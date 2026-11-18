import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { CONFIG_PATH, DATA_DIR, DEFAULT_SAVEFOLDER, ROOT } from './paths.js'

export const DEFAULT_CONFIG = {
  // Web
  port: 7788,
  password: '',
  // 路径
  savefolder: '',                    // 空 = <安装目录>/recordings
  ffmpegselect: '',                  // 空 = 使用 PATH 中的 ffmpeg
  mkvmergepath: 'mkvmerge',
  mkvmergenable: false,
  // 录制
  recformat: 'mkv',                  // mkv | ts | mp4 | flv
  quality: '',                       // 录制清晰度：空=最高画质，或高度数字如 1080 / 720
  dateformat: 'model-site-dd-MM-yyyy_hh-mm-ss',
  autocreatefolder: true,            // savefolder/yyyy-MM-dd/{site} - {room}/
  ffmpegparams: '',                  // 附加 ffmpeg 输出参数（空格分隔）
  maxrecfilesize: 0,                 // MB，0 = 不切分
  maxrecduration: 0,                 // 秒，0 = 不切分
  pauseforprivate: true,             // 主播进入私播时暂停录制
  concatonresume: true,              // 停止/下播后把分段合并成单文件
  minfreespacemb: 1024,              // 磁盘剩余低于此值(MB)自动停止全部录制
  maxconcurrent: 0,                  // 同时录制上限，0 = 不限
  // 轮询
  pollinterval: 50000,               // 直播中/录制中的检查间隔 ms
  offlinepollinterval: 120000,       // 离线时的检查间隔 ms
  retryinterval: 15000,              // 启动失败/待重试间隔 ms
  // 网络
  useragent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:147.0) Gecko/20100101 Firefox/147.0',
  proxylist: '',                     // 文本文件路径，每行一个 http 代理（可选）
  maxproxytry: 3,
  // 其它
  loglevel: 'info',
  historymax: 500
}

let cached = null

function mergeConfig(raw) {
  const cfg = { ...DEFAULT_CONFIG }
  if (raw && typeof raw === 'object') {
    for (const k of Object.keys(DEFAULT_CONFIG)) {
      if (raw[k] !== undefined && raw[k] !== null) cfg[k] = raw[k]
    }
  }
  return cfg
}

export function loadConfig() {
  if (cached) return cached
  let raw = null
  try {
    if (existsSync(CONFIG_PATH)) raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'))
  } catch (err) {
    raw = null
  }
  cached = mergeConfig(raw)
  return cached
}

function atomicWrite(file, data) {
  const tmp = file + '.tmp'
  writeFileSync(tmp, data)
  renameSync(tmp, file)
}

export function updateConfig(partial) {
  const clean = {}
  for (const k of Object.keys(DEFAULT_CONFIG)) {
    if (partial[k] !== undefined) clean[k] = partial[k]
  }
  const merged = { ...loadConfig(), ...clean }
  // 类型纠正
  for (const numKey of ['port', 'pollinterval', 'offlinepollinterval', 'retryinterval',
    'maxrecfilesize', 'maxrecduration', 'minfreespacemb', 'maxconcurrent', 'historymax']) {
    merged[numKey] = Number(merged[numKey]) || 0
  }
  for (const boolKey of ['autocreatefolder', 'pauseforprivate', 'concatonresume', 'mkvmergenable']) {
    merged[boolKey] = merged[boolKey] === true || merged[boolKey] === 'true'
  }
  merged.port = Math.min(Math.max(Math.round(merged.port) || 7788, 1), 65535)
  cached = merged
  try { atomicWrite(CONFIG_PATH, JSON.stringify(merged, null, 2)) } catch (err) { /* ignore */ }
  return merged
}

export function saveFolderPath() {
  const cfg = loadConfig()
  return cfg.savefolder && String(cfg.savefolder).trim() ? String(cfg.savefolder).trim() : DEFAULT_SAVEFOLDER
}

export function ffmpegPath() {
  const cfg = loadConfig()
  let p = cfg.ffmpegselect && String(cfg.ffmpegselect).trim()
  // 防呆：Windows 的 .exe 路径在 Linux 上无效，忽略并回退 PATH 中的 ffmpeg
  if (p && p.toLowerCase().endsWith('.exe') && process.platform !== 'win32') {
    p = ''
  }
  return p || 'ffmpeg'
}

export function ensureDirs() {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true })
  const sf = saveFolderPath()
  if (!existsSync(sf)) mkdirSync(sf, { recursive: true })
  if (!existsSync(ROOT)) mkdirSync(ROOT, { recursive: true })
}
