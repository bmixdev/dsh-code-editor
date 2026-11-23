import test from 'node:test'
import assert from 'node:assert/strict'

import { applyHunks, createChangeTracker, MAX_TURNS_PER_SESSION, revertHunks } from '../agentChanges.js'

const summary = (turn, files) => ({
  turn,
  cwd: '/work',
  files,
  total: files.length,
  added: files.reduce((sum, file) => sum + file.added, 0),
  deleted: files.reduce((sum, file) => sum + file.deleted, 0),
})

function recorderOf(turns, diff) {
  return {
    summary: (_sessionId, seq) => turns[seq],
    diff: diff ?? (async () => ({ kind: 'text', path: 'src/a.js', display: 'src/a.js', before: true, after: true, hunks: [], coarse: false })),
  }
}

test('a Host without the recorder reports itself as unavailable instead of empty', async () => {
  const tracker = createChangeTracker()
  assert.equal(tracker.available, false)
  assert.equal(tracker.note('s1', 1), true)
  assert.deepEqual(tracker.list('s1'), [])
  assert.equal(await tracker.diff('s1', 1, 0, new AbortController().signal), undefined)
})

test('a noted turn is listed newest first with positional file indices', () => {
  const turns = {
    4: summary(1, [{ path: 'src/a.js', display: 'src/a.js', added: 2, deleted: 1 }]),
    9: summary(2, [
      { path: 'src/b.js', display: 'src/b.js', added: 1, deleted: 0 },
      { path: 'img/logo.png', display: 'img/logo.png', added: 0, deleted: 0, binary: true },
    ]),
  }
  const tracker = createChangeTracker({ recorder: recorderOf(turns) })
  assert.equal(tracker.available, true)
  tracker.note('s1', 4)
  tracker.note('s1', 9)

  const listed = tracker.list('s1')
  assert.deepEqual(listed.map((entry) => entry.seq), [9, 4])
  assert.equal(listed[0].turn, 2)
  assert.equal(listed[0].total, 2)
  assert.equal(listed[0].added, 1)
  assert.equal(listed[0].hasSnapshot, false)
  assert.deepEqual(listed[0].files[0], {
    index: 0,
    path: 'src/b.js',
    display: 'src/b.js',
    added: 1,
    deleted: 0,
    binary: false,
    oversized: false,
  })
  assert.equal(listed[0].files[1].index, 1)
  assert.equal(listed[0].files[1].binary, true)
  assert.equal(listed[1].files[0].deleted, 1)
})

test('the same announcement is indexed once and the window stays bounded', () => {
  const turns = {}
  for (let seq = 1; seq <= 30; seq += 1) turns[seq] = summary(seq, [])
  const tracker = createChangeTracker({ recorder: recorderOf(turns), limit: 2 })
  tracker.note('s1', 5)
  assert.equal(tracker.note('s1', 5), false)
  tracker.note('s1', 6)
  tracker.note('s1', 7)
  assert.deepEqual(tracker.list('s1').map((entry) => entry.seq), [7, 6])
})

test('a turn the recorder no longer keeps stays listed as stale', () => {
  const turns = { 3: summary(1, []) }
  const tracker = createChangeTracker({ recorder: recorderOf(turns) })
  tracker.note('s1', 2)
  tracker.note('s1', 3)
  // The forgotten turn keeps its place, marked stale, so the panel can grey it
  // out instead of silently erasing history the user already saw.
  assert.deepEqual(tracker.list('s1').map((entry) => [entry.seq, entry.stale === true]), [
    [3, false],
    [2, true],
  ])
  assert.deepEqual(tracker.list('s1')[1].files, [])
  assert.deepEqual(tracker.list('s1').map((entry) => entry.seq), [3, 2])
})

test('a throwing recorder cannot take the panel down', () => {
  const tracker = createChangeTracker({
    recorder: {
      summary() {
        throw new Error('recorder exploded')
      },
      async diff() {
        return undefined
      },
    },
  })
  tracker.note('s1', 1)
  // A broken recorder reads like a forgotten turn: the entry stays, marked
  // stale, and the panel renders it greyed out rather than failing.
  assert.deepEqual(tracker.list('s1').map((entry) => [entry.seq, entry.stale === true]), [[1, true]])
})

