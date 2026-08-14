import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import {
  DEFAULT_API_KEY_ENV,
  EndpointManager,
  endpointSettingsSchema,
  normalizeBaseURL,
  validateEndpointSettings,
} from '../lib/endpoints.js'

class FakeSettings {
  constructor({ terminal = {}, deepseek = {} } = {}) {
    this.sections = {
      'dshx-terminal': terminal,
      'llm-deepseek': deepseek,
    }
    this.registrations = new Map()
    this.writes = []
    this.documentPath = '/tmp/settings.yaml'
  }

  register(namespace, schema, options = {}) {
    const registration = { schema, options, watchers: new Set() }
    this.registrations.set(namespace, registration)
    this.sections[namespace] = schema(this.sections[namespace] ?? {})
    options.validate?.(this.sections[namespace])
    return {
      get: () => this.sections[namespace],
      watch: (callback) => {
        registration.watchers.add(callback)
        return () => registration.watchers.delete(callback)
      },
      update: patch => this.update(namespace, patch),
    }
  }

  get(namespace) {
    return this.sections[namespace]
  }

  async update(namespace, patch) {
    const registration = this.registrations.get(namespace)
    const previous = this.sections[namespace] ?? {}
    const merged = { ...previous, ...patch }
    const next = registration === undefined ? merged : registration.schema(merged)
    registration?.options.validate?.(next)
    this.sections[namespace] = next
    this.writes.push({ namespace, patch })
    if (registration !== undefined) {
      await Promise.all(Array.from(registration.watchers, watcher => watcher(next, previous)))
    }
  }
}

function configuredSettings() {
  return new FakeSettings({
    terminal: {
      activeEndpoint: 'official',
      endpoints: {
        proxy: {
          baseURL: 'https://proxy.example/v1/',
          apiKeyEnv: 'PROXY_API_KEY',
          description: '内部代理',
        },
        official: {
          baseURL: 'https://api.deepseek.com/',
        },
      },
    },
    deepseek: { reasoningEffort: 'max' },
  })
}

describe('endpoint settings', () => {
  test('applies defaults and normalizes safe HTTP endpoints', () => {
    const parsed = endpointSettingsSchema({
      activeEndpoint: 'official',
      endpoints: { official: { baseURL: 'https://api.deepseek.com/' } },
    })

    assert.equal(parsed.endpoints.official.apiKeyEnv, DEFAULT_API_KEY_ENV)
    assert.equal(normalizeBaseURL(parsed.endpoints.official.baseURL), 'https://api.deepseek.com')
    assert.doesNotThrow(() => validateEndpointSettings(parsed))
  })

  test('rejects unsafe URLs, invalid credential references, and missing active names', () => {
    for (const baseURL of [
      '',
      'file:///tmp/server',
      'https://user:secret@example.com/v1',
      'https://example.com/v1?token=secret',
      'https://example.com/v1#fragment',
    ]) {
      assert.throws(() => validateEndpointSettings({
        endpoints: { bad: { baseURL, apiKeyEnv: 'API_KEY' } },
      }))
    }
    assert.throws(
      () => validateEndpointSettings({
        endpoints: { bad: { baseURL: 'https://example.com', apiKeyEnv: 'not-valid' } },
      }),
      /apiKeyEnv/u,
    )
    assert.throws(
      () => validateEndpointSettings({ activeEndpoint: 'missing', endpoints: {} }),
      /不存在/u,
    )
  })
})

describe('EndpointManager', () => {
  test('applies the configured active endpoint without replacing other DeepSeek settings', async () => {
    const settings = configuredSettings()
    const manager = new EndpointManager(settings)

    await manager.initialize()

    assert.deepEqual(settings.get('llm-deepseek'), {
      reasoningEffort: 'max',
      baseURL: 'https://api.deepseek.com',
      apiKeyEnv: 'DEEPSEEK_API_KEY',
    })
    assert.deepEqual(manager.current(), {
      name: 'official',
      baseURL: 'https://api.deepseek.com',
      apiKeyEnv: 'DEEPSEEK_API_KEY',
    })
    assert.deepEqual(manager.list().map(endpoint => endpoint.name), ['official', 'proxy'])
    manager.dispose()
  })

  test('does not rewrite matching DeepSeek settings on every startup', async () => {
    const settings = configuredSettings()
    settings.sections['llm-deepseek'] = {
      reasoningEffort: 'max',
      baseURL: 'https://api.deepseek.com/',
      apiKeyEnv: 'DEEPSEEK_API_KEY',
    }
    const manager = new EndpointManager(settings)

    await manager.initialize()

    assert.equal(settings.writes.length, 0)
    assert.equal(manager.current().name, 'official')
    manager.dispose()
  })

  test('switches endpoint and persists the active name', async () => {
    const settings = configuredSettings()
    const manager = new EndpointManager(settings)
    await manager.initialize()

    const selected = await manager.select('proxy')

    assert.equal(settings.get('dshx-terminal').activeEndpoint, 'proxy')
    assert.deepEqual(selected, {
      name: 'proxy',
      baseURL: 'https://proxy.example/v1',
      apiKeyEnv: 'PROXY_API_KEY',
      description: '内部代理',
    })
    assert.equal(settings.get('llm-deepseek').baseURL, 'https://proxy.example/v1')
    assert.equal(settings.get('llm-deepseek').apiKeyEnv, 'PROXY_API_KEY')
    manager.dispose()
  })

  test('treats --endpoint initialization as a persistent switch', async () => {
    const settings = configuredSettings()
    const manager = new EndpointManager(settings)

    await manager.initialize('proxy')

    assert.equal(settings.get('dshx-terminal').activeEndpoint, 'proxy')
    assert.equal(manager.current().name, 'proxy')
    manager.dispose()
  })

  test('automatically reapplies an externally edited active endpoint', async () => {
    const settings = configuredSettings()
    const manager = new EndpointManager(settings)
    await manager.initialize()

    await settings.update('dshx-terminal', {
      endpoints: {
        ...settings.get('dshx-terminal').endpoints,
        official: { baseURL: 'https://new.example/v1', apiKeyEnv: 'NEW_API_KEY' },
      },
    })

    assert.equal(manager.current().baseURL, 'https://new.example/v1')
    assert.equal(settings.get('llm-deepseek').apiKeyEnv, 'NEW_API_KEY')
    manager.dispose()
  })

  test('reports an unknown endpoint without changing settings', async () => {
    const settings = configuredSettings()
    const manager = new EndpointManager(settings)
    await manager.initialize()
    const writes = settings.writes.length

    await assert.rejects(() => manager.select('missing'), /不存在/u)

    assert.equal(settings.writes.length, writes)
    assert.equal(manager.current().name, 'official')
    manager.dispose()
  })

  test('falls back to the underlying DeepSeek configuration when no endpoint is active', async () => {
    const settings = new FakeSettings({
      deepseek: { baseURL: 'https://manual.example/v1', apiKeyEnv: 'MANUAL_KEY' },
    })
    const manager = new EndpointManager(settings)
    await manager.initialize()

    assert.deepEqual(manager.current(), {
      name: undefined,
      baseURL: 'https://manual.example/v1',
      apiKeyEnv: 'MANUAL_KEY',
    })
    assert.equal(manager.documentPath(), '/tmp/settings.yaml')
    manager.dispose()
  })
})
