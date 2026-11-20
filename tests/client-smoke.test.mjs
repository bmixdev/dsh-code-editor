/**
 * Smoke test for the client half.
 *
 * The bundle runs in the browser, so this test evaluates it the way the module
 * loader does — with `window.__ModuleLoader__.load` — and checks that the
 * factory builds a plugin whose registrations match the sidebar slots and the
 * tab type the Host half expects. Rendering itself is out of scope: React is
 * stubbed, so components are never mounted.
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
      const element = { attributes: {}, textContent: '', removed: false, remove() { this.removed = true }, setAttribute(name, value) { this.attributes[name] = value } }
      created.push(element)
      return element
    },
    head: { appendChild() {} },
  }
}

/** Evaluate the bundle through the loader seam and return its plugin object. */
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
    disposers: [],
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
      const dispose = apply()
      host.disposers.push(dispose)
    },
  }
  return host
}

test('the bundle loads through the module loader and returns a plugin', async () => {
  const { definition, plugin } = await loadPlugin()
  assert.equal(definition.id, '@local/dsh-code-editor')
  assert.deepEqual(plugin.inject, ['slots', 'sidebarRight', 'sidebarRightTabs', 'theme'])
  assert.equal(typeof plugin.apply, 'function')
})

test('apply registers the tab type, the slots and the unsaved-close guard', async () => {
  const { plugin } = await loadPlugin()
  const host = createHost()
  plugin.apply(host.ctx)

  assert.deepEqual(host.effects, [
    'dsh-code-editor: styles',
    'dsh-code-editor: tab type',
    'dsh-code-editor: unsaved close guard',
  ])
  assert.equal(host.tabTypes.length, 1)
  assert.equal(host.tabTypes[0].id, '@local/dsh-code-editor')
  assert.equal(host.tabTypes[0].kind, 'dsh-code-editor')
  assert.equal(host.tabTypes[0].priority, 'fallback')

  assert.deepEqual([...host.slotInjections].sort(), [
    'sidebar.right.pane.tab',
    'sidebar.right.pane.tab.title',
    'sidebar.right.tab.document.actions',
  ])
  const pane = host.registrations.find((entry) => entry.config.name === 'sidebar.right.pane.tab')
  assert.equal(pane.config.key, '@local/dsh-code-editor')
  assert.equal(typeof pane.component, 'function')
  const action = host.registrations.find((entry) => entry.config.name === 'sidebar.right.tab.document.actions')
  assert.equal(action.config.id, 'dsh-code-editor.open')
  assert.equal(action.config.order, 20)

  assert.equal(host.closeHandlers.length, 1)
  assert.equal(host.closeHandlers[0].kind, 'dsh-code-editor')
  assert.equal(host.closeHandlers[0].handler('session-1', { id: 'tab-1' }), undefined, 'clean tabs close without a prompt')
})

test('the tab title reads the file name out of the tab address', async () => {
  const { plugin } = await loadPlugin()
  const host = createHost()
  plugin.apply(host.ctx)
  const { title } = host.tabTypes[0]

  assert.equal(title('dsh-resource://file/session/session-1/src/main.ts'), 'main.ts')
  assert.equal(title('dsh-resource://file/session/session-1/src/nested/editor.js'), 'editor.js')
  assert.equal(title('dsh-resource://file/session/session-1/README.md#L4'), 'README.md')
  assert.equal(title('about:blank'), 'Редактор')
})

test('the styles effect installs and removes a style element', async () => {
  const { plugin, document } = await loadPlugin()
  const host = createHost()
  plugin.apply(host.ctx)

  const style = document.created.find((element) => 'data-dsh-code-editor' in element.attributes)
  assert.ok(style, 'the styles effect must append a style element')
  assert.match(style.textContent, /\.dsh-ce-settings\b/)

  host.disposers[0]()
  assert.equal(style.removed, true)
})
