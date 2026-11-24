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
