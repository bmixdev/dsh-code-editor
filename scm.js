/**
 * Git plumbing for the Source Control panel.
 *
 * This module never chooses a workspace, never reads a file behind the Host's
 * policy and never builds a command line from user text: it receives a `git`
 * runner bound to one directory, fixed argv arrays, and a `readWorktree`
 * callback supplied by `index.js` (which is the only place that knows the
 * session, the sandbox policy and the workspace boundary).
 *
 * The wire format is deliberately boring so the same snapshot can be tested
 * without a browser:
 *  - `loadSnapshot` returns one list of entries plus a revision string;
 *  - `rowsOf` projects entries onto the three panel sections (staged, changes,
 *    conflicts), so an `MM` file is two rows;
 *  - `loadDiff` reads both sides through Git (HEAD / index) or through the
 *    worktree callback and returns text or a typed reason, never a checkout.
 *
 * Machine formats only. A localized message, an ASCII graph or a path split on
 * a space is never parsed: `git status --porcelain=v2 -z` and NUL-separated
 * `ls-files` / `ls-tree` records are the contract.
 * Reference: https://git-scm.com/docs/git-status#_porcelain_format_version_2
 */
import { createHash } from 'node:crypto'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

/** One Git call may not run longer than this without a caller override. */
export const GIT_TIMEOUT_MS = 15000
/** A status listing above this size is reported as a limitation, not as clean. */
export const MAX_STATUS_BYTES = 16 * 1024 * 1024
/** The index listing feeds the revision; it is normally a few kilobytes. */
export const MAX_INDEX_BYTES = 32 * 1024 * 1024
/** The largest blob the comparison will send to the browser, per side. */
export const MAX_DIFF_BYTES = 2 * 1024 * 1024
/** First bytes of a large worktree file used for its content marker. */
const TOKEN_PREFIX_BYTES = 4 * 1024 * 1024
/** Total worktree bytes hashed for one snapshot. */
const TOKEN_BUDGET_BYTES = 64 * 1024 * 1024
/** Above this many worktree changes the panel stops hashing every file. */
const TOKEN_MAX_ENTRIES = 500
const HISTORY_PAGE = 50

export class ScmError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'ScmError'
    this.code = code
  }
}

const sha256 = (value) => createHash('sha256').update(value).digest('hex')

/**
 * Environment for a Git child.
 *
 * `GIT_DIR` and friends would redirect the command to another repository, so
 * they are dropped instead of inherited: the editor must operate on the
 * session's own worktree. Prompts are disabled because a GUI has no terminal.
 */
export function gitEnvironment(base = process.env) {
  const env = { ...base }
  for (const name of [
    'GIT_DIR',
    'GIT_WORK_TREE',
    'GIT_INDEX_FILE',
    'GIT_OBJECT_DIRECTORY',
    'GIT_ALTERNATE_OBJECT_DIRECTORIES',
    'GIT_NAMESPACE',
    'GIT_COMMON_DIR',
    'GIT_PREFIX',
    'GIT_CONFIG_COUNT',
    'GIT_CONFIG_PARAMETERS',
  ]) {
    delete env[name]
  }
  env.GIT_TERMINAL_PROMPT = '0'
  env.GIT_PAGER = 'cat'
  env.PAGER = 'cat'
  env.GIT_EDITOR = 'true'
  env.GIT_ASKPASS = 'echo'
  return env
}

/**
 * Bind a runner to one directory. `run` accepts only an argv array; there is no
 * shell, so a path containing `&`, spaces or quotes is data, not syntax.
 */
export function createGit(cwd, { env = process.env, timeoutMs = GIT_TIMEOUT_MS } = {}) {
  return {
    cwd,
    async run(args, options = {}) {
      const limit = options.maxBytes ?? MAX_STATUS_BYTES
      const deadline = options.timeoutMs ?? timeoutMs
      const signal = options.signal
      if (signal?.aborted === true) throw new ScmError('cancelled', 'Запрос отменён.')
      return await new Promise((resolve, reject) => {
        let child
        try {
          child = spawn('git', args, {
            cwd,
            env: gitEnvironment(env),
            windowsHide: true,
            stdio: ['pipe', 'pipe', 'pipe'],
          })
        } catch (cause) {
          reject(new ScmError('git-not-found', `Git не запустился: ${cause instanceof Error ? cause.message : String(cause)}`))
          return
        }
        const stdout = []
        let stdoutBytes = 0
        let stderr = ''
        let settled = false
        let timer
        const cleanup = () => {
          if (timer !== undefined) clearTimeout(timer)
          signal?.removeEventListener?.('abort', onAbort)
        }
        const settle = (error, result) => {
          if (settled) return
          settled = true
          cleanup()
          if (error !== undefined) reject(error)
          else resolve(result)
        }
        const stop = (error) => {
          settle(error)
          try {
            child.kill()
          } catch {
            /* already gone */
          }
        }
        const onAbort = () => stop(new ScmError('cancelled', 'Запрос отменён.'))
        signal?.addEventListener?.('abort', onAbort, { once: true })
        timer = setTimeout(() => {
          stop(new ScmError('timeout', 'Git не ответил вовремя.'))
        }, deadline)
        child.stdout.on('data', (chunk) => {
          stdoutBytes += chunk.length
          if (stdoutBytes > limit) {
            stop(
              new ScmError(
                'output-limit',
                'Ответ Git превысил предел — панель показывает ограничение, а не пустое дерево.',
              ),
            )
            return
          }
          stdout.push(chunk)
        })
        child.stderr.on('data', (chunk) => {
          if (stderr.length < 64 * 1024) stderr += chunk.toString('utf8')
        })
        child.on('error', (cause) => {
          if (cause?.code === 'ENOENT') {
            settle(new ScmError('git-not-found', 'Git не найден в PATH — Source Control недоступен.'))
            return
          }
          settle(new ScmError('git-failed', `Git не запустился: ${cause instanceof Error ? cause.message : String(cause)}`))
        })
        child.on('close', (code) => {
          settle(undefined, { code: code ?? -1, stdout: Buffer.concat(stdout), stderr })
        })
        child.stdin.on('error', () => {
          /* a command may exit before reading stdin; `close` carries the verdict */
        })
        if (options.input === undefined) child.stdin.end()
        else child.stdin.end(options.input)
      })
    },
  }
}

