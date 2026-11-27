/**
 * Client half of `@local/dsh-ide`.
 *
 * A classic code-editor that lives in the right sidebar and brings its own
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
    const UI_BUILD = '2026-11-26.3'
    // The theme service has no subscribe method; the shell emits this event
    // instead, and the IDE re-renders so data-theme and Monaco follow a live
    // light/dark switch.
    const THEME_EVENT = 'dsh-ide:theme-change'
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
    // The phone layout is chosen by the width of the pane, not of the window:
    // the IDE is a column inside the right sidebar, so a desktop window can hold
    // a narrow pane while a phone fills the screen with it. Seven menus, a
    // 220px explorer and 12px rows do not survive 400px, hence the breakpoints.
    const COMPACT_PANE_WIDTH = 700
    const COMPACT_PANE_HARD_WIDTH = 480

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

    // -------------------------------------------------------------- viewport

    /** `matchMedia` as a plain question: unknown windows answer "no". */
    function matchMediaSafe(query) {
      try {
        if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
        return window.matchMedia(query).matches === true
      } catch {
        return false
      }
    }

    /** A media query as reactive state; safe on the Host-rendered test stubs. */
    function useMediaQuery(query) {
      const [matches, setMatches] = React.useState(() => matchMediaSafe(query))
      React.useEffect(() => {
        if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return undefined
        let media
        try {
          media = window.matchMedia(query)
        } catch {
          return undefined
        }
        if (media === undefined || media === null) return undefined
        const listener = (event) => setMatches(event.matches === true)
        if (typeof media.addEventListener === 'function') media.addEventListener('change', listener)
        else if (typeof media.addListener === 'function') media.addListener(listener)
        return () => {
          if (typeof media.removeEventListener === 'function') media.removeEventListener('change', listener)
          else if (typeof media.removeListener === 'function') media.removeListener(listener)
        }
      }, [query])
      return matches
    }

    /**
     * Width of the pane element itself. The initial guess uses the window, which
     * is exact on a phone and close enough everywhere else for one frame.
     */
    function usePaneWidth(ref) {
      const [width, setWidth] = React.useState(() =>
        typeof window !== 'undefined' && typeof window.innerWidth === 'number' ? window.innerWidth : 1024,
      )
      React.useEffect(() => {
        const node = ref.current
        if (node === null || node === undefined) return undefined
        const measure = () => {
          const next = node.clientWidth
          if (typeof next === 'number' && next > 0) setWidth(next)
        }
        measure()
        if (typeof ResizeObserver === 'function') {
          const observer = new ResizeObserver(measure)
          observer.observe(node)
          return () => observer.disconnect()
        }
        if (typeof window === 'undefined') return undefined
        window.addEventListener('resize', measure)
        return () => window.removeEventListener('resize', measure)
      }, [ref])
      return width
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

    // Menus follow the page language. Unsupported or missing locales use Russian.
    const menuLanguage = () => /^en(?:-|$)/i.test(document.documentElement?.lang || '') ? 'en' : 'ru'
    const menuText = (ru, en) => menuLanguage() === 'en' ? en : ru

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
          const start = () => amd(['vs/editor/editor.main'], () => resolve(window.monaco), reject)
          if (menuLanguage() === 'en') return start()
          // The vendored language pack sets globals; it is not an AMD module.
          const locale = document.createElement('script')
          locale.src = `${ASSET_BASE}/nls/lang/ru.js`
          locale.onload = start
          locale.onerror = () => reject(new Error('Не удалось загрузить русский перевод Monaco'))
          document.head.appendChild(locale)
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
        // The live shape is `{ preference, active: { id, colorScheme }, ... }`;
        // older hosts returned a bare id. Accept both, plus a resolved flag.
        const active = snapshot && typeof snapshot === 'object' ? snapshot.active : undefined
        const name = typeof snapshot === 'string'
          ? snapshot
          : snapshot && (snapshot.id || snapshot.name || snapshot.theme
            || (active && (active.colorScheme || active.id || active.name))
            || snapshot.preference)
        if (typeof name === 'string') {
          if (/dark/i.test(name)) return 'dark'
          if (/light/i.test(name)) return 'light'
        }
        if (active && typeof active.colorScheme === 'string') {
          if (/dark/i.test(active.colorScheme)) return 'dark'
          if (/light/i.test(active.colorScheme)) return 'light'
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
    // the reference file explorer instead of relying on font glyphs.
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
     * files that turn touched. Each file carries the same two decisions the
     * reference editor offers (keep / undo), and the header applies them to the whole turn.
     *
     * A component rather than inline JSX: the editor surface of `IdeBody` is
     * already the largest expression in this file.
     */
    // ------------------------------------------------------------------- git

    // The Host groups a status entry by where its content lives: the index or
    // the working tree. An `MM` file therefore belongs to both lists, and each
    // row compares the side pair of its own group.
    const SCM_SECTIONS = [
      { id: 'conflicts', title: 'Конфликты' },
      { id: 'staged', title: 'Подготовленные' },
      { id: 'changes', title: 'Изменения' },
    ]

    const SCM_GRAPH_COLORS = ['#4e94ce', '#d18616', '#89d185', '#c586c0', '#e2c08d', '#f48771', '#73c991', '#9cdcfe']

    function scmGroupsOf(entry) {
      if (entry === undefined || entry === null) return []
      if (entry.kind === 'conflict') return ['conflicts']
      if (entry.kind === 'ignored') return []
      if (entry.kind === 'untracked') return ['changes']
      const groups = []
      if (entry.indexStatus !== '.' && entry.indexStatus !== '?') groups.push('staged')
      if (entry.worktreeStatus !== '.') groups.push('changes')
      return groups
    }

    function scmSections(snapshot) {
      const entries = snapshot !== undefined && snapshot !== null && Array.isArray(snapshot.entries) ? snapshot.entries : []
      const buckets = new Map(SCM_SECTIONS.map((section) => [section.id, []]))
      for (const entry of entries) {
        if (typeof entry?.path !== 'string' || entry.path === '') continue
        for (const group of scmGroupsOf(entry)) {
          const rows = buckets.get(group)
          if (rows === undefined) continue
          rows.push({ group, path: entry.path, key: `${group}:${entry.path}`, entry })
        }
      }
      return SCM_SECTIONS.map((section) => ({ ...section, rows: buckets.get(section.id) })).filter((section) => section.rows.length > 0)
    }

    function scmLetter(row) {
      if (row.group === 'conflicts') return 'U'
      // `?` records carry no worktree status: the Host reports the kind, and
      // reading the empty status field here once turned every new file into `·`.
      if (row.entry.kind === 'untracked') return '?'
      const code = row.group === 'changes' ? row.entry.worktreeStatus : row.entry.indexStatus
      if (code === '?') return '?'
      return typeof code === 'string' && code !== '' && code !== '.' ? code[0] : '·'
    }

    const SCM_STATUS_LABELS = {
      A: 'добавлен',
      M: 'изменён',
      D: 'удалён',
      R: 'переименован',
      C: 'скопирован',
      T: 'изменён тип',
      U: 'конфликт',
      '?': 'новый файл',
      '·': 'без изменений',
    }

    function scmLetterLabel(letter) {
      return SCM_STATUS_LABELS[letter] ?? 'изменён'
    }

    // A stable, theme-independent palette: the letter and the commit text stay
    // the real status signal, the colour only helps to follow a branch line.
    function scmGraphColor(column) {
      const index = Math.abs(Number(column) || 0) % SCM_GRAPH_COLORS.length
      return SCM_GRAPH_COLORS[index]
    }

    /**
     * Assigns every commit a column and puts the branch lines between rows.
     *
     * The result is what the SVG renderer draws: for each row, `segments` with
     * unit coordinates (`y` 0 = top, 11 = node centre, 22 = bottom). Lanes keep
     * the expected OID, so a line continues across a page boundary when the
     * caller passes the previous page's `lanes` as `carry`.
     */
    function layoutGraph(commits, carry) {
      const lanes = Array.isArray(carry?.lanes) ? carry.lanes.slice() : []
      const rows = []
      let width = 0
      for (const commit of Array.isArray(commits) ? commits : []) {
        if (commit === undefined || commit === null || typeof commit.oid !== 'string' || commit.oid === '') continue
        const parents = Array.isArray(commit.parents)
          ? commit.parents.filter((oid) => typeof oid === 'string' && oid !== '')
          : []
        const before = lanes.slice()
        let column = lanes.indexOf(commit.oid)
        if (column === -1) {
          column = lanes.indexOf(undefined)
          if (column === -1) {
            column = lanes.length
            lanes.push(commit.oid)
          } else {
            lanes[column] = commit.oid
          }
        }
        const segments = []
        for (let index = 0; index < before.length; index += 1) {
          if (before[index] === undefined) continue
          if (index === column) {
            if (before[index] === commit.oid) segments.push({ kind: 'in', x1: index, y1: 0, x2: index, y2: 11 })
          } else {
            segments.push({ kind: 'through', x1: index, y1: 0, x2: index, y2: 22 })
          }
        }
        lanes[column] = undefined
        parents.forEach((parent, parentIndex) => {
          let target = lanes.indexOf(parent)
          if (target === -1) {
            if (parentIndex === 0) {
              target = column
            } else {
              target = lanes.indexOf(undefined)
              if (target === -1) target = lanes.length
            }
            lanes[target] = parent
          }
          segments.push({ kind: 'out', x1: column, y1: 11, x2: target, y2: 22, parent })
        })
        const visible = Math.max(column + 1, lanes.length, ...segments.map((segment) => Math.max(segment.x1, segment.x2) + 1))
        width = Math.max(width, visible)
        rows.push({ oid: commit.oid, column, segments, parents, lanes: lanes.slice() })
      }
      // A trailing free slot is not a line: trim it so the next page does not
      // inherit an empty column and the width stays honest.
      while (lanes.length > 0 && lanes[lanes.length - 1] === undefined) lanes.pop()
      return { rows, lanes: lanes.slice(), width }
    }

    function formatScmTime(seconds) {
      const value = Number(seconds)
      if (!Number.isFinite(value) || value <= 0) return ''
      try {
        return new Date(value * 1000).toLocaleString('ru-RU', {
          day: '2-digit',
          month: '2-digit',
          year: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
        })
      } catch {
        return ''
      }
    }

    function fileExtension(filePath) {
  const name = String(filePath ?? '').split(/[\\/]/).pop() ?? ''
  const dot = name.lastIndexOf('.')
  if (dot <= 0 || dot === name.length - 1) return ''
  return name.slice(dot + 1).toLowerCase()
}

function splitCandidate(tabs, activeKey) {
  return tabs.find((candidate) => candidate.key !== activeKey)
}

function crossFileCandidate(tabs, activeKey, insertedText, beforeText) {
  const known = new Set(String(beforeText ?? '').match(/[A-Za-z_][A-Za-z0-9_]{2,}/g) ?? [])
  const words = new Set(String(insertedText ?? '').match(/[A-Za-z_][A-Za-z0-9_]{2,}/g) ?? [])
  for (const word of words) {
    if (known.has(word)) continue
    const other = tabs.find(
      (candidate) =>
        candidate.key !== activeKey &&
        typeof candidate.text === 'string' &&
        new RegExp(`(^|[^A-Za-z0-9_])${word}([^A-Za-z0-9_]|$)`).test(candidate.text),
    )
    if (other !== undefined) return { key: other.key, path: other.path, token: word }
  }
  return undefined
}

function diagnosticContext(markers, position, limit = 5) {
  if (!Array.isArray(markers) || position === null || position === undefined) return []
  const near = markers.filter(
    (marker) =>
      marker !== null &&
      typeof marker === 'object' &&
      typeof marker.message === 'string' &&
      marker.message.trim() !== '' &&
      (marker.severity === 8 || marker.severity === 4) &&
      Number.isFinite(marker.startLineNumber) &&
      Math.abs(marker.startLineNumber - position.lineNumber) <= 3,
  )
  return near.slice(0, limit).map((marker) => ({
    line: marker.startLineNumber,
    column: marker.startColumn,
    endLine: Number.isFinite(marker.endLineNumber) ? marker.endLineNumber : marker.startLineNumber,
    endColumn: Number.isFinite(marker.endColumn) ? marker.endColumn : marker.startColumn,
    severity: marker.severity === 8 ? 'error' : 'warning',
    message: marker.message.replace(/\s+/g, ' ').trim().slice(0, 300),
  }))
}

function wordAt(text, offset) {
  const source = String(text ?? '')
  const at = Math.max(0, Math.min(Number(offset) || 0, source.length))
  const token = /[A-Za-z_$][A-Za-z0-9_$]*/g
  let match
  while ((match = token.exec(source)) !== null) {
    if (match.index <= at && at <= match.index + match[0].length) return match[0]
  }
  return ''
}

function symbolReferences(tabs, word, limit = 100) {
  if (typeof word !== 'string' || word === '') return []
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const whole = new RegExp(`(^|[^A-Za-z0-9_$])(${escaped})(?=[^A-Za-z0-9_$]|$)`, 'g')
  const definitionPatterns = [
    new RegExp(`\\b(?:function|class|const|let|var|interface|type|enum|namespace|module)\\s+${escaped}\\b`),
    new RegExp(`\\b${escaped}\\s*[:=]\\s*(?:async\\s*)?(?:function\\b|\\()`),
  ]
  const rows = []
  for (const tab of tabs) {
    if (typeof tab.text !== 'string') continue
    if (!/\.(?:[cm]?[jt]sx?)$/i.test(tab.path ?? '')) continue
    const lines = tab.text.split('\n')
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]
      whole.lastIndex = 0
      let hit
      while ((hit = whole.exec(line)) !== null) {
        const column = hit.index + hit[1].length + 1
        if (rows.length < limit) {
          const definition = definitionPatterns.some((pattern) => pattern.test(line))
          rows.push({
            key: tab.key,
            path: tab.path,
            line: index + 1,
            column,
            kind: definition ? 'definition' : 'reference',
            text: line.trim().slice(0, 200),
          })
        }
        whole.lastIndex = hit.index + hit[0].length
      }
    }
  }
  return rows.sort((left, right) => {
    if (left.kind !== right.kind) return left.kind === 'definition' ? -1 : 1
    if (left.path !== right.path) return left.path.localeCompare(right.path)
    return left.line - right.line
  })
}

function renamePlan(tabs, word, next) {
  if (typeof word !== 'string' || word === '') return { ok: false, reason: 'Нет имени под курсором.' }
  if (typeof next !== 'string' || !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(next)) {
    return { ok: false, reason: 'Новое имя должно быть одним идентификатором: буквы, цифры, _ или $.' }
  }
  if (next === word) return { ok: false, reason: 'Имя не изменилось.' }
  const whole = new RegExp(`(^|[^A-Za-z0-9_$])${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=[^A-Za-z0-9_$]|$)`, 'g')
  const files = []
  for (const tab of tabs) {
    if (typeof tab.text !== 'string' || !/\.(?:[cm]?[jt]sx?)$/i.test(tab.path ?? '')) continue
    const lines = tab.text.split('\n')
    const edits = []
    const nextLines = lines.map((line, index) => {
      whole.lastIndex = 0
      let replaced = ''
      let consumed = 0
      let hit
      while ((hit = whole.exec(line)) !== null) {
        const start = hit.index + hit[1].length
        replaced += line.slice(consumed, start) + next
        consumed = start + word.length
        edits.push({ line: index + 1, column: start + 1 })
        whole.lastIndex = start + word.length
      }
      return edits.length === 0 ? line : replaced + line.slice(consumed)
    })
    if (edits.length === 0) continue
    files.push({
      key: tab.key,
      path: tab.path,
      count: edits.length,
      edits: edits.slice(0, 50),
      before: lines.slice(Math.max(0, edits[0].line - 1), edits[0].line).join(''),
      after: nextLines.slice(Math.max(0, edits[0].line - 1), edits[0].line).join(''),
      text: nextLines.join('\n'),
    })
  }
  return { ok: true, files, total: files.reduce((sum, file) => sum + file.count, 0) }
}

function tabExtensionDisabled(preferences, filePath) {
  const extension = fileExtension(filePath)
  if (extension === '') return false
  const disabled = preferences === undefined || preferences === null ? undefined : preferences.tabDisabledExtensions
  return Array.isArray(disabled) && disabled.includes(extension)
}

function snoozeLabel(until) {
  if (!Number.isFinite(until) || until <= 0) return ''
  const date = new Date(until)
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

const TERMINAL_CONTEXT_CHARS = 12000
const DEBUG_FIELD_CHARS = 4000
const DEBUG_TOTAL_CHARS = 16000
const NOTES_MAX = 50
const NOTE_MAX_CHARS = 1000
const NOTES_TOTAL_CHARS = 16000

function lineAttribution(records, path, line) {
  if (!Array.isArray(records) || typeof path !== 'string' || !Number.isSafeInteger(line) || line < 1) return []
  const want = path.replace(/\\/g, '/').replace(/^\.\//, '')
  return records.filter((record) => {
    if (record === null || typeof record !== 'object' || typeof record.path !== 'string') return false
    const recordPath = record.path.replace(/\\/g, '/').replace(/^\.\//, '')
    if (recordPath !== want) return false
    if (!Number.isSafeInteger(record.startLine) || !Number.isSafeInteger(record.endLine)) return false
    return record.startLine <= line && line <= record.endLine
  })
}

// A review notes pack: numbered remarks, optionally anchored to a file and
// line. The chat gets one agreed list, not a stream of separate quotes.
function notesBlock(input) {
  const list = Array.isArray(input) ? input : []
  const lines = []
  let chars = 0
  let truncated = false
  let number = 0
  for (const item of list) {
    if (list.length > NOTES_MAX && number >= NOTES_MAX) {
      truncated = true
      break
    }
    const note = item !== null && typeof item === 'object' ? item : {}
    const text = typeof note.text === 'string' ? note.text.trim().replace(/\s+/g, ' ') : ''
    if (text === '') continue
    const clipped = text.length > NOTE_MAX_CHARS ? text.slice(0, NOTE_MAX_CHARS) : text
    if (clipped.length !== text.length) truncated = true
    const where = typeof note.path === 'string' && note.path.trim() !== ''
      ? `${normalPath(note.path)}${Number.isSafeInteger(note.line) && note.line > 0 ? `:${note.line}` : ''} — `
      : ''
    const rendered = `${where}${clipped}`
    if (chars + rendered.length + 8 > NOTES_TOTAL_CHARS) {
      truncated = true
      break
    }
    number += 1
    lines.push(`${number}. ${rendered}`)
    chars += rendered.length + 8
  }
  if (lines.length === 0) return { text: '', chars: 0, count: 0, truncated: false }
  const body = ['Замечания:', ...lines]
  let text = body.join('\n') + '\n'
  if (text.length > NOTES_TOTAL_CHARS) {
    text = text.slice(0, NOTES_TOTAL_CHARS) + '\n(список обрезан)\n'
    truncated = true
  }
  return { text, chars: text.length, count: lines.length, truncated }
}

// A local code tour: an ordered list of file/line stops with short notes.
// Nothing is written to the repository and no model is involved; the panel is
// the only holder of the route.
const TOUR_MAX_STEPS = 40
const TOUR_NOTE_CHARS = 240

function tourStep(input) {
  if (input === null || typeof input !== 'object' || typeof input.path !== 'string') return undefined
  const path = input.path
    .trim()
    .replace(/\\/g, '/')
    .replace(/^(?:\.\/)+/, '')
    .replace(/^\/+/, '')
  if (path === '') return undefined
  const line = Number.isSafeInteger(input.line) && input.line > 0 ? input.line : 1
  const note = typeof input.note === 'string'
    ? input.note.trim().replace(/\s+/g, ' ').slice(0, TOUR_NOTE_CHARS)
    : ''
  return { path, line, note }
}

function tourAdd(steps, input) {
  const list = Array.isArray(steps) ? steps : []
  const step = tourStep(input)
  if (step === undefined || list.length >= TOUR_MAX_STEPS) return list
  return [...list, step]
}

function tourMove(steps, index, delta) {
  if (!Array.isArray(steps)) return []
  const from = Number.isSafeInteger(index) ? index : -1
  const to = from + (Number.isSafeInteger(delta) ? delta : 0)
  if (from < 0 || from >= steps.length || to < 0 || to >= steps.length) return steps
  const next = steps.slice()
  const [moved] = next.splice(from, 1)
  next.splice(to, 0, moved)
  return next
}

function tourRemove(steps, index) {
  if (!Array.isArray(steps) || !Number.isSafeInteger(index) || index < 0 || index >= steps.length) {
    return Array.isArray(steps) ? steps : []
  }
  return steps.filter((_, at) => at !== index)
}

function tourProgress(index, total) {
  if (!Number.isSafeInteger(total) || total <= 0) return '0/0'
  const at = Number.isSafeInteger(index) ? Math.min(Math.max(index, 0), total - 1) : 0
  return `${at + 1}/${total}`
}

function terminalBlock(command, code, output) {
  const text = typeof output === 'string' ? output : ''
  const kept = text.length > TERMINAL_CONTEXT_CHARS ? text.slice(0, TERMINAL_CONTEXT_CHARS) : text
  const truncated = kept.length !== text.length
  const typedCommand = typeof command === 'string' ? command.trim() : ''
  const exitCode = typeof code === 'string' ? code.trim() : ''
  const body = []
  body.push(typedCommand === '' ? 'Запуск в терминале' : `Запуск в терминале: ${typedCommand}`)
  if (exitCode !== '') body.push(`Код выхода: ${exitCode}`)
  if (kept.trim() !== '') body.push('Вывод:', '```', kept.replace(/\s+$/, ''), '```')
  if (truncated) body.push(`(вывод обрезан до ${TERMINAL_CONTEXT_CHARS} символов)`)
  const result = body.join('\n') + '\n'
  return { text: result, chars: result.length, lines: result.split('\n').length - 1, truncated, outputChars: kept.length }
}

// A local debug journal: hypothesis, reproduction steps, two runs and the
// cleanup state of temporary logs. It is deliberately not a debugger — no
// breakpoints, no process control — only a bounded block for the chat.
function debugBlock(input) {
  const fields = input !== null && typeof input === 'object' ? input : {}
  const clip = (value) => {
    if (typeof value !== 'string') return ''
    const text = value.trim()
    return text.length > DEBUG_FIELD_CHARS ? text.slice(0, DEBUG_FIELD_CHARS) : text
  }
  const hypothesis = clip(fields.hypothesis)
  const steps = clip(fields.steps)
  const runA = clip(fields.runA)
  const runB = clip(fields.runB)
  const logs = clip(fields.logs)
  const cleaned = fields.cleaned === true
  const body = [`Debug${hypothesis === '' ? '' : `: ${hypothesis}`}`]
  if (steps !== '') body.push('', 'Шаги:', steps)
  if (runA !== '' || runB !== '') {
    body.push('', 'Прогон A:', runA === '' ? '(не записан)' : runA, '', 'Прогон B:', runB === '' ? '(не записан)' : runB)
  }
  if (logs !== '' || cleaned) {
    body.push('', `Временные логи: ${logs === '' ? '(путь не указан)' : logs}`)
    body.push(cleaned ? 'Очистка временных логов: подтверждена.' : 'Очистка временных логов: НЕ подтверждена.')
  }
  let text = body.join('\n') + '\n'
  const truncated = text.length > DEBUG_TOTAL_CHARS
  if (truncated) text = text.slice(0, DEBUG_TOTAL_CHARS) + '\n(журнал обрезан до 16000 символов)\n'
  return { text, chars: text.length, truncated }
}

function describeScmError(cause) {
      const code = cause !== null && typeof cause === 'object' ? cause.code : undefined
      if (code === 'git-unavailable') return 'Git недоступен: политика сессии не подтверждена.'
      if (code === 'git-not-found') return 'Git не найден на компьютере.'
      if (code === 'not-repository') return 'Рабочая папка не является Git-репозиторием.'
      if (code === 'not-root') return typeof cause.message === 'string' ? cause.message : 'Откройте корень Git-репозитория.'
      if (code === 'read-only') return 'Сессия работает только для чтения: изменения индекса недоступны.'
      if (code === 'locked') return 'Git занят другой операцией (index.lock). Повторите позже.'
      if (code === 'timeout') return 'Git не ответил вовремя. Повторите запрос.'
      if (code === 'output-limit') return 'Слишком большой список изменений: панель показала предел, а не «чисто».'
      if (code === 'stale') return typeof cause.message === 'string' && cause.message !== '' ? cause.message : 'Список изменений обновился — обновите панель.'
      if (code === 'history-stale') return 'Ветки изменились — граф начнётся заново.'
      if (code === 'nothing-staged') return 'Нет подготовленных изменений — фиксировать нечего.'
      if (code === 'identity') return typeof cause.message === 'string' ? cause.message : 'Git не знает автора фиксации.'
      if (code === 'branch-exists') return 'Ветка с таким именем уже есть.'
      if (code === 'branch-current') return 'Текущую ветку удалить нельзя.'
      if (code === 'branch-unmerged') return 'В ветке есть невлитые коммиты — безопасно удалить её нельзя.'
      if (code === 'switch-conflict') return 'Несохранённые изменения мешают переключению ветки.'
      return describeError(cause)
    }

    function ScmBranchIcon() {
      return h(
        'svg',
        { width: '15', height: '15', viewBox: '0 0 16 16', 'aria-hidden': 'true' },
        h('path', { fill: 'none', stroke: 'currentColor', strokeWidth: '1.3', d: 'M4 2.5v7M4 13.2v-.4M4.8 5.5h3.7a3 3 0 0 1 3 3v4.7M11.5 2.5v.6M11.5 2.2a1.1 1.1 0 1 0 0 2.2 1.1 1.1 0 0 0 0-2.2M4 1.4a1.1 1.1 0 1 0 0 2.2 1.1 1.1 0 0 0 0-2.2M4 12.4a1.1 1.1 0 1 0 0 2.2 1.1 1.1 0 0 0 0-2.2' }),
      )
    }

    function ScmRow({ row, active, unsaved, busy, onOpen, onStage, onUnstage, onResolve }) {
      const letter = scmLetter(row)
      const label = scmLetterLabel(letter)
      const name = baseName(row.entry.path)
      const directory = dirName(row.entry.path)
      const rename = typeof row.entry.oldPath === 'string' && row.entry.oldPath !== '' ? `${row.entry.oldPath} → ${row.entry.path}` : row.entry.path
      const action = row.group === 'conflicts' ? null : row.group === 'staged' ? '−' : '+'
      const actionLabel = row.group === 'staged' ? 'Снять с подготовки' : 'Подготовить файл'
      return h(
        'div',
        { className: `dsh-ide-scm-row${active ? ' dsh-ide-scm-row-active' : ''}`, 'data-group': row.group },
        h(
          'div',
          {
            className: 'dsh-ide-scm-row-main',
            role: 'button',
            tabIndex: 0,
            title: rename,
            'aria-label': `${name}, ${label}: ${row.entry.path}`,
            onClick: () => onOpen(row),
            onKeyDown: (event) => {
              if (event.key !== 'Enter' && event.key !== ' ') return
              event.preventDefault()
              onOpen(row)
            },
          },
          h('span', { className: 'dsh-ide-scm-letter', 'data-letter': letter, 'aria-hidden': 'true' }, letter),
          h(
            'span',
            { className: 'dsh-ide-scm-row-text' },
            h(
              'span',
              { className: 'dsh-ide-scm-name' },
              name,
              unsaved ? h('span', { className: 'dsh-ide-scm-dirty', title: 'В редакторе есть несохранённые правки', 'aria-label': 'есть несохранённые правки' }, '•') : null,
            ),
            directory === '' ? null : h('span', { className: 'dsh-ide-scm-dir' }, directory),
          ),
        ),
        action === null
          ? h(
              'button',
              {
                type: 'button',
                className: 'dsh-ide-scm-resolve-action',
                title: 'Собрать обе стороны конфликта и предложить разрешение',
                'aria-label': `Разрешить конфликт: ${row.entry.path}`,
                disabled: busy,
                onClick: (event) => {
                  event.stopPropagation()
                  if (typeof onResolve === 'function') onResolve(row)
                },
              },
              'Разрешить',
            )
          : h(
              'button',
              {
                type: 'button',
                className: 'dsh-ide-scm-action',
                title: actionLabel,
                'aria-label': `${actionLabel}: ${row.entry.path}`,
                disabled: busy,
                onClick: (event) => {
                  event.stopPropagation()
                  if (row.group === 'staged') onUnstage(row)
                  else onStage(row)
                },
              },
              action,
            ),
      )
    }

    function ScmGraph({ history, activeOid, onSelect, onMore, onReload }) {
      if (history.unborn) return h('div', { className: 'dsh-ide-scm-graph-note' }, 'Пока нет коммитов.')
      if (history.phase === 'loading') return h('div', { className: 'dsh-ide-scm-graph-note' }, 'Читаю историю…')
      if (history.phase === 'failed' && history.commits.length === 0) {
        return h(
          'div',
          { className: 'dsh-ide-scm-graph-note' },
          history.error,
          h('button', { type: 'button', className: 'dsh-ide-scm-link', onClick: onReload }, 'Повторить'),
        )
      }
      const layout = layoutGraph(history.commits)
      const columnWidth = 14
      const width = Math.max(columnWidth, layout.width * columnWidth)
      const rows = []
      history.commits.forEach((commit, index) => {
        const geometry = layout.rows[index]
        if (geometry === undefined) return
        const refs = Array.isArray(commit.refs) ? commit.refs.filter((ref) => typeof ref === 'string' && ref !== '') : []
        rows.push(
          h(
            'div',
            { className: `dsh-ide-scm-graph-row${activeOid === commit.oid ? ' dsh-ide-scm-graph-row-active' : ''}`, key: commit.oid },
            h(
              'svg',
              { className: 'dsh-ide-scm-graph-svg', width, height: 22, viewBox: `0 0 ${width} 22`, 'aria-hidden': 'true' },
              geometry.segments.map((segment, segmentIndex) =>
                h('path', {
                  key: segmentIndex,
                  d: `M${segment.x1 * columnWidth + 7} ${segment.y1} L${segment.x2 * columnWidth + 7} ${segment.y2}`,
                  fill: 'none',
                  stroke: scmGraphColor(segment.kind === 'out' ? segment.x2 : segment.x1),
                  strokeWidth: '1.4',
                  strokeLinecap: 'round',
                }),
              ),
              h('circle', { cx: geometry.column * columnWidth + 7, cy: 11, r: 4, fill: scmGraphColor(geometry.column) }),
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'dsh-ide-scm-graph-commit',
                title: `${commit.oid}\n${commit.author || ''}\n${formatScmTime(commit.time)}`,
                'aria-pressed': activeOid === commit.oid,
                onClick: () => onSelect(commit),
              },
              h('span', { className: 'dsh-ide-scm-graph-subject' }, commit.subject || '(без сообщения)'),
              h(
                'span',
                { className: 'dsh-ide-scm-graph-meta' },
                `${commit.oid.slice(0, 7)} · ${commit.author || ''}${formatScmTime(commit.time) === '' ? '' : ` · ${formatScmTime(commit.time)}`}`,
              ),
              refs.length === 0 ? null : h('span', { className: 'dsh-ide-scm-graph-refs' }, refs.join(', ')),
            ),
          ),
        )
      })
      if (rows.length === 0) return h('div', { className: 'dsh-ide-scm-graph-note' }, 'История пуста.')
      return h(
        'div',
        { className: 'dsh-ide-scm-graph' },
        h('div', { className: 'dsh-ide-scm-graph-list' }, rows),
        history.error ? h('div', { className: 'dsh-ide-scm-error' }, history.error) : null,
        history.cursor === null
          ? null
          : h(
              'button',
              {
                type: 'button',
                className: 'dsh-ide-scm-more',
                disabled: history.phase === 'more',
                onClick: onMore,
              },
              history.phase === 'more' ? 'Читаю…' : 'Ещё',
            ),
      )
    }

    // A Git comparison reuses the single Monaco diff editor of the assistant
    // review; only the shell around it differs: side labels, change navigation
    // and a visible way back to the list.
    function GitDiff({ view, dirty, onClose, onOpenFile, onPrevious, onNext, onSendPatch, patching, containerRef }) {
      const ready = view.phase === 'ready'
      const textual = ready && (view.kind === undefined || view.kind === 'text')
      const reason =
        view.phase === 'failed'
          ? view.error
          : ready && !textual
            ? view.message || (view.kind === 'binary' ? 'Двоичный файл: сравнение текстом недоступно.' : view.kind === 'outside' ? 'Файл вне рабочей папки.' : view.kind === 'too-large' ? 'Файл слишком большой для сравнения.' : 'Сравнение недоступно.')
            : ''
      return h(
        'div',
        { className: 'dsh-ide-diffview dsh-ide-gitdiff', 'data-phase': view.phase },
        h(
          'div',
          { className: 'dsh-ide-diffview-head dsh-ide-gitdiff-head' },
          h(
            'div',
            { className: 'dsh-ide-gitdiff-titles' },
            h(
              'button',
              { type: 'button', className: 'dsh-ide-diffview-action', title: 'Вернуться к списку изменений', onClick: onClose },
              '← К списку',
            ),
            h(
              'span',
              { className: 'dsh-ide-gitdiff-caption' },
              h('span', { className: 'dsh-ide-diffview-title' }, typeof view.oldPath === 'string' && view.oldPath !== '' ? `${view.oldPath} → ${view.path}` : view.path),
              h('span', { className: 'dsh-ide-diffview-sub' }, `${view.beforeLabel ?? ''} → ${view.afterLabel ?? ''}`),
              dirty ? h('span', { className: 'dsh-ide-diffview-note' }, 'На диске; есть несохранённые правки') : null,
              view.phase === 'pending' ? h('span', { className: 'dsh-ide-diffview-note' }, 'Читаю снимок…') : null,
              view.phase === 'failed' ? h('span', { className: 'dsh-ide-diffview-error' }, view.error) : null,
            ),
          ),
          h(
            'div',
            { className: 'dsh-ide-gitdiff-actions' },
            h(
              'button',
              {
                type: 'button',
                className: 'dsh-ide-diffview-action',
                title: 'Предыдущее изменение',
                'aria-label': 'Предыдущее изменение',
                disabled: !textual,
                onClick: onPrevious,
              },
              '‹',
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'dsh-ide-diffview-action',
                title: 'Следующее изменение',
                'aria-label': 'Следующее изменение',
                disabled: !textual,
                onClick: onNext,
              },
              '›',
            ),
            view.canOpen === true
              ? h(
                  'button',
                  { type: 'button', className: 'dsh-ide-diffview-action', title: 'Открыть файл на диске', onClick: () => onOpenFile(view.path) },
                  'Открыть файл',
                )
              : null,
            (view.group === 'staged' || view.group === 'changes') && typeof onSendPatch === 'function'
              ? h(
                  'button',
                  {
                    type: 'button',
                    className: 'dsh-ide-diffview-action dsh-ide-gitdiff-chat',
                    title: 'Вставить точный Git diff этого файла в чат',
                    disabled: patching === true || !textual,
                    onClick: () => onSendPatch(view.group, view.path),
                  },
                  patching === true ? '…' : 'В чат',
                )
              : null,
          ),
        ),
        h(
          'div',
          { className: 'dsh-ide-diffview-body', ref: textual ? containerRef : undefined },
          view.phase === 'pending'
            ? h('div', { className: 'dsh-ide-diffview-reason' }, 'Читаю снимок…')
            : reason !== ''
              ? h('div', { className: 'dsh-ide-diffview-reason' }, reason)
              : null,
        ),
      )
    }

    function SourceControl(props) {
      const sessionId = typeof props.sessionId === 'string' ? props.sessionId : ''
      const snapshot = props.status
      const error = typeof props.error === 'string' ? props.error : ''
      const loading = props.loading === true
      const readOnly = snapshot !== undefined && snapshot !== null && snapshot.readOnly === true
      const sections = scmSections(snapshot)
      const stagedCount = sections.find((section) => section.id === 'staged')?.rows.length ?? 0
      const head = snapshot !== undefined && snapshot !== null && typeof snapshot.head === 'string' ? snapshot.head : ''
      const branch = snapshot !== undefined && snapshot !== null && typeof snapshot.branch === 'string' && snapshot.branch !== '' ? snapshot.branch : ''
      const detached = snapshot !== undefined && snapshot !== null && snapshot.detached === true
      const unborn = snapshot !== undefined && snapshot !== null && snapshot.unborn === true
      const message = typeof props.message === 'string' ? props.message : ''
      const [graphOpen, setGraphOpen] = React.useState(true)
      const [history, setHistory] = React.useState({ phase: 'idle', commits: [], cursor: null, error: '', unborn: false })
      const [historyReload, setHistoryReload] = React.useState(0)
      const [commitView, setCommitView] = React.useState(undefined)
      const [branchOpen, setBranchOpen] = React.useState(false)
      const [branchState, setBranchState] = React.useState({ phase: 'idle', current: '', detached: false, branches: [], error: '' })
      const [branchReload, setBranchReload] = React.useState(0)
      const [branchBusy, setBranchBusy] = React.useState('')
      const [branchCreating, setBranchCreating] = React.useState(false)
      const [branchDraft, setBranchDraft] = React.useState('')
      const [branchDelete, setBranchDelete] = React.useState('')
      const historySeq = React.useRef(0)
      const commitSeq = React.useRef(0)
      const branchSeq = React.useRef(0)

      // Review is an explicit, cancellable request for the staged snapshot.
      // `revision` is kept with the answer: if the index moves afterwards the
      // findings stay readable but are marked as belonging to an older snapshot.
      const [review, setReview] = React.useState({ phase: 'idle', findings: [], files: [], skipped: [], bytes: 0, revision: '', depth: 'quick', calls: 0, durationMs: 0, error: '' })
      const [reviewDepth, setReviewDepth] = React.useState('quick')
      const [drafting, setDrafting] = React.useState(false)
      const [draftError, setDraftError] = React.useState('')
      const reviewAbort = React.useRef(undefined)
      const [conflictView, setConflictView] = React.useState(undefined)
      const [conflictBusy, setConflictBusy] = React.useState(false)
      const conflictSeq = React.useRef(0)
      const [compareDraft, setCompareDraft] = React.useState('main')
      const [compare, setCompare] = React.useState({ phase: 'idle', base: '', data: undefined, error: '' })
      const kilobytes = (bytes) => `${Math.max(1, Math.round((Number.isFinite(bytes) ? bytes : 0) / 1024))} КиБ`
      const skipReason = (reason) => {
        switch (reason) {
          case 'untracked':
            return 'не в индексе'
          case 'binary':
            return 'двоичный'
          case 'secret':
            return 'похож на секрет'
          case 'ignored':
            return 'исключено .dshideignore'
          case 'too-large':
            return 'больше лимита'
          case 'empty':
            return 'нет текста'
          case 'limit':
            return 'не вошло в лимит'
          default:
            return String(reason)
        }
      }

      const runCompare = async () => {
        const base = compareDraft.trim()
        if (sessionId === '' || base === '' || compare.phase === 'running') return
        setCompare({ phase: 'running', base, data: compare.data, error: '' })
        try {
          const payload = await call('scmCompare', { sessionId, base })
          setCompare({ phase: 'ready', base, data: payload, error: '' })
        } catch (cause) {
          setCompare({ phase: 'failed', base, data: undefined, error: describeScmError(cause) })
        }
      }

      const startReview = async () => {
        if (sessionId === '' || snapshot === undefined || stagedCount === 0 || review.phase === 'running' || readOnly) return
        reviewAbort.current?.abort()
        const controller = new AbortController()
        reviewAbort.current = controller
        setReview((previous) => ({ ...previous, phase: 'running', error: '' }))
        try {
          const payload = await call('scmReview', { sessionId, revision: snapshot.revision, depth: reviewDepth }, controller.signal)
          if (controller.signal.aborted) return
          setReview({
            phase: 'ready',
            findings: Array.isArray(payload?.findings) ? payload.findings : [],
            files: Array.isArray(payload?.files) ? payload.files : [],
            skipped: Array.isArray(payload?.skipped) ? payload.skipped : [],
            bytes: Number.isFinite(payload?.bytes) ? payload.bytes : 0,
            revision: typeof payload?.revision === 'string' ? payload.revision : '',
            depth: payload?.depth === 'deep' ? 'deep' : 'quick',
            calls: Number.isFinite(payload?.calls) ? payload.calls : 1,
            durationMs: Number.isFinite(payload?.durationMs) ? payload.durationMs : 0,
            error: '',
          })
        } catch (cause) {
          if (cause?.code === 'cancelled') {
            setReview((previous) => ({ ...previous, phase: 'idle' }))
            return
          }
          setReview((previous) => ({ ...previous, phase: 'failed', error: describeScmError(cause) }))
        }
      }

      const cancelReview = () => {
        reviewAbort.current?.abort()
        setReview((previous) => ({ ...previous, phase: 'idle' }))
      }

      const draftMessage = async () => {
        setDraftError('')
        if (sessionId === '' || snapshot === undefined || stagedCount === 0 || drafting || readOnly) return
        if (message.trim() !== '' && typeof window !== 'undefined' && typeof window.confirm === 'function') {
          if (!window.confirm('Заменить текущее сообщение черновиком модели?')) return
        }
        setDrafting(true)
        try {
          const payload = await call('scmDraftMessage', { sessionId, revision: snapshot.revision })
          if (typeof payload?.message === 'string' && payload.message !== '') props.onMessage(payload.message)
        } catch (cause) {
          setDraftError(describeScmError(cause))
        } finally {
          setDrafting(false)
        }
      }

      // A conflict is resolved locally: the model only proposes text, and the
      // file plus the index change when the user applies that text.
      const generateConflict = async (path) => {
        if (sessionId === '' || snapshot === undefined || readOnly) return
        const seq = (conflictSeq.current += 1)
        setConflictView({ phase: 'loading', path, resolution: '', revision: '', error: '' })
        try {
          const payload = await call('scmResolve', { sessionId, path, revision: snapshot.revision })
          if (seq !== conflictSeq.current) return
          setConflictView({
            phase: 'ready',
            path,
            resolution: typeof payload?.resolution === 'string' ? payload.resolution : '',
            revision: typeof payload?.revision === 'string' ? payload.revision : '',
            error: '',
          })
        } catch (cause) {
          if (seq !== conflictSeq.current) return
          setConflictView({ phase: 'failed', path, resolution: '', revision: '', error: describeScmError(cause) })
        }
      }

      const applyConflict = async () => {
        if (conflictView === undefined || conflictView.phase !== 'ready' || conflictBusy) return
        setConflictBusy(true)
        try {
          await call('scmResolveApply', {
            sessionId,
            path: conflictView.path,
            text: conflictView.resolution,
            revision: conflictView.revision,
          })
          setConflictView(undefined)
          if (typeof props.onRefresh === 'function') props.onRefresh()
        } catch (cause) {
          setConflictView((previous) =>
            previous === undefined ? previous : { ...previous, error: describeScmError(cause) },
          )
        } finally {
          setConflictBusy(false)
        }
      }

      const cancelConflict = () => {
        conflictSeq.current += 1
        setConflictView(undefined)
      }

      React.useEffect(
        () => () => {
          reviewAbort.current?.abort()
        },
        [],
      )

      React.useEffect(() => {
        if (!branchOpen || sessionId === '') return undefined
        let cancelled = false
        const seq = (branchSeq.current += 1)
        setBranchState((previous) => ({
          ...previous,
          phase: previous.branches.length === 0 ? 'loading' : 'refreshing',
          error: '',
        }))
        void call('scmBranches', { sessionId })
          .then((payload) => {
            if (cancelled || seq !== branchSeq.current) return
            setBranchState({
              phase: 'ready',
              current: typeof payload?.current === 'string' ? payload.current : '',
              detached: payload?.detached === true,
              branches: Array.isArray(payload?.branches) ? payload.branches : [],
              error: '',
            })
          })
          .catch((cause) => {
            if (cancelled || seq !== branchSeq.current || cause?.code === 'cancelled') return
            setBranchState((previous) => ({ ...previous, phase: 'failed', error: describeScmError(cause) }))
          })
        return () => {
          cancelled = true
        }
      }, [branchOpen, sessionId, branch, head, branchReload])

      React.useEffect(() => {
        if (!graphOpen || sessionId === '') return undefined
        let cancelled = false
        const seq = (historySeq.current += 1)
        setHistory((previous) => ({ ...previous, phase: previous.commits.length === 0 ? 'loading' : 'more', error: '' }))
        void call('scmHistory', { sessionId })
          .then((page) => {
            if (cancelled || seq !== historySeq.current) return
            setHistory({
              phase: 'ready',
              commits: page !== null && Array.isArray(page.commits) ? page.commits : [],
              cursor: page !== null && page.nextCursor !== undefined ? page.nextCursor : null,
              error: '',
              unborn: page !== null && page.unborn === true,
            })
          })
          .catch((cause) => {
            if (cancelled || seq !== historySeq.current || cause?.code === 'cancelled') return
            setHistory((previous) => ({ ...previous, phase: 'failed', error: describeScmError(cause) }))
          })
        return () => {
          cancelled = true
        }
      }, [graphOpen, sessionId, head, branch, historyReload])

      const loadMore = () => {
        if (sessionId === '' || history.cursor === null || history.phase === 'more') return
        const seq = (historySeq.current += 1)
        setHistory((previous) => ({ ...previous, phase: 'more', error: '' }))
        void call('scmHistory', { sessionId, cursor: history.cursor })
          .then((page) => {
            if (seq !== historySeq.current) return
            const next = page !== null && Array.isArray(page.commits) ? page.commits : []
            setHistory((previous) => {
              const seen = new Set(previous.commits.map((commit) => commit.oid))
              const commits = previous.commits.concat(next.filter((commit) => !seen.has(commit.oid)))
              return { phase: 'ready', commits, cursor: page?.nextCursor ?? null, error: '', unborn: previous.unborn }
            })
          })
          .catch((cause) => {
            if (seq !== historySeq.current || cause?.code === 'cancelled') return
            setHistory((previous) => ({ ...previous, phase: 'failed', error: describeScmError(cause) }))
          })
      }

      const openCommit = (commit, base) => {
        if (sessionId === '' || commit === undefined) return
        const parents = Array.isArray(commit.parents) ? commit.parents.filter((oid) => typeof oid === 'string' && oid !== '') : []
        const selectedBase = typeof base === 'string' ? base : parents[0] ?? ''
        const seq = (commitSeq.current += 1)
        setCommitView({ phase: 'loading', oid: commit.oid, subject: commit.subject, time: commit.time, parents, base: selectedBase, files: [], error: '' })
        void call('scmCommitFiles', { sessionId, oid: commit.oid, base: selectedBase })
          .then((payload) => {
            if (seq !== commitSeq.current) return
            setCommitView({
              phase: 'ready',
              oid: commit.oid,
              subject: commit.subject,
              time: commit.time,
              parents,
              base: typeof payload?.base === 'string' ? payload.base : selectedBase,
              files: Array.isArray(payload?.entries) ? payload.entries : [],
              error: '',
            })
          })
          .catch((cause) => {
            if (seq !== commitSeq.current || cause?.code === 'cancelled') return
            setCommitView((previous) => (previous === undefined ? previous : { ...previous, phase: 'failed', error: describeScmError(cause) }))
          })
      }

      const runBranch = (route, value) => {
        const name = typeof value === 'string' ? value.trim() : ''
        if (sessionId === '' || branchBusy !== '' || name === '') return
        setBranchBusy(route)
        setBranchState((previous) => ({ ...previous, error: '' }))
        void call(route, { sessionId, name })
          .then((payload) => {
            if (payload?.branches !== undefined && Array.isArray(payload.branches.branches)) {
              setBranchState({
                phase: 'ready',
                current: typeof payload.branches.current === 'string' ? payload.branches.current : '',
                detached: payload.branches.detached === true,
                branches: payload.branches.branches,
                error: '',
              })
            }
            if (route !== 'scmDeleteBranch') {
              setCommitView(undefined)
              setBranchOpen(false)
              setBranchCreating(false)
              setBranchDraft('')
              if (typeof props.onBranchChanged === 'function') props.onBranchChanged(payload)
              setHistoryReload((value) => value + 1)
            }
            setBranchDelete('')
          })
          .catch((cause) => {
            if (cause?.code === 'cancelled') return
            setBranchState((previous) => ({ ...previous, error: describeScmError(cause) }))
          })
          .finally(() => setBranchBusy(''))
      }

      const header = h(
        'div',
        { className: 'dsh-ide-explorer-head' },
        h('span', { className: 'dsh-ide-explorer-title' }, 'GIT'),
        h(
          'span',
          { className: 'dsh-ide-explorer-actions' },
          h(
            'button',
            {
              type: 'button',
              className: 'dsh-ide-icon-button',
              title: 'Обновить состояние Git',
              'aria-label': 'Обновить состояние Git',
              disabled: loading,
              onClick: () => {
                if (typeof props.onRefresh === 'function') props.onRefresh()
              },
            },
            h(ToolbarIcon, { kind: 'refresh' }),
          ),
          h(
            'button',
            { type: 'button', className: 'dsh-ide-icon-button', title: 'Скрыть панель Git', 'aria-label': 'Скрыть панель Git', onClick: () => props.onClose() },
            '✕',
          ),
        ),
      )

      if (snapshot === undefined && loading) {
        return h('div', { className: 'dsh-ide-explorer dsh-ide-scm' }, header, h('div', { className: 'dsh-ide-scm-graph-note' }, 'Читаю состояние Git…'))
      }

      if (snapshot === undefined) {
        return h(
          'div',
          { className: 'dsh-ide-explorer dsh-ide-scm' },
          header,
          h(
            'div',
            { className: 'dsh-ide-scm-error', role: 'status' },
            error === '' ? 'Состояние Git недоступно.' : error,
            h('button', { type: 'button', className: 'dsh-ide-scm-link', onClick: () => props.onRefresh() }, 'Повторить'),
          ),
        )
      }

      const branchLabel = detached ? 'отдельная HEAD' : branch === '' ? 'ветка не определена' : branch
      const composer = h(
        'div',
        { className: 'dsh-ide-scm-commit' },
        h('textarea', {
          className: 'dsh-ide-scm-message',
          rows: 3,
          value: message,
          placeholder: 'Сообщение фиксации',
          'aria-label': 'Сообщение фиксации',
          disabled: readOnly,
          onChange: (event) => props.onMessage(event.target.value),
          onKeyDown: (event) => {
            if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
              event.preventDefault()
              props.onCommit()
            }
          },
        }),
        h(
          'button',
          {
            type: 'button',
            className: 'dsh-ide-button dsh-ide-button-primary dsh-ide-scm-commit-button',
            disabled: readOnly || props.committing === true || message.trim() === '' || stagedCount === 0,
            title:
              stagedCount === 0
                ? 'Сначала подготовьте изменения кнопкой «+»'
                : message.trim() === ''
                  ? 'Введите сообщение фиксации'
                  : 'Зафиксировать только подготовленные файлы',
            onClick: () => props.onCommit(),
          },
          props.committing === true ? 'Фиксирую…' : 'Зафиксировать',
        ),
        h(
          'div',
          { className: 'dsh-ide-scm-hint' },
          stagedCount === 0 ? 'Отметьте «+» файлы, которые войдут в коммит.' : `В коммит войдут подготовленные файлы: ${stagedCount}.`,
        ),
        h(
          'div',
          { className: 'dsh-ide-scm-actions' },
          h(
            'div',
            { className: 'dsh-ide-scm-depth', role: 'group', 'aria-label': 'Глубина проверки' },
            h(
              'button',
              {
                type: 'button',
                className: 'dsh-ide-scm-depth-button',
                'aria-pressed': reviewDepth === 'quick',
                disabled: review.phase === 'running',
                title: 'Один запрос по всему индексу',
                onClick: () => setReviewDepth('quick'),
              },
              'Быстро',
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'dsh-ide-scm-depth-button',
                'aria-pressed': reviewDepth === 'deep',
                disabled: review.phase === 'running',
                title: 'До четырёх запросов по группам файлов — дольше, но каждый видит меньше diff',
                onClick: () => setReviewDepth('deep'),
              },
              'Глубоко',
            ),
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'dsh-ide-button dsh-ide-scm-review-button',
              disabled: readOnly || (stagedCount === 0 && review.phase !== 'running'),
              title:
                review.phase === 'running'
                  ? 'Отменить проверку'
                  : stagedCount === 0
                    ? 'Сначала подготовьте изменения кнопкой «+»'
                    : 'Отправить точный diff индекса модели на проверку',
              onClick: () => {
                if (review.phase === 'running') cancelReview()
                else void startReview()
              },
            },
            review.phase === 'running' ? 'Отменить' : 'Проверить индекс',
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'dsh-ide-button dsh-ide-scm-draft-button',
              disabled: readOnly || stagedCount === 0 || drafting || review.phase === 'running',
              title: stagedCount === 0 ? 'Сначала подготовьте изменения кнопкой «+»' : 'Составить сообщение по diff индекса',
              onClick: () => {
                void draftMessage()
              },
            },
            drafting ? 'Пишу…' : 'Черновик',
          ),
          review.phase === 'ready'
            ? h(
                'span',
                { className: 'dsh-ide-scm-review-note' },
                `${review.depth === 'deep' ? 'Глубоко' : 'Быстро'} · ${review.calls} вызов(а) · ${(review.durationMs / 1000).toFixed(1)} с · ${review.files.length} файл(ов) · ${kilobytes(review.bytes)}`,
              )
            : null,
        ),
        h(
          'div',
          { className: 'dsh-ide-scm-compare' },
          h('div', { className: 'dsh-ide-scm-compare-head' }, 'Сравнить с базой'),
          h(
            'div',
            { className: 'dsh-ide-scm-compare-form' },
            h('input', {
              className: 'dsh-ide-scm-compare-input',
              value: compareDraft,
              placeholder: 'main',
              onChange: (event) => setCompareDraft(event.target.value),
              onKeyDown: (event) => {
                if (event.key === 'Enter') void runCompare()
              },
            }),
            h(
              'button',
              {
                type: 'button',
                className: 'dsh-ide-button',
                disabled: compare.phase === 'running' || compareDraft.trim() === '',
                onClick: () => void runCompare(),
              },
              compare.phase === 'running' ? 'Сравниваю…' : 'Сравнить',
            ),
          ),
          compare.phase === 'failed' ? h('div', { className: 'dsh-ide-scm-error' }, compare.error) : null,
          compare.phase === 'ready' && compare.data !== undefined
            ? h(
                'div',
                { className: 'dsh-ide-scm-compare-result' },
                h(
                  'div',
                  { className: 'dsh-ide-scm-compare-note' },
                  `${compare.data.base} · точка ветвления ${String(compare.data.mergeBase).slice(0, 7)} · впереди ${compare.data.ahead}, позади ${compare.data.behind}`,
                ),
                h(
                  'div',
                  { className: 'dsh-ide-scm-compare-files' },
                  compare.data.files.map((file) =>
                    h(
                      'div',
                      { className: 'dsh-ide-scm-compare-file', key: `${file.status}:${file.path}`, title: file.oldPath ?? file.path },
                      h('span', { className: 'dsh-ide-scm-compare-status' }, String(file.status).slice(0, 1)),
                      h('span', { className: 'dsh-ide-scm-compare-path' }, file.path),
                    ),
                  ),
                ),
                compare.data.truncated
                  ? h('div', { className: 'dsh-ide-scm-compare-note' }, `Показано ${compare.data.files.length} из ${compare.data.total}.`)
                  : null,
              )
            : null,
        ),
        draftError === '' ? null : h('div', { className: 'dsh-ide-scm-error', role: 'status' }, draftError),
      )

      const reviewPanel =
        review.phase === 'idle'
          ? null
          : h(
              'div',
              { className: 'dsh-ide-scm-review', 'data-phase': review.phase, role: 'status' },
              review.phase === 'running'
                ? h('div', { className: 'dsh-ide-scm-review-note' }, 'Проверяю подготовленный diff…')
                : null,
              review.phase === 'failed'
                ? h(
                    'div',
                    { className: 'dsh-ide-scm-error' },
                    review.error,
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'dsh-ide-scm-link',
                        onClick: () => {
                          void startReview()
                        },
                      },
                      'Повторить',
                    ),
                  )
                : null,
              review.phase === 'ready'
                ? h(
                    'div',
                    { className: 'dsh-ide-scm-review-body' },
                    review.revision !== '' && snapshot !== undefined && snapshot.revision !== review.revision
                      ? h(
                          'div',
                          { className: 'dsh-ide-scm-review-stale' },
                          'Проверка устарела: индекс изменился.',
                          h(
                            'button',
                            {
                              type: 'button',
                              className: 'dsh-ide-scm-link',
                              onClick: () => {
                                void startReview()
                              },
                            },
                            'Проверить заново',
                          ),
                        )
                      : null,
                    review.skipped.length === 0
                      ? null
                      : h(
                          'div',
                          { className: 'dsh-ide-scm-review-note' },
                          `Пропущено: ${review.skipped.map((item) => `${item.path} (${skipReason(item.reason)})`).join(', ')}`,
                        ),
                    review.findings.length === 0
                      ? h('div', { className: 'dsh-ide-scm-review-note' }, 'Замечаний не найдено.')
                      : h(
                          'div',
                          { className: 'dsh-ide-scm-findings' },
                          review.findings.map((finding, index) =>
                            h(
                              'button',
                              {
                                key: `${finding.path}:${finding.line}:${index}`,
                                type: 'button',
                                className: `dsh-ide-scm-finding dsh-ide-scm-finding-${finding.severity}`,
                                title: `${finding.path}:${finding.line} — открыть в сравнении`,
                                onClick: () => {
                                  if (typeof props.onOpenFinding === 'function') props.onOpenFinding(finding)
                                },
                              },
                              h('span', { className: 'dsh-ide-scm-finding-where' }, `${finding.path}:${finding.line}`),
                              h('span', { className: 'dsh-ide-scm-finding-message' }, finding.message),
                            ),
                          ),
                        ),
                  )
                : null,
            )

      const conflictPanel =
        conflictView === undefined
          ? null
          : h(
              'div',
              { className: 'dsh-ide-scm-resolve', 'data-phase': conflictView.phase, role: 'group', 'aria-label': 'Разрешение конфликта' },
              h(
                'div',
                { className: 'dsh-ide-scm-section-head' },
                h('span', { className: 'dsh-ide-scm-section-title' }, 'Разрешение конфликта'),
                h('span', { className: 'dsh-ide-scm-resolve-path', title: conflictView.path }, conflictView.path),
                h('button', { type: 'button', className: 'dsh-ide-scm-link', onClick: cancelConflict }, 'Закрыть'),
              ),
              conflictView.phase === 'loading'
                ? h('div', { className: 'dsh-ide-scm-review-note' }, 'Собираю стороны конфликта и предложение модели…')
                : null,
              conflictView.phase === 'failed'
                ? h(
                    'div',
                    { className: 'dsh-ide-scm-error', role: 'status' },
                    conflictView.error,
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'dsh-ide-scm-link',
                        onClick: () => {
                          void generateConflict(conflictView.path)
                        },
                      },
                      'Повторить',
                    ),
                  )
                : null,
              conflictView.phase === 'ready'
                ? h(
                    'div',
                    { className: 'dsh-ide-scm-resolve-body' },
                    h(
                      'div',
                      { className: 'dsh-ide-scm-review-note' },
                      'Проверьте текст: «Применить» запишет его в файл и в индекс. Git-состояние изменится только по этой кнопке.',
                    ),
                    h('textarea', {
                      className: 'dsh-ide-scm-resolve-text',
                      value: conflictView.resolution,
                      spellCheck: false,
                      'aria-label': 'Предложенное разрешение конфликта',
                      onChange: (event) => {
                        const resolution = event.target.value
                        setConflictView((previous) => (previous === undefined ? previous : { ...previous, resolution, error: '' }))
                      },
                    }),
                    conflictView.error === ''
                      ? null
                      : h('div', { className: 'dsh-ide-scm-error', role: 'status' }, conflictView.error),
                    h(
                      'div',
                      { className: 'dsh-ide-scm-resolve-actions' },
                      h(
                        'button',
                        { type: 'button', className: 'dsh-ide-button', disabled: conflictBusy, onClick: () => { void applyConflict() } },
                        conflictBusy ? 'Записываю…' : 'Применить',
                      ),
                      h('button', { type: 'button', className: 'dsh-ide-scm-link', disabled: conflictBusy, onClick: cancelConflict }, 'Отмена'),
                    ),
                  )
                : null,
            )

      const workingSections = h(
        'div',
        { className: 'dsh-ide-scm-working' },
        composer,
        reviewPanel,
        conflictPanel,
        sections.length === 0
          ? h('div', { className: 'dsh-ide-scm-clean' }, 'Рабочая папка чиста.')
          : sections.map((section) =>
              h(
                'div',
                { className: 'dsh-ide-scm-section', key: section.id },
                h(
                  'div',
                  { className: 'dsh-ide-scm-section-head' },
                  h('span', { className: 'dsh-ide-scm-section-title' }, section.title),
                  h('span', { className: 'dsh-ide-scm-section-count' }, String(section.rows.length)),
                  section.id === 'conflicts'
                    ? null
                    : h(
                        'button',
                        {
                          type: 'button',
                          className: 'dsh-ide-scm-chat',
                          title: 'Вставить точный Git diff этой группы в чат',
                          disabled: props.patching === true || section.rows.length === 0,
                          onClick: () => {
                            if (typeof props.onSendPatch === 'function') props.onSendPatch(section.id, undefined)
                          },
                        },
                        props.patching === true ? '…' : 'В чат',
                      ),
                ),
                section.rows.map((row) =>
                  h(ScmRow, {
                    key: row.key,
                    row,
                    active: typeof props.activePath === 'string' && props.activePath === row.entry.path,
                    unsaved:
                      props.unsavedPaths instanceof Set
                        ? props.unsavedPaths.has(row.entry.path)
                        : Array.isArray(props.unsavedPaths) && props.unsavedPaths.includes(row.entry.path),
                    busy: typeof props.busy === 'string' && props.busy !== '',
                    onOpen: (target) => props.onOpenRow(target),
                    onStage: (target) => props.onStageRow(target),
                    onUnstage: (target) => props.onUnstageRow(target),
                    onResolve: (target) => {
                      void generateConflict(target.entry.path)
                    },
                  }),
                ),
              ),
            ),
      )

      const selectedCommit = commitView === undefined ? null : h(
        'div',
        { className: 'dsh-ide-scm-selected' },
        h(
          'div',
          { className: 'dsh-ide-scm-section-head' },
          h('span', { className: 'dsh-ide-scm-section-title' }, 'Изменения'),
          h(
            'span',
            { className: 'dsh-ide-scm-section-count' },
            commitView.phase === 'ready' ? String(commitView.files.length) : '…',
          ),
        ),
        h(
          'div',
          { className: 'dsh-ide-scm-commit-summary' },
          h('div', { className: 'dsh-ide-scm-commit-subject' }, commitView.subject || '(без сообщения)'),
          h('div', { className: 'dsh-ide-scm-commit-oid' }, `${commitView.oid.slice(0, 12)} · ${commitView.time === undefined ? '' : formatScmTime(commitView.time)}`),
          commitView.parents.length > 1
            ? h(
                'label',
                { className: 'dsh-ide-scm-parent' },
                h('span', { className: 'dsh-ide-scm-parent-label' }, 'Сравнить с родителем'),
                h(
                  'select',
                  {
                    value: commitView.base,
                    'aria-label': 'Родитель для сравнения',
                    onChange: (event) => openCommit({ oid: commitView.oid, subject: commitView.subject, parents: commitView.parents, time: commitView.time }, event.target.value),
                  },
                  commitView.parents.map((parent, index) =>
                    h('option', { value: parent, key: parent }, `${index + 1}: ${parent.slice(0, 7)}`),
                  ),
                ),
              )
            : h('div', { className: 'dsh-ide-scm-commit-base' }, commitView.base === '' ? 'Корневой коммит: до него файлов нет' : `Родитель: ${commitView.base.slice(0, 7)}`),
          h(
            'button',
            { type: 'button', className: 'dsh-ide-scm-back', onClick: () => setCommitView(undefined) },
            '← К рабочим изменениям',
          ),
        ),
        commitView.phase === 'loading'
          ? h('div', { className: 'dsh-ide-scm-graph-note' }, 'Читаю файлы коммита…')
          : commitView.phase === 'failed'
            ? h('div', { className: 'dsh-ide-scm-error', role: 'status' }, commitView.error)
            : commitView.files.length === 0
              ? h('div', { className: 'dsh-ide-scm-graph-note' }, 'В этом коммите нет изменённых файлов.')
              : h(
                  'div',
                  { className: 'dsh-ide-scm-files', role: 'list' },
                  commitView.files.map((file) =>
                    h(
                      'button',
                      {
                        type: 'button',
                        key: `${file.status}:${file.path}`,
                        className: 'dsh-ide-scm-file',
                        title: file.oldPath === undefined ? file.path : `${file.oldPath} → ${file.path}`,
                        onClick: () => props.onOpenCommitFile(commitView, file),
                      },
                      h('span', { className: 'dsh-ide-scm-letter', 'data-letter': file.status, 'aria-hidden': 'true' }, file.status),
                      h('span', { className: 'dsh-ide-scm-file-path' }, file.path),
                    ),
                  ),
                ),
      )

      const branchPanel = branchOpen
        ? h(
            'div',
            { className: 'dsh-ide-scm-branches', id: 'dsh-ide-scm-branches', role: 'group', 'aria-label': 'Ветки Git' },
            h(
              'div',
              { className: 'dsh-ide-scm-branches-head' },
              h('span', { className: 'dsh-ide-scm-branches-title' }, 'Ветки'),
              h(
                'button',
                { type: 'button', className: 'dsh-ide-scm-link', title: 'Обновить список веток', onClick: () => setBranchReload((value) => value + 1) },
                'Обновить',
              ),
            ),
            branchState.error === '' ? null : h('div', { className: 'dsh-ide-scm-error', role: 'status' }, branchState.error),
            branchState.phase === 'loading' && branchState.branches.length === 0
              ? h('div', { className: 'dsh-ide-scm-graph-note' }, 'Читаю ветки…')
              : h(
                  'div',
                  { className: 'dsh-ide-scm-branch-list' },
                  branchState.branches.map((entry) => {
                    const isCurrent = entry.current === true || entry.name === (branchState.current || branch)
                    if (branchDelete === entry.name) {
                      return h(
                        'div',
                        { className: 'dsh-ide-scm-branch-confirm', key: entry.name },
                        h('span', { className: 'dsh-ide-scm-branch-confirm-text' }, `Удалить ветку ${entry.name}?`),
                        h(
                          'button',
                          { type: 'button', className: 'dsh-ide-scm-branch-danger', disabled: branchBusy !== '', onClick: () => runBranch('scmDeleteBranch', entry.name) },
                          'Удалить',
                        ),
                        h('button', { type: 'button', className: 'dsh-ide-scm-link', onClick: () => setBranchDelete('') }, 'Отмена'),
                      )
                    }
                    return h(
                      'div',
                      { className: `dsh-ide-scm-branch-row${isCurrent ? ' dsh-ide-scm-branch-row-current' : ''}`, key: entry.name },
                      h(
                        'button',
                        {
                          type: 'button',
                          className: 'dsh-ide-scm-branch-pick',
                          disabled: isCurrent || branchBusy !== '',
                          title: isCurrent ? `Текущая ветка: ${entry.name}` : `Переключиться на ${entry.name}`,
                          onClick: () => runBranch('scmSwitchBranch', entry.name),
                        },
                        h('span', { className: 'dsh-ide-scm-branch-check', 'aria-hidden': 'true' }, isCurrent ? '✓' : ''),
                        h('span', { className: 'dsh-ide-scm-branch-option-name' }, entry.name),
                        isCurrent ? h('span', { className: 'dsh-ide-scm-branch-badge' }, 'текущая') : null,
                      ),
                      isCurrent
                        ? null
                        : h(
                            'button',
                            {
                              type: 'button',
                              className: 'dsh-ide-scm-branch-delete',
                              title: `Удалить ветку ${entry.name}`,
                              'aria-label': `Удалить ветку ${entry.name}`,
                              disabled: branchBusy !== '',
                              onClick: () => setBranchDelete(entry.name),
                            },
                            '×',
                          ),
                    )
                  }),
                ),
            h(
              'form',
              {
                className: 'dsh-ide-scm-new-branch',
                onSubmit: (event) => {
                  event.preventDefault()
                  if (branchDraft.trim() !== '') runBranch('scmCreateBranch', branchDraft)
                },
              },
              branchCreating
                ? [
                    h('input', {
                      key: 'name',
                      className: 'dsh-ide-scm-branch-input',
                      value: branchDraft,
                      placeholder: 'Имя новой ветки',
                      'aria-label': 'Имя новой ветки',
                      autoFocus: true,
                      onChange: (event) => setBranchDraft(event.target.value),
                      onKeyDown: (event) => {
                        if (event.key !== 'Escape') return
                        setBranchCreating(false)
                        setBranchDraft('')
                      },
                    }),
                    h(
                      'button',
                      { key: 'create', type: 'submit', className: 'dsh-ide-scm-new-branch-submit', disabled: branchBusy !== '' || branchDraft.trim() === '' },
                      branchBusy === 'scmCreateBranch' ? 'Создаю…' : 'Создать',
                    ),
                    h(
                      'button',
                      { key: 'cancel', type: 'button', className: 'dsh-ide-scm-link', onClick: () => { setBranchCreating(false); setBranchDraft('') } },
                      'Отмена',
                    ),
                  ]
                : h(
                    'button',
                    {
                      type: 'button',
                      className: 'dsh-ide-scm-new-branch-button',
                      disabled: branchBusy !== '',
                      onClick: () => { setBranchCreating(true); setBranchDraft('') },
                    },
                    '+ Новая ветка',
                  ),
            ),
          )
        : null

      return h(
        'div',
        { className: 'dsh-ide-explorer dsh-ide-scm' },
        header,
        h(
          'button',
          {
            type: 'button',
            className: `dsh-ide-scm-branch${branchOpen ? ' dsh-ide-scm-branch-open' : ''}`,
            title: detached ? `HEAD: ${head}. Выбрать ветку` : `Ветка ${branchLabel}. Выбрать ветку`,
            'aria-expanded': branchOpen,
            'aria-controls': 'dsh-ide-scm-branches',
            'aria-label': `Ветка: ${branchLabel}. Выбрать ветку`,
            onClick: () => {
              setBranchOpen((value) => !value)
              setBranchDelete('')
              setBranchCreating(false)
              setBranchDraft('')
            },
          },
          h('span', { className: 'dsh-ide-scm-branch-icon' }, h(ScmBranchIcon)),
          h('span', { className: 'dsh-ide-scm-branch-name' }, branchLabel),
          h('span', { className: 'dsh-ide-scm-branch-head' }, head === '' ? '' : head.slice(0, 7)),
          h('span', { className: 'dsh-ide-scm-branch-caret', 'aria-hidden': 'true' }, branchOpen ? '▴' : '▾'),
        ),
        branchPanel,
        error === '' ? null : h('div', { className: 'dsh-ide-scm-error', role: 'status' }, error),
        readOnly ? h('div', { className: 'dsh-ide-scm-note' }, 'Только чтение: политика сессии не разрешает менять индекс.') : null,
        unborn ? h('div', { className: 'dsh-ide-scm-note' }, 'Ветка ещё без коммитов: первый коммит заберёт подготовленные файлы.') : null,
        h(
          'div',
          { className: 'dsh-ide-scm-scroll' },
          commitView === undefined ? workingSections : selectedCommit,
        ),
        h(
          'div',
          { className: 'dsh-ide-scm-history' },
          h(
            'button',
            {
              type: 'button',
              className: 'dsh-ide-scm-history-toggle',
              'aria-expanded': graphOpen,
              title: graphOpen ? 'Свернуть граф коммитов' : 'Развернуть граф коммитов',
              onClick: () => {
                const next = !graphOpen
                setGraphOpen(next)
                if (next && history.phase === 'idle') setHistoryReload((value) => value + 1)
              },
            },
            h('span', { className: 'dsh-ide-scm-history-title' }, 'Граф'),
            h('span', { className: 'dsh-ide-scm-history-count' }, history.commits.length === 0 ? '' : String(history.commits.length)),
            h('span', { className: 'dsh-ide-scm-history-chevron', 'aria-hidden': 'true' }, graphOpen ? '▾' : '▸'),
          ),
          graphOpen
            ? h(ScmGraph, {
                history,
                activeOid: commitView === undefined ? '' : commitView.oid,
                onSelect: (commit) => openCommit(commit),
                onMore: loadMore,
                onReload: () => setHistoryReload((value) => value + 1),
              })
            : null,
        ),
      )
    }

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

    /** Outline glyphs: one letter per symbol kind; the row color comes from CSS. */
    const STRUCTURE_GLYPHS = { class: 'C', function: 'ƒ', method: 'm', interface: 'I', heading: '#', rule: '#', atrule: '@' }

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
      const structureOpen = props.structureOpen === true
      const structure = props.structure === undefined ? { phase: 'idle', language: '', symbols: [], error: '' } : props.structure
      const onCloseStructure = props.onCloseStructure
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
      // Inline "new file / new folder" row, the way a classic file explorer does it:
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
      const [searchRegex, setSearchRegex] = React.useState(false)
      const [searchWholeWord, setSearchWholeWord] = React.useState(false)
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
        // A literal query ignores surrounding spaces; a pattern keeps them.
        const needle = searchRegex ? searchQuery : searchQuery.trim()
        if (needle === '' || typeof sessionId !== 'string' || sessionId === '') {
          setSearchResult({ phase: 'idle', matches: [], truncated: false, error: '' })
          return undefined
        }
        const controller = new AbortController()
        const timer = window.setTimeout(() => {
          setSearchResult((previous) => ({ ...previous, phase: 'pending', error: '' }))
          void call('searchText', {
            sessionId,
            query: needle,
            limit: 50,
            regex: searchRegex,
            wholeWord: searchWholeWord,
          }, controller.signal)
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
      }, [searchOpen, searchQuery, searchRegex, searchWholeWord, sessionId])
      React.useEffect(() => {
        if (!searchOpen) return undefined
        const timer = window.setTimeout(() => searchInputRef.current?.focus(), 0)
        return () => window.clearTimeout(timer)
      }, [searchOpen])
      // New files and folders land in the selected folder, or next to the
      // selected file, exactly like a classic file explorer.
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
          items.push({ id: 'toggle', label: (target.path === '' ? rootOpen : expanded.has(target.path)) ? menuText('Свернуть', 'Collapse') : menuText('Развернуть', 'Expand'), run: () => target.path === '' ? setRootOpen(!rootOpen) : toggle(target.path, cache.has(target.path)) })
          items.push({ id: 'new-file', label: menuText('Новый файл…', 'New file…'), run: () => props.onNewFile(target.path) })
          items.push({ id: 'new-folder', label: menuText('Новая папка…', 'New folder…'), run: () => props.onNewFolder(target.path) })
          if (typeof props.onQuoteFile === 'function') {
            items.push({ id: 'quote', label: menuText('Добавить в чат', 'Add to chat'), key: ADD_TO_CHAT_KEY, run: () => props.onQuoteFile(target.path, true) })
          }
          items.push({ separator: true })
        } else {
          items.push({ id: 'open', label: menuText('Открыть', 'Open'), run: () => onOpenFile(target.path) })
          if (typeof props.onQuoteFile === 'function') {
            items.push({ id: 'quote', label: menuText('Добавить в чат', 'Add to chat'), key: ADD_TO_CHAT_KEY, run: () => props.onQuoteFile(target.path, false) })
          }
          if (typeof props.onQuoteLines === 'function') {
            items.push({ id: 'quote-lines', label: menuText('Добавить строки в чат…', 'Quote lines in chat…'), run: () => props.onQuoteLines(target.path) })
          }
          items.push({ separator: true })
        }
        items.push({
          id: 'copy-path',
          label: menuText('Копировать путь', 'Copy path'),
          run: () => copy(workspaceRoot === '' ? target.path : `${workspaceRoot.replace(/[\\/]+$/, '')}/${target.path}`),
        })
        items.push({ id: 'copy-relative', label: menuText('Копировать относительный путь', 'Copy relative path'), run: () => copy(target.path) })
        items.push({
          id: 'reveal',
          label: menuText('Показать в проводнике ОС', 'Reveal in file manager'),
          run: () => {
            void call('reveal', { sessionId, path: target.path }).catch((cause) => setError(describeError(cause)))
          },
        })
        if (target.path === '') return items
        items.push({ separator: true })
        items.push({ id: 'rename', label: menuText('Переименовать…', 'Rename…'), key: 'F2', run: () => props.onRename(target.path, target.name, target.type) })
        items.push({ id: 'delete', label: menuText('Удалить', 'Delete'), key: 'Delete', run: () => props.onDelete(target.path, target.name, target.type) })
        return items
      }

      const moreMenuItems = [
        { id: 'new-file', label: menuText('Новый файл…', 'New file…'), run: () => props.onNewFile('') },
        { id: 'new-folder', label: menuText('Новая папка…', 'New folder…'), run: () => props.onNewFolder('') },
        { separator: true },
        { id: 'refresh', label: menuText('Обновить дерево', 'Refresh explorer'), run: () => setReloadKey((value) => value + 1) },
        { id: 'collapse', label: menuText('Свернуть все папки', 'Collapse all folders'), run: () => setExpanded(new Set()) },
        { id: 'hidden', label: hidden ? menuText('Скрыть скрытые файлы', 'Hide hidden files') : menuText('Показать скрытые файлы', 'Show hidden files'), run: () => onToggleHidden(!hidden) },
        workspaceRoot === '' ? null : { separator: true },
        workspaceRoot === '' ? null : { id: 'copy-root', label: menuText('Копировать путь рабочей папки', 'Copy workspace path'), run: () => copy(workspaceRoot) },
        // Touch devices have no reliable hover, so the actions that normally live
        // in a row's context menu are repeated here for the selected row.
        selected === undefined || typeof selected.path !== 'string' || selected.path === ''
          ? null
          : { separator: true },
        selected === undefined || typeof selected.path !== 'string' || selected.path === ''
          ? null
          : {
              id: 'rename-selected',
              label: menuText(`Переименовать «${baseName(selected.path)}»…`, `Rename “${baseName(selected.path)}”…`),
              run: () => props.onRename(selected.path, baseName(selected.path), selected.type),
            },
        selected === undefined || typeof selected.path !== 'string' || selected.path === ''
          ? null
          : {
              id: 'delete-selected',
              label: menuText(`Удалить «${baseName(selected.path)}»`, `Delete “${baseName(selected.path)}”`),
              run: () => props.onDelete(selected.path, baseName(selected.path), selected.type),
            },
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

      // A folder with more entries than one page is not hidden: the row at the
      // end of the listing asks the Host for the next page and appends it, so a
      // huge `node_modules` is read only as far as the reader scrolls.
      const loadMore = React.useCallback(
        async (relativePath) => {
          const listing = cache.get(relativePath)
          if (listing === undefined || listing.truncated !== true) return
          if (typeof sessionId !== 'string' || sessionId === '') return
          setPending(relativePath)
          try {
            const page = await call('tree', {
              sessionId,
              path: relativePath,
              hidden,
              offset: Array.isArray(listing.entries) ? listing.entries.length : 0,
            })
            setCache((previous) => {
              const next = new Map(previous)
              const base = next.get(relativePath) ?? listing
              next.set(relativePath, { ...page, entries: [...base.entries, ...page.entries] })
              return next
            })
            setError('')
          } catch (cause) {
            setError(describeError(cause))
          } finally {
            setPending('')
          }
        },
        [cache, sessionId, hidden],
      )

      React.useEffect(() => {
        setExpanded(new Set())
        expandedRef.current = new Set()
        setCache(new Map())
        setFlat(undefined)
        setFlatError('')
        if (typeof sessionId === 'string' && sessionId !== '') void load('')
      }, [sessionId, hidden, load])

      // Refreshing keeps the expanded folders open, the way a classic explorer does: only
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

      // Height of the outline section below the tree; the splitter between
      // them is dragged like a classic sidebar's section handle.
      // This state lives with the other hooks on purpose: the changes and
      // search branches below return early, and a hook after those returns
      // would disappear from the render whenever either pane opens — React
      // then kills the whole subtree with "Rendered fewer hooks than
      // expected" until the page is reloaded.
      const [structureHeight, setStructureHeight] = React.useState(300)

      const rows = []

      // The inline "new file / new folder" row. Enter accepts, Escape cancels,
      // and losing focus cancels like a classic explorer does.
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
          if (listing.truncated === true) {
            const remaining = Math.max(0, (listing.total ?? listing.entries.length) - listing.entries.length)
            const busy = pending === directory
            rows.push(
              h(
                'button',
                {
                  key: `more:${directory}`,
                  type: 'button',
                  className: 'dsh-ide-row dsh-ide-row-more',
                  style: { paddingLeft: `${6 + depth * 12}px` },
                  disabled: busy,
                  title: 'Прочитать следующую страницу этого каталога',
                  onClick: () => void loadMore(directory),
                },
                h('span', { className: 'dsh-ide-caret' }),
                h('span', { className: 'dsh-ide-row-name' }, busy ? 'Читаю…' : `Показать ещё${remaining > 0 ? ` ${remaining}` : ''}`),
              ),
            )
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
              placeholder: searchRegex ? 'Регулярное выражение' : 'Текст для поиска',
              'aria-label': 'Поиск по содержимому файлов',
              onChange: (event) => setSearchQuery(event.target.value),
              onKeyDown: (event) => {
                if (event.key !== 'Escape') return
                if (searchQuery !== '') setSearchQuery('')
                else if (typeof onCloseSearch === 'function') onCloseSearch()
              },
            }),
            h(
              'button',
              {
                type: 'button',
                className: 'dsh-ide-search-toggle',
                'aria-pressed': searchRegex,
                'aria-label': 'Регулярное выражение',
                title: 'Регулярное выражение',
                onClick: () => setSearchRegex((value) => !value),
              },
              '.*',
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'dsh-ide-search-toggle',
                'aria-pressed': searchWholeWord,
                'aria-label': 'Слово целиком',
                title: 'Слово целиком',
                onClick: () => setSearchWholeWord((value) => !value),
              },
              'ab',
            ),
          ),
          h('div', { className: 'dsh-ide-search-status' }, statusText),
          h('div', { className: 'dsh-ide-tree dsh-ide-search-results', role: 'list' }, rows),
        )
      }

      // Splitter state is declared with the other hooks above (see the note
      // there): keeping it below the early returns would change the hook count
      // between renders and crash the pane.
      const startStructureResize = (event) => {
        event.preventDefault()
        const startY = event.clientY
        const startHeight = structureHeight
        const move = (moveEvent) => {
          const next = startHeight + (startY - moveEvent.clientY)
          setStructureHeight(Math.max(120, Math.min(next, window.innerHeight - 200)))
        }
        const stop = () => {
          window.removeEventListener('pointermove', move)
          window.removeEventListener('pointerup', stop)
          window.removeEventListener('pointercancel', stop)
          document.body.style.cursor = ''
        }
        window.addEventListener('pointermove', move)
        window.addEventListener('pointerup', stop)
        window.addEventListener('pointercancel', stop)
        document.body.style.cursor = 'row-resize'
      }
      const structureRows = (nodes, depth) =>
        nodes.map((node, index) =>
          h(
            'div',
            { key: `${depth}-${index}`, className: 'dsh-ide-structure-row', role: 'listitem' },
            h(
              'button',
              {
                type: 'button',
                className: 'dsh-ide-search-hit dsh-ide-structure-hit',
                style: { paddingLeft: `${depth * 12 + 2}px` },
                title: `${node.name} · строка ${node.line}`,
                onClick: () => {
                  if (typeof onOpenFile === 'function') onOpenFile(activePath, node.line)
                },
              },
              h(
                'span',
                { className: 'dsh-ide-structure-main' },
                h('span', { className: `dsh-ide-structure-kind dsh-ide-structure-${node.kind}` }, STRUCTURE_GLYPHS[node.kind] ?? '·'),
                h('span', { className: 'dsh-ide-structure-name' }, node.name),
                h('span', { className: 'dsh-ide-structure-line' }, String(node.line)),
              ),
              typeof node.comment === 'string' && node.comment !== ''
                ? h('span', { className: 'dsh-ide-structure-comment', title: node.comment }, node.comment)
                : null,
            ),
            depth < 12 && Array.isArray(node.children) && node.children.length > 0 ? structureRows(node.children, depth + 1) : null,
          ),
        )
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
            autoCapitalize: 'off',
            autoCorrect: 'off',
            spellCheck: false,
            enterKeyHint: 'search',
            onChange: (event) => setQuery(event.target.value),
            onKeyDown: (event) => {
              if (event.key === 'Escape') setQuery('')
            },
          }),
        ),
        h('div', { className: 'dsh-ide-tree', role: 'tree' }, rows),
        structureOpen
          ? h('div', {
              className: 'dsh-ide-structure-resize',
              title: 'Потяните, чтобы изменить высоту панели',
              onPointerDown: startStructureResize,
            })
          : null,
        structureOpen
          ? h(
              'div',
              { className: 'dsh-ide-structure', style: { height: `${structureHeight}px` } },
              h(
                'div',
                { className: 'dsh-ide-explorer-head' },
                h('span', { className: 'dsh-ide-explorer-title' }, 'СТРУКТУРА'),
                h(
                  'span',
                  { className: 'dsh-ide-explorer-actions' },
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'dsh-ide-icon-button',
                      title: 'Закрыть структуру',
                      'aria-label': 'Закрыть структуру',
                      onClick: () => {
                        if (typeof onCloseStructure === 'function') onCloseStructure()
                      },
                    },
                    '✕',
                  ),
                ),
              ),
              h(
                'div',
                { className: 'dsh-ide-search-status', title: activePath },
                `${baseName(activePath)}${structure.phase === 'pending' && structure.language !== '' ? ' · обновляю…' : ''}`,
              ),
              h(
                'div',
                { className: 'dsh-ide-tree dsh-ide-structure-list', role: 'list' },
                activePath === ''
                  ? [h('div', { key: 'structure-no-file', className: 'dsh-ide-tree-empty' }, 'Откройте файл — здесь появится его структура')]
                  : structure.phase === 'failed'
                    ? [h('div', { key: 'structure-error', className: 'dsh-ide-tree-error' }, structure.error)]
                    : structure.language === ''
                      ? [h('div', { key: 'structure-unsupported', className: 'dsh-ide-tree-empty' }, 'Структура для этого типа файла не поддерживается (пока: JS, TS, Python, Markdown, CSS)')]
                      : structure.symbols.length === 0
                        ? [h('div', { key: 'structure-empty', className: 'dsh-ide-tree-empty' }, structure.phase === 'ready' ? 'Символов в файле нет' : 'Разбираю…')]
                        : structureRows(structure.symbols, 0),
              ),
            )
          : null,
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

    // The menu bar mirrors a classic editor's title bar: a row of top-level menus whose
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

    /**
     * Compact stand-in for the menu bar. Desktop menus with dropdowns do not fit
     * a phone width, so the whole command set moves into one scrollable sheet.
     * Commands the bundle cannot honour are already disabled on the desktop and
     * stay out here: on a phone they would only be noise.
     */
    function MenuSheet({ menus, onClose }) {
      // Escape closes the sheet; on a phone it sits over the whole pane, so a
      // stray hardware key press must not leave the editor unreachable.
      React.useEffect(() => {
        if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') return undefined
        const onKeyDown = (event) => {
          if (event.key !== 'Escape') return
          event.preventDefault()
          onClose()
        }
        document.addEventListener('keydown', onKeyDown)
        return () => document.removeEventListener('keydown', onKeyDown)
      }, [onClose])
      const groups = menus
        .map((menu) => ({
          id: menu.id,
          label: menu.label,
          items: menu.items.filter((item) => item.separator !== true && item.disabled !== true),
        }))
        .filter((menu) => menu.items.length > 0)
      return h(
        'div',
        { className: 'dsh-ide-sheet', onClick: onClose },
        h(
          'div',
          {
            className: 'dsh-ide-sheet-card',
            role: 'dialog',
            'aria-modal': 'true',
            'aria-label': menuText('Меню IDE', 'IDE menu'),
            onClick: (event) => event.stopPropagation(),
          },
          h(
            'div',
            { className: 'dsh-ide-sheet-head' },
            h('span', { className: 'dsh-ide-sheet-title' }, menuText('Меню', 'Menu')),
            h('button', { type: 'button', className: 'dsh-ide-sheet-close', title: menuText('Закрыть', 'Close'), onClick: onClose }, '✕'),
          ),
          h(
            'div',
            { className: 'dsh-ide-sheet-body' },
            groups.map((menu) =>
              h(
                'div',
                { key: menu.id, className: 'dsh-ide-sheet-group' },
                h('div', { className: 'dsh-ide-sheet-group-label' }, menu.label),
                menu.items.map((item) =>
                  h(
                    'button',
                    {
                      key: item.id,
                      type: 'button',
                      className: 'dsh-ide-sheet-item',
                      onClick: () => {
                        onClose()
                        if (typeof item.run === 'function') item.run()
                      },
                    },
                    h('span', { className: 'dsh-ide-sheet-item-label' }, item.label),
                    item.key === undefined ? null : h('span', { className: 'dsh-ide-sheet-item-key' }, item.key),
                  ),
                ),
              ),
            ),
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
            h('button', { type: 'button', className: 'dsh-ide-button dsh-ide-button-primary', onClick: onClose }, menuText('Закрыть', 'Close')),
          ),
        ),
      )
    }

    function TabStrip(props) {
      const { tabs, activeKey, onActivate, onClose, onContextMenu, compact } = props
      return h(
        'div',
        { className: 'dsh-ide-tabs', role: 'tablist' },
        tabs.length === 0
          ? h(
              'span',
              { className: 'dsh-ide-tabs-empty' },
              compact ? 'Нет открытых файлов' : 'Выберите файл в дереве слева',
            )
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
            placeholder: menuText('Команда…', 'Command…'),
            spellCheck: false,
            value: query,
            'aria-label': menuText('Палитра команд', 'Command palette'),
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
              ? h('div', { className: 'dsh-ide-palette-empty' }, menuText('Ничего не найдено', 'No matches'))
              : visible.map((entry) =>
                  h(
                    'button',
                    {
                      key: entry.id,
                      type: 'button',
                      className: `dsh-ide-palette-item${entry.disabled === true ? ' dsh-ide-palette-item-off' : ''}`,
                      disabled: entry.disabled === true,
                      title: entry.disabled === true ? menuText('Недоступно', 'Unavailable') : entry.label,
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

    /** Encodings the status bar offers. `writable` ones can be written back by the Host. */
    const ENCODING_OPTIONS = [
      { id: 'utf8', label: 'UTF-8', writable: true },
      { id: 'utf8-bom', label: 'UTF-8 с BOM', writable: true },
      { id: 'utf16le', label: 'UTF-16 LE', writable: false },
      { id: 'utf16be', label: 'UTF-16 BE', writable: false },
      { id: 'windows-1251', label: 'Windows-1251', writable: false },
      { id: 'koi8-r', label: 'KOI8-R', writable: false },
      { id: 'ibm866', label: 'OEM 866', writable: false },
      { id: 'windows-1252', label: 'Windows-1252', writable: false },
      { id: 'iso-8859-5', label: 'ISO 8859-5', writable: false },
    ]

    const encodingLabel = (id) => {
      const spec = ENCODING_OPTIONS.find((candidate) => candidate.id === id)
      return spec === undefined ? 'UTF-8' : spec.label
    }

    /**
     * Monaco does not give every language an extension list; this maps the
     * ids it omits to a representative extension so the language picker can
     * reuse the explorer's colored file badges.
     */
    const LANG_BADGE_BY_ID = {
      javascript: '.js', typescript: '.ts', json: '.json', css: '.css', html: '.html', xml: '.xml',
      markdown: '.md', python: '.py', ruby: '.rb', go: '.go', rust: '.rs', java: '.java',
      kotlin: '.kt', c: '.c', cpp: '.cpp', csharp: '.cs', php: '.php', shell: '.sh',
      powershell: '.ps1', yaml: '.yml', ini: '.ini', sql: '.sql', lua: '.lua', dart: '.dart',
      swift: '.swift', perl: '.pl', dockerfile: 'Dockerfile', scss: '.scss', less: '.less', bat: '.bat',
    }

    /**
     * Status-bar list picker (language mode, EOL, encoding) — Cursor-style:
     * a search field, keyboard navigation and a checkmark on the active value.
     * `head` renders the encoding mode toggle («открыть» / «сохранить»).
     */
    function StatusPicker({ title, entries, currentId, head, onPick, onClose }) {
      const [query, setQuery] = React.useState('')
      const [position, setPosition] = React.useState(0)
      const needle = query.trim().toLowerCase()
      const visible = entries.filter(
        (entry) => needle === '' || entry.label.toLowerCase().includes(needle) || entry.id.toLowerCase().includes(needle),
      )
      const move = (delta) =>
        setPosition((value) => (visible.length === 0 ? 0 : (value + delta + visible.length) % visible.length))
      const current = visible[position]
      return h(
        'div',
        { className: 'dsh-ide-modal dsh-ide-modal-top', onClick: onClose },
        h(
          'div',
          { className: 'dsh-ide-modal-card dsh-ide-quick dsh-ide-picker', onClick: (event) => event.stopPropagation() },
          h('div', { className: 'dsh-ide-picker-title' }, title),
          head === undefined
            ? null
            : h(
                'div',
                { className: 'dsh-ide-picker-head' },
                head.map((part) =>
                  h(
                    'button',
                    {
                      key: part.id,
                      type: 'button',
                      className: `dsh-ide-picker-head-item${part.active ? ' dsh-ide-picker-head-item-active' : ''}`,
                      onClick: part.run,
                    },
                    part.label,
                  ),
                ),
              ),
          h('input', {
            className: 'dsh-ide-quick-input',
            type: 'text',
            autoFocus: true,
            placeholder: menuText('Фильтр…', 'Filter…'),
            spellCheck: false,
            value: query,
            'aria-label': title,
            onChange: (event) => {
              setQuery(event.target.value)
              setPosition(0)
            },
            onKeyDown: (event) => {
              if (event.key === 'ArrowDown') {
                event.preventDefault()
                move(1)
                return
              }
              if (event.key === 'ArrowUp') {
                event.preventDefault()
                move(-1)
                return
              }
              if (event.key === 'Escape') {
                event.preventDefault()
                onClose()
                return
              }
              if (event.key !== 'Enter') return
              event.preventDefault()
              if (current !== undefined) onPick(current)
            },
          }),
          h(
            'div',
            { className: 'dsh-ide-quick-list', role: 'list' },
            visible.length === 0
              ? h('div', { className: 'dsh-ide-tree-empty' }, menuText('Ничего не найдено', 'No matches'))
              : visible.map((entry, index) =>
                  h(
                    'button',
                    {
                      key: entry.id,
                      type: 'button',
                      className: `dsh-ide-quick-row dsh-ide-picker-row${index === position ? ' dsh-ide-quick-row-active' : ''}${
                        entry.disabled === true ? ' dsh-ide-picker-row-off' : ''
                      }`,
                      title: entry.detail === undefined ? entry.label : `${entry.label} — ${entry.detail}`,
                      onClick: () => onPick(entry),
                      onMouseEnter: () => setPosition(index),
                    },
                    entry.badge === undefined
                      ? h('span', { className: 'dsh-ide-badge' }, '')
                      : h(FileBadge, { name: entry.badge }),
                    h('span', { className: 'dsh-ide-row-name' }, entry.label),
                    entry.detail === undefined ? null : h('span', { className: 'dsh-ide-row-dim' }, entry.detail),
                    h('span', { className: 'dsh-ide-picker-check' }, entry.id === currentId ? '✓' : ''),
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
            autoCapitalize: 'off',
            autoCorrect: 'off',
            spellCheck: false,
            enterKeyHint: 'go',
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

      const autoModelOn = options.autoModel === undefined ? true : options.autoModel === true
      const deadlineSetting = TAB_PREFERENCES.find((entry) => entry.key === 'deadlineMs')
      const deadlineDefault = deadlineSetting === undefined ? 6000 : deadlineSetting.value
      const modelOptions = [
        h(
          'option',
          { key: '', value: '' },
          sessionInfo !== undefined ? `Как у сессии (${sessionInfo.model})${autoModelOn ? ' · авто' : ''}` : 'Как у сессии',
        ),
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
          autoModelOn
            ? 'Пустое значение — модель сессии, но при включённом автопереключении (ниже) подсказка идёт на быстрой модели из каталога провайдера.'
            : 'Пустое значение — модель сессии; для другого провайдера — его первая модель.',
          h('select', { className: 'dsh-ide-input dsh-ide-setting-input', value: model, onChange: (event) => setModel(event.target.value) }, modelOptions),
        ),
        setting(
          'auto-model',
          'Автодополнение: автопереключение модели',
          'Включено — если модель не выбрана, брать быструю из каталога провайдера. Выключено — подсказки идут на модели сессии. Явно выбранная модель важнее этой настройки.',
          h(
            'label',
            { className: 'dsh-ide-setting-check' },
            h('input', {
              type: 'checkbox',
              checked: autoModelOn,
              onChange: (event) => setOptions((previous) => ({ ...previous, autoModel: event.target.checked })),
            }),
            h('span', {}, 'Брать быструю автоматически'),
          ),
        ),
        setting(
          'deadline',
          'Автодополнение: максимальное ожидание',
          'Сколько миллисекунд ждать ответ, прежде чем показать «Истекло время ожидания подсказки». 1000–60000 (6000 = 6 с, 60000 = 60 с).',
          h('input', {
            className: 'dsh-ide-input dsh-ide-setting-input dsh-ide-input-number',
            type: 'number',
            min: 1000,
            max: 60000,
            step: 1000,
            value: String(options.deadlineMs === undefined ? deadlineDefault : options.deadlineMs),
            onChange: (event) => setOptions((previous) => ({ ...previous, deadlineMs: event.target.value })),
          }),
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
        'noReasoningHint',
        'rangeReplace',
        'partialAccept',
        'refetchAfterAccept',
        'triggerInComments',
        'showRemovedDecorations',
        'explainSuppressed',
        'fullTrace',
        'showChat',
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
          h('button', { type: 'button', className: 'dsh-ide-icon-button dsh-ide-settings-close', title: 'Закрыть настройки', onClick: onClose }, '✕'),
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

    /**
     * The rule chain is shown as a read-only report: what exists on disk, and
     * which part of it the next Inline Edit would actually send. Chat and Tab
     * do not receive these files, so the panel says so instead of implying a
     * global policy.
     */
    function RulesPanel({ tab, sessionId, onClose }) {
      const [view, setView] = React.useState({ phase: 'loading', rules: [], file: '', truncated: false, error: '' })
      const [reload, setReload] = React.useState(0)
      React.useEffect(() => {
        let alive = true
        setView({ phase: 'loading', rules: [], file: '', truncated: false, error: '' })
        void (async () => {
          try {
            const payload = await call('rules', { id: tab.hostId, sessionId })
            if (!alive) return
            setView({
              phase: 'ready',
              rules: Array.isArray(payload.rules) ? payload.rules : [],
              file: typeof payload.file === 'string' ? payload.file : '',
              truncated: payload.truncated === true,
              error: '',
            })
          } catch (cause) {
            if (!alive) return
            setView({ phase: 'failed', rules: [], file: '', truncated: false, error: describeError(cause) })
          }
        })()
        return () => {
          alive = false
        }
      }, [tab.hostId, sessionId, reload])
      const reasonLabel = (rule) =>
        rule.reason === 'limit'
          ? 'пропущено: общий лимит'
          : rule.reason === 'ignored'
            ? 'исключено .dshideignore'
            : 'пропущено: больше 32 КиБ'
      return h(
        'div',
        { className: 'dsh-ide-modal' },
        h(
          'div',
          { className: 'dsh-ide-modal-card dsh-ide-rules-card' },
          h(
            'div',
            { className: 'dsh-ide-rules-head' },
            h('div', { className: 'dsh-ide-modal-title' }, 'Правила проекта'),
            h('button', { type: 'button', className: 'dsh-ide-button', onClick: onClose }, 'Закрыть'),
          ),
          h('div', { className: 'dsh-ide-modal-text' }, `Для файла ${tab.path} — от корня к его папке.`),
          view.phase === 'loading' ? h('div', { className: 'dsh-ide-rules-note' }, 'Читаю правила…') : null,
          view.phase === 'failed'
            ? h(
                'div',
                { className: 'dsh-ide-rules-failed' },
                h('div', { className: 'dsh-ide-rules-note' }, view.error),
                h('button', { type: 'button', className: 'dsh-ide-button', onClick: () => setReload((value) => value + 1) }, 'Повторить'),
              )
            : null,
          view.phase === 'ready' && view.rules.length === 0
            ? h('div', { className: 'dsh-ide-rules-note' }, 'Правил не найдено: AGENTS.md, CLAUDE.md, .dshiderules и .dshide/rules/*.mdc отсутствуют на пути к файлу.')
            : null,
          view.phase === 'ready' && view.rules.length > 0
            ? h(
                'div',
                { className: 'dsh-ide-rules-list' },
                view.rules.map((rule) =>
                  h(
                    'div',
                    { key: rule.path, className: 'dsh-ide-rules-row' },
                    h(
                      'div',
                      { className: 'dsh-ide-rules-row-head' },
                      h('span', { className: 'dsh-ide-rules-path' }, rule.path),
                      h(
                        'span',
                        { className: `dsh-ide-rules-badge${rule.applied ? ' dsh-ide-rules-badge-on' : ''}` },
                        rule.applied ? 'применяется' : reasonLabel(rule),
                      ),
                    ),
                    h(
                      'div',
                      { className: 'dsh-ide-rules-meta' },
                      `${rule.dir === '.' ? 'корень' : rule.dir} · ${Math.max(1, Math.round(rule.bytes / 1024))} КиБ`,
                    ),
                    rule.preview === '' ? null : h('pre', { className: 'dsh-ide-rules-preview' }, rule.preview),
                  ),
                ),
              )
            : null,
          view.truncated ? h('div', { className: 'dsh-ide-rules-note' }, 'Показаны не все правила: сработал предел в 16 файлов.') : null,
          h('div', { className: 'dsh-ide-rules-foot' }, 'Применяются только к «Изменить выделение»; Tab и чат эти файлы не получают.'),
        ),
      )
    }

    /** Saved plan drafts, reopened into this composer or another open session. */
    function PlansPanel({ sessionId, onClose, onOpen, onTransfer }) {
      const [view, setView] = React.useState({ phase: 'loading', plans: [], error: '' })
      const [reload, setReload] = React.useState(0)
      React.useEffect(() => {
        let alive = true
        setView({ phase: 'loading', plans: [], error: '' })
        void (async () => {
          try {
            const result = await call('planList', { sessionId })
            if (alive) setView({ phase: 'ready', plans: Array.isArray(result.plans) ? result.plans : [], error: '' })
          } catch (cause) {
            if (alive) setView({ phase: 'failed', plans: [], error: messageOf(cause) })
          }
        })()
        return () => {
          alive = false
        }
      }, [sessionId, reload])
      const stamp = (value) => {
        const date = new Date(value)
        return Number.isNaN(date.getTime()) ? '' : date.toLocaleString()
      }
      return h(
        'div',
        { className: 'dsh-ide-modal-card dsh-ide-plans-card', role: 'region', 'aria-label': 'Сохранённые планы' },
        h(
          'div',
          { className: 'dsh-ide-plans-head' },
          h('strong', null, 'Сохранённые планы'),
          h('button', { type: 'button', className: 'dsh-ide-button', onClick: onClose }, 'Закрыть'),
        ),
        view.phase === 'loading' ? h('div', { className: 'dsh-ide-plans-note' }, 'Читаю…') : null,
        view.phase === 'failed'
          ? h(
              'div',
              { className: 'dsh-ide-plans-failed' },
              h('div', null, view.error),
              h('button', { type: 'button', className: 'dsh-ide-button', onClick: () => setReload((value) => value + 1) }, 'Повторить'),
            )
          : null,
        view.phase === 'ready' && view.plans.length === 0
          ? h('div', { className: 'dsh-ide-plans-note' }, 'Сохранённых планов нет: «Файл → Подготовить план…», затем «Сохранить план…».')
          : null,
        view.phase === 'ready' && view.plans.length > 0
          ? h(
              'div',
              { className: 'dsh-ide-plans-list' },
              view.plans.map((plan) =>
                h(
                  'div',
                  { key: plan.id, className: 'dsh-ide-plans-row' },
                  h('div', { className: 'dsh-ide-plans-title' }, plan.title),
                  h('div', { className: 'dsh-ide-plans-meta' }, `${stamp(plan.createdAt)} · ${plan.chars} символов`),
                  h(
                    'div',
                    { className: 'dsh-ide-plans-actions' },
                    h('button', { type: 'button', className: 'dsh-ide-button', onClick: () => onOpen(plan.id) }, 'В поле ввода'),
                    h('button', { type: 'button', className: 'dsh-ide-button', onClick: () => onTransfer(plan) }, 'В сессию…'),
                  ),
                ),
              ),
            )
          : null,
        h('div', { className: 'dsh-ide-plans-foot' }, 'Планы хранятся локально; передача в другую сессию только заполняет её поле ввода.'),
      )
    }

    function TerminalContextPanel({ onClose, onInsert }) {
  const [command, setCommand] = React.useState('')
  const [code, setCode] = React.useState('')
  const [output, setOutput] = React.useState('')
  const composed = terminalBlock(command, code, output)
  const empty = command.trim() === '' && code.trim() === '' && output.trim() === ''
  return h(
    'div',
    { className: 'dsh-ide-modal-card dsh-ide-terminal-card', role: 'region', 'aria-label': 'Запуск терминала в чат' },
    h(
      'div',
      { className: 'dsh-ide-terminal-head' },
      h('strong', null, 'Запуск терминала в чат'),
      h('button', { type: 'button', className: 'dsh-ide-button', onClick: onClose }, 'Закрыть'),
    ),
    h('div', { className: 'dsh-ide-terminal-note' }, 'Вставьте команду, код выхода и вывод. В чат попадёт только показанный ниже текст; запрос не отправляется.'),
    h('label', { className: 'dsh-ide-terminal-field' }, 'Команда', h('input', {
      className: 'dsh-ide-terminal-input',
      value: command,
      onChange: (event) => setCommand(event.currentTarget.value),
      placeholder: 'npm test',
    })),
    h('label', { className: 'dsh-ide-terminal-field' }, 'Код выхода', h('input', {
      className: 'dsh-ide-terminal-input dsh-ide-terminal-code',
      value: code,
      onChange: (event) => setCode(event.currentTarget.value),
      placeholder: '0',
    })),
    h('label', { className: 'dsh-ide-terminal-field' }, 'Вывод', h('textarea', {
      className: 'dsh-ide-terminal-output',
      value: output,
      rows: 7,
      onChange: (event) => setOutput(event.currentTarget.value),
      placeholder: 'Вставьте вывод команды',
    })),
    h('div', { className: 'dsh-ide-terminal-meta' },
      empty ? 'Пока нечего вставлять' : `Вставится ${composed.chars} символов в ${composed.lines} строк` +
        (composed.truncated ? ` · вывод обрезан до ${TERMINAL_CONTEXT_CHARS} символов` : '')),
    h('pre', { className: 'dsh-ide-terminal-preview' }, empty ? 'Предпросмотр появится здесь.' : composed.text),
    h('div', { className: 'dsh-ide-terminal-actions' },
      h('button', {
        type: 'button',
        className: 'dsh-ide-button dsh-ide-button-primary',
        disabled: empty,
        onClick: () => {
          if (onInsert(composed.text) === true) onClose()
        },
      }, 'Вставить в чат'),
      h('button', { type: 'button', className: 'dsh-ide-button', onClick: onClose }, 'Отмена')),
  )
}

function WorktreesPanel({ sessionId, call, onClose }) {
  const callRef = React.useRef(call)
  callRef.current = call
  const [view, setView] = React.useState({ phase: 'loading' })
  const [path, setPath] = React.useState('.worktrees/task')
  const [branch, setBranch] = React.useState('task')
  const [create, setCreate] = React.useState(true)
  const [busy, setBusy] = React.useState(false)
  const load = async () => {
    try {
      const payload = await callRef.current('scmWorktrees', { sessionId })
      if (payload.error) throw new Error(payload.error.message ?? 'Не удалось получить рабочие копии')
      setView({ phase: 'ready', items: payload.worktrees ?? [] })
    } catch (error) {
      setView({ phase: 'failed', error: messageOf(error) })
    }
  }
  React.useEffect(() => {
    void load()
  }, [sessionId])
  const submit = async (action) => {
    if (busy) return
    setBusy(true)
    try {
      const payload = action()
      const answer = await payload
      if (answer.error) throw new Error(answer.error.message ?? 'Операция не удалась')
      setView({ phase: 'ready', items: answer.worktrees ?? [] })
    } catch (error) {
      setView({ phase: 'failed', error: messageOf(error) })
    } finally {
      setBusy(false)
    }
  }
  return h(
    'div',
    { className: 'dsh-ide-modal-card dsh-ide-worktree-card', role: 'region', 'aria-label': 'Рабочие копии' },
    h('div', { className: 'dsh-ide-worktree-head' },
      h('strong', null, 'Рабочие копии'),
      h('button', { type: 'button', className: 'dsh-ide-button', onClick: onClose }, 'Закрыть')),
    h('div', { className: 'dsh-ide-worktree-note' },
      'Изолированная копия репозитория на отдельной ветке. Создаётся только внутри открытой рабочей папки; основную копию удалить нельзя.'),
    view.phase === 'loading' ? h('div', { className: 'dsh-ide-worktree-note' }, 'Читаю список…') : null,
    view.phase === 'failed' ? h('div', { className: 'dsh-ide-worktree-error' }, view.error) : null,
    view.phase === 'ready'
      ? h('div', { className: 'dsh-ide-worktree-list' },
          view.items.length === 0
            ? h('div', { className: 'dsh-ide-worktree-note' }, 'Git не вернул рабочих копий.')
            : view.items.map((item) => h('div', { key: item.path, className: 'dsh-ide-worktree-row' },
                h('div', { className: 'dsh-ide-worktree-main' },
                  h('div', { className: 'dsh-ide-worktree-path' }, item.path),
                  h('div', { className: 'dsh-ide-worktree-meta' },
                    (item.branch || (item.detached ? 'detached' : '—')) +
                      (item.current ? ' · текущая' : '') +
                      (item.locked ? ' · заблокирована' : '') +
                      (item.prunable ? ' · можно очистить' : ''))),
                !item.current
                  ? h('button', {
                      type: 'button',
                      className: 'dsh-ide-button',
                      disabled: busy,
                      onClick: () => {
                        if (!window.confirm(`Удалить рабочую копию ${item.path}?`)) return
                        void submit(() => callRef.current('scmRemoveWorktree', { sessionId, path: item.path }))
                      },
                    }, 'Удалить')
                  : null)))
      : null,
    h('div', { className: 'dsh-ide-worktree-form' },
      h('label', { className: 'dsh-ide-worktree-field' }, 'Ветка',
        h('input', {
          className: 'dsh-ide-debug-input',
          value: branch,
          onChange: (event) => setBranch(event.currentTarget.value),
          placeholder: 'feature/task',
        })),
      h('label', { className: 'dsh-ide-worktree-field' }, 'Путь внутри рабочей папки',
        h('input', {
          className: 'dsh-ide-debug-input',
          value: path,
          onChange: (event) => setPath(event.currentTarget.value),
          placeholder: '.worktrees/task',
        })),
      h('label', { className: 'dsh-ide-worktree-check' },
        h('input', { type: 'checkbox', checked: create, onChange: (event) => setCreate(event.currentTarget.checked) }),
        'Создать новую ветку от HEAD'),
      h('button', {
        type: 'button',
        className: 'dsh-ide-button dsh-ide-button-primary',
        disabled: busy || branch.trim() === '' || path.trim() === '',
        onClick: () => void submit(() => callRef.current('scmCreateWorktree', {
          sessionId,
          path: path.trim(),
          branch: branch.trim(),
          create,
        })),
      }, busy ? 'Создаю…' : 'Создать копию')),
  )
}

function NotesPackPanel({ onClose, onInsert, onCapture }) {
  const [notes, setNotes] = React.useState([])
  const [draft, setDraft] = React.useState('')
  const composed = notesBlock(notes)
  const add = (text, path, line) => {
    const value = typeof text === 'string' ? text.trim() : ''
    if (value === '' || notes.length >= NOTES_MAX) return
    setNotes([...notes, { text: value, path, line }])
  }
  const capture = () => {
    const taken = onCapture()
    if (taken !== undefined) add(taken.text, taken.path, taken.line)
  }
  return h(
    'div',
    { className: 'dsh-ide-modal-card dsh-ide-notes-card', role: 'region', 'aria-label': 'Пакет заметок' },
    h(
      'div',
      { className: 'dsh-ide-notes-head' },
      h('strong', null, 'Пакет заметок'),
      h('button', { type: 'button', className: 'dsh-ide-button', onClick: onClose }, 'Закрыть'),
    ),
    h('div', { className: 'dsh-ide-notes-note' },
      'Соберите пронумерованные замечания и отправьте один список. В чат попадёт только предпросмотр ниже; запрос не отправляется.'),
    h('textarea', {
      className: 'dsh-ide-notes-input',
      value: draft,
      rows: 2,
      placeholder: 'Что исправить: текст, ожидаемое поведение, причина',
      onChange: (event) => setDraft(event.currentTarget.value),
      onKeyDown: (event) => {
        if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
          add(draft)
          setDraft('')
        }
      },
    }),
    h('div', { className: 'dsh-ide-notes-actions' },
      h('button', {
        type: 'button',
        className: 'dsh-ide-button dsh-ide-button-primary',
        disabled: draft.trim() === '' || notes.length >= NOTES_MAX,
        onClick: () => {
          add(draft)
          setDraft('')
        },
      }, 'Добавить'),
      h('button', { type: 'button', className: 'dsh-ide-button', onClick: capture }, 'Из выделения'),
      h('span', { className: 'dsh-ide-notes-meta' }, `Заметок: ${notes.length} из ${NOTES_MAX}`)),
    notes.length > 0
      ? h('ol', { className: 'dsh-ide-notes-list' },
          notes.map((note, index) => h('li', { key: index, className: 'dsh-ide-notes-row' },
            h('span', { className: 'dsh-ide-notes-where' },
              note.path ? `${normalPath(note.path)}${note.line ? `:${note.line}` : ''}` : 'без файла'),
            h('span', { className: 'dsh-ide-notes-text' }, note.text),
            h('button', {
              type: 'button',
              className: 'dsh-ide-notes-remove',
              title: 'Убрать заметку',
              'aria-label': 'Убрать заметку',
              onClick: () => setNotes(notes.filter((_, at) => at !== index)),
            }, '×'))))
      : h('div', { className: 'dsh-ide-notes-empty' }, 'Пока нет заметок.'),
    h('div', { className: 'dsh-ide-notes-meta' },
      composed.count === 0 ? 'Пока нечего вставлять' : `Вставится ${composed.count} заметок · ${composed.chars} символов${composed.truncated ? ' · список обрезан' : ''}`),
    h('pre', { className: 'dsh-ide-notes-preview' }, composed.count === 0 ? 'Предпросмотр появится здесь.' : composed.text),
    h('div', { className: 'dsh-ide-notes-footer' },
      h('button', {
        type: 'button',
        className: 'dsh-ide-button dsh-ide-button-primary',
        disabled: composed.count === 0,
        onClick: () => {
          if (onInsert(composed.text) === true) onClose()
        },
      }, 'Вставить в чат'),
      h('button', { type: 'button', className: 'dsh-ide-button', onClick: onClose }, 'Отмена')),
  )
}

function CodeTourPanel({ steps, index, onClose, onAdd, onMove, onRemove, onJump, onPrev, onNext }) {
  const [note, setNote] = React.useState('')
  const list = Array.isArray(steps) ? steps : []
  return h(
    'div',
    { className: 'dsh-ide-modal-card dsh-ide-tour-card', role: 'region', 'aria-label': 'Экскурсия по коду' },
    h(
      'div',
      { className: 'dsh-ide-tour-head' },
      h('strong', null, 'Экскурсия по коду'),
      h('button', { type: 'button', className: 'dsh-ide-button', onClick: onClose }, 'Закрыть'),
    ),
    h('div', { className: 'dsh-ide-tour-note' },
      'Маршрут ревью по файлам и строкам. Шаги живут только в этой панели; файлы не меняются, модель не вызывается.'),
    h('div', { className: 'dsh-ide-tour-actions' },
      h('input', {
        className: 'dsh-ide-tour-input',
        value: note,
        placeholder: 'Пояснение к шагу (необязательно)',
        onChange: (event) => setNote(event.currentTarget.value),
        onKeyDown: (event) => {
          if (event.key === 'Enter') {
            onAdd(note)
            setNote('')
          }
        },
      }),
      h('button', {
        type: 'button',
        className: 'dsh-ide-button dsh-ide-button-primary',
        disabled: list.length >= TOUR_MAX_STEPS,
        onClick: () => {
          onAdd(note)
          setNote('')
        },
      }, 'Добавить текущую строку')),
    list.length > 0
      ? h('ol', { className: 'dsh-ide-tour-list' },
          list.map((step, at) => h('li', {
            key: `${step.path}:${step.line}:${at}`,
            className: `dsh-ide-tour-row${at === index ? ' dsh-ide-tour-row-current' : ''}`,
          },
          h('button', {
            type: 'button',
            className: 'dsh-ide-tour-open',
            title: 'Открыть этот шаг',
            onClick: () => onJump(step, at),
          }, `${at + 1}. ${step.path}:${step.line}`),
          h('span', { className: 'dsh-ide-tour-text' }, step.note === '' ? 'без пояснения' : step.note),
          h('span', { className: 'dsh-ide-tour-row-actions' },
            h('button', { type: 'button', className: 'dsh-ide-tour-move', disabled: at === 0, title: 'Выше', onClick: () => onMove(at, -1) }, '↑'),
            h('button', { type: 'button', className: 'dsh-ide-tour-move', disabled: at === list.length - 1, title: 'Ниже', onClick: () => onMove(at, 1) }, '↓'),
            h('button', { type: 'button', className: 'dsh-ide-tour-move', title: 'Убрать шаг', onClick: () => onRemove(at) }, '×')))))
      : h('div', { className: 'dsh-ide-tour-empty' }, 'Пока нет шагов. Поставьте курсор в файле и добавьте строку.'),
    h('div', { className: 'dsh-ide-tour-footer' },
      h('span', { className: 'dsh-ide-tour-meta' }, `Шаг ${tourProgress(index, list.length)}`),
      h('button', { type: 'button', className: 'dsh-ide-button', disabled: list.length === 0 || index <= 0, onClick: onPrev }, 'Назад'),
      h('button', { type: 'button', className: 'dsh-ide-button dsh-ide-button-primary', disabled: list.length === 0 || index >= list.length - 1, onClick: onNext }, 'Далее')),
  )
}

function DebugPanel({ onClose, onInsert }) {
  const [hypothesis, setHypothesis] = React.useState('')
  const [steps, setSteps] = React.useState('')
  const [runA, setRunA] = React.useState('')
  const [runB, setRunB] = React.useState('')
  const [logs, setLogs] = React.useState('')
  const [cleaned, setCleaned] = React.useState(false)
  const composed = debugBlock({ hypothesis, steps, runA, runB, logs, cleaned })
  const empty = [hypothesis, steps, runA, runB, logs].every((value) => value.trim() === '') && !cleaned
  return h(
    'div',
    { className: 'dsh-ide-modal-card dsh-ide-debug-card', role: 'region', 'aria-label': 'Журнал отладки' },
    h(
      'div',
      { className: 'dsh-ide-debug-head' },
      h('strong', null, 'Журнал отладки'),
      h('button', { type: 'button', className: 'dsh-ide-button', onClick: onClose }, 'Закрыть'),
    ),
    h('div', { className: 'dsh-ide-debug-note' },
      'Это не отладчик: точки останова и процессы им не управляются. Журнал собирает гипотезу, шаги, два прогона и состояние временных логов, чтобы приложить их к чату одним блоком.'),
    h('label', { className: 'dsh-ide-debug-field' }, 'Гипотеза', h('input', {
      className: 'dsh-ide-debug-input',
      value: hypothesis,
      onChange: (event) => setHypothesis(event.currentTarget.value),
      placeholder: 'Что, по-вашему, ломается и почему',
    })),
    h('label', { className: 'dsh-ide-debug-field' }, 'Шаги воспроизведения', h('textarea', {
      className: 'dsh-ide-debug-text',
      value: steps,
      rows: 3,
      onChange: (event) => setSteps(event.currentTarget.value),
      placeholder: '1. … 2. …',
    })),
    h('div', { className: 'dsh-ide-debug-runs' },
      h('label', { className: 'dsh-ide-debug-field' }, 'Прогон A', h('textarea', {
        className: 'dsh-ide-debug-text',
        value: runA,
        rows: 3,
        onChange: (event) => setRunA(event.currentTarget.value),
        placeholder: 'Команда, вывод, результат',
      })),
      h('label', { className: 'dsh-ide-debug-field' }, 'Прогон B', h('textarea', {
        className: 'dsh-ide-debug-text',
        value: runB,
        rows: 3,
        onChange: (event) => setRunB(event.currentTarget.value),
        placeholder: 'Повтор после изменения',
      }))),
    h('label', { className: 'dsh-ide-debug-field' }, 'Временные логи', h('input', {
      className: 'dsh-ide-debug-input',
      value: logs,
      onChange: (event) => setLogs(event.currentTarget.value),
      placeholder: 'Путь к логам, которые надо убрать',
    })),
    h('label', { className: 'dsh-ide-debug-check' },
      h('input', {
        type: 'checkbox',
        checked: cleaned,
        onChange: (event) => setCleaned(event.currentTarget.checked),
      }),
      'Временные логи убраны'),
    !cleaned && logs.trim() !== ''
      ? h('div', { className: 'dsh-ide-debug-warn' }, 'В блоке будет пометка, что логи ещё не убраны.')
      : null,
    h('div', { className: 'dsh-ide-debug-meta' },
      empty ? 'Пока нечего вставлять' : `Вставится ${composed.chars} символов${composed.truncated ? ' · журнал обрезан' : ''}`),
    h('pre', { className: 'dsh-ide-debug-preview' }, empty ? 'Предпросмотр появится здесь.' : composed.text),
    h('div', { className: 'dsh-ide-debug-actions' },
      h('button', {
        type: 'button',
        className: 'dsh-ide-button dsh-ide-button-primary',
        disabled: empty,
        onClick: () => {
          if (onInsert(composed.text) === true) onClose()
        },
      }, 'Вставить в чат'),
      h('button', { type: 'button', className: 'dsh-ide-button', onClick: onClose }, 'Отмена')),
  )
}

function SplitEditor({ monaco, runtime, tab, dirty, onDirty, onSave, onActivate, onClose }) {
  const host = React.useRef(null)
  const callbacks = React.useRef({ onDirty, onSave })
  callbacks.current = { onDirty, onSave }
  React.useEffect(() => {
    if (monaco === undefined || host.current === null) return undefined
    let model = runtime.current.models.get(tab.key)
    if (model === undefined) {
      model = monaco.editor.createModel(
        tab.text,
        tab.language,
        monaco.Uri.parse(`inmemory://dsh-ide/${encodeURIComponent(tab.key)}`),
      )
      runtime.current.models.set(tab.key, model)
      runtime.current.modelTabs.set(model.uri.toString(), tab.key)
    }
    const editor = monaco.editor.create(host.current, {
      model,
      automaticLayout: true,
      theme: themeName() === 'dark' ? 'vs-dark' : 'vs',
      fontSize: 12,
      lineHeight: 19,
      minimap: { enabled: false },
      tabSize: 2,
      insertSpaces: true,
      scrollBeyondLastLine: false,
      wordBasedSuggestions: 'off',
      renderLineHighlight: 'line',
      smoothScrolling: true,
      wordWrap: 'on',
      readOnly: tab.readOnly === true,
      glyphMargin: false,
      padding: { top: 8, bottom: 16 },
    })
    const change = editor.onDidChangeModelContent(() => callbacks.current.onDirty(tab.key))
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => void callbacks.current.onSave(tab.key))
    return () => {
      change.dispose()
      editor.dispose()
    }
  }, [monaco, tab.key])
  return h(
    'div',
    { className: 'dsh-ide-split' },
    h(
      'div',
      { className: 'dsh-ide-split-head' },
      h(
        'button',
        {
          type: 'button',
          className: 'dsh-ide-split-title',
          title: 'Открыть этот файл в основной панели',
          onClick: () => onActivate(tab.key),
        },
        tab.path === '' ? tab.name : tab.path,
      ),
      dirty ? h('span', { className: 'dsh-ide-split-dirty', title: 'Есть несохранённые правки' }, '●') : null,
      h(
        'button',
        {
          type: 'button',
          className: 'dsh-ide-split-action',
          title: 'Сохранить файл',
          disabled: tab.readOnly === true,
          onClick: () => void onSave(tab.key),
        },
        'Сохранить',
      ),
      h('button', { type: 'button', className: 'dsh-ide-split-action', title: 'Закрыть вторую панель', onClick: onClose }, '×'),
    ),
    h('div', { className: 'dsh-ide-split-stage', ref: host }),
  )
}

function ExplorePanel({ onClose, onAsk, onOpen }) {
  const [question, setQuestion] = React.useState('')
  const [view, setView] = React.useState({ phase: 'idle' })
  const inputRef = React.useRef(undefined)
  React.useEffect(() => {
    inputRef.current?.focus()
  }, [])
  const submit = async () => {
    const value = question.trim()
    if (value === '' || view.phase === 'running') return
    setView({ phase: 'running' })
    try {
      const payload = await onAsk(value)
      if (payload.error) throw new Error(payload.error.message ?? 'Не удалось получить ответ.')
      setView({ phase: 'ready', ...payload })
    } catch (error) {
      setView({ phase: 'failed', error: messageOf(error) })
    }
  }
  return h(
    'div',
    { className: 'dsh-ide-modal' },
    h(
      'div',
      { className: 'dsh-ide-modal-card dsh-ide-explore-card' },
      h(
        'div',
        { className: 'dsh-ide-explore-head' },
        h('span', { className: 'dsh-ide-explore-title' }, 'Спросить о проекте'),
        h(
          'button',
          { type: 'button', className: 'dsh-ide-explore-close', onClick: onClose, title: 'Закрыть', 'aria-label': 'Закрыть' },
          '×',
        ),
      ),
      h('input', {
        ref: inputRef,
        className: 'dsh-ide-explore-input',
        value: question,
        placeholder: 'Например: где считается ответ?',
        onChange: (event) => setQuestion(event.target.value),
        onKeyDown: (event) => {
          if (event.key === 'Enter') void submit()
          if (event.key === 'Escape') onClose()
        },
      }),
      h(
        'div',
        { className: 'dsh-ide-explore-actions' },
        h(
          'button',
          {
            type: 'button',
            className: 'dsh-ide-explore-ask',
            disabled: question.trim() === '' || view.phase === 'running',
            onClick: () => void submit(),
          },
          view.phase === 'running' ? 'Ищу…' : 'Спросить',
        ),
        h('span', { className: 'dsh-ide-explore-note' }, 'Поиск локальный; модели уходят только найденные строки.'),
      ),
      view.phase === 'failed'
        ? h('div', { className: 'dsh-ide-explore-error' }, view.error)
        : null,
      view.phase === 'ready'
        ? h(
            'div',
            { className: 'dsh-ide-explore-result' },
            h('pre', { className: 'dsh-ide-explore-answer' }, view.answer),
            view.sources.length > 0
              ? h(
                  'div',
                  { className: 'dsh-ide-explore-sources' },
                  h('div', { className: 'dsh-ide-explore-sources-head' }, 'Источники'),
                  view.sources.map((source) =>
                    h(
                      'button',
                      {
                        type: 'button',
                        key: `${source.path}:${source.line}`,
                        className: 'dsh-ide-explore-source',
                        onClick: () => onOpen(source),
                        title: source.text,
                      },
                      `${source.path}:${source.line}`,
                    ),
                  ),
                )
              : h('div', { className: 'dsh-ide-explore-note' }, 'Ссылок на найденные строки нет.'),
            h(
              'div',
              { className: 'dsh-ide-explore-meta' },
              `Просмотрено файлов: ${view.files.length}${view.truncated ? ' · список усечён' : ''}`,
            ),
          )
        : null,
      h(
        'div',
        { className: 'dsh-ide-explore-foot' },
        'Ответ не меняет файлы. Нажмите источник, чтобы открыть строку.',
      ),
    ),
  )
}

function ConversationSearchPanel({ onClose, onSearch, onOpen, onAttach }) {
  const [query, setQuery] = React.useState('')
  const [view, setView] = React.useState({ phase: 'idle' })
  const inputRef = React.useRef(undefined)
  React.useEffect(() => {
    inputRef.current?.focus()
  }, [])
  const submit = async () => {
    const value = query.trim()
    if (value === '' || view.phase === 'running') return
    setView({ phase: 'running' })
    try {
      const payload = await onSearch(value)
      if (payload.error) throw new Error(payload.error.message ?? 'Поиск не удался.')
      setView({ phase: 'ready', ...payload })
    } catch (error) {
      setView({ phase: 'failed', error: messageOf(error) })
    }
  }
  return h(
    'div',
    { className: 'dsh-ide-modal' },
    h(
      'div',
      { className: 'dsh-ide-modal-card dsh-ide-conv-card' },
      h(
        'div',
        { className: 'dsh-ide-explore-head' },
        h('span', { className: 'dsh-ide-explore-title' }, 'Найти в разговорах'),
        h(
          'button',
          { type: 'button', className: 'dsh-ide-explore-close', onClick: onClose, title: 'Закрыть', 'aria-label': 'Закрыть' },
          '×',
        ),
      ),
      h('input', {
        ref: inputRef,
        className: 'dsh-ide-explore-input',
        value: query,
        placeholder: 'Например: как решили конфликт индекса?',
        onChange: (event) => setQuery(event.target.value),
        onKeyDown: (event) => {
          if (event.key === 'Enter') void submit()
          if (event.key === 'Escape') onClose()
        },
      }),
      h(
        'div',
        { className: 'dsh-ide-explore-actions' },
        h(
          'button',
          {
            type: 'button',
            className: 'dsh-ide-explore-ask',
            disabled: query.trim() === '' || view.phase === 'running',
            onClick: () => void submit(),
          },
          view.phase === 'running' ? 'Ищу…' : 'Найти',
        ),
        h('span', { className: 'dsh-ide-explore-note' }, 'Индекс разговоров этой рабочей папки; модель не вызывается.'),
      ),
      view.phase === 'failed' ? h('div', { className: 'dsh-ide-explore-error' }, view.error) : null,
      view.phase === 'ready'
        ? h(
            'div',
            { className: 'dsh-ide-conv-result' },
            view.items.length === 0
              ? h('div', { className: 'dsh-ide-explore-note' }, 'Ничего не найдено. Попробуйте другие слова.')
              : h(
                  'div',
                  { className: 'dsh-ide-conv-list' },
                  view.items.map((item) =>
                    h(
                      'div',
                      { key: `${item.sessionId}:${item.seq ?? 0}`, className: 'dsh-ide-conv-row' },
                      h(
                        'button',
                        {
                          type: 'button',
                          className: 'dsh-ide-conv-hit',
                          onClick: () => onOpen(item),
                        },
                        h('span', { className: 'dsh-ide-conv-snippet' }, item.snippet || '(без фрагмента)'),
                        h(
                          'span',
                          { className: 'dsh-ide-conv-meta' },
                          `${item.title || item.sessionId}${item.time ? ` · ${new Date(item.time).toLocaleString('ru-RU')}` : ''}`,
                        ),
                      ),
                      h(
                        'button',
                        {
                          type: 'button',
                          className: 'dsh-ide-conv-attach',
                          disabled: !Number.isInteger(item.seq),
                          title: Number.isInteger(item.seq) ? 'Приложить этот ход в поле ввода' : 'Ход без номера приложить нельзя',
                          onClick: () => void onAttach(item),
                        },
                        'Приложить',
                      ),
                    ),
                  ),
                ),
            h(
              'div',
              { className: 'dsh-ide-explore-meta' },
              `Найдено: ${view.items.length}${view.hasMore ? ' · есть ещё' : ''}`,
            ),
          )
        : null,
      h(
        'div',
        { className: 'dsh-ide-explore-foot' },
        'Результат открывается в своей сессии. Модель не вызывается, файлы не меняются.',
      ),
    ),
  )
}

function ConversationSourcePanel({ source, onClose, onInsert }) {
  const text = typeof source.text === 'string' ? source.text : ''
  const preview = text.slice(0, 1200)
  return h(
    'div',
    { className: 'dsh-ide-modal' },
    h(
      'div',
      { className: 'dsh-ide-modal-card dsh-ide-conv-card' },
      h(
        'div',
        { className: 'dsh-ide-explore-head' },
        h('span', { className: 'dsh-ide-explore-title' }, 'Источник из разговора'),
        h(
          'button',
          { type: 'button', className: 'dsh-ide-explore-close', onClick: onClose, title: 'Закрыть', 'aria-label': 'Закрыть' },
          '×',
        ),
      ),
      h('div', { className: 'dsh-ide-conv-source-title' }, source.title || source.sessionId),
      h(
        'div',
        { className: 'dsh-ide-explore-meta' },
        `${source.chars} символ(ов) · ${source.type === 'assistant/message' ? 'ответ' : 'вопрос'}${
          source.time ? ` · ${new Date(source.time).toLocaleString('ru-RU')}` : ''
        }${source.truncated ? ' · в чат попадёт только начало' : ''}`,
      ),
      h('pre', { className: 'dsh-ide-conv-source-text' }, preview),
      text.length > preview.length ? h('div', { className: 'dsh-ide-explore-note' }, 'Показаны первые 1200 символов.') : null,
      h(
        'div',
        { className: 'dsh-ide-explore-actions' },
        h(
          'button',
          { type: 'button', className: 'dsh-ide-explore-ask', onClick: () => void onInsert() },
          'Вставить в чат',
        ),
        h('button', { type: 'button', className: 'dsh-ide-explore-ask', onClick: onClose }, 'Отмена'),
        h('span', { className: 'dsh-ide-explore-note' }, 'Вставляется только этот ход, не вся сессия.'),
      ),
    ),
  )
}

function SideChatPanel({ context, onClose, onAsk }) {
  const [question, setQuestion] = React.useState('')
  const [turns, setTurns] = React.useState([])
  const [view, setView] = React.useState({ phase: 'idle' })
  const inputRef = React.useRef(undefined)
  React.useEffect(() => {
    inputRef.current?.focus()
  }, [])
  const running = view.phase === 'running'
  const ask = async () => {
    const value = question.trim()
    if (value === '' || running) return
    setView({ phase: 'running' })
    try {
      const payload = await onAsk({
        id: context.id,
        start: context.start,
        end: context.end,
        selection: context.text,
        question: value,
        history: turns.map((turn) => ({ question: turn.question, answer: turn.answer })),
      })
      if (payload.error) throw new Error(payload.error.message ?? 'Не удалось получить ответ.')
      setTurns([...turns, { question: value, answer: payload.answer }])
      setQuestion('')
      setView({ phase: 'idle' })
    } catch (error) {
      setView({ phase: 'failed', error: messageOf(error) })
    }
  }
  return h(
    'div',
    { className: 'dsh-ide-modal' },
    h(
      'div',
      { className: 'dsh-ide-modal-card dsh-ide-side-card' },
      h(
        'div',
        { className: 'dsh-ide-side-head' },
        h('span', { className: 'dsh-ide-side-title' }, 'Побочный вопрос'),
        h(
          'button',
          { type: 'button', className: 'dsh-ide-side-close', onClick: onClose, title: 'Закрыть', 'aria-label': 'Закрыть' },
          '×',
        ),
      ),
      h(
        'div',
        { className: 'dsh-ide-side-context' },
        h('div', { className: 'dsh-ide-side-where' }, `${context.path}:${context.start + 1}–${context.end + 1}`),
        h('pre', { className: 'dsh-ide-side-selection' }, context.text.length > 400 ? `${context.text.slice(0, 400)}…` : context.text),
      ),
      turns.length > 0
        ? h(
            'div',
            { className: 'dsh-ide-side-turns' },
            turns.map((turn, index) =>
              h(
                'div',
                { key: index, className: 'dsh-ide-side-turn' },
                h('div', { className: 'dsh-ide-side-question' }, turn.question),
                h('div', { className: 'dsh-ide-side-answer' }, turn.answer),
              ),
            ),
          )
        : null,
      view.phase === 'failed' ? h('div', { className: 'dsh-ide-side-error' }, view.error) : null,
      h('input', {
        ref: inputRef,
        className: 'dsh-ide-side-input',
        value: question,
        placeholder: 'Спросить по выделению',
        onChange: (event) => setQuestion(event.target.value),
        onKeyDown: (event) => {
          if (event.key === 'Enter') void ask()
          if (event.key === 'Escape') onClose()
        },
      }),
      h(
        'div',
        { className: 'dsh-ide-side-actions' },
        h(
          'button',
          {
            type: 'button',
            className: 'dsh-ide-side-ask',
            disabled: question.trim() === '' || running,
            onClick: () => void ask(),
          },
          running ? 'Спрашиваю…' : 'Спросить',
        ),
        h(
          'button',
          {
            type: 'button',
            className: 'dsh-ide-side-new',
            disabled: turns.length === 0 || running,
            onClick: () => {
              setTurns([])
              setView({ phase: 'idle' })
            },
          },
          'Новый вопрос',
        ),
      ),
      h(
        'div',
        { className: 'dsh-ide-side-foot' },
        'Этот разговор не попадает в основной чат. Выделение уходит модели только по кнопке; файл не меняется.',
      ),
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
      const scope = providedSession !== '' ? providedSession : fromTab !== undefined ? fromTab.sessionId : ''
      const [openTabId, setOpenTabId] = React.useState('')
      const tabOpen = openTabId !== ''

      // The IDE lives in the sidebar and can be closed from there, so the button
      // has to follow the tab inventory instead of guessing from a click. The
      // inventory holds saved and adopted tabs even while the sidebar is closed.
      React.useEffect(() => {
        const sidebar = services.sidebarRight
        const inventory = sidebar && sidebar.openTabs
        if (scope === '' || !inventory || typeof inventory.getSnapshot !== 'function' || typeof inventory.subscribe !== 'function') {
          return undefined
        }
        const read = () => {
          let tabs
          try {
            tabs = inventory.getSnapshot()
          } catch (cause) {
            return
          }
          if (!Array.isArray(tabs)) return
          const match = tabs.find((entry) => entry && entry.sessionId === scope && entry.kind === TAB_KIND)
          setOpenTabId(match && typeof match.tabId === 'string' ? match.tabId : '')
        }
        read()
        const stop = inventory.subscribe(read)
        return typeof stop === 'function' ? stop : undefined
      }, [scope])

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
            if (openTabId !== '') {
              // A second press closes only the IDE that is actually on screen.
              // An open but background or collapsed tab is revealed instead, so
              // the press never closes something the user cannot see.
              const active = typeof sidebar.active === 'function' ? sidebar.active() : undefined
              const expanded = typeof sidebar.isExpanded !== 'function' || sidebar.isExpanded()
              const showing = typeof sidebar.active !== 'function' || (expanded && active !== undefined && active.id === openTabId)
              if (showing) {
                if (typeof sidebar.closeIn === 'function') sidebar.closeIn(sessionId, openTabId)
                else if (typeof sidebar.close === 'function') sidebar.close(openTabId)
                else {
                  setError('Не удалось закрыть IDE')
                  return
                }
                return
              }
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
        [absolutePath, fromTab, openTabId, providedSession],
      )

      return h(
        'span',
        { className: props && props.compact === true ? 'dsh-ide-action dsh-ide-action-compact' : 'dsh-ide-action' },
        h(
          'button',
          {
            type: 'button',
            className: 'dsh-ide-action-button',
            'data-open': tabOpen ? 'true' : 'false',
            'aria-pressed': tabOpen,
            onClick: open,
            disabled: busy,
            title: error !== '' ? error : tabOpen ? 'IDE открыта — переключиться или закрыть' : 'Открыть рабочую область в IDE',
          },
          h(
            'svg',
            {
              className: 'dsh-ide-action-icon',
              viewBox: '0 0 24 24',
              fill: 'none',
              stroke: 'currentColor',
              strokeWidth: 1.6,
              strokeLinecap: 'round',
              strokeLinejoin: 'round',
              'aria-hidden': 'true',
            },
            h('rect', { x: 2.5, y: 4, width: 19, height: 16, rx: 2.5 }),
            h('path', { d: 'M8.5 9.5 6 12l2.5 2.5' }),
            h('path', { d: 'M15.5 9.5 18 12l-2.5 2.5' }),
            h('path', { d: 'M13 8.5 11 15.5' }),
          ),
          h('span', { className: 'dsh-ide-action-label' }, label),
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
  { key: 'autoModel', kind: 'boolean', value: true, title: 'Подсказки: автопереключение модели', hint: 'Если модель подсказок не выбрана, брать быструю из каталога провайдера, а не модель сессии. Выключите, чтобы подсказки шли на текущей модели.' },
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
  { key: 'showChat', kind: 'boolean', value: true, title: 'Показывать чат в панели', hint: 'Открывать панель вывода на вкладке «Чат» при запуске IDE. Выключите, чтобы панель не занимала место, пока вы её не откроете.' },
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

// --------------------------------------------------------------- terminal

let xtermPromise

// xterm ships as plain UMD next to the vendored Monaco: the xterm.js global
// (`window.Terminal`) is a namespace object holding the `Terminal` class, and
// `addon-fit.js` sets a `FitAddon` namespace.
function loadXterm() {
  if (xtermPromise) return xtermPromise
  xtermPromise = new Promise((resolve, reject) => {
    const read = () => (window.Terminal !== undefined && window.FitAddon !== undefined && window.FitAddon.FitAddon !== undefined
      ? { Terminal: window.Terminal.Terminal ?? window.Terminal, FitAddon: window.FitAddon.FitAddon }
      : undefined)
    const ready = read()
    if (ready !== undefined) {
      resolve(ready)
      return
    }
    const style = document.createElement('link')
    style.rel = 'stylesheet'
    style.href = `${ASSET_BASE}/xterm/xterm.css`
    document.head.appendChild(style)
    let script
    const next = (src, onDone) => {
      const element = document.createElement('script')
      element.src = src
      element.async = true
      element.addEventListener('load', onDone)
      element.addEventListener('error', () => reject(new Error('Не удалось загрузить xterm.js')))
      document.head.appendChild(element)
      return element
    }
    script = next(`${ASSET_BASE}/xterm/xterm.js`, () => {
      script = next(`${ASSET_BASE}/xterm/addon-fit.js`, () => {
        const libs = read()
        if (libs === undefined) {
          reject(new Error('xterm.js загрузился без глобальных экспортов'))
          return
        }
        resolve(libs)
      })
    })
  })
  return xtermPromise
}

function bytesFromBase64(text) {
  const binary = atob(text)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}

const TERMINAL_PROFILE_LABELS = {
  powershell: 'PowerShell',
  pwsh: 'PowerShell (pwsh)',
  cmd: 'Command Prompt',
  'git-bash': 'Git Bash',
  node: 'Node',
  shell: 'Shell',
}

/**
 * One real PTY session in the bottom panel. Terminals live on the Host, so a
 * page reload finds them again through `termList`; the reader keeps a byte
 * offset per terminal and long-polls for new output.
 */
function PtyPanel({ sessionId, call, height }) {
  const [terminals, setTerminals] = React.useState([])
  const [activeId, setActiveId] = React.useState(undefined)
  const [profiles, setProfiles] = React.useState(undefined)
  const [profileMenu, setProfileMenu] = React.useState(false)
  const [error, setError] = React.useState('')
  const hostsRef = React.useRef(new Map())
  const enginesRef = React.useRef(new Map())
  const readersRef = React.useRef(new Map())
  const offsetsRef = React.useRef(new Map())

  const engineOf = (id) => enginesRef.current.get(id)

  const markDead = React.useCallback((id, exitCode) => {
    setTerminals((previous) => previous.map((item) => (item.id === id ? { ...item, alive: false, exitCode: exitCode ?? item.exitCode } : item)))
  }, [])

  const startReader = React.useCallback((id) => {
    if (readersRef.current.has(id)) return
    const controller = new AbortController()
    readersRef.current.set(id, controller)
    ;(async () => {
      while (!controller.signal.aborted) {
        try {
          const payload = await call('termRead', { sessionId, id, offset: offsetsRef.current.get(id) ?? 0, waitMs: 15000 }, controller.signal)
          if (controller.signal.aborted) return
          const engine = engineOf(id)
          if (payload.gap === true) {
            if (engine !== undefined) engine.term.reset()
            offsetsRef.current.set(id, payload.offset)
            continue
          }
          if (payload.data !== '' && engine !== undefined) {
            engine.term.write(bytesFromBase64(payload.data))
          }
          offsetsRef.current.set(id, payload.offset)
          if (payload.alive === false) {
            markDead(id, payload.exitCode)
            return
          }
        } catch (cause) {
          if (controller.signal.aborted || cause?.name === 'AbortError') return
          markDead(id, undefined)
          return
        }
      }
    })()
  }, [call, markDead, sessionId])

  // Attach an xterm to every terminal that does not have one yet, then start
  // its reader. Dead terminals from a previous page keep their scrollback.
  React.useEffect(() => {
    let cancelled = false
    ;(async () => {
      let libs
      try {
        libs = await loadXterm()
      } catch (cause) {
        if (!cancelled) setError(describeError(cause))
        return
      }
      if (cancelled) return
      for (const item of terminals) {
        const host = hostsRef.current.get(item.id)
        if (host === undefined || enginesRef.current.has(item.id)) continue
        const term = new (libs.Terminal.Terminal ?? libs.Terminal)({
          cursorBlink: true,
          fontSize: 12.5,
          fontFamily: 'Consolas, "Courier New", monospace',
          scrollback: 5000,
          convertEol: false,
        })
        const fit = new libs.FitAddon()
        term.loadAddon(fit)
        term.open(host)
        try {
          fit.fit()
        } catch {
          /* zero-size host while hidden */
        }
        term.onData((data) => {
          if (call !== undefined) call('termWrite', { sessionId, id: item.id, data }).catch(() => {})
        })
        term.onResize((size) => {
          if (call !== undefined) call('termResize', { sessionId, id: item.id, cols: size.cols, rows: size.rows }).catch(() => {})
        })
        enginesRef.current.set(item.id, { term, fit })
        if (item.alive !== false) startReader(item.id)
        // Pull the backlog the reader may already have missed.
        if (call !== undefined && item.alive !== false && (offsetsRef.current.get(item.id) ?? 0) === 0) {
          call('termRead', { sessionId, id: item.id, offset: 0, waitMs: 0 })
            .then((payload) => {
              if (payload.data !== '') term.write(bytesFromBase64(payload.data))
              offsetsRef.current.set(item.id, payload.offset)
            })
            .catch(() => {})
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [terminals, startReader, call, sessionId])

  // Keep the active terminal fitted to the panel: height drags and window
  // resizes both land here.
  React.useEffect(() => {
    const refit = () => {
      const engine = engineOf(activeId)
      if (engine === undefined) return
      try {
        engine.fit.fit()
      } catch {
        /* zero-size host */
      }
    }
    refit()
    window.addEventListener('resize', refit)
    return () => window.removeEventListener('resize', refit)
  }, [activeId, height, terminals])

  const refreshList = React.useCallback(async () => {
    if (call === undefined) return
    try {
      const payload = await call('termList', { sessionId })
      setTerminals(Array.isArray(payload.terminals) ? payload.terminals : [])
      for (const item of payload.terminals ?? []) {
        if (offsetsRef.current.get(item.id) === undefined) offsetsRef.current.set(item.id, 0)
      }
    } catch (cause) {
      setError(describeError(cause))
    }
  }, [call, sessionId])

  const createTerminal = React.useCallback(async (profile) => {
    if (call === undefined) return
    setProfileMenu(false)
    try {
      const created = await call('termCreate', { sessionId, profile, cols: 80, rows: 24 })
      offsetsRef.current.set(created.id, 0)
      setTerminals((previous) => [...previous, { ...created, alive: true }])
      setActiveId(created.id)
    } catch (cause) {
      setError(describeError(cause))
    }
  }, [call, sessionId])

  const killTerminal = React.useCallback(async (id) => {
    readersRef.current.get(id)?.abort()
    readersRef.current.delete(id)
    const engine = enginesRef.current.get(id)
    enginesRef.current.delete(id)
    try {
      engine?.term.dispose()
    } catch {
      /* already gone */
    }
    if (call !== undefined) call('termKill', { sessionId, id }).catch(() => {})
    setTerminals((previous) => previous.filter((item) => item.id !== id))
    setActiveId((current) => (current === id ? undefined : current))
  }, [call, sessionId])

  // On mount: adopt whatever the Host still runs; otherwise create the first
  // terminal in the default profile, the way VS Code opens one for you.
  React.useEffect(() => {
    if (call === undefined || sessionId === undefined) return
    let cancelled = false
    ;(async () => {
      try {
        const payload = await call('termProfiles', {})
        if (!cancelled) setProfiles(Array.isArray(payload.profiles) ? payload.profiles.filter((profile) => profile.available !== false) : [])
      } catch {
        if (!cancelled) setProfiles([])
      }
      await refreshList()
    })()
    return () => {
      cancelled = true
    }
  }, [call, sessionId, refreshList])

  React.useEffect(() => {
    if (profiles === undefined || terminals.length > 0 || activeId !== undefined) return
    if (profiles.length === 0) return
    const preferred = profiles.find((profile) => profile.id === 'powershell') ?? profiles[0]
    void createTerminal(preferred.id)
  }, [profiles, terminals.length, activeId, createTerminal])

  // Tear down readers when the panel unmounts; the processes stay alive on
  // the Host so a reopened panel (or reload) can adopt them again.
  React.useEffect(() => () => {
    for (const controller of readersRef.current.values()) controller.abort()
    readersRef.current.clear()
  }, [])

  React.useEffect(() => {
    if (!profileMenu) return undefined
    const close = () => setProfileMenu(false)
    const onKey = (event) => {
      if (event.key === 'Escape') close()
    }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', onKey)
    }
  }, [profileMenu])

  const labelOf = (item) => `${TERMINAL_PROFILE_LABELS[item.profile] ?? item.profile} — ${item.cwd === undefined ? '' : item.cwd}`

  const visible = terminals.filter((item) => item.alive !== false || enginesRef.current.has(item.id))
  return h(
    'div',
    { className: 'dsh-ide-pty' },
    h(
      'div',
      { className: 'dsh-ide-pty-strip' },
      h(
        'div',
        { className: 'dsh-ide-pty-actions' },
        h('button', {
          type: 'button',
          className: 'dsh-ide-pty-new',
          title: menuText('Создать терминал', 'New terminal'),
          onClick: () => setProfileMenu((current) => !current),
          onMouseDown: (event) => event.stopPropagation(),
        }, '+'),
        h(
          'div',
          { className: 'dsh-ide-pty-tabs' },
          visible.length === 0 ? h('span', { className: 'dsh-ide-pty-empty' }, menuText('Терминалов нет', 'No terminals')) : null,
          visible.map((item) => h(
            'button',
            {
              key: item.id,
              type: 'button',
              className: `dsh-ide-pty-tab${item.id === activeId ? ' dsh-ide-pty-tab-active' : ''}`,
              title: labelOf(item),
              onClick: () => setActiveId(item.id),
            },
            h('span', { className: item.alive === false ? 'dsh-ide-pty-dead' : undefined },
              item.alive === false
                ? menuText(`завершён (${item.exitCode ?? 0})`, `exited (${item.exitCode ?? 0})`)
                : TERMINAL_PROFILE_LABELS[item.profile] ?? item.profile),
            h('span', {
              className: 'dsh-ide-pty-close',
              title: menuText('Завершить', 'Kill terminal'),
              onClick: (event) => {
                event.stopPropagation()
                void killTerminal(item.id)
              },
            }, '×'),
          )),
        ),
      ),
      error === '' ? null : h('span', { className: 'dsh-ide-pty-error' }, error),
    ),
    h(
      'div',
      { className: 'dsh-ide-pty-screens', style: { height: `${Math.max(120, height - 30)}px` } },
      visible.length === 0
        ? h(
            'div',
            { className: 'dsh-ide-pty-blank' },
            profiles === undefined ? menuText('Загрузка…', 'Loading…') : menuText('Создайте терминал кнопкой «+»', 'Create a terminal with “+”'),
          )
        : visible.map((item) => h(
            'div',
            {
              key: item.id,
              hidden: item.id !== activeId,
              className: 'dsh-ide-pty-screen',
              ref: (node) => {
                if (node === null) hostsRef.current.delete(item.id)
                else hostsRef.current.set(item.id, node)
              },
            },
          )),
    ),
    profileMenu
      ? h(
          'div',
          {
            className: 'dsh-ide-pty-profiles',
            onMouseDown: (event) => event.stopPropagation(),
          },
          (profiles ?? []).map((profile) => h(
            'button',
            {
              key: profile.id,
              type: 'button',
              className: 'dsh-ide-pty-profile',
              onClick: () => void createTerminal(profile.id),
            },
            TERMINAL_PROFILE_LABELS[profile.id.split(':')[0]] !== undefined
              ? `${TERMINAL_PROFILE_LABELS[profile.id.split(':')[0]]}${profile.id.includes(':') ? profile.id.slice(profile.id.indexOf(':')) : ''}`
              : profile.id,
          )),
          (profiles ?? []).length === 0 ? h('span', { className: 'dsh-ide-pty-empty' }, menuText('Профили не найдены', 'No profiles found')) : null,
        )
      : null,
  )
}

function OutputPanel({ panel, height, trace, showChat, toolTabs, onTab, onSelect, onAccept, onClose }) {
  const [menu, setMenu] = React.useState(undefined)
  React.useEffect(() => {
    if (menu === undefined) return undefined
    const close = () => setMenu(undefined)
    const onKey = (event) => {
      if (event.key === 'Escape') close()
    }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', onKey)
    }
  }, [menu])
  const selected = trace.length === 0 ? undefined : trace[Math.min(panel.index, trace.length - 1)]
  // Inline edits have no recorded conversation. Do not let their rows blank
  // the Chat tab: fall back to the newest row that does carry one.
  const entry = selected !== undefined && selected.conversation !== undefined
    ? selected
    : trace.find((row) => row.conversation !== undefined)
  const conversation = entry === undefined ? undefined : entry.conversation
  const system = conversation === undefined ? '' : conversation.system
  const message = conversation === undefined ? '' : conversation.message
  const answer = conversation === undefined ? '' : conversation.answer
  const toolActive = toolTabs.some((tool) => tool.id === panel.tab)
  const chatOpen = showChat !== false && panel.tab === 'chat'
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
          className: !chatOpen && !toolActive ? 'dsh-ide-panel-tab dsh-ide-panel-tab-active' : 'dsh-ide-panel-tab',
          onClick: () => onTab('trajectory'),
        },
        menuText('Траектория', 'Trajectory'),
      ),
      showChat === false ? null : h(
        'button',
        {
          type: 'button',
          className: chatOpen ? 'dsh-ide-panel-tab dsh-ide-panel-tab-active' : 'dsh-ide-panel-tab',
          onClick: () => onTab('chat'),
        },
        menuText('Чат', 'Chat'),
      ),
      toolTabs.map(({ id, label }) => h('button', { key: id, type: 'button',
        className: `dsh-ide-panel-tab${panel.tab === id ? ' dsh-ide-panel-tab-active' : ''}`,
        onClick: () => onTab(id),
      }, label)),
      h('span', { className: 'dsh-ide-panel-spacer' }),
      toolActive ? null : h('span', { className: 'dsh-ide-panel-hint' }, trace.length === 0 ? 'пока пусто' : `запросов: ${trace.length}`),
      showChat === false
        ? h('button', { type: 'button', className: 'dsh-ide-panel-close', title: 'Закрыть панель', onClick: onClose }, '×')
        : null,
    ),
    toolTabs.map(({ id, body }) => h('div', { key: id, hidden: panel.tab !== id, className: 'dsh-ide-panel-tool' }, body)),
    toolActive ? null : !chatOpen
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
                    title: row.hint === undefined ? undefined : 'Клик — показать подсказку, правый клик — принять',
                    onClick: () => onSelect(index),
                    onContextMenu: (event) => {
                      if (row.hint === undefined) return
                      event.preventDefault()
                      event.stopPropagation()
                      const width = window.innerWidth
                      const heightNow = window.innerHeight
                      setMenu({
                        x: Math.max(4, Math.min(event.clientX, width - 184)),
                        y: Math.max(4, Math.min(event.clientY, heightNow - 42)),
                        row,
                      })
                    },
                  },
                  h('span', { className: 'dsh-ide-trace-time' }, row.at),
                  h('span', { className: 'dsh-ide-trace-path' }, row.path),
                  h(
                    'span',
                    {
                      className: 'dsh-ide-trace-model',
                      title: traceModelHint(row),
                    },
                    row.pending === true
                      ? 'модель думает…'
                      : `${row.provider} / ${row.model}${
                          row.fellBack === true ? ' · запасная' : row.modelSource === 'session' ? ' · из сессии' : row.modelSource === 'auto' ? ' · быстрая' : ''
                        }`,
                  ),
                  h(
                    'span',
                    { className: 'dsh-ide-trace-mode' },
                    row.kind === 'inline-edit' ? 'правка' : row.explicit ? 'Ctrl+Space' : 'авто',
                  ),
                  h('span', { className: 'dsh-ide-trace-meta' }, `${row.before}/${row.after} символов`),
                  h('span', { className: 'dsh-ide-trace-meta' }, row.displayMs === undefined ? `${row.durationMs} мс` : `до показа: ${row.displayMs} мс · Host: ${row.durationMs} мс`),
                  row.pending === true
                    ? h('span', { className: 'dsh-ide-trace-pending' }, 'думает…')
                    : row.ok
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
    menu === undefined
      ? null
      : h(
          'div',
          {
            className: 'dsh-ide-context-menu',
            style: { left: `${menu.x}px`, top: `${menu.y}px` },
            onMouseDown: (event) => event.stopPropagation(),
          },
          h(
            'button',
            {
              type: 'button',
              className: 'dsh-ide-context-item',
              onClick: () => {
                const row = menu.row
                setMenu(undefined)
                onAccept(row)
              },
            },
            menuText('Принять правку', 'Accept edit'),
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
      const hintElapsedRef = React.useRef(null)
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
        attribution: [],
        inlineSeq: 0,
        changeSeq: 0,
        // The last non-empty selection, kept because a touch on a menu (or a
        // long-press context menu) can collapse Monaco's live selection before
        // the inline-edit command runs. Offsets are only reused while the model
        // version still matches, so a typed change cannot target stale text.
        lastSelection: undefined,
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

      // The pane itself is measured: the shell gives the right sidebar a column
      // whose width has little to do with the window on a desktop, and phones in
      // landscape are wider than the breakpoint while still being phones.
      const rootRef = React.useRef(null)
      const paneWidth = usePaneWidth(rootRef)
      const coarsePointer = useMediaQuery('(pointer: coarse)')
      const narrowWindow = useMediaQuery(`(max-width: ${COMPACT_PANE_WIDTH}px)`)
      const compact =
        paneWidth < COMPACT_PANE_HARD_WIDTH || (paneWidth < COMPACT_PANE_WIDTH && (coarsePointer || narrowWindow))
      const compactRef = React.useRef(compact)
      compactRef.current = compact
      // Touch size defaults follow the input device, not the pane width: a phone
      // held sideways has plenty of width but still wants readable text.
      const coarseRef = React.useRef(coarsePointer)
      coarseRef.current = coarsePointer

      const [monaco, setMonaco] = React.useState(undefined)
      // Loading the editor is not guaranteed: a stalled bundle or a broken
      // WebView must still show the file. Those four fields drive the plain
      // text fallback below the stage.
      const [editorAttempt, setEditorAttempt] = React.useState(0)
      const [editorFailure, setEditorFailure] = React.useState(null)
      const [editorReady, setEditorReady] = React.useState(false)
      const [editorSlow, setEditorSlow] = React.useState(false)
      const [tabs, setTabs] = React.useState([])
      const [activeKey, setActiveKey] = React.useState('')
      const [status, setStatus] = React.useState({ kind: 'idle', message: '' })
      const [explorerWidth, setExplorerWidth] = React.useState(220)
      const [showTree, setShowTree] = React.useState(true)
      // The left column is either the file tree or the Source Control view;
      // both keep the same width and drawer behaviour.
      const [explorerMode, setExplorerMode] = React.useState('files')
      const [searchOpen, setSearchOpen] = React.useState(false)
      const [changes, setChanges] = React.useState([])
      /** Host checkpoints of assistant turns: `{phase, available, turns, error}`. */
      const [assistant, setAssistant] = React.useState({ phase: 'idle', available: true, turns: [], error: '' })
      const [changesOpen, setChangesOpen] = React.useState(false)
      const [structureOpen, setStructureOpen] = React.useState(true)
      /** Outline of the active file: `{phase, language, symbols, error}`. */
      const [structure, setStructure] = React.useState({ phase: 'idle', language: '', symbols: [], error: '' })
      // Bumped on every «open at line» click: an already-active tab makes
      // openFile a state no-op, and the reveal effect only runs when a dep changes.
      const [revealNonce, setRevealNonce] = React.useState(0)
      /** Per-file decision on an assistant turn, keyed `seq:index`. */
      const [assistantWork, setAssistantWork] = React.useState({})
      /** Side-by-side comparison over the editor: `{phase, seq, index, path, display, before, after, language, error}`. */
      const [diffView, setDiffView] = React.useState(undefined)
      const diffContainerRef = React.useRef(undefined)
      // A theme switch changes CSS variables and Monaco at once; the counter
      // only exists to re-run render and the Monaco theme effect.
      const [themeTick, setThemeTick] = React.useState(0)
      React.useEffect(() => {
        const onTheme = () => setThemeTick((value) => value + 1)
        window.addEventListener(THEME_EVENT, onTheme)
        return () => window.removeEventListener(THEME_EVENT, onTheme)
      }, [])
      React.useEffect(() => {
        if (monaco !== undefined) monaco.editor.setTheme(themeName() === 'dark' ? 'vs-dark' : 'vs')
      }, [monaco, themeTick])
      // Bumped after «Отменить правки» so the pane refetches the turn list
      // instead of showing a snapshot the Host has already superseded.
      const [changesReload, setChangesReload] = React.useState(0)
      // Source Control: the snapshot is the Host's revisioned view of the
      // worktree, never a client guess. The request counter discards an answer
      // that belongs to an older session or an older panel open.
      const [scmStatus, setScmStatus] = React.useState(undefined)
      const [scmError, setScmError] = React.useState('')
      const [scmLoading, setScmLoading] = React.useState(false)
      const [scmBusy, setScmBusy] = React.useState('')
      const [scmMessage, setScmMessage] = React.useState('')
      /** Git comparison over the editor: `{phase, seq, group, path, before, after, ...}`. */
      const [scmDiff, setScmDiff] = React.useState(undefined)
      const [scmReload, setScmReload] = React.useState(0)
      const scmSeq = React.useRef(0)
      const scmAbort = React.useRef(undefined)
      const scmDiffSeq = React.useRef(0)
      // «В чат» sends one exact patch, not the whole panel: the pending answer
      // disables the button instead of letting two quotes race the composer.
      const [scmPatching, setScmPatching] = React.useState(false)
      /** `{path, line}` the next ready Git comparison should reveal. */
      const scmReveal = React.useRef(undefined)
      const [paletteOpen, setPaletteOpen] = React.useState(false)
      const [explorerSide, setExplorerSide] = React.useState('left')
      const [hidden, setHidden] = React.useState(false)
      const [preferences, setPreferences] = React.useState(undefined)
      const [promptDefault, setPromptDefault] = React.useState('')
      const [settingsOpen, setSettingsOpen] = React.useState(false)
      const [rulesOpen, setRulesOpen] = React.useState(false)
      const [plansOpen, setPlansOpen] = React.useState(false)
      const [terminalOpen, setTerminalOpen] = React.useState(false)
      const [ptyOpen, setPtyOpen] = React.useState(false)
      const [snoozeUntil, setSnoozeUntil] = React.useState(0)
      const [splitKey, setSplitKey] = React.useState('')
  const [crossFile, setCrossFile] = React.useState(undefined)
  const [symbolView, setSymbolView] = React.useState(undefined)
  const [blameView, setBlameView] = React.useState(undefined)
  const [exploreOpen, setExploreOpen] = React.useState(false)
  const [convSearchOpen, setConvSearchOpen] = React.useState(false)
  const [convSource, setConvSource] = React.useState(undefined)
  const [debugOpen, setDebugOpen] = React.useState(false)
  const [notesPackOpen, setNotesPackOpen] = React.useState(false)
  const [tourOpen, setTourOpen] = React.useState(false)
  const [tourSteps, setTourSteps] = React.useState([])
  const [tourIndex, setTourIndex] = React.useState(0)
  const [worktreesOpen, setWorktreesOpen] = React.useState(false)
  const [sideChat, setSideChat] = React.useState(undefined)
  const [renameView, setRenameView] = React.useState(undefined)
  const [testsView, setTestsView] = React.useState(undefined)
  const testsAbort = React.useRef(undefined)
      const [planPicker, setPlanPicker] = React.useState(undefined)
      const [modelDialog, setModelDialog] = React.useState(false)
      React.useEffect(() => {
        if (snoozeUntil === 0) return undefined
        const delay = Math.max(0, snoozeUntil - Date.now())
        const timer = window.setTimeout(() => {
          runtime.current.tab.snoozeUntil = 0
          setSnoozeUntil(0)
        }, delay + 25)
        return () => window.clearTimeout(timer)
      }, [snoozeUntil])
      const [createRequest, setCreateRequest] = React.useState(undefined)
      const [catalog, setCatalog] = React.useState(undefined)
      const [tabMenu, setTabMenu] = React.useState(undefined)
  // The output panel mirrors a classic output panel: "Trajectory" explains every
  // completion request, "Chat" shows the exact prompt and answer.
  const [panel, setPanel] = React.useState(undefined)
  const [panelHeight, setPanelHeight] = React.useState(190)
  const [trace, setTrace] = React.useState([])
  const [replayHint, setReplayHint] = React.useState(undefined)
  const showChat = preferences === undefined || preferences.showChat !== false
      const [quick, setQuick] = React.useState(undefined)
      const [picker, setPicker] = React.useState(undefined)
      const [dialog, setDialog] = React.useState(undefined)
      const [cursor, setCursor] = React.useState({ line: 1, column: 1 })
      const [consent, setConsent] = React.useState(undefined)
      const [menuId, setMenuId] = React.useState('')
      const [prompt, setPrompt] = React.useState(undefined)
      const [info, setInfo] = React.useState(undefined)
      const [reloadSignal, setReloadSignal] = React.useState(0)
      const [fontSize, setFontSize] = React.useState(compact || coarsePointer ? 16 : 13)
      const [wordWrap, setWordWrap] = React.useState(compact)
      const [booted, setBooted] = React.useState(false)
      const [dragOver, setDragOver] = React.useState('')
      const [quotePrompt, setQuotePrompt] = React.useState(undefined)
      const [inlineView, setInlineView] = React.useState(undefined)
      const inlineInputRef = React.useRef(undefined)
      const [selected, setSelected] = React.useState(undefined)
      const [menuSheetOpen, setMenuSheetOpen] = React.useState(false)
      // A deliberate wrap choice outlives an orientation change; the compact
      // default only applies while the user has not picked one.
      const wrapTouched = React.useRef(false)
      // The same rule for the text size: a phone starts at 16px, but a size the
      // user picked by hand survives an orientation change.
      const zoomTouched = React.useRef(false)
      const fontSizeRef = React.useRef(fontSize)
      fontSizeRef.current = fontSize
      // One place that moves the text size: the View menu, the status-bar
      // stepper, a two-finger pinch and the keyboard commands all end up here.
      const bumpFont = (delta) => {
        zoomTouched.current = true
        setFontSize((current) => Math.min(28, Math.max(9, Math.round(current + delta))))
      }
      const resetFont = () => {
        zoomTouched.current = false
        setFontSize(compactRef.current || coarseRef.current ? 16 : 13)
      }
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

      // Turning the chat off must not leave the panel on a tab it no longer shows.
      // While it is on, the panel is permanent: closed means the setting is off.
      React.useEffect(() => {
        if (!booted) return
        if (showChat) {
          setPanel((current) => (current === undefined ? { tab: 'chat', index: 0 } : current))
          return
        }
        setPanel(undefined)
      }, [showChat, booted])

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
          const payload = await call('open', { sessionId: scope, path: normalized, encoding: options?.encoding })
          const entry = {
            key: payload.id,
            path: normalized,
            name: baseName(normalized),
            hostId: payload.id,
            token: payload.token,
            text: payload.text,
            language: payload.language,
            eol: payload.eol,
            encoding: payload.encoding ?? 'utf8',
            languageOverride: undefined,
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
        if (kind === 'plan') {
          runtime.current.planDraft = { text: draft, path, from, to, title: `${path}:${from}–${to}` }
        }
        setStatus({ kind: 'ok', message: 'Черновик запроса в поле ввода — проверьте и отправьте сами.' })
        return true
      }

      /** Save the plan draft last put into the composer; nothing is sent. */
      const savePlanDraft = async () => {
        const draft = runtime.current.planDraft
        if (draft === undefined) {
          setStatus({ kind: 'error', message: 'Сначала нажмите «Подготовить план…»' })
          return false
        }
        try {
          const saved = await call('planSave', {
            sessionId,
            title: draft.title,
            text: draft.text,
            path: draft.path,
            from: draft.from,
            to: draft.to,
          })
          setStatus({ kind: 'ok', message: `План сохранён: ${saved.title}` })
          return true
        } catch (cause) {
          setStatus({ kind: 'error', message: messageOf(cause) })
          return false
        }
      }

      /** Sessions that already hold a retained client binding and can take a draft. */
      const planTargets = () => {
        try {
          const ctx = services.ctx
          const sessions = typeof ctx.get === 'function' ? ctx.get('sessions') : undefined
          if (sessions === undefined || sessions === null) return []
          const snapshot = sessions.list.getSnapshot()
          const ids = Array.isArray(snapshot?.ids) ? snapshot.ids : []
          return ids
            .filter((id) => id !== sessionId)
            .filter((id) => sessions.binding(id) !== undefined)
            .map((id) => ({ id, title: snapshot.byId?.[id]?.displayTitle ?? id }))
        } catch {
          return []
        }
      }


      const openSavedPlan = async (id) => {
        const actions = props && props.inputActions
        if (!actions || typeof actions.insertText !== 'function') {
          setStatus({ kind: 'error', message: 'Чат недоступен в этой панели' })
          return false
        }
        try {
          const plan = await call('planRead', { sessionId, id })
          const span = typeof actions.captureInsertion === 'function' ? actions.captureInsertion() : undefined
          actions.insertText(plan.text, span)
          setPlansOpen(false)
          setStatus({ kind: 'ok', message: `План открыт: ${plan.title}` })
          return true
        } catch (cause) {
          setStatus({ kind: 'error', message: messageOf(cause) })
          return false
        }
      }

      /**
       * Hand a saved plan to another retained session. The DSH client exposes
       * draft initialization only for a retained binding, so the picker lists
       * sessions that are already open; no text is sent and the target
       * session's existing draft is preserved.
       */
      const transferSavedPlan = async (plan, targetId) => {
        const ctx = services.ctx
        let sessions
        let conversation
        let workspace
        try {
          sessions = typeof ctx.get === 'function' ? ctx.get('sessions') : undefined
          conversation = typeof ctx.get === 'function' ? ctx.get('conversation') : undefined
          workspace = typeof ctx.get === 'function' ? ctx.get('uiWorkspace') : undefined
        } catch {
          sessions = undefined
        }
        const binding = sessions && typeof sessions.binding === 'function' ? sessions.binding(targetId) : undefined
        if (binding === undefined || binding === null || !conversation || !conversation.input) {
          setStatus({ kind: 'error', message: 'Эта сессия ещё не открыта — откройте её и повторите' })
          return false
        }
        try {
          const outcome = conversation.input.requestDraftInitialization(binding, {
            prompt: plan.text,
            whenDraftExists: 'preserve',
          })
          if (outcome === 'applied') {
            if (workspace && typeof workspace.openSession === 'function') workspace.openSession(targetId)
            setPlanPicker(undefined)
            setStatus({ kind: 'ok', message: `План передан: ${plan.title}` })
            return true
          }
          setStatus({
            kind: 'error',
            message: outcome === 'preserved'
              ? 'В целевой сессии уже есть черновик — план не передан'
              : 'Целевая сессия занята — план не передан',
          })
          return false
        } catch (cause) {
          setStatus({ kind: 'error', message: messageOf(cause) })
          return false
        }
      }

      const openConversationSession = (sessionId) => {
        let workspace
        try {
          workspace = services.ctx.get('uiWorkspace')
        } catch {
          workspace = undefined
        }
        if (!workspace || typeof workspace.openSession !== 'function') {
          setStatus({ kind: 'error', message: 'Не удалось открыть сессию: рабочая область недоступна' })
          return false
        }
        workspace.openSession(sessionId)
        setConvSearchOpen(false)
        setStatus({ kind: 'ok', message: 'Открываю сессию с найденным фрагментом' })
        return true
      }

      // Fetch exactly one turn from another conversation and show its size
      // before anything reaches the composer. The whole conversation is never
      // attached, and the model stays untouched.
      const attachConversation = async (item) => {
        if (!item || typeof item.sessionId !== 'string' || item.sessionId === '' || !Number.isInteger(item.seq)) {
          setStatus({ kind: 'error', message: 'У этого фрагмента нет номера хода' })
          return false
        }
        setStatus({ kind: 'busy', message: 'Читаю выбранный ход…' })
        try {
          const payload = await call('sessionExcerpt', {
            sessionId: stateRef.current.sessionId,
            target: item.sessionId,
            seq: item.seq,
          })
          if (payload.error) {
            setStatus({ kind: 'error', message: payload.error.message ?? 'Не удалось прочитать разговор' })
            return false
          }
          setConvSource({ ...payload, title: payload.title || item.title || item.sessionId })
          setConvSearchOpen(false)
          setStatus(undefined)
          return true
        } catch (cause) {
          setStatus({ kind: 'error', message: messageOf(cause) })
          return false
        }
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
            eol: target.eol,
            encoding: target.encoding,
          })
          setTabs((previous) => previous.map((candidate) => (candidate.key === key ? { ...candidate, token: payload.token, dirty: false } : candidate)))
          setChanges((previous) => previous.map((change) => (change.path === target.path ? { ...change, saved: true } : change)))
          setStatus({ kind: 'ok', message: `Сохранено: ${target.name}` })
          // A save is also a worktree change: the Git panel must not keep
          // showing the previous bytes as if the file were still dirty.
          setScmReload((value) => value + 1)
          return true
        } catch (cause) {
          setStatus({ kind: 'error', message: describeError(cause) })
          return false
        }
      }

      // ------------------------------------------------------ status pickers
      //
      // Language / EOL / encoding pickers driven from the status bar. The
      // language is view-only (it never marks the tab dirty); switching the EOL
      // or the save encoding changes what the next save writes, so it does;
      // reopening in another encoding needs a clean tab because the buffer is
      // re-read from disk.
      const closePicker = () => setPicker(undefined)

      const pickLanguage = (entry, picked) => {
        closePicker()
        const languageId = picked.id === 'auto' ? entry.language || 'plaintext' : picked.id
        const model = runtime.current.models.get(entry.key)
        if (model !== undefined && monaco !== undefined) monaco.editor.setModelLanguage(model, languageId)
        setTabs((previous) =>
          previous.map((candidate) =>
            candidate.key === entry.key
              ? { ...candidate, languageOverride: picked.id === 'auto' ? undefined : picked.id }
              : candidate,
          ),
        )
      }

      const pickEol = (entry, eol) => {
        closePicker()
        if (entry.eol === eol) return
        setTabs((previous) => previous.map((candidate) => (candidate.key === entry.key ? { ...candidate, eol, dirty: true } : candidate)))
        setStatus({
          kind: 'idle',
          message: eol === 'crlf' ? 'Конец строк: CRLF — применится при сохранении' : 'Конец строк: LF — применится при сохранении',
        })
      }

      const pickEncoding = (entry, encodingId, mode) => {
        closePicker()
        const spec = ENCODING_OPTIONS.find((candidate) => candidate.id === encodingId)
        if (spec === undefined) return
        if (mode === 'save' && spec.writable === true) {
          setTabs((previous) =>
            previous.map((candidate) =>
              candidate.key === entry.key && candidate.encoding !== encodingId ? { ...candidate, encoding: encodingId, dirty: true } : candidate,
            ),
          )
          setStatus({ kind: 'idle', message: `Кодировка сохранения: ${spec.label}` })
          return
        }
        if (entry.dirty) {
          setStatus({ kind: 'error', message: 'Сначала сохраните изменения — файл будет переоткрыт в новой кодировке.' })
          return
        }
        const path = entry.path
        // The buffer is re-read from disk in the chosen encoding: the old tab
        // and its model must go, or openFile would only re-activate it. A save
        // pick of a non-writable encoding lands here too — there is no
        // byte-level write on the file seam, so reopening is all it can mean.
        removeTab(entry.key)
        void openFile(path, { activate: true, encoding: encodingId }).then(() => {
          setStatus({
            kind: 'idle',
            message:
              mode === 'save'
                ? `${spec.label}: запись недоступна — файл переоткрыт в этой кодировке, сохранение будет в UTF-8.`
                : `Открыто в кодировке ${spec.label}`,
          })
        })
      }

      const pickerEntries = (kind, mode, entry) => {
        if (kind === 'language') {
          const items = [{ id: 'auto', label: menuText('Автоматическое обнаружение', 'Auto detect') }]
          if (monaco !== undefined) {
            const languages = monaco.languages
              .getLanguages()
              .map((candidate) => ({
                id: candidate.id,
                label: candidate.aliases !== undefined && candidate.aliases.length > 0 ? candidate.aliases[0] : candidate.id,
                badge:
                  candidate.extensions !== undefined && candidate.extensions.length > 0
                    ? candidate.extensions[0]
                    : LANG_BADGE_BY_ID[candidate.id],
              }))
            languages.sort((left, right) => left.label.localeCompare(right.label, 'ru'))
            items.push(...languages)
          }
          return items
        }
        if (kind === 'eol') {
          return [
            { id: 'lf', label: 'LF', detail: menuText('перевод строки (Unix)', 'line feed (Unix)') },
            {
              id: 'crlf',
              label: 'CRLF',
              detail: menuText('возврат каретки и перевод строки (Windows)', 'carriage return and line feed (Windows)'),
            },
          ]
        }
        return ENCODING_OPTIONS.map((candidate) => ({
          id: candidate.id,
          label: candidate.label,
          detail: candidate.writable ? undefined : menuText('только открытие', 'open only'),
          disabled: mode === 'save' && candidate.writable !== true,
        }))
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
        // Sync the ref immediately: an openFile() call later in the same tick
        // (reopening with another encoding) must not see the removed tab and
        // "re-activate" a key that no longer exists — the file would just close.
        stateRef.current.tabs = next
        if (removing.has(active)) {
          const index = current.findIndex((candidate) => candidate.key === active)
          if (next.length === 0) {
            setActiveKey('')
            stateRef.current.activeKey = ''
          } else {
            const fallback = (next[Math.min(Math.max(index, 0), next.length - 1)] || next[0]).key
            setActiveKey(fallback)
            stateRef.current.activeKey = fallback
          }
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

      // A request that is still running keeps one row in the list and only
      // refreshes its elapsed time; the row id survives other traces arriving
      // above it, so a late answer cannot overwrite a newer request.
      const updateTrace = React.useCallback((id, patch) => {
        setTrace((current) => current.map((row) => (row.id === id ? { ...row, ...patch } : row)))
      }, [])

      const toggleOutput = React.useCallback(() => {
        // The chat is a permanent part of the IDE while its setting is on:
        // closing it is the setting's job, not a keystroke's.
        if (prefsRef.current?.showChat !== false) {
          setPanel({ tab: 'chat', index: 0 })
          return
        }
        setPanel((current) => (current === undefined ? { tab: 'trajectory', index: 0 } : undefined))
      }, [])

      // ---------------------------------------------------------------------
      // Tab suggestions
      //
      // The Host does the reasoning: it asks the model, plans a concrete edit
      // (an insertion or a small replacement) and filters it through the
      // bad-case checks ported from the reference editor's `cppBadHeuristics`. The client only
      // draws that plan, records whether it was accepted or rejected, and keeps
      // the histories those checks need. See docs/reference-editor-tab-mechanics.md.
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

      // A replacement hides text that the suggestion rewrites. The reference editor paints
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
              diagnostics:
                monaco?.editor?.getModelMarkers === undefined
                  ? undefined
                  : diagnosticContext(monaco.editor.getModelMarkers({ resource: model.uri }), position),
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
            // request says why, an automatic one stays quiet like a classic editor.
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
        setCrossFile(
          crossFileCandidate(
            stateRef.current.tabs,
            tabKey,
            operations.map((operation) => operation.text).join('\n'),
            textBefore,
          ),
        )
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
        // The reference editor remembers what the user threw away and refuses to offer it again
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

      const clearInlineTraceTimer = (st) => {
        if (st !== undefined && st.traceTimer !== undefined) {
          clearInterval(st.traceTimer)
          st.traceTimer = undefined
        }
      }

      const settleInlineTrace = (st, patch) => {
        clearInlineTraceTimer(st)
        if (st === undefined || st.traceSettled === true || typeof st.traceId !== 'string') return
        st.traceSettled = true
        updateTrace(st.traceId, { pending: false, ...patch })
      }

      // Inline Edit is a model request too: it gets a live row in the same
      // Trajectory list, with the clock ticking until the answer arrives.
      const startInlineTrace = (st, requestId) => {
        const startedAt = performance.now()
        const traceId = `inline-${requestId}`
        st.traceId = traceId
        st.traceStartedAt = startedAt
        pushTrace({
          id: traceId,
          at: new Date().toLocaleTimeString('ru-RU'),
          path: st.path,
          provider: '—',
          model: '—',
          explicit: true,
          kind: 'inline-edit',
          pending: true,
          before: st.oldText.length,
          after: 0,
          durationMs: 0,
          chars: 0,
          ok: false,
          reason: 'Модель думает…',
        })
        st.traceTimer = setInterval(() => {
          if (runtime.current.inlineEdit !== st) {
            clearInlineTraceTimer(st)
            return
          }
          updateTrace(traceId, { durationMs: Math.round(performance.now() - startedAt) })
        }, 100)
      }

      const publishInline = () => {
        const st = inlineState()
        setInlineView(
          st === undefined
            ? undefined
            : {
                phase: st.phase,
                key: st.key,
                instruction: st.instruction,
                history: st.history === undefined ? 0 : st.history.length,
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
        if (st.phase === 'pending') {
          settleInlineTrace(st, {
            durationMs: Math.round(performance.now() - st.traceStartedAt),
            reason: 'Отменено',
          })
        } else {
          clearInlineTraceTimer(st)
        }
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
        let selection = editor.getSelection()
        if (selection === null || selection.isEmpty()) {
          // The menu click collapsed the live selection (common with touch
          // selection handles). Restore the last one for this exact model state.
          const remembered = runtime.current.lastSelection
          if (
            remembered !== undefined
            && remembered.key === key
            && remembered.modelVersion === model.getVersionId()
            && remembered.end > remembered.start
          ) {
            const from = model.getPositionAt(remembered.start)
            const to = model.getPositionAt(remembered.end)
            editor.setSelection({
              startLineNumber: from.lineNumber,
              startColumn: from.column,
              endLineNumber: to.lineNumber,
              endColumn: to.column,
            })
            selection = editor.getSelection()
          }
        }
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
          path: entry.path,
          hostId: entry.hostId,
          token: entry.token,
          modelVersion: model.getVersionId(),
          start,
          end,
          oldText: text.slice(start, end),
          text,
          instruction: '',
          history: [],
          error: '',
          controller: undefined,
          decorations: undefined,
          zone: undefined,
          traceId: undefined,
          traceTimer: undefined,
          traceStartedAt: 0,
          traceSettled: false,
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
        startInlineTrace(st, requestId)
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
              history: st.history !== undefined && st.history.length > 0 ? st.history : undefined,
            },
            controller.signal,
          )
          if (inlineState() !== st || st.requestId !== requestId) return
          st.controller = undefined
          st.proposal = payload.proposal
          st.provider = typeof payload.provider === 'string' ? payload.provider : '—'
          st.model = typeof payload.model === 'string' ? payload.model : '—'
          const nextText = payload.proposal?.changes?.[0]?.newText
          // The next refinement is sent with the exchange it refers to. An empty
          // replacement still needs a non-empty answer, so keep the JSON shape.
          st.history = [
            ...(st.history ?? []),
            {
              instruction,
              answer: typeof nextText === 'string' && nextText !== '' ? nextText : '{"replacement":""}',
            },
          ].slice(-4)
          st.phase = 'preview'
          const change = payload.proposal?.changes?.[0]
          const replacement = change !== undefined && typeof change.newText === 'string' ? change.newText : ''
          const removedText = change !== undefined && typeof change.oldText === 'string' ? change.oldText : st.oldText
          const hint = change === undefined
            ? undefined
            : {
                path: st.path,
                kind: removedText === '' ? 'insert' : 'replace',
                range: { start: change.start, end: change.end },
                removedText,
                insertText: replacement,
                modelVersion: st.modelVersion,
              }
          // Older Host builds do not send the inline conversation; keep the
          // Chat tab useful with the same instruction/fragment/replacement
          // while the full transcript is unavailable.
          const conversation = payload.conversation !== undefined
            ? payload.conversation
            : prefsRef.current?.fullTrace === true
              ? {
                  system: 'Правка выделения',
                  message: `Задача: ${st.instruction}\n\n--- фрагмент ---\n${st.oldText}`,
                  answer: replacement,
                }
              : undefined
          st.conversation = conversation
          settleInlineTrace(st, {
            ok: true,
            provider: typeof payload.provider === 'string' ? payload.provider : '—',
            model: typeof payload.model === 'string' ? payload.model : '—',
            durationMs: Number.isFinite(Number(payload.durationMs))
              ? Number(payload.durationMs)
              : Math.round(performance.now() - st.traceStartedAt),
            before: st.oldText.length,
            after: replacement.length,
            chars: replacement.length,
            reason: '',
            hint,
            conversation,
          })
          paintInlinePreview()
          publishInline()
        } catch (cause) {
          if (inlineState() !== st || st.requestId !== requestId) return
          st.controller = undefined
          const cancelled = cause?.name === 'AbortError' || cause?.code === 'cancelled'
          if (cancelled) st.phase = 'input'
          else {
            st.phase = 'failed'
            st.error = describeError(cause)
          }
          settleInlineTrace(st, {
            ok: false,
            durationMs: Math.round(performance.now() - st.traceStartedAt),
            reason: cancelled ? 'Отменено' : describeError(cause),
          })
          publishInline()
        }
      }

      const refineInlineEdit = () => {
        const st = inlineState()
        if (st === undefined) return
        if (st.phase === 'pending') {
          settleInlineTrace(st, {
            durationMs: Math.round(performance.now() - st.traceStartedAt),
            reason: 'Отменено',
          })
        }
        clearInlineDecorations()
        st.controller?.abort()
        st.controller = undefined
        st.proposal = undefined
        st.phase = 'input'
        st.error = ''
        publishInline()
        window.setTimeout(() => {
          inlineInputRef.current?.focus()
          inlineInputRef.current?.select?.()
        }, 0)
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
        const firstLine = startPosition.lineNumber
        const addedLines = Math.max(1, String(change.newText).split('\n').length)
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
        runtime.current.attribution = [
          ...runtime.current.attribution,
          {
            path: st.path,
            startLine: firstLine,
            endLine: firstLine + addedLines - 1,
            provider: st.provider ?? '—',
            model: st.model ?? '—',
            instruction: st.instruction,
            at: Date.now(),
            conversation: st.conversation,
          },
        ].slice(-50)
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
        const activePath = stateRef.current.tabs.find((candidate) => candidate.key === stateRef.current.activeKey)?.path
        if (kind !== 'explicit' && kind !== 'refetch' && tabExtensionDisabled(prefsRef.current, activePath)) return
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
        // Keep the plan's own coordinates so a trajectory click can draw the
        // same hint again without asking the model. Only the cursor block is
        // replayed; other edits in the reply are not applied by a replay.
        const hintKey = runtime.current.modelTabs.get(model.uri.toString())
        const hintPath = stateRef.current.tabs.find((candidate) => candidate.key === hintKey)?.path || ''
        pushTrace({
          ...result.trace,
          ok: true,
          displayMs: Math.round(performance.now() - triggerAt),
          hint: hintPath === ''
            ? undefined
            : {
                path: hintPath,
                kind: plan.kind,
                range: plan.range,
                removedText: plan.removedText,
                insertText: plan.insertText,
                modelVersion: plan.modelVersion,
              },
        })
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

      const snoozeTab = (ms) => {
        const until = Date.now() + ms
        runtime.current.tab.snoozeUntil = until
        setSnoozeUntil(until)
        cancelGhostRequest()
        clearGhost()
        setStatus({ kind: 'ok', message: `Tab на паузе до ${snoozeLabel(until)} — автоподсказки не запрашиваются` })
      }

      const toggleSplit = () => {
        if (splitKey !== '') {
          setSplitKey('')
          return
        }
        const other = splitCandidate(stateRef.current.tabs, stateRef.current.activeKey)
        if (other === undefined) {
          setStatus({ kind: 'error', message: 'Откройте второй файл, чтобы разделить редактор' })
          return
        }
        setSplitKey(other.key)
      }

      const runProjectTests = async () => {
        if (testsView?.phase === 'running') return
        const controller = new AbortController()
        testsAbort.current = controller
        setTestsView({ phase: 'running' })
        try {
          const result = await call('runTests', { sessionId }, controller.signal)
          setTestsView({ phase: 'ready', result })
        } catch (cause) {
          setTestsView({ phase: 'failed', error: describeError(cause) })
        } finally {
          if (testsAbort.current === controller) testsAbort.current = undefined
        }
      }

      const stopProjectTests = () => {
        testsAbort.current?.abort()
        testsAbort.current = undefined
      }

      const startRename = () => {
        const editor = runtime.current.editor
        const model = editor === undefined ? null : editor.getModel()
        const position = editor === undefined ? null : editor.getPosition()
        if (model === null || position === null) {
          setStatus('Поставьте курсор на имя символа')
          return
        }
        const word = wordAt(model.getValue(), model.getOffsetAt(position))
        if (word === '') {
          setStatus('Под курсором нет имени')
          return
        }
        setRenameView({ word, next: word, plan: undefined })
      }

      const applyRename = () => {
        const plan = renameView?.plan
        if (plan === undefined || plan.ok !== true) return
        const replacement = new Map(plan.files.map((file) => [file.key, file.text]))
        setTabs((previous) =>
          previous.map((tab) =>
            replacement.has(tab.key) ? { ...tab, text: replacement.get(tab.key), dirty: true } : tab,
          ),
        )
        for (const [uri, key] of runtime.current.modelTabs) {
          const model = runtime.current.models.get(uri)
          if (model !== undefined && replacement.has(key)) model.setValue(replacement.get(key))
        }
        setRenameView(undefined)
        setStatus({ kind: 'ok', message: `Переименовано: ${plan.total} в ${plan.files.length} файл(ах). Сохраните вручную.` })
      }

      const findSymbol = () => {
        const editor = runtime.current.editor
        const model = editor === undefined ? null : editor.getModel()
        const position = editor === undefined ? null : editor.getPosition()
        if (model === null || position === null) {
          setStatus('Поставьте курсор в файл с кодом')
          return
        }
        const word = wordAt(model.getValue(), model.getOffsetAt(position))
        if (word === '') {
          setStatus('Под курсором нет имени')
          return
        }
        const rows = symbolReferences(stateRef.current.tabs, word)
        if (rows.length === 0) {
          setStatus(`«${word}» не найдено в открытых файлах`)
          return
        }
        setSymbolView({ word, rows })
      }

      const openBlame = () => {
        const editor = runtime.current.editor
        const model = editor === undefined ? null : editor.getModel()
        const position = editor === undefined ? null : editor.getPosition()
        const tab = stateRef.current.tabs.find((candidate) => candidate.key === stateRef.current.activeKey)
        if (model === null || position === null || tab === undefined) {
          setStatus('Поставьте курсор в открытый файл')
          return
        }
        const line = position.lineNumber
        setBlameView({
          path: tab.path,
          line,
          records: lineAttribution(runtime.current.attribution, tab.path, line),
        })
      }

      const openSideChat = () => {
        const editor = runtime.current.editor
        const model = editor === undefined ? null : editor.getModel()
        const selection = editor === undefined ? null : editor.getSelection()
        const tab = stateRef.current.tabs.find((candidate) => candidate.key === stateRef.current.activeKey)
        if (model === null || selection === null || selection.isEmpty() || tab === undefined) {
          setStatus('Выделите фрагмент в открытом файле')
          return
        }
        if (typeof tab.hostId !== 'string') {
          setStatus('Файл ещё не открыт в Host — побочный вопрос недоступен')
          return
        }
        setSideChat({
          id: tab.hostId,
          path: normalPath(tab.path),
          start: model.getOffsetAt(selection.getStartPosition()),
          end: model.getOffsetAt(selection.getEndPosition()),
          text: model.getValueInRange(selection),
        })
      }

      const askSideChat = (request) =>
        call('sideChat', {
          id: request.id,
          sessionId: stateRef.current.sessionId,
          start: request.start,
          end: request.end,
          selection: request.selection,
          question: request.question,
          history: request.history,
        })

      const captureNote = () => {
        const editor = runtime.current.editor
        const model = editor === undefined ? null : editor.getModel()
        const selection = editor === undefined ? null : editor.getSelection()
        const tab = stateRef.current.tabs.find((candidate) => candidate.key === stateRef.current.activeKey)
        if (model === null || selection === null || tab === undefined) {
          setStatus('Откройте файл и поставьте курсор или выделение')
          return undefined
        }
        const empty = selection.isEmpty()
        const text = (empty ? model.getLineContent(selection.getPosition().lineNumber) : model.getValueInRange(selection))
          .replace(/\s+/g, ' ')
          .trim()
        if (text === '') {
          setStatus('Нечего добавить: строка пуста')
          return undefined
        }
        return {
          text: text.slice(0, NOTE_MAX_CHARS),
          path: tab.path,
          line: selection.getStartPosition().lineNumber,
        }
      }

      const tourCursor = () => {
        const editor = runtime.current.editor
        const tab = stateRef.current.tabs.find((candidate) => candidate.key === stateRef.current.activeKey)
        const position = editor === undefined || editor === null ? null : editor.getPosition()
        if (tab === undefined || position === null || position === undefined) return undefined
        return { path: tab.path, line: position.lineNumber }
      }

      const addTourStep = (note) => {
        const cursor = tourCursor()
        if (cursor === undefined) {
          setStatus('Откройте файл и поставьте курсор на нужную строку')
          return
        }
        setTourSteps((previous) => {
          const next = tourAdd(previous, { ...cursor, note })
          return next
        })
      }

      const jumpTour = (step, at) => {
        runtime.current.pendingReveal = { path: normalPath(step.path), line: step.line }
        setTourIndex(at)
        void openFile(step.path, { activate: true })
      }

      const splitTab = splitKey === '' ? undefined : tabs.find((candidate) => candidate.key === splitKey)

      React.useEffect(() => {
        if (splitKey !== '' && !tabs.some((candidate) => candidate.key === splitKey)) setSplitKey('')
      }, [tabs, splitKey])

      const markTabDirty = (key) => {
        setTabs((previous) =>
          previous.map((candidate) => (candidate.key === key && !candidate.dirty ? { ...candidate, dirty: true } : candidate)),
        )
      }

      const resumeTab = () => {
        runtime.current.tab.snoozeUntil = 0
        setSnoozeUntil(0)
        setStatus({ kind: 'ok', message: 'Автоподсказки Tab снова включены' })
      }

      const toggleTabExtension = async () => {
        const active = stateRef.current.tabs.find((candidate) => candidate.key === stateRef.current.activeKey)
        const extension = active === undefined ? '' : fileExtension(active.path)
        if (extension === '') {
          setStatus({ kind: 'error', message: 'У файла нет расширения — отключать нечего' })
          return
        }
        const current = Array.isArray(prefsRef.current?.tabDisabledExtensions) ? prefsRef.current.tabDisabledExtensions : []
        const wasDisabled = current.includes(extension)
        const next = wasDisabled ? current.filter((entry) => entry !== extension) : [...current, extension]
        await saveSettings({ tabDisabledExtensions: next })
        setStatus({
          kind: 'ok',
          message: wasDisabled ? `Tab для .${extension} снова включён` : `Автоподсказки Tab для .${extension} выключены`,
        })
      }

      const askModeOn = preferences?.askMode === true

      const toggleAskMode = async () => {
        const next = !askModeOn
        try {
          await saveSettings({ askMode: next })
          setStatus({ kind: 'ok', message: next ? 'Режим вопросов: запись в рабочую папку запрещена' : 'Режим вопросов выключен — запись снова разрешена' })
        } catch (cause) {
          setStatus({ kind: 'error', message: describeError(cause) })
        }
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

      // Pointer events cover the mouse, the pen and the finger; the handle also
      // needs `touch-action:none` in the stylesheet or the pane scrolls instead.
      const beginPanelResize = (event) => {
        event.preventDefault()
        const startY = event.clientY
        const startHeight = panelHeight
        const move = (moveEvent) => {
          const ceiling = compactRef.current ? 420 : 560
          const next = Math.min(ceiling, Math.max(90, startHeight - (moveEvent.clientY - startY)))
          setPanelHeight(next)
        }
        const finish = () => {
          window.removeEventListener('pointermove', move)
          window.removeEventListener('pointerup', finish)
          window.removeEventListener('pointercancel', finish)
          document.body.style.cursor = ''
        }
        window.addEventListener('pointermove', move)
        window.addEventListener('pointerup', finish)
        window.addEventListener('pointercancel', finish)
        document.body.style.cursor = 'row-resize'
      }

      const openSettings = () => {
        if (compactRef.current) setShowTree(false)
        setSettingsOpen(true)
      }

      const openQuick = () => {
        // Both overlays make the drawer pointless: close it before the modal
        // appears so the editor is visible again when the picker is dismissed.
        if (compactRef.current) {
          setShowTree(false)
          setMenuSheetOpen(false)
        }
        if (quick !== undefined && quick.loading !== true) {
          setQuick({ files: quick.files, loading: false, error: quick.error })
          return
        }
        setQuick({ files: [], loading: true })
        call('files', { sessionId: stateRef.current.sessionId, hidden, limit: QUICK_OPEN_LIMIT })
          .then((payload) => setQuick({ files: Array.isArray(payload.files) ? payload.files : [], loading: false }))
          .catch((cause) => setQuick({ files: [], loading: false, error: describeError(cause) }))
      }

      // Monaco is loaded once per pane; a failure is reported to the fallback
      // view, which keeps the file readable even when the editor is missing.
      React.useEffect(() => {
        let cancelled = false
        setEditorFailure(null)
        loadMonaco()
          .then((instance) => {
            if (!cancelled) setMonaco(instance)
          })
          .catch((cause) => {
            if (cancelled) return
            const message = messageOf(cause)
            setEditorFailure(message)
            setStatus({ kind: 'error', message })
          })
        return () => {
          cancelled = true
        }
      }, [editorAttempt])

      React.useEffect(() => {
        if (!monaco || !hostRef.current || runtime.current.editor) return
        // A phone editor is read more than it is scrolled: bigger glyphs, roomy
        // lines, wrapped text and fat scrollbars that a thumb can actually hit.
        const compactNow = compactRef.current
        let editor
        try {
          editor = monaco.editor.create(hostRef.current, {
            model: null,
            automaticLayout: true,
            theme: themeName() === 'dark' ? 'vs-dark' : 'vs',
            fontSize,
            // On a phone the line box grows with the glyphs, otherwise a big font
            // would overlap the next line.
            lineHeight: compactNow ? Math.round(fontSize * 1.5) : 20,
            minimap: { enabled: false },
            tabSize: 2,
            insertSpaces: true,
            scrollBeyondLastLine: false,
            wordBasedSuggestions: 'off',
            renderLineHighlight: 'line',
            smoothScrolling: true,
            wordWrap: wordWrap ? 'on' : 'off',
            stickyScroll: { enabled: !compactNow },
            scrollbar: {
              verticalScrollbarSize: compactNow ? 14 : 10,
              horizontalScrollbarSize: compactNow ? 14 : 10,
              useShadows: false,
            },
            mouseWheelZoom: false,
            padding: { top: compactNow ? 4 : 8, bottom: 24 },
            inlineSuggest: { enabled: true },
            glyphMargin: true,
          })
        } catch (cause) {
          const message = messageOf(cause)
          setEditorFailure(message)
          setStatus({ kind: 'error', message })
          return undefined
        }
        runtime.current.editor = editor
        setEditorReady(true)
        runtime.current.monaco = monaco

        const hintButton = document.createElement('button')
        hintButton.type = 'button'
        hintButton.className = 'dsh-ide-hint-button'
        let hintStartedAt = 0
        let hintTimerHandle = 0
        const stopHintTimer = () => {
          if (hintTimerHandle !== 0) clearInterval(hintTimerHandle)
          hintTimerHandle = 0
        }
        const showHintElapsed = (ms) => {
          const element = hintElapsedRef.current
          if (!element) return
          element.hidden = false
          element.textContent = `ИИ думает: ${ms} мс`
        }
        const hideHintElapsed = () => {
          const element = hintElapsedRef.current
          if (!element) return
          element.hidden = true
          element.textContent = ''
        }
        const setHintBusy = (busy) => {
          stopHintTimer()
          hintButton.textContent = busy ? '' : '💡'
          if (busy) {
            hintStartedAt = performance.now()
            showHintElapsed(0)
            const tick = () => {
              showHintElapsed(Math.max(0, Math.round(performance.now() - hintStartedAt)))
            }
            tick()
            hintTimerHandle = setInterval(tick, 100)
          } else {
            hideHintElapsed()
          }
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
        // Remember every non-empty selection. On a touch device the selection
        // handles live in the page, and opening a menu can collapse the model
        // selection before the command fires.
        const selectionChange = typeof editor.onDidChangeCursorSelection === 'function'
          ? editor.onDidChangeCursorSelection(() => {
              const selection = editor.getSelection()
              const model = editor.getModel()
              if (selection === null || model === null || selection.isEmpty()) return
              const key = runtime.current.modelTabs.get(model.uri.toString())
              if (key === undefined) return
              runtime.current.lastSelection = {
                key,
                start: model.getOffsetAt(selection.getStartPosition()),
                end: model.getOffsetAt(selection.getEndPosition()),
                modelVersion: model.getVersionId(),
              }
            })
          : undefined

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
        // Same shortcuts a desktop editor uses for its own text size.
        editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Equal, () => bumpFont(1))
        editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Minus, () => bumpFont(-1))
        editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Digit0, () => resetFont())
        // Inline Edit. The chord comes from the keymap (Ctrl+Shift+K by default,
        // remappable in settings); the action only puts the command in Monaco's
        // own context menu.
        editor.addAction({
          id: 'dsh-ide.inline-edit',
          label: menuText('Изменить выделение…', 'Edit selection…'),
          contextMenuGroupId: '1_modification',
          contextMenuOrder: 1,
          // No `editorTextFocus` guard: on touch the editor loses focus while
          // the context menu is open, and the command itself checks the target.
          run: () => handlersRef.current.openInlineEdit?.(),
        })
        // Link the active file and the lines highlighted in it into the chat.
        // An action, not a bare command: the same declaration draws the entry in
        // Monaco's own context menu; the chord is dispatched from the keymap.
        editor.addAction({
          id: 'dsh-ide.add-to-chat',
          label: menuText('Добавить в чат', 'Add to chat'),
          contextMenuGroupId: '1_modification',
          contextMenuOrder: 0.5,
          run: () => handlersRef.current.addToChat?.(),
        })

        return () => {
          cancelGhostRequest()
          clearInlineTraceTimer(runtime.current.inlineEdit)
          runtime.current.inlineEdit?.controller?.abort()
          window.clearTimeout(cursorTimer)
          modelChange.dispose()
          if (hintLine) editor.removeGlyphMarginWidget(hintWidget)
          stopHintTimer()
          hideHintElapsed()
          runtime.current.setHintBusy = undefined
          blur.dispose()
          change.dispose()
          cursorChange.dispose()
          selectionChange?.dispose()
          editor.dispose()
          runtime.current.editor = undefined
        }
      }, [monaco])

      // Font size and word wrap live in state, so both the compact defaults and
      // a manual zoom reach Monaco through the same update.
      React.useEffect(() => {
        const editor = runtime.current.editor
        if (editor === undefined) return
        editor.updateOptions({ fontSize, lineHeight: compact ? Math.round(fontSize * 1.5) : 20 })
      }, [fontSize, compact])

      React.useEffect(() => {
        const editor = runtime.current.editor
        if (editor !== undefined) editor.updateOptions({ wordWrap: wordWrap ? 'on' : 'off' })
      }, [wordWrap])

      React.useEffect(() => {
        if (!wrapTouched.current) setWordWrap(compact)
      }, [compact])

      // Follow the layout default until the user picks a size by hand.
      React.useEffect(() => {
        if (!zoomTouched.current) setFontSize(compact || coarsePointer ? 16 : 13)
      }, [compact, coarsePointer])

      React.useEffect(() => {
        const editor = runtime.current.editor
        if (editor === undefined) return
        editor.updateOptions({
          lineHeight: compact ? Math.round(fontSize * 1.5) : 20,
          stickyScroll: { enabled: !compact },
          scrollbar: {
            verticalScrollbarSize: compact ? 14 : 10,
            horizontalScrollbarSize: compact ? 14 : 10,
            useShadows: false,
          },
          padding: { top: compact ? 4 : 8, bottom: 24 },
        })
      }, [compact])

      // The on-screen keyboard shrinks the visible area without resizing the
      // pane. On a phone, lay the editor out again and keep the caret in view.
      React.useEffect(() => {
        if (!compact) return undefined
        if (typeof window === 'undefined' || window.visualViewport === undefined || window.visualViewport === null) {
          return undefined
        }
        const viewport = window.visualViewport
        if (typeof viewport.addEventListener !== 'function') return undefined
        const reflow = () => {
          const editor = runtime.current.editor
          if (editor === undefined) return
          editor.layout()
          const position = editor.getPosition()
          if (position !== null) editor.revealPositionInCenterIfOutsideViewport(position)
        }
        viewport.addEventListener('resize', reflow)
        return () => viewport.removeEventListener('resize', reflow)
      }, [compact])

      // Two fingers over the code resize the text, like every other mobile
      // editor. The browser's own page zoom is suppressed while a pinch runs so
      // the gesture changes the code, not the whole app.
      React.useEffect(() => {
        if (!compact && !coarsePointer) return undefined
        const host = hostRef.current
        if (host === null || typeof host.addEventListener !== 'function') return undefined
        let startDistance = 0
        let startSize = 0
        const spread = (touches) =>
          Math.hypot(touches[0].clientX - touches[1].clientX, touches[0].clientY - touches[1].clientY)
        const begin = (event) => {
          if (event.touches.length !== 2) return
          startDistance = spread(event.touches)
          startSize = fontSizeRef.current
        }
        const move = (event) => {
          if (event.touches.length !== 2 || startDistance <= 0) return
          // Fingers that start a pixel apart would turn the smallest wobble into
          // a huge jump; ignore such a pinch instead of guessing.
          if (startDistance < 16) return
          event.preventDefault()
          const next = Math.min(28, Math.max(9, Math.round(startSize * (spread(event.touches) / startDistance))))
          if (next !== fontSizeRef.current) bumpFont(next - fontSizeRef.current)
        }
        const end = () => {
          startDistance = 0
        }
        host.addEventListener('touchstart', begin, { passive: true })
        host.addEventListener('touchmove', move, { passive: false })
        host.addEventListener('touchend', end)
        host.addEventListener('touchcancel', end)
        return () => {
          host.removeEventListener('touchstart', begin)
          host.removeEventListener('touchmove', move)
          host.removeEventListener('touchend', end)
          host.removeEventListener('touchcancel', end)
        }
      }, [compact, coarsePointer])

      // Neither the dropdown menus nor the phone sheet survive a layout change:
      // they were positioned for the width that just went away.
      React.useEffect(() => {
        if (compact) {
          setMenuId('')
        } else {
          setMenuSheetOpen(false)
        }
      }, [compact])

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
        editor.focus()
        setEditorReady(true)
        // A model that lost the payload would paint an empty pane; surface it
        // through the fallback instead of leaving the file unreadable.
        if (model.getValue() === '' && entry.text !== '') {
          setEditorFailure('Редактор получил пустой текст файла.')
        }
      }, [activeKey, monaco])

      // A trajectory row keeps the plan it described. Clicking it opens that
      // file and draws the same block again; it never asks the model. The text
      // must still match the recorded removed fragment, or the hint would sit
      // over code it no longer describes.
      React.useEffect(() => {
        if (replayHint === undefined) return
        const editor = runtime.current.editor
        const model = editor?.getModel()
        if (!editor || !model) return
        if (runtime.current.modelTabs.get(model.uri.toString()) !== replayHint.key) return
        const hint = replayHint
        setReplayHint(undefined)
        clearGhost()
        if (model.getValue().slice(hint.range.start, hint.range.end) !== hint.removedText) {
          setStatus({ kind: 'error', message: 'Файл изменился — подсказка из траектории больше не подходит.' })
          return
        }
        const plan = {
          // `decorateRemoved` only marks a real replacement; an empty removed
          // fragment is a plain insertion.
          kind: hint.removedText === '' ? 'insert' : 'replace',
          range: hint.range,
          removedText: hint.removedText,
          insertText: hint.insertText,
          edits: [],
          modelVersion: model.getVersionId(),
        }
        runtime.current.tab.plan = plan
        runtime.current.tab.accepted = 0
        decorateRemoved(plan, model)
        const start = model.getPositionAt(plan.range.start)
        editor.setPosition(start)
        editor.revealPositionInCenterIfOutsideViewport(start)
        if (plan.insertText !== '') {
          showGhost(start, plan.insertText, model.getPositionAt(plan.range.end))
        } else {
          clearGhostPreview()
        }
        // "Принять правку" from the trajectory menu opens the file and asks
        // for the same plan to be applied immediately. The text check above
        // still protects a stale record; Tab and this path share one code path.
        if (hint.accept === true) acceptGhost()
      }, [replayHint, activeKey])

      // A hint belongs to the turn that was on screen when it was requested.
      // As soon as that session starts a new turn, and again when the turn
      // settles, the old ghost must go: otherwise it floats over a file while
      // the model is already answering something else.
      React.useEffect(() => {
        const sessionService = services.uiSession
          || (services.ctx && typeof services.ctx.get === 'function' ? services.ctx.get('uiSession') : undefined)
        const status = sessionService && sessionService.sessionStatus
        if (!status || typeof status.getSnapshot !== 'function' || typeof status.subscribe !== 'function') return undefined
        let previous
        const read = () => {
          const current = status.getSnapshot().get(sessionId)
          const running = current === undefined ? undefined : current.running
          if (running === true || (previous === true && running === false)) {
            cancelGhostRequest()
            clearGhost()
            runtime.current.setHintBusy?.(false)
          }
          previous = running
        }
        read()
        return status.subscribe(read)
      }, [sessionId, clearGhost])

      // A phone either paints the editor quickly or not at all. If the stage
      // stays empty for a few seconds while a file is open, show the text.
      React.useEffect(() => {
        const open = tabs.some((candidate) => candidate.key === activeKey)
        if (!open || editorReady || editorFailure !== null) {
          setEditorSlow(false)
          return undefined
        }
        const timer = window.setTimeout(() => setEditorSlow(true), 4000)
        return () => window.clearTimeout(timer)
      }, [activeKey, tabs, editorReady, editorFailure])

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
        // Only one comparison owns the stage: opening the assistant review
        // closes a Git comparison and the other way round.
        setScmDiff(undefined)
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

      // ---------------------------------------------------------- git panel

      // One status read at a time: the abort is what keeps a slow answer from a
      // superseded session or a superseded request out of the panel.
      const refreshScm = async () => {
        if (typeof sessionId !== 'string' || sessionId === '') return
        const ticket = (scmSeq.current += 1)
        scmAbort.current?.abort()
        const controller = new AbortController()
        scmAbort.current = controller
        setScmLoading(true)
        try {
          const snapshot = await call('scmStatus', { sessionId }, controller.signal)
          if (ticket !== scmSeq.current || controller.signal.aborted) return
          setScmStatus(snapshot)
          setScmError('')
        } catch (cause) {
          if (ticket !== scmSeq.current || controller.signal.aborted || cause?.code === 'cancelled') return
          setScmStatus(undefined)
          setScmError(describeScmError(cause))
        } finally {
          if (ticket === scmSeq.current) setScmLoading(false)
        }
      }

      React.useEffect(() => {
        // A pane keeps no state of another session: the snapshot, the open
        // comparison, the draft and a late answer all belong to one session.
        scmDiffSeq.current += 1
        scmAbort.current?.abort()
        scmSeq.current += 1
        setScmStatus(undefined)
        setScmDiff(undefined)
        setScmError('')
        setScmBusy('')
        setScmMessage('')
        setScmLoading(false)
      }, [sessionId])

      React.useEffect(() => {
        if (explorerMode !== 'scm' || typeof sessionId !== 'string' || sessionId === '') return undefined
        const timer = window.setTimeout(() => {
          void refreshScm()
        }, 150)
        return () => {
          window.clearTimeout(timer)
          scmAbort.current?.abort()
        }
        // The function reads the current session; only these three things ask
        // for a new snapshot.
      }, [explorerMode, sessionId, scmReload])

      React.useEffect(() => {
        if (explorerMode !== 'scm') return undefined
        const onFocus = () => {
          void refreshScm()
        }
        window.addEventListener('focus', onFocus)
        return () => window.removeEventListener('focus', onFocus)
      }, [explorerMode, sessionId])

      React.useEffect(
        () => () => {
          scmAbort.current?.abort()
        },
        [],
      )

      const stageScm = async (row) => {
        if (scmBusy !== '' || scmStatus === undefined || row === undefined) return
        setScmBusy(row.key)
        setScmError('')
        try {
          const payload = await call('scmStage', {
            sessionId,
            group: row.group,
            path: row.path,
            revision: scmStatus.revision,
            token: row.entry.token,
          })
          scmAbort.current?.abort()
          scmSeq.current += 1
          setScmLoading(false)
          setScmStatus(payload.status)
        } catch (cause) {
          setScmError(describeScmError(cause))
          if (cause?.code === 'stale' || cause?.code === 'locked') setScmReload((value) => value + 1)
        } finally {
          setScmBusy('')
        }
      }

      const unstageScm = async (row) => {
        if (scmBusy !== '' || scmStatus === undefined || row === undefined) return
        setScmBusy(row.key)
        setScmError('')
        try {
          const payload = await call('scmUnstage', {
            sessionId,
            group: row.group,
            path: row.path,
            revision: scmStatus.revision,
          })
          scmAbort.current?.abort()
          scmSeq.current += 1
          setScmLoading(false)
          setScmStatus(payload.status)
        } catch (cause) {
          setScmError(describeScmError(cause))
          if (cause?.code === 'stale' || cause?.code === 'locked') setScmReload((value) => value + 1)
        } finally {
          setScmBusy('')
        }
      }

      const commitScm = async () => {
        const message = scmMessage.trim()
        if (scmBusy !== '' || scmStatus === undefined || message === '') return
        setScmBusy('commit')
        setScmError('')
        try {
          const payload = await call('scmCommit', { sessionId, message, revision: scmStatus.revision })
          scmAbort.current?.abort()
          scmSeq.current += 1
          setScmLoading(false)
          setScmStatus(payload.status)
          setScmMessage('')
          setScmReload((value) => value + 1)
          setStatus({ kind: 'ok', message: `Зафиксировано: ${String(payload.head ?? '').slice(0, 7)}` })
        } catch (cause) {
          setScmError(describeScmError(cause))
          if (cause?.code === 'stale' || cause?.code === 'locked') setScmReload((value) => value + 1)
        } finally {
          setScmBusy('')
        }
      }

      const openScmRow = async (row) => {
        if (scmStatus === undefined || row === undefined) return
        setDiffView(undefined)
        if (compactRef.current) setShowTree(false)
        const seq = (scmDiffSeq.current += 1)
        setScmDiff({ phase: 'pending', source: 'git', seq, group: row.group, path: row.path })
        try {
          const payload = await call('scmDiff', {
            sessionId,
            group: row.group,
            path: row.path,
            revision: scmStatus.revision,
          })
          if (seq !== scmDiffSeq.current) return
          setScmDiff({ ...payload.diff, phase: 'ready', source: 'git', seq })
        } catch (cause) {
          if (seq !== scmDiffSeq.current || cause?.code === 'cancelled') return
          setScmDiff({ phase: 'failed', source: 'git', seq, group: row.group, path: row.path, beforeLabel: '', afterLabel: '', error: describeScmError(cause) })
          if (cause?.code === 'stale') setScmReload((value) => value + 1)
        }
      }

      const openScmCommitFile = async (commit, file) => {
        if (commit === undefined || file === undefined) return
        setDiffView(undefined)
        if (compactRef.current) setShowTree(false)
        const seq = (scmDiffSeq.current += 1)
        setScmDiff({ phase: 'pending', source: 'git', seq, group: 'commit', path: file.path, oid: commit.oid })
        try {
          const payload = await call('scmCommitDiff', {
            sessionId,
            oid: commit.oid,
            base: commit.base,
            path: file.path,
          })
          if (seq !== scmDiffSeq.current) return
          setScmDiff({ ...payload.diff, phase: 'ready', source: 'git', seq })
        } catch (cause) {
          if (seq !== scmDiffSeq.current || cause?.code === 'cancelled') return
          setScmDiff({ phase: 'failed', source: 'git', seq, group: 'commit', path: file.path, error: describeScmError(cause) })
        }
      }

      // The exact `git diff` of one group or one file, inserted into the chat
      // draft as a quote. The Host bounds the payload; the status line shows the
      // size before the user sends it, and nothing is sent automatically.
      const sendScmPatch = async (group, path) => {
        if (scmPatching || scmStatus === undefined) return
        if (group !== 'staged' && group !== 'changes') return
        setScmPatching(true)
        try {
          const payload = await call('scmPatch', {
            sessionId,
            group,
            ...(typeof path === 'string' && path !== '' ? { path } : {}),
            revision: scmStatus.revision,
          })
          const where = group === 'staged' ? 'индекс' : 'рабочая копия'
          const label = `Git diff · ${where}${typeof path === 'string' && path !== '' ? ` · ${path}` : ''}`
          const bytes = Number.isFinite(payload?.bytes) ? payload.bytes : 0
          insertQuote(
            `${label}\n\n\`\`\`diff\n${String(payload?.patch ?? '')}\n\`\`\`\n`,
            `${label} · ${Math.max(1, Math.round(bytes / 1024))} КиБ`,
          )
        } catch (cause) {
          setStatus({ kind: 'error', message: describeScmError(cause) })
          if (cause?.code === 'stale') setScmReload((value) => value + 1)
        } finally {
          setScmPatching(false)
        }
      }

      const openScmFinding = (finding) => {
        if (finding === undefined || finding === null || scmStatus === undefined) return
        if (typeof finding.path !== 'string' || finding.path === '') return
        const line = Number.isSafeInteger(finding.line) ? finding.line : 1
        scmReveal.current = { path: finding.path, line }
        void openScmRow({ group: 'staged', path: finding.path })
      }

      const jumpDiff = (direction) => {
        const info = runtime.current.diffEditor
        if (info === undefined || info === null) return
        const changes = typeof info.editor.getLineChanges === 'function' ? info.editor.getLineChanges() : undefined
        if (!Array.isArray(changes) || changes.length === 0) return
        const modified = info.editor.getModifiedEditor()
        if (modified === undefined) return
        const line = modified.getPosition()?.lineNumber ?? 1
        let target
        if (direction === 'next') {
          target = changes.find((change) => change.modifiedStartLineNumber > line) ?? changes[0]
        } else {
          const earlier = changes.filter((change) => change.modifiedStartLineNumber < line)
          target = earlier.length > 0 ? earlier[earlier.length - 1] : changes[changes.length - 1]
        }
        if (target === undefined) return
        modified.revealLineInCenter(target.modifiedStartLineNumber)
        modified.setPosition({ lineNumber: target.modifiedStartLineNumber, column: 1 })
        modified.focus()
      }

      // The explorer pane is far too narrow for two columns, so the comparison
      // opens over the editor the way the reference editor shows a change before accepting it.
      // A Git comparison takes precedence; both shells share this one editor.
      const activeDiff = scmDiff !== undefined ? scmDiff : diffView
      const diffKey =
        activeDiff === undefined
          ? ''
          : scmDiff !== undefined
            ? `git:${scmDiff.phase}:${scmDiff.seq}:${scmDiff.group}:${scmDiff.path}`
            : `agent:${diffView.phase}:${diffView.seq}:${diffView.index}`
      const diffUid = scmDiff !== undefined ? `git-${scmDiff.seq}` : `agent-${diffView?.seq}-${diffView?.index}`
      React.useEffect(() => {
        const container = diffContainerRef.current
        const view = activeDiff
        const textual = view !== undefined && (view.kind === undefined || view.kind === 'text')
        if (!monaco || view === undefined || view.phase !== 'ready' || !textual || container === undefined) return undefined
        const language = typeof view.language === 'string' && view.language !== '' ? view.language : 'plaintext'
        const original = monaco.editor.createModel(
          String(view.before ?? ''),
          language,
          monaco.Uri.parse(`inmemory://dsh-ide/diff-before/${diffUid}`),
        )
        const modified = monaco.editor.createModel(
          String(view.after ?? ''),
          language,
          monaco.Uri.parse(`inmemory://dsh-ide/diff-after/${diffUid}`),
        )
        const editor = monaco.editor.createDiffEditor(container, {
          readOnly: true,
          renderSideBySide: !compact,
          // A docked pane can be desktop-sized while the stage left for the
          // diff is narrow (the change list takes its own column). Let Monaco
          // fall back to the unified view by width, not by device class.
          useInlineViewWhenSpaceIsLimited: true,
          renderSideBySideInlineBreakpoint: 900,
          wordWrap: 'on',
          diffWordWrap: 'on',
          renderOverviewRuler: true,
          overviewRulerBorder: false,
          renderIndicators: true,
          automaticLayout: true,
          ignoreTrimWhitespace: false,
          scrollBeyondLastLine: false,
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
      }, [monaco, diffKey, compact])

      // A review finding points at a line of the patch that was actually sent.
      // Once that comparison is ready, reveal the line in its modified side and
      // drop the request, so an ordinary later diff does not jump anywhere.
      React.useEffect(() => {
        const pending = scmReveal.current
        if (pending === undefined || scmDiff === undefined || scmDiff.phase !== 'ready' || scmDiff.path !== pending.path) return
        const info = runtime.current.diffEditor
        if (info === undefined || info === null) return
        const modified = info.editor.getModifiedEditor()
        const model = modified?.getModel?.()
        if (modified === undefined || model === null || model === undefined) return
        scmReveal.current = undefined
        const line = Math.max(1, Math.min(pending.line, model.getLineCount()))
        modified.revealLineInCenter(line)
        modified.setPosition({ lineNumber: line, column: 1 })
        modified.focus()
      }, [scmDiff])

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
      }, [activeKey, tabs, symbolView, testsView, revealNonce])

      // The outline follows the live buffer: it re-runs on a tab switch and on
      // every edit, debounced like the file search, and the previous request is
      // aborted so a slow parse cannot answer a file the user already left.
      React.useEffect(() => {
        if (!structureOpen) return undefined
        const entry = tabs.find((candidate) => candidate.key === activeKey)
        if (entry === undefined) {
          setStructure({ phase: 'idle', language: '', symbols: [], error: '' })
          return undefined
        }
        const editor = runtime.current.editor
        if (editor === undefined) return undefined
        const controller = new AbortController()
        let timer = 0
        const run = () => {
          const model = editor.getModel()
          if (model === null || runtime.current.modelTabs.get(model.uri.toString()) !== entry.key) return
          const text = model.getValue()
          if (text === '') {
            // `empty` keeps the panel from calling an empty JS file unsupported.
            setStructure({ phase: 'ready', language: 'empty', symbols: [], error: '' })
            return
          }
          setStructure((previous) => ({ ...previous, phase: 'pending', error: '' }))
          void call('structure', { sessionId, path: entry.path, text }, controller.signal)
            .then((payload) => {
              if (controller.signal.aborted) return
              setStructure({
                phase: 'ready',
                language: typeof payload?.language === 'string' ? payload.language : '',
                symbols: Array.isArray(payload?.symbols) ? payload.symbols : [],
                error: '',
              })
            })
            .catch((cause) => {
              if (controller.signal.aborted) return
              if (cause !== null && typeof cause === 'object' && cause.code === 'cancelled') return
              setStructure({ phase: 'failed', language: '', symbols: [], error: describeError(cause) })
            })
        }
        timer = window.setTimeout(run, 300)
        const content = editor.onDidChangeModelContent(() => {
          window.clearTimeout(timer)
          timer = window.setTimeout(run, 300)
        })
        const swap = editor.onDidChangeModel(() => {
          window.clearTimeout(timer)
          timer = window.setTimeout(run, 0)
        })
        return () => {
          window.clearTimeout(timer)
          content.dispose()
          swap.dispose()
          controller.abort()
        }
      }, [structureOpen, activeKey, sessionId])

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
            // Remember the text size the user picked; a size equal to the
            // layout default stays adaptable to the next orientation change.
            if (typeof saved.fontSize === 'number') {
              const restored = Math.min(28, Math.max(9, Math.round(saved.fontSize)))
              setFontSize(restored)
              if (restored !== (compactRef.current || coarseRef.current ? 16 : 13)) zoomTouched.current = true
            }
            if (saved.explorerSide === 'right') setExplorerSide('right')
            setShowTree(saved.showTree !== false)
            setHidden(saved.hidden === true)
            if (loaded.showChat !== false) setPanel({ tab: 'chat', index: 0 })
            if (saved.ptyOpen === true) {
              setPtyOpen(true)
              setPanel({ tab: 'pty', index: 0 })
            }
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
            // On a phone a restored file should be visible straight away, not
            // hidden behind the explorer drawer.
            if (activated && compactRef.current) setShowTree(false)
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
              fontSize,
              ptyOpen,
            },
          }).catch(() => {})
        }, STATE_WRITE_DELAY_MS)
        return () => window.clearTimeout(timer)
      }, [booted, sessionId, tabsKey, activeKey, explorerWidth, panelHeight, showTree, hidden, explorerSide, fontSize, ptyOpen])

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
          window.removeEventListener('pointermove', move)
          window.removeEventListener('pointerup', stop)
          window.removeEventListener('pointercancel', stop)
          document.body.style.cursor = ''
        }
        window.addEventListener('pointermove', move)
        window.addEventListener('pointerup', stop)
        window.addEventListener('pointercancel', stop)
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
        openOutput: () => setPanel({ tab: showChat ? 'chat' : 'trajectory', index: 0 }),
        openSettings,
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
        if (delta === 0) return
        bumpFont(delta)
      }

      const toggleWordWrap = () => {
        wrapTouched.current = true
        setWordWrap(!wordWrap)
      }

      // Creating a file or a folder starts an inline row inside the explorer,
      // the way a classic editor does it: the name is typed in place, not in a dialog.
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

      // Menu labels follow the live keymap: a remapped chord must not keep the
      // old default printed next to the command.
      const menuChords = resolveKeymap(keybindingsOf(preferences))
      const chordLabel = (commandId) => {
        const chord = menuChords.get(commandId)
        return chord === undefined ? undefined : chordText(chord)
      }

      const selectPanelTab = (tab) => setPanel((current) => ({ tab, index: current?.index ?? 0 }))
      const openTerminal = () => {
        setPtyOpen(true)
        selectPanelTab('pty')
      }
      const toolTabs = [
        ptyOpen && { id: 'pty', label: menuText('Терминал', 'Terminal'), body: h(PtyPanel, {
              sessionId: stateRef.current.sessionId,
              call,
              height: panelHeight,
            }) },
        plansOpen && { id: 'plans', label: menuText('Планы', 'Plans'), body: h(PlansPanel, {
              sessionId: stateRef.current.sessionId,
              onClose: () => setPlansOpen(false),
              onOpen: (id) => void openSavedPlan(id),
              onTransfer: (plan) => {
                setPlansOpen(false)
                setPlanPicker(plan)
              },
            }) },
        terminalOpen && { id: 'terminal', label: menuText('Терминал', 'Terminal'), body: h(TerminalContextPanel, {
              onClose: () => setTerminalOpen(false),
              onInsert: (text) => insertQuote(text, 'Запуск терминала'),
            }) },
        debugOpen && { id: 'debug', label: menuText('Журнал отладки', 'Debug journal'), body: h(DebugPanel, {
              onClose: () => setDebugOpen(false),
              onInsert: (text) => insertQuote(text, menuText('Журнал отладки', 'Debug journal')),
            }) },
        notesPackOpen && { id: 'notesPack', label: menuText('Пакет заметок', 'Note bundle'), body: h(NotesPackPanel, {
              onClose: () => setNotesPackOpen(false),
              onInsert: (text) => insertQuote(text, menuText('Пакет заметок', 'Note bundle')),
              onCapture: captureNote,
            }) },
        tourOpen && { id: 'tour', label: menuText('Экскурсия по коду', 'Code tour'), body: h(CodeTourPanel, {
              steps: tourSteps,
              index: tourIndex,
              onClose: () => setTourOpen(false),
              onAdd: addTourStep,
              onMove: (at, delta) => setTourSteps((previous) => tourMove(previous, at, delta)),
              onRemove: (at) => setTourSteps((previous) => tourRemove(previous, at)),
              onJump: jumpTour,
              onPrev: () => {
                const at = Math.max(0, tourIndex - 1)
                if (tourSteps[at] !== undefined) jumpTour(tourSteps[at], at)
              },
              onNext: () => {
                const at = Math.min(tourSteps.length - 1, tourIndex + 1)
                if (tourSteps[at] !== undefined) jumpTour(tourSteps[at], at)
              },
            }) },
        worktreesOpen && { id: 'worktrees', label: menuText('Рабочие копии', 'Worktrees'), body: h(WorktreesPanel, {
              sessionId,
              call,
              onClose: () => setWorktreesOpen(false),
            }) },
      ].filter(Boolean)

      const menuActiveTab = tabs.find((candidate) => candidate.key === activeKey)
      const menuExtension = menuActiveTab === undefined ? '' : fileExtension(menuActiveTab.path)
      const menuExtensionOff = menuActiveTab !== undefined && tabExtensionDisabled(preferences, menuActiveTab.path)
      const menus = [
        {
          id: 'file',
          label: menuText('Файл', 'File'),
          items: [
            { id: 'new', label: menuText('Новый файл…', 'New file…'), run: () => createFile() },
            { id: 'new-folder', label: menuText('Новая папка…', 'New folder…'), run: () => createDirectory() },
            { id: 'open', label: menuText('Открыть файл…', 'Open file…'), key: chordLabel('quick-open'), run: openQuick },
            { separator: true },
            { id: 'save', label: menuText('Сохранить', 'Save'), key: chordLabel('save'), run: () => void saveActive() },
            { id: 'save-all', label: menuText('Сохранить всё', 'Save all'), key: chordLabel('save-all'), run: () => void saveAll() },
            { separator: true },
            { id: 'close', label: menuText('Закрыть вкладку', 'Close tab'), key: chordLabel('close-tab'), run: closeActive },
            { id: 'close-all', label: menuText('Закрыть все вкладки', 'Close all tabs'), run: closeAllTabs },
            { separator: true },
            { id: 'settings', label: menuText('Настройки IDE…', 'IDE settings…'), key: chordLabel('settings'), run: openSettings },
          ],
        },
        {
          id: 'edit',
          label: menuText('Правка', 'Edit'),
          items: [
            { id: 'undo', label: menuText('Отменить', 'Undo'), key: 'Ctrl+Z', run: () => runAction('undo') },
            { id: 'redo', label: menuText('Повторить', 'Redo'), key: 'Ctrl+Y', run: () => runAction('redo') },
            { separator: true },
            { id: 'cut', label: menuText('Вырезать', 'Cut'), key: 'Ctrl+X', run: () => runAction('editor.action.clipboardCutAction') },
            { id: 'copy', label: menuText('Копировать', 'Copy'), key: 'Ctrl+C', run: () => runAction('editor.action.clipboardCopyAction') },
            { id: 'paste', label: menuText('Вставить', 'Paste'), key: 'Ctrl+V', run: () => runAction('editor.action.clipboardPasteAction') },
            { separator: true },
            { id: 'find', label: menuText('Найти', 'Find'), key: 'Ctrl+F', run: () => runAction('actions.find') },
            { id: 'replace', label: menuText('Заменить', 'Replace'), key: 'Ctrl+H', run: () => runAction('editor.action.startFindReplaceAction') },
            { separator: true },
            { id: 'inline-edit', label: menuText('Изменить выделение…', 'Edit selection…'), key: chordLabel('inline-edit'), run: () => handlersRef.current.openInlineEdit?.() },
            {
              id: 'rename-symbol',
              label: menuText('Переименовать символ…', 'Rename symbol…'),
              disabled: tabs.length === 0,
              run: startRename,
            },
            { separator: true },
            { id: 'select-all', label: menuText('Выделить всё', 'Select all'), key: 'Ctrl+A', run: () => runAction('editor.action.selectAll') },
            { id: 'select-line', label: menuText('Выделить строку', 'Select line'), run: () => runAction('expandLineSelection') },
            { separator: true },
            { id: 'expand', label: menuText('Расширить выделение', 'Expand selection'), key: 'Shift+Alt+→', run: () => runAction('editor.action.smartSelect.expand') },
            { id: 'shrink', label: menuText('Сузить выделение', 'Shrink selection'), key: 'Shift+Alt+←', run: () => runAction('editor.action.smartSelect.shrink') },
          ],
        },
        {
          id: 'view',
          label: menuText('Вид', 'View'),
          items: [
            { id: 'palette', label: menuText('Палитра команд…', 'Command palette…'), key: chordLabel('command-palette'), run: () => setPaletteOpen(true) },
            { separator: true },
            { id: 'refresh', label: menuText('Обновить дерево', 'Refresh explorer'), run: () => setReloadSignal((previous) => previous + 1) },
            { id: 'toggle-tree', label: showTree ? menuText('Скрыть проводник', 'Hide explorer') : menuText('Показать проводник', 'Show explorer'), run: () => setShowTree(!showTree) },
            {
              id: 'swap-explorer',
              label: explorerSide === 'left' ? menuText('Проводник справа', 'Move explorer right') : menuText('Проводник слева', 'Move explorer left'),
              run: () => setExplorerSide(explorerSide === 'left' ? 'right' : 'left'),
            },
            { id: 'hidden', label: hidden ? menuText('Скрыть скрытые файлы', 'Hide hidden files') : menuText('Показывать скрытые файлы', 'Show hidden files'), run: () => setHidden(!hidden) },
            { separator: true },
            {
              id: 'split-editor',
              label: splitKey === '' ? menuText('Разделить редактор', 'Split editor') : menuText('Закрыть вторую панель', 'Close split editor'),
              disabled: compact || (splitKey === '' && tabs.length < 2),
              run: toggleSplit,
            },
            {
              id: 'output',
              label: showChat ? menuText('Перейти в чат', 'Show chat') : panel === undefined ? menuText('Показать панель вывода', 'Show output panel') : menuText('Скрыть панель вывода', 'Hide output panel'),
              key: chordLabel('output'),
              run: toggleOutput,
            },
            { id: 'pty', label: menuText('Терминал', 'Terminal'), run: openTerminal },
            { separator: true },
            { id: 'word-wrap', label: wordWrap ? menuText('Отключить перенос по словам', 'Disable word wrap') : menuText('Включить перенос по словам', 'Enable word wrap'), run: toggleWordWrap },
            { id: 'zoom-in', label: menuText('Увеличить шрифт', 'Increase font size'), key: 'Ctrl+=', run: () => zoom(1) },
            { id: 'zoom-out', label: menuText('Уменьшить шрифт', 'Decrease font size'), key: 'Ctrl+-', run: () => zoom(-1) },
            { id: 'zoom-reset', label: menuText('Сбросить размер шрифта', 'Reset font size'), key: 'Ctrl+0', run: resetFont },
          ],
        },
        {
          id: 'go',
          label: menuText('Переход', 'Go'),
          items: [
            { id: 'goto-line', label: menuText('Перейти к строке…', 'Go to line…'), key: 'Ctrl+G', run: () => runAction('editor.action.gotoLine') },
            { separator: true },
            {
              id: 'file-start',
              label: menuText('В начало файла', 'Go to start of file'),
              key: 'Ctrl+Home',
              run: () => withEditor((editor) => editor.setPosition({ lineNumber: 1, column: 1 })),
            },
            {
              id: 'file-end',
              label: menuText('В конец файла', 'Go to end of file'),
              key: 'Ctrl+End',
              run: () =>
                withEditor((editor) => {
                  const model = editor.getModel()
                  if (model === undefined) return
                  const lineNumber = model.getLineCount()
                  editor.setPosition({ lineNumber, column: model.getLineMaxColumn(lineNumber) })
                }),
            },
            {
              id: 'find-symbol',
              label: menuText('Символ под курсором', 'Symbol at cursor'),
              disabled: tabs.length === 0,
              run: findSymbol,
            },
            { separator: true },
            { id: 'next-tab', label: menuText('Следующая вкладка', 'Next tab'), key: 'Ctrl+Tab', run: () => cycleTab(1) },
            { id: 'prev-tab', label: menuText('Предыдущая вкладка', 'Previous tab'), key: 'Ctrl+Shift+Tab', run: () => cycleTab(-1) },
          ],
        },
        {
          id: 'chat',
          label: menuText('Чат', 'Chat'),
          items: [
            { id: 'add-to-chat', label: menuText('Файл в чат', 'Add file to chat'), key: chordLabel('add-to-chat'), run: () => handlersRef.current.addToChat?.() },
            { id: 'quote', label: menuText('Строки в чат', 'Quote lines in chat'), key: chordLabel('quote'), run: () => handlersRef.current.quoteSelection?.() },
            { id: 'explain', label: menuText('Объяснить выделенное…', 'Explain selection…'), run: () => draftQuestion('explain') },
            {
              id: 'side-chat',
              label: menuText('Побочный вопрос по выделению…', 'Ask about selection…'),
              run: openSideChat,
            },
            { separator: true },
            {
              id: 'ask-mode',
              label: askModeOn ? menuText('Выключить режим вопросов', 'Disable read-only questions') : menuText('Режим вопросов (без записи)', 'Enable read-only questions'),
              run: toggleAskMode,
            },
            {
              id: 'explore-project',
              label: menuText('Спросить о проекте…', 'Ask about project…'),
              run: () => setExploreOpen(true),
            },
            {
              id: 'conversation-search',
              label: menuText('Найти в разговорах…', 'Search conversations…'),
              run: () => setConvSearchOpen(true),
            },
            { separator: true },
            { id: 'prepare-plan', label: menuText('Подготовить план…', 'Prepare plan…'), run: () => draftQuestion('plan') },
            { id: 'save-plan', label: menuText('Сохранить план…', 'Save plan…'), run: () => void savePlanDraft() },
            { id: 'open-plans', label: menuText('Открыть сохранённый план…', 'Open saved plan…'), run: () => { setPlansOpen(true); selectPanelTab('plans') } },
            {
              id: 'notes-pack',
              label: menuText('Пакет заметок…', 'Note bundle…'),
              run: () => { setNotesPackOpen(true); selectPanelTab('notesPack') },
            },
          ],
        },
        {
          id: 'project',
          label: menuText('Проект', 'Project'),
          items: [
            {
              id: 'worktrees',
              label: menuText('Рабочие копии…', 'Worktrees…'),
              run: () => { setWorktreesOpen(true); selectPanelTab('worktrees') },
            },
            {
              id: 'blame-line',
              label: menuText('Происхождение строки…', 'Line history…'),
              disabled: tabs.length === 0,
              run: openBlame,
            },
            { separator: true },
            {
              id: 'code-tour',
              label: menuText('Экскурсия по коду…', 'Code tour…'),
              run: () => { setTourOpen(true); selectPanelTab('tour') },
            },
            { separator: true },
            {
              id: 'run-tests',
              label: menuText('Запустить тесты (npm test)…', 'Run tests (npm test)…'),
              run: runProjectTests,
            },
            { id: 'terminal-context', label: menuText('Запуск терминала в чат…', 'Add terminal run to chat…'), run: () => { setTerminalOpen(true); selectPanelTab('terminal') } },
            {
              id: 'debug-journal',
              label: menuText('Журнал отладки…', 'Debug journal…'),
              run: () => { setDebugOpen(true); selectPanelTab('debug') },
            },
          ],
        },
        {
          id: 'completion',
          label: menuText('Подсказки', 'Suggestions'),
          items: [
            { id: 'connect-model', label: menuText('Подключить модель…', 'Connect model…'), run: () => setModelDialog(true) },
            { separator: true },
            { id: 'snooze-15', label: menuText('Приостановить подсказки на 15 минут', 'Pause suggestions for 15 minutes'), run: () => snoozeTab(15 * 60 * 1000) },
            { id: 'snooze-60', label: menuText('Приостановить подсказки на 1 час', 'Pause suggestions for 1 hour'), run: () => snoozeTab(60 * 60 * 1000) },
            { id: 'snooze-resume', label: menuText('Возобновить подсказки', 'Resume suggestions'), disabled: snoozeUntil === 0, run: resumeTab },
            {
              id: 'tab-extension',
              label:
                menuExtension === ''
                  ? menuText('Подсказки по расширению', 'Suggestions by extension')
                  : menuText(`${menuExtensionOff ? 'Включить' : 'Отключить'} подсказки для .${menuExtension}`, `${menuExtensionOff ? 'Enable' : 'Disable'} suggestions for .${menuExtension}`),
              disabled: menuExtension === '',
              run: () => void toggleTabExtension(),
            },
          ],
        },
        {
          id: 'help',
          label: menuText('Справка', 'Help'),
          items: [
            {
              id: 'about',
              label: menuText('О плагине IDE', 'About the IDE'),
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
              label: menuText('Горячие клавиши', 'Keyboard shortcuts'),
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
                setInfo({ title: menuText('Горячие клавиши', 'Keyboard shortcuts'), lines })
              },
            },
          ],
        },
      ]

      const replayRow = (row, accept) => {
        const index = Math.max(0, trace.indexOf(row))
        // Keep the trajectory visible: a replay is something the user may want
        // to compare across several rows, and switching to Chat hid the list.
        setPanel((current) => ({ tab: current === undefined ? 'trajectory' : current.tab, index }))
        if (row === undefined || row.hint === undefined) return
        void openFile(row.hint.path, { activate: true }).then((entry) => {
          if (entry !== undefined) setReplayHint({ ...row.hint, key: entry.key, accept })
        })
      }
      const replayTrace = (index, accept = false) => replayRow(trace[index], accept)

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
              ? { id: 'save', label: menuText('Сохранить', 'Save'), run: () => void saveKey(tabMenuTarget.key) }
              : null,
            { id: 'close', label: menuText('Закрыть', 'Close'), run: () => closeTab(tabMenuTarget.key) },
            { id: 'close-others', label: menuText('Закрыть другие', 'Close others'), run: () => closeOtherTabs(tabMenuTarget.key) },
            { id: 'close-all', label: menuText('Закрыть все', 'Close all'), run: () => closeAllTabs() },
            { separator: true },
            { id: 'copy-path', label: menuText('Копировать путь', 'Copy path'), run: () => void copyText(tabMenuTarget.path) },
          ].filter(Boolean)

      return h(
        'div',
        {
          ref: rootRef,
          className: 'dsh-ide-root',
          'data-theme': themeName(),
          'data-compact': compact ? '' : undefined,
          'data-touch': coarsePointer ? '' : undefined,
          onKeyDown: onRootKeyDown,
        },
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
              className: 'dsh-ide-icon-button dsh-ide-top-swap',
              title: explorerSide === 'left' ? 'Проводник справа' : 'Проводник слева',
              'aria-label': 'Поменять местами проводник и редактор',
              onClick: () => setExplorerSide(explorerSide === 'left' ? 'right' : 'left'),
            },
            h('span', { className: 'dsh-ide-activity-glyph' }, '⇄'),
          ),
          h('span', { className: 'dsh-ide-top-title', title: activeTab === undefined ? 'IDE' : activeTab.path }, activeTab === undefined ? 'IDE' : activeTab.name),
          // Phone-only controls. They are always in the tree and shown by CSS so
          // switching layouts never remounts anything; the desktop order (menu bar,
          // spacer, ⇄, title) is untouched because these buttons stay `display:none`.
          h(
            'button',
            {
              type: 'button',
              className: `dsh-ide-icon-button dsh-ide-compact-only dsh-ide-mobile-explorer${showTree ? ' dsh-ide-icon-button-active' : ''}`,
              title: showTree ? 'Скрыть проводник' : 'Показать проводник',
              'aria-label': 'Проводник',
              'aria-expanded': showTree,
              onClick: () => setShowTree(!showTree),
            },
            h(
              'svg',
              { width: '18', height: '18', viewBox: '0 0 16 16', 'aria-hidden': 'true' },
              h('path', {
                fill: 'none',
                stroke: 'currentColor',
                strokeWidth: '1.4',
                strokeLinecap: 'round',
                d: 'M2.4 4h11.2M2.4 8h11.2M2.4 12h11.2',
              }),
            ),
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'dsh-ide-icon-button dsh-ide-compact-only dsh-ide-mobile-menu',
              title: 'Меню IDE',
              'aria-label': 'Меню IDE',
              onClick: () => {
                setMenuId('')
                setMenuSheetOpen(true)
              },
            },
            h('span', { className: 'dsh-ide-activity-glyph' }, '⋮'),
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'dsh-ide-icon-button dsh-ide-compact-only dsh-ide-mobile-quick',
              title: 'Открыть файл по имени',
              'aria-label': 'Открыть файл по имени',
              onClick: openQuick,
            },
            h(
              'svg',
              { width: '18', height: '18', viewBox: '0 0 16 16', 'aria-hidden': 'true' },
              h('path', {
                fill: 'none',
                stroke: 'currentColor',
                strokeWidth: '1.3',
                d: 'M7 2.6a4.4 4.4 0 1 0 0 8.8 4.4 4.4 0 0 0 0-8.8zM10.4 10.4 14 14',
              }),
            ),
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'dsh-ide-icon-button dsh-ide-compact-only dsh-ide-mobile-settings',
              title: 'Настройки IDE',
              'aria-label': 'Настройки IDE',
              onClick: openSettings,
            },
            h('span', { className: 'dsh-ide-activity-glyph' }, '⚙'),
          ),
        ),
        h(
          'div',
          { className: 'dsh-ide-body' },
          // a classic activity bar: one narrow rail, the panel toggles live there,
          // so the explorer can be hidden without leaving the editor.
          h(
            'div',
            { className: 'dsh-ide-activity' },
            h(
              'button',
              {
                type: 'button',
                className: `dsh-ide-activity-button${explorerMode === 'scm' && showTree ? ' dsh-ide-activity-button-active' : ''}`,
                title: explorerMode === 'scm' ? 'Показать проводник' : 'Система контроля версий',
                'aria-label': 'Система контроля версий',
                onClick: () => {
                  setExplorerMode('scm')
                  setShowTree(true)
                  setChangesOpen(false)
                  setSearchOpen(false)
                  setStructureOpen(false)
                },
              },
              h(ScmBranchIcon, { size: 18 }),
            ),
            h(
              'button',
              {
                type: 'button',
                className: `dsh-ide-activity-button${explorerMode === 'files' && showTree ? ' dsh-ide-activity-button-active' : ''}`,
                title: explorerMode === 'files' && showTree ? 'Скрыть проводник' : 'Проводник',
                onClick: () => {
                  if (explorerMode !== 'files') {
                    setExplorerMode('files')
                    setShowTree(true)
                    return
                  }
                  setShowTree(!showTree)
                },
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
                  setExplorerMode('files')
                  setShowTree(true)
                  setChangesOpen(false)
                  setSearchOpen(true)
                  setStructureOpen(false)
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
                  setExplorerMode('files')
                  setShowTree(true)
                  setSearchOpen(false)
                  setStructureOpen(false)
                  setChangesOpen((open) => !open)
                },
              },
              h('span', { className: 'dsh-ide-activity-glyph' }, '🕘'),
            ),
            h(
              'button',
              {
                type: 'button',
                className: `dsh-ide-activity-button${structureOpen ? ' dsh-ide-activity-button-active' : ''}`,
                title: 'Структура активного файла',
                'aria-label': 'Структура активного файла',
                onClick: () => {
                  setExplorerMode('files')
                  setShowTree(true)
                  setChangesOpen(false)
                  setSearchOpen(false)
                  setStructureOpen((open) => !open)
                },
              },
              h(
                'svg',
                { width: '18', height: '18', viewBox: '0 0 16 16', 'aria-hidden': 'true' },
                h('path', {
                  fill: 'none',
                  stroke: 'currentColor',
                  strokeWidth: '1.3',
                  // Three indented lines: the outline of a document.
                  d: 'M3 3.5h8M5 7.5h7M7 11.5h6',
                }),
              ),
            ),
            h('span', { className: 'dsh-ide-activity-spacer' }),
            h(
              'button',
              {
                type: 'button',
                className: 'dsh-ide-activity-button',
                title: 'Настройки IDE',
                onClick: openSettings,
              },
              h('span', { className: 'dsh-ide-activity-glyph' }, '⚙'),
            ),
          ),
          // On a phone the explorer is a drawer over the editor, with a scrim
          // that dismisses it, instead of a column that squeezes the code.
          compact && showTree && typeof sessionId === 'string'
            ? h('div', {
                className: 'dsh-ide-scrim',
                'aria-hidden': 'true',
                onClick: () => setShowTree(false),
                onContextMenu: (event) => {
                  event.preventDefault()
                  setShowTree(false)
                },
              })
            : null,
          (showTree || (compact && typeof sessionId === 'string')) && typeof sessionId === 'string'
            ? h(
                'div',
                {
                  // On a phone the drawer stays mounted while closed: expanded
                  // folders and the scroll position survive the next open.
                  className: `dsh-ide-explorer-wrap${explorerSide === 'right' ? ' dsh-ide-explorer-right' : ''}${
                    compact && !showTree ? ' dsh-ide-explorer-closed' : ''
                  }`,
                  style: compact ? undefined : { width: `${explorerWidth}px`, order: explorerSide === 'left' ? 0 : 2 },
                },
                explorerMode === 'scm'
                  ? h(SourceControl, {
                      key: sessionId,
                      sessionId,
                      status: scmStatus,
                      error: scmError,
                      loading: scmLoading,
                      message: scmMessage,
                      onMessage: setScmMessage,
                      committing: scmBusy === 'commit',
                      busy: scmBusy,
                      patching: scmPatching,
                      onSendPatch: (group, path) => {
                        void sendScmPatch(group, path)
                      },
                      onOpenFinding: openScmFinding,
                      onCommit: commitScm,
                      onRefresh: () => {
                        void refreshScm()
                      },
                      onClose: () => setShowTree(false),
                      activePath: activeTab === undefined ? '' : activeTab.path,
                      unsavedPaths: new Set(tabs.filter((tab) => tab.dirty === true).map((tab) => tab.path)),
                      onOpenRow: (row) => {
                        void openScmRow(row)
                      },
                      onStageRow: (row) => {
                        void stageScm(row)
                      },
                      onUnstageRow: (row) => {
                        void unstageScm(row)
                      },
                      onOpenCommitFile: (commit, file) => {
                        void openScmCommitFile(commit, file)
                      },
                      onBranchChanged: (payload) => {
                        if (payload?.status !== undefined) {
                          scmDiffSeq.current += 1
                          scmAbort.current?.abort()
                          scmSeq.current += 1
                          setScmStatus(payload.status)
                          setScmLoading(false)
                          setScmBusy('')
                        }
                        setScmDiff(undefined)
                        setScmError('')
                      },
                    })
                  : h(Explorer, {
                  sessionId,
                  hidden,
                  reloadSignal,
                  activePath: activeTab === undefined ? '' : activeTab.path,
                  onOpenFile: (path, line) => {
                    if (typeof line === 'number') {
                      runtime.current.pendingReveal = { path: normalPath(path), line }
                      // A click on the already-active file changes no other state,
                      // so the nonce is what makes the reveal effect run again.
                      setRevealNonce((value) => value + 1)
                    }
                    // The file has to be seen: get the drawer out of the way.
                    if (compactRef.current) setShowTree(false)
                    void openFile(path, { activate: true })
                  },
                  searchOpen,
                  onCloseSearch: () => setSearchOpen(false),
                  structureOpen,
                  structure,
                  onCloseStructure: () => setStructureOpen(false),
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
          !compact && showTree && typeof sessionId === 'string'
            ? h('div', {
                className: explorerSide === 'right' ? 'dsh-ide-divider dsh-ide-divider-flip' : 'dsh-ide-divider',
                style: { order: 1 },
                title: 'Потяните, чтобы изменить ширину',
                onPointerDown: startResize,
              })
            : null,
          h(
            'div',
            {
              className: 'dsh-ide-editor',
              style: compact ? undefined : { order: explorerSide === 'left' ? 2 : 0 },
              onDragOver: onEditorDragOver,
              onDragLeave: onEditorDragLeave,
              onDrop: onEditorDrop,
            },
            dragOver === '' ? null : h('div', { className: 'dsh-ide-drop-overlay' }, h('span', { className: 'dsh-ide-drop-overlay-text' }, `Сослаться в чате: ${mentionLabel(dragOver)}`)),
            h(TabStrip, { tabs, activeKey, onActivate: setActiveKey, onClose: closeTab, onContextMenu: openTabMenu, compact }),
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
                        placeholder: inlineView.history > 0 ? 'Уточните: что поменять в предложении?' : 'Что изменить в выделенном коде?',
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
                  inlineView.phase === 'input' && inlineView.history > 0
                    ? h('span', { className: 'dsh-ide-inline-text' }, 'Уточнение к предыдущему ответу')
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
            h(
              'div',
              { className: 'dsh-ide-stage-wrap' },
              h('div', { className: 'dsh-ide-stage', ref: hostRef }),
              activeTab === undefined
                ? h(
                    'div',
                    { className: 'dsh-ide-empty' },
                    h('div', { className: 'dsh-ide-watermark' }, 'IDE'),
                    h('div', { className: 'dsh-ide-empty-title' }, 'Файл не открыт'),
                    h(
                      'div',
                      { className: 'dsh-ide-empty-text' },
                      compact
                        ? 'Выберите файл в проводнике или найдите его по имени.'
                        : explorerSide === 'left'
                          ? 'Ctrl+P — открыть файл по имени, или выберите его в проводнике слева.'
                          : 'Ctrl+P — открыть файл по имени, или выберите его в проводнике справа.',
                    ),
                    compact
                      ? h(
                          'div',
                          { className: 'dsh-ide-empty-actions' },
                          h(
                            'button',
                            { type: 'button', className: 'dsh-ide-button dsh-ide-button-primary', onClick: openQuick },
                            'Открыть файл',
                          ),
                          h(
                            'button',
                            {
                              type: 'button',
                              className: 'dsh-ide-button',
                              onClick: () => {
                                setExplorerMode('files')
                                setShowTree(true)
                              },
                            },
                            'Проводник',
                          ),
                        )
                      : null,
                  )
                : null,
              splitTab === undefined
                ? null
                : h(SplitEditor, {
                    monaco,
                    runtime,
                    tab: splitTab,
                    dirty: splitTab.dirty,
                    onDirty: markTabDirty,
                    onSave: (key) => void saveKey(key),
                    onActivate: (key) => setActiveKey(key),
                    onClose: () => setSplitKey(''),
                  }),
              crossFile === undefined
                ? null
                : h(
                    'div',
                    { className: 'dsh-ide-next-card', role: 'status' },
                    h('span', { className: 'dsh-ide-next-text' }, 'Возможно, дальше:'),
                    h(
                      'button',
                      {
                        className: 'dsh-ide-next-path',
                        title: 'Открыть этот файл',
                        onClick: () => {
                          setActiveKey(crossFile.key)
                          setCrossFile(undefined)
                        },
                      },
                      `${crossFile.path} · ${crossFile.token}`,
                    ),
                    h(
                      'button',
                      {
                        className: 'dsh-ide-next-close',
                        title: 'Скрыть',
                        'aria-label': 'Скрыть предположение',
                        onClick: () => setCrossFile(undefined),
                      },
                      '×',
                    ),
                  ),
              blameView === undefined
                ? null
                : h(
                    'div',
                    { className: 'dsh-ide-symbol-card', role: 'dialog', 'aria-label': `Происхождение строки ${blameView.path}:${blameView.line}` },
                    h(
                      'div',
                      { className: 'dsh-ide-symbol-head' },
                      h('span', { className: 'dsh-ide-symbol-title' }, `${blameView.path}:${blameView.line}`),
                      h('span', { className: 'dsh-ide-symbol-count' }, blameView.records.length === 0 ? 'неизвестно' : `${blameView.records.length}`),
                      h(
                        'button',
                        {
                          className: 'dsh-ide-next-close',
                          title: 'Закрыть',
                          'aria-label': 'Закрыть происхождение строки',
                          onClick: () => setBlameView(undefined),
                        },
                        '×',
                      ),
                    ),
                    blameView.records.length === 0
                      ? h(
                          'div',
                          { className: 'dsh-ide-symbol-note' },
                          'Неизвестно: доказательств AI-правки нет. Это не значит, что строку писал человек — запись ведётся только для принятых правок Inline Edit в этой сессии.',
                        )
                      : h(
                          'div',
                          { className: 'dsh-ide-symbol-list' },
                          blameView.records.map((record, index) =>
                            h(
                              'div',
                              { key: `${record.at}:${index}`, className: 'dsh-ide-blame-record' },
                              h(
                                'div',
                                { className: 'dsh-ide-blame-where' },
                                `${record.provider}/${record.model} · ${new Date(record.at).toLocaleTimeString('ru-RU')}`,
                              ),
                              h('div', { className: 'dsh-ide-blame-instruction' }, record.instruction || 'Без инструкции'),
                              record.conversation === undefined
                                ? null
                                : h(
                                    'details',
                                    { className: 'dsh-ide-blame-conversation' },
                                    h('summary', {}, 'Показать ход'),
                                    h('pre', {}, `Задача: ${record.conversation.message ?? ''}\n\nОтвет: ${record.conversation.answer ?? ''}`),
                                  ),
                            ),
                          ),
                        ),
                    blameView.records.length === 0
                      ? null
                      : h('div', { className: 'dsh-ide-symbol-note' }, 'Ход — это запрос и ответ, сохранённые при принятии правки. Другие изменения строки здесь не отслеживаются.'),
                  ),
              symbolView === undefined
                ? null
                : h(
                    'div',
                    { className: 'dsh-ide-symbol-card', role: 'dialog', 'aria-label': `Символ ${symbolView.word}` },
                    h(
                      'div',
                      { className: 'dsh-ide-symbol-head' },
                      h('span', { className: 'dsh-ide-symbol-title' }, symbolView.word),
                      h('span', { className: 'dsh-ide-symbol-count' }, `${symbolView.rows.length} в открытых файлах`),
                      h(
                        'button',
                        {
                          className: 'dsh-ide-next-close',
                          title: 'Закрыть',
                          'aria-label': 'Закрыть список символов',
                          onClick: () => setSymbolView(undefined),
                        },
                        '×',
                      ),
                    ),
                    h(
                      'div',
                      { className: 'dsh-ide-symbol-list' },
                      symbolView.rows.slice(0, 60).map((row, index) =>
                        h(
                          'button',
                          {
                            key: `${row.key}:${row.line}:${row.column}:${index}`,
                            className: 'dsh-ide-symbol-row',
                            title: row.text,
                            onClick: () => {
                              runtime.current.pendingReveal = { path: normalPath(row.path), line: row.line }
                              setActiveKey(row.key)
                              setSymbolView(undefined)
                            },
                          },
                          h('span', { className: `dsh-ide-symbol-kind ${row.kind}` }, row.kind === 'definition' ? 'опр' : 'ссылка'),
                          h('span', { className: 'dsh-ide-symbol-where' }, `${row.path}:${row.line}`),
                          h('span', { className: 'dsh-ide-symbol-text' }, row.text),
                        ),
                      ),
                    ),
                    h('div', { className: 'dsh-ide-symbol-note' }, 'Только открытые вкладки и JS/TS: это поиск по тексту, не языковой сервер.'),
                  ),
              renameView === undefined
                ? null
                : h(
                    'div',
                    { className: 'dsh-ide-symbol-card', role: 'dialog', 'aria-label': `Переименовать ${renameView.word}` },
                    h(
                      'div',
                      { className: 'dsh-ide-symbol-head' },
                      h('span', { className: 'dsh-ide-symbol-title' }, `Переименовать ${renameView.word}`),
                      h(
                        'button',
                        {
                          className: 'dsh-ide-next-close',
                          title: 'Закрыть',
                          'aria-label': 'Закрыть переименование',
                          onClick: () => setRenameView(undefined),
                        },
                        '×',
                      ),
                    ),
                    h(
                      'div',
                      { className: 'dsh-ide-symbol-form' },
                      h('input', {
                        className: 'dsh-ide-symbol-input',
                        value: renameView.next,
                        'aria-label': 'Новое имя',
                        onInput: (event) => setRenameView({ ...renameView, next: event.target.value, plan: undefined }),
                      }),
                      h(
                        'button',
                        {
                          className: 'dsh-ide-symbol-action',
                          onClick: () => setRenameView({ ...renameView, plan: renamePlan(tabs, renameView.word, renameView.next) }),
                        },
                        'Просмотреть',
                      ),
                    ),
                    renameView.plan === undefined
                      ? null
                      : renameView.plan.ok === false
                        ? h('div', { className: 'dsh-ide-symbol-note' }, renameView.plan.reason)
                        : h(
                            'div',
                            { className: 'dsh-ide-symbol-list' },
                            renameView.plan.files.map((file) =>
                              h(
                                'div',
                                { className: 'dsh-ide-symbol-row', key: file.key },
                                h('span', { className: 'dsh-ide-symbol-kind definition' }, `${file.count}`),
                                h('span', { className: 'dsh-ide-symbol-where' }, file.path),
                                h('span', { className: 'dsh-ide-symbol-text' }, `${file.before.trim()} → ${file.after.trim()}`),
                              ),
                            ),
                          ),
                    renameView.plan?.ok === true
                      ? h(
                          'div',
                          { className: 'dsh-ide-symbol-form' },
                          h('span', { className: 'dsh-ide-symbol-note' }, `${renameView.plan.total} замен(ы) в ${renameView.plan.files.length} файл(ах)`),
                          h('button', { className: 'dsh-ide-symbol-action', onClick: applyRename }, 'Применить'),
                        )
                      : null,
                    h('div', { className: 'dsh-ide-symbol-note' }, 'Применение меняет текст открытых вкладок и помечает их изменёнными; файлы на диске не пишутся, Undo в моделях сбрасывается.'),
                  ),
              testsView === undefined
                ? null
                : h(
                    'div',
                    { className: 'dsh-ide-symbol-card', role: 'dialog', 'aria-label': 'Тесты проекта' },
                    h(
                      'div',
                      { className: 'dsh-ide-symbol-head' },
                      h('span', { className: 'dsh-ide-symbol-title' }, 'npm test'),
                      h(
                        'span',
                        { className: 'dsh-ide-symbol-count' },
                        testsView.phase === 'running'
                          ? 'идёт запуск…'
                          : testsView.phase === 'failed'
                            ? 'ошибка'
                            : `${testsView.result.failures.length} упавших · ${Math.round(testsView.result.durationMs / 1000)} с`,
                      ),
                      h(
                        'button',
                        {
                          className: 'dsh-ide-next-close',
                          title: 'Закрыть',
                          'aria-label': 'Закрыть результаты тестов',
                          onClick: () => {
                            stopProjectTests()
                            setTestsView(undefined)
                          },
                        },
                        '×',
                      ),
                    ),
                    testsView.phase === 'running'
                      ? h(
                          'div',
                          { className: 'dsh-ide-symbol-form' },
                          h('span', { className: 'dsh-ide-symbol-note' }, 'Тесты идут в рабочей папке. Вывод появится после завершения.'),
                          h('button', { className: 'dsh-ide-symbol-action', onClick: stopProjectTests }, 'Остановить'),
                        )
                      : null,
                    testsView.phase === 'failed' ? h('div', { className: 'dsh-ide-symbol-note' }, testsView.error) : null,
                    testsView.phase === 'ready'
                      ? h(
                          'div',
                          { className: 'dsh-ide-symbol-form' },
                          h('button', { className: 'dsh-ide-symbol-action', onClick: runProjectTests }, 'Повторить'),
                          h('span', { className: 'dsh-ide-symbol-note' }, `код ${testsView.result.code}${testsView.result.truncated ? ' · вывод обрезан' : ''}`),
                        )
                      : null,
                    testsView.phase === 'ready'
                      ? h(
                          'div',
                          { className: 'dsh-ide-symbol-list' },
                          testsView.result.failures.length === 0
                            ? h('div', { className: 'dsh-ide-symbol-note' }, `Тесты прошли, код ${testsView.result.code}.`)
                            : testsView.result.failures.map((failure, index) =>
                                h(
                                  'button',
                                  {
                                    key: `${failure.file}:${failure.line}:${index}`,
                                    className: 'dsh-ide-symbol-row',
                                    title: failure.name,
                                    onClick: () => {
                                      if (failure.file === '') return
                                      runtime.current.pendingReveal = { path: normalPath(failure.file), line: failure.line }
                                      void openFile(failure.file, { activate: true })
                                    },
                                  },
                                  h('span', { className: 'dsh-ide-symbol-kind definition' }, 'тест'),
                                  h('span', { className: 'dsh-ide-symbol-where' }, `${failure.file}:${failure.line}`),
                                  h('span', { className: 'dsh-ide-symbol-text' }, failure.name),
                                ),
                              ),
                        )
                      : null,
                    testsView.phase === 'ready'
                      ? h(
                          'details',
                          { className: 'dsh-ide-symbol-output' },
                          h('summary', null, 'Вывод'),
                          h('pre', null, testsView.result.output),
                        )
                      : null,
                    h('div', { className: 'dsh-ide-symbol-note' }, 'Запускается только скрипт test из package.json; запись в файлы тестов не выполняется плагином.'),
                  ),
              activeTab !== undefined && !editorReady && (editorFailure !== null || editorSlow)
                ? h(
                    'div',
                    { className: 'dsh-ide-stage-fallback' },
                    h(
                      'div',
                      { className: 'dsh-ide-stage-fallback-head' },
                      h(
                        'div',
                        { className: 'dsh-ide-stage-fallback-title' },
                        editorFailure === null ? 'Редактор ещё загружается' : 'Редактор не загрузился',
                      ),
                      h(
                        'div',
                        { className: 'dsh-ide-stage-fallback-text' },
                        editorFailure === null
                          ? 'Пока файл показан простым текстом: его можно прочитать, но подсветки и правок нет.'
                          : `Файл показан простым текстом. ${editorFailure}`,
                      ),
                      editorFailure === null
                        ? null
                        : h(
                            'div',
                            { className: 'dsh-ide-stage-fallback-actions' },
                            h(
                              'button',
                              {
                                type: 'button',
                                className: 'dsh-ide-button dsh-ide-button-primary',
                                onClick: () => {
                                  if (typeof window !== 'undefined') window.location.reload()
                                },
                              },
                              'Обновить страницу',
                            ),
                          ),
                    ),
                    h('pre', { className: 'dsh-ide-stage-fallback-code' }, activeTab.text),
                  )
                : null,
              // Side-by-side comparison of one assistant file or one Git change,
              // drawn over the editor: two panes need the width, the explorer
              // pane has none. Only one comparison is open at a time.
              scmDiff !== undefined
                ? h(GitDiff, {
                    view: scmDiff,
                    dirty: scmDiff.group !== 'commit' && tabs.some((tab) => tab.path === scmDiff.path && tab.dirty === true),
                    onClose: () => {
                      setScmDiff(undefined)
                      if (compactRef.current) setShowTree(true)
                    },
                    onOpenFile: (path) => {
                      setScmDiff(undefined)
                      void openFile(path, { activate: true })
                    },
                    onPrevious: () => jumpDiff('previous'),
                    onNext: () => jumpDiff('next'),
                    onSendPatch: (group, path) => {
                      void sendScmPatch(group, path)
                    },
                    patching: scmPatching,
                    containerRef: diffContainerRef,
                  })
                : diffView === undefined
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
            panel === undefined ? null : h('div', { className: 'dsh-ide-panel-resize', onPointerDown: beginPanelResize }),
            panel === undefined
              ? null
              : h(OutputPanel, {
                  panel,
                  toolTabs,
                  height: panelHeight,
                  trace,
                  showChat,
                  onTab: (tab) => setPanel({ tab, index: panel.index }),
                  onSelect: replayTrace,
                  onAccept: (row) => replayRow(row, true),
                  onClose: () => setPanel(undefined),
                }),
            h(
              'div',
              { className: 'dsh-ide-status' },
              h('span', { className: `dsh-ide-status-text${status.kind === 'error' ? ' dsh-ide-status-error' : ''}` }, statusMessage),
              h('span', { className: 'dsh-ide-status-item dsh-ide-hint-elapsed', ref: hintElapsedRef, hidden: true }, ''),
              h('span', { className: 'dsh-ide-status-spacer' }),
              activeTab === undefined
                ? null
                : h(
                    'button',
                    {
                      type: 'button',
                      className: 'dsh-ide-status-item dsh-ide-status-action dsh-ide-status-lang',
                      title: 'Выбрать языковой режим',
                      onClick: () => setPicker({ kind: 'language' }),
                    },
                    activeTab.languageOverride || activeTab.language || 'plain',
                  ),
              activeTab === undefined ? null : h('span', { className: 'dsh-ide-status-item dsh-ide-status-pos' }, `Стр ${cursor.line}, Стлб ${cursor.column}`),
              activeTab !== undefined && activeTab.readOnly
                ? h('span', { className: 'dsh-ide-status-item dsh-ide-status-readonly' }, 'Только чтение')
                : null,
              activeTab === undefined || activeTab.readOnly
                ? null
                : h(
                    'button',
                    {
                      type: 'button',
                      className: 'dsh-ide-status-item dsh-ide-status-action dsh-ide-status-eol',
                      title: 'Выбрать конец строки',
                      onClick: () => setPicker({ kind: 'eol' }),
                    },
                    activeTab.eol === 'crlf' ? 'CRLF' : 'LF',
                  ),
              activeTab === undefined
                ? null
                : h(
                    'button',
                    {
                      type: 'button',
                      className: 'dsh-ide-status-item dsh-ide-status-action dsh-ide-status-enc',
                      title: 'Выбрать кодировку',
                      onClick: () => setPicker({ kind: 'encoding', mode: 'save' }),
                    },
                    encodingLabel(activeTab.encoding),
                  ),
              askModeOn
                ? h(
                    'button',
                    {
                      type: 'button',
                      className: 'dsh-ide-status-item dsh-ide-status-action dsh-ide-status-ask',
                      title: 'Режим вопросов включён: запись запрещена. Нажмите, чтобы выключить',
                      onClick: toggleAskMode,
                    },
                    'Ask',
                  )
                : null,
              snoozeUntil > 0
                ? h(
                    'button',
                    {
                      type: 'button',
                      className: 'dsh-ide-status-item dsh-ide-status-action dsh-ide-status-snooze',
                      title: 'Возобновить автоподсказки Tab',
                      onClick: resumeTab,
                    },
                    `Tab до ${snoozeLabel(snoozeUntil)}`,
                  )
                : null,
              activeTab !== undefined && tabExtensionDisabled(preferences, activeTab.path)
                ? h(
                    'button',
                    {
                      type: 'button',
                      className: 'dsh-ide-status-item dsh-ide-status-action',
                      title: `Включить автоподсказки Tab для .${fileExtension(activeTab.path)}`,
                      onClick: () => void toggleTabExtension(),
                    },
                    `Tab .${fileExtension(activeTab.path)} выкл`,
                  )
                : null,
              activeTab === undefined || activeTab.hostId === undefined
                ? null
                : h(
                    'button',
                    {
                      type: 'button',
                      className: 'dsh-ide-status-item dsh-ide-status-action',
                      title: 'Показать правила проекта для этого файла',
                      onClick: () => setRulesOpen(true),
                    },
                    'Правила',
                  ),
              compact || coarsePointer
                ? h(
                    'span',
                    { className: 'dsh-ide-zoom' },
                    h(
                      'button',
                      { type: 'button', className: 'dsh-ide-zoom-button', 'aria-label': 'Уменьшить шрифт', onClick: () => zoom(-1) },
                      'A−',
                    ),
                    h('span', { className: 'dsh-ide-zoom-value', title: 'Размер текста' }, `${fontSize}px`),
                    h(
                      'button',
                      { type: 'button', className: 'dsh-ide-zoom-button', 'aria-label': 'Увеличить шрифт', onClick: () => zoom(1) },
                      'A+',
                    ),
                  )
                : null,
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
        menuSheetOpen && compact ? h(MenuSheet, { menus, onClose: () => setMenuSheetOpen(false) }) : null,
        rulesOpen && activeTab !== undefined && activeTab.hostId !== undefined
          ? h(RulesPanel, {
              tab: { hostId: activeTab.hostId, path: activeTab.path },
              sessionId: stateRef.current.sessionId,
              onClose: () => setRulesOpen(false),
            })
          : null,
        exploreOpen
          ? h(ExplorePanel, {
              onClose: () => setExploreOpen(false),
              onAsk: (question) => call('explore', { sessionId: stateRef.current.sessionId, question }),
              onOpen: (source) => {
                setExploreOpen(false)
                runtime.current.pendingReveal = { path: normalPath(source.path), line: source.line }
                void openFile(source.path, { activate: true })
              },
            })
          : null,
        convSearchOpen
          ? h(ConversationSearchPanel, {
              onClose: () => setConvSearchOpen(false),
              onSearch: (query) => call('sessionSearch', { sessionId: stateRef.current.sessionId, query }),
              onOpen: (item) => openConversationSession(item.sessionId),
              onAttach: (item) => void attachConversation(item),
            })
          : null,
        convSource !== undefined
          ? h(ConversationSourcePanel, {
              source: convSource,
              onClose: () => setConvSource(undefined),
              onInsert: () => {
                const title = convSource.title || convSource.sessionId
                const accepted = insertQuote(
                  `Прошлый разговор · ${title}\n\n${convSource.text}`,
                  `Разговор: ${convSource.chars} символов`,
                )
                if (accepted) setConvSource(undefined)
              },
            })
          : null,
        sideChat !== undefined
          ? h(SideChatPanel, {
              context: sideChat,
              onClose: () => setSideChat(undefined),
              onAsk: askSideChat,
            })
          : null,
        planPicker !== undefined
          ? h('div', { className: 'dsh-ide-modal' }, h(
              'div',
              { className: 'dsh-ide-modal-card dsh-ide-plans-card', role: 'dialog', 'aria-label': 'Передать план в сессию' },
              h(
                'div',
                { className: 'dsh-ide-plans-head' },
                h('strong', null, 'Передать план в сессию'),
                h('button', { type: 'button', className: 'dsh-ide-button', onClick: () => setPlanPicker(undefined) }, 'Отмена'),
              ),
              h('div', { className: 'dsh-ide-plans-meta' }, planPicker.title),
              planTargets().length === 0
                ? h('div', { className: 'dsh-ide-plans-note' }, 'Нет других открытых сессий: откройте нужную сессию и повторите.')
                : h(
                    'div',
                    { className: 'dsh-ide-plans-list' },
                    planTargets().map((target) =>
                      h(
                        'button',
                        {
                          key: target.id,
                          type: 'button',
                          className: 'dsh-ide-plans-row dsh-ide-plans-target',
                          onClick: () => void transferSavedPlan(planPicker, target.id),
                        },
                        h('span', { className: 'dsh-ide-plans-title' }, target.title),
                        h('span', { className: 'dsh-ide-plans-meta' }, target.id),
                      ),
                    ),
                  ),
              h('div', { className: 'dsh-ide-plans-foot' }, 'Текст попадает только в поле ввода выбранной сессии и не отправляется.'),
            ))
          : null,
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
        picker !== undefined && activeTab !== undefined
          ? h(StatusPicker, {
              title:
                picker.kind === 'language'
                  ? menuText('Выбрать языковой режим', 'Select Language Mode')
                  : picker.kind === 'eol'
                    ? menuText('Выбрать конец строки', 'Select End of Line Sequence')
                    : menuText('Выбрать кодировку', 'Select File Encoding'),
              currentId:
                picker.kind === 'language'
                  ? activeTab.languageOverride ?? 'auto'
                  : picker.kind === 'eol'
                    ? activeTab.eol
                    : activeTab.encoding,
              head:
                picker.kind !== 'encoding'
                  ? undefined
                  : [
                      {
                        id: 'open',
                        label: menuText('Открыть в кодировке', 'Reopen with encoding'),
                        active: picker.mode !== 'save',
                        run: () => setPicker({ kind: 'encoding', mode: 'open' }),
                      },
                      {
                        id: 'save',
                        label: menuText('Сохранить в кодировке', 'Save with encoding'),
                        active: picker.mode === 'save',
                        run: () => setPicker({ kind: 'encoding', mode: 'save' }),
                      },
                    ],
              entries: pickerEntries(picker.kind, picker.mode, activeTab),
              onPick: (picked) => {
                if (picker.kind === 'language') pickLanguage(activeTab, picked)
                else if (picker.kind === 'eol') pickEol(activeTab, picked.id)
                else pickEncoding(activeTab, picked.id, picker.mode === 'save' ? 'save' : 'open')
              },
              onClose: closePicker,
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
.dsh-ide-explorer-search { display:flex; align-items:center; gap:4px; padding:0 8px 6px; }
.dsh-ide-search-input { flex:1 1 auto; min-width:0; padding:3px 6px; border-radius:4px; color:inherit; background:var(--ide-bg);
  border:1px solid var(--ide-border); font:400 11.5px/1.5 var(--dsh-font-ui, system-ui, sans-serif); outline:none; }
.dsh-ide-search-input:focus { border-color:var(--ide-accent); }
.dsh-ide-search-toggle { flex:0 0 auto; padding:2px 5px; border-radius:4px; border:1px solid var(--ide-border);
  background:var(--ide-bg); color:var(--ide-fg-dim); font:600 10px/1.5 var(--ide-mono); cursor:pointer; }
.dsh-ide-search-toggle:hover { background:var(--ide-hover); color:var(--ide-fg); }
.dsh-ide-search-toggle[aria-pressed='true'] { border-color:var(--ide-accent); background:var(--ide-hover); color:var(--ide-fg); }
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
.dsh-ide-structure-row:hover { background:var(--ide-hover); }
.dsh-ide-structure-kind { flex:0 0 auto; min-width:14px; height:14px; padding:0 2px; display:inline-flex; align-items:center; justify-content:center;
  align-self:center; border-radius:3px; background:var(--ide-hover); color:var(--ide-fg-dim); font:600 9px/1 var(--ide-mono); }
.dsh-ide-structure-class { color:#b48ead; }
.dsh-ide-structure-function { color:#bf9560; }
.dsh-ide-structure-method { color:#81a1c1; }
.dsh-ide-structure-interface { color:#7fb285; }
.dsh-ide-structure-heading, .dsh-ide-structure-rule, .dsh-ide-structure-atrule { color:#8fa876; }
.dsh-ide-structure-name { flex:1 1 auto; min-width:0; color:var(--ide-fg);
  font:400 11.5px/1.4 var(--dsh-font-ui, system-ui, sans-serif); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.dsh-ide-structure-line { flex:0 0 auto; min-width:3ch; text-align:right; color:var(--ide-fg-dim); font:400 10.5px/1.4 var(--ide-mono); }
.dsh-ide-structure-resize { flex:0 0 5px; height:5px; cursor:row-resize; background:transparent; border-top:1px solid var(--ide-border); }
.dsh-ide-structure-resize:hover { background:var(--ide-hover); }
.dsh-ide-structure { flex:0 0 auto; display:flex; flex-direction:column; min-height:0; overflow:hidden; }
.dsh-ide-structure .dsh-ide-tree { flex:1 1 auto; }
.dsh-ide-structure-hit { flex-direction:column; align-items:stretch; gap:0; }
.dsh-ide-structure-main { display:flex; align-items:baseline; gap:6px; min-width:0; }
.dsh-ide-structure-comment { display:block; margin-left:20px; color:var(--ide-fg-dim); font:400 10.5px/1.4 var(--dsh-font-ui, system-ui, sans-serif); white-space:normal; overflow-wrap:anywhere; }
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
.dsh-ide-scm { min-height:0; }
.dsh-ide-scm-branch { display:flex; align-items:center; gap:6px; width:100%; padding:5px 10px; flex:0 0 auto;
  border:0; border-bottom:1px solid var(--ide-border); background:var(--ide-panel-2); color:inherit;
  cursor:pointer; text-align:left; font:inherit; min-width:0; }
.dsh-ide-scm-branch:hover { background:var(--ide-hover); }
.dsh-ide-scm-branch:focus-visible { outline:1px solid var(--ide-accent); outline-offset:-1px; }
.dsh-ide-scm-branch-icon { display:flex; color:var(--ide-accent); flex:0 0 auto; }
.dsh-ide-scm-branch-name { font-weight:600; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.dsh-ide-scm-branch-head { margin-left:auto; color:var(--ide-fg-dim);
  font:400 10px/1.4 var(--dsh-font-mono, ui-monospace, monospace); flex:0 0 auto; }
.dsh-ide-scm-branch-caret { color:var(--ide-fg-dim); flex:0 0 auto; font-size:10px; }
.dsh-ide-scm-branch-open .dsh-ide-scm-branch-caret { color:var(--ide-accent); }
.dsh-ide-scm-branches { flex:0 0 auto; max-height:44%; overflow:auto; padding:6px 10px 8px;
  border-bottom:1px solid var(--ide-border); background:var(--ide-panel-2); }
.dsh-ide-scm-branches-head { display:flex; align-items:center; justify-content:space-between; gap:8px;
  margin-bottom:3px; color:var(--ide-fg-dim); text-transform:uppercase; letter-spacing:.4px;
  font:600 10px/1.5 var(--dsh-font-ui, system-ui, sans-serif); }
.dsh-ide-scm-branch-list { display:flex; flex-direction:column; gap:1px; }
.dsh-ide-scm-branch-row { display:flex; align-items:center; gap:2px; border-radius:3px; }
.dsh-ide-scm-branch-row:hover { background:var(--ide-hover); }
.dsh-ide-scm-branch-row-current { background:var(--ide-select); }
.dsh-ide-scm-branch-pick { flex:1 1 auto; min-width:0; display:flex; align-items:center; gap:6px;
  padding:3px 4px; border:0; background:transparent; color:inherit; cursor:pointer;
  text-align:left; font:inherit; }
.dsh-ide-scm-branch-pick:disabled { cursor:default; }
.dsh-ide-scm-branch-pick:focus-visible { outline:1px solid var(--ide-accent); outline-offset:-1px; }
.dsh-ide-scm-branch-check { flex:0 0 12px; color:var(--ide-accent);
  font:700 10px/1.5 var(--dsh-font-mono, ui-monospace, monospace); }
.dsh-ide-scm-branch-option-name { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.dsh-ide-scm-branch-badge { margin-left:auto; padding:0 4px; border:1px solid var(--ide-border); border-radius:6px;
  color:var(--ide-fg-dim); font:400 9px/1.4 var(--dsh-font-ui, system-ui, sans-serif); }
.dsh-ide-scm-branch-delete { flex:0 0 auto; width:20px; height:20px; padding:0; border:0; border-radius:3px;
  background:transparent; color:var(--ide-fg-dim); cursor:pointer;
  font:600 13px/1 var(--dsh-font-mono, ui-monospace, monospace); }
.dsh-ide-scm-branch-delete:hover:not(:disabled) { background:var(--ide-hover); color:var(--ide-error); }
.dsh-ide-scm-branch-delete:disabled { opacity:.5; cursor:default; }
.dsh-ide-scm-branch-confirm { display:flex; flex-wrap:wrap; align-items:center; gap:6px; padding:4px;
  border:1px solid var(--ide-error); border-radius:4px; margin-top:2px; }
.dsh-ide-scm-branch-confirm-text { flex:1 1 100%; overflow-wrap:anywhere;
  font:400 10.5px/1.4 var(--dsh-font-ui, system-ui, sans-serif); }
.dsh-ide-scm-branch-danger { padding:2px 7px; border:1px solid var(--ide-error); border-radius:3px;
  background:transparent; color:var(--ide-error); cursor:pointer;
  font:600 10.5px/1.5 var(--dsh-font-ui, system-ui, sans-serif); }
.dsh-ide-scm-branch-danger:disabled { opacity:.5; cursor:default; }
.dsh-ide-scm-new-branch { display:flex; flex-wrap:wrap; align-items:center; gap:4px; margin-top:6px; }
.dsh-ide-scm-branch-input { flex:1 1 120px; min-width:0; padding:2px 5px; color:var(--ide-fg);
  background:var(--ide-bg); border:1px solid var(--ide-border); border-radius:3px; outline:none;
  font:400 11px/1.5 var(--dsh-font-ui, system-ui, sans-serif); }
.dsh-ide-scm-branch-input:focus { border-color:var(--ide-accent); }
.dsh-ide-scm-new-branch-submit { padding:2px 8px; border:1px solid var(--ide-accent); border-radius:3px;
  background:var(--ide-accent); color:#ffffff; cursor:pointer;
  font:600 10.5px/1.5 var(--dsh-font-ui, system-ui, sans-serif); }
.dsh-ide-scm-new-branch-submit:disabled { opacity:.5; cursor:default; }
.dsh-ide-scm-new-branch-button { padding:2px 0; border:0; background:transparent; color:var(--ide-accent);
  cursor:pointer; text-align:left; font:400 11px/1.6 var(--dsh-font-ui, system-ui, sans-serif); }
.dsh-ide-scm-new-branch-button:hover { text-decoration:underline; }
.dsh-ide-scm-scroll { flex:1 1 auto; min-height:0; overflow:auto; }
.dsh-ide-scm-commit { padding:8px 10px; border-bottom:1px solid var(--ide-border); }
.dsh-ide-scm-message { width:100%; min-height:48px; resize:vertical; padding:5px 6px; color:var(--ide-fg);
  background:var(--ide-bg); border:1px solid var(--ide-border); border-radius:4px; outline:none;
  font:400 11.5px/1.45 var(--dsh-font-ui, system-ui, sans-serif); }
.dsh-ide-scm-message:focus { border-color:var(--ide-accent); }
.dsh-ide-scm-commit-button { width:100%; margin-top:4px; }
.dsh-ide-scm-hint { margin-top:3px; color:var(--ide-fg-dim);
  font:400 10.5px/1.4 var(--dsh-font-ui, system-ui, sans-serif); }
/* Chat and review act on the exact index snapshot: buttons stay small, the
   payload size is stated, and a skipped file is named rather than hidden. */
.dsh-ide-scm-actions { display:flex; flex-wrap:wrap; align-items:center; gap:4px; margin-top:5px; }
.dsh-ide-scm-actions .dsh-ide-button { flex:0 0 auto; padding:2px 8px; font-size:10.5px; }
.dsh-ide-scm-depth { display:flex; border:1px solid var(--ide-border); border-radius:4px; overflow:hidden; }
.dsh-ide-scm-depth-button { border:0; background:transparent; color:var(--ide-muted); cursor:pointer;
  padding:2px 7px; font-size:10.5px; }
.dsh-ide-scm-depth-button[aria-pressed='true'] { background:var(--ide-accent); color:#fff; }
.dsh-ide-scm-compare { margin-top:8px; border-top:1px solid var(--ide-border); padding-top:8px; }
.dsh-ide-scm-compare-head { font-size:10.5px; color:var(--ide-muted); margin-bottom:4px; }
.dsh-ide-scm-compare-form { display:flex; gap:4px; }
.dsh-ide-scm-compare-input { flex:1 1 auto; min-width:0; padding:2px 6px; border-radius:4px;
  border:1px solid var(--ide-border); background:var(--ide-bg); color:inherit; font-size:11px; }
.dsh-ide-scm-compare-result { margin-top:6px; }
.dsh-ide-scm-compare-note { color:var(--ide-muted); font-size:10.5px; line-height:1.45; }
.dsh-ide-scm-compare-files { max-height:120px; overflow:auto; margin-top:4px; }
.dsh-ide-scm-compare-file { display:flex; gap:6px; font:10.5px/1.5 var(--dsh-font-mono, ui-monospace, monospace); }
.dsh-ide-scm-compare-status { color:var(--ide-warn, #d19a66); width:10px; flex:0 0 auto; }
.dsh-ide-scm-compare-path { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.dsh-ide-scm-review-note { color:var(--ide-fg-dim);
  font:400 10.5px/1.45 var(--dsh-font-ui, system-ui, sans-serif); }
.dsh-ide-scm-review { padding:6px 10px 8px; border-top:1px solid var(--ide-border); }
.dsh-ide-scm-review-stale { margin-bottom:4px; padding:3px 6px; border-radius:4px;
  background:rgba(220, 170, 60, .14); color:var(--ide-fg-dim);
  font:400 10.5px/1.45 var(--dsh-font-ui, system-ui, sans-serif); }
.dsh-ide-scm-review-stale .dsh-ide-scm-link { margin-left:6px; }
.dsh-ide-scm-findings { display:flex; flex-direction:column; gap:3px; margin-top:4px; }
.dsh-ide-scm-finding { display:block; width:100%; padding:4px 6px; border:1px solid var(--ide-border);
  border-left-width:3px; border-radius:4px; background:var(--ide-panel-2); color:inherit; text-align:left;
  cursor:pointer; font:400 10.5px/1.45 var(--dsh-font-ui, system-ui, sans-serif); }
.dsh-ide-scm-finding:hover { background:var(--ide-hover); }
.dsh-ide-scm-finding-high { border-left-color:#f48771; }
.dsh-ide-scm-finding-medium { border-left-color:#dcdcaa; }
.dsh-ide-scm-finding-low { border-left-color:#9cdcfe; }
.dsh-ide-scm-finding-where { display:block; color:var(--ide-fg-dim); font:400 9.5px/1.4 var(--dsh-font-mono, ui-monospace, monospace); }
.dsh-ide-scm-finding-message { display:block; }
.dsh-ide-scm-chat { padding:0 5px; border:1px solid var(--ide-border); border-radius:3px;
  background:var(--ide-panel-2); color:var(--ide-fg-dim); cursor:pointer; text-transform:none;
  letter-spacing:0; font:400 9.5px/1.6 var(--dsh-font-ui, system-ui, sans-serif); }
.dsh-ide-scm-chat:hover:not(:disabled) { color:var(--ide-fg); border-color:var(--ide-accent); }
.dsh-ide-scm-chat:disabled { opacity:.5; cursor:default; }
.dsh-ide-scm-section { border-top:1px solid var(--ide-border); }
.dsh-ide-scm-section-head { display:flex; align-items:center; justify-content:space-between; gap:8px;
  padding:6px 10px 2px; color:var(--ide-fg-dim); text-transform:uppercase; letter-spacing:.4px;
  font:600 10px/1.5 var(--dsh-font-ui, system-ui, sans-serif); }
.dsh-ide-scm-section-count { padding:0 5px; border-radius:8px; background:var(--ide-hover); letter-spacing:0; }
.dsh-ide-scm-row { display:flex; align-items:center; gap:2px; padding:1px 4px 1px 8px; }
.dsh-ide-scm-row:hover { background:var(--ide-hover); }
.dsh-ide-scm-row-active { background:var(--ide-select); }
.dsh-ide-scm-row-main { flex:1 1 auto; min-width:0; display:flex; align-items:center; gap:6px; padding:3px 0;
  border:0; background:transparent; color:inherit; text-align:left; cursor:pointer; font:inherit; }
.dsh-ide-scm-row-main:focus-visible { outline:1px solid var(--ide-accent); outline-offset:-1px; border-radius:3px; }
.dsh-ide-scm-letter { flex:0 0 13px; width:13px; text-align:center; font:700 10px/1.6 var(--dsh-font-mono, ui-monospace, monospace); }
.dsh-ide-scm-letter[data-letter="A"], .dsh-ide-scm-letter[data-letter="?"] { color:#89d185; }
.dsh-ide-scm-letter[data-letter="M"] { color:#dcdcaa; }
.dsh-ide-scm-letter[data-letter="D"] { color:#f48771; }
.dsh-ide-scm-letter[data-letter="R"], .dsh-ide-scm-letter[data-letter="C"] { color:#9cdcfe; }
.dsh-ide-scm-letter[data-letter="T"], .dsh-ide-scm-letter[data-letter="U"] { color:#c586c0; }
.dsh-ide-root[data-theme="light"] .dsh-ide-scm-letter[data-letter="A"],
.dsh-ide-root[data-theme="light"] .dsh-ide-scm-letter[data-letter="?"] { color:#1a7f37; }
.dsh-ide-root[data-theme="light"] .dsh-ide-scm-letter[data-letter="M"] { color:#8a5a00; }
.dsh-ide-root[data-theme="light"] .dsh-ide-scm-letter[data-letter="D"] { color:#cf222e; }
.dsh-ide-root[data-theme="light"] .dsh-ide-scm-letter[data-letter="R"],
.dsh-ide-root[data-theme="light"] .dsh-ide-scm-letter[data-letter="C"] { color:#0969da; }
.dsh-ide-root[data-theme="light"] .dsh-ide-scm-letter[data-letter="T"],
.dsh-ide-root[data-theme="light"] .dsh-ide-scm-letter[data-letter="U"] { color:#8250df; }
.dsh-ide-root[data-theme="light"] .dsh-ide-scm-graph-svg { filter:brightness(0.68) saturate(1.05); }
.dsh-ide-scm-row-text { min-width:0; display:flex; flex-direction:column; }
.dsh-ide-scm-name { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.dsh-ide-scm-dir { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:var(--ide-fg-dim);
  font:400 10px/1.35 var(--dsh-font-mono, ui-monospace, monospace); }
.dsh-ide-scm-dirty { margin-left:3px; color:var(--ide-accent); }
.dsh-ide-scm-action { flex:0 0 auto; width:22px; height:22px; padding:0; border:1px solid transparent; border-radius:3px;
  background:transparent; color:var(--ide-fg-dim); cursor:pointer;
  font:600 13px/1 var(--dsh-font-mono, ui-monospace, monospace); }
.dsh-ide-scm-action:hover:not(:disabled) { border-color:var(--ide-border); background:var(--ide-panel-2); color:var(--ide-fg); }
.dsh-ide-scm-action:disabled { opacity:.5; cursor:default; }
.dsh-ide-scm-conflict-note { flex:0 0 auto; color:var(--ide-fg-dim);
  font:400 9.5px/1.4 var(--dsh-font-ui, system-ui, sans-serif); }
.dsh-ide-scm-resolve-action { flex:0 0 auto; border:1px solid var(--ide-border); border-radius:4px;
  background:transparent; color:var(--ide-fg-dim); padding:2px 6px; cursor:pointer;
  font:400 9.5px/1.4 var(--dsh-font-ui, system-ui, sans-serif); }
.dsh-ide-scm-resolve-action:hover:not(:disabled) { border-color:var(--ide-accent); color:var(--ide-fg); }
.dsh-ide-scm-resolve-action:disabled { opacity:.5; cursor:default; }
.dsh-ide-scm-resolve { margin:6px 8px; border:1px solid var(--ide-border); border-radius:5px;
  background:var(--ide-panel-2); overflow:hidden; }
.dsh-ide-scm-resolve-path { flex:1 1 auto; min-width:0; overflow:hidden; text-overflow:ellipsis;
  white-space:nowrap; color:var(--ide-fg-dim);
  font:400 9.5px/1.4 var(--dsh-font-mono, ui-monospace, monospace); }
.dsh-ide-scm-resolve-body { display:flex; flex-direction:column; gap:6px; padding:6px 8px 8px; }
.dsh-ide-scm-resolve-text { width:100%; box-sizing:border-box; min-height:140px; resize:vertical;
  background:var(--ide-panel); color:var(--ide-fg); border:1px solid var(--ide-border); border-radius:4px;
  padding:6px; font:400 11px/1.45 var(--dsh-font-mono, ui-monospace, monospace); }
.dsh-ide-scm-resolve-text:focus { outline:1px solid var(--ide-accent); outline-offset:-1px; }
.dsh-ide-scm-resolve-actions { display:flex; align-items:center; gap:8px; }
.dsh-ide-scm-note { padding:5px 10px; color:var(--ide-fg-dim); background:var(--ide-panel-2);
  border-bottom:1px solid var(--ide-border); font:400 10.5px/1.4 var(--dsh-font-ui, system-ui, sans-serif); }
.dsh-ide-scm-error { padding:6px 10px; color:var(--ide-error);
  font:400 10.5px/1.4 var(--dsh-font-ui, system-ui, sans-serif); }
.dsh-ide-scm-link { margin-left:6px; border:0; background:transparent; padding:0; color:var(--ide-accent);
  cursor:pointer; font:inherit; text-decoration:underline; }
.dsh-ide-scm-clean { padding:10px; color:var(--ide-fg-dim); }
.dsh-ide-scm-history { flex:0 0 auto; max-height:46%; display:flex; flex-direction:column; min-height:0;
  border-top:1px solid var(--ide-border); }
.dsh-ide-scm-history-toggle { display:flex; align-items:center; gap:6px; width:100%; padding:5px 10px; border:0;
  background:var(--ide-panel-2); color:inherit; cursor:pointer; text-align:left;
  font:600 10px/1.5 var(--dsh-font-ui, system-ui, sans-serif); text-transform:uppercase; letter-spacing:.4px; }
.dsh-ide-scm-history-toggle:hover { background:var(--ide-hover); }
.dsh-ide-scm-history-toggle:focus-visible { outline:1px solid var(--ide-accent); outline-offset:-1px; }
.dsh-ide-scm-history-title { color:var(--ide-fg-dim); }
.dsh-ide-scm-history-count { color:var(--ide-fg-dim); }
.dsh-ide-scm-history-chevron { margin-left:auto; color:var(--ide-fg-dim); }
.dsh-ide-scm-graph { min-height:0; display:flex; flex-direction:column; }
.dsh-ide-scm-graph-list { min-height:0; overflow:auto; }
.dsh-ide-scm-graph-row { display:flex; align-items:stretch; border-top:1px solid rgba(60, 60, 60, .45); }
.dsh-ide-scm-graph-row:hover { background:var(--ide-hover); }
.dsh-ide-scm-graph-row-active { background:var(--ide-select); box-shadow:inset 3px 0 0 var(--ide-accent); }
.dsh-ide-scm-graph-row-active .dsh-ide-scm-graph-subject { font-weight:600; }
.dsh-ide-scm-selected .dsh-ide-scm-section-head { padding-top:6px; }
.dsh-ide-scm-selected .dsh-ide-scm-commit-summary { border-bottom:1px solid var(--ide-border); }
.dsh-ide-scm-selected .dsh-ide-scm-back { margin-top:5px; }
.dsh-ide-scm-graph-svg { flex:0 0 auto; display:block; }
.dsh-ide-scm-graph-commit { flex:1 1 auto; min-width:0; display:flex; flex-direction:column; align-items:flex-start;
  gap:1px; padding:2px 6px 2px 2px; border:0; background:transparent; color:inherit; cursor:pointer;
  text-align:left; font:inherit; }
.dsh-ide-scm-graph-commit:focus-visible { outline:1px solid var(--ide-accent); outline-offset:-1px; }
.dsh-ide-scm-graph-subject { max-width:100%; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.dsh-ide-scm-graph-meta { max-width:100%; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
  color:var(--ide-fg-dim); font:400 9.5px/1.4 var(--dsh-font-mono, ui-monospace, monospace); }
.dsh-ide-scm-graph-refs { max-width:100%; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
  padding:0 4px; margin-top:1px; border-radius:3px; background:var(--ide-active); color:var(--ide-fg);
  font:400 9.5px/1.5 var(--dsh-font-mono, ui-monospace, monospace); }
.dsh-ide-scm-graph-note { padding:6px 10px; color:var(--ide-fg-dim);
  font:400 10.5px/1.45 var(--dsh-font-ui, system-ui, sans-serif); }
.dsh-ide-scm-more { margin:6px 10px; padding:3px 8px; border:1px solid var(--ide-border); border-radius:4px;
  background:var(--ide-panel); color:var(--ide-fg); cursor:pointer;
  font:400 11px/1.5 var(--dsh-font-ui, system-ui, sans-serif); }
.dsh-ide-scm-more:hover:not(:disabled) { border-color:var(--ide-accent); }
.dsh-ide-scm-more:disabled { opacity:.5; cursor:default; }
.dsh-ide-scm-back { border:0; background:transparent; padding:0; color:var(--ide-accent); cursor:pointer;
  font:inherit; text-transform:none; letter-spacing:0; }
.dsh-ide-scm-commit-summary { padding:8px 10px; border-bottom:1px solid var(--ide-border); }
.dsh-ide-scm-commit-subject { font-weight:600; overflow-wrap:anywhere; }
.dsh-ide-scm-commit-oid { margin-top:2px; color:var(--ide-fg-dim);
  font:400 10px/1.4 var(--dsh-font-mono, ui-monospace, monospace); overflow-wrap:anywhere; }
.dsh-ide-scm-commit-base, .dsh-ide-scm-parent { display:flex; align-items:center; gap:6px; margin-top:6px;
  color:var(--ide-fg-dim); font:400 10.5px/1.4 var(--dsh-font-ui, system-ui, sans-serif); }
.dsh-ide-scm-parent { flex-direction:column; align-items:stretch; gap:2px; }
.dsh-ide-scm-parent select { flex:1 1 auto; min-width:0; padding:2px 4px; color:var(--ide-fg);
  background:var(--ide-bg); border:1px solid var(--ide-border); border-radius:3px;
  font:400 10.5px/1.5 var(--dsh-font-mono, ui-monospace, monospace); }
.dsh-ide-scm-files { overflow:auto; padding:4px 0; }
.dsh-ide-scm-file { display:flex; align-items:center; gap:6px; width:100%; padding:3px 10px; border:0;
  background:transparent; color:inherit; cursor:pointer; text-align:left; font:inherit; }
.dsh-ide-scm-file:hover { background:var(--ide-hover); }
.dsh-ide-scm-file:focus-visible { outline:1px solid var(--ide-accent); outline-offset:-1px; }
.dsh-ide-scm-file-path { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
  font:400 11px/1.5 var(--dsh-font-mono, ui-monospace, monospace); }
.dsh-ide-gitdiff-head { flex-wrap:wrap; row-gap:4px; align-items:flex-start; padding:6px 8px; }
.dsh-ide-gitdiff-titles { display:flex; align-items:center; gap:6px; min-width:0; flex:1 1 240px; }
.dsh-ide-gitdiff-caption { display:flex; flex-direction:column; gap:1px; min-width:0; }
.dsh-ide-gitdiff-caption .dsh-ide-diffview-title { max-width:100%; }
.dsh-ide-gitdiff-caption .dsh-ide-diffview-sub { max-width:none; }
.dsh-ide-gitdiff-actions { display:flex; align-items:center; gap:4px; margin-left:auto; flex:0 0 auto; }
.dsh-ide-diffview-reason { flex:1 1 auto; display:flex; align-items:center; justify-content:center; padding:20px;
  color:var(--ide-fg-dim); text-align:center;
  font:400 12px/1.5 var(--dsh-font-ui, system-ui, sans-serif); }
.dsh-ide-root[data-compact] .dsh-ide-scm-row { padding-top:4px; padding-bottom:4px; }
.dsh-ide-root[data-compact] .dsh-ide-scm-row-main { min-height:34px; }
.dsh-ide-root[data-compact] .dsh-ide-scm-action { width:34px; height:34px; }
.dsh-ide-root[data-compact] .dsh-ide-scm-branch { min-height:34px; }
.dsh-ide-root[data-compact] .dsh-ide-scm-branch-pick { min-height:34px; }
.dsh-ide-root[data-compact] .dsh-ide-scm-branch-delete { width:34px; height:34px; }
.dsh-ide-root[data-compact] .dsh-ide-scm-branches { max-height:52%; }
.dsh-ide-root[data-compact] .dsh-ide-diffview-action { min-height:32px; }
.dsh-ide-root[data-compact] .dsh-ide-scm-history { max-height:52%; }
.dsh-ide-root[data-compact] .dsh-ide-gitdiff .dsh-ide-diffview-title,
.dsh-ide-root[data-compact] .dsh-ide-gitdiff .dsh-ide-diffview-sub { max-width:100%; }
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
.dsh-ide-row-more { color:var(--ide-muted); font-size:11px; font-style:italic; }
.dsh-ide-row-more:hover:not(:disabled) { color:var(--ide-accent); }
.dsh-ide-row-more:disabled { cursor:default; opacity:.7; }
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
.dsh-ide-hint-elapsed { font-variant-numeric:tabular-nums; }
.dsh-ide-hint-elapsed[hidden] { display:none; }
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
.dsh-ide-split { display:flex; flex-direction:column; width:50%; min-width:0; min-height:0; border-left:1px solid var(--ide-border); background:var(--ide-bg); }
.dsh-ide-split-head { display:flex; align-items:center; gap:6px; padding:3px 8px; min-height:24px; border-bottom:1px solid var(--ide-border); background:var(--ide-panel); }
.dsh-ide-split-title { flex:1 1 auto; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:11px; text-align:left; background:none; border:0; color:var(--ide-fg); cursor:pointer; padding:0; }
.dsh-ide-split-title:hover { text-decoration:underline; }
.dsh-ide-split-dirty { color:#d19a66; font-size:10px; }
.dsh-ide-split-action { flex:0 0 auto; font-size:11px; color:var(--ide-muted); background:none; border:1px solid transparent; border-radius:3px; padding:1px 6px; cursor:pointer; }
.dsh-ide-split-action:hover { color:var(--ide-fg); border-color:var(--ide-border); }
.dsh-ide-split-action:disabled { opacity:.5; cursor:default; }
.dsh-ide-split-stage { flex:1 1 auto; min-height:0; }
.dsh-ide-root[data-compact] .dsh-ide-split { display:none; }
.dsh-ide-next-card { position:absolute; right:12px; bottom:12px; z-index:5; display:flex; align-items:center; gap:6px; max-width:min(420px, 80%); padding:6px 8px; border:1px solid var(--ide-border); border-radius:6px; background:var(--ide-panel); box-shadow:0 4px 14px rgba(0,0,0,.18); font-size:11px; }
.dsh-ide-next-text { color:var(--ide-muted); flex:0 0 auto; }
.dsh-ide-next-path { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; background:none; border:0; color:var(--ide-accent); cursor:pointer; padding:0; font-size:11px; }
.dsh-ide-next-path:hover { text-decoration:underline; }
.dsh-ide-next-close { flex:0 0 auto; background:none; border:0; color:var(--ide-muted); cursor:pointer; font-size:13px; line-height:1; padding:0 2px; }
.dsh-ide-next-close:hover { color:var(--ide-fg); }
.dsh-ide-symbol-card { position:absolute; right:12px; bottom:12px; z-index:6; display:flex; flex-direction:column; width:min(560px, 90%); max-height:60%; border:1px solid var(--ide-border); border-radius:6px; background:var(--ide-panel); box-shadow:0 8px 24px rgba(0,0,0,.24); }
.dsh-ide-symbol-head { display:flex; align-items:center; gap:8px; padding:6px 8px; border-bottom:1px solid var(--ide-border); }
.dsh-ide-symbol-title { font-weight:600; font-size:12px; color:var(--ide-fg); }
.dsh-ide-symbol-count { flex:1 1 auto; color:var(--ide-muted); font-size:11px; }
.dsh-ide-symbol-list { overflow:auto; min-height:0; }
.dsh-ide-symbol-row { display:flex; align-items:baseline; gap:8px; width:100%; text-align:left; padding:3px 8px; border:0; border-bottom:1px solid var(--ide-border); background:none; color:var(--ide-fg); cursor:pointer; font-size:11px; }
.dsh-ide-symbol-row:hover { background:var(--ide-hover); }
.dsh-ide-symbol-kind { flex:0 0 auto; color:var(--ide-muted); }
.dsh-ide-symbol-kind.definition { color:var(--ide-accent); }
.dsh-ide-symbol-where { flex:0 0 auto; max-width:45%; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:var(--ide-accent); }
.dsh-ide-symbol-text { flex:1 1 auto; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:var(--ide-muted); }
.dsh-ide-symbol-note { padding:5px 8px; color:var(--ide-muted); font-size:10px; border-top:1px solid var(--ide-border); }
.dsh-ide-blame-record { padding:6px 8px; border-bottom:1px solid var(--ide-border); display:flex; flex-direction:column; gap:3px; }
.dsh-ide-blame-where { font-size:10px; color:var(--ide-muted); }
.dsh-ide-blame-instruction { font-size:11px; white-space:pre-wrap; }
.dsh-ide-blame-conversation summary { cursor:pointer; font-size:10.5px; color:var(--ide-accent); }
.dsh-ide-blame-conversation pre { margin:4px 0 0; max-height:160px; overflow:auto; white-space:pre-wrap; font-size:10px; }
.dsh-ide-symbol-form { display:flex; align-items:center; gap:6px; padding:6px 8px; border-bottom:1px solid var(--ide-border); }
.dsh-ide-symbol-input { flex:1 1 auto; min-width:0; padding:3px 6px; font-size:12px; color:var(--ide-fg); background:var(--ide-bg); border:1px solid var(--ide-border); border-radius:3px; }
.dsh-ide-symbol-input:focus { outline:none; border-color:var(--ide-accent); }
.dsh-ide-symbol-action { flex:0 0 auto; padding:3px 8px; font-size:11px; color:var(--ide-fg); background:var(--ide-hover); border:1px solid var(--ide-border); border-radius:3px; cursor:pointer; }
.dsh-ide-symbol-action:hover { border-color:var(--ide-accent); }
.dsh-ide-symbol-output { border-top:1px solid var(--ide-border); font-size:10px; color:var(--ide-muted); }
.dsh-ide-symbol-output summary { padding:4px 8px; cursor:pointer; }
.dsh-ide-symbol-output pre { margin:0; padding:6px 8px; max-height:180px; overflow:auto; white-space:pre-wrap; word-break:break-word; }
.dsh-ide-stage-fallback { position:absolute; inset:0; z-index:2; display:flex; flex-direction:column; overflow:auto; background:var(--ide-bg); }
.dsh-ide-stage-fallback-head { display:flex; flex-direction:column; gap:6px; padding:12px 14px; border-bottom:1px solid var(--ide-border); }
.dsh-ide-stage-fallback-title { color:var(--ide-text); font:600 13px/1.4 var(--dsh-font-ui, system-ui, sans-serif); }
.dsh-ide-stage-fallback-text { color:var(--ide-muted); font-size:11.5px; line-height:1.5; overflow-wrap:anywhere; }
.dsh-ide-stage-fallback-actions { display:flex; gap:8px; margin-top:2px; }
.dsh-ide-stage-fallback-code { margin:0; padding:10px 14px 48px; color:var(--ide-text); white-space:pre; tab-size:2;
  font:12px/1.55 var(--ide-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace); }
.dsh-ide-root[data-compact] .dsh-ide-stage-fallback-title { font-size:14px; }
.dsh-ide-root[data-compact] .dsh-ide-stage-fallback-text { font-size:12.5px; }
.dsh-ide-root[data-compact] .dsh-ide-stage-fallback-code { font-size:13px; line-height:1.6; }
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
.dsh-ide-panel-tool { min-height:0; overflow:auto; flex:1; }
.dsh-ide-panel-tool > .dsh-ide-modal-card { box-sizing:border-box; max-height:none; max-width:none; border:0; border-radius:0; box-shadow:none; }
.dsh-ide-panel-head { overflow-x:auto; white-space:nowrap; }
.dsh-ide-panel-body { flex:1 1 auto; min-height:0; overflow:auto; padding:4px 0; font:400 11.5px/1.55 var(--ide-font); }
.dsh-ide-panel-empty { color:var(--ide-fg-dim); padding:8px 12px; }
.dsh-ide-context-menu { position:fixed; z-index:1000; min-width:168px; padding:4px; border:1px solid var(--ide-border); border-radius:7px; background:var(--ide-panel-2); box-shadow:0 10px 28px rgba(0,0,0,.35); }
.dsh-ide-context-item { display:block; width:100%; padding:5px 9px; border:0; border-radius:5px; background:transparent; color:var(--ide-text); font:12px/1.4 var(--dsw-font-family,inherit); text-align:left; cursor:pointer; }
.dsh-ide-context-item:hover { background:var(--ide-active); }
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
.dsh-ide-trace-pending { color:#d9a441; flex:0 0 auto; }
.dsh-ide-chat { padding:6px 12px 10px; }
.dsh-ide-chat-label { color:var(--ide-fg-dim); text-transform:uppercase; letter-spacing:.4px; font-size:10px; margin:8px 0 3px; }
.dsh-ide-chat-text { margin:0; white-space:pre-wrap; word-break:break-word; font:400 11.5px/1.5 var(--ide-mono); color:var(--ide-fg); max-height:120px; overflow:auto; background:var(--ide-bg); border:1px solid var(--ide-border); border-radius:4px; padding:6px 8px; }
.dsh-ide-pty { display:flex; flex-direction:column; min-height:0; flex:1; position:relative; }
.dsh-ide-pty-strip { display:flex; align-items:center; gap:8px; padding:0 6px; height:26px; flex:0 0 auto; border-bottom:1px solid var(--ide-border); overflow-x:auto; white-space:nowrap; }
.dsh-ide-pty-actions { display:flex; align-items:center; gap:6px; flex:0 0 auto; }
.dsh-ide-pty-new { border:1px solid var(--ide-border); border-radius:4px; background:transparent; color:var(--ide-fg); font:600 12px/1 var(--ide-font); padding:2px 7px; cursor:pointer; }
.dsh-ide-pty-new:hover { background:var(--ide-hover); }
.dsh-ide-pty-tabs { display:flex; align-items:center; gap:2px; min-width:0; }
.dsh-ide-pty-tab { display:flex; align-items:center; gap:4px; border:none; background:transparent; color:var(--ide-fg-dim); font:400 11px/1.5 var(--ide-font); padding:2px 4px 2px 8px; cursor:pointer; border-radius:4px; }
.dsh-ide-pty-tab:hover { background:var(--ide-hover); color:var(--ide-fg); }
.dsh-ide-pty-tab-active { background:var(--ide-active); color:var(--ide-fg); }
.dsh-ide-pty-dead { color:var(--ide-fg-dim); font-style:italic; }
.dsh-ide-pty-close { color:var(--ide-fg-dim); font-size:12px; line-height:1; padding:0 3px; border-radius:3px; }
.dsh-ide-pty-close:hover { color:var(--ide-fg); background:var(--ide-border); }
.dsh-ide-pty-empty { color:var(--ide-fg-dim); font:400 11px/1.6 var(--ide-font); padding:0 6px; }
.dsh-ide-pty-error { color:#f48771; font:400 11px/1.4 var(--ide-font); padding-right:8px; overflow:hidden; text-overflow:ellipsis; }
.dsh-ide-pty-screens { min-height:0; flex:1; position:relative; background:var(--ide-bg); }
.dsh-ide-pty-screen { position:absolute; inset:0; padding:2px 4px; overflow:hidden; }
.dsh-ide-pty-screen .xterm { height:100%; }
.dsh-ide-pty-blank { color:var(--ide-fg-dim); padding:10px 12px; font:400 11.5px/1.5 var(--ide-font); }
.dsh-ide-pty-profiles { position:absolute; z-index:40; top:24px; left:6px; min-width:180px; padding:4px; border:1px solid var(--ide-border); border-radius:7px; background:var(--ide-panel-2); box-shadow:0 10px 28px rgba(0,0,0,.35); }
.dsh-ide-pty-profile { display:block; width:100%; padding:5px 9px; border:0; border-radius:5px; background:transparent; color:var(--ide-text); font:12px/1.4 var(--dsw-font-family,inherit); text-align:left; cursor:pointer; }
.dsh-ide-pty-profile:hover { background:var(--ide-active); }
.dsh-ide-empty { position:absolute; inset:0; overflow:hidden; display:flex; flex-direction:column; align-items:center; justify-content:center;
  gap:6px; text-align:center; padding:16px; pointer-events:none; z-index:2; }
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
.dsh-ide-status-ask { color:#e5c07b; font-weight:600; }
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
.dsh-ide-rules-card { max-height:78%; display:flex; flex-direction:column; }
.dsh-ide-rules-head { display:flex; align-items:center; justify-content:space-between; gap:10px; }
.dsh-ide-rules-list { overflow:auto; margin:8px 0; display:flex; flex-direction:column; gap:8px; }
.dsh-ide-rules-row { border:1px solid var(--ide-border); border-radius:6px; padding:8px; }
.dsh-ide-rules-row-head { display:flex; gap:8px; align-items:baseline; justify-content:space-between; }
.dsh-ide-rules-path { font:600 12px/1.4 var(--dsh-font-mono, ui-monospace, monospace); word-break:break-all; }
.dsh-ide-rules-badge { flex:0 0 auto; font-size:10.5px; padding:1px 6px; border-radius:999px;
  background:rgba(255,255,255,.08); color:var(--ide-muted); white-space:nowrap; }
.dsh-ide-rules-badge-on { background:rgba(80,180,120,.18); color:#a6e3bb; }
.dsh-ide-rules-meta { color:var(--ide-muted); font-size:10.5px; margin-top:2px; }
.dsh-ide-rules-preview { margin:6px 0 0; padding:6px; background:var(--ide-bg); border-radius:4px;
  max-height:140px; overflow:auto; white-space:pre-wrap; font:11px/1.45 var(--dsh-font-mono, ui-monospace, monospace); }
.dsh-ide-rules-note { color:var(--ide-muted); font-size:11.5px; line-height:1.5; }
.dsh-ide-rules-failed { display:flex; flex-direction:column; gap:8px; align-items:flex-start; }
.dsh-ide-rules-foot { color:var(--ide-muted); font-size:11px; line-height:1.45;
  border-top:1px solid var(--ide-border); padding-top:8px; margin-top:8px; }
.dsh-ide-plans-card { max-height:78%; display:flex; flex-direction:column; }
.dsh-ide-plans-head { display:flex; align-items:center; justify-content:space-between; gap:10px; }
.dsh-ide-plans-list { overflow:auto; margin:8px 0; display:flex; flex-direction:column; gap:8px; }
.dsh-ide-plans-row { border:1px solid var(--ide-border); border-radius:6px; padding:8px; }
.dsh-ide-plans-title { font-weight:600; font-size:12px; word-break:break-all; }
.dsh-ide-plans-meta { color:var(--ide-muted); font-size:10.5px; margin-top:2px; }
.dsh-ide-plans-actions { display:flex; gap:8px; margin-top:8px; }
.dsh-ide-plans-note { color:var(--ide-muted); font-size:11.5px; line-height:1.5; }
.dsh-ide-plans-failed { display:flex; flex-direction:column; gap:8px; align-items:flex-start; }
.dsh-ide-plans-foot { color:var(--ide-muted); font-size:11px; line-height:1.45;
  border-top:1px solid var(--ide-border); padding-top:8px; margin-top:8px; }
.dsh-ide-plans-target { display:flex; flex-direction:column; align-items:flex-start; gap:2px; width:100%;
  background:transparent; color:inherit; text-align:left; cursor:pointer; }
.dsh-ide-plans-target:hover { border-color:var(--ide-accent); }
.dsh-ide-terminal-card { max-height:82%; display:flex; flex-direction:column; }
.dsh-ide-terminal-head { display:flex; align-items:center; justify-content:space-between; gap:10px; }
.dsh-ide-terminal-note { color:var(--ide-muted); font-size:11.5px; line-height:1.5; margin:6px 0 10px; }
.dsh-ide-terminal-field { display:flex; flex-direction:column; gap:4px; margin-bottom:8px; font-size:11px; color:var(--ide-muted); }
.dsh-ide-terminal-input, .dsh-ide-terminal-output { width:100%; box-sizing:border-box; padding:6px 8px; border-radius:4px;
  border:1px solid var(--ide-border); background:var(--ide-bg); color:inherit; font:12px/1.45 var(--dsh-font-mono, ui-monospace, monospace); }
.dsh-ide-terminal-code { max-width:120px; }
.dsh-ide-terminal-output { resize:vertical; min-height:120px; }
.dsh-ide-terminal-meta { color:var(--ide-muted); font-size:10.5px; margin:2px 0 6px; }
.dsh-ide-terminal-preview { margin:0 0 10px; padding:8px; border:1px solid var(--ide-border); border-radius:6px;
  background:var(--ide-bg); max-height:180px; overflow:auto; white-space:pre-wrap;
  font:11px/1.45 var(--dsh-font-mono, ui-monospace, monospace); }
.dsh-ide-terminal-actions { display:flex; gap:8px; justify-content:flex-end; }
.dsh-ide-debug-card { max-height:86%; display:flex; flex-direction:column; }
.dsh-ide-debug-head { display:flex; align-items:center; justify-content:space-between; gap:10px; }
.dsh-ide-debug-note { color:var(--ide-muted); font-size:11.5px; line-height:1.5; margin:6px 0 10px; }
.dsh-ide-debug-field { display:flex; flex-direction:column; gap:4px; margin-bottom:8px; font-size:11px; color:var(--ide-muted); }
.dsh-ide-debug-input, .dsh-ide-debug-text { width:100%; box-sizing:border-box; padding:6px 8px; border-radius:4px;
  border:1px solid var(--ide-border); background:var(--ide-bg); color:inherit; font:12px/1.45 var(--dsh-font-mono, ui-monospace, monospace); }
.dsh-ide-debug-text { resize:vertical; min-height:56px; }
.dsh-ide-debug-runs { display:grid; grid-template-columns:1fr 1fr; gap:8px; }
.dsh-ide-debug-check { display:flex; align-items:center; gap:6px; font-size:11.5px; color:var(--ide-muted); margin:2px 0 6px; }
.dsh-ide-debug-warn { color:#e5c07b; font-size:11px; line-height:1.45; margin-bottom:6px; }
.dsh-ide-debug-meta { color:var(--ide-muted); font-size:10.5px; margin:2px 0 6px; }
.dsh-ide-debug-preview { margin:0 0 10px; padding:8px; border:1px solid var(--ide-border); border-radius:6px;
  background:var(--ide-bg); max-height:180px; overflow:auto; white-space:pre-wrap;
  font:11px/1.45 var(--dsh-font-mono, ui-monospace, monospace); }
.dsh-ide-debug-actions { display:flex; gap:8px; justify-content:flex-end; }
.dsh-ide-notes-card { max-height:86%; display:flex; flex-direction:column; }
.dsh-ide-notes-head { display:flex; align-items:center; justify-content:space-between; gap:10px; }
.dsh-ide-notes-note { color:var(--ide-muted); font-size:11.5px; line-height:1.5; margin:6px 0 10px; }
.dsh-ide-notes-input { width:100%; box-sizing:border-box; padding:6px 8px; border-radius:4px; resize:vertical;
  border:1px solid var(--ide-border); background:var(--ide-bg); color:inherit; font:12px/1.45 var(--dsh-font-mono, ui-monospace, monospace); }
.dsh-ide-notes-actions { display:flex; align-items:center; gap:8px; margin:8px 0; }
.dsh-ide-notes-meta { color:var(--ide-muted); font-size:10.5px; margin-left:auto; }
.dsh-ide-notes-list { margin:0; padding:0 0 0 18px; max-height:180px; overflow:auto; }
.dsh-ide-notes-row { margin-bottom:4px; font-size:12px; line-height:1.45; }
.dsh-ide-notes-where { color:var(--ide-muted); font:10.5px/1.4 var(--dsh-font-mono, ui-monospace, monospace); margin-right:6px; }
.dsh-ide-notes-text { white-space:pre-wrap; }
.dsh-ide-notes-remove { border:none; background:transparent; color:var(--ide-muted); cursor:pointer; padding:0 4px; }
.dsh-ide-notes-empty { color:var(--ide-muted); font-size:11.5px; margin-bottom:8px; }
.dsh-ide-notes-preview { margin:0 0 10px; padding:8px; border:1px solid var(--ide-border); border-radius:6px;
  background:var(--ide-bg); max-height:160px; overflow:auto; white-space:pre-wrap;
  font:11px/1.45 var(--dsh-font-mono, ui-monospace, monospace); }
.dsh-ide-notes-footer { display:flex; gap:8px; justify-content:flex-end; }
.dsh-ide-tour-card { max-height:82%; display:flex; flex-direction:column; }
.dsh-ide-tour-head { display:flex; align-items:center; justify-content:space-between; gap:10px; }
.dsh-ide-tour-note { color:var(--ide-muted); font-size:11px; line-height:1.5; margin:6px 0 10px; }
.dsh-ide-tour-actions { display:flex; gap:8px; align-items:center; margin-bottom:8px; }
.dsh-ide-tour-input { flex:1 1 auto; min-width:0; padding:5px 8px; border-radius:4px;
  border:1px solid var(--ide-border); background:var(--ide-bg); color:inherit; font-size:12px; }
.dsh-ide-tour-list { list-style:none; margin:0 0 8px; padding:0; max-height:240px; overflow:auto; }
.dsh-ide-tour-row { display:flex; align-items:center; gap:6px; padding:3px 4px; border-radius:4px; font-size:12px; }
.dsh-ide-tour-row-current { background:var(--ide-hover, rgba(127,127,127,.12)); }
.dsh-ide-tour-open { flex:0 0 auto; border:none; background:transparent; color:var(--ide-accent, #61afef);
  cursor:pointer; font:11px/1.4 var(--dsh-font-mono, ui-monospace, monospace); padding:0; text-align:left; }
.dsh-ide-tour-text { flex:1 1 auto; min-width:0; color:var(--ide-muted); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.dsh-ide-tour-row-actions { flex:0 0 auto; display:flex; gap:2px; }
.dsh-ide-tour-move { border:none; background:transparent; color:var(--ide-muted); cursor:pointer; padding:0 4px; }
.dsh-ide-tour-move:disabled { opacity:.35; cursor:default; }
.dsh-ide-tour-empty { color:var(--ide-muted); font-size:11.5px; margin-bottom:8px; }
.dsh-ide-tour-footer { display:flex; gap:8px; align-items:center; justify-content:flex-end; }
.dsh-ide-tour-meta { margin-right:auto; color:var(--ide-muted); font-size:11px; }
.dsh-ide-worktree-card { max-height:82%; display:flex; flex-direction:column; }
.dsh-ide-worktree-head { display:flex; align-items:center; justify-content:space-between; gap:10px; }
.dsh-ide-worktree-note { color:var(--ide-muted); font-size:11px; line-height:1.5; margin:6px 0 10px; }
.dsh-ide-worktree-error { color:var(--ide-danger, #f14c4c); font-size:11.5px; margin:6px 0; }
.dsh-ide-worktree-list { overflow:auto; max-height:240px; border:1px solid var(--ide-border); border-radius:6px; margin-bottom:10px; }
.dsh-ide-worktree-row { display:flex; align-items:center; justify-content:space-between; gap:8px; padding:6px 8px; border-top:1px solid var(--ide-border); }
.dsh-ide-worktree-row:first-child { border-top:none; }
.dsh-ide-worktree-main { min-width:0; }
.dsh-ide-worktree-path { font:11px/1.4 var(--dsh-font-mono, ui-monospace, monospace); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.dsh-ide-worktree-meta { color:var(--ide-muted); font-size:10.5px; margin-top:2px; }
.dsh-ide-worktree-form { display:flex; flex-direction:column; gap:8px; }
.dsh-ide-worktree-field { display:flex; flex-direction:column; gap:3px; font-size:11px; color:var(--ide-muted); }
.dsh-ide-worktree-check { display:flex; align-items:center; gap:6px; font-size:11.5px; color:var(--ide-muted); }
.dsh-ide-worktree-form .dsh-ide-button-primary { align-self:flex-start; }
.dsh-ide-explore-card { max-height:82%; display:flex; flex-direction:column; }
.dsh-ide-explore-head { display:flex; align-items:center; justify-content:space-between; gap:10px; }
.dsh-ide-explore-title { font-weight:600; font-size:12px; }
.dsh-ide-explore-close { background:transparent; border:0; color:var(--ide-muted); cursor:pointer; font-size:16px; line-height:1; }
.dsh-ide-explore-input { width:100%; box-sizing:border-box; margin:8px 0; padding:6px 8px; border-radius:4px;
  border:1px solid var(--ide-border); background:var(--ide-bg); color:inherit; font:400 12.5px/1.4 var(--dsh-font-ui, system-ui, sans-serif); }
.dsh-ide-explore-actions { display:flex; align-items:center; gap:10px; }
.dsh-ide-explore-ask { padding:4px 10px; }
.dsh-ide-explore-note { color:var(--ide-muted); font-size:10.5px; line-height:1.45; }
.dsh-ide-explore-error { color:var(--ide-danger, #f14c4c); font-size:11.5px; margin-top:8px; }
.dsh-ide-explore-result { overflow:auto; margin-top:10px; }
.dsh-ide-explore-answer { margin:0 0 8px; white-space:pre-wrap; font:11.5px/1.5 var(--dsh-font-ui, system-ui, sans-serif); }
.dsh-ide-explore-sources-head { color:var(--ide-muted); font-size:10.5px; margin-bottom:4px; }
.dsh-ide-explore-sources { display:flex; flex-wrap:wrap; gap:6px; }
.dsh-ide-explore-source { padding:2px 6px; border:1px solid var(--ide-border); border-radius:4px;
  background:transparent; color:inherit; cursor:pointer; font:10.5px/1.4 var(--dsh-font-mono, ui-monospace, monospace); }
.dsh-ide-explore-source:hover { border-color:var(--ide-accent); }
.dsh-ide-explore-meta { color:var(--ide-muted); font-size:10.5px; margin-top:8px; }
.dsh-ide-explore-foot { color:var(--ide-muted); font-size:10.5px; line-height:1.45;
  border-top:1px solid var(--ide-border); padding-top:8px; margin-top:8px; }
.dsh-ide-conv-card { width:min(640px, 94vw); max-height:82vh; display:flex; flex-direction:column; }
.dsh-ide-conv-result { overflow:auto; margin-top:8px; }
.dsh-ide-conv-list { display:flex; flex-direction:column; gap:6px; }
.dsh-ide-conv-hit { display:flex; flex-direction:column; gap:3px; text-align:left; width:100%;
  padding:8px 10px; border:1px solid var(--ide-border); border-radius:6px; background:transparent;
  color:inherit; cursor:pointer; }
.dsh-ide-conv-hit:hover { border-color:var(--ide-accent); }
.dsh-ide-conv-snippet { font-size:12px; line-height:1.45; white-space:pre-wrap; }
.dsh-ide-conv-meta { color:var(--ide-muted); font-size:10.5px; }
.dsh-ide-conv-row { display:flex; gap:6px; align-items:stretch; }
.dsh-ide-conv-row .dsh-ide-conv-hit { flex:1 1 auto; min-width:0; }
.dsh-ide-conv-attach { flex:0 0 auto; align-self:stretch; padding:0 10px; border:1px solid var(--ide-border);
  border-radius:6px; background:transparent; color:inherit; cursor:pointer; font-size:11px; }
.dsh-ide-conv-attach:hover:not(:disabled) { border-color:var(--ide-accent); }
.dsh-ide-conv-attach:disabled { opacity:.45; cursor:default; }
.dsh-ide-conv-source-title { font-weight:600; margin-top:4px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.dsh-ide-conv-source-text { margin:8px 0 0; padding:8px 10px; border:1px solid var(--ide-border); border-radius:6px;
  background:var(--ide-bg); font:11px/1.5 var(--dsh-font-mono, ui-monospace, monospace);
  white-space:pre-wrap; overflow:auto; max-height:280px; }
.dsh-ide-side-card { width:min(520px, 92vw); max-height:82vh; display:flex; flex-direction:column; padding:12px; gap:8px; }
.dsh-ide-side-head { display:flex; align-items:center; justify-content:space-between; }
.dsh-ide-side-title { font-weight:600; }
.dsh-ide-side-close { border:none; background:transparent; color:inherit; cursor:pointer; font-size:16px; line-height:1; padding:2px 6px; }
.dsh-ide-side-context { border:1px solid var(--ide-border); border-radius:4px; padding:6px 8px; background:var(--ide-bg); }
.dsh-ide-side-where { color:var(--ide-muted); font:10.5px/1.4 var(--dsh-font-mono, ui-monospace, monospace); margin-bottom:4px; }
.dsh-ide-side-selection { margin:0; max-height:110px; overflow:auto; white-space:pre-wrap; font:11px/1.45 var(--dsh-font-mono, ui-monospace, monospace); }
.dsh-ide-side-turns { overflow:auto; display:flex; flex-direction:column; gap:8px; max-height:36vh; }
.dsh-ide-side-turn { border-left:2px solid var(--ide-accent); padding-left:8px; }
.dsh-ide-side-question { font-weight:600; margin-bottom:2px; }
.dsh-ide-side-answer { white-space:pre-wrap; }
.dsh-ide-side-error { color:#e06c75; }
.dsh-ide-side-input { width:100%; padding:6px 8px; border-radius:4px; color:inherit; background:var(--ide-bg);
  border:1px solid var(--ide-border); font:400 13px/1.4 var(--dsh-font-ui, system-ui, sans-serif); outline:none; }
.dsh-ide-side-input:focus { border-color:var(--ide-accent); }
.dsh-ide-side-actions { display:flex; gap:6px; align-items:center; }
.dsh-ide-side-ask, .dsh-ide-side-new { padding:4px 10px; border-radius:4px; border:1px solid var(--ide-border); background:transparent; color:inherit; cursor:pointer; }
.dsh-ide-side-ask { border-color:var(--ide-accent); }
.dsh-ide-side-ask:disabled, .dsh-ide-side-new:disabled { opacity:.5; cursor:default; }
.dsh-ide-side-foot { color:var(--ide-muted); font-size:10.5px; line-height:1.45; border-top:1px solid var(--ide-border); padding-top:8px; }
.dsh-ide-quick { padding:8px; max-height:70%; display:flex; flex-direction:column; }
.dsh-ide-quick-input { width:100%; padding:6px 8px; border-radius:4px; color:inherit; background:var(--ide-bg);
  border:1px solid var(--ide-accent); font:400 13px/1.4 var(--dsh-font-ui, system-ui, sans-serif); outline:none; }
.dsh-ide-quick-list { margin-top:6px; overflow:auto; }
.dsh-ide-quick-row { display:flex; align-items:center; gap:6px; width:100%; border:0; background:transparent; color:inherit;
  text-align:left; cursor:pointer; padding:3px 6px; border-radius:4px; font:inherit; }
.dsh-ide-quick-row-active { background:var(--ide-active); }
.dsh-ide-picker-title { font:600 11px/1.3 var(--dsh-font-ui, system-ui, sans-serif); color:var(--ide-muted); padding:2px 2px 6px; }
.dsh-ide-picker-head { display:flex; gap:4px; margin-bottom:6px; }
.dsh-ide-picker-head-item { flex:1; border:1px solid var(--ide-border); background:transparent; color:inherit; font:inherit; border-radius:4px; padding:4px 6px; cursor:pointer; }
.dsh-ide-picker-head-item-active { background:var(--ide-active); }
.dsh-ide-picker-check { width:14px; flex:none; text-align:center; opacity:.9; margin-left:auto; }
.dsh-ide-picker-row-off { opacity:.45; cursor:default; }
.dsh-ide-picker .dsh-ide-quick-list { min-height:80px; }
.dsh-ide-action { display:inline-flex; align-items:center; gap:4px; }
.dsh-ide-action-button { display:inline-flex; align-items:center; gap:5px; font:600 10.5px/1.25 var(--dsw-font-family, var(--dsh-font-ui, system-ui, sans-serif));
  color:var(--dsw-alias-label-secondary, inherit); background:var(--dsw-alias-bg-layer-1, transparent);
  border:1px solid var(--dsw-alias-border-l2, var(--dsh-border, rgba(127,127,127,.35))); border-radius:7px;
  padding:3px 8px 3px 6px; cursor:pointer;
  transition:color .12s ease, background .12s ease, border-color .12s ease; }
.dsh-ide-action-button:hover:not(:disabled) { color:var(--dsw-alias-label-primary, inherit);
  background:var(--dsw-alias-bg-layer-2, var(--dsh-hover, rgba(127,127,127,.14))); }
.dsh-ide-action-button:focus-visible { outline:2px solid var(--dsw-alias-brand-primary, #4c8dff); outline-offset:1px; }
.dsh-ide-action-button[data-open="true"] { color:var(--dsw-alias-brand-primary, #4c8dff);
  border-color:var(--dsw-alias-brand-primary, #4c8dff); background:var(--dsw-alias-bg-layer-2, rgba(127,127,127,.14)); }
.dsh-ide-action-button[data-open="true"]::after { content:''; width:5px; height:5px; border-radius:50%;
  background:currentColor; margin-left:1px; }
.dsh-ide-action-icon { width:14px; height:14px; flex:none; opacity:.85; }
.dsh-ide-action-button[data-open="true"] .dsh-ide-action-icon { opacity:1; }
.dsh-ide-action-label { white-space:nowrap; }
.dsh-ide-action-button:disabled { opacity:.5; cursor:default; }
.dsh-ide-action-error { color:#d9534f; font-weight:700; cursor:help; }
.dsh-ide-action-compact .dsh-ide-action-button { padding:2px 7px 2px 5px; font-size:10.5px; line-height:1.3;
  letter-spacing:.15px; text-transform:none; border-radius:6px; }
.dsh-ide-action-compact .dsh-ide-action-icon { width:13px; height:13px; }

/* ------------------------------------------------------------- phone layout */

/*
 * The pane, not the window, decides the layout: on a phone it is the whole
 * screen, on a desktop it may be a 400px column. Rules therefore key off
 * data-compact / data-touch on the root element instead of viewport media
 * queries, and only apply when the measured pane is narrow or the pointer is
 * coarse. The desktop layout above is never touched.
 */
.dsh-ide-compact-only { display:none; }
.dsh-ide-root { overscroll-behavior:contain; -webkit-tap-highlight-color:transparent; }
.dsh-ide-root button, .dsh-ide-root input, .dsh-ide-root textarea { touch-action:manipulation; }
.dsh-ide-divider, .dsh-ide-panel-resize { touch-action:none; }
.dsh-ide-tabs, .dsh-ide-tree, .dsh-ide-quick-list, .dsh-ide-settings-content, .dsh-ide-settings-nav,
.dsh-ide-chat-text { overscroll-behavior:contain; }

.dsh-ide-root[data-compact] .dsh-ide-body { position:relative; }
/* Keep Monaco's own z-indexed widgets inside the editor so the drawer and the
   scrim always paint over them. */
.dsh-ide-root[data-compact] .dsh-ide-editor { z-index:1; }
.dsh-ide-root[data-compact] .dsh-ide-compact-only { display:inline-flex; align-items:center; justify-content:center;
  flex:0 0 auto; width:38px; height:38px; padding:0; }
.dsh-ide-root[data-compact] .dsh-ide-compact-only .dsh-ide-activity-glyph { font-size:18px; }
.dsh-ide-root[data-compact] .dsh-ide-mobile-explorer { order:0; }
.dsh-ide-root[data-compact] .dsh-ide-mobile-menu { order:2; }
.dsh-ide-root[data-compact] .dsh-ide-mobile-quick { order:3; }
.dsh-ide-root[data-compact] .dsh-ide-mobile-settings { order:4; }

/* One compact top bar: drawer toggle, file name, commands, open, settings. */
.dsh-ide-root[data-compact] .dsh-ide-top { gap:2px; padding:2px 6px; min-height:44px; }
.dsh-ide-root[data-compact] .dsh-ide-menubar,
.dsh-ide-root[data-compact] .dsh-ide-activity,
.dsh-ide-root[data-compact] .dsh-ide-top-swap,
.dsh-ide-root[data-compact] .dsh-ide-top-spacer,
.dsh-ide-root[data-compact] .dsh-ide-divider { display:none; }
.dsh-ide-root[data-compact] .dsh-ide-top-title { order:1; flex:1 1 auto; max-width:none; padding:0 2px;
  text-align:center; font-size:12.5px; }

/* The explorer is a drawer with a scrim; the editor keeps the whole width. */
.dsh-ide-scrim { position:absolute; inset:0; z-index:7; background:rgba(0,0,0,.45); }
.dsh-ide-root[data-compact] .dsh-ide-explorer-wrap { position:absolute; top:0; bottom:0; left:0; z-index:8;
  width:min(88%, 340px); border-right:1px solid var(--ide-border); box-shadow:10px 0 28px rgba(0,0,0,.5); }
.dsh-ide-root[data-compact] .dsh-ide-explorer-wrap.dsh-ide-explorer-right { left:auto; right:0;
  border-right:0; border-left:1px solid var(--ide-border); box-shadow:-10px 0 28px rgba(0,0,0,.5); }
.dsh-ide-root[data-compact] .dsh-ide-explorer-wrap.dsh-ide-explorer-closed { display:none; }
.dsh-ide-root[data-compact] .dsh-ide-explorer-head { padding:8px 10px 4px; }
.dsh-ide-root[data-compact] .dsh-ide-explorer-actions .dsh-ide-icon-button { width:32px; height:32px;
  display:inline-flex; align-items:center; justify-content:center; }
.dsh-ide-root[data-compact] .dsh-ide-explorer-search { padding:0 10px 8px; }
.dsh-ide-root[data-compact] .dsh-ide-search-input { padding:8px 9px; font-size:16px; }
.dsh-ide-root[data-compact] .dsh-ide-search-toggle { padding:6px 8px; font-size:12px; }
.dsh-ide-root[data-compact] .dsh-ide-search-file-head { padding:8px 10px 4px; }
.dsh-ide-root[data-compact] .dsh-ide-search-file-name { font-size:12.5px; }
.dsh-ide-root[data-compact] .dsh-ide-search-row { min-height:38px; }
.dsh-ide-root[data-compact] .dsh-ide-search-hit { padding-top:7px; padding-bottom:7px; }
.dsh-ide-root[data-compact] .dsh-ide-search-preview { font-size:12px; }
.dsh-ide-root[data-compact] .dsh-ide-tree { padding:2px 0 16px; }
.dsh-ide-root[data-compact] .dsh-ide-row { min-height:38px; padding:7px 8px; gap:6px; font-size:13px; }
.dsh-ide-root[data-touch] .dsh-ide-row { min-height:36px; padding-top:6px; padding-bottom:6px; }
.dsh-ide-root[data-touch] .dsh-ide-search-toggle { min-height:32px; padding:2px 8px; }

/* Tabs and bars sized for a thumb, not for a mouse pointer. */
.dsh-ide-root[data-compact] .dsh-ide-tabs-empty { padding:10px 12px; font-size:12px; }
.dsh-ide-root[data-compact] .dsh-ide-tab { min-height:40px; max-width:65%; padding:8px 8px 8px 11px; font-size:12.5px; }
.dsh-ide-root[data-compact] .dsh-ide-tab-close { width:24px; height:24px; padding:0; font-size:12px; opacity:.75; }
.dsh-ide-root[data-compact] .dsh-ide-breadcrumbs { padding:4px 10px; font-size:11px; overflow-x:auto;
  scrollbar-width:none; }
.dsh-ide-root[data-compact] .dsh-ide-breadcrumbs::-webkit-scrollbar { display:none; }
.dsh-ide-root[data-compact] .dsh-ide-status { gap:8px; padding:4px 8px;
  padding-bottom:max(4px, env(safe-area-inset-bottom)); font-size:11px; min-height:40px; }
.dsh-ide-root[data-compact] .dsh-ide-status-lang,
.dsh-ide-root[data-compact] .dsh-ide-status-readonly,
.dsh-ide-root[data-compact] .dsh-ide-status-enc,
.dsh-ide-root[data-compact] .dsh-ide-status-eol,
.dsh-ide-root[data-compact] .dsh-ide-status-action { display:none; }
.dsh-ide-root[data-compact] .dsh-ide-status-text { max-width:30%; overflow:hidden; text-overflow:ellipsis;
  white-space:nowrap; }
/* Text size: two thumb-sized keys at the right edge of the status bar. */
.dsh-ide-zoom { display:flex; align-items:center; margin-left:2px; margin-right:-4px; }
.dsh-ide-zoom-button { min-width:34px; min-height:30px; padding:0 4px; border:0; border-radius:5px;
  background:transparent; color:#fff; font:inherit; font-size:12.5px; line-height:1;
  touch-action:manipulation; }
.dsh-ide-zoom-button:active { background:rgba(255,255,255,.22); }
.dsh-ide-zoom-value { min-width:38px; text-align:center; font-size:11px; opacity:.9;
  font-variant-numeric:tabular-nums; }
.dsh-ide-root[data-compact] .dsh-ide-consent { flex-wrap:wrap; gap:6px; padding:8px 10px; }
.dsh-ide-root[data-compact] .dsh-ide-consent-actions { flex:1 1 100%; justify-content:flex-end; }
.dsh-ide-root[data-compact] .dsh-ide-consent .dsh-ide-button { min-height:36px; }

.dsh-ide-root[data-compact] .dsh-ide-empty { gap:10px; padding:20px; }
.dsh-ide-root[data-compact] .dsh-ide-watermark { font-size:48px; }
.dsh-ide-root[data-compact] .dsh-ide-empty-title { font-size:15px; }
.dsh-ide-root[data-compact] .dsh-ide-empty-text { max-width:300px; font-size:12.5px; line-height:1.5; }
.dsh-ide-empty-actions { display:flex; gap:8px; margin-top:6px; pointer-events:auto; }
.dsh-ide-empty-actions .dsh-ide-button { min-height:40px; padding:8px 14px; font-size:12.5px; }

/* Output panel: a wide grip that can actually be caught with a finger. */
.dsh-ide-root[data-compact] .dsh-ide-panel { max-height:55vh; }
.dsh-ide-root[data-compact] .dsh-ide-panel-resize { position:relative; height:14px; margin-bottom:-14px; }
.dsh-ide-root[data-compact] .dsh-ide-panel-resize::after { content:''; position:absolute; left:50%; top:5px;
  width:36px; height:3px; margin-left:-18px; border-radius:2px; background:var(--ide-muted); opacity:.5; }
.dsh-ide-root[data-compact] .dsh-ide-panel-head { height:38px; gap:4px; padding:0 8px; }
.dsh-ide-root[data-compact] .dsh-ide-panel-tab { padding:8px 10px; font-size:11.5px; }
.dsh-ide-root[data-compact] .dsh-ide-panel-body { overscroll-behavior:contain; }

/* Long-press menus and the command sheet. */
.dsh-ide-root[data-touch] .dsh-ide-menu-item { min-height:40px; }
.dsh-ide-root[data-touch] .dsh-ide-icon-button { min-width:32px; min-height:32px; }
.dsh-ide-root[data-touch] .dsh-ide-context { max-width:calc(100vw - 12px); max-height:70vh; overflow:auto; }
.dsh-ide-root[data-compact] .dsh-ide-context { min-width:220px; padding:6px; }
.dsh-ide-root[data-compact] .dsh-ide-context .dsh-ide-menu-item { padding:10px; font-size:13px; }

.dsh-ide-sheet { position:absolute; inset:0; z-index:40; display:flex; align-items:flex-end;
  background:rgba(0,0,0,.45); }
.dsh-ide-sheet-card { display:flex; flex-direction:column; width:100%; max-height:82%;
  background:var(--ide-panel); border-top:1px solid var(--ide-border); border-radius:16px 16px 0 0;
  box-shadow:0 -12px 32px rgba(0,0,0,.5); padding-bottom:max(4px, env(safe-area-inset-bottom)); }
.dsh-ide-sheet-head { display:flex; align-items:center; justify-content:space-between; flex:0 0 auto;
  padding:10px 14px; border-bottom:1px solid var(--ide-border); }
.dsh-ide-sheet-title { font:600 14px/1.3 var(--dsh-font-ui, system-ui, sans-serif); }
.dsh-ide-sheet-close { width:34px; height:34px; border:0; border-radius:50%; background:var(--ide-panel-2);
  color:inherit; font-size:14px; cursor:pointer; }
.dsh-ide-sheet-body { flex:1 1 auto; overflow:auto; padding:2px 8px 10px; }
.dsh-ide-sheet-group { padding-top:6px; }
.dsh-ide-sheet-group-label { padding:8px 8px 3px; color:var(--ide-muted); font:600 10.5px/1.4 var(--dsh-font-ui, system-ui, sans-serif);
  text-transform:uppercase; letter-spacing:.07em; }
.dsh-ide-sheet-item { display:flex; align-items:center; justify-content:space-between; gap:12px; width:100%;
  min-height:44px; border:0; border-radius:8px; background:transparent; color:inherit; cursor:pointer;
  text-align:left; padding:10px 12px; font:400 14px/1.35 var(--dsh-font-ui, system-ui, sans-serif); }
.dsh-ide-sheet-item:hover, .dsh-ide-sheet-item:active { background:var(--ide-hover); }
.dsh-ide-sheet-item-label { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.dsh-ide-sheet-item-key { flex:0 0 auto; color:var(--ide-muted); font-size:11px; }

/* Dialogs become bottom sheets; quick open takes the screen, because the
   keyboard already eats half of it. */
.dsh-ide-root[data-compact] .dsh-ide-modal { align-items:flex-end; padding:10px;
  padding-bottom:max(10px, env(safe-area-inset-bottom)); }
.dsh-ide-root[data-compact] .dsh-ide-modal-card { max-width:none; border-radius:14px; }
.dsh-ide-root[data-compact] .dsh-ide-modal-title { font-size:15px; }
.dsh-ide-root[data-compact] .dsh-ide-modal-text { font-size:12.5px; }
.dsh-ide-root[data-compact] .dsh-ide-modal-actions { gap:8px; }
.dsh-ide-root[data-compact] .dsh-ide-modal-actions .dsh-ide-button { flex:1 1 auto; min-height:44px; }
.dsh-ide-root[data-compact] .dsh-ide-input,
.dsh-ide-root[data-compact] .dsh-ide-setting-input,
.dsh-ide-root[data-compact] .dsh-ide-quick-input { font-size:16px; }
.dsh-ide-root[data-touch] .dsh-ide-input,
.dsh-ide-root[data-touch] .dsh-ide-search-input,
.dsh-ide-root[data-touch] .dsh-ide-quick-input,
.dsh-ide-root[data-touch] .dsh-ide-setting-input { font-size:16px; }
.dsh-ide-root[data-compact] .dsh-ide-modal-top { align-items:stretch; padding:0; }
.dsh-ide-root[data-compact] .dsh-ide-modal-top .dsh-ide-modal-card { height:100%; border:0; border-radius:0;
  display:flex; flex-direction:column; }
.dsh-ide-root[data-compact] .dsh-ide-quick { max-height:none; padding:max(10px, env(safe-area-inset-top)) 10px 12px; }
.dsh-ide-root[data-compact] .dsh-ide-quick-input { padding:11px 12px; }
.dsh-ide-root[data-compact] .dsh-ide-quick-list { margin-top:8px; }
.dsh-ide-root[data-compact] .dsh-ide-quick-row { min-height:44px; padding:9px 8px; gap:8px; font-size:13px; }

/* The command palette is a sheet as well: a centred dialog would sit under the
   on-screen keyboard and hide its own list. */
.dsh-ide-root[data-compact] .dsh-ide-palette-layer { align-items:flex-start;
  padding:max(8px, env(safe-area-inset-top)) 8px 8px; }
.dsh-ide-root[data-compact] .dsh-ide-palette { width:100%; max-height:calc(100% - 16px); }
.dsh-ide-root[data-compact] .dsh-ide-palette-input { padding:11px 12px; font-size:16px; }
.dsh-ide-root[data-compact] .dsh-ide-palette-item { min-height:44px; padding:10px 12px; font-size:13px; }

/* A diff review on a phone: the header wraps into two rows, and the file list
   grows rows that a thumb can hit. Monaco itself switches to the unified view. */
.dsh-ide-root[data-compact] .dsh-ide-diffview-head { flex-wrap:wrap; gap:6px; padding:6px 8px; }
.dsh-ide-root[data-compact] .dsh-ide-diffview-title { flex:1 1 100%; font-size:12.5px; }
.dsh-ide-root[data-compact] .dsh-ide-diffview-sub,
.dsh-ide-root[data-compact] .dsh-ide-diffview-spacer { display:none; }
/* The Git comparison must name both sides even on a phone; only the
   assistant summary can drop that line. */
.dsh-ide-root[data-compact] .dsh-ide-gitdiff .dsh-ide-diffview-sub { display:block; flex:1 1 100%; max-width:100%; }
.dsh-ide-root[data-compact] .dsh-ide-diffview-action { min-height:34px; padding:6px 9px; }
.dsh-ide-root[data-compact] .dsh-ide-diffview-files { max-height:40%; }
.dsh-ide-root[data-compact] .dsh-ide-diffview-file { flex-wrap:wrap; gap:4px; padding:6px 8px; }

/* Chat transcript: bigger text and no inner scrollbar competing with the pane. */
.dsh-ide-root[data-compact] .dsh-ide-chat { padding:8px 10px 12px; }
.dsh-ide-root[data-compact] .dsh-ide-chat-text { max-height:none; font-size:12.5px; }

/* Settings: the vertical nav turns into a scrollable row of chips. */
.dsh-ide-root[data-compact] .dsh-ide-settings-head { flex-wrap:wrap; gap:6px; padding:8px 10px; }
.dsh-ide-root[data-compact] .dsh-ide-settings-head-title { order:1; flex:1 1 auto; font-size:14px; }
.dsh-ide-root[data-compact] .dsh-ide-settings-search { order:3; flex:1 1 100%; max-width:none; padding:9px 10px; }
.dsh-ide-root[data-compact] .dsh-ide-settings-close { order:2; width:36px; height:36px; }
.dsh-ide-root[data-compact] .dsh-ide-settings-tabs { gap:10px; padding:0 10px; overflow-x:auto; }
.dsh-ide-root[data-compact] .dsh-ide-settings-tabs-note { display:none; }
.dsh-ide-root[data-compact] .dsh-ide-settings-main { flex-direction:column; }
.dsh-ide-root[data-compact] .dsh-ide-settings-nav { flex:0 0 auto; flex-direction:row; gap:4px; padding:8px 10px;
  border-right:0; border-bottom:1px solid var(--ide-border); overflow-x:auto; }
.dsh-ide-root[data-compact] .dsh-ide-settings-nav-item { flex:0 0 auto; white-space:nowrap; border-radius:999px;
  padding:8px 12px; font-size:12.5px; background:var(--ide-panel-2); }
.dsh-ide-root[data-compact] .dsh-ide-settings-nav-item-active { background:var(--ide-accent); color:#fff; }
.dsh-ide-root[data-compact] .dsh-ide-settings-content { padding:4px 14px 48px; }
.dsh-ide-root[data-compact] .dsh-ide-settings-section-title { font-size:16px; }
.dsh-ide-root[data-compact] .dsh-ide-setting-desc { font-size:12px; }
.dsh-ide-root[data-compact] .dsh-ide-setting-control { flex-wrap:wrap; }
.dsh-ide-root[data-compact] .dsh-ide-setting-input { width:100%; padding:9px 10px; }
.dsh-ide-root[data-compact] .dsh-ide-setting-control input[type="checkbox"] { width:20px; height:20px; }
.dsh-ide-root[data-compact] .dsh-ide-settings-foot { flex-wrap:wrap; gap:8px; padding:10px;
  padding-bottom:max(10px, env(safe-area-inset-bottom)); }
.dsh-ide-root[data-compact] .dsh-ide-settings-foot .dsh-ide-button { min-height:42px; }
.dsh-ide-root[data-compact] .dsh-ide-model-dialog { align-items:flex-end; }
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
      // Small, pure pieces of the Git panel are testable without a browser;
      // the module loader gives the tests exactly this object.
      __test: { layoutGraph, scmSections, scmGroupsOf, scmLetter, describeScmError, terminalBlock, debugBlock, notesBlock, tourStep, tourAdd, tourMove, tourRemove, tourProgress, snoozeLabel, fileExtension, tabExtensionDisabled, splitCandidate, crossFileCandidate, diagnosticContext, wordAt, symbolReferences, renamePlan, lineAttribution },
      inject: ['slots', 'sidebarRight', 'sidebarRightTabs', 'theme'],
      apply(ctx) {
        services = {
          ctx,
          theme: ctx.theme,
          sidebarRight: ctx.sidebarRight,
          sidebarRightTabs: ctx.sidebarRightTabs,
          // Session UI status (running / settled) lives in the shared core
          // service; it is read defensively so the IDE still loads without it.
          uiSession: typeof ctx.get === 'function' ? ctx.get('uiSession') : undefined,
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

        // `ctx.theme` owns the preference but exposes no subscribe; the Client
        // context emits `theme/change` instead. Bridge it to the mounted pane.
        ctx.effect(() => {
          if (typeof ctx.on !== 'function') return () => {}
          try {
            const dispose = ctx.on('theme/change', () => {
              try {
                window.dispatchEvent(new Event(THEME_EVENT))
              } catch (cause) {
                // A non-browser host has no window; the next render picks it up.
              }
            })
            return typeof dispose === 'function' ? dispose : () => {}
          } catch (cause) {
            return () => {}
          }
        }, 'dsh-ide: theme change')

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
