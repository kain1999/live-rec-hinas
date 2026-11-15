import { fetchWithAgent } from './fetcher.js'
import { getResolutions, resolutions } from './m3u8.js'
import { DEFAULT_UA } from './fetcher.js'
import CBProxy from '../lib/cb-proxy.js'
import StripchatProxy from '../lib/stripchat-proxy.js'

export const status_types = {
  ONLINE: 'online',
  OFFLINE: 'offline',
  PRIVATE: 'private',
  NOT_EXIST: 'not exist',
  ERROR: 'error'
}

export function formatExtract({ nametag, status, url, resolutions: res, thumb }) {
  return {
    nametag,
    status,
    url: url || '',
    recUrl: url || '',
    statusRec: false,
    timeRec: 0,
    resolutions: res || [],
    thumb: thumb || ''
  }
}

export function formatUpdate({ status, thumb, url }) {
  return { status, thumb: thumb || '', url: url || '' }
}

/**
 * 注入给每个扩展的基类（对应原版 SiteExtra，Electron 依赖已移除）。
 * use_net（Camsoda 的 Cloudflare 浏览器会话）在无头环境下按普通请求处理。
 */
export default class SiteExtra {
  constructor(config) {
    this.config = config
  }

  status_types = status_types

  getCBProxy() { return CBProxy }
  getStripchatProxy() { return StripchatProxy }

  async fetch(url, options) {
    const opts = { ...(options || {}) }
    if (this.config.use_impit && opts.impit === undefined) {
      opts.impit = true
      if (!opts.browser) opts.browser = this.config.impit_browser || 'firefox'
    }
    if (this.config.referer && !opts.headers) opts.headers = {}
    return fetchWithAgent(url, opts)
  }

  async getResolutions(url, prefix, getData) {
    return getResolutions(url, prefix, getData)
  }

  resolutionsRaw({ active, data, prefixUrl, baseUrl }) {
    return resolutions({ active, data, prefixUrl, baseUrl })
  }

  createResponse(data) {
    return formatExtract({
      nametag: data.nametag,
      status: data.status,
      url: data.url,
      resolutions: data.resolutions,
      thumb: data.thumb
    })
  }

  createUpdate(data) {
    return formatUpdate({ status: data.status, thumb: data.thumb, url: data.url })
  }

  defaultUA() { return DEFAULT_UA }
}
