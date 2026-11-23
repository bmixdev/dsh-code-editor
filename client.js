/**
 * Client half of `@local/dsh-ide`.
 *
 * A VS Code-shaped editor that lives in the right sidebar and brings its own
 * explorer: it lists the session workspace itself, keeps several files open as
 * tabs (one Monaco model each, so undo and cursor survive a tab switch) and
 * does not depend on the built-in file preview plugin for anything but the way
 * the tab is spawned.
 *
 * Entry points:
 *  - the "IDE" button in the composer tool row (always visible in a session);
 *  - an "IDE" action on the document, files and guide toolbars;
 *  - any `dsh-resource://ide/session/<id>[/<path>]` address opened with kind `dsh-ide`.
 *
 * Monaco is vendored (vendor/vs) and served by the Host half at /ide/vs, so
 * nothing is fetched from a CDN.
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-ide',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const TAB_ID = '@local/dsh-ide'
    const TAB_KIND = 'dsh-ide'
    // Bumped with every change that has to reach the browser: the number is
    // shown in the settings drawer, so "did the tab reload?" stops being a guess.
    const UI_BUILD = '2026-11-23.10'
    const ACTION_ID = 'dsh-ide.open'
    const ACTION_SLOTS = [
      ['sidebar.right.tab.document.actions', ACTION_ID, 30, 'IDE'],
      ['sidebar.right.tab.files.actions', `${ACTION_ID}.files`, 30, 'IDE'],
      ['sidebar.right.tab.guide.actions', `${ACTION_ID}.guide`, 30, 'IDE'],
    ]
    const API_BASE = '/api/ide/'
    const ASSET_BASE = '/ide/vs'
    // Sidebar tab addresses must live under the shell's resource scheme, or the
    // sidebar refuses to place the tab at all.
    const ADDRESS_PREFIX = 'dsh-resource://ide/session/'
    const LEGACY_PREFIX = 'dsh-ide://session/'
    // Glob: the registry matches `patterns` with picomatch over the whole
    // address (any pattern containing ':' is compared to the full string).
    const ADDRESS_PATTERN = 'dsh-resource://ide/**'
    // `multiple: false` tab types are opened by kind on a synthetic page
    // address; the guide row in the Start panel uses exactly this route.
    const PAGE_ADDRESS = `sidebar://${TAB_KIND}`
    const GUIDE_ENTRY_ID = 'dsh-ide'

    /** Pause the explorer writes so typing does not spam the Host. */
    const STATE_WRITE_DELAY_MS = 400
    const MAX_RESTORED_TABS = 12
    const QUICK_OPEN_LIMIT = 3000

    let services = {}
    /** Sidebar tab ids whose IDE pane holds unsaved text; read by the close guard. */
    const dirtyTabs = new Set()
    const closePromptHandlers = new Map()

    const messageOf = (cause) => (cause instanceof Error ? cause.message : String(cause))

    const describeError = (cause) => {
      if (!cause || typeof cause !== 'object') return String(cause)
      if (cause.code === 'stale') return 'Файл изменился на диске — перечитайте его.'
      if (cause.code === 'read-only') return 'Рабочая папка открыта только для чтения.'
      if (cause.code === 'cancelled') return ''
      return messageOf(cause)
    }

    // ------------------------------------------------------------- addresses

    const encodeSegment = (value) => encodeURIComponent(value).replace(/%3A/gi, ':')
    const encodePath = (value) => value.split('/').map(encodeSegment).join('/')
    const normalPath = (value) =>
      String(value ?? '')
        .replace(/\\/g, '/')
        .replace(/^(?:\.\/)+/, '')
        .replace(/^\/+/, '')

    function fileAddress(sessionId, filePath) {
      const path = normalPath(filePath)
      const base = `${ADDRESS_PREFIX}${encodeSegment(sessionId)}`
      return path === '' ? base : `${base}/${encodePath(path)}`
    }

    function parseAddress(address) {
      if (typeof address !== 'string') return undefined
      // The workspace page (`sidebar://dsh-ide`) carries no session of its own;
      // the pane learns it from the slot props instead.
      if (address === PAGE_ADDRESS) return { sessionId: undefined, path: '' }
      const prefix =
        address.startsWith(ADDRESS_PREFIX) ? ADDRESS_PREFIX : address.startsWith(LEGACY_PREFIX) ? LEGACY_PREFIX : undefined
      if (prefix === undefined) return undefined
      const rest = address.slice(prefix.length).split('?')[0].split('#')[0]
      const segments = rest.split('/').filter((segment) => segment !== '')
      if (segments.length === 0) return undefined
      const decoded = segments.map((segment) => {
        try {
          return decodeURIComponent(segment)
        } catch {
          return segment
        }
      })
      const sessionId = decoded.shift()
      if (typeof sessionId !== 'string' || sessionId === '') return undefined
      return { sessionId, path: decoded.join('/') }
    }

    // Addresses of the built-in document preview, e.g.
    // `dsh-resource://file/session/<id>/src/main.ts`. The IDE button lives in
    // that tab's toolbar, so it must understand the same scheme.
    const FILE_ADDRESS_PREFIX = 'dsh-resource://file/session/'

    function parseFileAddress(address) {
      if (typeof address !== 'string' || !address.startsWith(FILE_ADDRESS_PREFIX)) return undefined
      const rest = address.slice(FILE_ADDRESS_PREFIX.length).split('?')[0].split('#')[0]
      const segments = rest.split('/').filter((segment) => segment !== '')
      if (segments.length === 0) return undefined
      const decoded = segments.map((segment) => {
        try {
          return decodeURIComponent(segment)
        } catch {
          return segment
        }
      })
      const sessionId = decoded.shift()
      if (typeof sessionId !== 'string' || sessionId === '') return undefined
      return { sessionId, path: decoded.join('/') }
    }

    // The IDE keeps one tab per session, so a requested file cannot travel in
    // the tab address: opening another address would stack another tab. Buttons
    // leave the request here and an already mounted pane consumes it.
    const pendingOpens = new Map()
    const openListeners = new Set()
    let openNonce = 0

    function requestOpen(sessionId, filePath, lineRange) {
      const path = normalPath(filePath)
      const bounds = chipBounds(lineRange)
      const request = { path, nonce: ++openNonce, lineRange: bounds === undefined ? undefined : { start: bounds.from, end: bounds.to } }
      pendingOpens.set(sessionId, request)
      for (const listener of openListeners) {
        try {
          listener(sessionId, request)
        } catch {
          /* a broken listener must not block the open */
        }
      }
      return request
    }

    function subscribeOpens(listener) {
      openListeners.add(listener)
      return () => {
        openListeners.delete(listener)
      }
    }

    function latestOpen(sessionId) {
      return pendingOpens.get(sessionId)
    }

    function baseName(filePath) {
      const parts = String(filePath ?? '').split('/')
      return parts[parts.length - 1] || 'Файл'
    }

    function dirName(filePath) {
      const parts = String(filePath ?? '').split('/')
      parts.pop()
      return parts.join('/')
    }

    // DSH's own mention shape: a file is `@path`, a directory keeps its trailing
    // slash (`@dir/`), and a path with spaces is quoted. The transcript parses
    // exactly these forms back into reference chips, so this is the token both
    // the drag source and the drop target hand to the composer.
    // Shortcut for "add this file (and the lines selected in it) to the chat".
    // It only fires while the IDE panel holds focus: the panel cannot claim a
    // global chord, DSH's own keymap owns those.
    const ADD_TO_CHAT_KEY = 'Ctrl+Alt+C'

    const MENTION_UNSAFE = /[\u0000-\u001f\u007f-\u009f"]/u
    function mentionText(filePath, directory) {
      const path = normalPath(filePath)
        .replace(/\\/g, '/')
        .replace(/\/+$/, '')
      if (path === '') return ''
      const target = directory === true ? `${path}/` : path
      if (MENTION_UNSAFE.test(target)) return ''
      return /\s/u.test(target) ? `@"${target}"` : `@${target}`
    }

    function mentionLabel(token) {
      const trimmed = String(token ?? '')
        .replace(/^@+/, '')
        .replace(/^"|"$/g, '')
        .replace(/\/+$/, '')
      return baseName(trimmed)
    }

    // A chip this plugin puts into the composer carries its line range inside
    // itself: the draft shows `state.js:13-19`, and the message keeps
    // `@state.js (строки 13-19)`. DSH's own `@` source serializes a reference to
    // the bare path, so the lines would be lost on send; a second source of our
    // own is the only hook the shell offers for a custom serialization. The
    // fragment stays out of the visible token:
    // `#L13-L19` rides after it and is stripped before the path is resolved.
    const CHIP_SOURCE = 'dsh-ide-file'
    const CHIP_RANGE = /#L(\d+)(?:-L?(\d+))?$/u

    function chipBounds(lineRange) {
      if (lineRange === undefined || lineRange === null) return undefined
      if (typeof lineRange.start !== 'number' || typeof lineRange.end !== 'number') return undefined
      const from = Math.max(1, Math.round(Math.min(lineRange.start, lineRange.end)))
      const to = Math.max(1, Math.round(Math.max(lineRange.start, lineRange.end)))
      return { from, to }
    }

    function chipRangeWord(range) {
      return range.from === range.to ? `строка ${range.from}` : `строки ${range.from}-${range.to}`
    }

    function chipRef(token, lineRange) {
      const mention = String(token ?? '')
      if (mention === '') return ''
      const range = chipBounds(lineRange)
      if (range === undefined) return mention
      return `${mention}#L${range.from}${range.from === range.to ? '' : `-L${range.to}`}`
    }

    function parseChipRef(ref) {
      const text = String(ref ?? '').trim()
      if (text === '') return undefined
      const match = CHIP_RANGE.exec(text)
      const mention = match === null ? text : text.slice(0, match.index)
      const path = mention
        .replace(/^@/u, '')
        .replace(/^"(.*)"$/u, '$1')
        .replace(/\/+$/u, '')
      if (path === '') return undefined
      const range =
        match === null ? undefined : chipBounds({ start: Number(match[1]), end: Number(match[2] ?? match[1]) })
      return { path, range }
    }

    // The text a chip turns into when the draft is serialized for sending. The
    // transcript still draws one chip for `@state.js`; the lines follow as
    // prose, which is the only shape the model can read (a path with a range
    // suffix would not resolve as a reference).
    function chipMessageText(ref) {
      const text = String(ref ?? '').trim()
      const parsed = parseChipRef(text)
      if (parsed === undefined || parsed.range === undefined) return text
      const mention = text.slice(0, text.search(CHIP_RANGE))
      return `${mention} (${chipRangeWord(parsed.range)})`
    }

    let chatSourceReady = false

    function chatSource() {
      return {
        trigger: '@',
        name: CHIP_SOURCE,
        // Chips are inserted, never typed: the `@` menu must not grow a second
        // file group, so the source answers no candidates.
        showGroupTitle: false,
        candidates: () => Promise.resolve([]),
        onPick: () => undefined,
        openReference: (session, reference) => openChipReference(session, reference),
        codec: {
          // The text the chip shows (and copies) is the mention itself; the
          // range fragment is ours alone and never leaves the ref.
          clipboardText: (ref) => {
            const text = String(ref ?? '')
            const at = text.search(CHIP_RANGE)
            return at < 0 ? text : text.slice(0, at)
          },
          serialize: (ref) => Promise.resolve(chipMessageText(ref)),
        },
      }
    }

    // Registered once, on the first chip: the `inputTriggers` service belongs
    // to the shell and may not exist yet when this plugin applies.
    function ensureChatSource() {
      if (chatSourceReady) return true
      const ctx = services.ctx
      if (ctx === undefined || ctx === null || typeof ctx.get !== 'function') return false
      let triggers
      try {
        triggers = ctx.get('inputTriggers')
      } catch (cause) {
        return false
      }
      if (triggers === undefined || triggers === null || typeof triggers.registerSource !== 'function') return false
      let dispose
      try {
        dispose = triggers.registerSource(chatSource())
      } catch (cause) {
        return false
      }
      if (typeof dispose !== 'function') return false
      chatSourceReady = true
      try {
        if (typeof ctx.effect === 'function') {
          // The source dies with the plugin, and the flag that guards its
          // registration dies with it: a reloaded plugin registers again.
          ctx.effect(
            () => () => {
              chatSourceReady = false
              try {
                dispose()
              } catch (cause) {
                /* already gone */
              }
            },
            'dsh-ide: @ reference source',
          )
        }
      } catch (cause) {
        /* the source stands for the life of the app either way */
      }
      return true
    }

    // A click on one of our chips reveals the file in the IDE pane and puts the
    // selection on the lines the chip names.
    function openChipReference(session, reference) {
      const parsed = parseChipRef(reference === undefined || reference === null ? '' : reference.ref)
      if (parsed === undefined) return false
      const sessionId = session === undefined || session === null ? undefined : session.sessionId
      if (typeof sessionId !== 'string' || sessionId === '') return false
      const sidebar = services.sidebarRight
      try {
        if (sidebar && typeof sidebar.openResourceIn === 'function') {
          sidebar.openResourceIn(sessionId, fileAddress(sessionId, parsed.path), { kind: TAB_KIND })
        } else if (sidebar && typeof sidebar.openResource === 'function') {
          sidebar.openResource(fileAddress(sessionId, parsed.path))
        }
      } catch (cause) {
        /* an unwired sidebar must not swallow the click */
      }
      const range = parsed.range === undefined ? undefined : { start: parsed.range.from, end: parsed.range.to }
      requestOpen(sessionId, parsed.path, range)
      return true
    }

    function sessionIdFromElement(element) {
      const host = element && typeof element.closest === 'function' ? element.closest('[data-sidebar-right-session]') : null
      const value = host && host.getAttribute ? host.getAttribute('data-sidebar-right-session') : null
      return typeof value === 'string' && value !== '' ? value : undefined
    }

    function tabOf(props) {
      if (props && typeof props.useTabInfo === 'function') {
        try {
          const info = props.useTabInfo()
          if (info && info.tab) return info.tab
        } catch {
          /* ignore */
        }
      }
      return (props && props.tab) || (props && props.slotProps && props.slotProps.tab)
    }

    // -------------------------------------------------------------------- api

    async function call(operation, body, signal) {
      const response = await fetch(`${API_BASE}${operation}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal,
      })
      if (!response.ok) throw new Error(`Запрос не выполнен (HTTP ${response.status})`)
      let payload
      try {
        payload = await response.json()
      } catch {
        throw new Error('Ответ сервера не является JSON')
      }
      if (payload && payload.error) {
        const error = new Error(payload.error.message || 'Операция не выполнена')
        error.code = payload.error.code
        throw error
      }
      return payload
    }

    // ----------------------------------------------------------------- monaco

    let monacoPromise

    function loadMonaco() {
      if (monacoPromise) return monacoPromise
      monacoPromise = new Promise((resolve, reject) => {
        const ready = window.monaco && window.monaco.editor
        if (ready) {
          resolve(window.monaco)
          return
        }
        const script = document.createElement('script')
        script.src = `${ASSET_BASE}/loader.js`
        script.async = true
        script.addEventListener('load', () => {
          const amd = window.require
          if (!amd || typeof amd.config !== 'function') {
            reject(new Error('Загрузчик Monaco не инициализировался'))
            return
          }
          amd.config({ paths: { vs: ASSET_BASE } })
          amd(['vs/editor/editor.main'], () => resolve(window.monaco), (error) => reject(error))
        })
        script.addEventListener('error', () => reject(new Error('Не удалось загрузить Monaco из /ide/vs')))
        document.head.appendChild(script)
      })
      monacoPromise.catch(() => {
        monacoPromise = undefined
      })
      return monacoPromise
    }

    function themeName() {
      try {
        const snapshot = services.theme && typeof services.theme.getTheme === 'function' ? services.theme.getTheme() : undefined
        const name = typeof snapshot === 'string' ? snapshot : snapshot && (snapshot.id || snapshot.name || snapshot.theme)
        if (typeof name === 'string') {
          if (/dark/i.test(name)) return 'dark'
          if (/light/i.test(name)) return 'light'
        }
        if (snapshot && typeof snapshot === 'object' && typeof snapshot.dark === 'boolean') return snapshot.dark ? 'dark' : 'light'
      } catch {
        /* fall through */
      }
      try {
        if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) return 'dark'
      } catch {
        /* ignore */
      }
      return 'light'
    }

    // ------------------------------------------------------------------ icons

    const FILE_BADGES = {
      js: 'JS', mjs: 'JS', cjs: 'JS', jsx: 'JSX', ts: 'TS', tsx: 'TSX', mts: 'TS', cts: 'TS',
      json: '{}', jsonc: '{}', md: 'MD', mdx: 'MD', txt: 'TXT', log: 'LOG', csv: 'CSV',
      css: '#', scss: '#', sass: '#', less: '#', html: '<>', htm: '<>', xml: 'XML', svg: 'SVG',
      vue: 'V', svelte: 'S', astro: 'A', py: 'PY', rb: 'RB', go: 'GO', rs: 'RS', java: 'J',
      kt: 'KT', kts: 'KT', c: 'C', h: 'H', cpp: 'C+', cc: 'C+', hpp: 'H', cs: 'C#', php: 'PHP',
      sh: 'SH', bash: 'SH', zsh: 'SH', ps1: 'PS1', bat: 'BAT', cmd: 'BAT', sql: 'SQL',
      yml: 'YML', yaml: 'YML', toml: 'TML', ini: 'INI', env: 'ENV', conf: 'CFG', config: 'CFG',
      png: 'IMG', jpg: 'IMG', jpeg: 'IMG', gif: 'IMG', webp: 'IMG', ico: 'IMG', bmp: 'IMG',
      pdf: 'PDF', lock: 'LCK', dockerfile: 'DKR', makefile: 'MK', gradle: 'GRD', tf: 'TF',
    }

    const BADGE_COLORS = {
      JS: '#e2c08d', JSX: '#61dafb', TS: '#4b9fd5', TSX: '#4b9fd5', '{}': '#cbcb41',
      MD: '#9db4c0', TXT: '#9a9a9a', LOG: '#9a9a9a', CSV: '#89e051', '#': '#4b9fd5',
      '<>': '#e37933', XML: '#e37933', SVG: '#a074c4', V: '#42b883', S: '#ff3e00', A: '#ff5d01',
      PY: '#4b8bbe', RB: '#cc342d', GO: '#4fc3f7', RS: '#dea584', J: '#e76f00', KT: '#a97bff',
      C: '#a8b9cc', H: '#8b9bb4', 'C+': '#a8b9cc', 'C#': '#68217a', PHP: '#8892bf',
      SH: '#89e051', PS1: '#89e051', BAT: '#89e051', SQL: '#e38c00', YML: '#cbcb41',
      TML: '#9c6b3f', INI: '#9c6b3f', ENV: '#cbcb41', CFG: '#cbcb41', IMG: '#4caf50',
      PDF: '#e05252', LCK: '#9a9a9a', DKR: '#4b9fd5', MK: '#89e051', GRD: '#4b8bbe', TF: '#a07bd8',
    }

    function badgeOf(name) {
      const lower = String(name ?? '').toLowerCase()
      const extension = lower.includes('.') ? lower.slice(lower.lastIndexOf('.') + 1) : lower
      const badge = FILE_BADGES[extension] || FILE_BADGES[lower]
      if (badge === undefined) return { label: '·', color: '#8a8a8a' }
      return { label: badge, color: BADGE_COLORS[badge] || '#8a8a8a' }
    }

    function FolderIcon({ open }) {
      return h(
        'svg',
        { className: 'dsh-ide-folder', width: 14, height: 14, viewBox: '0 0 16 16', 'aria-hidden': 'true' },
        h('path', {
          fill: open ? '#dcb67a' : '#c09553',
          d: 'M1.6 3.1h4.2l1.3 1.5h7.3c.5 0 .9.4.9.9v6.6c0 .5-.4.9-.9.9H1.6c-.5 0-.9-.4-.9-.9V4c0-.5.4-.9.9-.9z',
        }),
      )
    }

    // Small stroke icons for the explorer toolbar, so the buttons read like
    // the VS Code explorer instead of relying on font glyphs.
    function ToolbarIcon({ kind }) {
      const stroke = { fill: 'none', stroke: 'currentColor', 'stroke-width': 1.3, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }
      const paths =
        kind === 'file'
          ? [h('path', { key: 'a', d: 'M9.5 1.5H4.2a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h7.6a1 1 0 0 0 1-1V5z', ...stroke }), h('path', { key: 'b', d: 'M9.5 1.5V5h3.3', ...stroke }), h('path', { key: 'c', d: 'M8 7.4v4.2M5.9 9.5h4.2', ...stroke })]
          : kind === 'folder'
            ? [h('path', { key: 'a', d: 'M1.4 3.4h4.1l1.3 1.5h7.6c.4 0 .8.4.8.8v6.5c0 .4-.4.8-.8.8H1.4a.8.8 0 0 1-.8-.8V4.2c0-.4.4-.8.8-.8z', ...stroke }), h('path', { key: 'b', d: 'M8 6.8v4.2M5.9 8.9h4.2', ...stroke })]
            : kind === 'refresh'
              ? [h('path', { key: 'a', d: 'M13.2 8a5.2 5.2 0 1 1-1.6-3.7', ...stroke }), h('path', { key: 'b', d: 'M13.4 1.9v3.4h-3.4', ...stroke })]
              : [h('path', { key: 'a', d: 'M2 2.5h12M2 8h12M2 13.5h8', ...stroke })]
      return h('svg', { width: 14, height: 14, viewBox: '0 0 16 16', 'aria-hidden': 'true', className: 'dsh-ide-toolbar-icon' }, paths)
    }

    // ---------------------------------------------------------------- explorer

    /**
     * Smallest single region two versions of a text differ in: the common
     * prefix and suffix are the same in both, so one replacement describes the
     * change. Used for the change history, where storing whole files per edit
     * would be wasteful.
     */
    function changedRegion(before, after) {
      if (before === after) return undefined
      let start = 0
      const limit = Math.min(before.length, after.length)
      while (start < limit && before.charCodeAt(start) === after.charCodeAt(start)) start += 1
      let tail = 0
      while (
        tail < limit - start &&
        before.charCodeAt(before.length - 1 - tail) === after.charCodeAt(after.length - 1 - tail)
      ) {
        tail += 1
      }
      return {
        start,
        before: before.slice(start, before.length - tail),
        after: after.slice(start, after.length - tail),
      }
    }

    /**
     * Review of one assistant turn: the side-by-side comparison plus the list of
     * files that turn touched. Each file carries the same two decisions Cursor
     * offers (keep / undo), and the header applies them to the whole turn.
     *
     * A component rather than inline JSX: the editor surface of `IdeBody` is
     * already the largest expression in this file.
     */
    function DiffReview({ view, work, onAccept, onRevert, onAcceptAll, onRevertAll, onOpenFile, onClose, containerRef }) {
      const files = Array.isArray(view.files) ? view.files : []
      const stateOf = (file) => work[`${view.seq}:${file.index}`]
      const decided = (file) => {
        const current = stateOf(file)
        return current !== undefined && (current.phase === 'accepted' || current.phase === 'reverted')
      }
      const busy = files.some((file) => stateOf(file)?.phase === 'saving')
      const totalAdded = files.reduce((sum, file) => sum + (Number(file.added) || 0), 0)
      const totalDeleted = files.reduce((sum, file) => sum + (Number(file.deleted) || 0), 0)
      const phaseLabel = (phase) =>
        phase === 'accepted' ? 'принято' : phase === 'reverted' ? 'отменено' : phase === 'saving' ? 'откатываю…' : 'не вышло'
      return h(
        'div',
        { className: 'dsh-ide-diffview', 'data-phase': view.phase },
        h(
          'div',
          { className: 'dsh-ide-diffview-head' },
          h('span', { className: 'dsh-ide-diffview-title' }, view.display || view.path),
          h(
            'span',
            { className: 'dsh-ide-diffview-sub' },
            `${files.length === 1 ? '1 файл' : `файлов: ${files.length}`} · +${totalAdded} −${totalDeleted} · начало и конец хода`,
          ),
          h('span', { className: 'dsh-ide-diffview-spacer' }),
          view.phase === 'pending' ? h('span', { className: 'dsh-ide-diffview-note' }, 'Читаю снимок…') : null,
          view.phase === 'failed' ? h('span', { className: 'dsh-ide-diffview-error' }, view.error) : null,
          h(
            'button',
            {
              type: 'button',
              className: 'dsh-ide-diffview-action',
              disabled: busy,
              title: 'Оставить правки всех файлов хода',
              onClick: () => onAcceptAll(),
            },
            'Принять все',
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'dsh-ide-diffview-action dsh-ide-diffview-danger',
              disabled: busy,
              title: 'Вернуть все файлы хода к его началу',
              onClick: () => onRevertAll(),
            },
            'Отменить все',
          ),
          h('button', { type: 'button', className: 'dsh-ide-diffview-action', onClick: () => onClose() }, 'Закрыть'),
        ),
        h('div', { className: 'dsh-ide-diffview-body', ref: containerRef }),
        files.length === 0
          ? null
          : h(
              'div',
              { className: 'dsh-ide-diffview-files' },
              h('div', { className: 'dsh-ide-diffview-files-head' }, files.length === 1 ? '1 файл' : `Файлов: ${files.length}`),
              files.map((file) => {
                const display = String(file.display || file.path)
                const state = stateOf(file)
                return h(
                  'div',
                  { key: String(file.index), className: 'dsh-ide-diffview-file' },
                  h('span', { className: 'dsh-ide-change-name' }, baseName(display)),
                  dirName(display) === '' ? null : h('span', { className: 'dsh-ide-change-dir' }, dirName(display)),
                  h('span', { className: 'dsh-ide-change-added' }, `+${file.added}`),
                  h('span', { className: 'dsh-ide-change-removed' }, `−${file.deleted}`),
                  state === undefined
                    ? null
                    : h('span', { className: `dsh-ide-assist-work dsh-ide-assist-work-${state.phase}` }, phaseLabel(state.phase)),
                  h('span', { className: 'dsh-ide-diffview-spacer' }),
                  h(
                    'button',
                    { type: 'button', className: 'dsh-ide-diffview-action', onClick: () => onOpenFile(file.path) },
                    'Открыть',
                  ),
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'dsh-ide-diffview-action',
                      disabled: decided(file) || busy,
                      title: 'Оставить правки этого файла как есть',
                      onClick: () => onAccept(file),
                    },
                    'Принять',
                  ),
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'dsh-ide-diffview-action dsh-ide-diffview-danger',
                      disabled: decided(file) || busy,
                      title: 'Вернуть этот файл к состоянию до хода',
                      onClick: () => onRevert(file),
                    },
                    'Отменить',
                  ),
                )
              }),
            ),
      )
    }

    /**
     * Workspace explorer. Folders load on first expand; the filter box switches
     * the view to a flat, fuzzy list served by the `files` route so a match in
     * a collapsed folder is still findable.
     */
    function Explorer(props) {
      const sessionId = props.sessionId
      const hidden = props.hidden === true
      const activePath = typeof props.activePath === 'string' ? props.activePath : ''
      const onOpenFile = props.onOpenFile
      const onToggleHidden = props.onToggleHidden
      const onInsertReference = props.onInsertReference
      const searchOpen = props.searchOpen === true
      const onCloseSearch = props.onCloseSearch
      const changesOpen = props.changesOpen === true
      const changes = Array.isArray(props.changes) ? props.changes : []
      const onCloseChanges = props.onCloseChanges
      const onOpenChange = props.onOpenChange
      const onRevertChange = props.onRevertChange
      // Host-side checkpoints: read-only view of what the assistant changed,
      // fetched on demand because the diff needs a snapshot read per file.
      const assistant = props.assistant === undefined ? { phase: 'idle', available: true, turns: [], error: '' } : props.assistant
      const assistantTurns = Array.isArray(assistant.turns) ? assistant.turns : []
      // The menu bar asks for a refresh without owning the tree's internal state.
      const reloadSignal = props.reloadSignal === undefined ? 0 : props.reloadSignal

      const [expanded, setExpanded] = React.useState(() => new Set())
      const [cache, setCache] = React.useState(() => new Map())
      const [error, setError] = React.useState('')
      const [pending, setPending] = React.useState('')
      const [query, setQuery] = React.useState('')
      const [flat, setFlat] = React.useState(undefined)
      const [flatError, setFlatError] = React.useState('')
      const [reloadKey, setReloadKey] = React.useState(0)
      const [rowMenu, setRowMenu] = React.useState(undefined)
      const [moreMenu, setMoreMenu] = React.useState(undefined)
      // Inline "new file / new folder" row, the way the VS Code explorer does it:
      // the name is typed straight into the tree instead of a modal dialog.
      const [draft, setDraft] = React.useState(undefined)
      const [draftError, setDraftError] = React.useState('')
      /** Per-file decision in the assistant list: `{phase, error}` keyed by `seq:index`.
       * It lives in `IdeBody`, because the same decision has to be visible both
       * in this list and in the toolbar of the side-by-side comparison. */
      const assistantWork = props.assistantWork === undefined ? {} : props.assistantWork
      const onOpenDiff = props.onOpenDiff
      const onAcceptAssistant = props.onAcceptAssistant
      const onRevertAssistant = props.onRevertAssistant
      const [rootOpen, setRootOpen] = React.useState(true)
      // File content search: the panel owns its query and results, the explorer
      // only decides whether to show it instead of the tree.
      const [searchQuery, setSearchQuery] = React.useState('')
      const [searchResult, setSearchResult] = React.useState({ phase: 'idle', matches: [], truncated: false, error: '' })
      const searchInputRef = React.useRef(undefined)
      const expandedRef = React.useRef(new Set())
      const selected = props.selected
      const selectRow = (path, type) => {
        if (typeof props.onSelect === 'function') props.onSelect(path, type)
      }
      React.useEffect(() => {
        expandedRef.current = expanded
      }, [expanded])
      // The scan happens on the Host and is local: it works without the Tab
      // opt-in and never reaches a model. A new keystroke aborts the old walk so
      // a slow folder cannot answer a query the user already replaced.
      React.useEffect(() => {
        if (!searchOpen) return undefined
        const needle = searchQuery.trim()
        if (needle === '' || typeof sessionId !== 'string' || sessionId === '') {
          setSearchResult({ phase: 'idle', matches: [], truncated: false, error: '' })
          return undefined
        }
        const controller = new AbortController()
        const timer = window.setTimeout(() => {
          setSearchResult((previous) => ({ ...previous, phase: 'pending', error: '' }))
          void call('searchText', { sessionId, query: needle, limit: 50 }, controller.signal)
            .then((payload) => {
              if (controller.signal.aborted) return
              const matches = payload !== null && Array.isArray(payload.matches) ? payload.matches : []
              setSearchResult({ phase: 'ready', matches, truncated: payload?.truncated === true, error: '' })
            })
            .catch((cause) => {
              if (controller.signal.aborted) return
              if (cause !== null && typeof cause === 'object' && cause.code === 'cancelled') return
              setSearchResult({ phase: 'failed', matches: [], truncated: false, error: describeError(cause) })
            })
        }, 250)
        return () => {
          window.clearTimeout(timer)
          controller.abort()
        }
      }, [searchOpen, searchQuery, sessionId])
      React.useEffect(() => {
        if (!searchOpen) return undefined
        const timer = window.setTimeout(() => searchInputRef.current?.focus(), 0)
        return () => window.clearTimeout(timer)
      }, [searchOpen])
      // New files and folders land in the selected folder, or next to the
      // selected file, exactly like the VS Code explorer.
      const targetDirectory = () => {
        if (selected === undefined || typeof selected.path !== 'string') return ''
        return selected.type === 'directory' ? selected.path : dirName(selected.path)
      }
      const createRequest = props.createRequest
      const createNonce = createRequest === undefined ? 0 : createRequest.nonce

      const workspaceRoot = (() => {
        const root = cache.get('')
        return root !== undefined && typeof root.workspaceRoot === 'string' ? root.workspaceRoot : ''
      })()

      const copy = (value) => {
        if (typeof props.onCopy === 'function') props.onCopy(value)
      }

      const menuPoint = (event) => {
        const width = typeof window === 'undefined' ? 1024 : window.innerWidth
        const height = typeof window === 'undefined' ? 768 : window.innerHeight
        return {
          x: Math.max(4, Math.min(event.clientX, width - 240)),
          y: Math.max(4, Math.min(event.clientY, height - 280)),
        }
      }

      const rowMenuItems = (target) => {
        if (target === undefined) return []
        const items = []
        if (target.type === 'directory') {
          items.push({ id: 'toggle', label: expanded.has(target.path) ? 'Свернуть' : 'Развернуть', run: () => toggle(target.path, cache.has(target.path)) })
          items.push({ id: 'new-file', label: 'Новый файл…', run: () => props.onNewFile(target.path) })
          items.push({ id: 'new-folder', label: 'Новая папка…', run: () => props.onNewFolder(target.path) })
          if (typeof props.onQuoteFile === 'function') {
            items.push({ id: 'quote', label: 'Добавить в чат', key: ADD_TO_CHAT_KEY, run: () => props.onQuoteFile(target.path, true) })
          }
          items.push({ separator: true })
        } else {
          items.push({ id: 'open', label: 'Открыть', run: () => onOpenFile(target.path) })
          if (typeof props.onQuoteFile === 'function') {
            items.push({ id: 'quote', label: 'Добавить в чат', key: ADD_TO_CHAT_KEY, run: () => props.onQuoteFile(target.path, false) })
          }
          if (typeof props.onQuoteLines === 'function') {
            items.push({ id: 'quote-lines', label: 'Добавить строки в чат…', run: () => props.onQuoteLines(target.path) })
          }
          items.push({ separator: true })
        }
        items.push({
          id: 'copy-path',
          label: 'Копировать путь',
          run: () => copy(workspaceRoot === '' ? target.path : `${workspaceRoot.replace(/[\\/]+$/, '')}/${target.path}`),
        })
        items.push({ id: 'copy-relative', label: 'Копировать относительный путь', run: () => copy(target.path) })
        items.push({ separator: true })
        items.push({ id: 'rename', label: 'Переименовать…', key: 'F2', run: () => props.onRename(target.path, target.name, target.type) })
        items.push({ id: 'delete', label: 'Удалить', key: 'Delete', run: () => props.onDelete(target.path, target.name, target.type) })
        items.push({ separator: true })
        items.push({ id: 'terminal', label: 'Открыть во встроенном терминале', disabled: true, hint: 'Встроенного терминала в IDE нет: плагин не получает PTY.' })
        items.push({ id: 'reveal', label: 'Показать в проводнике ОС', disabled: true, hint: 'Плагин не имеет доступа к оболочке рабочей машины.' })
        return items
      }

      const moreMenuItems = [
        { id: 'new-file', label: 'Новый файл…', run: () => props.onNewFile('') },
        { id: 'new-folder', label: 'Новая папка…', run: () => props.onNewFolder('') },
        { separator: true },
        { id: 'refresh', label: 'Обновить дерево', run: () => setReloadKey((value) => value + 1) },
        { id: 'collapse', label: 'Свернуть все папки', run: () => setExpanded(new Set()) },
        { id: 'hidden', label: hidden ? 'Скрыть скрытые файлы' : 'Показать скрытые файлы', run: () => onToggleHidden(!hidden) },
        workspaceRoot === '' ? null : { separator: true },
        workspaceRoot === '' ? null : { id: 'copy-root', label: 'Копировать путь рабочей папки', run: () => copy(workspaceRoot) },
      ].filter(Boolean)

      const load = React.useCallback(
        async (relativePath) => {
          if (typeof sessionId !== 'string' || sessionId === '') return
          setPending(relativePath)
          try {
            const listing = await call('tree', { sessionId, path: relativePath, hidden })
            setCache((previous) => {
              const next = new Map(previous)
              next.set(relativePath, listing)
              return next
            })
            setError('')
          } catch (cause) {
            setError(describeError(cause))
          } finally {
            setPending('')
          }
        },
        [sessionId, hidden],
      )

      React.useEffect(() => {
        setExpanded(new Set())
        expandedRef.current = new Set()
        setCache(new Map())
        setFlat(undefined)
        setFlatError('')
        if (typeof sessionId === 'string' && sessionId !== '') void load('')
      }, [sessionId, hidden, load])

      // Refreshing keeps the expanded folders open, the way VS Code does: only
      // the listings are reloaded, not the tree layout.
      const firstRefresh = React.useRef(true)
      React.useEffect(() => {
        if (firstRefresh.current) {
          firstRefresh.current = false
          return
        }
        if (typeof sessionId !== 'string' || sessionId === '') return
        void load('')
        for (const directory of expandedRef.current) void load(directory)
      }, [reloadKey, reloadSignal])

      const needle = query.trim().toLowerCase()

      // A create request from the menu bar or the explorer toolbar opens the
      // inline row in the target folder, expanding (and loading) it first.
      React.useEffect(() => {
        if (createRequest === undefined) return
        const directory = createRequest.directory === '' ? '' : normalPath(createRequest.directory)
        setDraft({ type: createRequest.type, directory, value: '' })
        setDraftError('')
        setQuery('')
        setRootOpen(true)
        if (directory !== '') {
          setExpanded((previous) => {
            const next = new Set(previous)
            next.add(directory)
            return next
          })
          void load(directory)
        }
      }, [createNonce])

      React.useEffect(() => {
        if (needle === '' || flat !== undefined || typeof sessionId !== 'string' || sessionId === '') return
        let cancelled = false
        call('files', { sessionId, hidden, limit: QUICK_OPEN_LIMIT })
          .then((payload) => {
            if (!cancelled) setFlat(Array.isArray(payload.files) ? payload.files : [])
          })
          .catch((cause) => {
            if (!cancelled) setFlatError(describeError(cause))
          })
        return () => {
          cancelled = true
        }
      }, [needle, flat, sessionId, hidden])

      const toggle = (path, isLoaded) => {
        setExpanded((previous) => {
          const next = new Set(previous)
          if (next.has(path)) next.delete(path)
          else next.add(path)
          return next
        })
        if (!isLoaded) void load(path)
      }

      const matches = React.useMemo(() => {
        if (needle === '' || flat === undefined) return []
        return flat
          .filter((file) => file.path.toLowerCase().includes(needle) || file.name.toLowerCase().includes(needle))
          .slice(0, 200)
      }, [needle, flat])

      const rows = []

      // The inline "new file / new folder" row. Enter accepts, Escape cancels,
      // and losing focus cancels like the VS Code explorer does.
      const draftRow = (directory, depth) => {
        if (draft === undefined) return null
        const submit = async () => {
          const name = draft.value.trim()
          if (name === '') {
            setDraft(undefined)
            return
          }
          const base = directory === '' ? '' : `${directory}/`
          const error = await props.onCreate(draft.type, `${base}${name}`)
          if (typeof error === 'string' && error !== '') {
            setDraftError(error)
            return
          }
          setDraft(undefined)
          setDraftError('')
        }
        return h(
          'div',
          { key: `draft:${directory}`, className: 'dsh-ide-draft', style: { paddingLeft: `${6 + depth * 12}px` } },
          ...Array.from({ length: depth }, (_unused, index) => h('span', { key: `g${index}`, className: 'dsh-ide-guide' })),
          h('span', { className: 'dsh-ide-caret' }),
          draft.type === 'directory'
            ? h(FolderIcon, { open: false })
            : h(ToolbarIcon, { kind: 'file' }),
          h('input', {
            className: 'dsh-ide-draft-input',
            autoFocus: true,
            value: draft.value,
            placeholder: draft.type === 'directory' ? 'Имя папки' : 'Имя файла',
            'aria-label': draft.type === 'directory' ? 'Имя новой папки' : 'Имя нового файла',
            onChange: (event) => setDraft({ ...draft, value: event.currentTarget.value }),
            onKeyDown: (event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                void submit()
              } else if (event.key === 'Escape') {
                event.preventDefault()
                setDraft(undefined)
                setDraftError('')
              }
            },
            onBlur: () => {
              setDraft(undefined)
              setDraftError('')
            },
          }),
        )
      }

      if (needle !== '') {
        if (flatError !== '') rows.push(h('div', { key: 'flat-error', className: 'dsh-ide-tree-error' }, flatError))
        else if (flat === undefined) rows.push(h('div', { key: 'flat-loading', className: 'dsh-ide-tree-empty' }, 'Ищу файлы…'))
        else if (matches.length === 0) rows.push(h('div', { key: 'flat-empty', className: 'dsh-ide-tree-empty' }, 'Ничего не найдено'))
        else
          for (const file of matches) {
            rows.push(
              h(
                'button',
                {
                  key: `m:${file.path}`,
                  type: 'button',
                  className: `dsh-ide-row${file.path === activePath ? ' dsh-ide-row-active' : ''}${selected !== undefined && selected.path === file.path ? ' dsh-ide-row-selected' : ''}`,
                  style: { paddingLeft: '8px' },
                  title: file.path,
                  onClick: () => {
                    selectRow(file.path, file.type === 'directory' ? 'directory' : 'file')
                    onOpenFile(file.path)
                  },
                  draggable: true,
                  onDragStart: (event) => {
                    const token = mentionText(file.path, file.type === 'directory')
                    if (token === '') return
                    // Both payloads carry the mention token, so a drop that lands
                    // on the chat composer itself also becomes a reference.
                    event.dataTransfer.setData('application/x-dsh-ide-file', token)
                    event.dataTransfer.setData('text/plain', token)
                    event.dataTransfer.effectAllowed = 'copy'
                  },
                  onContextMenu: (event) => {
                    event.preventDefault()
                    selectRow(file.path, file.type === 'directory' ? 'directory' : 'file')
                    setRowMenu({ ...menuPoint(event), path: file.path, name: file.name, type: file.type === 'directory' ? 'directory' : 'file' })
                  },
                },
                h(FileBadge, { name: file.name }),
                h('span', { className: 'dsh-ide-row-dim' }, dirName(file.path) === '' ? '' : `${dirName(file.path)}/`),
                h('span', { className: 'dsh-ide-row-name' }, file.name),
              ),
            )
          }
      } else {
        const walk = (directory, depth) => {
          const listing = cache.get(directory)
          if (listing === undefined) {
            if (depth === 0) rows.push(h('div', { key: 'loading', className: 'dsh-ide-tree-empty' }, pending === '' ? 'Загрузка…' : 'Читаю папку…'))
            return
          }
          if (listing.entries.length === 0) {
            if (draft === undefined || draft.directory !== directory) {
              rows.push(h('div', { key: `empty:${directory}`, className: 'dsh-ide-tree-empty', style: { paddingLeft: `${8 + depth * 12}px` } }, 'пусто'))
              return
            }
          }
          for (const entry of listing.entries) {
            const path = directory === '' ? entry.name : `${directory}/${entry.name}`
            const isDirectory = entry.type === 'directory'
            const open = isDirectory && expanded.has(path)
            const selectedClass = selected !== undefined && selected.path === path ? ' dsh-ide-row-selected' : ''
            rows.push(
              h(
                'button',
                {
                  key: path,
                  type: 'button',
                  className: `dsh-ide-row${path === activePath ? ' dsh-ide-row-active' : ''}${selectedClass}`,
                  style: { paddingLeft: `${6 + depth * 12}px` },
                  title: path,
                  onClick: () => {
                    selectRow(path, isDirectory ? 'directory' : 'file')
                    if (isDirectory) toggle(path, cache.has(path))
                    else onOpenFile(path)
                  },
                  draggable: true,
                  onDragStart: (event) => {
                    const token = mentionText(path, isDirectory)
                    if (token === '') return
                    event.dataTransfer.setData('application/x-dsh-ide-file', token)
                    event.dataTransfer.setData('text/plain', token)
                    event.dataTransfer.effectAllowed = 'copy'
                  },
                  onContextMenu: (event) => {
                    event.preventDefault()
                    selectRow(path, isDirectory ? 'directory' : 'file')
                    setRowMenu({ ...menuPoint(event), path, name: entry.name, type: isDirectory ? 'directory' : 'file' })
                  },
                },
                ...Array.from({ length: depth }, (_unused, index) => h('span', { key: `g${index}`, className: 'dsh-ide-guide' })),
                isDirectory
                  ? h('span', { className: `dsh-ide-caret${open ? ' dsh-ide-caret-open' : ''}` }, '▸')
                  : h('span', { className: 'dsh-ide-caret' }),
                isDirectory ? h(FolderIcon, { open }) : h(FileBadge, { name: entry.name }),
                h('span', { className: 'dsh-ide-row-name' }, entry.name),
                entry.type === 'symlink' ? h('span', { className: 'dsh-ide-row-tag', title: 'Символическая ссылка' }, '↗') : null,
              ),
            )
            if (open) walk(path, depth + 1)
          }
          if (listing.truncated) {
            rows.push(h('div', { key: `more:${directory}`, className: 'dsh-ide-tree-empty', style: { paddingLeft: `${10 + depth * 12}px` } }, 'Показаны первые 400 записей'))
          }
          if (draft !== undefined && draft.directory === directory) {
            rows.push(draftRow(directory, depth))
            if (draftError !== '') rows.push(h('div', { key: `draft-error:${directory}`, className: 'dsh-ide-tree-error', style: { paddingLeft: `${10 + depth * 12}px` } }, draftError))
          }
        }

        const rootListing = cache.get('')
        const rootAbsolute = rootListing === undefined || rootListing.workspaceRoot === undefined ? '' : String(rootListing.workspaceRoot)
        const rootParts = rootAbsolute.replace(/[\\/]+$/, '').split(/[\\/]/)
        const rootName = rootParts.length === 0 ? '' : rootParts[rootParts.length - 1]
        rows.push(
          h(
            'button',
            {
              key: 'root',
              type: 'button',
              className: `dsh-ide-row dsh-ide-row-root${rootOpen ? '' : ' dsh-ide-row-collapsed'}${selected !== undefined && selected.path === '' ? ' dsh-ide-row-selected' : ''}`,
              style: { paddingLeft: '6px' },
              title: rootListing === undefined ? '' : String(rootListing.workspaceRoot),
              onClick: () => {
                selectRow('', 'directory')
                setRootOpen((previous) => !previous)
              },
              onContextMenu: (event) => {
                event.preventDefault()
                selectRow('', 'directory')
                setRowMenu({ ...menuPoint(event), path: '', name: rootName, type: 'directory' })
              },
            },
            h('span', { className: `dsh-ide-caret${rootOpen ? ' dsh-ide-caret-open' : ''}` }, '▸'),
            h(FolderIcon, { open: rootOpen }),
            h('span', { className: 'dsh-ide-row-name dsh-ide-row-root-name' }, rootName === '' ? 'Рабочая папка' : rootName),
          ),
        )
        if (rootOpen) walk('', 1)
        if (rootListing === undefined) rows.push(h('div', { key: 'loading', className: 'dsh-ide-tree-empty', style: { paddingLeft: '20px' } }, pending === '' ? 'Загрузка…' : 'Читаю папку…'))
        if (error !== '') rows.unshift(h('div', { key: 'tree-error', className: 'dsh-ide-tree-error' }, error))
      }

      if (changesOpen) {
        // The comparison is read per file, on demand: the recorder keeps the
        // snapshots, and pulling every file of every turn up front would be a
        // lot of reads for a list the user may not open at all.
        const assistantKey = (turn, file) => `${turn.seq}:${file.index}`
        const assistantRows = []
        if (assistant.phase === 'pending') {
          assistantRows.push(h('div', { key: 'assistant-pending', className: 'dsh-ide-tree-empty' }, 'Читаю ходы…'))
        } else if (assistant.phase === 'failed') {
          assistantRows.push(h('div', { key: 'assistant-error', className: 'dsh-ide-tree-error' }, assistant.error))
        } else if (assistant.available === false) {
          assistantRows.push(h('div', { key: 'assistant-off', className: 'dsh-ide-tree-empty' }, 'Этот Host не ведёт контрольные точки ходов'))
        } else if (assistantTurns.length === 0) {
          assistantRows.push(h('div', { key: 'assistant-empty', className: 'dsh-ide-tree-empty' }, 'Ассистент ещё не менял файлы в этой сессии'))
        } else {
          for (const turn of assistantTurns) {
            const files = Array.isArray(turn.files) ? turn.files : []
            assistantRows.push(
              h(
                'div',
                {
                  key: `turn-${turn.seq}`,
                  className: turn.stale === true ? 'dsh-ide-assist-turn dsh-ide-assist-turn-stale' : 'dsh-ide-assist-turn',
                  role: 'listitem',
                },
                h(
                  'div',
                  { className: 'dsh-ide-assist-turn-head' },
                  h('span', { className: 'dsh-ide-assist-turn-title' }, turn.turn === 0 ? 'Ход' : `Ход ${turn.turn}`),
                  h(
                    'span',
                    { className: 'dsh-ide-assist-turn-count' },
                    turn.stale === true ? 'снимок недоступен' : `+${turn.added} −${turn.deleted} · файлов: ${turn.total}`,
                  ),
                ),
                // A stale turn kept its place in the list on purpose: dropping it
                // would erase history the user already saw, so it is shown greyed
                // out without actions instead of disappearing.
                turn.stale === true
                  ? h(
                      'div',
                      { className: 'dsh-ide-assist-note' },
                      'Снимок хода больше недоступен — сравнение и откат открыть нельзя.',
                    )
                  : files.map((file) => {
                  const key = assistantKey(turn, file)
                  const display = String(file.display || file.path)
                  const work = assistantWork[key]
                  const decided = work !== undefined && (work.phase === 'accepted' || work.phase === 'reverted')
                  return h(
                    'div',
                    { key, className: 'dsh-ide-assist-file' },
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'dsh-ide-assist-file-head',
                        title: `${display} — сравнение начала и конца хода`,
                        onClick: () => {
                          if (typeof onOpenDiff === 'function') onOpenDiff(turn, file)
                        },
                      },
                      h('span', { className: 'dsh-ide-change-name' }, baseName(display)),
                      dirName(display) === '' ? null : h('span', { className: 'dsh-ide-change-dir' }, dirName(display)),
                      file.binary === true ? h('span', { className: 'dsh-ide-assist-flag' }, 'bin') : null,
                      file.oversized === true ? h('span', { className: 'dsh-ide-assist-flag' }, 'большой') : null,
                    ),
                    h(
                      'div',
                      { className: 'dsh-ide-change-meta' },
                      h('span', { className: 'dsh-ide-change-added' }, `+${file.added}`),
                      h('span', { className: 'dsh-ide-change-removed' }, `−${file.deleted}`),
                      typeof onOpenFile === 'function'
                        ? h(
                            'button',
                            {
                              type: 'button',
                              className: 'dsh-ide-change-revert',
                              title: 'Открыть файл в редакторе',
                              onClick: () => onOpenFile(file.path),
                            },
                            'Открыть',
                          )
                        : null,
                      h(
                        'button',
                        {
                          type: 'button',
                          className: 'dsh-ide-assist-accept',
                          disabled: decided || work?.phase === 'saving',
                          title: 'Оставить правки ассистента как есть',
                          onClick: () => {
                            if (typeof onAcceptAssistant === 'function') onAcceptAssistant(turn, file)
                          },
                        },
                        'Принять правки',
                      ),
                      h(
                        'button',
                        {
                          type: 'button',
                          className: 'dsh-ide-assist-revert',
                          disabled: decided || work?.phase === 'saving',
                          title: 'Вернуть файл к состоянию до хода',
                          onClick: () => {
                            if (typeof onRevertAssistant === 'function') onRevertAssistant(turn, file)
                          },
                        },
                        'Отменить правки',
                      ),
                      work === undefined
                        ? null
                        : h(
                            'span',
                            { className: `dsh-ide-assist-work dsh-ide-assist-work-${work.phase}` },
                            work.phase === 'accepted'
                              ? 'принято'
                              : work.phase === 'reverted'
                                ? 'отменено'
                                : work.phase === 'saving'
                                  ? 'откатываю…'
                                  : 'не вышло',
                          ),
                    ),
                    work !== undefined && work.phase === 'failed' && work.error !== ''
                      ? h('div', { className: 'dsh-ide-assist-error' }, work.error)
                      : null,
                  )
                }),
              ),
            )
          }
        }
        const rows =
          changes.length === 0
            ? [h('div', { key: 'changes-empty', className: 'dsh-ide-tree-empty' }, 'Принятых правок в этой сессии пока нет')]
            : changes.map((change) => {
                const added = change.after === '' ? 0 : change.after.split('\n').length
                const removed = change.before === '' ? 0 : change.before.split('\n').length
                const status = change.reverted === true ? 'возвращено' : change.saved === true ? 'сохранено' : 'в буфере'
                return h(
                  'div',
                  { key: String(change.id), className: 'dsh-ide-change-row', role: 'listitem' },
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'dsh-ide-change-head',
                      title: `${change.path} · ${status}`,
                      onClick: () => {
                        if (typeof onOpenChange === 'function') onOpenChange(change)
                      },
                    },
                    h('span', { className: 'dsh-ide-change-name' }, baseName(change.path)),
                    dirName(change.path) === '' ? null : h('span', { className: 'dsh-ide-change-dir' }, dirName(change.path)),
                  ),
                  h(
                    'div',
                    { className: 'dsh-ide-change-meta' },
                    h('span', { className: 'dsh-ide-change-added' }, `+${added}`),
                    h('span', { className: 'dsh-ide-change-removed' }, `−${removed}`),
                    h('span', { className: `dsh-ide-change-status dsh-ide-change-${status === 'в буфере' ? 'buffer' : status === 'сохранено' ? 'saved' : 'reverted'}` }, status),
                    change.error === undefined ? null : h('span', { className: 'dsh-ide-change-error' }, change.error),
                    change.reverted === true
                      ? null
                      : h(
                          'button',
                          {
                            type: 'button',
                            className: 'dsh-ide-change-revert',
                            title: 'Вернуть текст до правки',
                            onClick: () => {
                              if (typeof onRevertChange === 'function') onRevertChange(change)
                            },
                          },
                          'Вернуть',
                        ),
                  ),
                )
              })
        return h(
          'div',
          { className: 'dsh-ide-explorer' },
          h(
            'div',
            { className: 'dsh-ide-explorer-head' },
            h('span', { className: 'dsh-ide-explorer-title' }, 'ИЗМЕНЕНИЯ'),
            h(
              'span',
              { className: 'dsh-ide-explorer-actions' },
              h(
                'button',
                {
                  type: 'button',
                  className: 'dsh-ide-icon-button',
                  title: 'Закрыть список изменений',
                  'aria-label': 'Закрыть список изменений',
                  onClick: () => {
                    if (typeof onCloseChanges === 'function') onCloseChanges()
                  },
                },
                '✕',
              ),
            ),
          ),
          h('div', { className: 'dsh-ide-change-section' }, 'Правки ассистента'),
          h('div', { className: 'dsh-ide-change-hint' }, 'Снимок начала и конца хода — не текущий диск'),
          h('div', { className: 'dsh-ide-tree dsh-ide-assist-list', role: 'list' }, assistantRows),
          h('div', { className: 'dsh-ide-change-section' }, 'Мои правки'),
          h('div', { className: 'dsh-ide-change-hint' }, 'Правки этой сессии: принято в буфер, сохранено, возвращено'),
          h('div', { className: 'dsh-ide-tree dsh-ide-change-list', role: 'list' }, rows),
        )
      }

      if (searchOpen) {
        const statusText =
          searchResult.phase === 'failed'
            ? searchResult.error
            : searchResult.phase === 'pending' && searchResult.matches.length === 0
              ? 'Ищу…'
              : searchResult.phase === 'ready'
                ? `${searchResult.matches.length}${searchResult.truncated ? '+' : ''} совпадений${
                    searchResult.truncated ? ' · упёрлись в лимит, покажу не всё' : ''
                  }`
                : 'Введите текст — поиск идёт по рабочей папке'
        // Group by file: a flat list of `path:line` rows reads as one grey wall,
        // and there is no visible boundary between two files with the same name.
        const groups = []
        const groupOf = new Map()
        for (const match of searchResult.matches) {
          let group = groupOf.get(match.path)
          if (group === undefined) {
            group = { path: match.path, hits: [] }
            groupOf.set(match.path, group)
            groups.push(group)
          }
          group.hits.push(match)
        }
        const previewParts = (match) => {
          const preview = String(match.preview ?? '')
          const needle = typeof match.match === 'string' ? match.match : ''
          if (needle === '') return [preview]
          const at = preview.toLowerCase().indexOf(needle.toLowerCase())
          if (at < 0) return [preview]
          return [
            preview.slice(0, at),
            h('mark', { key: 'mark', className: 'dsh-ide-search-mark' }, preview.slice(at, at + needle.length)),
            preview.slice(at + needle.length),
          ]
        }
        const rows =
          searchResult.phase === 'failed'
            ? [h('div', { key: 'search-error', className: 'dsh-ide-tree-error' }, searchResult.error)]
            : searchResult.phase === 'ready' && searchResult.matches.length === 0
              ? [h('div', { key: 'search-empty', className: 'dsh-ide-tree-empty' }, 'Ничего не найдено')]
              : groups.map((group) =>
                  h(
                    'div',
                    { key: group.path, className: 'dsh-ide-search-file', role: 'group' },
                    h(
                      'div',
                      { className: 'dsh-ide-search-file-head', title: group.path },
                      h('span', { className: 'dsh-ide-search-file-name' }, baseName(group.path)),
                      dirName(group.path) === '' ? null : h('span', { className: 'dsh-ide-search-file-dir' }, dirName(group.path)),
                      h('span', { className: 'dsh-ide-search-file-count' }, String(group.hits.length)),
                    ),
                    group.hits.map((match, index) =>
                      h(
                        'div',
                        {
                          key: `${match.line}:${match.column}:${index}`,
                          className: 'dsh-ide-search-row',
                          role: 'listitem',
                        },
                        h(
                          'button',
                          {
                            type: 'button',
                            className: 'dsh-ide-search-hit',
                            title: `${match.path}:${match.line}:${match.column}`,
                            onClick: () => {
                              if (typeof onOpenFile === 'function') onOpenFile(match.path, match.line)
                            },
                          },
                          h('span', { className: 'dsh-ide-search-line' }, String(match.line)),
                          h('span', { className: 'dsh-ide-search-preview' }, previewParts(match)),
                        ),
                        typeof onInsertReference === 'function'
                          ? h(
                              'button',
                              {
                                type: 'button',
                                className: 'dsh-ide-icon-button',
                                title: 'Добавить ссылку в чат',
                                'aria-label': 'Добавить ссылку в чат',
                                onClick: () => onInsertReference(match.path, match.line),
                              },
                              '@',
                            )
                          : null,
                      ),
                    ),
                  ),
                )
        return h(
          'div',
          { className: 'dsh-ide-explorer' },
          h(
            'div',
            { className: 'dsh-ide-explorer-head' },
            h('span', { className: 'dsh-ide-explorer-title' }, 'ПОИСК В ФАЙЛАХ'),
            h(
              'span',
              { className: 'dsh-ide-explorer-actions' },
              h(
                'button',
                {
                  type: 'button',
                  className: 'dsh-ide-icon-button',
                  title: 'Закрыть поиск',
                  'aria-label': 'Закрыть поиск',
                  onClick: () => {
                    if (typeof onCloseSearch === 'function') onCloseSearch()
                  },
                },
                '✕',
              ),
            ),
          ),
          h(
            'div',
            { className: 'dsh-ide-explorer-search' },
            h('input', {
              ref: searchInputRef,
              className: 'dsh-ide-search-input',
              type: 'search',
              value: searchQuery,
              placeholder: 'Текст для поиска',
              'aria-label': 'Поиск по содержимому файлов',
              onChange: (event) => setSearchQuery(event.target.value),
              onKeyDown: (event) => {
                if (event.key !== 'Escape') return
                if (searchQuery !== '') setSearchQuery('')
                else if (typeof onCloseSearch === 'function') onCloseSearch()
              },
            }),
          ),
          h('div', { className: 'dsh-ide-search-status' }, statusText),
          h('div', { className: 'dsh-ide-tree dsh-ide-search-results', role: 'list' }, rows),
        )
      }

      return h(
        'div',
        { className: 'dsh-ide-explorer' },
        h(
          'div',
          { className: 'dsh-ide-explorer-head' },
          h('span', { className: 'dsh-ide-explorer-title' }, 'ПРОВОДНИК'),
          h(
            'span',
            { className: 'dsh-ide-explorer-actions' },
            h(
              'button',
              {
                type: 'button',
                className: 'dsh-ide-icon-button',
                title: 'Новый файл…',
                'aria-label': 'Новый файл',
                disabled: typeof sessionId !== 'string' || sessionId === '',
                onClick: () => {
                  if (typeof props.onNewFile === 'function') props.onNewFile(targetDirectory())
                },
              },
              h(ToolbarIcon, { kind: 'file' }),
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'dsh-ide-icon-button',
                title: 'Новая папка…',
                'aria-label': 'Новая папка',
                disabled: typeof sessionId !== 'string' || sessionId === '',
                onClick: () => {
                  if (typeof props.onNewFolder === 'function') props.onNewFolder(targetDirectory())
                },
              },
              h(ToolbarIcon, { kind: 'folder' }),
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'dsh-ide-icon-button',
                title: 'Обновить дерево',
                onClick: () => setReloadKey((value) => value + 1),
              },
              h(ToolbarIcon, { kind: 'refresh' }),
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'dsh-ide-icon-button',
                title: 'Свернуть все папки',
                onClick: () => setExpanded(new Set()),
              },
              '⊟',
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'dsh-ide-icon-button',
                title: hidden ? 'Скрыть скрытые файлы' : 'Показать скрытые файлы',
                onClick: () => onToggleHidden(!hidden),
              },
              hidden ? '◉' : '◎',
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'dsh-ide-icon-button',
                title: 'Дополнительные действия',
                'aria-label': 'Дополнительные действия',
                onClick: (event) => {
                  const rect = event.currentTarget.getBoundingClientRect()
                  setMoreMenu({ x: Math.max(4, rect.right - 240), y: rect.bottom + 4 })
                },
              },
              '⋯',
            ),
          ),
        ),
        h(
          'div',
          { className: 'dsh-ide-explorer-search' },
          h('input', {
            className: 'dsh-ide-search-input',
            type: 'search',
            value: query,
            placeholder: 'Фильтр по имени файла',
            'aria-label': 'Фильтр файлов по имени',
            onChange: (event) => setQuery(event.target.value),
            onKeyDown: (event) => {
              if (event.key === 'Escape') setQuery('')
            },
          }),
        ),
        h('div', { className: 'dsh-ide-tree', role: 'tree' }, rows),
        rowMenu === undefined ? null : h(TabContextMenu, { menu: rowMenu, items: rowMenuItems(rowMenu), onClose: () => setRowMenu(undefined) }),
        moreMenu === undefined ? null : h(TabContextMenu, { menu: moreMenu, items: moreMenuItems, onClose: () => setMoreMenu(undefined) }),
      )
    }

    function FileBadge({ name }) {
      const badge = badgeOf(name)
      return h(
        'span',
        {
          className: 'dsh-ide-badge',
          style: { color: badge.color, fontSize: badge.label.length > 2 ? '7.5px' : '8.5px' },
          'aria-hidden': 'true',
        },
        badge.label,
      )
    }

    // -------------------------------------------------------------- tab strip

    // The menu bar mirrors VS Code's title bar: a row of top-level menus whose
    // dropdowns list commands. Items that the IDE cannot honour stay visible but
    // disabled, with the reason in the tooltip, so the gap is explicit.
    function MenuBar({ menus, openId, onOpen }) {
      return h(
        'div',
        {
          className: 'dsh-ide-menubar',
          role: 'menubar',
          onKeyDown: (event) => {
            if (event.key === 'Escape') onOpen('')
          },
        },
        menus.map((menu) =>
          h(
            'div',
            { key: menu.id, className: 'dsh-ide-menubar-slot' },
            h(
              'button',
              {
                type: 'button',
                role: 'menuitem',
                className: `dsh-ide-menubar-button${openId === menu.id ? ' dsh-ide-menubar-button-active' : ''}`,
                'aria-expanded': openId === menu.id,
                onClick: () => onOpen(openId === menu.id ? '' : menu.id),
                onMouseEnter: () => {
                  if (openId !== '' && openId !== menu.id) onOpen(menu.id)
                },
              },
              menu.label,
            ),
            openId === menu.id
              ? h(
                  'div',
                  { className: 'dsh-ide-dropdown', role: 'menu' },
                  menu.items.map((item, index) =>
                    item.separator === true
                      ? h('div', { key: `separator-${index}`, className: 'dsh-ide-menu-sep' })
                      : h(
                          'button',
                          {
                            key: item.id,
                            type: 'button',
                            role: 'menuitem',
                            className: 'dsh-ide-menu-item',
                            disabled: item.disabled === true,
                            title: item.hint === undefined ? '' : item.hint,
                            onClick: () => {
                              if (item.disabled === true) return
                              onOpen('')
                              if (typeof item.run === 'function') item.run()
                            },
                          },
                          h('span', null, item.label),
                          h('span', { className: 'dsh-ide-menu-key' }, item.key === undefined ? '' : item.key),
                        ),
                  ),
                )
              : null,
          ),
        ),
      )
    }

    function PromptDialog({ prompt, onClose }) {
      const [value, setValue] = React.useState(prompt.value === undefined ? '' : prompt.value)
      const [busy, setBusy] = React.useState(false)
      const submit = () => {
        if (busy) return
        setBusy(true)
        Promise.resolve(prompt.submit(value)).finally(() => {
          setBusy(false)
          onClose()
        })
      }
      return h(
        'div',
        { className: 'dsh-ide-modal' },
        h(
          'div',
          { className: 'dsh-ide-modal-card' },
          h('div', { className: 'dsh-ide-modal-title' }, prompt.title),
          h('div', { className: 'dsh-ide-modal-text' }, prompt.label),
          h('input', {
            className: 'dsh-ide-input',
            value,
            spellCheck: false,
            onChange: (event) => setValue(event.target.value),
            onKeyDown: (event) => {
              if (event.key === 'Enter') submit()
              if (event.key === 'Escape') onClose()
            },
          }),
          h(
            'div',
            { className: 'dsh-ide-modal-actions' },
            h('button', { type: 'button', className: 'dsh-ide-button', onClick: onClose }, 'Отмена'),
            h('button', { type: 'button', className: 'dsh-ide-button dsh-ide-button-primary', onClick: submit }, prompt.action === undefined ? 'Создать' : prompt.action),
          ),
        ),
      )
    }

    function InfoDialog({ info, onClose }) {
      return h(
        'div',
        { className: 'dsh-ide-modal' },
        h(
          'div',
          { className: 'dsh-ide-modal-card' },
          h('div', { className: 'dsh-ide-modal-title' }, info.title),
          info.lines.map((line, index) => h('div', { key: `line-${index}`, className: 'dsh-ide-modal-text' }, line)),
          h(
            'div',
            { className: 'dsh-ide-modal-actions' },
            h('button', { type: 'button', className: 'dsh-ide-button dsh-ide-button-primary', onClick: onClose }, 'Закрыть'),
          ),
        ),
      )
    }

    function TabStrip(props) {
      const { tabs, activeKey, onActivate, onClose, onContextMenu } = props
      return h(
        'div',
        { className: 'dsh-ide-tabs', role: 'tablist' },
        tabs.length === 0
          ? h('span', { className: 'dsh-ide-tabs-empty' }, 'Выберите файл в дереве слева')
          : tabs.map((tab) =>
              h(
                'div',
                {
                  key: tab.key,
                  className: `dsh-ide-tab${tab.key === activeKey ? ' dsh-ide-tab-active' : ''}`,
                  role: 'tab',
                  title: tab.path,
                  onClick: () => onActivate(tab.key),
                  onContextMenu: (event) => {
                    event.preventDefault()
                    onActivate(tab.key)
                    if (typeof onContextMenu === 'function') onContextMenu(tab.key, event)
                  },
                  onAuxClick: (event) => {
                    if (event.button === 1) {
                      event.preventDefault()
                      onClose(tab.key)
                    }
                  },
                },
                h(FileBadge, { name: tab.name }),
                h('span', { className: 'dsh-ide-tab-name' }, tab.name),
                tab.dirty ? h('span', { className: 'dsh-ide-tab-dirty', title: 'Не сохранено' }, '●') : null,
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'dsh-ide-tab-close',
                    title: 'Закрыть (Ctrl+W)',
                    'aria-label': `Закрыть ${tab.name}`,
                    onClick: (event) => {
                      event.stopPropagation()
                      onClose(tab.key)
                    },
                  },
                  '✕',
                ),
              ),
            ),
      )
    }

    // ---------------------------------------------------------- tab context

    function TabContextMenu({ menu, items, onClose }) {
      return h(
        'div',
        {
          className: 'dsh-ide-menu-shield',
          onClick: onClose,
          onContextMenu: (event) => {
            event.preventDefault()
            onClose()
          },
        },
        h(
          'div',
          {
            className: 'dsh-ide-context',
            style: { left: `${menu.x}px`, top: `${menu.y}px` },
            role: 'menu',
            onClick: (event) => event.stopPropagation(),
            onContextMenu: (event) => event.preventDefault(),
          },
          items.map((item, index) =>
            item.separator === true
              ? h('div', { className: 'dsh-ide-menu-sep', key: `separator-${index}` })
              : h(
                  'button',
                  {
                    key: item.id,
                    type: 'button',
                    role: 'menuitem',
                    disabled: item.disabled === true,
                    title: item.hint === undefined ? undefined : item.hint,
                    className: item.disabled === true ? 'dsh-ide-menu-item dsh-ide-menu-item-disabled' : 'dsh-ide-menu-item',
                    onClick: () => {
                      if (item.disabled === true) return
                      onClose()
                      item.run()
                    },
                  },
                  h('span', { className: 'dsh-ide-menu-label' }, item.label),
                  item.key === undefined ? null : h('span', { className: 'dsh-ide-menu-key' }, item.key),
                ),
          ),
        ),
      )
    }

    // ---------------------------------------------------------- quick open

    function fuzzyScore(candidatePath, needle) {
      if (needle === '') return 1
      let index = 0
      let score = 0
      let streak = 0
      for (let position = 0; position < candidatePath.length && index < needle.length; position += 1) {
        if (candidatePath[position].toLowerCase() === needle[index]) {
          score += 2 + streak
          streak += 1
          index += 1
        } else {
          streak = 0
        }
      }
      return index === needle.length ? score : -1
    }

    function rankFiles(files, query) {
      const needle = query.trim().toLowerCase()
      const scored = []
      for (const file of files) {
        const score = needle === '' ? 0 : fuzzyScore(file.path.toLowerCase(), needle) + fuzzyScore(file.name.toLowerCase(), needle) * 3
        if (needle === '' || score >= 0) scored.push({ file, score })
      }
      scored.sort((a, b) => b.score - a.score || a.file.path.length - b.file.path.length)
      return scored.slice(0, 60).map((entry) => entry.file)
    }

    /**
     * Command palette. It runs the very same closures the menu bar runs, so a
     * command cannot exist in one place and be missing or different in the
     * other; a disabled menu item stays disabled here for the same reason.
     */
    function CommandPalette({ commands, onPick, onClose }) {
      const [query, setQuery] = React.useState('')
      const needle = query.trim().toLowerCase()
      const visible = commands.filter(
        (entry) => needle === '' || `${entry.group} ${entry.label} ${entry.key === undefined ? '' : entry.key}`.toLowerCase().includes(needle),
      )
      const run = (entry) => {
        if (entry.disabled === true) return
        onPick(entry)
      }
      return h(
        'div',
        { className: 'dsh-ide-palette-layer', onClick: onClose },
        h(
          'div',
          { className: 'dsh-ide-palette', onClick: (event) => event.stopPropagation() },
          h('input', {
            className: 'dsh-ide-palette-input',
            type: 'text',
            autoFocus: true,
            placeholder: 'Команда…',
            spellCheck: false,
            value: query,
            'aria-label': 'Палитра команд',
            onChange: (event) => setQuery(event.target.value),
            onKeyDown: (event) => {
              if (event.key === 'Escape') {
                event.preventDefault()
                onClose()
                return
              }
              if (event.key !== 'Enter') return
              event.preventDefault()
              const first = visible.find((entry) => entry.disabled !== true)
              if (first === undefined) onClose()
              else run(first)
            },
          }),
          h(
            'div',
            { className: 'dsh-ide-palette-list', role: 'list' },
            visible.length === 0
              ? h('div', { className: 'dsh-ide-palette-empty' }, 'Ничего не найдено')
              : visible.map((entry) =>
                  h(
                    'button',
                    {
                      key: entry.id,
                      type: 'button',
                      className: `dsh-ide-palette-item${entry.disabled === true ? ' dsh-ide-palette-item-off' : ''}`,
                      disabled: entry.disabled === true,
                      title: entry.disabled === true ? 'Недоступно' : entry.label,
                      onClick: () => run(entry),
                    },
                    h('span', { className: 'dsh-ide-palette-label' }, entry.label),
                    h('span', { className: 'dsh-ide-palette-group' }, entry.group),
                    entry.key === undefined ? null : h('span', { className: 'dsh-ide-palette-key' }, entry.key),
                  ),
                ),
          ),
        ),
      )
    }

    function QuickOpen({ files, loading, error, onPick, onClose }) {
      const [query, setQuery] = React.useState('')
      const [index, setIndex] = React.useState(0)
      const inputRef = React.useRef(null)

      React.useEffect(() => {
        if (inputRef.current && typeof inputRef.current.focus === 'function') inputRef.current.focus()
      }, [])

      const matches = React.useMemo(() => rankFiles(files, query), [files, query])

      React.useEffect(() => {
        setIndex(0)
      }, [query])

      const onKeyDown = (event) => {
        if (event.key === 'ArrowDown') {
          event.preventDefault()
          setIndex((current) => Math.min(matches.length - 1, current + 1))
        } else if (event.key === 'ArrowUp') {
          event.preventDefault()
          setIndex((current) => Math.max(0, current - 1))
        } else if (event.key === 'Enter') {
          event.preventDefault()
          const picked = matches[index]
          if (picked !== undefined) onPick(picked.path)
        } else if (event.key === 'Escape') {
          event.preventDefault()
          onClose()
        }
      }

      const rows = matches.map((file, position) =>
        h(
          'button',
          {
            key: file.path,
            type: 'button',
            className: `dsh-ide-quick-row${position === index ? ' dsh-ide-quick-row-active' : ''}`,
            onMouseEnter: () => setIndex(position),
            onClick: () => onPick(file.path),
          },
          h(FileBadge, { name: file.name }),
          h('span', { className: 'dsh-ide-row-name' }, file.name),
          h('span', { className: 'dsh-ide-row-dim' }, dirName(file.path)),
        ),
      )

      return h(
        'div',
        { className: 'dsh-ide-modal dsh-ide-modal-top' },
        h(
          'div',
          { className: 'dsh-ide-modal-card dsh-ide-quick' },
          h('input', {
            ref: inputRef,
            className: 'dsh-ide-quick-input',
            type: 'text',
            value: query,
            placeholder: 'Имя файла в рабочей области…',
            'aria-label': 'Быстрое открытие файла',
            onChange: (event) => setQuery(event.target.value),
            onKeyDown,
          }),
          loading ? h('div', { className: 'dsh-ide-tree-empty' }, 'Загружаю список файлов…') : null,
          error !== undefined ? h('div', { className: 'dsh-ide-tree-error' }, error) : null,
          h('div', { className: 'dsh-ide-quick-list' }, rows.length === 0 && !loading ? h('div', { className: 'dsh-ide-tree-empty' }, 'Совпадений нет') : rows),
        ),
      )
    }

    // ------------------------------------------------------------- settings

    function providerKeyName(profile, provider) {
      const names = profile !== undefined && Array.isArray(profile.keyNames) ? profile.keyNames : []
      if (names.length > 0) return names[0]
      return `${String(provider || 'PROVIDER').toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`
    }

    // Continue-style "connect a model" dialog: provider, model, key, one button.
    function ModelDialog({ preferences, sessionModel, onClose, onConnected }) {
      const [catalog, setCatalog] = React.useState(undefined)
      const [provider, setProvider] = React.useState(preferences.completionProvider || '')
      const [model, setModel] = React.useState(preferences.completionModel || '')
      const [keyValue, setKeyValue] = React.useState('')
      const [keyStatus, setKeyStatus] = React.useState(undefined)
      const [busy, setBusy] = React.useState(false)
      const [message, setMessage] = React.useState('')
      const [connected, setConnected] = React.useState(false)

      React.useEffect(() => {
        let cancelled = false
        void (async () => {
          try {
            const payload = await call('catalog', {})
            if (!cancelled) setCatalog(payload)
          } catch (cause) {
            if (!cancelled) setMessage(describeError(cause))
          }
        })()
        return () => {
          cancelled = true
        }
      }, [])

      const groups = catalog !== undefined && Array.isArray(catalog.groups) ? catalog.groups : []
      const configurable = catalog !== undefined && Array.isArray(catalog.configurable) ? catalog.configurable : []
      const sessionProvider = sessionModel !== undefined && sessionModel !== null ? sessionModel.provider : ''
      const effectiveProvider = provider !== '' ? provider : sessionProvider
      const group = groups.find((entry) => entry.id === effectiveProvider)
      const profile = configurable.find((entry) => entry.provider === effectiveProvider)
      const models = group === undefined ? [] : group.models
      const fallbackModel = models.length > 0 ? models[0].id : ''
      const effectiveModel = model !== '' ? model : fallbackModel
      const keyRef = providerKeyName(profile, effectiveProvider)

      React.useEffect(() => {
        let cancelled = false
        void (async () => {
          if (keyRef === '') {
            setKeyStatus(undefined)
            return
          }
          try {
            const status = await call('credentials', { op: 'status', ref: keyRef })
            if (!cancelled) setKeyStatus(status)
          } catch (cause) {
            if (!cancelled) setKeyStatus({ supported: false, message: describeError(cause) })
          }
        })()
        return () => {
          cancelled = true
        }
      }, [keyRef])

      const providerOptions = []
      providerOptions.push(
        h('option', { key: '__session__', value: '' }, sessionProvider === '' ? 'Как у сессии' : `Как у сессии (${sessionProvider})`),
      )
      const known = new Set()
      for (const entry of groups) {
        known.add(entry.id)
        providerOptions.push(h('option', { key: entry.id, value: entry.id }, `${entry.name} (${entry.models.length})`))
      }
      if (effectiveProvider !== '' && !known.has(effectiveProvider)) {
        providerOptions.push(h('option', { key: `__unknown__${effectiveProvider}`, value: effectiveProvider }, `${effectiveProvider} (нет в каталоге)`))
      }

      const modelOptions = []
      if (models.length === 0) {
        modelOptions.push(h('option', { key: '__none__', value: '' }, 'Нет доступных моделей'))
      } else {
        for (const entry of models) {
          modelOptions.push(h('option', { key: entry.id, value: entry.id }, entry.name || entry.id))
        }
      }
      if (model !== '' && !models.some((entry) => entry.id === model)) {
        modelOptions.push(h('option', { key: `__saved__${model}`, value: model }, `${model} (сохранена ранее)`))
      }

      const keyHint = keyStatus === undefined
        ? `Имя ключа: ${keyRef || '—'}`
        : keyStatus.supported === false
          ? keyStatus.message || 'Хранилище ключей недоступно в этой сборке.'
          : keyStatus.configured === true
            ? `Ключ уже сохранён${keyStatus.source === 'environment' ? ' (переменная окружения)' : ''}. Введите новый, чтобы заменить.`
            : `Ключ не задан. Сохранится как ${keyRef}.`

      const connect = async () => {
        if (effectiveProvider === '' || effectiveModel === '') {
          setMessage('Выберите провайдера и модель.')
          return
        }
        setBusy(true)
        setMessage('')
        try {
          if (keyValue.trim() !== '' && keyRef !== '') {
            setKeyStatus(await call('credentials', { op: 'set', ref: keyRef, value: keyValue.trim() }))
            setKeyValue('')
          }
          await onConnected({
            completionProvider: provider,
            completionModel: effectiveModel,
            apiKeyRef: keyRef,
          })
          setConnected(true)
          setMessage(`Подключено: ${effectiveProvider} / ${effectiveModel}`)
        } catch (cause) {
          setMessage(describeError(cause))
        } finally {
          setBusy(false)
        }
      }

      return h(
        'div',
        { className: 'dsh-ide-model-dialog', role: 'dialog', 'aria-modal': 'true' },
        h(
          'div',
          { className: 'dsh-ide-model-card' },
          h(
            'div',
            { className: 'dsh-ide-model-head' },
            h('span', { className: 'dsh-ide-model-title' }, 'Подключить модель'),
            h('button', { type: 'button', className: 'dsh-ide-model-close', title: 'Закрыть', onClick: onClose }, '×'),
          ),
          h(
            'div',
            { className: 'dsh-ide-model-field' },
            h('span', { className: 'dsh-ide-model-label' }, 'Провайдер'),
            h(
              'select',
              {
                value: provider,
                'aria-label': 'Провайдер',
                onChange: (event) => {
                  setProvider(event.target.value)
                  setModel('')
                  setMessage('')
                },
              },
              providerOptions,
            ),
          ),
          h(
            'div',
            { className: 'dsh-ide-model-field' },
            h('span', { className: 'dsh-ide-model-label' }, 'Модель'),
            h(
              'select',
              {
                value: effectiveModel,
                'aria-label': 'Модель',
                onChange: (event) => {
                  setModel(event.target.value)
                  setMessage('')
                },
              },
              modelOptions,
            ),
          ),
          h(
            'div',
            { className: 'dsh-ide-model-field' },
            h('span', { className: 'dsh-ide-model-label' }, 'API-ключ'),
            h('input', {
              type: 'password',
              value: keyValue,
              autoComplete: 'off',
              spellCheck: false,
              placeholder: `Введите ключ ${keyRef || 'провайдера'}`,
              onChange: (event) => setKeyValue(event.target.value),
              onKeyDown: (event) => {
                if (event.key === 'Enter') void connect()
              },
            }),
            h('span', { className: 'dsh-ide-model-hint' }, keyHint),
          ),
          h(
            'button',
            { type: 'button', className: 'dsh-ide-model-button', disabled: busy, onClick: () => void connect() },
            busy ? 'Подключение…' : connected ? 'Готово' : 'Подключить',
          ),
          message === ''
            ? null
            : h('div', { className: connected ? 'dsh-ide-model-message dsh-ide-model-ok' : 'dsh-ide-model-message' }, message),
          h('div', { className: 'dsh-ide-model-foot' }, 'Настройки сохранятся в ~/.dsh/code-editor.json, ключ — в хранилище DSH.'),
        ),
      )
    }

    function SettingsPanel({ preferences, sessionModel, promptDefault, onClose, onSave, onAddModel }) {
      const [provider, setProvider] = React.useState(preferences.completionProvider || '')
      const [model, setModel] = React.useState(preferences.completionModel || '')
      const [systemPrompt, setSystemPrompt] = React.useState(preferences.systemPrompt || '')
      const [autoSuggest, setAutoSuggest] = React.useState(preferences.autoSuggest !== false)
      const [contextLeft, setContextLeft] = React.useState(String(preferences.contextLeft ?? 4000))
      const [contextRight, setContextRight] = React.useState(String(preferences.contextRight ?? 1000))
      const [catalog, setCatalog] = React.useState(undefined)
      const [refreshing, setRefreshing] = React.useState(false)
      const [keyRef, setKeyRef] = React.useState(preferences.apiKeyRef || '')
      const [keyValue, setKeyValue] = React.useState('')
      const [keyStatus, setKeyStatus] = React.useState(undefined)
      const [keyBusy, setKeyBusy] = React.useState(false)
      const [message, setMessage] = React.useState('')
      const [query, setQuery] = React.useState('')
      const [section, setSection] = React.useState('completion')
      // Chord drafts, one per IDE command. Empty means "the default chord"; the
      // Host stores only the strings that parse and differ from the default.
      const [keyDraft, setKeyDraft] = React.useState(() => {
        const initial = {}
        const stored = keybindingsOf(preferences)
        for (const command of KEY_COMMANDS) {
          const saved = stored === undefined || stored === null ? undefined : stored[command.id]
          initial[command.id] = typeof saved === 'string' && saved !== '' ? saved : command.chord
        }
        return initial
      })
      // Every Tab knob lives in one object: it starts from the stored
      // preferences and travels back to the Host as one patch.
      const [options, setOptions] = React.useState(() => {
        const initial = {}
        for (const entry of TAB_PREFERENCES) {
          initial[entry.key] = preferences[entry.key] === undefined ? entry.value : preferences[entry.key]
        }
        return initial
      })
      const initialProvider = React.useRef(provider).current

      const refreshCatalog = React.useCallback(async () => {
        setRefreshing(true)
        try {
          setCatalog(await call('catalog', {}))
        } catch (cause) {
          setMessage(describeError(cause))
        } finally {
          setRefreshing(false)
        }
      }, [])

      React.useEffect(() => {
        void refreshCatalog()
      }, [refreshCatalog])

      const sessionInfo = sessionModel !== undefined && sessionModel !== null
        ? sessionModel
        : catalog !== undefined && catalog !== null && catalog.default !== undefined
          ? catalog.default
          : undefined
      const sessionProvider = sessionInfo === undefined ? '' : sessionInfo.provider
      const effectiveProvider = provider !== '' ? provider : sessionProvider
      const group = catalog !== undefined && Array.isArray(catalog.groups) ? catalog.groups.find((entry) => entry.id === effectiveProvider) : undefined
      const profile = catalog !== undefined && Array.isArray(catalog.configurable) ? catalog.configurable.find((entry) => entry.provider === effectiveProvider) : undefined
      const models = group !== undefined ? group.models : []
      const failures = catalog !== undefined && Array.isArray(catalog.failures) ? catalog.failures : []

      const refreshKey = React.useCallback(async (ref) => {
        if (typeof ref !== 'string' || ref === '') {
          setKeyStatus(undefined)
          return
        }
        try {
          setKeyStatus(await call('credentials', { op: 'status', ref }))
        } catch (cause) {
          setKeyStatus({ supported: false, message: describeError(cause) })
        }
      }, [])

      React.useEffect(() => {
        const saved = preferences.apiKeyRef || ''
        const suggested = provider === initialProvider && saved !== '' ? saved : providerKeyName(profile, effectiveProvider)
        setKeyRef(suggested)
        void refreshKey(suggested)
      }, [effectiveProvider, profile === undefined ? '' : profile.settingsNs, preferences.apiKeyRef, initialProvider, refreshKey])

      const saveKey = async () => {
        if (keyValue.trim() === '') {
          setMessage('Введите новый ключ или оставьте поле пустым, чтобы сохранить прежний.')
          return
        }
        setKeyBusy(true)
        setMessage('')
        try {
          const status = await call('credentials', { op: 'set', ref: keyRef, value: keyValue.trim() })
          setKeyStatus(status)
          setKeyValue('')
          setMessage('Ключ сохранён.')
        } catch (cause) {
          setMessage(describeError(cause))
        } finally {
          setKeyBusy(false)
        }
      }

      const clearKey = async () => {
        setKeyBusy(true)
        setMessage('')
        try {
          setKeyStatus(await call('credentials', { op: 'clear', ref: keyRef }))
          setMessage('Ключ удалён.')
        } catch (cause) {
          setMessage(describeError(cause))
        } finally {
          setKeyBusy(false)
        }
      }

      const submit = () => {
        const toNumber = (value, fallback) => {
          const parsed = Number(value)
          return Number.isFinite(parsed) ? Math.round(parsed) : fallback
        }
        const patch = {
          completionProvider: provider,
          completionModel: model,
          autoSuggest,
          contextLeft: toNumber(contextLeft, 4000),
          contextRight: toNumber(contextRight, 1000),
          apiKeyRef: keyRef,
          systemPrompt: systemPrompt.trim(),
        }
        for (const entry of TAB_PREFERENCES) {
          patch[entry.key] =
            entry.kind === 'boolean'
              ? options[entry.key] === true
              : entry.kind === 'text'
                ? String(options[entry.key] ?? entry.value)
                : toNumber(options[entry.key], entry.value)
        }
        const issues = keyIssues()
        if (issues.size > 0) {
          setMessage(`Клавиши: ${issues.values().next().value}`)
          return
        }
        const keybindings = {}
        for (const command of KEY_COMMANDS) {
          const text = String(keyDraft[command.id] ?? command.chord).trim()
          if (text !== command.chord) keybindings[command.id] = text
        }
        patch.keybindings = keybindings
        onSave(patch)
      }

      const providerOptions = []
      const known = new Set()
      if (provider !== '') {
        providerOptions.push(h('option', { key: provider, value: provider }, provider))
        known.add(provider)
      }
      if (catalog !== undefined && Array.isArray(catalog.groups)) {
        for (const entry of catalog.groups) {
          if (!known.has(entry.id)) {
            providerOptions.push(h('option', { key: entry.id, value: entry.id }, `${entry.name} (${entry.models.length})`))
            known.add(entry.id)
          }
        }
      }
      if (catalog !== undefined && Array.isArray(catalog.configurable)) {
        for (const entry of catalog.configurable) {
          if (!known.has(entry.provider)) {
            providerOptions.push(h('option', { key: entry.provider, value: entry.provider }, `${entry.displayName || entry.provider} (нет моделей)`))
            known.add(entry.provider)
          }
        }
      }

      const modelOptions = [
        h('option', { key: '', value: '' }, sessionInfo !== undefined ? `Как у сессии (${sessionInfo.model})` : 'Как у сессии'),
      ]
      const knownModels = new Set()
      for (const entry of models) {
        modelOptions.push(h('option', { key: entry.id, value: entry.id }, entry.name || entry.id))
        knownModels.add(entry.id)
      }
      if (model !== '' && !knownModels.has(model)) modelOptions.push(h('option', { key: model, value: model }, `${model} (сохранена ранее)`))

      const keyHint = keyStatus === undefined
        ? 'Проверяю хранилище ключей…'
        : keyStatus.supported === false
          ? 'Хранилище ключей недоступно: ключ задаётся через окружение (apiKeyEnv профиля).'
          : keyStatus.configured
            ? `Ключ задан${keyStatus.source ? ` (${keyStatus.source})` : ''}${keyStatus.masked ? ` · ${keyStatus.masked}` : ''}`
            : 'Ключ не задан — автодополнение может не работать.'

      const q = query.trim().toLowerCase()
      const matches = (text) => q === '' || String(text).toLowerCase().includes(q)
      const searching = q !== ''

      const setting = (id, title, description, control) => {
        if (!matches(`${title} ${description}`)) return null
        return h(
          'div',
          { className: 'dsh-ide-setting', key: id },
          h(
            'div',
            { className: 'dsh-ide-setting-text' },
            h('div', { className: 'dsh-ide-setting-title' }, title),
            description === '' ? null : h('div', { className: 'dsh-ide-setting-desc' }, description),
          ),
          h('div', { className: 'dsh-ide-setting-control' }, control),
        )
      }

      const block = (id, title, rows) => {
        const visible = rows.filter((row) => row !== null)
        if (visible.length === 0) return null
        return h(
          'section',
          { className: 'dsh-ide-settings-section', key: id },
          h('div', { className: 'dsh-ide-settings-section-title' }, title),
          visible,
        )
      }

      const completionRows = [
        setting(
          'provider',
          'Автодополнение: провайдер',
          'Пустое значение — провайдер текущей сессии.',
          h(
            'select',
            { className: 'dsh-ide-input dsh-ide-setting-input', value: provider, onChange: (event) => setProvider(event.target.value) },
            h('option', { value: '' }, sessionInfo !== undefined ? `Как у сессии (${sessionInfo.provider})` : 'Как у сессии'),
            providerOptions,
          ),
        ),
        setting(
          'model',
          'Автодополнение: модель',
          'Пустое значение — модель сессии; для другого провайдера — его первая модель.',
          h('select', { className: 'dsh-ide-input dsh-ide-setting-input', value: model, onChange: (event) => setModel(event.target.value) }, modelOptions),
        ),
        setting(
          'catalog',
          'Автодополнение: каталог моделей',
          sessionInfo !== undefined ? `Модель сессии: ${sessionInfo.provider} / ${sessionInfo.model}` : '',
          h(
            'button',
            { type: 'button', className: 'dsh-ide-button', onClick: refreshCatalog, disabled: refreshing },
            refreshing ? 'Обновляю…' : 'Обновить',
          ),
        ),
        setting(
          'auto-suggest',
          'Автодополнение: автоподсказки',
          'Предлагать подсказку по паузе из настройки «Задержка запроса»; выключено — только по Ctrl+Space.',
          h(
            'label',
            { className: 'dsh-ide-setting-check' },
            h('input', { type: 'checkbox', checked: autoSuggest, onChange: (event) => setAutoSuggest(event.target.checked) }),
            h('span', {}, 'Предлагать по паузе'),
          ),
        ),
        failures.length === 0
          ? null
          : setting(
              'failures',
              'Автодополнение: ошибки провайдеров',
              failures.map((failure) => `${failure.name || failure.id}: ${failure.message}`).join('; '),
              null,
            ),
      ]

      const keyRows = [
        setting(
          'key-name',
          'API-ключ: имя переменной',
          'Переменная окружения из apiKeyEnv профиля DSH.',
          h('input', {
            className: 'dsh-ide-input dsh-ide-setting-input',
            type: 'text',
            value: keyRef,
            spellCheck: false,
            placeholder: 'OPENROUTER_API_KEY',
            onChange: (event) => setKeyRef(event.target.value.trim().toUpperCase()),
            onBlur: () => void refreshKey(keyRef),
          }),
        ),
        setting(
          'key-value',
          'API-ключ: значение',
          keyHint,
          h('input', {
            className: 'dsh-ide-input dsh-ide-setting-input',
            type: 'password',
            value: keyValue,
            autoComplete: 'off',
            spellCheck: false,
            placeholder: 'оставьте пустым, чтобы не менять',
            onChange: (event) => setKeyValue(event.target.value),
            onKeyDown: (event) => {
              if (event.key === 'Enter') void saveKey()
            },
          }),
        ),
        setting(
          'key-actions',
          '',
          '',
          h(
            'div',
            { className: 'dsh-ide-settings-actions' },
            h('button', { type: 'button', className: 'dsh-ide-button dsh-ide-button-primary', onClick: saveKey, disabled: keyBusy }, 'Сохранить ключ'),
            h('button', { type: 'button', className: 'dsh-ide-button', onClick: clearKey, disabled: keyBusy }, 'Удалить ключ'),
          ),
        ),
      ]

      const contextRows = [
        setting(
          'build',
          'Сборка интерфейса',
          'Если номер не совпадает с последним изменением, вкладка IDE работает на старом коде: нажмите Ctrl+Shift+R.',
          h('span', { className: 'dsh-ide-setting-value' }, UI_BUILD),
        ),
        setting(
          'context-left',
          'Контекст: символов до курсора',
          'От 200 до 20000.',
          h('input', {
            className: 'dsh-ide-input dsh-ide-setting-input dsh-ide-input-number',
            type: 'number',
            min: 200,
            max: 20000,
            value: contextLeft,
            onChange: (event) => setContextLeft(event.target.value),
          }),
        ),
        setting(
          'context-right',
          'Контекст: символов после курсора',
          'От 0 до 8000.',
          h('input', {
            className: 'dsh-ide-input dsh-ide-setting-input dsh-ide-input-number',
            type: 'number',
            min: 0,
            max: 8000,
            value: contextRight,
            onChange: (event) => setContextRight(event.target.value),
          }),
        ),
      ]

      const optionValue = (entry) => (options[entry.key] === undefined ? entry.value : options[entry.key])
      const optionRow = (entry) => {
        if (entry.kind === 'boolean') {
          return setting(
            entry.key,
            entry.title,
            entry.hint,
            h(
              'label',
              { className: 'dsh-ide-setting-check' },
              h('input', {
                type: 'checkbox',
                checked: optionValue(entry) === true,
                onChange: (event) => setOptions((previous) => ({ ...previous, [entry.key]: event.target.checked })),
              }),
              h('span', {}, 'Включено'),
            ),
          )
        }
        if (entry.kind === 'text') {
          return setting(
            entry.key,
            entry.title,
            entry.hint,
            h(
              'select',
              {
                className: 'dsh-ide-input dsh-ide-setting-input',
                value: String(optionValue(entry)),
                onChange: (event) => setOptions((previous) => ({ ...previous, [entry.key]: event.target.value })),
              },
              (entry.choices === undefined ? [] : entry.choices).map((choice) =>
                h('option', { key: choice.value, value: choice.value }, choice.label),
              ),
            ),
          )
        }
        return setting(
          entry.key,
          entry.title,
          entry.hint,
          h('input', {
            className: 'dsh-ide-input dsh-ide-setting-input dsh-ide-input-number',
            type: 'number',
            min: entry.min,
            max: entry.max,
            value: String(optionValue(entry)),
            onChange: (event) => setOptions((previous) => ({ ...previous, [entry.key]: event.target.value })),
          }),
        )
      }

      // Two groups because they answer different questions: "when and what do we
      // ask" versus "what do we refuse to show".
      const REQUEST_KEYS = [
        'completionEffort',
        'debounceMs',
        'deadlineMs',
        'flushAfterMs',
        'aboveLines',
        'belowLines',
        'answerLines',
        'rangeReplaceLines',
        'maxFileChars',
        'snoozeAfterRejectMs',
        'multiEdit',
        'multiEditAuto',
        'maxEdits',
        'maxTokens',
        'wholeFileContext',
        'autoModel',
        'noReasoningHint',
        'rangeReplace',
        'partialAccept',
        'refetchAfterAccept',
        'triggerInComments',
        'showRemovedDecorations',
        'explainSuppressed',
        'fullTrace',
      ]
      const CHECK_KEYS = [
        'showWhitespaceOnlyChanges',
        'maxAddedLines',
        'recentRejectThreshold',
        'recentRejectWindowMs',
        'heuristicDuplicateLine',
        'heuristicExtendsRange',
        'heuristicRevertingChange',
      ]
      const rowsForKeyList = (keys) =>
        keys
          .map((key) => TAB_PREFERENCES.find((entry) => entry.key === key))
          .filter((entry) => entry !== undefined)
          .map(optionRow)

      const promptRow = setting(
        'system-prompt',
        'Системная инструкция',
        'С чем редактор обращается к модели. Пустое поле — стандартная инструкция (она показана серым). Подстановки: {{answerLines}}, {{language}}, {{file}}.',
        h('textarea', {
          className: 'dsh-ide-input dsh-ide-setting-input dsh-ide-setting-textarea',
          rows: 6,
          placeholder: promptDefault === undefined ? '' : promptDefault,
          value: systemPrompt,
          onChange: (event) => setSystemPrompt(event.target.value),
        }),
      )

      const hintsRows = [promptRow, ...rowsForKeyList(REQUEST_KEYS)]
      const hintFilterRows = rowsForKeyList(CHECK_KEYS)

      // A chord the user typed may be unparsable or already taken; the section
      // says which, and `submit` refuses to save while any row is unhappy.
      const keyIssues = () => {
        const issues = new Map()
        const seen = new Map()
        for (const command of KEY_COMMANDS) {
          const text = String(keyDraft[command.id] ?? command.chord).trim()
          if (text === '') {
            issues.set(command.id, 'Пусто — останется клавиша по умолчанию.')
            continue
          }
          const parsed = parseChord(text)
          if (parsed === undefined) {
            issues.set(command.id, 'Не понял клавишу')
            continue
          }
          const signature = `${parsed.ctrl ? 1 : 0}${parsed.alt ? 1 : 0}${parsed.shift ? 1 : 0}${parsed.meta ? 1 : 0}:${parsed.key}`
          const other = seen.get(signature)
          if (other !== undefined) {
            issues.set(command.id, `Занято: ${other.label}`)
            continue
          }
          seen.set(signature, command)
        }
        return issues
      }

      const keyIssuesNow = keyIssues()
      // The chord list is wide and shallow, so it is a table rather than one
      // setting block per command: the name column stays readable and the
      // default chord sits next to the field instead of under the title.
      const keyCommandRows = (() => {
        const visible = KEY_COMMANDS.filter((command) => matches(`${command.label} ${command.chord}`))
        if (visible.length === 0) return []
        return [
          h(
            'div',
            { className: 'dsh-ide-keys', key: 'keys-table' },
            h(
              'div',
              { className: 'dsh-ide-keys-row dsh-ide-keys-head' },
              h('span', { className: 'dsh-ide-keys-name' }, 'Команда'),
              h('span', { className: 'dsh-ide-keys-chord' }, 'Клавиша'),
              h('span', { className: 'dsh-ide-keys-reset' }, ''),
            ),
            visible.map((command) => {
              const issue = keyIssuesNow.get(command.id)
              return h(
                'div',
                { className: 'dsh-ide-keys-row', key: command.id, 'data-invalid': issue !== undefined },
                h(
                  'span',
                  { className: 'dsh-ide-keys-name' },
                  command.label,
                  keyDraft[command.id] === command.chord
                    ? null
                    : h('span', { className: 'dsh-ide-keys-default' }, `по умолчанию ${command.chord}`),
                ),
                h(
                  'span',
                  { className: 'dsh-ide-keys-chord' },
                  h('input', {
                    className: 'dsh-ide-input dsh-ide-key-input',
                    value: keyDraft[command.id],
                    spellCheck: false,
                    'aria-label': command.label,
                    'aria-invalid': issue !== undefined,
                    onChange: (event) => setKeyDraft((current) => ({ ...current, [command.id]: event.target.value })),
                  }),
                  issue === undefined ? null : h('span', { className: 'dsh-ide-key-error' }, issue),
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'dsh-ide-icon-button dsh-ide-keys-reset',
                    title: `Вернуть по умолчанию: ${command.chord}`,
                    onClick: () => setKeyDraft((current) => ({ ...current, [command.id]: command.chord })),
                  },
                  '↺',
                ),
              )
            }),
          ),
        ]
      })()

      const sections = [
        { id: 'completion', label: 'Автодополнение', rows: completionRows },
        { id: 'hints', label: 'Подсказки ИИ', rows: hintsRows },
        { id: 'hints-filters', label: 'Проверки подсказок', rows: hintFilterRows },
        { id: 'keys', label: 'Клавиши', rows: keyCommandRows },
        { id: 'key', label: 'API-ключ', rows: keyRows },
        { id: 'context', label: 'Контекст', rows: contextRows },
      ]
      const shown = sections.filter((entry) => searching || entry.id === section)

      return h(
        'div',
        { className: 'dsh-ide-settings' },
        h(
          'div',
          { className: 'dsh-ide-settings-head' },
          h('div', { className: 'dsh-ide-settings-head-title' }, 'Параметры'),
          h('input', {
            className: 'dsh-ide-settings-search',
            type: 'search',
            placeholder: 'Параметры поиска',
            value: query,
            spellCheck: false,
            onChange: (event) => setQuery(event.target.value),
          }),
          h('button', { type: 'button', className: 'dsh-ide-icon-button', title: 'Закрыть настройки', onClick: onClose }, '✕'),
        ),
        h(
          'div',
          { className: 'dsh-ide-settings-tabs' },
          h('span', { className: 'dsh-ide-settings-tab dsh-ide-settings-tab-active' }, 'Пользователь'),
          h('span', { className: 'dsh-ide-settings-tabs-spacer' }),
          h('span', { className: 'dsh-ide-settings-tabs-note' }, 'Файл настроек: ~/.dsh/code-editor.json'),
        ),
        h(
          'div',
          { className: 'dsh-ide-settings-main' },
          h(
            'nav',
            { className: 'dsh-ide-settings-nav' },
            sections.map((entry) =>
              h(
                'button',
                {
                  key: entry.id,
                  type: 'button',
                  className: `dsh-ide-settings-nav-item${searching ? '' : section === entry.id ? ' dsh-ide-settings-nav-item-active' : ''}`,
                  onClick: () => {
                    setQuery('')
                    setSection(entry.id)
                  },
                },
                entry.label,
              ),
            ),
          ),
          h('div', { className: 'dsh-ide-settings-content' }, shown.map((entry) => block(entry.id, entry.label, entry.rows))),
        ),
        h(
          'div',
          { className: 'dsh-ide-settings-foot' },
          message === '' ? null : h('span', { className: 'dsh-ide-settings-message' }, message),
          h('span', { className: 'dsh-ide-settings-foot-spacer' }),
          h('button', { type: 'button', className: 'dsh-ide-button', onClick: onAddModel }, 'Подключить модель…'),
          h('button', { type: 'button', className: 'dsh-ide-button', onClick: onClose }, 'Закрыть'),
          h('button', { type: 'button', className: 'dsh-ide-button dsh-ide-button-primary', onClick: submit }, 'Сохранить'),
        ),
      )
    }

    function ConfirmDialog({ dialog, onSave, onDiscard, onCancel }) {
      if (dialog.mode === 'delete') {
        const kind = dialog.type === 'directory' ? 'папку' : 'файл'
        return h(
          'div',
          { className: 'dsh-ide-modal' },
          h(
            'div',
            { className: 'dsh-ide-modal-card' },
            h('div', { className: 'dsh-ide-modal-title' }, `Удалить ${kind} «${dialog.name}»?`),
            h('div', { className: 'dsh-ide-modal-text' }, 'Удаление безвозвратное: корзины в IDE нет. Изменения из открытых вкладок будут потеряны.'),
            h(
              'div',
              { className: 'dsh-ide-modal-actions' },
              h('button', { type: 'button', className: 'dsh-ide-button dsh-ide-button-primary', onClick: onDiscard }, 'Удалить'),
              h('button', { type: 'button', className: 'dsh-ide-button', onClick: onCancel }, 'Отмена'),
            ),
          ),
        )
      }
      const pane = dialog.mode === 'close-pane'
      const many = dialog.mode === 'close-many'
      const count = many && Array.isArray(dialog.keys) ? dialog.keys.length : 0
      const title = pane
        ? 'Закрыть IDE с несохранёнными файлами?'
        : many
          ? `Закрыть ${count} ${count === 1 ? 'вкладку' : 'вкладок'} с изменениями?`
          : 'Закрыть файл с изменениями?'
      const text = pane
        ? 'В панели остались несохранённые файлы. Сохранить их перед закрытием?'
        : many
          ? 'В выбранных вкладках есть несохранённые изменения. Сохранить их перед закрытием?'
          : 'Изменения не сохранены. Сохранить перед закрытием?'
      return h(
        'div',
        { className: 'dsh-ide-modal' },
        h(
          'div',
          { className: 'dsh-ide-modal-card' },
          h('div', { className: 'dsh-ide-modal-title' }, title),
          h('div', { className: 'dsh-ide-modal-text' }, text),
          h(
            'div',
            { className: 'dsh-ide-modal-actions' },
            h('button', { type: 'button', className: 'dsh-ide-button dsh-ide-button-primary', onClick: onSave }, 'Сохранить'),
            h('button', { type: 'button', className: 'dsh-ide-button', onClick: onDiscard }, 'Не сохранять'),
            h('button', { type: 'button', className: 'dsh-ide-button', onClick: onCancel }, 'Отмена'),
          ),
        ),
      )
    }

    // -------------------------------------------------------------- the pane

    function IdeTitle(props) {
      const tab = tabOf(props)
      const parsed = tab ? parseAddress(tab.contentId) : undefined
      const title = parsed === undefined || parsed.path === '' ? 'IDE' : baseName(parsed.path)
      return h('span', { title: tab && tab.title ? tab.title : title }, title)
    }

    function OpenIdeButton(props) {
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState('')
      const tab = tabOf(props)
      const fromTab = tab && typeof tab.contentId === 'string' ? parseAddress(tab.contentId) ?? parseFileAddress(tab.contentId) : undefined
      const absolutePath =
        props && typeof props.absolutePath === 'string' ? props.absolutePath : fromTab !== undefined ? fromTab.path : ''
      const label = props && typeof props.label === 'string' ? props.label : 'IDE'
      const providedSession = props && typeof props.sessionId === 'string' ? props.sessionId : ''

      const open = React.useCallback(
        async (event) => {
          setError('')
          setBusy(true)
          try {
            let sessionId = providedSession !== '' ? providedSession : sessionIdFromElement(event && event.currentTarget)
            if (sessionId === undefined && fromTab !== undefined) sessionId = fromTab.sessionId
            if (sessionId === undefined) {
              if (absolutePath === '') {
                setError('Не удалось определить сессию')
                return
              }
              const resolved = await call('resolve', { path: absolutePath })
              sessionId = resolved && resolved.sessionId
            }
            if (typeof sessionId !== 'string' || sessionId === '') {
              setError('Не удалось определить сессию')
              return
            }
            const sidebar = services.sidebarRight
            if (!sidebar) {
              setError('Правая панель недоступна')
              return
            }
            requestOpen(sessionId, absolutePath)
            // One IDE tab per session: `multiple: false` makes every open land
            // on the same page address, so the tab is revealed instead of stacked.
            if (typeof sidebar.openTabIn === 'function') {
              sidebar.openTabIn(sessionId, TAB_KIND, {})
            } else if (typeof sidebar.openTab === 'function') {
              sidebar.openTab(TAB_KIND, {})
            } else if (typeof sidebar.openResourceIn === 'function') {
              sidebar.openResourceIn(sessionId, fileAddress(sessionId, ''), { kind: TAB_KIND })
            } else {
              setError('Правая панель недоступна')
            }
          } catch (cause) {
            setError(describeError(cause))
          } finally {
            setBusy(false)
          }
        },
        [absolutePath, fromTab, providedSession],
      )

      return h(
        'span',
        { className: props && props.compact === true ? 'dsh-ide-action dsh-ide-action-compact' : 'dsh-ide-action' },
        h(
          'button',
          {
            type: 'button',
            className: 'dsh-ide-action-button',
            onClick: open,
            disabled: busy,
            title: error === '' ? 'Открыть рабочую область в IDE' : error,
          },
          label,
        ),
        error === '' ? null : h('span', { className: 'dsh-ide-action-error', title: error }, '!'),
      )
    }

    function asNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/**
 * Why this row shows the model it shows.
 *
 * An empty `completionModel` preference means "the session's model", so the
 * trajectory naming the session model looked like the settings were ignored.
 * The row now says where the model came from, and the tooltip spells it out.
 */
function traceModelHint(row) {
  if (row === undefined || row === null) return ''
  const parts = []
  if (row.modelSource === 'session') parts.push('Своя модель подсказок не выбрана — взята модель сессии.')
  if (row.modelSource === 'auto') parts.push('Модель подсказок не выбрана — взята быстрая модель провайдера.')
  if (row.modelSource === 'settings') parts.push('Модель выбрана в настройках подсказок.')
  if (row.modelSource === 'request') parts.push('Модель передана запросом.')
  if (row.fellBack === true) parts.push('Первая модель не ответила — сработала запасная.')
  if (typeof row.effort === 'string' && row.effort !== '') parts.push(`Рассуждения: ${row.effort}.`)
  return parts.join(' ')
}

// The editor bundle cannot import the Host modules, so the two primitives the
// Tab controller needs are duplicated here. Keep them identical to the ones in
// `tab.js`; `tests/tab.test.mjs` guards the Host side.
function commonPrefixLengthLocal(left, right) {
  const limit = Math.min(left.length, right.length)
  let index = 0
  while (index < limit && left.charCodeAt(index) === right.charCodeAt(index)) index += 1
  return index
}

function nextWordEndLocal(text, start) {
  if (typeof text !== 'string') return start
  if (start >= text.length) return text.length
  let index = start
  while (index < text.length && /\s/.test(text[index])) index += 1
  if (index >= text.length) return text.length
  if (/\w/.test(text[index])) {
    while (index < text.length && /\w/.test(text[index])) index += 1
    return index
  }
  return index + 1
}

// One table drives both the settings rows and the patch sent to the Host, so a
// new knob cannot be shown without also being saved. Bounds here are only for
// the inputs: `prefs.js` clamps the stored value again on the Host.
const TAB_PREFERENCES = [
  {
    key: 'completionEffort',
    kind: 'text',
    value: '',
    choices: [
      { value: '', label: 'по умолчанию у провайдера' },
      { value: 'off', label: 'off — без рассуждений (быстро)' },
      { value: 'low', label: 'low — минимум рассуждений' },
      { value: 'medium', label: 'medium — средне' },
      { value: 'high', label: 'high — подробные рассуждения' },
    ],
    title: 'Подсказки: уровень рассуждений',
    hint: 'Пусто — как решит провайдер. off отключает «размышления» и ускоряет ответ, но не все модели его принимают: такой запрос отклоняется сразу и повторяется с low.',
  },
  { key: 'deadlineMs', kind: 'number', value: 6000, min: 1000, max: 60000, title: 'Подсказки: предел ожидания', hint: 'Сколько миллисекунд ждать ответ, прежде чем сдаться (1000–60000).' },
  { key: 'flushAfterMs', kind: 'number', value: 250, min: 0, max: 5000, title: 'Подсказки: показывать начало ответа', hint: 'Сколько миллисекунд собирать текст после первого символа, прежде чем показать его.' },
  { key: 'debounceMs', kind: 'number', value: 500, min: 50, max: 3000, title: 'Подсказки: задержка', hint: 'Пауза после последней правки перед запросом, мс (50–3000).' },
  { key: 'aboveLines', kind: 'number', value: 60, min: 0, max: 400, title: 'Подсказки: строк до курсора', hint: 'Сколько строк перед курсором видит модель (0–400).' },
  { key: 'belowLines', kind: 'number', value: 20, min: 0, max: 200, title: 'Подсказки: строк после курсора', hint: 'Сколько строк после курсора видит модель (0–200).' },
  { key: 'answerLines', kind: 'number', value: 5, min: 1, max: 20, title: 'Подсказки: длина ответа', hint: 'Просить продолжение не длиннее N строк (1–20).' },
  { key: 'rangeReplaceLines', kind: 'number', value: 2, min: 0, max: 8, title: 'Подсказки: строк для замены', hint: 'Сколько строк после курсора разрешено переписать (0 — только вставка).' },
  { key: 'maxFileChars', kind: 'number', value: 1000000, min: 1000, max: 5000000, title: 'Подсказки: размер файла', hint: 'Файлы длиннее этого числа символов не получают подсказок.' },
  { key: 'maxAddedLines', kind: 'number', value: 20, min: 1, max: 200, title: 'Проверка: рост ответа', hint: 'Отклонять ответ, добавляющий больше N строк.' },
  { key: 'recentRejectThreshold', kind: 'number', value: 3, min: 0, max: 10, title: 'Проверка: порог повторов', hint: 'Не повторять отклонённое N раз; 0 — выключить проверку.' },
  { key: 'recentRejectWindowMs', kind: 'number', value: 300000, min: 0, max: 600000, title: 'Проверка: память отказов', hint: 'Сколько миллисекунд помнить отклонённое.' },
  { key: 'snoozeAfterRejectMs', kind: 'number', value: 800, min: 0, max: 5000, title: 'Подсказки: пауза после Escape', hint: 'Не спрашивать модель сразу после отклонения, мс.' },
  { key: 'multiEdit', kind: 'boolean', value: true, title: 'Подсказки: правки по всему файлу', hint: 'В том же ответе просить правки в других местах файла (сигнатуры, ветки, импорты).' },
  { key: 'multiEditAuto', kind: 'boolean', value: false, title: 'Подсказки: правки при наборе', hint: 'Просить правки по всему файлу и на обычной паузе, а не только по Ctrl+Space. Такие ответы идут на 2–3 секунды дольше.' },
  { key: 'maxEdits', kind: 'number', value: 3, min: 0, max: 5, title: 'Подсказки: сколько правок', hint: 'Больше этого числа правок из одного ответа не принимается; 0 — выключить.' },
  { key: 'maxTokens', kind: 'number', value: 0, min: 0, max: 8000, title: 'Подсказки: лимит токенов ответа', hint: '0 — без ограничения: запрос уходит без maxTokens, и модель останавливается сама. Лимит ниже возможностей модели обрезает ответ посреди правки.' },
  { key: 'wholeFileContext', kind: 'boolean', value: true, title: 'Подсказки: весь файл в запросе', hint: 'Отправлять файл целиком с отметкой курсора, а не окна вокруг него.' },
  { key: 'autoModel', kind: 'boolean', value: true, title: 'Подсказки: быстрая модель сама', hint: 'Если модель подсказок не выбрана, брать быструю из каталога провайдера, а не модель сессии. Выключите, чтобы подсказки шли на текущей модели.' },
  { key: 'noReasoningHint', kind: 'boolean', value: true, title: 'Подсказки: сразу кодом', hint: 'Добавлять в инструкцию «не рассуждай вслух: сразу пиши код». Скрытые рассуждения модели это не отключает — их задаёт маршрут.' },
  { key: 'rangeReplace', kind: 'boolean', value: true, title: 'Подсказки: заменять хвост строки', hint: 'Разрешать замену текста после курсора, а не только вставку.' },
  { key: 'partialAccept', kind: 'boolean', value: true, title: 'Подсказки: приём по слову', hint: 'Ctrl+→ принимает следующее слово подсказки.' },
  { key: 'refetchAfterAccept', kind: 'boolean', value: false, title: 'Подсказки: запрос после приёма', hint: 'Сразу спрашивать продолжение после Tab.' },
  { key: 'triggerInComments', kind: 'boolean', value: true, title: 'Подсказки: в комментариях', hint: 'Подсказывать код сразу после комментария-просьбы.' },
  { key: 'showWhitespaceOnlyChanges', kind: 'boolean', value: false, title: 'Проверка: пробельные правки', hint: 'Показывать подсказки, меняющие только пробелы.' },
  {
    key: 'showRemovedDecorations',
    kind: 'boolean',
    value: false,
    title: 'Подсказки: подсветка замены',
    hint: 'Красить текст, который перепишет подсказка. По умолчанию выключено: подсветка легко выглядит как чужое выделение.',
  },
  { key: 'fullTrace', kind: 'boolean', value: false, title: 'Полная диагностика подсказок', hint: 'Хранить в панели запрос, исходный код и ответ модели. Выключение очищает эти тексты в текущей панели.' },
  { key: 'explainSuppressed', kind: 'boolean', value: true, title: 'Подсказки: причины отказа', hint: 'Писать в «Траектории», почему подсказка скрыта.' },
  { key: 'heuristicDuplicateLine', kind: 'boolean', value: true, title: 'Проверка: дубль строки', hint: 'Отклонять повтор следующей строки.' },
  { key: 'heuristicExtendsRange', kind: 'boolean', value: true, title: 'Проверка: повтор диапазона', hint: 'Отклонять ответ, повторяющий исходные строки.' },
  { key: 'heuristicRevertingChange', kind: 'boolean', value: true, title: 'Проверка: отмена правки', hint: 'Не предлагать текст, который пользователь только что удалил.' },
]

// Chords the IDE owns. A user override lives in `preferences.keybindings` and is
// applied at dispatch time instead of at registration: Monaco cannot change a
// chord after `addCommand`, and a remapped chord must also stop working.
const KEY_COMMANDS = [
  { id: 'save', label: 'Сохранить файл', chord: 'Ctrl+S' },
  { id: 'save-all', label: 'Сохранить всё', chord: 'Ctrl+Shift+S' },
  { id: 'quick-open', label: 'Открыть файл по имени', chord: 'Ctrl+P' },
  { id: 'close-tab', label: 'Закрыть вкладку', chord: 'Ctrl+W' },
  { id: 'next-tab', label: 'Следующая вкладка', chord: 'Ctrl+Tab' },
  { id: 'prev-tab', label: 'Предыдущая вкладка', chord: 'Ctrl+Shift+Tab' },
  { id: 'search', label: 'Поиск в файлах', chord: 'Ctrl+Shift+F' },
  { id: 'command-palette', label: 'Палитра команд', chord: 'Ctrl+Shift+P' },
  { id: 'quote', label: 'Строки в чат', chord: 'Ctrl+L' },
  { id: 'add-to-chat', label: 'Файл в чат', chord: 'Ctrl+Alt+C' },
  { id: 'inline-edit', label: 'Изменить выделение', chord: 'Ctrl+Shift+K' },
  { id: 'settings', label: 'Параметры', chord: 'Ctrl+,' },
  { id: 'output', label: 'Журнал подсказок', chord: 'Ctrl+`' },
]

const COMMAND_HANDLERS = {
  save: 'saveActive',
  'save-all': 'saveAll',
  'quick-open': 'openQuick',
  'close-tab': 'closeActive',
  'next-tab': 'nextTab',
  'prev-tab': 'prevTab',
  search: 'openSearch',
  'command-palette': 'openPalette',
  quote: 'quoteSelection',
  'add-to-chat': 'addToChat',
  'inline-edit': 'openInlineEdit',
  settings: 'openSettings',
  output: 'toggleOutput',
}

// Chord name -> Monaco KeyCode name. `+` itself is not bindable: it is the
// separator.
const CHORD_KEYS = (() => {
  const keys = {
    space: 'Space',
    tab: 'Tab',
    enter: 'Enter',
    escape: 'Escape',
    esc: 'Escape',
    up: 'UpArrow',
    down: 'DownArrow',
    left: 'LeftArrow',
    right: 'RightArrow',
    home: 'Home',
    end: 'End',
    pageup: 'PageUp',
    pagedown: 'PageDown',
    insert: 'Insert',
    delete: 'Delete',
    del: 'Delete',
    backspace: 'Backspace',
    ',': 'Comma',
    '.': 'Period',
    '/': 'Slash',
    '\\': 'Backslash',
    ';': 'Semicolon',
    "'": 'Quote',
    '[': 'BracketLeft',
    ']': 'BracketRight',
    '-': 'Minus',
    '=': 'Equal',
    '`': 'Backquote',
  }
  for (let code = 65; code <= 90; code += 1) {
    const letter = String.fromCharCode(code)
    keys[letter.toLowerCase()] = `Key${letter}`
  }
  for (let digit = 0; digit <= 9; digit += 1) keys[String(digit)] = `Digit${digit}`
  for (let n = 1; n <= 12; n += 1) keys[`f${n}`] = `F${n}`
  return keys
})()

/**
 * `Ctrl+Shift+K` -> `{ctrl:true, alt:false, shift:true, meta:false, key:'KeyK'}`.
 * Returns undefined when the text is not a chord the IDE can compare.
 */
function parseChord(text) {
  if (typeof text !== 'string') return undefined
  const parts = text
    .toLowerCase()
    .split('+')
    .map((part) => part.trim())
    .filter((part) => part !== '')
  if (parts.length === 0) return undefined
  const chord = { ctrl: false, alt: false, shift: false, meta: false, key: '' }
  for (const part of parts) {
    if (part === 'ctrl' || part === 'control' || part === 'cmd' || part === 'command') chord.ctrl = true
    else if (part === 'alt' || part === 'option') chord.alt = true
    else if (part === 'shift') chord.shift = true
    else if (part === 'win' || part === 'meta' || part === 'super') chord.meta = true
    else {
      const key = CHORD_KEYS[part]
      if (key === undefined || chord.key !== '') return undefined
      chord.key = key
    }
  }
  if (chord.key === '') return undefined
  return chord
}

/** A parsed chord back to text, for the help window. */
function chordText(chord) {
  const parts = []
  if (chord.ctrl) parts.push('Ctrl')
  if (chord.alt) parts.push('Alt')
  if (chord.shift) parts.push('Shift')
  if (chord.meta) parts.push('Win')
  const key = chord.key
  if (/^Key[A-Z]$/.test(key)) parts.push(key.slice(3))
  else if (/^Digit[0-9]$/.test(key)) parts.push(key.slice(5))
  else if (/^F[0-9]{1,2}$/.test(key)) parts.push(key)
  else if (key === 'Escape') parts.push('Esc')
  else if (key === 'UpArrow') parts.push('↑')
  else if (key === 'DownArrow') parts.push('↓')
  else if (key === 'LeftArrow') parts.push('←')
  else if (key === 'RightArrow') parts.push('→')
  else parts.push(key)
  return parts.join('+')
}

/** Stored overrides, or undefined before the first `state` reply arrives. */
function keybindingsOf(preferences) {
  return preferences !== undefined && preferences !== null && typeof preferences === 'object' ? preferences.keybindings : undefined
}

/** The effective map: a stored override when it parses, the default otherwise. */
function resolveKeymap(overrides) {
  const configured = overrides !== undefined && overrides !== null && typeof overrides === 'object' ? overrides : {}
  const map = new Map()
  for (const command of KEY_COMMANDS) {
    const custom = typeof configured[command.id] === 'string' ? parseChord(configured[command.id]) : undefined
    map.set(command.id, custom !== undefined ? custom : parseChord(command.chord))
  }
  return map
}

// `event.code` is the physical key, so a chord keeps working on a non-Latin
// layout. Monaco's own `IKeyboardEvent` carries the same DOM-style code.
const DOM_CODE_ALIASES = {
  ArrowUp: 'UpArrow',
  ArrowDown: 'DownArrow',
  ArrowLeft: 'LeftArrow',
  ArrowRight: 'RightArrow',
  NumpadEnter: 'Enter',
}

function matchChord(keymap, event) {
  if (keymap === undefined || keymap === null) return undefined
  const code = typeof event.code === 'string' ? DOM_CODE_ALIASES[event.code] ?? event.code : ''
  if (code === '') return undefined
  for (const [id, chord] of keymap) {
    if (chord === undefined || chord.key !== code) continue
    if (chord.ctrl !== (event.ctrlKey === true) || chord.alt !== (event.altKey === true)) continue
    if (chord.shift !== (event.shiftKey === true) || chord.meta !== (event.metaKey === true)) continue
    return id
  }
  return undefined
}

function OutputPanel({ panel, height, trace, onTab, onSelect, onClose }) {
  const entry = trace.length === 0 ? undefined : trace[Math.min(panel.index, trace.length - 1)]
  const conversation = entry === undefined ? undefined : entry.conversation
  const system = conversation === undefined ? '' : conversation.system
  const message = conversation === undefined ? '' : conversation.message
  const answer = conversation === undefined ? '' : conversation.answer
  return h(
    'div',
    { className: 'dsh-ide-panel', style: { height: `${height}px` } },
    h(
      'div',
      { className: 'dsh-ide-panel-head' },
      h(
        'button',
        {
          type: 'button',
          className: panel.tab === 'trajectory' ? 'dsh-ide-panel-tab dsh-ide-panel-tab-active' : 'dsh-ide-panel-tab',
          onClick: () => onTab('trajectory'),
        },
        'Траектория',
      ),
      h(
        'button',
        {
          type: 'button',
          className: panel.tab === 'chat' ? 'dsh-ide-panel-tab dsh-ide-panel-tab-active' : 'dsh-ide-panel-tab',
          onClick: () => onTab('chat'),
        },
        'Чат',
      ),
      h('span', { className: 'dsh-ide-panel-spacer' }),
      h('span', { className: 'dsh-ide-panel-hint' }, trace.length === 0 ? 'пока пусто' : `запросов: ${trace.length}`),
      h('button', { type: 'button', className: 'dsh-ide-panel-close', title: 'Закрыть панель', onClick: onClose }, '×'),
    ),
    panel.tab === 'trajectory'
      ? h(
          'div',
          { className: 'dsh-ide-panel-body' },
          trace.length === 0
            ? h(
                'div',
                { className: 'dsh-ide-panel-empty' },
                'Здесь появятся попытки автодополнения: модель, размер контекста, длительность и результат.',
              )
            : trace.map((row, index) =>
                h(
                  'div',
                  {
                    key: `${row.at}:${index}`,
                    className: index === panel.index ? 'dsh-ide-trace dsh-ide-trace-active' : 'dsh-ide-trace',
                    onClick: () => onSelect(index),
                  },
                  h('span', { className: 'dsh-ide-trace-time' }, row.at),
                  h('span', { className: 'dsh-ide-trace-path' }, row.path),
                  h(
                    'span',
                    {
                      className: 'dsh-ide-trace-model',
                      title: traceModelHint(row),
                    },
                    `${row.provider} / ${row.model}${
                      row.fellBack === true ? ' · запасная' : row.modelSource === 'session' ? ' · из сессии' : row.modelSource === 'auto' ? ' · быстрая' : ''
                    }`,
                  ),
                  h('span', { className: 'dsh-ide-trace-mode' }, row.explicit ? 'Ctrl+Space' : 'авто'),
                  h('span', { className: 'dsh-ide-trace-meta' }, `${row.before}/${row.after} символов`),
                  h('span', { className: 'dsh-ide-trace-meta' }, row.displayMs === undefined ? `${row.durationMs} мс` : `до показа: ${row.displayMs} мс · Host: ${row.durationMs} мс`),
                  row.ok
                    ? h('span', { className: 'dsh-ide-trace-ok' }, `+${row.chars} символов`)
                    : h('span', { className: 'dsh-ide-trace-error' }, row.reason || 'пустой ответ'),
                ),
              ),
        )
      : h(
          'div',
          { className: 'dsh-ide-panel-body dsh-ide-chat' },
          entry === undefined
            ? h('div', { className: 'dsh-ide-panel-empty' }, 'Запросов пока не было.')
            : !conversation ? h('div', { className: 'dsh-ide-panel-empty' }, 'Для этой записи текст не сохранён. Для новых запросов включите «Полная диагностика подсказок» в настройках.')
            : h(
                'div',
                null,
                h('div', { className: 'dsh-ide-chat-label' }, 'Системная инструкция'),
                h('pre', { className: 'dsh-ide-chat-text' }, system),
                h('div', { className: 'dsh-ide-chat-label' }, 'Отправлено'),
                h('pre', { className: 'dsh-ide-chat-text' }, message),
                h('div', { className: 'dsh-ide-chat-label' }, 'Ответ модели'),
                h('pre', { className: 'dsh-ide-chat-text' }, answer === '' ? entry.reason || '(пусто)' : answer),
              ),
        ),
  )
}

function IdeBody(props) {
      const tab = tabOf(props)
      const address = tab && typeof tab.contentId === 'string' ? tab.contentId : ''
      const parsed = parseAddress(address)
      // The workspace page address carries no session; session-scoped slots hand
      // it over in props instead.
      const providedSession = props && typeof props.sessionId === 'string' ? props.sessionId : ''
      const sessionId = parsed !== undefined && parsed.sessionId !== undefined ? parsed.sessionId : providedSession || undefined
      const initialPath = parsed !== undefined ? parsed.path : ''

      const hostRef = React.useRef(null)
      const runtime = React.useRef({
        editor: undefined,
        monaco: undefined,
        models: new Map(),
        views: new Map(),
        modelTabs: new Map(),
        activeKey: '',
        autoSuggest: true,
        lastCompletion: '',
        ghostPosition: undefined,
        ghostDecorations: [],
        ghostZone: undefined,
        ghostTimer: 0,
        ghostKey: undefined,
        // Inline Edit: one selection, one instruction, one reviewable
        // replacement. The payload never contains Monaco objects.
        inlineEdit: undefined,
        inlineSeq: 0,
        changeSeq: 0,
        // Effective chord table (`Map` of command id -> parsed chord). Read by the
        // editor's key dispatch, so a remap takes effect without re-registering.
        keymap: undefined,
        // Side-by-side comparison of an assistant turn: `{editor, original, modified}`.
        diffEditor: undefined,
        // One-shot caret target requested by a search hit, consumed once the tab
        // owns the editor model.
        pendingReveal: undefined,
        // Controller state for the ported Tab mechanics: the plan the Host
        // computed, how much of it was already accepted word by word, and the
        // per-tab histories that feed the bad-case checks.
        tab: {
          controller: undefined,
          plan: undefined,
          accepted: 0,
          snoozeUntil: 0,
          removedDecorations: [],
          edits: [],
          editWidgets: [],
          editDecorations: [],
          rejections: new Map(),
          revertions: new Map(),
          internalEdit: false,
        },
      })
      const pendingOpens = React.useRef(new Set())
      const handlersRef = React.useRef({})

      const [monaco, setMonaco] = React.useState(undefined)
      const [tabs, setTabs] = React.useState([])
      const [activeKey, setActiveKey] = React.useState('')
      const [status, setStatus] = React.useState({ kind: 'idle', message: '' })
      const [explorerWidth, setExplorerWidth] = React.useState(220)
      const [showTree, setShowTree] = React.useState(true)
      const [searchOpen, setSearchOpen] = React.useState(false)
      const [changes, setChanges] = React.useState([])
      /** Host checkpoints of assistant turns: `{phase, available, turns, error}`. */
      const [assistant, setAssistant] = React.useState({ phase: 'idle', available: true, turns: [], error: '' })
      const [changesOpen, setChangesOpen] = React.useState(false)
      /** Per-file decision on an assistant turn, keyed `seq:index`. */
      const [assistantWork, setAssistantWork] = React.useState({})
      /** Side-by-side comparison over the editor: `{phase, seq, index, path, display, before, after, language, error}`. */
      const [diffView, setDiffView] = React.useState(undefined)
      const diffContainerRef = React.useRef(undefined)
      // Bumped after «Отменить правки» so the pane refetches the turn list
      // instead of showing a snapshot the Host has already superseded.
      const [changesReload, setChangesReload] = React.useState(0)
      const [paletteOpen, setPaletteOpen] = React.useState(false)
      const [explorerSide, setExplorerSide] = React.useState('left')
      const [hidden, setHidden] = React.useState(false)
      const [preferences, setPreferences] = React.useState(undefined)
      const [promptDefault, setPromptDefault] = React.useState('')
      const [settingsOpen, setSettingsOpen] = React.useState(false)
      const [modelDialog, setModelDialog] = React.useState(false)
      const [createRequest, setCreateRequest] = React.useState(undefined)
      const [catalog, setCatalog] = React.useState(undefined)
      const [tabMenu, setTabMenu] = React.useState(undefined)
  // The output panel mirrors the VS Code one: "Trajectory" explains every
  // completion request, "Chat" shows the exact prompt and answer.
  const [panel, setPanel] = React.useState(undefined)
  const [panelHeight, setPanelHeight] = React.useState(190)
  const [trace, setTrace] = React.useState([])
      const [quick, setQuick] = React.useState(undefined)
      const [dialog, setDialog] = React.useState(undefined)
      const [cursor, setCursor] = React.useState({ line: 1, column: 1 })
      const [consent, setConsent] = React.useState(undefined)
      const [menuId, setMenuId] = React.useState('')
      const [prompt, setPrompt] = React.useState(undefined)
      const [info, setInfo] = React.useState(undefined)
      const [reloadSignal, setReloadSignal] = React.useState(0)
      const [fontSize, setFontSize] = React.useState(13)
      const [wordWrap, setWordWrap] = React.useState(false)
      const [booted, setBooted] = React.useState(false)
      const [dragOver, setDragOver] = React.useState('')
      const [quotePrompt, setQuotePrompt] = React.useState(undefined)
      const [inlineView, setInlineView] = React.useState(undefined)
      const inlineInputRef = React.useRef(undefined)
      const [selected, setSelected] = React.useState(undefined)
      const selectedRef = React.useRef(undefined)
      selectedRef.current = selected
      // The explorer's selected folder decides where a new file or folder goes.
      const selectionDirectory = () => {
        const value = selectedRef.current
        if (value === undefined || typeof value.path !== 'string') return ''
        return value.type === 'directory' ? value.path : dirName(value.path)
      }

      const stateRef = React.useRef({})
      stateRef.current = { tabs, activeKey, sessionId, preferences }

      // Settings are read through a ref as well: the editor effect installs the
      // Tab commands once, so a closure over `preferences` would keep the
      // values from the first render forever.
      const prefsRef = React.useRef(undefined)
      React.useEffect(() => {
        prefsRef.current = preferences
      }, [preferences])

      // Same reason as `prefsRef`: the editor effect installs the key dispatch
      // once, so the chord table has to be read through a ref.
      const savedKeybindings = keybindingsOf(preferences)
      const keymap = React.useMemo(() => resolveKeymap(savedKeybindings), [savedKeybindings])
      React.useEffect(() => {
        runtime.current.keymap = keymap
      }, [keymap])

      const tabPref = (key, fallback) => {
        const saved = prefsRef.current
        if (saved === undefined || saved === null) return fallback
        const value = saved[key]
        return value === undefined ? fallback : value
      }

      const openFile = React.useCallback(async (filePath, options) => {
        const normalized = normalPath(filePath)
        const scope = stateRef.current.sessionId
        if (normalized === '' || typeof scope !== 'string' || scope === '') return undefined
        const existing = stateRef.current.tabs.find((candidate) => candidate.path === normalized)
        if (existing !== undefined) {
          if (options === undefined || options.activate !== false) setActiveKey(existing.key)
          return existing
        }
        if (pendingOpens.current.has(normalized)) return undefined
        pendingOpens.current.add(normalized)
        try {
          const payload = await call('open', { sessionId: scope, path: normalized })
          const entry = {
            key: payload.id,
            path: normalized,
            name: baseName(normalized),
            hostId: payload.id,
            token: payload.token,
            text: payload.text,
            language: payload.language,
            eol: payload.eol,
            readOnly: payload.readOnly === true,
            dirty: false,
          }
          setTabs((previous) => (previous.some((candidate) => candidate.path === normalized) ? previous : [...previous, entry]))
          if (options === undefined || options.activate !== false) setActiveKey(entry.key)
          setSelected({ path: normalized, type: 'file' })
          setStatus({ kind: 'idle', message: '' })
          return entry
        } catch (cause) {
          setStatus({ kind: 'error', message: describeError(cause) })
          return undefined
        } finally {
          pendingOpens.current.delete(normalized)
        }
      }, [])

      // ------------------------------------------------------------ "в чат"
      //
      // Inserts a quoted fragment into the current session's composer draft via
      // the slot-provided `inputActions`. The full coordinates and the text both
      // live in `text`; `summary` only controls how the draft displays it (see
      // docs/dsh-code-editor.md, «Строки в чат»). Nothing is sent to the model:
      // the user still has to press the ordinary send control.
      const insertQuote = (text, summary) => {
        const actions = props && props.inputActions
        if (!actions || typeof actions.insertQuote !== 'function') {
          setStatus({ kind: 'error', message: 'Чат недоступен в этой панели' })
          return false
        }
        let accepted = false
        try {
          accepted = actions.insertQuote(text, summary) === true
        } catch (cause) {
          setStatus({ kind: 'error', message: messageOf(cause) })
          return false
        }
        setStatus(accepted ? { kind: 'ok', message: 'Добавлено в поле ввода' } : { kind: 'error', message: 'Поле ввода занято — очистите его и повторите' })
        return accepted
      }

      // P6: «Объяснить» and «Подготовить план» only fill the chat composer with a
      // ready request about the selection; the model call stays the user's own
      // press of Enter in the standard composer. Sending from here would grant a
      // new run nobody asked for.
      const draftQuestion = (kind) => {
        const editor = runtime.current.editor
        const active = stateRef.current.tabs.find((candidate) => candidate.key === stateRef.current.activeKey)
        if (editor === undefined || active === undefined) {
          setStatus({ kind: 'error', message: 'Откройте файл, о котором нужно спросить' })
          return false
        }
        const model = editor.getModel()
        if (model === null) return false
        const selection = editor.getSelection()
        const cursor = editor.getPosition()
        const hasSelection = selection !== null && !selection.isEmpty()
        const startLine = hasSelection ? selection.getStartPosition().lineNumber : cursor === null ? 0 : cursor.lineNumber
        const endLine = hasSelection ? selection.getEndPosition().lineNumber : startLine
        if (startLine === 0) {
          setStatus({ kind: 'error', message: 'Курсор редактора недоступен' })
          return false
        }
        const lineCount = model.getLineCount()
        const from = Math.max(1, Math.min(startLine, endLine))
        const to = Math.min(lineCount, Math.max(startLine, endLine))
        let selected
        if (hasSelection) {
          selected = model.getValueInRange(selection)
        } else {
          const lines = []
          for (let line = from; line <= to; line += 1) lines.push(model.getLineContent(line))
          selected = lines.join('\n')
        }
        if (selected.trim() === '') {
          setStatus({ kind: 'error', message: hasSelection ? 'Выделение пустое' : 'Строка пустая' })
          return false
        }
        const actions = props && props.inputActions
        if (!actions || typeof actions.insertText !== 'function') {
          setStatus({ kind: 'error', message: 'Чат недоступен в этой панели' })
          return false
        }
        const path = active.path
        const question = kind === 'plan' ? 'Подготовь план изменения этого кода. Что нужно изменить: ' : 'Объясни этот код. Что именно непонятно: '
        const language = typeof active.language === 'string' ? active.language : ''
        const draft = `${question}\n\n${path}:${from}–${to}\n\`\`\`${language}\n${selected}\n\`\`\`\n`
        const span = typeof actions.captureInsertion === 'function' ? actions.captureInsertion() : undefined
        try {
          actions.insertText(draft, span)
        } catch (cause) {
          setStatus({ kind: 'error', message: messageOf(cause) })
          return false
        }
        setStatus({ kind: 'ok', message: 'Черновик запроса в поле ввода — проверьте и отправьте сами.' })
        return true
      }

      // Quote the current selection (or the current line when nothing is
      // selected) from the live Monaco model, marking unsaved text as "из
      // буфера". `lineRange` optionally overrides the selection with an explicit
      // inclusive 1-based range { start, end }.
      const quoteEditorFragment = (lineRange) => {
        const editor = runtime.current.editor
        const active = stateRef.current.tabs.find((candidate) => candidate.key === stateRef.current.activeKey)
        if (editor === undefined || active === undefined) return false
        const model = editor.getModel()
        if (model === null) return false
        const selection = editor.getSelection()
        const explicit = lineRange !== undefined && typeof lineRange.start === 'number' && typeof lineRange.end === 'number'
        const cursor = editor.getPosition()
        const hasSelection = !explicit && selection !== null && !selection.isEmpty()
        const startLine = explicit ? lineRange.start : hasSelection ? selection.getStartPosition().lineNumber : cursor === null ? 0 : cursor.lineNumber
        const endLine = explicit ? lineRange.end : hasSelection ? selection.getEndPosition().lineNumber : startLine
        if (startLine === 0) {
          setStatus({ kind: 'error', message: 'Курсор редактора недоступен' })
          return false
        }
        const lineCount = model.getLineCount()
        const from = Math.max(1, Math.min(startLine, endLine))
        const to = Math.min(lineCount, Math.max(startLine, endLine))
        let selected
        if (explicit || !hasSelection) {
          const lines = []
          for (let line = from; line <= to; line += 1) lines.push(model.getLineContent(line))
          selected = lines.join('\n')
        } else {
          selected = model.getValueInRange(selection)
        }
        if (selected.trim() === '') {
          setStatus({ kind: 'error', message: hasSelection ? 'Выделение пустое' : 'Строка пустая' })
          return false
        }
        const relativePath = active.path
        const label = `${relativePath}:${from}–${to}${explicit || hasSelection ? '' : ' · из буфера'}`
        const text = `${label}\n${selected}`
        const summary = { label, title: 'Фрагмент из редактора', detail: relativePath, body: selected }
        return insertQuote(text, summary)
      }

      // Quote a whole file (or an explicit line range of it) straight from the
      // explorer without opening it as a tab. Reads the current on-disk bytes
      // through the Host `open` route so the quote matches what is saved.
      const quoteFile = async (filePath, lineRange) => {
        const scope = stateRef.current.sessionId
        if (typeof scope !== 'string' || scope === '') return false
        const normalized = normalPath(filePath)
        const explicit = lineRange !== undefined && typeof lineRange.start === 'number' && typeof lineRange.end === 'number'
        let payload
        try {
          payload = await call('open', { sessionId: scope, path: normalized })
        } catch (cause) {
          setStatus({ kind: 'error', message: describeError(cause) })
          return false
        }
        const text = payload === undefined ? '' : payload.text
        if (typeof text !== 'string' || text.trim() === '') {
          setStatus({ kind: 'error', message: 'Файл пустой' })
          return false
        }
        const relativePath = payload && typeof payload.relativePath === 'string' && payload.relativePath !== '' ? payload.relativePath : normalized
        const lines = text.split('\n')
        let body
        let from
        let to
        if (explicit) {
          from = Math.max(1, Math.min(lineRange.start, lineRange.end))
          to = Math.min(lines.length, Math.max(lineRange.start, lineRange.end))
          body = lines.slice(from - 1, to).join('\n')
        } else {
          from = 1
          to = lines.length
          body = text
        }
        const label = `${relativePath}:${from}–${to}`
        const summary = { label, title: 'Файл из проводника', detail: relativePath, body }
        return insertQuote(`${label}\n${body}`, summary)
      }

      // --------------------------------------------------- ссылка в поле ввода
      //
      // The token itself is built by `mentionText`. The lines ride in the chip
      // caption (`state.js:13-19`), never in the token: a reference resolves as
      // a path, so `@file:12-40` would be read as a path with a colon in it and
      // would not open anything.
      const lineRangeBounds = (lineRange) => {
        const valid = lineRange !== undefined && typeof lineRange.start === 'number' && typeof lineRange.end === 'number'
        if (!valid) return undefined
        return {
          from: Math.max(1, Math.min(lineRange.start, lineRange.end)),
          to: Math.max(1, Math.max(lineRange.start, lineRange.end)),
        }
      }

      const lineRangeSuffix = (lineRange) => {
        const bounds = lineRangeBounds(lineRange)
        if (bounds === undefined) return ''
        return bounds.from === bounds.to ? ` (строка ${bounds.from})` : ` (строки ${bounds.from}-${bounds.to})`
      }

      // The chip caption names the file and the lines it points at, the way the
      // editor's own title does (`state.js:13-19`). It is display only: a
      // reference is a path, so the lines travel in the label, never in the ref.
      const chipCaption = (token, lineRange) => {
        const name = mentionLabel(token)
        const bounds = lineRangeBounds(lineRange)
        if (bounds === undefined) return name
        return bounds.from === bounds.to ? `${name}:${bounds.from}` : `${name}:${bounds.from}-${bounds.to}`
      }

      // A chip, not a decorated token. The `@` source only answers a click when
      // the reference arrives with an appearance (`openReference` in the shell
      // returns false for everything but `file`), and a typed `@path` carries
      // no appearance at all: the composer still draws it as a reference, but
      // the click is inert. A chip lives in the session input machine, so ask
      // that machine for one through the very event the `@` menu uses. When the
      // hook is out of reach, the plain token below remains the fallback — it
      // renders the same way, it just is not clickable.
      const INSERT_REFERENCE = 'slash/input-insert-reference'

      const insertChatChip = (token, appearance, caption, lineRange) => {
        const actions = props && props.inputActions
        const context =
          typeof services.sessionContext === 'function' ? services.sessionContext(sessionId) : undefined
        if (context === undefined || context === null || typeof context.bail !== 'function') return false
        if (!actions || typeof actions.captureInsertion !== 'function') return false
        let span
        try {
          span = actions.captureInsertion()
        } catch (cause) {
          return false
        }
        if (span === null || typeof span !== 'object' || typeof span.start !== 'number') return false
        const fallback = mentionLabel(token)
        const label =
          typeof caption === 'string' && caption !== ''
            ? caption
            : appearance === 'folder'
              ? `${fallback}/`
              : fallback
        // Ours when the shell lends the trigger service, the built-in source
        // otherwise: only ours can turn the lines into message text.
        const own = ensureChatSource()
        const reference = {
          source: own ? CHIP_SOURCE : 'reference',
          ref: own ? chipRef(token, lineRange) : token,
          label,
          appearance,
          clipboardText: token,
        }
        const request = { reference, span }
        const attempt = (run) => {
          try {
            return run() === true
          } catch (cause) {
            return false
          }
        }
        // The shell reaches this helper as `actx.bail(actx, name, request)`;
        // Cordis also exposes it bound to the context. Try the shipped shape
        // first, then the bound one, and treat a miss as "no chip here".
        return (
          attempt(() => context.bail(context, INSERT_REFERENCE, request)) ||
          attempt(() => context.bail(INSERT_REFERENCE, request))
        )
      }

      // Insert plain text at the live caret. This is the same channel the
      // composer uses for a paste: the draft keeps everything already typed,
      // and the lexical text-ref decoration turns the token into a reference.
      const insertChatText = (text) => {
        const actions = props && props.inputActions
        if (typeof text !== 'string' || text === '') return false
        if (!actions || typeof actions.insertText !== 'function' || typeof actions.captureInsertion !== 'function') {
          return false
        }
        try {
          const span = actions.captureInsertion()
          if (span === null || typeof span !== 'object' || typeof span.start !== 'number') return false
          return actions.insertText(` ${text} `, span) === true
        } catch (cause) {
          return false
        }
      }

      const insertChatToken = (text) => {
        const actions = props && props.inputActions
        if (typeof text !== 'string' || text === '') return false
        if (!actions || typeof actions.insertText !== 'function' || typeof actions.captureInsertion !== 'function') {
          setStatus({ kind: 'error', message: 'Поле ввода чата недоступно' })
          return false
        }
        const accepted = insertChatText(text)
        setStatus(
          accepted
            ? { kind: 'ok', message: `В поле ввода: ${text}` }
            : { kind: 'error', message: 'Поле ввода занято — очистите его и повторите' },
        )
        return accepted
      }

      // Link a file (or a directory) into the draft as a clickable reference.
      const insertChatReference = (filePath, options) => {
        const settings = options === undefined ? {} : options
        const directory = settings.directory === true
        const token = mentionText(filePath, directory)
        if (token === '') return false
        const caption = chipCaption(token, settings.lineRange)
        if (insertChatChip(token, directory ? 'folder' : 'file', caption, settings.lineRange)) {
          setStatus({ kind: 'ok', message: `В поле ввода: ${caption}` })
          return true
        }
        return insertChatToken(`${token}${lineRangeSuffix(settings.lineRange)}`)
      }

      // Ask for an optional line range before sending a file to the chat, so the
      // user can point at a few lines. The prompt is a small modal; Enter (and
      // the primary button) links the file with the parsed range, the secondary
      // button quotes the lines' text instead, Escape aborts.
      const requestQuoteLines = (filePath, directory) => {
        setQuotePrompt({ path: filePath, directory: directory === true, value: '' })
      }

      const applyQuoteLines = (mode) => {
        const request = quotePrompt
        setQuotePrompt(undefined)
        if (request === undefined || typeof request.path !== 'string' || request.path === '') return
        const range = parseLineRange(request.value)
        if (request.directory === true) {
          insertChatReference(request.path, { directory: true })
          return
        }
        if (mode === 'text') void quoteFile(request.path, range)
        else insertChatReference(request.path, { lineRange: range })
      }

      // Parse "3", "3-7", "3–7" or "3,7" into an inclusive 1-based { start, end }.
      const parseLineRange = (value) => {
        if (typeof value !== 'string') return undefined
        const trimmed = value.trim()
        if (trimmed === '') return undefined
        const match = /^\s*(\d+)\s*(?:[-–,]\s*(\d+))?\s*$/.exec(trimmed)
        if (match === null) return undefined
        const start = Number(match[1])
        const end = match[2] === undefined ? start : Number(match[2])
        if (!Number.isFinite(start) || !Number.isFinite(end) || start < 1 || end < 1) return undefined
        return { start, end }
      }

      // The lines highlighted in the editor belong to the tab that is active, so
      // a mention of any other file carries the path alone. An empty selection
      // is the line the caret sits on, which is what "this line" means in the
      // status bar too.
      const selectionPatchFor = (filePath) => {
        if (activeTab === undefined) return undefined
        if (normalPath(activeTab.path) !== normalPath(filePath)) return undefined
        const editor = runtime.current.editor
        if (editor === undefined) return undefined
        const model = typeof editor.getModel === 'function' ? editor.getModel() : undefined
        const selection = typeof editor.getSelection === 'function' ? editor.getSelection() : undefined
        if (model === undefined || model === null || selection === undefined || selection === null) return undefined
        const start = Math.max(1, Math.min(selection.startLineNumber, selection.endLineNumber))
        const end = Math.min(model.getLineCount(), Math.max(selection.startLineNumber, selection.endLineNumber))
        return { start, end }
      }

      // One click in the explorer: link the file, and the highlighted lines when
      // the file is the one open in the editor. Directories always link whole.
      const addFileToChat = (filePath, directory) => {
        if (directory === true) return insertChatReference(filePath, { directory: true })
        return insertChatReference(filePath, { lineRange: selectionPatchFor(filePath) })
      }

      // Panel-level chord, so the shortcut also works while the explorer holds
      // focus (Monaco owns it once the editor does).
      const onRootKeyDown = (event) => {
        if (event.defaultPrevented === true) return
        // A chord may be a bare key; inside a text field that would eat typing.
        const target = event.target
        if (target !== null && target !== undefined) {
          const tag = typeof target.tagName === 'string' ? target.tagName : ''
          if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable === true) return
        }
        const id = matchChord(runtime.current.keymap, event)
        if (id === undefined) return
        const run = handlersRef.current[COMMAND_HANDLERS[id]]
        if (typeof run !== 'function') return
        event.preventDefault()
        run()
      }


      // Drop target for a row dragged out of the explorer. The transfer already
      // carries the mention token (`@file`, `@dir/`), so the panel just hands it
      // to the composer; a drop that lands on the composer itself is handled by
      // the composer, which reads the same token out of `text/plain`.
      const mentionFromDrag = (event) => {
        const transfer = event.dataTransfer
        if (transfer === undefined || transfer === null) return undefined
        const direct = transfer.getData('application/x-dsh-ide-file')
        if (typeof direct === 'string' && direct !== '') return direct
        const plain = transfer.getData('text/plain')
        if (typeof plain === 'string' && plain !== '') return plain
        return undefined
      }

      const onEditorDragOver = (event) => {
        const token = mentionFromDrag(event)
        if (token === undefined) return
        event.preventDefault()
        event.dataTransfer.dropEffect = 'copy'
        if (dragOver !== token) setDragOver(token)
      }

      const onEditorDragLeave = (event) => {
        if (event.currentTarget !== null && event.currentTarget.contains(event.relatedTarget)) return
        setDragOver('')
      }

      const onEditorDrop = (event) => {
        const token = mentionFromDrag(event)
        setDragOver('')
        if (token === undefined) return
        event.preventDefault()
        // A plain path from another drop source is upgraded to a mention.
        const mention = token.startsWith('@') ? token : `@${token}`
        const appearance = mention.endsWith('/') ? 'folder' : 'file'
        if (!insertChatChip(mention, appearance)) insertChatToken(mention)
      }

      const saveKey = async (key) => {
        const target = stateRef.current.tabs.find((candidate) => candidate.key === key)
        const model = runtime.current.models.get(key)
        if (target === undefined || model === undefined) return false
        if (target.readOnly) {
          setStatus({ kind: 'error', message: 'Файл доступен только для чтения.' })
          return false
        }
        setStatus({ kind: 'busy', message: 'Сохранение…' })
        // A staged proposal lives in the buffer. Saving must write the file the
        // user actually has, never the lines a hint is still offering.
        if (runtime.current.tab.phantom !== undefined && runtime.current.editor !== undefined && runtime.current.editor.getModel() === model) {
          clearGhost()
        }
        try {
          const payload = await call('save', {
            id: target.hostId,
            sessionId: stateRef.current.sessionId,
            token: target.token,
            text: model.getValue(),
          })
          setTabs((previous) => previous.map((candidate) => (candidate.key === key ? { ...candidate, token: payload.token, dirty: false } : candidate)))
          setChanges((previous) => previous.map((change) => (change.path === target.path ? { ...change, saved: true } : change)))
          setStatus({ kind: 'ok', message: `Сохранено: ${target.name}` })
          return true
        } catch (cause) {
          setStatus({ kind: 'error', message: describeError(cause) })
          return false
        }
      }

      const pathOfTab = (key) => {
        const entry = stateRef.current.tabs.find((candidate) => candidate.key === key)
        return entry === undefined ? '' : entry.path
      }

      // Session memory of accepted edits. Only the changed region is kept, so a
      // big file does not cost its whole text per edit; the history dies with
      // the session and is never presented as a disk checkpoint.
      const recordChange = (key, path, beforeText, afterText) => {
        const region = changedRegion(beforeText, afterText)
        if (region === undefined) return
        const end = region.start + region.after.length
        setChanges((previous) =>
          [
            {
              id: (runtime.current.changeSeq += 1),
              key,
              path,
              start: region.start,
              before: region.before,
              after: region.after,
              ctxBefore: afterText.slice(Math.max(0, region.start - 24), region.start),
              ctxAfter: afterText.slice(end, end + 24),
              at: new Date().toLocaleTimeString('ru-RU'),
              saved: false,
              reverted: false,
            },
            ...previous,
          ].slice(0, 40),
        )
      }

      const openChange = (change) => {
        const entry = stateRef.current.tabs.find((candidate) => normalPath(candidate.path) === normalPath(change.path))
        const model = entry === undefined ? undefined : runtime.current.models.get(entry.key)
        if (model !== undefined) {
          const position = model.getPositionAt(Math.min(change.start, model.getValueLength()))
          runtime.current.pendingReveal = { path: normalPath(change.path), line: position.lineNumber }
        } else {
          runtime.current.pendingReveal = { path: normalPath(change.path), offset: change.start }
        }
        void openFile(change.path, { activate: true })
      }

      // Reverting works by file path, not by the model that happens to be focused:
      // a preview, a closed tab or a switched tab must not turn the button into a
      // silent no-op. Every refusal says why.
      const revertChange = (change) => {
        const path = normalPath(change.path === undefined ? '' : change.path)
        const entry = path === '' ? undefined : stateRef.current.tabs.find((candidate) => normalPath(candidate.path) === path)
        if (entry === undefined) {
          setStatus({ kind: 'error', message: 'Файл закрыт — откройте его и нажмите «Вернуть» ещё раз.' })
          if (path !== '') openChange(change)
          return
        }
        const model = runtime.current.models.get(entry.key)
        if (model === undefined) {
          setStatus({ kind: 'error', message: 'Файл закрыт — откройте его и нажмите «Вернуть» ещё раз.' })
          openChange(change)
          return
        }
        if (stateRef.current.activeKey !== entry.key) {
          openChange(change)
          setStatus({ kind: 'ok', message: `Открыл ${path} — нажмите «Вернуть» ещё раз.` })
          return
        }
        // The recorded offset is only a hint. Accepting a hint can move the rest
        // of the buffer (staged phantom lines are rewritten in the same undo
        // step), so the edited region is located again by its own text and the
        // 24-character context on both sides. Exactly one match is required: two
        // identical candidates are not a guess the button is allowed to make.
        const text = model.getValue()
        const locate = () => {
          const before = change.ctxBefore
          const after = change.ctxAfter
          if (change.after !== '') {
            const hits = []
            let at = text.indexOf(change.after)
            while (at !== -1) {
              if (
                text.slice(Math.max(0, at - before.length), at) === before &&
                text.slice(at + change.after.length, at + change.after.length + after.length) === after
              ) {
                hits.push(at)
              }
              at = text.indexOf(change.after, at + 1)
            }
            return hits.length === 1 ? hits[0] : undefined
          }
          const anchor = `${before}${after}`
          if (anchor === '') return undefined
          const hits = []
          let at = text.indexOf(anchor)
          while (at !== -1) {
            hits.push(at + before.length)
            at = text.indexOf(anchor, at + 1)
          }
          return hits.length === 1 ? hits[0] : undefined
        }
        const start = locate()
        if (start === undefined) {
          setStatus({ kind: 'error', message: 'Файл изменился — вернуть правку нельзя, откройте сравнение.' })
          setChanges((previous) => previous.map((candidate) => (candidate.id === change.id ? { ...candidate, error: 'текст изменился' } : candidate)))
          return
        }
        const end = start + change.after.length
        const monaco = runtime.current.monaco
        const editor = runtime.current.editor
        if (monaco === undefined || editor === undefined) {
          setStatus({ kind: 'error', message: 'Редактор ещё не готов — попробуйте ещё раз.' })
          return
        }
        const startPosition = model.getPositionAt(start)
        const endPosition = model.getPositionAt(end)
        const range = new monaco.Range(startPosition.lineNumber, startPosition.column, endPosition.lineNumber, endPosition.column)
        runtime.current.tab.internalEdit = true
        try {
          if (editor.getModel() !== model) editor.setModel(model)
          editor.pushUndoStop()
          editor.executeEdits('dsh-ide-revert', [{ range, text: change.before }])
          editor.pushUndoStop()
        } catch (cause) {
          setStatus({ kind: 'error', message: `Не удалось вернуть правку: ${messageOf(cause)}` })
          return
        } finally {
          runtime.current.tab.internalEdit = false
        }
        setChanges((previous) =>
          previous.map((candidate) => (candidate.id === change.id ? { ...candidate, reverted: true, saved: false, error: undefined } : candidate)),
        )
        setTabs((previous) => previous.map((candidate) => (candidate.key === entry.key ? { ...candidate, dirty: true } : candidate)))
        setStatus({ kind: 'ok', message: `Правка возвращена: ${path} (Ctrl+Z отменит сам возврат)` })
      }

      const saveAll = async () => {
        const dirty = stateRef.current.tabs.filter((candidate) => candidate.dirty)
        for (const candidate of dirty) await saveKey(candidate.key)
        return true
      }

      const removeTabs = (keys) => {
        const removing = new Set(keys)
        if (removing.size === 0) return
        for (const key of removing) {
          const model = runtime.current.models.get(key)
          const editor = runtime.current.editor
          if (model !== undefined) {
            if (editor !== undefined && editor.getModel() === model) editor.setModel(null)
            runtime.current.modelTabs.delete(model.uri.toString())
            model.dispose()
            runtime.current.models.delete(key)
          }
          runtime.current.views.delete(key)
          dirtyTabs.delete(key)
        }
        const current = stateRef.current.tabs
        const next = current.filter((candidate) => !removing.has(candidate.key))
        const active = stateRef.current.activeKey
        setTabs(next)
        if (removing.has(active)) {
          const index = current.findIndex((candidate) => candidate.key === active)
          if (next.length === 0) setActiveKey('')
          else setActiveKey((next[Math.min(Math.max(index, 0), next.length - 1)] || next[0]).key)
        }
      }

      const removeTab = (key) => {
        removeTabs([key])
      }

      const closeTab = (key) => {
        const target = stateRef.current.tabs.find((candidate) => candidate.key === key)
        if (target === undefined) return
        if (target.dirty) {
          setDialog({ mode: 'close-tab', key })
          return
        }
        removeTab(key)
      }

      const closeActive = () => {
        if (stateRef.current.activeKey !== '') closeTab(stateRef.current.activeKey)
      }

      const saveActive = async () => {
        if (stateRef.current.activeKey === '') return false
        return saveKey(stateRef.current.activeKey)
      }

      const closePane = () => {
        try {
          if (tab && tab.actions && typeof tab.actions.close === 'function') tab.actions.close()
        } catch {
          /* the pane is already gone */
        }
      }

      const pushTrace = React.useCallback((record) => {
        setTrace((current) => [record, ...current].slice(0, 60))
      }, [])

      const toggleOutput = React.useCallback(() => {
        setPanel((current) => (current === undefined ? { tab: 'trajectory', index: 0 } : undefined))
      }, [])

      // ---------------------------------------------------------------------
      // Tab suggestions
      //
      // The Host does the reasoning: it asks the model, plans a concrete edit
      // (an insertion or a small replacement) and filters it through the
      // bad-case checks ported from Cursor's `cppBadHeuristics`. The client only
      // draws that plan, records whether it was accepted or rejected, and keeps
      // the histories those checks need. See docs/cursor-tab-mechanics.md.
      // ---------------------------------------------------------------------

      const remember = (map, key, text) => {
        if (typeof key !== 'string' || key === '' || typeof text !== 'string') return
        if (text.trim() === '' || text.length > 2000) return
        const list = map.get(key) || []
        list.push({ text, at: Date.now() })
        map.set(key, list.slice(-20))
      }

      const clearRemovedDecoration = () => {
        const editor = runtime.current.editor
        const decorations = runtime.current.tab.removedDecorations
        runtime.current.tab.removedDecorations = []
        if (editor !== undefined && decorations.length > 0) editor.deltaDecorations(decorations, [])
      }

      // A replacement hides text that the suggestion rewrites. Cursor paints
      // the part it drops; the same marker keeps the edit honest here.
      const decorateRemoved = (plan, model) => {
        clearRemovedDecoration()
        const editor = runtime.current.editor
        const monacoInstance = runtime.current.monaco
        if (editor === undefined || monacoInstance === undefined) return
        if (plan.kind !== 'replace' || plan.range.end <= plan.range.start) return
        if (tabPref('showRemovedDecorations', true) !== true) return
        const start = model.getPositionAt(plan.range.start)
        const end = model.getPositionAt(plan.range.end)
        // One line only: a multi-line marker is indistinguishable from a stray
        // selection, and the edits that matter (a rewritten empty assignment,
        // an echo of the rest of the line) never span more than one line.
        if (start.lineNumber !== end.lineNumber) return
        runtime.current.tab.removedDecorations = editor.deltaDecorations(
          [],
          [
            {
              range: new monacoInstance.Range(start.lineNumber, start.column, end.lineNumber, end.column),
              options: { className: 'dsh-ide-ghost-removed' },
            },
          ],
        )
      }

      // ---------------------------------------------------------------------
      // Phantom edits elsewhere in the file. The Host located every snippet in
      // the buffer it sent, so both ends are exact offsets of the current text;
      // the editor paints the old range and a ghost block with the replacement.
      // ---------------------------------------------------------------------

      const clearEdits = () => {
        const state = runtime.current
        const editor = state.editor
        const decorations = state.tab.editDecorations
        state.tab.editDecorations = []
        if (editor !== undefined && Array.isArray(decorations) && decorations.length > 0) {
          editor.deltaDecorations(decorations, [])
        }
        const widgets = state.tab.editWidgets
        state.tab.editWidgets = []
        if (editor !== undefined && Array.isArray(widgets)) {
          for (const widget of widgets) editor.removeContentWidget(widget)
        }
        state.tab.edits = []
      }

      // ---------------------------------------------------------------------
      // A block proposal takes room in the buffer. Drawing it as an overlay
      // printed the new text on top of the code underneath (the two lines merged
      // in the user's screenshot), so the proposed lines are inserted into the
      // model for real and the replaced lines are painted pink. Tab deletes the
      // pink lines and keeps the inserted ones, Esc deletes the inserted ones.
      // Nothing reaches the file until Tab: the buffer is only staged, and any
      // other edit reverts the staging first.
      // ---------------------------------------------------------------------
      // A block proposal takes room in the buffer, but only where it differs:
      // the unchanged lines stay exactly where they are, the lines that go away
      // keep a pink strikethrough, and the lines that arrive are inserted above
      // them in green. Inserting the whole new block duplicated every unchanged
      // line, which is what made the preview unreadable. Tab replaces the whole
      // staged region with the proposed text, Esc puts the original text back;
      // nothing reaches the file until Tab.
      // ---------------------------------------------------------------------

      const eolOf = (model) => (model.getEOL() === '\r\n' ? '\r\n' : '\n')

      // Runs a set of offset edits as one internal transaction, so the content
      // listener does not mistake the staging for typing.
      const runModelEdits = (operations) => {
        const editor = runtime.current.editor
        const monacoInstance = runtime.current.monaco
        if (editor === undefined || monacoInstance === undefined) return false
        const model = editor.getModel()
        if (model === null || operations.length === 0) return false
        const ranges = []
        for (const operation of [...operations].sort((left, right) => left.start - right.start)) {
          const start = model.getPositionAt(Math.max(0, operation.start))
          const end = model.getPositionAt(Math.max(operation.start, operation.end))
          ranges.push({
            range: new monacoInstance.Range(start.lineNumber, start.column, end.lineNumber, end.column),
            text: operation.text,
            forceMoveMarkers: true,
          })
        }
        runtime.current.tab.internalEdit = true
        // Staging is not a user edit: the buffer only holds the proposal, so
        // the tab must not look modified and cancelling must not count as a
        // reverted edit.
        runtime.current.tab.staging = true
        try {
          editor.pushUndoStop()
          editor.executeEdits('dsh-ide', ranges)
          editor.pushUndoStop()
        } finally {
          runtime.current.tab.internalEdit = false
          runtime.current.tab.staging = false
        }
        return true
      }

      /** Line-level diff: the shortest list of keep/delete/insert operations. */
      const diffLinesLocal = (before, after) => {
        const left = before.split('\n')
        const right = after.split('\n')
        const rows = left.length
        const columns = right.length
        const table = Array.from({ length: rows + 1 }, () => new Array(columns + 1).fill(0))
        for (let row = rows - 1; row >= 0; row -= 1) {
          for (let column = columns - 1; column >= 0; column -= 1) {
            table[row][column] =
              left[row] === right[column]
                ? table[row + 1][column + 1] + 1
                : Math.max(table[row + 1][column], table[row][column + 1])
          }
        }
        const ops = []
        let row = 0
        let column = 0
        while (row < rows && column < columns) {
          if (left[row] === right[column]) {
            ops.push({ type: 'same', text: left[row] })
            row += 1
            column += 1
            continue
          }
          // Adds come first when the two choices are equally good, so the new
          // lines are inserted above the ones they replace: a block answer reads
          // top-down instead of the new imports landing under the old `def`.
          if (table[row + 1][column] > table[row][column + 1]) {
            ops.push({ type: 'del', text: left[row] })
            row += 1
          } else {
            ops.push({ type: 'add', text: right[column] })
            column += 1
          }
        }
        while (row < rows) {
          ops.push({ type: 'del', text: left[row] })
          row += 1
        }
        while (column < columns) {
          ops.push({ type: 'add', text: right[column] })
          column += 1
        }
        return ops
      }

      // Cancels the staging: each staged region gets its original text back, so
      // the buffer is byte-identical to what the user had before the hint.
      const clearPhantom = () => {
        const state = runtime.current
        const editor = state.editor
        const phantom = state.tab.phantom
        state.tab.phantom = undefined
        if (editor !== undefined && phantom !== undefined && Array.isArray(phantom.decorations)) {
          editor.deltaDecorations(phantom.decorations, [])
        }
        if (phantom === undefined || editor === undefined) return false
        const model = editor.getModel()
        if (model === null || model.getVersionId() !== phantom.version) return false
        const operations = phantom.replaced.map((entry) => ({
          start: entry.start,
          end: entry.end,
          text: entry.original,
        }))
        if (operations.length === 0) return false
        return runModelEdits(operations)
      }

      const decorateEdits = (plan, model) => {
        clearPhantom()
        clearEdits()
        const editor = runtime.current.editor
        const monacoInstance = runtime.current.monaco
        const edits = Array.isArray(plan.edits) ? plan.edits : []
        if (editor === undefined || monacoInstance === undefined || edits.length === 0) return
        const eol = eolOf(model)
        const value = model.getValue()
        const blocks = []
        for (const edit of edits) {
          // The hover carries the whole proposal, so the hint stays readable
          // wherever the staged lines sit.
          const hover =
            (edit.why === '' ? 'Правка подсказки' : edit.why) + '\n\n```\n' + edit.newText + '\n```'
          // Grow the change to whole lines. Inserting in the middle of a line
          // pushes the rest of that line into a new row, and the result reads as
          // text printed over its neighbour; a whole-line region keeps every
          // row where the reader expects it.
          const startPosition = model.getPositionAt(edit.start)
          const endPosition = model.getPositionAt(edit.end)
          const lineStart = model.getOffsetAt({ lineNumber: startPosition.lineNumber, column: 1 })
          const lineEnd = model.getOffsetAt({
            lineNumber: endPosition.lineNumber,
            column: model.getLineMaxColumn(endPosition.lineNumber),
          })
          blocks.push({
            edit,
            hover,
            start: lineStart,
            end: lineEnd,
            original: value.slice(lineStart, lineEnd),
            replacement: value.slice(lineStart, edit.start) + edit.newText + value.slice(edit.end, lineEnd),
          })
        }
        // Two edits that share a line would expand onto the same rows; the Host
        // already refuses overlapping ranges, and this keeps the staging honest
        // when a model repeats a snippet in two proposals.
        const staged = []
        for (const block of blocks) {
          if (staged.some((entry) => block.start < entry.end && entry.start < block.end)) continue
          staged.push(block)
        }
        if (staged.length === 0) return
        const operations = []
        const added = []
        const removed = []
        const replaced = []
        let shift = 0
        for (const block of staged) {
          const ops = diffLinesLocal(block.original, block.replacement)
          // Where every line of the replaced block starts, relative to its start.
          const starts = [0]
          for (let index = 0; index < block.original.length; index += 1) {
            if (block.original[index] === '\n') starts.push(index + 1)
          }
          let line = 0
          let localAdd = 0
          let pending = []
          const flush = (anchor) => {
            if (pending.length === 0) return
            const text = pending.join(eol) + eol
            operations.push({ start: anchor, end: anchor, text })
            added.push({ start: anchor + shift + localAdd, end: anchor + shift + localAdd + text.length, text })
            localAdd += text.length
            pending = []
          }
          for (const op of ops) {
            const anchor = block.start + (line < starts.length ? starts[line] : block.original.length)
            if (op.type === 'add') {
              pending.push(op.text)
              continue
            }
            if (pending.length > 0) flush(block.start + (line < starts.length ? starts[line] : block.original.length))
            if (op.type === 'del') {
              const next = line < starts.length - 1 ? starts[line + 1] : block.original.length
              removed.push({
                start: block.start + starts[line] + shift + localAdd,
                end: block.start + next + shift + localAdd,
                hover: block.hover,
              })
            }
            line += 1
          }
          if (pending.length > 0) flush(block.start + block.original.length)
          // Tab rewrites the whole staged region with the proposed text, so the
          // inserted lines and the old ones are replaced in one operation.
          replaced.push({
            start: block.start + shift,
            end: block.end + shift + localAdd,
            text: block.replacement,
            original: block.original,
            edit: block.edit,
          })
          shift += localAdd
        }
        if (!runModelEdits(operations)) return
        const stagedDecorations = []
        for (const entry of added) {
          const start = model.getPositionAt(entry.start)
          const end = model.getPositionAt(entry.end)
          stagedDecorations.push({
            range: new monacoInstance.Range(start.lineNumber, 1, Math.max(start.lineNumber, end.lineNumber), 1),
            options: { isWholeLine: true, className: 'dsh-ide-edit-added' },
          })
        }
        for (const entry of removed) {
          const start = model.getPositionAt(entry.start)
          const end = model.getPositionAt(Math.max(entry.start, entry.end - 1))
          stagedDecorations.push({
            range: new monacoInstance.Range(start.lineNumber, 1, Math.max(start.lineNumber, end.lineNumber), 1),
            options: { isWholeLine: true, className: 'dsh-ide-edit-old-line', hoverMessage: { value: entry.hover } },
          })
        }
        runtime.current.tab.phantom = {
          version: model.getVersionId(),
          replaced,
          decorations: editor.deltaDecorations([], stagedDecorations),
        }
        runtime.current.tab.edits = edits
        if (runtime.current.ghostKey !== undefined) runtime.current.ghostKey.set(true)
      }

      const cancelGhostRequest = () => {
        window.clearTimeout(runtime.current.ghostTimer)
        const controller = runtime.current.tab.controller
        if (!controller) return
        runtime.current.tab.controller = undefined
        controller.abort()
        runtime.current.setHintBusy?.(false)
      }

      const complete = async (model, position, kind, signal, isCurrent) => {
        const key = runtime.current.modelTabs.get(model.uri.toString())
        const entry = stateRef.current.tabs.find((candidate) => candidate.key === key)
        const explicit = kind === 'explicit'
        if (entry === undefined || entry.readOnly) return { items: [] }
        if (kind === 'auto' && runtime.current.autoSuggest !== true) return { items: [] }
        const text = model.getValue()
        if (text.length > Number(tabPref('maxFileChars', 1000000))) return { items: [] }
        const offset = model.getOffsetAt(position)
        const version = model.getVersionId()
        const stamp = `${key}:${offset}:${version}:${kind}`
        // An explicit request is a fresh question even at an unchanged position:
        // only automatic suggestions are de-duplicated.
        if (kind === 'auto' && runtime.current.lastCompletion === stamp) return { items: [] }
        runtime.current.lastCompletion = stamp
        const rejections = (runtime.current.tab.rejections.get(key) || []).slice(-20)
        const revertions = (runtime.current.tab.revertions.get(key) || []).slice(-20)
        try {
          const payload = await call(
            'complete',
            {
              id: entry.hostId,
              sessionId: stateRef.current.sessionId,
              token: entry.token,
              text,
              offset,
              explicit,
              kind,
              modelVersion: version,
              rejections,
              revertions,
            },
            signal,
          )
          if (!isCurrent()) return
          if (payload === undefined || typeof payload.text !== 'string') return { items: [] }
          const trajectory = payload.trajectory === undefined || payload.trajectory === null ? {} : payload.trajectory
          const planKind = typeof payload.planKind === 'string' ? payload.planKind : 'insert'
          const suppressed = typeof payload.suppressed === 'string' ? payload.suppressed : ''
          const trace = {
            at: new Date().toLocaleTimeString('ru-RU'),
            path: entry.path,
            provider: payload.provider,
            model: payload.model,
            modelSource: typeof payload.modelSource === 'string' ? payload.modelSource : '',
            fellBack: payload.fellBack === true,
            effort: typeof payload.effort === 'string' ? payload.effort : '',
            explicit,
            before: asNumber(trajectory.before),
            after: asNumber(trajectory.after),
            durationMs: asNumber(payload.durationMs),
            chars: payload.text.length,
            ok: payload.text !== '',
            reason: typeof payload.reason === 'string' ? payload.reason : '',
            conversation: tabPref('fullTrace', false) ? payload.conversation : undefined,
            kind,
            planKind,
            removedChars: asNumber(trajectory.removedChars),
            suppressed,
          }
          const edits = []
          if (Array.isArray(payload.edits)) {
            for (const candidate of payload.edits.slice(0, 5)) {
              if (candidate === null || typeof candidate !== 'object') continue
              const start = asNumber(candidate.start)
              const end = asNumber(candidate.end)
              const newText = typeof candidate.newText === 'string' ? candidate.newText : ''
              if (newText === '' || end < start || end > text.length) continue
              edits.push({
                start,
                end,
                oldText: typeof candidate.oldText === 'string' ? candidate.oldText : '',
                newText,
                why: typeof candidate.why === 'string' ? candidate.why : '',
              })
            }
          }
          if (payload.text === '' && edits.length === 0) {
            // A silent empty answer is the worst failure mode: an explicit
            // request says why, an automatic one stays quiet like VS Code.
            if (explicit && typeof payload.reason === 'string' && payload.reason !== '') {
              setStatus({ kind: 'error', message: payload.reason })
            }
            pushTrace(trace)
            return { items: [] }
          }
          const range = payload.range === undefined || payload.range === null ? {} : payload.range
          const plan = {
            kind: planKind === 'replace' ? 'replace' : 'insert',
            range: { start: asNumber(range.start), end: asNumber(range.end) },
            insertText: payload.text,
            removedText: typeof payload.removedText === 'string' ? payload.removedText : '',
            edits,
            modelVersion: version,
            requestId: typeof payload.requestId === 'string' ? payload.requestId : '',
          }
          return { plan, trace }
        } catch (cause) {
          if (!isCurrent()) return
          if (cause instanceof Error && (cause.name === 'AbortError' || cause.code === 'cancelled')) return { items: [] }
          if (cause instanceof Error && cause.code === 'not-opted-in') {
            // The host only sends buffer context after the workspace opted in. The
            // reminder is a one-click consent bar instead of a dead error line.
            setConsent({ tabKey: key })
            setStatus({ kind: 'idle', message: '' })
            return { items: [] }
          }
          if (explicit) setStatus({ kind: 'error', message: describeError(cause) })
          pushTrace({
            at: new Date().toLocaleTimeString('ru-RU'),
            path: entry.path,
            provider: '—',
            model: '—',
            explicit,
            before: 0,
            after: 0,
            durationMs: 0,
            chars: 0,
            ok: false,
            reason: describeError(cause),
            kind,
          })
          return { items: [] }
        }
      }

      const clearGhostPreview = () => {
        const state = runtime.current
        if (state.ghostZone !== undefined) {
          state.editor?.changeViewZones((zones) => zones.removeZone(state.ghostZone))
          state.ghostZone = undefined
        }
        if (state.ghostDecorations.length > 0) {
          state.editor?.deltaDecorations(state.ghostDecorations, [])
          state.ghostDecorations = []
        }
        state.ghostPosition = undefined
      }

      const clearGhost = React.useCallback(() => {
        const state = runtime.current
        // Avoid any editor work on ordinary keystrokes when no hint is drawn.
        const visible =
          state.ghostPosition !== undefined ||
          state.tab.plan !== undefined ||
          state.tab.phantom !== undefined ||
          state.tab.removedDecorations.length > 0 ||
          state.tab.editWidgets.length > 0
        state.tab.plan = undefined
        state.tab.accepted = 0
        if (!visible) return
        clearGhostPreview()
        state.ghostKey?.set(false)
        clearPhantom()
        clearRemovedDecoration()
        clearEdits()
      }, [])

      const showGhost = (position, ghostText, end = position) => {
        const state = runtime.current
        const { editor, monaco } = state
        const model = editor?.getModel()
        if (!model || ghostText === '') return
        clearGhostPreview()
        const { lineNumber, column } = position
        const lines = ghostText.split(/\r\n|\r|\n/)
        const suffix = model.getLineContent(end.lineNumber).slice(end.column - 1)
        const replacing = end.lineNumber !== lineNumber || end.column !== column
        // Keep the original line readable when the proposal rewrites it or
        // would move its suffix to a new line.
        if (replacing || (lines.length > 1 && suffix !== '')) {
          lines[0] = model.getLineContent(lineNumber).slice(0, column - 1) + lines[0]
          lines[lines.length - 1] += suffix
        } else {
          const first = lines.shift()
          if (first !== '') {
            state.ghostDecorations = editor.deltaDecorations([], [{
              range: new monaco.Range(lineNumber, column, lineNumber, column),
              options: {
                showIfCollapsed: true,
                before: { content: first, inlineClassName: 'dsh-ide-ghost' },
              },
            }])
          }
        }
        if (lines.length > 0) {
          const node = document.createElement('div')
          node.className = 'dsh-ide-ghost dsh-ide-ghost-lines'
          node.textContent = lines.join('\n')
          node.style.tabSize = String(model.getOptions().tabSize)
          editor.applyFontInfo(node)
          editor.changeViewZones((zones) => {
            state.ghostZone = zones.addZone({
              afterLineNumber: end.lineNumber,
              heightInLines: lines.length,
              domNode: node,
              suppressMouseDown: true,
            })
          })
        }
        state.ghostPosition = position
        state.ghostKey?.set(true)
      }

      // Every ghost edit goes through one place: it brackets the Monaco edit with
      // undo stops and marks it as ours, so the content listener does not treat
      // it as typing and ask the model again. The cursor continuation and the
      // phantom edits are applied as one operation, which is why the edit
      // offsets from the Host never have to be recomputed after the insert.
      const applyGhostEdits = (operations, caretOffset) => {
        const editor = runtime.current.editor
        const monacoInstance = runtime.current.monaco
        if (editor === undefined || monacoInstance === undefined) return false
        const model = editor.getModel()
        if (model === null || operations.length === 0) return false
        // Monaco refuses overlapping edits in one call. The Host already drops
        // an edit that covers the cursor, but a replacement range can still meet
        // an edit on the same line; the first operation wins there.
        const ordered = [...operations].sort((left, right) => left.start - right.start)
        const accepted = []
        for (const operation of ordered) {
          const last = accepted[accepted.length - 1]
          if (last !== undefined && operation.start < last.end) continue
          accepted.push(operation)
        }
        if (accepted.length === 0) return false
        const ranges = accepted.map((operation) => {
          const start = model.getPositionAt(operation.start)
          const end = model.getPositionAt(operation.end)
          return {
            range: new monacoInstance.Range(start.lineNumber, start.column, end.lineNumber, end.column),
            text: operation.text,
            forceMoveMarkers: true,
          }
        })
        runtime.current.tab.internalEdit = true
        try {
          editor.pushUndoStop()
          editor.executeEdits('dsh-ide', ranges)
          // `executeEdits` moves the caret but leaves any selection the editor
          // had, so a hint applied while text was selected looked like the
          // selection grew. Collapse it at the end of what we inserted.
          editor.setPosition(model.getPositionAt(Math.max(0, caretOffset)))
          editor.pushUndoStop()
        } finally {
          runtime.current.tab.internalEdit = false
        }
        return true
      }

      const applyGhostEdit = (startOffset, endOffset, text) =>
        applyGhostEdits([{ start: startOffset, end: endOffset, text }], startOffset + text.length)

      const acceptGhost = () => {
        const plan = runtime.current.tab.plan
        const editor = runtime.current.editor
        if (plan === undefined || editor === undefined) return false
        const model = editor.getModel()
        if (model === null) return false
        // A staged block was inserted into the buffer already, so the model
        // version moved past the one the request was built on; the staged
        // version is the one Tab has to trust.
        const phantom = runtime.current.tab.phantom
        const expectedVersion = phantom === undefined ? plan.modelVersion : phantom.version
        if (model.getVersionId() !== expectedVersion) {
          clearGhost()
          return false
        }
        const accepted = runtime.current.tab.accepted
        const text = plan.insertText.slice(accepted)
        const edits = Array.isArray(plan.edits) ? plan.edits : []
        if (text === '' && edits.length === 0 && phantom === undefined) {
          clearGhost()
          return false
        }
        // Everything that sits below a staged region moved by the difference the
        // staging made, so an offset from the Host is shifted by it.
        const shiftAt = (offset) =>
          phantom === undefined
            ? 0
            : phantom.replaced.reduce(
                (sum, entry) => (entry.end <= offset ? sum + entry.text.length - entry.original.length : sum),
                0,
              )
        const staged = phantom === undefined ? new Set() : new Set(phantom.replaced.map((entry) => entry.edit))
        const tabKey = runtime.current.modelTabs.get(model.uri.toString())
        const entry = stateRef.current.tabs.find((candidate) => candidate.key === tabKey)
        // One transaction: the continuation at the caret plus every phantom edit
        // the Host located. Tab is one undo step, and the offsets stay valid
        // because Monaco applies the whole set together.
        const operations = []
        if (text !== '') {
          operations.push({
            start: plan.range.start + accepted + shiftAt(plan.range.start + accepted),
            end: plan.range.end + shiftAt(plan.range.end),
            text,
          })
        }
        for (const edit of edits) {
          // A block that was staged is already in the buffer; Tab only has to
          // delete the lines it replaces, which the staging recorded.
          if (staged.has(edit)) continue
          operations.push({
            start: edit.start + shiftAt(edit.start),
            end: edit.end + shiftAt(edit.end),
            text: edit.newText,
          })
        }
        if (phantom !== undefined) {
          // The staged region already holds the inserted lines and the old ones;
          // rewriting it with the proposed text leaves exactly the proposal.
          for (const entry of phantom.replaced) {
            operations.push({ start: entry.start, end: entry.end, text: entry.text })
          }
        }
        const caret = plan.range.start + plan.insertText.length + shiftAt(plan.range.start)
        const textBefore = model.getValue()
        const edited = applyGhostEdits(operations, caret)
        const textAfter = model.getValue()
        runtime.current.tab.plan = undefined
        runtime.current.tab.accepted = 0
        // Tab keeps the staged lines: drop the record before clearGhost, which
        // would otherwise treat them as a cancelled hint and delete them.
        if (phantom !== undefined) {
          runtime.current.tab.phantom = undefined
          if (Array.isArray(phantom.decorations)) editor.deltaDecorations(phantom.decorations, [])
        }
        clearGhost()
        if (!edited) return false
        recordChange(tabKey, pathOfTab(tabKey), textBefore, textAfter)
        pushTrace({
          at: new Date().toLocaleTimeString('ru-RU'),
          path: entry === undefined ? '' : entry.path,
          provider: '—',
          model: '—',
          explicit: false,
          before: 0,
          after: 0,
          durationMs: 0,
          chars: text.length,
          ok: true,
          reason:
            edits.length === 0
              ? plan.kind === 'replace'
                ? 'Принята замена (Tab)'
                : 'Принята подсказка (Tab)'
              : `Принято правок: ${edits.length} (Tab)`,
          kind: 'accepted',
          planKind: plan.kind,
          removedChars: plan.kind === 'replace' ? plan.removedText.length : 0,
          suppressed: '',
        })
        // Off by default: one suggestion, then the user decides. The setting is
        // kept for anyone who wants the next hint predicted immediately.
        if (tabPref('refetchAfterAccept', false) === true) {
          window.clearTimeout(runtime.current.ghostTimer)
          runtime.current.ghostTimer = window.setTimeout(() => {
            void requestGhost('refetch')
          }, 0)
        }
        return true
      }

      const acceptWord = () => {
        const plan = runtime.current.tab.plan
        const editor = runtime.current.editor
        if (plan === undefined || editor === undefined) return false
        if (tabPref('partialAccept', true) !== true) return acceptGhost()
        // A staged block already moved the text under the caret, so a word-by-word
        // insert would land at an offset that no longer exists: take it all.
        if (runtime.current.tab.phantom !== undefined) return acceptGhost()
        // A replacement is all or nothing: inserting only its first word would
        // keep the tail it was supposed to rewrite.
        if (plan.range.start !== plan.range.end) return acceptGhost()
        const model = editor.getModel()
        if (model === null) return false
        if (model.getVersionId() !== plan.modelVersion) {
          clearGhost()
          return false
        }
        const accepted = runtime.current.tab.accepted
        const next = nextWordEndLocal(plan.insertText, accepted)
        if (next <= accepted) return false
        const chunk = plan.insertText.slice(accepted, next)
        if (!applyGhostEdit(plan.range.start + accepted, plan.range.start + accepted, chunk)) return false
        runtime.current.tab.accepted = next
        runtime.current.tab.plan = { ...plan, modelVersion: model.getVersionId() }
        const rest = plan.insertText.slice(next)
        if (rest === '') {
          const tabKey = runtime.current.modelTabs.get(model.uri.toString())
          const entry = stateRef.current.tabs.find((candidate) => candidate.key === tabKey)
          pushTrace({
            at: new Date().toLocaleTimeString('ru-RU'),
            path: entry === undefined ? '' : entry.path,
            provider: '—',
            model: '—',
            explicit: false,
            before: 0,
            after: 0,
            durationMs: 0,
            chars: chunk.length,
            ok: true,
            reason: 'Принято слово (Ctrl+→)',
            kind: 'accepted-word',
            planKind: plan.kind,
            removedChars: 0,
            suppressed: '',
          })
          runtime.current.tab.plan = undefined
          runtime.current.tab.accepted = 0
          clearGhost()
          return true
        }
        showGhost(model.getPositionAt(plan.range.start + next), rest)
        return true
      }

      const rejectGhost = () => {
        const plan = runtime.current.tab.plan
        if (plan === undefined) return false
        const editor = runtime.current.editor
        const model = editor === undefined ? null : editor.getModel()
        const tabKey = model === null ? '' : runtime.current.modelTabs.get(model.uri.toString())
        // Cursor remembers what the user threw away and refuses to offer it again
        // for a while; the Host applies the threshold, the client keeps history.
        remember(runtime.current.tab.rejections, tabKey, plan.insertText)
        const ms = Number(tabPref('snoozeAfterRejectMs', 800))
        runtime.current.tab.snoozeUntil = Date.now() + (Number.isFinite(ms) ? Math.max(0, ms) : 800)
        const entry = stateRef.current.tabs.find((candidate) => candidate.key === tabKey)
        pushTrace({
          at: new Date().toLocaleTimeString('ru-RU'),
          path: entry === undefined ? '' : entry.path,
          provider: '—',
          model: '—',
          explicit: false,
          before: 0,
          after: 0,
          durationMs: 0,
          chars: plan.insertText.length,
          ok: false,
          reason: 'Отклонено (Escape)',
          kind: 'rejected',
          planKind: plan.kind,
          removedChars: 0,
          suppressed: '',
        })
        clearGhost()
        return true
      }

      // ------------------------------------------------------- inline edit
      // Inline Edit reviews one model replacement for one selection. The source
      // model stays untouched: the selection is painted as "old" and the
      // replacement lives in a read-only view zone until «Принять» writes it as
      // a single undoable edit. Nothing here touches the disk — saving is a
      // separate, explicit action.

      const inlineState = () => runtime.current.inlineEdit

      const publishInline = () => {
        const st = inlineState()
        setInlineView(
          st === undefined
            ? undefined
            : {
                phase: st.phase,
                key: st.key,
                instruction: st.instruction,
                error: st.error,
                proposal: st.proposal,
                addedLines: st.proposal === undefined ? 0 : st.proposal.addedLines,
                removedLines: st.proposal === undefined ? 0 : st.proposal.removedLines,
              },
        )
      }

      const clearInlineDecorations = () => {
        const st = inlineState()
        const editor = runtime.current.editor
        if (st === undefined || editor === undefined) return
        if (st.decorations !== undefined) {
          const decorations = st.decorations
          st.decorations = undefined
          try {
            editor.deltaDecorations(decorations, [])
          } catch {
            /* the model may be disposed already; decorations die with it */
          }
        }
        if (st.zone !== undefined) {
          const zone = st.zone
          st.zone = undefined
          try {
            editor.changeViewZones((accessor) => accessor.removeZone(zone))
          } catch {
            /* same for an already detached view zone */
          }
        }
      }

      const dismissInlineEdit = (reason, focus) => {
        const st = inlineState()
        if (st === undefined) return false
        clearInlineDecorations()
        st.controller?.abort()
        runtime.current.inlineEdit = undefined
        setInlineView(undefined)
        if (reason === 'typing') setStatus({ kind: 'idle', message: 'Правка отменена: файл изменился.' })
        if (focus === true) runtime.current.editor?.focus()
        return true
      }

      const openInlineEdit = () => {
        const editor = runtime.current.editor
        const monaco = runtime.current.monaco
        if (editor === undefined || monaco === undefined) return false
        const model = editor.getModel()
        if (model === null) {
          setStatus({ kind: 'error', message: 'Откройте файл, чтобы изменить выделение.' })
          return false
        }
        const key = runtime.current.modelTabs.get(model.uri.toString())
        const entry = key === undefined ? undefined : stateRef.current.tabs.find((candidate) => candidate.key === key)
        if (entry === undefined) return false
        if (entry.readOnly) {
          setStatus({ kind: 'error', message: 'Файл открыт только для чтения — правка недоступна.' })
          return false
        }
        const selection = editor.getSelection()
        if (selection === null || selection.isEmpty()) {
          setStatus({ kind: 'error', message: 'Выделите код, который нужно изменить.' })
          return false
        }
        const start = model.getOffsetAt(selection.getStartPosition())
        const end = model.getOffsetAt(selection.getEndPosition())
        const text = model.getValue()
        dismissInlineEdit('restart')
        runtime.current.inlineEdit = {
          phase: 'input',
          key,
          hostId: entry.hostId,
          token: entry.token,
          modelVersion: model.getVersionId(),
          start,
          end,
          oldText: text.slice(start, end),
          text,
          instruction: '',
          error: '',
          controller: undefined,
          decorations: undefined,
          zone: undefined,
        }
        publishInline()
        window.setTimeout(() => inlineInputRef.current?.focus(), 0)
        return true
      }

      const setInlineInstruction = (value) => {
        const st = inlineState()
        if (st === undefined || st.phase !== 'input') return
        st.instruction = value
        publishInline()
      }

      const paintInlinePreview = () => {
        const st = inlineState()
        const editor = runtime.current.editor
        const monaco = runtime.current.monaco
        if (st === undefined || st.proposal === undefined || editor === undefined || monaco === undefined) return
        const model = editor.getModel()
        if (model === null) return
        clearInlineDecorations()
        const change = st.proposal.changes[0]
        const startPosition = model.getPositionAt(change.start)
        const endPosition = model.getPositionAt(change.end)
        const range = new monaco.Range(
          startPosition.lineNumber,
          startPosition.column,
          endPosition.lineNumber,
          endPosition.column,
        )
        st.decorations = editor.deltaDecorations(
          [],
          [{ range, options: { inlineClassName: 'dsh-ide-inline-old', hoverMessage: { value: 'Этот фрагмент будет заменён' } } }],
        )
        const replacement = change.newText
        const node = document.createElement('div')
        node.className = 'dsh-ide-inline-preview'
        const head = document.createElement('div')
        head.className = 'dsh-ide-inline-preview-head'
        head.textContent =
          replacement === '' ? 'Предложение · удалить фрагмент' : `Предложение · ${replacement.split('\n').length} стр.`
        const body = document.createElement('pre')
        body.className = 'dsh-ide-inline-preview-body'
        body.textContent = replacement === '' ? 'Фрагмент будет удалён целиком.' : replacement
        node.appendChild(head)
        node.appendChild(body)
        // editor.changeViewZones() returns nothing: the zone id has to be taken
        // from the accessor, otherwise there is nothing to remove later and the
        // accepted preview stays in the buffer view forever.
        st.zone = undefined
        editor.changeViewZones((accessor) => {
          st.zone = accessor.addZone({
            afterLineNumber: endPosition.lineNumber,
            heightInLines: replacement === '' ? 2 : replacement.split('\n').length + 1,
            domNode: node,
          })
        })
      }

      const submitInlineEdit = async () => {
        const st = inlineState()
        if (st === undefined || st.phase !== 'input') return
        const instruction = st.instruction.trim()
        if (instruction === '') {
          st.error = 'Опишите, что изменить.'
          publishInline()
          inlineInputRef.current?.focus()
          return
        }
        // Tab permission is not Edit permission: the model receives a selection
        // plus an instruction only after this explicit, separate consent.
        if (prefsRef.current?.inlineEditConsent !== true) {
          st.error = 'Сначала разрешите отправку выделения модели.'
          publishInline()
          return
        }
        const editor = runtime.current.editor
        const model = editor === undefined ? null : editor.getModel()
        if (model === null) return
        if (model.getVersionId() !== st.modelVersion) {
          st.phase = 'stale'
          st.error = 'Файл изменился, запросите новую правку.'
          publishInline()
          return
        }
        st.phase = 'pending'
        st.error = ''
        const requestId = ++runtime.current.inlineSeq
        st.requestId = requestId
        const controller = new AbortController()
        st.controller = controller
        publishInline()
        try {
          const payload = await call(
            'inlineEdit',
            {
              id: st.hostId,
              sessionId: stateRef.current.sessionId,
              token: st.token,
              modelVersion: st.modelVersion,
              start: st.start,
              end: st.end,
              text: st.text,
              instruction,
            },
            controller.signal,
          )
          if (inlineState() !== st || st.requestId !== requestId) return
          st.controller = undefined
          st.proposal = payload.proposal
          st.phase = 'preview'
          paintInlinePreview()
          publishInline()
        } catch (cause) {
          if (inlineState() !== st || st.requestId !== requestId) return
          st.controller = undefined
          if (cause?.name === 'AbortError' || cause?.code === 'cancelled') st.phase = 'input'
          else {
            st.phase = 'failed'
            st.error = describeError(cause)
          }
          publishInline()
        }
      }

      const refineInlineEdit = () => {
        const st = inlineState()
        if (st === undefined) return
        clearInlineDecorations()
        st.controller?.abort()
        st.controller = undefined
        st.proposal = undefined
        st.phase = 'input'
        st.error = ''
        publishInline()
        window.setTimeout(() => inlineInputRef.current?.focus(), 0)
      }

      const allowInlineEdit = async () => {
        const st = inlineState()
        try {
          await call('prefs', { patch: { inlineEditConsent: true } })
        } catch (cause) {
          if (inlineState() === st && st !== undefined) {
            st.error = describeError(cause)
            publishInline()
          }
          return
        }
        const next = { ...(prefsRef.current ?? {}), inlineEditConsent: true }
        prefsRef.current = next
        setPreferences(next)
        if (inlineState() === st && st !== undefined) {
          st.error = ''
          publishInline()
        }
        inlineInputRef.current?.focus()
      }

      const acceptInlineEdit = () => {
        const st = inlineState()
        const editor = runtime.current.editor
        const monaco = runtime.current.monaco
        if (st === undefined || editor === undefined || monaco === undefined) return false
        if (st.phase !== 'preview' || st.proposal === undefined) return false
        const model = editor.getModel()
        if (model === null) return false
        if (runtime.current.modelTabs.get(model.uri.toString()) !== st.key) {
          dismissInlineEdit('switch')
          return false
        }
        const change = st.proposal.changes[0]
        // Version alone is not enough: the range text must still be the text the
        // model was shown. Otherwise the proposal is stale and nothing is written.
        if (model.getVersionId() !== st.modelVersion || model.getValue().slice(change.start, change.end) !== change.oldText) {
          st.phase = 'stale'
          st.error = 'Файл изменился, запросите новую правку.'
          clearInlineDecorations()
          publishInline()
          return false
        }
        const startPosition = model.getPositionAt(change.start)
        const endPosition = model.getPositionAt(change.end)
        const range = new monaco.Range(
          startPosition.lineNumber,
          startPosition.column,
          endPosition.lineNumber,
          endPosition.column,
        )
        dismissInlineEdit('accepted')
        const textBefore = model.getValue()
        runtime.current.tab.internalEdit = true
        try {
          editor.pushUndoStop()
          editor.executeEdits('dsh-ide-inline', [{ range, text: change.newText }])
          editor.pushUndoStop()
        } finally {
          runtime.current.tab.internalEdit = false
        }
        recordChange(st.key, pathOfTab(st.key), textBefore, model.getValue())
        setStatus({ kind: 'ok', message: 'Правка применена. Ctrl+Z — отменить.' })
        editor.focus()
        return true
      }

      // Monaco reports replaced ranges in the old document, highest offset first.
      // Keep the old lines of the active model; a normal keystroke updates one slot.
      const trackRemovedText = (lines, model, event, key) => {
        if (event.isFlush) return model.getLinesContent()
        for (const { range, rangeLength, text } of event.changes) {
          const first = range.startLineNumber - 1, last = range.endLineNumber - 1
          const head = lines[first].slice(0, range.startColumn - 1)
          const tail = lines[last].slice(range.endColumn - 1)
          if (key && rangeLength > 0 && rangeLength <= 2000) {
            const removed = first === last ? lines[first].slice(head.length, range.endColumn - 1) :
              [lines[first].slice(head.length), ...lines.slice(first + 1, last), lines[last].slice(0, range.endColumn - 1)].join(event.eol)
            const prefix = commonPrefixLengthLocal(removed, text)
            let end = removed.length, other = text.length
            while (end > prefix && other > prefix && removed[end - 1] === text[other - 1]) { end--; other-- }
            remember(runtime.current.tab.revertions, key, removed.slice(prefix, end))
          }
          const added = text.split(/\r\n|[\r\n]/)
          added[0] = head + added[0]
          added[added.length - 1] += tail
          if (first === last && added.length === 1) lines[first] = added[0]
          else if (added.length < 8192) lines.splice(first, last - first + 1, ...added)
          else lines = lines.slice(0, first).concat(added, lines.slice(last + 1))
        }
        return lines
      }

      const requestGhost = async (kind, triggerAt = performance.now()) => {
        const editor = runtime.current.editor
        if (editor === undefined) return
        if (kind !== 'explicit' && kind !== 'refetch' && Date.now() < runtime.current.tab.snoozeUntil) return
        if (kind === 'auto' && runtime.current.tab.plan !== undefined) return
        // A staged block lives in the buffer; the request must describe the file
        // the user actually has, not the proposal it is still deciding about.
        if (runtime.current.tab.phantom !== undefined) clearGhost()
        cancelGhostRequest()
        const model = editor.getModel()
        const position = editor.getPosition()
        if (model === null || position === null) return
        const controller = new AbortController()
        runtime.current.tab.controller = controller
        const version = model.getVersionId()
        const isCurrent = () => {
          if (controller.signal.aborted || editor.getModel() !== model || model.getVersionId() !== version) return false
          const caret = editor.getPosition()
          return caret?.lineNumber === position.lineNumber && caret.column === position.column
        }
        runtime.current.setHintBusy?.(true)
        let result
        try {
          result = await complete(model, position, kind, controller.signal, isCurrent)
        } finally {
          // A superseded response must not turn off the newer request's spinner.
          if (runtime.current.tab.controller === controller) {
            runtime.current.tab.controller = undefined
            runtime.current.setHintBusy?.(false)
          }
        }
        if (!isCurrent()) return
        if (result === undefined || result.plan === undefined) {
          clearGhost()
          return
        }
        const plan = result.plan
        if (model.getVersionId() !== plan.modelVersion) return
        const current = editor.getPosition()
        if (current === null) {
          clearGhost()
          return
        }
        const offset = model.getOffsetAt(current)
        if (offset < plan.range.start || offset > plan.range.end) {
          // The cursor moved while the model was answering.
          clearGhost()
          return
        }
        if (model.getValue().slice(plan.range.start, plan.range.end) !== plan.removedText) {
          // The text under the plan changed, so the plan no longer describes it.
          clearGhost()
          return
        }
        runtime.current.tab.plan = plan
        runtime.current.tab.accepted = 0
        decorateRemoved(plan, model)
        // The staging runs first: a block proposal inserts real lines, and the
        // ghost then has to be positioned in the buffer those lines produced.
        decorateEdits(plan, model)
        if (plan.insertText !== '') {
          const phantom = runtime.current.tab.phantom
          const shift =
            phantom === undefined
              ? 0
              : phantom.replaced.reduce(
                  (sum, entry) =>
                    entry.edit.start < plan.range.start ? sum + entry.text.length - entry.original.length : sum,
                  0,
                )
          showGhost(model.getPositionAt(plan.range.start + shift), plan.insertText, model.getPositionAt(plan.range.end + shift))
        } else {
          clearGhostPreview()
        }
        pushTrace({ ...result.trace, ok: true, displayMs: Math.round(performance.now() - triggerAt) })
      }

      const scheduleGhost = (kind = 'auto') => {
        cancelGhostRequest()
        // One suggestion at a time: while one is on screen the user either
        // accepts it or cancels it, so nothing asks the model again.
        if (runtime.current.tab.plan !== undefined) return
        if (runtime.current.autoSuggest !== true) return
        const editor = runtime.current.editor
        if (editor === undefined || !editor.hasTextFocus()) return
        const selection = editor.getSelection()
        if (selection !== null && !selection.isEmpty()) return
        const triggerAt = performance.now()
        const delay = Number(tabPref('debounceMs', 500))
        runtime.current.ghostTimer = window.setTimeout(() => {
          void requestGhost(kind, triggerAt)
        }, Number.isFinite(delay) ? Math.max(0, delay) : 500)
      }

      const enableSuggestions = async () => {
        const active = stateRef.current.tabs.find((candidate) => candidate.key === stateRef.current.activeKey)
        if (active === undefined) {
          setConsent(undefined)
          return
        }
        try {
          await call('settings', { id: active.hostId, sessionId: stateRef.current.sessionId, smartTab: true })
          setConsent(undefined)
          setStatus({ kind: 'ok', message: 'Подсказки включены для этой рабочей папки.' })
          runtime.current.tab.snoozeUntil = 0
          void requestGhost('explicit')
        } catch (cause) {
          setStatus({ kind: 'error', message: describeError(cause) })
        }
      }

      const beginPanelResize = (event) => {
        event.preventDefault()
        const startY = event.clientY
        const startHeight = panelHeight
        const move = (moveEvent) => {
          const next = Math.min(560, Math.max(90, startHeight - (moveEvent.clientY - startY)))
          setPanelHeight(next)
        }
        const finish = () => {
          window.removeEventListener('mousemove', move)
          window.removeEventListener('mouseup', finish)
        }
        window.addEventListener('mousemove', move)
        window.addEventListener('mouseup', finish)
      }

      const openQuick = () => {
        if (quick !== undefined && quick.loading !== true) {
          setQuick({ files: quick.files, loading: false, error: quick.error })
          return
        }
        setQuick({ files: [], loading: true })
        call('files', { sessionId: stateRef.current.sessionId, hidden, limit: QUICK_OPEN_LIMIT })
          .then((payload) => setQuick({ files: Array.isArray(payload.files) ? payload.files : [], loading: false }))
          .catch((cause) => setQuick({ files: [], loading: false, error: describeError(cause) }))
      }

      // Monaco is loaded once per pane; a failure is shown instead of an editor.
      React.useEffect(() => {
        loadMonaco()
          .then((instance) => setMonaco(instance))
          .catch((cause) => setStatus({ kind: 'error', message: messageOf(cause) }))
      }, [])

      React.useEffect(() => {
        if (!monaco || !hostRef.current || runtime.current.editor) return
        const editor = monaco.editor.create(hostRef.current, {
          model: null,
          automaticLayout: true,
          theme: themeName() === 'dark' ? 'vs-dark' : 'vs',
          fontSize: 13,
          lineHeight: 20,
          minimap: { enabled: false },
          tabSize: 2,
          insertSpaces: true,
          scrollBeyondLastLine: false,
          wordBasedSuggestions: 'off',
          renderLineHighlight: 'line',
          smoothScrolling: true,
          padding: { top: 8, bottom: 24 },
          inlineSuggest: { enabled: true },
          glyphMargin: true,
        })
        runtime.current.editor = editor
        runtime.current.monaco = monaco

        const hintButton = document.createElement('button')
        hintButton.type = 'button'
        hintButton.className = 'dsh-ide-hint-button'
        const setHintBusy = (busy) => {
          hintButton.textContent = busy ? '' : '💡'
          hintButton.title = busy ? 'ИИ готовит подсказку. Нажмите, чтобы отменить (Esc)' : 'Запросить подсказку ИИ (Ctrl+Space)'
          hintButton.setAttribute('aria-label', hintButton.title)
          hintButton.setAttribute('data-busy', String(busy))
        }
        setHintBusy(false)
        runtime.current.setHintBusy = setHintBusy
        // Keep the caret and editor focus: moving either invalidates a request.
        hintButton.onmousedown = (event) => { event.preventDefault(); event.stopPropagation() }
        hintButton.onclick = (event) => {
          event.stopPropagation()
          if (runtime.current.tab.controller) cancelGhostRequest()
          else void requestGhost('explicit')
          editor.focus()
        }
        let hintLine = 0
        const hintWidget = {
          getId: () => 'dsh-ide.ai-hint',
          getDomNode: () => hintButton,
          getPosition: () => ({ lane: monaco.editor.GlyphMarginLane.Right, range: new monaco.Range(hintLine, 1, hintLine, 1), zIndex: 1 }),
        }
        const syncHintLine = () => {
          const model = editor.getModel()
          const key = model && runtime.current.modelTabs.get(model.uri.toString())
          const entry = key && stateRef.current.tabs.find(tab => tab.key === key)
          const line = entry && !entry.readOnly ? editor.getPosition()?.lineNumber || 0 : 0
          if (line === hintLine) return
          const attached = hintLine !== 0
          hintLine = line
          if (!line) editor.removeGlyphMarginWidget(hintWidget)
          else if (!attached) editor.addGlyphMarginWidget(hintWidget)
          else editor.layoutGlyphMarginWidget(hintWidget)
        }
        syncHintLine()
        let oldLines = editor.getModel()?.getLinesContent() || []
        const modelChange = editor.onDidChangeModel(() => {
          oldLines = editor.getModel()?.getLinesContent() || []
          syncHintLine()
        })
        runtime.current.ghostKey =
          typeof editor.createContextKey === 'function' ? editor.createContextKey('dshIdeGhostVisible', false) : undefined

        const change = editor.onDidChangeModelContent((event) => {
          const model = editor.getModel()
          if (model === null) return
          const internal = runtime.current.tab.internalEdit === true
          const staging = runtime.current.tab.staging === true
          const key = runtime.current.modelTabs.get(model.uri.toString())
          oldLines = trackRemovedText(oldLines, model, event, !internal && !staging ? key : undefined)
          if (key !== undefined && !staging) {
            setTabs((previous) =>
              previous.map((candidate) => (candidate.key === key && !candidate.dirty ? { ...candidate, dirty: true } : candidate)),
            )
          }
          // An edit we made ourselves (Tab, Ctrl+→) must not cancel or re-ask.
          if (internal || staging) return
          if (runtime.current.inlineEdit !== undefined) dismissInlineEdit('typing')
          const tab = runtime.current.tab, plan = tab.plan
          const typed = event.changes.length === 1 ? event.changes[0] : undefined
          if (plan?.kind === 'insert' && !tab.phantom && !plan.edits.length && plan.range.start === plan.range.end &&
              !event.isFlush && !event.isUndoing && !event.isRedoing && !event.isEolChange &&
              event.versionId === plan.modelVersion + 1 && typed?.rangeLength === 0 && typed.text.length > 0 &&
              typed.rangeOffset === plan.range.start + tab.accepted && plan.insertText.startsWith(typed.text, tab.accepted) &&
              editor.getSelections()?.length === 1) {
            cancelGhostRequest()
            const offset = typed.rangeOffset + typed.text.length
            const rest = plan.insertText.slice(tab.accepted + typed.text.length)
            if (!rest) clearGhost()
            else {
              tab.accepted = 0
              tab.plan = { ...plan, range: { start: offset, end: offset }, insertText: rest, modelVersion: event.versionId }
              showGhost(model.getPositionAt(offset), rest)
            }
            return
          }
          clearGhost()
          scheduleGhost('auto')
        })
        const blur = editor.onDidBlurEditorWidget(() => {
          cancelGhostRequest()
          clearGhost()
        })
        let cursorTimer = 0
        const cursorChange = editor.onDidChangeCursorPosition((event) => {
          syncHintLine()
          if (runtime.current.tab.internalEdit === true) return
          if (runtime.current.tab.controller) cancelGhostRequest()
          const shown = runtime.current.ghostPosition
          if (shown !== undefined && (shown.lineNumber !== event.position.lineNumber || shown.column !== event.position.column)) clearGhost()
          // The status bar needs the final position, not every intermediate one.
          // A React update per mouse move re-renders the whole pane, which is
          // what made placing the cursor feel heavy. Only a changed position is
          // worth a render, and at most four times a second.
          if (cursorTimer !== 0) return
          cursorTimer = window.setTimeout(() => {
            cursorTimer = 0
            const position = editor.getPosition()
            if (position === null) return
            setCursor((current) =>
              current.line === position.lineNumber && current.column === position.column
                ? current
                : { line: position.lineNumber, column: position.column },
            )
          }, 250)
        })

        // Chords the user can remap are matched here rather than registered with
        // addCommand: a registered chord cannot be changed afterwards, and a
        // remapped one has to stop firing as well.
        if (typeof editor.onKeyDown === 'function') {
          editor.onKeyDown((event) => {
            const id = matchChord(runtime.current.keymap, event)
            if (id === undefined) return
            const run = handlersRef.current[COMMAND_HANDLERS[id]]
            if (typeof run !== 'function') return
            event.preventDefault()
            event.stopPropagation()
            run()
          })
        }
        editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Space, () => {
          handlersRef.current.openOutput?.()
          void handlersRef.current.requestGhost?.('explicit')
        })
        if (runtime.current.ghostKey !== undefined) {
          editor.addCommand(monaco.KeyCode.Tab, () => handlersRef.current.acceptGhost?.(), 'editorTextFocus && dshIdeGhostVisible')
          // Escape drops the hint, and when there is no hint it collapses a
          // selection. A selection that would not go away had no obvious way out
          // once the pane stopped reacting to clicks.
          editor.addCommand(
            monaco.KeyCode.Escape,
            () => {
              if (handlersRef.current.cancelInline?.() === true) return
              cancelGhostRequest()
              if (handlersRef.current.rejectGhost?.() === true) return
              const selection = editor.getSelection()
              if (selection !== null && !selection.isEmpty()) editor.setPosition(selection.getPosition())
            },
            'editorTextFocus',
          )
          editor.addCommand(
            monaco.KeyMod.CtrlCmd | monaco.KeyCode.RightArrow,
            () => handlersRef.current.acceptWord?.(),
            'editorTextFocus && dshIdeGhostVisible',
          )
        }
        // Settings, the trace panel and the quote command are dispatched above,
        // from the same remappable keymap.
        // Inline Edit. The chord comes from the keymap (Ctrl+Shift+K by default,
        // remappable in settings); the action only puts the command in Monaco's
        // own context menu.
        editor.addAction({
          id: 'dsh-ide.inline-edit',
          label: 'Изменить выделение…',
          contextMenuGroupId: '1_modification',
          contextMenuOrder: 1,
          precondition: 'editorTextFocus',
          run: () => handlersRef.current.openInlineEdit?.(),
        })
        // Link the active file and the lines highlighted in it into the chat.
        // An action, not a bare command: the same declaration draws the entry in
        // Monaco's own context menu; the chord is dispatched from the keymap.
        editor.addAction({
          id: 'dsh-ide.add-to-chat',
          label: 'Добавить в чат',
          contextMenuGroupId: '1_modification',
          contextMenuOrder: 0.5,
          precondition: 'editorTextFocus',
          run: () => handlersRef.current.addToChat?.(),
        })

        return () => {
          cancelGhostRequest()
          window.clearTimeout(cursorTimer)
          modelChange.dispose()
          if (hintLine) editor.removeGlyphMarginWidget(hintWidget)
          runtime.current.setHintBusy = undefined
          blur.dispose()
          change.dispose()
          cursorChange.dispose()
          editor.dispose()
          runtime.current.editor = undefined
        }
      }, [monaco])

      // Keep the active tab bound to the editor, one model per tab.
      //
      // The dependency list is deliberately `[activeKey, monaco]`: marking a tab
      // dirty rewrites `tabs` on every keystroke, and with `tabs` here this whole
      // effect (clearGhost, updateOptions, focus) ran for every character typed,
      // which is what made the editor feel like it was waiting for something.
      React.useEffect(() => {
        cancelGhostRequest()
        clearGhost()
        dismissInlineEdit('switch')
        const editor = runtime.current.editor
        if (!editor || !monaco || activeKey === '') return
        const entry = stateRef.current.tabs.find((candidate) => candidate.key === activeKey)
        if (entry === undefined) return
        let model = runtime.current.models.get(activeKey)
        if (model === undefined) {
          model = monaco.editor.createModel(entry.text, entry.language, monaco.Uri.parse(`inmemory://dsh-ide/${encodeURIComponent(activeKey)}`))
          runtime.current.models.set(activeKey, model)
          runtime.current.modelTabs.set(model.uri.toString(), activeKey)
        }
        if (editor.getModel() !== model) {
          if (editor.getModel() !== null) runtime.current.views.set(runtime.current.activeKey, editor.saveViewState())
          editor.setModel(model)
          const view = runtime.current.views.get(activeKey)
          if (view !== undefined && view !== null) {
            editor.restoreViewState(view)
            // A saved view state carries the selection as well as the scroll
            // offset. A selection the user made once used to come back with the
            // tab and looked like it could not be dismissed, so only the caret
            // position is restored here.
            const restored = editor.getPosition()
            if (restored !== null) editor.setPosition(restored)
          } else {
            // A fresh tab has no view state, and Monaco keeps the selection of the
            // model it replaced. Opening a second file after selecting text in the
            // first one therefore started with the old selection over the new
            // buffer, which looked like everything being highlighted.
            editor.setSelection(new monaco.Selection(1, 1, 1, 1))
            editor.setScrollTop(0)
          }
          runtime.current.activeKey = activeKey
          const position = editor.getPosition()
          if (position !== null) setCursor({ line: position.lineNumber, column: position.column })
          editor.focus()
        }
        editor.updateOptions({ readOnly: entry.readOnly === true })
      }, [activeKey, monaco])

      // The close guard reads this set synchronously; keep it in step with react.
      React.useEffect(() => {
        dirtyTabs.clear()
        for (const candidate of tabs) if (candidate.dirty) dirtyTabs.add(candidate.key)
      }, [tabs])

      // The changes pane reads the Host's checkpoint index when it opens: a turn
      // that happened while the pane was closed shows up on the next open, and a
      // closed pane costs no reads at all.
      React.useEffect(() => {
        if (!changesOpen) return undefined
        if (typeof sessionId !== 'string' || sessionId === '') return undefined
        let cancelled = false
        setAssistant((current) => ({ ...current, phase: 'pending', error: '' }))
        call('agentChanges', { sessionId })
          .then((payload) => {
            if (cancelled) return
            setAssistant({
              phase: 'ready',
              available: payload !== null && payload.available === true,
              turns: Array.isArray(payload?.turns) ? payload.turns : [],
              error: '',
            })
          })
          .catch((cause) => {
            if (cancelled || cause?.code === 'cancelled') return
            setAssistant({ phase: 'failed', available: true, turns: [], error: describeError(cause) })
          })
        return () => {
          cancelled = true
        }
      }, [changesOpen, changesReload, sessionId])

      // Decisions on assistant turns live here rather than inside the explorer:
      // the same two buttons also sit on the side-by-side comparison, and a
      // second copy of that state would drift from this one.
      const acceptAssistant = (turn, file) => {
        const key = `${turn.seq}:${file.index}`
        // The assistant already wrote the file. Accepting records that the user
        // looked at the comparison and keeps the result; nothing is written.
        setAssistantWork((current) => ({ ...current, [key]: { phase: 'accepted', error: '' } }))
      }

      // «Принять все» is the same decision for every file of the turn: the
      // files are already on disk, so this only stops asking about them.
      const acceptAssistantAll = (turn) => {
        const files = Array.isArray(turn?.files) ? turn.files : []
        setAssistantWork((current) => {
          const next = { ...current }
          for (const file of files) next[`${turn.seq}:${file.index}`] = { phase: 'accepted', error: '' }
          return next
        })
      }

      const revertAssistant = async (turn, file) => {
        const key = `${turn.seq}:${file.index}`
        setAssistantWork((current) => ({ ...current, [key]: { phase: 'saving', error: '' } }))
        try {
          await call('agentChangeRestore', { sessionId, seq: turn.seq, index: file.index })
          setAssistantWork((current) => ({ ...current, [key]: { phase: 'reverted', error: '' } }))
          setChangesReload((value) => value + 1)
          // The comparison showed the text that was just replaced.
          setDiffView((current) => (current !== undefined && `${current.seq}:${current.index}` === key ? undefined : current))
          setStatus({ kind: 'ok', message: `Правки отменены: ${file.display || file.path}` })
        } catch (cause) {
          if (cause?.code === 'cancelled') return
          setAssistantWork((current) => ({ ...current, [key]: { phase: 'failed', error: describeError(cause) } }))
        }
      }

      // «Отменить все» reverts file by file: the Host writes one file per call,
      // so a failure on the second file keeps the first one reverted and the
      // pane shows both outcomes instead of pretending it was atomic.
      const revertAssistantAll = async (turn) => {
        const files = Array.isArray(turn?.files) ? turn.files : []
        for (const file of files) await revertAssistant(turn, file)
        setDiffView(undefined)
      }

      const openAssistantDiff = async (turn, file) => {
        if (typeof sessionId !== 'string' || sessionId === '') return
        // `files` keeps the whole turn in the footer list, so «Принять все» and
        // «Отменить все» act on the same set the pane shows.
        setDiffView({
          phase: 'pending',
          turn,
          file,
          files: Array.isArray(turn.files) ? turn.files : [],
          seq: turn.seq,
          index: file.index,
          path: file.path,
          display: file.display,
          error: '',
        })
        try {
          const payload = await call('agentChangeText', { sessionId, seq: turn.seq, index: file.index })
          setDiffView((current) => {
            if (current === undefined || current.seq !== turn.seq || current.index !== file.index) return current
            return { ...current, ...payload, phase: 'ready', error: '' }
          })
        } catch (cause) {
          if (cause?.code === 'cancelled') return
          setDiffView((current) => {
            if (current === undefined || current.seq !== turn.seq || current.index !== file.index) return current
            return { ...current, phase: 'failed', error: describeError(cause) }
          })
        }
      }

      // The explorer pane is far too narrow for two columns, so the comparison
      // opens over the editor the way Cursor shows a change before accepting it.
      const diffKey = diffView === undefined ? '' : `${diffView.phase}:${diffView.seq}:${diffView.index}`
      React.useEffect(() => {
        const container = diffContainerRef.current
        if (!monaco || diffView === undefined || diffView.phase !== 'ready' || container === undefined) return undefined
        const language = typeof diffView.language === 'string' && diffView.language !== '' ? diffView.language : 'plaintext'
        const uid = `${diffView.seq}-${diffView.index}`
        const original = monaco.editor.createModel(
          String(diffView.before ?? ''),
          language,
          monaco.Uri.parse(`inmemory://dsh-ide/diff-before/${uid}`),
        )
        const modified = monaco.editor.createModel(
          String(diffView.after ?? ''),
          language,
          monaco.Uri.parse(`inmemory://dsh-ide/diff-after/${uid}`),
        )
        const editor = monaco.editor.createDiffEditor(container, {
          readOnly: true,
          renderSideBySide: true,
          // Monaco switches a narrow diff editor to the inline (unified) view by
          // default, which is exactly what «два окна» must not do: this pane is
          // narrower than the default 900px breakpoint almost always.
          useInlineViewWhenSpaceIsLimited: false,
          renderSideBySideInlineBreakpoint: 0,
          // Same wrapping as the request: long lines must not force a horizontal
          // scroll in a pane that is shown side by side on every width.
          wordWrap: 'on',
          diffWordWrap: 'on',
          // The overview ruler is what shows where the changes are on the
          // scrollbar; without it the two columns give no map of the diff.
          renderOverviewRuler: true,
          overviewRulerBorder: false,
          renderIndicators: true,
          automaticLayout: true,
          ignoreTrimWhitespace: false,
          scrollBeyondLastLine: false,
          // `themeName()` answers 'dark'/'light', which are not Monaco theme
          // ids, so the diff fell back to the default light theme while the
          // plain editor already used vs-dark.
          theme: themeName() === 'dark' ? 'vs-dark' : 'vs',
        })
        editor.setModel({ original, modified })
        runtime.current.diffEditor = { editor, original, modified }
        return () => {
          runtime.current.diffEditor = undefined
          editor.dispose()
          original.dispose()
          modified.dispose()
        }
      }, [monaco, diffKey])

      // A search hit opens the file and then puts the caret on the matched line.
      // The reveal waits until the tab really owns the editor model, otherwise the
      // caret would land in the previous file while the new tab is still loading.
      React.useEffect(() => {
        const pending = runtime.current.pendingReveal
        if (pending === undefined) return
        const entry = tabs.find((candidate) => candidate.key === activeKey)
        if (entry === undefined || normalPath(entry.path) !== pending.path) return
        const editor = runtime.current.editor
        if (editor === undefined) return
        const model = editor.getModel()
        if (model === null || runtime.current.modelTabs.get(model.uri.toString()) !== entry.key) return
        runtime.current.pendingReveal = undefined
        const line = pending.offset === undefined
          ? Math.max(1, Math.min(pending.line, model.getLineCount()))
          : model.getPositionAt(Math.min(pending.offset, model.getValueLength())).lineNumber
        const end = pending.end === undefined ? line : Math.max(line, Math.min(pending.end, model.getLineCount()))
        if (end === line) {
          editor.setPosition({ lineNumber: line, column: 1 })
        } else {
          editor.setSelection({ startLineNumber: line, startColumn: 1, endLineNumber: end, endColumn: model.getLineMaxColumn(end) })
        }
        if (typeof editor.revealLineInCenterIfOutsideViewport === 'function') {
          editor.revealLineInCenterIfOutsideViewport(line)
        }
        setCursor({ line, column: 1 })
        editor.focus()
      }, [activeKey, tabs])

      React.useEffect(() => {
        if (tab === undefined || typeof tab.id !== 'string') return
        closePromptHandlers.set(tab.id, () => setDialog({ mode: 'close-pane' }))
        return () => {
          closePromptHandlers.delete(tab.id)
        }
      }, [tab === undefined ? '' : tab.id])

      // Restore the session's tabs once, then never overwrite them again.
      React.useEffect(() => {
        if (typeof sessionId !== 'string' || sessionId === '') {
          setStatus({ kind: 'error', message: 'Не удалось определить сессию: откройте IDE из вкладки документа.' })
          setBooted(true)
          return
        }
        if (booted) return
        let cancelled = false
        ;(async () => {
          try {
            const [prefsPayload, statePayload] = await Promise.all([call('prefs', {}), call('state', { sessionId })])
            if (cancelled) return
            const loaded = prefsPayload.preferences || {}
            setPreferences(loaded)
            if (typeof prefsPayload.promptDefault === 'string') setPromptDefault(prefsPayload.promptDefault)
            runtime.current.autoSuggest = loaded.autoSuggest !== false
            const saved = statePayload.state || {}
            if (typeof saved.treeWidth === 'number') setExplorerWidth(saved.treeWidth)
            if (typeof saved.panelHeight === 'number') setPanelHeight(saved.panelHeight)
        if (saved.explorerSide === 'right') setExplorerSide('right')
            setShowTree(saved.showTree !== false)
            setHidden(saved.hidden === true)
            const wanted = []
            if (initialPath !== '') wanted.push(initialPath)
            for (const candidate of Array.isArray(saved.tabs) ? saved.tabs : []) {
              if (!wanted.includes(candidate)) wanted.push(candidate)
            }
            let activated = false
            for (const candidate of wanted.slice(0, MAX_RESTORED_TABS)) {
              const entry = await openFile(candidate, { activate: false })
              if (entry !== undefined && !activated) {
                setActiveKey(entry.key)
                activated = true
              }
            }
            setBooted(true)
          } catch (cause) {
            if (!cancelled) setStatus({ kind: 'error', message: describeError(cause) })
            setBooted(true)
          }
        })()
        return () => {
          cancelled = true
        }
      }, [sessionId, initialPath, openFile, booted])

      // A new address on the same pane opens the file it names.
      React.useEffect(() => {
        if (!booted || initialPath === '') return
        void openFile(initialPath, { activate: true })
      }, [booted, initialPath, openFile])

      // Buttons request a file through `requestOpen` instead of changing the tab
      // address, so the pane only has one tab to reveal. Consume the latest
      // request when it mounts, then stay subscribed for later clicks.
      const consumedOpen = React.useRef(0)
      React.useEffect(() => {
        if (!booted || typeof sessionId !== 'string' || sessionId === '') return
        const apply = (request) => {
          if (request === undefined || request.path === '' || request.nonce <= consumedOpen.current) return
          consumedOpen.current = request.nonce
          // A chip click names lines: the caret lands there once the tab owns
          // the model, through the same one-shot reveal a search hit uses.
          if (request.lineRange !== undefined) {
            runtime.current.pendingReveal = {
              path: normalPath(request.path),
              line: request.lineRange.start,
              end: request.lineRange.end,
            }
          }
          void openFile(request.path, { activate: true })
        }
        apply(latestOpen(sessionId))
        return subscribeOpens((target, request) => {
          if (target === sessionId) apply(request)
        })
      }, [booted, sessionId, openFile])

      const tabsKey = tabs.map((candidate) => candidate.path).join('\n')
      React.useEffect(() => {
        if (!booted || typeof sessionId !== 'string' || sessionId === '') return
        const timer = window.setTimeout(() => {
          call('state', {
            sessionId,
            patch: {
              tabs: tabs.map((candidate) => candidate.path),
              active: (tabs.find((candidate) => candidate.key === activeKey) || {}).path || '',
              treeWidth: explorerWidth,
              explorerSide,
              panelHeight,
              showTree,
              hidden,
            },
          }).catch(() => {})
        }, STATE_WRITE_DELAY_MS)
        return () => window.clearTimeout(timer)
      }, [booted, sessionId, tabsKey, activeKey, explorerWidth, panelHeight, showTree, hidden, explorerSide])

      const saveSettings = async (patch) => {
        try {
          const payload = await call('prefs', { patch })
          const loaded = payload.preferences || {}
          if (prefsRef.current?.fullTrace && loaded.fullTrace !== true) {
            cancelGhostRequest()
            setTrace(rows => rows.map(({ conversation, ...metadata }) => metadata))
          }
          prefsRef.current = loaded
          setPreferences(loaded)
          if (typeof payload.promptDefault === 'string') setPromptDefault(payload.promptDefault)
          runtime.current.autoSuggest = loaded.autoSuggest !== false
          setSettingsOpen(false)
          setStatus({ kind: 'ok', message: 'Настройки сохранены' })
        } catch (cause) {
          setStatus({ kind: 'error', message: describeError(cause) })
        }
      }

      const startResize = (event) => {
        event.preventDefault()
        const startX = event.clientX
        const startWidth = explorerWidth
        const move = (moveEvent) => {
          const delta = explorerSide === 'right' ? startX - moveEvent.clientX : moveEvent.clientX - startX
          setExplorerWidth(Math.min(640, Math.max(150, startWidth + delta)))
        }
        const stop = () => {
          window.removeEventListener('mousemove', move)
          window.removeEventListener('mouseup', stop)
          document.body.style.cursor = ''
        }
        window.addEventListener('mousemove', move)
        window.addEventListener('mouseup', stop)
        document.body.style.cursor = 'col-resize'
      }

      const resolveDialog = async (mode) => {
        const current = dialog
        setDialog(undefined)
        if (current === undefined) return
        if (mode === 'cancel') return
        if (current.mode === 'delete') {
          if (mode !== 'discard') return
          try {
            await call('remove', { sessionId, path: current.path })
            const removed = stateRef.current.tabs.filter(
              (candidate) => candidate.path === current.path || candidate.path.startsWith(`${current.path}/`),
            )
            if (removed.length > 0) removeTabs(removed.map((candidate) => candidate.key))
            setReloadSignal((previous) => previous + 1)
            setStatus({ kind: 'ok', message: `Удалено: ${current.path}` })
          } catch (cause) {
            setStatus({ kind: 'error', message: describeError(cause) })
          }
          return
        }
        if (current.mode === 'close-pane') {
          if (mode === 'save') await saveAll()
          for (const candidate of stateRef.current.tabs) dirtyTabs.delete(candidate.key)
          closePane()
          return
        }
        if (current.mode === 'close-many') {
          if (mode === 'save') {
            const kept = []
            for (const key of current.keys) {
              const saved = await saveKey(key)
              if (!saved) kept.push(key)
            }
            if (kept.length > 0) {
              setStatus({ kind: 'error', message: 'Не удалось сохранить часть вкладок — они остались открытыми.' })
              removeTabs(current.keys.filter((key) => !kept.includes(key)))
              return
            }
          }
          removeTabs(current.keys)
          return
        }
        if (mode === 'save') {
          const saved = await saveKey(current.key)
          if (!saved) return
        } else {
          dirtyTabs.delete(current.key)
        }
        removeTab(current.key)
      }

      handlersRef.current = {
        saveActive,
        closeActive,
        saveAll,
        openQuick,
        complete,
        toggleOutput,
        openOutput: () => setPanel({ tab: 'trajectory', index: 0 }),
        openSettings: () => setSettingsOpen(true),
        openPalette: () => setPaletteOpen(true),
        openSearch: () => {
          setShowTree(true)
          setChangesOpen(false)
          setSearchOpen(true)
        },
        requestGhost: (kind) => void requestGhost(kind === 'explicit' ? 'explicit' : 'auto'),
        acceptGhost,
        acceptWord,
        rejectGhost,
        quoteSelection: () => quoteEditorFragment(),
        addToChat: () => {
          if (activeTab === undefined) return
          addFileToChat(activeTab.path, false)
        },
        nextTab: () => cycleTab(1),
        prevTab: () => cycleTab(-1),
        openInlineEdit: () => openInlineEdit(),
        cancelInline: () => dismissInlineEdit('esc', true),
      }

      const withEditor = (run) => {
        const editor = runtime.current.editor
        if (editor === undefined) return
        run(editor)
      }

      const runAction = (actionId) => {
        withEditor((editor) => {
          const action = editor.getAction(actionId)
          if (action !== undefined) void action.run()
        })
      }

      const closeMany = (keys) => {
        const targets = stateRef.current.tabs.filter((candidate) => keys.includes(candidate.key))
        if (targets.length === 0) return
        const dirty = targets.filter((candidate) => candidate.dirty)
        if (dirty.length > 0) {
          setDialog({ mode: 'close-many', keys: targets.map((candidate) => candidate.key) })
          return
        }
        removeTabs(targets.map((candidate) => candidate.key))
      }

      const closeAllTabs = () => closeMany(stateRef.current.tabs.map((candidate) => candidate.key))

      const closeOtherTabs = (key) => closeMany(stateRef.current.tabs.filter((candidate) => candidate.key !== key).map((candidate) => candidate.key))

      const copyText = async (value) => {
        try {
          if (navigator.clipboard === undefined) throw new Error('Буфер обмена недоступен')
          await navigator.clipboard.writeText(value)
          setStatus({ kind: 'ok', message: `Скопировано: ${value}` })
        } catch {
          setStatus({ kind: 'error', message: 'Буфер обмена недоступен в этом окне.' })
        }
      }

      const openTabMenu = (key, event) => {
        const width = typeof window === 'undefined' ? 1024 : window.innerWidth
        const height = typeof window === 'undefined' ? 768 : window.innerHeight
        setTabMenu({
          key,
          x: Math.max(4, Math.min(event.clientX, width - 220)),
          y: Math.max(4, Math.min(event.clientY, height - 200)),
        })
      }

      const cycleTab = (step) => {
        const list = stateRef.current.tabs
        if (list.length < 2) return
        const index = list.findIndex((candidate) => candidate.key === stateRef.current.activeKey)
        const next = list[(index + step + list.length) % list.length]
        setActiveKey(next.key)
      }

      const zoom = (delta) => {
        const next = Math.min(28, Math.max(9, fontSize + delta))
        setFontSize(next)
        withEditor((editor) => editor.updateOptions({ fontSize: next }))
      }

      const toggleWordWrap = () => {
        const next = !wordWrap
        setWordWrap(next)
        withEditor((editor) => editor.updateOptions({ wordWrap: next ? 'on' : 'off' }))
      }

      // Creating a file or a folder starts an inline row inside the explorer,
      // the way VS Code does it: the name is typed in place, not in a dialog.
      const createNonce = React.useRef(0)
      const beginCreate = (type, directory = '') => {
        createNonce.current += 1
        setCreateRequest({ type, directory: normalPath(directory), nonce: createNonce.current })
        setSettingsOpen(false)
        setModelDialog(false)
      }

      const submitCreate = async (type, relative) => {
        const path = normalPath(relative)
        if (path === '' || path.split('/').includes('..')) return 'Некорректное имя файла или папки.'
        try {
          await call(type === 'directory' ? 'mkdir' : 'create', { sessionId, path })
          setReloadSignal((previous) => previous + 1)
          if (type !== 'directory') await openFile(path)
          setStatus({ kind: 'ok', message: type === 'directory' ? `Создана папка: ${path}` : `Создан файл: ${path}` })
          return ''
        } catch (cause) {
          return describeError(cause)
        }
      }

      const createFile = (directory) => beginCreate('file', directory === undefined ? selectionDirectory() : directory)

      const renamePath = (path, name) => {
        setPrompt({
          title: 'Переименовать',
          label: `Новый путь для «${name}» относительно рабочей папки`,
          value: path,
          action: 'Переименовать',
          submit: async (value) => {
            const to = normalPath(value)
            if (to === '' || to === path) return
            const open = stateRef.current.tabs.find((candidate) => candidate.path === path)
            try {
              await call('rename', { sessionId, path, to })
              if (open !== undefined) {
                dirtyTabs.delete(open.key)
                removeTab(open.key)
              }
              setReloadSignal((previous) => previous + 1)
              if (open !== undefined) await openFile(to)
              setStatus({ kind: 'ok', message: `Переименовано: ${path} → ${to}` })
            } catch (cause) {
              setStatus({ kind: 'error', message: describeError(cause) })
            }
          },
        })
      }

      const deletePath = (path, name, type) => {
        setDialog({ mode: 'delete', path, name, type })
      }

      const createDirectory = (directory) => beginCreate('directory', directory === undefined ? selectionDirectory() : directory)

      // The same top-level arrangement as VS Code. Commands the IDE cannot honour
      // are disabled with the reason in their tooltip instead of being hidden.
      // Menu labels follow the live keymap: a remapped chord must not keep the
      // old default printed next to the command.
      const menuChords = resolveKeymap(keybindingsOf(preferences))
      const chordLabel = (commandId) => {
        const chord = menuChords.get(commandId)
        return chord === undefined ? undefined : chordText(chord)
      }

      const menus = [
        {
          id: 'file',
          label: 'Файл',
          items: [
            { id: 'new', label: 'Новый файл…', run: () => createFile() },
            { id: 'new-folder', label: 'Новая папка…', run: () => createDirectory() },
            { id: 'open', label: 'Открыть файл…', key: chordLabel('quick-open'), run: openQuick },
            { separator: true },
            { id: 'save', label: 'Сохранить', key: chordLabel('save'), run: () => void saveActive() },
            { id: 'save-all', label: 'Сохранить всё', key: chordLabel('save-all'), run: () => void saveAll() },
            { separator: true },
            { id: 'explain', label: 'Объяснить выделенное…', run: () => draftQuestion('explain') },
            { id: 'prepare-plan', label: 'Подготовить план…', run: () => draftQuestion('plan') },
            { separator: true },
            { id: 'close', label: 'Закрыть вкладку', key: chordLabel('close-tab'), run: closeActive },
            { id: 'close-all', label: 'Закрыть все вкладки', run: closeAllTabs },
            { separator: true },
            { id: 'refresh', label: 'Обновить дерево', run: () => setReloadSignal((previous) => previous + 1) },
            { id: 'toggle-tree', label: showTree ? 'Скрыть проводник' : 'Показать проводник', run: () => setShowTree(!showTree) },
            {
              id: 'swap-explorer',
              label: explorerSide === 'left' ? 'Проводник справа' : 'Проводник слева',
              run: () => setExplorerSide(explorerSide === 'left' ? 'right' : 'left'),
            },
            { separator: true },
            { id: 'settings', label: 'Настройки IDE…', key: chordLabel('settings'), run: () => setSettingsOpen(true) },
            { id: 'open-folder', label: 'Открыть папку…', disabled: true, hint: 'Рабочая папка задаётся сессией DSH; другая папка открывается только в новой сессии.' },
          ],
        },
        {
          id: 'edit',
          label: 'Правка',
          items: [
            { id: 'undo', label: 'Отменить', key: 'Ctrl+Z', run: () => runAction('undo') },
            { id: 'redo', label: 'Повторить', key: 'Ctrl+Y', run: () => runAction('redo') },
            { separator: true },
            { id: 'cut', label: 'Вырезать', key: 'Ctrl+X', run: () => runAction('editor.action.clipboardCutAction') },
            { id: 'copy', label: 'Копировать', key: 'Ctrl+C', run: () => runAction('editor.action.clipboardCopyAction') },
            { id: 'paste', label: 'Вставить', key: 'Ctrl+V', run: () => runAction('editor.action.clipboardPasteAction') },
            { separator: true },
            { id: 'find', label: 'Найти', key: 'Ctrl+F', run: () => runAction('actions.find') },
            { id: 'replace', label: 'Заменить', key: 'Ctrl+H', run: () => runAction('editor.action.startFindReplaceAction') },
            { id: 'format', label: 'Форматировать документ', disabled: true, hint: 'Форматирование требует языкового сервиса, которого нет в бандле.' },
          ],
        },
        {
          id: 'selection',
          label: 'Выделение',
          items: [
            { id: 'select-all', label: 'Выделить всё', key: 'Ctrl+A', run: () => runAction('editor.action.selectAll') },
            { id: 'select-line', label: 'Выделить строку', run: () => runAction('expandLineSelection') },
            { separator: true },
            { id: 'expand', label: 'Расширить выделение', key: 'Shift+Alt+→', run: () => runAction('editor.action.smartSelect.expand') },
            { id: 'shrink', label: 'Сузить выделение', key: 'Shift+Alt+←', run: () => runAction('editor.action.smartSelect.shrink') },
            { separator: true },
            { id: 'quote', label: 'Строки в чат', key: chordLabel('quote'), run: () => handlersRef.current.quoteSelection?.() },
            { id: 'inline-edit', label: 'Изменить выделение…', key: chordLabel('inline-edit'), run: () => handlersRef.current.openInlineEdit?.() },
          ],
        },
        {
          id: 'view',
          label: 'Вид',
          items: [
            { id: 'word-wrap', label: wordWrap ? 'Отключить перенос по словам' : 'Включить перенос по словам', run: toggleWordWrap },
            { id: 'palette', label: 'Палитра команд…', key: chordLabel('command-palette'), run: () => setPaletteOpen(true) },
            { id: 'hidden', label: hidden ? 'Скрыть скрытые файлы' : 'Показывать скрытые файлы', run: () => setHidden(!hidden) },
            { separator: true },
            { id: 'zoom-in', label: 'Увеличить шрифт', run: () => zoom(1) },
            { id: 'zoom-out', label: 'Уменьшить шрифт', run: () => zoom(-1) },
            { id: 'zoom-reset', label: 'Сбросить размер шрифта', run: () => zoom(13 - fontSize) },
            { separator: true },
            {
              id: 'output',
              label: panel === undefined ? 'Показать панель вывода' : 'Скрыть панель вывода',
              key: chordLabel('output'),
              run: toggleOutput,
            },
            { separator: true },
            { id: 'connect-model', label: 'Подключить модель…', run: () => setModelDialog(true) },
            { id: 'problems', label: 'Проблемы', disabled: true, hint: 'Диагностика требует языковых сервисов — их в бандле нет.' },
          ],
        },
        {
          id: 'go',
          label: 'Переход',
          items: [
            { id: 'goto-file', label: 'Перейти к файлу…', key: chordLabel('quick-open'), run: openQuick },
            { id: 'goto-line', label: 'Перейти к строке…', key: 'Ctrl+G', run: () => runAction('editor.action.gotoLine') },
            { separator: true },
            {
              id: 'file-start',
              label: 'В начало файла',
              key: 'Ctrl+Home',
              run: () => withEditor((editor) => editor.setPosition({ lineNumber: 1, column: 1 })),
            },
            {
              id: 'file-end',
              label: 'В конец файла',
              key: 'Ctrl+End',
              run: () =>
                withEditor((editor) => {
                  const model = editor.getModel()
                  if (model === undefined) return
                  const lineNumber = model.getLineCount()
                  editor.setPosition({ lineNumber, column: model.getLineMaxColumn(lineNumber) })
                }),
            },
            { separator: true },
            { id: 'next-tab', label: 'Следующая вкладка', key: 'Ctrl+Tab', run: () => cycleTab(1) },
            { id: 'prev-tab', label: 'Предыдущая вкладка', key: 'Ctrl+Shift+Tab', run: () => cycleTab(-1) },
            { separator: true },
            { id: 'definition', label: 'Перейти к определению', disabled: true, hint: 'Нужен языковой сервис (LSP), его в бандле нет; подсказку даёт только модель.' },
          ],
        },
        {
          id: 'run',
          label: 'Запуск',
          items: [
            {
              id: 'run-no-debug',
              label: 'Запуск без отладки',
              disabled: true,
              hint: 'Запуск кода в DSH выполняют терминал и инструменты агента; у IDE нет доступа к PTY.',
            },
            { id: 'run-start', label: 'Запуск с отладкой', disabled: true, hint: 'Отладчика в бандле нет.' },
            { separator: true },
            { id: 'run-config', label: 'Открыть launch.json', disabled: true, hint: 'Конфигурации запуска VS Code к IDE не применимы.' },
          ],
        },
        {
          id: 'terminal',
          label: 'Терминал',
          items: [
            {
              id: 'new-terminal',
              label: 'Новый терминал',
              disabled: true,
              hint: 'Терминал DSH открывается отдельной вкладкой правой панели: у плагина нет доступа к PTY, встроить его внутрь IDE нельзя.',
            },
          ],
        },
        {
          id: 'help',
          label: 'Справка',
          items: [
            {
              id: 'about',
              label: 'О плагине IDE',
              run: () =>
                setInfo({
                  title: 'IDE для DSH',
                  lines: [
                    'Отдельный бандл @local/dsh-ide: дерево рабочей папки, вкладки, Monaco, подсказки модели.',
                    'Проводник, вкладки и настройки свои — встроенный файловый предпросмотр DSH не используется.',
                    'Исходники и документация: github.com/bmixdev/dsh-code-editor',
                  ],
                }),
            },
            {
              id: 'shortcuts',
              label: 'Горячие клавиши',
              run: () => {
                // Built from the same table the editor dispatches, so the help
                // cannot drift from the real map.
                const keymapNow = resolveKeymap(keybindingsOf(preferences))
                const lines = []
                for (const command of KEY_COMMANDS) {
                  const chord = keymapNow.get(command.id)
                  const text = chord === undefined ? command.chord : chordText(chord)
                  lines.push(`${text} — ${command.label.toLowerCase()}`)
                }
                lines.push('Tab — принять подсказку, Esc — отклонить, Ctrl+→ — принять слово')
                lines.push('Все клавиши, кроме Tab и Esc, переназначаются: Параметры → Клавиши')
                setInfo({ title: 'Горячие клавиши', lines })
              },
            },
          ],
        },
      ]

      const activeTab = tabs.find((candidate) => candidate.key === activeKey)
      // Buttons of the comparison show the same decision as the row in the pane.
      const diffWork = diffView === undefined ? undefined : assistantWork[`${diffView.seq}:${diffView.index}`]
      const diffDecided = diffWork !== undefined && (diffWork.phase === 'accepted' || diffWork.phase === 'reverted')
      const segments = activeTab === undefined ? [] : activeTab.path.split('/')
      const statusMessage = status.kind === 'error' || status.kind === 'ok' || status.kind === 'busy' ? status.message : ''

      const tabMenuTarget = tabMenu === undefined ? undefined : tabs.find((candidate) => candidate.key === tabMenu.key)
      const tabMenuItems = tabMenuTarget === undefined
        ? []
        : [
            tabMenuTarget.dirty
              ? { id: 'save', label: 'Сохранить', run: () => void saveKey(tabMenuTarget.key) }
              : null,
            { id: 'close', label: 'Закрыть', run: () => closeTab(tabMenuTarget.key) },
            { id: 'close-others', label: 'Закрыть другие', run: () => closeOtherTabs(tabMenuTarget.key) },
            { id: 'close-all', label: 'Закрыть все', run: () => closeAllTabs() },
            { separator: true },
            { id: 'copy-path', label: 'Копировать путь', run: () => void copyText(tabMenuTarget.path) },
          ].filter(Boolean)

      return h(
        'div',
        { className: 'dsh-ide-root', 'data-theme': themeName(), onKeyDown: onRootKeyDown },
        menuId === ''
          ? null
          : h('div', {
              className: 'dsh-ide-menu-shield',
              onClick: () => setMenuId(''),
              onContextMenu: (event) => {
                event.preventDefault()
                setMenuId('')
              },
            }),
        h(
          'div',
          { className: 'dsh-ide-top' },
          h(MenuBar, { menus, openId: menuId, onOpen: setMenuId }),
          h('span', { className: 'dsh-ide-top-spacer' }),
          h(
            'button',
            {
              type: 'button',
              className: 'dsh-ide-icon-button',
              title: explorerSide === 'left' ? 'Проводник справа' : 'Проводник слева',
              'aria-label': 'Поменять местами проводник и редактор',
              onClick: () => setExplorerSide(explorerSide === 'left' ? 'right' : 'left'),
            },
            h('span', { className: 'dsh-ide-activity-glyph' }, '⇄'),
          ),
          h('span', { className: 'dsh-ide-top-title', title: activeTab === undefined ? 'IDE' : activeTab.path }, activeTab === undefined ? 'IDE' : activeTab.name),
        ),
        h(
          'div',
          { className: 'dsh-ide-body' },
          // VS Code's activity bar: one narrow rail, the panel toggles live there,
          // so the explorer can be hidden without leaving the editor.
          h(
            'div',
            { className: 'dsh-ide-activity' },
            h(
              'button',
              {
                type: 'button',
                className: `dsh-ide-activity-button${showTree ? ' dsh-ide-activity-button-active' : ''}`,
                title: showTree ? 'Скрыть проводник' : 'Показать проводник',
                onClick: () => setShowTree(!showTree),
              },
              h(
                'svg',
                { width: '18', height: '18', viewBox: '0 0 16 16', 'aria-hidden': 'true' },
                h('path', {
                  fill: 'none',
                  stroke: 'currentColor',
                  strokeWidth: '1.3',
                  d: 'M2 2.2h8.2L13 5v8.8H2zM10,2.2V5h2.6',
                }),
              ),
            ),
            h(
              'button',
              {
                type: 'button',
                className: `dsh-ide-activity-button${searchOpen ? ' dsh-ide-activity-button-active' : ''}`,
                title: 'Поиск в файлах (Ctrl+Shift+F)',
                'aria-label': 'Поиск в файлах',
                onClick: () => {
                  setShowTree(true)
                  setChangesOpen(false)
                  setSearchOpen(true)
                },
              },
              h('span', { className: 'dsh-ide-activity-glyph' }, '🔍'),
            ),
            h(
              'button',
              {
                type: 'button',
                className: `dsh-ide-activity-button${changesOpen ? ' dsh-ide-activity-button-active' : ''}`,
                title: changes.length === 0 ? 'Изменения этой сессии' : `Изменения этой сессии: ${changes.length}`,
                'aria-label': 'Изменения',
                onClick: () => {
                  setShowTree(true)
                  setSearchOpen(false)
                  setChangesOpen((open) => !open)
                },
              },
              h('span', { className: 'dsh-ide-activity-glyph' }, '🕘'),
            ),
            h('span', { className: 'dsh-ide-activity-spacer' }),
            h(
              'button',
              {
                type: 'button',
                className: 'dsh-ide-activity-button',
                title: 'Настройки IDE',
                onClick: () => setSettingsOpen(true),
              },
              h('span', { className: 'dsh-ide-activity-glyph' }, '⚙'),
            ),
          ),
          showTree && typeof sessionId === 'string'
            ? h(
                'div',
                {
                  className: `dsh-ide-explorer-wrap${explorerSide === 'right' ? ' dsh-ide-explorer-right' : ''}`,
                  style: { width: `${explorerWidth}px`, order: explorerSide === 'left' ? 0 : 2 },
                },
                h(Explorer, {
                  sessionId,
                  hidden,
                  reloadSignal,
                  activePath: activeTab === undefined ? '' : activeTab.path,
                  onOpenFile: (path, line) => {
                    if (typeof line === 'number') {
                      runtime.current.pendingReveal = { path: normalPath(path), line }
                    }
                    void openFile(path, { activate: true })
                  },
                  searchOpen,
                  onCloseSearch: () => setSearchOpen(false),
                  changesOpen,
                  changes,
                  assistant,
                  assistantWork,
                  onOpenDiff: (turn, file) => {
                    void openAssistantDiff(turn, file)
                  },
                  onAcceptAssistant: acceptAssistant,
                  onRevertAssistant: (turn, file) => {
                    void revertAssistant(turn, file)
                  },
                  onReloadChanges: () => setChangesReload((value) => value + 1),
                  onCloseChanges: () => setChangesOpen(false),
                  onOpenChange: openChange,
                  onRevertChange: revertChange,
                  onInsertReference: (path, line) => {
                    insertChatReference(path, { lineRange: { start: line, end: line } })
                  },
                  onQuoteFile: (path, directory) => {
                    addFileToChat(path, directory)
                  },
                  onQuoteLines: (path) => {
                    requestQuoteLines(path, false)
                  },
                  onToggleHidden: setHidden,
                  createRequest,
                  onCreate: submitCreate,
                  selected,
                  onSelect: (path, type) => setSelected({ path, type }),
                  onNewFile: createFile,
                  onNewFolder: createDirectory,
                  onRename: renamePath,
                  onDelete: deletePath,
                  onCopy: copyText,
                }),
              )
            : null,
          showTree && typeof sessionId === 'string'
            ? h('div', {
                className: explorerSide === 'right' ? 'dsh-ide-divider dsh-ide-divider-flip' : 'dsh-ide-divider',
                style: { order: 1 },
                title: 'Потяните, чтобы изменить ширину',
                onMouseDown: startResize,
              })
            : null,
          h(
            'div',
            {
              className: 'dsh-ide-editor',
              style: { order: explorerSide === 'left' ? 2 : 0 },
              onDragOver: onEditorDragOver,
              onDragLeave: onEditorDragLeave,
              onDrop: onEditorDrop,
            },
            dragOver === '' ? null : h('div', { className: 'dsh-ide-drop-overlay' }, h('span', { className: 'dsh-ide-drop-overlay-text' }, `Сослаться в чате: ${mentionLabel(dragOver)}`)),
            h(TabStrip, { tabs, activeKey, onActivate: setActiveKey, onClose: closeTab, onContextMenu: openTabMenu }),
            consent === undefined
              ? null
              : h(
                  'div',
                  { className: 'dsh-ide-consent' },
                  h(
                    'span',
                    { className: 'dsh-ide-consent-text' },
                    `Подсказки отправляют фрагмент файла (до ${preferences === undefined ? 4000 : preferences.contextLeft} символов до курсора и ${preferences === undefined ? 1000 : preferences.contextRight} после) модели ${preferences !== undefined && preferences.completionProvider !== '' ? preferences.completionProvider : 'сессии'}. Включить для этой рабочей папки?`,
                  ),
                  h(
                    'span',
                    { className: 'dsh-ide-consent-actions' },
                    h(
                      'button',
                      { type: 'button', className: 'dsh-ide-button dsh-ide-button-primary', onClick: () => void enableSuggestions() },
                      'Включить',
                    ),
                    h(
                      'button',
                      { type: 'button', className: 'dsh-ide-button', onClick: () => setConsent(undefined) },
                      'Не сейчас',
                    ),
                  ),
                ),
            inlineView === undefined
              ? null
              : h(
                  'div',
                  { className: 'dsh-ide-inline', 'data-phase': inlineView.phase },
                  h(
                    'span',
                    { className: 'dsh-ide-inline-label' },
                    inlineView.phase === 'preview' ? 'Предложение' : inlineView.phase === 'pending' ? 'Правка' : 'Изменить выделение',
                  ),
                  inlineView.phase === 'input' || inlineView.phase === 'pending'
                    ? h('input', {
                        ref: inlineInputRef,
                        className: 'dsh-ide-inline-input',
                        value: inlineView.instruction,
                        placeholder: 'Что изменить в выделенном коде?',
                        disabled: inlineView.phase === 'pending',
                        onChange: (event) => setInlineInstruction(event.target.value),
                        onKeyDown: (event) => {
                          if (event.key === 'Enter') {
                            event.preventDefault()
                            void submitInlineEdit()
                          } else if (event.key === 'Escape') {
                            event.preventDefault()
                            dismissInlineEdit('esc', true)
                          }
                        },
                      })
                    : null,
                  inlineView.phase === 'pending' ? h('span', { className: 'dsh-ide-inline-text' }, 'Модель готовит правку…') : null,
                  inlineView.phase === 'preview'
                    ? h('span', { className: 'dsh-ide-inline-text' }, `+${inlineView.addedLines} / −${inlineView.removedLines} строк`)
                    : null,
                  inlineView.error === '' ? null : h('span', { className: 'dsh-ide-inline-error' }, inlineView.error),
                  h(
                    'span',
                    { className: 'dsh-ide-inline-actions' },
                    inlineView.phase === 'input' && (preferences === undefined || preferences.inlineEditConsent !== true)
                      ? h(
                          'button',
                          {
                            type: 'button',
                            className: 'dsh-ide-button dsh-ide-button-primary',
                            onClick: (event) => {
                              event.preventDefault()
                              void allowInlineEdit()
                            },
                          },
                          'Разрешить',
                        )
                      : null,
                    inlineView.phase === 'input'
                      ? h(
                          'button',
                          {
                            type: 'button',
                            className: 'dsh-ide-button dsh-ide-button-primary',
                            onClick: (event) => {
                              event.preventDefault()
                              void submitInlineEdit()
                            },
                          },
                          'Отправить',
                        )
                      : null,
                    inlineView.phase === 'preview'
                      ? h(
                          'button',
                          {
                            type: 'button',
                            className: 'dsh-ide-button dsh-ide-button-primary',
                            onClick: (event) => {
                              event.preventDefault()
                              acceptInlineEdit()
                            },
                          },
                          'Принять',
                        )
                      : null,
                    inlineView.phase === 'preview'
                      ? h(
                          'button',
                          {
                            type: 'button',
                            className: 'dsh-ide-button',
                            onClick: (event) => {
                              event.preventDefault()
                              refineInlineEdit()
                            },
                          },
                          'Уточнить',
                        )
                      : null,
                    inlineView.phase === 'stale' || inlineView.phase === 'failed'
                      ? h(
                          'button',
                          {
                            type: 'button',
                            className: 'dsh-ide-button',
                            onClick: (event) => {
                              event.preventDefault()
                              dismissInlineEdit('close', true)
                            },
                          },
                          'Закрыть',
                        )
                      : null,
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'dsh-ide-button',
                        onClick: (event) => {
                          event.preventDefault()
                          dismissInlineEdit('esc', true)
                        },
                      },
                      'Отмена',
                    ),
                  ),
                ),
            h(
              'div',
              { className: 'dsh-ide-breadcrumbs' },
              segments.length === 0
                ? null
                : segments.map((segment, index) =>
                    h(
                      'span',
                      { key: `${segment}:${index}` },
                      index === 0 ? null : h('span', { className: 'dsh-ide-crumb-sep' }, '›'),
                      h('span', { className: index === segments.length - 1 ? 'dsh-ide-crumb dsh-ide-crumb-last' : 'dsh-ide-crumb' }, segment),
                    ),
                  ),
            ),
            activeTab === undefined
              ? h(
                  'div',
                  { className: 'dsh-ide-empty' },
                  h('div', { className: 'dsh-ide-watermark' }, 'IDE'),
                  h('div', { className: 'dsh-ide-empty-title' }, 'Файл не открыт'),
                  h('div', { className: 'dsh-ide-empty-text' }, explorerSide === 'left' ? 'Ctrl+P — открыть файл по имени, или выберите его в проводнике слева.' : 'Ctrl+P — открыть файл по имени, или выберите его в проводнике справа.'),
                )
              : null,
            h(
              'div',
              { className: 'dsh-ide-stage-wrap' },
              h('div', { className: 'dsh-ide-stage', ref: hostRef }),
              // Side-by-side comparison of one assistant file, drawn over the
              // editor: two panes need the width, the explorer pane has none.
            diffView === undefined
              ? null
              : h(DiffReview, {
                  view: diffView,
                  work: assistantWork,
                  onAccept: (file) => acceptAssistant(diffView.turn, file),
                  onRevert: (file) => {
                    void revertAssistant(diffView.turn, file)
                  },
                  onAcceptAll: () => acceptAssistantAll(diffView.turn),
                  onRevertAll: () => {
                    void revertAssistantAll(diffView.turn)
                  },
                  onOpenFile: (path) => {
                    void openFile(path, { activate: true })
                  },
                  onClose: () => setDiffView(undefined),
                  containerRef: diffContainerRef,
                }),
            ),
            panel === undefined ? null : h('div', { className: 'dsh-ide-panel-resize', onMouseDown: beginPanelResize }),
            panel === undefined
              ? null
              : h(OutputPanel, {
                  panel,
                  height: panelHeight,
                  trace,
                  onTab: (tab) => setPanel({ tab, index: panel.index }),
                  onSelect: (index) => setPanel({ tab: 'chat', index }),
                  onClose: () => setPanel(undefined),
                }),
            h(
              'div',
              { className: 'dsh-ide-status' },
              h('span', { className: `dsh-ide-status-text${status.kind === 'error' ? ' dsh-ide-status-error' : ''}` }, statusMessage),
              h('span', { className: 'dsh-ide-status-spacer' }),
              activeTab === undefined
                ? null
                : h('span', { className: 'dsh-ide-status-item' }, activeTab.language || 'plain'),
              activeTab === undefined ? null : h('span', { className: 'dsh-ide-status-item' }, `Стр ${cursor.line}, Стлб ${cursor.column}`),
              activeTab === undefined ? null : h('span', { className: 'dsh-ide-status-item' }, activeTab.readOnly ? 'Только чтение' : activeTab.eol === 'crlf' ? 'CRLF' : 'LF'),
              activeTab === undefined ? null : h('span', { className: 'dsh-ide-status-item' }, 'UTF-8'),
              activeTab === undefined
                ? null
                : h(
                    'button',
                    {
                      type: 'button',
                      className: 'dsh-ide-status-item dsh-ide-status-action',
                      title: `Добавить файл и выделенные строки в чат ссылкой (${ADD_TO_CHAT_KEY})`,
                      onClick: () => handlersRef.current.addToChat?.(),
                    },
                    'В чат',
                  ),
              activeTab === undefined
                ? null
                : h(
                    'button',
                    {
                      type: 'button',
                      className: 'dsh-ide-status-item dsh-ide-status-action',
                      title: 'Вставить выделение или текущую строку в чат текстом (Ctrl+L)',
                      onClick: () => void quoteEditorFragment(),
                    },
                    'Цитата',
                  ),
            ),
          ),
        ),
        settingsOpen && preferences !== undefined
          ? h(SettingsPanel, {
              preferences,
              sessionModel: catalog === undefined ? undefined : catalog.default,
              promptDefault,
              onClose: () => setSettingsOpen(false),
              onSave: saveSettings,
              onAddModel: () => setModelDialog(true),
            })
          : null,
        modelDialog && preferences !== undefined
          ? h(ModelDialog, {
              preferences,
              sessionModel: catalog === undefined ? undefined : catalog.default,
              onClose: () => setModelDialog(false),
              onConnected: async (patch) => {
                await saveSettings(patch)
                setModelDialog(false)
                setSettingsOpen(false)
              },
            })
          : null,
        paletteOpen
          ? h(CommandPalette, {
              commands: menus.flatMap((menu) =>
                menu.items
                  .filter((item) => item.separator !== true && typeof item.run === 'function')
                  .map((item) => ({
                    id: `${menu.id}:${item.id}`,
                    label: item.label,
                    group: menu.label,
                    key: item.key,
                    disabled: item.disabled === true,
                    run: item.run,
                  })),
              ),
              onPick: (entry) => {
                setPaletteOpen(false)
                entry.run()
              },
              onClose: () => setPaletteOpen(false),
            })
          : null,
        quick !== undefined
          ? h(QuickOpen, {
              files: quick.files,
              loading: quick.loading === true,
              error: quick.error,
              onPick: (path) => {
                setQuick(undefined)
                void openFile(path, { activate: true })
              },
              onClose: () => setQuick(undefined),
            })
          : null,
        dialog !== undefined
          ? h(ConfirmDialog, {
              dialog,
              onSave: () => {
                void resolveDialog('save')
              },
              onDiscard: () => {
                void resolveDialog('discard')
              },
              onCancel: () => {
                void resolveDialog('cancel')
              },
            })
          : null,
        tabMenu === undefined || tabMenuItems.length === 0
          ? null
          : h(TabContextMenu, { menu: tabMenu, items: tabMenuItems, onClose: () => setTabMenu(undefined) }),
        prompt === undefined ? null : h(PromptDialog, { prompt, onClose: () => setPrompt(undefined) }),
        info === undefined ? null : h(InfoDialog, { info, onClose: () => setInfo(undefined) }),
        quotePrompt === undefined
          ? null
          : h(
              'div',
              { className: 'dsh-ide-modal', onClick: () => setQuotePrompt(undefined) },
              h(
                'div',
                { className: 'dsh-ide-modal-card', onClick: (event) => event.stopPropagation() },
                h('div', { className: 'dsh-ide-modal-title' }, 'Добавить в чат'),
                h('div', { className: 'dsh-ide-modal-text' }, baseName(quotePrompt.path)),
                quotePrompt.directory === true
                  ? null
                  : h('input', {
                      className: 'dsh-ide-input dsh-ide-input-number',
                      type: 'text',
                      inputMode: 'numeric',
                      autoFocus: true,
                      placeholder: 'Например, 3 или 3-7 (пусто — весь файл)',
                      value: quotePrompt.value,
                      onChange: (event) => setQuotePrompt({ ...quotePrompt, value: event.target.value }),
                      onKeyDown: (event) => {
                        if (event.key === 'Enter') applyQuoteLines('reference')
                        else if (event.key === 'Escape') setQuotePrompt(undefined)
                      },
                    }),
                h(
                  'div',
                  { className: 'dsh-ide-modal-actions' },
                  h('button', { type: 'button', className: 'dsh-ide-button', onClick: () => setQuotePrompt(undefined) }, 'Отмена'),
                  quotePrompt.directory === true
                    ? null
                    : h(
                        'button',
                        { type: 'button', className: 'dsh-ide-button', onClick: () => applyQuoteLines('text') },
                        'Текст строк',
                      ),
                  h(
                    'button',
                    { type: 'button', className: 'dsh-ide-button dsh-ide-button-primary', onClick: () => applyQuoteLines('reference') },
                    'Ссылка @',
                  ),
                ),
              ),
            ),
      )
    }

    // ----------------------------------------------------------------- styles

    const STYLES = `
.dsh-ide-root { display:flex; flex-direction:column; height:100%; min-height:0; position:relative;
  --ide-bg:#1e1e1e; --ide-panel:#252526; --ide-panel-2:#2d2d2d; --ide-border:#3c3c3c; --ide-text:#cccccc;
  --ide-muted:#8a8a8a; --ide-hover:#2a2d2e; --ide-active:#37373d; --ide-select:#094771; --ide-accent:#007acc; --ide-error:#f48771;
  --ide-fg:#cccccc; --ide-fg-dim:#8a8a8a; --ide-mono:'Cascadia Code','Fira Code',Consolas,ui-monospace,monospace;
  background:var(--ide-bg); color:var(--ide-text);
  font:400 12px/1.45 var(--dsh-font-ui, system-ui, -apple-system, Segoe UI, sans-serif); }
.dsh-ide-root[data-theme="light"] { --ide-bg:#ffffff; --ide-panel:#f3f3f3; --ide-panel-2:#ececec; --ide-border:#e2e2e2;
  --ide-text:#2b2b2b; --ide-muted:#6b6b6b; --ide-hover:#e8e8e8; --ide-active:#e4e6f1; --ide-select:#cce4ff; --ide-accent:#0066bf; --ide-error:#b5200d;
  --ide-fg:#2b2b2b; --ide-fg-dim:#6b6b6b; }
.dsh-ide-root * { box-sizing:border-box; }
.dsh-ide-top { display:flex; align-items:center; gap:6px; padding:3px 8px; background:var(--ide-panel);
  border-bottom:1px solid var(--ide-border); flex:0 0 auto; min-height:32px; }
.dsh-ide-top-title { min-width:0; max-width:50%; font-weight:600; color:var(--ide-muted); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.dsh-ide-top-spacer { flex:1 1 auto; }
.dsh-ide-menu { display:flex; flex-direction:column; }
.dsh-ide-menubar { display:flex; align-items:stretch; gap:1px; position:relative; z-index:9; }
.dsh-ide-menubar-slot { position:relative; }
.dsh-ide-menubar-button { border:0; background:transparent; color:var(--ide-text); font:inherit; padding:3px 8px;
  border-radius:4px; cursor:pointer; white-space:nowrap; }
.dsh-ide-menubar-button:hover, .dsh-ide-menubar-button-active { background:var(--ide-active); }
.dsh-ide-dropdown { position:absolute; top:100%; left:0; z-index:9; min-width:250px; display:flex; flex-direction:column;
  padding:4px; background:var(--ide-panel-2); border:1px solid var(--ide-border); border-radius:6px;
  box-shadow:0 8px 24px rgba(0,0,0,.45); }
.dsh-ide-menu-shield { position:fixed; inset:0; z-index:7; }
.dsh-ide-menu-item:disabled { opacity:.5; cursor:default; }
.dsh-ide-menu-item:disabled:hover { background:transparent; color:var(--ide-text); }
.dsh-ide-menu-label { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.dsh-ide-menu-item-disabled { opacity:.5; cursor:default; }
.dsh-ide-menu-item-disabled:hover { background:transparent; color:var(--ide-text); }
.dsh-ide-menu-item { display:flex; align-items:center; justify-content:space-between; gap:18px; border:0; border-radius:4px;
  background:transparent; color:inherit; text-align:left; cursor:pointer; padding:5px 8px; font:inherit; }
.dsh-ide-menu-item:hover { background:var(--ide-accent); color:#ffffff; }
.dsh-ide-menu-key { color:var(--ide-muted); font-size:10.5px; }
.dsh-ide-menu-item:hover .dsh-ide-menu-key { color:#ffffff; }
.dsh-ide-menu-sep { height:1px; margin:4px 2px; background:var(--ide-border); }
.dsh-ide-context { position:fixed; z-index:31; min-width:210px; display:flex; flex-direction:column; padding:4px;
  background:var(--ide-panel-2); border:1px solid var(--ide-border); border-radius:6px;
  box-shadow:0 8px 24px rgba(0,0,0,.45); }
.dsh-ide-model-dialog { position:fixed; inset:0; z-index:40; display:flex; align-items:center; justify-content:center;
  background:rgba(0,0,0,.5); }
.dsh-ide-model-card { width:420px; max-width:calc(100vw - 40px); max-height:calc(100vh - 60px); overflow:auto;
  padding:20px 22px 16px; background:var(--ide-panel); border:1px solid var(--ide-border); border-radius:10px;
  box-shadow:0 18px 48px rgba(0,0,0,.55); }
.dsh-ide-model-head { display:flex; align-items:center; justify-content:space-between; gap:12px; margin-bottom:16px; }
.dsh-ide-model-title { font-size:17px; font-weight:600; }
.dsh-ide-model-close { border:0; background:transparent; color:var(--ide-muted); cursor:pointer; font-size:18px;
  line-height:1; padding:2px 6px; border-radius:4px; }
.dsh-ide-model-close:hover { background:var(--ide-hover); color:var(--ide-text); }
.dsh-ide-model-field { display:flex; flex-direction:column; gap:6px; margin-bottom:14px; }
.dsh-ide-model-label { font-weight:600; }
.dsh-ide-model-field select, .dsh-ide-model-field input { width:100%; padding:8px 10px; border:1px solid var(--ide-border);
  border-radius:6px; background:var(--ide-panel-2); color:var(--ide-text); font:inherit; }
.dsh-ide-model-field select:focus, .dsh-ide-model-field input:focus { outline:none; border-color:var(--ide-accent); }
.dsh-ide-model-hint { color:var(--ide-muted); font-size:11px; }
.dsh-ide-model-button { width:100%; margin-top:4px; padding:9px 12px; border:1px solid var(--ide-accent); border-radius:6px;
  background:var(--ide-accent); color:#ffffff; font:inherit; font-weight:600; cursor:pointer; }
.dsh-ide-model-button:disabled { opacity:.55; cursor:default; }
.dsh-ide-model-message { margin-top:10px; color:var(--ide-error); font-size:11px; }
.dsh-ide-model-ok { color:#89d185; }
.dsh-ide-model-foot { margin-top:10px; text-align:center; color:var(--ide-muted); font-size:11px; }
.dsh-ide-body { display:flex; flex:1 1 auto; min-height:0; }
.dsh-ide-activity { display:flex; flex-direction:column; align-items:center; gap:2px; flex:0 0 36px; width:36px;
  padding:4px 0; background:var(--ide-panel-2); border-right:1px solid var(--ide-border); }
.dsh-ide-activity-button { display:flex; align-items:center; justify-content:center; width:30px; height:30px; border:0;
  border-radius:4px; background:transparent; color:var(--ide-muted); cursor:pointer; padding:0; }
.dsh-ide-activity-button:hover { color:var(--ide-text); background:var(--ide-hover); }
.dsh-ide-activity-button-active { color:var(--ide-text); box-shadow:inset 2px 0 0 var(--ide-accent); }
.dsh-ide-activity-glyph { font-size:15px; line-height:1; }
.dsh-ide-activity-spacer { flex:1 1 auto; }
.dsh-ide-explorer-wrap { flex:0 0 auto; min-width:0; display:flex; background:var(--ide-panel); }
.dsh-ide-divider { flex:0 0 4px; width:4px; cursor:col-resize; background:transparent; border-right:1px solid var(--ide-border); }
.dsh-ide-divider:hover { background:var(--ide-accent); }
.dsh-ide-divider-flip { border-right:none; border-left:1px solid var(--ide-border); }
.dsh-ide-explorer-right { border-right:none; border-left:1px solid var(--ide-border); }
.dsh-ide-explorer { display:flex; flex-direction:column; width:100%; min-width:0; }
.dsh-ide-explorer-head { display:flex; align-items:center; justify-content:space-between; padding:6px 8px 4px;
  font:600 10.5px/1.4 var(--dsh-font-ui, system-ui, sans-serif); letter-spacing:.06em; text-transform:uppercase; color:var(--ide-muted); }
.dsh-ide-explorer-actions { display:flex; gap:2px; }
.dsh-ide-explorer-search { padding:0 8px 6px; }
.dsh-ide-search-input { width:100%; padding:3px 6px; border-radius:4px; color:inherit; background:var(--ide-bg);
  border:1px solid var(--ide-border); font:400 11.5px/1.5 var(--dsh-font-ui, system-ui, sans-serif); outline:none; }
.dsh-ide-search-input:focus { border-color:var(--ide-accent); }
.dsh-ide-tree { flex:1 1 auto; overflow:auto; padding:2px 0 10px; }
.dsh-ide-search-status { padding:0 8px 6px; color:var(--ide-fg-dim); font:400 10.5px/1.4 var(--dsh-font-ui, system-ui, sans-serif); }
.dsh-ide-search-file { border-bottom:1px solid var(--ide-border); padding-bottom:3px; }
.dsh-ide-search-file:last-child { border-bottom:0; }
.dsh-ide-search-file-head { display:flex; align-items:baseline; gap:6px; padding:6px 8px 3px; position:sticky; top:0;
  background:var(--ide-panel); z-index:1; }
.dsh-ide-search-file-name { font:600 11.5px/1.3 var(--dsh-font-ui, system-ui, sans-serif); color:var(--ide-fg); white-space:nowrap; }
.dsh-ide-search-file-dir { flex:1 1 auto; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
  color:var(--ide-fg-dim); font:400 10px/1.3 var(--ide-mono); }
.dsh-ide-search-file-count { flex:0 0 auto; padding:0 5px; border-radius:7px; background:var(--ide-hover);
  color:var(--ide-fg-dim); font:400 10px/1.5 var(--ide-mono); }
.dsh-ide-search-row { display:flex; align-items:center; gap:2px; padding-left:8px; }
.dsh-ide-search-row:hover { background:var(--ide-hover); }
.dsh-ide-search-hit { flex:1 1 auto; min-width:0; display:flex; align-items:baseline; gap:6px; padding:2px 6px 2px 0;
  border:0; background:transparent; color:inherit; text-align:left; cursor:pointer; font:inherit; }
.dsh-ide-search-line { flex:0 0 auto; min-width:3ch; text-align:right; color:var(--ide-fg-dim);
  font:400 10.5px/1.4 var(--ide-mono); }
.dsh-ide-search-path { color:var(--ide-fg-dim); font:400 10px/1.3 var(--ide-mono); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.dsh-ide-search-preview { flex:1 1 auto; min-width:0; color:var(--ide-fg); font:400 11px/1.35 var(--ide-mono); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.dsh-ide-search-mark { background:rgba(255, 196, 0, .32); color:inherit; border-radius:2px; }
.dsh-ide-change-hint { padding:6px 10px; color:var(--ide-fg-dim);
  font:400 10.5px/1.45 var(--dsh-font-ui, system-ui, sans-serif); }
.dsh-ide-change-list { padding:0 0 10px; }
.dsh-ide-change-section { padding:8px 10px 3px; font-size:10px; text-transform:uppercase;
  letter-spacing:.4px; color:var(--ide-fg-dim); border-top:1px solid var(--ide-border); }
.dsh-ide-change-section:first-of-type { border-top:none; }
.dsh-ide-assist-list { padding:0 0 4px; }
.dsh-ide-assist-turn { padding:5px 10px 6px; border-top:1px solid var(--ide-border); }
.dsh-ide-assist-turn-head { display:flex; align-items:baseline; justify-content:space-between; gap:8px;
  font:400 11.5px/1.5 var(--dsh-font-ui, system-ui, sans-serif); }
.dsh-ide-assist-turn-title { font-weight:600; }
.dsh-ide-assist-turn-count { color:var(--ide-fg-dim); font:400 10.5px/1.5 var(--ide-mono); }
/* A turn the recorder forgot: still visible, without actions, so the list never
   rewrites itself behind the user's back. */
.dsh-ide-assist-turn-stale { opacity:.55; }
.dsh-ide-assist-turn-stale .dsh-ide-assist-turn-title { font-weight:500; color:var(--ide-fg-dim); }
.dsh-ide-assist-file { padding-left:8px; }
.dsh-ide-assist-file-head { display:flex; align-items:baseline; gap:6px; width:100%; padding:2px 0;
  background:none; border:none; color:inherit; text-align:left; cursor:pointer;
  font:400 12px/1.5 var(--dsh-font-ui, system-ui, sans-serif); }
.dsh-ide-assist-file-head:hover { background:var(--ide-hover); }
.dsh-ide-assist-flag { padding:0 4px; border:1px solid var(--ide-border); border-radius:3px;
  color:var(--ide-fg-dim); font:400 9px/1.5 var(--ide-mono); }
.dsh-ide-assist-diff { margin:2px 0 4px 6px; max-height:260px; overflow:auto;
  background:var(--ide-bg); border:1px solid var(--ide-border); border-radius:4px; }
.dsh-ide-assist-note { padding:3px 6px; color:var(--ide-fg-dim);
  font:400 10.5px/1.5 var(--dsh-font-ui, system-ui, sans-serif); }
.dsh-ide-assist-hunk { border-top:1px solid var(--ide-border); }
.dsh-ide-assist-hunk:first-child { border-top:none; }
.dsh-ide-assist-hunk-head { padding:2px 6px; background:var(--ide-panel); color:var(--ide-fg-dim);
  font:400 10px/1.5 var(--ide-mono); }
.dsh-ide-assist-line { padding:0 6px; white-space:pre; font:400 11px/1.45 var(--ide-mono); }
.dsh-ide-assist-add { background:rgba(137, 209, 133, .14); }
.dsh-ide-assist-del { background:rgba(244, 135, 113, .14); }
.dsh-ide-stage-wrap { position:relative; flex:1 1 auto; min-height:0; display:flex; }
.dsh-ide-diffview { position:absolute; inset:0; z-index:5; display:flex; flex-direction:column;
  background:var(--ide-bg); }
.dsh-ide-diffview-head { display:flex; align-items:center; gap:8px; padding:4px 8px; flex:0 0 auto;
  border-bottom:1px solid var(--ide-border); background:var(--ide-panel); }
.dsh-ide-diffview-title { font:600 11.5px/1.5 var(--dsh-font-ui, system-ui, sans-serif); color:var(--ide-fg);
  overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.dsh-ide-diffview-sub, .dsh-ide-diffview-note { color:var(--ide-fg-dim);
  font:400 10.5px/1.5 var(--dsh-font-ui, system-ui, sans-serif); }
.dsh-ide-diffview-spacer { flex:1 1 auto; }
.dsh-ide-diffview-error { color:#f48771; font:400 10.5px/1.5 var(--dsh-font-ui, system-ui, sans-serif); }
.dsh-ide-diffview-action { padding:0 8px; border-radius:4px; cursor:pointer; border:1px solid var(--ide-border);
  background:var(--ide-panel-2); color:var(--ide-fg);
  font:400 10.5px/1.8 var(--dsh-font-ui, system-ui, sans-serif); }
.dsh-ide-diffview-action:hover:not(:disabled) { border-color:rgba(204, 204, 204, .5); }
.dsh-ide-diffview-action:disabled { opacity:.5; cursor:default; }
.dsh-ide-diffview-danger:hover:not(:disabled) { border-color:rgba(244, 135, 113, .6); }
.dsh-ide-diffview-body { flex:1 1 auto; min-height:0; }
.dsh-ide-diffview-files { flex:0 0 auto; max-height:32%; overflow:auto;
  border-top:1px solid var(--ide-border); background:var(--ide-panel); }
.dsh-ide-diffview-files-head { padding:3px 10px; color:var(--ide-fg-dim); text-transform:uppercase;
  letter-spacing:.3px; font:400 10px/1.6 var(--dsh-font-ui, system-ui, sans-serif); }
.dsh-ide-diffview-file { display:flex; align-items:baseline; gap:8px; padding:2px 10px;
  border-top:1px solid rgba(60, 60, 60, .45); }
.dsh-ide-diffview-file:hover { background:var(--ide-hover); }
.dsh-ide-assist-accept, .dsh-ide-assist-revert { padding:0 6px; border-radius:4px; cursor:pointer;
  border:1px solid var(--ide-border); background:var(--ide-panel); color:var(--ide-fg);
  font:400 10.5px/1.7 var(--dsh-font-ui, system-ui, sans-serif); }
.dsh-ide-assist-accept:hover:not(:disabled) { border-color:rgba(137, 209, 133, .6); }
.dsh-ide-assist-revert:hover:not(:disabled) { border-color:rgba(244, 135, 113, .6); }
.dsh-ide-assist-accept:disabled, .dsh-ide-assist-revert:disabled { opacity:.5; cursor:default; }
.dsh-ide-assist-work { color:var(--ide-fg-dim); font:400 10.5px/1.5 var(--dsh-font-ui, system-ui, sans-serif); }
.dsh-ide-assist-work-accepted { color:#89d185; }
.dsh-ide-assist-work-reverted { color:#dcdcaa; }
.dsh-ide-assist-work-failed { color:#f48771; }
.dsh-ide-assist-error { padding:2px 0 3px 8px; color:#f48771;
  font:400 10.5px/1.5 var(--dsh-font-ui, system-ui, sans-serif); }
.dsh-ide-change-row { padding:5px 10px; border-top:1px solid var(--ide-border); }
.dsh-ide-change-row:first-child { border-top:none; }
.dsh-ide-change-head { display:flex; align-items:baseline; gap:6px; width:100%; padding:0;
  background:none; border:none; color:inherit; text-align:left; cursor:pointer;
  font:400 12.5px/1.5 var(--dsh-font-ui, system-ui, sans-serif); }
.dsh-ide-change-name { font-weight:600; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.dsh-ide-change-dir { color:var(--ide-fg-dim); font-size:10.5px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.dsh-ide-change-meta { display:flex; flex-wrap:wrap; align-items:center; gap:8px; margin-top:2px;
  font:400 10.5px/1.5 var(--ide-font-mono, ui-monospace, monospace); }
.dsh-ide-change-added { color:#89d185; }
.dsh-ide-change-removed { color:#f48771; }
.dsh-ide-change-status { padding:0 5px; border-radius:8px; border:1px solid var(--ide-border);
  font:400 10px/1.5 var(--dsh-font-ui, system-ui, sans-serif); color:var(--ide-fg-dim); }
.dsh-ide-change-buffer { color:#dcdcaa; border-color:rgba(220, 220, 170, .45); }
.dsh-ide-change-saved { color:#89d185; border-color:rgba(137, 209, 133, .45); }
.dsh-ide-change-reverted { color:var(--ide-fg-dim); }
.dsh-ide-change-revert { margin-left:auto; padding:0 6px; border-radius:4px; cursor:pointer;
  border:1px solid var(--ide-border); background:var(--ide-panel); color:var(--ide-fg);
  font:400 10.5px/1.7 var(--dsh-font-ui, system-ui, sans-serif); }
.dsh-ide-change-revert:hover { border-color:var(--ide-accent); }
.dsh-ide-change-error { color:#f48771; }
.dsh-ide-palette-layer { position:absolute; inset:0; z-index:30; display:flex; justify-content:center;
  align-items:flex-start; padding-top:8vh; background:rgba(0, 0, 0, .35); }
.dsh-ide-palette { width:min(560px, 92%); max-height:70%; display:flex; flex-direction:column;
  background:var(--ide-panel); border:1px solid var(--ide-border); border-radius:6px; overflow:hidden;
  box-shadow:0 12px 32px rgba(0, 0, 0, .45); }
.dsh-ide-palette-input { padding:8px 10px; border:none; border-bottom:1px solid var(--ide-border);
  background:var(--ide-bg); color:var(--ide-fg); outline:none;
  font:400 13px/1.4 var(--dsh-font-ui, system-ui, sans-serif); }
.dsh-ide-palette-list { overflow:auto; padding:4px 0; }
.dsh-ide-palette-item { display:flex; align-items:baseline; gap:8px; width:100%; padding:4px 10px;
  border:none; background:none; color:var(--ide-fg); text-align:left; cursor:pointer;
  font:400 12.5px/1.5 var(--dsh-font-ui, system-ui, sans-serif); }
.dsh-ide-palette-item:hover { background:rgba(255, 255, 255, .06); }
.dsh-ide-palette-item-off { opacity:.45; cursor:default; }
.dsh-ide-palette-group { margin-left:auto; color:var(--ide-fg-dim); font-size:10.5px; }
.dsh-ide-palette-key { color:var(--ide-fg-dim); font:400 10.5px/1.5 var(--dsh-font-mono, ui-monospace, monospace); }
.dsh-ide-palette-empty { padding:10px; color:var(--ide-fg-dim);
  font:400 12px/1.5 var(--dsh-font-ui, system-ui, sans-serif); }
.dsh-ide-activity-glyph { font:400 13px/1 var(--dsh-font-ui, system-ui, sans-serif); }
.dsh-ide-row { display:flex; align-items:center; gap:4px; width:100%; border:0; background:transparent; color:inherit;
  text-align:left; cursor:pointer; padding:2px 6px 2px 6px; font:inherit; line-height:18px; white-space:nowrap; }
.dsh-ide-row:hover { background:var(--ide-hover); }
.dsh-ide-row-active { background:var(--ide-active); }
.dsh-ide-row-selected { background:var(--ide-select); }
.dsh-ide-row-root { font-weight:600; }
.dsh-ide-row-root-name { color:var(--ide-text); }
.dsh-ide-row-collapsed { opacity:.85; }
.dsh-ide-row-name { overflow:hidden; text-overflow:ellipsis; }
.dsh-ide-row-dim { color:var(--ide-muted); overflow:hidden; text-overflow:ellipsis; max-width:60%; }
.dsh-ide-row-tag { color:var(--ide-muted); font-size:10px; }
.dsh-ide-draft { display:flex; align-items:center; gap:4px; height:22px; padding-right:6px; background:var(--ide-active); }
.dsh-ide-draft-input { flex:1; min-width:0; height:18px; border:1px solid var(--ide-accent); border-radius:2px; background:var(--ide-bg); color:var(--ide-text); font:400 12px/1.3 var(--dsh-font-ui, system-ui, sans-serif); padding:0 4px; outline:none; }
.dsh-ide-guide { flex:0 0 12px; width:12px; align-self:stretch; border-left:1px solid var(--ide-border); opacity:.55; margin-left:1px; }
.dsh-ide-caret { flex:0 0 12px; width:12px; font-size:9px; color:var(--ide-muted); transition:transform .1s ease; }
.dsh-ide-caret-open { transform:rotate(90deg); }
.dsh-ide-folder { flex:0 0 14px; }
.dsh-ide-badge { flex:0 0 16px; width:16px; text-align:center; font:700 8.5px/1 var(--dsh-font-mono, ui-monospace, monospace);
  letter-spacing:-.02em; }
.dsh-ide-tree-error { padding:3px 10px; color:var(--ide-error); font-size:11px; }
.dsh-ide-tree-empty { padding:3px 10px; color:var(--ide-muted); font-size:11px; }
.dsh-ide-hint-button { cursor:pointer; pointer-events:auto; border:0; border-radius:4px; padding:0; background:transparent; color:var(--ide-text); font:14px/1 system-ui; text-align:center; }
.dsh-ide-hint-button:hover, .dsh-ide-hint-button:focus-visible { background:var(--ide-hover); outline:1px solid var(--ide-accent); outline-offset:-1px; }
.dsh-ide-hint-button[data-busy="true"]::after { content:''; display:inline-block; vertical-align:middle; width:11px; height:11px; border-radius:50%; border:2px solid var(--ide-muted); border-top-color:transparent; animation:dsh-ide-hint-spin .8s linear infinite; }
@keyframes dsh-ide-hint-spin { to { transform:rotate(360deg); } }
@media (prefers-reduced-motion:reduce) { .dsh-ide-hint-button[data-busy="true"]::after { animation:none; } }
.dsh-ide-ghost { pointer-events:none; opacity:.5; color:var(--ide-text); }
.dsh-ide-ghost-lines { white-space:pre; }
.dsh-ide-ghost-removed { background:rgba(224, 108, 117, .18); border-bottom:1px solid rgba(224, 108, 117, .55); }
.dsh-ide-edit-old { background:rgba(224, 108, 117, .22); border-bottom:1px solid rgba(224, 108, 117, .5); }
.dsh-ide-edit-inline { color:rgba(150, 225, 165, .95); margin-left:6px; opacity:.95;
  font-family:var(--ide-font-mono, ui-monospace, monospace); }
.dsh-ide-edit-added { background:rgba(106, 190, 120, .14); }
.dsh-ide-edit-old-line { background:rgba(224, 108, 117, .16); text-decoration:line-through;
  text-decoration-color:rgba(224, 108, 117, .5); }
.dsh-ide-edit-code { white-space:pre; }
.dsh-ide-icon-button { border:0; background:transparent; color:inherit; cursor:pointer; border-radius:4px;
  padding:2px 5px; font:400 12px/1 var(--dsh-font-ui, system-ui, sans-serif); }
.dsh-ide-icon-button:hover { background:var(--ide-hover); }
.dsh-ide-icon-button:disabled { opacity:.45; cursor:default; background:transparent; }
.dsh-ide-toolbar-icon { display:block; }
.dsh-ide-icon-button-active { background:var(--ide-active); }
.dsh-ide-editor { display:flex; flex-direction:column; flex:1 1 auto; min-width:0; min-height:0; background:var(--ide-bg); position:relative; }
.dsh-ide-tabs { display:flex; align-items:stretch; flex:0 0 auto; overflow-x:auto; overflow-y:hidden; background:var(--ide-panel-2);
  border-bottom:1px solid var(--ide-border); scrollbar-width:thin; }
.dsh-ide-tabs-empty { padding:6px 10px; color:var(--ide-muted); font-size:11.5px; }
.dsh-ide-tab { display:flex; align-items:center; gap:5px; padding:5px 6px 5px 9px; border-right:1px solid var(--ide-border);
  cursor:pointer; max-width:220px; min-width:0; position:relative; color:var(--ide-muted); }
.dsh-ide-tab:hover { color:var(--ide-text); }
.dsh-ide-tab-active { background:var(--ide-bg); color:var(--ide-text); box-shadow:inset 0 -1px 0 var(--ide-bg); }
.dsh-ide-tab-name { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.dsh-ide-tab-dirty { color:var(--ide-text); font-size:9px; }
.dsh-ide-tab-close { border:0; background:transparent; color:inherit; cursor:pointer; border-radius:3px; padding:0 3px;
  font-size:10px; opacity:.55; }
.dsh-ide-tab-close:hover { opacity:1; background:var(--ide-hover); }
.dsh-ide-breadcrumbs { display:flex; align-items:center; gap:2px; flex:0 0 auto; padding:3px 10px; color:var(--ide-muted);
  font-size:11px; white-space:nowrap; overflow:hidden; border-bottom:1px solid var(--ide-border); }
.dsh-ide-crumb { overflow:hidden; text-overflow:ellipsis; }
.dsh-ide-crumb-last { color:var(--ide-text); }
.dsh-ide-crumb-sep { padding:0 3px; opacity:.6; }
.dsh-ide-stage { flex:1 1 auto; min-height:0; }
.dsh-ide-panel { flex:0 0 auto; min-height:90px; max-height:560px; display:flex; flex-direction:column; border-top:1px solid var(--ide-border); background:var(--ide-panel); }
.dsh-ide-panel-resize { flex:0 0 auto; height:5px; margin-bottom:-5px; cursor:row-resize; z-index:2; }
.dsh-ide-panel-resize:hover { background:var(--ide-accent); opacity:.6; }
.dsh-ide-panel-head { display:flex; align-items:center; gap:2px; flex:0 0 auto; padding:0 6px; height:28px; border-bottom:1px solid var(--ide-border); }
.dsh-ide-panel-tab { border:none; background:transparent; color:var(--ide-fg-dim); font:400 11px/1.6 var(--ide-font); text-transform:uppercase; letter-spacing:.4px; padding:4px 8px; cursor:pointer; border-bottom:1px solid transparent; }
.dsh-ide-panel-tab:hover { color:var(--ide-fg); }
.dsh-ide-panel-tab-active { color:var(--ide-fg); border-bottom-color:var(--ide-accent); }
.dsh-ide-panel-spacer { flex:1 1 auto; }
.dsh-ide-panel-hint { font:400 11px/1.6 var(--ide-font); color:var(--ide-fg-dim); padding-right:6px; }
.dsh-ide-panel-close { border:none; background:transparent; color:var(--ide-fg-dim); font-size:14px; line-height:1; cursor:pointer; padding:2px 6px; }
.dsh-ide-panel-close:hover { color:var(--ide-fg); }
.dsh-ide-panel-body { flex:1 1 auto; min-height:0; overflow:auto; padding:4px 0; font:400 11.5px/1.55 var(--ide-font); }
.dsh-ide-panel-empty { color:var(--ide-fg-dim); padding:8px 12px; }
.dsh-ide-trace { display:flex; gap:10px; align-items:baseline; padding:2px 12px; cursor:pointer; white-space:nowrap; }
.dsh-ide-trace:hover { background:var(--ide-hover); }
.dsh-ide-trace-active { background:var(--ide-active); }
.dsh-ide-trace-time { color:var(--ide-fg-dim); flex:0 0 auto; }
.dsh-ide-trace-path { color:var(--ide-fg); flex:0 1 auto; overflow:hidden; text-overflow:ellipsis; }
.dsh-ide-trace-model { color:var(--ide-fg-dim); flex:0 0 auto; }
.dsh-ide-trace-mode { color:var(--ide-fg-dim); flex:0 0 auto; }
.dsh-ide-trace-meta { color:var(--ide-fg-dim); flex:0 0 auto; }
.dsh-ide-trace-ok { color:#89d185; flex:0 0 auto; }
.dsh-ide-trace-error { color:#f48771; flex:0 1 auto; overflow:hidden; text-overflow:ellipsis; }
.dsh-ide-chat { padding:6px 12px 10px; }
.dsh-ide-chat-label { color:var(--ide-fg-dim); text-transform:uppercase; letter-spacing:.4px; font-size:10px; margin:8px 0 3px; }
.dsh-ide-chat-text { margin:0; white-space:pre-wrap; word-break:break-word; font:400 11.5px/1.5 var(--ide-mono); color:var(--ide-fg); max-height:120px; overflow:auto; background:var(--ide-bg); border:1px solid var(--ide-border); border-radius:4px; padding:6px 8px; }
.dsh-ide-empty { position:absolute; inset:64px 0 24px; display:flex; flex-direction:column; align-items:center; justify-content:center;
  gap:6px; text-align:center; padding:16px; pointer-events:none; }
.dsh-ide-watermark { font:700 72px/1 var(--dsh-font-ui, system-ui, sans-serif); letter-spacing:.02em; color:var(--ide-text);
  opacity:.06; margin-bottom:-4px; }
.dsh-ide-empty-title { font:600 13px/1.4 var(--dsh-font-ui, system-ui, sans-serif); }
.dsh-ide-empty-text { max-width:320px; color:var(--ide-muted); font-size:11.5px; }
.dsh-ide-status { display:flex; align-items:center; gap:12px; flex:0 0 auto; padding:3px 10px; background:var(--ide-accent);
  color:#ffffff; font-size:11px; white-space:nowrap; overflow:hidden; }
.dsh-ide-status-text { overflow:hidden; text-overflow:ellipsis; }
.dsh-ide-status-error { color:#ffe0d8; font-weight:600; }
.dsh-ide-status-spacer { flex:1 1 auto; }
.dsh-ide-status-item { flex:0 0 auto; }
.dsh-ide-status-item:hover { background:rgba(255,255,255,.12); border-radius:3px; padding:0 3px; margin:0 -3px; }
.dsh-ide-status-action { cursor:pointer; border:none; background:transparent; color:inherit; font:inherit; }
.dsh-ide-status-action:hover { background:rgba(255,255,255,.12); border-radius:3px; }
.dsh-ide-drop-overlay { position:absolute; inset:0; z-index:25; display:flex; align-items:center; justify-content:center;
  background:rgba(0,0,0,.5); pointer-events:none; }
.dsh-ide-drop-overlay-text { padding:10px 18px; border:2px dashed var(--ide-accent); border-radius:8px; background:var(--ide-panel);
  color:var(--ide-text); font:600 13px/1.4 var(--dsh-font-ui, system-ui, sans-serif); }
.dsh-ide-consent { display:flex; align-items:center; gap:8px; flex:0 0 auto; padding:6px 10px; background:#3a2d1f;
  border-bottom:1px solid var(--ide-border); color:#e8d6b8; font-size:11.5px; }
.dsh-ide-root[data-theme="light"] .dsh-ide-consent { background:#fff4d6; color:#4d3a12; }
.dsh-ide-consent-text { flex:1 1 auto; min-width:0; }
.dsh-ide-consent-actions { display:flex; gap:6px; flex:0 0 auto; }
.dsh-ide-inline { display:flex; align-items:center; gap:8px; flex:0 0 auto; padding:6px 10px;
  border-bottom:1px solid var(--ide-border); background:var(--ide-panel); }
.dsh-ide-inline-label { text-transform:uppercase; letter-spacing:.4px; font-size:10px; color:var(--ide-fg-dim); flex:0 0 auto; }
.dsh-ide-inline-input { flex:1 1 auto; min-width:0; background:var(--ide-bg); color:var(--ide-fg);
  border:1px solid var(--ide-border); border-radius:4px; padding:3px 6px; font:inherit; outline:none; }
.dsh-ide-inline-input:focus { border-color:var(--ide-accent); }
.dsh-ide-inline-text { flex:0 1 auto; overflow:hidden; text-overflow:ellipsis; font-size:11.5px; }
.dsh-ide-inline-error { flex:0 1 auto; overflow:hidden; text-overflow:ellipsis; font-size:11.5px; color:#f48771; }
.dsh-ide-inline-actions { display:flex; gap:6px; flex:0 0 auto; }
.dsh-ide-inline-old { background:rgba(244,135,113,.18); text-decoration:line-through; }
.dsh-ide-inline-preview { background:rgba(137,209,133,.12); border-left:2px solid #89d185;
  font:400 12px/1.45 var(--ide-mono); white-space:pre; overflow:auto; padding:2px 8px; color:var(--ide-fg); }
.dsh-ide-inline-preview-head { font-size:10px; text-transform:uppercase; letter-spacing:.4px; color:var(--ide-fg-dim); }
.dsh-ide-inline-preview-body { margin:0; font:inherit; white-space:pre; }
.dsh-ide-settings { position:absolute; inset:0; z-index:20; display:flex; flex-direction:column;
  background:var(--ide-bg); color:var(--ide-text); }
.dsh-ide-settings-head { display:flex; align-items:center; gap:10px; padding:8px 14px;
  border-bottom:1px solid var(--ide-border); background:var(--ide-panel); }
.dsh-ide-settings-head-title { font:600 13px/1.4 var(--dsh-font-ui, system-ui, sans-serif); white-space:nowrap; }
.dsh-ide-settings-search { flex:1 1 auto; max-width:520px; padding:5px 9px; border-radius:4px;
  border:1px solid var(--ide-border); background:var(--ide-panel-2); color:inherit;
  font:400 12.5px/1.4 var(--dsh-font-ui, system-ui, sans-serif); outline:none; }
.dsh-ide-settings-search:focus { border-color:var(--ide-accent); }
.dsh-ide-settings-tabs { display:flex; align-items:center; gap:14px; padding:0 14px;
  border-bottom:1px solid var(--ide-border); background:var(--ide-panel); }
.dsh-ide-settings-tab { padding:6px 2px 5px; color:var(--ide-muted);
  font:400 12px/1.4 var(--dsh-font-ui, system-ui, sans-serif); border-bottom:1px solid transparent; }
.dsh-ide-settings-tab-active { color:var(--ide-text); border-bottom-color:var(--ide-accent); }
.dsh-ide-settings-tabs-spacer { flex:1 1 auto; }
.dsh-ide-settings-tabs-note { color:var(--ide-muted); font:400 11px/1.4 var(--dsh-font-ui, system-ui, sans-serif); }
.dsh-ide-settings-main { flex:1 1 auto; display:flex; min-height:0; }
.dsh-ide-settings-nav { flex:0 0 190px; display:flex; flex-direction:column; gap:1px; padding:10px 8px;
  border-right:1px solid var(--ide-border); overflow:auto; }
.dsh-ide-settings-nav-item { text-align:left; border:0; border-radius:4px; background:transparent; color:inherit;
  cursor:pointer; padding:5px 9px; font:400 12.5px/1.5 var(--dsh-font-ui, system-ui, sans-serif); }
.dsh-ide-settings-nav-item:hover { background:var(--ide-hover); }
.dsh-ide-settings-nav-item-active { background:var(--ide-active); font-weight:600; }
.dsh-ide-settings-content { flex:1 1 auto; overflow:auto; padding:4px 28px 40px; min-width:0; }
.dsh-ide-settings-section-title { margin:22px 0 6px; color:var(--ide-text);
  font:600 18px/1.3 var(--dsh-font-ui, system-ui, sans-serif); }
.dsh-ide-settings-section:first-child > .dsh-ide-settings-section-title { margin-top:8px; }
.dsh-ide-setting { padding:6px 0 14px; }
.dsh-ide-setting-title { font:600 12.5px/1.5 var(--dsh-font-ui, system-ui, sans-serif); }
.dsh-ide-setting-desc { margin-top:2px; max-width:720px; color:var(--ide-muted);
  font:400 12px/1.55 var(--dsh-font-ui, system-ui, sans-serif); }
.dsh-ide-setting-control { margin-top:8px; display:flex; align-items:center; gap:6px; }
.dsh-ide-keys { display:flex; flex-direction:column; border:1px solid var(--ide-border);
  border-radius:4px; overflow:hidden; background:var(--ide-panel-2); max-width:720px; }
.dsh-ide-keys-row { display:grid; grid-template-columns:minmax(150px, 1fr) 210px 26px; gap:10px;
  align-items:center; padding:5px 10px; border-top:1px solid var(--ide-border); }
.dsh-ide-keys-row:first-child { border-top:none; }
.dsh-ide-keys-head { padding:4px 10px; background:var(--ide-panel); font-size:10px;
  text-transform:uppercase; letter-spacing:.4px; color:var(--ide-fg-dim); }
.dsh-ide-keys-name { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
  font:400 12.5px/1.5 var(--dsh-font-ui, system-ui, sans-serif); }
.dsh-ide-keys-default { margin-left:6px; font-size:10.5px; color:var(--ide-fg-dim); }
.dsh-ide-keys-chord { display:flex; flex-direction:column; gap:2px; min-width:0; }
.dsh-ide-keys-row[data-invalid="true"] .dsh-ide-key-input { border-color:#f48771; }
.dsh-ide-keys-reset { justify-self:end; }
.dsh-ide-key-input { width:100%; padding:2px 7px; border-radius:4px; border:1px solid var(--ide-border);
  background:var(--ide-bg); color:var(--ide-fg); font:500 12px/1.5 var(--dsh-font-mono, ui-monospace, monospace); outline:none; }
.dsh-ide-key-input:focus { border-color:var(--ide-accent); }
.dsh-ide-key-error { color:#f48771; font:400 10.5px/1.35 var(--dsh-font-ui, system-ui, sans-serif); }
.dsh-ide-setting-input { width:230px; max-width:100%; }
.dsh-ide-setting-textarea { width:100%; min-height:96px; resize:vertical; font:400 12.5px/1.5 var(--dsh-font-mono, ui-monospace, monospace); padding:6px 8px; }
.dsh-ide-setting-control input[type="checkbox"] { width:14px; height:14px; accent-color:var(--ide-accent); }
.dsh-ide-setting-check { display:inline-flex; align-items:center; gap:6px; color:var(--ide-text);
  font:400 12.5px/1.4 var(--dsh-font-ui, system-ui, sans-serif); }
.dsh-ide-settings-actions { display:flex; gap:6px; }
.dsh-ide-setting-value { font:500 12px/1.4 var(--dsh-font-mono, ui-monospace, monospace); color:var(--ide-muted, #9aa4b2); }
.dsh-ide-settings-foot { display:flex; align-items:center; gap:8px; padding:8px 14px;
  border-top:1px solid var(--ide-border); background:var(--ide-panel); }
.dsh-ide-settings-foot-spacer { flex:1 1 auto; }
.dsh-ide-settings-message { color:var(--ide-muted); font-size:11px; }
.dsh-ide-hint { color:var(--ide-muted); font-size:10.5px; line-height:1.45; }
.dsh-ide-input { width:100%; padding:4px 6px; border-radius:4px; color:inherit; background:var(--ide-bg);
  border:1px solid var(--ide-border); font:400 12px/1.4 var(--dsh-font-ui, system-ui, sans-serif); outline:none; }
.dsh-ide-input:focus { border-color:var(--ide-accent); }
.dsh-ide-input-number { width:110px; }
.dsh-ide-button { border:1px solid var(--ide-border); background:var(--ide-panel-2); color:inherit; cursor:pointer;
  border-radius:4px; padding:3px 9px; font:400 11.5px/1.5 var(--dsh-font-ui, system-ui, sans-serif); }
.dsh-ide-button:hover:not(:disabled) { background:var(--ide-hover); }
.dsh-ide-button:disabled { opacity:.45; cursor:default; }
.dsh-ide-button-primary { background:var(--ide-accent); border-color:var(--ide-accent); color:#fff; }
.dsh-ide-warn { margin:6px 0; color:#d7ba7d; font-size:10.5px; line-height:1.45; }
.dsh-ide-message { margin-top:8px; font-size:11px; }
.dsh-ide-modal { position:absolute; inset:0; z-index:30; display:flex; align-items:center; justify-content:center;
  padding:18px; background:rgba(0,0,0,.42); }
.dsh-ide-modal-top { align-items:flex-start; padding-top:32px; background:rgba(0,0,0,.28); }
.dsh-ide-modal-card { width:100%; max-width:520px; background:var(--ide-panel); color:var(--ide-text);
  border:1px solid var(--ide-border); border-radius:8px; box-shadow:0 12px 32px rgba(0,0,0,.45); padding:14px; }
.dsh-ide-modal-title { font:600 13px/1.4 var(--dsh-font-ui, system-ui, sans-serif); margin-bottom:6px; }
.dsh-ide-modal-text { color:var(--ide-muted); font-size:11.5px; line-height:1.5; margin-bottom:12px; }
.dsh-ide-modal-actions { display:flex; gap:8px; justify-content:flex-end; }
.dsh-ide-quick { padding:8px; max-height:70%; display:flex; flex-direction:column; }
.dsh-ide-quick-input { width:100%; padding:6px 8px; border-radius:4px; color:inherit; background:var(--ide-bg);
  border:1px solid var(--ide-accent); font:400 13px/1.4 var(--dsh-font-ui, system-ui, sans-serif); outline:none; }
.dsh-ide-quick-list { margin-top:6px; overflow:auto; }
.dsh-ide-quick-row { display:flex; align-items:center; gap:6px; width:100%; border:0; background:transparent; color:inherit;
  text-align:left; cursor:pointer; padding:3px 6px; border-radius:4px; font:inherit; }
.dsh-ide-quick-row-active { background:var(--ide-active); }
.dsh-ide-action { display:inline-flex; align-items:center; gap:4px; }
.dsh-ide-action-button { font:600 10.5px/1.2 var(--dsh-font-ui, system-ui, sans-serif); color:inherit; background:transparent;
  border:1px solid var(--dsh-border, rgba(127,127,127,.35)); border-radius:5px; padding:2px 7px; cursor:pointer; }
.dsh-ide-action-button:hover:not(:disabled) { background:var(--dsh-hover, rgba(127,127,127,.14)); }
.dsh-ide-action-button:disabled { opacity:.5; cursor:default; }
.dsh-ide-action-error { color:#d9534f; font-weight:700; cursor:help; }
.dsh-ide-action-compact .dsh-ide-action-button { padding:1px 6px; font-size:10px; line-height:1.4;
  letter-spacing:.4px; text-transform:uppercase; }
`

    function injectStyles() {
      const element = document.createElement('style')
      element.setAttribute('data-dsh-ide', '')
      element.textContent = STYLES
      document.head.appendChild(element)
      return () => {
        element.remove()
      }
    }

    // ------------------------------------------------------------------ apply

    const plugin = {
      inject: ['slots', 'sidebarRight', 'sidebarRightTabs', 'theme'],
      apply(ctx) {
        services = {
          ctx,
          theme: ctx.theme,
          sidebarRight: ctx.sidebarRight,
          sidebarRightTabs: ctx.sidebarRightTabs,
          // The session input machine — the owner of `slash/input-insert-reference`
          // — lives on the session's own client context, which the sessions
          // service hands out per retained binding. Absent for a tab that is not
          // bound to a retained session.
          sessionContext: (id) => {
            if (typeof id !== 'string' || id === '') return undefined
            try {
              const sessions = typeof ctx.get === 'function' ? ctx.get('sessions') : undefined
              if (sessions === undefined || sessions === null || typeof sessions.binding !== 'function') return undefined
              const binding = sessions.binding(id)
              if (binding === undefined || binding === null) return undefined
              return typeof binding.ctx === 'object' ? binding.ctx : undefined
            } catch (cause) {
              return undefined
            }
          },
        }

        ctx.effect(injectStyles, 'dsh-ide: styles')

        // Chips link files the way `@` does, but carry their line range into
        // the sent message. The source is registered eagerly when the shell's
        // trigger service is already up; `ensureChatSource` retries on the
        // first chip otherwise.
        ensureChatSource()

        ctx.effect(() => {
          const dispose = ctx.sidebarRightTabs.register({
            id: TAB_ID,
            kind: TAB_KIND,
            priority: 'fallback',
            multiple: false,
            patterns: [ADDRESS_PATTERN],
            canOpen: (candidate) => parseAddress(candidate) !== undefined,
            title: (candidate) => {
              const parsed = parseAddress(candidate)
              return parsed === undefined || parsed.path === '' ? 'IDE' : baseName(parsed.path)
            },
            // The Start panel lists one row per guide entry, and the row opens
            // the tab by kind — this is the entry point with no prerequisites.
            guide: [
              {
                id: GUIDE_ENTRY_ID,
                order: 10,
                title: () => 'IDE',
                description: () => 'Редактор с деревом файлов и вкладками',
              },
            ],
          })
          return () => {
            dispose()
          }
        }, 'dsh-ide: tab type')

        ctx.slots.inject('sidebar.right.pane.tab', () =>
          ctx.slots.register({ name: 'sidebar.right.pane.tab', key: TAB_ID }, IdeBody),
        )

        ctx.slots.inject('sidebar.right.pane.tab.title', () =>
          ctx.slots.register({ name: 'sidebar.right.pane.tab.title', key: TAB_ID }, IdeTitle),
        )

        ctx.effect(
          () =>
            ctx.sidebarRight.registerCloseHandler(TAB_KIND, (_sessionId, record) => {
              if (dirtyTabs.size === 0) return
              closePromptHandlers.get(record.id)?.()
              throw new Error('В IDE остались несохранённые файлы: сохраните или отбросьте изменения.')
            }),
          'dsh-ide: unsaved close guard',
        )

        for (const [slot, id, order, label] of ACTION_SLOTS) {
          ctx.slots.inject(slot, () => ctx.slots.register({ name: slot, id, order, label }, OpenIdeButton))
        }

        // The composer row is always on screen inside a session, so this is the
        // entry point that does not depend on any other panel being open.
        ctx.slots.inject('conversation.input.left', () =>
          ctx.slots.register(
            { name: 'conversation.input.left', id: `${ACTION_ID}.composer`, order: 40, label: 'IDE' },
            (props) => h(OpenIdeButton, { ...props, compact: true, absolutePath: '' }),
          ),
        )
      },
    }

    return plugin
  },
})