/** Trim one trailing newline from a Git text answer. */
function text(value) {
  return value.toString('utf8').replace(/\r?\n$/, '')
}

function firstLine(value) {
  const line = value.split(/\r?\n/).find((candidate) => candidate.trim() !== '')
  return line === undefined ? '' : line.trim()
}

/** Map a failed Git call to a typed, human-readable reason. */
export function classifyFailure(result) {
  const message = `${result.stderr}\n${result.stdout.toString('utf8')}`
  if (/not a git repository/i.test(message)) {
    return new ScmError('not-repository', 'Рабочая папка сессии не является корнем Git-репозитория.')
  }
  if (/detected dubious ownership|unsafe repository/i.test(message)) {
    return new ScmError(
      'unsafe-repository',
      'Git считает репозиторий недоверенным (владелец папки отличается). Панель не запускает команды в таком репозитории.',
    )
  }
  if (/index\.lock|another git process|Unable to create .*\.lock/i.test(message)) {
    return new ScmError('locked', 'Индекс занят другим процессом Git. Дождитесь его завершения и повторите.')
  }
  return new ScmError('git-failed', firstLine(message) || 'Git завершился с ошибкой.')
}

/** Global options for read-only commands, so a status never writes the index. */
function readArgs(...rest) {
  return ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'core.quotepath=false', '-c', 'color.ui=false', ...rest]
}

/** Global options for commands that change the index or create objects. */
function writeArgs(...rest) {
  return ['-c', 'core.fsmonitor=false', '-c', 'core.quotepath=false', '-c', 'core.color.ui=false', ...rest]
}

// `--ignored` is needed to see `!` records at all; the panel ignores them, but
// the parser and its tests must be able to prove that they are classified.
const STATUS_ARGS = readArgs(
  'status',
  '--porcelain=v2',
  '--branch',
  '-z',
  '--untracked-files=all',
  '--ignored',
)
const LS_FILES_ARGS = readArgs('ls-files', '-s', '-z')

/** Native directory compare, case-insensitive on Windows like the filesystem. */
function normalizeDirectory(value) {
  const resolved = path.resolve(value)
  const trimmed = resolved.length > path.parse(resolved).root.length ? resolved.replace(/[\\/]+$/, '') : resolved
  return process.platform === 'win32' ? trimmed.toLowerCase() : trimmed
}

export async function canonicalDirectory(value) {
  try {
    return normalizeDirectory(await realpath(value))
  } catch {
    return normalizeDirectory(value)
  }
}

export async function sameDirectory(left, right) {
  return (await canonicalDirectory(left)) === (await canonicalDirectory(right))
}

/**
 * The repository root as Git sees it, or a typed refusal. A `.git` FILE (a
 * linked worktree) answers normally here; it is not a missing repository.
 */
export async function resolveRoot(git, signal) {
  const result = await git.run(readArgs('rev-parse', '--show-toplevel'), { signal })
  if (result.code !== 0) throw classifyFailure(result)
  const root = text(result.stdout).trim()
  if (root === '') throw new ScmError('not-repository', 'Git не назвал корень репозитория.')
  return root
}

/**
 * Parse `status --porcelain=v2 --branch -z` into entries. The path is never
 * split on spaces: each record has a fixed field count and a NUL boundary, and
 * a rename carries its old path in the NEXT NUL field.
 */
