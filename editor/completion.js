/**
 * Prompt preparation and answer cleanup for inline completion.
 *
 * These two operations are deliberately free of I/O: they take text and return
 * text. No disk, no network, no keys, no chat history, no Monaco. That is what
 * makes them testable without a running GUI and safe to call inside the Host
 * request handler.
 *
 * The algorithms are a selective port of Continue
 * (https://github.com/continuedev/continue), commit
 * 5522c6f44ca0ac3528b37244818fbfa39b5af470, Apache-2.0
 * (LICENSE at that commit reads "Apache License, Version 2.0" with
 * "Copyright 2023 Continue Dev, Inc."; verified 20.11.2026). Ported and changed:
 *  - `lineIsRepeated` uses a local Levenshtein implementation instead of the
 *    `fastest-levenshtein` dependency;
 *  - the stream generators became plain array transforms, since the Host works
 *    on a finished string rather than an async line stream;
 *  - model-specific fixups keyed on the model name (`codestral`, `qwen3`,
 *    `granite`, `mercury`, `gemini`) were deliberately not ported: they are
 *    Continue's internal quirks, not properties of the algorithm.
 * See `plans/continue-integration.md` for the full borrow/no-borrow list.
 */

/** Lines at or below this length are never treated as repeated. */
const REPEAT_MIN_LENGTH = 5
/** Relative Levenshtein distance below which two lines count as the same line. */
const REPEAT_DISTANCE_RATIO = 0.1
/** Consecutive identical lines tolerated before the answer is cut. */
const MAX_REPEATS = 3
/** Lines that end a completion when they appear at the logical start. */
const LINES_TO_STOP_AT = ['# End of file.', '<STOP EDITING HERE', '<|/updated_code|>', '```']
/** Leading prefixes stripped from the first line only. */
const PREFIXES_TO_SKIP = ['<COMPLETION>']
/** Whole lines that are dropped wherever they appear. */
const LINES_TO_SKIP = ['</START EDITING HERE>', '<|updated_code|>']
/** Phrases that mark a line as prose rather than code. */
const ENGLISH_START_PHRASES = [
  'here is',
  "here's",
  'sure, here',
  'sure thing',
  'sure!',
  'to fill',
  'certainly',
  'of course',
  'the code should',
]
const ENGLISH_POST_PHRASES = ['explanation:', 'here is', "here's how", 'the above']

/**
 * Levenshtein distance between two strings, computed with a single rolling row.
 * Iterative, bounded by `a.length * b.length`; no dependency and no allocation
 * proportional to the product of the lengths.
 */
export function levenshtein(a, b) {
  if (a === b) return 0
  if (a.length === 0) return b.length
  if (b.length === 0) return a.length

  let previous = new Array(b.length + 1)
  let current = new Array(b.length + 1)
  for (let j = 0; j <= b.length; j += 1) previous[j] = j

  for (let i = 1; i <= a.length; i += 1) {
    current[0] = i
    const charA = a.charCodeAt(i - 1)
    for (let j = 1; j <= b.length; j += 1) {
      const cost = charA === b.charCodeAt(j - 1) ? 0 : 1
      current[j] = Math.min(current[j - 1] + 1, previous[j] + 1, previous[j - 1] + cost)
    }
    const swap = previous
    previous = current
    current = swap
  }
  return previous[b.length]
}

/**
 * True when two lines are similar enough that the second is a repeat of the
 * first: at least 5 characters each, and a Levenshtein distance under 10% of the
 * compared line's length. Short lines are never repeats, so indentation-only and
 * brace-only lines survive.
 */
export function lineIsRepeated(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  if (a.length < REPEAT_MIN_LENGTH || b.length < REPEAT_MIN_LENGTH) return false
  const aTrim = a.trim()
  const bTrim = b.trim()
  if (bTrim.length === 0) return false
  return levenshtein(aTrim, bTrim) / bTrim.length < REPEAT_DISTANCE_RATIO
}

/**
 * True when `pattern` occurs in `line` in a context that makes it meaningful.
 * A pattern glued to a preceding identifier character, or sitting inside an
 * unbalanced string literal, is part of the code rather than a marker.
 */
