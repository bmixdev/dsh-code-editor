/**
 * File outline: named structure of one document — classes, functions, methods,
 * headings, CSS rules — as a nested tree of `{name, kind, line, endLine, children}`.
 *
 * The client keeps the live Monaco buffer, so the outline request carries the
 * current text and this module needs no filesystem access. The language comes
 * from the extension. The scanner is deliberately pragmatic: strings, comments,
 * templates and regex bodies are masked first, then brace depth (C family) or
 * indentation (Python) decides nesting — an exact syntax tree is a compiler's
 * job, an outline only needs the rows a human would click.
 */

/** Deepest nesting the parser tracks; guards runaway generated code. */
const MAX_DEPTH = 24
const MAX_SYMBOLS = 4000

const EXTENSIONS = new Map([
  ['js', 'javascript'], ['mjs', 'javascript'], ['cjs', 'javascript'], ['jsx', 'javascript'],
  ['ts', 'typescript'], ['tsx', 'typescript'], ['mts', 'typescript'], ['cts', 'typescript'],
  ['py', 'python'],
  ['md', 'markdown'], ['markdown', 'markdown'],
  ['css', 'css'], ['scss', 'css'], ['less', 'css'],
])

export function languageOf(path) {
  if (typeof path !== 'string') return ''
  const dot = path.lastIndexOf('.')
  if (dot < 0) return ''
  return EXTENSIONS.get(path.slice(dot + 1).toLowerCase()) ?? ''
}

export function outlineOf(path, text) {
  const language = languageOf(path)
  if (language === '' || typeof text !== 'string' || text === '') return { language, symbols: [] }
  const rawLines = text.split(/\r\n|\r|\n/)
  const symbols =
    language === 'python'
      ? parseIndent(maskPython(text), rawLines)
      : language === 'markdown'
        ? parseMarkdown(rawLines)
        : parseBraces(maskC(text), language === 'css' ? CSS_MATCHERS : JS_MATCHERS, rawLines, language !== 'css')
  return { language, symbols }
}

// ------------------------------------------------------- attached comments

const COMMENT_CAP = 120

function capComment(text) {
  const clean = text.replace(/\s+/g, ' ').trim()
  return clean.length > COMMENT_CAP ? `${clean.slice(0, COMMENT_CAP - 1)}…` : clean
}

/** First line of the comment block attached directly above the definition (C family). */
function commentAbove(rawLines, defIndex0) {
  if (defIndex0 < 1) return ''
  const line = rawLines[defIndex0 - 1].trim()
  if (line.startsWith('//')) return capComment(line.slice(2))
  if (line.endsWith('*/')) {
    // Multi-line block comment: the attached text is its first content line.
    let opener = defIndex0 - 1
    while (opener >= 0 && !rawLines[opener].includes('/*')) opener -= 1
    if (opener < 0) return ''
    const head = rawLines[opener].trim()
    const after = head.slice(head.indexOf('/*') + 2).replace(/\*\/\s*$/, '').replace(/\*+\s*$/, '').trim()
    if (after !== '') return capComment(after)
    return opener + 1 < defIndex0 ? capComment(rawLines[opener + 1].trim().replace(/^\*+\s*/, '').replace(/\*\/\s*$/, '')) : ''
  }
  return ''
}