export function parseStatus(stdout) {
  const chunks = stdout.toString('utf8').split('\0')
  const entries = []
  let branch = ''
  let head = ''
  let detached = false
  let unborn = false
  for (let index = 0; index < chunks.length; index += 1) {
    const record = chunks[index]
    if (record === '') continue
    if (record.startsWith('# ')) {
      const header = record.slice(2)
      if (header.startsWith('branch.oid ')) {
        const value = header.slice('branch.oid '.length).trim()
        if (value === '(initial)') unborn = true
        else head = value
      } else if (header.startsWith('branch.head ')) {
        const value = header.slice('branch.head '.length).trim()
        if (value === '(detached)') detached = true
        else branch = value
      }
      continue
    }
    const marker = record[0]
    if (marker === '1') {
      // `1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>`: seven fields, then path.
      const split = takeFields(record.slice(2), 7)
      if (split.rest === '') continue
      entries.push({
        path: split.rest,
        indexStatus: split.fields[0]?.[0] ?? '.',
        worktreeStatus: split.fields[0]?.[1] ?? '.',
        kind: kindOf(split.fields[0] ?? '..'),
      })
    } else if (marker === '2') {
      const split = takeFields(record.slice(2), 8)
      const oldPath = chunks[index + 1] ?? ''
      index += 1
      if (split.rest === '') continue
      entries.push({
        path: split.rest,
        oldPath,
        indexStatus: split.fields[0]?.[0] ?? '.',
        worktreeStatus: split.fields[0]?.[1] ?? '.',
        kind: kindOf(split.fields[0] ?? '..'),
      })
    } else if (marker === 'u') {
      // `u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>`: nine fields.
      const split = takeFields(record.slice(2), 9)
      if (split.rest === '') continue
      entries.push({
        path: split.rest,
        indexStatus: split.fields[0]?.[0] ?? 'U',
        worktreeStatus: split.fields[0]?.[1] ?? 'U',
        kind: 'conflict',
      })
    } else if (marker === '?') {
      entries.push({ path: record.slice(2), indexStatus: '?', worktreeStatus: '.', kind: 'untracked' })
    } else if (marker === '!') {
      entries.push({ path: record.slice(2), indexStatus: '!', worktreeStatus: '.', kind: 'ignored' })
    }
  }
  entries.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
  for (const entry of entries) if (entry.oldPath === '') delete entry.oldPath
  return { branch, head, detached, unborn, entries }
}

/**
 * Split `count` space-separated fields and keep everything after the last one
 * as `rest`. `String.split(separator, limit)` would silently drop the tail, and
 * the tail is exactly the path this parser must not damage.
 */
function takeFields(value, count) {
  const fields = []
  let start = 0
  while (fields.length < count) {
    const space = value.indexOf(' ', start)
    if (space === -1) {
      fields.push(value.slice(start))
      return { fields, rest: '' }
    }
    fields.push(value.slice(start, space))
    start = space + 1
  }
  return { fields, rest: value.slice(start) }
}

/** The section a status pair belongs to. Conflicts win over both sides. */
export function groupsOf(entry) {
  if (entry.kind === 'conflict') return ['conflicts']
  if (entry.kind === 'ignored') return []
  if (entry.kind === 'untracked') return ['changes']
  const groups = []
  if (entry.indexStatus !== '.' && entry.indexStatus !== '?') groups.push('staged')
  if (entry.worktreeStatus !== '.') groups.push('changes')
  return groups
}

function kindOf(pair) {
  const [indexStatus, worktreeStatus] = [pair[0] ?? '.', pair[1] ?? '.']
  if (indexStatus === '?' && worktreeStatus === '.') return 'untracked'
  if (indexStatus === '!' && worktreeStatus === '.') return 'ignored'
  if (indexStatus === 'U' || worktreeStatus === 'U' || ['AA', 'DD', 'AU', 'UA', 'DU', 'UD'].includes(pair)) return 'conflict'
  if (indexStatus === 'R' || worktreeStatus === 'R') return 'renamed'
  if (indexStatus === 'C' || worktreeStatus === 'C') return 'copied'
  if (indexStatus === 'A' || worktreeStatus === 'A') return 'added'
  if (indexStatus === 'D' || worktreeStatus === 'D') return 'deleted'
  if (indexStatus === 'T' || worktreeStatus === 'T') return 'typechanged'
  if (indexStatus === 'M' || worktreeStatus === 'M') return 'modified'
  return 'unknown'
}

/** Flatten entries into panel rows; an `MM` file produces two rows. */
export function rowsOf(entries) {
  const rows = []
  for (const entry of entries) {
    for (const group of groupsOf(entry)) {
      rows.push({ group, path: entry.path, key: `${group}:${entry.path}`, entry })
    }
  }
  return rows
}

/**
 * A content marker for the worktree side of one entry. It is returned with the
 * status, and staging compares it with a fresh one: the same `M` letter is not
 * the same bytes. Large files contribute their size, timestamp and prefix, not
 * an unbounded read.
 */
