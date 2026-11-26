/**
 * Project instruction files for one open document.
 *
 * Rules are discovered, not invented: every directory from the workspace root
 * down to the file's folder may carry `AGENTS.md`, `CLAUDE.md`, `.cursorrules`
 * or `.cursor/rules/*.mdc`. The chain is returned in that order so a nested
 * rule visibly overrides its parent. Discovery is local and cheap; only the
 * explicitly applied subset ever reaches a model, and only for Inline Edit.
 *
 * Deliberately absent: globs, front-matter activation, remote rule packs and
 * any implicit application to chat or Tab — those need a policy the local
 * plugin cannot verify.
 */
import { lstat, readFile, readdir } from 'node:fs/promises'
import path from 'node:path'

/** Names checked in every directory of the chain, in listing order. */
export const RULE_NAMES = ['AGENTS.md', 'CLAUDE.md', '.cursorrules']
/** One rule file larger than this is listed but never applied. */
export const MAX_RULE_BYTES = 32 * 1024
/** Combined size of applied rule text in one Inline Edit request. */
export const MAX_RULES_TOTAL = 64 * 1024
/** Hard ceiling on listed rules, so a pathological tree cannot flood the panel. */
export const MAX_RULES = 16

const fail = (code, message) => Object.assign(new Error(message), { code })

const posix = (value) => value.split(path.sep).join('/')

/** True when `child` is `parent` or lives below it, by path segments. */
function within(parent, child) {
  const relative = path.relative(parent, child)
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}

/** Collect the directories from the workspace root to the file's folder. */
function chain(root, file) {
  const dirs = []
  let current = path.dirname(file)
  while (within(root, current)) {
    dirs.unshift(current)
    if (current === root) break
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
  return dirs
}

/** List the `.mdc` files of one `.cursor/rules` folder, sorted by name. */
async function cursorRules(directory) {
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch {
    return []
  }
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.mdc'))
    .map((entry) => path.join(directory, entry.name))
    .sort()
}

/**
 * Discover the rule chain for `target` inside `root`.
 *
 * Missing or unreadable files are skipped silently: a rule is an optional
 * hint, and one bad file must not hide the rest of the chain. A file that is
 * not regular (a directory, a symlink, a socket) is skipped for the same
 * reason. Binary files are skipped rather than rendered as replacement text.
 */
export async function discoverRules({ root, target }) {
  const top = path.resolve(root)
  const file = path.resolve(target)
  if (!within(top, file) || file === top) {
    throw fail('bad-request', 'Файл вне рабочей папки — правила недоступны.')
  }
  const rules = []
  let truncated = false
  for (const directory of chain(top, file)) {
    const candidates = RULE_NAMES.map((name) => path.join(directory, name))
    for (const candidate of await cursorRules(path.join(directory, '.cursor', 'rules'))) {
      candidates.push(candidate)
    }
    for (const candidate of candidates) {
      let info
      try {
        info = await lstat(candidate)
      } catch {
        continue
      }
      if (!info.isFile()) continue
      if (rules.length >= MAX_RULES) {
        truncated = true
        break
      }
      let buffer
      try {
        buffer = await readFile(candidate)
      } catch {
        continue
      }
      if (buffer.includes(0)) continue
      const bytes = buffer.length
      const oversized = bytes > MAX_RULE_BYTES
      const text = buffer.subarray(0, MAX_RULE_BYTES).toString('utf8')
      rules.push({
        path: posix(path.relative(top, candidate)),
        dir: posix(path.relative(top, path.dirname(candidate))) || '.',
        name: path.basename(candidate),
        bytes,
        oversized,
        text,
      })
    }
    if (truncated) break
  }
  return { file: posix(path.relative(top, file)), rules, truncated }
}

/**
 * Mark which discovered rules actually fit the request. The decision is
 * deterministic and uses the same budget as `rulePrompt`, so the panel cannot
 * claim a rule is applied when the model never saw it.
 */
export function chooseRules(rules, { budget = MAX_RULES_TOTAL } = {}) {
  let used = 0
  return rules.map((rule) => {
    if (rule.oversized) return { ...rule, applied: false, reason: 'size', text: '' }
    if (used + rule.bytes > budget) return { ...rule, applied: false, reason: 'limit', text: '' }
    used += rule.bytes
    return { ...rule, applied: true, reason: '', text: rule.text }
  })
}

/** Render applied rules as a system-prompt appendix. */
export function rulePrompt(rules) {
  const applied = rules.filter((rule) => rule.applied)
  if (applied.length === 0) return ''
  const parts = applied.map((rule) => `### ${rule.path}\n${rule.text.trim()}`)
  return [
    'Правила проекта. Соблюдай их в этой правке; более глубокий файл уточняет верхний.',
    '',
    ...parts,
  ].join('\n')
}
