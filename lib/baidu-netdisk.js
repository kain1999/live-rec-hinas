// 百度网盘自动上传（授权用 bypy，上传直连 PCS API 以获得精确进度）
// 首次授权：设置页点"测试连接" → 打开授权链接 → 授权码填回 → 再点测试
// 文件上传到网盘「我的应用数据 / bypy / live-rec」目录
import { spawn } from 'node:child_process'
import { existsSync, statSync, readFileSync } from 'node:fs'
import { createReadStream } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadConfig } from '../core/config.js'
import { log } from '../core/log.js'

const SLICE = 8 * 1024 * 1024 // 8MB 分片，兼顾进度粒度与请求数

function bypyBin() {
  const cfg = loadConfig().baidu || {}
  return (cfg.bypypath || 'bypy').trim() || 'bypy'
}
function remoteDir() {
  const cfg = loadConfig().baidu || {}
  const d = (cfg.remoteDir || 'live-rec').trim().replace(/^\/+|\/+$/g, '') || 'live-rec'
  return d
}

// 全局上传状态（前端进度条读取）
const uploadStatus = {
  active: false, file: '', remote: '', uploaded: 0, total: 0, speed: 0,
  startedAt: null, finishedAt: null, ok: null, error: null
}
let currentProc = null

// 取消当前上传（杀掉 bypy 进程）
export function cancelUpload() {
  if (currentProc) {
    try { currentProc.kill('SIGKILL') } catch { /* ignore */ }
    return true
  }
  return false
}
export function getUploadStatus() { return { ...uploadStatus } }

function readBypyToken() {
  for (const home of [os.homedir(), '/root']) {
    try {
      const j = JSON.parse(readFileSync(path.join(home, '.bypy', 'bypy.json'), 'utf8'))
      if (j.access_token) return j
    } catch { /* next */ }
  }
  throw new Error('未找到 bypy 授权信息（~/.bypy/bypy.json），请先在设置页完成授权')
}

function apiPost(url, { params = {}, fields = {}, form = null } = {}, timeoutMs = 600000) {
  const qs = new URLSearchParams({ ...params }).toString()
  const ctl = new AbortController()
  const t = setTimeout(() => ctl.abort(), timeoutMs)
  let body
  const headers = {}
  if (form) { body = form; }
  else { body = new URLSearchParams(fields); headers['Content-Type'] = 'application/x-www-form-urlencoded' }
  return fetch(url + (qs ? '?' + qs : ''), { method: 'POST', body, headers, signal: ctl.signal })
    .finally(() => clearTimeout(t))
}

async function uploadSlice(token, filePath, start, end) {
  const form = new FormData()
  const stream = createReadStream(filePath, { start, end: end - 1 })
  const chunks = []
  for await (const c of stream) chunks.push(c)
  form.append('file', new Blob([Buffer.concat(chunks)], { type: 'application/octet-stream' }), 'file')
  const res = await apiPost('https://d.pcs.baidu.com/rest/2.0/pcs/file', {
    params: { method: 'upload', type: 'tmpfile', access_token: token }, form
  })
  const j = await res.json()
  if (!j.md5) throw new Error(`分片上传失败: ${JSON.stringify(j).slice(0, 200)}`)
  return j.md5
}

