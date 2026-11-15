// live-rec-hinas 服务端：HTTP API + 静态 UI + 鉴权 + 调度启动
import http from 'node:http'
import { createHash, randomBytes } from 'node:crypto'
import { createReadStream, existsSync, statSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { loadConfig, updateConfig, ensureDirs, saveFolderPath } from './core/config.js'
import { ROOT, VERSION } from './core/paths.js'
import { log, getLogs, clearLogs, initLog } from './core/log.js'
import { getTask, getTasks, addTask, removeTask, updateTask, getHistory } from './core/store.js'
import { getSite, matchSite, roomFromUrl, siteListForUI } from './core/sites.js'
import { startScheduler, stopScheduler, runNow, shutdown } from './core/scheduler.js'
import {
  getRecording, removeRecording, activeCount, totalRecordingSize
} from './core/recorder.js'
import { fetchWithAgent } from './core/fetcher.js'

const startedAt = Date.now()

function json(res, code, data) {
  const body = JSON.stringify(data)
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  })
  res.end(body)
}

function readBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', c => {
      size += c.length
      if (size > limit) { reject(new Error('body too large')); req.destroy(); return }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

async function readJson(req) {
  const raw = await readBody(req)
  if (!raw) return {}
  try { return JSON.parse(raw) } catch { return {} }
}

// ---------- 鉴权 ----------
function tokenOf(password) {
  return createHash('sha256').update(`live-rec-hinas|${password}`).digest('hex')
}

function parseCookies(req) {
  const header = req.headers.cookie || ''
  const out = {}
  for (const part of header.split(';')) {
    const idx = part.indexOf('=')
    if (idx === -1) continue
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim())
  }
  return out
}

function authed(req) {
  const cfg = loadConfig()
  if (!cfg.password) return true
  const cookies = parseCookies(req)
  return cookies.lrv_token === tokenOf(cfg.password)
}

// ---------- 任务 ----------
function taskView(task) {
  const rec = getRecording(task.id)
  return {
    id: task.id,
    url: task.url,
    site: task.site,
    room: task.room,
    enabled: task.enabled,
    createdAt: task.createdAt,
    lastStatus: task.lastStatus || '',
    lastCheck: task.lastCheck || 0,
    lastError: task.lastError || '',
    recording: rec ? rec.info() : { recording: false, paused: false, timeRec: 0, fileSize: 0, files: [], outputPath: null, retryCount: 0, url: null, startedAt: null, stats: {} }
  }
}

function stateView() {
  const cfg = loadConfig()
  return {
    ok: true,
    version: VERSION,
    node: process.version,
    platform: `${os.arch()} ${os.type()}`,
    startedAt,
    uptime: Date.now() - startedAt,
    savefolder: saveFolderPath(),
    activeCount: activeCount(),
    totalSize: totalRecordingSize(),
    hasPassword: !!cfg.password,
    authed: true,
    sites: siteListForUI(),
    tasks: getTasks().map(taskView),
    history: getHistory().slice(-100).reverse()
  }
}

function newId() {
  return randomBytes(6).toString('hex')
}

async function apiAddTask(req, res) {
  const body = await readJson(req)
  const url = String(body.url || '').trim()
  if (!url) return json(res, 400, { ok: false, error: '缺少 URL' })
  const withProto = /^https?:\/\//i.test(url) ? url : `https://${url}`
  const site = matchSite(withProto)
  if (!site) return json(res, 400, { ok: false, error: '无法识别站点（支持：chaturbate / stripchat / bongacams / cam4 / camsoda / dreamcam）' })
  const room = roomFromUrl(withProto)
  if (!room) return json(res, 400, { ok: false, error: 'URL 中未找到房间名' })
  const tasks = getTasks()
  if (tasks.some(t => t.site === site && t.room === room)) {
    return json(res, 409, { ok: false, error: `任务已存在：${site}/${room}` })
  }
  const task = {
    id: newId(),
    url: withProto,
    site,
    room,
    enabled: body.enabled !== false,
    createdAt: Date.now(),
    lastStatus: '',
    lastCheck: 0,
    lastError: ''
  }
  addTask(task)
  log.info(`task added: ${site}/${room}`)
  runNow(task.id)
  json(res, 200, { ok: true, task: taskView(task) })
}

