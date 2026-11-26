/**
 * Text search across the session workspace.
 *
 * The search is local: it never reaches a model, and it works without the Tab
 * opt-in. It walks the workspace with `node:fs` exactly like the tree does,
 * reuses the tree's skip policy and its realpath guard, and stops on a budget
 * instead of pretending that a truncated scan found nothing.
 *
 * A query is either a literal substring or a one-line regular expression, and
 * either can be restricted to whole words. Lines are matched one by one, so a
 * pattern never spans a newline; a match keeps the text it actually found, not
 * the text of the pattern.
 *
 * Deliberately absent: external processes (`rg`, `git grep`), an index, and
 * multi-line patterns. Those are separate decisions with their own follow-ups;
 * the route answers the one question «where does this text appear» honestly.
 */
import { lstat, readFile, readdir, realpath } from 'node:fs/promises'
import path from 'node:path'

/**
 * Dependency installs and version-control internals. The tree itself hides
 * nothing; search still skips these because vendored packages and object
 * stores never hold the reader's own source, and a single match budget would
 * otherwise fill with them. Build output (`dist`, `build`, `target`, …) stays
 * searchable so generated code can be inspected where the tree shows it.
 */
const SKIPPED = new Set([
  '.git',
  '.hg',
  '.svn',
  'node_modules',
  'bower_components',
  '.venv',
  'venv',
  '.cache',
  '.turbo',
  '.parcel-cache',
])

const MAX_DEPTH = 8
const MAX_FILES = 4000
const MAX_RESULTS = 50
const MAX_FILE_BYTES = 512 * 1024
const MAX_TOTAL_BYTES = 8 * 1024 * 1024
const PREVIEW_CHARS = 200
const BINARY_PROBE_BYTES = 4096

/**
 * Search one workspace for a literal string or a regular expression.
 *
 * @param {object} ctx Host context carrying `fs`.
 * @param {{cwd: string, query: string, limit?: number, hidden?: boolean,
 *          ignoreCase?: boolean, regex?: boolean, wholeWord?: boolean,
 *          maxResults?: number, maxFileBytes?: number,
 *          maxTotalBytes?: number, maxFiles?: number, signal?: AbortSignal}} request
 * @returns {Promise<{matches: Array<{path: string, line: number, column: number,
 *   preview: string, match: string}>, truncated: boolean, scanned: number, bytes: number}>}
 */
export async function searchText(ctx, request) {
  const query = String(request.query ?? '')
  const limit = positive(request.limit, MAX_RESULTS, 200)
  const maxResults = positive(request.maxResults, limit, 2000)
  const maxFiles = positive(request.maxFiles, MAX_FILES, 20000)
  const maxFileBytes = positive(request.maxFileBytes, MAX_FILE_BYTES, 8 * 1024 * 1024)
  const maxTotalBytes = positive(request.maxTotalBytes, MAX_TOTAL_BYTES, 64 * 1024 * 1024)
  const signal = request.signal
  const hidden = request.hidden === true
  const ignoreCase = request.ignoreCase !== false
  const useRegex = request.regex === true
  const wholeWord = request.wholeWord === true
  const skip = typeof request.skip === 'function' ? request.skip : undefined

  if (query === '') return { matches: [], truncated: false, scanned: 0, bytes: 0 }

  // A malformed pattern is refused before the walk starts, so the error costs
  // nothing and the caller gets the engine's own explanation.
  const expression = useRegex ? compile(query, ignoreCase) : undefined
  const needle = useRegex ? '' : ignoreCase ? query.toLowerCase() : query

  const root = await ctx.fs.resolve(request.cwd, { signal })
  const nativeRoot = ctx.fs.processPath(root)
  // `contains` compares text, so a link inside the workspace could still point
  // at C:\Windows. The walk starts from the real root and refuses symlinked
  // directories and files, which keeps every read inside the workspace.
  const realRoot = await safeRealpath(nativeRoot)
  const knownRoot = realRoot === undefined ? nativeRoot : realRoot

  const matches = []
  const queue = [{ relative: '', absolute: knownRoot, depth: 0 }]
  let scanned = 0
  let bytes = 0
  let truncated = false

  walk: while (queue.length > 0) {
    if (signal?.aborted) throw fail('cancelled', 'Поиск отменён')
    const current = queue.shift()
    let dirents
    try {
      dirents = await readdir(current.absolute, { withFileTypes: true })
    } catch {
      continue
    }
    dirents.sort((left, right) =>
      left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: 'base' }),
    )
    for (const dirent of dirents) {
      if (signal?.aborted) throw fail('cancelled', 'Поиск отменён')
      const name = dirent.name
      if (dirent.isSymbolicLink()) continue
      if (!hidden && name.startsWith('.')) continue
      const relative = current.relative === '' ? name : `${current.relative}/${name}`
      if (skip !== undefined && skip(relative, dirent.isDirectory())) continue
      if (dirent.isDirectory()) {
        if (SKIPPED.has(name)) continue
        if (current.depth >= MAX_DEPTH) {
          truncated = true
          continue
        }
        queue.push({ relative, absolute: path.join(current.absolute, name), depth: current.depth + 1 })
        continue
      }
      if (!dirent.isFile()) continue
      if (scanned >= maxFiles) {
        truncated = true
        break walk
      }
      if (bytes >= maxTotalBytes) {
        truncated = true
        break walk
      }
      const absolute = path.join(current.absolute, name)
      let info
      try {
        info = await lstat(absolute)
      } catch {
        continue
      }
      if (!info.isFile() || info.size > maxFileBytes) continue
      if (bytes + info.size > maxTotalBytes) {
        truncated = true
        break walk
      }
      let buffer
      try {
        buffer = await readFile(absolute)
      } catch {
        continue
      }
      scanned += 1
      if (looksBinary(buffer)) continue
      bytes += buffer.length
      const text = buffer.toString('utf8')
      if (text.includes('\uFFFD')) continue
      const lines = text.split(/\r?\n/)
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index]
        // `visit` owns the result budget, so a helper stops as soon as the
        // budget is full instead of first collecting every hit on the line.
        const visit = (at, found) => {
          if (wholeWord && !isWholeWord(line, at, found.length)) return true
          matches.push({
            path: relative,
            line: index + 1,
            column: at + 1,
            preview: clipLine(line, at),
            match: found,
          })
          if (matches.length >= maxResults) {
            truncated = true
            return false
          }
          return true
        }
        const more = useRegex
          ? eachRegexHit(expression, line, visit)
          : eachLiteralHit(ignoreCase ? line.toLowerCase() : line, line, needle, query.length, visit)
        if (!more) break walk
      }
    }
  }

  return { matches, truncated, scanned, bytes }
}

