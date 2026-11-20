/**
 * Provider/model catalog and credential helpers for the code editor settings.
 *
 * The browser model picker needs the same information the official model page
 * shows: every provider that currently answers, its models, and which ones
 * failed. `buildCatalog` mirrors `dsh-api-session-controller`'s catalog builder
 * but keeps the raw model list, because an inline completion only needs an id.
 *
 * API keys are never stored in the preferences file. The editor asks the
 * credential store for a status (configured, source, masked) and writes a value
 * only when the user explicitly saves one.
 */

const MAX_CATALOG_MODELS = 200

function describeError(error) {
  if (error instanceof Error) return error.message
  return String(error)
}

/** Names of the credential keys a provider profile falls back to. */
function providerKeyNames(profile) {
  const names = []
  const native = profile?.nativeAuth
  if (native !== undefined && Array.isArray(native.env)) {
    for (const name of native.env) {
      if (typeof name === 'string' && name.trim() !== '') names.push(name.trim())
    }
  }
  return names
}

/**
 * The credential seam, looked up on demand.
 *
 * It is deliberately not part of the plugin's `inject` list: the editor must
 * start even where no credential provider is installed, and a missing seam only
 * turns the key field into a "not available" hint instead of blocking the tab.
 * @param {object} ctx - Host context.
 */
function credentialsOf(ctx) {
  if (typeof ctx?.get === 'function') {
    try {
      return ctx.get('credentials')
    } catch {
      return undefined
    }
  }
  return ctx?.credentials
}

/**
 * Live provider/model catalog plus the credential metadata the drawer displays.
 * @param {object} ctx - Host context carrying `llm` and `agentDefaultModel`.
 */
export async function buildCatalog(ctx) {
  const providers = ctx.llm.listProviders()
  const groups = []
  const failures = []
  for (const provider of providers) {
    try {
      const models = await ctx.llm.listModels(provider.id)
      groups.push({
        id: provider.id,
        name: provider.name ?? provider.id,
        models: models.slice(0, MAX_CATALOG_MODELS).map(model => ({
          id: model.id,
          name: model.name ?? model.id,
          ...(typeof model.description === 'string' ? { description: model.description } : {}),
        })),
      })
    } catch (error) {
      failures.push({ id: provider.id, name: provider.name ?? provider.id, message: describeError(error) })
    }
  }

  let profiles = []
  try {
    profiles = ctx.llm.listConfigurableProviders()
  } catch {
    profiles = []
  }
  const configurable = profiles.map(profile => ({
    provider: profile.provider,
    displayName: profile.displayName ?? profile.provider,
    settingsNs: profile.settingsNs,
    keyNames: providerKeyNames(profile),
    ...(profile.error === undefined ? {} : { error: describeError(profile.error) }),
  }))

  const selection = ctx.agentDefaultModel.currentSelection()
  return { default: selection, groups, failures, configurable }
}

/** Credential status for one key name, or a clear "not available" answer. */
export async function credentialStatus(ctx, name) {
  if (typeof credentialsOf(ctx) === 'undefined') {
    return { ref: name ?? '', supported: false, message: 'Хранилище ключей недоступно в этой сборке.' }
  }
  const ref = String(name ?? '').trim()
  if (ref === '') return { ref: '', supported: true, configured: false }
  try {
    const info = await credentialsOf(ctx)?.describe(ref)
    return {
      ref,
      supported: true,
      configured: info?.configured === true,
      ...(typeof info?.source === 'string' ? { source: info.source } : {}),
      ...(typeof info?.writable === 'boolean' ? { writable: info.writable } : {}),
      ...(typeof info?.masked === 'string' ? { masked: info.masked } : {}),
    }
  } catch (error) {
    return { ref, supported: true, configured: false, message: describeError(error) }
  }
}

/** Validate a key value the same way the official settings page does. */
export function validateSecret(value) {
  const text = String(value ?? '')
  if (text === '') return { ok: false, message: 'Пустой ключ не сохраняется: очистка — отдельной кнопкой.' }
  if (!/^[\x21-\x7E]+$/.test(text)) {
    return { ok: false, message: 'Ключ должен состоять из печатных ASCII-символов без пробелов.' }
  }
  return { ok: true, value: text }
}

/** Store a key and return the refreshed status. */
export async function saveCredential(ctx, { ref, value }) {
  const name = String(ref ?? '').trim()
  if (!/^[A-Z][A-Z0-9_]*$/.test(name)) {
    throw Object.assign(new Error('Имя ключа должно быть переменной окружения, например DEEPSEEK_API_KEY.'), {
      code: 'bad-request',
    })
  }
  if (typeof credentialsOf(ctx) === 'undefined') {
    throw Object.assign(new Error('Хранилище ключей недоступно в этой сборке.'), { code: 'no-credentials' })
  }
  const checked = validateSecret(value)
  if (!checked.ok) throw Object.assign(new Error(checked.message), { code: 'bad-request' })
  await credentialsOf(ctx)?.set(name, checked.value)
  return credentialStatus(ctx, name)
}

/** Remove a stored key; an environment fallback applies again afterwards. */
export async function clearCredential(ctx, { ref }) {
  const name = String(ref ?? '').trim()
  if (!/^[A-Z][A-Z0-9_]*$/.test(name)) {
    throw Object.assign(new Error('Не указано имя ключа.'), { code: 'bad-request' })
  }
  if (typeof credentialsOf(ctx) === 'undefined') {
    throw Object.assign(new Error('Хранилище ключей недоступно в этой сборке.'), { code: 'no-credentials' })
  }
  await credentialsOf(ctx)?.unset(name)
  return credentialStatus(ctx, name)
}
