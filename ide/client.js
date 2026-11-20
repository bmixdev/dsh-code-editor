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
 *  - an "IDE" action on the document preview toolbar;
 *  - any `dsh-ide://session/<id>[/<path>]` address opened with kind `dsh-ide`.
 *
 * Monaco is vendored (ide/vendor/vs) and served by the Host half at /ide/vs, so
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
    const ADDRESS_PREFIX = 'dsh-ide://session/'

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
      if (typeof address !== 'string' || !address.startsWith(ADDRESS_PREFIX)) return undefined
      const rest = address.slice(ADDRESS_PREFIX.length).split('?')[0].split('#')[0]
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

      const [expanded, setExpanded] = React.useState(() => new Set())
      const [cache, setCache] = React.useState(() => new Map())
      const [error, setError] = React.useState('')
      const [pending, setPending] = React.useState('')
      const [query, setQuery] = React.useState('')
      const [flat, setFlat] = React.useState(undefined)
      const [flatError, setFlatError] = React.useState('')
      const [reloadKey, setReloadKey] = React.useState(0)

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
        setCache(new Map())
        setFlat(undefined)
        setFlatError('')
        if (typeof sessionId === 'string' && sessionId !== '') void load('')
      }, [sessionId, hidden, reloadKey, load])

      const needle = query.trim().toLowerCase()

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
                  className: `dsh-ide-row${file.path === activePath ? ' dsh-ide-row-active' : ''}`,
                  style: { paddingLeft: '8px' },
                  title: file.path,
                  onClick: () => onOpenFile(file.path),
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
            rows.push(h('div', { key: `empty:${directory}`, className: 'dsh-ide-tree-empty', style: { paddingLeft: `${8 + depth * 12}px` } }, 'пусто'))
            return
          }
          for (const entry of listing.entries) {
            const path = directory === '' ? entry.name : `${directory}/${entry.name}`
            const isDirectory = entry.type === 'directory'
            const open = isDirectory && expanded.has(path)
            rows.push(
              h(
                'button',
                {
                  key: path,
                  type: 'button',
                  className: `dsh-ide-row${path === activePath ? ' dsh-ide-row-active' : ''}`,
                  style: { paddingLeft: `${6 + depth * 12}px` },
                  title: path,
                  onClick: () => (isDirectory ? toggle(path, cache.has(path)) : onOpenFile(path)),
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
        }
        walk('', 0)
        if (error !== '') rows.unshift(h('div', { key: 'tree-error', className: 'dsh-ide-tree-error' }, error))
      }

      return h(
        'div',
        { className: 'dsh-ide-explorer' },
        h(
          'div',
          { className: 'dsh-ide-explorer-head' },
          h('span', { className: 'dsh-ide-explorer-title' }, 'Explorer'),
          h(
            'span',
            { className: 'dsh-ide-explorer-actions' },
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
                title: 'Обновить дерево',
                onClick: () => setReloadKey((value) => value + 1),
              },
              '⟳',
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

    function TabStrip(props) {
      const { tabs, activeKey, onActivate, onClose } = props
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

    function SettingsPanel({ preferences, onClose, onSave }) {
      const [provider, setProvider] = React.useState(preferences.completionProvider || '')
      const [model, setModel] = React.useState(preferences.completionModel || '')
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

      const group = catalog !== undefined && Array.isArray(catalog.groups) ? catalog.groups.find((entry) => entry.id === provider) : undefined
      const profile = catalog !== undefined && Array.isArray(catalog.configurable) ? catalog.configurable.find((entry) => entry.provider === provider) : undefined
      const models = group !== undefined ? group.models : []
      const sessionModel = catalog !== undefined ? catalog.default : undefined

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
        const suggested = provider === initialProvider && saved !== '' ? saved : providerKeyName(profile, provider)
        setKeyRef(suggested)
        void refreshKey(suggested)
      }, [provider, profile === undefined ? '' : profile.settingsNs, preferences.apiKeyRef, initialProvider, refreshKey])

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
        onSave({
          completionProvider: provider,
          completionModel: model,
          autoSuggest,
          contextLeft: toNumber(contextLeft, 4000),
          contextRight: toNumber(contextRight, 1000),
          apiKeyRef: keyRef,
        })
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

      const modelOptions = [h('option', { key: '', value: '' }, 'Первая доступная у провайдера')]
      const knownModels = new Set()
      for (const entry of models) {
        modelOptions.push(h('option', { key: entry.id, value: entry.id }, entry.name || entry.id))
        knownModels.add(entry.id)
      }
      if (model !== '' && !knownModels.has(model)) modelOptions.push(h('option', { key: model, value: model }, `${model} (сохранена ранее)`))

      const keyHint = keyStatus === undefined
        ? ''
        : keyStatus.supported === false
          ? 'Хранилище ключей недоступно: ключ задаётся через окружение (apiKeyEnv профиля).'
          : keyStatus.configured
            ? `Ключ задан${keyStatus.source ? ` (${keyStatus.source})` : ''}${keyStatus.masked ? ` · ${keyStatus.masked}` : ''}`
            : 'Ключ не задан — автодополнение может не работать.'

      return h(
        'div',
        { className: 'dsh-ide-settings' },
        h(
          'div',
          { className: 'dsh-ide-settings-head' },
          h('span', {}, 'Настройки IDE'),
          h('button', { type: 'button', className: 'dsh-ide-icon-button', title: 'Закрыть настройки', onClick: onClose }, '✕'),
        ),
        h(
          'div',
          { className: 'dsh-ide-settings-body' },
          h(
            'section',
            { className: 'dsh-ide-section' },
            h('div', { className: 'dsh-ide-legend' }, 'Автодополнение'),
            h(
              'label',
              { className: 'dsh-ide-field' },
              h('span', { className: 'dsh-ide-field-label' }, 'Провайдер'),
              h(
                'select',
                { className: 'dsh-ide-input', value: provider, onChange: (event) => setProvider(event.target.value) },
                h(
                  'option',
                  { value: '' },
                  sessionModel !== undefined ? `Как у сессии (${sessionModel.provider})` : 'Как у сессии',
                ),
                providerOptions,
              ),
            ),
            h(
              'label',
              { className: 'dsh-ide-field' },
              h('span', { className: 'dsh-ide-field-label' }, 'Модель'),
              h('select', { className: 'dsh-ide-input', value: model, onChange: (event) => setModel(event.target.value) }, modelOptions),
            ),
            h(
              'div',
              { className: 'dsh-ide-row' },
              h('button', { type: 'button', className: 'dsh-ide-button', onClick: refreshCatalog, disabled: refreshing }, refreshing ? 'Обновляю…' : 'Обновить каталог'),
              sessionModel !== undefined
                ? h('span', { className: 'dsh-ide-hint' }, `Модель сессии: ${sessionModel.provider} / ${sessionModel.model}`)
                : null,
            ),
            catalog !== undefined && Array.isArray(catalog.failures) && catalog.failures.length > 0
              ? h(
                  'div',
                  { className: 'dsh-ide-warn' },
                  'Не ответили: ',
                  catalog.failures.map((failure) => `${failure.name || failure.id}: ${failure.message}`).join('; '),
                )
              : null,
            h(
              'label',
              { className: 'dsh-ide-check' },
              h('input', { type: 'checkbox', checked: autoSuggest, onChange: (event) => setAutoSuggest(event.target.checked) }),
              h('span', {}, 'Автоподсказки по паузе (иначе только Ctrl+Space)'),
            ),
          ),
          h(
            'section',
            { className: 'dsh-ide-section' },
            h('div', { className: 'dsh-ide-legend' }, 'API-ключ провайдера'),
            h(
              'label',
              { className: 'dsh-ide-field' },
              h('span', { className: 'dsh-ide-field-label' }, 'Имя ключа'),
              h('input', {
                className: 'dsh-ide-input',
                type: 'text',
                value: keyRef,
                spellCheck: false,
                placeholder: 'OPENROUTER_API_KEY',
                onChange: (event) => setKeyRef(event.target.value.trim().toUpperCase()),
                onBlur: () => void refreshKey(keyRef),
              }),
              h('span', { className: 'dsh-ide-hint' }, 'Имя переменной окружения из apiKeyEnv профиля.'),
            ),
            h(
              'label',
              { className: 'dsh-ide-field' },
              h('span', { className: 'dsh-ide-field-label' }, 'Новый ключ'),
              h('input', {
                className: 'dsh-ide-input',
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
            h(
              'div',
              { className: 'dsh-ide-row' },
              h('button', { type: 'button', className: 'dsh-ide-button dsh-ide-button-primary', onClick: saveKey, disabled: keyBusy }, 'Сохранить ключ'),
              h('button', { type: 'button', className: 'dsh-ide-button', onClick: clearKey, disabled: keyBusy }, 'Удалить ключ'),
            ),
            keyHint === '' ? null : h('div', { className: 'dsh-ide-hint' }, keyHint),
          ),
          h(
            'section',
            { className: 'dsh-ide-section' },
            h('div', { className: 'dsh-ide-legend' }, 'Контекст автодополнения'),
            h(
              'div',
              { className: 'dsh-ide-row' },
              h(
                'label',
                { className: 'dsh-ide-field dsh-ide-field-inline' },
                h('span', { className: 'dsh-ide-field-label' }, 'Символов до курсора'),
                h('input', {
                  className: 'dsh-ide-input dsh-ide-input-number',
                  type: 'number',
                  min: 200,
                  max: 20000,
                  value: contextLeft,
                  onChange: (event) => setContextLeft(event.target.value),
                }),
              ),
              h(
                'label',
                { className: 'dsh-ide-field dsh-ide-field-inline' },
                h('span', { className: 'dsh-ide-field-label' }, 'После курсора'),
                h('input', {
                  className: 'dsh-ide-input dsh-ide-input-number',
                  type: 'number',
                  min: 0,
                  max: 8000,
                  value: contextRight,
                  onChange: (event) => setContextRight(event.target.value),
                }),
              ),
            ),
          ),
          message === '' ? null : h('div', { className: 'dsh-ide-message' }, message),
        ),
        h(
          'div',
          { className: 'dsh-ide-settings-foot' },
          h('button', { type: 'button', className: 'dsh-ide-button dsh-ide-button-primary', onClick: submit }, 'Сохранить настройки'),
          h('button', { type: 'button', className: 'dsh-ide-button', onClick: onClose }, 'Закрыть'),
        ),
      )
    }

    function ConfirmDialog({ dialog, onSave, onDiscard, onCancel }) {
      const pane = dialog.mode === 'close-pane'
      return h(
        'div',
        { className: 'dsh-ide-modal' },
        h(
          'div',
          { className: 'dsh-ide-modal-card' },
          h('div', { className: 'dsh-ide-modal-title' }, pane ? 'Закрыть IDE с несохранёнными файлами?' : 'Закрыть файл с изменениями?'),
          h(
            'div',
            { className: 'dsh-ide-modal-text' },
            pane ? 'В панели остались несохранённые файлы. Сохранить их перед закрытием?' : 'Изменения не сохранены. Сохранить перед закрытием?',
          ),
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
      const parsed = tab && typeof tab.contentId === 'string' ? parseAddress(tab.contentId) : undefined
      const absolutePath =
        props && typeof props.absolutePath === 'string' ? props.absolutePath : parsed !== undefined ? parsed.path : ''
      const label = props && typeof props.label === 'string' ? props.label : 'IDE'
      const providedSession = props && typeof props.sessionId === 'string' ? props.sessionId : ''

      const open = React.useCallback(
        async (event) => {
          setError('')
          setBusy(true)
          try {
            let sessionId = providedSession !== '' ? providedSession : sessionIdFromElement(event && event.currentTarget)
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
            if (!sidebar || typeof sidebar.openResource !== 'function') {
              setError('Правая панель недоступна')
              return
            }
            sidebar.openResource(fileAddress(sessionId, absolutePath), { kind: TAB_KIND })
          } catch (cause) {
            setError(describeError(cause))
          } finally {
            setBusy(false)
          }
        },
        [absolutePath, providedSession],
      )

      return h(
        'span',
        { className: 'dsh-ide-action' },
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

    function IdeBody(props) {
      const tab = tabOf(props)
      const address = tab && typeof tab.contentId === 'string' ? tab.contentId : ''
      const parsed = parseAddress(address)
      const sessionId = parsed !== undefined ? parsed.sessionId : undefined
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
      })
      const pendingOpens = React.useRef(new Set())
      const handlersRef = React.useRef({})

      const [monaco, setMonaco] = React.useState(undefined)
      const [tabs, setTabs] = React.useState([])
      const [activeKey, setActiveKey] = React.useState('')
      const [status, setStatus] = React.useState({ kind: 'idle', message: '' })
      const [explorerWidth, setExplorerWidth] = React.useState(220)
      const [showTree, setShowTree] = React.useState(true)
      const [hidden, setHidden] = React.useState(false)
      const [preferences, setPreferences] = React.useState(undefined)
      const [settingsOpen, setSettingsOpen] = React.useState(false)
      const [quick, setQuick] = React.useState(undefined)
      const [dialog, setDialog] = React.useState(undefined)
      const [cursor, setCursor] = React.useState({ line: 1, column: 1 })
      const [booted, setBooted] = React.useState(false)

      const stateRef = React.useRef({})
      stateRef.current = { tabs, activeKey, sessionId, preferences }

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

      const removeTab = (key) => {
        const model = runtime.current.models.get(key)
        const editor = runtime.current.editor
        if (model !== undefined) {
          if (editor !== undefined && editor.getModel() === model) editor.setModel(null)
          runtime.current.modelTabs.delete(model.uri.toString())
          model.dispose()
          runtime.current.models.delete(key)
        }
        runtime.current.views.delete(key)
        const current = stateRef.current.tabs
        const index = current.findIndex((candidate) => candidate.key === key)
        const next = current.filter((candidate) => candidate.key !== key)
        setTabs(next)
        if (stateRef.current.activeKey === key) {
          if (next.length === 0) setActiveKey('')
          else setActiveKey((next[Math.min(index, next.length - 1)] || next[0]).key)
        }
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

      const complete = React.useCallback(async (model, position, context, cancelToken) => {
        const key = runtime.current.modelTabs.get(model.uri.toString())
        const entry = stateRef.current.tabs.find((candidate) => candidate.key === key)
        const explicit = context !== undefined && context !== null && context.triggerKind === 1
        if (entry === undefined || entry.readOnly) return { items: [] }
        if (!explicit && runtime.current.autoSuggest !== true) return { items: [] }
        const text = model.getValue()
        if (text.length > 4 * 1024 * 1024) return { items: [] }
        const offset = model.getOffsetAt(position)
        const stamp = `${key}:${offset}:${model.getVersionId()}:${explicit ? 'x' : 'a'}`
        if (runtime.current.lastCompletion === stamp) return { items: [] }
        runtime.current.lastCompletion = stamp
        const controller = new AbortController()
        if (cancelToken && typeof cancelToken.onCancellationRequested === 'function') {
          cancelToken.onCancellationRequested(() => controller.abort())
        }
        try {
          const payload = await call(
            'complete',
            { id: entry.hostId, sessionId: stateRef.current.sessionId, token: entry.token, text, offset, explicit },
            controller.signal,
          )
          if (payload === undefined || typeof payload.text !== 'string' || payload.text === '') return { items: [] }
          return { items: [{ insertText: payload.text }] }
        } catch (cause) {
          if (cause instanceof Error && (cause.name === 'AbortError' || cause.code === 'cancelled')) return { items: [] }
          setStatus({ kind: 'error', message: describeError(cause) })
          return { items: [] }
        }
      }, [])

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
        })
        runtime.current.editor = editor
        runtime.current.monaco = monaco

        const change = editor.onDidChangeModelContent(() => {
          const model = editor.getModel()
          if (model === null) return
          const key = runtime.current.modelTabs.get(model.uri.toString())
          if (key === undefined) return
          setTabs((previous) => previous.map((candidate) => (candidate.key === key && !candidate.dirty ? { ...candidate, dirty: true } : candidate)))
        })
        const cursorChange = editor.onDidChangeCursorPosition((event) => setCursor({ line: event.position.lineNumber, column: event.position.column }))

        editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
          void handlersRef.current.saveActive?.()
        })
        editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyW, () => handlersRef.current.closeActive?.())
        editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyP, () => handlersRef.current.openQuick?.())
        editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyS, () => {
          void handlersRef.current.saveAll?.()
        })
        editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Space, () => editor.trigger('keyboard', 'editor.action.inlineSuggest.trigger', {}))

        const provider = monaco.languages.registerInlineCompletionsProvider(
          { pattern: '**' },
          {
            provideInlineCompletions(model, position, context, cancelToken) {
              const run = handlersRef.current.complete
              if (run === undefined) return Promise.resolve({ items: [] })
              return run(model, position, context, cancelToken)
            },
          },
        )

        return () => {
          provider.dispose()
          change.dispose()
          cursorChange.dispose()
          editor.dispose()
          runtime.current.editor = undefined
        }
      }, [monaco])

      // Keep the active tab bound to the editor, one model per tab.
      React.useEffect(() => {
        const editor = runtime.current.editor
        if (!editor || !monaco || activeKey === '') return
        const entry = tabs.find((candidate) => candidate.key === activeKey)
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
          if (view !== undefined && view !== null) editor.restoreViewState(view)
          runtime.current.activeKey = activeKey
          const position = editor.getPosition()
          if (position !== null) setCursor({ line: position.lineNumber, column: position.column })
        }
        editor.updateOptions({ readOnly: entry.readOnly === true })
        editor.focus()
      }, [activeKey, tabs, monaco])

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
            runtime.current.autoSuggest = loaded.autoSuggest !== false
            const saved = statePayload.state || {}
            if (typeof saved.treeWidth === 'number') setExplorerWidth(saved.treeWidth)
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
              showTree,
              hidden,
            },
          }).catch(() => {})
        }, STATE_WRITE_DELAY_MS)
        return () => window.clearTimeout(timer)
      }, [booted, sessionId, tabsKey, activeKey, explorerWidth, showTree, hidden])

      const saveSettings = async (patch) => {
        try {
          const payload = await call('prefs', { patch })
          const loaded = payload.preferences || {}
          setPreferences(loaded)
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
          setExplorerWidth(Math.min(640, Math.max(150, startWidth + (moveEvent.clientX - startX))))
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
        if (current.mode === 'close-pane') {
          if (mode === 'save') await saveAll()
          for (const candidate of stateRef.current.tabs) dirtyTabs.delete(candidate.key)
          closePane()
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

      handlersRef.current = { saveActive, closeActive, saveAll, openQuick, complete }

      const activeTab = tabs.find((candidate) => candidate.key === activeKey)
      const segments = activeTab === undefined ? [] : activeTab.path.split('/')
      const statusMessage = status.kind === 'error' || status.kind === 'ok' || status.kind === 'busy' ? status.message : ''

      return h(
        'div',
        { className: 'dsh-ide-root', 'data-theme': themeName() },
        h(
          'div',
          { className: 'dsh-ide-top' },
          h(
            'button',
            {
              type: 'button',
              className: `dsh-ide-icon-button${showTree ? ' dsh-ide-icon-button-active' : ''}`,
              title: showTree ? 'Скрыть проводник' : 'Показать проводник',
              onClick: () => setShowTree(!showTree),
            },
            '☰',
          ),
          h('span', { className: 'dsh-ide-top-title', title: activeTab === undefined ? 'IDE' : activeTab.path }, activeTab === undefined ? 'IDE' : activeTab.name),
          h('span', { className: 'dsh-ide-top-spacer' }),
          h('button', { type: 'button', className: 'dsh-ide-button', title: 'Быстрое открытие (Ctrl+P)', onClick: openQuick }, 'Файл'),
          h(
            'button',
            {
              type: 'button',
              className: 'dsh-ide-button',
              title: 'Сохранить все изменённые файлы (Ctrl+Shift+S)',
              disabled: !tabs.some((candidate) => candidate.dirty),
              onClick: () => {
                void saveAll()
              },
            },
            'Сохранить всё',
          ),
          h('button', { type: 'button', className: 'dsh-ide-icon-button', title: 'Настройки IDE', onClick: () => setSettingsOpen(true) }, '⚙'),
        ),
        h(
          'div',
          { className: 'dsh-ide-body' },
          showTree && typeof sessionId === 'string'
            ? h(
                'div',
                { className: 'dsh-ide-explorer-wrap', style: { width: `${explorerWidth}px` } },
                h(Explorer, {
                  sessionId,
                  hidden,
                  activePath: activeTab === undefined ? '' : activeTab.path,
                  onOpenFile: (path) => {
                    void openFile(path, { activate: true })
                  },
                  onToggleHidden: setHidden,
                }),
              )
            : null,
          showTree && typeof sessionId === 'string'
            ? h('div', { className: 'dsh-ide-divider', title: 'Потяните, чтобы изменить ширину', onMouseDown: startResize })
            : null,
          h(
            'div',
            { className: 'dsh-ide-editor' },
            h(TabStrip, { tabs, activeKey, onActivate: setActiveKey, onClose: closeTab }),
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
                  h('div', { className: 'dsh-ide-empty-title' }, 'Файл не открыт'),
                  h('div', { className: 'dsh-ide-empty-text' }, 'Выберите файл в проводнике слева или нажмите «Файл», чтобы найти его по имени.'),
                )
              : null,
            h('div', { className: 'dsh-ide-stage', ref: hostRef }),
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
          ? h(SettingsPanel, { preferences, onClose: () => setSettingsOpen(false), onSave: saveSettings })
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
      )
    }

    // ----------------------------------------------------------------- styles

    const STYLES = `
.dsh-ide-root { display:flex; flex-direction:column; height:100%; min-height:0; position:relative;
  --ide-bg:#1e1e1e; --ide-panel:#252526; --ide-panel-2:#2d2d2d; --ide-border:#3c3c3c; --ide-text:#cccccc;
  --ide-muted:#8a8a8a; --ide-hover:#2a2d2e; --ide-active:#37373d; --ide-accent:#007acc; --ide-error:#f48771;
  background:var(--ide-bg); color:var(--ide-text);
  font:400 12px/1.45 var(--dsh-font-ui, system-ui, -apple-system, Segoe UI, sans-serif); }
.dsh-ide-root[data-theme="light"] { --ide-bg:#ffffff; --ide-panel:#f3f3f3; --ide-panel-2:#ececec; --ide-border:#e2e2e2;
  --ide-text:#2b2b2b; --ide-muted:#6b6b6b; --ide-hover:#e8e8e8; --ide-active:#e4e6f1; --ide-accent:#0066bf; --ide-error:#b5200d; }
.dsh-ide-root * { box-sizing:border-box; }
.dsh-ide-top { display:flex; align-items:center; gap:6px; padding:3px 8px; background:var(--ide-panel);
  border-bottom:1px solid var(--ide-border); flex:0 0 auto; min-height:32px; }
.dsh-ide-top-title { font-weight:600; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.dsh-ide-top-spacer { flex:1 1 auto; }
.dsh-ide-body { display:flex; flex:1 1 auto; min-height:0; }
.dsh-ide-explorer-wrap { flex:0 0 auto; min-width:0; display:flex; background:var(--ide-panel); }
.dsh-ide-divider { flex:0 0 4px; width:4px; cursor:col-resize; background:transparent; border-right:1px solid var(--ide-border); }
.dsh-ide-divider:hover { background:var(--ide-accent); }
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
.dsh-ide-row-name { overflow:hidden; text-overflow:ellipsis; }
.dsh-ide-row-dim { color:var(--ide-muted); overflow:hidden; text-overflow:ellipsis; max-width:60%; }
.dsh-ide-row-tag { color:var(--ide-muted); font-size:10px; }
.dsh-ide-guide { flex:0 0 12px; width:12px; align-self:stretch; border-left:1px solid var(--ide-border); opacity:.55; margin-left:1px; }
.dsh-ide-caret { flex:0 0 12px; width:12px; font-size:9px; color:var(--ide-muted); transition:transform .1s ease; }
.dsh-ide-caret-open { transform:rotate(90deg); }
.dsh-ide-folder { flex:0 0 14px; }
.dsh-ide-badge { flex:0 0 16px; width:16px; text-align:center; font:700 8.5px/1 var(--dsh-font-mono, ui-monospace, monospace);
  letter-spacing:-.02em; }
.dsh-ide-tree-error { padding:3px 10px; color:var(--ide-error); font-size:11px; }
.dsh-ide-tree-empty { padding:3px 10px; color:var(--ide-muted); font-size:11px; }
.dsh-ide-icon-button { border:0; background:transparent; color:inherit; cursor:pointer; border-radius:4px;
  padding:2px 5px; font:400 12px/1 var(--dsh-font-ui, system-ui, sans-serif); }
.dsh-ide-icon-button:hover { background:var(--ide-hover); }
.dsh-ide-icon-button-active { background:var(--ide-active); }
.dsh-ide-editor { display:flex; flex-direction:column; flex:1 1 auto; min-width:0; min-height:0; background:var(--ide-bg); position:relative; }
.dsh-ide-tabs { display:flex; align-items:stretch; flex:0 0 auto; overflow-x:auto; overflow-y:hidden; background:var(--ide-panel-2);
  border-bottom:1px solid var(--ide-border); scrollbar-width:thin; }
.dsh-ide-tabs-empty { padding:6px 10px; color:var(--ide-muted); font-size:11.5px; }
.dsh-ide-tab { display:flex; align-items:center; gap:5px; padding:5px 6px 5px 9px; border-right:1px solid var(--ide-border);
  cursor:pointer; max-width:220px; min-width:0; position:relative; color:var(--ide-muted); }
.dsh-ide-tab:hover { color:var(--ide-text); }
.dsh-ide-tab-active { background:var(--ide-bg); color:var(--ide-text); }
.dsh-ide-tab-active::before { content:""; position:absolute; left:0; right:0; top:0; height:1px; background:var(--ide-accent); }
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
.dsh-ide-empty { position:absolute; inset:64px 0 24px; display:flex; flex-direction:column; align-items:center; justify-content:center;
  gap:6px; text-align:center; padding:16px; pointer-events:none; }
.dsh-ide-empty-title { font:600 13px/1.4 var(--dsh-font-ui, system-ui, sans-serif); }
.dsh-ide-empty-text { max-width:320px; color:var(--ide-muted); font-size:11.5px; }
.dsh-ide-status { display:flex; align-items:center; gap:10px; flex:0 0 auto; padding:3px 10px; background:var(--ide-panel);
  border-top:1px solid var(--ide-border); color:var(--ide-muted); font-size:11px; white-space:nowrap; overflow:hidden; }
.dsh-ide-status-text { overflow:hidden; text-overflow:ellipsis; }
.dsh-ide-status-error { color:var(--ide-error); }
.dsh-ide-status-spacer { flex:1 1 auto; }
.dsh-ide-status-item { flex:0 0 auto; }
.dsh-ide-settings { position:absolute; inset:0; z-index:6; display:flex; flex-direction:column; background:var(--ide-panel); }
.dsh-ide-settings-head { display:flex; align-items:center; justify-content:space-between; padding:8px 10px;
  border-bottom:1px solid var(--ide-border); font:600 12.5px/1.4 var(--dsh-font-ui, system-ui, sans-serif); }
.dsh-ide-settings-body { flex:1 1 auto; overflow:auto; padding:10px 12px 16px; }
.dsh-ide-section { margin-bottom:16px; }
.dsh-ide-legend { margin-bottom:6px; color:var(--ide-muted); font:600 10.5px/1.4 var(--dsh-font-ui, system-ui, sans-serif);
  letter-spacing:.06em; text-transform:uppercase; }
.dsh-ide-field { display:flex; flex-direction:column; gap:3px; margin-bottom:9px; }
.dsh-ide-field-inline { flex:1 1 140px; }
.dsh-ide-field-label { font-size:11px; color:var(--ide-muted); }
.dsh-ide-hint { color:var(--ide-muted); font-size:10.5px; line-height:1.45; }
.dsh-ide-input { width:100%; padding:4px 6px; border-radius:4px; color:inherit; background:var(--ide-bg);
  border:1px solid var(--ide-border); font:400 12px/1.4 var(--dsh-font-ui, system-ui, sans-serif); outline:none; }
.dsh-ide-input:focus { border-color:var(--ide-accent); }
.dsh-ide-input-number { width:110px; }
.dsh-ide-row { display:flex; flex-wrap:wrap; align-items:center; gap:8px; margin-bottom:8px; }
.dsh-ide-check { display:flex; align-items:center; gap:6px; font-size:11.5px; }
.dsh-ide-check input { accent-color:var(--ide-accent); }
.dsh-ide-button { border:1px solid var(--ide-border); background:var(--ide-panel-2); color:inherit; cursor:pointer;
  border-radius:4px; padding:3px 9px; font:400 11.5px/1.5 var(--dsh-font-ui, system-ui, sans-serif); }
.dsh-ide-button:hover:not(:disabled) { background:var(--ide-hover); }
.dsh-ide-button:disabled { opacity:.45; cursor:default; }
.dsh-ide-button-primary { background:var(--ide-accent); border-color:var(--ide-accent); color:#fff; }
.dsh-ide-warn { margin:6px 0; color:#d7ba7d; font-size:10.5px; line-height:1.45; }
.dsh-ide-message { margin-top:8px; font-size:11px; }
.dsh-ide-settings-foot { display:flex; gap:8px; padding:8px 12px; border-top:1px solid var(--ide-border); }
.dsh-ide-modal { position:absolute; inset:0; z-index:9; display:flex; align-items:center; justify-content:center;
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
            title: (candidate) => {
              const parsed = parseAddress(candidate)
              return parsed === undefined || parsed.path === '' ? 'IDE' : baseName(parsed.path)
            },
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
      },
    }

    return plugin
  },
})
