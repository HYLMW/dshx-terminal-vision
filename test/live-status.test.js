import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import {
  displayWidth,
  formatLiveStatus,
  LiveStatusBar,
  LiveTurnMetrics,
  truncateDisplay,
} from '../lib/live-status.js'

function captureOutput({ isTTY = true, columns = 200 } = {}) {
  const chunks = []
  return {
    stream: {
      isTTY,
      columns,
      write(chunk) {
        chunks.push(String(chunk))
        return true
      },
    },
    chunks,
    text: () => chunks.join(''),
  }
}

describe('LiveTurnMetrics', () => {
  test('tracks TTFT, approximate output, throughput, and activity from live events', () => {
    let now = 1_000
    const metrics = new LiveTurnMetrics({ now: () => now })
    metrics.reset()
    metrics.observe({ type: 'step/start', time: 1_100, data: { turn: 1, step: 1 } })
    metrics.observe({
      type: 'assistant/chunk',
      time: 1_300,
      data: { turn: 1, step: 1, chunk: { type: 'reasoning-delta', text: 'abcd' } },
    })
    metrics.observe({
      type: 'assistant/chunk',
      time: 1_500,
      data: { turn: 1, step: 1, chunk: { type: 'text-delta', text: 'abcdefgh' } },
    })

    assert.deepEqual(metrics.snapshot(2_300), {
      activity: '生成中',
      elapsedMs: 1_300,
      ttftMs: 200,
      outputTokens: 3,
      outputEstimated: true,
      tokensPerSecond: 3,
      usage: undefined,
    })

    metrics.observe({
      type: 'tool/call',
      time: 2_400,
      data: { turn: 1, step: 1, callId: 'call-1', name: 'bash', arguments: '{}' },
    })
    assert.equal(metrics.snapshot(2_500).activity, 'bash')
    metrics.observe({
      type: 'tool/result',
      time: 2_600,
      data: {
        turn: 1,
        step: 1,
        message: { content: [{ type: 'tool-result', toolCallId: 'call-1', content: [] }] },
      },
    })
    assert.equal(metrics.snapshot(2_700).activity, '等待模型')
  })

  test('uses UTF-8 size so CJK streaming estimates are not treated like Latin characters', () => {
    const metrics = new LiveTurnMetrics({ now: () => 1_000 })
    metrics.reset(1_000)
    metrics.observe({
      type: 'assistant/chunk',
      time: 1_100,
      data: { turn: 1, step: 1, chunk: { type: 'text-delta', text: '中文' } },
    })

    assert.equal(metrics.snapshot(1_200).outputTokens, 2)
  })

  test('replaces estimates with provider usage and does not double-count a committed message', () => {
    const metrics = new LiveTurnMetrics({ now: () => 1_000 })
    metrics.reset(1_000)
    metrics.observe({
      type: 'assistant/chunk',
      time: 1_200,
      data: {
        turn: 2,
        step: 3,
        chunk: {
          type: 'usage',
          usage: { inputTokens: 10, outputTokens: 20, cacheReadTokens: 90, cacheWriteTokens: 0 },
        },
      },
    })
    metrics.observe({
      type: 'assistant/message',
      time: 1_300,
      data: {
        turn: 2,
        step: 3,
        message: { content: [] },
        usage: { inputTokens: 10, outputTokens: 20, cacheReadTokens: 90, cacheWriteTokens: 0 },
      },
    })

    const snapshot = metrics.snapshot(2_000)
    assert.equal(snapshot.outputTokens, 20)
    assert.equal(snapshot.outputEstimated, false)
    assert.deepEqual(snapshot.usage, {
      uncachedInputTokens: 10,
      outputTokens: 20,
      cacheReadTokens: 90,
      cacheWriteTokens: 0,
    })
  })

  test('combines exact completed steps with a live estimate and excludes tool wait from speed', () => {
    const metrics = new LiveTurnMetrics({ now: () => 1_000 })
    metrics.reset(1_000)
    metrics.observe({
      type: 'assistant/chunk',
      time: 1_100,
      data: { turn: 1, step: 1, chunk: { type: 'text-delta', text: 'abcd' } },
    })
    metrics.observe({
      type: 'assistant/chunk',
      time: 1_200,
      data: {
        turn: 1,
        step: 1,
        chunk: { type: 'usage', usage: { inputTokens: 5, outputTokens: 10 } },
      },
    })
    metrics.observe({
      type: 'assistant/message',
      time: 1_200,
      data: {
        turn: 1,
        step: 1,
        message: { content: [] },
        usage: { inputTokens: 5, outputTokens: 10 },
      },
    })
    metrics.observe({
      type: 'assistant/chunk',
      time: 2_000,
      data: { turn: 1, step: 2, chunk: { type: 'text-delta', text: 'abcdefgh' } },
    })

    const snapshot = metrics.snapshot(2_100)
    assert.equal(snapshot.outputTokens, 12)
    assert.equal(snapshot.outputEstimated, true)
    assert.equal(snapshot.tokensPerSecond, 60)
  })
})

