/**
 * Host half of `@local/dsh-ide` — a tabbed, VS Code-shaped editor that brings
 * its own explorer and does not depend on the built-in file plugin.
 *
 * Responsibilities:
 *  - serve the vendored Monaco tree (`/ide/vs/…`) as static bytes;
 *  - open a text file from inside the calling session's workspace and hand the
 *    client its text plus an opaque revision token (one document per open tab);
 *  - save a document through that session's `ctx.fs` with a mandatory version
 *    check, under the session's sandbox policy (a read-only session stays
 *    read-only);
 *  - list workspace folders for the explorer and flatten the workspace for
 *    quick open;
 *  - remember which tabs a session had open (`~/.dsh/ide-state.json`);
 *  - answer cancellable inline-completion requests from the configured model;
 *  - report the live provider/model catalog and store the completion key
 *    through the credential store;
 *  - persist the completion preferences shared with the code-editor plugin
 *    (`~/.dsh/code-editor.json`).
 *
 * Every operation is an exact Fetch route below `/api`, which the connection
 * layer serves only to the owner principal (this machine's GUI page).
 */
import { appendFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  buildCatalog,
  clearCredential,
  credentialStatus,
  saveCredential,
} from './catalog.js'
import { buildContext, postprocessCompletion } from './completion.js'
import { optedInRoots, readPreferences, writePreferences } from './prefs.js'
import { boundLines, evaluateSuggestion, planEdit, reasonLabel } from './tab.js'
import { listFiles, listTree } from './tree.js'
import { readSessionState, writeSessionState } from './state.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ASSET_ROOT = path.join(HERE, 'vendor', 'vs')
const ASSET_PREFIX = '/ide/vs'
const API_PREFIX = '/api/ide/'

/** Files above this size stay in the preview: the editor refuses them. */
const MAX_EDIT_BYTES = 1024 * 1024
const CONTEXT_LEFT = 4000
const CONTEXT_RIGHT = 1000
/**
 * Ceiling on the buffer a client may send for completion context. The window
 * itself is bounded by `buildContext`; this only stops a client from pushing an
 * unbounded string through the request handler.
 */
const MAX_CONTEXT_TEXT_CHARS = 4 * 1024 * 1024
const COMPLETION_DEADLINE_MS = 20000
const COMPLETION_MAX_CHARS = 400

const CONTENT_TYPES = new Map([
  ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.map', 'application/json; charset=utf-8'],
  ['.ttf', 'font/ttf'],
  ['.woff', 'font/woff'],
  ['.woff2', 'font/woff2'],
  ['.svg', 'image/svg+xml'],
  ['.html', 'text/html; charset=utf-8'],
  ['.md', 'text/markdown; charset=utf-8'],
])

const EXTENSIONS = new Map([
  ['.ts', 'typescript'],
  ['.tsx', 'typescript'],
  ['.mts', 'typescript'],
  ['.cts', 'typescript'],
  ['.js', 'javascript'],
  ['.jsx', 'javascript'],
  ['.mjs', 'javascript'],
  ['.cjs', 'javascript'],
  ['.json', 'json'],
  ['.jsonc', 'json'],
  ['.css', 'css'],
  ['.scss', 'scss'],
  ['.less', 'less'],
  ['.html', 'html'],
  ['.htm', 'html'],
  ['.md', 'markdown'],
  ['.markdown', 'markdown'],
  ['.py', 'python'],
  ['.rb', 'ruby'],
  ['.go', 'go'],
  ['.rs', 'rust'],
  ['.java', 'java'],
  ['.kt', 'kotlin'],
  ['.c', 'c'],
  ['.h', 'c'],
  ['.cc', 'cpp'],
  ['.cpp', 'cpp'],
  ['.hpp', 'cpp'],
  ['.cs', 'csharp'],
  ['.php', 'php'],
  ['.sh', 'shell'],
  ['.bash', 'shell'],
  ['.ps1', 'powershell'],
  ['.yml', 'yaml'],
  ['.yaml', 'yaml'],
  ['.toml', 'ini'],
  ['.ini', 'ini'],
  ['.sql', 'sql'],
  ['.xml', 'xml'],
  ['.swift', 'swift'],
  ['.lua', 'lua'],
  ['.r', 'r'],
  ['.dart', 'dart'],
])

/**
 * Top-level keywords per language, used to cut a completion that starts a new
 * declaration mid-line. Mirrors Continue's `AutocompleteLanguageInfo` at commit
 * 5522c6f4; unknown languages fall back to TypeScript, as Continue does.
 */
const TOP_LEVEL_KEYWORDS = new Map([
  ['typescript', ['function', 'class', 'module', 'export', 'import', 'interface', 'type', 'enum', 'const', 'let', 'var']],
  ['javascript', ['function', 'class', 'export', 'import', 'const', 'let', 'var']],
  ['python', ['def', 'class', 'import', 'from']],
  ['go', ['func', 'package', 'import', 'type', 'var', 'const']],
  ['rust', ['fn', 'mod', 'pub', 'struct', 'enum', 'trait', 'impl', 'use']],
  ['java', ['public', 'private', 'protected', 'class', 'interface', 'import', 'package']],
  ['csharp', ['public', 'private', 'protected', 'internal', 'class', 'interface', 'namespace', 'using']],
  ['c', ['int', 'void', 'char', 'struct', 'include']],
  ['cpp', ['int', 'void', 'class', 'struct', 'namespace', 'template', 'include']],
  ['ruby', ['def', 'class', 'module', 'require']],
  ['php', ['function', 'class', 'namespace', 'use']],
  ['kotlin', ['fun', 'class', 'object', 'import', 'package']],
  ['swift', ['func', 'class', 'struct', 'enum', 'import', 'protocol']],
  ['sql', ['select', 'insert', 'update', 'delete', 'create', 'alter', 'drop']],
  ['shell', ['function']],
])

function topLevelKeywordsFor(language) {
  return TOP_LEVEL_KEYWORDS.get(String(language)) ?? TOP_LEVEL_KEYWORDS.get('typescript')
}

export const inject = [
  'fs',
  'webServer',
  'connection',
  'sessions',
  'workingDirectory',
  'sandboxPolicy',
  'llm',
  'agentDefaultModel',
]

