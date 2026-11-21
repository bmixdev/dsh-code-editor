import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  buildContext,
  cleanLines,
  levenshtein,
  lineIsRepeated,
  patternIsValid,
  postprocessCompletion,
} from '../completion.js'

test('levenshtein computes distance and short-circuits equal strings', () => {
  assert.equal(levenshtein('', ''), 0)
  assert.equal(levenshtein('abc', ''), 3)
  assert.equal(levenshtein('', 'abcd'), 4)
  assert.equal(levenshtein('kitten', 'sitting'), 3)
  assert.equal(levenshtein('same', 'same'), 0)
  assert.equal(levenshtein('flaw', 'lawn'), 2)
})

test('lineIsRepeated ignores short lines and near-identical long lines', () => {
  // Short lines are never repeats, so structural punctuation survives.
  assert.equal(lineIsRepeated('}', '}'), false)
  assert.equal(lineIsRepeated('  }', '}'), false)
  assert.equal(lineIsRepeated('a', 'b'), false)
  assert.equal(lineIsRepeated('1234', '1234'), false)
  // Five characters is enough to be compared.
  assert.equal(lineIsRepeated('abcde', 'abcde'), true)
  // One character in ten differs → still a repeat.
  assert.equal(lineIsRepeated('const value = 1', 'const value = 2'), true)
  // Genuinely different lines are not.
  assert.equal(lineIsRepeated('const total = 1', 'return computeTotal(items)'), false)
  // Whitespace-only differences do not count as repeats of nothing.
  assert.equal(lineIsRepeated('      ', '   '), false)
})

test('patternIsValid rejects markers inside identifiers and string literals', () => {
  assert.equal(patternIsValid('```', '```'), true)
  assert.equal(patternIsValid('  ```', '```'), true)
  assert.equal(patternIsValid('x```', '```'), false)
  assert.equal(patternIsValid('const s = "```"', '```'), false)
  // Inside an already closed literal the marker is valid again.
  assert.equal(patternIsValid('const s = "a" + "```"', '```'), false)
  assert.equal(patternIsValid('const s = "a" \n```', '```'), true)
  assert.equal(patternIsValid('no marker here', '```'), false)
})

test('cleanLines stops at fence and end markers', () => {
  assert.equal(cleanLines('const a = 1\n```\nconst b = 2'), 'const a = 1')
  assert.equal(cleanLines('const a = 1\n# End of file.\nconst b = 2'), 'const a = 1')
  assert.equal(cleanLines('const a = 1\n<|/updated_code|>'), 'const a = 1')
  // A fence inside a string literal is code, not a stop marker.
  assert.equal(cleanLines('const a = "```"'), 'const a = "```"')
})

test('cleanLines drops marker lines, leading prefix and path comments', () => {
  assert.equal(cleanLines('</START EDITING HERE>\nconst a = 1'), 'const a = 1')
  assert.equal(cleanLines('<COMPLETION>const a = 1'), 'const a = 1')
  assert.equal(cleanLines('// Path: src/other.ts\nconst a = 1'), 'const a = 1')
  assert.equal(cleanLines('  # Path: src/other.ts\nconst a = 1'), 'const a = 1')
  // A path-looking line that is not a comment stays.
  assert.equal(cleanLines('const path = "Path: x"'), 'const path = "Path: x"')
})

test('cleanLines cuts prose at the start and after the code', () => {
  assert.equal(cleanLines('Here is the continuation:\nconst a = 1'), 'const a = 1')
  assert.equal(cleanLines('Sure, here you go\nconst a = 1'), 'const a = 1')
  // The blank line after the prose is dropped too.
  assert.equal(cleanLines('Certainly\n\nconst a = 1'), 'const a = 1')
  // A colon-ending line that is a real statement is not prose.
  assert.equal(cleanLines('def handler(self):\n    return 1'), 'def handler(self):\n    return 1')
  // Prose after a fence ends the answer.
  assert.equal(cleanLines('const a = 1\n```\nExplanation: it does x'), 'const a = 1')
})

test('cleanLines cuts a line repeated three times but keeps the first', () => {
  const repeated = 'process(item)\nprocess(item)\nprocess(item)\nprocess(item)'
  assert.equal(cleanLines(repeated), 'process(item)')
  // Near-identical lines count as repeats.
  assert.equal(
    cleanLines('const total = compute(a)\nconst total = compute(b)\nconst total = compute(c)\nconst total = compute(d)'),
    'const total = compute(a)',
  )
  // Short repeated lines are structural and survive.
  assert.equal(cleanLines('}\n}\n}\n}'), '}')
})

test('cleanLines trims trailing whitespace and edge blank lines', () => {
  assert.equal(cleanLines('const a = 1   \nconst b = 2\t'), 'const a = 1\nconst b = 2')
  assert.equal(cleanLines('\n\nconst a = 1\n'), 'const a = 1')
})

test('cleanLines cuts at a top-level keyword that is not at the start', () => {
  const keywords = ['function', 'class', 'export']
  assert.equal(cleanLines('const a = 1; function b() {}', { topLevelKeywords: keywords }), 'const a = 1;')
  // At the start of the line the keyword is legitimate.
  assert.equal(cleanLines('function b() {}', { topLevelKeywords: keywords }), 'function b() {}')
  // A keyword inside a longer identifier is not a boundary in Continue, but a
  // space after the keyword is what this port matches on, so `myfunction = 1`
  // is cut. Recorded as a deliberate difference.
  assert.equal(cleanLines('const myfunction = 1', { topLevelKeywords: keywords }), 'const my')
})