/** Python: the docstring of the definition, else a `#` comment line above it. */
function pythonComment(rawLines, defIndex0, defIndent) {
  let at = defIndex0 + 1
  while (at < rawLines.length && rawLines[at].trim() === '') at += 1
  if (at < rawLines.length) {
    const body = rawLines[at]
    const indent = (body.match(/^[ \t]*/)[0] ?? '').replace(/\t/g, '    ').length
    if (indent > defIndent) {
      const trimmed = body.trim()
      for (const q of ['"""', "'''"]) {
        if (!trimmed.startsWith(q)) continue
        const rest = trimmed.slice(3)
        const endAt = rest.indexOf(q)
        const first = endAt >= 0 ? rest.slice(0, endAt) : rest
        if (first.trim() !== '') return capComment(first)
        let next = at + 1
        while (next < rawLines.length && rawLines[next].trim() === '') next += 1
        if (next < rawLines.length) {
          const text = rawLines[next].trim().replace(new RegExp(`${q}$`), '').trim()
          if (text !== '') return capComment(text)
        }
        return ''
      }
    }
  }
  if (defIndex0 > 0) {
    const above = rawLines[defIndex0 - 1].trim()
    if (above.startsWith('#')) return capComment(above.replace(/^#+\s*/, ''))
  }
  return ''
}

function makeNode(name, kind, line) {
  return { name, kind, line, endLine: line, children: [] }
}

// ------------------------------------------------------------------ masking

/** Blank out strings, comments, templates and regex bodies, keeping the line structure. */
function maskC(source) {
  const out = source.split('')
  let mode = 'code'
  let quote = ''
  let prevChar = ''
  let prevWord = ''
  // Template interpolation: the `${` brace stays in the output (so brace depth
  // counting sees a balanced pair) and the mode machine only tracks the count.
  const interpolations = []
  const isWord = (ch) => (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9') || ch === '_' || ch === '$'
  const regexAllowed = () =>
    prevChar === '' ||
    '([{=,;:!&|?+-*%~^<>'.includes(prevChar) ||
    /^(?:return|case|typeof|instanceof|in|of|new|delete|void|yield|await|do|else)$/.test(prevWord)
  let i = 0
  while (i < out.length) {
    const ch = out[i]
    const next = out[i + 1] ?? ''
    if (mode === 'code') {
      if (ch === '/' && next === '/') { out[i] = ' '; out[i + 1] = ' '; i += 2; mode = 'line'; continue }
      if (ch === '/' && next === '*') { out[i] = ' '; out[i + 1] = ' '; i += 2; mode = 'block'; continue }
      if (ch === '"' || ch === "'" || ch === '`') { quote = ch; mode = ch === '`' ? 'template' : 'string'; i += 1; continue }
      if (ch === '/' && regexAllowed()) { mode = 'regex'; i += 1; continue }
      if (isWord(ch)) prevWord += ch
      else prevWord = ''
      if (ch !== ' ' && ch !== '\t' && ch !== '\n' && ch !== '\r') prevChar = ch
      if (interpolations.length > 0) {
        if (ch === '{') interpolations[interpolations.length - 1] += 1
        else if (ch === '}') {
          interpolations[interpolations.length - 1] -= 1
          if (interpolations[interpolations.length - 1] === 0) {
            interpolations.pop()
            mode = 'template'
          }
        }
      }
      i += 1
      continue
    }
    if (mode === 'line') {
      if (ch === '\n') mode = 'code'
      else out[i] = ' '
      i += 1
      continue
    }
    if (mode === 'block') {
      if (ch === '*' && next === '/') { out[i] = ' '; out[i + 1] = ' '; i += 2; mode = 'code'; continue }
      if (ch !== '\n') out[i] = ' '
      i += 1
      continue
    }
    if (mode === 'string' || mode === 'template') {
      if (ch === '\\') { out[i] = ' '; out[i + 1] = ' '; i += 2; continue }
      if (mode === 'template' && ch === '$' && next === '{') { interpolations.push(1); mode = 'code'; i += 2; continue }
      if (ch === quote || (mode === 'string' && ch === '\n')) { mode = 'code'; i += 1; continue }
      out[i] = ch === '\n' ? '\n' : ' '
      i += 1
      continue
    }
    // Regex body: content is masked, an unterminated one stops at the line end.
    if (ch === '\\') { out[i] = ' '; out[i + 1] = ' '; i += 2; continue }
    if (ch === '/' || ch === '\n') { mode = 'code'; i += 1; continue }
    out[i] = ' '
    i += 1
  }
  return out.join('')
}

/** Blank out comments and string bodies, keeping the line structure. */
function maskPython(source) {
  const out = source.split('')
  let mode = 'code'
  let quote = ''
  let i = 0
  while (i < out.length) {
    const ch = out[i]
    const next = out[i + 1] ?? ''
    if (mode === 'code') {
      if (ch === '#') { out[i] = ' '; mode = 'line'; i += 1; continue }
      if (ch === '"' || ch === "'") {
        if (next === ch && out[i + 2] === ch) {
          quote = ch
          out[i] = ' '; out[i + 1] = ' '; out[i + 2] = ' '
          i += 3
          mode = 'block'
          continue
        }
        quote = ch
        mode = 'string'
        i += 1
        continue
      }
      i += 1
      continue
    }
    if (mode === 'line') {
      if (ch === '\n') mode = 'code'
      else out[i] = ' '
      i += 1
      continue
    }
    if (mode === 'string') {
      if (ch === '\\') { out[i] = ' '; out[i + 1] = ' '; i += 2; continue }
      if (ch === quote || ch === '\n') { mode = 'code'; i += 1; continue }
      out[i] = ' '
      i += 1
      continue
    }
    // Triple-quoted string, may span lines.
    if (ch === '\\') { out[i] = ' '; out[i + 1] = ' '; i += 2; continue }
    if (ch === quote && next === quote && out[i + 2] === quote) {
      out[i] = ' '; out[i + 1] = ' '; out[i + 2] = ' '
      i += 3
      mode = 'code'
      continue
    }
    if (ch !== '\n') out[i] = ' '
    i += 1
  }
  return out.join('')
}

// ------------------------------------------------------------------ parsers

function parseBraces(masked, matchers, rawLines, withComments) {
  const lines = masked.split('\n')
  const roots = []
  const stack = []
  let depth = 0
  let count = 0
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]
    if (stack.length < MAX_DEPTH && count < MAX_SYMBOLS) {
      for (const matcher of matchers) {
        const match = matcher.re.exec(line)
        if (match === null) continue
        const name = match[1]
        if (typeof name !== 'string' || name === '') continue
        if (matcher.when !== undefined && matcher.when(stack) === false) continue
        const parent = stack.length > 0 ? stack[stack.length - 1].node : undefined
        const node = makeNode(name, matcher.kindOf === undefined ? matcher.kind : matcher.kindOf(match), index + 1)
        if (withComments === true) {
          const comment = commentAbove(rawLines, index)
          if (comment !== '') node.comment = comment
        }
        ;(parent === undefined ? roots : parent.children).push(node)
        count += 1
        stack.push({ node, depth })
        break
      }
    }
    for (const ch of line) {
      if (ch === '{') depth += 1
      else if (ch === '}' && depth > 0) depth -= 1
    }
    while (stack.length > 0 && stack[stack.length - 1].depth >= depth) stack.pop().node.endLine = index + 1
  }
  return roots
}

function parseIndent(masked, rawLines) {
  const lines = masked.split('\n')
  const roots = []
  const stack = []
  let count = 0
  let lastContent = -1
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]
    if (line.trim() === '') continue
    lastContent = index
    const indent = (line.match(/^[ \t]*/)[0] ?? '').replace(/\t/g, '    ').length
    while (stack.length > 0 && stack[stack.length - 1].indent >= indent) stack.pop().node.endLine = index
    if (stack.length >= MAX_DEPTH || count >= MAX_SYMBOLS) continue
    const classMatch = /^\s*class\s+([A-Za-z_]\w*)/.exec(line)
    const defMatch = classMatch === null ? /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/.exec(line) : null
    if (classMatch === null && defMatch === null) continue
    const parent = stack.length > 0 ? stack[stack.length - 1].node : undefined
    const kind = classMatch !== null || parent === undefined || parent.kind !== 'class' ? 'function' : 'method'
    const node = makeNode(classMatch !== null ? classMatch[1] : defMatch[1], classMatch !== null ? 'class' : kind, index + 1)
    const comment = pythonComment(rawLines, index, indent)
    if (comment !== '') node.comment = comment
    ;(parent === undefined ? roots : parent.children).push(node)
    count += 1
    stack.push({ node, indent })
  }
  for (const entry of stack) entry.node.endLine = lastContent + 1
  return roots
}