export function apply(ctx, config) {
  /** Open documents: id → host-side record. Never crosses the wire. */
  const documents = new Map()
  /** Workspace roots whose owner opted into smart Tab. */
  const optedIn = new Set()
  /** Files explicitly excluded from smart Tab by the owner. */
  const excludedFiles = new Set()
  let sequence = 0

  const json = (value, status = 200) =>
    new Response(JSON.stringify(value), {
      status,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    })

  const fail = (code, message) => ({ error: { code, message } })

  const token = () => {
    sequence += 1
    return `${sequence.toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  }

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: ASSET_PREFIX,
        resource: serveAsset,
      }),
    'dsh-ide: Monaco assets',
  )

  const handlers = {
    open: (body, signal) => open(body, signal),
    save: (body, signal) => save(body, signal),
    settings: (body) => settings(body),
    complete: (body, signal) => complete(body, signal),
    resolve: (body) => resolveSession(body),
    tree: (body, signal) => treeRoute(body, signal),
    files: (body, signal) => filesRoute(body, signal),
    create: (body, signal) => createRoute(body, signal),
    mkdir: (body, signal) => mkdirRoute(body, signal),
    rename: (body, signal) => renameRoute(body, signal),
    remove: (body, signal) => removeRoute(body, signal),
    state: (body) => stateRoute(body),
    catalog: () => buildCatalog(ctx),
    credentials: (body) => credentialsRoute(body),
    prefs: (body) => prefsRoute(body),
  }

  for (const [name, handler] of Object.entries(handlers)) {
    ctx.effect(
      () =>
        ctx.connection.fetch.register({
          path: `${API_PREFIX}${name}`,
          methods: ['POST'],
          requestBody: 'buffered',
          fetch: async (request) => {
            let body
            try {
              body = await request.json()
            } catch {
              return json(fail('bad-request', 'Тело запроса не является JSON'), 400)
            }
            try {
              return json(await handler(body && typeof body === 'object' ? body : {}, request.signal))
            } catch (error) {
              return json({ error: describe(error) })
            }
          },
        }),
      `dsh-ide: route ${name}`,
    )
  }

  // ---------------------------------------------------------------- helpers

  function describe(error) {
    const code = error && typeof error === 'object' ? String(error.code ?? '') : ''
    const message = error instanceof Error ? error.message : String(error)
    if (code === 'FS_STALE_VERSION') {
      return {
        code: 'stale',
        message: 'Файл изменился на диске после открытия — переоткройте его, чтобы не потерять чужие правки.',
      }
    }
    if (code === 'FS_SANDBOX_DENIED' || code === 'FS_READ_ONLY') {
      return { code: 'read-only', message: 'Сессия работает в режиме только для чтения — сохранение запрещено.' }
    }
    if (code === 'ABORT_ERR' || code === 'ABORTED' || error?.name === 'AbortError') {
      return { code: 'cancelled', message: 'Запрос отменён.' }
    }
    return { code: code || 'operation-failed', message }
  }

  function sessionOf(body) {
    const id = body?.sessionId
    if (typeof id !== 'string' || id.length === 0) return undefined
    const session = ctx.sessions.get(id)
    if (session === undefined) return undefined
    const cwd = ctx.workingDirectory.get(session)
    return { session, cwd, id }
  }

  async function rootTarget(cwd, signal) {
    return ctx.fs.resolve(cwd, { signal })
  }

  // ------------------------------------------------------------------- open

  async function open(body, signal) {
    const scope = sessionOf(body)
    if (scope === undefined) return fail('no-session', 'Сессия не найдена — откройте файл из активной сессии.')
    const preferences = await readPreferences()
    const requestPath = typeof body.path === 'string' ? body.path : ''
    if (requestPath.trim() === '') return fail('bad-request', 'Не указан путь к файлу.')

    const target = await ctx.fs.resolve(requestPath, { cwd: scope.cwd, signal })
    const displayPath = ctx.fs.processPath(target)
    const root = await rootTarget(scope.cwd, signal)
    if (!ctx.fs.contains(root, target)) {
      return fail('outside-workspace', `Файл вне рабочей папки сессии: ${displayPath}`)
    }

    const info = await ctx.fs.stat(target, signal)
    if (info === undefined) return fail('not-found', `Файл не найден: ${displayPath}`)
    if (info.type !== 'file') return fail('not-a-file', `Это не обычный файл: ${displayPath}`)
    if (info.size !== undefined && info.size > MAX_EDIT_BYTES) {
      return fail('too-large', `Файл больше 1 МиБ (${info.size} байт) — редактор такие не открывает.`)
    }

    const bytes = await ctx.fs.readBytes(target, signal, MAX_EDIT_BYTES + 1)
    if (bytes.byteLength > MAX_EDIT_BYTES) {
      return fail('too-large', 'Файл больше 1 МиБ — редактор такие не открывает.')
    }
    const decoded = decodeUtf8(bytes)
    if (decoded === undefined) {
      return fail('unsupported-encoding', 'Файл не является текстом UTF-8 (или содержит NUL) — только просмотр.')
    }

    const eol = detectEol(decoded.text)
    const text = decoded.text.replace(/\r\n/g, '\n')
    const mode = ctx.sandboxPolicy.resolve({ session: scope.session }).mode

    let record
    do {
      record = { id: token(), token: token() }
    } while (documents.has(record.id))

    documents.set(record.id, {
      id: record.id,
      sessionId: scope.id,
      target,
      version: info.version,
      token: record.token,
      eol,
      bom: decoded.bom,
      displayPath,
      workspaceRoot: scope.cwd,
      language: languageOf(displayPath),
    })

    return {
      id: record.id,
      sessionId: scope.id,
      token: record.token,
      text,
      eol,
      bom: decoded.bom,
      language: languageOf(displayPath),
      displayPath,
      relativePath: relativeOf(scope.cwd, displayPath),
      workspaceRoot: scope.cwd,
      size: bytes.byteLength,
      model: ctx.agentDefaultModel.currentSelection(),
      readOnly: mode === 'read-only',
      completionExcluded: completionExcluded(displayPath),
      fileExcluded: excludedFiles.has(fileKey(displayPath)),
      smartTab: optedIn.has(scope.cwd) && !completionExcluded(displayPath) && !excludedFiles.has(fileKey(displayPath)),
      context: { left: preferences.contextLeft, right: preferences.contextRight },
      preferences,
    }
  }

  // ------------------------------------------------------------------- save

  async function save(body, signal) {
    const document = documents.get(body.id)
    if (document === undefined) return fail('no-document', 'Документ не открыт — откройте файл заново.')
    if (body.sessionId !== document.sessionId) return fail('wrong-session', 'Документ принадлежит другой сессии.')
    if (body.token !== document.token) {
      return fail('stale-client', 'Редактор потерял актуальную версию файла — переоткройте его.')
    }
    if (typeof body.text !== 'string') return fail('bad-request', 'Не передано содержимое файла.')

    const session = ctx.sessions.get(document.sessionId)
    if (session === undefined) return fail('no-session', 'Сессия закрыта — сохранение невозможно.')
    const policy = ctx.sandboxPolicy.resolve({ session })
    if (policy.mode === 'read-only') {
      return fail('read-only', 'Сессия работает в режиме только для чтения — сохранение запрещено.')
    }

    const content =
      (document.bom ? '\uFEFF' : '') +
      (document.eol === 'crlf' ? body.text.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n') : body.text)

    const outcome = await ctx.fs.writeText(
      document.target,
      content,
      { kind: 'replaceIfVersion', version: document.version },
      signal,
      policy,
    )
    document.version = outcome.version
    document.token = token()
    return { token: document.token, operation: outcome.operation }
  }

  // --------------------------------------------------------------- settings

  async function settings(body) {
    const scope = sessionOf(body)
    if (scope === undefined) return fail('no-session', 'Сессия не найдена.')
    const document = documents.get(body.id)
    if (document === undefined || document.sessionId !== scope.id) return fail('no-document', 'Документ не открыт в этой сессии.')
    const preferences = await readPreferences()
    if (body.excludeFile !== undefined) {
      if (body.excludeFile === true) excludedFiles.add(fileKey(document.displayPath))
      else excludedFiles.delete(fileKey(document.displayPath))
    }
    if (body.smartTab === true && completionExcluded(document.displayPath)) {
      return fail('excluded-file', 'Подсказки отключены для файла с вероятными секретами.')
    }
    if (body.smartTab === true) optedIn.add(scope.cwd)
    else if (body.smartTab === false) optedIn.delete(scope.cwd)
    if (body.smartTab === true || body.smartTab === false) {
      // The permission is remembered: an editor restart must not silently turn
      // completions back off, which reads to the user as "suggestions broke".
      const roots = optedInRoots(preferences)
      const next =
        body.smartTab === true
          ? roots.includes(scope.cwd)
            ? roots
            : [...roots, scope.cwd].slice(-20)
          : roots.filter((root) => root !== scope.cwd)
      await writePreferences({ completionOptIn: next })
    }
    return {
      smartTab: optedIn.has(scope.cwd) && !completionExcluded(document.displayPath) && !excludedFiles.has(fileKey(document.displayPath)),
      fileExcluded: excludedFiles.has(fileKey(document.displayPath)),
      workspaceRoot: scope.cwd,
      context: { left: preferences.contextLeft, right: preferences.contextRight },
    }
  }

  // ------------------------------------------------------------- completion

  async function complete(body, signal) {
    const document = documents.get(body.id)
    if (document === undefined) return fail('no-document', 'Документ не открыт.')
    if (body.sessionId !== document.sessionId) return fail('wrong-session', 'Документ принадлежит другой сессии.')
    if (body.token !== document.token) return fail('stale-client', 'Редактор потерял актуальную версию файла.')
    const preferences = await readPreferences()
    const kind = body.kind === 'explicit' ? 'explicit' : body.kind === 'refetch' ? 'refetch' : body.explicit === true ? 'explicit' : 'auto'
    if (
      !optedIn.has(document.workspaceRoot) &&
      !optedInRoots(preferences).includes(document.workspaceRoot)
    ) {
      return fail('not-opted-in', 'Подсказки не включены для этой рабочей папки.')
    }
    if (completionExcluded(document.displayPath)) {
      return fail('excluded-file', 'Подсказки отключены для файла с вероятными секретами.')
    }
    if (excludedFiles.has(fileKey(document.displayPath))) {
      return fail('excluded-file', 'Подсказки выключены для этого файла.')
    }

    const rawText = String(body.text ?? '')
    if (rawText.length > MAX_CONTEXT_TEXT_CHARS) {
      return fail('context-too-large', 'Файл слишком велик для подсказок в редакторе.')
    }
    if (rawText.length > preferences.maxFileChars) {
      logCompletion({
        file: document.displayPath,
        language: document.language,
        kind,
        suppressed: 'file-too-large',
        fileChars: rawText.length,
        limit: preferences.maxFileChars,
      })
      return {
        text: '',
        requestId: randomUUID(),
        provider: '',
        model: '',
        durationMs: 0,
        reason: reasonLabel('file-too-large'),
        suppressed: { reason: 'file-too-large' },
        trajectory: { kind, suppressed: 'file-too-large', fileChars: rawText.length, explicit: kind === 'explicit' },
      }
    }
    const left = boundedWindow(body.contextLeft, preferences.contextLeft)
    const right = boundedWindow(body.contextRight, preferences.contextRight)
    const context = buildContext({
      text: rawText,
      offset: Number(body.offset ?? 0),
      left,
      right,
      selection: String(body.selection ?? ''),
    })
    // A client that still sends pre-sliced windows keeps working, and it is held
    // to the same budget it was granted rather than the configured default.
    const prefix = context.prefix === '' ? clip(String(body.prefix ?? ''), left, 'end') : context.prefix
    const suffix = context.suffix === '' ? clip(String(body.suffix ?? ''), right, 'start') : context.suffix
    if (preferences.triggerInComments !== true && looksLikeCommentLine(prefix)) {
      logCompletion({ file: document.displayPath, language: document.language, kind, suppressed: 'comment-line' })
      return {
        text: '',
        requestId: randomUUID(),
        provider: '',
        model: '',
        durationMs: 0,
        reason: reasonLabel('comment-line'),
        suppressed: { reason: 'comment-line' },
        trajectory: { kind, suppressed: 'comment-line', explicit: kind === 'explicit' },
      }
    }
    // `aboveLines`/`belowLines` bound the prompt by lines; the character window
    // above only keeps the request itself bounded. Both are settings the user
    // can change in the IDE drawer.
    const windowPrefix = boundLines(prefix, preferences.aboveLines, 'end')
    const windowSuffix = boundLines(suffix, preferences.belowLines, 'start')
    const selection = ctx.agentDefaultModel.currentSelection()
    if (!selection || typeof selection.provider !== 'string' || typeof selection.model !== 'string') {
      return fail('no-model', 'Модель не выбрана — подсказки недоступны, редактор работает.')
    }
    // A reasoning model spends the whole token budget on `reasoning_content` and
    // returns an empty answer, which reads in the GUI as "smart Tab does
    // nothing". So the completion is allowed to name its own model, and an empty
    // answer from the session model is not the end of the attempt.
    //
    // Precedence: an explicit request from the editor, then the saved
    // preference, then the plugin config, then DSH_CODE_EDITOR_MODEL. The
    // provider follows the model: a preference that names only a model keeps the
    // session provider, and one that names only a provider uses its first model.
    const requestedModel = String(
      (typeof body.model === 'string' ? body.model : '') ||
        preferences.completionModel ||
        (typeof config === 'object' && config !== null && typeof config.completionModel === 'string'
          ? config.completionModel
          : '') ||
        process.env.DSH_CODE_EDITOR_MODEL ||
        '',
    ).trim()
    // Where the model came from, so the trajectory can say why the session's own
    // model appears in a row: an empty preference means "whatever the session
    // uses", not "a broken completion setting".
    const modelSource =
      (typeof body.model === 'string' && body.model.trim() !== '')
        ? 'request'
        : String(preferences.completionModel ?? '').trim() !== ''
          ? 'settings'
          : typeof config === 'object' && config !== null && String(config.completionModel ?? '').trim() !== ''
            ? 'config'
            : String(process.env.DSH_CODE_EDITOR_MODEL ?? '').trim() !== ''
              ? 'env'
              : 'session'
    const requestedProvider = String(
      (typeof body.provider === 'string' ? body.provider : '') || preferences.completionProvider || '',
    ).trim() || selection.provider
    const attempts = []
    if (requestedModel !== '') attempts.push({ provider: requestedProvider, model: requestedModel })
    if (requestedProvider !== selection.provider) {
      // A provider without a model cannot be called: ask its catalog for the
      // first advertised model so the choice still means something.
      try {
        const models = await ctx.llm.listModels(requestedProvider)
        const first = Array.isArray(models) ? models[0] : undefined
        if (first !== undefined && typeof first.id === 'string') {
          attempts.push({ provider: requestedProvider, model: first.id })
        }
      } catch {
        // The failure surfaces as "no model answered" below, with the provider
        // named in the log line.
      }
    }
    if (!attempts.some(attempt => attempt.provider === selection.provider && attempt.model === selection.model)) {
      attempts.push({ provider: selection.provider, model: selection.model })
    }

    const systemPrompt =
      'Ты — движок строчных подсказок в редакторе кода. Продолжи текст ровно с позиции курсора. ' +
      'Ответь только вставляемым продолжением: без пояснений, без markdown-ограждений, без повторения ' +
      `уже написанного кода. Продолжение должно быть коротким (1–${preferences.answerLines} строк) и синтаксически уместным. ` +
      'Если строка перед курсором — комментарий, который просит написать код, начни ответ с перевода ' +
      'строки и напиши код на следующей строке: не повторяй текст комментария и не ставь решётку. ' +
      'Если уместного продолжения нет, ответь пустой строкой.'
    // The suffix must follow its own header: an inverted layout tells the model to
    // continue past the text that comes after the cursor, which produced empty
    // answers for every request of the first benchmark.
    const requestText =
      `Файл: ${document.displayPath}\n` +
      `Язык: ${document.language}\n\n` +
      `--- текст до курсора ---\n${windowPrefix}\n--- курсор ---\n` +
      `--- текст после курсора ---\n${windowSuffix}`

    const deadline = AbortSignal.timeout(boundedMs(preferences.deadlineMs, COMPLETION_DEADLINE_MS, 1000, 60000))
    const combined = signal === undefined ? deadline : AbortSignal.any([signal, deadline])
    const flushAfterMs = boundedMs(preferences.flushAfterMs, 250, 0, 5000)
    const startedAt = Date.now()

    // A thinking model spends the output budget on hidden reasoning and then
    // returns nothing, and it is also what turned a hint into a 20 s wait.
    // DSH exposes an adapter-owned `off` level that sends `thinking: { type:
    // disabled }` for routes whose compat declares `thinkingFormat: deepseek`.
    // Measured against the same gateway on a 20-line Python prompt: `off` put
    // the first character on the wire in 1.6 s, while the default effort spent
    // the whole budget on reasoning and never emitted text at all. A level the
    // route rejects fails before any network I/O, so the chain below falls back
    // cheaply; `undefined` means "provider default".
    const effortChain = effortChainFor(preferences.completionEffort)
    const attemptsForKind = kind === 'explicit' ? attempts : attempts.slice(0, 1)

    let text = ''
    let used = attemptsForKind[0]
    let effortsAdvertised = []
    let effortUsed
    let flushed = false
    // The stream can end without any text and without throwing: a refusal or a
    // transport failure arrives as its own chunk. Collecting the chunk types is
    // what tells that apart from "the model answered nothing" — the empty
    // answer and the broken call both looked like "smart Tab does nothing".
    const chunkTypes = new Set()
    let streamError = ''
    let finishReason = ''
    let firstChunk = ''
    for (const attempt of attemptsForKind) {
      // Asking the route for its reasoning catalogue is only needed when a level
      // has to be chosen. With the default (empty) preference there is nothing to
      // choose, and the extra round trip is pure latency on a keystroke.
      if (effortChain.length === 1 && effortChain[0] === undefined) {
        effortsAdvertised = []
      } else {
        try {
          const info = await ctx.llm.resolveModelInfo(attempt.provider, attempt.model, combined)
          effortsAdvertised = Array.isArray(info?.reasoning?.efforts) ? info.reasoning.efforts.map(effort => effort.id) : []
        } catch {
          effortsAdvertised = []
        }
      }
      for (const effort of effortChain) {
        let buffer = ''
        let firstTextAt = 0
        let unsupported = false
        streamError = ''
        finishReason = ''
        try {
          for await (const chunk of ctx.llm.stream({
            provider: attempt.provider,
            model: attempt.model,
            ...(effort === undefined ? {} : { reasoningEffort: effort }),
            system: systemPrompt,
            // Message content is a list of typed blocks, not a bare string:
            // every other host-side caller in this installation passes
            // `[{ type: 'text', text }]`, and a string content made the adapter
            // end the stream immediately with no chunk at all (2 ms, empty).
            messages: [
              {
                role: 'user',
                content: [
                  {
                    type: 'text',
                    text: requestText,
                  },
                ],
              },
            ],
            // The answer is at most `answerLines` lines of code, so the budget is
            // sized to that instead of a flat 900: a shorter budget comes back
            // sooner, and a thinking model still cannot spend it all on reasoning
            // when the level is `off`.
            maxTokens: Math.min(900, Math.max(80, preferences.answerLines * 40 + 40)),
            temperature: 0.1,
            signal: combined,
            sessionId: document.sessionId,
            purpose: 'code-editor-inline-completion',
          })) {
            if (!chunk || typeof chunk !== 'object') continue
            if (firstChunk === '') {
              try {
                firstChunk = JSON.stringify(chunk).slice(0, 400)
              } catch {
                firstChunk = '<unserializable chunk>'
              }
            }
            if (typeof chunk.type === 'string' && chunkTypes.size < 8) chunkTypes.add(chunk.type)
            if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
              if (firstTextAt === 0) firstTextAt = Date.now()
              buffer += chunk.text
            }
            if (chunk.type === 'error') {
              const detail = chunk.message ?? chunk.error?.message ?? chunk.error
              streamError = typeof detail === 'string' && detail !== '' ? detail : 'stream-error'
            }
            if (chunk.type === 'finish') {
              // A failed call finishes the stream with `reason.kind: "error"`
              // and the cause under `reason.failure`; it is not a thrown error
              // and not a `type: "error"` chunk, so reading only those two made
              // a rejected request look like "the model answered nothing".
              const reason = chunk.reason ?? {}
              if (reason.kind === 'error' && reason.failure !== undefined && reason.failure !== null) {
                const message = typeof reason.failure.message === 'string' ? reason.failure.message : ''
                const code = typeof reason.failure.code === 'string' ? reason.failure.code : ''
                streamError = message !== '' ? message : code !== '' ? code : 'stream-error'
                if (code !== '') finishReason = code
              } else {
                finishReason = typeof reason.kind === 'string' ? reason.kind : 'finish'
              }
            }
            if (typeof chunk.finishReason === 'string' && chunk.finishReason !== '') finishReason = chunk.finishReason
            // Cursor draws the beginning of an answer while the rest of the
            // stream is still arriving. A whole answer is never worth 20 s of
            // silence, so once text has started, a short grace period ends the
            // stream and the hint appears with what is already there.
            if (firstTextAt !== 0 && Date.now() - firstTextAt >= flushAfterMs) {
              flushed = true
              break
            }
            if (buffer.length > COMPLETION_MAX_CHARS) break
          }
        } catch (cause) {
          streamError = cause instanceof Error ? cause.message : String(cause)
        }
        unsupported = buffer.trim() === '' && isUnsupportedEffort(streamError)
        if (unsupported && effortChain.indexOf(effort) < effortChain.length - 1) continue
        used = { provider: attempt.provider, model: attempt.model, ...(effort === undefined ? {} : { effort }) }
        effortUsed = effort
        text = buffer
        break
      }
      if (text.trim() !== '') break
    }

    const answer = postprocessCompletion({
      completion: text,
      prefix,
      suffix,
      topLevelKeywords: topLevelKeywordsFor(document.language),
    })

    const result = sanitizeCompletion(answer)

    // Where the answer lands and whether it is worth showing. Both decisions
    // used to live in Cursor's server response (`range_to_replace` plus the
    // bad-case heuristics); here the Host owns them because it already has the
    // whole buffer, and every knob below is a saved preference.
    const requestId = randomUUID()
    const modelVersion = Number.isFinite(Number(body.modelVersion)) ? Number(body.modelVersion) : undefined
    const planOptions = {
      rangeReplace: preferences.rangeReplace,
      rangeReplaceLines: preferences.rangeReplaceLines,
      showWhitespaceOnlyChanges: preferences.showWhitespaceOnlyChanges,
      heuristicDuplicateLine: preferences.heuristicDuplicateLine,
      heuristicExtendsRange: preferences.heuristicExtendsRange,
      maxAddedLines: preferences.maxAddedLines,
      recentRejectThreshold: preferences.recentRejectThreshold,
      recentRejectWindowMs: preferences.recentRejectWindowMs,
      heuristicRevertingChange: preferences.heuristicRevertingChange,
    }
    const plan = planEdit({
      text: rawText,
      offset: Number(body.offset ?? 0),
      suggestion: result,
      options: planOptions,
    })
    const verdict = evaluateSuggestion({
      text: rawText,
      plan,
      options: planOptions,
      rejections: readRecords(body.rejections),
      revertions: readRecords(body.revertions),
    })
    const accepted = verdict.accepted && plan.insertText !== ''

    // The GUI shows nothing when the answer is empty, so every attempt records
    // what it was and what came back; without this line "smart Tab does not
    // work" is impossible to tell apart from "the model answered nothing".
    logCompletion({
      file: document.displayPath,
      language: document.language,
      provider: used.provider,
      model: used.model,
      modelSource,
      effort: effortUsed ?? '',
      flushed,
      rawChars: text.length,
      answerChars: result.length,
      ms: Date.now() - startedAt,
      attempts: attempts.length,
      effort: effortUsed ?? '',
      efforts: effortsAdvertised,
      flushed,
      chunkTypes: [...chunkTypes],
      finishReason,
      error: streamError,
      firstChunk,
      kind,
      planKind: plan.kind,
      planChars: plan.insertText.length,
      planLines: plan.insertText === '' ? 0 : plan.insertText.split('\n').length,
      removedChars: plan.removedText.length,
      suppressed: accepted ? '' : verdict.reason,
    })
    // An empty answer is a normal outcome the user has to be able to read, so
    // it comes back with the same diagnostics block as a real completion. A
    // suppressed answer names the check that dropped it.
    const reason =
      streamError !== ''
        ? `Модель не ответила: ${streamError}`
        : finishReason === 'length'
          ? 'Модель израсходовала лимит на рассуждения — включите менее «думающую» модель.'
          : text.trim() === ''
            ? 'Модель не вернула продолжение.'
            : accepted
              ? ''
              : reasonLabel(verdict.reason)
    return {
      // `text` stays the final insert text: the client only has to apply it.
      // A suppressed answer returns an empty string and a reason, never the
      // rejected code.
      text: accepted ? plan.insertText : '',
      requestId,
      kind,
      planKind: plan.kind,
      range: { start: plan.startOffset, end: plan.endOffset },
      removedText: plan.removedText,
      modelVersion,
      provider: used.provider,
      model: used.model,
      modelSource,
      effort: effortUsed ?? '',
      fellBack:
        attemptsForKind.length > 0 &&
        (used.provider !== attemptsForKind[0].provider || used.model !== attemptsForKind[0].model),
      durationMs: Date.now() - startedAt,
      reason,
      suppressed: accepted ? undefined : { reason: verdict.reason },
      // The IDE renders these in its output panel: the trajectory explains what
      // was attempted and what came back, the conversation shows the exact text.
      trajectory: {
        attempts: attempts.map(attempt => `${attempt.provider} / ${attempt.model}`),
        modelSource,
        effort: effortUsed ?? '',
        efforts: effortsAdvertised,
        flushed,
        finishReason,
        streamError,
        chunkTypes: [...chunkTypes],
        rawChars: text.length,
        answerChars: result.length,
        before: windowPrefix.length,
        after: windowSuffix.length,
        explicit: kind === 'explicit',
        kind,
        planKind: plan.kind,
        planChars: plan.insertText.length,
        planLines: plan.insertText === '' ? 0 : plan.insertText.split('\n').length,
        removedChars: plan.removedText.length,
        suppressed: accepted ? '' : verdict.reason,
      },
      conversation: { system: systemPrompt, message: requestText, answer: text },
    }
  }

  // ---------------------------------------------------------------- resolve

  async function resolveSession(body) {
    const requestPath = typeof body.path === 'string' ? body.path : ''
    if (requestPath.trim() === '') return fail('bad-request', 'Не указан путь к файлу.')
    for (const session of ctx.sessions.list()) {
      let cwd
      try {
        cwd = ctx.workingDirectory.get(session)
      } catch {
        continue
      }
      if (typeof cwd !== 'string' || cwd === '') continue
      let target
      let root
      try {
        target = await ctx.fs.resolve(requestPath, { cwd })
        root = await ctx.fs.resolve(cwd)
      } catch {
        continue
      }
      if (ctx.fs.contains(root, target)) {
        return { sessionId: session.id, relativePath: relativeOf(cwd, ctx.fs.processPath(target)) }
      }
    }
    return fail('no-session', 'Не нашли сессию, в рабочей папке которой лежит этот файл.')
  }

  // ------------------------------------------------------------------- tree

  async function treeRoute(body, signal) {
    const scope = sessionOf(body)
    if (scope === undefined) return fail('no-session', 'Сессия не найдена — откройте файл из активной сессии.')
    const preferences = await readPreferences()
    return listTree(ctx, {
      cwd: scope.cwd,
      relativePath: typeof body.path === 'string' ? body.path : '',
      hidden: body.hidden === undefined ? preferences.hiddenFiles === true : body.hidden === true,
      signal,
    })
  }

  // ---------------------------------------------------------- editor state

  async function filesRoute(body, signal) {
    const scope = sessionOf(body)
    if (scope === undefined) return fail('no-session', 'Сессия не найдена — откройте папку из активной сессии.')
    const preferences = await readPreferences()
    return listFiles(ctx, {
      cwd: scope.cwd,
      hidden: body.hidden === undefined ? preferences.hiddenFiles === true : body.hidden === true,
      limit: typeof body.limit === 'number' ? body.limit : undefined,
      signal,
    })
  }

  // ----------------------------------------------------------------- create

  async function createRoute(body, signal) {
    const scope = sessionOf(body)
    if (scope === undefined) return fail('no-session', 'Сессия не найдена — откройте папку из активной сессии.')
    const mode = ctx.sandboxPolicy.resolve({ session: scope.session }).mode
    if (mode === 'read-only') return fail('read-only', 'Рабочая папка открыта только для чтения.')
    const relative = typeof body.path === 'string' ? body.path.trim() : ''
    const segments = relative.split(/[\\/]+/)
    if (relative === '' || relative.length > 400 || segments.some((segment) => segment === '..' || segment === '')) {
      return fail('bad-request', 'Укажите путь к новому файлу внутри рабочей папки.')
    }
    const root = await ctx.fs.resolve(scope.cwd, { signal })
    const target = await ctx.fs.resolve(path.resolve(scope.cwd, relative), { signal })
    if (!ctx.fs.contains(root, target)) return fail('outside-workspace', 'Файл должен находиться внутри рабочей папки.')
    const nativePath = ctx.fs.processPath(target)
    await mkdir(path.dirname(nativePath), { recursive: true })
    try {
      await writeFile(nativePath, '', { flag: 'wx' })
    } catch (error) {
      if (error !== null && typeof error === 'object' && error.code === 'EEXIST') {
        return fail('exists', 'Файл с таким путём уже существует — откройте его через Ctrl+P.')
      }
      throw error
    }
    return { path: relative, created: true }
  }

  async function mkdirRoute(body, signal) {
    const scope = sessionOf(body)
    if (scope === undefined) return fail('no-session', 'Сессия не найдена — откройте папку из активной сессии.')
    const mode = ctx.sandboxPolicy.resolve({ session: scope.session }).mode
    if (mode === 'read-only') return fail('read-only', 'Рабочая папка открыта только для чтения.')
    const relative = typeof body.path === 'string' ? body.path.trim() : ''
    const segments = relative.split(/[\\/]+/)
    if (relative === '' || relative.length > 400 || segments.some((segment) => segment === '..' || segment === '')) {
      return fail('bad-request', 'Укажите путь к новой папке внутри рабочей папки.')
    }
    const root = await ctx.fs.resolve(scope.cwd, { signal })
    const target = await ctx.fs.resolve(path.resolve(scope.cwd, relative), { signal })
    if (!ctx.fs.contains(root, target)) return fail('outside-workspace', 'Папка должна находиться внутри рабочей папки.')
    const nativePath = ctx.fs.processPath(target)
    const existing = await stat(nativePath).catch(() => undefined)
    if (existing !== undefined) return fail('exists', 'Папка с таким путём уже существует.')
    await mkdir(nativePath, { recursive: true })
    return { path: relative, created: true }
  }

  async function renameRoute(body, signal) {
    const scope = sessionOf(body)
    if (scope === undefined) return fail('no-session', 'Сессия не найдена — откройте папку из активной сессии.')
    const mode = ctx.sandboxPolicy.resolve({ session: scope.session }).mode
    if (mode === 'read-only') return fail('read-only', 'Рабочая папка открыта только для чтения.')
    const from = typeof body.path === 'string' ? body.path.trim() : ''
    const to = typeof body.to === 'string' ? body.to.trim() : ''
    for (const relative of [from, to]) {
      const segments = relative.split(/[\\/]+/)
      if (relative === '' || relative.length > 400 || segments.some((segment) => segment === '..' || segment === '')) {
        return fail('bad-request', 'Укажите путь внутри рабочей папки.')
      }
    }
    const root = await ctx.fs.resolve(scope.cwd, { signal })
    const targetFrom = await ctx.fs.resolve(path.resolve(scope.cwd, from), { signal })
    const targetTo = await ctx.fs.resolve(path.resolve(scope.cwd, to), { signal })
    if (!ctx.fs.contains(root, targetFrom) || !ctx.fs.contains(root, targetTo)) {
      return fail('outside-workspace', 'Переименование возможно только внутри рабочей папки.')
    }
    const nativeFrom = ctx.fs.processPath(targetFrom)
    const nativeTo = ctx.fs.processPath(targetTo)
    const existingFrom = await stat(nativeFrom).catch(() => undefined)
    if (existingFrom === undefined) return fail('not-found', 'Такого файла или папки больше нет — обновите дерево.')
    const existingTo = await stat(nativeTo).catch(() => undefined)
    if (existingTo !== undefined) return fail('exists', 'По новому пути уже что-то есть — выберите другое имя.')
    await mkdir(path.dirname(nativeTo), { recursive: true })
    await rename(nativeFrom, nativeTo)
    return { path: to, renamed: true }
  }

  async function removeRoute(body, signal) {
    const scope = sessionOf(body)
    if (scope === undefined) return fail('no-session', 'Сессия не найдена — откройте папку из активной сессии.')
    const mode = ctx.sandboxPolicy.resolve({ session: scope.session }).mode
    if (mode === 'read-only') return fail('read-only', 'Рабочая папка открыта только для чтения.')
    const relative = typeof body.path === 'string' ? body.path.trim() : ''
    const segments = relative.split(/[\\/]+/)
    if (relative === '' || relative.length > 400 || segments.some((segment) => segment === '..' || segment === '')) {
      return fail('bad-request', 'Нельзя удалить рабочую папку целиком — укажите файл или вложенную папку.')
    }
    const root = await ctx.fs.resolve(scope.cwd, { signal })
    const target = await ctx.fs.resolve(path.resolve(scope.cwd, relative), { signal })
    if (!ctx.fs.contains(root, target)) return fail('outside-workspace', 'Удаление возможно только внутри рабочей папки.')
    const nativePath = ctx.fs.processPath(target)
    const info = await stat(nativePath).catch(() => undefined)
    if (info === undefined) return fail('not-found', 'Такого файла или папки больше нет — обновите дерево.')
    await rm(nativePath, { recursive: true, force: false })
    return { path: relative, removed: true }
  }

  async function stateRoute(body) {
    const scope = sessionOf(body)
    if (scope === undefined) return fail('no-session', 'Сессия не найдена — откройте папку из активной сессии.')
    if (body.patch !== undefined && typeof body.patch === 'object' && body.patch !== null) {
      return { state: await writeSessionState(scope.id, body.patch) }
    }
    return { state: await readSessionState(scope.id) }
  }

  async function credentialsRoute(body) {
    const operation = typeof body.op === 'string' ? body.op : 'status'
    if (operation === 'set') return saveCredential(ctx, { ref: body.ref, value: body.value })
    if (operation === 'clear') return clearCredential(ctx, { ref: body.ref })
    return credentialStatus(ctx, body.ref)
  }

  async function prefsRoute(body) {
    if (body.patch !== undefined && typeof body.patch === 'object' && body.patch !== null) {
      return { preferences: await writePreferences(body.patch) }
    }
    return { preferences: await readPreferences() }
  }

  // ----------------------------------------------------------------- assets

  async function serveAsset(request) {
    const url = new URL(request.url)
    const relative = assetPathOf(url.pathname)
    if (relative === undefined) return new Response('not found', { status: 404 })
    try {
      const bytes = await readFile(path.join(ASSET_ROOT, relative))
      return new Response(bytes, {
        status: 200,
        headers: {
          'content-type': CONTENT_TYPES.get(path.extname(relative).toLowerCase()) ?? 'application/octet-stream',
          'cache-control': 'no-cache',
        },
      })
    } catch {
      return new Response('not found', { status: 404 })
    }
  }
}

