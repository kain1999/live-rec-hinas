import { existsSync, readFileSync } from 'node:fs'
import { loadConfig } from './config.js'
import { log } from './log.js'

export const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:147.0) Gecko/20100101 Firefox/147.0'

export const BROWSER_HEADERS = {
  'User-Agent': DEFAULT_UA,
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7',
  'Upgrade-Insecure-Requests': '1',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Sec-Fetch-User': '?1'
}

// impit（浏览器 TLS 指纹伪装）为可选依赖：装了就用，没装自动回退到原生 fetch。
// bongacams 有 Cloudflare 防护，原生 fetch 的 TLS 指纹可能被拦。
let ImpitCtor = null
let impitChecked = false
async function getImpit() {
  if (impitChecked) return ImpitCtor
  impitChecked = true
  try {
    const mod = await import('impit')
    ImpitCtor = mod.Impit
    log.info('impit loaded: browser TLS impersonation enabled')
  } catch {
    log.info('impit not installed, using plain fetch (bongacams may be blocked by Cloudflare)')
  }
  return ImpitCtor
}

const impitClients = new Map()
function getImpitClient(browser = 'firefox', proxyUrl) {
  const key = `${browser}|${proxyUrl || ''}`
  if (!impitClients.has(key)) {
    impitClients.set(key, new ImpitCtor({ browser, proxyUrl: proxyUrl || undefined, timeout: 20000 }))
  }
  return impitClients.get(key)
}

// undici 为可选依赖：仅当配置了 proxylist 且装了 undici 时启用代理池
let undiciMod = undefined
async function getUndici() {
  if (undiciMod !== undefined) return undiciMod
  try { undiciMod = await import('undici') } catch { undiciMod = null }
  return undiciMod
}

const proxyAgents = new Map()
async function getProxyAgent(proxyUrl) {
  const undici = await getUndici()
  if (!undici) return null
  if (!proxyAgents.has(proxyUrl)) {
    proxyAgents.set(proxyUrl, new undici.ProxyAgent(proxyUrl, { connect: { timeout: 10000 } }))
  }
  return proxyAgents.get(proxyUrl)
}

function loadProxyList() {
  const config = loadConfig()
  if (config.proxylist && existsSync(config.proxylist)) {
    try {
      return readFileSync(config.proxylist, 'utf8').split('\n').map(p => p.trim()).filter(p => p && !p.startsWith('#'))
    } catch { return [] }
  }
  return []
}

async function drain(res) {
  try {
    if (res?.body && !res.body.locked) await res.body.cancel()
  } catch { /* ignore */ }
}

function toProxyUrl(p) {
  return p && p.includes('://') ? p : `http://${p}`
}

/**
 * 与原版 scraperUtils.fetchWithAgent 行为对齐：
 * - impit 可用时优先走浏览器指纹
 * - 显式 proxy 失败后回退直连
 * - 无显式 proxy 时按 proxylist 尝试 maxproxytry 次，再直连
 */
export async function fetchWithAgent(url, options = {}) {
  const { impit, browser, proxy, ...fetchOptions } = options
  const signal = fetchOptions.signal || AbortSignal.timeout(20000)
  if (!fetchOptions.headers || !fetchOptions.headers['User-Agent']) {
    fetchOptions.headers = { 'User-Agent': DEFAULT_UA, ...(fetchOptions.headers || {}) }
  }

  if (impit) {
    const ctor = await getImpit()
    if (ctor) {
      try {
        const proxyUrl = proxy ? toProxyUrl(proxy) : undefined
        const client = getImpitClient(browser || 'firefox', proxyUrl)
        return await client.fetch(url, {
          method: fetchOptions.method,
          headers: fetchOptions.headers,
          body: fetchOptions.body,
          redirect: fetchOptions.redirect,
          signal
        })
      } catch (err) {
        log.warn(`impit fetch failed (${url}): ${err.message}, falling back to plain fetch`)
      }
    }
  }

  if (proxy !== undefined) {
    if (proxy) {
      try {
        const agent = await getProxyAgent(toProxyUrl(proxy))
        if (agent) return await fetch(url, { ...fetchOptions, signal, dispatcher: agent })
      } catch (err) {
        log.warn(`Proxy ${proxy} failed: ${err.message}`)
      }
    }
    return await fetch(url, { ...fetchOptions, signal })
  }

  const proxyList = loadProxyList()
  const maxTry = Math.min(proxyList.length, Number(loadConfig().maxproxytry) || 0)
  for (let i = 0; i < maxTry; i++) {
    try {
      const agent = await getProxyAgent(toProxyUrl(proxyList[i]))
      if (!agent) break
      return await fetch(url, { ...fetchOptions, signal, dispatcher: agent })
    } catch (err) {
      log.warn(`Proxy ${proxyList[i]} (${i + 1}/${maxTry}) failed: ${err.message}`)
    }
  }

  return await fetch(url, { ...fetchOptions, signal })
}

export async function fetchText(url, options) {
  const res = await fetchWithAgent(url, options)
  const text = await res.text()
  return { ok: res.ok, status: res.status, text, res }
}

export async function fetchJson(url, options) {
  const res = await fetchWithAgent(url, options)
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* not json */ }
  return { ok: res.ok, status: res.status, json, text, res }
}
