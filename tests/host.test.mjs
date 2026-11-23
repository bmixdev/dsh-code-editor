/**
 * Host-half tests for `@local/dsh-ide`.
 *
 * The plugin is applied to a fake context whose `routes` map collects every
 * Fetch route it registers; each test then calls the route the same way the
 * connection layer does (a POST with a JSON body).
 */
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { apply, rankModels, resetModelCatalog } from '../index.js'

const SESSION_ID = 'session-1'
const ROUTES = [
  'open',
  'save',
  'settings',
  'complete',
  'inlineEdit',
  'searchText',
  'agentChanges',
  'agentChangeDiff',
  'agentChangeRestore',
  'agentChangeText',
  'resolve',
  'tree',
  'files',
  'create',
  'mkdir',
  'rename',
  'remove',
  'state',
  'catalog',
  'credentials',
  'prefs',
]

function errorCode(body) {
  return body.error !== null && typeof body.error === 'object' ? body.error.code : body.error
}

async function makeWorkspace() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-ide-ws-'))
  await mkdir(path.join(root, 'src'))
  await mkdir(path.join(root, 'node_modules'))
  await writeFile(path.join(root, 'README.md'), '# demo\n', 'utf8')
  await writeFile(path.join(root, 'src', 'index.js'), 'export const answer = 42\n', 'utf8')
  await writeFile(path.join(root, 'src', 'util.ts'), 'export const twice = (value: number) => value * 2\n', 'utf8')
  return root
}

