/**
 * Directory listing for the editor's file tree.
 *
 * The DSH file service has no "list a directory" operation: it resolves,
 * stats, reads and writes single targets. The explorer therefore lists with
 * `node:fs`, but it still resolves every directory through `ctx.fs` first, so a
 * path outside the session workspace is rejected by exactly the same check that
 * guards opening a file.
 */
import { readdir, lstat, realpath } from 'node:fs/promises'
import path from 'node:path'

/** Folders that are never worth walking in an editor tree. */
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

/** Hard cap per directory: the tree is a navigator, not a file browser. */
const MAX_ENTRIES = 400

function kindOf(entry) {
  if (entry.isDirectory()) return 'directory'
  if (entry.isFile()) return 'file'
  if (entry.isSymbolicLink()) return 'symlink'
  return 'other'
}

function fail(code, message) {
  return Object.assign(new Error(message), { code })
}

/** Real path of a local path, or undefined when the platform or link refuses to say. */
async function safeRealpath(local) {
  try {
    return await realpath(local)
  } catch {
    return undefined
  }
}

/**
 * List one directory inside the session workspace.
 * @param {object} ctx - Host context carrying `fs`.
 * @param {{cwd: string, relativePath?: string, hidden?: boolean, signal?: AbortSignal}} request
 */
export async function listTree(ctx, { cwd, relativePath = '', hidden = false, signal }) {
  const root = await ctx.fs.resolve(cwd, { signal })
  const requested = String(relativePath ?? '').trim()
  const target = requested === ''
    ? root
    : await ctx.fs.resolve(path.isAbsolute(requested) ? requested : path.join(cwd, requested), { cwd, signal })

  if (!ctx.fs.contains(root, target)) {
    throw fail('outside-workspace', `Папка вне рабочей области: ${requested}`)
  }

  const info = await ctx.fs.stat(target, signal)
  if (info === undefined) throw fail('not-found', `Папка не найдена: ${requested}`)
  if (info.type !== 'directory') throw fail('not-a-directory', `Это не папка: ${requested}`)

  const native = ctx.fs.processPath(target)
  // `contains` compares paths as text, so a symlink inside the workspace can
  // still point at /etc or C:\Windows. A link is listed (the tree marks it) but
  // its target must resolve inside the workspace before the folder is walked.
  const real = await safeRealpath(native)
  const realRoot = await safeRealpath(ctx.fs.processPath(root))
  if (real !== undefined && realRoot !== undefined) {
    const prefix = realRoot.endsWith(path.sep) ? realRoot : `${realRoot}${path.sep}`
    if (real !== realRoot && !real.startsWith(prefix)) {
      throw fail('outside-workspace', `Ссылка выводит за рабочую область: ${requested}`)
    }
  }
  let dirents
  try {
    dirents = await readdir(native, { withFileTypes: true })
  } catch (error) {
    throw fail('read-failed', `Не удалось прочитать папку: ${error instanceof Error ? error.message : String(error)}`)
  }

  const entries = []
  for (const dirent of dirents) {
    const name = dirent.name
    const type = kindOf(dirent)
    if (type === 'other') continue
    if (!hidden && name.startsWith('.')) continue
    if (type === 'directory' && SKIPPED.has(name)) continue
    entries.push({ name, type })
  }

  entries.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'directory' ? -1 : 1
    return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
  })

  const truncated = entries.length > MAX_ENTRIES
  const visible = truncated ? entries.slice(0, MAX_ENTRIES) : entries

  const decorated = []
  for (const entry of visible) {
    const absolute = path.join(native, entry.name)
    let size
    let mtimeMs
    if (entry.type === 'file') {
      try {
        const stats = await lstat(absolute)
        size = stats.size
        mtimeMs = stats.mtimeMs
      } catch {
        // A file can disappear between `readdir` and `lstat`; the row still
        // opens and reports its own error, so the listing keeps it.
      }
    }
    decorated.push({ ...entry, ...(size === undefined ? {} : { size }), ...(mtimeMs === undefined ? {} : { mtimeMs }) })
  }

  return {
    relativePath: requested.split(path.sep).join('/'),
    workspaceRoot: ctx.fs.processPath(root),
    entries: decorated,
    truncated,
  }
}
