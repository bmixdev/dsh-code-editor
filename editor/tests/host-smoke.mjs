import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { apply } from '../index.js'

// Without an isolated file the smoke test reads the real
// `~/.dsh/code-editor.json`, so a completion model chosen on this machine
// (glm-5.3-flash, provider opencode-go) overrides the fixture selection and the
// provider assertion below fails for a reason that has nothing to do with code.
const PREFS_DIR = mkdtempSync(path.join(os.tmpdir(), 'dsh-editor-prefs-'))
writeFileSync(path.join(PREFS_DIR, 'prefs.json'), '{}\n')
process.env.DSH_CODE_EDITOR_PREFS = path.join(PREFS_DIR, 'prefs.json')

const ROOT = 'C:\\workspace'
const SESSION_ID = 'session-1'

function setup({ mode = 'workspace-write' } = {}) {
  const files = new Map()
  const routes = new Map()
  const session = { id: SESSION_ID }
  let versionNumber = 1
  let writeCalls = 0
  let modelOptions
  let modelText = 'return value'
  let prompts = 0

  const targetPath = (value, cwd) => path.win32.isAbsolute(value) ? path.win32.normalize(value) : path.win32.resolve(cwd, value)
  const targetFor = (value, cwd) => ({ path: targetPath(value, cwd), targetKey: targetPath(value, cwd), displayPath: targetPath(value, cwd) })

  const ctx = {
    effect(effect) {
      const cleanup = effect()
      return () => cleanup?.()
    },
    webServer: { register: () => () => {} },
    connection: { fetch: { register: (route) => { routes.set(route.path, route); return () => routes.delete(route.path) } } },
    sessions: { get: (id) => id === SESSION_ID ? session : undefined, list: () => [session] },
    workingDirectory: { get: () => ROOT },
    sandboxPolicy: { resolve: () => ({ mode, workspaceRoot: ROOT }) },
    agentDefaultModel: { currentSelection: () => ({ provider: 'fixture', model: 'fixture-model' }) },
    llm: {
      async *stream(options) {
        modelOptions = options
        prompts += 1
        yield { type: 'text-delta', index: 0, text: modelText }
      },
    },
    fs: {
      resolve: async (value, { cwd } = {}) => targetFor(value, cwd ?? ROOT),
      processPath: (target) => target.path,
      contains: (parent, child) => child.path === parent.path || child.path.toLowerCase().startsWith(`${parent.path.toLowerCase()}\\`),
      stat: async (target) => {
        const file = files.get(target.path.toLowerCase())
        return file ? { type: 'file', size: file.bytes.byteLength, version: file.version } : undefined
      },
      readBytes: async (target, _signal, limit) => {
        const file = files.get(target.path.toLowerCase())
        if (!file) throw new Error('missing fixture')
        assert.ok(file.bytes.byteLength <= limit)
        return file.bytes
      },
      async writeText(target, content, expected, _signal, policy) {
        writeCalls += 1
        assert.equal(policy.mode, mode)
        const key = target.path.toLowerCase()
        const current = files.get(key)
        if (!current || expected?.kind !== 'replaceIfVersion' || current.version !== expected.version) {
          const error = new Error('stale fixture')
          error.code = 'FS_STALE_VERSION'
          throw error
        }
        const version = `v${++versionNumber}`
        files.set(key, { bytes: new TextEncoder().encode(content), version })
        return { operation: 'update', version, before: null, after: content }
      },
    },
  }

  apply(ctx)

  async function call(name, body, headers = { 'content-type': 'application/json' }) {
    const route = routes.get(`/api/code-editor/${name}`)
    assert.ok(route, `registered route ${name}`)
    const response = await route.fetch(new Request(`http://dsh.internal/api/code-editor/${name}`, {
      method: 'POST',
      headers,
      body: headers['content-type'] === 'application/json' ? JSON.stringify(body) : 'not-json',
    }))
    return { status: response.status, body: await response.json() }
  }

  return {
    files,
    call,
    get modelOptions() { return modelOptions },
    get promptCount() { return prompts },
    lastPrompt() {
      assert.ok(modelOptions, 'the model was never invoked')
      const blocks = modelOptions.messages[0].content
      // Message content is a list of typed blocks; a bare string is what made the
      // real adapter end the stream with no chunk, so the shape is asserted here.
      assert.ok(Array.isArray(blocks), 'message content must be a list of blocks')
      assert.strictEqual(blocks[0]?.type, 'text')
      assert.strictEqual(typeof blocks[0]?.text, 'string')
      return blocks[0].text
    },
    get writeCalls() { return writeCalls },
    set modelText(value) { modelText = value },
  }
}

