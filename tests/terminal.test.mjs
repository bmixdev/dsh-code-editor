/**
 * Terminal tests for `@local/dsh-ide`.
 *
 * The pure pieces (ring buffer, WSL output parser, profile detection) are
 * covered directly; the service is driven through a fake child process so the
 * create → write → read → kill lifecycle runs without a real PTY.
 */
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { test } from 'node:test'

import { RingBuffer, parseWslList, profileSpecs, detectProfiles, createTerminalService } from '../terminal.js'

test('RingBuffer keeps absolute offsets and reports gaps', () => {
  const ring = new RingBuffer(16)
  assert.equal(ring.offset, 0)
  assert.equal(ring.dropped, 0)
  ring.append(Buffer.from('abcdefghij'))
  const first = ring.read(0)
  assert.equal(first.gap, false)
  assert.equal(Buffer.concat(first.bytes).toString(), 'abcdefghij')
  assert.equal(first.next, 10)
  // Exceeding the capacity drops the oldest bytes and invalidates reads below
  // the new floor.
  ring.append(Buffer.from('KLMNOPQRSTUV'))
  assert.equal(ring.offset, 22)
  // Drop happens in whole chunks: the entire first chunk leaves the buffer.
  assert.equal(ring.dropped, 10)
  const gap = ring.read(0)
  assert.equal(gap.gap, true)
  assert.equal(gap.next, 10)
  const tail = ring.read(10)
  assert.equal(tail.gap, false)
  assert.equal(Buffer.concat(tail.bytes).toString(), 'KLMNOPQRSTUV')
  assert.equal(tail.next, 22)
  // A read at the current end is empty, not a gap.
  const empty = ring.read(22)
  assert.equal(empty.gap, false)
  assert.equal(empty.bytes.length, 0)
})

test('parseWslList reads UTF-16LE, BOM-prefixed and plain listings', () => {
  const utf16 = Buffer.from('\ufeffUbuntu-22.04\0Debian\0', 'utf16le')
  assert.deepEqual(parseWslList(utf16), ['Ubuntu-22.04', 'Debian'])
  const utf16NoBom = Buffer.from('Ubuntu-22.04\0\0Debian\0', 'utf16le')
  assert.deepEqual(parseWslList(utf16NoBom), ['Ubuntu-22.04', 'Debian'])
  assert.deepEqual(parseWslList(Buffer.from('Ubuntu\nDebian\n', 'utf8')), ['Ubuntu', 'Debian'])
  assert.deepEqual(parseWslList(Buffer.from('Ubuntu\r\nDebian', 'utf8')), ['Ubuntu', 'Debian'])
  assert.deepEqual(parseWslList(Buffer.alloc(0)), [])
})

test('profileSpecs marks only the shells the platform provides', () => {
  const windows = profileSpecs({ platform: 'win32' })
  assert.deepEqual(windows.map((spec) => spec.id), ['powershell', 'pwsh', 'cmd', 'git-bash', 'node'])
  const unix = profileSpecs({ platform: 'linux', env: {} })
  assert.deepEqual(unix.map((spec) => spec.id), ['shell', 'node'])
})

test('detectProfiles keeps declared order and skips missing executables', async () => {
  const specs = [
    { id: 'a', label: 'A', file: 'a.exe', preferredPath: 'C:/a/a.exe' },
    { id: 'b', label: 'B', file: 'b.exe', preferredPath: 'C:/b/b.exe' },
    { id: 'c', label: 'C', file: 'c.exe', candidates: ['C:/x/c.exe'] },
  ]
  const profiles = await detectProfiles(specs, (file) => (file === 'a.exe' || file === 'b.exe' || file === 'C:/x/c.exe' ? Promise.resolve() : Promise.reject(new Error('missing'))))
  assert.deepEqual(profiles.map((profile) => profile.id), ['a', 'b', 'c'])
})

function fakeChild() {
  const child = new EventEmitter()
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.finish = (code) => {
    queueMicrotask(() => {
      // Real shells fire exit first, then close once stdio drains.
      child.emit('exit', code, null)
      child.emit('close', code, null)
    })
  }
  child.stdin = {
    writable: true,
    write: (data) => {
      // Behave like a real shell: echo the typed line back.
      const line = String(data).replace(/\r?\n$/, '')
      if (line === 'exit') {
        child.finish(0)
        return true
      }
      child.stdout.emit('data', Buffer.from(`${line}\r\n`))
      return true
    },
    end: () => {},
  }
  child.killed = false
  child.kill = () => {
    child.killed = true
    child.finish(1)
    return true
  }
  child.pid = 4242
  return child
}

/** Spawns a fake shell that announces itself on stdout. */
function makeSpawner() {
  const children = []
  return {
    children,
    spawnChild(file, args, options) {
      const child = fakeChild()
      children.push(child)
      queueMicrotask(() => {
        child.stdout.emit('data', Buffer.from('FAKE-SHELL ready\r\n'))
      })
      return child
    },
  }
}

