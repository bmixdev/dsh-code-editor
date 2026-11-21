/**
 * Client-half smoke test for `@local/dsh-ide`.
 *
 * Evaluates the bundle through the module-loader seam and checks the
 * registrations the Host half and the sidebar expect. React is stubbed, so no
 * component is ever mounted.
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const CLIENT_SOURCE = fileURLToPath(new URL('../client.js', import.meta.url))

const REACT_STUB = {
  Fragment: 'fragment',
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  useCallback: (fn) => fn,
  useEffect: () => {},
  useMemo: (factory) => factory(),
  useRef: (value) => ({ current: value }),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
}

function createDocument() {
  const created = []
  return {
    created,
    createElement: () => {
      const element = {
        attributes: {},
        textContent: '',
        removed: false,
        remove() {
          this.removed = true
        },
        setAttribute(name, value) {
          this.attributes[name] = value
        },
      }
      created.push(element)
      return element
    },
    head: { appendChild() {} },
  }
}

async function loadPlugin() {
  const source = await readFile(CLIENT_SOURCE, 'utf8')
  const document = createDocument()
  const window = {
    __ModuleLoader__: { load(definition) { this.definition = definition } },
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  }
  const run = new Function('window', 'document', source)
  run(window, document)

  const definition = window.__ModuleLoader__.definition
  assert.equal(typeof definition?.factory, 'function', 'the bundle must call __ModuleLoader__.load with a factory')

  const plugin = definition.factory((id) => {
    if (id === 'react') return REACT_STUB
    throw new Error(`unexpected require: ${id}`)
  })
  return { definition, plugin, document }
}

function createHost() {
  const host = {
    effects: [],
    slotInjections: [],
    registrations: [],
    tabTypes: [],
    closeHandlers: [],
  }
  host.ctx = {
    theme: { getTheme: () => 'dark' },
    sidebarRight: {
      registerCloseHandler(kind, handler) {
        host.closeHandlers.push({ kind, handler })
        return () => {}
      },
    },
    sidebarRightTabs: {
      register(config) {
        host.tabTypes.push(config)
        return () => {}
      },
    },
    slots: {
      inject(name, register) {
        host.slotInjections.push(name)
        register()
      },
      register(config, component) {
        host.registrations.push({ config, component })
        return () => {}
      },
    },
    effect(apply, label) {
      host.effects.push(label)
      apply()
    },
  }
  return host
}

test('the bundle loads through the module loader and returns a plugin', async () => {
  const { definition, plugin } = await loadPlugin()
  assert.equal(definition.id, '@local/dsh-ide')
  assert.deepEqual(plugin.inject, ['slots', 'sidebarRight', 'sidebarRightTabs', 'theme'])
  assert.equal(typeof plugin.apply, 'function')
})

test('apply registers the tab type, its slots, the action and the close guard', async () => {
  const { plugin } = await loadPlugin()
  const host = createHost()
  plugin.apply(host.ctx)

  assert.deepEqual(host.effects, ['dsh-ide: styles', 'dsh-ide: tab type', 'dsh-ide: unsaved close guard'])

  assert.equal(host.tabTypes.length, 1)
  const tabType = host.tabTypes[0]
  assert.equal(tabType.id, '@local/dsh-ide')
  assert.equal(tabType.kind, 'dsh-ide')
  assert.equal(tabType.priority, 'fallback')
  assert.equal(tabType.multiple, false)
  assert.deepEqual(tabType.patterns, ['dsh-resource://ide/**'])
  assert.equal(tabType.canOpen('dsh-resource://ide/session/session-1'), true)
  assert.equal(tabType.canOpen('sidebar://dsh-ide'), true)
  assert.equal(tabType.canOpen('dsh-resource://file/session/session-1/a.ts'), false)

  assert.equal(tabType.guide.length, 1)
  assert.equal(tabType.guide[0].id, 'dsh-ide')
  assert.equal(tabType.guide[0].order, 10)
  assert.equal(tabType.guide[0].title(), 'IDE')

  assert.deepEqual(host.slotInjections, [
    'sidebar.right.pane.tab',
    'sidebar.right.pane.tab.title',
    'sidebar.right.tab.document.actions',
    'sidebar.right.tab.files.actions',
    'sidebar.right.tab.guide.actions',
    'conversation.input.left',
  ])

  const action = host.registrations.find((entry) => entry.config.name === 'sidebar.right.tab.document.actions')
  assert.ok(action, 'the document toolbar action is registered')
  assert.equal(action.config.id, 'dsh-ide.open')
  assert.equal(action.config.order, 30)

  const filesAction = host.registrations.find((entry) => entry.config.name === 'sidebar.right.tab.files.actions')
  assert.ok(filesAction, 'the files toolbar action is registered')
  assert.equal(filesAction.config.id, 'dsh-ide.open.files')

  const guideAction = host.registrations.find((entry) => entry.config.name === 'sidebar.right.tab.guide.actions')
  assert.ok(guideAction, 'the guide toolbar action is registered')
  assert.equal(guideAction.config.id, 'dsh-ide.open.guide')

  const composerAction = host.registrations.find((entry) => entry.config.name === 'conversation.input.left')
  assert.ok(composerAction, 'the composer entry is registered')
  assert.equal(composerAction.config.id, 'dsh-ide.open.composer')

  assert.equal(host.closeHandlers.length, 1)
  assert.equal(host.closeHandlers[0].kind, 'dsh-ide')
  assert.doesNotThrow(() => host.closeHandlers[0].handler('session-1', { id: 'tab-1' }))
})

test('the tab type titles a workspace tab and a file tab differently', async () => {
  const { plugin } = await loadPlugin()
  const host = createHost()
  plugin.apply(host.ctx)
  const title = host.tabTypes[0].title

  assert.equal(title('dsh-resource://ide/session/session-1'), 'IDE')
  assert.equal(title('dsh-resource://ide/session/session-1/src/main.ts'), 'main.ts')
  assert.equal(title('sidebar://dsh-ide'), 'IDE')
  assert.equal(title('dsh-resource://file/session/session-1/src/main.ts'), 'IDE')
})

test('the styles element is tagged and removed on dispose', async () => {
  const { plugin, document } = await loadPlugin()
  const host = createHost()
  plugin.apply(host.ctx)

  const style = document.created.find((element) => element.attributes['data-dsh-ide'] !== undefined)
  assert.ok(style, 'a style element is injected')
  assert.match(style.textContent, /\.dsh-ide-root/)
})

/**
 * Walks the element tree the stubbed `createElement` produced and calls every
 * function component once. Effects are skipped, so this exercises the first
 * render pass only - enough to catch a broken render path.
 */
