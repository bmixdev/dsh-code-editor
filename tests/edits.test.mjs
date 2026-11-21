/**
 * Tests for the whole-file edit plan: parsing the model's two-part answer,
 * locating each snippet in the buffer, and applying the result.
 *
 * The point of the locate step is that a model is bad at counting bytes but
 * good at quoting code; these cases pin down which quotes are accepted and
 * which are refused instead of guessed.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { applyEdits, buildFileContext, editInstructions, locateEdits, parseEditResponse } from '../edits.js'

const FILE = 'def main():\n    pass\n\nif __name__ == "__main__":\n    main(f)\n'

test('the answer is split at the EDITS section', () => {
  const parsed = parseEditResponse(
    'INSERT:\n    main(f)\nEDITS:\n[{"find":"def main():","replace":"def main(f):","why":"signature"}]',
  )
  assert.equal(parsed.answer, '    main(f)')
  assert.deepEqual(parsed.edits, [{ find: 'def main():', replace: 'def main(f):', why: 'signature' }])
})

test('an answer without the section is a plain continuation', () => {
  const parsed = parseEditResponse('return value + 1')
  assert.equal(parsed.answer, 'return value + 1')
  assert.deepEqual(parsed.edits, [])
})

test('a bare edit array is accepted when there is no continuation', () => {
  const parsed = parseEditResponse('[{"find":"pass","replace":"return 1","why":""}]')
  assert.equal(parsed.answer, '')
  assert.equal(parsed.edits.length, 1)
})

test('unparsable JSON yields no edits instead of throwing', () => {
  const parsed = parseEditResponse('INSERT:\nx\nEDITS:\n[{"find": broken')
  assert.equal(parsed.answer, 'x')
  assert.deepEqual(parsed.edits, [])
})

test('a truncated list keeps the complete leading edits', () => {
  // The live failure: the answer ran out of tokens inside the second edit and
  // every edit before the cut was thrown away with the half-written one.
  const parsed = parseEditResponse(
    'INSERT:\nEDITS:\n[{"find":"def main():","replace":"def main(path):","why":"argument"},{"find":"    with open(\\"data.json\\", \\"r\\",',
  )
  assert.equal(parsed.edits.length, 1)
  assert.equal(parsed.edits[0].find, 'def main():')
  assert.equal(parsed.edits[0].replace, 'def main(path):')
})

test('an edit cut inside why is still recovered', () => {
  // The second live failure: the cut fell inside the optional `why` string, so
  // the object never closed and the one useful edit was lost.
  const parsed = parseEditResponse(
    'INSERT:\nEDITS:\n' +
      '[{"find":"def main():","replace":"def main(path):","why":"нужны импорты json и Path',
  )
  assert.equal(parsed.edits.length, 1)
  assert.deepEqual(
    { find: parsed.edits[0].find, replace: parsed.edits[0].replace, why: parsed.edits[0].why },
    { find: 'def main():', replace: 'def main(path):', why: '' },
  )
})

test('entries without a find or a replace are dropped', () => {
  const parsed = parseEditResponse(
    'a\nEDITS:\n[{"find":"","replace":"x"},{"find":"y","replace":""},{"find":"z","replace":"z"},{"find":"q","replace":"w"}]',
  )
  assert.deepEqual(parsed.edits, [{ find: 'q', replace: 'w', why: '' }])
})

test('an edit is located at its unique occurrence', () => {
  const edits = locateEdits({ text: FILE, edits: [{ find: 'def main():', replace: 'def main(f):' }], maxEdits: 3 })
  assert.equal(edits.length, 1)
  assert.equal(edits[0].start, 0)
  assert.equal(FILE.slice(edits[0].start, edits[0].end), 'def main():')
})

test('a snippet that appears twice is refused rather than guessed', () => {
  const text = 'a = 1\nb = 1\n'
  const edits = locateEdits({ text, edits: [{ find: '= 1', replace: '= 2' }], maxEdits: 3 })
  assert.deepEqual(edits, [])
})

test('a snippet missing from the buffer is refused', () => {
  const edits = locateEdits({ text: FILE, edits: [{ find: 'def other():', replace: 'x' }], maxEdits: 3 })
  assert.deepEqual(edits, [])
})

test('edits never overlap, and the caret keeps its own spot', () => {
  const nearby = locateEdits({
    text: FILE,
    edits: [
      { find: 'def main():', replace: 'def main(f):' },
      { find: 'main():', replace: 'main(f):' },
    ],
    maxEdits: 3,
  })
  assert.equal(nearby.length, 1)

  const atCursor = locateEdits({
    text: FILE,
    edits: [{ find: 'main(f)', replace: 'main(g)' }],
    maxEdits: 3,
    cursor: FILE.indexOf('main(f)') + 3,
  })
  assert.deepEqual(atCursor, [])
})

test('the count setting bounds how many edits survive', () => {
  const edits = locateEdits({
    text: 'a\nb\nc\n',
    edits: [
      { find: 'a', replace: 'A' },
      { find: 'b', replace: 'B' },
      { find: 'c', replace: 'C' },
    ],
    maxEdits: 2,
  })
  assert.deepEqual(
    edits.map((edit) => edit.newText),
    ['A', 'B'],
  )
  assert.deepEqual(locateEdits({ text: 'a\n', edits: [{ find: 'a', replace: 'b' }], maxEdits: 0 }), [])
})

test('CRLF buffers match LF snippets and keep CRLF', () => {
  const text = 'a\r\ndef main():\r\n    pass\r\n'
  const edits = locateEdits({
    text,
    edits: [{ find: 'def main():\n    pass', replace: 'def main(f):\n    pass' }],
    maxEdits: 2,
  })
  assert.equal(edits.length, 1)
  assert.equal(edits[0].newText, 'def main(f):\r\n    pass')
})

test('applying edits keeps the parts between them', () => {
  const edits = locateEdits({
    text: 'one\ntwo\nthree\n',
    edits: [
      { find: 'one', replace: '1' },
      { find: 'three', replace: '3' },
    ],
    maxEdits: 2,
  })
  assert.equal(applyEdits('one\ntwo\nthree\n', edits), '1\ntwo\n3\n')
})

test('the file context marks the caret exactly once', () => {
  const message = buildFileContext({ path: 'src/main.py', language: 'python', text: FILE, offset: 5 })
  assert.ok(message.includes('Файл: src/main.py'))
  const marks = message.split('⟦КУРСОР⟧')
  // The header names the marker and the body places it once.
  assert.equal(marks.length, 3)
  assert.ok(message.includes('def m⟦КУРСОР⟧ain'))
})

test('the edit instruction names the limit and the format', () => {
  const text = editInstructions({ maxEdits: 2 })
  assert.ok(text.includes('EDITS:'))
  assert.ok(text.includes('не больше 2'))
  assert.ok(text.includes('"find"'))
})
