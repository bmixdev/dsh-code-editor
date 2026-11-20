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

import { apply } from '../index.js'

const SESSION_ID = 'session-1'
const ROUTES = [
  'open',
  'save',
  'settings',
  'complete',
  'resolve',
  'tree',
  'files',
  'create',
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

function setup({ root, selection = { provider: 'fixture', model: 'fixture-model' } }) {
  const routes = new Map()
  const session = { id: SESSION_ID }
  const ctx = {
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
        return [{ id: 'fixture-model', name: 'Fixture model' }]
      },
      listConfigurableProviders: () => [],
      async *stream() {
        yield { type: 'text-delta', index: 0, text: 'return 1' }
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

  return { call, routes }
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

      const written = await app.call('state', {
        sessionId: SESSION_ID,
        patch: { tabs: ['src/index.js', '../outside.js', 'README.md'], active: 'README.md', treeWidth: 900, hidden: true },
      })
      assert.deepEqual(written.body.state.tabs, ['src/index.js', 'README.md'])
      assert.equal(written.body.state.active, 'README.md')
      assert.equal(written.body.state.treeWidth, 640)
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
