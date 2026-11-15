// Camsoda 本地 HLS 代理（原版依赖 Electron 隐藏窗口过 Cloudflare；
// 无头环境改为普通 fetch + 完整浏览器头，对 CDN 媒体节点通常有效）
//
// 作用：Camsoda 边缘节点返回的 m3u8 里把 .hls.fmp4 段标成 mp4 才能被 ffmpeg 正确
// 处理（原版做法：请求时把 .mp4 还原成 .hls.fmp4，回包时再改写回 .mp4）。
import http from 'node:http'
import { URL } from 'node:url'
import { BROWSER_HEADERS } from '../core/fetcher.js'
import { log } from '../core/log.js'

function toProxyUrl(resolved, port) {
  const isCrossOrigin = resolved.hostname !== '127.0.0.1'
  const hostPart = isCrossOrigin ? resolved.host : ''
  return `http://127.0.0.1:${port}${hostPart}${resolved.pathname}${resolved.search}`
}

function rewriteM3u8(content, port, baseProxyUrl) {
  const lines = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')
  return lines.map(line => {
    const trimmed = line.trim()
    if (!trimmed) return ''

    const mapMatch = trimmed.match(/^(#EXT-X-MAP:.*URI=")([^"]+)(")/)
    if (mapMatch) {
      const resolved = new URL(mapMatch[2], baseProxyUrl)
      return `${mapMatch[1]}${toProxyUrl(resolved, port)}${mapMatch[3]}`
    }

    const mediaMatch = trimmed.match(/^(#EXT-X-MEDIA:.*URI=")([^"]+)(")/)
    if (mediaMatch) {
      const resolved = new URL(mediaMatch[2], baseProxyUrl)
      return `${mediaMatch[1]}${toProxyUrl(resolved, port)}${mediaMatch[3]}`
    }

    const iFrameMatch = trimmed.match(/^(#EXT-X-I-FRAME-STREAM-INF:.*URI=")([^"]+)(")/)
    if (iFrameMatch) {
      const resolved = new URL(iFrameMatch[2], baseProxyUrl)
      return `${iFrameMatch[1]}${toProxyUrl(resolved, port)}${iFrameMatch[3]}`
    }

    const streamMatch = trimmed.match(/^(#EXT-X-STREAM-INF:.*)(,URI=")([^"]+)(")/)
    if (streamMatch) {
      const resolved = new URL(streamMatch[3], baseProxyUrl)
      return `${streamMatch[1]}${streamMatch[2]}${toProxyUrl(resolved, port)}${streamMatch[4]}`
    }

    if (!trimmed.startsWith('#')) {
      try {
        const resolved = new URL(trimmed, baseProxyUrl)
        return toProxyUrl(resolved, port)
      } catch { /* keep */ }
    }

    return trimmed
  }).join('\n').replace(/\.hls\.fmp4/g, '.mp4')
}

export default class CamsodaProxy {
  #server = null
  #port = 0

  async start() {
    if (this.#server) return this.#port

    this.#server = http.createServer(async (req, res) => {
      try {
        const pathWithHost = req.url.substring(1)
        const firstSlash = pathWithHost.indexOf('/')
        if (firstSlash === -1) { res.writeHead(400); res.end('Bad Request'); return }
        const hostname = pathWithHost.substring(0, firstSlash)
        const pathAndQuery = pathWithHost.substring(firstSlash)
        const origPathAndQuery = pathAndQuery.replace(/\.mp4(?=\?|$)/g, '.hls.fmp4')
        const targetUrl = `https://${hostname}${origPathAndQuery}`

        const fetchRes = await fetch(targetUrl, {
          method: 'GET',
          headers: {
            ...BROWSER_HEADERS,
            'Referer': 'https://www.camsoda.com/',
            'Accept': '*/*',
            'Accept-Encoding': 'gzip, deflate'
          },
          signal: AbortSignal.timeout(20000)
        })

        const contentType = fetchRes.headers.get('content-type') || ''
        const body = Buffer.from(await fetchRes.arrayBuffer())

        const isM3u8 = contentType.includes('mpegurl') || contentType.includes('x-mpegurl') || targetUrl.includes('.m3u8')

        if (isM3u8) {
          let text = body.toString('utf-8')
          if (text.charCodeAt(0) === 0xFEFF) text = text.substring(1)

          if (!text.trimStart().startsWith('#EXTM3U')) {
            res.writeHead(fetchRes.status, {
              'Content-Type': contentType || 'text/plain',
              'Content-Length': body.length
            })
            res.end(body)
            return
          }

          const baseProxyUrl = `http://127.0.0.1:${this.#port}/${hostname}${pathAndQuery}`
          const rewritten = rewriteM3u8(text, this.#port, baseProxyUrl)
          const out = Buffer.from(rewritten, 'utf-8')
          res.writeHead(fetchRes.status, {
            'Content-Type': 'application/vnd.apple.mpegurl',
            'Content-Length': out.length
          })
          res.end(out)
        } else {
          res.writeHead(fetchRes.status, {
            'Content-Type': contentType || 'application/octet-stream',
            'Content-Length': body.length
          })
          res.end(body)
        }
      } catch (err) {
        log.warn(`CamsodaProxy error: ${err.message}`)
        res.writeHead(502)
        res.end('Bad Gateway')
      }
    })

    return new Promise(resolve => {
      this.#server.listen(0, '127.0.0.1', () => {
        this.#port = this.#server.address().port
        log.info(`CamsodaProxy listening on port ${this.#port}`)
        resolve(this.#port)
      })
    })
  }

  getPort() { return this.#port }

  proxyUrl(originalUrl) {
    try {
      const u = new URL(originalUrl)
      return `http://127.0.0.1:${this.#port}/${u.host}${u.pathname}${u.search}`
    } catch { return originalUrl }
  }

  stop() {
    if (this.#server) {
      this.#server.close()
      this.#server = null
      this.#port = 0
    }
  }
}