// -------------------------------------------------------------------- pure

function assetPathOf(pathname) {
  if (typeof pathname !== 'string' || !pathname.startsWith(`${ASSET_PREFIX}/`)) return undefined
  let relative
  try {
    relative = decodeURIComponent(pathname.slice(ASSET_PREFIX.length + 1))
  } catch {
    return undefined
  }
  if (relative === '' || relative.includes('\\') || relative.includes('\0')) return undefined
  const segments = relative.split('/')
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..') return undefined
    if (!/^[A-Za-z0-9._-]+$/.test(segment)) return undefined
  }
  return segments.join(path.sep)
}

function decodeUtf8(bytes) {
  let bom = false
  let view = bytes
  if (bytes.byteLength >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    bom = true
    view = bytes.subarray(3)
  }
  for (const byte of view) {
    if (byte === 0) return undefined
  }
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(view), bom }
  } catch {
    return undefined
  }
}

function detectEol(text) {
  let crlf = 0
  let lf = 0
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== '\n') continue
    if (index > 0 && text[index - 1] === '\r') crlf += 1
    else lf += 1
  }
  return crlf > lf ? 'crlf' : 'lf'
}

function languageOf(displayPath) {
  return EXTENSIONS.get(path.extname(displayPath).toLowerCase()) ?? 'plaintext'
}

