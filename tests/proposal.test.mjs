/**
 * Proposal-half tests for `@local/dsh-ide`.
 *
 * A proposal is the Host-side record of one reviewed change: exact ranges into
 * the open buffer, the text they replace and the text they produce. These tests
 * pin the validation rules — an ambiguous proposal must be refused at creation,
 * never "resolved" by guessing an occurrence.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  MAX_PROPOSAL_CHANGES,
  ProposalError,
  createProposal,
  readReplacementAnswer,
  summarizeProposal,
  verifyProposal,
} from '../proposal.js'

function code(run) {
  try {
    run()
  } catch (error) {
    assert.ok(error instanceof ProposalError, 'expected a ProposalError')
    return error.code
  }
  assert.fail('expected the call to throw')
}

test('a proposal applies its changes from the end and reports the result', () => {
  const text = 'a\nb\nc\n'
  const proposal = createProposal({
    id: 'p1',
    documentId: 'doc1',
    modelVersion: 7,
    text,
    changes: [
      { start: 0, end: 1, oldText: 'a', newText: 'A' },
      { start: 4, end: 5, oldText: 'c', newText: 'C' },
    ],
  })
  assert.equal(proposal.result, 'A\nb\nC\n')
  assert.equal(proposal.text, text)
  assert.equal(proposal.modelVersion, 7)
  assert.deepEqual(
    proposal.changes.map((change) => [change.start, change.end, change.oldText, change.newText]),
    [
      [0, 1, 'a', 'A'],
      [4, 5, 'c', 'C'],
    ],
  )
})

test('offsets are UTF-16, so a surrogate pair before the range shifts nothing', () => {
  const text = '// 😀\nlet x = 1\n'
  const start = text.indexOf('let x = 1')
  const proposal = createProposal({
    id: 'p1',
    documentId: 'doc1',
    modelVersion: 1,
    text,
    changes: [{ start, end: start + 'let x = 1'.length, oldText: 'let x = 1', newText: 'let x = 2' }],
  })
  assert.equal(proposal.result, '// 😀\nlet x = 2\n')
})

test('an empty replacement is a deletion, not an empty answer', () => {
  const text = 'keep\ndrop\n'
  const start = text.indexOf('drop')
  const proposal = createProposal({
    id: 'p1',
    documentId: 'doc1',
    modelVersion: 1,
    text,
    changes: [{ start, end: start + 'drop\n'.length, oldText: 'drop\n', newText: '' }],
  })
  assert.equal(proposal.result, 'keep\n')
  assert.equal(proposal.changes[0].newText, '')
})

test('createProposal refuses anything that would make the apply ambiguous', () => {
  const text = 'one\ntwo\nthree\n'
  const base = { id: 'p1', documentId: 'doc1', modelVersion: 1, text }

  assert.equal(
    code(() =>
      createProposal({ ...base, changes: [{ start: 4, end: 7, oldText: 'TWO', newText: 'X' }] }),
    ),
    'mismatch',
  )
  assert.equal(
    code(() => createProposal({ ...base, changes: [{ start: 4, end: 999, newText: 'X' }] })),
    'out-of-range',
  )
  assert.equal(
    code(() =>
      createProposal({
        ...base,
        changes: [
          { start: 0, end: 3, newText: 'X' },
          { start: 2, end: 5, newText: 'Y' },
        ],
      }),
    ),
    'overlap',
  )
  assert.equal(
    code(() =>
      createProposal({
        ...base,
        changes: [
          { start: 0, end: 3, newText: 'X' },
          { start: 0, end: 3, newText: 'Y' },
        ],
      }),
    ),
    'duplicate',
  )
  assert.equal(
    code(() => createProposal({ ...base, changes: [{ start: 0, end: 3, newText: 'one' }] })),
    'no-change',
  )
  assert.equal(code(() => createProposal({ ...base, changes: [] })), 'empty-changes')
  assert.equal(code(() => createProposal({ ...base, changes: undefined })), 'empty-changes')
  assert.equal(
    code(() =>
      createProposal({
        ...base,
        changes: Array.from({ length: MAX_PROPOSAL_CHANGES + 1 }, () => ({ start: 0, end: 0, newText: 'x' })),
      }),
    ),
    'too-many-changes',
  )
})

test('verifyProposal catches a newer version and changed range text', () => {
  const text = 'alpha beta\n'
  const proposal = createProposal({
    id: 'p1',
    documentId: 'doc1',
    modelVersion: 3,
    text,
    changes: [{ start: 6, end: 10, oldText: 'beta', newText: 'gamma' }],
  })

  assert.deepEqual(verifyProposal(proposal, { text, modelVersion: 3 }), { ok: true })
  assert.deepEqual(verifyProposal(proposal, { text, modelVersion: 4 }), {
    ok: false,
    code: 'stale',
    message: 'Файл изменился, запросите новую правку.',
  })
  assert.deepEqual(verifyProposal(proposal, { text: 'alpha zeta\n', modelVersion: 3 }), {
    ok: false,
    code: 'text-changed',
    message: 'Текст файла изменился, запросите новую правку.',
  })
  assert.equal(verifyProposal(undefined, {}).ok, false)
})

test('summarizeProposal reports counts for the review bar', () => {
  const proposal = createProposal({
    id: 'p1',
    documentId: 'doc1',
    modelVersion: 1,
    text: 'a\nb\n',
    changes: [{ start: 0, end: 4, oldText: 'a\nb\n', newText: 'c\n' }],
  })
  assert.deepEqual(summarizeProposal(proposal), { changes: 1, addedLines: 1, removedLines: 2 })
  assert.deepEqual(summarizeProposal(undefined), { changes: 0, addedLines: 0, removedLines: 0 })
})

test('readReplacementAnswer reads JSON, a fence and a wrapped object', () => {
  assert.equal(readReplacementAnswer('{"replacement":"const a = 1\\n"}'), 'const a = 1\n')
  assert.equal(readReplacementAnswer('```json\n{"replacement":"x"}\n```'), 'x')
  assert.equal(readReplacementAnswer('Вот правка: {"replacement":"y"} — готово.'), 'y')
  assert.equal(readReplacementAnswer('{"replacement":""}'), '')
  assert.equal(readReplacementAnswer('sure!'), undefined)
  assert.equal(readReplacementAnswer(''), undefined)
  assert.equal(readReplacementAnswer('{"replacement": 42}'), undefined)
  assert.equal(readReplacementAnswer('{"other":"x"}'), undefined)
})