export function worktreeToken(read) {
  if (read === undefined || read === null) return ''
  if (read.kind === 'missing') return 'missing'
  if (read.kind === 'outside') return 'outside'
  if (read.kind === 'special') return 'special'
  if (read.kind === 'symlink') return `link:${sha256(String(read.target ?? ''))}`
  if (read.kind !== 'file') return ''
  const bytes = Buffer.isBuffer(read.bytes) ? read.bytes : Buffer.from(read.bytes ?? [])
  if (read.truncated === true || read.bytesTruncated === true) {
    return `t:${read.size ?? bytes.length}:${Math.round(Number(read.mtimeMs) || 0)}:${sha256(bytes)}`
  }
  return `f:${bytes.length}:${sha256(bytes)}`
}

/**
 * Read one snapshot: status, index digest, revision and worktree tokens.
 *
 * `readWorktree(relativePath)` is injected: it enforces the workspace boundary
 * and returns `{kind, bytes, size, truncated, mtimeMs}`. The snapshot survives
 * a failed token read — the list still opens, but a row without a token cannot
 * be staged until the panel refreshes.
 */
export async function loadSnapshot(git, { readWorktree, signal } = {}) {
  const statusResult = await git.run(STATUS_ARGS, { signal, maxBytes: MAX_STATUS_BYTES })
  if (statusResult.code !== 0) throw classifyFailure(statusResult)
  const indexResult = await git.run(LS_FILES_ARGS, { signal, maxBytes: MAX_INDEX_BYTES })
  if (indexResult.code !== 0) throw classifyFailure(indexResult)
  const parsed = parseStatus(statusResult.stdout)
  const indexDigest = sha256(indexResult.stdout)

  let budget = TOKEN_BUDGET_BYTES
  let hashed = 0
  if (typeof readWorktree === 'function') {
    for (const entry of parsed.entries) {
      const needsToken = entry.worktreeStatus !== '.' || entry.kind === 'untracked'
      if (!needsToken || entry.kind === 'conflict' || entry.kind === 'ignored') continue
      if (hashed >= TOKEN_MAX_ENTRIES || budget <= 0) continue
      hashed += 1
      let read
      try {
        read = await readWorktree(entry.path)
      } catch {
        read = undefined
      }
      if (read !== undefined && read.kind === 'file') {
        budget -= Math.max(0, Number(read.size) || 0)
      }
      entry.token = worktreeToken(read)
    }
  }

  // The revision covers the worktree bytes that the status line itself does not
  // spell out: the same `M` with different content is a different snapshot.
  const tokens = parsed.entries.map((entry) => `${entry.path}\0${entry.token ?? ''}`).join('\0')
  const revision = sha256(
    Buffer.concat([
      Buffer.from(
        `${parsed.head}\0${parsed.branch}\0${parsed.detached ? '1' : '0'}\0${indexDigest}\0`,
        'utf8',
      ),
      statusResult.stdout,
      Buffer.from(`\0${tokens}`, 'utf8'),
    ]),
  )

  return {
    branch: parsed.branch,
    head: parsed.head,
    detached: parsed.detached,
    unborn: parsed.unborn,
    entries: parsed.entries,
    revision,
    readOnly: false,
  }
}

/** Locate a row by group and path in a fresh snapshot. */
export function findRow(snapshot, group, target) {
  return rowsOf(snapshot.entries).find((row) => row.group === group && row.path === target)
}

function parseLsFiles(stdout) {
  const records = []
  for (const record of stdout.toString('utf8').split('\0')) {
    if (record === '') continue
    const tab = record.indexOf('\t')
    if (tab === -1) continue
    const [mode, oid, stage] = record.slice(0, tab).split(' ')
    records.push({ mode, oid, stage: Number(stage), path: record.slice(tab + 1) })
  }
  return records
}

/** The index entry for one path; several stages mean an unresolved conflict. */
async function indexBlob(git, target, { maxBytes, signal }) {
  const result = await git.run(readArgs('--literal-pathspecs', 'ls-files', '-s', '-z', '--', target), { signal })
  if (result.code !== 0) throw classifyFailure(result)
  const records = parseLsFiles(result.stdout)
  if (records.length === 0) return { kind: 'missing' }
  if (records.some((record) => record.stage !== 0) || records.length > 1) return { kind: 'conflict' }
  if (records[0].mode === '160000') return { kind: 'special' }
  return await catBlob(git, records[0].oid, { maxBytes, signal })
}

/** A blob from any commit-ish (HEAD, a parent, the commit being viewed). */
async function treeBlob(git, revision, target, { maxBytes, signal }) {
  const result = await git.run(readArgs('--literal-pathspecs', 'ls-tree', '-z', revision, '--', target), { signal })
  if (result.code !== 0) {
    if (/Not a valid object name|unknown revision|bad revision/i.test(result.stderr)) return { kind: 'missing' }
    throw classifyFailure(result)
  }
  const record = result.stdout.toString('utf8').split('\0').find((candidate) => candidate !== '')
  if (record === undefined) return { kind: 'missing' }
  const tab = record.indexOf('\t')
  if (tab === -1) return { kind: 'missing' }
  const [mode, type, oid] = record.slice(0, tab).split(' ')
  if (type !== 'blob' || mode === '160000') return { kind: 'special' }
  return await catBlob(git, oid, { maxBytes, signal })
}

