/**
 * Client-half smoke test for `@local/dsh-ide`.
 *
 * Evaluates the bundle through the module-loader seam and checks the
 * registrations the Host half and the sidebar expect. Most tests stub React and
 * never mount a component; the action toggle test uses a minimal hook renderer.
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
        style: {},
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

async function loadPlugin({ react = REACT_STUB, fetch, timers = {}, innerWidth = 1024 } = {}) {
  const source = await readFile(CLIENT_SOURCE, 'utf8')
  const document = createDocument()
  const window = {
    __ModuleLoader__: { load(definition) { this.definition = definition } },
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    innerWidth,
    clearTimeout,
    ...timers,
  }
  const run = new Function('window', 'document', 'fetch', source)
  run(window, document, fetch)

  const definition = window.__ModuleLoader__.definition
  assert.equal(typeof definition?.factory, 'function', 'the bundle must call __ModuleLoader__.load with a factory')

  const plugin = definition.factory((id) => {
    if (id === 'react') return react
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
  assert.match(style.textContent, /\.dsh-ide-action-button\[data-open="true"\]/, 'the action button has an open state')
  assert.match(style.textContent, /\.dsh-ide-action-icon/, 'the action button carries the IDE icon')
  assert.match(style.textContent, /\.dsh-ide-hint-elapsed/, 'the busy spinner carries an elapsed timer in the status bar')
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

test('a multiline continuation reserves editor rows until Escape or Tab', async () => {
  const original = 'if ready:\n    existing()\n'
  let value = original, version = 1, fullReads = 0
  let position = { lineNumber: 1, column: 10 }
  const model = {
    uri: 'test.py',
    getValue: () => { fullReads++; return value },
    getVersionId: () => version,
    getLinesContent: () => value.split('\n'),
    getLineContent: (line) => value.split('\n')[line - 1],
    getOptions: () => ({ tabSize: 4 }),
    getOffsetAt: ({ lineNumber, column }) => value.split('\n').slice(0, lineNumber - 1).join('\n').length + (lineNumber > 1 ? 1 : 0) + column - 1,
    getPositionAt: (offset) => {
      const lines = value.slice(0, offset).split('\n')
      return { lineNumber: lines.length, column: lines.at(-1).length + 1 }
    },
  }
  const zones = new Map()
  const decorations = new Map()
  const commands = new Map()
  const actions = new Map()
  let nextId = 0
  const subscribe = () => ({ dispose() {} })
  let widget, moveCaret, modelChanged
  const editor = {
    focus() {},
    addGlyphMarginWidget: value => { widget = value },
    layoutGlyphMarginWidget: value => assert.equal(value, widget),
    removeGlyphMarginWidget: value => { assert.equal(value, widget); widget = undefined },
    onDidChangeModel: fn => { modelChanged = fn; return subscribe() },
    getModel: () => model,
    getPosition: () => position,
    setPosition: (next) => { position = next },
    addContentWidget() {},
    layoutContentWidget() {},
    deltaDecorations(oldIds, additions) {
      for (const id of oldIds) decorations.delete(id)
      return additions.map((decoration) => {
        decorations.set(++nextId, decoration)
        return nextId
      })
    },
    applyFontInfo() {},
    changeViewZones: (change) => change({
      addZone(zone) { zones.set(++nextId, zone); return nextId },
      removeZone: (id) => zones.delete(id),
    }),
    createContextKey: () => ({ set() {} }),
    addCommand: (key, run) => commands.set(key, run),
    addAction: (action) => {
      actions.set(action.id, action)
      commands.set(`action:${action.id}`, action.run)
      return { dispose() {} }
    },
    onDidChangeModelContent: subscribe,
    onDidBlurEditorWidget: subscribe,
    onDidChangeCursorPosition: fn => { moveCaret = fn; return subscribe() },
    pushUndoStop() {},
    executeEdits(_source, [edit]) {
      value = value.slice(0, edit.range.startColumn - 1) + edit.text + value.slice(edit.range.endColumn - 1)
    },
    dispose() {},
  }
  const monaco = {
    editor: { create: () => editor, ContentWidgetPositionPreference: { EXACT: 0 }, GlyphMarginLane: { Right: 3 } },
    Range: class { constructor(startLineNumber, startColumn, endLineNumber, endColumn) { Object.assign(this, { startLineNumber, startColumn, endLineNumber, endColumn }) } },
    KeyMod: { CtrlCmd: 256, Shift: 512, Alt: 1024 },
    KeyCode: { Space: 1, Tab: 2, Escape: 3, RightArrow: 4, KeyS: 5, KeyW: 6, KeyP: 7, Comma: 8, Backquote: 9, KeyL: 10, KeyC: 11, KeyK: 12 },
  }
  const tabs = [{ key: 'test', hostId: 'test', path: 'test.py' }]
  const insert = '\n\tfirst()\n\n\tsecond()'
  const continuation = { text: insert, range: { start: 9, end: 9 } }
  let reply = continuation
  let onBlur, onContent
  const timers = new Map(), requests = []
  editor.hasTextFocus = () => true
  editor.onDidChangeModelContent = (fn) => { onContent = fn; return subscribe() }
  editor.onDidBlurEditorWidget = (fn) => { onBlur = fn; return subscribe() }
  editor.getSelection = () => null
  editor.getSelections = () => [position]
  const initialStates = [monaco, tabs]
  // The pane now measures itself and watches two media queries before it asks
  // for the editor and the tabs, so those states are found by slot rather than
  // by taking the first two slots.
  const editorSlot = 3
  const tabsSlot = 8
  let slot = 0
  const effects = []
  const { plugin } = await loadPlugin({
    react: {
      ...REACT_STUB,
      useEffect: (run, dependencies) => {
        if (dependencies?.length === 1 && dependencies[0] === monaco) effects.push(run)
      },
      useRef: (initial) => {
        initial?.modelTabs?.set(model.uri, 'test')
        return { current: initial === null ? {} : initial }
      },
      useState: (initial) => {
        const index = slot++
        const injected = index === editorSlot ? initialStates[0] : index === tabsSlot ? initialStates[1] : undefined
        return REACT_STUB.useState(injected === undefined ? initial : injected)
      },
    },
    timers: {
      setTimeout: (fn) => { const id = ++nextId; timers.set(id, fn); return id },
      clearTimeout: (id) => timers.delete(id),
    },
    fetch: async (_url, options) => { requests.push(JSON.parse(options.body)); return { ok: true, json: async () => reply } },
  })
  const host = createHost()
  plugin.apply(host.ctx)
  const pane = host.registrations.find((entry) => entry.config.name === 'sidebar.right.pane.tab')
  pane.component({ tab: { contentId: 'dsh-resource://ide/session/session-1', id: 'tab-1' } })
  const dispose = effects[0]()
  // Inline Edit stays reachable from Monaco's own context menu; the chord moved
  // to the remappable keymap (Ctrl+Shift+K by default) and is dispatched there.
  const inlineAction = actions.get('dsh-ide.inline-edit')
  assert.equal(inlineAction.label, 'Изменить выделение…')
  assert.equal(inlineAction.keybindings, undefined)
  assert.equal(inlineAction.precondition, 'editorTextFocus')
  const request = async () => {
    commands.get(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Space)()
    await new Promise(setImmediate)
  }

  const button = widget.getDomNode()
  const click = () => button.onclick({ stopPropagation() {} })
  assert.match(button.title, /Запросить/)
  assert.equal(button.attributes['aria-label'], button.title)
  let finishCancelled, finishCurrent
  reply = new Promise(resolve => { finishCancelled = resolve })
  click()
  await new Promise(setImmediate)
  assert.equal(button.attributes['data-busy'], 'true')
  click()
  assert.equal(button.attributes['data-busy'], 'false')
  reply = new Promise(resolve => { finishCurrent = resolve })
  click()
  await new Promise(setImmediate)
  finishCancelled(continuation)
  await new Promise(setImmediate)
  assert.equal(button.attributes['data-busy'], 'true', 'late reply cannot extinguish a newer request')
  assert.equal(zones.size, 0)
  finishCurrent(continuation)
  await new Promise(setImmediate)
  assert.equal(button.attributes['data-busy'], 'false')
  assert.equal(zones.size, 1)
  commands.get(monaco.KeyCode.Escape)()
  editor.getModel = () => null
  modelChanged()
  assert.equal(widget, undefined)
  editor.getModel = () => model
  modelChanged()
  assert.equal(widget.getDomNode(), button)
  onContent({ changes: [], versionId: version })
  assert.equal(timers.size, 1, 'typing schedules an automatic request')
  // This transport deliberately ignores AbortSignal to exercise late replies.
  let finishOld
  reply = new Promise(resolve => { finishOld = resolve })
  await request()
  assert.equal(timers.size, 0, 'Ctrl+Space must also remove the pending automatic timer')
  reply = continuation
  await request()
  finishOld({ text: '' })
  await new Promise(setImmediate)
  assert.equal(zones.size, 1, 'an obsolete empty response cannot erase the newer preview')
  commands.get(monaco.KeyCode.Escape)()

  for (const invalidate of [() => commands.get(monaco.KeyCode.Escape)(), () => onBlur(), () => { editor.getModel = () => ({ ...model }) }]) {
    reply = new Promise(resolve => { finishOld = resolve })
    await request()
    invalidate()
    finishOld(continuation)
    await new Promise(setImmediate)
    assert.equal(zones.size, 0, 'a late response cannot recreate an invalidated preview')
    editor.getModel = () => model
  }
  reply = continuation
  await request()
  assert.equal(zones.size, 1, 'the preview must reserve rows above the existing second line')
  const [zone] = zones.values()
  assert.equal(zone.afterLineNumber, 1)
  assert.equal(zone.heightInLines, 3)
  assert.equal(zone.domNode.textContent, '\tfirst()\n\n\tsecond()')
  assert.equal(value, original)
  commands.get(monaco.KeyCode.Escape)()
  assert.equal(zones.size, 0)
  assert.equal(value, original)

  position = { lineNumber: 1, column: 4 }
  reply = { text: 'always_', range: { start: 3, end: 3 } }
  await request()
  assert.equal(zones.size, 0)
  assert.equal([...decorations.values()][0].options.before.content, 'always_')
  assert.equal(value, original)

  reply = { text: 'check(\r\n    ', range: { start: 3, end: 3 } }
  await request()
  assert.equal(decorations.size, 0)
  assert.equal([...zones.values()][0].domNode.textContent, 'if check(\n    ready:')
  assert.equal(value, original)

  position = { lineNumber: 1, column: 10 }
  reply = continuation
  await request()
  assert.equal(zones.size, 1)
  commands.get(monaco.KeyCode.Tab)()
  assert.equal(zones.size, 0)
  assert.equal(value, 'if ready:\n\tfirst()\n\n\tsecond()\n    existing()\n')
  position = { lineNumber: 3, column: 1 }
  moveCaret({ position })
  assert.equal(widget.getPosition().range.startLineNumber, 3)
  // Replay the same typing at the end of small and large documents. No model
  // round trip or full-document read is needed while the typed prefix matches.
  for (const rows of [2, 20000]) {
    value = 'pass\n'.repeat(rows)
    modelChanged()
    const start = value.length
    position = model.getPositionAt(start)
    reply = { text: 'a'.repeat(100) + 'tail', range: { start, end: start } }
    await request()
    const reads = fullReads, calls = requests.length
    const type = text => {
      const offset = value.length, range = { startLineNumber: position.lineNumber, startColumn: position.column, endLineNumber: position.lineNumber, endColumn: position.column }
      value += text
      position = { ...position, column: position.column + text.length }
      onContent({ changes: [{ range, rangeOffset: offset, rangeLength: 0, text }], versionId: ++version, eol: '\n' })
      moveCaret({ position })
    }
    for (let i = 0; i < 100; i++) type('a')
    assert.equal(fullReads, reads)
    assert.equal(requests.length, calls)
    assert.equal([...decorations.values()][0].options.before.content, 'tail')
    type('!')
    assert.equal(decorations.size, 0, 'a mismatching keystroke discards the preview')
    const end = position.column, offset = value.length - 2
    value = value.slice(0, -2)
    position = { ...position, column: end - 2 }
    onContent({ changes: [{ range: { startLineNumber: position.lineNumber, endLineNumber: position.lineNumber, startColumn: end - 2, endColumn: end }, rangeOffset: offset, rangeLength: 2, text: '' }], versionId: ++version, eol: '\n' })
    assert.equal(fullReads, reads)
    await request()
    assert.equal(requests.at(-1).revertions.at(-1).text, 'a!')
  }
  for (const typed of ['ret', 'return result']) {
    value = ''
    modelChanged()
    position = { lineNumber: 1, column: 1 }
    reply = { text: 'return result', range: { start: 0, end: 0 } }
    await request()
    value = typed
    position = { lineNumber: 1, column: 1 + typed.length }
    onContent({ changes: [{ range: new monaco.Range(1, 1, 1, 1), rangeOffset: 0, rangeLength: 0, text: typed }], versionId: ++version, eol: '\n' })
    moveCaret({ position })
    if (typed === 'ret') {
      assert.equal([...decorations.values()][0].options.before.content, 'urn result')
      commands.get(monaco.KeyCode.Tab)()
    }
    assert.equal(value, 'return result', 'Tab must not duplicate the typed prefix')
    assert.equal(decorations.size, 0)
  }
  tabs[0].readOnly = true
  modelChanged()
  assert.equal(widget, undefined, 'a read-only tab has no hint button')
  dispose()
})

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

/** Flattens the stubbed element tree so layout tests can inspect props. */
function collectElements(element, found = []) {
  if (element === null || element === undefined || element === false) return found
  if (typeof element === 'string' || typeof element === 'number') return found
  if (Array.isArray(element)) {
    for (const item of element) collectElements(item, found)
    return found
  }
  if (typeof element.type === 'function') {
    collectElements(element.type({ ...element.props, children: element.children }), found)
    return found
  }
  found.push(element)
  for (const child of element.children ?? []) collectElements(child, found)
  return found
}