test('opens, normalizes, and guarded-saves UTF-8 while preserving BOM and CRLF', async () => {
  const app = setup()
  const file = `${ROOT}\\src\\sample.ts`
  app.files.set(file.toLowerCase(), {
    bytes: new TextEncoder().encode('\uFEFFconst a = 1;\r\nconst b = 2;\r\n'),
    version: 'v1',
  })

  const opened = await app.call('open', { sessionId: SESSION_ID, path: file })
  assert.equal(opened.body.text, 'const a = 1;\nconst b = 2;\n')
  assert.equal(opened.body.eol, 'crlf')
  assert.equal(opened.body.bom, true)
  assert.equal(opened.body.relativePath, 'src/sample.ts')

  const saved = await app.call('save', {
    id: opened.body.id,
    sessionId: SESSION_ID,
    token: opened.body.token,
    text: 'const a = 3;\nconst b = 2;\n',
  })
  assert.equal(saved.body.operation, 'update')
  assert.equal(saved.body.token === opened.body.token, false)
  const savedBytes = app.files.get(file.toLowerCase()).bytes
  assert.deepEqual([...savedBytes.subarray(0, 3)], [0xef, 0xbb, 0xbf])
  assert.equal(new TextDecoder().decode(savedBytes.subarray(3)), 'const a = 3;\r\nconst b = 2;\r\n')
})

test('rejects stale and out-of-workspace writes without overwriting the file', async () => {
  const app = setup()
  const file = `${ROOT}\\src\\sample.ts`
  const original = new TextEncoder().encode('const a = 1;')
  app.files.set(file.toLowerCase(), { bytes: original, version: 'v1' })
  const opened = await app.call('open', { sessionId: SESSION_ID, path: file })
  app.files.get(file.toLowerCase()).version = 'external-change'

  const stale = await app.call('save', {
    id: opened.body.id,
    sessionId: SESSION_ID,
    token: opened.body.token,
    text: 'const a = 2;',
  })
  assert.equal(stale.body.error.code, 'stale')
  assert.equal(new TextDecoder().decode(app.files.get(file.toLowerCase()).bytes), 'const a = 1;')

  const outside = await app.call('open', { sessionId: SESSION_ID, path: 'C:\\secrets\\private.ts' })
  assert.equal(outside.body.error.code, 'outside-workspace')
})

test('refuses read-only writes and excludes secret-like files from completion', async () => {
  const app = setup({ mode: 'read-only' })
  const file = `${ROOT}\\src\\sample.ts`
  app.files.set(file.toLowerCase(), { bytes: new TextEncoder().encode('x'), version: 'v1' })
  const opened = await app.call('open', { sessionId: SESSION_ID, path: file })
  assert.equal(opened.body.readOnly, true)
  const saved = await app.call('save', {
    id: opened.body.id,
    sessionId: SESSION_ID,
    token: opened.body.token,
    text: 'y',
  })
  assert.equal(saved.body.error.code, 'read-only')
  assert.equal(app.writeCalls, 0)

  const secret = `${ROOT}\\.env.local`
  app.files.set(secret.toLowerCase(), { bytes: new TextEncoder().encode('TOKEN=do-not-send'), version: 'v1' })
  const secretDocument = await app.call('open', { sessionId: SESSION_ID, path: secret })
  assert.equal(secretDocument.body.completionExcluded, true)
  const enabled = await app.call('settings', { sessionId: SESSION_ID, id: secretDocument.body.id, smartTab: true })
  assert.equal(enabled.body.error.code, 'excluded-file')
})

