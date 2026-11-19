// 百度网盘自动上传（基于 bypy）
// 设置里开启即可；首次使用需授权：点"测试连接"会返回授权链接，
// 浏览器打开登录百度后拿到授权码，填入"百度授权码"再点测试即完成绑定。
// 文件上传到网盘的「我的应用数据 / bypy / live-rec」目录
import { spawn } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import path from 'node:path'
import { loadConfig } from '../core/config.js'
import { log } from '../core/log.js'

function bypyBin() {
  const cfg = loadConfig().baidu || {}
  return (cfg.bypypath || 'bypy').trim() || 'bypy'
}

function runBypy(args, stdinData = '', timeoutMs = 600000) {
  return new Promise(resolve => {
    const proc = spawn(bypyBin(), args, { windowsHide: true })
    let out = '', err = ''
    const timer = setTimeout(() => { try { proc.kill('SIGKILL') } catch {} }, timeoutMs)
    proc.stdout.on('data', d => { out += d })
    proc.stderr.on('data', d => { err += d })
    if (stdinData) { try { proc.stdin.write(stdinData) } catch {} }
    proc.stdin.end()
    proc.on('error', e => { clearTimeout(timer); resolve({ code: -1, out, err: e.message }) })
    proc.on('close', code => { clearTimeout(timer); resolve({ code, out, err }) })
  })
}

// 检测授权状态；未授权时返回 authUrl 供用户打开
export async function testBypyConnection() {
  const r = await runBypy(['--processes', '1', 'info'], '', 60000)
  const text = (r.out + '\n' + r.err)
  if (/Open the following .* in a browser|授权|auth/i.test(text) && /openapi|pan\.baidu\.com/.test(text)) {
    const m = text.match(/https:\/\/openapi\.baidu\.com[^\s"']+/)
    return { ok: false, needAuth: true, authUrl: m ? m[0] : null, raw: text.slice(0, 800) }
  }
  if (r.code === 0) {
    const quota = text.match(/Quota[^\n]*|\S+/g)
    return { ok: true, needAuth: false, raw: text.slice(0, 800) }
  }
  return { ok: false, needAuth: false, raw: text.slice(0, 800) }
}

// 用户拿到授权码后提交，完成绑定
export async function submitBypyAuthCode(code) {
  if (!code || !code.trim()) return { ok: false, raw: '授权码为空' }
  const r = await runBypy(['--processes', '1', 'info'], code.trim() + '\n', 90000)
  const text = r.out + '\n' + r.err
  const ok = r.code === 0 && !/auth|授权码/.test(text.slice(-200))
  return { ok, raw: text.slice(0, 800) }
}

// 上传单个文件（阻塞式，供录制完成后调用）
export async function uploadToBaidu(filePath) {
  if (!existsSync(filePath) || statSync(filePath).size <= 0) throw new Error('文件不存在或为空: ' + filePath)
  const remote = 'live-rec/' + path.basename(filePath)  // 网盘「我的应用数据/bypy/live-rec/」
  const size = statSync(filePath).size
  log.info(`[百度网盘] 开始上传: ${path.basename(filePath)} (${(size / 1048576).toFixed(1)}MB)`)
  const r = await runBypy(['--processes', '4', 'upload', filePath, remote], '', 0x7fffffff)
  if (r.code !== 0) throw new Error(`bypy 退出码 ${r.code}: ${(r.err || r.out).slice(-300)}`)
  log.info(`[百度网盘] 上传完成: ${remote}`)
  return true
}

// 录制完成后调用：检查开关，异步上传不阻塞录制
export function maybeUploadToBaidu(filePath) {
  const cfg = loadConfig().baidu || {}
  if (!cfg.enabled) return
  if (!filePath || !existsSync(filePath)) return
  const size = statSync(filePath).size
  if (size <= 0) return
  uploadToBaidu(filePath).catch(err => log.error(`[百度网盘] 上传失败: ${err.message}`))
}