function renderPaneElements(plugin, host) {
  const pane = host.registrations.find((entry) => entry.config.name === 'sidebar.right.pane.tab')
  return collectElements(pane.component({ tab: { contentId: 'dsh-resource://ide/session/session-1', id: 'tab-1' } }))
}

test('a wide pane keeps the desktop layout', async () => {
  const { plugin } = await loadPlugin({ innerWidth: 1024 })
  const host = createHost()
  plugin.apply(host.ctx)

  const elements = renderPaneElements(plugin, host)
  const root = elements.find((element) => element.props.className === 'dsh-ide-root')
  assert.ok(root, 'the IDE root is rendered')
  assert.equal(root.props['data-compact'], undefined)
  assert.equal(
    elements.some((element) => element.props.className === 'dsh-ide-scrim'),
    false,
    'a wide pane has no drawer scrim',
  )
})

test('a phone-width pane switches to the compact layout', async () => {
  const { plugin } = await loadPlugin({ innerWidth: 390 })
  const host = createHost()
  plugin.apply(host.ctx)

  const elements = renderPaneElements(plugin, host)
  const root = elements.find((element) => element.props.className === 'dsh-ide-root')
  assert.ok(root, 'the IDE root is rendered')
  assert.equal(root.props['data-compact'], '', 'the root is tagged for the phone stylesheet')

  const classes = elements.map((element) => element.props.className).filter((value) => typeof value === 'string')
  for (const name of ['dsh-ide-mobile-explorer', 'dsh-ide-mobile-menu', 'dsh-ide-mobile-quick', 'dsh-ide-mobile-settings']) {
    assert.ok(classes.some((value) => value.includes(name)), `${name} is rendered`)
  }
  assert.ok(classes.includes('dsh-ide-scrim'), 'the explorer drawer gets a scrim')
  assert.ok(classes.includes('dsh-ide-empty-actions'), 'the empty editor offers phone actions')
  assert.ok(classes.includes('dsh-ide-zoom'), 'the status bar offers a text-size stepper')
  const zoomValue = elements.find((element) => element.props.className === 'dsh-ide-zoom-value')
  assert.ok(zoomValue, 'the current text size is shown')
  assert.equal(zoomValue.children[0], '16px', 'a phone starts with 16px text')
})

