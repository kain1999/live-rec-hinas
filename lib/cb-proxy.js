// Chaturbate 本地 HLS 代理（移植自原版 lib/cbProxy.class.js，去除 Electron/undici 依赖）
//
// 为什么需要它：CB 的 m3u8 URL 带时效 token，直播中会过期；ffmpeg 直连一旦 403 就断流。
// 该代理把 master/variant/segment 全部改写成 127.0.0.1 本地地址，token 过期时通过
// onRefreshUrl 回调（重新请求 get_edge_hls_url_ajax）拿新地址热替换，ffmpeg 无感知。
import http from 'node:http'
import { URL } from 'node:url'
import { log } from '../core/log.js'

const DESKTOP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:147.0) Gecko/20100101 Firefox/147.0'

const CHUNKLIST_NAME_RE = /((?:chunklist|audio)_\w+)/
const TRUSTED_SUFFIXES = ['chaturbate.com', 'mmcdn.com', 'highwebmedia.com']

function isTrustedUrl(urlStr) {
  try {
    const u = new URL(urlStr)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false
    const host = (u.hostname || '').toLowerCase()
    return TRUSTED_SUFFIXES.some(s => host === s || host.endsWith('.' + s))
  } catch { return false }
}

function baseUrlOf(url) {
  const idx = url.lastIndexOf('/')
  return idx !== -1 ? url.substring(0, idx + 1) : url + '/'
}

function fileNameOf(url) {
  const afterSlash = url.substring(url.lastIndexOf('/') + 1)
  return afterSlash.split('?')[0]
}

function harvestChunklistMap(absolutized) {
  const out = {}
  for (const line of absolutized.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('chunklist_')) continue
    const m = CHUNKLIST_NAME_RE.exec(trimmed)
    if (m) out[m[1]] = trimmed
  }
  for (const mi of absolutized.matchAll(/URI="(https?:\/\/[^"]*chunklist_[^"]*)"/gi)) {
    const m = CHUNKLIST_NAME_RE.exec(mi[1])
    if (m) out[m[1]] = mi[1]
  }
  return out
}

const ENDLIST_BODY = Buffer.from(
  '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-PLAYLIST-TYPE:VOD\n' +
  '#EXT-X-TARGETDURATION:1\n#EXT-X-MEDIA-SEQUENCE:0\n' +
  '#EXTINF:0.001,\nabout:blank\n#EXT-X-ENDLIST\n', 'utf-8'
)

class CBProxy {
  static #instances = new Map()

  static getProxy(nametag) { return CBProxy.#instances.get(nametag) || null }
  static stopProxy(nametag) {
    const proxy = CBProxy.#instances.get(nametag)
    if (proxy) {
      proxy.stop()
      CBProxy.#instances.delete(nametag)
    }
  }

  #server = null
  #port = 0
  #nametag = ''
  #state = {}
  #monitorTimer = null
  #reconnectTimer = null
  #stopped = false
  #onRefreshUrl = null
  #selectedResolution = null
  #lastMasterTime = 0
  createdAt = 0

  constructor(nametag, streamUrl, roomUrl, proxy = '', onRefreshUrl = null, selectedResolution = null) {
    this.#nametag = nametag
    this.#onRefreshUrl = onRefreshUrl
    this.#selectedResolution = selectedResolution
    this.createdAt = Date.now()
    this.#state = {
      streamUrl,
      headers: { 'User-Agent': DESKTOP_UA, 'Referer': roomUrl },
      urlMap: {},
      chunklistCache: {},
      segCdnUrls: {},
      latestSeg: {},
      lastRefresh: 0,
      lastRequest: Date.now(),
      requestCount: 0,
      reconnecting: false,
      stopping: false,
      terminal: false,
      masterBody: Buffer.from('#EXTM3U\n#EXT-X-VERSION:3\n', 'utf-8')
    }
  }

