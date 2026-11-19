/* live-rec-hinas 前端逻辑（无框架） */
(() => {
  'use strict'

  const $ = sel => document.querySelector(sel)
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

  let state = null
  let configCache = null
  let activeTab = 'tasks'
  let logLast = 0
  let logLines = []

  function humanSize(bytes) {
    if (!bytes || bytes < 0) return '0 B'
    const units = ['B', 'KB', 'MB', 'GB', 'TB']
    let i = 0, v = Number(bytes)
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++ }
    return v.toFixed(v >= 100 || i === 0 ? 0 : 1) + ' ' + units[i]
  }
  function humanDur(ms) {
    if (!ms || ms < 0) ms = 0
    const s = Math.floor(ms / 1000)
    const p = n => String(n).padStart(2, '0')
    return `${p(Math.floor(s / 3600))}:${p(Math.floor((s % 3600) / 60))}:${p(s % 60)}`
  }
  function timeStr(ts) {
    if (!ts) return '-'
    return new Date(ts).toLocaleString('sv-SE').replace('T', ' ')
  }
  function durText(ms) {
    if (!ms) return '-'
    if (ms < 60000) return Math.round(ms / 1000) + ' 秒'
    if (ms < 3600000) return Math.round(ms / 60000) + ' 分钟'
    return (ms / 3600000).toFixed(1) + ' 小时'
  }

  function toast(msg, isErr) {
    const t = $('#toast')
    t.textContent = msg
    t.classList.toggle('hidden', false)
    t.style.borderColor = isErr ? 'var(--red)' : 'var(--border)'
    clearTimeout(t._timer)
    t._timer = setTimeout(() => t.classList.add('hidden'), 3000)
  }

  async function api(path, opts = {}) {
    const res = await fetch(path, {
      headers: { 'Content-Type': 'application/json' },
      ...opts,
      body: opts.body ? JSON.stringify(opts.body) : undefined
    })
    if (res.status === 401) {
      $('#login-overlay').classList.remove('hidden')
      throw new Error('需要登录')
    }
    return res.json()
  }

  // ---------- 登录 ----------
  async function doLogin() {
    const password = $('#login-password').value
    try {
      const r = await api('/api/login', { method: 'POST', body: { password } })
      if (r.ok) {
        $('#login-overlay').classList.add('hidden')
        $('#login-error').classList.add('hidden')
        refreshAll()
      } else {
        $('#login-error').classList.remove('hidden')
      }
    } catch { $('#login-error').classList.remove('hidden') }
  }
  $('#login-btn').addEventListener('click', doLogin)
  $('#login-password').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin() })

  // ---------- 状态轮询 ----------
  async function refreshState() {
    let data
    try { data = await api('/api/state') } catch { return }
    state = data
    $('#hd-version').textContent = 'v' + data.version + ' · ' + data.platform
    $('#hd-dot').classList.toggle('off', false)
    $('#hd-stats').innerHTML =
      `<span>录制中 <b>${data.activeCount}</b></span>` +
      `<span>当前总大小 <b>${humanSize(data.totalSize)}</b></span>` +
      `<span>运行 <b>${humanDur(data.uptime)}</b></span>` +
      `<span>任务 <b>${data.tasks.length}</b></span>`
    $('#save-folder').textContent = data.savefolder
    renderTasks()
    if (activeTab === 'files') { renderFiles(); if (Date.now() - filesLoadedAt > 3000) loadFiles() }
  }
  function refreshAll() { refreshState() }

  // ---------- 任务渲染 ----------
  function statusPill(task) {
    const rec = task.recording || {}
    if (rec.recording) return '<span class="pill rec pulse">● 录制中</span>'
    if (rec.paused) return '<span class="pill paused">‖ 已暂停(私播)</span>'
    const s = task.lastStatus
    if (s === 'online') return '<span class="pill online">● 在线</span>'
    if (s === 'private') return '<span class="pill private">私播</span>'
    if (s === 'offline') return '<span class="pill offline">离线</span>'
    if (s === 'not exist') return '<span class="pill error">房间不存在</span>'
    if (s === 'disabled') return '<span class="pill offline">已停用</span>'
    return '<span class="pill offline">待检测</span>'
  }

  function siteColor(name) {
    const site = (state?.sites || []).find(s => s.name === name)
    return site ? site.color : '#64748b'
  }

  function renderTasks() {
    const el = $('#tasks-list')
    const tasks = state?.tasks || []
    if (!tasks.length) return
    el.innerHTML = tasks.map(t => {
      const rec = t.recording || {}
      const site = (state.sites || []).find(s => s.name === t.site)
      const curFile = rec.outputPath ? rec.outputPath.split(/[\\/]/).pop() : ''
      const fileLine = rec.recording && curFile
        ? `<div class="task-file">写入中：<b>${esc(curFile)}</b> · ${humanSize(rec.fileSize)} · ${esc(rec.stats?.resolution || '')} ${esc(rec.stats?.bitrate || '')}</div>`
        : (rec.files && rec.files.length && rec.paused ? `<div class="task-file">已录分段 ${rec.files.length} 个 · ${humanSize(rec.fileSize)}</div>` : '')
      const errLine = t.lastError ? `<div class="task-err">⚠ ${esc(t.lastError)}</div>` : ''
      const retry = rec.retryCount > 0 ? `<span>重试 <b>${rec.retryCount}/6</b></span>` : ''
      return `
      <div class="task-card" data-id="${esc(t.id)}">
        <div class="task-head">
          <span class="site-chip" style="background:${siteColor(t.site)}">${esc(site?.domain || t.site)}</span>
          <span class="room-name"><a href="${esc(t.url)}" target="_blank" rel="noopener">${esc(t.room)}</a></span>
          ${statusPill(t)}
          <label class="switch" style="margin-left:auto" title="启用/停用">
            <input type="checkbox" ${t.enabled ? 'checked' : ''} data-act="toggle" data-id="${esc(t.id)}">
            <span class="slider"></span>
          </label>
        </div>
        <div class="task-meta">
          ${rec.recording || rec.paused ? `<span>已录 <b>${humanDur(rec.timeRec)}</b></span><span>大小 <b>${humanSize(rec.fileSize)}</b></span>` : ''}
          ${retry}
          <span>检测于 <b>${timeStr(t.lastCheck)}</b></span>
        </div>
        ${fileLine}
        ${errLine}
        <div class="task-actions">
          <button class="btn small" data-act="check" data-id="${esc(t.id)}">立即检测</button>
          ${rec.recording ? '<button class="btn small" data-act="stop" data-id="' + esc(t.id) + '">停止录制</button>' : ''}
          <button class="btn small danger" data-act="delete" data-id="${esc(t.id)}">${armedTaskId === t.id ? '确认删除？' : '删除'}</button>
        </div>
      </div>`
    }).join('')
  }

  let armedTaskId = ''
  setInterval(() => { armedTaskId = '' }, 8000)
  $('#tasks-list').addEventListener('click', async e => {
    const btn = e.target.closest('button[data-act]')
    if (!btn) return
    const id = btn.dataset.id
    const act = btn.dataset.act
    if (act === 'delete') {
      // 两步确认（不用原生 confirm，部分环境会禁用），armed 状态跨自动刷新存活
      if (armedTaskId !== id) {
        armedTaskId = id
        renderTasks()
        return
      }
      armedTaskId = ''
    }
    if (act === 'stop') {
      // 停止录制 = 停用（自动模式下防秒重启）
      const r = await api('/api/task/action', { method: 'POST', body: { id, action: 'disable' } })
      if (r.ok) toast('已停止并停用，需重新启用才会再录')
      refreshState()
      return
    }
    const r = await api('/api/task/action', { method: 'POST', body: { id, action: act } })
    if (r.ok) { if (act === 'delete') toast('已删除'); refreshState() }
  })
  $('#tasks-list').addEventListener('change', async e => {
    const input = e.target.closest('input[data-act="toggle"]')
    if (!input) return
    const id = input.dataset.id
    const action = input.checked ? 'enable' : 'disable'
    await api('/api/task/action', { method: 'POST', body: { id, action } })
    refreshState()
  })

  // ---------- 添加 / 测试 ----------
  $('#btn-add').addEventListener('click', async () => {
    const url = $('#add-url').value.trim()
    if (!url) return toast('请输入直播间地址', true)
    const r = await api('/api/task', { method: 'POST', body: { url } })
    if (r.ok) {
      toast(`已添加监控：${r.task.site}/${r.task.room}`)
      $('#add-url').value = ''
      $('#resolve-result').classList.add('hidden')
      refreshState()
    } else {
      toast(r.error || '添加失败', true)
    }
  })
  $('#btn-test').addEventListener('click', async () => {
    const url = $('#add-url').value.trim()
    if (!url) return toast('请输入直播间地址', true)
    const box = $('#resolve-result')
    box.classList.remove('hidden')
    box.innerHTML = '<span class="muted">解析中…</span>'
    const r = await api('/api/resolve', { method: 'POST', body: { url } })
    if (!r.ok) { box.innerHTML = `<span class="error">${esc(r.error)}</span>`; return }
    const x = r.result
    let html = `站点 <b>${esc(x.site)}</b> · 房间 <b>${esc(x.room)}</b> · 状态 <b>${esc(x.status)}</b>`
    if (x.error) html += ` · <span class="error">${esc(x.error)}</span>`
    if (x.url) html += `<br>流地址：<code>${esc(x.url.length > 120 ? x.url.slice(0, 120) + '…' : x.url)}</code>`
    if (x.resolutions && x.resolutions.length) {
      html += '<br>清晰度：' + x.resolutions.map(v => esc(v.resolution + (v.fps ? '@' + v.fps : ''))).join(' / ')
    }
    box.innerHTML = html
  })

  // ---------- 文件 ----------
  // 文件列表实时来自磁盘扫描（/api/files），不是历史记录
  let filesCache = []
  let filesMeta = { totalSize: null, diskFree: null, upload: null }
  let filesLoadedAt = 0
  function renderFiles() {
    const el = $('#files-list')
    // 容量显示数据由 loadFiles 更新
    // 录制中的文件（尚未结束，磁盘上持续增长）
    const active = (state?.tasks || []).filter(t => (t.recording || {}).recording || (t.recording || {}).paused)
    let html = ''
    // 实时容量显示
    if (filesMeta.diskFree !== null) {
      html += `<div class="muted" style="margin:4px 0 8px;font-weight:600">💾 磁盘剩余 <b>${humanSize(filesMeta.diskFree)}</b></div>`
    }
    if (active.length) {
      html += '<div class="muted" style="margin:4px 0 8px;font-weight:600">● 录制中</div>'
      html += active.map(t => {
        const rec = t.recording || {}
        const file = rec.outputPath || ''
        let rel = ''
        if (file) {
          const base = state?.savefolder || ''
          if (base && file.startsWith(base)) rel = file.slice(base.length + 1).split(pathSep).join('/')
          else rel = file.split(/[\\/]/).pop()
        }
        return `<div class="file-row">
        <div class="file-name">
          <span>🔴 ${esc(t.room)} (${esc(t.site)})</span>
          <div class="file-info">已录 ${humanDur(rec.timeRec || 0)} · ${humanSize(rec.fileSize || 0)} · ${esc(file.split(/[\\/]/).pop() || '等待起流')} ${rec.paused ? ' · 已暂停(私播)' : ''}</div>
        </div>
        ${rel ? `<a class="btn small" href="/files/${encodeURI(rel)}" download>下载当前</a>` : ''}
      </div>`
      }).join('')
    }
    // 百度网盘上传进度
    const up = filesMeta.upload
    if (up && (up.active || up.ok === false || (up.ok && up.finishedAt))) {
      const pctRaw = up.total ? Math.min(100, (up.uploaded / up.total * 100)) : 0
      const pct = (up.active && pctRaw >= 99.9) ? '99' : pctRaw.toFixed(1)  // 本地传完待网盘确认显示99%
      if (up.active) {
        const suffix = pctRaw >= 99.9 ? ' · 待网盘确认' : ''
        html += `<div class="file-row" style="background:var(--card)">
        <div class="file-name">
          <span>⬆ 百度网盘上传中：${esc(up.file)}</span>
          <div class="file-info">${pct}%${suffix} · ${humanSize(up.uploaded)} / ${humanSize(up.total)} · ${humanSize(up.speed)}/s</div>
        </div>
        <span style="display:flex;gap:6px"><button class="btn small danger" data-fact="cancelup">取消上传</button></span>
      </div>`
      } else if (up.ok === false && up.error !== '已取消') {
        html += `<div class="file-row"><div class="file-name"><span>⬆ 上传失败：${esc(up.file)}</span><div class="file-info">${esc(up.error || '未知错误')}</div></div></div>`
      } else if (up.ok && up.finishedAt && Date.now() - up.finishedAt < 60000) {
        html += `<div class="file-row"><div class="file-name"><span>⬆ 上传完成：${esc(up.file)}</span><div class="file-info">${humanSize(up.total)} · 已到网盘「我的应用数据/bypy/${esc(up.remote)}」</div></div></div>`
      }
    }
    if (!filesCache.length && !active.length) {
      const cap = filesMeta.diskFree !== null ? `<div class="muted" style="margin:4px 0 8px;font-weight:600">💾 磁盘剩余 <b>${humanSize(filesMeta.diskFree)}</b></div>` : ''
      if (Date.now() - filesLoadedAt > 3000) loadFiles()
      el.innerHTML = cap + '<div class="empty muted">磁盘上没有录像文件。开始录制后文件会出现在这里。</div>'
      return
    }
    html += (filesCache.length ? '<div class="muted" style="margin:12px 0 8px;font-weight:600">📁 磁盘文件</div>' : '')
    html += filesCache.map((f, i) => `
      <div class="file-row">
        <div class="file-name">
          <a href="/files/${encodeURI(f.rel)}" target="_blank" rel="noopener">${esc(f.rel.split('/').pop())}</a>
          <div class="file-info">${esc(f.rel.split('/').slice(0, -1).join('/') || '.')} · ${humanSize(f.size)} · ${timeStr(f.mtime)}</div>
        </div>
        <span style="display:flex;gap:6px">
          <a class="btn small" href="/files/${encodeURI(f.rel)}" download>下载</a>
          <button class="btn small" data-fact="upload" data-idx="${i}">上传</button>
          <button class="btn small danger${armedFile === i ? ' armed' : ''}" data-fact="del" data-idx="${i}">${armedFile === i ? '确认删除文件？' : '删除文件'}</button>
        </span>
      </div>`).join('')
    el.innerHTML = html
  }
  async function loadFiles() {
    filesLoadedAt = Date.now()
    try {
      const r = await api('/api/files')
      if (r.ok) {
        filesCache = r.files || []
        filesMeta = { totalSize: r.totalSize ?? null, diskFree: r.diskFree ?? null, upload: filesMeta.upload }
        renderFiles()
      }
    } catch { /* 下次轮询重试 */ }
    try {
      const p = await api('/api/baidu/progress')
      if (p.ok) { filesMeta.upload = p.upload; renderFiles() }
    } catch { /* ignore */ }
  }
  // 删除确认状态（跨自动刷新存活）
  let armedFile = -1
  function disarmHist() { armedFile = -1 }
  setInterval(disarmHist, 8000)
  // 事件委托：DOM 重建后监听依然有效
  $('#files-list').addEventListener('click', async e => {
    const btn = e.target.closest('button[data-fact]')
    if (!btn) return
    const fact = btn.dataset.fact
    if (fact === 'cancelup') {
      const r = await api('/api/baidu/cancel', { method: 'POST', body: {} })
      toast(r.ok ? (r.cancelled ? '已取消上传' : '当前没有进行中的上传') : '取消失败')
      await loadFiles()
      return
    }
    if (fact === 'upload') {
      const f = filesCache[Number(btn.dataset.idx)]
      if (!f) return
      const r = await api('/api/baidu/upload', { method: 'POST', body: { rel: f.rel, root: f.root } })
      if (r.ok) { toast('已加入上传队列'); filesLoadedAt = 0; await loadFiles() }
      else toast('上传失败: ' + (r.error || '未知错误'))
      return
    }
    const idx = Number(btn.dataset.idx)
    if (armedFile !== idx) { armedFile = idx; renderFiles(); return }
    armedFile = -1
    const f = filesCache[idx]
    if (!f) return
    const r = await api('/api/files/delete', { method: 'POST', body: { rel: f.rel, root: f.root } })
    if (r.ok) { toast('已删除文件'); await loadFiles() }
    else toast('删除失败: ' + (r.error || '未知错误'))
  })
  const pathSep = navigator.platform.startsWith('Win') ? '\\' : '/'
  $('#btn-refresh-files').addEventListener('click', () => { filesLoadedAt = 0; loadFiles() })

  // ---------- 设置 ----------
  const SETTINGS_GROUPS = [
    {
      title: 'Web 界面', fields: [
        { key: 'port', label: '监听端口', type: 'number', hint: '修改后需重启服务生效 (0.0.0.0 监听，局域网可访问)' },
        { key: 'password', label: '访问密码', type: 'password', hint: '留空 = 不设密码；填入新值即启用' }
      ]
    },
    {
      title: '路径与程序', fields: [
        { key: 'savefolder', label: '录像保存目录', type: 'text', hint: '建议指向 USB 硬盘/U盘挂载点，如 /mnt/sda1/rec' },
        { key: 'ffmpegselect', label: 'ffmpeg 路径', type: 'text', hint: '留空 = 使用 PATH 中的 ffmpeg' },
        { key: 'mkvmergepath', label: 'mkvmerge 路径', type: 'text', hint: '可选，合并 mkv 分段更快' }
      ]
    },
    {
      title: '录制', fields: [
        { key: 'recformat', label: '录像格式', type: 'select', options: ['mkv', 'ts', 'mp4', 'flv'], hint: '推荐 mkv（断电不怕文件损坏）或 ts' },
        { key: 'quality', label: '录制清晰度（高度，空=最高）', type: 'number', hint: '如填 720 只录 720p 及匹配清晰度；留空录制最高画质。对 chaturbate/stripchat 无效的清晰度会自动回退到最高。' },
        { key: 'dateformat', label: '文件名格式', type: 'text', hint: 'model=房间名 site=站点名，支持 yyyy MM dd hh mm ss' },
        { key: 'autocreatefolder', label: '按日期/房间建子目录', type: 'checkbox' },
        { key: 'ffmpegparams', label: '附加 ffmpeg 参数', type: 'text', hint: '输出参数，空格分隔，留空即可' },
        { key: 'maxrecfilesize', label: '单文件大小上限 (MB)', type: 'number', hint: '0 = 不限制，超过后自动分段' },
        { key: 'maxrecduration', label: '单文件时长上限 (秒)', type: 'number', hint: '0 = 不限制' },
        { key: 'pauseforprivate', label: '私播时暂停（回来继续录）', type: 'checkbox' },
        { key: 'concatonresume', label: '停止后自动合并分段', type: 'checkbox' },
        { key: 'minfreespacemb', label: '磁盘最低剩余空间 (MB)', type: 'number', hint: '低于该值自动停止全部录制' }
      ]
    },
    {
      title: '轮询与并发', fields: [
        { key: 'pollinterval', label: '在线/录制中检测间隔 (ms)', type: 'number' },
        { key: 'offlinepollinterval', label: '离线检测间隔 (ms)', type: 'number' },
        { key: 'retryinterval', label: '启动重试间隔 (ms)', type: 'number' },
        { key: 'maxconcurrent', label: '同时录制上限', type: 'number', hint: '0 = 不限' }
      ]
    },
    {
      title: '高级', fields: [
        { key: 'useragent', label: 'User-Agent', type: 'text' },
        { key: 'proxylist', label: '代理列表文件路径', type: 'text', hint: '可选，每行一个 http 代理（需 npm 安装 undici 才生效）' },
        { key: 'maxproxytry', label: '代理最大尝试次数', type: 'number' }
      ]
    },
    {
      title: '百度网盘自动上传', fields: [
        { key: 'baidu.enabled', label: '录制完成后自动上传', type: 'checkbox', hint: '基于 bypy，文件上传到网盘「我的应用数据/bypy/live-rec」。首次使用需点下方「测试连接」完成授权。' },
        { key: 'baidu.bypypath', label: 'bypy 路径（可选）', hint: '留空使用 PATH 中的 bypy；自装时填完整路径如 /usr/local/bin/bypy' }
      ]
    }
  ]

  async function loadSettings() {
    const r = await api('/api/config')
    configCache = r.config
    const form = $('#settings-form')
    form.innerHTML = SETTINGS_GROUPS.map(g => `
      <div class="settings-group">
        <h3>${esc(g.title)}</h3>
        <div class="settings-grid">
          ${g.fields.map(f => {
            const val = f.key.includes('.') ? (configCache[f.key.split('.')[0]] || {})[f.key.split('.')[1]] : configCache[f.key]
            let input
            if (f.type === 'select') {
              input = `<select data-key="${f.key}">${f.options.map(o => `<option value="${o}" ${String(val) === o ? 'selected' : ''}>${o}</option>`).join('')}</select>`
            } else if (f.type === 'checkbox') {
              input = `<input type="checkbox" data-key="${f.key}" ${val ? 'checked' : ''}>`
            } else {
              input = `<input type="${f.type === 'password' ? 'text' : f.type}" data-key="${f.key}" value="${esc(val)}">`
            }
            return `<div class="field"><label>${esc(f.label)}</label>${input}${f.hint ? `<div class="hint">${esc(f.hint)}</div>` : ''}</div>`
          }).join('')}
        </div>
      </div>`
    ).join('')
    ensureBaiduTestUI()
  }

    $('#btn-save-config').addEventListener('click', async () => {
    const patch = {}
    $('#settings-form').querySelectorAll('[data-key]').forEach(el => {
      const key = el.dataset.key
      let value
      if (el.type === 'checkbox') value = el.checked
      else if (el.type === 'number') value = Number(el.value) || 0
      else value = el.value
      if (key.includes('.')) {
        const [group, sub] = key.split('.')
        // 同组的多个 dot-key 依次累积，避免后者用旧 configCache 覆盖前者
        patch[group] = { ...(patch[group] ?? configCache[group] ?? {}), [sub]: value }
      } else patch[key] = value
    })
    const r = await api('/api/config', { method: 'POST', body: patch })
    if (r.ok) {
      configCache = r.config
      toast('设置已保存')
      $('#config-note').textContent = r.restartNeeded ? '端口已修改，需重启服务（systemctl restart live-rec 或重新运行 start.sh）' : ''
    } else toast('保存失败', true)
  })

  // 百度网盘授权/测试连接
  $('#settings-form').addEventListener('click', async e => {
    if (!e.target.closest('#btn-baidu-test')) return
    const btn = e.target.closest('#btn-baidu-test')
    const out = $('#baidu-test-result')
    btn.disabled = true; btn.textContent = '检测中...'
    const authCode = ($('#baidu-auth-code') || {}).value || ''
    const r = await api('/api/baidu/test', { method: 'POST', body: { authCode } })
    btn.disabled = false; btn.textContent = '测试连接 / 提交授权码'
    if (r.ok && r.needAuth) {
      out.innerHTML = `未授权。请用浏览器打开下面的链接登录百度网盘并复制授权码，填到上方输入框后再点一次：<br><a href="${esc(r.authUrl || '')}" target="_blank" rel="noopener">${esc(r.authUrl || '见日志')}</a>`
    } else if (r.ok && !r.needAuth) {
      out.innerHTML = `<span style="color:var(--accent)">✅ 百度网盘连接正常</span>`
    } else {
      out.innerHTML = `❌ 连接失败：<br><pre style="white-space:pre-wrap;font-size:11px">${esc(r.raw || '未知错误')}</pre>`
    }
  })
  function ensureBaiduTestUI() {
    if ($('#btn-baidu-test')) return
    const form = $('#settings-form')
    form.insertAdjacentHTML('beforeend', `
      <div class="settings-group">
        <h3>百度网盘授权</h3>
        <div class="field"><label>百度授权码（首次绑定时填写）</label>
          <input type="text" id="baidu-auth-code" placeholder="授权后百度页面显示的授权码">
          <div class="hint">流程：点「测试连接」→ 浏览器打开授权链接登录 → 复制授权码填入此处 → 再点「测试连接」</div>
        </div>
        <div class="field"><button class="btn" id="btn-baidu-test" type="button">测试连接 / 提交授权码</button></div>
        <div id="baidu-test-result" class="hint"></div>
      </div>`)
  }

  // ---------- 日志 ----------
  async function pollLogs() {
    if (activeTab !== 'logs') return
    const r = await api(`/api/logs?since=${logLast}`)
    if (r.ok) {
      for (const e of r.logs) {
        logLines.push(`<span class="muted">[${timeStr(e.t)}]</span> <span class="log-${esc(e.level)}">[${esc(e.level)}]</span> ${esc(e.msg)}`)
      }
      logLast = r.last
      if (logLines.length > 800) logLines = logLines.slice(-800)
      const view = $('#logs-view')
      const stick = $('#logs-autoscroll').checked && (view.scrollTop + view.clientHeight >= view.scrollHeight - 40)
      view.innerHTML = logLines.join('\n')
      if (stick) view.scrollTop = view.scrollHeight
    }
  }
  $('#btn-clear-logs').addEventListener('click', async () => {
    await api('/api/logs/clear', { method: 'POST' })
    logLines = []
    logLast = 0
    $('#logs-view').innerHTML = ''
  })

  // ---------- Tab 切换 ----------
  document.querySelectorAll('nav .tab').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('nav .tab').forEach(b => b.classList.remove('active'))
      btn.classList.add('active')
      activeTab = btn.dataset.tab
      document.querySelectorAll('.tabpage').forEach(p => p.classList.add('hidden'))
      $('#tab-' + activeTab).classList.remove('hidden')
      if (activeTab === 'settings' && !configCache) loadSettings()
      if (activeTab === 'files') { renderFiles(); if (Date.now() - filesLoadedAt > 3000) loadFiles() }
      if (activeTab === 'logs') { logLast = 0; logLines = []; pollLogs() }
    })
  })

  // ---------- 启动 ----------
  refreshState().catch(() => {})
  setInterval(refreshState, 3000)
  setInterval(pollLogs, 2000)

  // 支持 #tasks/#files/#settings/#logs 直达
  const h = location.hash.slice(1)
  if (h) {
    const btn = document.querySelector(`nav .tab[data-tab="${h}"]`)
    if (btn) btn.click()
  }
})()
