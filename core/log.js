import { appendFileSync, existsSync, renameSync, statSync, unlinkSync } from 'node:fs'
import path from 'node:path'
import { DATA_DIR, LOG_PATH } from './paths.js'

const MAX_BUFFER = 2000
const LOG_MAX_BYTES = 4 * 1024 * 1024

const buffer = []
let seq = 0

function rotateIfNeeded() {
  try {
    if (existsSync(LOG_PATH) && statSync(LOG_PATH).size > LOG_MAX_BYTES) {
      const old = LOG_PATH + '.old'
      try { if (existsSync(old)) unlinkSync(old) } catch {}
      renameSync(LOG_PATH, old)
    }
  } catch { /* ignore */ }
}

function push(level, args) {
  const msg = args.map(a => {
    if (a instanceof Error) return a.stack || a.message
    if (typeof a === 'object') { try { return JSON.stringify(a) } catch { return String(a) } }
    return String(a)
  }).join(' ').slice(0, 4000)

  const entry = { i: ++seq, t: Date.now(), level, msg }
  buffer.push(entry)
  if (buffer.length > MAX_BUFFER) buffer.splice(0, buffer.length - MAX_BUFFER)

  const line = `[${new Date(entry.t).toLocaleString('sv-SE')}] [${level.toUpperCase()}] ${msg}\n`
  try {
    appendFileSync(LOG_PATH, line)
    rotateIfNeeded()
  } catch { /* ignore */ }

  const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log
  fn(line.trimEnd())
}

export const log = {
  info: (...a) => push('info', a),
  warn: (...a) => push('warn', a),
  error: (...a) => push('error', a),
  ffmpeg: (...a) => push('ffmpeg', a),
  debug: (...a) => push('debug', a)
}

export function getLogs(since = 0, limit = 400) {
  const out = buffer.filter(e => e.i > since)
  return { logs: out.slice(-limit), last: seq }
}

export function clearLogs() {
  buffer.length = 0
  try { if (existsSync(LOG_PATH)) unlinkSync(LOG_PATH) } catch {}
  try { appendFileSync(LOG_PATH, '') } catch {}
}

export function initLog() {
  try { if (!existsSync(DATA_DIR)) return; appendFileSync(LOG_PATH, '') } catch {}
}
export { path }