test('forget clears one session only', () => {
  const turns = { 1: summary(1, []), 2: summary(1, []) }
  const tracker = createChangeTracker({ recorder: recorderOf(turns) })
  tracker.note('s1', 1)
  tracker.note('s2', 2)
  tracker.forget('s1')
  assert.deepEqual(tracker.list('s1'), [])
  assert.deepEqual(tracker.list('s2').map((entry) => entry.seq), [2])
})

test('diff reaches the recorder for a listed file and refuses everything else', async () => {
  const turns = { 7: summary(1, [{ path: 'src/a.js', display: 'src/a.js', added: 1, deleted: 0 }]) }
  const calls = []
  const tracker = createChangeTracker({
    recorder: recorderOf(turns, async (sessionId, seq, index) => {
      calls.push([sessionId, seq, index])
      return { kind: 'text', path: 'src/a.js', display: 'src/a.js', before: true, after: true, hunks: [], coarse: false }
    }),
  })
  tracker.note('s1', 7)

  const diff = await tracker.diff('s1', 7, 0, new AbortController().signal)
  assert.equal(diff.kind, 'text')
  assert.deepEqual(calls, [['s1', 7, 0]])

  await assert.rejects(tracker.diff('s1', 7, 3, new AbortController().signal), (error) => error.code === 'bad-request')
  await assert.rejects(tracker.diff('', 7, 0, new AbortController().signal), (error) => error.code === 'bad-request')
  // A turn this index never saw is the recorder's decision, not a refusal.
  assert.equal(await tracker.diff('s1', 8, 0, new AbortController().signal), undefined)
  assert.deepEqual(calls.length, 1)
})

test('the default window is the documented one', () => {
  assert.equal(MAX_TURNS_PER_SESSION, 20)
})

// One hunk that turns "const a = 1" into "const a = 2" on line 2.
const renameHunk = {
  oldStart: 2,
  oldLines: 1,
  newStart: 2,
  newLines: 1,
  lines: ['-const a = 1', '+const a = 2'],
}

test('a turn is reverted by applying its hunks backwards', () => {
  const after = 'x\nconst a = 2\ny'
  assert.equal(revertHunks(after, [renameHunk]), 'x\nconst a = 1\ny')
  // Round trip: the same hunks forward rebuild the turn end exactly.
  assert.equal(applyHunks('x\nconst a = 1\ny', [renameHunk]), after)
})

test('a hunk with context lines reverts only the changed line', () => {
  const hunk = {
    oldStart: 1,
    oldLines: 3,
    newStart: 1,
    newLines: 3,
    lines: [' a', '-b', '+B', ' c'],
  }
  assert.equal(revertHunks('a\nB\nc', [hunk]), 'a\nb\nc')
  assert.equal(applyHunks('a\nb\nc', [hunk]), 'a\nB\nc')
})

test('a hunk that no longer matches is a conflict, never a partial patch', () => {
  assert.equal(revertHunks('x\nconst a = 3\ny', [renameHunk]), undefined)
  assert.equal(revertHunks('x\ny', [renameHunk]), undefined)
  // An insertion hunk needs the anchor of the file it belongs to.
  const insertion = { oldStart: 2, oldLines: 0, newStart: 2, newLines: 1, lines: ['+new'] }
  assert.equal(revertHunks('x\nnew\nold', [insertion]), 'x\nold')
  assert.equal(revertHunks('x\nother', [insertion]), undefined)
})

test('several hunks revert in the right order without shifting each other', () => {
  const first = { oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, lines: ['-a', '+a1', '+a2'] }
  const last = { oldStart: 5, oldLines: 1, newStart: 6, newLines: 1, lines: ['-e', '+E'] }
  const after = 'a1\na2\nb\nc\nd\nE'
  assert.equal(revertHunks(after, [first, last]), 'a\nb\nc\nd\ne')
  assert.equal(applyHunks('a\nb\nc\nd\ne', [first, last]), after)
})

test('text without hunks is unchanged and garbage hunks are refused', () => {
  assert.equal(revertHunks('same', []), 'same')
  assert.equal(revertHunks('same', [{ lines: [1] }]), undefined)
  assert.equal(revertHunks('same', [{ newStart: 0, lines: ['+x'] }]), undefined)
})