export function patternIsValid(line, pattern) {
  const index = line.indexOf(pattern)
  if (index === -1) return false
  if (index > 0 && !/\s/.test(line[index - 1])) return false
  const before = line.slice(0, index)
  const single = (before.match(/'/g) || []).length
  const double = (before.match(/"/g) || []).length
  return single % 2 === 0 && double % 2 === 0
}

/** True when the line's logical start is one of the stop markers. */
function isStopLine(line) {
  for (const marker of LINES_TO_STOP_AT) {
    if (!line.includes(marker)) continue
    if (!patternIsValid(line, marker)) continue
    if (line.trimStart().startsWith(marker)) return true
    const before = line.slice(0, line.indexOf(marker))
    if (before.length !== before.trimEnd().length) return true
  }
  return false
}

function isEnglishStartLine(line) {
  const trimmed = line.trim().toLowerCase()
  if (ENGLISH_START_PHRASES.some((phrase) => trimmed.startsWith(phrase))) return true
  // An English lead-in is a sentence, not a statement: several plain words and a
  // colon. A line of code also ends with `:`, but it carries punctuation the
  // sentence pattern below cannot match (`with open(...) as f:`), which is why
  // the earlier blanket "ends with a colon" rule silently deleted the first line
  // of every block the model returned.
  return /^[a-z][a-z'-]*(?: [a-z'-]+){2,}:$/.test(trimmed)
}

function isEnglishEndLine(line) {
  const lowered = line.toLowerCase()
  return ENGLISH_POST_PHRASES.some((phrase) => lowered.startsWith(phrase))
}

/** True when the line is a path comment the model copied out of a snippet. */
function isPathComment(line) {
  const trimmed = line.trimStart()
  return /^(?:\/\/|#|--|;)\s*Path:\s/.test(trimmed)
}

/**
 * The portable line-level cleanup, applied to a finished completion.
 *
 * Order matters and mirrors the original: drop marker lines, strip a leading
 * prefix, cut prose, then cut repetition, then trailing whitespace.
 */
export function cleanLines(raw, options = {}) {
  const keywords = Array.isArray(options.topLevelKeywords) ? options.topLevelKeywords : []
  const lines = String(raw ?? '').split('\n')
  const output = []
  let seenFirstLine = false
  let previousLine
  let repeatCount = 0
  let proseEnded = false

  for (const original of lines) {
    if (isStopLine(original)) break
    if (LINES_TO_SKIP.some((skip) => original.startsWith(skip))) continue

    let line = original

    if (!seenFirstLine) {
      const prefix = PREFIXES_TO_SKIP.find((candidate) => line.startsWith(candidate))
      if (prefix !== undefined) line = line.slice(prefix.length)
      if (line.trim() === '') continue
      seenFirstLine = true
      if (isEnglishStartLine(line)) {
        proseEnded = true
        continue
      }
    } else if (proseEnded && line.trim() === '') {
      proseEnded = false
      continue
    }

    if (isPathComment(line)) continue

    let cut = -1
    if (keywords.length > 0) {
      for (const keyword of keywords) {
        const index = line.indexOf(`${keyword} `)
        if (index > 0 && !isPathComment(line.slice(0, index))) cut = index
      }
    }

    if (line === previousLine) {
      repeatCount += 1
      if (repeatCount >= MAX_REPEATS) break
      continue
    }
    if (previousLine !== undefined && lineIsRepeated(line, previousLine)) {
      repeatCount += 1
      if (repeatCount >= MAX_REPEATS) break
      continue
    }
    previousLine = line
    repeatCount = 1
    if (cut > 0) {
      output.push(line.slice(0, cut).trimEnd())
      break
    }

    output.push(line.trimEnd())
  }

  if (output.length > 0 && output[output.length - 1].trim() === '') output.pop()
  while (output.length > 0 && output[0].trim() === '') output.shift()
  return output.join('\n')
}

/** Strips a wrapping markdown fence, if the model added one. */
function removeFence(text) {
  let value = text
  const opening = value.match(/^\s*```[a-zA-Z0-9_+-]*[ \t]*\r?\n/)
  if (opening !== null) value = value.slice(opening[0].length)
  else if (value.startsWith('```')) return ''
  value = value.replace(/\r?\n?```\s*$/, '')
  if (value.startsWith('```')) return ''
  return value
}

/** True when the answer merely repeats the line already above the cursor. */
function rewritesLineAbove(completion, prefix) {
  const first = completion.split('\n').find((line) => line.trim() !== '')
  if (first === undefined) return true
  const parts = String(prefix ?? '').split('\n')
  const trimmed = parts[parts.length - 1].trim() === '' ? parts.length - 2 : parts.length - 1
  const above = parts[Math.max(0, trimmed)]
  return above.trim() !== '' && above.trim() === first.trim()
}

/**
 * True when the answer is the same line repeated: the first line recurs often
 * enough, and covers enough of the answer, to be a loop rather than code.
 */
function isExtremeRepetition(completion) {
  const lines = completion.split('\n')
  if (lines.length < 6) return false
  const first = lines[0]
  if (first.trim().length === 0) return false
  for (let frequency = 1; frequency <= 2; frequency += 1) {
    let matches = 0
    for (let index = frequency; index < lines.length; index += frequency) {
      if (lineIsRepeated(lines[index], first)) matches += 1
    }
    const ratio = (matches * frequency) / lines.length
    if (matches * frequency > 8 || ratio > 0.8) return true
  }
  return false
}

/**
 * Prepares the bounded prefix and suffix sent to the model.
 *
 * The prefix keeps the tail of the text before the cursor and the suffix keeps
 * the head of the text after it, so both windows stay adjacent to the cursor
 * regardless of file size. A selection is appended to the prefix, because the
 * model should see what the user marked.
 */
export function buildContext({ text, offset, left = 4000, right = 1000, selection }) {
  const full = String(text ?? '')
  const position = Math.max(0, Math.min(full.length, Number.isFinite(offset) ? Math.trunc(offset) : 0))
  const prefixLimit = Math.max(0, Math.trunc(left))
  const suffixLimit = Math.max(0, Math.trunc(right))
  let prefix = full.slice(Math.max(0, position - prefixLimit), position)
  const suffix = full.slice(position, position + suffixLimit)
  const selected = typeof selection === 'string' ? selection : ''
  if (selected !== '') prefix = `${prefix}${selected}`
  return { prefix, suffix, truncated: prefixLimit < position || position + suffixLimit < full.length }
}

/**
 * Turns a raw model answer into an insertion, or into an empty string.
 *
 * Model-agnostic parts of Continue's `postprocessCompletion`: reject blank and
 * whitespace-only answers, reject an answer that repeats the line above the
 * cursor, reject an answer that is the same line over and over, remove a
 * markdown fence, and drop a duplicated space at the join.
 */
/** True when the line is nothing but a comment: no code before the marker. */
function isCommentOnlyLine(line) {
  return /^\s*(?:#|\/\/|--|;|\*|\/\*|<!--)/.test(String(line ?? ''))
}

/**
 * True when the cursor sits at the end of a comment line, i.e. the answer is
 * expected to continue on the next line rather than inside the comment.
 */
function endsInComment(prefix) {
  if (prefix === '' || prefix.endsWith('\n')) return false
  const lines = prefix.split('\n')
  return isCommentOnlyLine(lines[lines.length - 1])
}

export function postprocessCompletion({ completion, prefix = '', suffix = '', topLevelKeywords } = {}) {
  let text = String(completion ?? '')
  if (text.trim() === '') return ''
  // Decided before any rewriting: the answer is meant to start on a new line.
  const startsOnNewLine = /^\r?\n/.test(text)
  // Checked before any rewriting: an answer that repeats the line above the
  // cursor is a repeat, even when the repeat is only the first of its lines.
  if (rewritesLineAbove(text, prefix)) return ''
  text = removeFence(text)
  if (text.trim() === '') return ''
  if (isExtremeRepetition(text)) return ''
  text = cleanLines(text, { topLevelKeywords })
  if (text.trim() === '') return ''
  // Only a single duplicated space at the join is dropped. An answer that starts
  // with a deeper indent is a block written relative to the line, and taking one
  // space off it breaks the alignment of every line below.
  if (prefix.endsWith(' ') && /^ [^ \t]/.test(text)) text = text.slice(1)
  // A comment above the cursor asks for code on the next line, so the answer
  // has to keep the line break that separates it from the comment. `cleanLines`
  // drops leading blank lines by design, which erased that break and glued the
  // code onto the comment; restore exactly one break here instead.
  if (prefix !== '' && !prefix.endsWith('\n') && !text.startsWith('\n')) {
    const answeredNewLine = startsOnNewLine
    // Not every model obeys the instruction to start with a line break: the
    // fast ones answer with bare code. When the cursor is at the end of a
    // comment line and the answer is code, the break is still required, so it
    // is added here rather than hoped for in the prompt.
    const answeredCodeUnderComment = endsInComment(prefix) && !isCommentOnlyLine(text.split('\n')[0])
    if (answeredNewLine || answeredCodeUnderComment) text = `\n${text}`
  }
  void suffix
  return text
}
