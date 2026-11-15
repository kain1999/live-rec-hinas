import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { TASKS_PATH } from './paths.js'
import { loadConfig } from './config.js'

const state = { tasks: [], history: [] }
let loaded = false
let saveTimer = null

export function loadStore() {
  if (loaded) return state
  try {
    if (existsSync(TASKS_PATH)) {
      const raw = JSON.parse(readFileSync(TASKS_PATH, 'utf8'))
      state.tasks = Array.isArray(raw.tasks) ? raw.tasks : []
      state.history = Array.isArray(raw.history) ? raw.history : []
    }
  } catch { /* corrupt file -> start fresh */ }
  loaded = true
  return state
}

export function saveNow() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null }
  try {
    const tmp = TASKS_PATH + '.tmp'
    writeFileSync(tmp, JSON.stringify({ tasks: state.tasks, history: state.history, updatedAt: Date.now() }, null, 2))
    renameSync(tmp, TASKS_PATH)
  } catch { /* ignore */ }
}

export function scheduleSave() {
  if (saveTimer) return
  saveTimer = setTimeout(saveNow, 500)
}

export function getTasks() { loadStore(); return state.tasks }
export function getTask(id) { return getTasks().find(t => t.id === id) || null }
export function addTask(t) { getTasks().push(t); scheduleSave(); return t }
export function updateTask(id, patch) {
  const t = getTask(id)
  if (!t) return null
  Object.assign(t, patch)
  scheduleSave()
  return t
}
export function removeTask(id) {
  const idx = getTasks().findIndex(t => t.id === id)
  if (idx !== -1) state.tasks.splice(idx, 1)
  state.history = state.history.filter(h => h.taskId !== id)
  scheduleSave()
}
export function getHistory() { loadStore(); return state.history }
export function addHistory(entry) {
  loadStore()
  state.history.push(entry)
  const max = Number(loadConfig().historymax) || 500
  if (state.history.length > max) state.history.splice(0, state.history.length - max)
  scheduleSave()
}
