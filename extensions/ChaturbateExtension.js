import { getResolutions } from '../core/m3u8.js'

const IPAD_UA = 'Mozilla/5.0 (iPad; CPU OS 16_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.5 Mobile/15E148 Safari/604.1'

export default class ChaturbateExtension {
  constructor(ExtensionExtra) {
    this.config = {
      name: 'chaturbate',
      color: '#f97316',
      domain: 'chaturbate.com',
      referer: true,
      get_url_new: true,
      patterns: ['https://*.chaturbate.com/*', 'https://*.mmcdn.com/*'],
      version: '2.1.1'
    }
    this.extension = new ExtensionExtra(this.config)
    this.status_types = this.extension.status_types
  }

  async requestApi(nametag) {
    const body = new URLSearchParams()
    body.append('room_slug', nametag)
    body.append('bandwidth', 'high')

    // 走 impit 浏览器 TLS 指纹，绕过 Cloudflare 对原生 fetch 的质询
    // UA 必须与 CBProxy 拉流时一致（edge 校验 token 绑定的 UA）
    const DESKTOP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:147.0) Gecko/20100101 Firefox/147.0'
    const { fetchWithAgent } = await import('../core/fetcher.js')
    let text = ''
    try {
      const res = await fetchWithAgent('https://chaturbate.com/get_edge_hls_url_ajax/', {
        method: 'POST',
        impit: true,
        browser: 'firefox',
        headers: {
          'User-Agent': DESKTOP_UA,
          'X-Requested-With': 'XMLHttpRequest',
          'Content-Type': 'application/x-www-form-urlencoded',
          'Accept': 'application/json',
          'Referer': `https://chaturbate.com/${nametag}/`
        },
        body: body.toString()
      })
      text = await res.text()
    } catch (err) {
      // impit 失败回退原生 fetch
      const res = await fetch('https://chaturbate.com/get_edge_hls_url_ajax/', {
        method: 'POST',
        headers: {
          'X-Requested-With': 'XMLHttpRequest',
          'Content-Type': 'application/x-www-form-urlencoded',
          'Accept': 'application/json',
          'User-Agent': IPAD_UA,
          'Referer': `https://chaturbate.com/${nametag}/`
        },
        body
      })
      text = await res.text()
    }
    let res
    try {
      res = JSON.parse(text)
    } catch {
      // 返回了 HTML（Cloudflare 质询页）——抛出可识别的错误，交由上层重试
      throw new Error('cloudflare-challenge')
    }

    return res
  }

  async getInfo(nametag) {
    const res = await this.requestApi(nametag)

    const status =
      res.room_status == 'public'
        ? this.status_types.ONLINE
        : res.room_status == 'private'
          ? this.status_types.PRIVATE
          : !res.success
            ? this.status_types.NOT_EXIST
            : this.status_types.OFFLINE

    return { status, thumb: this.getThumb(nametag, status), res }
  }

  getThumb(nametag, status) {
    return status == this.status_types.ONLINE || status == this.status_types.PRIVATE
      ? `https://thumb.live.mmcdn.com/riw/${nametag}.jpg`
      : ''
  }

  async #fetchPlaylist(url) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': IPAD_UA },
        signal: AbortSignal.timeout(10000)
      })
      if (!res.ok) {
        try { await res.body?.cancel() } catch { /* ignore */ }
        return []
      }
      const data = await res.text()
      const playlists = data.includes('#EXT-X-STREAM-INF')
        ? await getResolutions(url)
        : []
      return playlists
    } catch {
      return []
    }
  }

  async extract(nametag, cachedData = null) {
    const { res, status, thumb } = await this.getInfo(nametag)

    if (status === this.status_types.OFFLINE || status === this.status_types.NOT_EXIST) {
      return this.extension.createResponse({ nametag, status, thumb })
    }

    const url = res.url
    const resolutions = await this.#fetchPlaylist(url)

    let finalUrl = url
    if (!url.includes('playlist.m3u8')) {
      const freshRes = await this.requestApi(nametag)
      if (freshRes && freshRes.success && freshRes.url) {
        finalUrl = freshRes.url
      }
    }

    return this.extension.createResponse({
      nametag,
      status,
      url: finalUrl,
      resolutions,
      thumb
    })
  }

  async getStreamUrlForRec(nametag, proxy = '', selectedResolution = null) {
    try {
      const CBProxy = this.extension.getCBProxy()
      const existing = CBProxy.getProxy(nametag)
      if (existing) {
        CBProxy.stopProxy(nametag)
      }

      const res = await this.requestApi(nametag)
      if (!res || !res.success || !res.url || res.room_status !== 'public') {
        return null
      }

      const streamUrl = res.url
      const roomUrl = `https://chaturbate.com/${nametag}/`

      const cbProxy = new CBProxy(
        nametag,
        streamUrl,
        roomUrl,
        '',
        async (name, currentUrl) => {
          try {
            const fresh = await this.requestApi(name)
            if (fresh && fresh.success && fresh.url) return fresh.url
          } catch {}
          return null
        },
        selectedResolution
      )

      await cbProxy.start()
      return { url: cbProxy.url }
    } catch (err) {
      console.error(`CBProxy start failed for ${nametag}:`, err.message)
      return null
    }
  }

  async getStreamUrl(nametag, proxy = '', selectedResolution = null) {
    return this.getStreamUrlForRec(nametag, proxy, selectedResolution)
  }

  async update(nametag) {
    const { status, thumb, res } = await this.getInfo(nametag)
    return this.extension.createUpdate({
      status,
      thumb,
      url: res?.url && !res.url.includes('playlist.m3u8') ? res.url : null
    })
  }
}