test('caps model context and returns only the generated insertion', async () => {
  const app = setup()
  const file = `${ROOT}\\src\\sample.ts`
  app.files.set(file.toLowerCase(), { bytes: new TextEncoder().encode('x'), version: 'v1' })
  const opened = await app.call('open', { sessionId: SESSION_ID, path: file })
  await app.call('settings', { sessionId: SESSION_ID, id: opened.body.id, smartTab: true })
  const completed = await app.call('complete', {
    id: opened.body.id,
    sessionId: SESSION_ID,
    token: opened.body.token,
    prefix: 'x'.repeat(5000),
    suffix: 'y'.repeat(1500),
  })
  assert.equal(completed.body.text, 'return value')
  assert.equal(completed.body.provider, 'fixture')
  assert.equal(app.modelOptions.sessionId, SESSION_ID)
  assert.ok(app.lastPrompt().includes('x'.repeat(4000)))
  assert.ok(app.lastPrompt().includes('y'.repeat(1000)))
})

test('bad request body is rejected explicitly', async () => {
  const app = setup()
  const response = await app.call('open', {}, { 'content-type': 'text/plain' })
  assert.equal(response.status, 400)
  assert.equal(response.body.error.code, 'bad-request')
})

test('complete clamps a client-supplied context window and rejects an oversized buffer', async () => {
  const app = await setup()
  const file = `${ROOT}\\src\\window.ts`
  app.files.set(file.toLowerCase(), { bytes: new TextEncoder().encode('const a = 1;\n'), version: 'v1' })
  const opened = (await app.call('open', { sessionId: SESSION_ID, path: file })).body
  await app.call('settings', { id: opened.id, sessionId: SESSION_ID, smartTab: true })
  assert.deepEqual(opened.context, { left: 4000, right: 1000 })
  // Long enough that the default 4000/1000 budget cannot cover both sides, so a
  // client-supplied window is observable in the prompt. The two sides are long
  // runs of different characters, so a prompt can only contain the long needle
  // when that whole window travelled.
  const text = `${'a'.repeat(5000)}${'m'.repeat(50)}${'b'.repeat(1050)}`
  const offset = 5050
  // A client asking for more than the budget gets the budget, not its number.
  const wide = await app.call('complete', {
    id: opened.id,
    sessionId: SESSION_ID,
    token: opened.token,
    text,
    offset,
    selection: '',
    contextLeft: 100000,
    contextRight: 100000,
  })
  assert.equal(wide.status, 200)
  const widePrompt = app.lastPrompt()
  assert.equal(widePrompt.includes('a'.repeat(3950)), true)
  assert.equal(widePrompt.includes('a'.repeat(3951)), false)
  assert.equal(widePrompt.includes('m'.repeat(50)), true)
  assert.equal(widePrompt.includes('b'.repeat(1000)), true)
  assert.equal(widePrompt.includes('b'.repeat(1001)), false)
  // The header order is the whole contract the model sees, so it is asserted
  // here: the prefix belongs above the cursor marker and the suffix below the
  // after-cursor header. An inverted layout makes the model continue the wrong
  // side of the text and was the cause of 100 empty answers out of 100.
  const cursorMarker = '--- курсор ---'
  const suffixMarker = '--- текст после курсора ---'
  const cursorAt = widePrompt.indexOf(cursorMarker)
  const suffixAt = widePrompt.indexOf(suffixMarker)
  assert.equal(cursorAt > 0, true)
  assert.equal(suffixAt > cursorAt, true)
  assert.equal(widePrompt.slice(cursorAt + cursorMarker.length, suffixAt).trim(), '')
  assert.equal(widePrompt.slice(suffixAt).includes('b'.repeat(1000)), true)
  // A client window smaller than the budget is honoured.
  await app.call('complete', {
    id: opened.id,
    sessionId: SESSION_ID,
    token: opened.token,
    text,
    offset,
    selection: '',
    contextLeft: 30,
    contextRight: 30,
  })
  const narrowPrompt = app.lastPrompt()
  // `offset - 30` lands inside the 50-character `m` run, so the narrow window
  // legitimately carries no `a` at all: the whole window is the `m` run.
  assert.equal(narrowPrompt.includes('m'.repeat(30)), true)
  assert.equal(narrowPrompt.includes('m'.repeat(31)), false)
  assert.equal(narrowPrompt.includes('a'.repeat(29)), false)
  // An oversized buffer is refused explicitly instead of being sent upstream,
  // and it never reaches the model.
  const before = app.promptCount
  const huge = await app.call('complete', {
    id: opened.id,
    sessionId: SESSION_ID,
    token: opened.token,
    text: 'x'.repeat(4 * 1024 * 1024 + 1),
    offset: 10,
    selection: '',
  })
  assert.equal(huge.body.error?.code, 'context-too-large')
  assert.equal(app.promptCount, before)
})

