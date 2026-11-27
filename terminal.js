/**
 * Host half of the IDE terminal: real PTY sessions behind four routes.
 *
 * The heavy lifting is node-pty. DSH already ships a full copy inside its
 * `app.asar` (native `.node` binaries live unpacked next to it), so instead of
 * bundling a second copy this module unpacks the shipped one on first use into
 * `~/.dsh/ide-pty-runtime/node-pty-<version>/` and requires it from there.
 * When the runtime cannot be unpacked the service degrades to plain piped
 * `child_process` shells (no colors from most shells, no echo) rather than
 * failing the whole terminal feature.
 *
 * Transport is intentionally boring: every route is a buffered POST. Reads are
 * long polls — `termRead` parks up to ~20 s waiting for new bytes and answers
 * immediately when data is already queued, so a focused terminal streams with
 * one pending request and an idle one costs nothing.
 */

import { createRequire } from 'node:module'
import { spawn as spawnNode } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { EventEmitter } from 'node:events'
import os from 'node:os'
import path from 'node:path'

const PTY_VERSION = '1.2.0-beta.15'
const PTY_DIR_NAME = `node-pty-${PTY_VERSION}`
const MAX_BUFFER_BYTES = 10 * 1024 * 1024
const MAX_READ_BYTES = 262144
const MAX_WAIT_MS = 20000
const MAX_TERMINALS = 8

/**
 * Byte-keeping buffer with a hard cap: when the cap is reached the oldest
 * bytes are dropped and `dropped` records how many are gone, so a reader that
 * asked for an offset below `dropped` knows its view has a gap and must be
 * redrawn from scratch.
 */
export class RingBuffer {
  constructor(capacity = MAX_BUFFER_BYTES) {
    this.capacity = capacity
    this.chunks = []
    this.bytes = 0
    /** Total bytes ever appended (the offset of the next new byte). */
    this.offset = 0
    /** Total bytes dropped from the front. Offsets below this are gone. */
    this.dropped = 0
  }

  append(chunk) {
    if (!(chunk instanceof Uint8Array) || chunk.length === 0) return
    this.chunks.push(chunk)
    this.bytes += chunk.length
    this.offset += chunk.length
    while (this.bytes > this.capacity && this.chunks.length > 1) {
      const first = this.chunks[0]
      this.chunks.shift()
      this.bytes -= first.length
      this.dropped += first.length
    }
    if (this.bytes > this.capacity) {
      // A single chunk larger than the whole cap: keep only its tail.
      const keep = this.chunks[0].subarray(this.chunks[0].length - this.capacity)
      this.dropped += this.chunks[0].length - keep.length
      this.bytes = keep.length
      this.chunks = [keep]
    }
  }

  /** Whether bytes at `from` are still buffered. */
  hasFrom(from) {
    return from >= this.dropped && from <= this.offset
  }

  /**
   * Collects buffered bytes from `from` up to at most `limit` bytes,
   * returning `{ bytes, next, gap }`.
   */
  read(from, limit = MAX_READ_BYTES) {
    if (from < this.dropped) return { bytes: [], next: this.dropped, gap: true }
    const collected = []
    let size = 0
    let skip = from - this.dropped
    for (const chunk of this.chunks) {
      if (skip >= chunk.length) {
        skip -= chunk.length
        continue
      }
      const piece = skip === 0 ? chunk : chunk.subarray(skip)
      skip = 0
      if (size + piece.length > limit) {
        collected.push(piece.subarray(0, limit - size))
        size = limit
        break
      }
      collected.push(piece)
      size += piece.length
    }
    return { bytes: collected, next: from + size, gap: false }
  }
}

/**
 * Shell launches per profile id. `file` may be an absolute path or a bare
 * executable resolved through `PATH`. Detection of optional shells happens in
 * `detectProfiles`, this table only describes the launch.
 */
