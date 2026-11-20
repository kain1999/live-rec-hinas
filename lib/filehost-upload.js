// 文件床自动上传：Pixeldrain / Gofile（curl 直传，无需代理）
// 进度从 curl stderr 的百分比解析（纯本地计算，不依赖对方 API 返回）
// 确认以接口返回的 JSON（pd: {success,id} / gf: {status:'ok',data:...}）为准
// 传后即焚：确认成功后删除本地文件
import { spawn } from 'node:child_process'
import { existsSync, statSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import path from 'path'
import { DATA_DIR } from '../core/paths.js'
import { loadConfig } from '../core/config.js'
import { log } from '../core/log.js'

export const PROVIDERS = {
  pd: { name: 'Pixeldrain' },
  gf: { name: 'Gofile' }
}

const HISTORY_PATH = path.join(DATA_DIR, 'filehost-history.json')
let fhHistory = []
try { fhHistory = JSON.parse(readFileSync(HISTORY_PATH, 'utf8')) } catch { fhHistory = [] }
function pushHistory(entry) {
  fhHistory.unshift(entry)
  if (fhHistory.length > 200) fhHistory = fhHistory.slice(0, 200)
  try { writeFileSync(HISTORY_PATH, JSON.stringify(fhHistory, null, 2)) } catch { /* ignore */ }
}
export function getFhHistory() { return fhHistory }

const statuses = {
  pd: { active: false, file: '', uploaded: 0, total: 0, speed: 0, startedAt: null, finishedAt: null, ok: null, error: null, remote: '', _lastT: null, _lastB: 0 },
  gf: { active: false, file: '', uploaded: 0, total: 0, speed: 0, startedAt: null, finishedAt: null, ok: null, error: null, remote: '', _lastT: null, _lastB: 0 }
}
const procs = { pd: null, gf: null }

export function getFhStatus(provider) { return { ...(statuses[provider] || {}) } }
export function cancelFhUpload(provider) {
  if (procs[provider]) { try { procs[provider].kill('SIGKILL') } catch { /* ignore */ } return true }
  return false
}

function cfgOf(provider) { return loadConfig()[provider] || {} }

function trackProgress(st, err, size) {
  const ms = [...err.matchAll(/(\d+(?:\.\d+)?)\s*%/g)]
  if (!ms.length) return
  const pct = Number(ms[ms.length - 1][1])
  if (pct >= 0 && pct <= 100) {
    st.uploaded = Math.min(size, Math.floor(size * pct / 100))
    // 平均速度 = 已传字节 / 从开始经过的总秒数（比两次采样间的瞬时值更接近真实带宽）
    const now = Date.now()
    const elapsed = Math.max(1, (now - (st.startedAt || now)) / 1000)
    st.speed = Math.max(0, Math.floor(st.uploaded / elapsed))
  }
}

async function gfServer() {
  const res = await fetch('https://api.gofile.io/servers', { signal: AbortSignal.timeout(15000) })
  const j = await res.json()
  const s = j?.data?.servers?.[0]?.name
  if (!s) throw new Error(`Gofile 获取上传节点失败: ${JSON.stringify(j).slice(0, 150)}`)
  return s
}

function curlUpload(provider, filePath, size, serverName) {
  const cfg = cfgOf(provider)
  const name = path.basename(filePath)
  const args = ['-S', '--progress-bar', '--max-time', '86400']
  const proxy = (cfg.proxy || '').trim()
  if (proxy) args.push('-x', proxy)
  if (provider === 'pd') {
    args.push('-T', filePath, 'https://pixeldrain.com/api/file/' + encodeURIComponent(name))
    const key = (cfg.apiKey || '').trim()
    if (key) args.push('-u', ':' + key)
  } else {
    const token = (cfg.apiToken || '').trim()
    if (token) args.push('-H', 'Authorization: Bearer ' + token)
    args.push('-F', `file=@${filePath}`, `https://${serverName}.gofile.io/contents/uploadfile`)
  }
  const st = statuses[provider]
  const proc = spawn('curl', args, { windowsHide: true })
  procs[provider] = proc
  let out = '', err = ''
  proc.stdout.on('data', d => { out += d })
  proc.stderr.on('data', d => { err += d; trackProgress(st, err, size) })
  return new Promise((resolve, reject) => {
    proc.on('error', e => { procs[provider] = null; reject(new Error(e.message)) })
    proc.on('close', (code, signal) => {
      procs[provider] = null
      if (signal === 'SIGKILL' || signal === 'SIGTERM') return reject(new Error('已取消'))
      let j = null
      try { j = JSON.parse(out) } catch { /* 非 JSON */ }
      if (provider === 'pd') {
        if (j && j.success && j.id) return resolve({ id: j.id, url: 'https://pixeldrain.com/u/' + j.id })
        return reject(new Error(`Pixeldrain 未确认: ${(out || err || '').slice(-200)}`))
      } else {
        if (j && j.status === 'ok' && j.data?.downloadPage) return resolve({ id: j.data.id, url: j.data.downloadPage })
        return reject(new Error(`Gofile 未确认: ${(j ? JSON.stringify(j) : out + err).slice(-200)}`))
      }
    })
  })
}

export function maybeUploadToFilehost(filePath) {
  if (!filePath || !existsSync(filePath) || statSync(filePath).size <= 0) return
  for (const p of ['pd', 'gf']) {
    if (cfgOf(p).enabled) uploadToFilehost(p, filePath).catch(e => log.error(`[${PROVIDERS[p].name}] 上传失败: ${e.message}`))
  }
}

export async function uploadToFilehost(provider, filePath) {
  const size = statSync(filePath).size
  try {
    await doUpload(provider, filePath, size)
  } catch (err) {
    log.warn(`[${PROVIDERS[provider].name}] 首次上传未确认，30 秒后重试一次: ${err.message}`)
    await new Promise(r => setTimeout(r, 30000))
    await doUpload(provider, filePath, size)
  }
}

async function doUpload(provider, filePath, size) {
  const cfg = cfgOf(provider)
  const st = statuses[provider]
  if (st.active) { while (st.active) await new Promise(r => setTimeout(r, 5000)) }
  Object.assign(st, {
    active: true, file: path.basename(filePath), uploaded: 0, total: size,
    speed: 0, startedAt: Date.now(), finishedAt: null, ok: null, error: null, remote: '', _lastT: null, _lastB: 0
  })
  log.info(`[${PROVIDERS[provider].name}] 开始上传: ${path.basename(filePath)} (${(size / 1048576).toFixed(1)}MB)`)
  try {
    let serverName = null
    if (provider === 'gf') serverName = await gfServer()
    const r = await curlUpload(provider, filePath, size, serverName)
    st.speed = 0
    st.remote = r.url
    Object.assign(st, { active: false, finishedAt: Date.now(), uploaded: size, ok: true, error: null })
    pushHistory({ target: provider, file: path.basename(filePath), total: size, url: r.url, startedAt: st.startedAt, finishedAt: st.finishedAt, ok: true, error: null })
    if (cfg.deleteAfterUpload) {
      try {
        unlinkSync(filePath)
        log.info(`[${PROVIDERS[provider].name}] 传后即焚: 已删除本地文件 ${filePath}`)
        pushHistory({ target: provider, file: path.basename(filePath), total: size, url: r.url, startedAt: st.startedAt, finishedAt: st.finishedAt, ok: true, error: null, deleted: true })
      } catch (e) {
        log.error(`[${PROVIDERS[provider].name}] 传后即焚删除失败: ${e.message}`)
      }
    }
    log.info(`[${PROVIDERS[provider].name}] 上传完成: ${r.url}`)
    return true
  } catch (err) {
    Object.assign(st, { active: false, finishedAt: Date.now(), ok: false, error: err.message })
    pushHistory({ target: provider, file: path.basename(filePath), total: size, url: '', startedAt: st.startedAt, finishedAt: st.finishedAt, ok: false, error: err.message })
    log.error(`[${PROVIDERS[provider].name}] 上传失败: ${err.message}`)
    throw err
  }
}
