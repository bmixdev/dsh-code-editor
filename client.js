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

    function requestOpen(sessionId, filePath) {
      const path = normalPath(filePath)
      const request = { path, nonce: ++openNonce }
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
      const [rootOpen, setRootOpen] = React.useState(true)
      const expandedRef = React.useRef(new Set())
      const selected = props.selected
      const selectRow = (path, type) => {
        if (typeof props.onSelect === 'function') props.onSelect(path, type)
      }
      React.useEffect(() => {
        expandedRef.current = expanded
      }, [expanded])
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
          items.push({ separator: true })
        } else {
          items.push({ id: 'open', label: 'Открыть', run: () => onOpenFile(target.path) })
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
        'rangeReplace',
        'partialAccept',
        'refetchAfterAccept',
        'triggerInComments',
        'showRemovedDecorations',
        'explainSuppressed',
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

      const sections = [
        { id: 'completion', label: 'Автодополнение', rows: completionRows },
        { id: 'hints', label: 'Подсказки ИИ', rows: hintsRows },
        { id: 'hints-filters', label: 'Проверки подсказок', rows: hintFilterRows },
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
  { key: 'explainSuppressed', kind: 'boolean', value: true, title: 'Подсказки: причины отказа', hint: 'Писать в «Траектории», почему подсказка скрыта.' },
  { key: 'heuristicDuplicateLine', kind: 'boolean', value: true, title: 'Проверка: дубль строки', hint: 'Отклонять повтор следующей строки.' },
  { key: 'heuristicExtendsRange', kind: 'boolean', value: true, title: 'Проверка: повтор диапазона', hint: 'Отклонять ответ, повторяющий исходные строки.' },
  { key: 'heuristicRevertingChange', kind: 'boolean', value: true, title: 'Проверка: отмена правки', hint: 'Не предлагать текст, который пользователь только что удалил.' },
]

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
                      row.fellBack === true ? ' · запасная' : row.modelSource === 'session' ? ' · из сессии' : ''
                    }`,
                  ),
                  h('span', { className: 'dsh-ide-trace-mode' }, row.explicit ? 'Ctrl+Space' : 'авто'),
                  h('span', { className: 'dsh-ide-trace-meta' }, `${row.before}/${row.after} символов`),
                  h('span', { className: 'dsh-ide-trace-meta' }, `${row.durationMs} мс`),
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
        ghost: '',
        ghostPosition: undefined,
        ghostNode: undefined,
        ghostWidget: undefined,
        ghostTimer: 0,
        ghostKey: undefined,
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
          values: new Map(),
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

      const saveKey = async (key) => {
        const target = stateRef.current.tabs.find((candidate) => candidate.key === key)
        const model = runtime.current.models.get(key)
        if (target === undefined || model === undefined) return false
        if (target.readOnly) {
          setStatus({ kind: 'error', message: 'Файл доступен только для чтения.' })
          return false
        }
        setStatus({ kind: 'busy', message: 'Сохранение…' })
        try {
          const payload = await call('save', {
            id: target.hostId,
            sessionId: stateRef.current.sessionId,
            token: target.token,
            text: model.getValue(),
          })
          setTabs((previous) => previous.map((candidate) => (candidate.key === key ? { ...candidate, token: payload.token, dirty: false } : candidate)))
          setStatus({ kind: 'ok', message: `Сохранено: ${target.name}` })
          return true
        } catch (cause) {
          setStatus({ kind: 'error', message: describeError(cause) })
          return false
        }
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

      const decorateEdits = (plan, model) => {
        clearEdits()
        const editor = runtime.current.editor
        const monacoInstance = runtime.current.monaco
        const edits = Array.isArray(plan.edits) ? plan.edits : []
        if (editor === undefined || monacoInstance === undefined || edits.length === 0) return
        const decorations = []
        const inlineOnly = new Set()
        for (const [index, edit] of edits.entries()) {
          const start = model.getPositionAt(edit.start)
          const end = model.getPositionAt(edit.end)
          // The hover carries the whole proposal, so an edit whose block card was
          // skipped as too close to the previous one is still readable.
          const hover =
            (edit.why === '' ? 'Правка подсказки' : edit.why) +
            '\n\n```\n' +
            edit.newText +
            '\n```'
          const singleLine = !edit.newText.includes('\n')
          decorations.push({
            range: new monacoInstance.Range(start.lineNumber, start.column, end.lineNumber, end.column),
            options: {
              inlineClassName: 'dsh-ide-edit-old',
              hoverMessage: { value: hover },
              // A one-line replacement is phantom text on the same line: what goes
              // away stays pink, what arrives follows it in green. That is the
              // inline behaviour of Cursor, and it needs no overlay at all. The
              // "after" content sits at the end of the decorated range.
              ...(singleLine
                ? { after: { content: edit.newText, inlineClassName: 'dsh-ide-edit-inline' } }
                : {}),
            },
          })
          if (singleLine) inlineOnly.add(index)
        }
        runtime.current.tab.editDecorations = editor.deltaDecorations([], decorations)
        const widgets = []
        // Two block cards anchored a line apart would cover each other, so only
        // the first of a cluster keeps a card; the rest stay highlighted, and
        // their replacement is in the hover.
        let lastCardLine = -Infinity
        edits.forEach((edit, index) => {
          if (inlineOnly.has(index)) return
          const start = model.getPositionAt(edit.start)
          const node = document.createElement('div')
          node.className = 'dsh-ide-edit-new'
          // A block answer cannot be inline: the phantom lines have to sit over
          // real ones. The block is drawn as plain code on the editor background
          // (no dialog chrome), so it reads as extra lines rather than a popup.
          const code = document.createElement('div')
          code.className = 'dsh-ide-edit-code'
          code.textContent = edit.newText
          node.appendChild(code)
          node.title = edit.newText
          // The card may be wider than the text column: scrolling it must not
          // move the caret or steal focus from the editor.
          node.addEventListener('mousedown', (event) => event.preventDefault())
          if (start.lineNumber - lastCardLine < 7) return
          lastCardLine = start.lineNumber
          const widget = {
            getId: () => `dsh-ide.edit.${plan.requestId}.${index}`,
            getDomNode: () => node,
            getPosition: () => {
              // The percentage cap is unreliable inside Monaco's widget layer, so
              // the usable width comes from the editor layout itself. Without it
              // the card runs past the right edge and its text is cut off.
              const width = editor.getLayoutInfo().width
              node.style.maxWidth = `${Math.max(220, Math.round(width) - 48)}px`
              // Anchored at the start of the line, not at the column of the edit:
              // a card that begins mid-line runs off the right edge of a narrow
              // editor. A multi-line edit anchors after its last line, so the
              // proposal reads like a diff and does not hide the code it replaces.
              const anchorLine = start.lineNumber === model.getPositionAt(edit.end).lineNumber
                ? start.lineNumber
                : model.getPositionAt(edit.end).lineNumber
              return {
                position: { lineNumber: anchorLine, column: 1 },
                preference: [
                  monacoInstance.editor.ContentWidgetPositionPreference.BELOW,
                  monacoInstance.editor.ContentWidgetPositionPreference.ABOVE,
                ],
              }
            },
          }
          editor.addContentWidget(widget)
          widgets.push(widget)
        })
        runtime.current.tab.editWidgets = widgets
        runtime.current.tab.edits = edits
        // An answer that is only edits has no ghost text at the caret, but Tab
        // must still accept it: the command is guarded by this context key.
        if (runtime.current.ghostKey !== undefined) runtime.current.ghostKey.set(true)
      }

      const complete = async (model, position, context, cancelToken) => {
        const key = runtime.current.modelTabs.get(model.uri.toString())
        const entry = stateRef.current.tabs.find((candidate) => candidate.key === key)
        const requested = context === undefined || context === null ? {} : context
        const kind =
          requested.kind === 'explicit' || requested.kind === 'refetch'
            ? requested.kind
            : requested.triggerKind === 1
              ? 'explicit'
              : 'auto'
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
        const controller = new AbortController()
        runtime.current.tab.controller = controller
        if (cancelToken && typeof cancelToken.onCancellationRequested === 'function') {
          cancelToken.onCancellationRequested(() => controller.abort())
        }
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
            controller.signal,
          )
          if (payload === undefined || typeof payload.text !== 'string') return { items: [] }
          const trajectory = payload.trajectory === undefined || payload.trajectory === null ? {} : payload.trajectory
          const planKind = typeof payload.planKind === 'string' ? payload.planKind : 'insert'
          const suppressed = typeof payload.suppressed === 'string' ? payload.suppressed : ''
          pushTrace({
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
            conversation: payload.conversation,
            kind,
            planKind,
            removedChars: asNumber(trajectory.removedChars),
            suppressed,
          })
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
          return { items: payload.text === '' ? [] : [{ insertText: payload.text }], text: payload.text, plan }
        } catch (cause) {
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

      const clearGhost = React.useCallback(() => {
        const state = runtime.current
        const decorations = state.tab.removedDecorations
        // The content listener calls this on every keystroke. When nothing is
        // drawn there is nothing to undo, and a widget relayout per character is
        // exactly what makes typing feel like it waits for the model.
        const visible =
          state.ghost !== '' ||
          state.tab.plan !== undefined ||
          (Array.isArray(decorations) && decorations.length > 0) ||
          (Array.isArray(state.tab.editWidgets) && state.tab.editWidgets.length > 0)
        state.ghost = ''
        state.ghostPosition = undefined
        state.tab.plan = undefined
        state.tab.accepted = 0
        if (!visible) return
        const node = runtime.current.ghostNode
        if (node !== undefined) node.style.display = 'none'
        const editor = runtime.current.editor
        const widget = runtime.current.ghostWidget
        if (editor !== undefined && widget !== undefined) editor.layoutContentWidget(widget)
        if (runtime.current.ghostKey !== undefined) runtime.current.ghostKey.set(false)
        clearRemovedDecoration()
        clearEdits()
      }, [])

      const showGhost = React.useCallback((position, ghostText) => {
        const node = runtime.current.ghostNode
        const editor = runtime.current.editor
        const widget = runtime.current.ghostWidget
        if (node === undefined || editor === undefined || widget === undefined || ghostText === '') return
        runtime.current.ghost = ghostText
        runtime.current.ghostPosition = position
        node.textContent = ghostText
        node.style.display = 'block'
        editor.layoutContentWidget(widget)
        if (runtime.current.ghostKey !== undefined) runtime.current.ghostKey.set(true)
      }, [])

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
        if (model.getVersionId() !== plan.modelVersion) {
          clearGhost()
          return false
        }
        const accepted = runtime.current.tab.accepted
        const text = plan.insertText.slice(accepted)
        const edits = Array.isArray(plan.edits) ? plan.edits : []
        if (text === '' && edits.length === 0) {
          clearGhost()
          return false
        }
        const tabKey = runtime.current.modelTabs.get(model.uri.toString())
        const entry = stateRef.current.tabs.find((candidate) => candidate.key === tabKey)
        // One transaction: the continuation at the caret plus every phantom edit
        // the Host located. Tab is one undo step, and the offsets stay valid
        // because Monaco applies the whole set together.
        const operations = []
        if (text !== '') operations.push({ start: plan.range.start + accepted, end: plan.range.end, text })
        for (const edit of edits) operations.push({ start: edit.start, end: edit.end, text: edit.newText })
        const edited = applyGhostEdits(operations, plan.range.start + plan.insertText.length)
        runtime.current.tab.plan = undefined
        runtime.current.tab.accepted = 0
        clearGhost()
        if (!edited) return false
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

      // The buffer value before each change tells us what the user deleted. A
      // suggestion that recreates that text is "reverting a change" and is
      // dropped by the Host.
      const trackRemovedText = (model, record) => {
        const uri = model.uri.toString()
        const previous = runtime.current.tab.values.get(uri)
        const next = model.getValue()
        runtime.current.tab.values.set(uri, next)
        if (record !== true || typeof previous !== 'string' || previous === next) return
        const prefix = commonPrefixLengthLocal(previous, next)
        const limit = Math.min(previous.length - prefix, next.length - prefix)
        let suffix = 0
        while (suffix < limit && previous[previous.length - 1 - suffix] === next[next.length - 1 - suffix]) suffix += 1
        remember(runtime.current.tab.revertions, runtime.current.modelTabs.get(uri), previous.slice(prefix, previous.length - suffix))
      }

      const requestGhost = async (kind) => {
        const editor = runtime.current.editor
        if (editor === undefined) return
        const model = editor.getModel()
        const position = editor.getPosition()
        if (model === null || position === null) return
        if (kind !== 'explicit' && kind !== 'refetch' && Date.now() < runtime.current.tab.snoozeUntil) return
        if (kind === 'auto' && runtime.current.tab.plan !== undefined) return
        const result = await complete(model, position, { triggerKind: kind === 'explicit' ? 1 : 0, kind }, undefined)
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
        if (plan.insertText !== '') showGhost(model.getPositionAt(plan.range.start), plan.insertText)
        decorateRemoved(plan, model)
        decorateEdits(plan, model)
      }

      const scheduleGhost = (kind = 'auto') => {
        window.clearTimeout(runtime.current.ghostTimer)
        // A pending answer is for text that no longer exists. Cancelling it here
        // is what keeps typing responsive: otherwise every keystroke leaves a
        // request running and its late answer has to be thrown away on arrival.
        const pending = runtime.current.tab.controller
        if (pending !== undefined) {
          pending.abort()
          runtime.current.tab.controller = undefined
        }
        // One suggestion at a time: while one is on screen the user either
        // accepts it or cancels it, so nothing asks the model again.
        if (runtime.current.tab.plan !== undefined) return
        if (runtime.current.autoSuggest !== true) return
        const editor = runtime.current.editor
        if (editor === undefined || !editor.hasTextFocus()) return
        const selection = editor.getSelection()
        if (selection !== null && !selection.isEmpty()) return
        const delay = Number(tabPref('debounceMs', 500))
        runtime.current.ghostTimer = window.setTimeout(() => {
          void requestGhost(kind)
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
        })
        runtime.current.editor = editor
        runtime.current.monaco = monaco

        const ghostNode = document.createElement('span')
        ghostNode.className = 'dsh-ide-ghost'
        ghostNode.style.display = 'none'
        const ghostWidget = {
          getId: () => 'dsh-ide.ghost',
          getDomNode: () => ghostNode,
          getPosition: () =>
            runtime.current.ghostPosition === undefined
              ? null
              : { position: runtime.current.ghostPosition, preference: [monaco.editor.ContentWidgetPositionPreference.EXACT] },
        }
        editor.addContentWidget(ghostWidget)
        runtime.current.ghostNode = ghostNode
        runtime.current.ghostWidget = ghostWidget
        runtime.current.ghostKey =
          typeof editor.createContextKey === 'function' ? editor.createContextKey('dshIdeGhostVisible', false) : undefined

        const change = editor.onDidChangeModelContent(() => {
          const model = editor.getModel()
          if (model === null) return
          const internal = runtime.current.tab.internalEdit === true
          trackRemovedText(model, !internal)
          const key = runtime.current.modelTabs.get(model.uri.toString())
          if (key !== undefined) {
            setTabs((previous) =>
              previous.map((candidate) => (candidate.key === key && !candidate.dirty ? { ...candidate, dirty: true } : candidate)),
            )
          }
          // An edit we made ourselves (Tab, Ctrl+→) must not cancel or re-ask.
          if (internal) return
          clearGhost()
          scheduleGhost('auto')
        })
        const blur = editor.onDidBlurEditorWidget(() => clearGhost())
        let cursorTimer = 0
        const cursorChange = editor.onDidChangeCursorPosition((event) => {
          if (runtime.current.tab.internalEdit === true) return
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

        editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
          void handlersRef.current.saveActive?.()
        })
        editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyW, () => handlersRef.current.closeActive?.())
        editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyP, () => handlersRef.current.openQuick?.())
        editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyS, () => {
          void handlersRef.current.saveAll?.()
        })
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
        editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Comma, () => handlersRef.current.openSettings?.())
        editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Backquote, () => handlersRef.current.toggleOutput?.())

        return () => {
          window.clearTimeout(runtime.current.ghostTimer)
          window.clearTimeout(cursorTimer)
          if (runtime.current.tab.controller !== undefined) runtime.current.tab.controller.abort()
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
        clearGhost()
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
        requestGhost: (kind) => void requestGhost(kind === 'explicit' ? 'explicit' : 'auto'),
        acceptGhost,
        acceptWord,
        rejectGhost,
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
      const menus = [
        {
          id: 'file',
          label: 'Файл',
          items: [
            { id: 'new', label: 'Новый файл…', run: () => createFile() },
            { id: 'new-folder', label: 'Новая папка…', run: () => createDirectory() },
            { id: 'open', label: 'Открыть файл…', key: 'Ctrl+P', run: openQuick },
            { separator: true },
            { id: 'save', label: 'Сохранить', key: 'Ctrl+S', run: () => void saveActive() },
            { id: 'save-all', label: 'Сохранить всё', key: 'Ctrl+Shift+S', run: () => void saveAll() },
            { separator: true },
            { id: 'close', label: 'Закрыть вкладку', key: 'Ctrl+W', run: closeActive },
            { id: 'close-all', label: 'Закрыть все вкладки', run: closeAllTabs },
            { separator: true },
            { id: 'refresh', label: 'Обновить дерево', run: () => setReloadSignal((previous) => previous + 1) },
            { id: 'toggle-tree', label: showTree ? 'Скрыть проводник' : 'Показать проводник', run: () => setShowTree(!showTree) },
        {
          id: 'swap-explorer',
          label: explorerSide === 'left' ? 'Проводник справа' : 'Проводник слева',
          run: () => setExplorerSide(explorerSide === 'left' ? 'right' : 'left'),
        },
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
            { id: 'select-line', label: 'Выделить строку', key: 'Ctrl+L', run: () => runAction('expandLineSelection') },
            { separator: true },
            { id: 'expand', label: 'Расширить выделение', key: 'Shift+Alt+→', run: () => runAction('editor.action.smartSelect.expand') },
            { id: 'shrink', label: 'Сузить выделение', key: 'Shift+Alt+←', run: () => runAction('editor.action.smartSelect.shrink') },
          ],
        },
        {
          id: 'view',
          label: 'Вид',
          items: [
            { id: 'word-wrap', label: wordWrap ? 'Отключить перенос по словам' : 'Включить перенос по словам', run: toggleWordWrap },
            { id: 'hidden', label: hidden ? 'Скрыть скрытые файлы' : 'Показывать скрытые файлы', run: () => setHidden(!hidden) },
            { separator: true },
            { id: 'zoom-in', label: 'Увеличить шрифт', run: () => zoom(1) },
            { id: 'zoom-out', label: 'Уменьшить шрифт', run: () => zoom(-1) },
            { id: 'zoom-reset', label: 'Сбросить размер шрифта', run: () => zoom(13 - fontSize) },
            { separator: true },
            {
              id: 'output',
              label: panel === undefined ? 'Показать панель вывода' : 'Скрыть панель вывода',
              key: 'Ctrl+',
              run: toggleOutput,
            },
            { separator: true },
            { id: 'settings', label: 'Настройки IDE…', key: 'Ctrl+,', run: () => setSettingsOpen(true) },
            { id: 'connect-model', label: 'Подключить модель…', run: () => setModelDialog(true) },
            { id: 'problems', label: 'Проблемы', disabled: true, hint: 'Диагностика требует языковых сервисов — их в бандле нет.' },
          ],
        },
        {
          id: 'go',
          label: 'Переход',
          items: [
            { id: 'goto-file', label: 'Перейти к файлу…', key: 'Ctrl+P', run: openQuick },
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
              run: () =>
                setInfo({
                  title: 'Горячие клавиши',
                  lines: [
                    'Ctrl+S — сохранить файл, Ctrl+Shift+S — сохранить всё',
                    'Ctrl+W — закрыть вкладку, Ctrl+P — открыть файл по имени',
                    'Ctrl+G — перейти к строке, Ctrl+Space — подсказка модели',
                  ],
                }),
            },
          ],
        },
      ]

      const activeTab = tabs.find((candidate) => candidate.key === activeKey)
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
        { className: 'dsh-ide-root', 'data-theme': themeName() },
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
                className: 'dsh-ide-activity-button',
                title: 'Быстрое открытие файла (Ctrl+P)',
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
                  onOpenFile: (path) => {
                    void openFile(path, { activate: true })
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
            { className: 'dsh-ide-editor', style: { order: explorerSide === 'left' ? 2 : 0 } },
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
            h('div', { className: 'dsh-ide-stage', ref: hostRef }),
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
      )
    }

    // ----------------------------------------------------------------- styles

    const STYLES = `
.dsh-ide-root { display:flex; flex-direction:column; height:100%; min-height:0; position:relative;
  --ide-bg:#1e1e1e; --ide-panel:#252526; --ide-panel-2:#2d2d2d; --ide-border:#3c3c3c; --ide-text:#cccccc;
  --ide-muted:#8a8a8a; --ide-hover:#2a2d2e; --ide-active:#37373d; --ide-select:#094771; --ide-accent:#007acc; --ide-error:#f48771;
  background:var(--ide-bg); color:var(--ide-text);
  font:400 12px/1.45 var(--dsh-font-ui, system-ui, -apple-system, Segoe UI, sans-serif); }
.dsh-ide-root[data-theme="light"] { --ide-bg:#ffffff; --ide-panel:#f3f3f3; --ide-panel-2:#ececec; --ide-border:#e2e2e2;
  --ide-text:#2b2b2b; --ide-muted:#6b6b6b; --ide-hover:#e8e8e8; --ide-active:#e4e6f1; --ide-select:#cce4ff; --ide-accent:#0066bf; --ide-error:#b5200d; }
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
.dsh-ide-ghost { display:none; pointer-events:none; white-space:pre; opacity:.5; color:var(--ide-fg);
  font-family:var(--ide-font-mono, Consolas, 'Courier New', monospace); font-size:13px; line-height:20px; }
.dsh-ide-ghost-removed { background:rgba(224, 108, 117, .18); border-bottom:1px solid rgba(224, 108, 117, .55); }
.dsh-ide-edit-old { background:rgba(224, 108, 117, .22); border-bottom:1px solid rgba(224, 108, 117, .5); }
.dsh-ide-edit-inline { color:rgba(150, 225, 165, .95); margin-left:6px; opacity:.95;
  font-family:var(--ide-font-mono, ui-monospace, monospace); }
.dsh-ide-edit-new { position:relative; z-index:30; margin:0 0 0 8px; padding:0 8px 0 6px;
  max-height:200px; overflow:auto; cursor:auto; opacity:.97;
  background:var(--ide-bg, #1e1e1e); border-left:2px solid rgba(106, 190, 120, .75);
  color:rgba(150, 225, 165, .95); white-space:pre;
  font:400 13px/20px var(--ide-font-mono, ui-monospace, monospace); }
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
.dsh-ide-consent { display:flex; align-items:center; gap:8px; flex:0 0 auto; padding:6px 10px; background:#3a2d1f;
  border-bottom:1px solid var(--ide-border); color:#e8d6b8; font-size:11.5px; }
.dsh-ide-root[data-theme="light"] .dsh-ide-consent { background:#fff4d6; color:#4d3a12; }
.dsh-ide-consent-text { flex:1 1 auto; min-width:0; }
.dsh-ide-consent-actions { display:flex; gap:6px; flex:0 0 auto; }
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
.dsh-ide-setting-input { width:230px; max-width:100%; }
.dsh-ide-setting-textarea { width:100%; min-height:96px; resize:vertical; font:400 12.5px/1.5 var(--dsh-font-mono, ui-monospace, monospace); padding:6px 8px; }
.dsh-ide-setting-control input[type="checkbox"] { width:14px; height:14px; accent-color:var(--ide-accent); }
.dsh-ide-setting-check { display:inline-flex; align-items:center; gap:6px; color:var(--ide-text);
  font:400 12.5px/1.4 var(--dsh-font-ui, system-ui, sans-serif); }
.dsh-ide-settings-actions { display:flex; gap:6px; }
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
          theme: ctx.theme,
          sidebarRight: ctx.sidebarRight,
          sidebarRightTabs: ctx.sidebarRightTabs,
        }

        ctx.effect(injectStyles, 'dsh-ide: styles')

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
