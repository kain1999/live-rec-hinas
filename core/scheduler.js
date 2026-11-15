// 自治调度器 —— 渲染层轮询逻辑的服务端化：
// 在线 -> 起录（按站点走对应本地代理）；私播 -> 暂停；下播 -> 停止并合并；
// 离线低频轮询，录制中高频轮询；磁盘水位保护；并发上限。
import { statfsSync } from 'node:fs'
import { loadConfig, saveFolderPath } from './config.js'
import { log } from './log.js'
import { getTask, getTasks, scheduleSave } from './store.js'
import { getSite } from './sites.js'
import {
  getOrCreateRecording, getRecording, stopAllRecordings,
  allRecordings, activeCount, setRecorderNotify
} from './recorder.js'
import CBProxy from '../lib/cb-proxy.js'
import StripchatProxy from '../lib/stripchat-proxy.js'
import CamsodaProxy from '../lib/camsoda-proxy.js'

const timers = new Map()
let running = false
let diskTimer = null
let lastDiskWarn = 0
let camsodaProxy = null

async function ensureCamsodaProxy() {
  if (!camsodaProxy) camsodaProxy = new CamsodaProxy()
  await camsodaProxy.start()
  return camsodaProxy
}

function camsodaIdleCheck() {
  const busy = getTasks().some(t => t.site === 'camsoda' && (getRecording(t.id)?.recording || getRecording(t.id)?.paused))
  if (!busy && camsodaProxy) {
    camsodaProxy.stop()
    camsodaProxy = null
  }
}

// 录制结束/状态变化 -> 清理代理 + 保存
setRecorderNotify((type, taskId) => {
  const task = getTask(taskId)
  if (!task) return
  if (type === 'finalized') {
    CBProxy.stopProxy(task.room)
    StripchatProxy.stopProxy(task.room)
    camsodaIdleCheck()
  }
  scheduleSave()
})

export function startScheduler() {
  if (running) return
  running = true
  const tasks = getTasks()
  tasks.forEach((t, i) => scheduleTask(t, 2500 + i * 1500))
  diskTimer = setInterval(diskGuard, 60000)
  log.info(`scheduler started: ${tasks.length} task(s)`)
}

export function stopScheduler() {
  running = false
  for (const t of timers.values()) clearTimeout(t)
  timers.clear()
  if (diskTimer) { clearInterval(diskTimer); diskTimer = null }
}

export function shutdown() {
  stopScheduler()
  stopAllRecordings()
  try { CBProxy.stopProxy('*') } catch {}
  for (const rec of allRecordings()) {
    const task = rec.task
    if (task) { try { CBProxy.stopProxy(task.room) } catch {}; try { StripchatProxy.stopProxy(task.room) } catch {} }
  }
  if (camsodaProxy) { camsodaProxy.stop(); camsodaProxy = null }
  scheduleSave()
}

function scheduleTask(task, delay) {
  if (timers.has(task.id)) clearTimeout(timers.get(task.id))
  const jitter = Math.floor(delay * 0.05 * (Math.random() * 2 - 1))
  const d = Math.max(2000, delay + jitter)
  timers.set(task.id, setTimeout(() => {
    timers.delete(task.id)
    loopTask(task)
  }, d))
}

export function runNow(taskId) {
  const t = getTask(taskId)
  if (t) scheduleTask(t, 100)
}

export function rescheduleTask(taskId) {
  const t = getTask(taskId)
  if (t && running) scheduleTask(t, 100)
}

