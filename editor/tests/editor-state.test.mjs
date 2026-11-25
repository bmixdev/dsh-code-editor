import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { apply } from '../index.js'
import { DEFAULT_PREFERENCES, readPreferences, writePreferences } from '../prefs.js'

const SESSION_ID = 'session-1'

/** The routes report failures as {error:{code,message}}; tests compare codes. */
function errorCode(body) {
  return body.error !== null && typeof body.error === 'object' ? body.error.code : body.error
}

/** A throwaway workspace with the shapes the tree test cares about. */
async function makeWorkspace() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-ce-ws-'))
  await mkdir(path.join(root, 'src'))
  await mkdir(path.join(root, 'node_modules'))
  await mkdir(path.join(root, 'dist'))
  await writeFile(path.join(root, 'README.md'), '# demo\n', 'utf8')
  await writeFile(path.join(root, 'src', 'index.js'), 'export const answer = 42\n', 'utf8')
  await writeFile(path.join(root, 'dist', 'bundle.js'), 'export const built = true\n', 'utf8')
  await writeFile(path.join(root, '.env.example'), 'PLACEHOLDER=1\n', 'utf8')
  return root
}

/**
 * The smallest Host context the new routes need: a real directory for the
 * tree, a fake fs target shape matching the Host service, and stubs for the
 * catalog and credential stores.
 */