test('the stylesheet carries the phone layout rules', async () => {
  const { plugin, document } = await loadPlugin()
  const host = createHost()
  plugin.apply(host.ctx)

  const style = document.created.find((element) => element.attributes['data-dsh-ide'] !== undefined)
  assert.ok(style, 'a style element is injected')
  assert.match(style.textContent, /\[data-compact\]/)
  assert.match(style.textContent, /\.dsh-ide-sheet/)
  assert.match(style.textContent, /safe-area-inset-bottom/)
  assert.match(style.textContent, /min\(88%,\s*340px\)/)
  assert.match(style.textContent, /touch-action:manipulation/)
  assert.match(style.textContent, /\.dsh-ide-zoom-button/)
  assert.match(style.textContent, /\.dsh-ide-empty \{[^}]*z-index:2/, 'the empty-state actions sit above the editor host')
})

function createHookReact() {
  let slots = []
  let effects = []
  let cursor = 0
  let component
  let props
  let tree
  let queued = false

  const sameDeps = (left, right) =>
    Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((value, index) => Object.is(value, right[index]))
  const runEffects = () => {
    for (const effect of effects) {
      if (!effect || (effect.prev !== undefined && sameDeps(effect.prev, effect.deps))) continue
      if (typeof effect.cleanup === 'function') effect.cleanup()
      const cleanup = effect.fn()
      effect.cleanup = typeof cleanup === 'function' ? cleanup : undefined
      effect.prev = effect.deps
    }
  }
  const render = () => {
    cursor = 0
    tree = component(props)
    runEffects()
    return tree
  }
  const schedule = () => {
    if (queued) return
    queued = true
    queueMicrotask(() => {
      queued = false
      render()
    })
  }
  const React = {
    Fragment: 'fragment',
    createElement: (type, elementProps, ...children) => ({ type, props: elementProps ?? {}, children }),
    useState(initial) {
      const index = cursor++
      if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial
      return [
        slots[index],
        (value) => {
          slots[index] = typeof value === 'function' ? value(slots[index]) : value
          schedule()
        },
      ]
    },
    useEffect(fn, deps) {
      const index = cursor++
      const previous = effects[index]
      effects[index] = { fn, deps, prev: previous?.prev, cleanup: previous?.cleanup }
    },
    useCallback: (fn) => fn,
    useMemo: (factory) => factory(),
    useRef: (value) => ({ current: value }),
  }
  return {
    React,
    mount(nextComponent, nextProps) {
      component = nextComponent
      props = nextProps
      slots = []
      effects = []
      queued = false
      render()
      return { getTree: () => tree }
    },
  }
}

