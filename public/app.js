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
    if (activeTab === 'files') renderFiles()
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
          <button class="btn small danger" data-act="delete" data-id="${esc(t.id)}">删除</button>
        </div>
      </div>`
    }).join('')
  }

  $('#tasks-list').addEventListener('click', async e => {
    const btn = e.target.closest('button[data-act]')
    if (!btn) return
    const id = btn.dataset.id
    const act = btn.dataset.act
    if (act === 'delete' && !confirm('删除该任务？录像文件会保留在磁盘上。')) return
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
  function renderFiles() {
    const el = $('#files-list')
    const history = state?.history || []
    const base = state?.savefolder || ''
    if (!history.length) { el.innerHTML = '<div class="empty muted">还没有已完成的录像。开始录制后这里会列出文件（点击文件名可直接在浏览器播放/下载）。</div>'; return }
    el.innerHTML = history.map(h => {
      let rel = ''
      if (base && h.file.startsWith(base)) rel = h.file.slice(base.length + 1).split(pathSep).join('/')
      else rel = h.file.split(/[\\/]/).pop()
      const name = h.file.split(/[\\/]/).pop()
      const dur = h.startedAt && h.endedAt ? humanDur(h.endedAt - h.startedAt) : '-'
      const reasonText = { ended: '正常结束', stopped: '手动停止', error: '异常终止', offline: '主播下播', private: '私播结束', disk: '磁盘空间不足', 'disk-full': '磁盘空间不足', removed: '任务删除', manual: '手动停止', shutdown: '程序退出' }[h.reason] || h.reason || ''
      return `
      <div class="file-row">
        <div class="file-name">
          <a href="/files/${encodeURI(rel)}" target="_blank" rel="noopener">${esc(name)}</a>
          <div class="file-info">${esc(h.site)}/${esc(h.room)} · ${humanSize(h.size)} · ${dur} · ${timeStr(h.endedAt)}${reasonText ? ' · ' + esc(reasonText) : ''}${h.parts ? ' · ' + h.parts.length + ' 分段已合并' : ''}</div>
        </div>
        <a class="btn small" href="/files/${encodeURI(rel)}" download>下载</a>
      </div>`
    }).join('')
  }
  const pathSep = navigator.platform.startsWith('Win') ? '\\' : '/'
  $('#btn-refresh-files').addEventListener('click', refreshState)

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
            const val = configCache[f.key]
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
  }

  $('#btn-save-config').addEventListener('click', async () => {
    const patch = {}
    $('#settings-form').querySelectorAll('[data-key]').forEach(el => {
      const key = el.dataset.key
      if (el.type === 'checkbox') patch[key] = el.checked
      else if (el.type === 'number') patch[key] = Number(el.value) || 0
      else patch[key] = el.value
    })
    const r = await api('/api/config', { method: 'POST', body: patch })
    if (r.ok) {
      configCache = r.config
      toast('设置已保存')
      $('#config-note').textContent = r.restartNeeded ? '端口已修改，需重启服务（systemctl restart live-rec 或重新运行 start.sh）' : ''
    } else toast('保存失败', true)
  })

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
      if (activeTab === 'files') renderFiles()
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
