/**
 * Tests for the outline parser (`structure.js`).
 *
 * The parser is pure text-in/tree-out, so every case is a literal source
 * snippet and an assertion about the rows and their line numbers.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { languageOf, outlineOf } from '../structure.js'

const names = (symbols) => symbols.map((symbol) => symbol.name)
const find = (symbols, name) => symbols.find((symbol) => symbol.name === name)

test('language detection by extension', () => {
  assert.equal(languageOf('src/App.jsx'), 'javascript')
  assert.equal(languageOf('lib/util.TS'), 'typescript')
  assert.equal(languageOf('a/b/main.py'), 'python')
  assert.equal(languageOf('notes.md'), 'markdown')
  assert.equal(languageOf('styles/theme.scss'), 'css')
  assert.equal(languageOf('readme.txt'), '')
  assert.equal(languageOf('noextension'), '')
})

test('javascript outline: class with methods, nested functions, arrow', () => {
  const source = [
    'export class Widget {',
    '  render() {',
    "    const text = '{ fake }'",
    '    return text',
    '  }',
    '  static create(text) { return new Widget() }',
    '}',
    'function helper() {',
    '  function inner() {}',
    '}',
    'const arrow = async (x) => {',
    '  return x',
    '}',
  ].join('\n')
  const result = outlineOf('src/widget.js', source)
  assert.equal(result.language, 'javascript')
  assert.deepEqual(names(result.symbols), ['Widget', 'helper', 'arrow'])
  const widget = find(result.symbols, 'Widget')
  assert.equal(widget.kind, 'class')
  assert.equal(widget.line, 1)
  assert.equal(widget.endLine, 7)
  assert.deepEqual(names(widget.children), ['render', 'create'])
  assert.equal(find(widget.children, 'render').endLine, 5)
  assert.equal(find(widget.children, 'render').kind, 'method')
  const helper = find(result.symbols, 'helper')
  assert.deepEqual(names(helper.children), ['inner'])
  assert.equal(find(result.symbols, 'arrow').line, 11)
})

test('javascript masking: comments, strings, templates and regex cannot fake symbols', () => {
  const source = [
    '// class Ghost {}',
    '/* function phantom() {} */',
    "const label = 'class sneaky {}'",
    'const pattern = /a{2}/.test("x{2}")',
    'const message = `class also fake ${label} done`',
    'function real() {}',
  ].join('\n')
  const result = outlineOf('src/masked.js', source)
  assert.deepEqual(names(result.symbols), ['real'])
})

test('typescript outline includes interface and type', () => {
  const source = ['export interface Shape {', '  area(): number', '}', 'export type Pair = {', '  a: number', '}', 'function main() {}'].join('\n')
  const result = outlineOf('src/types.ts', source)
  const kinds = Object.fromEntries(result.symbols.map((symbol) => [symbol.name, symbol.kind]))
  assert.equal(kinds.Shape, 'interface')
  assert.equal(kinds.Pair, 'interface')
  assert.equal(kinds.main, 'function')
})

test('python outline: indentation nesting and dedent end lines', () => {
  const source = [
    'class Dog:',
    '    def bark(self):',
    '        pass',
    '',
    '    async def fetch(self):',
    '        pass',
    '',
    'def street():',
    '    pass',
  ].join('\n')
  const result = outlineOf('src/animal.py', source)
  assert.equal(result.language, 'python')
  assert.deepEqual(names(result.symbols), ['Dog', 'street'])
  const dog = find(result.symbols, 'Dog')
  assert.deepEqual(names(dog.children), ['bark', 'fetch'])
  assert.equal(find(dog.children, 'fetch').kind, 'method')
  assert.equal(find(result.symbols, 'street').line, 8)
  assert.ok(find(result.symbols, 'street').endLine >= 9)
})

test('python masking: comments and docstrings do not create symbols', () => {
  const source = ['# def fake(): pass', 'def real():', '    """class Docstring:', '    more', '    """', '    pass'].join('\n')
  const result = outlineOf('src/docstring.py', source)
  assert.deepEqual(names(result.symbols), ['real'])
})

test('markdown outline: headings nest by level', () => {
  const source = ['# Title', '## Sub', '## Other', '### Deep', '# Next'].join('\n')
  const result = outlineOf('notes.md', source)
  assert.deepEqual(names(result.symbols), ['Title', 'Next'])
  const title = find(result.symbols, 'Title')
  assert.deepEqual(names(title.children), ['Sub', 'Other'])
  assert.deepEqual(names(find(title.children, 'Other').children), ['Deep'])
  assert.equal(find(result.symbols, 'Next').line, 5)
})

test('css outline: rules and at-rules nest', () => {
  const source = ['.card {', '  color: red;', '}', '@media (min-width: 100px) {', '  .box { color: blue }', '}'].join('\n')
  const result = outlineOf('styles/main.css', source)
  const kinds = Object.fromEntries(result.symbols.map((symbol) => [symbol.name, symbol.kind]))
  assert.equal(kinds['.card'], 'rule')
  assert.equal(kinds['@media (min-width: 100px)'], 'atrule')
  const media = find(result.symbols, '@media (min-width: 100px)')
  assert.deepEqual(names(media.children), ['.box'])
  assert.equal(find(media.children, '.box').line, 5)
})

test('unsupported or empty input yields no symbols', () => {
  assert.deepEqual(outlineOf('data.bin', 'class Foo {}'), { language: '', symbols: [] })
  assert.deepEqual(outlineOf('src/app.js', ''), { language: 'javascript', symbols: [] })
})

test('python docstring becomes the symbol comment', () => {
  const sameLine = ['def read_rows(path):', '    """Читает файл — массив строк."""', '    pass'].join('\n')
  const rows = find(outlineOf('src/read.py', sameLine).symbols, 'read_rows')
  assert.equal(rows.comment, 'Читает файл — массив строк.')

  const multiline = ['def write_xlsx(data):', '    """', '    Пишет книгу Excel.', '    Вторая строка.', '    """', '    pass'].join('\n')
  const write = find(outlineOf('src/write.py', multiline).symbols, 'write_xlsx')
  assert.equal(write.comment, 'Пишет книгу Excel.')

  const hash = ['# Готовит данные к записи.', 'def prepare(data):', '    pass'].join('\n')
  const prepare = find(outlineOf('src/prepare.py', hash).symbols, 'prepare')
  assert.equal(prepare.comment, 'Готовит данные к записи.')

  const none = ['def plain(data):', '    pass'].join('\n')
  const plain = find(outlineOf('src/plain.py', none).symbols, 'plain')
  assert.ok(!('comment' in plain))
})

test('javascript comment above definition becomes the symbol comment', () => {
  const line = ['// Считает сумму элементов.', 'function sum(list) {}'].join('\n')
  const sum = find(outlineOf('src/sum.js', line).symbols, 'sum')
  assert.equal(sum.comment, 'Считает сумму элементов.')

  const jsdoc = ['/**', ' * Renders the widget.', ' */', 'function render() {}'].join('\n')
  const render = find(outlineOf('src/render.js', jsdoc).symbols, 'render')
  assert.equal(render.comment, 'Renders the widget.')

  const bare = ['function bare() {}'].join('\n')
  const node = find(outlineOf('src/bare.js', bare).symbols, 'bare')
  assert.ok(!('comment' in node))

  const capped = ['// ' + 'слово '.repeat(40), 'function longOne() {}'].join('\n')
  const longOne = find(outlineOf('src/long.js', capped).symbols, 'longOne')
  assert.ok(longOne.comment.length <= 120)
  assert.ok(longOne.comment.endsWith('…'))
})
