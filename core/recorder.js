// ffmpeg 录制管理器 —— 对应原版 lib/tools.class.js 的 rec/recInit/rec 语义：
// 重连 6 次（4s*次数，上限 15s）、私播暂停、文件大小/时长切分、停止后 concat 合并。
import { spawn, execFile } from 'node:child_process'
import { existsSync, mkdirSync, statSync, renameSync, unlinkSync, writeFileSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { loadConfig, saveFolderPath, ffmpegPath } from './config.js'
import { log } from './log.js'
import { addHistory } from './store.js'
import { maybeUploadToBaidu } from '../lib/baidu-netdisk.js'
import { maybeUploadToFilehost } from '../lib/filehost-upload.js'
import { dateFormat } from './dateutil.js'

const RECOVERABLE_ERRORS = [
  'End of file', 'end of file', 'EOF',
  'Connection reset', 'connection reset',
  'Timed out', 'timed out',
  'Connection refused', 'connection refused',
  'Connection failed', 'connection failed',
  'Network is unreachable', 'network is unreachable',
  'No route to host', 'no route to host',
  'I/O error', 'i/o error',
  'Error number -138', 'error number -138',
  'Server returned 5',
  'exit signal',
  'Input/output error',
  '400 Bad Request', '403 Forbidden', '404 Not Found', '410 Gone', '502 Bad Gateway', '503 Service Unavailable'
]

function isRecoverable(errMessage) {
  return RECOVERABLE_ERRORS.some(e => (errMessage || '').includes(e))
}

const recordings = new Map()
let notifyFn = null

export function setRecorderNotify(fn) { notifyFn = fn }
function notify(type, taskId) {
  try { if (notifyFn) notifyFn(type, taskId) } catch {}
}

export function getRecording(taskId) { return recordings.get(taskId) || null }
export function getOrCreateRecording(task) {
  let rec = recordings.get(task.id)
  if (!rec) {
    rec = new Recording(task)
    recordings.set(task.id, rec)
  }
  return rec
}
export function removeRecording(taskId) {
  const rec = recordings.get(taskId)
  if (rec) rec.stop('removed')
  recordings.delete(taskId)
}
export function allRecordings() { return [...recordings.values()] }
export function stopAllRecordings() {
  for (const rec of recordings.values()) {
    if (rec.recording || rec.paused) rec.stop('shutdown')
  }
}
export function activeCount() {
  let n = 0
  for (const rec of recordings.values()) if (rec.recording || rec.paused) n++
  return n
}
export function totalRecordingSize() {
  let total = 0
  for (const rec of recordings.values()) {
    if (!rec.recording && !rec.paused) continue
    total += rec.currentSize()
  }
  return total
}

export class Recording {
  constructor(task) {
    this.task = task
    this.proc = null
    this.recording = false
    this.paused = false
    this.pausedAt = null
    this.pausedAccumulator = 0
    this.pendingEnd = false // 流断开后待确认：等状态检测裁决离线/私播/恢复
    this.startTime = null
    this.retryCount = 0
    this.retryMax = 6
    this.retryDelay = 4000
    this.keepAlive = false
    this.files = []          // 本次会话已完成分段
    this.outputPath = null   // 当前写入文件
    this.lastUrl = null
    this.referer = ''
    this.cookies = ''
    this.rotate = false
    this.stopping = false
    this.lastErrLine = ''
    this.fileMs = 0
    this.stats = { size: 0, timeText: '', resolution: '', codec: '', bitrate: '' }
    this.sizeTimer = null
    this.reconnectTimer = null
    this.concatRunning = false
  }

  #fileDate() {
    const cfg = loadConfig()
    const fmtRaw = String(cfg.dateformat || '')
    const originalformat = fmtRaw.replace('model-', '').replace('site-', '').trim()
    const prefix = [
      fmtRaw.includes('model-') ? this.task.room : '',
      fmtRaw.includes('site-') ? this.task.site : ''
    ].filter(Boolean).join('-')
    const dateStr = dateFormat(originalformat || 'yyyy-MM-dd_hh-mm-ss', new Date())
    return prefix ? `${prefix}-${dateStr}` : dateStr
  }

  #ensureDir(dir) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  }

  #nextOutputPath() {
    const cfg = loadConfig()
    let dir = saveFolderPath()
    if (cfg.autocreatefolder) {
      const dateStr = dateFormat('yyyy-MM-dd', new Date())
      dir = path.join(dir, dateStr, `${this.task.site} - ${this.task.room}`)
    }
    this.#ensureDir(dir)
    const fmt = String(cfg.recformat || 'mkv').trim().replace(/^\./, '') || 'mkv'
    return path.join(dir, `${this.#fileDate()}.${fmt}`)
  }

  #inputOptions() {
    const cfg = loadConfig()
    const ua = cfg.useragent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:147.0) Gecko/20100101 Firefox/147.0'
    const isLocalProxy = this.task.site === 'chaturbate' || this.task.site === 'stripchat'
    const viaProxy = this.task.site === 'camsoda'
    let input
    if (isLocalProxy || viaProxy) {
      input = ['-live_start_index', '-1', '-user_agent', ua]
    } else {
      input = [
        '-reconnect', '1',
        '-reconnect_at_eof', '1',
        '-reconnect_streamed', '1',
        '-reconnect_on_network_error', '1',
        '-reconnect_delay_max', '3',
        '-live_start_index', '-1',
        '-user_agent', ua
      ]
    }
    if (this.cookies) input.push('-headers', `Cookie: ${this.cookies}\r\n`)
    if (this.referer) input.push('-referer', this.referer)
    return input
  }

  currentSize() {
    let total = 0
    const files = [...this.files, this.outputPath].filter(Boolean)
    for (const f of files) {
      try { if (existsSync(f)) total += statSync(f).size } catch {}
    }
    return total
  }

  getRecTime() {
    if ((!this.recording && !this.paused) || !this.startTime) return 0
    let time = Date.now() - this.startTime - (this.pausedAccumulator || 0)
    if (this.pausedAt) time -= (Date.now() - this.pausedAt)
    return Math.max(0, time)
  }

  info() {
    return {
      recording: this.recording,
      paused: this.paused,
      timeRec: this.getRecTime(),
      fileSize: this.currentSize(),
      files: [...this.files, this.outputPath].filter(Boolean),
      outputPath: this.outputPath,
      retryCount: this.retryCount,
      url: this.lastUrl,
      startedAt: this.startTime,
      stats: this.stats
    }
  }

  /**
   * 启动 ffmpeg。opts: { referer, cookies, reusePath, resume, fresh }
   */
  start(url, opts = {}) {
    if (this.proc) return
    if (!url) return
    const cfg = loadConfig()
    this.lastUrl = url
    if (opts.referer !== undefined) this.referer = opts.referer
    if (opts.cookies !== undefined) this.cookies = opts.cookies
    this.stopping = false
    this.keepAlive = true
    if (opts.fresh) this.retryCount = 0

    if (this.outputPath && existsSync(this.outputPath)) {
      if (!this.files.includes(this.outputPath)) this.files.push(this.outputPath)
    }
    if (!this.outputPath || (opts.resume && !opts.reusePath)) {
      this.outputPath = this.#nextOutputPath()
    }

    const input = this.#inputOptions()
    const extraParams = cfg.ffmpegparams ? String(cfg.ffmpegparams).trim().split(/\s+/).filter(Boolean) : []
    const outOpts = ['-c', 'copy', '-map', '0:v?', '-map', '0:a?', ...extraParams]
    const args = ['-hide_banner', '-nostdin', '-y', ...input, '-i', url, ...outOpts, this.outputPath]

    const bin = ffmpegPath()
    log.ffmpeg(`[spawn] ${bin} ${args.join(' ')}`)

    this.fileMs = 0
    let stderrBuf = ''
    try {
      this.proc = spawn(bin, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
    } catch (err) {
      log.error(`ffmpeg spawn failed (${this.task.room}): ${err.message}`)
      this.proc = null
      this.recording = false
      this.keepAlive = false
      this.task.lastError = `ffmpeg 启动失败: ${err.message}`
      notify('finalized', this.task.id)
      return
    }

    this.recording = true
    if (!this.startTime) this.startTime = Date.now()
    this.pausedAt = null

    this.proc.stderr.setEncoding('utf8')
    this.proc.stderr.on('data', chunk => {
      stderrBuf += chunk
      const lines = stderrBuf.split(/\r\n|\n|\r/)
      stderrBuf = lines.pop() || ''
      for (const line of lines) this.#onFfmpegLine(line)
    })

    this.proc.on('error', err => {
      log.error(`ffmpeg process error (${this.task.room}): ${err.message}`)
      this.lastErrLine = err.message
    })

    this.proc.on('close', (code) => {
      this.proc = null
      this.#stopSizeTimer()
      const wasRotate = this.rotate
      this.rotate = false
      this.recording = false

      if (this.paused) {
        // 私播暂停：保留会话，等恢复
        if (this.outputPath && existsSync(this.outputPath) && !this.files.includes(this.outputPath)) {
          this.files.push(this.outputPath)
        }
        log.info(`paused (${this.task.site}/${this.task.room}), file parts kept: ${this.files.length}`)
        notify('update', this.task.id)
        return
      }

      if (this.stopping) {
        this.#finalize('stopped')
        return
      }

      if (this.outputPath && existsSync(this.outputPath) && !this.files.includes(this.outputPath)) {
        this.files.push(this.outputPath)
      }

      if (wasRotate) {
        const ext = path.extname(this.outputPath || '')
        const base = (this.outputPath || '').slice(0, -ext.length)
        this.outputPath = `${base}.part${this.files.length}${ext}`
        log.info(`rotated file for ${this.task.room} -> ${path.basename(this.outputPath)}`)
        this.start(this.lastUrl, { reusePath: true, resume: true })
        return
      }

      const recoverable = code === 0 || isRecoverable(this.lastErrLine)
      if (recoverable && this.keepAlive && this.retryCount < this.retryMax && !this.paused) {
        this.retryCount++
        const delay = Math.min(this.retryDelay * this.retryCount, 15000)
        log.warn(`stream dropped (${this.task.room}), reconnect ${this.retryCount}/${this.retryMax} in ${delay}ms (code=${code})`)
        this.reconnectTimer = setTimeout(() => {
          this.reconnectTimer = null
          if (!this.stopping && !this.paused && this.keepAlive) this.start(this.lastUrl, { resume: true })
        }, delay)
      } else if (this.keepAlive && !this.paused) {
        // 流意外断开（私播/网络波动）：不立即 finalize 上传，保留已录片段，
        // 等状态检测确认真正离线（check 里的 pendingEnd 分支）再合并上传
        this.pendingEnd = true
        log.info(`stream ended (${this.task.room}), holding parts (${this.files.length}), waiting for offline confirmation`)
        notify('update', this.task.id)
      } else {
        if (this.keepAlive) {
          log.warn(`recording finished (${this.task.room}), code=${code}${this.lastErrLine ? ' last=' + this.lastErrLine : ''}`)
        }
        this.#finalize(code === 0 ? 'ended' : 'error')
      }
    })

    this.#startSizeTimer()
  }

  #onFfmpegLine(line) {
    const t = line.trim()
    if (!t) return
    const timeMatch = t.match(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/)
    if (timeMatch) {
      const ms = (Number(timeMatch[1]) * 3600 + Number(timeMatch[2]) * 60 + Number(timeMatch[3])) * 1000
      if (ms >= this.fileMs) {
        this.fileMs = ms
        this.stats.timeText = `${timeMatch[1]}:${timeMatch[2]}:${timeMatch[3].split('.')[0].padStart(2, '0')}`
      }
    }
    const sizeMatch = t.match(/size=\s*(\d+)kB/)
    if (sizeMatch) this.stats.size = Number(sizeMatch[1]) * 1024
    const bitrateMatch = t.match(/bitrate=\s*([\d.]+\s*\w+\/s)/)
    if (bitrateMatch) this.stats.bitrate = bitrateMatch[1]
    if (t.includes('Stream #0:') && t.includes('Video:')) {
      const vm = t.match(/Video: ([^,]+),[^,]*, (\d{2,5})x(\d{2,5})/)
      if (vm) {
        const w = Number(vm[2]), h = Number(vm[3])
        // 取所有流中分辨率最大的，避免被预览/附加流覆盖
        const cur = (this.stats.resolution || '').match(/(\d+)x(\d+)/)
        if (!cur || w * h > Number(cur[1]) * Number(cur[2])) {
          this.stats.codec = vm[1].split(' ')[0]
          this.stats.resolution = `${vm[2]}x${vm[3]}`
        }
      }
    }
    if (t.startsWith('[') && (t.includes('Error') || t.includes('error') || t.includes('Failed') || t.includes('403') || t.includes('404'))) {
      this.lastErrLine = t
    }
  }

  #startSizeTimer() {
    this.#stopSizeTimer()
    this.sizeTimer = setInterval(() => {
      try {
        if (!this.outputPath || !existsSync(this.outputPath)) return
        const st = statSync(this.outputPath)
        this.stats.size = st.size
        const cfg = loadConfig()
        if (cfg.maxrecfilesize > 0 && st.size / 1048576 >= cfg.maxrecfilesize) {
          log.info(`file size limit reached for ${this.task.room} (${(st.size / 1048576).toFixed(1)}MB), splitting`)
          this.rotate = true
          this.#kill()
        } else if (cfg.maxrecduration > 0 && this.fileMs >= cfg.maxrecduration * 1000) {
          log.info(`duration limit reached for ${this.task.room} (${Math.round(this.fileMs / 1000)}s), splitting`)
          this.rotate = true
          this.#kill()
        }
      } catch { /* ignore */ }
    }, 5000)
  }

  #stopSizeTimer() {
    if (this.sizeTimer) { clearInterval(this.sizeTimer); this.sizeTimer = null }
  }

  #kill() {
    if (!this.proc) return
    try { this.proc.kill('SIGTERM') } catch {}
    setTimeout(() => {
      try { if (this.proc) this.proc.kill('SIGKILL') } catch {}
    }, 4000)
  }

  check(status) {
    const cfg = loadConfig()
    if (this.pendingEnd) {
      // 流已断开但未确认结束：等状态检测裁决
      if (status === 'offline' || status === 'not exist') {
        log.info(`model ${this.task.room} confirmed offline (pendingEnd), finalizing & uploading`)
        this.pendingEnd = false
        this.keepAlive = false
        this.#finalize('offline')
        return
      }
      if (status === 'private') {
        log.info(`model ${this.task.room} in private show (pendingEnd), waiting as paused`)
        this.pendingEnd = false
        this.paused = true
        this.pausedAt = Date.now()
        notify('update', this.task.id)
        return
      }
      if (status === 'online') {
        log.info(`model ${this.task.room} back online (pendingEnd), resuming recording`)
        this.pendingEnd = false
        this.start(this.lastUrl, { resume: true })
        return
      }
      return // 未知状态：继续等下一轮检测
    }
    if (status === 'offline' || status === 'not exist') {
      if (this.paused) {
        log.info(`model ${this.task.room} confirmed offline (was paused)`)
        this.#finalize('offline')
      } else if (this.recording) {
        log.info(`model ${this.task.room} went offline, stopping`)
        this.stop('offline')
      }
    } else if (status === 'private') {
      if (this.recording) {
        if (cfg.pauseforprivate !== false) {
          log.info(`model ${this.task.room} went private, pausing`)
          this.pause()
        } else {
          log.info(`model ${this.task.room} went private (pause disabled), stopping`)
          this.stop('private')
        }
      }
    } else if (status === 'online') {
      // 恢复时间累计由 resume() 处理
    }
  }

  pause() {
    if (!this.recording) return
    this.paused = true
    this.pausedAt = Date.now()
    this.recording = false
    this.#kill()
  }

  resume(url) {
    if (!this.paused) return
    this.pausedAccumulator += this.pausedAt ? (Date.now() - this.pausedAt) : 0
    this.pausedAt = null
    this.paused = false
    log.info(`resuming recording for ${this.task.room} after private`)
    this.start(url, { resume: true })
  }

  stop(reason = 'manual') {
    this.keepAlive = false
    this.pendingEnd = false
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null }
    this.stopping = true
    this.paused = false
    if (this.proc) {
      this.#kill()
      // 兜底：4.5s 后强制 finalize，防止 ffmpeg 不退出
      setTimeout(() => {
        if (this.stopping && !this.recording) { /* close handler already ran */ }
        if (this.stopping && this.proc) {
          try { this.proc.kill('SIGKILL') } catch {}
        }
      }, 4500)
    } else {
      this.#finalize(reason)
    }
  }

  #finalize(reason) {
    this.recording = false
    this.stopping = false
    this.keepAlive = false
    this.#stopSizeTimer()
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null }

    if (this.outputPath && existsSync(this.outputPath) && !this.files.includes(this.outputPath)) {
      this.files.push(this.outputPath)
    }
    const files = this.files.filter(f => f && existsSync(f))
    const finalOutput = this.outputPath || files[files.length - 1] || ''
    const startedAt = this.startTime
    const endedAt = Date.now()
    const totalSize = files.reduce((s, f) => { try { return s + statSync(f).size } catch { return s } }, 0)

    this.files = []
    this.outputPath = null
    this.startTime = null
    this.pausedAccumulator = 0
    this.pausedAt = null
    this.pendingEnd = false
    this.retryCount = 0

    const pushHistory = (file, size, parts) => {
      if (!file || !existsSync(file)) return
      addHistory({
        taskId: this.task.id,
        site: this.task.site,
        room: this.task.room,
        file,
        size,
        parts: parts && parts.length > 1 ? parts : undefined,
        startedAt,
        endedAt,
        reason
      })
      log.info(`history saved: ${path.basename(file)} (${(size / 1048576).toFixed(1)}MB, ${reason})`)
      notify('finalized', this.task.id)
      maybeUploadToBaidu(file)  // 录制完成自动上传百度网盘（开启时）
      maybeUploadToFilehost(file)  // 录制完成自动上传 Pixeldrain / Gofile（开启时，与百度互斥）
    }

    const cfg = loadConfig()
    if (files.length > 1 && cfg.concatonresume !== false && finalOutput) {
      this.concatRunning = true
      this.#concatFiles(files, finalOutput).then(ok => {
        this.concatRunning = false
        const size = ok ? totalSize : files.reduce((s, f) => { try { return s + statSync(f).size } catch { return s } }, 0)
        pushHistory(finalOutput, size, ok ? undefined : files)
      })
    } else if (files.length > 0) {
      pushHistory(files[files.length - 1], totalSize, files.length > 1 ? files : undefined)
    }
  }

  async #concatFiles(files, finalOutput) {
    return new Promise(resolve => {
      const cfg = loadConfig()
      const existing = files.filter(f => existsSync(f)).map(f => f.trim())
      if (existing.length <= 1) { resolve(true); return }

      const ext = path.extname(finalOutput)
      const tempOutput = finalOutput.slice(0, -ext.length) + '.tmp' + ext
      const cleanupSources = () => {
        for (const f of existing) {
          if (f !== finalOutput) { try { unlinkSync(f) } catch {} }
        }
      }

      log.info(`concatenating ${existing.length} parts for ${this.task.room}`)
      const finishFfmpeg = () => {
        const listPath = finalOutput + '.concat.txt'
        const listContent = existing.map(f => `file '${f.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n')
        try { writeFileSync(listPath, listContent) } catch { resolve(false); return }
        const bin = ffmpegPath()
        const proc = spawn(bin, ['-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', tempOutput], { windowsHide: true, stdio: 'ignore' })
        proc.on('error', () => { try { unlinkSync(listPath) } catch {}; resolve(false) })
        proc.on('close', code => {
          try { unlinkSync(listPath) } catch {}
          if (code === 0) {
            try { renameSync(tempOutput, finalOutput) } catch { resolve(false); return }
            cleanupSources()
            log.info(`concat done: ${path.basename(finalOutput)}`)
            resolve(true)
          } else {
            try { unlinkSync(tempOutput) } catch {}
            resolve(false)
          }
        })
      }

      if (cfg.mkvmergenable && ext.toLowerCase() === '.mkv') {
        const mkvmerge = cfg.mkvmergepath || 'mkvmerge'
        execFile(mkvmerge, ['-o', tempOutput, ...existing], { windowsHide: true }, err => {
          if (err) {
            log.warn(`mkvmerge concat failed (${err.message}), falling back to ffmpeg`)
            finishFfmpeg()
          } else {
            try { renameSync(tempOutput, finalOutput) } catch { resolve(false); return }
            cleanupSources()
            log.info(`mkvmerge concat done: ${path.basename(finalOutput)}`)
            resolve(true)
          }
        })
      } else {
        finishFfmpeg()
      }
    })
  }
}