function parseMarkdown(lines) {
  const roots = []
  const stack = []
  let count = 0
  for (let index = 0; index < lines.length; index++) {
    const match = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(lines[index])
    if (match === null) continue
    if (count >= MAX_SYMBOLS) return roots
    const node = makeNode(match[2], 'heading', index + 1)
    const level = match[1].length
    while (stack.length > 0 && stack[stack.length - 1].level >= level) stack.pop()
    const parent = stack.length > 0 ? stack[stack.length - 1].node : undefined
    ;(parent === undefined ? roots : parent.children).push(node)
    count += 1
    stack.push({ node, level })
  }
  return roots
}

const JS_MATCHERS = [
  { kind: 'class', re: /^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/ },
  { kind: 'interface', re: /^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?interface\s+([A-Za-z_$][\w$]*)/ },
  { kind: 'interface', re: /^\s*(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*=\s*\{/ },
  {
    kind: 'function',
    re: /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/,
  },
  {
    kind: 'function',
    re: /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/,
  },
  {
    // Class property holding an arrow function.
    kind: 'method',
    re: /^\s*([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/,
    when: (stack) => stack.length > 0 && stack[stack.length - 1].node.kind === 'class',
  },
  {
    kind: 'method',
    // `if`/`for`/`switch`/`catch` also look like `name(…)`; keep them out.
    re: /^\s*(?:(?:static|get|set|async|\*)\s+)*(?!if\b|for\b|while\b|switch\b|catch\b|do\b|return\b|else\b)([A-Za-z_$][\w$]*)\s*\(/,
    when: (stack) => stack.length > 0 && stack[stack.length - 1].node.kind === 'class',
  },
]

const CSS_MATCHERS = [
  {
    kind: 'rule',
    kindOf: (match) => (match[1].startsWith('@') ? 'atrule' : 'rule'),
    re: /^[ \t]*([^{};\s][^{};]*?)\s*\{/,
  },
]