function setup({ root, selection = { provider: 'fixture', model: 'fixture-model' }, rejectEffort = '', answer = 'return 1', models = [{ id: 'fixture-model', name: 'Fixture model' }], workspaceChanges }) {
  // The catalog is cached per provider for five minutes, so one test's catalog
  // would leak into the next one and hide a model it added.
  resetModelCatalog()
  const routes = new Map()
  const streamCalls = []
  const listeners = new Map()
  const session = { id: SESSION_ID }
  const ctx = {
    get(name) {
      return name === 'workspaceChanges' ? workspaceChanges : undefined
    },
    on(name, handler) {
      const list = listeners.get(name) ?? []
      list.push(handler)
      listeners.set(name, list)
      return () => listeners.set(name, (listeners.get(name) ?? []).filter((entry) => entry !== handler))
    },
    effect(effect) {
      const cleanup = effect()
      return () => cleanup?.()
    },
    webServer: { register: () => () => {} },
    connection: {
      fetch: {
        register(route) {
          routes.set(route.path, route)
          return () => routes.delete(route.path)
        },
      },
    },
    sessions: { get: (id) => (id === SESSION_ID ? session : undefined), list: () => [session] },
    workingDirectory: { get: () => root },
    sandboxPolicy: { resolve: () => ({ mode: 'workspace-write', workspaceRoot: root }) },
    agentDefaultModel: { currentSelection: () => selection },
    llm: {
      listProviders: () => [{ id: 'fixture', name: 'Fixture' }],
      async listModels() {
        return models
      },
      listConfigurableProviders: () => [],
      // A thinking model advertises opaque effort ids; the completion pins the
      // least one so the hidden reasoning cannot eat the output budget.
      async resolveModelInfo() {
        return { reasoning: { efforts: [{ id: 'low', name: 'Low' }] } }
      },
      async *stream(request) {
        streamCalls.push(request)
        // A route that does not know the adapter-owned `off` level refuses the
        // call before any network I/O; the Host must then retry the next level.
        if (rejectEffort !== '' && request.reasoningEffort === rejectEffort) {
          throw new Error('UNSUPPORTED_REASONING_EFFORT: this route has no such level')
        }
        yield { type: 'text-delta', index: 0, text: answer }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    },
    fs: {
      async resolve(value, { cwd } = {}) {
        return { path: path.resolve(cwd ?? root, value) }
      },
      processPath: (target) => target.path,
      contains: (parent, child) => child.path === parent.path || child.path.startsWith(`${parent.path}${path.sep}`),
      async stat(target) {
        try {
          const stats = await stat(target.path)
          return { type: stats.isDirectory() ? 'directory' : 'file', size: stats.size, mtimeMs: stats.mtimeMs }
        } catch {
          return undefined
        }
      },
      async readBytes(target) {
        return readFile(target.path)
      },
      async writeText(target, text) {
        await writeFile(target.path, text, 'utf8')
        return { version: 'v2', operation: 'replace' }
      },
    },
  }

  apply(ctx)

  async function call(name, body) {
    const route = routes.get(`/api/ide/${name}`)
    assert.ok(route, `route ${name} is registered`)
    const response = await route.fetch(
      new Request(`http://dsh.internal/api/ide/${name}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    )
    return { status: response.status, body: await response.json() }
  }

  /** Deliver one Host event to every listener the plugin registered. */
  function emit(name, ...args) {
    for (const handler of listeners.get(name) ?? []) handler(...args)
  }

  return { call, routes, streamCalls, llm: ctx.llm, emit }
}

async function withFile(variable, name, run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'dsh-ide-env-'))
  const file = path.join(directory, name)
  const previous = process.env[variable]
  process.env[variable] = file
  try {
    await run(file)
  } finally {
    if (previous === undefined) delete process.env[variable]
    else process.env[variable] = previous
    await rm(directory, { recursive: true, force: true })
  }
}

test('apply registers every IDE route under /api/ide', async () => {
  const root = await makeWorkspace()
  try {
    const app = setup({ root })
    for (const name of ROUTES) assert.ok(app.routes.has(`/api/ide/${name}`), `route ${name}`)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('the explorer lists a folder and quick open flattens the workspace', async () => {
  const root = await makeWorkspace()
  try {
    const app = setup({ root })

    const listing = await app.call('tree', { sessionId: SESSION_ID, path: '', hidden: false })
    const names = listing.body.entries.map((entry) => entry.name)
    assert.deepEqual(names, ['src', 'README.md'])
    assert.equal(listing.body.entries[0].type, 'directory')
    assert.equal(listing.body.relativePath, '')

    const nested = await app.call('tree', { sessionId: SESSION_ID, path: 'src', hidden: false })
    assert.deepEqual(nested.body.entries.map((entry) => entry.name), ['index.js', 'util.ts'])

    const outside = await app.call('tree', { sessionId: SESSION_ID, path: '../..' })
    assert.equal(errorCode(outside.body), 'outside-workspace')

    const files = await app.call('files', { sessionId: SESSION_ID, hidden: false })
    const paths = files.body.files.map((entry) => entry.path).sort()
    assert.deepEqual(paths, ['README.md', 'src/index.js', 'src/util.ts'])
    assert.equal(files.body.truncated, false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a new file is created inside the workspace and never overwrites', async () => {
  const root = await makeWorkspace()
  try {
    const app = setup({ root })

    const created = await app.call('create', { sessionId: SESSION_ID, path: 'notes/todo.md' })
    assert.equal(created.status, 200)
    assert.equal(created.body.created, true)
    assert.equal(await readFile(path.join(root, 'notes', 'todo.md'), 'utf8'), '')

    const again = await app.call('create', { sessionId: SESSION_ID, path: 'README.md' })
    assert.equal(errorCode(again.body), 'exists')

    const outside = await app.call('create', { sessionId: SESSION_ID, path: '../escape.txt' })
    assert.equal(errorCode(outside.body), 'bad-request')

    const listing = await app.call('tree', { sessionId: SESSION_ID, path: 'notes' })
    assert.deepEqual(listing.body.entries.map((entry) => entry.name), ['todo.md'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a new folder is created inside the workspace and never replaces one', async () => {
  const root = await makeWorkspace()
  try {
    const app = setup({ root })

    const created = await app.call('mkdir', { sessionId: SESSION_ID, path: 'notes/draft' })
    assert.equal(created.status, 200)
    assert.equal(created.body.created, true)
    const info = await stat(path.join(root, 'notes', 'draft'))
    assert.equal(info.isDirectory(), true)

    const again = await app.call('mkdir', { sessionId: SESSION_ID, path: 'src' })
    assert.equal(errorCode(again.body), 'exists')

    const outside = await app.call('mkdir', { sessionId: SESSION_ID, path: '../escape' })
    assert.equal(errorCode(outside.body), 'bad-request')

    const listing = await app.call('tree', { sessionId: SESSION_ID, path: 'notes' })
    assert.deepEqual(listing.body.entries.map((entry) => entry.name), ['draft'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('rename and remove stay inside the workspace', async () => {
  const root = await makeWorkspace()
  try {
    const app = setup({ root })

    const renamed = await app.call('rename', { sessionId: SESSION_ID, path: 'README.md', to: 'docs/readme.md' })
    assert.equal(renamed.status, 200)
    assert.equal(renamed.body.renamed, true)
    assert.equal(await readFile(path.join(root, 'docs', 'readme.md'), 'utf8'), '# demo\n')

    const clash = await app.call('rename', { sessionId: SESSION_ID, path: 'docs/readme.md', to: 'src/index.js' })
    assert.equal(errorCode(clash.body), 'exists')

    const outside = await app.call('rename', { sessionId: SESSION_ID, path: 'docs/readme.md', to: '../escape.md' })
    assert.equal(errorCode(outside.body), 'bad-request')

    const removed = await app.call('remove', { sessionId: SESSION_ID, path: 'src/util.ts' })
    assert.equal(removed.status, 200)
    assert.equal(removed.body.removed, true)
    await assert.rejects(() => stat(path.join(root, 'src', 'util.ts')))

    const again = await app.call('remove', { sessionId: SESSION_ID, path: 'src/util.ts' })
    assert.equal(errorCode(again.body), 'not-found')

    const rootRemove = await app.call('remove', { sessionId: SESSION_ID, path: '' })
    assert.equal(errorCode(rootRemove.body), 'bad-request')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('the open, save and state routes work together', async () => {
  const root = await makeWorkspace()
  try {
    await withFile('DSH_IDE_STATE', 'ide-state.json', async () => {
      const app = setup({ root })

      const opened = await app.call('open', { sessionId: SESSION_ID, path: 'src/index.js' })
      assert.equal(opened.body.text, 'export const answer = 42\n')
      assert.equal(opened.body.language, 'javascript')
      assert.equal(opened.body.readOnly, false)
      assert.equal(typeof opened.body.token, 'string')

      const saved = await app.call('save', {
        id: opened.body.id,
        sessionId: SESSION_ID,
        token: opened.body.token,
        text: 'export const answer = 43\n',
      })
      assert.equal(typeof saved.body.token, 'string')
      assert.notEqual(saved.body.token, opened.body.token)
      assert.equal(await readFile(path.join(root, 'src', 'index.js'), 'utf8'), 'export const answer = 43\n')

      const initial = await app.call('state', { sessionId: SESSION_ID })
      assert.deepEqual(initial.body.state.tabs, [])
      assert.equal(initial.body.state.treeWidth, 220)
    assert.equal(initial.body.state.panelHeight, 190)
    assert.equal(initial.body.state.explorerSide, 'left')

      const written = await app.call('state', {
        sessionId: SESSION_ID,
        patch: {
        tabs: ['src/index.js', '../outside.js', 'README.md'],
        active: 'README.md',
        treeWidth: 900,
        panelHeight: 900,
        explorerSide: 'right',
        hidden: true,
      },
      })
      assert.deepEqual(written.body.state.tabs, ['src/index.js', 'README.md'])
      assert.equal(written.body.state.active, 'README.md')
      assert.equal(written.body.state.treeWidth, 640)
    assert.equal(written.body.state.panelHeight, 560)
    assert.equal(written.body.state.explorerSide, 'right')
      assert.equal(written.body.state.hidden, true)

      const reread = await app.call('state', { sessionId: SESSION_ID })
      assert.deepEqual(reread.body.state, written.body.state)

      const noSession = await app.call('state', { sessionId: 'unknown' })
      assert.equal(errorCode(noSession.body), 'no-session')
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('preferences are shared with the code-editor plugin', async () => {
  const root = await makeWorkspace()
  try {
    await withFile('DSH_CODE_EDITOR_PREFS', 'code-editor.json', async () => {
      const app = setup({ root })
      const initial = await app.call('prefs', {})
      assert.equal(initial.body.preferences.contextLeft, 4000)
      assert.equal(initial.body.preferences.autoSuggest, true)

      const saved = await app.call('prefs', {
        patch: { completionProvider: 'fixture', completionModel: 'pinned', contextLeft: 1234 },
      })
      assert.equal(saved.body.preferences.completionProvider, 'fixture')
      assert.equal(saved.body.preferences.completionModel, 'pinned')
      assert.equal(saved.body.preferences.contextLeft, 1234)
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a keybinding patch keeps only commands and chords the client can use', async () => {
  const root = await makeWorkspace()
  try {
    await withFile('DSH_CODE_EDITOR_PREFS', 'code-editor.json', async () => {
      const app = setup({ root })
      const saved = await app.call('prefs', {
        patch: {
          keybindings: {
            save: 'Ctrl+Alt+S',
            'inline-edit': 'Ctrl+Shift+K',
            'Bad Id': 'Ctrl+Q',
            ['x'.repeat(41)]: 'Ctrl+Q',
            quote: '',
            search: { chord: 'Ctrl+F' },
          },
        },
      })
      assert.deepEqual(saved.body.preferences.keybindings, {
        save: 'Ctrl+Alt+S',
        'inline-edit': 'Ctrl+Shift+K',
      })
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('the credential route degrades when no credential store is available', async () => {
  const root = await makeWorkspace()
  try {
    const app = setup({ root })
    const status = await app.call('credentials', { op: 'status', ref: 'FIXTURE_API_KEY' })
    assert.equal(status.body.supported, false)
    assert.equal(status.body.configured, false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('the completion permission survives an editor restart', async () => {
  const root = await makeWorkspace()
  try {
    await withFile('DSH_CODE_EDITOR_PREFS', 'code-editor.json', async (file) => {
      const first = setup({ root })
      const opened = await first.call('open', { sessionId: SESSION_ID, path: 'src/index.js' })
      const denied = await first.call('complete', {
        id: opened.body.id,
        sessionId: SESSION_ID,
        token: opened.body.token,
        text: 'export const answer = ',
        offset: 22,
      })
      assert.equal(errorCode(denied.body), 'not-opted-in')

      const enabled = await first.call('settings', { id: opened.body.id, sessionId: SESSION_ID, smartTab: true })
      assert.equal(enabled.body.smartTab, true)
      const stored = JSON.parse(await readFile(file, 'utf8'))
      assert.deepEqual(stored.completionOptIn, [root])

      // A fresh host instance sees only the preferences file — that is a restart.
      const second = setup({ root })
      const reopened = await second.call('open', { sessionId: SESSION_ID, path: 'src/index.js' })
      const allowed = await second.call('complete', {
        id: reopened.body.id,
        sessionId: SESSION_ID,
        token: reopened.body.token,
        text: 'export const answer = ',
        offset: 22,
      })
      assert.equal(allowed.body.text, 'return 1')
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('the completion sends the provider default effort and reports its trajectory', async () => {
  const root = await makeWorkspace()
  try {
    await withFile('DSH_CODE_EDITOR_PREFS', 'code-editor.json', async () => {
      const app = setup({ root })
      const opened = await app.call('open', { sessionId: SESSION_ID, path: 'src/index.js' })
      assert.equal(opened.status, 200)
      await app.call('settings', { id: opened.body.id, sessionId: SESSION_ID, smartTab: true })

      const answered = await app.call('complete', {
        id: opened.body.id,
        sessionId: SESSION_ID,
        token: opened.body.token,
        text: 'export const answer = 42\n',
        offset: 'export const answer = 42\n'.length,
      })
      assert.equal(answered.status, 200)
      assert.equal(answered.body.text, 'return 1')
      // No level is pinned by default: every extra level would cost a rejected
      // request first, and a provider rejects an unknown level before the network.
      assert.equal(app.streamCalls[0].reasoningEffort, undefined)
      // No ceiling by default: the request carries no `maxTokens` at all, so the
      // model stops when it is done. A cap below the model's own limit is what
      // cut the reply in the middle of the edit list.
      assert.equal(app.streamCalls[0].maxTokens, undefined)
      assert.deepEqual(answered.body.trajectory.attempts, ['fixture / fixture-model'])
      assert.equal(answered.body.trajectory.effort, '')
      assert.equal(answered.body.modelSource, 'session')
      assert.equal(answered.body.trajectory.before, 'export const answer = 42\n'.length)
      assert.equal(answered.body.trajectory.finishReason, 'stop')
      assert.equal(Object.hasOwn(answered.body, 'conversation'), false)
      // A typing pause sends the windows around the cursor, not the whole file;
      // the structured request for edits is checked on the explicit path below.
      assert.ok(app.streamCalls[0].messages[0].content[0].text.includes('--- текст до курсора ---'))
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a whole-file answer returns located edits beside the cursor continuation', async () => {
  const root = await makeWorkspace()
  try {
    await withFile('DSH_CODE_EDITOR_PREFS', 'code-editor.json', async () => {
      const app = setup({
        root,
        answer:
          'INSERT:\nreturn answer\nEDITS:\n' +
          '[{"find":"answer = 42","replace":"answer = 43","why":"rename"}]',
      })
      const opened = await app.call('open', { sessionId: SESSION_ID, path: 'src/index.js' })
      await app.call('settings', { id: opened.body.id, sessionId: SESSION_ID, smartTab: true })
      const text = 'export const answer = 42\n'
      const answered = await app.call('complete', {
        id: opened.body.id,
        sessionId: SESSION_ID,
        token: opened.body.token,
        text,
        offset: 0,
        kind: 'explicit',
      })
      assert.equal(answered.status, 200)
      // Even a whole-file request does not echo the file back by default.
      assert.equal(Object.hasOwn(answered.body, 'conversation'), false)
      assert.ok(app.streamCalls[0].messages[0].content[0].text.includes('--- файл целиком; курсор отмечен ⟦КУРСОР⟧ ---'))
      await app.call('prefs', { patch: { fullTrace: true } })
      const detailed = await app.call('complete', { id: opened.body.id, sessionId: SESSION_ID, token: opened.body.token, text, offset: 0, kind: 'explicit' })
      assert.equal(detailed.body.conversation.message, app.streamCalls.at(-1).messages[0].content[0].text)
      assert.equal(detailed.body.conversation.system, app.streamCalls.at(-1).system)
      assert.match(detailed.body.conversation.answer, /EDITS:/)
      // The continuation is the part before EDITS:, without the label and with
      // its indentation intact.
      assert.equal(answered.body.text, 'return answer')
      assert.equal(answered.body.edits.length, 1, JSON.stringify(answered.body).slice(0, 400))
      const edit = answered.body.edits[0]
      assert.equal(text.slice(edit.start, edit.end), 'answer = 42')
      assert.equal(edit.newText, 'answer = 43')
      assert.equal(edit.why, 'rename')
      assert.equal(answered.body.trajectory.edits, 1)
      // Structured or not, an unlimited default means no `maxTokens` field: the
      // reply is bounded by the deadline, not by a number chosen in advance.
      assert.equal(app.streamCalls[0].maxTokens, undefined)
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a route without the off level falls back to the next cheap effort', async () => {
  const root = await makeWorkspace()
  try {
    await withFile('DSH_CODE_EDITOR_PREFS', 'code-editor.json', async () => {
      const app = setup({ root, rejectEffort: 'off' })
      const opened = await app.call('open', { sessionId: SESSION_ID, path: 'src/index.js' })
      await app.call('settings', { id: opened.body.id, sessionId: SESSION_ID, smartTab: true })
      await app.call('prefs', { patch: { completionEffort: 'off' } })
      const saved = await app.call('prefs', {})
      assert.equal(saved.body.preferences.completionEffort, 'off')
      const answered = await app.call('complete', {
        id: opened.body.id,
        sessionId: SESSION_ID,
        token: opened.body.token,
        text: 'export const answer = 42\n',
        offset: 'export const answer = 42\n'.length,
      })
      assert.equal(answered.body.text, 'return 1')
      assert.equal(app.streamCalls[0].reasoningEffort, 'off')
      assert.equal(app.streamCalls[1].reasoningEffort, 'low')
      assert.equal(answered.body.trajectory.effort, 'low')
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('the system instruction is a setting and its placeholders are filled', async () => {
  const root = await makeWorkspace()
  try {
    await withFile('DSH_CODE_EDITOR_PREFS', 'code-editor.json', async () => {
      const app = setup({ root })
      const opened = await app.call('open', { sessionId: SESSION_ID, path: 'src/index.js' })
      await app.call('settings', { id: opened.body.id, sessionId: SESSION_ID, smartTab: true })

      // The drawer shows the shipped instruction as the placeholder of the field.
      const initial = await app.call('prefs', {})
      assert.ok(initial.body.promptDefault.includes('{{answerLines}}'))

      await app.call('complete', {
        id: opened.body.id,
        sessionId: SESSION_ID,
        token: opened.body.token,
        text: 'export const answer = 42\n',
        offset: 'export const answer = 42\n'.length,
      })
      assert.ok(app.streamCalls[0].system.includes('1–5 строк'))
      assert.ok(!app.streamCalls[0].system.includes('{{'))

      const saved = await app.call('prefs', {
        patch: { systemPrompt: 'Дополни {{file}} на {{language}}; не больше {{answerLines}} строк.' },
      })
      assert.equal(saved.status, 200)
      assert.equal(saved.body.preferences.systemPrompt, 'Дополни {{file}} на {{language}}; не больше {{answerLines}} строк.')

      await app.call('complete', {
        id: opened.body.id,
        sessionId: SESSION_ID,
        token: opened.body.token,
        text: 'export const answer = 42\n',
        offset: 'export const answer = 42\n'.length,
        kind: 'explicit',
      })
      // The edit instructions are appended to whatever the user wrote, so the
      // saved text must still open the system message and be fully filled.
      assert.match(app.streamCalls[1].system, /^Дополни .*src[\\/]index\.js на javascript; не больше 5 строк\./)
      assert.ok(app.streamCalls[1].system.includes('EDITS:'))

      // Emptying the field restores the shipped instruction.
      await app.call('prefs', { patch: { systemPrompt: '' } })
      await app.call('complete', {
        id: opened.body.id,
        sessionId: SESSION_ID,
        token: opened.body.token,
        text: 'export const answer = 42\n',
        offset: 'export const answer = 42\n'.length,
      })
      assert.ok(app.streamCalls[2].system.startsWith('Ты — движок строчных подсказок'))
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('an answer that only carries edits is shown, not reported as empty', async () => {
  const root = await makeWorkspace()
  try {
    await withFile('DSH_CODE_EDITOR_PREFS', 'code-editor.json', async () => {
      const app = setup({
        root,
        answer: 'INSERT:\n\nEDITS:\n[{"find":"answer = 42","replace":"answer = 43","why":"rename"}]',
      })
      const opened = await app.call('open', { sessionId: SESSION_ID, path: 'src/index.js' })
      await app.call('settings', { id: opened.body.id, sessionId: SESSION_ID, smartTab: true })
      const text = 'export const answer = 42\n'
      const answered = await app.call('complete', {
        id: opened.body.id,
        sessionId: SESSION_ID,
        token: opened.body.token,
        text,
        offset: text.length,
        kind: 'explicit',
      })
      assert.equal(answered.status, 200)
      // The continuation is empty on purpose: the whole answer is the edit.
      assert.equal(answered.body.text, '')
      assert.equal(answered.body.edits.length, 1, JSON.stringify(answered.body).slice(0, 400))
      // "Nothing came back" would send the user looking for a model problem;
      // the edit is there and Tab will apply it.
      assert.equal(answered.body.reason, '')
      assert.equal(answered.body.suppressed, undefined)
      assert.equal(answered.body.trajectory.suppressed, 'edits-only')
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('auto flush returns buffered text even if the adapter stalls; structured edits wait for finish', { timeout: 5000 }, async () => {
  const root = await makeWorkspace()
  try {
    await withFile('DSH_CODE_EDITOR_PREFS', 'prefs.json', async () => {
      const app = setup({ root })
      const opened = await app.call('open', { sessionId: SESSION_ID, path: 'src/index.js' })
      await app.call('settings', { id: opened.body.id, sessionId: SESSION_ID, smartTab: true })
      await app.call('prefs', { patch: { flushAfterMs: 10, deadlineMs: 1000 } })
      const text = 'const value = '
      const ask = kind => app.call('complete', { id: opened.body.id, sessionId: SESSION_ID, token: opened.body.token, text, offset: text.length, kind })
      let release, seenSignal
      const stalled = new Promise(resolve => { release = resolve })
      app.llm.stream = async function* ({ signal }) {
        seenSignal = signal
        yield { type: 'text-delta', text: '42' }
        await stalled // Simulate a transport that ignores cancellation.
        yield { type: 'text-delta', text: 'late' }
      }
      try {
        const { body } = await ask('auto')
        assert.equal(body.text, '42')
        assert.equal(body.trajectory.flushed, true)
        assert.equal(body.trajectory.streamError, '')
        assert.equal(seenSignal.aborted, true)
      } finally { release() }
      app.llm.stream = async function* () {
        yield { type: 'text-delta', text: 'INSERT:\n' }
        await new Promise(resolve => setTimeout(resolve, 30))
        yield { type: 'text-delta', text: '42\nEDITS:\n[]' }
      }
      const { body } = await ask('explicit')
      assert.equal(body.text, '42')
      assert.equal(body.trajectory.flushed, false)
      resetModelCatalog()
      app.llm.listModels = () => new Promise(() => {})
      const keepAlive = setTimeout(() => {}, 3500)
      try {
        assert.equal((await ask('auto')).body.error.code, 'timeout')
      } finally { clearTimeout(keepAlive) }
    })
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('a typing pause asks for edits only when the setting turns them on', async () => {
  const root = await makeWorkspace()
  try {
    await withFile('DSH_CODE_EDITOR_PREFS', 'code-editor.json', async () => {
      const app = setup({
        root,
        answer:
          'INSERT:\nreturn answer\nEDITS:\n' +
          '[{"find":"answer = 42","replace":"answer = 43","why":"rename"}]',
      })
      const opened = await app.call('open', { sessionId: SESSION_ID, path: 'src/index.js' })
      await app.call('settings', { id: opened.body.id, sessionId: SESSION_ID, smartTab: true })
      const text = 'export const answer = 42\n'
      const ask = (kind = 'auto') =>
        app.call('complete', {
          id: opened.body.id,
          sessionId: SESSION_ID,
          token: opened.body.token,
          text,
          offset: text.length,
          kind,
        })

      // By default a pause buys a fast continuation: the structured reply costs
      // the model a few extra seconds, so it is reserved for an explicit ask.
      const plain = await ask()
      assert.equal(plain.body.edits.length, 0)
      assert.equal(app.streamCalls[0].system.includes('EDITS:'), false)

      await ask('refetch')
      assert.equal(app.streamCalls.at(-1).system.includes('EDITS:'), false)
      await app.call('prefs', { patch: { multiEditAuto: true } })
      const structured = await ask()
      assert.equal(structured.body.edits.length, 1)
      assert.equal(app.streamCalls.at(-1).system.includes('EDITS:'), true)
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a hint can stay on the session model and asks for code without commentary', async () => {
  const root = await makeWorkspace()
  try {
    await withFile('DSH_CODE_EDITOR_PREFS', 'code-editor.json', async () => {
      const app = setup({
        root,
        models: [
          { id: 'fixture-model', name: 'Fixture model' },
          { id: 'fixture-flash', name: 'Fixture flash' },
        ],
      })
      const opened = await app.call('open', { sessionId: SESSION_ID, path: 'src/index.js' })
      await app.call('settings', { id: opened.body.id, sessionId: SESSION_ID, smartTab: true })
      const ask = () =>
        app.call('complete', {
          id: opened.body.id,
          sessionId: SESSION_ID,
          token: opened.body.token,
          text: 'export const answer = 42\n',
          offset: 'export const answer = 42\n'.length,
        })

      // By default a fast sibling is borrowed from the catalog.
      const auto = await ask()
      assert.equal(app.streamCalls[0].model, 'fixture-flash')
      assert.equal(auto.body.trajectory.modelSource, 'auto')

      // Turning that off keeps the user's own model, as asked in the settings.
      await app.call('prefs', { patch: { autoModel: false } })
      const own = await ask()
      assert.equal(app.streamCalls[1].model, 'fixture-model')
      assert.equal(own.body.trajectory.modelSource, 'session')
      // Chat models narrate unless told not to, so the instruction says it.
      assert.match(app.streamCalls[1].system, /Не рассуждай вслух/)
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('an unconfigured hint prefers a fast model over the session one', () => {  // The real catalog of the gateway this machine uses. The session runs on
  // deepseek-v4.1-flash, a thinking model that needs 3.2 s to its first text and
  // often runs into the deadline; glm-5.3-flash answered the same prompt in 0.7 s.
  const catalog = [
    'deepseek-v4.1-flash', 'deepseek-v4-pro', 'glm-5.3', 'glm-5.3-flash', 'grok-4.7',
    'gpt-5.6-luna', 'gpt-6-luna', 'claude-haiku-5-5', 'hy3', 'hy4', 'hy4-preview',
    'hy4-flash-free', 'kimi-k2.7-code', 'kimi-k3', 'kimi-k3.1-pro', 'mimo-v2.6-flash',
    'mimo-v2.6-pro', 'minimax-m3', 'minimax-m3.1-flash', 'longcat-2.0', 'longcat-2.5-free',
    'step-5-preview', 'beam-free', 'qwen3.8-max', 'qwen3.8-flash', 'qwen3.7-plus',
    'qwen4-max', 'gemini-4-argon', 'muse-spark-1.2', 'muse-spark-1.3-contributor',
    'iceman-contributor-free',
  ]
  assert.equal(rankModels(catalog, 'deepseek')[0], 'glm-5.3-flash')
  // A catalog with nothing better than the session model keeps it, so a provider
  // with a single model does not lose its only choice.
  assert.equal(rankModels(['fixture-model'], 'fixture')[0], 'fixture-model')
})

test('inline edit needs its own consent and sends only the selection', async () => {
  const root = await makeWorkspace()
  try {
    await withFile('DSH_CODE_EDITOR_PREFS', 'code-editor.json', async () => {
      const text = 'export const answer = 42\n'
      const app = setup({ root, answer: '{"replacement":"43"}' })

      const opened = await app.call('open', { sessionId: SESSION_ID, path: 'src/index.js' })
      assert.equal(opened.body.text, text)
      const request = {
        id: opened.body.id,
        sessionId: SESSION_ID,
        token: opened.body.token,
        modelVersion: 1,
        start: text.indexOf('42'),
        end: text.indexOf('42') + 2,
        text,
        instruction: 'поставь 43',
      }

      // Tab permission was never granted here, and it would not be enough.
      const denied = await app.call('inlineEdit', request)
      assert.equal(errorCode(denied.body), 'not-opted-in')
      assert.equal(app.streamCalls.length, 0)

      const allowed = await app.call('prefs', { patch: { inlineEditConsent: true } })
      assert.equal(allowed.body.preferences.inlineEditConsent, true)

      const edited = await app.call('inlineEdit', request)
      assert.equal(edited.status, 200)
      assert.equal(edited.body.proposal.documentId, opened.body.id)
      assert.equal(edited.body.proposal.changes.length, 1)
      assert.equal(edited.body.proposal.changes[0].start, text.indexOf('42'))
      assert.equal(edited.body.proposal.changes[0].oldText, '42')
      assert.equal(edited.body.proposal.changes[0].newText, '43')
      assert.equal(edited.body.proposal.result, 'export const answer = 43\n')

      // The prompt carries the frame around the selection and nothing more.
      assert.equal(app.streamCalls.length, 1)
      const sent = app.streamCalls[0].messages[0].content[0].text
      assert.ok(sent.includes('поставь 43'))
      assert.ok(sent.includes('--- фрагмент ---\n42\n--- после фрагмента ---'))
      assert.equal(app.streamCalls[0].purpose, 'code-editor-inline-edit')

      const prose = setup({ root, answer: 'sure!' })
      const reopened = await prose.call('open', { sessionId: SESSION_ID, path: 'src/index.js' })
      const bad = await prose.call('inlineEdit', { ...request, id: reopened.body.id, token: reopened.body.token })
      assert.equal(errorCode(bad.body), 'bad-answer')
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('an empty replacement deletes the selection and an empty one is refused', async () => {
  const root = await makeWorkspace()
  try {
    await withFile('DSH_CODE_EDITOR_PREFS', 'code-editor.json', async () => {
      const text = 'export const answer = 42\n'
      const app = setup({ root, answer: '{"replacement":""}' })
      const opened = await app.call('open', { sessionId: SESSION_ID, path: 'src/index.js' })
      await app.call('prefs', { patch: { inlineEditConsent: true } })

      const removed = await app.call('inlineEdit', {
        id: opened.body.id,
        sessionId: SESSION_ID,
        token: opened.body.token,
        modelVersion: 1,
        start: 0,
        end: text.length,
        text,
        instruction: 'убери всё',
      })
      assert.equal(removed.status, 200)
      assert.equal(removed.body.proposal.changes[0].newText, '')
      assert.equal(removed.body.proposal.result, '')

      // An empty selection is the "highlight some code" hint, not a deletion.
      const empty = await app.call('inlineEdit', {
        id: opened.body.id,
        sessionId: SESSION_ID,
        token: opened.body.token,
        modelVersion: 1,
        start: 3,
        end: 3,
        text,
        instruction: 'убери',
      })
      assert.equal(errorCode(empty.body), 'bad-request')
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('text search answers locally and never calls a model', async () => {
  const root = await makeWorkspace()
  try {
    const app = setup({ root })
    const result = await app.call('searchText', { sessionId: SESSION_ID, query: 'answer' })
    assert.equal(result.status, 200)
    assert.equal(errorCode(result.body), undefined)
    assert.deepEqual(
      result.body.matches.map((match) => ({ path: match.path, line: match.line, column: match.column })),
      [{ path: 'src/index.js', line: 1, column: 14 }],
    )
    assert.equal(result.body.truncated, false)
    // Search is local: nothing about it reaches the provider.
    assert.equal(app.streamCalls.length, 0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('an empty search query is answered without walking the workspace', async () => {
  const root = await makeWorkspace()
  try {
    const app = setup({ root })
    const empty = await app.call('searchText', { sessionId: SESSION_ID, query: '   ' })
    assert.equal(empty.status, 200)
    assert.deepEqual(empty.body, { query: '', matches: [], truncated: false, scanned: 0, bytes: 0 })

    const long = await app.call('searchText', { sessionId: SESSION_ID, query: 'x'.repeat(201) })
    assert.equal(errorCode(long.body), 'bad-request')

    const unknown = await app.call('searchText', { sessionId: 'missing', query: 'answer' })
    assert.equal(errorCode(unknown.body), 'no-session')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('assistant changes say the Host keeps no record instead of claiming none happened', async () => {
  const root = await makeWorkspace()
  try {
    const app = setup({ root })
    const listed = await app.call('agentChanges', { sessionId: SESSION_ID })
    assert.equal(listed.status, 200)
    assert.deepEqual(listed.body, { available: false, turns: [] })

    const missing = await app.call('agentChanges', { sessionId: 'missing' })
    assert.equal(errorCode(missing.body), 'no-session')
    const diff = await app.call('agentChangeDiff', { sessionId: 'missing', seq: 1, index: 0 })
    assert.equal(errorCode(diff.body), 'no-session')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('an announced workspace turn is listed and its file diff comes from the recorder', async () => {
  const root = await makeWorkspace()
  try {
    const summaries = {
      12: {
        turn: 3,
        cwd: root,
        files: [{ path: 'src/index.js', display: 'src/index.js', added: 1, deleted: 1 }],
        total: 1,
        added: 1,
        deleted: 1,
      },
    }
    const diffs = []
    const workspaceChanges = {
      summary: (sessionId, seq) => (sessionId === SESSION_ID ? summaries[seq] : undefined),
      async diff(sessionId, seq, index) {
        diffs.push([sessionId, seq, index])
        return {
          kind: 'text',
          path: 'src/index.js',
          display: 'src/index.js',
          before: true,
          after: true,
          hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-export const answer = 42', '+export const answer = 43'] }],
          coarse: false,
        }
      },
    }
    const app = setup({ root, workspaceChanges })
    // A different SessionEvent must not be indexed as a changes turn.
    app.emit('session/event', { id: SESSION_ID }, { type: 'turn/start', seq: 11, time: 1, data: { turn: 3 } })
    const before = await app.call('agentChanges', { sessionId: SESSION_ID })
    assert.deepEqual(before.body.turns, [])

    app.emit('session/event', { id: SESSION_ID }, { type: 'workspace/changes', seq: 12, time: 2, data: {} })

    const listed = await app.call('agentChanges', { sessionId: SESSION_ID })
    assert.equal(listed.body.available, true)
    assert.equal(listed.body.turns.length, 1)
    assert.equal(listed.body.turns[0].seq, 12)
    assert.equal(listed.body.turns[0].turn, 3)
    assert.equal(listed.body.turns[0].hasSnapshot, false)
    assert.deepEqual(listed.body.turns[0].files, [
      { index: 0, path: 'src/index.js', display: 'src/index.js', added: 1, deleted: 1, binary: false, oversized: false },
    ])

    const diff = await app.call('agentChangeDiff', { sessionId: SESSION_ID, seq: 12, index: 0 })
    assert.equal(diff.status, 200)
    assert.equal(diff.body.diff.hunks[0].lines[1], '+export const answer = 43')
    assert.deepEqual(diffs, [[SESSION_ID, 12, 0]])

    const wrongFile = await app.call('agentChangeDiff', { sessionId: SESSION_ID, seq: 12, index: 5 })
    assert.equal(errorCode(wrongFile.body), 'bad-request')
    const unknownTurn = await app.call('agentChangeDiff', { sessionId: SESSION_ID, seq: 99, index: 0 })
    assert.equal(errorCode(unknownTurn.body), 'not-found')
    assert.equal(diffs.length, 1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a turn file is restored on disk only while its hunks still match', async () => {
  const root = await makeWorkspace()
  try {
    const target = path.join(root, 'src', 'index.js')
    // The workspace holds the turn end, which is what the panel compares against.
    await writeFile(target, 'export const answer = 43\n', 'utf8')
    const workspaceChanges = {
      summary: (sessionId, seq) =>
        sessionId === SESSION_ID && seq === 5
          ? { turn: 1, cwd: root, files: [{ path: 'src/index.js', display: 'src/index.js', added: 1, deleted: 1 }], total: 1, added: 1, deleted: 1 }
          : undefined,
      async diff() {
        return {
          kind: 'text',
          path: 'src/index.js',
          display: 'src/index.js',
          before: true,
          after: true,
          hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-export const answer = 42', '+export const answer = 43'] }],
          coarse: false,
        }
      },
    }
    const app = setup({ root, workspaceChanges })
    app.emit('session/event', { id: SESSION_ID }, { type: 'workspace/changes', seq: 5, time: 1, data: {} })

    const restored = await app.call('agentChangeRestore', { sessionId: SESSION_ID, seq: 5, index: 0 })
    assert.equal(restored.status, 200)
    assert.equal(restored.body.restored, true)
    assert.equal(await readFile(target, 'utf8'), 'export const answer = 42\n')

    // A file edited after the turn must not be rewritten from the snapshot.
    await writeFile(target, 'export const answer = 44\n', 'utf8')
    const conflict = await app.call('agentChangeRestore', { sessionId: SESSION_ID, seq: 5, index: 0 })
    assert.equal(errorCode(conflict.body), 'conflict')
    assert.equal(await readFile(target, 'utf8'), 'export const answer = 44\n')

    const missing = await app.call('agentChangeRestore', { sessionId: 'missing', seq: 5, index: 0 })
    assert.equal(errorCode(missing.body), 'no-session')
    const unknown = await app.call('agentChangeRestore', { sessionId: SESSION_ID, seq: 77, index: 0 })
    assert.equal(errorCode(unknown.body), 'not-found')
    const wrongIndex = await app.call('agentChangeRestore', { sessionId: SESSION_ID, seq: 5, index: 4 })
    assert.equal(errorCode(wrongIndex.body), 'bad-request')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a turn file is served as full before and after texts for a real diff view', async () => {
  const root = await makeWorkspace()
  try {
    const target = path.join(root, 'src', 'index.js')
    await writeFile(target, 'export const answer = 43\n', 'utf8')
    const workspaceChanges = {
      summary: (sessionId, seq) =>
        sessionId === SESSION_ID && seq === 6
          ? { turn: 2, cwd: root, files: [{ path: 'src/index.js', display: 'src/index.js', added: 1, deleted: 1 }], total: 1, added: 1, deleted: 1 }
          : undefined,
      async diff() {
        return {
          kind: 'text',
          path: 'src/index.js',
          display: 'src/index.js',
          before: true,
          after: true,
          hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-export const answer = 42', '+export const answer = 43'] }],
          coarse: false,
        }
      },
    }
    const app = setup({ root, workspaceChanges })
    app.emit('session/event', { id: SESSION_ID }, { type: 'workspace/changes', seq: 6, time: 1, data: {} })

    const text = await app.call('agentChangeText', { sessionId: SESSION_ID, seq: 6, index: 0 })
    assert.equal(text.status, 200)
    assert.deepEqual(text.body, {
      path: 'src/index.js',
      display: 'src/index.js',
      before: 'export const answer = 42\n',
      after: 'export const answer = 43\n',
      coarse: false,
      language: 'javascript',
    })

    // Once the user edits the file the snapshot no longer describes it, so the
    // diff view must refuse instead of inventing a comparison.
    await writeFile(target, 'export const answer = 44\n', 'utf8')
    const conflict = await app.call('agentChangeText', { sessionId: SESSION_ID, seq: 6, index: 0 })
    assert.equal(errorCode(conflict.body), 'conflict')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
