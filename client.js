/**
 * Client half of `@local/dsh-code-editor`.
 *
 * Adds two things to the right sidebar:
 *  - a "Редактировать" action on the file preview toolbar that opens the file
 *    in a Monaco tab owned by this bundle;
 *  - the Monaco tab body itself: an editor with a guarded save, an inline
 *    completion provider (accepted with Tab) and a "В чат" quote action.
 *
 * The bundle ships its own Monaco build (vendor/vs, served by the Host half
 * at /code-editor/vs), so nothing is fetched from a CDN.
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-code-editor',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const TAB_ID = '@local/dsh-code-editor'
    const TAB_KIND = 'dsh-code-editor'
    const ACTION_ID = 'dsh-code-editor.open'

    const API_BASE = '/api/code-editor/'
    const ASSET_BASE = '/code-editor/vs'
    const FILE_PREFIX = 'dsh-resource://file/'

    /** Pause after the last keystroke before a completion request leaves the tab. */
    const COMPLETION_PAUSE_MS = 200
    const MAX_MEASUREMENTS = 200
    const BENCHMARK_SAMPLES = 100

    let services = {}
    const dirtyTabs = new Set()
    const closePromptHandlers = new Map()

    // --------------------------------------------------------------- addresses

    const encodeSegment = (value) => encodeURIComponent(value).replace(/%3A/gi, ':')
    const encodePath = (value) => value.split('/').map(encodeSegment).join('/')

    function sessionFileAddress(sessionId, filePath) {
      const normalized = String(filePath).replace(/\\/g, '/').replace(/^(?:\.\/)+/, '')
      return `${FILE_PREFIX}session/${encodeSegment(sessionId)}/${encodePath(normalized)}`
    }

    function parseFileAddress(address) {
      if (typeof address !== 'string' || !address.startsWith(FILE_PREFIX)) return undefined
      const rest = address.slice(FILE_PREFIX.length).split('?')[0].split('#')[0]
      const segments = rest.split('/').map((segment) => {
        try {
          return decodeURIComponent(segment)
        } catch {
          return segment
        }
      })
      const scope = segments.shift()
      if (scope !== 'session') return undefined
      const sessionId = segments.shift()
      if (typeof sessionId !== 'string' || sessionId === '' || segments.length === 0) return undefined
      return { sessionId, path: segments.join('/') }
    }

    function baseName(filePath) {
      const parts = String(filePath ?? '').split('/')
      return parts[parts.length - 1] || 'Файл'
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
        script.addEventListener('error', () => reject(new Error('Не удалось загрузить Monaco из /code-editor/vs')))
        document.head.appendChild(script)
      })
      monacoPromise.catch(() => {
        monacoPromise = undefined
      })
      return monacoPromise
    }

    function resolveEditorTheme() {
      try {
        const snapshot = services.theme && typeof services.theme.getTheme === 'function' ? services.theme.getTheme() : undefined
        const name = typeof snapshot === 'string' ? snapshot : snapshot && (snapshot.id || snapshot.name || snapshot.theme)
        if (typeof name === 'string') {
          if (/dark/i.test(name)) return 'vs-dark'
          if (/light/i.test(name)) return 'vs'
        }
        if (snapshot && typeof snapshot === 'object' && typeof snapshot.dark === 'boolean') {
          return snapshot.dark ? 'vs-dark' : 'vs'
        }
      } catch {
        /* fall through to the media query */
      }
      try {
        if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) return 'vs-dark'
      } catch {
        /* ignore */
      }
      return 'vs'
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

    // -------------------------------------------------------------- the button

    function EditorTitle(props) {
      const tab = tabOf(props)
      const parsed = tab ? parseFileAddress(tab.contentId) : undefined
      const title = parsed === undefined ? (tab && tab.title) || 'Редактор' : baseName(parsed.path)
      return h('span', { title: tab && tab.title ? tab.title : title }, title)
    }

    function EditButton(props) {
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState('')
      const absolutePath = props && typeof props.absolutePath === 'string' ? props.absolutePath : undefined

      const open = React.useCallback(
        async (event) => {
          if (absolutePath === undefined) return
          setError('')
          setBusy(true)
          try {
            let sessionId = sessionIdFromElement(event && event.currentTarget)
            if (sessionId === undefined) {
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
            sidebar.openResource(sessionFileAddress(sessionId, absolutePath), { kind: TAB_KIND })
          } catch (cause) {
            setError(cause instanceof Error ? cause.message : String(cause))
          } finally {
            setBusy(false)
          }
        },
        [absolutePath],
      )

      return h(
        'span',
        { className: 'dsh-ce-action' },
        h(
          'button',
          {
            type: 'button',
            className: 'dsh-ce-action-button',
            onClick: open,
            disabled: busy || absolutePath === undefined,
            title: error === '' ? 'Открыть файл в редакторе кода' : error,
          },
          'Редактировать',
        ),
        error === '' ? null : h('span', { className: 'dsh-ce-action-error', title: error }, '!'),
      )
    }

    // ------------------------------------------------------------ file tree

    /**
     * Lazily loaded workspace tree. A directory is requested the first time it
     * is expanded, so opening the editor costs one listing instead of a walk.
     */
    function TreePanel(props) {
      const sessionId = props.sessionId
      const hidden = props.hidden === true
      const activePath = typeof props.activePath === 'string' ? props.activePath : ''
      const onOpenFile = props.onOpenFile

      const [expanded, setExpanded] = React.useState(() => new Set())
      const [cache, setCache] = React.useState(() => new Map())
      const [error, setError] = React.useState('')
      const [pending, setPending] = React.useState('')

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
            setError(cause instanceof Error ? cause.message : String(cause))
          } finally {
            setPending('')
          }
        },
        [sessionId, hidden],
      )

      React.useEffect(() => {
        setCache(new Map())
        setExpanded(new Set())
        void load('')
      }, [load])

      const rows = []
      const walk = (directory, depth) => {
        const listing = cache.get(directory)
        if (listing === undefined) return
        for (const entry of listing.entries) {
          const path = directory === '' ? entry.name : `${directory}/${entry.name}`
          rows.push({ entry, path, depth })
          if (entry.type === 'directory' && expanded.has(path)) walk(path, depth + 1)
        }
      }
      walk('', 0)

      const toggleDirectory = (path) => {
        setExpanded((previous) => {
          const next = new Set(previous)
          if (next.has(path)) next.delete(path)
          else {
            next.add(path)
            if (!cache.has(path)) void load(path)
          }
          return next
        })
      }

      const root = cache.get('')
      return h(
        'div',
        { className: 'dsh-ce-tree', role: 'tree', 'aria-label': 'Файлы рабочей папки' },
        h(
          'div',
          { className: 'dsh-ce-tree-head' },
          h('span', { className: 'dsh-ce-tree-title', title: root ? root.workspaceRoot : '' }, 'Файлы'),
          h(
            'button',
            {
              type: 'button',
              className: 'dsh-ce-tree-refresh',
              onClick: () => {
                setCache(new Map())
                setExpanded(new Set())
                void load('')
              },
              title: 'Обновить дерево',
            },
            '⟳',
          ),
        ),
        error === '' ? null : h('div', { className: 'dsh-ce-tree-error' }, error),
        root === undefined
          ? h('div', { className: 'dsh-ce-tree-empty' }, pending === '' ? 'Загрузка…' : '…')
          : rows.length === 0
            ? h('div', { className: 'dsh-ce-tree-empty' }, 'Пустая папка')
            : rows.map((row) => {
                const entry = row.entry
                const isDirectory = entry.type === 'directory'
                const open = expanded.has(row.path)
                return h(
                  'button',
                  {
                    key: row.path,
                    type: 'button',
                    role: 'treeitem',
                    'aria-expanded': isDirectory ? open : undefined,
                    className:
                      'dsh-ce-tree-row' +
                      (isDirectory ? ' dsh-ce-tree-dir' : '') +
                      (!isDirectory && row.path === activePath ? ' dsh-ce-tree-active' : ''),
                    style: { paddingLeft: `${6 + row.depth * 12}px` },
                    title: row.path,
                    onClick: () => {
                      if (isDirectory) toggleDirectory(row.path)
                      else onOpenFile(row.path)
                    },
                  },
                  h('span', { className: 'dsh-ce-tree-caret' }, isDirectory ? (open ? '▾' : '▸') : ''),
                  h('span', { className: 'dsh-ce-tree-name' }, entry.name),
                )
              }),
        root !== undefined && root.truncated === true
          ? h('div', { className: 'dsh-ce-tree-empty' }, 'Показаны первые 400 записей')
          : null,
      )
    }

    // -------------------------------------------------------------- settings

    function providerKeyName(profile, provider) {
      const first = profile && Array.isArray(profile.keyNames) ? profile.keyNames[0] : ''
      if (typeof first === 'string' && first !== '') return first
      return `${String(provider || 'PROVIDER').toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`
    }

    /**
     * The settings drawer: completion provider and model, the provider's API
     * key, the context budget and the tree defaults. Everything is saved to
     * `~/.dsh/code-editor.json` on the Host, and the key never leaves the
     * credential store.
     */
    function SettingsPanel(props) {
      const preferences = props.preferences
      const models = props.models
      const sessionModel = props.sessionModel
      const onClose = props.onClose
      const onSave = props.onSave

      const [provider, setProvider] = React.useState(preferences.completionProvider || '')
      const [model, setModel] = React.useState(preferences.completionModel || '')
      const [fileTree, setFileTree] = React.useState(preferences.fileTree === true)
      const [hiddenFiles, setHiddenFiles] = React.useState(preferences.hiddenFiles === true)
      const [autoSuggest, setAutoSuggest] = React.useState(preferences.autoSuggest === true)
      const [contextLeft, setContextLeft] = React.useState(String(preferences.contextLeft))
      const [contextRight, setContextRight] = React.useState(String(preferences.contextRight))
      const [catalog, setCatalog] = React.useState(models)
      const [refreshing, setRefreshing] = React.useState(false)
      const [keyRef, setKeyRef] = React.useState(preferences.apiKeyRef || '')
      const [keyValue, setKeyValue] = React.useState('')
      const [keyStatus, setKeyStatus] = React.useState(undefined)
      const [keyBusy, setKeyBusy] = React.useState(false)
      const [message, setMessage] = React.useState('')
      const [saving, setSaving] = React.useState(false)

      const groups = catalog && Array.isArray(catalog.groups) ? catalog.groups : []
      const configurable = catalog && Array.isArray(catalog.configurable) ? catalog.configurable : []
      const profile = configurable.find((item) => item.provider === provider)

      const refreshCatalog = React.useCallback(async () => {
        setRefreshing(true)
        try {
          setCatalog(await call('catalog', {}))
        } catch (cause) {
          setMessage(cause instanceof Error ? cause.message : String(cause))
        } finally {
          setRefreshing(false)
        }
      }, [])

      const refreshKey = React.useCallback(async (ref) => {
        if (typeof ref !== 'string' || ref === '') {
          setKeyStatus(undefined)
          return
        }
        try {
          setKeyStatus(await call('credentials', { op: 'status', ref }))
        } catch (cause) {
          setKeyStatus({ ref, supported: false, message: cause instanceof Error ? cause.message : String(cause) })
        }
      }, [])

      React.useEffect(() => {
        if (catalog === undefined || catalog === null) void refreshCatalog()
      }, [])

      React.useEffect(() => {
        const suggested = providerKeyName(profile, provider)
        setKeyRef(suggested)
        void refreshKey(suggested)
      }, [provider, profile && profile.settingsNs])

      const selectedGroup = groups.find((group) => group.id === provider)
      const modelOptions = selectedGroup === undefined ? [] : selectedGroup.models

      const saveKey = React.useCallback(async () => {
        setKeyBusy(true)
        setMessage('')
        try {
          const next = await call('credentials', { op: 'set', ref: keyRef, value: keyValue })
          setKeyValue('')
          setKeyStatus(next)
          setMessage(next.configured === true ? 'Ключ сохранён.' : 'Ключ сохранён, но хранилище не подтвердило запись.')
          await refreshCatalog()
        } catch (cause) {
          setMessage(cause instanceof Error ? cause.message : String(cause))
        } finally {
          setKeyBusy(false)
        }
      }, [keyRef, keyValue, refreshCatalog])

      const clearKey = React.useCallback(async () => {
        setKeyBusy(true)
        setMessage('')
        try {
          setKeyStatus(await call('credentials', { op: 'clear', ref: keyRef }))
          setMessage('Ключ удалён: снова действует переменная окружения, если она задана.')
        } catch (cause) {
          setMessage(cause instanceof Error ? cause.message : String(cause))
        } finally {
          setKeyBusy(false)
        }
      }, [keyRef])

      const submit = React.useCallback(async () => {
        setSaving(true)
        setMessage('')
        try {
          const result = await onSave({
            completionProvider: provider,
            completionModel: model,
            fileTree,
            hiddenFiles,
            autoSuggest,
            contextLeft: Number(contextLeft),
            contextRight: Number(contextRight),
            apiKeyRef: keyRef,
          })
          setMessage('Настройки сохранены.')
          if (result && result.notice) setMessage(result.notice)
        } catch (cause) {
          setMessage(cause instanceof Error ? cause.message : String(cause))
        } finally {
          setSaving(false)
        }
      }, [onSave, provider, model, fileTree, hiddenFiles, autoSuggest, contextLeft, contextRight, keyRef])

      const row = (label, control, hint) =>
        h(
          'label',
          { className: 'dsh-ce-field' },
          h('span', { className: 'dsh-ce-field-label' }, label),
          control,
          hint === undefined ? null : h('span', { className: 'dsh-ce-field-hint' }, hint),
        )

      return h(
        'div',
        { className: 'dsh-ce-settings', role: 'dialog', 'aria-label': 'Настройки редактора' },
        h(
          'div',
          { className: 'dsh-ce-settings-head' },
          h('span', { className: 'dsh-ce-settings-title' }, 'Настройки редактора'),
          h('button', { type: 'button', className: 'dsh-ce-tree-refresh', onClick: onClose, title: 'Закрыть' }, '✕'),
        ),
        h(
          'div',
          { className: 'dsh-ce-settings-body' },
          h(
            'div',
            { className: 'dsh-ce-settings-section' },
            h('div', { className: 'dsh-ce-settings-legend' }, 'Автодополнение'),
            row(
              'Провайдер',
              h(
                'select',
                {
                  className: 'dsh-ce-input',
                  value: provider,
                  onChange: (event) => {
                    setProvider(event.target.value)
                    setModel('')
                  },
                },
                h('option', { value: '' }, `Как у сессии${sessionModel ? ` (${sessionModel.provider})` : ''}`),
                groups.map((group) => h('option', { key: group.id, value: group.id }, group.name)),
              ),
              'Пусто — модель сессии, та же, что отвечает в чате.',
            ),
            row(
              'Модель',
              h(
                'select',
                {
                  className: 'dsh-ce-input',
                  value: model,
                  onChange: (event) => setModel(event.target.value),
                },
                h('option', { value: '' }, 'Первая доступная у провайдера'),
                modelOptions.map((item) => h('option', { key: item.id, value: item.id }, item.name)),
              ),
              profile === undefined && provider !== '' ? 'Провайдер не найден в каталоге.' : undefined,
            ),
            h(
              'div',
              { className: 'dsh-ce-settings-row' },
              h(
                'button',
                { type: 'button', className: 'dsh-ce-button', onClick: refreshCatalog, disabled: refreshing },
                refreshing ? 'Обновляем…' : 'Обновить каталог',
              ),
              catalog && Array.isArray(catalog.failures) && catalog.failures.length > 0
                ? h(
                    'span',
                    { className: 'dsh-ce-field-hint', title: catalog.failures.map((item) => `${item.name}: ${item.message}`).join('\n') },
                    `Не ответили: ${catalog.failures.map((item) => item.name).join(', ')}`,
                  )
                : null,
            ),
            row(
              'Автоподсказки',
              h(
                'input',
                {
                  type: 'checkbox',
                  checked: autoSuggest,
                  onChange: (event) => setAutoSuggest(event.target.checked),
                },
              ),
              'Без этой галочки подсказка приходит только по Ctrl+Space.',
            ),
          ),
          h(
            'div',
            { className: 'dsh-ce-settings-section' },
            h('div', { className: 'dsh-ce-settings-legend' }, 'API-ключ провайдера'),
            row(
              'Имя ключа',
              h('input', {
                className: 'dsh-ce-input',
                value: keyRef,
                spellCheck: false,
                placeholder: 'DEEPSEEK_API_KEY',
                onChange: (event) => {
                  setKeyRef(event.target.value.toUpperCase())
                  setKeyStatus(undefined)
                },
                onBlur: () => void refreshKey(keyRef),
              }),
              keyStatus === undefined
                ? 'Имя переменной окружения, под которым ключ хранится в DSH.'
                : keyStatus.supported === false
                  ? keyStatus.message || 'Хранилище ключей недоступно.'
                  : keyStatus.configured === true
                    ? `Ключ есть${keyStatus.source ? ` · источник: ${keyStatus.source}` : ''}${keyStatus.masked ? ` · ${keyStatus.masked}` : ''}`
                    : 'Ключ не задан: модель может отвечать ошибкой авторизации.',
            ),
            row(
              'Новый ключ',
              h('input', {
                className: 'dsh-ce-input',
                type: 'password',
                value: keyValue,
                spellCheck: false,
                autoComplete: 'off',
                placeholder: 'вставьте ключ и нажмите «Сохранить ключ»',
                onChange: (event) => setKeyValue(event.target.value),
              }),
              'Значение уходит только в хранилище ключей DSH и не попадает в файл настроек.',
            ),
            h(
              'div',
              { className: 'dsh-ce-settings-row' },
              h(
                'button',
                {
                  type: 'button',
                  className: 'dsh-ce-button dsh-ce-button-primary',
                  onClick: saveKey,
                  disabled: keyBusy || keyValue === '' || keyRef === '',
                },
                'Сохранить ключ',
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'dsh-ce-button',
                  onClick: clearKey,
                  disabled: keyBusy || keyRef === '',
                  title: 'Удалить сохранённый ключ',
                },
                'Удалить ключ',
              ),
            ),
          ),
          h(
            'div',
            { className: 'dsh-ce-settings-section' },
            h('div', { className: 'dsh-ce-settings-legend' }, 'Вид и контекст'),
            row(
              'Дерево файлов',
              h('input', { type: 'checkbox', checked: fileTree, onChange: (event) => setFileTree(event.target.checked) }),
              'Панель файлов слева от редактора.',
            ),
            row(
              'Скрытые файлы',
              h('input', { type: 'checkbox', checked: hiddenFiles, onChange: (event) => setHiddenFiles(event.target.checked) }),
              'Показывать .gitignore, .env и прочие точки.',
            ),
            row(
              'Символов до курсора',
              h('input', {
                className: 'dsh-ce-input dsh-ce-input-number',
                type: 'number',
                min: 200,
                max: 20000,
                value: contextLeft,
                onChange: (event) => setContextLeft(event.target.value),
              }),
              'Сколько текста файла уходит провайдеру перед курсором.',
            ),
            row(
              'Символов после курсора',
              h('input', {
                className: 'dsh-ce-input dsh-ce-input-number',
                type: 'number',
                min: 0,
                max: 8000,
                value: contextRight,
                onChange: (event) => setContextRight(event.target.value),
              }),
              '0 — не отправлять текст после курсора.',
            ),
          ),
          message === '' ? null : h('div', { className: 'dsh-ce-settings-message' }, message),
        ),
        h(
          'div',
          { className: 'dsh-ce-settings-foot' },
          h(
            'button',
            { type: 'button', className: 'dsh-ce-button dsh-ce-button-primary', onClick: submit, disabled: saving },
            saving ? 'Сохраняем…' : 'Сохранить настройки',
          ),
          h('button', { type: 'button', className: 'dsh-ce-button', onClick: onClose }, 'Закрыть'),
        ),
      )
    }

    // ------------------------------------------------------------ editor body

    function EditorBody(props) {
      const tab = tabOf(props)
      const address = tab ? tab.contentId : undefined
      const target = React.useMemo(() => parseFileAddress(address), [address])

      const hostRef = React.useRef(null)
      const runtime = React.useRef({
        editor: undefined,
        monaco: undefined,
        document: undefined,
        sessionId: target && target.sessionId,
        tabId: tab && tab.id,
        save: undefined,
        quote: undefined,
        smartTab: false,
        fileExcluded: false,
        benchRunning: false,
        contextLeft: 4000,
        contextRight: 1000,
        autoSuggest: true,
        committedText: undefined,
        committedOffset: undefined,
        committedAt: 0,
        lastShown: undefined,
        lastShownOffset: undefined,
        lastShownAt: 0,
        completionController: undefined,
        benchmarkController: undefined,
        timings: [],
      })

      const [state, setState] = React.useState({ status: 'loading', message: '' })
      const [document, setDocument] = React.useState(undefined)
      const [dirty, setDirty] = React.useState(false)
      const [saving, setSaving] = React.useState(false)
      const [smartTab, setSmartTab] = React.useState(false)
      const [fileExcluded, setFileExcluded] = React.useState(false)
      const [consentPending, setConsentPending] = React.useState(false)
      const [closePrompt, setClosePrompt] = React.useState(false)
      const [contextBudget, setContextBudget] = React.useState(undefined)
      const [notice, setNotice] = React.useState('')
      const [stats, setStats] = React.useState({ count: 0, p50: 0, p95: 0 })
      const [preferences, setPreferences] = React.useState(undefined)
      const [treeOpen, setTreeOpen] = React.useState(false)
      const [settingsOpen, setSettingsOpen] = React.useState(false)
      const [catalog, setCatalog] = React.useState(undefined)
      const dirtyRef = React.useRef(false)
      React.useEffect(() => {
        dirtyRef.current = dirty
      }, [dirty])

      const patch = React.useCallback((next) => {
        setState((current) => (current.status === next.status && current.message === next.message ? current : next))
      }, [])

      const pushMeasurement = React.useCallback((durationMs) => {
        const timings = runtime.current.timings
        timings.push(durationMs)
        if (timings.length > MAX_MEASUREMENTS) timings.shift()
        const sorted = timings.slice().sort((a, b) => a - b)
        const pick = (fraction) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * fraction)))]
        setStats({ count: sorted.length, p50: pick(0.5), p95: pick(0.95) })
      }, [])

      // ---- editor preferences: one read per mounted tab
      React.useEffect(() => {
        let cancelled = false
        call('prefs', {})
          .then((payload) => {
            if (cancelled) return
            const next = payload && payload.preferences ? payload.preferences : undefined
            if (next === undefined) return
            runtime.current.contextLeft = next.contextLeft
            runtime.current.contextRight = next.contextRight
            runtime.current.autoSuggest = next.autoSuggest === true
            setPreferences(next)
            setTreeOpen(next.fileTree === true)
            setContextBudget({ left: next.contextLeft, right: next.contextRight })
          })
          .catch(() => {
            // The editor keeps working with the built-in defaults.
          })
        return () => {
          cancelled = true
        }
      }, [])

      // ---- open the document through the Host half
      React.useEffect(() => {
        if (target === undefined) {
          patch({ status: 'error', message: 'Не удалось разобрать адрес файла в этой вкладке' })
          return undefined
        }
        let cancelled = false
        patch({ status: 'loading', message: '' })
        call('open', { sessionId: target.sessionId, path: target.path })
          .then((payload) => {
            if (cancelled) return
            runtime.current.document = payload
            runtime.current.sessionId = payload.sessionId !== undefined ? payload.sessionId : target.sessionId
            runtime.current.smartTab = payload.smartTab === true
            runtime.current.fileExcluded = payload.fileExcluded === true
            if (payload.context !== undefined) {
              runtime.current.contextLeft = payload.context.left
              runtime.current.contextRight = payload.context.right
              setContextBudget(payload.context)
            }
            setDocument(payload)
            setSmartTab(payload.smartTab === true)
            setFileExcluded(payload.fileExcluded === true)
            patch({ status: 'ready', message: '' })
          })
          .catch((cause) => {
            if (cancelled) return
            patch({ status: 'error', message: cause instanceof Error ? cause.message : String(cause) })
          })
        return () => {
          cancelled = true
        }
      }, [target === undefined ? '' : `${target.sessionId}\u0000${target.path}`, patch])

      React.useEffect(() => {
        if (!tab || typeof tab.id !== 'string') return undefined
        const prompt = () => setClosePrompt(true)
        closePromptHandlers.set(tab.id, prompt)
        return () => {
          if (closePromptHandlers.get(tab.id) === prompt) closePromptHandlers.delete(tab.id)
        }
      }, [tab && tab.id])

      // ---- create the editor once the document text is known
      React.useEffect(() => {
        if (document === undefined || hostRef.current === null) return undefined
        let disposed = false
        let editor
        let provider
        let subscription

        const start = async () => {
          const monaco = await loadMonaco()
          if (disposed || hostRef.current === null) return
          runtime.current.monaco = monaco
          editor = monaco.editor.create(hostRef.current, {
            value: document.text,
            language: document.language,
            theme: resolveEditorTheme(),
            readOnly: document.readOnly === true,
            automaticLayout: true,
            minimap: { enabled: false },
            scrollBeyondLastLine: false,
            fontSize: 13,
            lineHeight: 20,
            renderWhitespace: 'selection',
            tabSize: 2,
            insertSpaces: true,
            scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10 },
            fixedOverflowWidgets: true,
            // Ctrl+Space не должен показывать слова из самого файла: список из
            // хешей и имён переменных закрывал собой настоящую подсказку и
            // выглядел как ответ модели.
            wordBasedSuggestions: 'off',
            padding: { top: 8, bottom: 24 },
          })
          runtime.current.editor = editor

          subscription = editor.onDidChangeModelContent(() => {
            if (disposed) return
            runtime.current.completionController?.abort()
            runtime.current.completionController = undefined
            runtime.current.benchmarkController?.abort()
            runtime.current.benchmarkController = undefined
            // Typing after a shown completion means it was accepted or edited:
            // keep that buffer as the baseline the next request is measured
            // against, so the assistant's own latency stays out of the stats.
            if (runtime.current.lastShown !== undefined && Date.now() - runtime.current.lastShownAt < 5000) {
              runtime.current.committedText = runtime.current.lastShown
              runtime.current.committedOffset = runtime.current.lastShownOffset
              runtime.current.committedAt = Date.now()
            }
            runtime.current.lastShown = undefined
            if (runtime.current.tabId) dirtyTabs.add(runtime.current.tabId)
            setDirty(true)
          })

          const save = async () => {
            const current = runtime.current
            if (current.editor === undefined || current.document === undefined) return false
            if (current.document.readOnly === true) {
              setNotice('Файл открыт только для чтения')
              return false
            }
            setSaving(true)
            setNotice('')
            try {
              const payload = await call('save', {
                id: current.document.id,
                sessionId: current.sessionId,
                token: current.document.token,
                text: current.editor.getValue(),
              })
              current.document = Object.assign({}, current.document, { token: payload.token })
              setDocument(current.document)
              if (current.tabId) dirtyTabs.delete(current.tabId)
              setDirty(false)
              setNotice(payload.operation === 'create' ? 'Файл создан' : 'Сохранено')
              return true
            } catch (cause) {
              setNotice(cause instanceof Error ? cause.message : String(cause))
              return false
            } finally {
              setSaving(false)
            }
          }
          runtime.current.save = save
          editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
            void save()
          })

          // Диагностика: 100 последовательных запросов подсказки на живой модели,
          // чтобы подтвердить p50/p95 из плана до включения умного Tab по умолчанию.
          const runBenchmark = async () => {
            const current = runtime.current
            if (current.benchRunning === true) return
            if (current.editor === undefined || current.document === undefined) return
            if (current.sessionId === undefined) return
            current.benchRunning = true
            const controller = new AbortController()
            current.benchmarkController?.abort()
            current.benchmarkController = controller
            const model = current.editor.getModel()
            const position = current.editor.getPosition()
            if (model === null || position === null) {
              current.benchRunning = false
              return
            }
            const offset = model.getOffsetAt(position)
            // The benchmark sends frozen text so it measures the round trip.
            // `offset` must stay on the model's live coordinate system: the Host
            // clamps it to the frozen text, and the client compares the result
            // with the same live number below.
            const full = model.getValue()
            const samples = []
            let answered = 0
            try {
              for (let index = 0; index < BENCHMARK_SAMPLES; index += 1) {
                setNotice(`Замер: ${index + 1}/${BENCHMARK_SAMPLES}`)
                const startedAt = Date.now()
                await new Promise((resolve) => setTimeout(resolve, COMPLETION_PAUSE_MS))
                const payload = await call('complete', {
                  id: current.document.id,
                  sessionId: current.sessionId,
                  token: current.document.token,
                  text: full,
                  offset,
                  selection: '',
                  contextLeft: current.contextLeft,
                  contextRight: current.contextRight,
                }, controller.signal)
                const durationMs = Math.max(payload.durationMs ?? 0, Date.now() - startedAt) + COMPLETION_PAUSE_MS
                samples.push(durationMs)
                pushMeasurement(durationMs)
                if (typeof payload.text === 'string' && payload.text.trim() !== '') answered += 1
              }
              const sorted = samples.slice().sort((a, b) => a - b)
              const pick = (fraction) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * fraction)))]
              setNotice(
                samples.length === 0
                  ? 'Замер не дал ответов — модель недоступна'
                  : `Замер ${sorted.length}: p50 ${pick(0.5)} мс, p95 ${pick(0.95)} мс, max ${sorted[sorted.length - 1]} мс; непустых вставок ${answered}`,
              )
            } catch (cause) {
              setNotice(`Замер прерван: ${cause instanceof Error ? cause.message : String(cause)}`)
            } finally {
              current.benchRunning = false
              if (current.benchmarkController === controller) current.benchmarkController = undefined
            }
          }
          editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Alt | monaco.KeyCode.KeyB, () => {
            void runBenchmark()
          })
          runtime.current.benchmark = runBenchmark

          const quote = () => {
            const current = runtime.current
            const actions = props.inputActions
            const activeEditor = current.editor
            if (activeEditor === undefined || current.document === undefined) return
            if (!actions || typeof actions.insertQuote !== 'function') {
              setNotice('Чат недоступен в этой панели')
              return
            }
            const model = activeEditor.getModel()
            const selection = activeEditor.getSelection()
            if (model === null) return
            const hasSelection = selection !== null && !selection.isEmpty()
            const cursor = activeEditor.getPosition()
            const start = hasSelection ? selection.getStartPosition() : cursor
            const end = hasSelection ? selection.getEndPosition() : cursor
            if (start === null || end === null) {
              setNotice('Курсор редактора недоступен')
              return
            }
            const selected = hasSelection
              ? model.getValueInRange(selection)
              : model.getLineContent(start.lineNumber)
            if (selected.trim() === '') {
              setNotice(hasSelection ? 'Выделение пустое' : 'Текущая строка пустая')
              return
            }
            const relativePath = current.document.relativePath || current.document.displayPath
            const label = `${relativePath}:${start.lineNumber}–${end.lineNumber} · из буфера`
            const text = `${label}\n${selected}`
            const summary = {
              label,
              title: 'Фрагмент из редактора',
              detail: relativePath,
              body: selected,
            }
            let accepted = false
            try {
              accepted = actions.insertQuote(text, summary) === true
            } catch (cause) {
              setNotice(cause instanceof Error ? cause.message : String(cause))
              return
            }
            setNotice(accepted ? 'Добавлено в поле ввода' : 'Поле ввода занято — очистите его и повторите')
          }
          runtime.current.quote = quote

          if (document.readOnly !== true) {
            provider = monaco.languages.registerInlineCompletionsProvider(document.language, {
              freeInlineCompletions() {},
              disposeInlineCompletions() {},
              async provideInlineCompletions(model, position, _context, token) {
                if (disposed || runtime.current.smartTab !== true || runtime.current.benchRunning === true) return { items: [] }
                if (editor.getSelection() !== null && editor.getSelection().isEmpty() === false) {
                  return { items: [] }
                }
                // Explicit — это Ctrl+Space: человек уже попросил, ждать паузу
                // «пользователь перестал печатать» незачем. Automatic (0) —
                // умный Tab, он ждёт COMPLETION_PAUSE_MS.
                const explicit = _context !== undefined && _context.triggerKind === 1
                if (!explicit && runtime.current.autoSuggest !== true) return { items: [] }
                if (!explicit) {
                  await new Promise((resolve) => setTimeout(resolve, COMPLETION_PAUSE_MS))
                  if (token.isCancellationRequested) return { items: [] }
                }

                const offset = model.getOffsetAt(position)
                const full = model.getValue()
                // The baseline to replace: the last buffer that preceded real
                // typing, or — when the user simply paused — the buffer on screen
                // when the debounce started. Measuring either against the live
                // buffer would count our own wait as the model's latency.
                const committed = runtime.current.committedText
                const baseline =
                  committed === undefined || Date.now() - runtime.current.committedAt > 30000 || committed === full
                    ? { text: full, offset }
                    : { text: committed, offset: runtime.current.committedOffset }
                const selection = editor.getSelection()
                const selectedText = selection === null || selection.isEmpty() ? '' : model.getValueInRange(selection)
                const versionId = model.getVersionId()
                const current = runtime.current.document
                if (current === undefined) return { items: [] }

                const startedAt = Date.now()
                const controller = new AbortController()
                runtime.current.completionController?.abort()
                runtime.current.completionController = controller
                const cancellation = token.onCancellationRequested(() => controller.abort())
                let payload
                try {
                  payload = await call('complete', {
                    id: current.id,
                    sessionId: runtime.current.sessionId,
                    token: current.token,
                    text: baseline.text,
                    offset: baseline.offset,
                    selection: selectedText,
                    contextLeft: runtime.current.contextLeft,
                    contextRight: runtime.current.contextRight,
                  }, controller.signal)
                } catch (cause) {
                  if (!controller.signal.aborted) {
                    const reason = cause instanceof Error ? cause.message : String(cause)
                    setNotice(`Подсказки недоступны: ${reason}`)
                  }
                  return { items: [] }
                } finally {
                  cancellation.dispose()
                  if (runtime.current.completionController === controller) runtime.current.completionController = undefined
                }
                const durationMs = Math.max(payload.durationMs ?? 0, Date.now() - startedAt) + (explicit ? 0 : COMPLETION_PAUSE_MS)
                pushMeasurement(durationMs)

                if (disposed || token.isCancellationRequested || model.getVersionId() !== versionId) return { items: [] }
                const text = typeof payload.text === 'string' ? payload.text : ''
                if (text.trim() === '') {
                  if (explicit) setNotice(`Подсказка: пусто, модель промолчала (${Math.round(durationMs)} мс)`)
                  return { items: [] }
                }
                if (explicit) {
                  const firstLine = text.replace(/^\r?\n/, '').split('\n')[0].trim().slice(0, 40)
                  setNotice(`Подсказка: ${Math.round(durationMs)} мс · ${firstLine}… · Tab вставит, Esc уберёт`)
                }
                const live = editor.getPosition()
                if (live === null || live.lineNumber !== position.lineNumber || live.column !== position.column) {
                  return { items: [] }
                }
                runtime.current.lastShown = model.getValue()
                runtime.current.lastShownOffset = model.getOffsetAt(position)
                runtime.current.lastShownAt = Date.now()
                return {
                  items: [
                    {
                      insertText: text,
                      range: {
                        startLineNumber: position.lineNumber,
                        startColumn: position.column,
                        endLineNumber: position.lineNumber,
                        endColumn: position.column,
                      },
                    },
                  ],
                }
              },
            })
          }

          // Ctrl+Space — подсказка по требованию: тот же запрос, что делает
          // умный Tab, но без паузы и без ожидания набора. Рисует её сам Monaco:
          // inline suggest показывает серый текст отдельными строками под
          // курсором, Tab вставляет, Esc убирает. Свой призрачный текст в
          // декорации для этого не годится — инъекция `after` однострочная, и
          // многострочный ответ склеивался в одну строку с «⏎».
          if (document.readOnly !== true) {
            editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Space, () => {
              const current = runtime.current
              if (current.benchRunning === true) {
                setNotice('Замер идёт — подсказка подождёт')
                return
              }
              if (current.smartTab !== true) {
                setNotice('Подсказки выключены для этой папки: нажмите «Таб-подсказки», чтобы включить')
                return
              }
              setNotice('Подсказка: запрос…')
              // Explicit-триггер идёт через тот же provideInlineCompletions, что
              // обслуживает умный Tab: второго HTTP-пути нет, поэтому и ответ, и
              // замер попадают в те же счётчики.
              editor.trigger('dsh-code-editor', 'editor.action.inlineSuggest.trigger', {})
            })
          }
        }

        start().catch((cause) => {
          patch({ status: 'error', message: cause instanceof Error ? cause.message : String(cause) })
        })

        return () => {
          disposed = true
          runtime.current.completionController?.abort()
          runtime.current.completionController = undefined
          runtime.current.benchmarkController?.abort()
          runtime.current.benchmarkController = undefined
          runtime.current.save = undefined
          runtime.current.benchmark = undefined
          runtime.current.quote = undefined
          runtime.current.editor = undefined
          try {
            try {
            provider && provider.dispose()
          } catch {
            // Провайдер мог не создаться — освобождать нечего.
          }
          } catch {
            /* ignore */
          }
          try {
            subscription && subscription.dispose()
          } catch {
            /* ignore */
          }
          try {
            editor && editor.dispose()
          } catch {
            /* ignore */
          }
        }
      }, [document === undefined ? '' : document.id, patch, props.inputActions, pushMeasurement])

      const changeWorkspaceSmartTab = React.useCallback(async (next) => {
        const current = runtime.current
        if (current.document === undefined) return
        try {
          const payload = await call('settings', {
            id: current.document.id,
            sessionId: current.sessionId,
            smartTab: next,
          })
          current.smartTab = payload.smartTab === true
          setSmartTab(current.smartTab)
          if (!current.smartTab) {
            current.completionController?.abort()
            current.benchmarkController?.abort()
          }
          setConsentPending(false)
          setNotice(current.smartTab ? 'Подсказки включены для этой папки' : 'Подсказки выключены')
        } catch (cause) {
          setNotice(cause instanceof Error ? cause.message : String(cause))
        }
      }, [])

      const toggleSmartTab = React.useCallback(() => {
        const current = runtime.current
        if (current.document === undefined) return
        if (current.smartTab) {
          void changeWorkspaceSmartTab(false)
          return
        }
        if (current.document.completionExcluded === true) {
          setNotice('Для этого файла подсказки отключены: путь похож на хранилище секретов')
          return
        }
        setNotice('')
        setConsentPending(true)
      }, [changeWorkspaceSmartTab])

      const confirmSmartTab = React.useCallback(() => {
        void changeWorkspaceSmartTab(true)
      }, [changeWorkspaceSmartTab])

      const toggleFileExclusion = React.useCallback(async () => {
        const current = runtime.current
        if (current.document === undefined) return
        const next = current.fileExcluded !== true
        try {
          const payload = await call('settings', {
            id: current.document.id,
            sessionId: current.sessionId,
            excludeFile: next,
          })
          current.fileExcluded = payload.fileExcluded === true
          current.smartTab = payload.smartTab === true
          setFileExcluded(current.fileExcluded)
          setSmartTab(current.smartTab)
          if (!current.smartTab) {
            current.completionController?.abort()
            current.benchmarkController?.abort()
          }
          setNotice(current.fileExcluded ? 'Подсказки выключены для этого файла' : 'Исключение снято')
        } catch (cause) {
          setNotice(cause instanceof Error ? cause.message : String(cause))
        }
      }, [])

      // Switch the open document inside this tab. The editor is recreated by its
      // own effect when the document id changes, so the model, token and dirty
      // flag all come back from the Host instead of being patched by hand.
      const openRelative = React.useCallback(async (relativePath) => {
        const current = runtime.current
        if (typeof relativePath !== 'string' || relativePath === '') return
        if (dirtyRef.current) {
          setNotice('Сохраните текущий файл (Ctrl+S): переключение не должно терять правки')
          return
        }
        try {
          const payload = await call('open', { sessionId: current.sessionId, path: relativePath })
          current.document = payload
          current.committedText = undefined
          current.committedOffset = undefined
          current.lastShown = undefined
          current.lastShownOffset = undefined
          setDocument(payload)
          setDirty(false)
          setSmartTab(payload.smartTab === true)
          setFileExcluded(payload.fileExcluded === true)
          if (payload.context !== undefined) {
            current.contextLeft = payload.context.left
            current.contextRight = payload.context.right
            setContextBudget(payload.context)
          }
          setNotice('')
        } catch (cause) {
          setNotice(cause instanceof Error ? cause.message : String(cause))
        }
      }, [])

      const savePreferences = React.useCallback(async (patch) => {
        const payload = await call('prefs', { patch })
        const next = payload && payload.preferences ? payload.preferences : undefined
        if (next === undefined) throw new Error('Хост не вернул настройки')
        runtime.current.contextLeft = next.contextLeft
        runtime.current.contextRight = next.contextRight
        runtime.current.autoSuggest = next.autoSuggest === true
        setPreferences(next)
        setTreeOpen(next.fileTree === true)
        setContextBudget({ left: next.contextLeft, right: next.contextRight })
        return {}
      }, [])

      const openSettings = React.useCallback(() => {
        setSettingsOpen(true)
        call('catalog', {})
          .then((payload) => setCatalog(payload))
          .catch(() => setCatalog(undefined))
      }, [])

      const onSave = React.useCallback(() => {
        if (runtime.current.save) void runtime.current.save()
      }, [])

      const discardAndClose = React.useCallback(() => {
        if (tab && tab.id) dirtyTabs.delete(tab.id)
        setDirty(false)
        setClosePrompt(false)
        tab?.actions?.close?.()
      }, [tab && tab.id, tab && tab.actions])

      const saveAndClose = React.useCallback(async () => {
        const saved = await runtime.current.save?.()
        if (saved) {
          setClosePrompt(false)
          tab?.actions?.close?.()
        }
      }, [tab && tab.actions])

      const onQuote = React.useCallback(() => {
        if (runtime.current.quote) runtime.current.quote()
      }, [])

      const onBenchmark = React.useCallback(() => {
        if (runtime.current.benchmark) void runtime.current.benchmark()
      }, [])

      const title = document === undefined ? 'Редактор' : baseName(document.displayPath)
      const statusLine =
        state.status === 'loading'
          ? 'Открываем файл…'
          : state.status === 'error'
            ? state.message
            : notice !== ''
              ? notice
              : dirty
                ? 'Есть несохранённые правки'
                : 'Сохранено'

      return h(
        'div',
        { className: 'dsh-ce-root' },
        h(
          'div',
          { className: 'dsh-ce-toolbar' },
          h('span', { className: 'dsh-ce-file', title: document ? document.displayPath : '' }, title),
          document && dirty ? h('span', { className: 'dsh-ce-dirty', title: 'Есть несохранённые правки' }, '●') : null,
          h('span', { className: 'dsh-ce-spacer' }),
          h(
            'button',
            {
              type: 'button',
              className: 'dsh-ce-button' + (treeOpen ? ' dsh-ce-button-active' : ''),
              onClick: () => {
                const next = !treeOpen
                setTreeOpen(next)
                void call('prefs', { patch: { fileTree: next } }).catch(() => {})
              },
              disabled: document === undefined,
              title: 'Дерево файлов рабочей папки',
            },
            'Файлы',
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'dsh-ce-button',
              onClick: openSettings,
              disabled: document === undefined,
              title: 'Настройки: провайдер и модель подсказок, API-ключ, контекст',
            },
            '⚙',
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'dsh-ce-button',
              onClick: toggleSmartTab,
              disabled: document === undefined || document.readOnly === true || document.completionExcluded === true,
              title: document && document.completionExcluded
                ? 'Подсказки запрещены для этого пути'
                : 'Подсказки модели: отправляют контекст провайдеру выбранной модели, Tab принимает',
            },
            smartTab ? 'Tab-подсказки: вкл' : 'Tab-подсказки: выкл',
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'dsh-ce-button',
              onClick: onBenchmark,
              disabled: document === undefined || document.readOnly === true,
              title: 'Замер p50/p95: 100 запросов подсказки на текущей модели',
            },
            'Замер',
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'dsh-ce-button',
              onClick: toggleFileExclusion,
              disabled: document === undefined || document.completionExcluded === true,
              title: 'Исключить этот файл из AI-подсказок',
            },
            fileExcluded ? 'Включить файл' : 'Исключить файл',
          ),
          stats.count > 0
            ? h('span', { className: 'dsh-ce-stats', title: 'Замеры подсказок в этой вкладке' }, `${stats.count} · p50 ${stats.p50} мс · p95 ${stats.p95} мс`)
            : null,
          h(
            'button',
            {
              type: 'button',
              className: 'dsh-ce-button',
              onClick: onQuote,
              disabled: document === undefined,
              title: 'Вставить выделение в поле ввода текущего чата',
            },
            'В чат',
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'dsh-ce-button dsh-ce-button-primary',
              onClick: onSave,
              disabled: document === undefined || saving || document.readOnly === true,
              title: 'Сохранить (Ctrl+S)',
            },
            saving ? 'Сохраняем…' : 'Сохранить',
          ),
        ),
        consentPending && document !== undefined
          ? h(
              'div',
              { className: 'dsh-ce-consent', role: 'group', 'aria-label': 'Разрешение на inline-подсказки' },
              h(
                'p',
                null,
                `Подсказки отправляют до ${contextBudget?.left ?? runtime.current.contextLeft} символов перед курсором и ${contextBudget?.right ?? runtime.current.contextRight} после него из текущего файла провайдеру ${document.model?.provider ?? 'текущей модели'}/${document.model?.model ?? ''}. ` +
                  'Запрос не записывается отдельным сообщением в журнал этой сессии; хранение на стороне провайдера зависит от его политики.',
              ),
              h('button', { type: 'button', className: 'dsh-ce-button dsh-ce-button-primary', onClick: confirmSmartTab }, 'Включить для рабочей папки'),
              h('button', { type: 'button', className: 'dsh-ce-button', onClick: () => setConsentPending(false) }, 'Не сейчас'),
            )
          : null,
        closePrompt
          ? h(
              'div',
              { className: 'dsh-ce-consent', role: 'group', 'aria-label': 'Несохранённые изменения' },
              h('p', null, 'Есть несохранённые изменения. Сохраните файл перед закрытием или отбросьте правки.'),
              h('button', { type: 'button', className: 'dsh-ce-button dsh-ce-button-primary', onClick: () => { void saveAndClose() } }, 'Сохранить и закрыть'),
              h('button', { type: 'button', className: 'dsh-ce-button', onClick: discardAndClose }, 'Отбросить и закрыть'),
              h('button', { type: 'button', className: 'dsh-ce-button', onClick: () => setClosePrompt(false) }, 'Оставить открытым'),
            )
          : null,
        settingsOpen && preferences !== undefined
          ? h(SettingsPanel, {
              preferences,
              models: catalog,
              sessionModel: document === undefined ? undefined : document.model,
              onClose: () => setSettingsOpen(false),
              onSave: savePreferences,
            })
          : null,
        h(
          'div',
          { className: 'dsh-ce-body' },
          treeOpen && document !== undefined
            ? h(TreePanel, {
                sessionId: runtime.current.sessionId,
                hidden: preferences !== undefined && preferences.hiddenFiles === true,
                activePath: document.relativePath,
                onOpenFile: openRelative,
              })
            : null,
          h(
            'div',
            { className: 'dsh-ce-main' },
            state.status === 'error'
              ? h('div', { className: 'dsh-ce-error' }, state.message)
              : h('div', { className: 'dsh-ce-stage', ref: hostRef }),
          ),
        ),
        h('div', { className: 'dsh-ce-status' }, statusLine),
      )
    }

    // ----------------------------------------------------------------- styles

    const STYLES = `
.dsh-ce-root { display: flex; flex-direction: column; height: 100%; min-height: 0; position: relative; }
.dsh-ce-toolbar { display: flex; align-items: center; gap: 6px; padding: 4px 8px; border-bottom: 1px solid var(--dsh-border, rgba(127,127,127,.25)); flex: 0 0 auto; }
.dsh-ce-file { font: 600 12px/1.4 var(--dsh-font-ui, system-ui, sans-serif); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 40%; }
.dsh-ce-dirty { color: var(--dsh-color-accent, #d98b18); font-size: 10px; }
.dsh-ce-spacer { flex: 1 1 auto; }
.dsh-ce-button { font: 500 11px/1.2 var(--dsh-font-ui, system-ui, sans-serif); color: inherit; background: transparent; border: 1px solid var(--dsh-border, rgba(127,127,127,.35)); border-radius: 5px; padding: 3px 8px; cursor: pointer; white-space: nowrap; }
.dsh-ce-button:hover:not(:disabled) { background: var(--dsh-hover, rgba(127,127,127,.14)); }
.dsh-ce-button:disabled { opacity: .5; cursor: default; }
.dsh-ce-button-primary { border-color: var(--dsh-accent, #3b82f6); }
.dsh-ce-stats { font: 400 10px/1.2 var(--dsh-font-mono, monospace); opacity: .65; white-space: nowrap; }
.dsh-ce-consent { flex: 0 0 auto; margin: 8px; padding: 8px 10px; border: 1px solid var(--dsh-border, rgba(127,127,127,.35)); border-radius: 8px; font: 400 11px/1.45 var(--dsh-font-ui, system-ui, sans-serif); }
.dsh-ce-consent p { margin: 0 0 8px; }
.dsh-ce-consent button + button { margin-left: 6px; }
.dsh-ce-stage { flex: 1 1 auto; min-height: 0; }
.dsh-ce-status { flex: 0 0 auto; padding: 3px 8px; font: 400 11px/1.3 var(--dsh-font-ui, system-ui, sans-serif); opacity: .75; border-top: 1px solid var(--dsh-border, rgba(127,127,127,.2)); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dsh-ce-error { margin: 12px; padding: 10px 12px; border: 1px solid var(--dsh-border, rgba(127,127,127,.35)); border-radius: 8px; font: 400 12px/1.5 var(--dsh-font-ui, system-ui, sans-serif); }
.dsh-ce-action { display: inline-flex; align-items: center; gap: 4px; }
.dsh-ce-action-button { font: 500 11px/1.2 var(--dsh-font-ui, system-ui, sans-serif); color: inherit; background: transparent; border: 1px solid var(--dsh-border, rgba(127,127,127,.35)); border-radius: 5px; padding: 2px 8px; cursor: pointer; }
.dsh-ce-action-button:hover:not(:disabled) { background: var(--dsh-hover, rgba(127,127,127,.14)); }
.dsh-ce-action-button:disabled { opacity: .5; cursor: default; }
.dsh-ce-action-error { color: #d9534f; font-weight: 700; cursor: help; }
.dsh-ce-button-active { border-color: var(--dsh-accent, #3b82f6); background: var(--dsh-hover, rgba(127,127,127,.14)); }
.dsh-ce-body { display: flex; flex: 1 1 auto; min-height: 0; }
.dsh-ce-main { display: flex; flex-direction: column; flex: 1 1 auto; min-width: 0; min-height: 0; }
.dsh-ce-main > .dsh-ce-stage { flex: 1 1 auto; }
.dsh-ce-tree { flex: 0 0 190px; width: 190px; overflow: auto; padding: 2px 0 8px; border-right: 1px solid var(--dsh-border, rgba(127,127,127,.25)); font: 400 12px/1.5 var(--dsh-font-ui, system-ui, sans-serif); }
.dsh-ce-tree-head { display: flex; align-items: center; justify-content: space-between; padding: 2px 6px 4px; font: 600 11px/1.4 var(--dsh-font-ui, system-ui, sans-serif); opacity: .8; }
.dsh-ce-tree-refresh { border: 0; background: transparent; color: inherit; cursor: pointer; font-size: 12px; padding: 0 4px; opacity: .7; }
.dsh-ce-tree-refresh:hover { opacity: 1; }
.dsh-ce-tree-row { display: flex; align-items: center; width: 100%; border: 0; background: transparent; color: inherit; text-align: left; cursor: pointer; padding: 1px 6px; font: inherit; }
.dsh-ce-tree-row:hover { background: var(--dsh-hover, rgba(127,127,127,.14)); }
.dsh-ce-tree-active { background: var(--dsh-hover, rgba(127,127,127,.2)); }
.dsh-ce-tree-caret { flex: 0 0 10px; width: 10px; font-size: 10px; opacity: .6; }
.dsh-ce-tree-name { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dsh-ce-tree-error { padding: 2px 10px; color: #d9534f; font-size: 11px; }
.dsh-ce-tree-empty { padding: 2px 10px; font-size: 11px; opacity: .6; }
.dsh-ce-settings { position: absolute; inset: 0; z-index: 5; display: flex; flex-direction: column; background: var(--dsh-bg-elevated, var(--dsh-bg, #1b1b1b)); }
.dsh-ce-settings-head { display: flex; align-items: center; justify-content: space-between; padding: 6px 10px; border-bottom: 1px solid var(--dsh-border, rgba(127,127,127,.25)); font: 600 12px/1.4 var(--dsh-font-ui, system-ui, sans-serif); }
.dsh-ce-settings-body { flex: 1 1 auto; overflow: auto; padding: 8px 10px 12px; }
.dsh-ce-settings-section { margin-bottom: 14px; }
.dsh-ce-settings-legend { margin-bottom: 6px; font: 600 10.5px/1.4 var(--dsh-font-ui, system-ui, sans-serif); letter-spacing: .04em; text-transform: uppercase; opacity: .6; }
.dsh-ce-field { display: flex; flex-direction: column; gap: 3px; margin-bottom: 9px; }
.dsh-ce-field-label { font: 500 11px/1.4 var(--dsh-font-ui, system-ui, sans-serif); opacity: .85; }
.dsh-ce-field-hint { font: 400 10.5px/1.4 var(--dsh-font-ui, system-ui, sans-serif); opacity: .6; }
.dsh-ce-input { box-sizing: border-box; width: 100%; padding: 4px 6px; font: 400 12px/1.4 var(--dsh-font-ui, system-ui, sans-serif); color: inherit; background: var(--dsh-input-bg, rgba(127,127,127,.08)); border: 1px solid var(--dsh-border, rgba(127,127,127,.35)); border-radius: 5px; }
.dsh-ce-input-number { width: 120px; }
.dsh-ce-settings-row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-bottom: 8px; }
.dsh-ce-settings-message { margin-top: 6px; font: 400 11px/1.45 var(--dsh-font-ui, system-ui, sans-serif); }
.dsh-ce-settings-foot { display: flex; gap: 8px; padding: 8px 10px; border-top: 1px solid var(--dsh-border, rgba(127,127,127,.25)); }
`

    function injectStyles() {
      const element = document.createElement('style')
      element.setAttribute('data-dsh-code-editor', '')
      element.textContent = STYLES
      document.head.appendChild(element)
      return () => {
        element.remove()
      }
    }

    // ------------------------------------------------------------------- apply

    const plugin = {
      inject: ['slots', 'sidebarRight', 'sidebarRightTabs', 'theme'],
      apply(ctx) {
        services = {
          theme: ctx.theme,
          sidebarRight: ctx.sidebarRight,
          sidebarRightTabs: ctx.sidebarRightTabs,
        }

        ctx.effect(injectStyles, 'dsh-code-editor: styles')

        ctx.effect(() => {
          // The tab type claims no address implicitly: it only opens when the
          // caller names its kind, so ordinary file previews keep working.
          const dispose = ctx.sidebarRightTabs.register({
            id: TAB_ID,
            kind: TAB_KIND,
            priority: 'fallback',
            title: (candidate) => {
              const parsed = parseFileAddress(candidate)
              return parsed === undefined ? 'Редактор' : baseName(parsed.path)
            },
          })
          return () => {
            dispose()
          }
        }, 'dsh-code-editor: tab type')

        ctx.slots.inject('sidebar.right.pane.tab', () =>
          ctx.slots.register({ name: 'sidebar.right.pane.tab', key: TAB_ID }, EditorBody),
        )

        ctx.slots.inject('sidebar.right.pane.tab.title', () =>
          ctx.slots.register({ name: 'sidebar.right.pane.tab.title', key: TAB_ID }, EditorTitle),
        )

        ctx.effect(
          () => ctx.sidebarRight.registerCloseHandler(TAB_KIND, (_sessionId, record) => {
            if (!dirtyTabs.has(record.id)) return
            closePromptHandlers.get(record.id)?.()
            throw new Error('Вкладка оставлена открытой: выберите, сохранить или отбросить изменения.')
          }),
          'dsh-code-editor: unsaved close guard',
        )

        ctx.slots.inject('sidebar.right.tab.document.actions', () =>
          ctx.slots.register({ name: 'sidebar.right.tab.document.actions', id: ACTION_ID, order: 20 }, EditButton),
        )
      },
    }

    return plugin
  },
})
