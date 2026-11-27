// Two scopes, matching the reference editor's convention:
// `.dshideignore`          — never send these files to a model;
// `.dshideindexingignore`  — keep them out of content search, but an explicit
//                            action on the file is still allowed.
import { readFile } from 'node:fs/promises'
import path from 'node:path'

export const IGNORE_FILES = ['.dshideignore', '.dshideindexingignore']
export const MAX_IGNORE_BYTES = 64 * 1024

function escape(value) {
  return value.replace(/[.+^${}()|[\]\\]/g, '\\$&')
}

function globSource(glob) {
  let source = ''
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index]
    if (char === '*') {
      if (glob[index + 1] === '*') {
        index += 1
        if (glob[index + 1] === '/') {
          index += 1
          source += '(?:.*/)?'
        } else {
          source += '.*'
        }
      } else {
        source += '[^/]*'
      }
      continue
    }
    if (char === '?') {
      source += '[^/]'
      continue
    }
    source += escape(char)
  }
  return source
}

function globRegExp(glob, anchored) {
  const source = globSource(glob)
  // A pattern without a slash matches a basename at any depth; everything
  // else is relative to the workspace root, unless it starts with `**/`.
  return glob.includes('/')
    ? new RegExp(`^${source}$`)
    : new RegExp(`${anchored ? '^' : '(?:^|.*/)'}${source}$`)
}

/** Gitignore-like subset: comments, `!` negation, trailing `/`, leading `/`. */
export function parseIgnore(text) {
  const patterns = []
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    let body = line
    let negate = false
    if (body.startsWith('!')) {
      negate = true
      body = body.slice(1).trim()
    }
    if (body === '') continue
    const directory = body.endsWith('/')
    if (directory) body = body.slice(0, -1)
    const anchored = body.startsWith('/')
    if (anchored) body = body.slice(1)
    if (body === '') continue
    patterns.push({ negate, directory, anchored, glob: body })
  }
  return patterns
}

function matches(rule, relative, isDirectory) {
  const parts = relative.split('/')
  // Test the path and every ancestor: a rule for a directory also covers its
  // contents, and a file named like a directory pattern stays untouched.
  for (let depth = parts.length; depth >= 1; depth -= 1) {
    const candidate = parts.slice(0, depth).join('/')
    const candidateIsDirectory = depth < parts.length || isDirectory
    if (rule.directory && !candidateIsDirectory) continue
    if (rule.expression.test(candidate)) return true
  }
  return false
}

export function compileIgnore(patterns) {
  const rules = patterns.map((pattern) => ({
    ...pattern,
    expression: globRegExp(pattern.glob, pattern.anchored),
  }))
  return function ignored(relative, isDirectory = false) {
    const target = String(relative ?? '').split(path.sep).join('/').replace(/^\.\//, '')
    if (target === '') return false
    let result = false
    for (const rule of rules) {
      if (matches(rule, target, isDirectory)) result = !rule.negate
    }
    return result
  }
}

async function readIgnore(file) {
  try {
    const buffer = await readFile(file)
    return buffer.subarray(0, MAX_IGNORE_BYTES).toString('utf8')
  } catch {
    return ''
  }
}

/**
 * Reads both files from the workspace root. `blocked` covers `.dshideignore`
 * only; `skipped` adds `.dshideindexingignore` for content search.
 */
export async function loadIgnore(root) {
  const base = path.resolve(String(root))
  const [blockedText, skippedText] = await Promise.all([
    readIgnore(path.join(base, '.dshideignore')),
    readIgnore(path.join(base, '.dshideindexingignore')),
  ])
  const blocked = compileIgnore(parseIgnore(blockedText))
  const indexed = compileIgnore(parseIgnore(skippedText))
  return {
    blocked,
    skipped: (relative, isDirectory = false) => blocked(relative, isDirectory) || indexed(relative, isDirectory),
  }
}

/** The workspace-relative posix path used by both matchers. */
export function relativePath(root, target) {
  return path.relative(path.resolve(String(root)), path.resolve(String(target))).split(path.sep).join('/')
}
