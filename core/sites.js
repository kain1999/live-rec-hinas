import BongacamsExtension from '../extensions/BongacamsExtension.js'
import Cam4Extension from '../extensions/Cam4Extension.js'
import CamsodaExtension from '../extensions/CamsodaExtension.js'
import ChaturbateExtension from '../extensions/ChaturbateExtension.js'
import DreamcamExtension from '../extensions/DreamcamExtension.js'
import StripchatExtension from '../extensions/StripchatExtension.js'
import SiteExtra from './site-extra.js'

export const sites = {}
export const siteOrder = []

for (const Ext of [BongacamsExtension, Cam4Extension, CamsodaExtension, ChaturbateExtension, DreamcamExtension, StripchatExtension]) {
  const inst = new Ext(SiteExtra)
  sites[inst.config.name] = inst
  siteOrder.push(inst.config.name)
}

export function getSite(name) {
  return sites[name] || null
}

function hostSuffixOf(hostname) {
  return String(hostname || '').toLowerCase()
}

/**
 * 按扩展 patterns/domain 匹配 URL -> 站点名
 */
export function matchSite(urlStr) {
  let u
  try { u = new URL(urlStr) } catch { return null }
  const host = hostSuffixOf(u.hostname)
  for (const name of siteOrder) {
    const inst = sites[name]
    const patterns = inst.config.patterns || []
    for (const p of patterns) {
      // pattern 形如 https://*.cam4.com/* 或 https://*.xcdnpro.com/*
      const m = String(p).match(/^https?:\/\/([^/]+)/)
      if (!m) continue
      const hostPart = m[1] // e.g. *.cam4.com
      const suffix = hostPart.replace(/^\*\./, '').toLowerCase()
      if (host === suffix || host.endsWith('.' + suffix)) return name
    }
  }
  return null
}

/**
 * 从房间 URL 提取房间名（取第一段路径）
 */
export function roomFromUrl(urlStr) {
  let u
  try { u = new URL(urlStr) } catch { return '' }
  const seg = u.pathname.split('/').filter(Boolean)
  if (!seg.length) return ''
  let room = decodeURIComponent(seg[0])
  room = room.replace(/[^\w.\-]/g, '')
  return room
}

export function siteListForUI() {
  return siteOrder.map(name => {
    const c = sites[name].config
    return { name, domain: c.domain, color: c.color, version: c.version || '' }
  })
}
