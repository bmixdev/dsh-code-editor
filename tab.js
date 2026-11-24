/**
 * Tab mechanics: the parts of an inline-suggestion engine that decide *where*
 * the answer lands in the buffer and whether it is worth showing at all.
 *
 * The behaviour of Cursor 3.23.23's Tab was measured statically (see
 * `docs/cursor-tab-mechanics.md`); this module is an independent
 * implementation of that behaviour, not a copy of its code. It lives on the
 * host because the host already receives the whole buffer, which is what an
 * edit plan needs: Cursor derives the same range from its server response
 * (`range_to_replace`) and from the model's own body text.
 *
 * Everything here is pure: no model calls, no file system, no editor.
 */

/** Split on the buffer's own line ending, keeping empty trailing lines. */
export function splitLines(text) {
  return normalizeEol(String(text ?? ''), '\n').split('\n')
}

/** The line ending the buffer already uses; mixed buffers count as CRLF. */
export function detectEol(text) {
  return String(text ?? '').includes('\r\n') ? '\r\n' : '\n'
}

/** Rewrite every line ending to one choice. */
export function normalizeEol(text, eol = '\n') {
  const unified = String(text ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  return eol === '\n' ? unified : unified.replace(/\n/g, eol)
}

/** Number of lines a string occupies; the empty string is one empty line. */
export function countLines(text) {
  const unified = normalizeEol(text, '\n')
  return unified === '' ? 1 : unified.split('\n').length
}

/** How many empty-or-blank lines the array ends with. */
export function trailingBlankLines(lines) {
  let count = 0
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (lines[index].trim() !== '') break
    count += 1
  }
  return count
}

/**
 * Whether a suggestion only restates text that is already at the cursor.
 *
 * Cursor normalises the answer's trailing line endings so they match the source
 * plus at most one blank line, then compares the two line lists from the end.
 * Trimming both lists first reaches the same verdict without mutating either.
 */
export function isNoOp({ originalText, suggestion }) {
  const answer = String(suggestion ?? '')
  if (answer === '') return true
  const sourceLines = trimTrailingBlanks(splitLines(originalText))
  const answerLines = trimTrailingBlanks(splitLines(answer))
  if (sourceLines.length !== answerLines.length) return false
  for (let index = sourceLines.length - 1; index >= 0; index -= 1) {
    if (sourceLines[index] !== answerLines[index]) return false
  }
  return true
}

function trimTrailingBlanks(lines) {
  const copy = lines.slice()
  while (copy.length > 1 && copy[copy.length - 1].trim() === '') copy.pop()
  return copy
}

/** Length of the shared leading run of two strings. */
export function commonPrefixLength(left, right) {
  const limit = Math.min(left.length, right.length)
  let index = 0
  while (index < limit && left[index] === right[index]) index += 1
  return index
}

/** Length of the shared trailing run of two strings. */
export function commonSuffixLength(left, right) {
  const limit = Math.min(left.length, right.length)
  let index = 0
  while (index < limit && left[left.length - 1 - index] === right[right.length - 1 - index]) index += 1
  return index
}

/** Strip a repeat of the text that already stands before the cursor. */
export function stripLeadingEcho(suggestion, before) {
  if (before === '') return suggestion
  if (suggestion.startsWith(before)) return suggestion.slice(before.length)
  // The model often returns the whole word the user is still typing. Drop the
  // already typed part of that word, but never a bare space: one shared space is
  // not evidence of a repeated word.
  let shared = 0
  const limit = Math.min(before.length, suggestion.length)
  for (let size = limit; size >= 1; size -= 1) {
    const tail = before.slice(before.length - size)
    if (tail !== suggestion.slice(0, size)) continue
    if (tail.trim() === '' && size < 2) continue
    shared = size
    break
  }
  return shared === 0 ? suggestion : suggestion.slice(shared)
}

/** Offset just past `lines` newlines from `start`; the buffer end when short. */
function lineWindowEnd(text, start, lines) {
  let end = start
  let remaining = lines
  while (remaining > 0) {
    const next = text.indexOf('\n', end)
    if (next === -1) return text.length
    end = next + 1
    remaining -= 1
  }
  return end
}