async function apiTaskAction(req, res) {
  const body = await readJson(req)
  const { id, action } = body
  const task = getTask(id)
  if (!task) return json(res, 404, { ok: false, error: '任务不存在' })
  switch (action) {
    case 'enable':
      updateTask(id, { enabled: true, lastError: '' })
      runNow(id)
      break
    case 'disable':
      updateTask(id, { enabled: false })
      removeRecording(id)
      break
    case 'delete':
      removeRecording(id)
      removeTask(id)
      break
    case 'check':
      runNow(id)
      break
    default:
      return json(res, 400, { ok: false, error: `未知操作: ${action}` })
  }
  json(res, 200, { ok: true })
}

async function apiResolve(req, res) {
  const body = await readJson(req)
  const url = String(body.url || '').trim()
  if (!url) return json(res, 400, { ok: false, error: '缺少 URL' })
  const withProto = /^https?:\/\//i.test(url) ? url : `https://${url}`
  const site = matchSite(withProto)
  if (!site) return json(res, 400, { ok: false, error: '无法识别站点' })
  const room = roomFromUrl(withProto)
  if (!room) return json(res, 400, { ok: false, error: 'URL 中未找到房间名' })
  const inst = getSite(site)
  try {
    const info = await inst.getInfo(room)
    let out = { site, room, status: info.status, thumb: info.thumb || '', url: '', resolutions: [] }
    if (info.status !== inst.status_types.OFFLINE && info.status !== inst.status_types.NOT_EXIST) {
      const extract = await inst.extract(room, info)
      out.url = extract.url || ''
      out.resolutions = (extract.resolutions || []).map(r => ({
        resolution: r.resolution ? `${r.resolution.width}x${r.resolution.height}` : '',
        fps: r.fps || '',
        url: r.url || ''
      })).slice(0, 8)
    }
    json(res, 200, { ok: true, result: out })
  } catch (err) {
    json(res, 200, { ok: true, result: { site, room, status: 'error', error: err.message, url: '', resolutions: [] } })
  }
}

async function apiConfigGet(req, res) {
  const cfg = loadConfig()
  const view = { ...cfg, password: cfg.password ? '********' : '' }
  json(res, 200, { ok: true, config: view, restartNeeded: false })
}

async function apiConfigPost(req, res) {
  const body = await readJson(req)
  const prevPort = loadConfig().port
  const patch = {}
  for (const k of Object.keys(loadConfig())) {
    if (body[k] !== undefined) {
      if (k === 'password') {
        // 留空字符串 = 清除密码；******** = 保持不变
        if (body.password === '********') continue
        patch.password = String(body.password)
      } else {
        patch[k] = body[k]
      }
    }
  }
  const cfg = updateConfig(patch)
  log.info('config updated')
  json(res, 200, {
    ok: true,
    restartNeeded: cfg.port !== prevPort,
    config: { ...cfg, password: cfg.password ? '********' : '' }
  })
}

// ---------- 静态文件 ----------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.mkv': 'video/x-matroska',
  '.ts': 'video/mp2t',
  '.mp4': 'video/mp4',
  '.flv': 'video/x-flv'
}

const PUBLIC_DIR = path.join(ROOT, 'public')
const DOWNLOAD_MIME = new Set(['.mkv', '.ts', '.mp4', '.flv'])

function serveFile(res, filePath, inline = false) {
  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    res.writeHead(404); res.end('Not Found'); return
  }
  const ext = path.extname(filePath).toLowerCase()
  const headers = {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Content-Length': statSync(filePath).size,
    'Cache-Control': 'no-store'
  }
  if (DOWNLOAD_MIME.has(ext) && !inline) {
    headers['Content-Disposition'] = `attachment; filename="${encodeURIComponent(path.basename(filePath))}"`
  }
  res.writeHead(200, headers)
  createReadStream(filePath).pipe(res)
}

function serveSavedFile(req, res, pathname) {
  // /files/<相对路径> -> savefolder 下文件（供局域网直接下载录像）
  const rel = decodeURIComponent(pathname.replace(/^\/files\/?/, ''))
  if (!rel) { res.writeHead(404); res.end(); return }
  const base = path.resolve(saveFolderPath())
  const full = path.resolve(base, rel)
  if (!full.startsWith(base)) { res.writeHead(403); res.end(); return }
  serveFile(res, full, true)
}

