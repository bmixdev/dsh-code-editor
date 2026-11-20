/**
 * Host half of `@local/dsh-code-editor`.
 *
 * Responsibilities:
 *  - serve the vendored Monaco tree (`/code-editor/vs/…`) as static bytes;
 *  - open a text file from inside the calling session's workspace and hand the
 *    client its text plus an opaque revision token;
 *  - save the file through that session's `ctx.fs` with a mandatory version
 *    check, under the session's sandbox policy (a read-only session stays
 *    read-only);
 *  - answer cancellable inline-completion requests from the configured model;
 *  - remember the per-workspace smart-Tab opt-in;
 *  - list workspace folders for the editor's file tree;
 *  - report the live provider/model catalog and store the completion key
 *    through the credential store;
 *  - persist the editor's own preferences (`~/.dsh/code-editor.json`).
 *
 * Every operation is an exact Fetch route below `/api`, which the connection
 * layer serves only to the owner principal (this machine's GUI page).
 */
import { appendFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
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
import { readPreferences, writePreferences } from './prefs.js'
import { listTree } from './tree.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ASSET_ROOT = path.join(HERE, 'vendor', 'vs')
const ASSET_PREFIX = '/code-editor/vs'
const API_PREFIX = '/api/code-editor/'

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
  'credentials',
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
    'dsh-code-editor: Monaco assets',
  )

  const handlers = {
    open: (body, signal) => open(body, signal),
    save: (body, signal) => save(body, signal),
    settings: (body) => settings(body),
    complete: (body, signal) => complete(body, signal),
    resolve: (body) => resolveSession(body),
    tree: (body, signal) => treeRoute(body, signal),
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
      `dsh-code-editor: route ${name}`,
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
    if (!optedIn.has(document.workspaceRoot)) {
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
    const preferences = await readPreferences()
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

    const deadline = AbortSignal.timeout(COMPLETION_DEADLINE_MS)
    const combined = signal === undefined ? deadline : AbortSignal.any([signal, deadline])
    const startedAt = Date.now()

    let text = ''
    let used = attempts[0]
    // The stream can end without any text and without throwing: a refusal or a
    // transport failure arrives as its own chunk. Collecting the chunk types is
    // what tells that apart from "the model answered nothing" — the empty
    // answer and the broken call both looked like "smart Tab does nothing".
    const chunkTypes = new Set()
    let streamError = ''
    let finishReason = ''
    let firstChunk = ''
    for (const attempt of attempts) {
      used = attempt
      let buffer = ''
      streamError = ''
      finishReason = ''
      try {
      for await (const chunk of ctx.llm.stream({
        provider: attempt.provider,
        model: attempt.model,
      system:
        'Ты — движок строчных подсказок в редакторе кода. Продолжи текст ровно с позиции курсора. ' +
        'Ответь только вставляемым продолжением: без пояснений, без markdown-ограждений, без повторения ' +
        'уже написанного кода. Продолжение должно быть коротким (1–5 строк) и синтаксически уместным. ' +
        // A comment that asks for code is the most common way a programmer
        // starts a block, so the answer has to begin with a line break and
        // contain the code itself rather than a repeat of the comment.
        'Если строка перед курсором — комментарий, который просит написать код, начни ответ с перевода ' +
        'строки и напиши код на следующей строке: не повторяй текст комментария и не ставь решётку. ' +
        'Если уместного продолжения нет, ответь пустой строкой.',
      // Message content is a list of typed blocks, not a bare string: every
      // other host-side caller in this installation passes
      // `[{ type: 'text', text }]`, and a string content made the adapter end
      // the stream immediately with no chunk at all (2 ms, empty answer).
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text:
                `Файл: ${document.displayPath}\n` +
                `Язык: ${document.language}\n\n` +
                // The suffix must follow its own header: an inverted layout tells the
                // model to continue past the text that comes after the cursor, which
                // produced empty answers for every request of the first benchmark.
                `--- текст до курсора ---\n${prefix}\n--- курсор ---\n` +
                `--- текст после курсора ---\n${suffix}`,
            },
          ],
        },
      ],
      // 160 tokens was not enough for a reasoning model: it spent the whole
      // budget on `reasoning_content` and every answer came back empty with
      // `finish_reason: length`. 400 leaves room for the thinking that
      // deepseek-v4.1-flash still does before the five lines of code.
      maxTokens: 400,
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
      if (chunk.type === 'text-delta' && typeof chunk.text === 'string') buffer += chunk.text
      if (chunk.type === 'error') {
        const detail = chunk.message ?? chunk.error?.message ?? chunk.error
        streamError = typeof detail === 'string' && detail !== '' ? detail : 'stream-error'
      }
      if (chunk.type === 'finish') {
        const kind = chunk.reason?.kind ?? chunk.reason ?? ''
        finishReason = typeof kind === 'string' ? kind : 'finish'
      }
      if (typeof chunk.finishReason === 'string' && chunk.finishReason !== '') finishReason = chunk.finishReason
      if (buffer.length > COMPLETION_MAX_CHARS) break
      }
      } catch (cause) {
        streamError = cause instanceof Error ? cause.message : String(cause)
      }
      text = buffer
      if (text.trim() !== '') break
    }

    const answer = postprocessCompletion({
      completion: text,
      prefix,
      suffix,
      topLevelKeywords: topLevelKeywordsFor(document.language),
    })

    const result = sanitizeCompletion(answer)
    // The GUI shows nothing when the answer is empty, so every attempt records
    // what it was and what came back; without this line "smart Tab does not
    // work" is impossible to tell apart from "the model answered nothing".
    logCompletion({
      file: document.displayPath,
      language: document.language,
      provider: used.provider,
      model: used.model,
      rawChars: text.length,
      answerChars: result.length,
      ms: Date.now() - startedAt,
      attempts: attempts.length,
      chunkTypes: [...chunkTypes],
      finishReason,
      error: streamError,
      firstChunk,
    })
    if (text.trim() === '' && streamError !== '') {
      return fail('upstream', `Модель не ответила: ${streamError}`)
    }
    if (text.trim() === '' && finishReason === 'length') {
      return fail(
        'upstream',
        'Модель израсходовала лимит на рассуждения: выберите нерассуждающую модель в настройках редактора (шестерёнка).',
      )
    }
    return {
      text: result,
      provider: used.provider,
      model: used.model,
      durationMs: Date.now() - startedAt,
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