function makeService(overrides = {}) {
  const spawner = makeSpawner()
  const service = createTerminalService({
    platform: 'linux',
    env: {},
    execPath: '/usr/bin/node',
    homedir: () => '/home/test',
    // Every profile "exists" so the create route accepts the fake specs.
    access: () => Promise.resolve(),
    spawnChild: spawner.spawnChild,
    ...overrides,
  })
  return { service, spawner }
}

const SESSION = 'session-1'

test('service lifecycle: create, write, read, list, kill', async () => {
  const { service, spawner } = makeService()
  const created = await service.termCreateRoute({ sessionId: SESSION, cols: 80, rows: 24 })
  assert.equal(created.alive, true)
  assert.equal(created.cols, 80)
  const id = created.id

  await service.termWriteRoute({ sessionId: SESSION, id, data: 'hello\r' })
  const read = await service.termReadRoute({ sessionId: SESSION, id, offset: 0, waitMs: 500 })
  const text = Buffer.from(read.data, 'base64').toString('utf8')
  assert.match(text, /FAKE-SHELL ready/)
  assert.match(text, /hello/)
  assert.equal(read.alive, true)
  assert.equal(read.gap, false)

  const list = await service.termListRoute({ sessionId: SESSION })
  assert.equal(list.terminals.length, 1)
  assert.equal(list.terminals[0].id, id)

  // Another session must not see or touch foreign terminals.
  const foreign = await service.termListRoute({ sessionId: 'session-2' })
  assert.equal(foreign.terminals.length, 0)
  await assert.rejects(() => service.termWriteRoute({ sessionId: 'session-2', id, data: 'x' }))

  await service.termKillRoute({ sessionId: SESSION, id })
  assert.equal(spawner.children[0].killed, true)
  const after = await service.termListRoute({ sessionId: SESSION })
  assert.equal(after.terminals.length, 0)
  await service.dispose()
})

test('service read: empty wait, then data when the child speaks', async () => {
  const { service } = makeService()
  const created = await service.termCreateRoute({ sessionId: SESSION })
  const id = created.id
  // First read grabs the startup banner (data already buffered).
  const first = await service.termReadRoute({ sessionId: SESSION, id, offset: 0, waitMs: 200 })
  assert.notEqual(first.data, '')
  const offset = first.offset
  // A second read at the end would wait for the full timeout when idle.
  const started = Date.now()
  const idle = await service.termReadRoute({ sessionId: SESSION, id, offset, waitMs: 250 })
  assert.ok(Date.now() - started >= 200)
  assert.equal(idle.data, '')
  // New output wakes the reader immediately.
  const child = service._terminals.get(id).child
  child.stdout.emit('data', Buffer.from('later output\r\n'))
  const woken = await service.termReadRoute({ sessionId: SESSION, id, offset, waitMs: 1000 })
  assert.equal(Buffer.from(woken.data, 'base64').toString('utf8'), 'later output\r\n')
  await service.termKillRoute({ sessionId: SESSION, id })
  await service.dispose()
})

test('service reports process exit through the read route', async () => {
  const { service } = makeService()
  const created = await service.termCreateRoute({ sessionId: SESSION })
  const id = created.id
  const first = await service.termReadRoute({ sessionId: SESSION, id, offset: 0, waitMs: 200 })
  const child = service._terminals.get(id).child
  child.finish(7)
  const final = await service.termReadRoute({ sessionId: SESSION, id, offset: first.offset, waitMs: 200 })
  assert.equal(final.alive, false)
  assert.equal(final.exitCode, 7)
  await service.dispose()
})

test('service caps concurrent terminals and validates input', async () => {
  const { service } = makeService()
  const created = []
  for (let index = 0; index < 8; index += 1) created.push(await service.termCreateRoute({ sessionId: SESSION }))
  await assert.rejects(() => service.termCreateRoute({ sessionId: SESSION }), /Слишком много/)
  for (const item of created) await service.termKillRoute({ sessionId: SESSION, id: item.id })
  await assert.rejects(() => service.termWriteRoute({ sessionId: SESSION, id: 'nope', data: 'x' }))
  await assert.rejects(() => service.termCreateRoute({ sessionId: SESSION, profile: 'unknown' }), /рофиль/)
  await service.dispose()
})

test('killSession disposes every terminal of one session', async () => {
  const { service, spawner } = makeService()
  await service.termCreateRoute({ sessionId: 's-a' })
  await service.termCreateRoute({ sessionId: 's-a' })
  await service.termCreateRoute({ sessionId: 's-b' })
  service.killSession('s-a')
  const alive = [...service._terminals.values()]
  assert.equal(alive.length, 1)
  assert.equal(alive[0].sessionId, 's-b')
  assert.equal(spawner.children.filter((child) => child.killed).length, 2)
  await service.dispose()
  assert.equal(spawner.children.filter((child) => child.killed).length, 3)
})
