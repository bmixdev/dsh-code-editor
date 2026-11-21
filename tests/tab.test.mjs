/**
 * Tab mechanics: the edit plan, the no-op detector and the pre-display checks.
 *
 * These tests run without a model and without an editor: every case is a buffer
 * plus an answer, which is exactly the input the host has when it decides what
 * to send back to the IDE.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  boundLines,
  countLines,
  detectEol,
  evaluateSuggestion,
  isNoOp,
  nextWordEnd,
  normalizeEol,
  planEdit,
  reasonLabel,
  splitLines,
} from '../tab.js'

test('line helpers keep the buffer endings', () => {
  assert.equal(detectEol('a\nb'), '\n')
  assert.equal(detectEol('a\r\nb'), '\r\n')
  assert.equal(normalizeEol('a\r\nb\r\n', '\n'), 'a\nb\n')
  assert.equal(normalizeEol('a\nb', '\r\n'), 'a\r\nb')
  assert.deepEqual(splitLines('a\nb\n'), ['a', 'b', ''])
  assert.equal(countLines(''), 1)
  assert.equal(countLines('a\nb'), 2)
})

test('a suggestion that only restates the cursor text is a no-op', () => {
  assert.equal(isNoOp({ originalText: 'const a = 1', suggestion: 'const a = 1' }), true)
  assert.equal(isNoOp({ originalText: '', suggestion: '' }), true)
  assert.equal(isNoOp({ originalText: 'foo', suggestion: 'foo\n' }), true)
  assert.equal(isNoOp({ originalText: 'foo', suggestion: 'foo\n\n' }), true)
  assert.equal(isNoOp({ originalText: 'foo', suggestion: 'foobar' }), false)
  assert.equal(isNoOp({ originalText: 'foo', suggestion: 'bar' }), false)
  assert.equal(isNoOp({ originalText: '', suggestion: 'let x = 1' }), false)
})

test('an answer is inserted at the cursor', () => {
  const text = 'const value = '
  const plan = planEdit({ text, offset: text.length, suggestion: '42' })
  assert.equal(plan.kind, 'insert')
  assert.equal(plan.startOffset, text.length)
  assert.equal(plan.endOffset, text.length)
  assert.equal(plan.insertText, '42')
  assert.equal(plan.removedText, '')
})

test('an echo of the text before the cursor is dropped', () => {
  const text = 'const value = fo'
  const plan = planEdit({ text, offset: text.length, suggestion: 'foo()' })
  assert.equal(plan.insertText, 'o()')
})

test('an answer that agrees with the whole tail continues after it', () => {
  const text = 'let a = 1'
  const offset = 'let a = '.length
  const plan = planEdit({ text, offset, suggestion: '1 + 2' })
  assert.equal(plan.kind, 'insert')
  assert.equal(plan.startOffset, text.length)
  assert.equal(plan.insertText, ' + 2')
  assert.equal(`${text.slice(0, plan.startOffset)}${plan.insertText}`, 'let a = 1 + 2')
})

test('an answer that diverges inside the tail rewrites it', () => {
  const text = 'let a = 100'
  const offset = 'let a = '.length
  const plan = planEdit({ text, offset, suggestion: '1 + 2' })
  assert.equal(plan.kind, 'replace')
  assert.equal(plan.startOffset, offset + 1)
  assert.equal(plan.removedText, '00')
  assert.equal(plan.insertText, ' + 2')
  assert.equal(`${text.slice(0, plan.startOffset)}${plan.insertText}${text.slice(plan.endOffset)}`, 'let a = 1 + 2')
})

test('an answer whose last line repeats the tail rewrites the tail', () => {
  const text = 'foo bar'
  const offset = 'foo '.length
  const plan = planEdit({ text, offset, suggestion: 'x\nbar' })
  assert.equal(plan.kind, 'replace')
  assert.equal(plan.startOffset, offset)
  assert.equal(plan.endOffset, text.length)
  assert.equal(plan.removedText, 'bar')
  assert.equal(`${text.slice(0, plan.startOffset)}${plan.insertText}`, 'foo x\nbar')
})

test('range replacement can be switched off from settings', () => {
  const text = 'let a = 1'
  const offset = 'let a = '.length
  const plan = planEdit({ text, offset, suggestion: '1 + 2', options: { rangeReplace: false } })
  assert.equal(plan.kind, 'insert')
  assert.equal(plan.insertText, '1 + 2')
})

test('CRLF buffers plan in their own endings', () => {
  const text = 'a\r\nb = 1'
  const offset = text.length - 1
  const plan = planEdit({ text, offset, suggestion: '1 + 1' })
  assert.equal(plan.startOffset, text.length)
  assert.equal(plan.insertText, ' + 1')
  assert.equal(plan.eol, '\r\n')
})

test('an empty answer produces an empty insertion', () => {
  const plan = planEdit({ text: 'abc', offset: 1, suggestion: '' })
  assert.equal(plan.insertText, '')
  assert.equal(plan.startOffset, 1)
})

test('a whitespace-only rewrite is suppressed', () => {
  const plan = { kind: 'replace', startOffset: 0, endOffset: 5, insertText: 'a b', removedText: 'a  b' }
  const verdict = evaluateSuggestion({ text: 'a  b', plan })
  assert.equal(verdict.accepted, false)
  assert.equal(verdict.reason, 'whitespace-only')
  assert.equal(reasonLabel('whitespace-only').length > 0, true)
})

test('a duplicate of the next line is suppressed', () => {
  const text = 'foo\n\tbar()'
  const offset = 'foo\n\t'.length
  const plan = { kind: 'insert', startOffset: offset, endOffset: offset, insertText: 'x = 1\nbar()', removedText: '' }
  const verdict = evaluateSuggestion({ text, plan })
  assert.equal(verdict.accepted, false)
  assert.equal(verdict.reason, 'duplicate-line')
})

test('an answer that only retells the following lines is suppressed', () => {
  const text = 'a\nb\nc'
  const plan = { kind: 'insert', startOffset: 2, endOffset: 2, insertText: 'b\nc', removedText: '' }
  const verdict = evaluateSuggestion({ text, plan })
  assert.equal(verdict.accepted, false)
  assert.equal(verdict.reason, 'extends-range')
})

test('a recently rejected answer is suppressed and can be re-enabled', () => {
  const plan = { kind: 'insert', startOffset: 0, endOffset: 0, insertText: 'x = 1\n', removedText: '' }
  const rejections = [{ text: 'x = 1', at: Date.now() }]
  const verdict = evaluateSuggestion({ text: '', plan, rejections, options: { recentRejectThreshold: 1 } })
  assert.equal(verdict.reason, 'recently-rejected')
  const allowed = evaluateSuggestion({ text: '', plan, rejections, options: { recentRejectThreshold: 0 } })
  assert.equal(allowed.accepted, true)
})

test('an ordinary continuation passes every check', () => {
  const plan = { kind: 'insert', startOffset: 0, endOffset: 0, insertText: 'const answer = 42\n', removedText: '' }
  const verdict = evaluateSuggestion({ text: '', plan })
  assert.equal(verdict.accepted, true)
  assert.equal(verdict.reason, '')
})

test('next word stops at the end of an identifier', () => {
  assert.equal(nextWordEnd('alpha beta', 0), 5)
  assert.equal(nextWordEnd('alpha beta', 5), 10)
  assert.equal(nextWordEnd('  indent', 0), 8)
  assert.equal(nextWordEnd('a + b', 2), 3)
  assert.equal(nextWordEnd('', 0), 0)
})

test('context windows can be bounded by lines', () => {
  const text = 'one\ntwo\nthree\nfour'
  assert.equal(boundLines(text, 2, 'start'), 'one\ntwo')
  assert.equal(boundLines(text, 2, 'end'), 'three\nfour')
  assert.equal(boundLines(text, 10, 'end'), text)
  assert.equal(boundLines(text, 0, 'end'), '')
})