export function profileSpecs({ platform = process.platform, env = process.env, execPath = process.execPath } = {}) {
  if (platform === 'win32') {
    let gitBash
    for (const variable of ['ProgramFiles', 'ProgramFiles(x86)', 'LocalAppData']) {
      const base = env[variable]
      if (typeof base !== 'string' || base === '') continue
      const bash = path.join(base, 'Git', 'bin', 'bash.exe')
      gitBash = { id: 'git-bash', label: 'Git Bash', file: bash, preferredPath: bash }
      break
    }
    return [
      { id: 'powershell', label: 'PowerShell', file: 'powershell.exe', preferredPath: path.join(env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') },
      { id: 'pwsh', label: 'PowerShell (pwsh)', file: 'pwsh.exe', candidates: String(env.PATH ?? '').split(';').filter((entry) => entry !== '').map((entry) => path.join(entry, 'pwsh.exe')) },
      { id: 'cmd', label: 'Command Prompt', file: env.ComSpec && String(env.ComSpec).toLowerCase().endsWith('cmd.exe') ? env.ComSpec : 'cmd.exe' },
      ...(gitBash ? [gitBash] : []),
      { id: 'node', label: 'Node', file: execPath },
    ]
  }
  return [
    { id: 'shell', label: 'Shell', file: env.SHELL && env.SHELL !== '' ? env.SHELL : '/bin/bash' },
    { id: 'node', label: 'Node', file: execPath },
  ]
}

/** Marks which of the spec launches actually exist on disk right now. */
export async function detectProfiles(specs, access) {
  const list = []
  for (const spec of specs) {
    const targets = [
      ...(Array.isArray(spec.candidates) ? spec.candidates : []),
      ...(spec.preferredPath !== undefined ? [spec.preferredPath] : []),
      spec.file,
    ]
    let available = false
    for (const target of targets) {
      try {
        await access(target)
        available = true
        break
      } catch {
        // Keep probing the remaining candidates.
      }
    }
    list.push({ id: spec.id, label: spec.label, available })
  }
  return list
}

/** `wsl -l -q` answers in UTF-16LE even when its stdout is redirected. */
export function parseWslList(stdout) {
  const buffer = typeof stdout === 'string' ? Buffer.from(stdout, 'latin1') : stdout
  let text
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) text = buffer.toString('utf16le', 2)
  else if (buffer.length >= 2 && buffer[1] === 0x00 && buffer[0] !== 0x00) text = buffer.toString('utf16le')
  else text = buffer.toString('utf8')
  return text
    .split(/\r?\n|\0/)
    .map((line) => line.trim())
    .filter((line) => line !== '' && line.toLowerCase() !== 'name')
    .filter((line, index, all) => all.indexOf(line) === index)
}

export function createTerminalService({
  platform = process.platform,
  env = process.env,
  execPath = process.execPath,
  homedir = os.homedir,
  readFile = (file) => fs.readFile(file),
  access = (file) => fs.access(file),
  spawnChild = undefined,
} = {}) {
  /** id → terminal record. Shared across sessions; each record keeps its own. */
  const terminals = new Map()
  let sequence = 0
  let profileCache = { at: 0, list: [] }
  let ptyPromise = undefined

  const fail = (message, code = 'terminal') => {
    const error = new Error(message)
    error.code = code
    return error
  }

  // ------------------------------------------------------------- node-pty

  const runtimeDir = () => path.join(homedir(), '.dsh', 'ide-pty-runtime', PTY_DIR_NAME)

  /** Candidate `resources` directories of an installed DSH. */
  function resourceDirs() {
    const list = []
    if (typeof process.resourcesPath === 'string' && process.resourcesPath !== '') list.push(process.resourcesPath)
    const besideExe = path.join(path.dirname(execPath), 'resources')
    if (!list.includes(besideExe)) list.push(besideExe)
    if (platform === 'win32') {
      list.push(path.join(homedir(), 'AppData', 'Local', 'Programs', 'DeepSeek Harness', 'resources'))
    }
    return list
  }

  /**
   * Reads one file out of an asar archive. The header is a Chrome pickle:
   * uint32 at 4..7 is the header size, but the JSON itself starts at the
   * first `{` (offset 16 on the writers in the wild) and may be followed by
   * padding, so parsing is retried with the position reported by the syntax
   * error. File bytes live at `8 + headerSize + offset`.
   */
  async function asarFileMap(asarPath) {
    const buffer = await readFile(asarPath)
    const headerSize = buffer.readUInt32LE(4)
    const headerText = buffer.toString('utf8', 8, 8 + headerSize)
    const start = headerText.indexOf('{')
    if (start < 0) throw fail(`asar ${asarPath}: заголовок не содержит JSON.`)
    let header
    try {
      header = JSON.parse(headerText.slice(start))
    } catch (error) {
      const at = /position (\d+)/.exec(String(error?.message ?? ''))
      if (at === null) throw error
      header = JSON.parse(headerText.slice(start, start + Number(at[1])))
    }
    const files = new Map()
    const walk = (node, prefix) => {
      if (node === null || typeof node !== 'object') return
      for (const [name, child] of Object.entries(node.files ?? {})) {
        const next = prefix === '' ? name : `${prefix}/${name}`
        if (child.files !== undefined) walk(child, next)
        else if (typeof child.offset === 'string' && typeof child.size === 'number') {
          files.set(next, { start: 8 + headerSize + Number(child.offset), size: child.size })
        }
      }
    }
    walk(header, '')
    return files
  }

  async function unpackNodePty() {
    const target = runtimeDir()
    const marker = path.join(target, 'package.json')
    try {
      const manifest = JSON.parse(await fs.readFile(marker, 'utf8'))
      if (manifest.name === 'node-pty' && manifest.version === PTY_VERSION) return target
    } catch {
      // fall through to a fresh unpack
    }
    let unpackedFrom = undefined
    for (const resources of resourceDirs()) {
      const asar = path.join(resources, 'app.asar')
      let files
      try {
        files = await asarFileMap(asar)
      } catch {
        continue
      }
      unpackedFrom = { resources, files }
      break
    }
    if (unpackedFrom === undefined) throw fail('Не найден установленный DSH с node-pty внутри app.asar.', 'no-pty-source')
    const { resources, files } = unpackedFrom
    const prefix = `dsh/node_modules/node-pty/`
    const wanted = [...files.keys()].filter((key) => key.startsWith(prefix) && files.get(key).size > 0)
    if (wanted.length === 0) throw fail('node-pty не найден внутри app.asar.', 'no-pty-source')

    const staging = `${target}.staging-${Date.now()}`
    await fs.mkdir(staging, { recursive: true })
    try {
      const buffer = await readFile(path.join(resources, 'app.asar'))
      for (const key of wanted) {
        const entry = files.get(key)
        const relative = key.slice(prefix.length)
        const destination = path.join(staging, relative)
        await fs.mkdir(path.dirname(destination), { recursive: true })
        await fs.writeFile(destination, buffer.subarray(entry.start, entry.start + entry.size))
      }
      // Native binaries live outside the archive, already unpacked on disk.
      const unpackedRoot = path.join(resources, 'app.asar.unpacked', 'dsh', 'node_modules', 'node-pty')
      for (const branch of ['build', 'prebuilds', 'third_party']) {
        const source = path.join(unpackedRoot, branch)
        let stat
        try {
          stat = await fs.stat(source)
        } catch {
          continue
        }
        if (!stat.isDirectory()) continue
        await copyTree(source, path.join(staging, branch))
      }
      await fs.rm(target, { recursive: true, force: true })
      await fs.rename(staging, target)
    } catch (error) {
      await fs.rm(staging, { recursive: true, force: true }).catch(() => {})
      throw error
    }
    return target
  }

  async function copyTree(source, destination) {
    await fs.mkdir(destination, { recursive: true })
    for (const entry of await fs.readdir(source, { withFileTypes: true })) {
      const from = path.join(source, entry.name)
      const to = path.join(destination, entry.name)
      if (entry.isDirectory()) await copyTree(from, to)
      else if (entry.isFile()) await fs.copyFile(from, to)
    }
  }

  async function loadPty() {
    if (ptyPromise === undefined) {
      ptyPromise = (async () => {
        const require = createRequire(import.meta.url)
        try {
          const dir = await unpackNodePty()
          const pty = require(dir)
          if (typeof pty?.spawn !== 'function') throw new Error('node-pty без spawn()')
          return pty
        } catch (error) {
          ptyPromise = undefined
          throw error
        }
      })()
    }
    return ptyPromise
  }

  // ------------------------------------------------------------- profiles

  async function profilesRoute() {
    const now = Date.now()
    if (now - profileCache.at > 60_000) {
      const specs = profileSpecs({ platform, env, execPath })
      const list = await detectProfiles(specs, access)
      const base = list
      if (platform === 'win32') {
        for (const entry of base) {
          if (entry.id !== 'powershell') continue
          // Windows PowerShell always exists on supported Windows.
          entry.available = true
        }
        try {
          const distros = await listWslDistros()
          profileCache = { at: now, list: [...base, ...distros.map((name) => ({ id: `wsl:${name}`, label: `WSL: ${name}`, available: true }))] }
          return { profiles: cloneProfiles(profileCache.list) }
        } catch {
          // wsl.exe absent or slow: ship the base list without distros.
        }
      }
      profileCache = { at: now, list: base }
    }
    return { profiles: cloneProfiles(profileCache.list) }
  }

  function cloneProfiles(list) {
    return list.map((entry) => ({ ...entry }))
  }

  function runCaptured(file, args, timeoutMs) {
    return new Promise((resolve, reject) => {
      let child
      try {
        child = (spawnChild ?? spawnDetached)(file, args, { stdio: ['ignore', 'pipe', 'ignore'] })
      } catch (error) {
        reject(error)
        return
      }
      const chunks = []
      const timer = setTimeout(() => {
        try { child.kill() } catch {}
        reject(new Error('timeout'))
      }, timeoutMs)
      child.stdout?.on('data', (chunk) => chunks.push(chunk))
      child.once('error', (error) => {
        clearTimeout(timer)
        reject(error)
      })
      child.once('close', () => {
        clearTimeout(timer)
        resolve(Buffer.concat(chunks))
      })
    })
  }

  async function listWslDistros() {
    const buffer = await runCaptured('wsl.exe', ['-l', '-q'], 4000)
    return parseWslList(buffer)
  }

  // ------------------------------------------------------------- registry

  function nextTitle(spec, record) {
    let count = 0
    for (const existing of terminals.values()) {
      if (existing.profile === spec.id) count += 1
    }
    return count === 0 ? spec.label : `${spec.label} ${count + 1}`
  }

  function publicView(record) {
    return {
      id: record.id,
      title: record.title,
      profile: record.profile,
      alive: record.alive,
      cols: record.cols,
      rows: record.rows,
      offset: record.buffer.offset,
    }
  }

  function ownTerminal(body) {
    const id = typeof body?.id === 'string' ? body.id : ''
    const record = terminals.get(id)
    if (record === undefined) throw fail('Терминал не найден — он был закрыт или Host перезапустился.', 'no-terminal')
    if (typeof body?.sessionId === 'string' && body.sessionId !== '' && record.sessionId !== body.sessionId) {
      throw fail('Терминал принадлежит другой сессии.', 'no-terminal')
    }
    return record
  }

  function recordExit(record, code) {
    if (!record.alive) return
    record.alive = false
    record.exitCode = typeof code === 'number' ? code : 0
    record.diedAt = Date.now()
    record.events.emit('exit')
  }

  /** Dead terminals linger 5 minutes so late readers still see their tail. */
  const DEAD_LINGER_MS = 5 * 60_000

  function pruneDead() {
    const now = Date.now()
    for (const [id, record] of terminals) {
      if (!record.alive && record.diedAt !== undefined && now - record.diedAt > DEAD_LINGER_MS) terminals.delete(id)
    }
  }

  // --------------------------------------------------------------- routes

  async function termCreateRoute(body, options) {
    const profiles = await profilesRoute()
    const requested = typeof body?.profile === 'string' && body.profile !== '' ? body.profile : (platform === 'win32' ? 'powershell' : 'shell')
    const spec = profileSpecs({ platform, env, execPath }).find((candidate) => candidate.id === requested)
    if (spec === undefined) throw fail(`Неизвестный профиль терминала: ${requested}.`, 'bad-profile')
    const known = profiles.profiles.find((candidate) => candidate.id === requested)
    if (known !== undefined && known.available === false) throw fail(`Профиль недоступен: ${spec.label}.`, 'bad-profile')

    const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : ''
    const mine = [...terminals.values()].filter((record) => record.sessionId === sessionId)
    if (mine.length >= MAX_TERMINALS) throw fail(`Слишком много терминалов (максимум ${MAX_TERMINALS}).`, 'too-many')
    const cwd = typeof options?.cwd === 'string' && options.cwd !== '' ? options.cwd : undefined
    const cols = clampSize(body?.cols, 80, 1, 500)
    const rows = clampSize(body?.rows, 24, 1, 200)

    sequence += 1
    const id = `t${sequence.toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    const record = {
      id,
      sessionId,
      profile: spec.id,
      title: '',
      cwd,
      cols,
      rows,
      alive: true,
      exitCode: undefined,
      buffer: new RingBuffer(),
      events: new EventEmitter(),
      readsGone: 0,
      waiters: new Set(),
      kind: undefined,
      child: undefined,
      pty: undefined,
    }
    record.events.setMaxListeners(64)

    let launched = false
    let launchError = undefined
    try {
      const pty = await loadPty()
      const childEnv = { ...env, TERM: 'xterm-256color', COLORTERM: 'truecolor' }
      const optionsPty = { name: 'xterm-256color', cols, rows, cwd, env: childEnv, useConptyDll: true }
      let instance
      try {
        instance = pty.spawn(spec.file, spec.args ?? [], optionsPty)
      } catch {
        // conpty.dll path unavailable: retry with the classic conhost mode.
        instance = pty.spawn(spec.file, spec.args ?? [], { ...optionsPty, useConptyDll: false })
      }
      record.kind = 'pty'
      record.pty = instance
      instance.onData((data) => appendData(record, Buffer.from(String(data), 'utf8')))
      instance.onExit(({ exitCode }) => {
        recordExit(record, exitCode)
        record.pty = undefined
        pruneDead()
      })
      launched = true
    } catch (error) {
      launchError = error
    }

    if (!launched) {
      // Degrade to piped shells: worse (no echo, no colors in cmd), but usable.
      try {
        const child = (spawnChild ?? spawnDetached)(spec.file, spec.args ?? [], {
          cwd,
          env: { ...env, TERM: 'xterm-256color' },
          stdio: ['pipe', 'pipe', 'pipe'],
        })
        record.kind = 'pipe'
        record.child = child
        child.stdout?.on('data', (chunk) => appendData(record, chunk))
        child.stderr?.on('data', (chunk) => appendData(record, chunk))
        child.once('error', () => recordExit(record, 1))
        child.once('close', (code) => {
          recordExit(record, code)
          record.child = undefined
          pruneDead()
        })
        record.pipeMode = true
      } catch (pipeError) {
        throw fail(
          `Не удалось запустить ${spec.label}: ${launchError instanceof Error ? launchError.message : String(launchError ?? pipeError)}.`,
          'spawn-failed',
        )
      }
    }

    record.title = nextTitle(spec, record)
    terminals.set(id, record)
    return { ...publicView(record), kind: record.kind }
  }

  function appendData(record, chunk) {
    record.buffer.append(chunk)
    record.events.emit('data')
  }

  function clampSize(value, fallback, min, max) {
    const number = Number(value)
    if (!Number.isFinite(number)) return fallback
    return Math.min(max, Math.max(min, Math.round(number)))
  }

  async function termWriteRoute(body) {
    const record = ownTerminal(body)
    const data = typeof body?.data === 'string' ? body.data : ''
    if (data === '' || !record.alive) return { written: data !== '' && record.alive }
    if (record.kind === 'pty') record.pty.write(data)
    else if (record.child?.stdin?.writable === true) {
      // Piped shells need CRLF; a PTY translates Enter itself.
      record.child.stdin.write(data.replace(/\r(?!\n)/g, '\r\n'))
    }
    return { written: true }
  }

  async function termResizeRoute(body) {
    const record = ownTerminal(body)
    const cols = clampSize(body?.cols, record.cols, 1, 500)
    const rows = clampSize(body?.rows, record.rows, 1, 200)
    record.cols = cols
    record.rows = rows
    if (record.alive && record.kind === 'pty') {
      try { record.pty.resize(cols, rows) } catch { /* a dying shell may refuse; harmless */ }
    }
    return { resized: true }
  }

  async function termKillRoute(body) {
    const record = ownTerminal(body)
    if (record.alive) {
      try {
        if (record.kind === 'pty') record.pty.kill()
        else record.child?.kill()
      } catch { /* already gone */ }
    }
    terminals.delete(record.id)
    return { killed: true }
  }

  async function termListRoute(body) {
    pruneDead()
    const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : ''
    const list = []
    for (const record of terminals.values()) {
      if (sessionId !== '' && record.sessionId !== sessionId) continue
      list.push(publicView(record))
    }
    return { terminals: list }
  }

  async function termReadRoute(body, signal) {
    const record = ownTerminal(body)
    let from = Number(body?.offset)
    if (!Number.isFinite(from) || from < 0) from = record.buffer.dropped
    const waitMs = Math.min(MAX_WAIT_MS, Math.max(0, Number(body?.waitMs) || 15000))

    if (record.buffer.offset === from && record.alive && waitMs > 0) {
      await waitReadable(record, from, waitMs, signal)
    }

    const ended = !record.alive
    if (ended && record.buffer.offset === from) {
      return { id: record.id, data: '', offset: from, alive: false, exitCode: record.exitCode ?? 0 }
    }

    const { bytes, next, gap } = record.buffer.read(from)
    const payload = bytes.length === 0 ? Buffer.alloc(0) : Buffer.concat(bytes.map((piece) => Buffer.from(piece)))
    return {
      id: record.id,
      data: payload.length === 0 ? '' : payload.toString('base64'),
      offset: next,
      gap,
      alive: record.alive,
      exitCode: record.alive ? undefined : record.exitCode ?? 0,
    }
  }

  function waitReadable(record, from, waitMs, signal) {
    return new Promise((resolve) => {
      let done = false
      let timer
      const finish = () => {
        if (done) return
        done = true
        clearTimeout(timer)
        record.events.off('data', onData)
        record.events.off('exit', onExit)
        signal?.removeEventListener?.('abort', onAbort)
        resolve()
      }
      const onData = () => {
        if (record.buffer.offset !== from || !record.alive) finish()
      }
      const onExit = () => finish()
      const onAbort = () => finish()
      record.events.on('data', onData)
      record.events.once('exit', onExit)
      signal?.addEventListener?.('abort', onAbort, { once: true })
      if (signal?.aborted === true) finish()
      else timer = setTimeout(finish, waitMs)
    })
  }

  function killSession(sessionId) {
    for (const record of terminals.values()) {
      if (record.sessionId !== sessionId) continue
      try {
        if (record.alive && record.kind === 'pty') record.pty.kill()
        else if (record.alive) record.child?.kill()
      } catch { /* gone already */ }
      terminals.delete(record.id)
    }
  }

  function dispose() {
    for (const record of terminals.values()) {
      try {
        if (record.alive && record.kind === 'pty') record.pty.kill()
        else if (record.alive) record.child?.kill()
      } catch { /* gone already */ }
    }
    terminals.clear()
    ptyPromise = undefined
  }

  function spawnDetached(file, args, options) {
    return spawnNode(file, args, options)
  }

  return {
    profilesRoute,
    termCreateRoute,
    termWriteRoute,
    termResizeRoute,
    termKillRoute,
    termListRoute,
    termReadRoute,
    killSession,
    dispose,
    /** Test seam. */
    _terminals: terminals,
    _loadPty: loadPty,
  }
}
