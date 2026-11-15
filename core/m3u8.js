import { fetchWithAgent } from './fetcher.js'

/**
 * 解析 #EXT-X-STREAM-INF 属性行
 */
function parseAttributes(line) {
  const attrs = {}
  const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g
  let m
  while ((m = re.exec(line)) !== null) {
    let v = m[2]
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1)
    attrs[m[1]] = v
  }
  return attrs
}

function baseUrlOf(url) {
  const idx = url.lastIndexOf('/')
  return idx !== -1 ? url.substring(0, idx + 1) : url
}

function fpsOf(attrs) {
  let fps = attrs['FRAME-RATE'] || ''
  if (!fps && attrs.NAME) {
    const m = String(attrs.NAME).match(/FPS:(\d+)/)
    if (m) fps = m[1]
  }
  return fps ? Number(fps).toFixed(0) : ''
}

function parseRes(text, opts) {
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')
  const out = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line.startsWith('#EXT-X-STREAM-INF:')) continue
    const attrs = parseAttributes(line)
    let uri = ''
    // URI 可能写在 STREAM-INF 行内（EXT-X-STREAM-INF:...,URI="..."）
    if (attrs.URI) uri = attrs.URI
    else {
      for (let j = i + 1; j < lines.length; j++) {
        const t = lines[j].trim()
        if (!t) continue
        if (t.startsWith('#')) continue
        uri = t
        break
      }
    }
    if (!uri) continue
    let url = uri
    if (opts.directurl) url = opts.directurl
    else if (opts.prefix && opts.prefix !== '#') url = uri.startsWith('http') ? uri : opts.prefix + uri
    else url = uri.startsWith('http') ? uri : new URL(uri, opts.base).href
    if (url.includes('#')) url = url.replace('#', '')

    let resolution = null
    if (attrs.RESOLUTION) {
      const [w, h] = String(attrs.RESOLUTION).split('x').map(n => parseInt(n) || 0)
      resolution = { width: w, height: h }
    }
    out.push({
      resolution,
      url,
      fps: fpsOf(attrs),
      bandwidth: parseInt(attrs.BANDWIDTH || '0') || 0
    })
  }
  return out.sort((a, b) => ((b.resolution?.height || 0) - (a.resolution?.height || 0)) || (b.bandwidth - a.bandwidth))
}

/**
 * master m3u8 -> 分辨率列表（与原版 tools.resolutions 行为一致）
 * @returns array
 */
export function resolutions({ active, data, prefixUrl, baseUrl }) {
  if (!active || !data) return []
  const opts = { base: baseUrl }
  if (prefixUrl && typeof prefixUrl === 'object') opts.directurl = prefixUrl.directurl || null
  else opts.prefix = prefixUrl || null
  return parseRes(data, opts)
}

/**
 * 抓取 m3u8 并解析分辨率。getData=true 时同时返回原始文本（stripchat 需要）。
 */
export async function getResolutions(url, prefixUrl, getData) {
  try {
    const res = await fetchWithAgent(url)
    if (!res.ok) {
      try { await res.body?.cancel() } catch {}
      return getData ? { resolutions: [], streamdata: '' } : []
    }
    const data = await res.text()
    const list = resolutions({
      active: true,
      data,
      prefixUrl: prefixUrl || (url.includes('playlist.m3u8') ? url.replace('playlist.m3u8', '') : undefined),
      baseUrl: url
    })
    return getData ? { resolutions: list, streamdata: data } : list
  } catch (err) {
    return getData ? { resolutions: [], streamdata: '' } : []
  }
}

/**
 * 解析 media playlist 的片段 URL（CBProxy 备用）
 */
export function parseSegments(text, baseUrl) {
  const out = []
  for (const raw of text.split('\n')) {
    const t = raw.trim()
    if (!t || t.startsWith('#')) continue
    out.push(t.startsWith('http') ? t : new URL(t, baseUrl).href)
  }
  return out
}
