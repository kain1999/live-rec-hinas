// 一次性录制 CLI：解析 -> 起录 N 秒 -> 停止合并 -> 验证产物
// 用法: node test/record-cli.mjs --site chaturbate --room oke_doke --seconds 60 [--outdir recordings]
import { setTimeout as sleep } from 'node:timers/promises'
import { mkdirSync, existsSync, statSync } from 'node:fs'
import { updateConfig } from '../core/config.js'
import { getSite } from '../core/sites.js'
import { getOrCreateRecording } from '../core/recorder.js'
import { getHistory } from '../core/store.js'
import CamsodaProxy from '../lib/camsoda-proxy.js'

const args = process.argv.slice(2)
function arg(name, dflt) {
  const i = args.indexOf('--' + name)
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : dflt
}

const site = arg('site', 'chaturbate')
const room = arg('room', '')
const seconds = Number(arg('seconds', '60'))
const outdir = arg('outdir', 'recordings')
if (!room) { console.error('[cli] missing --room'); process.exit(1) }

updateConfig({
  savefolder: process.cwd() + '/' + outdir,
  recformat: 'mkv',
  maxrecduration: 0,
  maxrecfilesize: 0,
  minfreespacemb: 0,
  pollinterval: 50000,
  offlinepollinterval: 120000,
  retryinterval: 15000
})
mkdirSync(outdir, { recursive: true })

const inst = getSite(site)
if (!inst) { console.error('[cli] unknown site:', site); process.exit(1) }

console.log('[cli] checking room status ...')
const st = await inst.update(room)
console.log('[cli] status:', st.status, '| thumb:', st.thumb || '-')

async function resolveUrl() {
  if (site === 'chaturbate' && inst.getStreamUrlForRec) {
    const r = await inst.getStreamUrlForRec(room, '', null)
    return r?.url || null
  }
  if (site === 'stripchat' && inst.getStreamUrlForRec) {
    const r = await inst.getStreamUrlForRec(room, null)
    return r?.url || null
  }
  if (site === 'camsoda') {
    const info = await inst.getInfo(room)
    if (info.status !== inst.status_types.ONLINE) return null
    const res = await inst.extract(room, info)
    if (!res.url) return null
    const p = new CamsodaProxy()
    await p.start()
    return p.proxyUrl(res.url)
  }
  const res = await inst.extract(room)
  return res.url || res.resolutions?.[0]?.url || null
}

if (st.status !== 'online') {
  console.log('[cli] SKIP: room is not online (status = ' + st.status + ')')
  process.exit(2)
}

const url = await resolveUrl()
if (!url) {
  console.log('[cli] FAIL: cannot resolve stream url (status was online)')
  process.exit(3)
}
console.log('[cli] stream url:', url)

const task = { id: 'cli', site, room, enabled: true }
const rec = getOrCreateRecording(task)
await rec.start(url, { referer: `https://${inst.config.domain}/`, fresh: true })
console.log('[cli] recording for', seconds, 's ...')
await sleep(seconds * 1000)

console.log('[cli] mid-state:', JSON.stringify({
  files: rec.files.length,
  size: rec.currentSize(),
  time: rec.stats.timeText,
  res: rec.stats.resolution
}))
rec.stop('manual')

let hist = null
for (let i = 0; i < 90; i++) {
  await sleep(1000)
  hist = getHistory().find(h => h.taskId === 'cli')
  if (hist && !rec.recording && !rec.paused) break
}
if (!hist) {
  console.log('[cli] FAIL: no history entry after stop')
  process.exit(4)
}
const ok = existsSync(hist.file)
const size = ok ? statSync(hist.file).size : 0
console.log('[cli] RESULT file :', hist.file)
console.log('[cli] RESULT size :', size, 'bytes | exists:', ok, '| reason:', hist.reason)
if (!ok || size < 100000) {
  console.log('[cli] FAIL: output missing or suspiciously small')
  process.exit(5)
}
console.log('[cli] PASS')
process.exit(0)
