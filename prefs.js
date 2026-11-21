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
  /** Workspace roots whose owner allowed sending buffer context to the model. */
  completionOptIn: [],

  // Tab mechanics. Every value below is a knob of the suggestion engine ported
  // from the observed behaviour of Cursor's Tab (see tab.js and
  // docs/cursor-tab-mechanics.md); the IDE settings drawer exposes all of them.
  /** Quiet time after the last keystroke before an automatic request. */
  debounceMs: 320,
  /** Lines of the buffer before the cursor kept in the prompt. */
  aboveLines: 60,
  /** Lines of the buffer after the cursor kept in the prompt. */
  belowLines: 20,
  /** Longest answer asked for, in lines. */
  answerLines: 5,
  /** Let an answer rewrite the rest of the cursor line instead of only inserting. */
  rangeReplace: true,
  /** How many lines from the cursor a rewrite may cover. 0 disables rewrites. */
  rangeReplaceLines: 2,
  /** Ctrl+Right inserts the next word of a pending suggestion. */
  partialAccept: true,
  /** Ask again immediately after accepting, like "next suggestion". */
  refetchAfterAccept: true,
  /** Ask for suggestions while the cursor is on a comment line. */
  triggerInComments: true,
  /** How long Esc suppresses automatic requests. */
  snoozeAfterRejectMs: 800,
  /** Show answers that only change whitespace. */
  showWhitespaceOnlyChanges: false,
  /** Mark the text a rewrite deletes. */
  showRemovedDecorations: true,
  /** Buffers above this many characters get no suggestions at all. */
  maxFileChars: 1000000,
  /** Say in the output panel why a suggestion was dropped. */
  explainSuppressed: true,
  /** Drop an answer that duplicates the line below the cursor. */
  heuristicDuplicateLine: true,
  /** Drop an answer that only retells the lines below the cursor. */
  heuristicExtendsRange: true,
  /** Drop an answer longer than the buffered request asked for. */
  maxAddedLines: 20,
  /** Rejections of the same answer before it is suppressed. 0 disables. */
  recentRejectThreshold: 3,
  /** How long a rejection is remembered. */
  recentRejectWindowMs: 300000,
  /** Drop an answer that restores text the user just deleted. */
  heuristicRevertingChange: true,
})

/** Inclusive integer bounds, applied to both the file and the drawer. */
export const PREFERENCE_LIMITS = Object.freeze({
  contextLeft: [200, 20000],
  contextRight: [0, 8000],
  debounceMs: [50, 3000],
  aboveLines: [0, 400],
  belowLines: [0, 200],
  answerLines: [1, 20],
  rangeReplaceLines: [0, 8],
  snoozeAfterRejectMs: [0, 5000],
  maxFileChars: [1000, 5000000],
  maxAddedLines: [1, 200],
  recentRejectThreshold: [0, 10],
  recentRejectWindowMs: [0, 600000],
})

const BOOLEAN_KEYS = [
  'fileTree',
  'hiddenFiles',
  'autoSuggest',
  'rangeReplace',
  'partialAccept',
  'refetchAfterAccept',
  'triggerInComments',
  'showWhitespaceOnlyChanges',
  'showRemovedDecorations',
  'explainSuppressed',
  'heuristicDuplicateLine',
  'heuristicExtendsRange',
  'heuristicRevertingChange',
]

/** How many workspaces may stay opted in at once. */
const MAX_OPT_IN = 20

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
  for (const key of BOOLEAN_KEYS) {
    if (patch[key] !== undefined) result[key] = patch[key] === true
  }
  for (const key of Object.keys(PREFERENCE_LIMITS)) {
    if (patch[key] !== undefined) {
      result[key] = clampInteger(patch[key], PREFERENCE_LIMITS[key], DEFAULT_PREFERENCES[key])
    }
  }
  if (patch.completionOptIn !== undefined) {
    if (!Array.isArray(patch.completionOptIn)) {
      throw Object.assign(new Error('Список разрешений должен быть массивом.'), { code: 'bad-request' })
    }
    const roots = []
    for (const candidate of patch.completionOptIn) {
      const value = String(candidate ?? '').trim()
      if (value === '' || value.length > 400) continue
      if (!roots.includes(value)) roots.push(value)
      if (roots.length >= MAX_OPT_IN) break
    }
    result.completionOptIn = roots
  }
  return result
}

/**
 * The workspace roots the user allowed sending buffer context from.
 * Kept in one place so the editor and the IDE agree on the permission.
 */
export function optedInRoots(preferences) {
  const roots = preferences !== undefined && preferences !== null ? preferences.completionOptIn : undefined
  return Array.isArray(roots) ? roots.filter((entry) => typeof entry === 'string' && entry !== '') : []
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