export const PLAN_REASONS = Object.freeze({
  empty: 'Модель не вернула продолжение.',
  'no-op': 'Ответ повторяет текст под курсором.',
  'whitespace-only': 'Ответ меняет только пробелы.',
  'duplicate-line': 'Ответ дублирует следующую строку.',
  'extends-range': 'Ответ пересказывает текст, который уже есть ниже.',
  'too-many-lines': 'Ответ слишком длинный для одного шага.',
  'recently-rejected': 'Этот вариант вы уже отклоняли.',
  'reverting-change': 'Ответ возвращает текст, который вы только что удалили.',
  'file-too-large': 'Файл слишком велик для подсказок.',
  'comment-line': 'Строка под курсором — комментарий, подсказки в комментариях выключены.',
})

/** Human label for a suppression reason (Russian, shown in the IDE). */
export function reasonLabel(reason) {
  return PLAN_REASONS[reason] ?? 'Подсказка отклонена проверкой.'
}

/** Leading whitespace shared by every non-blank line. */
function commonIndent(text) {
  const lines = text.split('\n')
  let indent
  for (const line of lines) {
    if (line.trim() === '') continue
    const match = /^[ \t]*/.exec(line)?.[0] ?? ''
    if (indent === undefined) {
      indent = match
      continue
    }
    let shared = 0
    while (shared < indent.length && shared < match.length && indent[shared] === match[shared]) shared += 1
    indent = indent.slice(0, shared)
    if (indent === '') return ''
  }
  return indent ?? ''
}

/** Removes one exact indentation prefix from every line that carries it. */
function dedent(text, indent) {
  if (indent === '') return text
  return text
    .split('\n')
    .map((line) => (line.startsWith(indent) ? line.slice(indent.length) : line.trim() === '' ? '' : line))
    .join('\n')
}

/**
 * Decide what the suggestion would change and where.
 *
 * Order of operations mirrors the observed engine: normalise line endings,
 * drop the echo of what is already at the cursor, and only then consider
 * replacing the cursor's line instead of inserting in front of it.
 *
 * `kind: 'replace'` means the answer rewrites part of the buffer between
 * `startOffset` and `endOffset`; `kind: 'insert'` is a pure insertion at the
 * cursor. `removedText` is the buffer slice that a replacement deletes, which
 * the caller uses both for staleness checks and for heuristics.
 */
