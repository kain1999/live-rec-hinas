const pad2 = n => String(n).padStart(2, '0')

/**
 * date-format 兼容子集：支持 yyyy MM dd hh mm ss
 * 默认格式与原版一致：'model-site-dd-MM-yyyy_hh-mm-ss'
 */
export function dateFormat(fmt = 'yyyy-MM-dd_hh-mm-ss', d = new Date()) {
  return String(fmt)
    .replace(/yyyy/g, String(d.getFullYear()))
    .replace(/MM/g, pad2(d.getMonth() + 1))
    .replace(/dd/g, pad2(d.getDate()))
    .replace(/hh/g, pad2(d.getHours()))
    .replace(/mm/g, pad2(d.getMinutes()))
    .replace(/ss/g, pad2(d.getSeconds()))
}

export function humanSize(bytes) {
  if (!bytes || bytes < 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  let v = Number(bytes)
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++ }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`
}

export function humanDuration(ms) {
  if (!ms || ms < 0) return '00:00:00'
  const s = Math.floor(ms / 1000)
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60
  return `${pad2(h)}:${pad2(m)}:${pad2(sec)}`
}
