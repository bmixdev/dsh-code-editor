/**
 * Literal text search across the session workspace.
 *
 * The search is local: it never reaches a model, and it works without the Tab
 * opt-in. It walks the workspace with `node:fs` exactly like the tree does,
 * reuses the tree's skip policy and its realpath guard, and stops on a budget
 * instead of pretending that a truncated scan found nothing.
 *
 * Deliberately absent: regular expressions, external processes (`rg`, `git
 * grep`), an index. Those are separate decisions with their own follow-ups; the
 * route answers the one question «where does this text appear» honestly.
 */
import { lstat, readFile, readdir, realpath } from 'node:fs/promises'
import path from 'node:path'

/** Same policy as `tree.js`: folders never worth walking for an editor. */
const SKIPPED = new Set([
  '.git',
  '.hg',
  '.svn',
  'node_modules',
  'bower_components',
  'dist',
  'build',
  'out',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.venv',
  'venv',
  '__pycache__',
  '.cache',
  '.turbo',
  '.parcel-cache',
  'coverage',
  'target',
])

const MAX_DEPTH = 8
const MAX_FILES = 4000
const MAX_RESULTS = 50
const MAX_FILE_BYTES = 512 * 1024
const MAX_TOTAL_BYTES = 8 * 1024 * 1024
const PREVIEW_CHARS = 200
const BINARY_PROBE_BYTES = 4096

/**
 * Search one workspace for a literal string.
 *
 * @param {object} ctx Host context carrying `fs`.
 * @param {{cwd: string, query: string, limit?: number, hidden?: boolean,
 *          ignoreCase?: boolean, maxResults?: number, maxFileBytes?: number,
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

  if (query === '') return { matches: [], truncated: false, scanned: 0, bytes: 0 }

  const root = await ctx.fs.resolve(request.cwd, { signal })
  const nativeRoot = ctx.fs.processPath(root)
  // `contains` compares text, so a link inside the workspace could still point
  // at C:\Windows. The walk starts from the real root and refuses symlinked
  // directories and files, which keeps every read inside the workspace.
  const realRoot = await safeRealpath(nativeRoot)
  const knownRoot = realRoot === undefined ? nativeRoot : realRoot

  const needle = ignoreCase ? query.toLowerCase() : query
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
        const haystack = ignoreCase ? line.toLowerCase() : line
        let at = haystack.indexOf(needle)
        while (at !== -1) {
          matches.push({
            path: relative,
            line: index + 1,
            column: at + 1,
            preview: clipLine(line, at),
            match: line.slice(at, at + query.length),
          })
          if (matches.length >= maxResults) {
            truncated = true
            break walk
          }
          at = haystack.indexOf(needle, at + Math.max(1, needle.length))
        }
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