// ---------- 路由 ----------
async function handleApi(req, res, pathname) {
  const method = req.method

  if (pathname === '/api/login' && method === 'POST') {
    const body = await readJson(req)
    const cfg = loadConfig()
    if (!cfg.password) return json(res, 200, { ok: true, token: tokenOf('') })
    if (String(body.password || '') === cfg.password) {
      res.setHeader('Set-Cookie', `lrv_token=${tokenOf(cfg.password)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`)
      return json(res, 200, { ok: true })
    }
    return json(res, 401, { ok: false, error: '密码错误' })
  }

  if (!authed(req)) return json(res, 401, { ok: false, error: '需要登录' })

  switch (pathname) {
    case '/api/state':
      return json(res, 200, stateView())
    case '/api/task':
      if (method === 'POST') return apiAddTask(req, res)
      break
    case '/api/task/action':
      if (method === 'POST') return apiTaskAction(req, res)
      break
    case '/api/resolve':
      if (method === 'POST') return apiResolve(req, res)
      break
    case '/api/config':
      if (method === 'GET') return apiConfigGet(req, res)
      if (method === 'POST') return apiConfigPost(req, res)
      break
    case '/api/logs': {
      const u = new URL(req.url, 'http://x')
      const since = Number(u.searchParams.get('since') || 0)
      const r = getLogs(since)
      return json(res, 200, { ok: true, ...r })
    }
    case '/api/logs/clear':
      if (method === 'POST') { clearLogs(); return json(res, 200, { ok: true }) }
      break
    case '/api/history':
      return json(res, 200, { ok: true, history: getHistory().slice(-300).reverse() })
    case '/api/probe': {
      // 手动测试某个 URL 的可访问性（诊断用）
      const body = await readJson(req)
      try {
        const r = await fetchWithAgent(String(body.url || ''), { timeout: undefined })
        return json(res, 200, { ok: true, status: r.status })
      } catch (err) {
        return json(res, 200, { ok: false, error: err.message })
      }
    }
    default:
      break
  }
  json(res, 404, { ok: false, error: 'not found' })
}

const server = http.createServer(async (req, res) => {
  let pathname = '/'
  try { pathname = new URL(req.url, 'http://x').pathname } catch {}
  try {
    if (pathname.startsWith('/api/')) return await handleApi(req, res, pathname)
    if (pathname.startsWith('/files/')) {
      if (!authed(req)) { res.writeHead(401); res.end(); return }
      return serveSavedFile(req, res, pathname)
    }
    if (pathname === '/' || pathname === '/index.html') return serveFile(res, path.join(PUBLIC_DIR, 'index.html'))
    if (pathname === '/app.js') return serveFile(res, path.join(PUBLIC_DIR, 'app.js'))
    if (pathname === '/style.css') return serveFile(res, path.join(PUBLIC_DIR, 'style.css'))
    res.writeHead(404); res.end('Not Found')
  } catch (err) {
    log.error(`http error: ${err.message}`)
    try { json(res, 500, { ok: false, error: err.message }) } catch {}
  }
})

function main() {
  ensureDirs()
  initLog()
  let port = loadConfig().port
  const argIdx = process.argv.indexOf('--port')
  if (argIdx !== -1 && process.argv[argIdx + 1]) port = Number(process.argv[argIdx + 1]) || port
  if (process.env.PORT) port = Number(process.env.PORT) || port

  server.listen(port, '0.0.0.0', () => {
    log.info(`live-rec-hinas v${VERSION} listening on http://0.0.0.0:${port}`)
    log.info(`node ${process.version}, platform ${os.arch()} ${os.type()}`)
    log.info(`recordings -> ${saveFolderPath()}`)
    const ff = loadConfig().ffmpegselect || ''
    if (ff.toLowerCase().endsWith('.exe') && process.platform !== 'win32') {
      log.warn(`ffmpegselect 指向 Windows 程序 (${ff})，在 Linux 上已忽略，将使用 PATH 中的 ffmpeg`)
    }
    if (process.env.LRH_NO_SCHED) {
      log.info('scheduler disabled (LRH_NO_SCHED=1, debug mode)')
    } else {
      startScheduler()
    }
  })

  server.on('error', err => {
    log.error(`server error: ${err.message}`)
    process.exit(1)
  })

  let shuttingDown = false
  const doShutdown = (sig) => {
    if (shuttingDown) return
    shuttingDown = true
    log.info(`received ${sig}, shutting down...`)
    try { shutdown() } catch {}
    server.close(() => process.exit(0))
    setTimeout(() => process.exit(0), 4000)
  }
  process.on('SIGINT', () => doShutdown('SIGINT'))
  process.on('SIGTERM', () => doShutdown('SIGTERM'))
}

main()
