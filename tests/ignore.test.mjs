import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { compileIgnore, loadIgnore, parseIgnore, relativePath } from '../ignore.js'

test('parses comments, negation, directory and anchored patterns', () => {
  const patterns = parseIgnore('# comment\n\nbuild/\n!build/keep.txt\n/top.txt\n*.log\n')
  assert.deepEqual(patterns, [
    { negate: false, directory: true, anchored: false, glob: 'build' },
    { negate: true, directory: false, anchored: false, glob: 'build/keep.txt' },
    { negate: false, directory: false, anchored: true, glob: 'top.txt' },
    { negate: false, directory: false, anchored: false, glob: '*.log' },
  ])
})

test('matches basenames at any depth but keeps anchored patterns at the root', () => {
  const ignored = compileIgnore(parseIgnore('*.log\n/only-root.txt\n'))
  assert.equal(ignored('a/b/debug.log'), true)
  assert.equal(ignored('only-root.txt'), true)
  assert.equal(ignored('nested/only-root.txt'), false)
  assert.equal(ignored('debug.txt'), false)
})

test('a directory pattern covers descendants and negation can re-include one', () => {
  const ignored = compileIgnore(parseIgnore('dist/\n!dist/keep.js\n'))
  assert.equal(ignored('dist', true), true)
  assert.equal(ignored('dist/bundle.js', false), true)
  assert.equal(ignored('dist/keep.js', false), false)
  assert.equal(ignored('src/dist/bundle.js', false), true)
})

test('loads both scopes and keeps them apart', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-ignore-'))
  try {
    await mkdir(path.join(root, 'generated'), { recursive: true })
    await writeFile(path.join(root, '.cursorignore'), 'secret.txt\n')
    await writeFile(path.join(root, '.cursorindexingignore'), 'generated/\n')
    const ignore = await loadIgnore(root)
    assert.equal(ignore.blocked('secret.txt'), true)
    assert.equal(ignore.blocked('generated/x.ts'), false)
    assert.equal(ignore.skipped('secret.txt'), true)
    assert.equal(ignore.skipped('generated/x.ts'), true)
    assert.equal(ignore.skipped('src/app.ts'), false)
    assert.equal(relativePath(root, path.join(root, 'src', 'app.ts')), 'src/app.ts')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('missing ignore files mean nothing is ignored', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-ignore-'))
  try {
    const ignore = await loadIgnore(root)
    assert.equal(ignore.blocked('anything.ts'), false)
    assert.equal(ignore.skipped('anything.ts'), false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
