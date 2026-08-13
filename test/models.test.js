import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import {
  buildModelCatalog,
  parseModelCommand,
  resolveModelSelection,
  selectionFromSession,
} from '../lib/models.js'

describe('model catalog', () => {
  test('groups healthy providers and keeps independent failures', async () => {
    const llm = {
      listProviders: () => [{ id: 'good', name: 'Good' }, { id: 'bad', name: 'Bad' }],
      listModels: async provider => {
        if (provider === 'bad') throw new Error('offline')
        return [{ provider, id: 'flash', name: 'Flash', description: 'Fast' }]
      },
      resolveModelInfo: async () => ({
        reasoning: {
          efforts: [{ id: 'high', name: 'High' }],
          defaultEffort: 'high',
        },
      }),
    }

    assert.deepEqual(await buildModelCatalog(llm), {
      groups: [{
        id: 'good',
        name: 'Good',
        models: [{
          id: 'flash',
          name: 'Flash',
          description: 'Fast',
          reasoning: { efforts: [{ id: 'high', name: 'High' }], defaultEffort: 'high' },
        }],
      }],
      failures: [{ id: 'bad', name: 'Bad', message: 'offline' }],
    })
  })

  test('validates and materializes the selected reasoning default', async () => {
    const llm = {
      resolveCallConfig: async requested => ({ ...requested, reasoningEffort: requested.reasoningEffort ?? 'medium' }),
    }
    assert.deepEqual(await resolveModelSelection(llm, { provider: 'p', model: 'm' }), {
      provider: 'p',
      model: 'm',
      reasoningEffort: 'medium',
    })
  })
})

describe('model command and session precedence', () => {
  test('parses a direct route with an optional effort', () => {
    assert.deepEqual(parseModelCommand(' deepseek/deepseek-v4-flash high '), {
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
      reasoningEffort: 'high',
    })
    assert.equal(parseModelCommand(''), undefined)
    assert.throws(() => parseModelCommand('missing-separator'), /用法/)
  })

  test('prefers explicit selection, then logged request, then live default', () => {
    let header = { config: { provider: 'logged', model: 'old', reasoningEffort: 'low' } }
    const agent = { session: { requestHeader: () => header } }
    let fallback = { provider: 'default', model: 'model' }
    const ref = selectionFromSession(agent, () => fallback)

    assert.deepEqual(ref.current, { provider: 'logged', model: 'old', reasoningEffort: 'low' })
    header = undefined
    assert.deepEqual(ref.current, fallback)
    fallback = { provider: 'new-default', model: 'new' }
    assert.deepEqual(ref.current, fallback)
    ref.current = { provider: 'picked', model: 'chosen' }
    assert.deepEqual(ref.current, { provider: 'picked', model: 'chosen' })
  })
})