test('per-file exclusion is enforced by Host before model invocation', async () => {
  const app = setup()
  const file = `${ROOT}\\src\\sample.ts`
  app.files.set(file.toLowerCase(), { bytes: new TextEncoder().encode('const x = 1'), version: 'v1' })
  const opened = await app.call('open', { sessionId: SESSION_ID, path: file })
  await app.call('settings', { sessionId: SESSION_ID, id: opened.body.id, smartTab: true })
  const excluded = await app.call('settings', { sessionId: SESSION_ID, id: opened.body.id, excludeFile: true })
  assert.equal(excluded.body.fileExcluded, true)
  const result = await app.call('complete', {
    id: opened.body.id,
    sessionId: SESSION_ID,
    token: opened.body.token,
    prefix: 'const x = ',
    suffix: '',
  })
  assert.equal(result.body.error.code, 'excluded-file')
  assert.equal(app.modelOptions, undefined)
})

test('complete derives bounded context from text+offset and filters the answer', async () => {
  const app = setup()
  const file = `${ROOT}\\src\\sample.ts`
  app.files.set(file.toLowerCase(), { bytes: new TextEncoder().encode('x'), version: 'v1' })
  const opened = await app.call('open', { sessionId: SESSION_ID, path: file })
  await app.call('settings', { sessionId: SESSION_ID, id: opened.body.id, smartTab: true })

  const before = 'a'.repeat(5000)
  const after = 'b'.repeat(1500)
  app.modelText = '```ts\nconst inserted = 1\n```'
  const completed = await app.call('complete', {
    id: opened.body.id,
    sessionId: SESSION_ID,
    token: opened.body.token,
    text: `${before}${after}`,
    offset: before.length,
  })
  // Context came from text+offset, capped on both sides.
  assert.ok(app.lastPrompt().includes('a'.repeat(4000)))
  assert.ok(app.lastPrompt().includes('b'.repeat(1000)))
  assert.ok(!app.lastPrompt().includes('a'.repeat(4001)))
  // The fence was removed by postprocessCompletion, not by sanitizeCompletion.
  assert.equal(completed.body.text, 'const inserted = 1')
})

test('complete drops an answer that only repeats the line above', async () => {
  const app = setup()
  const file = `${ROOT}\\src\\sample.ts`
  app.files.set(file.toLowerCase(), { bytes: new TextEncoder().encode('x'), version: 'v1' })
  const opened = await app.call('open', { sessionId: SESSION_ID, path: file })
  await app.call('settings', { sessionId: SESSION_ID, id: opened.body.id, smartTab: true })

  app.modelText = 'const total = compute(items)'
  const completed = await app.call('complete', {
    id: opened.body.id,
    sessionId: SESSION_ID,
    token: opened.body.token,
    prefix: 'const total = compute(items)\n',
    suffix: '',
  })
  assert.equal(completed.body.text, '')
})