// 上传单个文件（阻塞式，供录制完成后调用）
// 方案：bypy CLI 上传；进度用本地估算——读 /proc/<pid>/io 的 read_bytes
// （bypy 读完整个文件即认为本地已传完，显示 99%），延时几秒后用 bypy meta
// 查询网盘是否已有该文件，查到则 100%；不查百度资源，速度纯本地计算
export async function uploadToBaidu(filePath) {
  if (!existsSync(filePath) || statSync(filePath).size <= 0) throw new Error('文件不存在或为空: ' + filePath)
  const remote = remoteDir() + '/' + path.basename(filePath)
  const size = statSync(filePath).size

  if (uploadStatus.active) {
    log.info('[百度网盘] 已有上传任务进行中，等待其完成...')
    while (uploadStatus.active) await new Promise(r => setTimeout(r, 5000))
  }
  Object.assign(uploadStatus, {
    active: true, file: path.basename(filePath), remote, uploaded: 0, total: size,
    speed: 0, startedAt: Date.now(), finishedAt: null, ok: null, error: null
  })
  log.info(`[百度网盘] 开始上传: ${path.basename(filePath)} (${(size / 1048576).toFixed(1)}MB)`)

  try {
    await bypyUpload(filePath, size)
    // 本地已读完，进入确认阶段：显示 99%，延时几秒查询网盘
    uploadStatus.uploaded = size
    uploadStatus.speed = 0
    log.info('[百度网盘] 本地上传完成，等待几秒后查询网盘确认...')
    await new Promise(r => setTimeout(r, 5000))
    const found = await bypyRemoteExists(path.basename(filePath))
    if (!found) {
      // 再等一轮重查一次
      await new Promise(r => setTimeout(r, 5000))
      const found2 = await bypyRemoteExists(path.basename(filePath))
      if (!found2) throw new Error('本地上传完成，但网盘中未查询到该文件（可稍后在网盘刷新查看）')
    }
    Object.assign(uploadStatus, { active: false, finishedAt: Date.now(), uploaded: size, ok: true, error: null })
    log.info(`[百度网盘] 上传完成并确认: ${remote}`)
    return true
  } catch (err) {
    Object.assign(uploadStatus, { active: false, finishedAt: Date.now(), ok: false, error: err.message, _verifying: false })
    log.error(`[百度网盘] 上传失败: ${err.message}`)
    throw err
  }
}

const fsMod = await import('node:fs')

// 本地估算进度：统计 bypy 进程树（含 --processes 的 worker 子进程）的
// wchar（write 字节，主要是 socket 写入）≈ 已发往网络的数据量。
// 不用 rchar/read_bytes：本地读文件（页缓存）也计入，会导致进度瞬间到 100%。
function procTreeWchar(pid) {
  // 收集 pid 及其所有后代
  const tree = new Set([pid])
  let pids = []
  try { pids = fsMod.readdirSync('/proc').filter(d => /^\d+$/.test(d)) } catch { return 0 }
  const ppids = new Map()
  for (const p of pids) {
    try {
      const s = fsMod.readFileSync(`/proc/${p}/stat`, 'utf8')
      const m = s.match(/^\d+\s+\(.*?\)\s+\S+\s+(\d+)/)  // 第 4 字段 ppid
      if (m) ppids.set(Number(p), Number(m[1]))
    } catch { /* 进程已退出 */ }
  }
  let grew = true
  while (grew) {
    grew = false
    for (const [p, pp] of ppids) {
      if (tree.has(pp) && !tree.has(p)) { tree.add(p); grew = true }
    }
  }
  let total = 0
  for (const p of tree) {
    try {
      const io = fsMod.readFileSync(`/proc/${p}/io`, 'utf8')
      const m = io.match(/wchar:\s*(\d+)/)
      if (m) total += Number(m[1])
    } catch { /* 进程已退出 */ }
  }
  return total
}

function bypyUpload(filePath, size) {
  const proc = spawn(bypyBin(), ['--processes', '4', 'upload', filePath, remoteDir() + '/'], { windowsHide: true })
  currentProc = proc
  let out = '', err = ''
  proc.stdout.on('data', d => { out += d })
  proc.stderr.on('data', d => { err += d })
  return new Promise((resolve, reject) => {
    let lastT = Date.now(), lastB = 0
    const poll = setInterval(() => {
      try {
        const bytes = procTreeWchar(proc.pid)
        uploadStatus.uploaded = Math.min(size, Math.max(uploadStatus.uploaded, bytes))
        const now = Date.now(), dt = (now - lastT) / 1000
        if (dt >= 1) {
          const delta = uploadStatus.uploaded - lastB
          uploadStatus.speed = Math.max(0, Math.floor(delta / dt))
          lastT = now; lastB = uploadStatus.uploaded
        }
      } catch { /* 进程可能已退出 */ }
    }, 1000)
    proc.on('error', e => { clearInterval(poll); currentProc = null; reject(new Error(e.message)) })
    proc.on('close', (code, signal) => {
      clearInterval(poll)
      currentProc = null
      if (code !== 0) {
        const cancelled = signal === 'SIGKILL' || signal === 'SIGTERM' || code === -9 || code === 20 ||
          err.includes('已取消') || err.includes('Signal 15')
        reject(new Error(cancelled ? '已取消' : `bypy 退出码 ${code}: ${(err || out).slice(-300)}`))
      }
      else resolve(true)
    })
  })
}