  get port() { return this.#port }
  get url() { return `http://127.0.0.1:${this.#port}/master.m3u8` }
  get stopped() { return this.#stopped }

  async start() {
    this.#server = http.createServer((req, res) => {
      this.#handle(req, res).catch(() => {
        if (!res.headersSent) { res.writeHead(500); res.end() }
      })
    })

    return new Promise((resolve, reject) => {
      this.#server.listen(0, '127.0.0.1', async () => {
        this.#port = this.#server.address().port
        for (let i = 1; i <= 5; i++) {
          try {
            await this.#buildInitialState()
            break
          } catch (err) {
            if (i < 5) await new Promise(r => setTimeout(r, 2000))
            else {
              this.#server.close()
              reject(new Error(`CBProxy initial build failed after 5 attempts: ${err.message}`))
              return
            }
          }
        }
        this.#startMonitor()
        CBProxy.#instances.set(this.#nametag, this)
        resolve(this.#port)
      })
      this.#server.on('error', err => reject(err))
    })
  }

  stop() {
    if (this.#stopped) return
    this.#stopped = true
    this.#state.stopping = true
    if (this.#monitorTimer) { clearInterval(this.#monitorTimer); this.#monitorTimer = null }
    if (this.#reconnectTimer) { clearTimeout(this.#reconnectTimer); this.#reconnectTimer = null }
    this.#server?.close()
    CBProxy.#instances.delete(this.#nametag)
  }

  async #fetchUpstream(urlStr) {
    // Referer 只对 chaturbate.com 域名有效，mmcdn 边缘节点带 Referer 反而会拒绝/降级
    let headers = this.#state.headers
    try {
      const host = new URL(urlStr).host
      if (!host.includes('chaturbate.com')) {
        const { Referer, ...rest } = this.#state.headers
        headers = rest
      }
    } catch { /* keep default */ }
    const res = await fetch(urlStr, { headers, signal: AbortSignal.timeout(10000) })
    if (!res.ok) {
      try { await res.body?.cancel() } catch {}
      throw new Error(`HTTP ${res.status} from ${urlStr.split('?')[0]}`)
    }
    return res
  }

  async #fetchBody(urlStr) {
    const res = await this.#fetchUpstream(urlStr)
    const buf = Buffer.from(await res.arrayBuffer())
    return buf.toString('utf-8').replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  }

  async #fetchRaw(urlStr) {
    const res = await this.#fetchUpstream(urlStr)
    const body = Buffer.from(await res.arrayBuffer())
    const ct = res.headers.get('content-type') || 'video/mp4'
    return { body, ct }
  }

  #absolutize(text, baseUrl) {
    let result = text
    result = result.replace(/^(?!https?:\/\/)(?!#)(.+)$/gm, (m, p1) => {
      try { return new URL(p1, baseUrl).href } catch { return p1 }
    })
    result = result.replace(/URI="(?!https?:\/\/)(.*?)"/gi, (m, p1) => {
      try { return `URI="${new URL(p1, baseUrl).href}"` } catch { return m }
    })
    return result
  }

  #rewriteMasterForClient(absolutized) {
    const lines = absolutized.split('\n')
    const filtered = this.#selectedResolution
      ? this.#filterByResolution(lines, this.#selectedResolution)
      : lines
    const sorted = this.#sortByBandwidthDescending(filtered)

    let result = sorted.join('\n')
    result = result.replace(/^(https?:\/\/[^\s]+\.m3u8[^\s]*)$/gm, (m, url) => {
      const nm = CHUNKLIST_NAME_RE.exec(url)
      if (!nm) return url
      return `http://127.0.0.1:${this.#port}/chunklist?name=${nm[1]}`
    })
    result = result.replace(/URI="(https?:\/\/[^"]+\.m3u8[^"]*)"/gi, (m, url) => {
      const nm = CHUNKLIST_NAME_RE.exec(url)
      if (!nm) return m
      return `URI="http://127.0.0.1:${this.#port}/chunklist?name=${nm[1]}"`
    })
    return result
  }

  #filterByResolution(lines, targetRes) {
    const target = targetRes.toString().trim()
    const targetHeight = parseInt(target) || 0
    const targetFull = target.includes('x') ? target : null

    const streamBlocks = []
    let current = []
    for (const line of lines) {
      if (line.startsWith('#EXT-X-STREAM-INF:')) {
        if (current.length > 0) streamBlocks.push(current)
        current = [line]
      } else if (current.length > 0 && !line.startsWith('#EXT')) {
        current.push(line)
      } else {
        if (current.length > 0) { streamBlocks.push(current); current = [] }
        streamBlocks.push([line])
      }
    }
    if (current.length > 0) streamBlocks.push(current)

    const matched = streamBlocks.filter(block => {
      if (!block[0].startsWith('#EXT-X-STREAM-INF:')) return true
      const resMatch = block[0].match(/RESOLUTION=(\d+x\d+)/)
      if (!resMatch) return false
      const [, res] = resMatch
      if (targetFull) return res === targetFull
      return parseInt(res.split('x')[1]) === targetHeight
    })

    const streamMatchCount = matched.filter(b => b[0].startsWith('#EXT-X-STREAM-INF:')).length
    if (streamMatchCount === 0) return lines
    return matched.flat()
  }

  #sortByBandwidthDescending(lines) {
    const streamBlocks = []
    let current = []
    for (const line of lines) {
      if (line.startsWith('#EXT-X-STREAM-INF:')) {
        if (current.length > 0) streamBlocks.push(current)
        current = [line]
      } else if (current.length > 0 && !line.startsWith('#EXT')) {
        current.push(line)
      } else {
        if (current.length > 0) { streamBlocks.push(current); current = [] }
        streamBlocks.push([line])
      }
    }
    if (current.length > 0) streamBlocks.push(current)  // 别丢最后一个分块！

    streamBlocks.sort((a, b) => {
      const bwA = parseInt((a[0].match(/BANDWIDTH=(\d+)/) || [])[1] || '0')
      const bwB = parseInt((b[0].match(/BANDWIDTH=(\d+)/) || [])[1] || '0')
      const hA = parseInt(((a[0].match(/RESOLUTION=(\d+)x(\d+)/) || [])[2]) || '0')
      const hB = parseInt(((b[0].match(/RESOLUTION=(\d+)x(\d+)/) || [])[2]) || '0')
      return (hB - hA) || (bwB - bwA)
    })

    const result = []
    const nonStream = []
    const headers = []
    for (const block of streamBlocks) {
      if (block[0].startsWith('#EXT-X-STREAM-INF:')) result.push(...block)
      else if (/^#(EXTM3U|EXT-X-VERSION|EXT-X-INDEPENDENT-SEGMENTS)/.test(block[0])) headers.push(...block)
      else nonStream.push(...block)
    }
    // 头部行必须在最前；非标准变体（auto 等）放最后
    const out = [...headers, ...result, ...nonStream]
    return out
  }

  #rewriteChunklistForClient(absolutized) {
    let result = absolutized
    result = result.replace(/^(https?:\/\/[^\s]+\.m4s[^\s]*)$/gm, (m, url) => {
      const fname = fileNameOf(url)
      return `http://127.0.0.1:${this.#port}/segment/${fname}?url=${encodeURIComponent(url)}`
    })
    result = result.replace(/URI="(https?:\/\/[^"]+\.m4s[^"]*)"/gi, (m, url) => {
      const fname = fileNameOf(url)
      return `URI="http://127.0.0.1:${this.#port}/segment/${fname}?url=${encodeURIComponent(url)}"`
    })
    result = result.replace(/URI="(https?:\/\/[^"]+\.m3u8[^"]*)"/gi, (m, url) => {
      const nm = CHUNKLIST_NAME_RE.exec(url)
      if (!nm) return m
      return `URI="http://127.0.0.1:${this.#port}/chunklist?name=${nm[1]}"`
    })
    return result
  }

  #harvestSegmentMaps(absolutized, typeKey) {
    for (const line of absolutized.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('.m4s')) continue
      const segName = fileNameOf(trimmed)
      this.#state.segCdnUrls[segName] = trimmed
      if (typeKey) this.#state.latestSeg[typeKey] = trimmed
    }
  }

  async #buildInitialState() {
    const text = await this.#fetchBody(this.#state.streamUrl)
    if (!text.includes('#EXTINF') && !text.includes('chunklist') && !text.includes('#EXT-X-STREAM-INF')) {
      throw new Error('master playlist has no valid content')
    }
    const base = baseUrlOf(this.#state.streamUrl)
    const absolutized = this.#absolutize(text, base)
    this.#state.urlMap = harvestChunklistMap(absolutized)
    this.#state.masterBody = Buffer.from(this.#rewriteMasterForClient(absolutized), 'utf-8')
  }

  async #refreshStreamUrl() {
    if (!this.#onRefreshUrl) return null
    try {
      const newUrl = await this.#onRefreshUrl(this.#nametag, '')
      if (newUrl) {
        this.#state.streamUrl = newUrl
        return newUrl
      }
    } catch { /* ignore */ }
    return null
  }

  async #refreshSession() {
    const now = Date.now()
    if (now - this.#state.lastRefresh < 2000) return false
    this.#state.lastRefresh = now

    try {
      let text = await this.#fetchBody(this.#state.streamUrl)
      if (!text.includes('#EXTINF') && !text.includes('chunklist') && !text.includes('#EXT-X-STREAM-INF')) {
        const newUrl = await this.#refreshStreamUrl()
        if (newUrl) text = await this.#fetchBody(newUrl)
        if (!text.includes('#EXTINF') && !text.includes('chunklist') && !text.includes('#EXT-X-STREAM-INF')) {
          throw new Error('refresh got invalid content')
        }
      }

      const base = baseUrlOf(this.#state.streamUrl)
      const absolutized = this.#absolutize(text, base)
      Object.assign(this.#state.urlMap, harvestChunklistMap(absolutized))
      this.#state.chunklistCache = {}
      this.#state.segCdnUrls = {}
      this.#state.latestSeg = {}
      this.#state.masterBody = Buffer.from(this.#rewriteMasterForClient(absolutized), 'utf-8')
      return true
    } catch (err) {
      const newUrl = await this.#refreshStreamUrl()
      if (newUrl) {
        try {
          const text = await this.#fetchBody(newUrl)
          const base = baseUrlOf(newUrl)
          const absolutized = this.#absolutize(text, base)
          Object.assign(this.#state.urlMap, harvestChunklistMap(absolutized))
          this.#state.chunklistCache = {}
          this.#state.segCdnUrls = {}
          this.#state.latestSeg = {}
          this.#state.masterBody = Buffer.from(this.#rewriteMasterForClient(absolutized), 'utf-8')
          return true
        } catch { /* ignore */ }
      }
      return false
    }
  }

  #triggerReconnect(reason) {
    if (this.#state.reconnecting || this.#state.stopping || this.#state.terminal) return
    this.#state.reconnecting = true

    let attempt = 0
    const tryReconnect = async () => {
      if (this.#state.stopping || this.#state.terminal) { this.#state.reconnecting = false; return }
      attempt++
      if (attempt > 5) {
        this.#state.reconnecting = false
        this.#state.terminal = true
        log.warn(`CBProxy reconnect exhausted for ${this.#nametag}`)
        return
      }
      const ok = await this.#refreshSession()
      if (ok) { this.#state.reconnecting = false; return }
      this.#reconnectTimer = setTimeout(tryReconnect, 2000)
    }
    tryReconnect()
  }

  async #handle(req, res) {
    const parsedUrl = new URL(req.url, `http://127.0.0.1:${this.#port}`)
    const pathname = parsedUrl.pathname
    this.#state.lastRequest = Date.now()
    this.#state.requestCount++

    if (pathname === '/chunklist') await this.#handleChunklist(parsedUrl, res)
    else if (pathname.startsWith('/segment')) await this.#handleSegment(parsedUrl, res)
    else this.#sendHls(res, this.#state.masterBody)
  }

  async #handleChunklist(parsedUrl, res) {
    if (this.#state.terminal) { this.#sendHls(res, ENDLIST_BODY); return }

    const name = parsedUrl.searchParams.get('name')
    if (!name) { res.writeHead(400); res.end(); return }

    const cdnUrl = this.#state.urlMap[name]
    if (!cdnUrl) {
      const cached = this.#state.chunklistCache[name]
      if (cached) { this.#sendHls(res, cached); return }
      this.#sendHls(res, ENDLIST_BODY)
      return
    }

    try {
      const text = await this.#fetchBody(cdnUrl)
      const base = baseUrlOf(cdnUrl)
      const absolutized = this.#absolutize(text, base)
      this.#harvestSegmentMaps(absolutized, name)
      const payload = Buffer.from(this.#rewriteChunklistForClient(absolutized), 'utf-8')
      this.#state.chunklistCache[name] = payload
      this.#sendHls(res, payload)
    } catch (err) {
      this.#triggerReconnect(`chunklist fail name=${name}: ${err.message}`)
      if (this.#state.stopping || this.#state.terminal) { this.#sendHls(res, ENDLIST_BODY); return }
      const cached = this.#state.chunklistCache[name]
      if (cached) { this.#sendHls(res, cached); return }
      this.#sendHls(res, ENDLIST_BODY)
    }
  }

  async #handleSegment(parsedUrl, res) {
    if (this.#state.terminal) { res.writeHead(410); res.end(); return }

    const segUrl = parsedUrl.searchParams.get('url')
    if (!segUrl) { res.writeHead(400); res.end(); return }
    if (!isTrustedUrl(segUrl)) { res.writeHead(403); res.end(); return }

    const segName = fileNameOf(segUrl)

    try {
      const { body, ct } = await this.#fetchRaw(segUrl)
      res.writeHead(200, { 'Content-Type': ct, 'Content-Length': body.length })
      res.end(body)
      return
    } catch { this.#triggerReconnect(`segment fail: ${segName}`) }

    const fallback = this.#state.segCdnUrls[segName]
    if (fallback && fallback !== segUrl && isTrustedUrl(fallback)) {
      try {
        const { body, ct } = await this.#fetchRaw(fallback)
        res.writeHead(200, { 'Content-Type': ct, 'Content-Length': body.length })
        res.end(body)
        return
      } catch { /* ignore */ }
    }

    const tm = segName.match(/(video|audio)_(\d+)/)
    if (tm) {
      for (const [tk, latestUrl] of Object.entries(this.#state.latestSeg)) {
        if (tk.includes(tm[1]) && tk.includes(tm[2]) && isTrustedUrl(latestUrl)) {
          try {
            const { body, ct } = await this.#fetchRaw(latestUrl)
            res.writeHead(200, { 'Content-Type': ct, 'Content-Length': body.length })
            res.end(body)
            return
          } catch { break }
        }
      }
    }

    res.writeHead(502)
    res.end()
  }

  #sendHls(res, data) {
    res.writeHead(200, {
      'Content-Type': 'application/vnd.apple.mpegurl',
      'Content-Length': data.length,
      'Cache-Control': 'no-cache'
    })
    res.end(data)
  }

  #startMonitor() {
    this.#monitorTimer = setInterval(() => {
      if (this.#state.stopping) { this.stop(); return }
      const idle = Date.now() - this.#state.lastRequest
      if (idle > 30000 && this.#state.requestCount > 0) this.stop()
    }, 5000)
  }
}

export default CBProxy