test('postprocessCompletion rejects answers that carry no insertion', () => {
  assert.equal(postprocessCompletion({ completion: '' }), '')
  assert.equal(postprocessCompletion({ completion: '   \n\t ' }), '')
  assert.equal(postprocessCompletion({ completion: undefined }), '')
  // Only a fence is not an answer.
  assert.equal(postprocessCompletion({ completion: '```ts\n' }), '')
})

test('postprocessCompletion rejects an answer that repeats the line above', () => {
  const prefix = 'const a = 1\nconst b = 2'
  assert.equal(postprocessCompletion({ completion: 'const b = 2\nconst c = 3', prefix }), '')
  // A different line is kept.
  assert.equal(postprocessCompletion({ completion: 'const c = 3', prefix }), 'const c = 3')
  // With no line above, nothing is repeated.
  assert.equal(postprocessCompletion({ completion: 'const c = 3', prefix: '' }), 'const c = 3')
  // A cursor at the end of a line looks at the previous complete line, and a
  // prefix that ends in a newline must not make the check vacuous.
  assert.equal(postprocessCompletion({ completion: 'const b = 2', prefix: `${prefix}\n` }), '')
  // Indentation does not matter.
  assert.equal(postprocessCompletion({ completion: '    const b = 2', prefix: `${prefix}\n` }), '')
})

test('postprocessCompletion rejects an answer that is one line on a loop', () => {
  const loop = Array.from({ length: 10 }, () => 'await fetchNextPage()').join('\n')
  assert.equal(postprocessCompletion({ completion: loop }), '')
  // Fewer than six lines is never extreme repetition; the repeat filter still
  // collapses it to the first occurrence.
  const short = Array.from({ length: 5 }, () => 'await fetchNextPage()').join('\n')
  assert.equal(postprocessCompletion({ completion: short }), 'await fetchNextPage()')
})

test('postprocessCompletion removes a markdown fence and joins the space', () => {
  assert.equal(postprocessCompletion({ completion: '```ts\nconst a = 1\n```' }), 'const a = 1')
  assert.equal(postprocessCompletion({ completion: ' const a = 1', prefix: 'return ' }), 'const a = 1')
  // Without a trailing space in the prefix the leading space is content.
  assert.equal(postprocessCompletion({ completion: ' const a = 1', prefix: 'return' }), ' const a = 1')
})

test('postprocessCompletion keeps the line break a comment asks for', () => {
  const prefix = 'def main():\n    pass\n\n# Добавь тестовую процедуру печати'
  const answer = '\ndef hello():\n    print("hello")\n'
  const text = postprocessCompletion({ completion: answer, prefix })
  assert.ok(text.startsWith('\n'), 'the suggestion must start on the line after the comment')
  assert.equal(text, '\ndef hello():\n    print("hello")')
  // A prefix that already ends in a line break needs no second one.
  assert.equal(postprocessCompletion({ completion: answer, prefix: `${prefix}\n` }), 'def hello():\n    print("hello")')
  // An answer that does not ask for a new line keeps its place in the line.
  assert.equal(postprocessCompletion({ completion: 'foo()', prefix: 'x = ' }), 'foo()')
})

test('postprocessCompletion puts code under a comment even without a line break', () => {
  const prefix = '# Добавь тестовую процедуру печати'
  // The fast models answer with bare code, and the comment asks for the next line.
  assert.equal(postprocessCompletion({ completion: 'def print_test():\n    print("test")', prefix }), '\ndef print_test():\n    print("test")')
  // A comment answer stays in the comment.
  assert.equal(postprocessCompletion({ completion: '# другой комментарий', prefix }), '# другой комментарий')
  // Ordinary code at the end of a code line keeps its place in the line.
  assert.equal(postprocessCompletion({ completion: 'join()', prefix: 'return lines.' }), 'join()')
  // JS and SQL comment styles are recognised too.
  assert.equal(postprocessCompletion({ completion: 'const n = text.length', prefix: '  // Считает длину' }), '\nconst n = text.length')
  assert.equal(postprocessCompletion({ completion: 'select 1', prefix: '-- посчитать' }), '\nselect 1')
})

test('buildContext bounds both windows around the cursor', () => {
  const text = `${'a'.repeat(5000)}CURSOR${'b'.repeat(2000)}`
  const offset = 5000
  const context = buildContext({ text, offset, left: 4000, right: 1000 })
  assert.equal(context.prefix.length, 4000)
  assert.equal(context.suffix.length, 1000)
  assert.ok(context.prefix.endsWith('aaaa'))
  assert.ok(context.suffix.startsWith('CURSOR'))
  assert.equal(context.truncated, true)

  const small = buildContext({ text: 'const a = 1\n', offset: 5, left: 4000, right: 1000 })
  assert.equal(small.prefix, 'const')
  assert.equal(small.suffix, ' a = 1\n')
  assert.equal(small.truncated, false)
})

test('buildContext clamps a cursor outside the text and appends the selection', () => {
  const context = buildContext({ text: 'abc', offset: 999, left: 4000, right: 1000, selection: 'SELECTED' })
  assert.equal(context.prefix, 'abcSELECTED')
  assert.equal(context.suffix, '')

  const negative = buildContext({ text: 'abc', offset: -5 })
  assert.equal(negative.prefix, '')
  assert.equal(negative.suffix, 'abc')
})