async function catBlob(git, oid, { maxBytes, signal }) {
  const result = await git.run(readArgs('cat-file', 'blob', oid), { signal, maxBytes: maxBytes + 1 })
  if (result.code !== 0) throw classifyFailure(result)
  if (result.stdout.length > maxBytes) return { kind: 'too-large', size: result.stdout.length }
  return { kind: 'file', bytes: result.stdout, size: result.stdout.length }
}

/** Strict UTF-8 text, no NULs: the same rule the editor uses for files. */
export function decodeText(bytes) {
  for (const byte of bytes) if (byte === 0) return undefined
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return undefined
  }
}

/** Turn one side into `{kind:'empty'|'binary'|'too-large'|'encoding'|'text'}`. */
function sideOf(read, maxBytes) {
  if (read === undefined || read.kind === 'missing' || read.kind === 'empty') return { kind: 'empty', text: '' }
  if (read.kind === 'outside') return { kind: 'outside' }
  if (read.kind === 'special' || read.kind === 'conflict') return { kind: 'binary' }
  if (read.kind === 'symlink') return { kind: 'text', text: String(read.target ?? '') }
  if (read.kind === 'too-large') return { kind: 'too-large', size: read.size }
  if (read.kind !== 'file') return { kind: 'binary' }
  const bytes = Buffer.isBuffer(read.bytes) ? read.bytes : Buffer.from(read.bytes ?? [])
  if (read.truncated === true || bytes.length > maxBytes) return { kind: 'too-large', size: read.size ?? bytes.length }
  const decoded = decodeText(bytes)
  if (decoded === undefined) return { kind: 'binary' }
  return { kind: 'text', text: decoded }
}

/**
 * The two sides of one row.
 *
 *   staged  : HEAD (old name) → index
 *   changes : index (old name) → worktree
 *
 * A missing side is empty; a read failure is an error. Conflicts are not drawn
 * as a two-way diff at all: resolving them is outside this panel.
 */
export async function loadDiff(git, snapshot, { group, path: target, maxBytes = MAX_DIFF_BYTES, signal, readWorktree } = {}) {
  const row = findRow(snapshot, group, target)
  if (row === undefined) throw new ScmError('stale', 'Файл больше не в этом списке изменений. Обновите панель.')
  if (group === 'conflicts') {
    return { kind: 'conflict', group, path: target, message: 'Конфликт нужно разрешить вне панели, затем добавить результат через «+».' }
  }
  const oldPath = row.entry.oldPath ?? target
  let before
  let after
  let beforeLabel
  let afterLabel
  if (group === 'staged') {
    before = snapshot.unborn ? { kind: 'missing' } : await treeBlob(git, 'HEAD', oldPath, { maxBytes, signal })
    after = await indexBlob(git, target, { maxBytes, signal })
    beforeLabel = 'HEAD'
    afterLabel = 'Индекс'
  } else {
    before = await indexBlob(git, oldPath, { maxBytes, signal })
    const read = typeof readWorktree === 'function' ? await readWorktree(target) : { kind: 'missing' }
    after = read
    beforeLabel = snapshot.unborn && row.entry.kind === 'untracked' ? 'Пусто' : 'Индекс'
    afterLabel = 'На диске'
  }
  const left = sideOf(before, maxBytes)
  const right = sideOf(after, maxBytes)
  const base = {
    group,
    path: target,
    ...(row.entry.oldPath === undefined ? {} : { oldPath: row.entry.oldPath }),
    beforeLabel,
    afterLabel,
    canOpen: right.kind === 'text',
  }
  if (left.kind === 'too-large' || right.kind === 'too-large') {
    return { ...base, kind: 'too-large', size: Math.max(left.size ?? 0, right.size ?? 0), message: 'Слишком большой файл для сравнения.' }
  }
  if (left.kind === 'outside' || right.kind === 'outside') {
    return { ...base, kind: 'outside', message: 'Файл выводит за рабочую область сессии — чтение отменено.' }
  }
  if (left.kind === 'binary' || right.kind === 'binary') {
    return { ...base, kind: 'binary', message: 'Двоичный файл или подмодуль: текстовое сравнение недоступно.' }
  }
  if (left.kind === 'encoding' || right.kind === 'encoding') {
    return { ...base, kind: 'encoding', message: 'Файл не является текстом UTF-8.' }
  }
  return { ...base, kind: 'text', before: left.text, after: right.text }
}

/** Stage one row (both paths of a rename) with literal pathspecs. */
export async function addRow(git, entry, { signal } = {}) {
  const paths = entry.oldPath === undefined ? [entry.path] : [entry.oldPath, entry.path]
  const result = await git.run(writeArgs('--literal-pathspecs', 'add', '-A', '--', ...paths), { signal })
  if (result.code !== 0) throw classifyFailure(result)
}

