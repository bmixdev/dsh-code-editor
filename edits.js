/**
 * Whole-file edit suggestions, the part of Tab that Cursor calls "next edit".
 *
 * A cursor continuation alone only appends text at the caret. When the answer
 * changes the shape of the code — `main(f)` typed below a `def main():` that
 * takes nothing — the consistent follow-up is somewhere else in the file. The
 * model answers both parts in one streamed reply:
 *
 *     INSERT:
 *     <continuation at the cursor, possibly empty>
 *     EDITS:
 *     [{"find": "<exact snippet from the file>", "replace": "<new text>", "why": "<short reason>"}]
 *
 * Locating a snippet instead of trusting byte offsets is deliberate: a model
 * counts lines and characters badly, while an exact `find` either exists in the
 * buffer once or does not exist at all. Everything here is pure and works on the
 * buffer the Host already holds; `index.js` turns the result into a response and
 * the editor draws it.
 */

/** Marker the prompt puts into the file to say where the cursor is. */
export const CURSOR_MARKER = '⟦КУРСОР⟧'

/** Section label separating the cursor answer from the edit list. */
export const EDIT_SECTION = 'EDITS:'

/** Longest `find` snippet accepted; longer ones are usually a paste of the file. */
const MAX_FIND = 400

/** Longest replacement accepted. */
const MAX_REPLACE = 2000

/** Longest reason kept for the output panel. */
const MAX_WHY = 200

/** Number of edits asked for when the setting is missing. */
const DEFAULT_MAX_EDITS = 3

/**
 * The instruction appended to the system prompt when whole-file edits are on.
 *
 * `maxEdits` is interpolated instead of being a placeholder: the settings
 * drawer already owns the prompt text, and a second templating layer would let
 * a user break the count without noticing.
 */
export function editInstructions({ maxEdits = DEFAULT_MAX_EDITS } = {}) {
  const limit = Number.isFinite(Number(maxEdits)) ? Math.max(0, Math.round(Number(maxEdits))) : DEFAULT_MAX_EDITS
  return (
    'Если твоё продолжение у курсора делает код в другом месте несогласованным ' +
    '(например, вызов требует другой сигнатуры, ветки или импорта), предложи правки и там. ' +
    'Ответь строго в таком формате:\n' +
    'INSERT:\n<код для вставки в позицию курсора, может быть пустым>\n' +
    `${EDIT_SECTION}\n` +
    '[{"find":"<дословный фрагмент файла>","replace":"<новый текст>","why":"<короткая причина>"}]\n' +
    'Правила: `find` — точный фрагмент из файла, который встречается ровно один раз и занимает 1–5 строк; ' +
    '`replace` — чем его заменить; правок не больше ' +
    `${limit}; ` +
    `если правок не нужно, ответь \`${EDIT_SECTION} []\`. Не повторяй в правках то, что уже вставлено у курсора.`
  )
}

/**
 * The user message for a whole-file request: the buffer with the cursor marked.
 *
 * The marker is unique and cannot appear in real code, so the model does not
 * have to infer the caret from two truncated windows.
 */
export function buildFileContext({ path = '', language = '', text = '', offset = 0 }) {
  const safeOffset = Math.min(Math.max(0, Math.round(Number(offset) || 0)), text.length)
  return (
    `Файл: ${path}\n` +
    `Язык: ${language}\n\n` +
    `--- файл целиком; курсор отмечен ${CURSOR_MARKER} ---\n` +
    `${text.slice(0, safeOffset)}${CURSOR_MARKER}${text.slice(safeOffset)}`
  )
}

/** Strip a leading `INSERT:` label and one fenced block around the answer. */
function cleanAnswer(part) {
  let answer = String(part ?? '')
  // Only horizontal whitespace after the label: `\s*` would also eat the
  // newline and the indentation of the first code line.
  answer = answer.replace(/^[ \t]*INSERT[ \t]*:[ \t]*\r?\n?/i, '')
  // A fence is a wrapper, not indentation: drop only the fence lines, and keep
  // the body exactly as written so a Python block stays indented.
  answer = answer.replace(/^```[^\n]*\n/, '').replace(/\n```\s*$/, '')
  return answer.replace(/^\s*\n/, '').replace(/\s+$/, '')
}