/**
 * The client sends the whole buffer and asks the Host to derive the windows,
 * so `MAX_CONTEXT_TEXT_CHARS` is what keeps the request bound.
 */

/** Clamp a client-supplied window to the configured budget. */
function boundedWindow(value, fallback) {
  const number = Number(value)
  if (!Number.isFinite(number) || number <= 0) return fallback
  return Math.min(Math.floor(number), fallback)
}

function fileKey(displayPath) {
  const normalized = String(displayPath).replace(/\\/g, '/')
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

function completionExcluded(displayPath) {
  const normalized = String(displayPath).replace(/\\/g, '/')
  const segments = normalized.split('/')
  const base = segments[segments.length - 1] ?? ''
  return /^\.env(?:\.|$)/i.test(base)
    || /^\.(?:npmrc|pypirc|netrc)$/i.test(base)
    || /^(?:id_rsa|id_ed25519|credentials?(?:\..*)?|secrets?(?:\..*)?|.*\.(?:pem|key|p12|pfx|keystore))$/i.test(base)
    || segments.some((segment) => /^\.ssh$/i.test(segment))
}

function relativeOf(cwd, displayPath) {
  const normalizedRoot = String(cwd).replace(/\\/g, '/').replace(/\/+$/, '')
  const normalizedPath = String(displayPath).replace(/\\/g, '/')
  if (normalizedPath === normalizedRoot) return normalizedPath.split('/').pop() ?? normalizedPath
  if (normalizedPath.startsWith(`${normalizedRoot}/`)) return normalizedPath.slice(normalizedRoot.length + 1)
  return normalizedPath
}

function clip(text, limit, side) {
  if (text.length <= limit) return text
  return side === 'end' ? text.slice(text.length - limit) : text.slice(0, limit)
}

/** A preference that must stay inside a range, with a learned default. */
function boundedMs(value, fallback, min, max) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, Math.round(number)))
}

