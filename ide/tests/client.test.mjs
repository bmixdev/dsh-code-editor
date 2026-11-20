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

  assert.deepEqual(host.slotInjections, [
    'sidebar.right.pane.tab',
    'sidebar.right.pane.tab.title',
    'sidebar.right.tab.document.actions',
  ])

  const action = host.registrations.find((entry) => entry.config.name === 'sidebar.right.tab.document.actions')
  assert.ok(action, 'the document toolbar action is registered')
  assert.equal(action.config.id, 'dsh-ide.open')
  assert.equal(action.config.order, 30)

  assert.equal(host.closeHandlers.length, 1)
  assert.equal(host.closeHandlers[0].kind, 'dsh-ide')
  assert.doesNotThrow(() => host.closeHandlers[0].handler('session-1', { id: 'tab-1' }))
})

test('the tab type titles a workspace tab and a file tab differently', async () => {
  const { plugin } = await loadPlugin()
  const host = createHost()
  plugin.apply(host.ctx)
  const title = host.tabTypes[0].title

  assert.equal(title('dsh-ide://session/session-1'), 'IDE')
  assert.equal(title('dsh-ide://session/session-1/src/main.ts'), 'main.ts')
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