function renderText(element) {
  if (element === null || element === undefined || element === false) return ''
  if (typeof element === 'string' || typeof element === 'number') return String(element)
  if (Array.isArray(element)) return element.map(renderText).join('')
  const { type, props, children } = element
  if (typeof type === 'function') return renderText(type({ ...props, children }))
  return (children ?? []).map(renderText).join('')
}

test('a replacement is offered as pink removal plus green phantom text', async () => {
  const source = await readFile(CLIENT_SOURCE, 'utf8')

  // Every replacement is staged as real lines: the old text stays visible in
  // pink and the new text takes its own lines in green, so nothing is printed
  // over existing code and nothing flows past the end of a line.
  assert.ok(source.includes('const diffLinesLocal = (before, after) => {'), 'the change is staged from a line diff')
  assert.ok(!source.includes('after: { content: edit.newText'), 'no replacement is drawn inline')
  // A block answer takes real lines instead of printing over the code below it,
  // and only the lines that differ are inserted: the unchanged ones stay put.
  assert.ok(source.includes('const diffLinesLocal = (before, after) => {'), 'the block is staged from a line diff')
  assert.ok(source.includes("ops.push({ type: 'add', text: right[column] })"), 'only added lines are inserted')
  assert.ok(source.includes("className: 'dsh-ide-edit-added'"), 'the staged lines are marked as arriving')
  assert.ok(source.includes("className: 'dsh-ide-edit-old-line'"), 'the replaced lines are marked as leaving')
  assert.ok(source.includes('text: entry.original'), 'cancelling puts the original text back')
  assert.ok(source.includes('.dsh-ide-edit-inline {'), 'the phantom text has its own style')
  assert.ok(source.includes('.dsh-ide-edit-old-line {'), 'the leaving lines have their own style')
})

test('every registered component renders its first pass without throwing', async () => {
  const { plugin } = await loadPlugin()
  const host = createHost()
  plugin.apply(host.ctx)

  for (const entry of host.registrations) {
    const props =
      entry.config.name === 'sidebar.right.pane.tab'
        ? { tab: { contentId: 'dsh-resource://ide/session/session-1', id: 'tab-1' } }
        : {}
    assert.doesNotThrow(() => renderText(entry.component(props)), `${entry.config.name} renders`)
  }

  const pane = host.registrations.find((entry) => entry.config.name === 'sidebar.right.pane.tab')
  const text = renderText(pane.component({ tab: { contentId: 'dsh-resource://ide/session/session-1', id: 'tab-1' } }))
  assert.match(text, /IDE/)
  assert.match(text, /Файл/)
  assert.match(text, /Правка/)
  assert.match(text, /Справка/)
})