// 查询网盘是否已有该文件（bypy meta 只查元数据，不下载）
function bypyRemoteExists(name) {
  return new Promise(resolve => {
    const proc = spawn(bypyBin(), ['meta', 'live-rec/' + name], { windowsHide: true })
    let out = '', err = ''
    proc.stdout.on('data', d => { out += d })
    proc.stderr.on('data', d => { err += d })
    proc.on('error', () => resolve(false))
    proc.on('close', code => {
      const text = (out + err)
      // 成功时 bypy 输出形如 "F NoSubDir <name> <size> ..."；失败时含 No such / 不存在
      resolve(code === 0 && /\bF\s/.test(text) && !/No such|不存在|failed/i.test(text))
    })
  })
}

function runBypy(args, stdinData = '', timeoutMs = 60000) {
  return new Promise(resolve => {
    const proc = spawn(bypyBin(), args, { windowsHide: true })
    let out = '', err = ''
    const timer = timeoutMs > 0 ? setTimeout(() => { try { proc.kill('SIGKILL') } catch {} }, timeoutMs) : null
    proc.stdout.on('data', d => { out += d })
    proc.stderr.on('data', d => { err += d })
    if (stdinData) { try { proc.stdin.write(stdinData) } catch {} }
    proc.stdin.end()
    proc.on('error', e => { if (timer) clearTimeout(timer); resolve({ code: -1, out, err: e.message }) })
    proc.on('close', code => { if (timer) clearTimeout(timer); resolve({ code, out, err }) })
  })
}

// 检测授权状态；未授权时返回 authUrl
export async function testBypyConnection() {
  try { readBypyToken(); } catch {
    // 没有本地授权文件，触发 bypy 走授权流程拿链接
    const r = await runBypy(['--processes', '1', 'info'], '', 30000)
    const text = (r.out + '\n' + r.err)
    const m = text.match(/https:\/\/openapi\.baidu\.com[^\s"']+/)
    return { ok: false, needAuth: true, authUrl: m ? m[0] : null, raw: text.slice(0, 800) }
  }
  // 有 token，直接调 uinfo 验证
  const { token } = readBypyToken()
  const res = await apiPost('https://pan.baidu.com/rest/2.0/pcs/file', {
    params: { method: 'uinfo', access_token: token }
  }, 15000).catch(e => null)
  if (!res) return { ok: false, needAuth: false, raw: 'uinfo 请求失败' }
  const j = await res.json().catch(() => ({}))
  if (j.errno !== undefined && j.errno !== 0) return { ok: false, needAuth: false, raw: 'uinfo errno=' + j.errno }
  return { ok: true, needAuth: false, raw: JSON.stringify({ baidu_name: j.baidu_name || j.netdisk_name }) }
}

// 用户拿到授权码后提交，完成绑定（写回 bypy 配置）
export async function submitBypyAuthCode(code) {
  if (!code || !code.trim()) return { ok: false, raw: '授权码为空' }
  const r = await runBypy(['--processes', '1', 'info'], code.trim() + '\n', 90000)
  const text = r.out + '\n' + r.err
  const ok = r.code === 0 && !/auth|授权码/.test(text.slice(-200))
  return { ok, raw: text.slice(0, 800) }
}

// 录制完成后调用：检查开关，异步上传不阻塞录制
export function maybeUploadToBaidu(filePath) {
  const cfg = loadConfig().baidu || {}
  if (!cfg.enabled) return
  if (!filePath || !existsSync(filePath)) return
  if (statSync(filePath).size <= 0) return
  uploadToBaidu(filePath).catch(err => log.error(`[百度网盘] 上传失败: ${err.message}`))
}