/**
 * Reasoning levels to try, cheapest first.
 *
 * An empty preference means "whatever the provider does by default": every
 * extra level costs a rejected request first, and the adapter validates the
 * level against the model's own declaration. `off` stays available because it
 * is the only level that stops a DeepSeek-style gateway from spending the whole
 * budget on hidden reasoning — but a route that does not know it refuses the
 * call before any network I/O, so the fallback is cheap. `undefined` is
 * "provider default" and closes the chain.
 */
const EFFORT_LEVELS = ['off', 'low', 'medium', 'high']
function effortChainFor(value) {
  const wanted = typeof value === 'string' ? value.trim() : ''
  // The empty level is a deliberate choice, not a missing value: asking for it
  // first is what a provider without a usable `off` needs to answer at all.
  if (wanted === '') return [undefined]
  const chain = [wanted]
  for (const level of EFFORT_LEVELS) {
    if (!chain.includes(level)) chain.push(level)
  }
  // `undefined` closes the chain with "provider default": something has to run
  // even if every named level is rejected.
  chain.push(undefined)
  return chain
}

function isUnsupportedEffort(message) {
  return /UNSUPPORTED_REASONING_EFFORT|unsupported reasoning effort|does not support reasoning effort|invalid thinking/i.test(
    String(message ?? ''),
  )
}