function setup({ root, credentials, selection = { provider: 'fixture', model: 'fixture-model' } }) {
  const routes = new Map()
  const streamCalls = []
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
    sessions: { get: id => (id === SESSION_ID ? session : undefined), list: () => [session] },
    workingDirectory: { get: () => root },
    sandboxPolicy: { resolve: () => ({ mode: 'workspace-write', workspaceRoot: root }) },
    agentDefaultModel: { currentSelection: () => selection },
    llm: {
      listProviders: () => [
        { id: 'fixture', name: 'Fixture' },
        { id: 'broken', name: 'Broken' },
      ],
      async listModels(provider) {
        if (provider === 'broken') throw new Error('registry offline')
        return [{ id: 'fixture-model', name: 'Fixture model' }]
      },
      listConfigurableProviders: () => [
        {
          provider: 'fixture',
          displayName: 'Fixture',
          settingsNs: 'llm.fixture',
          settingsPath: [],
          nativeAuth: { env: ['FIXTURE_API_KEY'], oauth: false },
        },
      ],
      async *stream(options) {
        streamCalls.push(options)
        yield { type: 'text-delta', index: 0, text: 'return 1' }
      },
    },
    fs: {
      async resolve(value, { cwd } = {}) {
        return { path: path.resolve(cwd ?? root, value) }
      },
      processPath: target => target.path,
      contains: (parent, child) =>
        child.path === parent.path || child.path.startsWith(`${parent.path}${path.sep}`),
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
    },
  }
  if (credentials !== undefined) ctx.credentials = credentials

  apply(ctx)

  async function call(name, body) {
    const route = routes.get(`/api/code-editor/${name}`)
    assert.ok(route, `route ${name} is registered`)
    const response = await route.fetch(
      new Request(`http://dsh.internal/api/code-editor/${name}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    )
    return { status: response.status, body: await response.json() }
  }

  return { call, streamCalls }
}

/** Point the preference file at a temporary path for the duration of a test. */
async function withPreferences(run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'dsh-ce-prefs-'))
  const file = path.join(directory, 'code-editor.json')
  const previous = process.env.DSH_CODE_EDITOR_PREFS
  process.env.DSH_CODE_EDITOR_PREFS = file
  try {
    await run(file)
  } finally {
    if (previous === undefined) delete process.env.DSH_CODE_EDITOR_PREFS
    else process.env.DSH_CODE_EDITOR_PREFS = previous
    await rm(directory, { recursive: true, force: true })
  }
}

test('preferences round-trip through the route, clamp numbers, and reject long values', async () => {
  const root = await makeWorkspace()
  try {
    await withPreferences(async file => {
      const app = setup({ root })

      const initial = await app.call('prefs', {})
      assert.deepEqual(initial.body.preferences, DEFAULT_PREFERENCES)

      const saved = await app.call('prefs', {
        patch: {
          completionProvider: ' fixture ',
          completionModel: 'pinned-model',
          contextLeft: 999999,
          contextRight: -10,
          fileTree: false,
          autoSuggest: false,
          apiKeyRef: 'FIXTURE_API_KEY',
        },
      })
      assert.equal(saved.status, 200)
      assert.equal(saved.body.preferences.completionProvider, 'fixture')
      assert.equal(saved.body.preferences.contextLeft, 20000)
      assert.equal(saved.body.preferences.contextRight, 0)
      assert.equal(saved.body.preferences.fileTree, false)
      assert.equal(saved.body.preferences.autoSuggest, false)

      const reread = await app.call('prefs', {})
      assert.equal(reread.body.preferences.completionModel, 'pinned-model')

      const stored = await readPreferences()
      assert.equal(stored.apiKeyRef, 'FIXTURE_API_KEY')
      // The preferences file is not a secret store: values never go there.
      const text = await readFile(file, 'utf8')
      assert.ok(!text.includes('sk-'), 'no key material in the preferences file')

      const tooLong = await app.call('prefs', { patch: { completionModel: 'x'.repeat(201) } })
      assert.equal(errorCode(tooLong.body), 'bad-request')
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('tree lists folders before files, shows generated directories, pages a big one, and honours dotfiles', async () => {
  const root = await makeWorkspace()
  try {
    await withPreferences(async () => {
      const app = setup({ root })

      const top = await app.call('tree', { sessionId: SESSION_ID })
      assert.equal(top.status, 200)
      const names = top.body.entries.map(entry => entry.name)
      // Every folder is listed: node_modules and dist are shown like src.
      assert.deepEqual(names, ['dist', 'node_modules', 'src', 'README.md'])
      assert.equal(top.body.entries[0].type, 'directory')
      assert.equal(top.body.entries[0].name, 'dist')
      assert.ok(!names.includes('.env.example'))
      assert.equal(top.body.entries[3].type, 'file')
      assert.equal(typeof top.body.entries[3].size, 'number')

      const first = await app.call('tree', { sessionId: SESSION_ID, offset: 0, limit: 2 })
      assert.deepEqual(first.body.entries.map(entry => entry.name), ['dist', 'node_modules'])
      assert.equal(first.body.total, 4)
      assert.equal(first.body.truncated, true)
      const second = await app.call('tree', { sessionId: SESSION_ID, offset: 2, limit: 2 })
      assert.deepEqual(second.body.entries.map(entry => entry.name), ['src', 'README.md'])
      assert.equal(second.body.truncated, false)

      const nested = await app.call('tree', { sessionId: SESSION_ID, path: 'src' })
      assert.deepEqual(nested.body.entries.map(entry => entry.name), ['index.js'])
      assert.equal(nested.body.relativePath, 'src')

      const dots = await app.call('tree', { sessionId: SESSION_ID, hidden: true })
      assert.ok(dots.body.entries.some(entry => entry.name === '.env.example'))

      const escape = await app.call('tree', { sessionId: SESSION_ID, path: '..' })
      assert.equal(errorCode(escape.body), 'outside-workspace')

      const missing = await app.call('tree', { sessionId: SESSION_ID, path: 'nope' })
      assert.equal(errorCode(missing.body), 'not-found')

      const notFolder = await app.call('tree', { sessionId: SESSION_ID, path: 'README.md' })
      assert.equal(errorCode(notFolder.body), 'not-a-directory')

      const noSession = await app.call('tree', { sessionId: 'other' })
      assert.equal(errorCode(noSession.body), 'no-session')
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('catalog reports models, configurable key names, and provider failures', async () => {
  const root = await makeWorkspace()
  try {
    const app = setup({ root })
    const catalog = await app.call('catalog', {})

    assert.equal(catalog.body.default.provider, 'fixture')
    const fixture = catalog.body.groups.find(group => group.id === 'fixture')
    assert.deepEqual(fixture.models, [{ id: 'fixture-model', name: 'Fixture model' }])
    assert.deepEqual(catalog.body.failures, [{ id: 'broken', name: 'Broken', message: 'registry offline' }])
    assert.deepEqual(catalog.body.configurable, [
      { provider: 'fixture', displayName: 'Fixture', settingsNs: 'llm.fixture', keyNames: ['FIXTURE_API_KEY'] },
    ])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('credentials route validates the key name, stores, reports, and clears', async () => {
  const root = await makeWorkspace()
  const store = new Map()
  const credentials = {
    async describe(ref) {
      return store.has(ref)
        ? { configured: true, source: 'store', writable: true, masked: 'sk-…abcd' }
        : { configured: false, writable: true }
    },
    async set(ref, value) {
      store.set(ref, value)
    },
    async unset(ref) {
      store.delete(ref)
    },
  }
  try {
    const app = setup({ root, credentials })

    const empty = await app.call('credentials', { op: 'status', ref: 'FIXTURE_API_KEY' })
    assert.equal(empty.body.supported, true)
    assert.equal(empty.body.configured, false)

    const badName = await app.call('credentials', { op: 'set', ref: 'not a name', value: 'abc' })
    assert.equal(errorCode(badName.body), 'bad-request')

    const badValue = await app.call('credentials', { op: 'set', ref: 'FIXTURE_API_KEY', value: 'has space' })
    assert.equal(errorCode(badValue.body), 'bad-request')
    assert.equal(store.size, 0)

    const saved = await app.call('credentials', { op: 'set', ref: 'FIXTURE_API_KEY', value: 'sk-live-123' })
    assert.equal(saved.body.configured, true)
    assert.equal(saved.body.masked, 'sk-…abcd')
    assert.equal(store.get('FIXTURE_API_KEY'), 'sk-live-123')

    const cleared = await app.call('credentials', { op: 'clear', ref: 'FIXTURE_API_KEY' })
    assert.equal(cleared.body.configured, false)
    assert.equal(store.size, 0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }

  const withoutStore = await makeWorkspace()
  try {
    const app = setup({ root: withoutStore })
    const status = await app.call('credentials', { op: 'status', ref: 'FIXTURE_API_KEY' })
    assert.equal(status.body.supported, false)
    const set = await app.call('credentials', { op: 'set', ref: 'FIXTURE_API_KEY', value: 'abc' })
    assert.equal(errorCode(set.body), 'no-credentials')
  } finally {
    await rm(withoutStore, { recursive: true, force: true })
  }
})

test('completion uses the provider and model saved in the preferences', async () => {
  const root = await makeWorkspace()
  try {
    await withPreferences(async () => {
      await writePreferences({ completionProvider: 'fixture', completionModel: 'pinned-model' })
      const app = setup({ root, selection: { provider: 'session-provider', model: 'session-model' } })

      const file = path.join(root, 'src', 'index.js')
      const opened = await app.call('open', { sessionId: SESSION_ID, path: file })
      const text = 'export const answer = 4'
      const optedIn = await app.call('settings', {
        id: opened.body.id,
        sessionId: SESSION_ID,
        smartTab: true,
      })
      assert.equal(optedIn.body.smartTab, true)

      const completion = await app.call('complete', {
        id: opened.body.id,
        sessionId: SESSION_ID,
        token: opened.body.token,
        text,
        offset: text.length,
      })

      assert.equal(completion.status, 200)
      assert.equal(completion.body.provider, 'fixture')
      assert.equal(completion.body.model, 'pinned-model')
      assert.equal(app.streamCalls[0].provider, 'fixture')
      assert.equal(app.streamCalls[0].model, 'pinned-model')
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
