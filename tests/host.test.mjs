/**
 * Host-half tests for `@local/dsh-ide`.
 *
 * The plugin is applied to a fake context whose `routes` map collects every
 * Fetch route it registers; each test then calls the route the same way the
 * connection layer does (a POST with a JSON body).
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { apply, rankModels, resetModelCatalog, revealInvocation } from '../index.js'

const SESSION_ID = 'session-1'
const ROUTES = [
  'open',
  'save',
  'settings',
  'complete',
  'inlineEdit',
  'searchText',
  'explore',
  'sessionSearch',
  'sessionExcerpt',
  'sideChat',
  'rules',
  'agentChanges',
  'agentChangeDiff',
  'agentChangeRestore',
  'agentChangeText',
  'scmStatus',
  'scmDiff',
  'scmStage',
  'scmUnstage',
  'scmCommit',
  'scmHistory',
  'scmCommitFiles',
  'scmCommitDiff',
  'scmBranches',
  'scmCompare',
  'scmCreateBranch',
  'scmSwitchBranch',
  'scmDeleteBranch',
  'scmWorktrees',
  'scmCreateWorktree',
  'scmRemoveWorktree',
  'scmPatch',
  'scmReview',
  'scmDraftMessage',
  'scmConflict',
  'runTests',
  'scmResolve',
  'scmResolveApply',
  'planSave',
  'planList',
  'planRead',
  'resolve',
  'tree',
  'files',
  'structure',
  'create',
  'mkdir',
  'rename',
  'remove',
  'reveal',
  'state',
  'termProfiles',
  'termCreate',
  'termWrite',
  'termResize',
  'termKill',
  'termList',
  'termRead',
  'termSuggest',
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
  await mkdir(path.join(root, 'dist'))
  await mkdir(path.join(root, 'build'))
  await writeFile(path.join(root, 'README.md'), '# demo\n', 'utf8')
  await writeFile(path.join(root, 'src', 'index.js'), 'export const answer = 42\n', 'utf8')
  await writeFile(path.join(root, 'src', 'util.ts'), 'export const twice = (value: number) => value * 2\n', 'utf8')
  await writeFile(path.join(root, 'dist', 'bundle.js'), 'export const built = true\n', 'utf8')
  return root
}

function setup({ root, selection = { provider: 'fixture', model: 'fixture-model' }, rejectEffort = '', answer = 'return 1', models = [{ id: 'fixture-model', name: 'Fixture model' }], workspaceChanges, policyMode = 'workspace-write', sessionQuery }) {
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
    sessionQuery,
    workingDirectory: { get: () => root },
    sandboxPolicy: { resolve: () => ({ mode: policyMode, workspaceRoot: root }) },
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

async function removeDirectory(directory) {
  // Windows can report ENOTEMPTY for a recursive delete while a handle is
  // still closing. A short retry is enough; other errors stay visible.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await rm(directory, { recursive: true, force: true })
      return
    } catch (error) {
      if (error.code !== 'ENOTEMPTY' && error.code !== 'EPERM') throw error
      await new Promise((resolve) => setTimeout(resolve, 20 * (attempt + 1)))
    }
  }
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
    await removeDirectory(directory)
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

test('the explorer lists every folder, pages a big one, and quick open flattens the workspace', async () => {
  const root = await makeWorkspace()
  try {
    const app = setup({ root })

    const listing = await app.call('tree', { sessionId: SESSION_ID, path: '', hidden: false })
    const names = listing.body.entries.map((entry) => entry.name)
    // Generated folders are listed like any other: hiding them is not the
    // tree's job, and the client reads only the folders a reader expands.
    assert.deepEqual(names, ['build', 'dist', 'node_modules', 'src', 'README.md'])
    assert.equal(listing.body.entries[0].type, 'directory')
    assert.equal(listing.body.relativePath, '')
    assert.equal(listing.body.total, 5)
    assert.equal(listing.body.truncated, false)

    const first = await app.call('tree', { sessionId: SESSION_ID, path: '', hidden: false, offset: 0, limit: 2 })
    assert.deepEqual(first.body.entries.map((entry) => entry.name), ['build', 'dist'])
    assert.equal(first.body.offset, 0)
    assert.equal(first.body.total, 5)
    assert.equal(first.body.truncated, true)

    const second = await app.call('tree', { sessionId: SESSION_ID, path: '', hidden: false, offset: 2, limit: 2 })
    assert.deepEqual(second.body.entries.map((entry) => entry.name), ['node_modules', 'src'])
    assert.equal(second.body.offset, 2)
    assert.equal(second.body.truncated, true)

    const nested = await app.call('tree', { sessionId: SESSION_ID, path: 'src', hidden: false })
    assert.deepEqual(nested.body.entries.map((entry) => entry.name), ['index.js', 'util.ts'])

    const outside = await app.call('tree', { sessionId: SESSION_ID, path: '../..' })
    assert.equal(errorCode(outside.body), 'outside-workspace')

    const files = await app.call('files', { sessionId: SESSION_ID, hidden: false })
    const paths = files.body.files.map((entry) => entry.path).sort()
    assert.deepEqual(paths, ['README.md', 'dist/bundle.js', 'src/index.js', 'src/util.ts'])
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

test('the reveal command selects the entry without a shell', () => {
  assert.deepEqual(revealInvocation('win32', 'C:\\ws\\src\\index.js'), {
    command: 'explorer.exe',
    args: ['/select,"C:\\ws\\src\\index.js"'],
    options: { windowsVerbatimArguments: true },
  })
  assert.deepEqual(revealInvocation('darwin', '/ws/src/index.js'), { command: 'open', args: ['-R', '/ws/src/index.js'] })
  assert.deepEqual(revealInvocation('linux', path.join('ws', 'src', 'index.js')), {
    command: 'xdg-open',
    args: [path.join('ws', 'src')],
  })
})

test('reveal refuses to leave the workspace or show a missing entry', async () => {
  const root = await makeWorkspace()
  try {
    const app = setup({ root })

    const noSession = await app.call('reveal', { path: 'README.md' })
    assert.equal(errorCode(noSession.body), 'no-session')

    const outside = await app.call('reveal', { sessionId: SESSION_ID, path: '../escape.txt' })
    assert.equal(errorCode(outside.body), 'bad-request')

    const missing = await app.call('reveal', { sessionId: SESSION_ID, path: 'src/gone.js' })
    assert.equal(errorCode(missing.body), 'not-found')
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

test('open decodes legacy encodings and save honours the picked eol and encoding', async () => {
  const root = await makeWorkspace()
  try {
    // UTF-16 LE with a BOM — the sniffer must catch it without any hint.
    // (Node Buffers never write a BOM themselves, so it is prepended by hand.)
    await writeFile(
      path.join(root, 'src', 'legacy.txt'),
      Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('привет мир\nвторой\n', 'utf16le')]),
    )
    // Windows-1251 «привет\nмир\n» — Node Buffers cannot encode it, so the
    // fixture lists the bytes; the Host decodes through TextDecoder.
    await writeFile(
      path.join(root, 'src', 'cp1251.txt'),
      Buffer.from([0xef, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2, 0x0a, 0xec, 0xe8, 0xf0, 0x0a]),
    )
    const app = setup({ root })

    const sniffed = await app.call('open', { sessionId: SESSION_ID, path: 'src/legacy.txt' })
    assert.equal(sniffed.body.encoding, 'utf16le')
    assert.equal(sniffed.body.bom, true)
    assert.equal(sniffed.body.text, 'привет мир\nвторой\n')
    assert.equal(sniffed.body.eol, 'lf')

    const cp1251 = await app.call('open', { sessionId: SESSION_ID, path: 'src/cp1251.txt', encoding: 'windows-1251' })
    assert.equal(cp1251.body.encoding, 'windows-1251')
    assert.equal(cp1251.body.text, 'привет\nмир\n')

    // Saving may switch the EOL and the encoding; both are remembered on the
    // document, so a later save keeps writing the same shape.
    const converted = await app.call('save', {
      id: cp1251.body.id,
      sessionId: SESSION_ID,
      token: cp1251.body.token,
      text: 'строка один\nстрока два\n',
      eol: 'crlf',
      encoding: 'utf8-bom',
    })
    assert.equal(typeof converted.body.token, 'string')
    const bytes = await readFile(path.join(root, 'src', 'cp1251.txt'))
    assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf])
    assert.equal(bytes.toString('utf8'), '\uFEFFстрока один\r\nстрока два\r\n')

    const reopened = await app.call('open', { sessionId: SESSION_ID, path: 'src/cp1251.txt' })
    assert.equal(reopened.body.encoding, 'utf8-bom')
    assert.equal(reopened.body.eol, 'crlf')
    assert.equal(reopened.body.text, 'строка один\nстрока два\n')

    // Anything beyond UTF-8 stays read-and-convert-only: the file system seam
    // writes text, and there is no byte-level write to encode into Windows-1251.
    const refused = await app.call('save', {
      id: reopened.body.id,
      sessionId: SESSION_ID,
      token: reopened.body.token,
      text: 'строка\n',
      encoding: 'windows-1251',
    })
    assert.equal(errorCode(refused.body), 'unsupported-encoding')
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
      assert.equal(initial.body.preferences.showChat, true)

      const saved = await app.call('prefs', {
        patch: { completionProvider: 'fixture', completionModel: 'pinned', contextLeft: 1234 },
      })
      assert.equal(saved.body.preferences.completionProvider, 'fixture')
      assert.equal(saved.body.preferences.completionModel, 'pinned')
      assert.equal(saved.body.preferences.contextLeft, 1234)

      const chatOff = await app.call('prefs', { patch: { showChat: false } })
      assert.equal(chatOff.body.preferences.showChat, false)
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

test('Tab can be disabled for chosen file extensions', async () => {
  const root = await makeWorkspace()
  try {
    await withFile('DSH_CODE_EDITOR_PREFS', 'code-editor.json', async () => {
      const app = setup({ root })
      const initial = await app.call('prefs', {})
      assert.deepEqual(initial.body.preferences.tabDisabledExtensions, [])

      const saved = await app.call('prefs', {
        patch: { tabDisabledExtensions: ['.MD', 'md', 'bad ext', 'txt', 'ts', 'ts'] },
      })
      assert.deepEqual(saved.body.preferences.tabDisabledExtensions, ['md', 'txt', 'ts'])

      const cleared = await app.call('prefs', { patch: { tabDisabledExtensions: [] } })
      assert.deepEqual(cleared.body.preferences.tabDisabledExtensions, [])
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

test('linter diagnostics reach the completion prompt bounded and sanitized', async () => {
  const root = await makeWorkspace()
  try {
    await withFile('DSH_CODE_EDITOR_PREFS', 'code-editor.json', async () => {
      const app = setup({ root })
      const opened = await app.call('open', { sessionId: SESSION_ID, path: 'src/index.js' })
      await app.call('settings', { id: opened.body.id, sessionId: SESSION_ID, smartTab: true })
      const diagnostics = Array.from({ length: 7 }, (_, index) => ({
        line: index + 1,
        column: 3,
        message: index === 0 ? 'NameError: answer is not defined\n' : `warning ${index}`,
      }))
      diagnostics[0].message = `${diagnostics[0].message}${'x'.repeat(400)}`
      const answered = await app.call('complete', {
        id: opened.body.id,
        sessionId: SESSION_ID,
        token: opened.body.token,
        text: 'export const answer = 42\n',
        offset: 'export const answer = 42\n'.length,
        diagnostics,
      })
      assert.equal(answered.status, 200)
      const sent = app.streamCalls[0].messages[0].content[0].text
      assert.ok(sent.includes('--- диагностика ---'))
      assert.ok(sent.includes('Строка 1, столбец 3: NameError: answer is not defined'))
      assert.equal(sent.includes('warning 5'), false)
      assert.ok(sent.length < 3000)
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

test('project rules are listed and the applied ones reach inline edit', async () => {
  const root = await makeWorkspace()
  try {
    await writeFile(path.join(root, 'AGENTS.md'), 'Пиши тесты.\n', 'utf8')
    await mkdir(path.join(root, 'src', 'deep'), { recursive: true })
    await writeFile(path.join(root, 'src', 'CLAUDE.md'), 'Не трогай API.\n', 'utf8')
    await writeFile(path.join(root, 'src', 'deep', 'app.js'), 'let a = 1\n', 'utf8')
    await withFile('DSH_CODE_EDITOR_PREFS', 'code-editor.json', async () => {
      const app = setup({ root, answer: '{"replacement":"2"}' })
      const opened = await app.call('open', { sessionId: SESSION_ID, path: 'src/deep/app.js' })
      assert.equal(opened.status, 200)

      const listed = await app.call('rules', { sessionId: SESSION_ID, id: opened.body.id })
      assert.equal(listed.status, 200)
      assert.equal(listed.body.file, 'src/deep/app.js')
      assert.deepEqual(
        listed.body.rules.map((rule) => rule.path),
        ['AGENTS.md', 'src/CLAUDE.md'],
      )
      assert.ok(listed.body.rules.every((rule) => rule.applied === true))

      // Reading the chain is not consent to send it: the separate Inline Edit
      // gate still applies, and only after it does the system prompt carry rules.
      const denied = await app.call('inlineEdit', {
        id: opened.body.id,
        sessionId: SESSION_ID,
        token: opened.body.token,
        modelVersion: 1,
        start: 8,
        end: 9,
        text: 'let a = 1\n',
        instruction: 'поставь 2',
      })
      assert.equal(errorCode(denied.body), 'not-opted-in')
      assert.equal(app.streamCalls.length, 0)

      await app.call('prefs', { patch: { inlineEditConsent: true } })
      const edited = await app.call('inlineEdit', {
        id: opened.body.id,
        sessionId: SESSION_ID,
        token: opened.body.token,
        modelVersion: 1,
        start: 8,
        end: 9,
        text: 'let a = 1\n',
        instruction: 'поставь 2',
      })
      assert.equal(edited.status, 200)
      assert.deepEqual(edited.body.rules.applied, ['AGENTS.md', 'src/CLAUDE.md'])
      assert.deepEqual(edited.body.rules.skipped, [])
      assert.match(app.streamCalls[0].system, /Пиши тесты\./)
      assert.match(app.streamCalls[0].system, /Не трогай API\./)
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('explore answers from matching lines and cites only them', async () => {
  const root = await makeWorkspace()
  try {
    const answer = 'Ответ в src/index.js:1 — там объявлена константа answer.'
    const app = setup({ root, answer })
    const found = await app.call('explore', { sessionId: SESSION_ID, question: 'где answer?' })
    assert.equal(found.status, 200)
    assert.match(found.body.answer, /src\/index\.js:1/)
    assert.deepEqual(found.body.sources.map((source) => `${source.path}:${source.line}`), ['src/index.js:1'])
    assert.deepEqual(found.body.files, ['src/index.js'])
    assert.equal(app.streamCalls.length, 1)
    assert.match(app.streamCalls[0].messages[0].content[0].text, /src\/index\.js:1:/)
    assert.equal(app.streamCalls[0].purpose, 'code-editor-explore')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('explore filters ignored files before asking the model', async () => {
  const root = await makeWorkspace()
  try {
    await writeFile(path.join(root, 'secret.ts'), 'hidden word\n', 'utf8')
    await writeFile(path.join(root, '.dshideignore'), 'secret.ts\n', 'utf8')
    const app = setup({ root, answer: 'не должно вызываться' })
    const found = await app.call('explore', { sessionId: SESSION_ID, question: 'где hidden?' })
    assert.equal(found.status, 200)
    assert.deepEqual(found.body.sources, [])
    assert.match(found.body.answer, /не нашлось/)
    assert.equal(app.streamCalls.length, 0)

    const empty = await app.call('explore', { sessionId: SESSION_ID, question: '   ' })
    assert.equal(errorCode(empty.body), 'bad-request')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('side chat answers from the selection without touching the file', async () => {
  const root = await makeWorkspace()
  try {
    const app = setup({ root, answer: 'Здесь возвращается 42.' })
    const opened = await app.call('open', { sessionId: SESSION_ID, path: 'src/index.js' })
    const text = opened.body.text
    const start = text.indexOf('42')
    const request = {
      id: opened.body.id,
      sessionId: SESSION_ID,
      start,
      end: start + 2,
      selection: '42',
      question: 'что здесь происходит?',
    }
    const asked = await app.call('sideChat', request)
    assert.equal(asked.status, 200)
    assert.equal(asked.body.answer, 'Здесь возвращается 42.')
    assert.equal(asked.body.path, 'src/index.js')
    assert.equal(app.streamCalls.length, 1)
    assert.equal(app.streamCalls[0].purpose, 'code-editor-side-chat')
    const prompt = app.streamCalls[0].messages[0].content[0].text
    assert.ok(prompt.includes('src/index.js'))
    assert.ok(prompt.includes('42'))
    assert.ok(prompt.includes('что здесь происходит?'))

    const again = await app.call('sideChat', {
      ...request,
      question: 'а почему?',
      history: [{ question: request.question, answer: asked.body.answer }],
    })
    assert.equal(again.status, 200)
    const second = app.streamCalls[1].messages[0].content[0].text
    assert.ok(second.includes('а почему?'))
    assert.ok(second.includes('Здесь возвращается 42.'))

    const empty = await app.call('sideChat', { ...request, start: 5, end: 5, selection: '' })
    assert.equal(errorCode(empty.body), 'bad-request')
    assert.equal(await readFile(path.join(root, 'src/index.js'), 'utf8'), text)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('side chat refuses a selection in an ignored file', async () => {
  const root = await makeWorkspace()
  try {
    await writeFile(path.join(root, 'secret.ts'), 'const token = 1\n', 'utf8')
    await writeFile(path.join(root, '.dshideignore'), 'secret.ts\n', 'utf8')
    const app = setup({ root })
    const opened = await app.call('open', { sessionId: SESSION_ID, path: 'secret.ts' })
    const asked = await app.call('sideChat', {
      id: opened.body.id,
      sessionId: SESSION_ID,
      start: 0,
      end: 5,
      selection: 'const',
      question: 'что это?',
    })
    assert.equal(errorCode(asked.body), 'ignored-file')
    assert.equal(app.streamCalls.length, 0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('content search honours both ignore scopes', async () => {
  const root = await makeWorkspace()
  try {
    await writeFile(path.join(root, 'visible.ts'), 'needle\n', 'utf8')
    await writeFile(path.join(root, 'secret.txt'), 'needle\n', 'utf8')
    await mkdir(path.join(root, 'generated'), { recursive: true })
    await writeFile(path.join(root, 'generated', 'x.ts'), 'needle\n', 'utf8')
    await writeFile(path.join(root, '.dshideignore'), 'secret.txt\n', 'utf8')
    await writeFile(path.join(root, '.dshideindexingignore'), 'generated/\n', 'utf8')
    const app = setup({ root })
    const found = await app.call('searchText', { sessionId: SESSION_ID, query: 'needle' })
    assert.equal(found.status, 200)
    assert.deepEqual(found.body.matches.map((match) => match.path), ['visible.ts'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('cursorignore blocks inline edit and rules, indexing ignore does not', async () => {
  const root = await makeWorkspace()
  try {
    await writeFile(path.join(root, 'AGENTS.md'), 'Пиши тесты.\n', 'utf8')
    await writeFile(path.join(root, '.dshideignore'), 'AGENTS.md\nsrc/index.js\n', 'utf8')
    await writeFile(path.join(root, '.dshideindexingignore'), 'src/util.ts\n', 'utf8')
    await withFile('DSH_CODE_EDITOR_PREFS', 'code-editor.json', async () => {
      const app = setup({ root, answer: '{"replacement":"3"}' })
      await app.call('prefs', { patch: { inlineEditConsent: true } })

      const opened = await app.call('open', { sessionId: SESSION_ID, path: 'src/index.js' })
      const listed = await app.call('rules', { sessionId: SESSION_ID, id: opened.body.id })
      assert.deepEqual(
        listed.body.rules.map((rule) => ({ path: rule.path, reason: rule.reason, applied: rule.applied })),
        [{ path: 'AGENTS.md', reason: 'ignored', applied: false }],
      )
      const blocked = await app.call('inlineEdit', {
        id: opened.body.id,
        sessionId: SESSION_ID,
        token: opened.body.token,
        modelVersion: 1,
        start: 22,
        end: 24,
        text: 'export const answer = 42\n',
        instruction: 'поставь 3',
      })
      assert.equal(errorCode(blocked.body), 'ignored-file')
      assert.equal(app.streamCalls.length, 0)

      const allowedTab = await app.call('open', { sessionId: SESSION_ID, path: 'src/util.ts' })
      const allowed = await app.call('inlineEdit', {
        id: allowedTab.body.id,
        sessionId: SESSION_ID,
        token: allowedTab.body.token,
        modelVersion: 1,
        start: 13,
        end: 18,
        text: 'export const twice = (value: number) => value * 2\n',
        instruction: 'переименуй',
      })
      assert.equal(allowed.status, 200)
      assert.equal(app.streamCalls.length, 1)
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
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

test('ask mode refuses workspace writes at the Host boundary', async () => {
  const root = await makeWorkspace()
  try {
    await withFile('DSH_CODE_EDITOR_PREFS', 'code-editor.json', async () => {
      const app = setup({ root })
      const opened = await app.call('open', { sessionId: SESSION_ID, path: 'src/index.js' })
      const enabled = await app.call('prefs', { patch: { askMode: true } })
      assert.equal(enabled.body.preferences.askMode, true)

      const saved = await app.call('save', {
        id: opened.body.id,
        sessionId: SESSION_ID,
        token: opened.body.token,
        text: 'export const answer = 1\n',
      })
      assert.equal(errorCode(saved.body), 'ask-mode')
      const made = await app.call('mkdir', { sessionId: SESSION_ID, path: 'new-folder' })
      assert.equal(errorCode(made.body), 'ask-mode')
      assert.equal(await readFile(path.join(root, 'src/index.js'), 'utf8'), 'export const answer = 42\n')
      await assert.rejects(readFile(path.join(root, 'new-folder/x')), /ENOENT/)

      await app.call('prefs', { patch: { askMode: false } })
      const again = await app.call('save', {
        id: opened.body.id,
        sessionId: SESSION_ID,
        token: opened.body.token,
        text: 'export const answer = 1\n',
      })
      assert.equal(again.status, 200)
      assert.equal(await readFile(path.join(root, 'src/index.js'), 'utf8'), 'export const answer = 1\n')
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('an inline edit refinement sends the previous exchange', async () => {
  const root = await makeWorkspace()
  try {
    await withFile('DSH_CODE_EDITOR_PREFS', 'code-editor.json', async () => {
      const text = 'export const answer = 42\n'
      const app = setup({ root, answer: '{"replacement":"43"}' })
      const opened = await app.call('open', { sessionId: SESSION_ID, path: 'src/index.js' })
      await app.call('prefs', { patch: { inlineEditConsent: true } })
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
      const first = await app.call('inlineEdit', request)
      assert.equal(first.status, 200)

      const refined = await app.call('inlineEdit', {
        ...request,
        instruction: 'сделай строкой',
        history: [{ instruction: 'поставь 43', answer: '{"replacement":"43"}' }],
      })
      assert.equal(refined.status, 200)
      assert.equal(app.streamCalls.length, 2)
      const messages = app.streamCalls[1].messages
      assert.equal(messages.length, 3)
      assert.equal(messages[0].role, 'user')
      assert.ok(messages[0].content[0].text.includes('поставь 43'))
      assert.equal(messages[1].role, 'assistant')
      assert.equal(messages[1].content[0].text, '{"replacement":"43"}')
      assert.equal(messages[2].role, 'user')
      assert.ok(messages[2].content[0].text.includes('сделай строкой'))
      assert.ok(messages[2].content[0].text.includes('--- фрагмент ---\n42\n--- после фрагмента ---'))

      // A damaged or oversized turn list is refused before the model is asked.
      const broken = await app.call('inlineEdit', {
        ...request,
        history: [{ instruction: '', answer: 'x' }],
      })
      assert.equal(errorCode(broken.body), 'bad-request')
      const tooMany = await app.call('inlineEdit', {
        ...request,
        history: Array.from({ length: 5 }, () => ({ instruction: 'ещё', answer: 'x' })),
      })
      assert.equal(errorCode(tooMany.body), 'bad-request')
      assert.equal(app.streamCalls.length, 2)
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

test('text search forwards regex and whole-word flags', async () => {
  const root = await makeWorkspace()
  try {
    await writeFile(path.join(root, 'src', 'words.txt'), 'answer answers (answer)\n', 'utf8')
    const app = setup({ root })

    const whole = await app.call('searchText', {
      sessionId: SESSION_ID,
      query: 'answer',
      wholeWord: true,
    })
    assert.equal(errorCode(whole.body), undefined)
    assert.deepEqual(
      whole.body.matches.map((match) => ({ path: match.path, line: match.line, column: match.column })),
      [
        { path: 'src/index.js', line: 1, column: 14 },
        { path: 'src/words.txt', line: 1, column: 1 },
        { path: 'src/words.txt', line: 1, column: 17 },
      ],
    )
    assert.ok(whole.body.matches.every((match) => match.match === 'answer'))

    const pattern = await app.call('searchText', {
      sessionId: SESSION_ID,
      query: 'answer\\s*=\\s*42',
      regex: true,
    })
    assert.deepEqual(
      pattern.body.matches.map((match) => ({
        path: match.path,
        line: match.line,
        column: match.column,
        match: match.match,
      })),
      [{ path: 'src/index.js', line: 1, column: 14, match: 'answer = 42' }],
    )
    // Both requests stay local.
    assert.equal(app.streamCalls.length, 0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a malformed pattern is a panel error, not a Host failure', async () => {
  const root = await makeWorkspace()
  try {
    const app = setup({ root })
    const broken = await app.call('searchText', { sessionId: SESSION_ID, query: '(', regex: true })
    assert.equal(broken.status, 200)
    assert.equal(errorCode(broken.body), 'bad-request')
    assert.match(String(broken.body.error.message), /Некорректное регулярное выражение/)
    assert.equal(app.streamCalls.length, 0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a regular expression keeps leading spaces in the query', async () => {
  const root = await makeWorkspace()
  try {
    await writeFile(path.join(root, 'src', 'spaced.txt'), '  answer\n', 'utf8')
    const app = setup({ root })
    const result = await app.call('searchText', {
      sessionId: SESSION_ID,
      query: '^  answer',
      regex: true,
    })
    assert.deepEqual(
      result.body.matches.map((match) => ({ path: match.path, line: match.line, column: match.column })),
      [{ path: 'src/spaced.txt', line: 1, column: 1 }],
    )
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

/** A repository inside a test workspace, with identity and no user config. */
function initRepository(root) {
  const run = (args) =>
    execFileSync(
      'git',
      ['-c', 'core.autocrlf=false', '-c', 'commit.gpgsign=false', ...args],
      { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    )
  run(['init', '-q'])
  run(['symbolic-ref', 'HEAD', 'refs/heads/main'])
  run(['config', 'user.name', 'Тест'])
  run(['config', 'user.email', 'test@example.com'])
  run(['add', '-A'])
  run(['commit', '-q', '-m', 'начало'])
  return run
}

test('scmCompare uses the real merge base, not the branch tip', async () => {
  const root = await makeWorkspace()
  try {
    await writeFile(path.join(root, 'a.txt'), 'one\n', 'utf8')
    const run = initRepository(root)
    run(['checkout', '-q', '-b', 'feature'])
    await writeFile(path.join(root, 'feature.txt'), 'new\n', 'utf8')
    run(['add', '-A'])
    run(['commit', '-q', '-m', 'фича'])
    const app = setup({ root })
    const compared = await app.call('scmCompare', { sessionId: SESSION_ID, base: 'main' })
    assert.equal(compared.status, 200)
    assert.equal(compared.body.base, 'main')
    assert.equal(compared.body.ahead, 1)
    assert.equal(compared.body.behind, 0)
    assert.equal(compared.body.mergeBase, run(['rev-parse', 'main']).trim())
    assert.deepEqual(compared.body.files.map((file) => [file.status, file.path]), [['A', 'feature.txt']])

    const missing = await app.call('scmCompare', { sessionId: SESSION_ID, base: 'nope' })
    assert.equal(errorCode(missing.body), 'not-found')
    const bad = await app.call('scmCompare', { sessionId: SESSION_ID, base: '--all' })
    assert.equal(errorCode(bad.body), 'bad-request')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('the Git panel lists, compares, stages, commits and reads history through routes', async () => {
  const root = await makeWorkspace()
  try {
    const git = initRepository(root)
    const app = setup({ root })

    let status = await app.call('scmStatus', { sessionId: SESSION_ID })
    assert.equal(status.status, 200)
    assert.equal(status.body.branch, 'main')
    assert.equal(status.body.unborn, false)
    assert.deepEqual(status.body.entries, [])
    assert.equal(status.body.readOnly, false)
    const initialRevision = status.body.revision

    const readme = path.join(root, 'README.md')
    await writeFile(readme, '# изменено\n', 'utf8')
    status = await app.call('scmStatus', { sessionId: SESSION_ID })
    const entry = status.body.entries.find((item) => item.path === 'README.md')
    assert.ok(entry)
    assert.equal(entry.worktreeStatus, 'M')
    assert.match(entry.token, /^f:/)
    const revision = status.body.revision
    assert.notEqual(revision, initialRevision)

    const changes = await app.call('scmDiff', {
      sessionId: SESSION_ID,
      group: 'changes',
      path: 'README.md',
      revision,
    })
    assert.equal(changes.status, 200)
    assert.equal(changes.body.diff.kind, 'text')
    assert.equal(changes.body.diff.before, '# demo\n')
    assert.equal(changes.body.diff.after, '# изменено\n')
    assert.equal(changes.body.diff.language, 'markdown')
    assert.equal(changes.body.diff.canOpen, true)

    const stale = await app.call('scmDiff', {
      sessionId: SESSION_ID,
      group: 'changes',
      path: 'README.md',
      revision: initialRevision,
    })
    assert.equal(errorCode(stale.body), 'stale')

    const staged = await app.call('scmStage', {
      sessionId: SESSION_ID,
      group: 'changes',
      path: 'README.md',
      revision,
      token: entry.token,
    })
    assert.equal(staged.status, 200)
    assert.equal(staged.body.status.entries.filter((item) => item.path === 'README.md').length, 1)
    const stagedEntry = staged.body.status.entries[0]
    assert.equal(stagedEntry.indexStatus, 'M')
    assert.equal(stagedEntry.worktreeStatus, '.')

    // A stage request based on the pre-stage list is refused, not replayed.
    const repeated = await app.call('scmStage', {
      sessionId: SESSION_ID,
      group: 'changes',
      path: 'README.md',
      revision,
      token: entry.token,
    })
    assert.equal(errorCode(repeated.body), 'stale')

    const stagedDiff = await app.call('scmDiff', {
      sessionId: SESSION_ID,
      group: 'staged',
      path: 'README.md',
      revision: staged.body.status.revision,
    })
    assert.equal(stagedDiff.body.diff.before, '# demo\n')
    assert.equal(stagedDiff.body.diff.after, '# изменено\n')
    assert.equal(stagedDiff.body.diff.beforeLabel, 'HEAD')

    const unstaged = await app.call('scmUnstage', {
      sessionId: SESSION_ID,
      group: 'staged',
      path: 'README.md',
      revision: staged.body.status.revision,
    })
    assert.equal(unstaged.status, 200)
    assert.equal(unstaged.body.status.entries[0].indexStatus, '.')

    const afterUnstage = await app.call('scmStatus', { sessionId: SESSION_ID })
    const token = afterUnstage.body.entries.find((item) => item.path === 'README.md').token
    const stagedAgain = await app.call('scmStage', {
      sessionId: SESSION_ID,
      group: 'changes',
      path: 'README.md',
      revision: afterUnstage.body.revision,
      token,
    })
    assert.equal(stagedAgain.status, 200)

    const commit = await app.call('scmCommit', {
      sessionId: SESSION_ID,
      message: 'обновить README',
      revision: stagedAgain.body.status.revision,
    })
    assert.equal(commit.status, 200)
    assert.match(commit.body.head, /^[0-9a-f]{40,64}$/)
    assert.deepEqual(commit.body.status.entries, [])

    const staleCommit = await app.call('scmCommit', {
      sessionId: SESSION_ID,
      message: 'ещё раз',
      revision: stagedAgain.body.status.revision,
    })
    assert.equal(errorCode(staleCommit.body), 'stale')
    const emptyCommit = await app.call('scmCommit', {
      sessionId: SESSION_ID,
      message: '   ',
      revision: commit.body.status.revision,
    })
    assert.equal(errorCode(emptyCommit.body), 'bad-request')

    const history = await app.call('scmHistory', { sessionId: SESSION_ID })
    assert.equal(history.status, 200)
    assert.equal(history.body.commits[0].subject, 'обновить README')
    assert.equal(history.body.commits.length, 2)
    const oid = history.body.commits[0].oid
    assert.equal(history.body.commits[0].parents[0], history.body.commits[1].oid)

    const files = await app.call('scmCommitFiles', { sessionId: SESSION_ID, oid })
    assert.equal(files.status, 200)
    assert.deepEqual(
      files.body.entries.map((row) => [row.path, row.status]),
      [['README.md', 'M']],
    )

    const historical = await app.call('scmCommitDiff', {
      sessionId: SESSION_ID,
      oid,
      path: 'README.md',
    })
    assert.equal(historical.status, 200)
    assert.equal(historical.body.diff.before, '# demo\n')
    assert.equal(historical.body.diff.after, '# изменено\n')
    assert.equal(historical.body.diff.language, 'markdown')

    // A later disk edit cannot change what the commit holds.
    await writeFile(readme, '# позже\n', 'utf8')
    const again = await app.call('scmCommitDiff', {
      sessionId: SESSION_ID,
      oid,
      path: 'README.md',
    })
    assert.equal(again.body.diff.after, '# изменено\n')
    assert.ok(git(['rev-parse', 'HEAD']).trim().length >= 40)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a patch route sends only the requested side of one file', async () => {
  const root = await makeWorkspace()
  try {
    const git = initRepository(root)
    const readme = path.join(root, 'README.md')
    await writeFile(readme, '# staged\n', 'utf8')
    git(['add', '--', 'README.md'])
    await writeFile(readme, '# working\n', 'utf8')

    const app = setup({ root })
    const status = await app.call('scmStatus', { sessionId: SESSION_ID })
    const revision = status.body.revision

    const staged = await app.call('scmPatch', { sessionId: SESSION_ID, group: 'staged', revision })
    assert.equal(staged.status, 200)
    assert.match(staged.body.patch, /\+# staged/)
    assert.doesNotMatch(staged.body.patch, /# working/)
    assert.deepEqual(staged.body.files.map((file) => file.path), ['README.md'])

    const changes = await app.call('scmPatch', { sessionId: SESSION_ID, group: 'changes', revision })
    assert.match(changes.body.patch, /\+# working/)
    assert.doesNotMatch(changes.body.patch, /\+# staged/)

    const stale = await app.call('scmPatch', {
      sessionId: SESSION_ID,
      group: 'staged',
      revision: 'nope',
    })
    assert.equal(errorCode(stale.body), 'stale')
    const badGroup = await app.call('scmPatch', { sessionId: SESSION_ID, group: 'conflicts' })
    assert.equal(errorCode(badGroup.body), 'bad-request')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('the conflict routes read both sides, propose text and write it only on apply', async () => {
  const root = await makeWorkspace()
  try {
    const git = initRepository(root)
    const readme = path.join(root, 'README.md')
    git(['checkout', '-q', '-b', 'feature'])
    await writeFile(readme, '# feature\n', 'utf8')
    git(['add', '--', 'README.md'])
    git(['commit', '-q', '-m', 'feature'])
    git(['checkout', '-q', 'main'])
    await writeFile(readme, '# main\n', 'utf8')
    git(['add', '--', 'README.md'])
    git(['commit', '-q', '-m', 'main'])
    assert.throws(() => git(['merge', 'feature']))
    const conflictedText = await readFile(readme, 'utf8')
    assert.match(conflictedText, /^<<<<<<< HEAD/m)

    const app = setup({ root, answer: '# итог\n' })
    let status = await app.call('scmStatus', { sessionId: SESSION_ID })
    const conflictRow = status.body.entries.find((entry) => entry.kind === 'conflict')
    assert.ok(conflictRow)
    assert.equal(conflictRow.path, 'README.md')

    const view = await app.call('scmConflict', {
      sessionId: SESSION_ID,
      path: 'README.md',
      revision: status.body.revision,
    })
    assert.equal(view.status, 200)
    assert.equal(view.body.conflict.base, '# demo\n')
    assert.equal(view.body.conflict.ours, '# main\n')
    assert.equal(view.body.conflict.theirs, '# feature\n')

    const proposal = await app.call('scmResolve', {
      sessionId: SESSION_ID,
      path: 'README.md',
      revision: status.body.revision,
    })
    assert.equal(proposal.status, 200)
    assert.equal(proposal.body.resolution, '# итог')
    assert.equal(proposal.body.provider, 'fixture')
    assert.equal(proposal.body.model, 'fixture-model')
    assert.equal(await readFile(readme, 'utf8'), conflictedText)
    const prompt = app.streamCalls.at(-1).messages[0].content[0].text
    assert.match(prompt, /--- base ---/)
    assert.match(prompt, /# feature/)
    assert.match(prompt, /# main/)

    const stale = await app.call('scmResolveApply', {
      sessionId: SESSION_ID,
      path: 'README.md',
      text: proposal.body.resolution,
      revision: 'nope',
    })
    assert.equal(errorCode(stale.body), 'stale')

    const applied = await app.call('scmResolveApply', {
      sessionId: SESSION_ID,
      path: 'README.md',
      text: proposal.body.resolution,
      revision: proposal.body.revision,
    })
    assert.equal(applied.status, 200)
    assert.match(applied.body.oid, /^[0-9a-f]{40,64}$/)
    assert.equal(await readFile(readme, 'utf8'), '# итог')
    assert.equal(applied.body.status.entries.some((entry) => entry.kind === 'conflict'), false)
    status = await app.call('scmStatus', { sessionId: SESSION_ID })
    assert.equal(status.body.entries.some((entry) => entry.kind === 'conflict'), false)
    assert.deepEqual(
      status.body.entries.map((entry) => [entry.path, entry.indexStatus]),
      [['README.md', 'M']],
    )

    const again = await app.call('scmResolveApply', {
      sessionId: SESSION_ID,
      path: 'README.md',
      text: 'x\n',
      revision: applied.body.status.revision,
    })
    assert.equal(errorCode(again.body), 'not-conflict')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('conflict resolution refuses a read-only workspace and a clean file', async () => {
  const root = await makeWorkspace()
  try {
    initRepository(root)
    const app = setup({ root, policyMode: 'read-only' })
    const status = await app.call('scmStatus', { sessionId: SESSION_ID })
    const refused = await app.call('scmResolve', {
      sessionId: SESSION_ID,
      path: 'README.md',
      revision: status.body.revision,
    })
    assert.equal(errorCode(refused.body), 'read-only')
    const apply = await app.call('scmResolveApply', {
      sessionId: SESSION_ID,
      path: 'README.md',
      text: 'x\n',
      revision: status.body.revision,
    })
    assert.equal(errorCode(apply.body), 'read-only')

    const writable = setup({ root })
    const clean = await writable.call('scmConflict', { sessionId: SESSION_ID, path: 'README.md' })
    assert.equal(errorCode(clean.body), 'not-conflict')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('the Git panel creates, switches and deletes branches through routes', async () => {
  const root = await makeWorkspace()
  try {
    initRepository(root)
    const app = setup({ root })

    let branches = await app.call('scmBranches', { sessionId: SESSION_ID })
    assert.equal(branches.status, 200)
    assert.equal(branches.body.current, 'main')
    assert.deepEqual(branches.body.branches.map((branch) => branch.name), ['main'])

    const created = await app.call('scmCreateBranch', { sessionId: SESSION_ID, name: 'feature' })
    assert.equal(created.status, 200)
    assert.equal(created.body.status.branch, 'feature')
    assert.equal(created.body.branches.current, 'feature')
    assert.deepEqual(created.body.branches.branches.map((branch) => branch.name), ['feature', 'main'])

    const switched = await app.call('scmSwitchBranch', { sessionId: SESSION_ID, name: 'main' })
    assert.equal(switched.status, 200)
    assert.equal(switched.body.status.branch, 'main')

    await app.call('scmCreateBranch', { sessionId: SESSION_ID, name: 'temporary' })
    await app.call('scmSwitchBranch', { sessionId: SESSION_ID, name: 'main' })
    const deleted = await app.call('scmDeleteBranch', { sessionId: SESSION_ID, name: 'temporary' })
    assert.equal(deleted.status, 200)
    assert.deepEqual(deleted.body.branches.branches.map((branch) => branch.name), ['feature', 'main'])

    const current = await app.call('scmDeleteBranch', { sessionId: SESSION_ID, name: 'main' })
    assert.equal(errorCode(current.body), 'branch-current')

    const invalid = await app.call('scmCreateBranch', { sessionId: SESSION_ID, name: 'bad..name' })
    assert.equal(errorCode(invalid.body), 'bad-request')
    const missing = await app.call('scmSwitchBranch', { sessionId: SESSION_ID, name: 'missing' })
    assert.equal(errorCode(missing.body), 'not-found')

    const readOnly = setup({ root, policyMode: 'read-only' })
    const refused = await readOnly.call('scmCreateBranch', { sessionId: SESSION_ID, name: 'blocked' })
    assert.equal(errorCode(refused.body), 'read-only')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('worktrees are created, listed and removed inside the workspace', async () => {
  const root = await makeWorkspace()
  try {
    initRepository(root)
    const app = setup({ root })

    const initial = await app.call('scmWorktrees', { sessionId: SESSION_ID })
    assert.equal(initial.status, 200)
    assert.equal(initial.body.worktrees.length, 1)
    assert.equal(initial.body.worktrees[0].current, true)

    const created = await app.call('scmCreateWorktree', {
      sessionId: SESSION_ID,
      path: 'task-copy',
      branch: 'task',
      create: true,
    })
    assert.equal(created.status, 200)
    assert.equal(created.body.path, path.join(root, 'task-copy'))
    assert.equal(created.body.worktrees.length, 2)
    assert.equal(created.body.worktrees.filter((item) => !item.current)[0].branch, 'task')

    const removed = await app.call('scmRemoveWorktree', {
      sessionId: SESSION_ID,
      path: path.join(root, 'task-copy'),
    })
    assert.equal(removed.status, 200)
    assert.equal(removed.body.worktrees.length, 1)

    const escape = await app.call('scmCreateWorktree', {
      sessionId: SESSION_ID,
      path: '../outside',
      branch: 'outside',
      create: true,
    })
    assert.equal(errorCode(escape.body), 'bad-request')

    const outside = await app.call('scmRemoveWorktree', {
      sessionId: SESSION_ID,
      path: path.join(root, '..', 'outside'),
    })
    assert.equal(errorCode(outside.body), 'outside-workspace')

    const readOnly = setup({ root, policyMode: 'read-only' })
    const refused = await readOnly.call('scmCreateWorktree', {
      sessionId: SESSION_ID,
      path: 'blocked',
      branch: 'blocked',
      create: true,
    })
    assert.equal(errorCode(refused.body), 'read-only')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('the Git panel refuses a nested folder, a non-repository and read-only writes', async () => {
  const root = await makeWorkspace()
  try {
    const app = setup({ root })
    const missing = await app.call('scmStatus', { sessionId: SESSION_ID })
    assert.equal(errorCode(missing.body), 'not-repository')

    initRepository(root)
    await writeFile(path.join(root, 'README.md'), '# изменено\n', 'utf8')

    const nested = setup({ root: path.join(root, 'src') })
    const refused = await nested.call('scmStatus', { sessionId: SESSION_ID })
    assert.equal(errorCode(refused.body), 'not-root')

    const readOnly = setup({ root, policyMode: 'read-only' })
    const status = await readOnly.call('scmStatus', { sessionId: SESSION_ID })
    assert.equal(status.status, 200)
    assert.equal(status.body.readOnly, true)
    assert.equal(status.body.entries.length, 1)
    const written = await readOnly.call('scmStage', {
      sessionId: SESSION_ID,
      group: 'changes',
      path: 'README.md',
      revision: status.body.revision,
      token: status.body.entries[0].token,
    })
    assert.equal(errorCode(written.body), 'read-only')

    const noSession = await app.call('scmStatus', { sessionId: 'missing' })
    assert.equal(errorCode(noSession.body), 'no-session')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('the chat patch carries the index alone when a file has staged and unstaged edits', async () => {
  const root = await makeWorkspace()
  try {
    initRepository(root)
    const app = setup({ root })
    const readme = path.join(root, 'README.md')
    await writeFile(readme, '# staged\n', 'utf8')
    execFileSync('git', ['add', '--', 'README.md'], { cwd: root })
    await writeFile(readme, '# unstaged\n', 'utf8')

    const status = await app.call('scmStatus', { sessionId: SESSION_ID })
    const revision = status.body.revision
    const staged = await app.call('scmPatch', { sessionId: SESSION_ID, group: 'staged', revision })
    assert.equal(staged.status, 200)
    assert.match(staged.body.patch, /\+# staged/)
    assert.doesNotMatch(staged.body.patch, /unstaged/)
    assert.deepEqual(staged.body.files.map((file) => file.path), ['README.md'])
    assert.equal(staged.body.revision, revision)
    assert.ok(staged.body.bytes > 0)

    const changes = await app.call('scmPatch', { sessionId: SESSION_ID, group: 'changes', revision })
    assert.match(changes.body.patch, /\+# unstaged/)
    assert.match(changes.body.patch, /-# staged/)

    const stale = await app.call('scmPatch', {
      sessionId: SESSION_ID,
      group: 'staged',
      revision: '0'.repeat(64),
    })
    assert.equal(errorCode(stale.body), 'stale')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a review sends only the index and keeps findings that point into it', async () => {
  const root = await makeWorkspace()
  try {
    initRepository(root)
    const answer = JSON.stringify({
      findings: [
        { path: 'README.md', line: 1, severity: 'high', message: 'Заголовок потерял точку' },
        { path: 'nope.txt', line: 1, severity: 'low', message: 'Файла нет в патче' },
        { path: 'README.md', line: 99, severity: 'low', message: 'Строки нет в патче' },
      ],
    })
    const app = setup({ root, answer })
    const readme = path.join(root, 'README.md')
    await writeFile(readme, '# staged\n', 'utf8')
    execFileSync('git', ['add', '--', 'README.md'], { cwd: root })
    await writeFile(readme, '# unstaged\n', 'utf8')

    let status = await app.call('scmStatus', { sessionId: SESSION_ID })
    const review = await app.call('scmReview', { sessionId: SESSION_ID, revision: status.body.revision })
    assert.equal(review.status, 200)
    assert.equal(review.body.findings.length, 1)
    assert.equal(review.body.findings[0].path, 'README.md')
    assert.equal(review.body.findings[0].line, 1)
    assert.equal(review.body.findings[0].severity, 'high')
    assert.equal(review.body.provider, 'fixture')
    assert.equal(app.streamCalls.length, 1)
    const sent = app.streamCalls[0]
    assert.equal(sent.purpose, 'code-editor-scm-review')
    const text = sent.messages[0].content[0].text
    assert.match(text, /\+# staged/)
    assert.doesNotMatch(text, /unstaged/)

    const stale = await app.call('scmReview', {
      sessionId: SESSION_ID,
      revision: '0'.repeat(64),
    })
    assert.equal(errorCode(stale.body), 'stale')
    assert.equal(app.streamCalls.length, 1)

    const broken = setup({ root, answer: 'это не JSON' })
    status = await broken.call('scmStatus', { sessionId: SESSION_ID })
    const badAnswer = await broken.call('scmReview', {
      sessionId: SESSION_ID,
      revision: status.body.revision,
    })
    assert.equal(errorCode(badAnswer.body), 'bad-answer')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('deep review splits a large index into bounded calls', async () => {
  const root = await makeWorkspace()
  try {
    initRepository(root)
    const answer = JSON.stringify({
      findings: [{ path: 'big.txt', line: 1, severity: 'medium', message: 'Проверить первую строку' }],
    })
    const app = setup({ root, answer })
    const lines = Array.from({ length: 1200 }, (_, index) => `line ${index + 1} ${'x'.repeat(20)}`)
    await writeFile(path.join(root, 'big.txt'), `${lines.join('\n')}\n`, 'utf8')
    await writeFile(path.join(root, 'small.txt'), 'small\n', 'utf8')
    execFileSync('git', ['add', '--', 'big.txt', 'small.txt'], { cwd: root })

    const status = await app.call('scmStatus', { sessionId: SESSION_ID })
    const review = await app.call('scmReview', {
      sessionId: SESSION_ID,
      revision: status.body.revision,
      depth: 'deep',
    })
    assert.equal(review.status, 200, JSON.stringify(review.body))
    assert.equal(review.body.depth, 'deep')
    assert.ok(review.body.calls >= 2)
    assert.equal(app.streamCalls.length, review.body.calls)
    assert.ok(review.body.findings.some((finding) => finding.path === 'big.txt'))

    const quick = setup({ root, answer })
    const single = await quick.call('scmReview', {
      sessionId: SESSION_ID,
      revision: status.body.revision,
    })
    assert.equal(single.body.depth, 'quick')
    assert.equal(single.body.calls, 1)
    assert.equal(quick.streamCalls.length, 1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a review refuses read-only and a clean index without calling the model', async () => {
  const root = await makeWorkspace()
  try {
    initRepository(root)
    const app = setup({ root })
    const status = await app.call('scmStatus', { sessionId: SESSION_ID })
    const clean = await app.call('scmReview', {
      sessionId: SESSION_ID,
      revision: status.body.revision,
    })
    assert.equal(errorCode(clean.body), 'nothing-staged')
    assert.equal(app.streamCalls.length, 0)

    const readOnly = setup({ root, policyMode: 'read-only' })
    const refused = await readOnly.call('scmReview', {
      sessionId: SESSION_ID,
      revision: status.body.revision,
    })
    assert.equal(errorCode(refused.body), 'read-only')
    assert.equal(readOnly.streamCalls.length, 0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a commit message is drafted from the index and nothing is committed', async () => {
  const root = await makeWorkspace()
  try {
    initRepository(root)
    const app = setup({ root, answer: 'Обновить README\n\nОписание изменения.' })
    const readme = path.join(root, 'README.md')
    await writeFile(readme, '# staged\n', 'utf8')
    execFileSync('git', ['add', '--', 'README.md'], { cwd: root })
    const status = await app.call('scmStatus', { sessionId: SESSION_ID })
    const before = execFileSync('git', ['rev-list', '--count', 'HEAD'], { cwd: root, encoding: 'utf8' })

    const draft = await app.call('scmDraftMessage', {
      sessionId: SESSION_ID,
      revision: status.body.revision,
    })
    assert.equal(draft.status, 200)
    assert.equal(draft.body.message, 'Обновить README\n\nОписание изменения.')
    assert.deepEqual(draft.body.files.map((file) => file.path), ['README.md'])
    assert.equal(app.streamCalls[0].purpose, 'code-editor-scm-message')
    const after = execFileSync('git', ['rev-list', '--count', 'HEAD'], { cwd: root, encoding: 'utf8' })
    assert.equal(after, before)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('saved plans round-trip through the routes', async () => {
  const root = await makeWorkspace()
  const file = path.join(root, 'plans.json')
  const previous = process.env.DSH_CODE_EDITOR_PLANS
  process.env.DSH_CODE_EDITOR_PLANS = file
  try {
    const app = setup({ root })
    const empty = await app.call('planList', { sessionId: SESSION_ID })
    assert.equal(empty.status, 200)
    assert.deepEqual(empty.body.plans, [])

    const text = 'Подготовить план изменения: заменить 42 на 43.'
    const title = 'src/index.js:1-2'
    const saved = await app.call('planSave', {
      sessionId: SESSION_ID,
      title,
      text,
      path: 'src/index.js',
      from: 1,
      to: 2,
    })
    assert.equal(saved.status, 200)
    assert.equal(saved.body.title, title)
    assert.equal(saved.body.path, 'src/index.js')
    assert.equal(saved.body.from, 1)
    assert.equal(saved.body.to, 2)
    assert.equal(saved.body.chars, text.length)

    const listed = await app.call('planList', { sessionId: SESSION_ID })
    assert.equal(listed.status, 200)
    assert.deepEqual(listed.body.plans, [saved.body])

    const read = await app.call('planRead', { sessionId: SESSION_ID, id: saved.body.id })
    assert.equal(read.status, 200)
    assert.equal(read.body.text, text)
    assert.equal(read.body.title, title)

    const missing = await app.call('planRead', { sessionId: SESSION_ID, id: 'nope' })
    assert.equal(errorCode(missing.body), 'not-found')
    const blank = await app.call('planSave', { sessionId: SESSION_ID, text: '   ' })
    assert.equal(errorCode(blank.body), 'bad-request')
  } finally {
    if (previous === undefined) delete process.env.DSH_CODE_EDITOR_PLANS
    else process.env.DSH_CODE_EDITOR_PLANS = previous
    await rm(root, { recursive: true, force: true })
  }
})

test('project tests run through package.json and report the failing location', async () => {
  const root = await makeWorkspace()
  const script = [
    'TAP version 13',
    'not ok 1 - broken arithmetic',
    '  ---',
    '  location: ' + JSON.stringify(path.join(root, 'spec.js') + ':3:5'),
    '  ...',
    '1..1',
    '',
  ].join('\n')
  await writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'fixture', private: true, scripts: { test: 'node run-test.js' } }),
  )
  await writeFile(path.join(root, 'run-test.js'), `process.exitCode = 1\nprocess.stdout.write(${JSON.stringify(script)})`)
  await writeFile(path.join(root, 'spec.js'), 'const a = 1\nconst b = 2\nboom(a, b)\n')
  const app = setup({ root })
  try {
    const response = await app.call('runTests', { sessionId: SESSION_ID })
    assert.equal(response.status, 200)
    assert.equal(response.body.code, 1)
    assert.equal(response.body.failures.length, 1)
    assert.equal(response.body.failures[0].file, 'spec.js')
    assert.equal(response.body.failures[0].line, 3)
    assert.equal(response.body.failures[0].column, 5)
    assert.equal(response.body.failures[0].name, 'broken arithmetic')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('running project tests is refused in a read-only session', async () => {
  const root = await makeWorkspace()
  const app = setup({ root, policyMode: 'read-only' })
  try {
    const response = await app.call('runTests', { sessionId: SESSION_ID })
    assert.equal(errorCode(response.body), 'read-only')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('conversation search reads sessionQuery inside the open workspace only', async () => {
  const root = await makeWorkspace()
  const calls = []
  const sessionQuery = {
    async searchSessions(request) {
      calls.push(request)
      return {
        items: [
          {
            header: { id: 'older-1', title: 'Разбор индекса', cwd: root },
            bestMatch: {
              sessionId: 'older-1',
              surface: 'current',
              type: 'assistant/message',
              seq: 7,
              time: 1_700_000_000_000,
              snippet: 'нашли <mark>ответ</mark> в индексе',
            },
          },
        ],
        hasMore: false,
      }
    },
  }
  const app = setup({ root, sessionQuery })
  try {
    const response = await app.call('sessionSearch', { sessionId: SESSION_ID, query: ' ответ ' })
    assert.equal(response.status, 200)
    assert.equal(response.body.query, 'ответ')
    assert.deepEqual(response.body.items, [
      {
        sessionId: 'older-1',
        title: 'Разбор индекса',
        snippet: 'нашли ответ в индексе',
        seq: 7,
        time: 1_700_000_000_000,
        type: 'assistant/message',
      },
    ])
    assert.equal(calls.length, 1)
    assert.deepEqual(calls[0].sessionFilters, [{ kind: 'cwd', values: [root] }])
    assert.deepEqual(calls[0].eventFilters, [
      { kind: 'type', values: ['user/message', 'assistant/message'] },
      { kind: 'surface', values: ['current'] },
    ])
    assert.equal(calls[0].limit, 20)

    const empty = await app.call('sessionSearch', { sessionId: SESSION_ID, query: '   ' })
    assert.equal(errorCode(empty.body), 'bad-request')
    const long = await app.call('sessionSearch', { sessionId: SESSION_ID, query: 'x'.repeat(201) })
    assert.equal(errorCode(long.body), 'bad-request')
    assert.equal(calls.length, 1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('conversation search reports a missing sessionQuery service', async () => {
  const root = await makeWorkspace()
  const app = setup({ root })
  try {
    const response = await app.call('sessionSearch', { sessionId: SESSION_ID, query: 'anything' })
    assert.equal(errorCode(response.body), 'unavailable')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('one conversation turn becomes a bounded excerpt before the chat', async () => {
  const root = await makeWorkspace()
  const calls = []
  const long = 'я'.repeat(9000)
  const sessionQuery = {
    async readEvent(request) {
      calls.push(request)
      if (request.seq === 99) {
        throw Object.assign(new Error('gone'), { code: 'SESSION_QUERY_EVENT_NOT_FOUND' })
      }
      return {
        session: { id: 'older-1', title: 'Разбор индекса' },
        target: {
          seq: request.seq,
          type: 'assistant/message',
          time: 1_700_000_000_000,
          data: { content: [{ type: 'text', text: long }, { type: 'text', text: 'хвост' }] },
        },
      }
    },
  }
  const app = setup({ root, sessionQuery })
  try {
    const response = await app.call('sessionExcerpt', { sessionId: SESSION_ID, target: 'older-1', seq: 7 })
    assert.equal(response.status, 200)
    assert.equal(response.body.sessionId, 'older-1')
    assert.equal(response.body.title, 'Разбор индекса')
    assert.equal(response.body.seq, 7)
    assert.equal(response.body.type, 'assistant/message')
    assert.equal(response.body.chars, 9007)
    assert.equal(response.body.text.length, 8000)
    assert.equal(response.body.truncated, true)
    assert.deepEqual(calls[0], { sessionId: 'older-1', seq: 7, before: 0, after: 0 })

    const missing = await app.call('sessionExcerpt', { sessionId: SESSION_ID, target: 'older-1', seq: 99 })
    assert.equal(errorCode(missing.body), 'not-found')
    const bad = await app.call('sessionExcerpt', { sessionId: SESSION_ID, target: 'older-1' })
    assert.equal(errorCode(bad.body), 'bad-request')
    assert.equal(calls.length, 2)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})