/** Read the edit array out of the tail of the answer, tolerating chatter around it. */
function readEditArray(tail) {
  const from = tail.indexOf('[')
  const to = tail.lastIndexOf(']')
  if (from === -1 || to <= from) return []
  let parsed
  try {
    parsed = JSON.parse(tail.slice(from, to + 1))
  } catch {
    return []
  }
  if (Array.isArray(parsed)) return parsed
  if (parsed !== null && typeof parsed === 'object' && Array.isArray(parsed.edits)) return parsed.edits
  return []
}

/** Normalize one entry; returns null when it is not a usable edit. */
function readEntry(entry) {
  if (entry === null || typeof entry !== 'object') return null
  const find = typeof entry.find === 'string' ? entry.find : ''
  const replace = typeof entry.replace === 'string' ? entry.replace : ''
  const why = typeof entry.why === 'string' ? entry.why : ''
  if (find === '' || find.length > MAX_FIND) return null
  if (replace === '' || replace === find || replace.length > MAX_REPLACE) return null
  return { find, replace, why: why.slice(0, MAX_WHY) }
}

/**
 * Split a model answer into the cursor continuation and the raw edit list.
 *
 * A model that ignores the format is not an error: everything it wrote becomes
 * the cursor answer and no edits are proposed, which is exactly the behaviour
 * of the previous version.
 */
export function parseEditResponse(raw) {
  const text = String(raw ?? '')
  const match = text.match(/(?:^|\n)[ \t]*EDITS[ \t]*:[ \t]*/i)
  if (match === null || match.index === undefined) {
    const trimmed = text.trim()
    if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
      const entries = readEditArray(trimmed).map(readEntry).filter((entry) => entry !== null)
      if (entries.length > 0) return { answer: '', edits: entries }
    }
    return { answer: text, edits: [] }
  }
  const answer = cleanAnswer(text.slice(0, match.index))
  const tail = text.slice(match.index + match[0].length)
  const edits = readEditArray(tail).map(readEntry).filter((entry) => entry !== null)
  return { answer, edits }
}

/** Convert newlines in a snippet to the buffer's own convention. */
function withEol(value, eol) {
  if (eol !== '\r\n') return value
  return value.replace(/\r?\n/g, '\r\n')
}

/**
 * Find where each proposed edit applies, dropping the ones that do not.
 *
 * `find` must occur exactly once: a snippet that appears twice cannot say which
 * occurrence the model meant, and guessing turns a suggestion into a silent
 * wrong change. Overlapping edits and edits covering the caret are dropped for
 * the same reason — the cursor answer already owns that spot.
 */
export function locateEdits({ text = '', edits = [], maxEdits = DEFAULT_MAX_EDITS, cursor = -1 } = {}) {
  const limit = Number.isFinite(Number(maxEdits)) ? Math.max(0, Math.round(Number(maxEdits))) : DEFAULT_MAX_EDITS
  if (limit === 0) return []
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const located = []
  const used = []
  for (const entry of edits) {
    if (located.length >= limit) break
    if (entry === null || typeof entry !== 'object') continue
    let find = typeof entry.find === 'string' ? withEol(entry.find, eol) : ''
    let replace = typeof entry.replace === 'string' ? withEol(entry.replace, eol) : ''
    if (find === '' || replace === '' || find === replace) continue
    let at = text.indexOf(find)
    if (at === -1 && eol === '\r\n') {
      find = entry.find.replace(/\r?\n/g, '\n')
      replace = entry.replace.replace(/\r?\n/g, '\n')
      at = text.indexOf(find)
    }
    if (at === -1) continue
    if (text.indexOf(find, at + 1) !== -1) continue
    const end = at + find.length
    if (used.some(([start, stop]) => at < stop && start < end)) continue
    if (cursor >= at && cursor <= end) continue
    used.push([at, end])
    located.push({ start: at, end, oldText: find, newText: replace, why: String(entry.why ?? '') })
  }
  located.sort((left, right) => left.start - right.start)
  return located
}

/** Apply located edits to a string; kept for tests and for the preview panel. */
export function applyEdits(text, edits) {
  let result = String(text ?? '')
  const ordered = [...edits].sort((left, right) => right.start - left.start)
  for (const edit of ordered) {
    result = result.slice(0, edit.start) + edit.newText + result.slice(edit.end)
  }
  return result
}
