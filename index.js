/**
 * Host half of `@local/dsh-ide` — a tabbed, code-editor-shaped editor that brings
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
import { spawn } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, readlink, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
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
import { DEFAULT_SYSTEM_PROMPT, fillPrompt, optedInRoots, readPreferences, writePreferences } from './prefs.js'
import { buildFileContext, editInstructions, locateEdits, parseEditResponse } from './edits.js'
import { createProposal, ProposalError, readReplacementAnswer } from './proposal.js'
import { boundLines, evaluateSuggestion, planEdit, reasonLabel } from './tab.js'
import { listFiles, listTree } from './tree.js'
import { outlineOf } from './structure.js'
import { searchText as searchWorkspace } from './search.js'
import { applyHunks, createChangeTracker, revertHunks } from './agentChanges.js'
import * as scm from './scm.js'
import { chooseRules, discoverRules, rulePrompt } from './rules.js'
import { listPlans, readPlan, savePlan } from './plans.js'
import { loadIgnore, relativePath } from './ignore.js'
import { readSessionState, writeSessionState } from './state.js'
import { createTerminalService } from './terminal.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ASSET_ROOT = path.join(HERE, 'vendor', 'vs')
const ASSET_PREFIX = '/ide/vs'
const API_PREFIX = '/api/ide/'

/** Files above this size stay in the preview: the editor refuses them. */
const MAX_EDIT_BYTES = 1024 * 1024
/** Bytes read from a worktree file for a status token or a Git diff side. */
const SCM_READ_BYTES = 4 * 1024 * 1024
const MAX_SCM_PATH = 4096
/**
 * Review and commit-draft calls read the index once and wait for one answer.
 * The timeout is longer than a completion, because a patch is larger input;
 * the character ceilings stop a runaway stream before it fills the browser.
 */
const SCM_ANSWER_TIMEOUT_MS = 60000
const SCM_MAX_ANSWER_CHARS = 16000
const SCM_MAX_MESSAGE_CHARS = 4000
/** Deep review is the same prompt over smaller file groups, so each call sees
 * less diff; the cap keeps one click from becoming an unbounded batch. */
const SCM_DEEP_MAX_CALLS = 4
const SCM_DEEP_CHUNK_CHARS = 24000
const TEST_RUN_TIMEOUT_MS = 180000
const TEST_RUN_OUTPUT_BYTES = 2 * 1024 * 1024
const SCM_REVIEW_SYSTEM_PROMPT =
  'Ты — ревьюер подготовленных изменений Git. Тебе дан точный diff индекса. ' +
  'Верни только JSON-объект {"findings":[{"path":"файл","line":12,' +
  '"severity":"high|medium|low","message":"причина"}]} — без markdown-ограждений и пояснений. ' +
  'Указывай только строки новой стороны diff, которые присутствуют в diff как добавленные ' +
  'или контекстные. path — ровно один из перечисленных файлов. severity: high — ошибка или ' +
  'риск потери данных, medium — вероятный дефект, low — замечание по стилю. ' +
  'Если замечаний нет, верни {"findings":[]}. Не пересказывай diff и не предлагай правки ' +
  'вне перечисленных строк.'
const SCM_MESSAGE_SYSTEM_PROMPT =
  'Ты — автор сообщения коммита. По diff индекса верни только текст сообщения: ' +
  'первая строка не длиннее 72 символов, при необходимости пустая строка и тело. ' +
  'Без кавычек, markdown-ограждений и пояснений. Пиши по-русски, в повелительном ' +
  'наклонении, о сути изменения. Не добавляй подпись и не упоминай модель.'
/**
 * Conversation search goes through the Host's `sessionQuery` service, which
 * reads its own FTS5 index. The IDE narrows every search to sessions whose
 * recorded working directory is the open workspace, so changing projects never
 * surfaces another project's conversation.
 */
const SESSION_SEARCH_MAX_QUERY = 200
const SESSION_SEARCH_LIMIT = 20
const SESSION_EXCERPT_MAX_CHARS = 8000

/**
 * Explore is a keyword search plus one short answer. There is no embedding
 * index, so the prompt gets a bounded list of matching lines, and the answer
 * must cite `path:line` coordinates that actually came from that list.
 */
const EXPLORE_MAX_QUESTION = 500
const EXPLORE_MAX_TERMS = 6
const EXPLORE_MAX_EXCERPTS = 40
const EXPLORE_MAX_ANSWER_CHARS = 8000
const EXPLORE_STOPWORDS = new Set([
  'что', 'где', 'как', 'зачем', 'почему', 'когда', 'какой', 'какая', 'какие',
  'это', 'для', 'или', 'при', 'чем', 'кто', 'куда', 'откуда', 'можно', 'нужно',
  'есть', 'ли', 'найди', 'покажи', 'объясни', 'расскажи', 'про', 'без', 'над',
  'под', 'все', 'всё', 'чем', 'the', 'and', 'for', 'with', 'from', 'this',
])
const EXPLORE_SYSTEM_PROMPT =
  'Ты — помощник по кодовой базе. Тебе дан вопрос и ограниченный список строк ' +
  'из рабочей папки в виде `путь:строка: текст`. Ответь коротко, по-русски, ' +
  'опираясь только на эти строки. Каждый факт сопровождай ссылкой `путь:строка` ' +
  'ровно в том виде, как в списке. Если ответа в строках нет, скажи это прямо и ' +
  'не выдумывай файлы. Не предлагай изменений и не вставляй блоки кода.'
const SIDE_CHAT_MAX_QUESTION = 2000
const SIDE_CHAT_MAX_TURNS = 6
const SIDE_CHAT_MAX_SELECTION = 8000
const SIDE_CHAT_MAX_ANSWER_CHARS = 4000
const SIDE_CHAT_SYSTEM_PROMPT =
  'Ты отвечаешь на побочный вопрос по выделенному фрагменту кода. Ответь по-русски, ' +
  'кратко и по существу. Не переписывай файл, не предлагай патч и не проси ' +
  'разрешения что-то изменить: это разговор только для понимания. Если вопрос не ' +
  'относится к фрагменту, скажи это прямо.'
const SCM_CONFLICT_SYSTEM_PROMPT =
  'Ты разрешаешь конфликт слияния Git. Тебе даны base, ours и theirs — версии одного файла. ' +
  'Верни только итоговый текст файла после разрешения, без пояснений и markdown-ограждений. ' +
  'Сохрани полезные изменения обеих сторон; если они несовместимы, выбери вариант, который ' +
  'не теряет изменения другой стороны и остаётся синтаксически целым. ' +
  'Не добавляй маркеры конфликта <<<<<<<, =======, >>>>>>>.'
const SCM_RESOLVE_MAX_CHARS = 60000
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
/**
 * Inline Edit: the user describes a change for one selection. A selection is
 * small by definition, but it is still bounded so a whole-file selection is a
 * deliberate, visible refusal rather than a 2 MB prompt.
 */
const INLINE_EDIT_MAX_SELECTION = 20000
const INLINE_EDIT_CONTEXT_LINES = 40
const INLINE_EDIT_MAX_INSTRUCTION = 2000
const INLINE_EDIT_MAX_ANSWER = 40000
const INLINE_EDIT_MAX_TURNS = 4
const INLINE_EDIT_MAX_HISTORY = 80000
const INLINE_EDIT_DEADLINE_MS = 60000
const INLINE_EDIT_SYSTEM_PROMPT =
  'Ты — движок правки выделенного фрагмента кода. Верни только JSON-объект ' +
  '{"replacement": "..."} — без markdown-ограждений и пояснений. В replacement положи ' +
  'новый текст фрагмента целиком, с отступом как у исходного, и не повторяй соседние строки. ' +
  'Пустая строка в replacement означает удаление фрагмента. Не меняй ничего за пределами фрагмента.'
/**
 * Text search: a local scan, bounded on every axis so one query cannot turn into
 * an unbounded workspace read. `truncated` is part of the answer, because «not
 * found» and «stopped early» are different facts.
 */
const SEARCH_MAX_QUERY = 200
const SEARCH_DEFAULT_LIMIT = 50
/**
 * Hints must appear while the user is still looking at the line, so an
 * unconfigured route prefers a small model. The hints below are name-based on
 * purpose: a catalog entry carries no latency, and the small variants of this
 * gateway are the ones that answer under a second.
 */
const FAST_MODEL_HINTS = ['flash', 'mini', 'haiku', 'lite', 'small', 'fast', 'instant', 'cheap']
const SLOW_MODEL_HINTS = ['reason', 'think', 'thinking', 'pro', 'max', 'opus', 'sonnet', 'o1', 'o3', 'r1']
const CATALOG_TTL_MS = 5 * 60 * 1000
let catalogCache = { provider: '', models: [], at: 0 }

/**
 * Ranks model ids for a hint request: small variants first, thinking-heavy
 * families last, and the chat model's own family demoted so the hint does not
 * land on the same slow model the session uses.
 */
export function rankModels(ids, avoidFamily = '') {
  const score = id => {
    const lower = id.toLowerCase()
    let value = 0
    if (FAST_MODEL_HINTS.some(hint => lower.includes(hint))) value += 2
    if (SLOW_MODEL_HINTS.some(hint => lower.includes(hint))) value -= 2
    if (lower.includes('code')) value += 1
    if (avoidFamily !== '' && lower.split('-')[0] === avoidFamily) value -= 1
    return value
  }
  return ids.slice().sort((left, right) => score(right) - score(left))
}

/** Forgets the catalog cache; tests need it, and so does a provider switch. */
export function resetModelCatalog() {
  catalogCache = { provider: '', models: [], at: 0 }
}

