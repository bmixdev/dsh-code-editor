import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { searchText } from '../search.js'

/** The Host's file service, reduced to what `searchText` actually uses. */
function fakeContext() {
  return {
    fs: {
      resolve: async (target) => path.resolve(String(target)),
      processPath: (target) => String(target),
      contains: (root, target) => {
        const prefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`
        return target === root || target.startsWith(prefix)
      },
    },
  }
}

async function workspace(files) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-ide-search-'))
  for (const [relative, content] of Object.entries(files)) {
    const absolute = path.join(root, relative)
    await mkdir(path.dirname(absolute), { recursive: true })
    await writeFile(absolute, content)
  }
  return root
}

test('finds literal matches with 1-based line and column', async () => {
  const root = await workspace({
    'main.ts': 'export const x = 1\nexport const needle = 2\n',
  })
  try {
    const result = await searchText(fakeContext(), { cwd: root, query: 'needle' })
    assert.equal(result.matches.length, 1)
    assert.deepEqual(
      { path: result.matches[0].path, line: result.matches[0].line, column: result.matches[0].column },
      { path: 'main.ts', line: 2, column: 14 },
    )
    assert.equal(result.truncated, false)
    assert.equal(result.scanned, 1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('is case-insensitive by default and can be exact on request', async () => {
  const root = await workspace({ 'a.ts': 'const Needle = 1\n' })
  try {
    const loose = await searchText(fakeContext(), { cwd: root, query: 'needle' })
    assert.equal(loose.matches.length, 1)
    assert.equal(loose.matches[0].match, 'Needle')
    const exact = await searchText(fakeContext(), { cwd: root, query: 'needle', ignoreCase: false })
    assert.equal(exact.matches.length, 0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('skips node_modules, hidden folders and binary files', async () => {
  const root = await workspace({
    'src/a.ts': 'needle\n',
    'node_modules/pkg/index.js': 'needle\n',
    '.git/config': 'needle\n',
    '.hidden/x.ts': 'needle\n',
    'bin.dat': 'needle\u0000binary',
  })
  try {
    const result = await searchText(fakeContext(), { cwd: root, query: 'needle' })
    assert.deepEqual(result.matches.map((match) => match.path), ['src/a.ts'])
    const withHidden = await searchText(fakeContext(), { cwd: root, query: 'needle', hidden: true })
    // `.git` stays out even for a hidden-inclusive scan: the tree's skip policy
    // wins over the visibility toggle.
    assert.deepEqual(withHidden.matches.map((match) => match.path).sort(), ['.hidden/x.ts', 'src/a.ts'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('reports truncation instead of a silent empty answer', async () => {
  const root = await workspace({ 'a.ts': 'needle\n'.repeat(10) })
  try {
    const result = await searchText(fakeContext(), { cwd: root, query: 'needle', limit: 3, maxResults: 3 })
    assert.equal(result.matches.length, 3)
    assert.equal(result.truncated, true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('an empty query never walks the workspace', async () => {
  const result = await searchText(fakeContext(), { cwd: 'C:\\definitely-not-a-workspace', query: '   ' })
  assert.deepEqual(result, { matches: [], truncated: false, scanned: 0, bytes: 0 })
})

test('an aborted signal stops the scan with a cancelled error', async () => {
  const root = await workspace({ 'a.ts': 'needle\n' })
  const controller = new AbortController()
  controller.abort()
  try {
    await assert.rejects(
      searchText(fakeContext(), { cwd: root, query: 'needle', signal: controller.signal }),
      (error) => error.code === 'cancelled',
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('the same basename in two folders is distinguishable', async () => {
  const root = await workspace({ 'one/util.ts': 'needle\n', 'two/util.ts': 'needle\n' })
  try {
    const result = await searchText(fakeContext(), { cwd: root, query: 'needle' })
    assert.deepEqual(result.matches.map((match) => match.path).sort(), ['one/util.ts', 'two/util.ts'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('regex mode returns the text it matched, not the pattern width', async () => {
  const root = await workspace({ 'main.ts': 'const total = 42\n' })
  try {
    const result = await searchText(fakeContext(), { cwd: root, query: 'const\\s+\\w+', regex: true })
    assert.equal(result.matches.length, 1)
    assert.deepEqual(
      { line: result.matches[0].line, column: result.matches[0].column, match: result.matches[0].match },
      { line: 1, column: 1, match: 'const total' },
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('regex mode is case-insensitive unless asked otherwise', async () => {
  const root = await workspace({ 'a.ts': 'Needle needle NEEDLE\n' })
  try {
    const loose = await searchText(fakeContext(), { cwd: root, query: 'needle', regex: true })
    assert.equal(loose.matches.length, 3)
    const exact = await searchText(fakeContext(), { cwd: root, query: 'needle', regex: true, ignoreCase: false })
    assert.equal(exact.matches.length, 1)
    assert.equal(exact.matches[0].match, 'needle')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('whole word skips matches inside a larger word', async () => {
  const root = await workspace({ 'a.ts': 'needle needles aneedle needle_1 (needle)\n' })
  try {
    const loose = await searchText(fakeContext(), { cwd: root, query: 'needle' })
    assert.equal(loose.matches.length, 5)
    const whole = await searchText(fakeContext(), { cwd: root, query: 'needle', wholeWord: true })
    assert.deepEqual(whole.matches.map((match) => match.column), [1, 34])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('whole word treats underscores and digits as word characters', async () => {
  const root = await workspace({ 'a.ts': 'needle_1 xneedle2 needle!\n' })
  try {
    const result = await searchText(fakeContext(), { cwd: root, query: 'needle', wholeWord: true })
    assert.deepEqual(result.matches.map((match) => match.column), [19])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('whole word filters a regex match by the text it found', async () => {
  const root = await workspace({ 'a.ts': 'needle needles _needle\n' })
  try {
    const result = await searchText(fakeContext(), {
      cwd: root,
      query: 'needle\\w*',
      regex: true,
      wholeWord: true,
    })
    assert.deepEqual(result.matches.map((match) => match.match), ['needle', 'needles'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('an invalid pattern is refused before the workspace is touched', async () => {
  const missing = path.join(os.tmpdir(), 'dsh-ide-search-missing-workspace')
  await assert.rejects(
    searchText(fakeContext(), { cwd: missing, query: '(', regex: true }),
    (error) => error.code === 'bad-request' && error.message.includes('Некорректное регулярное выражение'),
  )
})

test('a zero-length pattern match is skipped instead of spinning', async () => {
  const root = await workspace({ 'a.ts': 'abc\n' })
  try {
    const empty = await searchText(fakeContext(), { cwd: root, query: 'x*', regex: true })
    assert.deepEqual(empty.matches, [])
    const one = await searchText(fakeContext(), { cwd: root, query: 'a*', regex: true })
    assert.deepEqual(one.matches.map((match) => match.match), ['a'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('regex mode still stops at the result budget', async () => {
  const root = await workspace({ 'a.ts': 'answer\n'.repeat(10) })
  try {
    const result = await searchText(fakeContext(), {
      cwd: root,
      query: 'answer',
      regex: true,
      limit: 3,
      maxResults: 3,
    })
    assert.equal(result.matches.length, 3)
    assert.equal(result.truncated, true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('literal mode keeps regular-expression metacharacters literal', async () => {
  const root = await workspace({ 'a.ts': 'a+b a.b\n' })
  try {
    const literal = await searchText(fakeContext(), { cwd: root, query: 'a.b' })
    assert.deepEqual(literal.matches.map((match) => match.column), [5])
    const pattern = await searchText(fakeContext(), { cwd: root, query: 'a.b', regex: true })
    assert.deepEqual(pattern.matches.map((match) => match.column), [1, 5])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('whole word uses Unicode letters, not only ASCII', async () => {
  const root = await workspace({ 'a.ts': 'тест тесты\n' })
  try {
    const loose = await searchText(fakeContext(), { cwd: root, query: 'тест' })
    assert.equal(loose.matches.length, 2)
    const whole = await searchText(fakeContext(), { cwd: root, query: 'тест', wholeWord: true })
    assert.deepEqual(whole.matches.map((match) => match.column), [1])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a skip callback removes paths before they are read', async () => {
  const root = await workspace({
    'visible.ts': 'needle\n',
    'secret.ts': 'needle\n',
  })
  try {
    const result = await searchText(fakeContext(), {
      cwd: root,
      query: 'needle',
      skip: (relative) => relative === 'secret.ts',
    })
    assert.deepEqual(result.matches.map((match) => match.path), ['visible.ts'])
    assert.equal(result.scanned, 1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