/** One visible line around the hit, so a long minified line stays readable. */
function clipLine(line, at) {
  const trimmed = line.replace(/^\s+/, '')
  const indent = line.length - trimmed.length
  const left = Math.min(at - 40, indent + trimmed.length - PREVIEW_CHARS)
  const start = Math.max(0, left);
  return line.slice(start, start + PREVIEW_CHARS).trimEnd()
}

/**
 * Visit every non-empty regex match on one line; returns false when `visit`
 * asks to stop. `lastIndex` advances past an empty match, otherwise `exec`
 * returns the same position forever and the scan never ends.
 */
function eachRegexHit(expression, line, visit) {
  expression.lastIndex = 0
  let hit
  while ((hit = expression.exec(line)) !== null) {
    if (hit[0] === '') {
      expression.lastIndex += 1
      continue
    }
    if (!visit(hit.index, hit[0])) return false
  }
  return true
}

/** Visit every literal hit; the text is cut from the line, not from `needle`. */
function eachLiteralHit(haystack, line, needle, width, visit) {
  let at = haystack.indexOf(needle)
  while (at !== -1) {
    if (!visit(at, line.slice(at, at + width))) return false
    at = haystack.indexOf(needle, at + Math.max(1, needle.length))
  }
  return true
}

/**
 * Letters, digits and `_` count as one word, including non-ASCII letters, so a
 * hit inside `needle_1` or `нужно` is filtered exactly like one inside `needles`.
 */
const WORD = /[\p{L}\p{N}_]/u

function isWholeWord(line, at, length) {
  return !WORD.test(charBefore(line, at)) && !WORD.test(charAfter(line, at + length))
}

/** One code point to the left, so a surrogate pair is not torn in half. */
function charBefore(line, at) {
  if (at <= 0) return ''
  const low = line.charCodeAt(at - 1)
  const start = low >= 0xdc00 && low <= 0xdfff && at >= 2 ? at - 2 : at - 1
  return String.fromCodePoint(line.codePointAt(start))
}

/** One code point to the right; `''` at the end of the line. */
function charAfter(line, at) {
  return at >= line.length ? '' : String.fromCodePoint(line.codePointAt(at))
}

function compile(query, ignoreCase) {
  try {
    return new RegExp(query, ignoreCase ? 'gi' : 'g')
  } catch (error) {
    throw fail('bad-request', `Некорректное регулярное выражение: ${error.message}`)
  }
}

function looksBinary(buffer) {
  const probe = buffer.subarray(0, Math.min(buffer.length, BINARY_PROBE_BYTES))
  return probe.includes(0)
}

async function safeRealpath(local) {
  try {
    return await realpath(local)
  } catch {
    return undefined
  }
}

function positive(value, fallback, maximum) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric) || numeric <= 0) return fallback
  return Math.min(maximum, Math.max(1, Math.floor(numeric)))
}

function fail(code, message) {
  return Object.assign(new Error(message), { code })
}