function findButton(element) {
  if (element === null || element === undefined || typeof element !== 'object') return undefined
  if (Array.isArray(element)) {
    for (const child of element) {
      const found = findButton(child)
      if (found !== undefined) return found
    }
    return undefined
  }
  if (element.type === 'button') return element
  for (const child of element.children ?? []) {
    const found = findButton(child)
    if (found !== undefined) return found
  }
  return undefined
}

test('the IDE action closes its visible tab on a second press', async () => {
  let tabs = [{ sessionId: 'session-1', tabId: 'tab-1', kind: 'dsh-ide' }]
  let notify = () => {}
  const closed = []
  const renderer = createHookReact()
  const { plugin } = await loadPlugin({ react: renderer.React })
  const host = createHost()
  host.ctx.sidebarRight.openTabs = {
    getSnapshot: () => tabs,
    subscribe(listener) {
      notify = listener
      return () => {}
    },
  }
  host.ctx.sidebarRight.active = () => ({ id: 'tab-1' })
  host.ctx.sidebarRight.isExpanded = () => true
  host.ctx.sidebarRight.closeIn = (sessionId, tabId) => {
    closed.push([sessionId, tabId])
    tabs = []
    notify()
  }
  plugin.apply(host.ctx)

  const action = host.registrations.find((entry) => entry.config.name === 'sidebar.right.tab.document.actions')
  const view = renderer.mount(action.component, { sessionId: 'session-1' })
  await new Promise((resolve) => setTimeout(resolve, 0))
  let button = findButton(view.getTree())
  assert.ok(button, 'the action renders a button')
  assert.equal(button.props['data-open'], 'true', 'the open IDE tab lights the action')
  assert.equal(button.props['aria-pressed'], true)

  button.props.onClick({ currentTarget: {} })
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.deepEqual(closed, [['session-1', 'tab-1']], 'the visible IDE tab is closed')
  button = findButton(view.getTree())
  assert.equal(button.props['data-open'], 'false', 'closing the tab clears the outline')
  assert.equal(button.props['aria-pressed'], false)
})
