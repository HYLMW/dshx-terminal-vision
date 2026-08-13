import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import {
  billedInputTokens,
  cacheHitPercent,
  contextOccupancy,
  formatContextDetails,
  formatDuration,
  formatStatsLine,
  formatTokens,
  formatUsageDetails,
  statsFromSnapshot,
  usageDelta,
} from '../lib/stats.js'

const usage = {
  uncachedInputTokens: 1_000,
  cacheReadTokens: 3_000,
  cacheWriteTokens: 200,
  outputTokens: 800,
}

describe('web-compatible usage formatting', () => {
  test('uses the same compact token and duration thresholds as the web client', () => {
    assert.equal(formatTokens(517), '517')
    assert.equal(formatTokens(12_240), '12.2K')
    assert.equal(formatTokens(1_240_000), '1.2M')
    assert.equal(formatDuration(45_240), '45.2s')
    assert.equal(formatDuration(162_000), '2m42s')
  })

  test('counts all three disjoint prompt buckets and derives cache hit share', () => {
    assert.equal(billedInputTokens(usage), 4_200)
    assert.equal(cacheHitPercent(usage), 71)
    assert.equal(cacheHitPercent({ ...usage, uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }), undefined)
  })

  test('uses projected pressure before the older provider sample', () => {
    assert.deepEqual(contextOccupancy({ projectedTokens: 23_000, pressureTokens: 20_000, contextWindow: 100_000 }), {
      percent: 23,
      usedTokens: 23_000,
      contextWindow: 100_000,
    })
    assert.equal(contextOccupancy({ pressureTokens: 1_000 }), undefined)
  })

  test('formats the same stats groups exposed by the web strip', () => {
    const line = formatStatsLine({
      usage,
      pressure: { projectedTokens: 23_000, contextWindow: 100_000 },
      session: {
        turns: 2,
        steps: 3,
        llmMs: 5_000,
        toolMs: 1_500,
        ttftMs: 1_000,
        ttftSteps: 2,
        decodeMs: 2_000,
        decodeTokens: 100,
      },
    })
    assert.equal(
      line,
      '2 轮 · 3 步  |  模型 5s · 工具 1.5s  |  TTFT 0.5s · 50 tok/s  |  缓存命中 71%  |  输入 4.2K · 输出 800  |  上下文 23%',
    )
  })
})

describe('projection snapshots and details', () => {
  test('reads projection values and computes a non-negative last-turn delta', () => {
    const stats = statsFromSnapshot({ values: { tokenUsage: usage, contextPressure: { pressureTokens: 10 } } })
    assert.equal(stats.usage, usage)
    assert.deepEqual(usageDelta(
      { uncachedInputTokens: 900, cacheReadTokens: 2_500, cacheWriteTokens: 300, outputTokens: 500 },
      usage,
    ), {
      uncachedInputTokens: 100,
      cacheReadTokens: 500,
      cacheWriteTokens: 0,
      outputTokens: 300,
    })
  })

  test('renders cache and context breakdown details', () => {
    const stats = {
      usage,
      pressure: { projectedTokens: 23_000, contextWindow: 100_000 },
      breakdown: { systemTokens: 100, toolsTokens: 200, messageTokens: 300 },
    }
    assert.deepEqual(formatUsageDetails(stats).slice(0, 2), ['累计输入      4.2K', '  未缓存      1K'])
    assert.deepEqual(formatContextDetails(stats), [
      '上下文占用    23%',
      '预计用量      ~23K / 100K',
      '  系统提示    ~100',
      '  工具定义    ~200',
      '  对话消息    ~300',
    ])
  })
})