async function resolveRecUrl(inst, task) {
  try {
    if (task.site === 'chaturbate' && inst.getStreamUrlForRec) {
      const r = await inst.getStreamUrlForRec(task.room, '', null)
      return r?.url || null
    }
    if (task.site === 'stripchat' && inst.getStreamUrlForRec) {
      const r = await inst.getStreamUrlForRec(task.room, null)
      return r?.url || null
    }
    if (task.site === 'camsoda') {
      const info = await inst.getInfo(task.room)
      if (info.status !== inst.status_types.ONLINE) return null
      const res = await inst.extract(task.room, info)
      if (!res.url) return null
      const proxy = await ensureCamsodaProxy()
      return proxy.proxyUrl(res.url)
    }
    const res = await inst.extract(task.room)
    return res.url || res.resolutions?.[0]?.url || null
  } catch (err) {
    log.warn(`resolveRecUrl failed (${task.site}/${task.room}): ${err.message}`)
    return null
  }
}

async function loopTask(task) {
  if (!running) return
  const cfg = loadConfig()

  if (!task.enabled) {
    task.lastStatus = 'disabled'
    scheduleTask(task, Math.max(30000, cfg.offlinepollinterval))
    return
  }

  const inst = getSite(task.site)
  if (!inst) {
    task.lastError = `unknown site: ${task.site}`
    scheduleTask(task, 60000)
    return
  }

  try {
    const rec = getOrCreateRecording(task)

    if (rec.recording) {
      const st = await inst.update(task.room)
      rec.check(st.status)
      task.lastStatus = st.status
      task.lastCheck = Date.now()
      task.lastError = ''
      scheduleTask(task, Math.max(10000, cfg.pollinterval))
    } else if (rec.paused) {
      const st = await inst.update(task.room)
      task.lastStatus = st.status
      task.lastCheck = Date.now()
      if (st.status === 'online') {
        const url = await resolveRecUrl(inst, task)
        if (url) {
          rec.resume(url)
          scheduleTask(task, Math.max(10000, cfg.pollinterval))
        } else {
          scheduleTask(task, Math.max(5000, cfg.retryinterval))
        }
      } else if (st.status === 'offline' || st.status === 'not exist') {
        rec.check('offline')
        scheduleTask(task, Math.max(30000, cfg.offlinepollinterval))
      } else {
        scheduleTask(task, Math.max(10000, cfg.pollinterval))
      }
    } else {
      const st = await inst.update(task.room)
      task.lastStatus = st.status
      task.lastCheck = Date.now()
      if (st.status === 'online') {
        if (cfg.maxconcurrent > 0 && activeCount() >= cfg.maxconcurrent) {
          task.lastError = '并发录制已达上限'
          scheduleTask(task, Math.max(5000, cfg.retryinterval))
          return
        }
        const url = await resolveRecUrl(inst, task)
        if (url) {
          log.info(`start recording: ${task.site}/${task.room}`)
          rec.start(url, { referer: `https://${inst.config.domain}/`, fresh: true })
          task.lastError = ''
        } else {
          task.lastError = '获取直播地址失败'
          log.warn(`cannot resolve stream url for ${task.site}/${task.room}`)
        }
        scheduleTask(task, Math.max(5000, cfg.retryinterval))
      } else if (st.status === 'private') {
        scheduleTask(task, Math.max(10000, cfg.pollinterval))
      } else {
        task.lastError = ''
        scheduleTask(task, Math.max(15000, cfg.offlinepollinterval))
      }
    }
    scheduleSave()
  } catch (err) {
    task.lastError = err.message
    log.warn(`task loop error (${task.site}/${task.room}): ${err.message}`)
    scheduleTask(task, 60000)
  }
}

function diskGuard() {
  try {
    const sf = saveFolderPath()
    const s = statfsSync(sf)
    const freeMB = Math.floor(Number(s.bsize) * Number(s.bavail) / 1048576)
    const min = Number(loadConfig().minfreespacemb) || 0
    if (min > 0 && freeMB < min) {
      if (Date.now() - lastDiskWarn > 300000) {
        log.error(`disk space low: ${freeMB}MB free < ${min}MB, stopping all recordings`)
        lastDiskWarn = Date.now()
      }
      for (const rec of allRecordings()) {
        if (rec.recording || rec.paused) rec.stop('disk-full')
      }
    }
  } catch { /* ignore */ }
}