/** Remove one row from the index without touching the worktree. */
export async function unstageRow(git, entry, { unborn = false, signal } = {}) {
  const paths = entry.oldPath === undefined ? [entry.path] : [entry.oldPath, entry.path]
  const result = unborn
    ? await git.run(writeArgs('--literal-pathspecs', 'rm', '--cached', '--quiet', '--', ...paths), { signal })
    : await git.run(writeArgs('--literal-pathspecs', 'restore', '--staged', '--', ...paths), { signal })
  if (result.code !== 0) throw classifyFailure(result)
}

/**
 * Commit exactly the index.
 *
 * A commit is the one Git command that can execute programs from the
 * repository (hooks, and a signing helper through configuration), so hooks are
 * redirected to an empty directory and signing is off. `-F -` passes the
 * message on stdin: no temporary message file, no shell quoting.
 */
export async function commitIndex(git, message, { signal } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dsh-ide-hooks-'))
  try {
    const result = await git.run(
      [
        '-c',
        `core.hooksPath=${dir}`,
        '-c',
        'commit.gpgsign=false',
        '-c',
        'core.fsmonitor=false',
        'commit',
        '--no-verify',
        '--quiet',
        '-F',
        '-',
      ],
      { input: message, signal, timeoutMs: 60000 },
    )
    if (result.code !== 0) {
      const messageText = `${result.stderr}\n${result.stdout.toString('utf8')}`
      if (/Please tell me who you are|Author identity unknown|unable to auto-detect email|empty ident/i.test(messageText)) {
        throw new ScmError('identity', 'Git не знает автора: задайте user.name и user.email в конфигурации Git.')
      }
      if (/nothing to commit|no changes added to commit/i.test(messageText)) {
        throw new ScmError('nothing-staged', 'В индексе нет изменений — фиксировать нечего.')
      }
      throw classifyFailure(result)
    }
    const head = await git.run(readArgs('rev-parse', 'HEAD'), { signal })
    return { head: head.code === 0 ? text(head.stdout).trim() : '' }
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

/**
 * Branch operations are the only place besides commit where Git can run a
 * repository program: `switch` fires post-checkout. The hook path is redirected
 * to an empty directory for the duration of the call, and the name is checked
 * before it reaches argv.
 */
const BRANCH_BAD_CHARS = /[\u0000-\u0020~^:?*\[\\]/

export function branchName(value) {
  if (typeof value !== 'string') throw new ScmError('bad-request', 'Не указано имя ветки.')
  const name = value.trim()
  if (
    name === '' ||
    name.length > 200 ||
    name.startsWith('-') ||
    name.endsWith('.') ||
    name.endsWith('/') ||
    name.includes('..') ||
    name.includes('@{') ||
    name.includes('//') ||
    BRANCH_BAD_CHARS.test(name)
  ) {
    throw new ScmError('bad-request', 'Недопустимое имя ветки.')
  }
  return name
}

async function checkedBranchName(git, value, signal) {
  const name = branchName(value)
  const result = await git.run(readArgs('check-ref-format', `refs/heads/${name}`), { signal })
  if (result.code !== 0) throw new ScmError('bad-request', 'Недопустимое имя ветки.')
  return name
}

export async function currentBranch(git, { signal } = {}) {
  const result = await git.run(readArgs('branch', '--show-current'), { signal })
  if (result.code !== 0) throw classifyFailure(result)
  return text(result.stdout).trim()
}

export async function listBranches(git, { signal } = {}) {
  const result = await git.run(
    readArgs('for-each-ref', '--format=%(refname:short)%00%(objectname)%00%(subject)', 'refs/heads'),
    { signal },
  )
  if (result.code !== 0) throw classifyFailure(result)
  const current = await currentBranch(git, { signal })
  const branches = []
  for (const line of text(result.stdout).split(/\r?\n/)) {
    if (line === '') continue
    const [name, oid, subject] = line.split('\0')
    if (typeof name !== 'string' || name === '') continue
    branches.push({ name, oid: oid ?? '', subject: subject ?? '' })
  }
  branches.sort((left, right) => left.name.localeCompare(right.name))
  if (current !== '' && !branches.some((branch) => branch.name === current)) {
    branches.unshift({ name: current, oid: '', subject: '', unborn: true })
  }
  for (const branch of branches) branch.current = branch.name === current
  return { current, detached: current === '', branches }
}

function branchFailure(result) {
  const message = `${result.stderr}\n${result.stdout.toString('utf8')}`
  if (/already exists/i.test(message)) {
    return new ScmError('branch-exists', 'Ветка с таким именем уже есть.')
  }
  if (/not fully merged/i.test(message)) {
    return new ScmError('branch-unmerged', 'В ветке есть невлитые коммиты — удалить её безопасно нельзя.')
  }
  if (/checked out at|cannot delete branch .* checked out/i.test(message)) {
    return new ScmError('branch-current', 'Текущую ветку удалить нельзя.')
  }
  if (/would be overwritten|Please commit your changes or stash|local changes/i.test(message)) {
    return new ScmError('switch-conflict', 'Несохранённые изменения мешают переключению ветки.')
  }
  if (/not found|did not match any file\(s\) known to git|unknown revision|invalid reference/i.test(message)) {
    return new ScmError('not-found', 'Ветка не найдена.')
  }
  return classifyFailure(result)
}

async function switchWithNoHooks(git, args, { signal } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dsh-ide-hooks-'))
  try {
    const result = await git.run(['-c', `core.hooksPath=${dir}`, ...writeArgs('switch', ...args)], { signal })
    if (result.code !== 0) throw branchFailure(result)
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

/** Create and switch in one step, like the branch action in an IDE. */
export async function createBranch(git, value, { signal } = {}) {
  const name = await checkedBranchName(git, value, signal)
  await switchWithNoHooks(git, ['-c', name], { signal })
  return { name }
}

export async function switchBranch(git, value, { signal } = {}) {
  const name = await checkedBranchName(git, value, signal)
  await switchWithNoHooks(git, ['--no-guess', name], { signal })
  return { name }
}

/** `-d` refuses unmerged work; there is no force delete in the panel. */
export async function deleteBranch(git, value, { signal } = {}) {
  const name = branchName(value)
  const current = await currentBranch(git, { signal })
  if (name === current) throw new ScmError('branch-current', 'Текущую ветку удалить нельзя.')
  const result = await git.run(writeArgs('branch', '-d', name), { signal })
  if (result.code !== 0) throw branchFailure(result)
  return { name }
}

/** Ref OIDs pinned by an explicit `git for-each-ref`, no network. */
export async function listVertices(git, { signal } = {}) {
  const result = await git.run(readArgs('for-each-ref', '--format=%(objectname)', 'refs/heads', 'refs/remotes'), { signal })
  if (result.code !== 0) throw classifyFailure(result)
  const vertices = []
  for (const line of text(result.stdout).split(/\r?\n/)) {
    const oid = line.trim()
    if (/^[0-9a-f]{40,64}$/.test(oid) && !vertices.includes(oid)) vertices.push(oid)
  }
  const head = await git.run(readArgs('rev-parse', 'HEAD'), { signal })
  if (head.code === 0) {
    const oid = text(head.stdout).trim()
    if (/^[0-9a-f]{40,64}$/.test(oid) && !vertices.includes(oid)) vertices.unshift(oid)
  }
  return vertices
}

/**
 * One page of `git log --topo-order`. Fields are NUL-separated fixed columns;
 * decorations come from `%D`, never from parsing the pretty graph.
 */
export async function loadHistoryPage(git, { cursor, pageSize = HISTORY_PAGE, signal } = {}) {
  const vertices = await listVertices(git, { signal })
  if (vertices.length === 0) return { commits: [], nextCursor: null, unborn: true, vertices }
  if (cursor !== undefined && cursor !== null) {
    if (JSON.stringify(cursor.vertices) !== JSON.stringify(vertices)) {
      throw new ScmError('history-stale', 'Ветки изменились — граф начнётся заново.')
    }
  }
  const skip = cursor === undefined || cursor === null ? 0 : Math.max(0, Number(cursor.skip) || 0)
  const result = await git.run(
    readArgs(
      'log',
      '--topo-order',
      '--no-show-signature',
      '-n',
      String(pageSize + 1),
      '--skip',
      String(skip),
      // One record per commit, fields NUL-separated, records separated by RS.
      // A NUL pair would be ambiguous: an empty parent list already produces
      // two consecutive NULs.
      '--format=%H%x00%P%x00%an%x00%at%x00%D%x00%s%x1e',
      ...vertices,
      '--',
    ),
    { signal, maxBytes: MAX_STATUS_BYTES },
  )
  if (result.code !== 0) throw classifyFailure(result)
  const commits = []
  for (const record of result.stdout.toString('utf8').split('\x1e')) {
    if (record.trim() === '') continue
    const fields = record.replace(/^\r?\n/, '').split('\0')
    if (fields.length < 6) continue
    const [oid, parents, author, at, decorations, subject] = fields
    commits.push({
      oid,
      parents: parents === '' ? [] : parents.split(' '),
      author,
      time: Number(at) || 0,
      subject,
      refs: decorations === '' ? [] : decorations.split(', ').map((ref) => ref.trim()).filter((ref) => ref !== ''),
    })
  }
  const page = commits.slice(0, pageSize)
  const nextCursor = commits.length > pageSize ? { skip: skip + pageSize, vertices } : null
  return { commits: page, nextCursor, unborn: false, vertices }
}

function assertOid(value) {
  const oid = String(value ?? '')
  if (!/^[0-9a-f]{40,64}$/.test(oid)) throw new ScmError('bad-request', 'Не указан коммит.')
  return oid
}

/** Parents of one commit, first parent first. */
export async function commitParents(git, oid, { signal } = {}) {
  const result = await git.run(readArgs('rev-list', '--parents', '-n', '1', assertOid(oid)), { signal })
  if (result.code !== 0) throw new ScmError('not-found', 'Коммит не найден в этой истории.')
  const fields = text(result.stdout).trim().split(' ')
  if (fields[0] === '') throw new ScmError('not-found', 'Коммит не найден в этой истории.')
  return fields.slice(1).filter((field) => /^[0-9a-f]{40,64}$/.test(field))
}

/**
 * Paths changed by one commit against one of its parents. Only OIDs already
 * shown in the graph are accepted, and only paths from this listing can be
 * opened, so the browser cannot turn the route into an arbitrary tree walk.
 */
export async function loadCommitFiles(git, { oid, base, signal } = {}) {
  const commit = assertOid(oid)
  const parents = await commitParents(git, commit, { signal })
  if (parents.length === 0) {
    const rootResult = await git.run(
      readArgs('diff-tree', '--root', '-r', '-z', '-M', '--name-status', '--no-commit-id', commit),
      { signal, maxBytes: MAX_STATUS_BYTES },
    )
    if (rootResult.code !== 0) throw classifyFailure(rootResult)
    return { oid: commit, parents, base: '', entries: parseNameStatus(rootResult.stdout) }
  }
  const selected = base === undefined || base === null || base === '' ? parents[0] : assertOid(base)
  if (!parents.includes(selected)) throw new ScmError('bad-request', 'Этот родитель не относится к выбранному коммиту.')
  const result = await git.run(
    readArgs('diff-tree', '-r', '-z', '-M', '--name-status', selected, commit),
    { signal, maxBytes: MAX_STATUS_BYTES },
  )
  if (result.code !== 0) throw classifyFailure(result)
  return { oid: commit, parents, base: selected, entries: parseNameStatus(result.stdout) }
}

/**
 * Parse `--name-status -z`. Git emits the status, then the path (old path then
 * new path for a rename); a path may contain spaces, so only NUL is a boundary.
 */
export function parseNameStatus(stdout) {
  const chunks = stdout.toString('utf8').split('\0')
  const entries = []
  let index = 0
  while (index < chunks.length) {
    let status = chunks[index].trim()
    index += 1
    if (status === '') continue
    let path = ''
    let oldPath
    if (status.includes('\t')) {
      const tab = status.indexOf('\t')
      path = status.slice(tab + 1)
      status = status.slice(0, tab)
    } else {
      path = chunks[index] ?? ''
      index += 1
    }
    if (/^[RC]/.test(status)) {
      oldPath = path
      path = chunks[index] ?? ''
      index += 1
    }
    entries.push({
      path,
      ...(oldPath === undefined ? {} : { oldPath }),
      status: status[0] ?? '?',
      kind: kindFromLetter(status[0]),
    })
  }
  return entries.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
}

function kindFromLetter(letter) {
  if (letter === 'A') return 'added'
  if (letter === 'D') return 'deleted'
  if (letter === 'M') return 'modified'
  if (letter === 'R') return 'renamed'
  if (letter === 'C') return 'copied'
  if (letter === 'T') return 'typechanged'
  if (letter === 'U') return 'conflict'
  return 'unknown'
}

/** Historical two-sided view: parent tree → commit tree, never the worktree. */
export async function loadCommitDiff(git, { oid, path: target, base, maxBytes = MAX_DIFF_BYTES, signal } = {}) {
  const files = await loadCommitFiles(git, { oid, base, signal })
  const entry = files.entries.find((candidate) => candidate.path === target)
  if (entry === undefined) throw new ScmError('not-found', 'Этого файла нет в выбранном коммите.')
  const oldPath = entry.oldPath ?? target
  const before = files.base === '' ? { kind: 'missing' } : await treeBlob(git, files.base, oldPath, { maxBytes, signal })
  const after = await treeBlob(git, files.oid, target, { maxBytes, signal })
  const left = sideOf(before, maxBytes)
  const right = sideOf(after, maxBytes)
  const result = {
    group: 'commit',
    path: target,
    oid: files.oid,
    base: files.base,
    when: 'commit',
    beforeLabel: files.base === '' ? 'Пусто' : `${files.base.slice(0, 7)} (родитель)`,
    afterLabel: `${files.oid.slice(0, 7)} (коммит)`,
    canOpen: false,
  }
  if (left.kind === 'too-large' || right.kind === 'too-large') {
    return { ...result, kind: 'too-large', message: 'Слишком большой файл для сравнения.' }
  }
  if (left.kind === 'binary' || right.kind === 'binary') {
    return { ...result, kind: 'binary', message: 'Двоичный файл или подмодуль: текстовое сравнение недоступно.' }
  }
  if (left.kind === 'encoding' || right.kind === 'encoding') {
    return { ...result, kind: 'encoding', message: 'Файл не является текстом UTF-8.' }
  }
  return { ...result, kind: 'text', before: left.text, after: right.text }
}