export function planEdit({ text, offset, suggestion, options = {} }) {
  const buffer = String(text ?? '')
  const at = Math.min(Math.max(0, Math.round(Number(offset) || 0)), buffer.length)
  const eol = detectEol(buffer)
  const rangeReplace = options.rangeReplace !== false
  const requestedLines = Number(options.rangeReplaceLines)
  const rangeReplaceLines = Number.isFinite(requestedLines) ? Math.min(8, Math.max(0, Math.round(requestedLines))) : 2

  let insert = normalizeEol(String(suggestion ?? ''), eol)
  const lineStart = buffer.lastIndexOf('\n', at - 1) + 1
  insert = stripLeadingEcho(insert, buffer.slice(lineStart, at))
  // The engine drops one leading line break when the range starts at the very
  // first character of the buffer: there is no line to continue there.
  if (at === 0 && insert.startsWith(eol)) insert = insert.slice(eol.length)

  const lineEnd = buffer.indexOf('\n', at)
  const restOfLine = lineEnd === -1 ? buffer.slice(at) : buffer.slice(at, lineEnd)

  const empty = { kind: 'insert', startOffset: at, endOffset: at, insertText: '', removedText: '', eol }
  if (insert === '') return empty

  // `f = ` is an empty right-hand side, and a model asked to continue it often
  // answers with the whole statement and its body. Inserting that after the `=`
  // would leave a double statement; the line itself is the right-hand side, so
  // the line is rewritten and re-indented to the buffer's own indentation.
  const lineText = buffer.slice(lineStart, lineEnd === -1 ? buffer.length : lineEnd)
  const lineIndent = /^[ \t]*/.exec(lineText)?.[0] ?? ''
  const beforeInLine = buffer.slice(lineStart, at)
  const assignmentLine = /^[ \t]*[A-Za-z_$][\w$.[\]'"]*[ \t]*=[ \t]*$/.test(beforeInLine) && restOfLine.trim() === ''
  const blockLines = insert.split('\n')
  if (assignmentLine && blockLines.length > 1 && /:$/.test(blockLines[0].trim())) {
    const body = dedent(insert, commonIndent(insert))
    // Re-indent every line: the answer was written relative to the line it
    // replaces, so the buffer's own indentation goes in front of each of them.
    const text = body
      .split('\n')
      .map((line) => (line === '' ? line : `${lineIndent}${line}`))
      .join('\n')
    return {
      kind: 'replace',
      startOffset: lineStart,
      endOffset: lineEnd === -1 ? buffer.length : lineEnd,
      insertText: text,
      removedText: lineText,
      eol,
    }
  }

  // At the start of an indent-only line the cursor already sits after the
  // indentation, so an answer that repeats it would be indented twice.
  if (beforeInLine.trim() === '' && lineIndent !== '') {
    const answerIndent = commonIndent(insert)
    if (answerIndent === lineIndent) insert = dedent(insert, answerIndent)
  }

  // A model that re-emits the tail of the line it was asked to continue is
  // answering with the whole line, not with an addition to it: rewrite the tail
  // in place instead of inserting a second copy before it.
  const lines = insert.split('\n')
  const lastLine = lines[lines.length - 1].replace(/\s+$/, '')
  if (rangeReplace && rangeReplaceLines > 0 && restOfLine.trim() !== '' && lastLine === restOfLine.replace(/\s+$/, '')) {
    return { kind: 'replace', startOffset: at, endOffset: lineEnd === -1 ? buffer.length : lineEnd, insertText: insert, removedText: restOfLine, eol }
  }

  if (rangeReplace && rangeReplaceLines > 0 && restOfLine !== '' && !insert.startsWith('\n') && !insert.startsWith('\r')) {
    const windowEnd = lineWindowEnd(buffer, at, rangeReplaceLines)
    const windowText = buffer.slice(at, windowEnd)
    const shared = commonPrefixLength(insert, windowText)
    if (shared >= 1) {
      const tail = Math.min(commonSuffixLength(insert.slice(shared), windowText.slice(shared)), insert.length - shared - 1)
      const removedText = windowText.slice(shared, Math.max(shared, windowText.length - tail))
      const insertText = insert.slice(shared, Math.max(shared, insert.length - tail))
      const removedLines = normalizeEol(removedText, '\n').split('\n').length - 1
      if (insertText !== '' && removedText === '') {
        // The answer agrees with the whole remaining line: the edit is an
        // insertion right after the shared text, not a rewrite of it.
        return { kind: 'insert', startOffset: at + shared, endOffset: at + shared, insertText, removedText: '', eol }
      }
      if (insertText !== '' && removedText !== '' && /\S/.test(removedText) && removedLines <= rangeReplaceLines) {
        return { kind: 'replace', startOffset: at + shared, endOffset: at + shared + removedText.length, insertText, removedText, eol }
      }
    }
  }

  return { kind: 'insert', startOffset: at, endOffset: at, insertText: insert, removedText: '', eol }
}

function stripSpaces(text) {
  return text.replace(/\s+/g, '')
}

function recentMatch(candidate, records, windowMs, threshold) {
  if (!Array.isArray(records) || records.length === 0) return false
  if (threshold <= 0) return false
  const normalized = String(candidate ?? '').trim()
  if (normalized === '') return false
  const now = Date.now()
  let matches = 0
  for (const record of records) {
    if (record === null || typeof record !== 'object') continue
    const text = typeof record.text === 'string' ? record.text.trim() : ''
    if (text !== normalized) continue
    const at = Number(record.at)
    if (Number.isFinite(at) && now - at > windowMs) continue
    matches += 1
  }
  return matches >= threshold
}

/**
 * Run the engine's pre-display checks over a plan.
 *
 * Every check can be switched off from the IDE's settings: the numbers and
 * booleans arrive in `options`, which is the sanitized preference object.
 */
export function evaluateSuggestion({ text, plan, options = {}, rejections = [], revertions = [] }) {
  const buffer = String(text ?? '')
  const insertText = plan.insertText
  const removedText = plan.removedText
  if (insertText === '') return { accepted: false, reason: 'empty' }
  if (isNoOp({ originalText: removedText, suggestion: insertText })) return { accepted: false, reason: 'no-op' }

  // Whitespace-only rewrites are noise unless the user asked to see them. A
  // pure insertion is left alone: indentation at the cursor is legitimate.
  if (options.showWhitespaceOnlyChanges !== true && removedText !== '' && /\S/.test(removedText)) {
    if (stripSpaces(insertText) === stripSpaces(removedText)) return { accepted: false, reason: 'whitespace-only' }
  }

  const maxAddedLines = Number.isFinite(Number(options.maxAddedLines)) ? Math.max(1, Number(options.maxAddedLines)) : 20
  const addedLines = countLines(insertText) - countLines(removedText)
  if (addedLines > maxAddedLines) return { accepted: false, reason: 'too-many-lines' }

  if (options.heuristicDuplicateLine !== false) {
    const lines = splitLines(insertText)
    if (lines.length >= 2) {
      let lastIndex = lines.length - 1
      while (lastIndex >= 0 && lines[lastIndex].trim() === '') lastIndex -= 1
      const last = lastIndex >= 0 ? lines[lastIndex].trim() : ''
      const nextStart = buffer.indexOf('\n', plan.endOffset)
      const nextLine = (nextStart === -1 ? buffer.slice(plan.endOffset) : buffer.slice(plan.endOffset, nextStart)).trim()
      if (last !== '' && last === nextLine && last !== '}' && last !== ']') {
        return { accepted: false, reason: 'duplicate-line' }
      }
    }
  }

  if (options.heuristicExtendsRange !== false) {
    const inserted = splitLines(insertText)
    if (inserted.length > 1) {
      const before = splitLines(buffer.slice(0, plan.startOffset))
      const startLine = before.length - 1
      const source = splitLines(buffer).slice(startLine)
      let same = 0
      for (let index = 0; index < inserted.length; index += 1) {
        const candidate = inserted[index].trim()
        if (candidate === '' || source[index] === undefined || candidate !== source[index].trim()) break
        same += 1
      }
      if (same === inserted.length && same > 1) return { accepted: false, reason: 'extends-range' }
    }
  }

  const threshold = Number.isFinite(Number(options.recentRejectThreshold)) ? Math.max(0, Number(options.recentRejectThreshold)) : 3
  const windowMs = Number.isFinite(Number(options.recentRejectWindowMs)) ? Math.max(0, Number(options.recentRejectWindowMs)) : 300000
  if (recentMatch(insertText, rejections, windowMs, threshold)) return { accepted: false, reason: 'recently-rejected' }
  if (options.heuristicRevertingChange !== false && recentMatch(insertText, revertions, windowMs, 1)) {
    return { accepted: false, reason: 'reverting-change' }
  }

  return { accepted: true, reason: '' }
}

const WORD_CHAR = /[\p{L}\p{N}_$]/u

/**
 * End of the next accept word inside `text`, starting at `start`.
 *
 * A word is an identifier run, a whitespace run (plus the run after it, so one
 * press always moves the cursor), or a punctuation run. This is what
 * "accept next word" inserts for a pure insertion plan.
 */
export function nextWordEnd(text, start) {
  const value = String(text ?? '')
  const at = Math.min(Math.max(0, Math.round(Number(start) || 0)), value.length)
  if (at >= value.length) return value.length
  const isWhitespace = (char) => /\s/.test(char)
  let index = at
  if (isWhitespace(value[index])) {
    while (index < value.length && isWhitespace(value[index])) index += 1
    if (index < value.length) {
      if (WORD_CHAR.test(value[index])) {
        while (index < value.length && WORD_CHAR.test(value[index])) index += 1
      } else {
        while (index < value.length && !isWhitespace(value[index]) && !WORD_CHAR.test(value[index])) index += 1
      }
    }
    return index
  }
  if (WORD_CHAR.test(value[index])) {
    while (index < value.length && WORD_CHAR.test(value[index])) index += 1
    return index
  }
  while (index < value.length && !isWhitespace(value[index]) && !WORD_CHAR.test(value[index])) index += 1
  return index
}

/** Bound a text to its last or first `lines` lines. */
export function boundLines(text, lines, edge) {
  const limit = Number(lines)
  if (!Number.isFinite(limit) || limit <= 0) return ''
  const parts = normalizeEol(String(text ?? ''), '\n').split('\n')
  if (parts.length <= limit) return String(text ?? '')
  return edge === 'start' ? parts.slice(0, limit).join('\n') : parts.slice(parts.length - limit).join('\n')
}
