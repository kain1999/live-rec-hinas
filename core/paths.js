import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const DATA_DIR = path.join(ROOT, 'data')
export const CONFIG_PATH = path.join(ROOT, 'config.json')
export const TASKS_PATH = path.join(DATA_DIR, 'tasks.json')
export const LOG_PATH = path.join(DATA_DIR, 'log.txt')
export const DEFAULT_SAVEFOLDER = path.join(ROOT, 'recordings')
export const VERSION = '1.0.0-hinas'
export { path }