// listModels has no signal, and a stream adapter can be slow to acknowledge
// cancellation. Bound the caller's wait independently of provider cleanup.
async function untilAbort(signal, work) {
  signal.throwIfAborted()
  let onAbort
  const stopped = new Promise((_, reject) => {
    onAbort = () => reject(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
  })
  try {
    return await Promise.race([stopped, work()])
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}

/** Ranks a provider's catalog and returns its fastest-looking model id. */
async function pickFastModel(ctx, provider, avoidFamily = '') {
  const now = Date.now()
  if (catalogCache.provider !== provider || now - catalogCache.at > CATALOG_TTL_MS) {
    let models = []
    try {
      const listed = await ctx.llm.listModels(provider)
      models = Array.isArray(listed) ? listed : []
    } catch {
      // An unlistable provider simply has no better suggestion to offer.
    }
    catalogCache = { provider, models, at: now }
  }
  const ids = catalogCache.models
    .map(entry => (typeof entry === 'string' ? entry : entry?.id))
    .filter(id => typeof id === 'string' && id !== '')
  if (ids.length === 0) return ''
  return rankModels(ids, avoidFamily)[0] ?? ''
}

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

  /**
   * Turns announced by live Sessions, if this Host records workspace changes.
   * The service is optional: without it the editor still works and the changes
   * panel says so instead of pretending nothing changed.
   */
  const changeTracker = createChangeTracker({ recorder: optionalChangeRecorder(ctx) })

  /**
   * Real PTY terminals. The service owns its processes; the `session/disposed`
   * hook below and the plugin's own teardown kill anything still running.
   */
  const terminalService = createTerminalService({ platform: process.platform })

  const json = (value, status = 200) =>
    new Response(JSON.stringify(value), {
      status,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    })

  const fail = (code, message) => ({ error: { code, message } })

  /**
   * Session-wide "ask only" switch. It lives in preferences, so every write
   * route can refuse independently of the client that calls it.
   */
  async function askRefusal() {
    const preferences = await readPreferences()
    if (preferences.askMode !== true) return undefined
    return fail('ask-mode', 'Включён режим вопросов: запись в рабочую папку запрещена. Отключите его в меню «Вид».')
  }

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

  if (typeof ctx.on === 'function') {
    ctx.effect(
      () =>
        ctx.on('session/event', (session, event) => {
          // `workspace/changes` is a SessionEvent, not a Cordis event: the feed
          // is the generic post-commit append stream, filtered by type.
          if (event === null || typeof event !== 'object') return
          if (event.type !== 'workspace/changes') return
          changeTracker.note(session?.id, event.seq)
        }),
      'dsh-ide: workspace changes feed',
    )
    ctx.effect(
      () => ctx.on('session/disposed', (session) => {
        changeTracker.forget(session?.id)
        terminalService.killSession(String(session?.id ?? ''))
      }),
      'dsh-ide: workspace changes cleanup',
    )
  }

  ctx.effect(
    () => () => terminalService.dispose(),
    'dsh-ide: terminal cleanup',
  )

  const handlers = {
    open: (body, signal) => open(body, signal),
    save: (body, signal) => save(body, signal),
    settings: (body) => settings(body),
    complete: (body, signal) => complete(body, signal),
    inlineEdit: (body, signal) => inlineEdit(body, signal),
    searchText: (body, signal) => searchText(body, signal),
    explore: (body, signal) => exploreRoute(body, signal),
    sessionSearch: (body, signal) => sessionSearchRoute(body, signal),
    sessionExcerpt: (body, signal) => sessionExcerptRoute(body, signal),
    sideChat: (body, signal) => sideChatRoute(body, signal),
    rules: (body) => rulesRoute(body),
    agentChanges: (body) => agentChangesRoute(body),
    agentChangeDiff: (body, signal) => agentChangeDiffRoute(body, signal),
    agentChangeRestore: (body, signal) => agentChangeRestoreRoute(body, signal),
    agentChangeText: (body, signal) => agentChangeTextRoute(body, signal),
    scmStatus: (body, signal) => scmStatusRoute(body, signal),
    scmDiff: (body, signal) => scmDiffRoute(body, signal),
    scmStage: (body, signal) => scmStageRoute(body, signal),
    scmUnstage: (body, signal) => scmUnstageRoute(body, signal),
    scmCommit: (body, signal) => scmCommitRoute(body, signal),
    scmHistory: (body, signal) => scmHistoryRoute(body, signal),
    scmCommitFiles: (body, signal) => scmCommitFilesRoute(body, signal),
    scmCommitDiff: (body, signal) => scmCommitDiffRoute(body, signal),
    scmBranches: (body, signal) => scmBranchesRoute(body, signal),
  scmCompare: (body, signal) => scmCompareRoute(body, signal),
    scmCreateBranch: (body, signal) => scmCreateBranchRoute(body, signal),
    scmSwitchBranch: (body, signal) => scmSwitchBranchRoute(body, signal),
    scmDeleteBranch: (body, signal) => scmDeleteBranchRoute(body, signal),
    scmWorktrees: (body, signal) => scmWorktreesRoute(body, signal),
    scmCreateWorktree: (body, signal) => scmCreateWorktreeRoute(body, signal),
    scmRemoveWorktree: (body, signal) => scmRemoveWorktreeRoute(body, signal),
  planSave: (body) => planSaveRoute(body),
  planList: (body) => planListRoute(body),
  planRead: (body) => planReadRoute(body),
    scmPatch: (body, signal) => scmPatchRoute(body, signal),
    scmReview: (body, signal) => scmReviewRoute(body, signal),
    scmDraftMessage: (body, signal) => scmDraftMessageRoute(body, signal),
    runTests: (body, signal) => runTestsRoute(body, signal),
    scmConflict: (body, signal) => scmConflictRoute(body, signal),
    scmResolve: (body, signal) => scmResolveRoute(body, signal),
    scmResolveApply: (body, signal) => scmResolveApplyRoute(body, signal),
    resolve: (body) => resolveSession(body),
    tree: (body, signal) => treeRoute(body, signal),
    files: (body, signal) => filesRoute(body, signal),
    structure: (body) => structureRoute(body),
    create: (body, signal) => createRoute(body, signal),
    mkdir: (body, signal) => mkdirRoute(body, signal),
    rename: (body, signal) => renameRoute(body, signal),
    remove: (body, signal) => removeRoute(body, signal),
    reveal: (body, signal) => revealRoute(body, signal),
    state: (body) => stateRoute(body),
    termProfiles: () => terminalService.profilesRoute(),
    termCreate: (body, signal) => termCreateRoute(body, signal),
    termWrite: (body) => terminalService.termWriteRoute(body),
    termResize: (body) => terminalService.termResizeRoute(body),
    termKill: (body) => terminalService.termKillRoute(body),
    termList: (body) => terminalService.termListRoute(body),
    termRead: (body, signal) => terminalService.termReadRoute(body, signal),
    termSuggest: (body, signal) => termSuggest(body, signal),
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
    if (error?.name === 'TimeoutError') return { code: 'timeout', message: 'Истекло время ожидания подсказки.' }
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

  /**
   * The recorder is a Host service this plugin does not require: a profile
   * without it must still load, so every access goes through an undefined check.
   */
  function optionalChangeRecorder(scope) {
    try {
      return typeof scope.get === 'function' ? scope.get('workspaceChanges') : undefined
    } catch {
      return undefined
    }
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

    // An explicit `body.encoding` reopens the file with that charset; without
    // one the BOM decides and the rest is read as UTF-8.
    const requestedEncoding = typeof body.encoding === 'string' ? body.encoding : ''
    if (requestedEncoding !== '' && !ENCODINGS.has(requestedEncoding)) {
      return fail('unsupported-encoding', `Неизвестная кодировка: ${requestedEncoding}`)
    }
    const encoding = requestedEncoding !== '' ? requestedEncoding : (sniffEncoding(bytes) ?? 'utf8')
    const decoded = decodeWithEncoding(bytes, encoding)
    if (decoded === undefined) {
      return fail(
        'unsupported-encoding',
        encoding === 'utf8'
          ? 'Файл не является текстом UTF-8 (или содержит NUL) — попробуйте открыть его в другой кодировке через статус-бар.'
          : `Файл не удалось декодировать как ${ENCODINGS.get(encoding).label}.`,
      )
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
      encoding,
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
      encoding,
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
    const ask = await askRefusal()
    if (ask !== undefined) return ask
    const document = documents.get(body.id)
    if (document === undefined) return fail('no-document', 'Документ не открыт — откройте файл заново.')
    if (body.sessionId !== document.sessionId) return fail('wrong-session', 'Документ принадлежит другой сессии.')
    if (body.token !== document.token) {
      return fail('stale-client', 'Редактор потерял актуальную версию файла — переоткройте его.')
    }
    if (typeof body.text !== 'string') return fail('bad-request', 'Не передано содержимое файла.')

    // The client owns the EOL and the encoding while a tab is open: it may
    // switch either from the status bar and save the new choice. Anything
    // beyond UTF-8 cannot be written back — the file system seam writes text,
    // and such a file must first be converted to UTF-8.
    const eol = body.eol === 'crlf' || body.eol === 'lf' ? body.eol : document.eol
    const encoding =
      body.encoding === 'utf8' || body.encoding === 'utf8-bom'
        ? body.encoding
        : body.encoding === undefined || body.encoding === ''
          ? document.encoding
          : undefined
    if (encoding === undefined) {
      return fail('unsupported-encoding', 'Запись возможна только в UTF-8 — пересохраните файл как UTF-8.')
    }

    const session = ctx.sessions.get(document.sessionId)
    if (session === undefined) return fail('no-session', 'Сессия закрыта — сохранение невозможно.')
    const policy = ctx.sandboxPolicy.resolve({ session })
    if (policy.mode === 'read-only') {
      return fail('read-only', 'Сессия работает в режиме только для чтения — сохранение запрещено.')
    }

    document.eol = eol
    document.encoding = encoding
    document.bom = encoding === 'utf8-bom'
    const normalized = body.text.replace(/\r\n/g, '\n')
    const content =
      (document.bom ? '\uFEFF' : '') +
      (eol === 'crlf' ? normalized.replace(/\n/g, '\r\n') : normalized)

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
    const cursorOffset = Math.min(Math.max(0, Math.round(Number(body.offset ?? 0) || 0)), rawText.length)
    // With whole-file edits on, the model gets the buffer with a cursor marker
    // and may answer with changes anywhere in the file — that is the part that
    // turns `main(f)` typed under a bare `def main():` into a proposal to fix
    // the signature, not just characters at the caret. A structured reply costs
    // the model a few extra seconds, so while typing it is opt-in: the ordinary
    // pause gets a fast continuation, and `Ctrl+Space` always asks for edits.
    const wantsEdits = preferences.multiEdit === true && preferences.maxEdits > 0
    const multiEdit = wantsEdits && (kind === 'explicit' || preferences.multiEditAuto === true)
    // 0 means "no ceiling": the request then carries no `maxTokens` at all and
    // the model stops when it is done. It is the default because a cap below the
    // model's own output limit silently truncates the answer, and a truncated
    // structured reply is what lost every edit twice in a row.
    const tokenBudget = Number.isFinite(Number(preferences.maxTokens)) ? Math.max(0, Math.round(Number(preferences.maxTokens))) : 0
    // The character guard exists so a runaway stream cannot fill the buffer, not
    // to shorten a good answer. A structured reply is several times longer than
    // a one-line continuation, so it gets the larger ceiling.
    const answerChars = multiEdit ? 8000 : COMPLETION_MAX_CHARS
    const deadline = AbortSignal.timeout(boundedMs(preferences.deadlineMs, COMPLETION_DEADLINE_MS, 1000, 60000))
    const combined = signal === undefined ? deadline : AbortSignal.any([signal, deadline])
    const flushAfterMs = boundedMs(preferences.flushAfterMs, 250, 0, 5000)
    const startedAt = Date.now()

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
    let modelSource =
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
    // Nothing is configured, and the session's own model is usually a thinking
    // one: its hidden reasoning eats the whole six-second window and the row ends
    // as «модель не вернула продолжение», which reads as a broken feature. When
    // the settings name no model, a fast model of the same provider is chosen
    // instead and the trajectory says so; the setting always overrides it.
    let effectiveModel = requestedModel
    if (modelSource === 'session' && preferences.autoModel !== false) {
      const family = String(selection.model).toLowerCase().split('-')[0]
      const fast = await untilAbort(combined, () => pickFastModel(ctx, requestedProvider, family))
      if (fast !== '' && fast !== selection.model) {
        effectiveModel = fast
        modelSource = 'auto'
      }
    }
    const attempts = []
    if (effectiveModel !== '') attempts.push({ provider: requestedProvider, model: effectiveModel })
    if (requestedProvider !== selection.provider && (kind === 'explicit' || attempts.length === 0)) {
      // A provider without a model cannot be called: ask its catalog for the
      // first advertised model so the choice still means something.
      try {
        const models = await untilAbort(combined, () => ctx.llm.listModels(requestedProvider))
        const first = Array.isArray(models) ? models[0] : undefined
        if (first !== undefined && typeof first.id === 'string') {
          attempts.push({ provider: requestedProvider, model: first.id })
        }
      } catch {
        combined.throwIfAborted()
        // The failure surfaces as "no model answered" below, with the provider
        // named in the log line.
      }
    }
    if (!attempts.some(attempt => attempt.provider === selection.provider && attempt.model === selection.model)) {
      attempts.push({ provider: selection.provider, model: selection.model })
    }

    // The instruction is a setting. Empty means the shipped text; a saved one
    // may use the same placeholders, so the user can keep "1–{{answerLines}}
    // строк" working while changing the rest of the wording.
    const promptTemplate =
      String(preferences.systemPrompt ?? '').trim() === '' ? DEFAULT_SYSTEM_PROMPT : preferences.systemPrompt
    const basePrompt = fillPrompt(promptTemplate, {
      answerLines: preferences.answerLines,
      language: document.language,
      file: document.displayPath,
    })
    // A chat model narrates before it writes. The line below asks for code
    // first; it cannot switch off hidden reasoning (that is the route's own
    // setting), but it keeps the visible answer free of commentary.
    const concisePrompt =
      preferences.noReasoningHint === false
        ? basePrompt
        : `${basePrompt}\n\nНе рассуждай вслух: сразу пиши код без пояснений.`
    const systemPrompt = multiEdit
      ? `${concisePrompt}\n\n${editInstructions({ maxEdits: preferences.maxEdits })}`
      : concisePrompt
    // The suffix must follow its own header: an inverted layout tells the model to
    // continue past the text that comes after the cursor, which produced empty
    // answers for every request of the first benchmark.
    const requestText =
      multiEdit && preferences.wholeFileContext === true
        ? buildFileContext({
            path: document.displayPath,
            language: document.language,
            text: rawText,
            offset: cursorOffset,
          })
        : `Файл: ${document.displayPath}\n` +
          `Язык: ${document.language}\n\n` +
          `--- текст до курсора ---\n${windowPrefix}\n--- курсор ---\n` +
          `--- текст после курсора ---\n${windowSuffix}`

    // Diagnostics are optional context from the editor: a short linter message
    // and its range, never a whole log. They are sanitized here so a client
    // cannot smuggle unbounded text into the prompt.
    const diagnostics = Array.isArray(body.diagnostics)
      ? body.diagnostics
          .slice(0, 5)
          .map((item) => ({
            line: Math.round(Number(item?.line)),
            column: Math.round(Number(item?.column)),
            message:
              typeof item?.message === 'string' ? item.message.replace(/\s+/g, ' ').trim().slice(0, 300) : '',
          }))
          .filter(
            (item) =>
              item.message !== '' &&
              Number.isFinite(item.line) &&
              item.line > 0 &&
              Number.isFinite(item.column) &&
              item.column > 0,
          )
      : []
    const diagnosticBlock =
      diagnostics.length === 0
        ? ''
        : `\n\n--- диагностика ---\n` +
          diagnostics.map((item) => `Строка ${item.line}, столбец ${item.column}: ${item.message}`).join('\n')

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
    for (const attempt of attemptsForKind) {
      combined.throwIfAborted()
      // Asking the route for its reasoning catalogue is only needed when a level
      // has to be chosen. With the default (empty) preference there is nothing to
      // choose, and the extra round trip is pure latency on a keystroke.
      if (effortChain.length === 1 && effortChain[0] === undefined) {
        effortsAdvertised = []
      } else {
        try {
          const info = await untilAbort(combined, () => ctx.llm.resolveModelInfo(attempt.provider, attempt.model, combined))
          effortsAdvertised = Array.isArray(info?.reasoning?.efforts) ? info.reasoning.efforts.map(effort => effort.id) : []
        } catch {
          combined.throwIfAborted()
          effortsAdvertised = []
        }
      }
      for (const effort of effortChain) {
        let buffer = ''
        const stop = new AbortController()
        const attemptSignal = AbortSignal.any([combined, stop.signal])
        let timer
        let iterator
        let unsupported = false
        streamError = ''
        finishReason = ''
        try {
          iterator = ctx.llm.stream({
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
                    text: requestText + diagnosticBlock,
                  },
                ],
              },
            ],
            // No token ceiling by default: a thinking model spends part of the
            // same budget on hidden reasoning, and every cap large enough to fit
            // an edit list still cut the reply mid-string on a long one. The
            // deadline and the stream reader bound the answer instead, and the
            // setting can put a ceiling back when a route bills by tokens.
            ...(tokenBudget > 0 ? { maxTokens: tokenBudget } : {}),
            temperature: 0.1,
            signal: attemptSignal,
            sessionId: document.sessionId,
            purpose: 'code-editor-inline-completion',
          })[Symbol.asyncIterator]()
          while (true) {
            const { done, value: chunk } = await untilAbort(attemptSignal, () => iterator.next())
            if (done) { iterator = undefined; break }
            if (!chunk || typeof chunk !== 'object') continue
            if (typeof chunk.type === 'string' && chunkTypes.size < 8) chunkTypes.add(chunk.type)
            if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
              buffer += chunk.text
              if (!multiEdit && timer === undefined && chunk.text.length > 0) {
                if (flushAfterMs === 0) { flushed = true; break }
                timer = setTimeout(() => { flushed = true; stop.abort() }, flushAfterMs)
              }
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
            if (buffer.length > answerChars) break
          }
        } catch (cause) {
          // Preserve complete edits already received at the deadline, but never
          // publish partial work when the caller cancelled the request.
          if (signal?.aborted || buffer.trim() === '') combined.throwIfAborted()
          if (!flushed) streamError = cause instanceof Error ? cause.message : String(cause)
        } finally {
          clearTimeout(timer)
          if (iterator !== undefined) {
            stop.abort()
            // An adapter may still be unwinding next(); do not delay a ready hint.
            void Promise.resolve().then(() => iterator.return?.()).catch(() => {})
          }
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

    // A whole-file answer carries two parts: the continuation at the cursor and
    // a list of edits elsewhere. A model that ignores the format simply wrote a
    // continuation, so the parser falls back to "all of it is the answer".
    const parsed = multiEdit ? parseEditResponse(text) : { answer: text, edits: [] }
    const answer = postprocessCompletion({
      completion: parsed.answer,
      prefix,
      suffix,
      topLevelKeywords: topLevelKeywordsFor(document.language),
    })

    const result = sanitizeCompletion(answer)

    // Where the answer lands and whether it is worth showing. Both decisions
    // used to live in the reference editor's server response (`range_to_replace` plus the
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
    // Located against the buffer the user actually has, so a snippet the model
    // remembered slightly wrong is dropped instead of applied in the wrong place.
    const edits = multiEdit
      ? locateEdits({
          text: rawText,
          edits: parsed.edits,
          maxEdits: preferences.maxEdits,
          cursor: cursorOffset,
        })
      : []
    // An answer may carry edits only: "move the call site, insert nothing here".
    // The plan is then an empty insertion at the cursor, which the continuation
    // heuristics rightly call empty — but the edits are the whole answer, so the
    // reply counts as usable and must not be reported as "nothing came back".
    const hasEdits = edits.length > 0
    const showable = accepted || hasEdits

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
      rawChars: text.length,
      answerChars: result.length,
      ms: Date.now() - startedAt,
      attempts: attempts.length,
      efforts: effortsAdvertised,
      flushed,
      chunkTypes: [...chunkTypes],
      finishReason,
      error: streamError !== '',
      kind,
      planKind: plan.kind,
      planChars: plan.insertText.length,
      planLines: plan.insertText === '' ? 0 : plan.insertText.split('\n').length,
      removedChars: plan.removedText.length,
      editCount: edits.length,
      suppressed: showable ? (accepted ? '' : 'edits-only') : verdict.reason,
    })
    // An empty answer is a normal outcome the user has to be able to read, so
    // it comes back with the same diagnostics block as a real completion. A
    // suppressed answer names the check that dropped it. An answer that only
    // carries edits is not suppressed: the panel says so, and Tab applies them.
    const reason = !showable
      ? streamError !== ''
        ? `Модель не ответила: ${streamError}`
        : finishReason === 'length'
          ? multiEdit && edits.length === 0
            ? 'Модель не уложилась в лимит ответа — увеличьте «строк в ответе» или уменьшите число правок.'
            : 'Модель израсходовала лимит на рассуждения — включите менее «думающую» модель.'
          : text.trim() === ''
            ? 'Модель не вернула продолжение.'
            : reasonLabel(verdict.reason)
      : ''
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
      // Edits elsewhere in the file, already resolved to offsets. The client
      // draws them as ghost blocks and applies all of them with Tab in one undo
      // step, so offsets are never recomputed after the insert.
      edits,
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
      suppressed: showable ? undefined : { reason: verdict.reason },
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
        edits: edits.length,
        suppressed: showable ? (accepted ? '' : 'edits-only') : verdict.reason,
      },
      ...(preferences.fullTrace === true ? { conversation: { system: systemPrompt, message: requestText, answer: text } } : {}),
    }
  }

  // ------------------------------------------------------------ inline edit

  async function inlineEdit(body, signal) {
    const document = documents.get(body.id)
    if (document === undefined) return fail('no-document', 'Документ не открыт.')
    if (body.sessionId !== document.sessionId) return fail('wrong-session', 'Документ принадлежит другой сессии.')
    if (body.token !== document.token) {
      return fail('stale-client', 'Редактор потерял актуальную версию файла — переоткройте его.')
    }
    const preferences = await readPreferences()
    // Tab permission is not an Edit permission: an owner who allowed inline
    // hints did not thereby allow sending a selection with an instruction.
    if (preferences.inlineEditConsent !== true) {
      return fail('not-opted-in', 'Правка выделения не разрешена — включите её в строке запроса.')
    }
    const session = ctx.sessions.get(document.sessionId)
    if (session === undefined) return fail('no-session', 'Сессия закрыта — правка выделения недоступна.')
    if (ctx.sandboxPolicy.resolve({ session }).mode === 'read-only') {
      return fail('read-only', 'Сессия работает в режиме только для чтения — правка выделения недоступна.')
    }
    if (completionExcluded(document.displayPath)) {
      return fail('excluded-file', 'Файл похож на секрет — отправка выделения модели отключена.')
    }
    if (excludedFiles.has(fileKey(document.displayPath))) {
      return fail('excluded-file', 'Правка выделения выключена для этого файла.')
    }
    const ignore = await loadIgnore(document.workspaceRoot)
    if (ignore.blocked(relativePath(document.workspaceRoot, document.target.path))) {
      return fail('ignored-file', 'Файл исключён правилами рабочей папки (.dshideignore) — модель его не получит.')
    }

    const text = String(body.text ?? '')
    if (text.length > MAX_CONTEXT_TEXT_CHARS) {
      return fail('context-too-large', 'Файл слишком велик для правки выделения.')
    }
    const start = Number(body.start)
    const end = Number(body.end)
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end > text.length || end <= start) {
      return fail('bad-request', 'Выделение пустое или выходит за пределы файла.')
    }
    if (end - start > INLINE_EDIT_MAX_SELECTION) {
      return fail(
        'selection-too-large',
        `Выделение больше ${INLINE_EDIT_MAX_SELECTION} символов — правка выделения недоступна.`,
      )
    }
    const instruction = String(body.instruction ?? '').trim()
    if (instruction === '') return fail('bad-request', 'Не описано, что изменить.')
    if (instruction.length > INLINE_EDIT_MAX_INSTRUCTION) {
      return fail('bad-request', `Инструкция длиннее ${INLINE_EDIT_MAX_INSTRUCTION} символов.`)
    }
    const modelVersion = Number.isFinite(Number(body.modelVersion)) ? Number(body.modelVersion) : undefined

    const selection = ctx.agentDefaultModel.currentSelection()
    if (selection === null || selection === undefined || typeof selection.model !== 'string' || selection.model === '') {
      return fail('no-model', 'Модель не выбрана — правка выделения недоступна.')
    }
    const provider = String(body.provider ?? preferences.completionProvider ?? '').trim() || selection.provider
    const model = String(body.model ?? preferences.completionModel ?? '').trim() || selection.model

    const fragment = text.slice(start, end)
    const before = boundLines(text.slice(0, start), INLINE_EDIT_CONTEXT_LINES, 'end')
    const after = boundLines(text.slice(end), INLINE_EDIT_CONTEXT_LINES, 'start')
    const requestTextFor = (task) =>
      [
        `Файл: ${document.displayPath}`,
        `Язык: ${document.language}`,
        `Задача: ${task}`,
        '',
        'Контекст файла; менять можно только фрагмент между маркерами.',
        '--- до фрагмента ---',
        before,
        '--- фрагмент ---',
        fragment,
        '--- после фрагмента ---',
        after,
      ].join('\n')
    const requestText = requestTextFor(instruction)

    // A refinement keeps the earlier exchange, so "сделай короче" still refers
    // to the proposal the user rejected. Only the explicit turn list is sent;
    // an absent list means the first request.
    const rawHistory = Array.isArray(body.history) ? body.history : []
    if (rawHistory.length > INLINE_EDIT_MAX_TURNS) {
      return fail('bad-request', 'Слишком много уточнений — начните правку заново.')
    }
    const history = []
    let historyChars = 0
    for (const turn of rawHistory) {
      const priorInstruction = typeof turn?.instruction === 'string' ? turn.instruction.trim() : ''
      const priorAnswer = typeof turn?.answer === 'string' ? turn.answer : ''
      if (
        priorInstruction === '' ||
        priorInstruction.length > INLINE_EDIT_MAX_INSTRUCTION ||
        priorAnswer.trim() === '' ||
        priorAnswer.length > INLINE_EDIT_MAX_ANSWER
      ) {
        return fail('bad-request', 'История уточнений повреждена — начните правку заново.')
      }
      historyChars += priorInstruction.length + priorAnswer.length
      history.push({ instruction: priorInstruction, answer: priorAnswer })
    }
    if (historyChars > INLINE_EDIT_MAX_HISTORY) {
      return fail('context-too-large', 'История уточнений слишком велика — начните правку заново.')
    }
    const messages = []
    for (const turn of history) {
      messages.push({ role: 'user', content: [{ type: 'text', text: requestTextFor(turn.instruction) }] })
      messages.push({ role: 'assistant', content: [{ type: 'text', text: turn.answer }] })
    }
    messages.push({ role: 'user', content: [{ type: 'text', text: requestText }] })

    const deadline = AbortSignal.timeout(INLINE_EDIT_DEADLINE_MS)
    const combined = signal === undefined ? deadline : AbortSignal.any([signal, deadline])
    const discovered = await discoverRules({ root: document.workspaceRoot, target: document.target.path })
    const ignoredRules = discovered.rules.filter((rule) => ignore.blocked(rule.path))
    const rules = chooseRules(discovered.rules.filter((rule) => !ignore.blocked(rule.path)))
    const rulesAppendix = rulePrompt(rules)
    const system = rulesAppendix === '' ? INLINE_EDIT_SYSTEM_PROMPT : `${INLINE_EDIT_SYSTEM_PROMPT}\n\n${rulesAppendix}`
    const startedAt = Date.now()
    let buffer = ''
    let streamError = ''
    const iterator = ctx.llm.stream({
      provider,
      model,
      system,
      messages,
      temperature: 0.2,
      signal: combined,
      sessionId: document.sessionId,
      purpose: 'code-editor-inline-edit',
    })[Symbol.asyncIterator]()
    for (;;) {
      const step = await iterator.next()
      if (step.done) break
      const chunk = step.value
      if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') buffer += chunk.text
      else if (chunk?.type === 'error') {
        streamError = String(chunk.message ?? chunk.error?.message ?? chunk.error ?? 'unknown')
      } else if (chunk?.type === 'finish' && chunk.reason?.kind === 'error' && streamError === '') {
        streamError = String(chunk.reason.failure?.message ?? chunk.reason.failure?.code ?? 'unknown')
      }
      if (buffer.length > INLINE_EDIT_MAX_ANSWER) break
    }

    const replacement = readReplacementAnswer(buffer)
    // An empty stream, prose or broken JSON is a failure, not a deletion: only
    // a well-formed `{"replacement":""}` may delete the selection.
    if (replacement === undefined) {
      const detail = streamError === '' ? '' : `: ${streamError}`
      return fail('bad-answer', `Модель вернула ответ не в ожидаемом формате${detail}.`)
    }

    let proposal
    try {
      proposal = createProposal({
        id: randomUUID(),
        documentId: document.id,
        modelVersion,
        text,
        eol: document.eol,
        changes: [{ start, end, oldText: fragment, newText: replacement }],
      })
    } catch (error) {
      if (error instanceof ProposalError) return fail(error.code, error.message)
      throw error
    }

    return {
      proposal,
      instruction,
      provider,
      model,
      durationMs: Date.now() - startedAt,
      conversation: preferences.fullTrace === true
        ? { system, message: requestText, answer: buffer }
        : undefined,
      rules: {
        applied: rules.filter((rule) => rule.applied).map((rule) => rule.path),
        skipped: [
          ...rules.filter((rule) => !rule.applied).map((rule) => ({ path: rule.path, reason: rule.reason })),
          ...ignoredRules.map((rule) => ({ path: rule.path, reason: 'ignored' })),
        ],
        truncated: discovered.truncated,
      },
      trace: {
        kind: 'inline-edit',
        explicit: true,
        rawChars: buffer.length,
        answerChars: replacement.length,
        removedChars: fragment.length,
        streamError,
      },
    }
  }

  // ----------------------------------------------------------------- search

  /**
   * Text search over the session workspace. The query is a literal substring or
   * a one-line regular expression, optionally restricted to whole words. It is
   * local: no model is asked and the Tab opt-in does not gate it, because
   * neither the query nor the matches travel anywhere — the scan happens on the
   * machine running the Host.
   */
  async function searchText(body, signal) {
    const scope = sessionOf(body)
    if (scope === undefined) return fail('no-session', 'Сессия не найдена — поиск недоступен.')
    const raw = typeof body.query === 'string' ? body.query : ''
    const regex = body.regex === true
    // A literal query has always ignored surrounding spaces. In a pattern they
    // are meaningful (for example `^  const`), so only the emptiness check trims.
    const query = regex ? raw : raw.trim()
    // An empty query never walks the tree: it is not «everything matches».
    if (query.trim() === '') return { query, matches: [], truncated: false, scanned: 0, bytes: 0 }
    if (query.length > SEARCH_MAX_QUERY) {
      return fail('bad-request', `Строка поиска длиннее ${SEARCH_MAX_QUERY} символов.`)
    }
    const requested = Number(body.limit)
    const limit = Number.isFinite(requested) && requested > 0
      ? Math.min(200, Math.floor(requested))
      : SEARCH_DEFAULT_LIMIT
    const ignore = await loadIgnore(scope.cwd)
    const result = await searchWorkspace(ctx, {
      cwd: scope.cwd,
      query,
      regex,
      wholeWord: body.wholeWord === true,
      limit,
      hidden: body.hidden === true,
      skip: ignore.skipped,
      signal,
    })
    return { query, ...result }
  }

  function exploreTerms(question) {
    const words = String(question).toLowerCase().match(/[\p{L}\p{N}_$]{3,}/gu) ?? []
    const terms = []
    for (const word of words) {
      if (EXPLORE_STOPWORDS.has(word) || terms.includes(word)) continue
      terms.push(word)
      if (terms.length >= EXPLORE_MAX_TERMS) break
    }
    return terms
  }

  function exploreSources(answer, excerpts) {
    const known = new Map(excerpts.map((item) => [`${item.path}:${item.line}`, item]))
    const sources = []
    const pattern = /([\w./\\-]+\.[A-Za-z0-9]{1,8}):(\d+)/g
    for (const match of String(answer).matchAll(pattern)) {
      const path = match[1].replace(/\\/g, '/').replace(/^\.\//, '')
      const key = `${path}:${Number(match[2])}`
      const item = known.get(key)
      if (item === undefined) continue
      if (sources.some((source) => source.path === item.path && source.line === item.line)) continue
      sources.push({ path: item.path, line: item.line, text: item.text })
      if (sources.length >= 20) break
    }
    return sources
  }

  /**
   * Natural-language explore: local keyword search first, then one bounded
   * answer over the matching lines. Sending those lines is the explicit action
   * of pressing «Спросить»; `.dshideignore` and secret-looking paths are
   * filtered before the model is called.
   */
  async function exploreRoute(body, signal) {
    const scope = sessionOf(body)
    if (scope === undefined) return fail('no-session', 'Сессия не найдена — вопрос о проекте недоступен.')
    const question = typeof body.question === 'string' ? body.question.trim() : ''
    if (question === '') return fail('bad-request', 'Вопрос пуст.')
    if (question.length > EXPLORE_MAX_QUESTION) {
      return fail('bad-request', `Вопрос длиннее ${EXPLORE_MAX_QUESTION} символов.`)
    }
    const terms = exploreTerms(question)
    if (terms.length === 0) return fail('bad-request', 'В вопросе нет слов для поиска по проекту.')
    const ignore = await loadIgnore(scope.cwd)
    const excerpts = []
    const seen = new Set()
    let truncated = false
    for (const term of terms) {
      const found = await searchWorkspace(ctx, {
        cwd: scope.cwd,
        query: term,
        limit: 12,
        skip: ignore.skipped,
        signal,
      })
      if (found.truncated) truncated = true
      for (const match of found.matches) {
        if (completionExcluded(match.path)) continue
        const key = `${match.path}:${match.line}`
        if (seen.has(key)) continue
        seen.add(key)
        excerpts.push({ path: match.path, line: match.line, text: match.preview })
        if (excerpts.length >= EXPLORE_MAX_EXCERPTS) break
      }
      if (excerpts.length >= EXPLORE_MAX_EXCERPTS) {
        truncated = true
        break
      }
    }
    const files = [...new Set(excerpts.map((item) => item.path))]
    if (excerpts.length === 0) {
      return {
        question,
        answer: `В рабочей папке не нашлось строк по словам: ${terms.join(', ')}.`,
        sources: [],
        files: [],
        truncated,
        provider: '',
        model: '',
        durationMs: 0,
      }
    }
    const requestText = [
      `Вопрос: ${question}`,
      '',
      'Строки рабочей папки:',
      ...excerpts.map((item) => `${item.path}:${item.line}: ${item.text.slice(0, 200)}`),
    ].join('\n')
    const startedAt = Date.now()
    const answer = await scmAnswer({
      sessionId: scope.id,
      system: EXPLORE_SYSTEM_PROMPT,
      text: requestText,
      purpose: 'code-editor-explore',
      signal,
      maxChars: EXPLORE_MAX_ANSWER_CHARS,
    })
    if (answer.error !== undefined) return answer.error
    const text = answer.text.trim()
    if (text === '') return fail('bad-answer', 'Модель вернула пустой ответ.')
    return {
      question,
      answer: text,
      sources: exploreSources(text, excerpts),
      files,
      truncated,
      provider: answer.provider,
      model: answer.model,
      durationMs: Date.now() - startedAt,
    }
  }

  /**
   * Find an earlier conversation by its text. The Host's `sessionQuery` service
   * runs the full-text search over its own index; the IDE passes the open
   * workspace as a `cwd` filter and never forwards a whole conversation.
   */
  async function sessionSearchRoute(body, signal) {
    const scope = sessionOf(body)
    if (scope === undefined) return fail('no-session', 'Сессия не найдена — поиск по разговорам недоступен.')
    const query = typeof body.query === 'string' ? body.query.trim() : ''
    if (query === '') return fail('bad-request', 'Запрос пуст.')
    if (query.length > SESSION_SEARCH_MAX_QUERY) {
      return fail('bad-request', `Запрос длиннее ${SESSION_SEARCH_MAX_QUERY} символов.`)
    }
    const service = ctx.sessionQuery
    if (service === undefined || typeof service.searchSessions !== 'function') {
      return fail('unavailable', 'Поиск по разговорам недоступен: Host не подключил сервис sessionQuery.')
    }
    let page
    try {
      page = await service.searchSessions({
        query,
        sessionFilters: [{ kind: 'cwd', values: [scope.cwd] }],
        eventFilters: [
          { kind: 'type', values: ['user/message', 'assistant/message'] },
          { kind: 'surface', values: ['current'] },
        ],
        limit: SESSION_SEARCH_LIMIT,
      }, { signal })
    } catch (error) {
      if (signal !== undefined && signal.aborted) return fail('cancelled', 'Поиск отменён.')
      const message = error instanceof Error ? error.message : String(error)
      return fail(error?.code ?? 'session-search-failed', `Поиск по разговорам не удался: ${message}`)
    }
    const items = []
    for (const hit of Array.isArray(page?.items) ? page.items : []) {
      const header = hit?.header ?? {}
      const match = hit?.bestMatch ?? {}
      const sessionId = typeof header.id === 'string' ? header.id : typeof match.sessionId === 'string' ? match.sessionId : ''
      if (sessionId === '') continue
      const rawSnippet = typeof match.snippet === 'string' ? match.snippet : ''
      items.push({
        sessionId,
        title: typeof header.title === 'string' ? header.title : typeof header.displayTitle === 'string' ? header.displayTitle : '',
        snippet: rawSnippet.replace(/<\/?mark>/g, '').slice(0, 400),
        seq: Number.isInteger(match.seq) ? match.seq : undefined,
        time: Number.isFinite(match.time) ? match.time : undefined,
        type: typeof match.type === 'string' ? match.type : '',
      })
    }
    return { query, items, hasMore: page?.hasMore === true, limit: SESSION_SEARCH_LIMIT }
  }

  function sessionEventText(event) {
    const data = event?.data ?? {}
    const parts = []
    if (Array.isArray(data.content)) {
      for (const part of data.content) {
        if (part && part.type === 'text' && typeof part.text === 'string') parts.push(part.text)
      }
    }
    if (parts.length === 0 && typeof data.text === 'string') parts.push(data.text)
    if (parts.length === 0 && typeof data.message === 'string') parts.push(data.message)
    return parts.join('\n\n').trim()
  }

  /**
   * Return one earlier conversation turn as a bounded excerpt. Only the chosen
   * event travels to the composer; the rest of that conversation stays out of
   * this session.
   */
  async function sessionExcerptRoute(body, signal) {
    const scope = sessionOf(body)
    if (scope === undefined) return fail('no-session', 'Сессия не найдена.')
    const target = typeof body.target === 'string' ? body.target.trim() : ''
    const seq = Number.isInteger(body.seq) ? body.seq : -1
    if (target === '' || seq < 0) {
      return fail('bad-request', 'Выберите найденный фрагмент разговора.')
    }
    const service = ctx.sessionQuery
    if (service === undefined || typeof service.readEvent !== 'function') {
      return fail('unavailable', 'Чтение разговоров недоступно: Host не подключил сервис sessionQuery.')
    }
    let result
    try {
      result = await service.readEvent({ sessionId: target, seq, before: 0, after: 0 }, { signal })
    } catch (error) {
      if (signal !== undefined && signal.aborted) return fail('cancelled', 'Чтение отменено.')
      if (error?.code === 'SESSION_QUERY_EVENT_NOT_FOUND') {
        return fail('not-found', 'Этот ход больше не найден в разговоре.')
      }
      const message = error instanceof Error ? error.message : String(error)
      return fail(error?.code ?? 'session-excerpt-failed', `Не удалось прочитать разговор: ${message}`)
    }
    const header = result?.session ?? {}
    const event = result?.target
    const full = sessionEventText(event)
    if (full === '') {
      return fail('no-text', 'В этом ходе нет текста — приложить нечего.')
    }
    const text = full.slice(0, SESSION_EXCERPT_MAX_CHARS)
    return {
      sessionId: target,
      title: typeof header.title === 'string' ? header.title : typeof header.displayTitle === 'string' ? header.displayTitle : '',
      seq,
      time: Number.isFinite(event?.time) ? event.time : undefined,
      type: typeof event?.type === 'string' ? event.type : '',
      text,
      chars: full.length,
      truncated: full.length > text.length,
    }
  }

  async function sideChatRoute(body, signal) {
    const document = documents.get(body.id)
    if (document === undefined) return fail('no-document', 'Документ не открыт.')
    if (body.sessionId !== document.sessionId) {
      return fail('wrong-session', 'Документ принадлежит другой сессии.')
    }
    const question = typeof body.question === 'string' ? body.question.trim() : ''
    if (question === '') return fail('bad-request', 'Вопрос пуст.')
    if (question.length > SIDE_CHAT_MAX_QUESTION) {
      return fail('bad-request', `Вопрос длиннее ${SIDE_CHAT_MAX_QUESTION} символов.`)
    }
    const start = Number.isInteger(body.start) ? body.start : -1
    const end = Number.isInteger(body.end) ? body.end : -1
    if (start < 0 || end <= start) {
      return fail('bad-request', 'Выделите фрагмент файла — побочный вопрос задаётся по выделению.')
    }
    const selection = typeof body.selection === 'string' ? body.selection : ''
    if (selection === '') {
      return fail('bad-request', 'Выделите фрагмент файла — побочный вопрос задаётся по выделению.')
    }
    if (selection.length > SIDE_CHAT_MAX_SELECTION) {
      return fail('bad-request', `Выделение длиннее ${SIDE_CHAT_MAX_SELECTION} символов.`)
    }
    const ignore = await loadIgnore(document.workspaceRoot)
    const relative = relativePath(document.workspaceRoot, document.target.path)
    if (ignore.blocked(relative)) {
      return fail('ignored-file', 'Файл исключён правилами рабочей папки (.dshideignore) — модель его не получит.')
    }
    if (completionExcluded(relative)) {
      return fail('excluded-file', 'Файл похож на секрет — побочный вопрос его не отправляет.')
    }
    const history = []
    if (Array.isArray(body.history)) {
      if (body.history.length > SIDE_CHAT_MAX_TURNS) {
        return fail('bad-request', `В истории больше ${SIDE_CHAT_MAX_TURNS} обменов.`)
      }
      for (const turn of body.history) {
        const priorQuestion = typeof turn?.question === 'string' ? turn.question.trim() : ''
        const priorAnswer = typeof turn?.answer === 'string' ? turn.answer.trim() : ''
        if (priorQuestion === '' || priorAnswer === '') {
          return fail('bad-request', 'История побочного вопроса повреждена.')
        }
        history.push({
          question: priorQuestion.slice(0, SIDE_CHAT_MAX_QUESTION),
          answer: priorAnswer.slice(0, SIDE_CHAT_MAX_ANSWER_CHARS),
        })
      }
    }
    const parts = [
      `Файл: ${relative}`,
      `Выделение (${start}–${end}):`,
      '```',
      selection,
      '```',
    ]
    if (history.length > 0) {
      parts.push('', 'Предыдущие обмены:')
      for (const turn of history) {
        parts.push(`Вопрос: ${turn.question}`, `Ответ: ${turn.answer}`)
      }
    }
    parts.push('', `Текущий вопрос: ${question}`)
    const answer = await scmAnswer({
      sessionId: document.sessionId,
      system: SIDE_CHAT_SYSTEM_PROMPT,
      text: parts.join('\n'),
      purpose: 'code-editor-side-chat',
      signal,
      maxChars: SIDE_CHAT_MAX_ANSWER_CHARS,
    })
    if (answer.error !== undefined) return answer.error
    const text = answer.text.trim()
    if (text === '') return fail('bad-answer', 'Модель вернула пустой ответ.')
    return {
      answer: text,
      path: relative,
      start,
      end,
      chars: selection.length,
      provider: answer.provider,
      model: answer.model,
    }
  }

  /**
   * The rule chain for one open document. Reading is local and never asks a
   * model; `applied` says which files the next Inline Edit would actually
   * include, not merely which files exist on disk.
   */
  async function rulesRoute(body) {
    const document = documents.get(body.id)
    if (document === undefined) return fail('no-document', 'Документ не открыт.')
    if (body.sessionId !== document.sessionId) return fail('wrong-session', 'Документ принадлежит другой сессии.')
    try {
      const ignore = await loadIgnore(document.workspaceRoot)
      const discovered = await discoverRules({ root: document.workspaceRoot, target: document.target.path })
      const ignored = discovered.rules.filter((rule) => ignore.blocked(rule.path))
      const rules = chooseRules(discovered.rules.filter((rule) => !ignore.blocked(rule.path)))
      return {
        file: discovered.file,
        truncated: discovered.truncated,
        rules: [
          ...ignored.map((rule) => ({
            path: rule.path,
            dir: rule.dir,
            name: rule.name,
            bytes: rule.bytes,
            applied: false,
            reason: 'ignored',
            preview: '',
          })),
          ...rules.map((rule) => ({
            path: rule.path,
            dir: rule.dir,
            name: rule.name,
            bytes: rule.bytes,
            applied: rule.applied,
            reason: rule.reason,
            preview: rule.applied ? rule.text.slice(0, 600) : '',
          })),
        ],
      }
    } catch (error) {
      return fail(error.code ?? 'rules-failed', error.message ?? 'Не удалось прочитать правила проекта.')
    }
  }

  // ------------------------------------------------------ assistant changes

  async function agentChangesRoute(body) {
    const scope = sessionOf(body)
    if (scope === undefined) return fail('no-session', 'Сессия не найдена — изменения ассистента недоступны.')
    return {
      available: changeTracker.available,
      turns: changeTracker.list(scope.id),
    }
  }

  async function agentChangeDiffRoute(body, signal) {
    const scope = sessionOf(body)
    if (scope === undefined) return fail('no-session', 'Сессия не найдена — изменения ассистента недоступны.')
    const seq = Number(body.seq)
    const index = Number(body.index)
    if (!Number.isSafeInteger(seq) || seq < 0) return fail('bad-request', 'Не указан ход изменений.')
    if (!Number.isSafeInteger(index) || index < 0) return fail('bad-request', 'Не указан файл.')
    let diff
    try {
      diff = await changeTracker.diff(scope.id, seq, index, signal)
    } catch (error) {
      // A snapshot read can fail for a live Session; that is a read error, not
      // an empty comparison, so it must not look like "nothing changed".
      return fail(error?.code || 'diff-failed', error instanceof Error ? error.message : String(error))
    }
    if (diff === undefined) {
      return fail('not-found', 'Сравнение недоступно: ход не найден, файла нет в списке или сессия уже закрыта.')
    }
    return { diff }
  }

  // Both routes below need the file a turn touched, read from disk.
  //
  // Typed errors instead of `fail()` objects: the two callers word their
  // refusals differently, so each route catches and maps them itself.
  async function readTurnFile(scope, diff, signal) {
    const refuse = (code, message) => Object.assign(new Error(message), { code })
    const policy = ctx.sandboxPolicy.resolve({ session: scope.session })
    if (policy.mode === 'read-only') throw refuse('read-only', 'Сессия работает в режиме только для чтения — действие недоступно.')
    const target = await ctx.fs.resolve(diff.path, { cwd: scope.cwd, signal })
    const root = await ctx.fs.resolve(scope.cwd, { signal })
    const displayPath = ctx.fs.processPath(target)
    if (!ctx.fs.contains(root, target)) throw refuse('outside-workspace', `Файл вне рабочей папки сессии: ${displayPath}`)
    const info = await ctx.fs.stat(target, signal)
    if (info === undefined || info.type !== 'file') throw refuse('not-found', `Файла больше нет на диске: ${displayPath}`)
    if (info.size !== undefined && info.size > MAX_EDIT_BYTES) {
      throw refuse('too-large', 'Файл больше 1 МиБ — сравнение и откат недоступны.')
    }
    const bytes = await ctx.fs.readBytes(target, signal, MAX_EDIT_BYTES + 1)
    if (bytes.byteLength > MAX_EDIT_BYTES) throw refuse('too-large', 'Файл больше 1 МиБ — сравнение и откат недоступны.')
    const decoded = decodeUtf8(bytes)
    if (decoded === undefined) throw refuse('unsupported-encoding', 'Файл не является текстом UTF-8.')
    // The snapshot speaks LF; the file may hold CRLF, so patch normalized text
    // and put the file's own line endings and BOM back on the way out.
    return { policy, target, info, decoded, text: decoded.text.replace(/\r\n/g, '\n') }
  }

  // Turn start and turn end as full texts, so the editor can show a real
  // side-by-side diff instead of a list of hunks.
  async function agentChangeTextRoute(body, signal) {
    const scope = sessionOf(body)
    if (scope === undefined) return fail('no-session', 'Сессия не найдена — сравнение правок ассистента недоступно.')
    const seq = Number(body.seq)
    const index = Number(body.index)
    if (!Number.isSafeInteger(seq) || seq < 0) return fail('bad-request', 'Не указан ход изменений.')
    if (!Number.isSafeInteger(index) || index < 0) return fail('bad-request', 'Не указан файл.')

    let diff
    try {
      diff = await changeTracker.diff(scope.id, seq, index, signal)
    } catch (error) {
      return fail(error?.code || 'diff-failed', error instanceof Error ? error.message : String(error))
    }
    if (diff === undefined) {
      return fail('not-found', 'Сравнение недоступно: ход не найден, файла нет в списке или сессия уже закрыта.')
    }
    if (diff.kind !== 'text') return fail('not-text', 'Файл не текстовый — сравнение недоступно.')

    let file
    try {
      file = await readTurnFile(scope, diff, signal)
    } catch (error) {
      return fail(error?.code || 'read-failed', error instanceof Error ? error.message : String(error))
    }
    const before = diff.before === false ? '' : revertHunks(file.text, diff.hunks)
    if (before === undefined) return fail('conflict', 'Файл изменился после хода — сравнение недоступно.')
    if (diff.before !== false && applyHunks(before, diff.hunks) !== file.text) {
      return fail('conflict', 'Снимок не сходится с файлом — сравнение недоступно.')
    }
    return {
      path: diff.path,
      display: diff.display,
      before,
      after: file.text,
      coarse: diff.coarse === true,
      language: languageOf(diff.path),
    }
  }

  // Undo one file of one assistant turn: write the turn-start text back.
  //
  // Two guards make this safe: the file must still be inside the session root
  // and writable, and every hunk must still match the file on disk. A file the
  // user edited after the turn therefore fails with a conflict instead of being
  // half-rewritten; the panel shows that as an honest refusal.
  async function agentChangeRestoreRoute(body, signal) {
    const scope = sessionOf(body)
    if (scope === undefined) return fail('no-session', 'Сессия не найдена — откат правок ассистента недоступен.')
    const seq = Number(body.seq)
    const index = Number(body.index)
    if (!Number.isSafeInteger(seq) || seq < 0) return fail('bad-request', 'Не указан ход изменений.')
    if (!Number.isSafeInteger(index) || index < 0) return fail('bad-request', 'Не указан файл.')

    let diff
    try {
      diff = await changeTracker.diff(scope.id, seq, index, signal)
    } catch (error) {
      return fail(error?.code || 'diff-failed', error instanceof Error ? error.message : String(error))
    }
    if (diff === undefined) {
      return fail('not-found', 'Сравнение недоступно: ход не найден, файла нет в списке или сессия уже закрыта.')
    }
    if (diff.kind !== 'text') return fail('not-text', 'Файл не текстовый — откат недоступен.')
    if (diff.before === false) return fail('no-before', 'Файла не было до этого хода — откат не поддерживается.')

    let file
    try {
      file = await readTurnFile(scope, diff, signal)
    } catch (error) {
      return fail(error?.code || 'read-failed', error instanceof Error ? error.message : String(error))
    }

    const previous = revertHunks(file.text, diff.hunks)
    if (previous === undefined) {
      return fail('conflict', 'Файл изменился после хода — откат не выполнен, чтобы не потерять правки.')
    }
    if (applyHunks(previous, diff.hunks) !== file.text) {
      return fail('conflict', 'Снимок не сходится с файлом — откат не выполнен.')
    }

    const eol = detectEol(file.decoded.text)
    const content = (file.decoded.bom ? '\uFEFF' : '') + (eol === 'crlf' ? previous.replace(/\n/g, '\r\n') : previous)
    const outcome = await ctx.fs.writeText(
      file.target,
      content,
      { kind: 'replaceIfVersion', version: file.info.version },
      signal,
      file.policy,
    )
    return { restored: true, path: diff.path, display: diff.display, version: outcome.version }
  }

  // ------------------------------------------------------------ source control
  //
  // Git runs only against a real local folder whose DSH policy is known, and
  // only when that folder is itself the repository root. Everything a browser
  // sends is a group and a path relative to that root; the argv is fixed here.

  const scmQueues = new Map()
  const SCM_ERROR_CODES = new Set([
    'git-unavailable',
    'not-root',
    'not-repository',
    'unsafe-repository',
    'locked',
    'git-not-found',
    'git-failed',
    'timeout',
    'cancelled',
    'output-limit',
    'stale',
    'bad-request',
    'not-found',
    'history-stale',
    'identity',
    'nothing-staged',
    'branch-exists',
    'branch-unmerged',
    'branch-current',
    'switch-conflict',
    'worktree-exists',
    'worktree-branch',
    'worktree-dirty',
    'worktree-main',
    'outside-workspace',
    'read-only',
    'bad-answer',
    'no-model',
    'context-too-large',
    'excluded-file',
    'not-conflict',
    'binary',
    'too-large',
  ])

  function scmFailure(error) {
    const raw = typeof error?.code === 'string' ? error.code : ''
    const message = error instanceof Error && error.message !== '' ? error.message : String(error)
    return fail(SCM_ERROR_CODES.has(raw) ? raw : 'git-failed', message)
  }

  function isLocalDirectory(value) {
    if (typeof value !== 'string' || value === '') return false
    if (process.platform === 'win32') {
      return /^[a-zA-Z]:[\\/]/.test(value) && !value.startsWith('\\\\')
    }
    return value.startsWith('/') && !value.startsWith('//')
  }

  // A path from the Git listing, or undefined. `..`, absolute paths, NUL and
  // backslashes cannot reach the file reader; Git itself always emits '/'.
  function scmTarget(value) {
    if (typeof value !== 'string' || value === '' || value.length > MAX_SCM_PATH) return undefined
    if (value.includes('\0') || value.includes('\\')) return undefined
    if (value.startsWith('/') || /^[a-zA-Z]:/.test(value)) return undefined
    const segments = value.split('/')
    for (const segment of segments) {
      if (segment === '' || segment === '.' || segment === '..') return undefined
    }
    return segments.join('/')
  }

  // The worktree path is a real directory, not a target handle: compare it
  // lexically against the resolved workspace root.
  function scmInside(directory, candidate) {
    const relative = path.relative(directory, candidate)
    return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
  }

  function scmGroup(value) {    return value === 'staged' || value === 'changes' || value === 'conflicts' ? value : undefined
  }

  function parseTestFailures(output, display) {
    const failures = []
    let current
    for (const line of output.split(/\r?\n/)) {
      const head = /^not ok \d+ - (.*)$/.exec(line)
      if (head !== null) {
        current = { name: head[1].trim(), file: '', line: 0, column: 0 }
        failures.push(current)
        continue
      }
      if (current === undefined) continue
      const location = /location:\s*(['"])(.+?)\1/.exec(line)
      if (location !== null && current.file === '') {
        const parts = /(.+?):(\d+):(\d+)$/.exec(location[2])
        if (parts === null) continue
        const relative = path.relative(display, parts[1])
        current.file = relative.split(path.sep).join('/')
        current.line = Number(parts[2])
        current.column = Number(parts[3])
        continue
      }
      const stack = /\((.+?):(\d+):(\d+)\)/.exec(line)
      if (stack !== null && current.file === '' && !stack[1].startsWith('node:')) {
        current.file = path.relative(display, stack[1]).split(path.sep).join('/')
        current.line = Number(stack[2])
        current.column = Number(stack[3])
      }
    }
    return failures
  }

  async function runTestsRoute(body, signal) {
    const scope = sessionOf(body)
    if (scope === undefined) return fail('no-session', 'Сессия не найдена — запуск тестов недоступен.')
    let policy
    try {
      policy = ctx.sandboxPolicy.resolve({ session: scope.session })
    } catch {
      policy = undefined
    }
    if (policy === undefined || policy === null) return fail('read-only', 'Политика доступа к папке не подтверждена.')
    if (policy.mode === 'read-only') return fail('read-only', 'Папка открыта только для чтения — запуск тестов запрещён.')
    const root = await rootTarget(scope.cwd, signal)
    const display = ctx.fs.processPath(root)
    if (!isLocalDirectory(display)) return fail('not-local', 'Рабочая папка не является локальным каталогом.')

    let manifest
    try {
      manifest = JSON.parse(await readFile(path.join(display, 'package.json'), 'utf8'))
    } catch {
      return fail('no-tests', 'В корне нет package.json — известных тестов нет.')
    }
    const scripts = manifest?.scripts !== null && typeof manifest?.scripts === 'object' ? manifest.scripts : {}
    const requested = typeof body.script === 'string' && body.script !== '' ? body.script : 'test'
    if (typeof scripts[requested] !== 'string' || !/^[A-Za-z0-9:_-]{1,64}$/.test(requested)) {
      return fail('no-tests', `Скрипт «${requested}» не найден в package.json.`)
    }

    const started = Date.now()
    const output = []
    let bytes = 0
    let truncated = false
    const isWindows = process.platform === 'win32'
    const child = isWindows
      ? spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `npm run ${requested}`], {
          cwd: display,
          env: { ...process.env, CI: '1', NO_COLOR: '1', FORCE_COLOR: '0' },
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        })
      : spawn('npm', ['run', requested], {
          cwd: display,
          env: { ...process.env, CI: '1', NO_COLOR: '1', FORCE_COLOR: '0' },
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        })

    const collect = (chunk) => {
      if (bytes >= TEST_RUN_OUTPUT_BYTES) {
        truncated = true
        return
      }
      const text = chunk.toString('utf8')
      const room = TEST_RUN_OUTPUT_BYTES - bytes
      output.push(text.slice(0, room))
      bytes += Math.min(text.length, room)
      if (text.length > room) truncated = true
    }
    child.stdout.on('data', collect)
    child.stderr.on('data', collect)

    const result = await new Promise((resolve) => {
      let settled = false
      const finish = (value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(value)
      }
      const timer = setTimeout(() => {
        child.kill('SIGTERM')
        finish({ timedOut: true })
      }, TEST_RUN_TIMEOUT_MS)
      const cancel = () => {
        child.kill('SIGTERM')
        finish({ cancelled: true })
      }
      if (signal !== undefined) {
        if (signal.aborted) cancel()
        else signal.addEventListener('abort', cancel, { once: true })
      }
      child.on('error', (error) => finish({ error }))
      child.on('close', (code, killSignal) => finish({ code, signal: killSignal }))
    })

    if (result.cancelled === true) return fail('cancelled', 'Запуск тестов отменён.')
    if (result.timedOut === true) return fail('timeout', `Тесты не уложились в ${TEST_RUN_TIMEOUT_MS / 1000} с и были остановлены.`)
    if (result.error !== undefined) return fail('test-failed', `Не удалось запустить тесты: ${result.error.message}`)

    const text = output.join('')
    return {
      script: requested,
      code: result.code ?? -1,
      signal: result.signal ?? '',
      durationMs: Date.now() - started,
      truncated,
      failures: parseTestFailures(text, display),
      output: text.slice(-20000),
    }
  }

  async function planSaveRoute(body) {
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
    if (sessionId === '') return fail('bad-request', 'Не указана сессия.')
    try {
      return await savePlan({
        title: body.title,
        text: body.text,
        path: body.path,
        from: body.from,
        to: body.to,
      })
    } catch (error) {
      return fail(error.code ?? 'plans-failed', error.message)
    }
  }

  async function planListRoute(body) {
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
    if (sessionId === '') return fail('bad-request', 'Не указана сессия.')
    try {
      return { plans: await listPlans() }
    } catch (error) {
      return fail(error.code ?? 'plans-failed', error.message)
    }
  }

  async function planReadRoute(body) {
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
    if (sessionId === '') return fail('bad-request', 'Не указана сессия.')
    try {
      return await readPlan(body.id)
    } catch (error) {
      return fail(error.code ?? 'plans-failed', error.message)
    }
  }

  // Resolve the session folder, prove it is local, and prove it is the Git
  // root. A nested folder is a deliberate refusal: opening the root instead is
  // the user's decision, and DSH never walks upward to find a repository.
  async function scmContext(scope, signal) {
    let policy
    try {
      policy = ctx.sandboxPolicy.resolve({ session: scope.session })
    } catch {
      policy = undefined
    }
    if (policy === undefined || policy === null || typeof policy.mode !== 'string') {
      throw new scm.ScmError('git-unavailable', 'Политика доступа к этой папке не подтверждена — панель Git отключена.')
    }
    const root = await rootTarget(scope.cwd, signal)
    const display = ctx.fs.processPath(root)
    if (!isLocalDirectory(display)) {
      throw new scm.ScmError('git-unavailable', 'Рабочая папка не является локальным каталогом — панель Git отключена.')
    }
    const git = scm.createGit(scope.cwd)
    let top
    try {
      top = await scm.resolveRoot(git, signal)
    } catch (error) {
      if (error?.code === 'not-repository') {
        throw new scm.ScmError('not-repository', 'В этой папке нет Git-репозитория. Панель не создаёт его автоматически.')
      }
      if (error?.code === 'unsafe-repository') {
        throw new scm.ScmError('unsafe-repository', error.message)
      }
      throw error
    }
    if (!(await scm.sameDirectory(top, display))) {
      throw new scm.ScmError(
        'not-root',
        `Репозиторий этой папки лежит выше: ${top}. Откройте корень репозитория как рабочую папку — панель не ищет его вверх по дереву.`,
      )
    }
    return { git, root, display, policy }
  }

  // Read one worktree path for a status token or a diff side. The physical
  // file is checked before reading: a symlink is reported as its target text,
  // a symlink resolving outside the root is refused, and a directory, device
  // or gitlink is never opened as text.
  function scmReader(scope, context, signal) {
    const rootReal = realpath(ctx.fs.processPath(context.root)).catch(() => undefined)
    return async (target) => {
      const relative = scmTarget(target)
      if (relative === undefined) return { kind: 'outside' }
      let resolved
      try {
        resolved = await ctx.fs.resolve(relative.split('/').join(path.sep), { cwd: scope.cwd, signal })
      } catch {
        return { kind: 'missing' }
      }
      if (!ctx.fs.contains(context.root, resolved)) return { kind: 'outside' }
      const native = ctx.fs.processPath(resolved)
      let info
      try {
        info = await lstat(native)
      } catch {
        return { kind: 'missing' }
      }
      if (info.isSymbolicLink()) {
        let link = ''
        try {
          link = await readlink(native)
        } catch {
          link = ''
        }
        return { kind: 'symlink', target: link }
      }
      if (!info.isFile()) return { kind: 'special' }
      const resolvedReal = await realpath(native).catch(() => undefined)
      const baseReal = await rootReal
      if (resolvedReal !== undefined && baseReal !== undefined) {
        const prefix = baseReal.endsWith(path.sep) ? baseReal : baseReal + path.sep
        const inside =
          resolvedReal === baseReal ||
          resolvedReal.toLowerCase().startsWith(prefix.toLowerCase())
        if (!inside) return { kind: 'outside' }
      }
      let bytes
      try {
        bytes = await ctx.fs.readBytes(resolved, signal, SCM_READ_BYTES + 1)
      } catch {
        return { kind: 'missing' }
      }
      const truncated = bytes.byteLength > SCM_READ_BYTES
      return {
        kind: 'file',
        bytes: truncated ? bytes.subarray(0, SCM_READ_BYTES) : bytes,
        size: info.size,
        truncated,
      }
    }
  }

  async function scmSnapshot(scope, context, signal) {
    const snapshot = await scm.loadSnapshot(context.git, {
      readWorktree: scmReader(scope, context, signal),
      signal,
    })
    snapshot.readOnly = context.policy.mode === 'read-only'
    return snapshot
  }

  // Two tabs of the panel may fire stage/unstage/commit at once; a shared queue
  // per worktree keeps those argv sequences off each other's index. External
  // Git is outside this queue, so its lock errors are surfaced, not retried.
  async function scmSerialized(context, task) {
    const key = context.display.toLowerCase()
    const previous = scmQueues.get(key) ?? Promise.resolve()
    const run = previous.then(task, task)
    const tail = run.then(
      () => undefined,
      () => undefined,
    )
    scmQueues.set(key, tail)
    try {
      return await run
    } finally {
      if (scmQueues.get(key) === tail) scmQueues.delete(key)
    }
  }

  async function scmStatusRoute(body, signal) {
    const scope = sessionOf(body)
    if (scope === undefined) return fail('no-session', 'Сессия не найдена — панель Git недоступна.')
    try {
      const context = await scmContext(scope, signal)
      return await scmSnapshot(scope, context, signal)
    } catch (error) {
      return scmFailure(error)
    }
  }

  async function scmDiffRoute(body, signal) {
    const scope = sessionOf(body)
    if (scope === undefined) return fail('no-session', 'Сессия не найдена — сравнение Git недоступно.')
    const group = scmGroup(body.group)
    if (group === undefined) return fail('bad-request', 'Не указана группа изменений.')
    const target = scmTarget(body.path)
    if (target === undefined) return fail('bad-request', 'Некорректный путь файла.')
    try {
      const context = await scmContext(scope, signal)
      const snapshot = await scmSnapshot(scope, context, signal)
      if (typeof body.revision !== 'string' || body.revision !== snapshot.revision) {
        return fail('stale', 'Список изменений обновился — обновите панель и откройте файл заново.')
      }
      const diff = await scm.loadDiff(context.git, snapshot, {
        group,
        path: target,
        signal,
        readWorktree: scmReader(scope, context, signal),
      })
      const row = scm.findRow(snapshot, group, target)
      const worktreeGone =
        row === undefined || row.entry.worktreeStatus === 'D' || row.entry.kind === 'deleted'
      return {
        diff: {
          ...diff,
          language: languageOf(target),
          canOpen: diff.kind === 'text' && group !== 'conflicts' && !worktreeGone,
        },
      }
    } catch (error) {
      return scmFailure(error)
    }
  }

  // Read-only sessions may look at Git state but never prepare or commit.
  function scmWriteRefusal(context) {
    return context.policy.mode === 'read-only'
      ? fail('read-only', 'Сессия работает в режиме только для чтения — изменения индекса недоступны.')
      : undefined
  }

  async function scmStageRoute(body, signal) {
    const ask = await askRefusal()
    if (ask !== undefined) return ask
    const scope = sessionOf(body)
    if (scope === undefined) return fail('no-session', 'Сессия не найдена — подготовка файла недоступна.')
    const group = scmGroup(body.group)
    if (group === undefined) return fail('bad-request', 'Не указана группа изменений.')
    if (group === 'staged') return fail('bad-request', 'Файл уже подготовлен.')
    const target = scmTarget(body.path)
    if (target === undefined) return fail('bad-request', 'Некорректный путь файла.')
    try {
      const context = await scmContext(scope, signal)
      const refusal = scmWriteRefusal(context)
      if (refusal !== undefined) return refusal
      return await scmSerialized(context, async () => {
        const snapshot = await scmSnapshot(scope, context, signal)
        if (typeof body.revision !== 'string' || body.revision !== snapshot.revision) {
          return fail('stale', 'Список изменений обновился — обновите панель и повторите.')
        }
        const row = scm.findRow(snapshot, group, target)
        if (row === undefined) return fail('stale', 'Файл больше не в этой группе изменений — обновите панель.')
        const read = await scmReader(scope, context, signal)(target)
        if (typeof body.token !== 'string' || body.token !== scm.worktreeToken(read)) {
          return fail('stale', 'Содержимое файла изменилось с момента просмотра — обновите панель и повторите.')
        }
        await scm.addRow(context.git, row.entry, { signal })
        return { status: await scmSnapshot(scope, context, signal) }
      })
    } catch (error) {
      return scmFailure(error)
    }
  }

  async function scmUnstageRoute(body, signal) {
    const ask = await askRefusal()
    if (ask !== undefined) return ask
    const scope = sessionOf(body)
    if (scope === undefined) return fail('no-session', 'Сессия не найдена — снятие с подготовки недоступно.')
    if (scmGroup(body.group) !== 'staged') return fail('bad-request', 'Снять с подготовки можно только подготовленный файл.')
    const target = scmTarget(body.path)
    if (target === undefined) return fail('bad-request', 'Некорректный путь файла.')
    try {
      const context = await scmContext(scope, signal)
      const refusal = scmWriteRefusal(context)
      if (refusal !== undefined) return refusal
      return await scmSerialized(context, async () => {
        const snapshot = await scmSnapshot(scope, context, signal)
        if (typeof body.revision !== 'string' || body.revision !== snapshot.revision) {
          return fail('stale', 'Список изменений обновился — обновите панель и повторите.')
        }
        const row = scm.findRow(snapshot, 'staged', target)
        if (row === undefined) return fail('stale', 'Файл больше не подготовлен — обновите панель.')
        await scm.unstageRow(context.git, row.entry, { unborn: snapshot.unborn, signal })
        return { status: await scmSnapshot(scope, context, signal) }
      })
    } catch (error) {
      return scmFailure(error)
    }
  }

  async function scmCommitRoute(body, signal) {
    const ask = await askRefusal()
    if (ask !== undefined) return ask
    const scope = sessionOf(body)
    if (scope === undefined) return fail('no-session', 'Сессия не найдена — фиксация недоступна.')
    const message = typeof body.message === 'string' ? body.message.trim() : ''
    if (message === '') return fail('bad-request', 'Введите сообщение фиксации.')
    if (message.length > 20000) return fail('bad-request', 'Сообщение фиксации слишком длинное.')
    try {
      const context = await scmContext(scope, signal)
      const refusal = scmWriteRefusal(context)
      if (refusal !== undefined) return refusal
      return await scmSerialized(context, async () => {
        const snapshot = await scmSnapshot(scope, context, signal)
        if (typeof body.revision !== 'string' || body.revision !== snapshot.revision) {
          return fail('stale', 'Индекс изменился с момента просмотра — обновите панель и повторите.')
        }
        const staged = snapshot.entries.some((entry) => scm.groupsOf(entry).includes('staged'))
        if (!staged) return fail('nothing-staged', 'Нет подготовленных изменений — фиксировать нечего.')
        const outcome = await scm.commitIndex(context.git, message, { signal })
        return { head: outcome.head, status: await scmSnapshot(scope, context, signal) }
      })
    } catch (error) {
      return scmFailure(error)
    }
  }

  async function scmHistoryRoute(body, signal) {
    const scope = sessionOf(body)
    if (scope === undefined) return fail('no-session', 'Сессия не найдена — история Git недоступна.')
    let cursor
    if (body.cursor !== undefined && body.cursor !== null) {
      if (typeof body.cursor !== 'object') return fail('bad-request', 'Некорректное продолжение истории.')
      cursor = body.cursor
    }
    try {
      const context = await scmContext(scope, signal)
      return await scm.loadHistoryPage(context.git, { cursor, signal })
    } catch (error) {
      return scmFailure(error)
    }
  }

  async function scmCommitFilesRoute(body, signal) {
    const scope = sessionOf(body)
    if (scope === undefined) return fail('no-session', 'Сессия не найдена — история Git недоступна.')
    try {
      const context = await scmContext(scope, signal)
      const base = typeof body.base === 'string' && body.base !== '' ? body.base : undefined
      return await scm.loadCommitFiles(context.git, { oid: body.oid, base, signal })
    } catch (error) {
      return scmFailure(error)
    }
  }

  async function scmCommitDiffRoute(body, signal) {
    const scope = sessionOf(body)
    if (scope === undefined) return fail('no-session', 'Сессия не найдена — сравнение недоступно.')
    const target = scmTarget(body.path)
    if (target === undefined) return fail('bad-request', 'Некорректный путь файла.')
    try {
      const context = await scmContext(scope, signal)
      const base = typeof body.base === 'string' && body.base !== '' ? body.base : undefined
      const diff = await scm.loadCommitDiff(context.git, {
        oid: body.oid,
        base,
        path: target,
        signal,
      })
      return { diff: { ...diff, language: languageOf(target) } }
    } catch (error) {
      return scmFailure(error)
    }
  }

  // Branch routes are separate from staging so the client never sends a Git
  // command: it names a branch, and every argv tail is fixed here.
  async function scmBranchesRoute(body, signal) {
    const scope = sessionOf(body)
    if (scope === undefined) return fail('no-session', 'Сессия не найдена — ветки Git недоступны.')
    try {
      const context = await scmContext(scope, signal)
      return await scm.listBranches(context.git, { signal })
    } catch (error) {
      return scmFailure(error)
    }
  }

  async function scmCompareRoute(body, signal) {
    const scope = sessionOf(body)
    if (scope === undefined) return fail('no-session', 'Сессия не найдена — сравнение веток недоступно.')
    try {
      const context = await scmContext(scope, signal)
      const base = typeof body.base === 'string' ? body.base.trim() : ''
      if (base === '') return fail('bad-request', 'Не указана ветка для сравнения.')
      return await scm.compareBranch(context.git, base, { signal })
    } catch (error) {
      return scmFailure(error)
    }
  }

  async function scmCreateBranchRoute(body, signal) {
    const ask = await askRefusal()
    if (ask !== undefined) return ask
    const scope = sessionOf(body)
    if (scope === undefined) return fail('no-session', 'Сессия не найдена — создание ветки недоступно.')
    try {
      scm.branchName(body.name)
      const context = await scmContext(scope, signal)
      const refusal = scmWriteRefusal(context)
      if (refusal !== undefined) return refusal
      return await scmSerialized(context, async () => {
        await scm.createBranch(context.git, body.name, { signal })
        return {
          branches: await scm.listBranches(context.git, { signal }),
          status: await scmSnapshot(scope, context, signal),
        }
      })
    } catch (error) {
      return scmFailure(error)
    }
  }

  async function scmSwitchBranchRoute(body, signal) {
    const ask = await askRefusal()
    if (ask !== undefined) return ask
    const scope = sessionOf(body)
    if (scope === undefined) return fail('no-session', 'Сессия не найдена — переключение ветки недоступно.')
    try {
      scm.branchName(body.name)
      const context = await scmContext(scope, signal)
      const refusal = scmWriteRefusal(context)
      if (refusal !== undefined) return refusal
      return await scmSerialized(context, async () => {
        await scm.switchBranch(context.git, body.name, { signal })
        return {
          branches: await scm.listBranches(context.git, { signal }),
          status: await scmSnapshot(scope, context, signal),
        }
      })
    } catch (error) {
      return scmFailure(error)
    }
  }

  async function scmDeleteBranchRoute(body, signal) {
    const ask = await askRefusal()
    if (ask !== undefined) return ask
    const scope = sessionOf(body)
    if (scope === undefined) return fail('no-session', 'Сессия не найдена — удаление ветки недоступно.')
    try {
      scm.branchName(body.name)
      const context = await scmContext(scope, signal)
      const refusal = scmWriteRefusal(context)
      if (refusal !== undefined) return refusal
      return await scmSerialized(context, async () => {
        await scm.deleteBranch(context.git, body.name, { signal })
        return { branches: await scm.listBranches(context.git, { signal }) }
      })
    } catch (error) {
      return scmFailure(error)
    }
  }

  // A worktree lives inside the workspace: the Host only writes where its
  // policy allows, so the client sends a relative path like `.worktrees/task`.
  async function scmWorktreesRoute(body, signal) {
    const scope = sessionOf(body)
    if (scope === undefined) return fail('no-session', 'Сессия не найдена — рабочие копии недоступны.')
    try {
      const context = await scmContext(scope, signal)
      return await scm.listWorktrees(context.git, { signal })
    } catch (error) {
      return scmFailure(error)
    }
  }

  async function scmCreateWorktreeRoute(body, signal) {
    const ask = await askRefusal()
    if (ask !== undefined) return ask
    const scope = sessionOf(body)
    if (scope === undefined) return fail('no-session', 'Сессия не найдена — создание рабочей копии недоступно.')
    const relative = scmTarget(body.path)
    if (relative === undefined) return fail('bad-request', 'Путь рабочей копии должен быть относительным и без «..».')
    try {
      scm.branchName(body.branch)
      const context = await scmContext(scope, signal)
      const refusal = scmWriteRefusal(context)
      if (refusal !== undefined) return refusal
      const target = path.join(context.display, relative.split('/').join(path.sep))
      if (!scmInside(context.display, target)) {
        return fail('outside-workspace', 'Рабочая копия должна находиться внутри открытой рабочей папки.')
      }
      return await scmSerialized(context, async () => {
        const created = await scm.addWorktree(context.git, target, body.branch, {
          create: body.create === true,
          signal,
        })
        return { ...created, ...(await scm.listWorktrees(context.git, { signal })) }
      })
    } catch (error) {
      return scmFailure(error)
    }
  }

  async function scmRemoveWorktreeRoute(body, signal) {
    const ask = await askRefusal()
    if (ask !== undefined) return ask
    const scope = sessionOf(body)
    if (scope === undefined) return fail('no-session', 'Сессия не найдена — удаление рабочей копии недоступно.')
    try {
      const context = await scmContext(scope, signal)
      const refusal = scmWriteRefusal(context)
      if (refusal !== undefined) return refusal
      const target = path.resolve(typeof body.path === 'string' ? body.path : '')
      if (typeof body.path !== 'string' || !path.isAbsolute(body.path) || !scmInside(context.display, target)) {
        return fail('outside-workspace', 'Удалять можно только рабочую копию внутри открытой рабочей папки.')
      }
      return await scmSerialized(context, async () => {
        await scm.removeWorktree(context.git, target, { force: body.force === true, signal })
        return { ...(await scm.listWorktrees(context.git, { signal })) }
      })
    } catch (error) {
      return scmFailure(error)
    }
  }

  // ------------------------------------------------------- chat and review
  //
  // Both features hand the exact index patch to a model or to the chat draft.
  // The user starts each one explicitly; nothing runs on stage, on a timer or
  // on focus. The patch is bounded in scm.js and the answer is validated before
  // the browser sees it.

  function patchReasonLabel(reason) {
    switch (reason) {
      case 'untracked':
        return 'не в индексе'
      case 'binary':
        return 'двоичный файл'
      case 'secret':
        return 'похож на секрет — отправка запрещена'
      case 'too-large':
        return 'больше лимита'
      case 'empty':
        return 'нет текстового изменения'
      case 'limit':
        return 'не вошло в лимит файлов'
      default:
        return String(reason)
    }
  }

  /** One prompt body: the file list, the skipped files, then the exact patch. */
  function scmPatchText(patch) {
    const lines = [`Файлы (${patch.files.length}):`]
    for (const file of patch.files) lines.push(`- ${file.status} ${file.path} (${file.bytes} Б)`)
    if (patch.skipped.length > 0) {
      lines.push('', 'Пропущено (в diff не вошло):')
      for (const item of patch.skipped) lines.push(`- ${item.path} — ${patchReasonLabel(item.reason)}`)
    }
    if (patch.truncated) lines.push('', 'Внимание: снимок усечён по лимиту.')
    lines.push('', 'Diff:', '```diff', patch.patch.trimEnd(), '```')
    return lines.join('\n')
  }

  /**
   * One bounded model call for a Git answer.
   *
   * The stream contract is the same as inline edit: text arrives as
   * `text-delta`, a transport failure arrives either as an `error` chunk or as
   * `finish` with `reason.kind === "error"`. The caller decides what a valid
   * body means; this helper only collects and classifies the transport.
   */
  async function scmAnswer({ sessionId, system, text, purpose, signal, maxChars = SCM_MAX_ANSWER_CHARS }) {
    const selection = ctx.agentDefaultModel.currentSelection()
    if (
      selection === null ||
      selection === undefined ||
      typeof selection.provider !== 'string' ||
      typeof selection.model !== 'string'
    ) {
      return { error: fail('no-model', 'Модель не выбрана — действие недоступно.') }
    }
    const deadline = AbortSignal.timeout(SCM_ANSWER_TIMEOUT_MS)
    const combined = signal === undefined ? deadline : AbortSignal.any([signal, deadline])
    let buffer = ''
    let streamError = ''
    try {
      const iterator = ctx.llm.stream({
        provider: selection.provider,
        model: selection.model,
        system,
        messages: [{ role: 'user', content: [{ type: 'text', text }] }],
        temperature: 0.2,
        signal: combined,
        sessionId,
        purpose,
      })[Symbol.asyncIterator]()
      for (;;) {
        const step = await iterator.next()
        if (step.done) break
        const chunk = step.value
        if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') buffer += chunk.text
        else if (chunk?.type === 'error') {
          streamError = String(chunk.message ?? chunk.error?.message ?? chunk.error ?? 'unknown')
        } else if (chunk?.type === 'finish' && chunk.reason?.kind === 'error' && streamError === '') {
          streamError = String(chunk.reason.failure?.message ?? chunk.reason.failure?.code ?? 'unknown')
        }
        if (buffer.length > maxChars) break
      }
    } catch (error) {
      if (error?.name === 'TimeoutError') return { error: fail('timeout', 'Модель не ответила вовремя.') }
      if (error?.name === 'AbortError' || error?.code === 'ABORT_ERR') {
        return { error: fail('cancelled', 'Запрос отменён.') }
      }
      return { error: fail('git-failed', error instanceof Error ? error.message : String(error)) }
    }
    if (streamError !== '') return { error: fail('bad-answer', `Модель не ответила: ${streamError}`) }
    return { text: buffer, provider: selection.provider, model: selection.model }
  }

  /**
   * Validate a review answer against the patch that was actually sent.
   *
   * A line that is not on the new side of that file, a path that is not in the
   * payload, a duplicate and a missing message are all dropped: a finding the
   * user cannot open in the reviewed diff is worse than no finding. `undefined`
   * means the answer was not JSON at all.
   */
  function parseFindings(answer, patch, maxFindings = 50) {
    let text = String(answer).trim()
    const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(text)
    if (fenced !== null) text = fenced[1].trim()
    const start = text.indexOf('{')
    const end = text.lastIndexOf('}')
    if (start === -1 || end <= start) return undefined
    let parsed
    try {
      parsed = JSON.parse(text.slice(start, end + 1))
    } catch {
      return undefined
    }
    if (parsed === null || typeof parsed !== 'object' || !Array.isArray(parsed.findings)) return undefined
    const allowed = new Map(patch.parts.map((part) => [part.path, scm.patchLineNumbers(part.patch)]))
    const findings = []
    const seen = new Set()
    for (const item of parsed.findings) {
      if (findings.length >= maxFindings) break
      if (item === null || typeof item !== 'object') continue
      const lines = allowed.get(item.path)
      if (lines === undefined) continue
      if (!Number.isSafeInteger(item.line) || !lines.has(item.line)) continue
      const severity = item.severity === 'high' || item.severity === 'medium' || item.severity === 'low' ? item.severity : 'medium'
      const raw = typeof item.message === 'string' ? item.message.trim() : ''
      if (raw === '') continue
      const message = raw.length > 500 ? `${raw.slice(0, 500)}…` : raw
      const key = `${item.path}:${item.line}:${message}`
      if (seen.has(key)) continue
      seen.add(key)
      findings.push({ path: item.path, line: item.line, severity, message })
    }
    return findings
  }

  /** A message answer without fences and quotes; the first line stays short. */
  function plainAnswer(value) {
    const text = String(value).trim()
    const fenced = /^```[a-zA-Z]*\s*([\s\S]*?)\s*```$/.exec(text)
    const body = fenced === null ? text : fenced[1].trim()
    return body.slice(0, SCM_MAX_MESSAGE_CHARS)
  }

  async function scmPatchRoute(body, signal) {
    const scope = sessionOf(body)
    if (scope === undefined) return fail('no-session', 'Сессия не найдена — Git diff недоступен.')
    const group = body.group === 'staged' ? 'staged' : body.group === 'changes' ? 'changes' : undefined
    if (group === undefined) return fail('bad-request', 'Diff доступен для индекса и рабочей копии.')
    let target
    if (body.path !== undefined && body.path !== null && body.path !== '') {
      target = scmTarget(body.path)
      if (target === undefined) return fail('bad-request', 'Некорректный путь файла.')
    }
    try {
      const context = await scmContext(scope, signal)
      const snapshot = await scmSnapshot(scope, context, signal)
      if (typeof body.revision === 'string' && body.revision !== snapshot.revision) {
        return fail('stale', 'Список изменений обновился — обновите панель и повторите.')
      }
      const ignore = await loadIgnore(context.display)
      const patch = await scm.loadPatch(context.git, snapshot, {
        group,
        skip: (file) => (completionExcluded(file) ? 'secret' : ignore.blocked(file) ? 'ignored' : false),
        signal,
      })
      const parts = target === undefined ? patch.parts : patch.parts.filter((part) => part.path === target)
      if (parts.length === 0) {
        return fail(
          group === 'staged' ? 'nothing-staged' : 'nothing-to-send',
          group === 'staged'
            ? 'Подготовленные файлы не дают текстового diff.'
            : 'Изменения рабочей копии не дают текстового diff.',
        )
      }
      const bytes = parts.reduce((sum, part) => sum + Buffer.byteLength(part.patch, 'utf8'), 0)
      return {
        group,
        patch: parts.map((part) => part.patch).join(''),
        files: patch.files.filter((file) => parts.some((part) => part.path === file.path)),
        skipped: patch.skipped.filter((item) => target === undefined || item.path === target),
        truncated: patch.truncated,
        bytes,
        revision: snapshot.revision,
      }
    } catch (error) {
      return scmFailure(error)
    }
  }

  /** Split the staged patch into bounded file groups for the deep pass. */
  function reviewChunks(patch) {
    const chunks = []
    let current = []
    let chars = 0
    let truncated = false
    for (const part of patch.parts) {
      const size = part.patch.length
      if (current.length > 0 && (chars + size > SCM_DEEP_CHUNK_CHARS || chunks.length + 1 >= SCM_DEEP_MAX_CALLS)) {
        chunks.push(current)
        current = []
        chars = 0
      }
      if (chunks.length >= SCM_DEEP_MAX_CALLS) {
        truncated = true
        break
      }
      current.push(part)
      chars += size
    }
    if (current.length > 0 && chunks.length < SCM_DEEP_MAX_CALLS) chunks.push(current)
    return { chunks, truncated }
  }

  async function scmReviewRoute(body, signal) {
    const scope = sessionOf(body)
    if (scope === undefined) return fail('no-session', 'Сессия не найдена — проверка индекса недоступна.')
    try {
      const context = await scmContext(scope, signal)
      const refusal = scmWriteRefusal(context)
      if (refusal !== undefined) return refusal
      const snapshot = await scmSnapshot(scope, context, signal)
      if (!snapshot.entries.some((entry) => scm.groupsOf(entry).includes('staged'))) {
        return fail('nothing-staged', 'Нет подготовленных изменений — проверять нечего.')
      }
      if (typeof body.revision !== 'string' || body.revision !== snapshot.revision) {
        return fail('stale', 'Индекс изменился — проверьте снимок заново.')
      }
      const ignore = await loadIgnore(context.display)
      const patch = await scm.loadPatch(context.git, snapshot, {
        group: 'staged',
        skip: (file) => (completionExcluded(file) ? 'secret' : ignore.blocked(file) ? 'ignored' : false),
        signal,
      })
      if (patch.files.length === 0) {
        return fail('nothing-staged', 'Подготовленные файлы не дают текстового diff для проверки.')
      }
      const depth = body.depth === 'deep' ? 'deep' : 'quick'
      const startedAt = Date.now()
      const findings = []
      const seen = new Set()
      let provider = ''
      let model = ''
      let calls = 0
      let truncated = patch.truncated
      const collect = (parsed) => {
        for (const finding of parsed) {
          const key = `${finding.path}:${finding.line}:${finding.message}`
          if (seen.has(key)) continue
          seen.add(key)
          findings.push(finding)
          if (findings.length >= 50) return
        }
      }
      if (depth === 'quick') {
        const answer = await scmAnswer({
          sessionId: scope.id,
          system: SCM_REVIEW_SYSTEM_PROMPT,
          text: scmPatchText(patch),
          purpose: 'code-editor-scm-review',
          signal,
        })
        if (answer.error !== undefined) return answer.error
        if (answer.text.trim() === '') return fail('bad-answer', 'Модель вернула пустой ответ.')
        const parsed = parseFindings(answer.text, patch)
        if (parsed === undefined) {
          return fail('bad-answer', 'Модель вернула ответ не в ожидаемом формате JSON.')
        }
        collect(parsed)
        provider = answer.provider
        model = answer.model
        calls = 1
      } else {
        const { chunks, truncated: chunkLimit } = reviewChunks(patch)
        if (chunkLimit) truncated = true
        for (const parts of chunks) {
          const chunk = {
            parts,
            patch: parts.map((part) => part.patch).join(''),
            files: patch.files.filter((file) => parts.some((part) => part.path === file.path)),
            skipped: [],
            truncated: false,
            bytes: parts.reduce((sum, part) => sum + Buffer.byteLength(part.patch, 'utf8'), 0),
          }
          const answer = await scmAnswer({
            sessionId: scope.id,
            system: SCM_REVIEW_SYSTEM_PROMPT,
            text: scmPatchText(chunk),
            purpose: 'code-editor-scm-review',
            signal,
          })
          if (answer.error !== undefined) return answer.error
          if (answer.text.trim() === '') return fail('bad-answer', 'Модель вернула пустой ответ.')
          const parsed = parseFindings(answer.text, chunk)
          if (parsed === undefined) {
            return fail('bad-answer', 'Модель вернула ответ не в ожидаемом формате JSON.')
          }
          collect(parsed)
          provider = answer.provider
          model = answer.model
          calls += 1
        }
      }
      return {
        depth,
        calls,
        durationMs: Date.now() - startedAt,
        revision: snapshot.revision,
        files: patch.files,
        skipped: patch.skipped,
        truncated,
        bytes: patch.bytes,
        provider,
        model,
        findings,
      }
    } catch (error) {
      return scmFailure(error)
    }
  }

  async function scmDraftMessageRoute(body, signal) {
    const scope = sessionOf(body)
    if (scope === undefined) return fail('no-session', 'Сессия не найдена — черновик сообщения недоступен.')
    try {
      const context = await scmContext(scope, signal)
      const refusal = scmWriteRefusal(context)
      if (refusal !== undefined) return refusal
      const snapshot = await scmSnapshot(scope, context, signal)
      if (!snapshot.entries.some((entry) => scm.groupsOf(entry).includes('staged'))) {
        return fail('nothing-staged', 'Нет подготовленных изменений — черновик не нужен.')
      }
      if (typeof body.revision !== 'string' || body.revision !== snapshot.revision) {
        return fail('stale', 'Индекс изменился — обновите панель и повторите.')
      }
      const ignore = await loadIgnore(context.display)
      const patch = await scm.loadPatch(context.git, snapshot, {
        group: 'staged',
        skip: (file) => (completionExcluded(file) ? 'secret' : ignore.blocked(file) ? 'ignored' : false),
        signal,
      })
      if (patch.files.length === 0) {
        return fail('nothing-staged', 'Подготовленные файлы не дают текстового diff для черновика.')
      }
      const answer = await scmAnswer({
        sessionId: scope.id,
        system: SCM_MESSAGE_SYSTEM_PROMPT,
        text: scmPatchText(patch),
        purpose: 'code-editor-scm-message',
        signal,
      })
      if (answer.error !== undefined) return answer.error
      const message = plainAnswer(answer.text)
      if (message === '') return fail('bad-answer', 'Модель вернула пустое сообщение.')
      return {
        message,
        revision: snapshot.revision,
        files: patch.files,
        skipped: patch.skipped,
        truncated: patch.truncated,
        bytes: patch.bytes,
        provider: answer.provider,
        model: answer.model,
      }
    } catch (error) {
      return scmFailure(error)
    }
  }

  async function scmConflictRoute(body, signal) {
    const scope = sessionOf(body)
    if (scope === undefined) return fail('no-session', 'Сессия не найдена — конфликты Git недоступны.')
    const target = scmTarget(body.path)
    if (target === undefined) return fail('bad-request', 'Некорректный путь файла.')
    try {
      const context = await scmContext(scope, signal)
      const snapshot = await scmSnapshot(scope, context, signal)
      if (typeof body.revision === 'string' && body.revision !== snapshot.revision) {
        return fail('stale', 'Список изменений обновился — откройте файл заново.')
      }
      const conflict = await scm.loadConflict(context.git, snapshot, target, { signal })
      return { conflict, revision: snapshot.revision }
    } catch (error) {
      return scmFailure(error)
    }
  }

  async function scmResolveRoute(body, signal) {
    const scope = sessionOf(body)
    if (scope === undefined) return fail('no-session', 'Сессия не найдена — разрешение конфликта недоступно.')
    const target = scmTarget(body.path)
    if (target === undefined) return fail('bad-request', 'Некорректный путь файла.')
    try {
      const context = await scmContext(scope, signal)
      const refusal = scmWriteRefusal(context)
      if (refusal !== undefined) return refusal
      const snapshot = await scmSnapshot(scope, context, signal)
      if (typeof body.revision !== 'string' || body.revision !== snapshot.revision) {
        return fail('stale', 'Список изменений обновился — обновите панель и повторите.')
      }
      const conflict = await scm.loadConflict(context.git, snapshot, target, { signal })
      const text = [
        `Файл: ${target}`,
        conflict.hasBase ? `--- base ---\n${conflict.base}` : '--- base отсутствует: файл добавлен с двух сторон ---',
        conflict.hasOurs ? `--- ours ---\n${conflict.ours}` : '--- ours отсутствует: сторона удалила файл ---',
        conflict.hasTheirs ? `--- theirs ---\n${conflict.theirs}` : '--- theirs отсутствует: сторона удалила файл ---',
      ].join('\n')
      if (text.length > SCM_RESOLVE_MAX_CHARS * 2) {
        return fail('context-too-large', 'Стороны конфликта слишком велики для модели.')
      }
      const answer = await scmAnswer({
        sessionId: scope.id,
        system: SCM_CONFLICT_SYSTEM_PROMPT,
        text,
        purpose: 'code-editor-scm-resolve',
        maxChars: SCM_RESOLVE_MAX_CHARS,
        signal,
      })
      if (answer.error !== undefined) return answer.error
      const resolution = plainAnswer(answer.text)
      if (resolution === '' && conflict.ours === '' && conflict.theirs === '') {
        return fail('bad-answer', 'Модель вернула пустое разрешение.')
      }
      return {
        path: target,
        resolution,
        revision: snapshot.revision,
        files: [target],
        skipped: [],
        bytes: conflict.bytes,
        provider: answer.provider,
        model: answer.model,
      }
    } catch (error) {
      return scmFailure(error)
    }
  }

  async function scmResolveApplyRoute(body, signal) {
    const ask = await askRefusal()
    if (ask !== undefined) return ask
    const scope = sessionOf(body)
    if (scope === undefined) return fail('no-session', 'Сессия не найдена — запись разрешения недоступна.')
    const target = scmTarget(body.path)
    if (target === undefined) return fail('bad-request', 'Некорректный путь файла.')
    if (typeof body.text !== 'string') return fail('bad-request', 'Не передано разрешённое содержимое.')
    if (body.text.length > 1024 * 1024) return fail('bad-request', 'Разрешённый текст слишком велик.')
    try {
      const context = await scmContext(scope, signal)
      const refusal = scmWriteRefusal(context)
      if (refusal !== undefined) return refusal
      return await scmSerialized(context, async () => {
        const snapshot = await scmSnapshot(scope, context, signal)
        if (typeof body.revision !== 'string' || body.revision !== snapshot.revision) {
          return fail('stale', 'Индекс изменился с момента предложения — повторите разрешение.')
        }
        if (scm.findRow(snapshot, 'conflicts', target) === undefined) {
          return fail('not-conflict', 'Файл больше не находится в конфликте.')
        }
        const outcome = await scm.resolveConflict(context.git, target, body.text, { signal })
        return {
          path: target,
          oid: outcome.oid,
          status: await scmSnapshot(scope, context, signal),
        }
      })
    } catch (error) {
      return scmFailure(error)
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
      offset: typeof body.offset === 'number' ? body.offset : undefined,
      limit: typeof body.limit === 'number' ? body.limit : undefined,
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

  // --------------------------------------------------------------- structure

  function structureRoute(body) {
    if (sessionOf(body) === undefined) return fail('no-session', 'Сессия не найдена — откройте файл из активной сессии.')
    const path = typeof body.path === 'string' ? body.path : ''
    const text = typeof body.text === 'string' ? body.text : ''
    // The client already caps what it sends; this only stops a runaway request
    // from costing the Host more than an outline is worth.
    if (text.length > 4000000) return fail('too-large', 'Файл слишком большой для структуры.')
    return outlineOf(path, text)
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
    const ask = await askRefusal()
    if (ask !== undefined) return ask
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
    const ask = await askRefusal()
    if (ask !== undefined) return ask
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
    const ask = await askRefusal()
    if (ask !== undefined) return ask
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

  // ----------------------------------------------------------------- reveal

  async function revealRoute(body, signal) {
    const scope = sessionOf(body)
    if (scope === undefined) return fail('no-session', 'Сессия не найдена — откройте папку из активной сессии.')
    const relative = typeof body.path === 'string' ? body.path.trim() : ''
    const segments = relative.split(/[\\/]+/)
    if (relative === '' || relative.length > 400 || segments.some((segment) => segment === '..' || segment === '')) {
      return fail('bad-request', 'Укажите путь к файлу или папке внутри рабочей папки.')
    }
    const root = await ctx.fs.resolve(scope.cwd, { signal })
    const target = await ctx.fs.resolve(path.resolve(scope.cwd, relative), { signal })
    if (!ctx.fs.contains(root, target)) return fail('outside-workspace', 'Показать можно только путь внутри рабочей папки.')
    const nativePath = ctx.fs.processPath(target)
    const existing = await stat(nativePath).catch(() => undefined)
    if (existing === undefined) return fail('not-found', 'Такого файла или папки больше нет — обновите дерево.')
    try {
      await launchDetached(revealInvocation(process.platform, nativePath))
    } catch (error) {
      return fail('reveal-failed', `Не удалось открыть проводник ОС: ${error instanceof Error ? error.message : String(error)}`)
    }
    return { path: relative, revealed: true }
  }

  /** Starts the file manager and lets go of it: the page must not wait for its exit. */
  function launchDetached(invocation) {
    return new Promise((resolve, reject) => {
      const child = spawn(invocation.command, invocation.args, { detached: true, stdio: 'ignore', ...invocation.options })
      child.once('error', reject)
      child.once('spawn', () => {
        child.unref()
        resolve()
      })
    })
  }

  async function stateRoute(body) {
    const scope = sessionOf(body)
    if (scope === undefined) return fail('no-session', 'Сессия не найдена — откройте папку из активной сессии.')
    if (body.patch !== undefined && typeof body.patch === 'object' && body.patch !== null) {
      return { state: await writeSessionState(scope.id, body.patch) }
    }
    return { state: await readSessionState(scope.id) }
  }

  /** The terminal always starts in the session workspace root. */
  async function termCreateRoute(body, signal) {
    const scope = sessionOf(body)
    if (scope === undefined) return fail('no-session', 'Сессия не найдена — откройте терминал из активной сессии.')
    const root = await rootTarget(scope.cwd, signal)
    return terminalService.termCreateRoute(body, { cwd: ctx.fs.processPath(root) })
  }

  // -------------------------------------------------------- smart terminal

  /**
   * The instruction for a terminal continuation. It is deliberately stricter
   * than the editor prompt: the answer is typed into a live shell on Tab, so
   * anything but the bare remaining characters becomes typed garbage.
   */
  const TERMINAL_SUGGEST_PROMPT = [
    'Ты — ассистент командной строки в IDE. Пользователь начал вводить команду в терминале.',
    'Допечатай команду: верни ТОЛЬКО текст, который нужно добавить после уже введённого.',
    'Правила: одна строка; без пояснений; без кавычек-обёрток вокруг всего ответа;',
    'не повторяй уже введённый текст; учитывай недавний вывод терминала —',
    'после ошибки предложи исправленную команду; если продолжать нечего — верни пустой ответ.',
  ].join('\n')

  /**
   * The model may echo the typed prefix (chat models love to restate the
   * input). The client types the answer verbatim on Tab, so an echo would
   * duplicate the command — cut it, take the first line only, and cap the
   * length so a runaway answer cannot push a wall of text into the shell.
   */
  function sanitizeTermSuggestion(raw, typed) {
    let text = String(raw ?? '').replace(/\r/g, '')
    const newline = text.indexOf('\n')
    if (newline !== -1) text = text.slice(0, newline)
    text = text.trim()
    if (text === '') return ''
    text = text.replace(/^`+/, '').replace(/`+$/, '').trim()
    const echo = String(typed ?? '')
    if (echo !== '' && text.toLowerCase().startsWith(echo.toLowerCase())) text = text.slice(echo.length)
    if (text === '') return ''
    return text.slice(0, 200)
  }

  /**
   * One idle-pause prediction for the smart terminal: continue the text the
   * user has typed so far. The screen tail rides along so a visible error can
   * shape the continuation. Same model chain as the editor completion — the
   * user configured a model once and expects both features to use it.
   */
  async function termSuggest(body, signal) {
    const scope = sessionOf(body)
    if (scope === undefined) return fail('no-session', 'Сессия не найдена — предугадывание недоступно.')
    const typed = String(body.command ?? '').slice(0, 300)
    const requestId = randomUUID()
    if (typed.trim() === '') return { text: '', requestId, provider: '', model: '', durationMs: 0, reason: '' }
    // The screen is context, never a transcript: bound it on the way in.
    const screen = String(body.output ?? '').replace(/\s+$/g, '').slice(-1200)
    const shell = typeof body.profile === 'string' ? body.profile.slice(0, 60) : ''
    const cwd = typeof body.cwd === 'string' ? body.cwd.slice(0, 200) : ''
    const startedAt = Date.now()

    const selection = ctx.agentDefaultModel.currentSelection()
    if (!selection || typeof selection.provider !== 'string' || typeof selection.model !== 'string') {
      return fail('no-model', 'Модель не выбрана — предугадывание недоступно, терминал работает.')
    }
    const preferences = await readPreferences()
    const requestedModel = String(
      preferences.completionModel ||
        (typeof config === 'object' && config !== null && typeof config.completionModel === 'string'
          ? config.completionModel
          : '') ||
        process.env.DSH_CODE_EDITOR_MODEL ||
        '',
    ).trim()
    let modelSource =
      String(preferences.completionModel ?? '').trim() !== ''
        ? 'settings'
        : typeof config === 'object' && config !== null && String(config.completionModel ?? '').trim() !== ''
          ? 'config'
          : String(process.env.DSH_CODE_EDITOR_MODEL ?? '').trim() !== ''
            ? 'env'
            : 'session'
    const provider = selection.provider
    let effectiveModel = requestedModel
    // The session's own model is usually a thinking one; a suggestion that
    // lands 20 s late is worse than none. Same reasoning as the editor path.
    if (modelSource === 'session' && preferences.autoModel !== false) {
      const family = String(selection.model).toLowerCase().split('-')[0]
      const fast = await untilAbort(signal, () => pickFastModel(ctx, provider, family))
      if (fast !== '' && fast !== selection.model) {
        effectiveModel = fast
        modelSource = 'auto'
      }
    }

    const deadline = AbortSignal.timeout(boundedMs(preferences.deadlineMs, 8000, 1000, 20000))
    const combined = AbortSignal.any([signal, deadline])
    const requestText =
      `Оболочка: ${shell}\n` +
      (cwd === '' ? '' : `Папка: ${cwd}\n`) +
      (screen === '' ? '' : `--- недавний вывод терминала ---\n${screen}\n--- конец вывода ---\n`) +
      `Введено: ${typed}`

    const effortChain = effortChainFor(preferences.completionEffort)
    let text = ''
    let used
    let effortUsed
    let streamError = ''
    for (const attempt of [{ provider, model: effectiveModel !== '' ? effectiveModel : selection.model }]) {
      for (const effort of effortChain) {
        let buffer = ''
        const stop = new AbortController()
        const attemptSignal = AbortSignal.any([combined, stop.signal])
        let iterator
        try {
          iterator = ctx.llm.stream({
            provider: attempt.provider,
            model: attempt.model,
            ...(effort === undefined ? {} : { reasoningEffort: effort }),
            system: TERMINAL_SUGGEST_PROMPT,
            messages: [{ role: 'user', content: [{ type: 'text', text: requestText }] }],
            temperature: 0.2,
            signal: attemptSignal,
            sessionId: scope.id,
            purpose: 'code-editor-terminal-suggestion',
          })[Symbol.asyncIterator]()
          while (true) {
            const { done, value: chunk } = await untilAbort(attemptSignal, () => iterator.next())
            if (done) { iterator = undefined; break }
            if (!chunk || typeof chunk !== 'object') continue
            if (chunk.type === 'text-delta' && typeof chunk.text === 'string') buffer += chunk.text
            if (chunk.type === 'error') {
              const detail = chunk.message ?? chunk.error?.message ?? chunk.error
              streamError = typeof detail === 'string' && detail !== '' ? detail : 'stream-error'
            }
            if (chunk.type === 'finish') {
              const reason = chunk.reason ?? {}
              if (reason.kind === 'error' && reason.failure !== undefined && reason.failure !== null) {
                const message = typeof reason.failure.message === 'string' ? reason.failure.message : ''
                const code = typeof reason.failure.code === 'string' ? reason.failure.code : ''
                streamError = message !== '' ? message : code !== '' ? code : 'stream-error'
              }
            }
            if (buffer.length > 600) break
          }
        } catch (cause) {
          if (signal?.aborted) combined.throwIfAborted()
          if (buffer.trim() === '') streamError = cause instanceof Error ? cause.message : String(cause)
        } finally {
          if (iterator !== undefined) {
            stop.abort()
            void Promise.resolve().then(() => iterator.return?.()).catch(() => {})
          }
        }
        const answer = sanitizeTermSuggestion(buffer, typed)
        if (answer !== '') {
          used = attempt
          effortUsed = effort
          text = answer
          break
        }
        if (streamError !== '' && !isUnsupportedEffort(streamError)) break
      }
      if (text !== '') break
    }

    logCompletion({
      file: `терминал:${shell}`,
      kind: 'terminal-suggest',
      provider: used?.provider ?? '',
      model: used?.model ?? '',
      modelSource,
      effort: effortUsed ?? '',
      answerChars: text.length,
      typedChars: typed.length,
      screenChars: screen.length,
      ms: Date.now() - startedAt,
      error: streamError !== '' ? streamError : undefined,
    })
    const reason =
      text !== ''
        ? ''
        : streamError !== ''
          ? `Модель не ответила: ${streamError}`
          : 'Модель не предложила продолжение.'
    return {
      text,
      requestId,
      provider: used?.provider ?? '',
      model: used?.model ?? '',
      modelSource,
      durationMs: Date.now() - startedAt,
      reason,
    }
  }


  async function credentialsRoute(body) {
    const operation = typeof body.op === 'string' ? body.op : 'status'
    if (operation === 'set') return saveCredential(ctx, { ref: body.ref, value: body.value })
    if (operation === 'clear') return clearCredential(ctx, { ref: body.ref })
    return credentialStatus(ctx, body.ref)
  }

  async function prefsRoute(body) {
    // The shipped instruction travels with the preferences so the drawer can show
    // it as the placeholder of the field: an empty field means "this text".
    if (body.patch !== undefined && typeof body.patch === 'object' && body.patch !== null) {
      return { preferences: await writePreferences(body.patch), promptDefault: DEFAULT_SYSTEM_PROMPT }
    }
    return { preferences: await readPreferences(), promptDefault: DEFAULT_SYSTEM_PROMPT }
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

/**
 * Command line that opens the OS file manager with `absolutePath` selected.
 * The path is an argument, never a shell word, so a file name cannot become a
 * command. Windows and macOS can select the entry itself; a Linux file manager
 * only opens a folder, which is the one containing the entry.
 */
export function revealInvocation(platform, absolutePath) {
  if (platform === 'win32') {
    return { command: 'explorer.exe', args: [`/select,"${absolutePath}"`], options: { windowsVerbatimArguments: true } }
  }
  if (platform === 'darwin') return { command: 'open', args: ['-R', absolutePath] }
  return { command: 'xdg-open', args: [path.dirname(absolutePath)] }
}

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
 * Encodings the Host can decode on open. `writable` marks the ones that can be
 * expressed as a `ctx.fs.writeText` payload (UTF-8 text); the others are
 * read-and-convert-only, because the file system seam has no byte-level write.
 */
const ENCODINGS = new Map([
  ['utf8', { label: 'UTF-8', writable: true }],
  ['utf8-bom', { label: 'UTF-8 с BOM', writable: true }],
  ['utf16le', { label: 'UTF-16 LE', writable: false }],
  ['utf16be', { label: 'UTF-16 BE', writable: false }],
  ['windows-1251', { label: 'Windows-1251', writable: false }],
  ['koi8-r', { label: 'KOI8-R', writable: false }],
  ['ibm866', { label: 'OEM 866', writable: false }],
  ['windows-1252', { label: 'Windows-1252', writable: false }],
  ['iso-8859-5', { label: 'ISO 8859-5', writable: false }],
])

/** BOM sniffing only: there is no reliable heuristic for byte-level charsets. */
function sniffEncoding(bytes) {
  if (bytes.byteLength >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return 'utf16le'
  if (bytes.byteLength >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return 'utf16be'
  if (bytes.byteLength >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return 'utf8-bom'
  return undefined
}

function decodeWithEncoding(bytes, encoding) {
  if (encoding === 'utf8') return decodeUtf8(bytes)
  if (encoding === 'utf8-bom') {
    const hasBom = bytes.byteLength >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf
    const view = hasBom ? bytes.subarray(3) : bytes
    try {
      return { text: new TextDecoder('utf-8', { fatal: true }).decode(view), bom: hasBom }
    } catch {
      return undefined
    }
  }
  if (encoding === 'utf16le' || encoding === 'utf16be') {
    if (bytes.byteLength % 2 !== 0) return undefined
    const hasBom =
      (encoding === 'utf16le' && bytes[0] === 0xff && bytes[1] === 0xfe) ||
      (encoding === 'utf16be' && bytes[0] === 0xfe && bytes[1] === 0xff)
    const view = hasBom ? bytes.subarray(2) : bytes
    try {
      const text = new TextDecoder(encoding === 'utf16le' ? 'utf-16le' : 'utf-16be').decode(view)
      if (text.includes('\u0000')) return undefined
      return { text, bom: hasBom }
    } catch {
      return undefined
    }
  }
  const spec = ENCODINGS.get(encoding)
  if (spec === undefined) return undefined
  try {
    const text = new TextDecoder(encoding, { fatal: true }).decode(bytes)
    if (text.includes('\u0000')) return undefined
    return { text, bom: false }
  } catch {
    return undefined
  }
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