describe('formatLiveStatus', () => {
  test('shows model, live measurements, exact cache rate, and projected context', () => {
    const line = formatLiveStatus({
      provider: 'deepseek-official',
      model: 'DeepSeek-V4-Flash',
      metrics: {
        activity: '生成中',
        elapsedMs: 8_400,
        ttftMs: 900,
        tokensPerSecond: 38.64,
        outputTokens: 326,
        outputEstimated: false,
        usage: {
          uncachedInputTokens: 20,
          cacheReadTokens: 80,
          cacheWriteTokens: 0,
          outputTokens: 326,
        },
      },
      stats: { pressure: { projectedTokens: 12_000, contextWindow: 100_000 } },
    })

    assert.equal(
      line,
      '● deepseek-official/DeepSeek-V4-Flash · 生成中 8.4s · TTFT 0.9s · ~38.6 tok/s · 输出 326 · 缓存 80% · 上下文 12%',
    )
  })

  test('marks output as estimated and unavailable provider metrics with a dash', () => {
    const line = formatLiveStatus({
      provider: 'provider',
      model: 'model',
      metrics: {
        activity: '等待模型',
        elapsedMs: 500,
        ttftMs: undefined,
        tokensPerSecond: undefined,
        outputTokens: 0,
        outputEstimated: true,
        usage: undefined,
      },
    })

    assert.equal(line, '● provider/model · 等待模型 0.5s · TTFT — · 输出 ~0 · 缓存 —')
  })

  test('offers a compact form that keeps all metrics visible in an 80-column terminal', () => {
    const line = formatLiveStatus({
      provider: 'deepseek-official',
      model: 'DeepSeek-V4-Flash',
      compact: true,
      metrics: {
        activity: '思考中',
        elapsedMs: 8_400,
        ttftMs: 900,
        tokensPerSecond: 38.64,
        outputTokens: 326,
        outputEstimated: true,
        usage: {
          uncachedInputTokens: 20,
          cacheReadTokens: 80,
          cacheWriteTokens: 0,
          outputTokens: 326,
        },
      },
      stats: { pressure: { projectedTokens: 12_000, contextWindow: 100_000 } },
    })

    assert.equal(line, '● DeepSeek-V4-Flash · 思考 8.4s · T 0.9s · ~38.6t/s · O~326 · C80% · X12%')
    assert.ok(displayWidth(line) < 80)
  })
})

describe('truncateDisplay', () => {
  test('respects wide characters and keeps a complete ellipsis', () => {
    assert.equal(truncateDisplay('abc', 3), 'abc')
    assert.equal(truncateDisplay('a中文b', 5), 'a中…')
    assert.equal(truncateDisplay('😀abc', 3), '😀…')
    assert.equal(truncateDisplay('abc', 1), '…')
    assert.equal(displayWidth('a中😀'), 5)
  })
})

describe('LiveStatusBar', () => {
  test('refreshes once per timer tick and preserves the bar around normal output', () => {
    const output = captureOutput()
    let now = 1_000
    let tick
    let cleared
    const timer = { unrefCalled: false, unref() { this.unrefCalled = true } }
    const bar = new LiveStatusBar({
      output: output.stream,
      color: false,
      now: () => now,
      setIntervalFn(callback, delay) {
        assert.equal(delay, 1_000)
        tick = callback
        return timer
      },
      clearIntervalFn(value) {
        cleared = value
      },
    })

    bar.begin({ provider: 'deepseek', model: 'chat' })
    assert.equal(timer.unrefCalled, true)
    assert.match(output.text(), /\n\r\u001b\[2K● deepseek\/chat · 等待模型 0s.*\u001b\[1A\u001b\[1G/u)
    assert.doesNotMatch(output.text(), /\u001b[78]/u)

    bar.observe({
      type: 'assistant/chunk',
      time: 1_200,
      data: { turn: 1, step: 1, chunk: { type: 'text-delta', text: 'abcdefgh' } },
    })
    now = 2_000
    tick()
    assert.match(output.text(), /\u001b\[1B\r\u001b\[2K\u001b\[1A\u001b\[1G\n\r\u001b\[2K● deepseek\/chat · 生成中 1s/u)

    const chunksBeforeOutput = output.chunks.length
    bar.beforeOutput()
    bar.afterOutput('回答')
    assert.equal(output.chunks.length, chunksBeforeOutput + 2)
    assert.match(output.text(), /\u001b\[5G$/u)

    bar.pause()
    const pausedLength = output.text().length
    tick()
    assert.equal(output.text().length, pausedLength)
    bar.resume()
    assert.ok(output.text().length > pausedLength)

    bar.stop()
    assert.equal(cleared, timer)
  })

  test('does nothing for non-TTY output or when explicitly disabled', () => {
    for (const options of [
      { output: captureOutput({ isTTY: false }) },
      { output: captureOutput(), enabled: false },
    ]) {
      let scheduled = false
      const bar = new LiveStatusBar({
        output: options.output.stream,
        enabled: options.enabled,
        setIntervalFn() {
          scheduled = true
        },
      })
      bar.begin({ provider: 'deepseek', model: 'chat' })
      assert.equal(options.output.text(), '')
      assert.equal(scheduled, false)
    }
  })
})