/**
 * Whether the line under the cursor is a comment.
 *
 * The editor knows the grammar of every language Monaco shipped; the Host only
 * needs the cheap answer, because the setting exists to stop suggestions inside
 * comments, not to parse them.
 */
const COMMENT_LINE = /^\s*(?:\/\/|#|--|\/\*|\*|<!--|;;|%|"""|''')/
function looksLikeCommentLine(text) {
  const lines = String(text ?? '').split('\n')
  return COMMENT_LINE.test(lines[lines.length - 1] ?? '')
}

/**
 * Client-reported rejection history, bounded on the way in.
 *
 * The IDE keeps the list per tab; a request may carry at most twenty entries of
 * two thousand characters each, so an old entry can never grow a request.
 */
function readRecords(value) {
  if (!Array.isArray(value)) return []
  const records = []
  for (const entry of value.slice(0, 20)) {
    if (entry === null || typeof entry !== 'object') continue
    const text = typeof entry.text === 'string' ? entry.text.slice(0, 2000) : ''
    if (text === '') continue
    const at = Number(entry.at)
    records.push({ text, at: Number.isFinite(at) ? at : Date.now() })
  }
  return records
}

/**
 * Appends one JSON line per completion attempt to the OS temp directory.
 * Never throws and never blocks a completion: diagnostics must not become a
 * failure mode of the feature they diagnose.
 */
function logCompletion(record) {
  try {
    appendFileSync(
      path.join(os.tmpdir(), 'dsh-code-editor-completion.log'),
      `${JSON.stringify({ at: new Date().toISOString(), ...record })}\n`,
      'utf8',
    )
  } catch {
    // Diagnostics are optional.
  }
}

function sanitizeCompletion(raw) {  let text = String(raw ?? '')
  if (text === '') return ''
  text = text.replace(/^(?:Продолжение|Продолжить|Continuation)\s*:\s*/i, '')
  // One leading line break is meaningful: it is what puts a comment-driven
  // suggestion on the line after the comment. Only a run of blank lines goes.
  text = text.replace(/^\n{2,}/, '\n')
  text = text.replace(/\n{3,}/g, '\n\n')
  const lines = text.split('\n')
  const limit = text.startsWith('\n') ? 7 : 6
  return lines.slice(0, limit).join('\n').slice(0, COMPLETION_MAX_CHARS)
}
