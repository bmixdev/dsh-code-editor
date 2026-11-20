/**
 * Per-session IDE state: which files are open, which one is active, how wide
 * the explorer is.
 *
 * The state lives outside the profile (`~/.dsh/ide-state.json`) so restarting
 * the desktop shell keeps the workspace layout, and it never mixes with the
 * editor's own preferences — those belong to the code-editor plugin.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const MAX_SESSIONS = 30
const MAX_TABS = 40
const MAX_PATH_CHARS = 400
const MIN_TREE_WIDTH = 150
const MAX_TREE_WIDTH = 640

const DEFAULTS = Object.freeze({
  tabs: [],
  active: '',
  treeWidth: 220,
  showTree: true,
  hidden: false,
})

export function statePath() {
  const override = process.env.DSH_IDE_STATE
  if (typeof override === 'string' && override.trim() !== '') return path.resolve(override)
  return path.join(os.homedir(), '.dsh', 'ide-state.json')
}

const clampWidth = (value) => {
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(number)) return DEFAULTS.treeWidth
  return Math.min(MAX_TREE_WIDTH, Math.max(MIN_TREE_WIDTH, Math.round(number)))
}

const cleanTab = (value) => {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim().replace(/\\/g, '/').replace(/^\/+/, '')
  if (trimmed === '' || trimmed.length > MAX_PATH_CHARS || trimmed.includes('\0')) return undefined
  if (trimmed.split('/').some((segment) => segment === '..')) return undefined
  return trimmed
}

/** Coerce one session record, dropping anything the client could not use. */
export function sanitizeSessionState(raw) {
  const source = raw && typeof raw === 'object' ? raw : {}
  const tabs = []
  const seen = new Set()
  if (Array.isArray(source.tabs)) {
    for (const candidate of source.tabs) {
      const tab = cleanTab(candidate)
      if (tab === undefined || seen.has(tab)) continue
      seen.add(tab)
      tabs.push(tab)
      if (tabs.length >= MAX_TABS) break
    }
  }
  const active = cleanTab(source.active)
  return {
    tabs,
    active: active !== undefined && seen.has(active) ? active : tabs[0] ?? '',
    treeWidth: clampWidth(source.treeWidth),
    showTree: typeof source.showTree === 'boolean' ? source.showTree : DEFAULTS.showTree,
    hidden: typeof source.hidden === 'boolean' ? source.hidden : DEFAULTS.hidden,
  }
}

async function readAll() {
  let parsed
  try {
    const text = await readFile(statePath(), 'utf8')
    parsed = JSON.parse(text)
  } catch {
    return { version: 1, sessions: {} }
  }
  const sessions = {}
  const source = parsed && typeof parsed === 'object' && parsed.sessions && typeof parsed.sessions === 'object'
    ? parsed.sessions
    : {}
  for (const [key, value] of Object.entries(source)) {
    if (typeof key !== 'string' || key === '') continue
    sessions[key] = sanitizeSessionState(value)
  }
  return { version: 1, sessions }
}

async function writeAll(state) {
  const entries = Object.entries(state.sessions).slice(0, MAX_SESSIONS)
  const payload = JSON.stringify({ version: 1, sessions: Object.fromEntries(entries) }, null, 2)
  const file = statePath()
  await mkdir(path.dirname(file), { recursive: true })
  const temporary = `${file}.${process.pid}.tmp`
  await writeFile(temporary, payload, 'utf8')
  await rename(temporary, file)
}

export async function readSessionState(sessionId) {
  const state = await readAll()
  return sanitizeSessionState(state.sessions[sessionId])
}

export async function writeSessionState(sessionId, patch) {
  const state = await readAll()
  const current = sanitizeSessionState(state.sessions[sessionId])
  const next = sanitizeSessionState({ ...current, ...(patch && typeof patch === 'object' ? patch : {}) })
  state.sessions[sessionId] = next
  await writeAll(state)
  return next
}
