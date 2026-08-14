import z from '@deepseek-ai/schemastery'

export const ENDPOINT_SETTINGS_NAMESPACE = 'dshx-terminal'
export const DEEPSEEK_SETTINGS_NAMESPACE = 'llm-deepseek'
export const DEFAULT_API_KEY_ENV = 'DEEPSEEK_API_KEY'
export const PUBLIC_DEEPSEEK_BASE_URL = 'https://api.deepseek.com'

const endpointSchema = z.object({
  baseURL: z.string().required(),
  apiKeyEnv: z.string().default(DEFAULT_API_KEY_ENV),
  description: z.string(),
})

export const endpointSettingsSchema = z.object({
  activeEndpoint: z.string(),
  endpoints: z.dict(endpointSchema).default({}),
})

function endpointEntries(config) {
  return Object.entries(config?.endpoints ?? {})
}

export function normalizeBaseURL(value) {
  const raw = String(value).trim()
  let parsed
  try {
    parsed = new URL(raw)
  } catch {
    throw new Error(`Base URL 无效：${raw || '（空）'}`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Base URL 只支持 http 或 https：${raw}`)
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw new Error('Base URL 不能包含用户名或密码；请使用 apiKeyEnv 引用凭据')
  }
  if (parsed.search !== '' || parsed.hash !== '') {
    throw new Error(`Base URL 不能包含查询参数或片段：${raw}`)
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/u, '')
  return parsed.toString().replace(/\/$/u, '')
}

export function validateEndpointSettings(config) {
  const entries = endpointEntries(config)
  for (const [name, endpoint] of entries) {
    if (name.trim() === '') throw new Error('端点名称不能为空')
    normalizeBaseURL(endpoint.baseURL)
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(endpoint.apiKeyEnv)) {
      throw new Error(`端点 “${name}” 的 apiKeyEnv 不是有效的环境变量名`)
    }
  }
  const active = config?.activeEndpoint
  if (active !== undefined && active !== '' && !Object.hasOwn(config.endpoints ?? {}, active)) {
    throw new Error(`当前端点 “${active}” 不存在于 endpoints 中`)
  }
}

function endpointSignature(name, endpoint) {
  return JSON.stringify([name, normalizeBaseURL(endpoint.baseURL), endpoint.apiKeyEnv])
}

export class EndpointManager {
  constructor(settings) {
    this.settings = settings
    this.scope = settings.register(ENDPOINT_SETTINGS_NAMESPACE, endpointSettingsSchema, {
      applies: 'live',
      validate: validateEndpointSettings,
    })
    this.initialized = false
    this.appliedSignature = undefined
    this.applied = undefined
    this.queue = Promise.resolve()
    this.disposeWatcher = undefined
  }

  config() {
    return this.scope.get()
  }

  list() {
    return endpointEntries(this.config())
      .map(([name, endpoint]) => ({ name, ...endpoint, baseURL: normalizeBaseURL(endpoint.baseURL) }))
      .sort((left, right) => left.name.localeCompare(right.name))
  }

  enqueue(config = this.config()) {
    const run = () => this.sync(config)
    this.queue = this.queue.catch(() => undefined).then(run)
    return this.queue
  }

  async initialize(overrideName) {
    if (this.initialized) return this.enqueue()
    this.initialized = true
    this.disposeWatcher = this.scope.watch(next => this.enqueue(next))
    if (overrideName !== undefined) await this.scope.update({ activeEndpoint: overrideName })
    return this.enqueue()
  }

  async sync(config) {
    const name = config.activeEndpoint
    if (name === undefined || name === '') {
      this.applied = undefined
      this.appliedSignature = undefined
      return undefined
    }
    const endpoint = config.endpoints[name]
    if (endpoint === undefined) throw new Error(`端点 “${name}” 不存在`)
    const signature = endpointSignature(name, endpoint)
    if (signature !== this.appliedSignature) {
      const baseURL = normalizeBaseURL(endpoint.baseURL)
      const current = this.settings.get(DEEPSEEK_SETTINGS_NAMESPACE) ?? {}
      let currentBaseURL
      try {
        currentBaseURL = current.baseURL === undefined ? undefined : normalizeBaseURL(current.baseURL)
      } catch {
        // A valid named endpoint replaces a stale malformed manual override.
      }
      if (currentBaseURL !== baseURL || current.apiKeyEnv !== endpoint.apiKeyEnv) {
        await this.settings.update(DEEPSEEK_SETTINGS_NAMESPACE, {
          baseURL,
          apiKeyEnv: endpoint.apiKeyEnv,
        })
      }
      this.appliedSignature = signature
      this.applied = { name, ...endpoint, baseURL }
    }
    return this.applied
  }

  async select(name) {
    const endpoint = this.config().endpoints[name]
    if (endpoint === undefined) throw new Error(`端点 “${name}” 不存在`)
    await this.scope.update({ activeEndpoint: name })
    return this.enqueue()
  }

  current() {
    if (this.applied !== undefined) return this.applied
    const deepseek = this.settings.get(DEEPSEEK_SETTINGS_NAMESPACE) ?? {}
    return {
      name: undefined,
      baseURL: deepseek.baseURL ?? process.env.DEEPSEEK_BASE_URL ?? PUBLIC_DEEPSEEK_BASE_URL,
      apiKeyEnv: deepseek.apiKeyEnv ?? DEFAULT_API_KEY_ENV,
    }
  }

  documentPath() {
    return this.settings.documentPath
  }

  dispose() {
    this.disposeWatcher?.()
    this.disposeWatcher = undefined
  }
}
