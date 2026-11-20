/**
 * Editor preferences: the small, machine-local JSON file that backs the
 * "Settings" drawer of the code editor.
 *
 * The plugin deliberately does not rewrite the DSH configuration: everything
 * here is a display or completion preference of the editor itself, so it lives
 * next to the other DSH state in `~/.dsh/code-editor.json`. API keys never land
 * in this file — they go through the credential store (see `catalog.js`).
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

/** Everything the drawer can change, with the value used before the first save. */
export const DEFAULT_PREFERENCES = Object.freeze({
  /** Provider id for inline completions; empty means "the session default". */
  completionProvider: '',
  /** Model id for inline completions; empty means "the session default". */
  completionModel: '',
  /** Show the file tree beside the editor on open. */
  fileTree: true,
  /** Show dotfiles and dot-folders in the tree. */
  hiddenFiles: false,
  /** Offer inline suggestions without pressing Ctrl+Space. */
  autoSuggest: true,
  /** Characters of the buffer sent before the cursor. */
  contextLeft: 4000,
  /** Characters of the buffer sent after the cursor. */
  contextRight: 1000,
  /** Last credential name shown in the API key field. */
  apiKeyRef: '',
})

const LIMITS = {
  contextLeft: [200, 20000],
  contextRight: [0, 8000],
}

/** Absolute path of the preferences file, overridable for tests and portable profiles. */
export function preferencesPath() {
  const override = process.env.DSH_CODE_EDITOR_PREFS
  if (typeof override === 'string' && override.trim() !== '') return path.resolve(override)
  return path.join(os.homedir(), '.dsh', 'code-editor.json')
}

function clampInteger(value, [min, max], fallback) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, Math.round(number)))
}

/** Coerce one caller-supplied patch into the shapes the file accepts. */
function sanitize(patch) {
  const result = {}
  if (typeof patch !== 'object' || patch === null) return result
  for (const key of ['completionProvider', 'completionModel', 'apiKeyRef']) {
    if (patch[key] === undefined) continue
    const value = String(patch[key] ?? '').trim()
    if (value.length > 200) throw Object.assign(new Error('Слишком длинное значение настройки.'), { code: 'bad-request' })
    result[key] = value
  }
  for (const key of ['fileTree', 'hiddenFiles', 'autoSuggest']) {
    if (patch[key] !== undefined) result[key] = patch[key] === true
  }
  for (const key of ['contextLeft', 'contextRight']) {
    if (patch[key] !== undefined) {
      result[key] = clampInteger(patch[key], LIMITS[key], DEFAULT_PREFERENCES[key])
    }
  }
  return result
}

/** Read the preferences, falling back to defaults for anything unreadable. */
export async function readPreferences() {
  try {
    const raw = await readFile(preferencesPath(), 'utf8')
    const parsed = JSON.parse(raw)
    return { ...DEFAULT_PREFERENCES, ...sanitize(parsed) }
  } catch {
    return { ...DEFAULT_PREFERENCES }
  }
}

/** Merge a patch into the file and return the full resulting preferences. */
export async function writePreferences(patch) {
  const current = await readPreferences()
  const next = { ...current, ...sanitize(patch) }
  const file = preferencesPath()
  await mkdir(path.dirname(file), { recursive: true })
  const temporary = `${file}.${process.pid}.tmp`
  await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
  await rename(temporary, file)
  return next
}
