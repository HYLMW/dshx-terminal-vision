import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import {
  EventRenderer,
  parseQuestionAnswer,
  summarizeToolArguments,
  summarizeTurn,
  turnFailure,
} from '../lib/terminal-ui.js'

function captureOutput({ isTTY = false } = {}) {
  const chunks = []
  return {
    stream: {
      isTTY,
      write(chunk) {
        chunks.push(String(chunk))
        return true
      },
    },
    text: () => chunks.join(''),
  }
}

function assistantMessage({ seq = 1, turn = 1, step = 1, content }) {
  return {
    seq,
    type: 'assistant/message',
    data: {
      turn,
      step,
      message: { content },
    },
  }
}

describe('summarizeToolArguments', () => {
  test('prefers useful known fields and compacts whitespace', () => {
    const raw = JSON.stringify({ path: '/fallback', command: '  npm   test\n-- --watch  ' })

    assert.equal(summarizeToolArguments(raw), 'npm test -- --watch')
  })

  test('lists keys when no known string summary is available', () => {
    assert.equal(summarizeToolArguments(JSON.stringify({ timeout: 1000, retries: 2 })), 'timeout, retries')
    assert.equal(summarizeToolArguments('{}'), '')
  })

  test('falls back to compact raw text for invalid or scalar JSON', () => {
    assert.equal(summarizeToolArguments('  not   valid\njson  '), 'not valid json')
    assert.equal(summarizeToolArguments('42'), '42')
  })

  test('limits summaries to one 120-character line', () => {
    const summary = summarizeToolArguments(JSON.stringify({ query: 'x'.repeat(150) }))

    assert.equal(summary.length, 120)
    assert.equal(summary, `${'x'.repeat(119)}…`)
  })
})

describe('parseQuestionAnswer', () => {
  const singleChoice = {
    id: 'runtime',
    options: [
      { label: 'Native' },
      { label: 'Code' },
      { label: 'Both' },
    ],
  }

  test('accepts a one-based option number', () => {
    assert.deepEqual(parseQuestionAnswer(singleChoice, ' 2 '), {
      id: 'runtime',
      selected: ['Code'],
    })
  })

  test('matches labels without case sensitivity', () => {
    assert.deepEqual(parseQuestionAnswer(singleChoice, 'bOtH'), {
      id: 'runtime',
      selected: ['Both'],
    })
  })

  test('returns a custom single-choice answer when no option matches', () => {
    assert.deepEqual(parseQuestionAnswer(singleChoice, 'Remote'), {
      id: 'runtime',
      selected: [],
      custom: 'Remote',
    })
  })

  test('deduplicates multi-select choices and preserves custom tokens', () => {
    assert.deepEqual(parseQuestionAnswer({ ...singleChoice, multiSelect: true }, '1, code, 1, Remote, edge'), {
      id: 'runtime',
      selected: ['Native', 'Code'],
      custom: 'Remote, edge',
    })
  })

  test('treats an invalid number as a custom answer', () => {
    assert.deepEqual(parseQuestionAnswer(singleChoice, '0'), {
      id: 'runtime',
      selected: [],
      custom: '0',
    })
  })

  test('supports free-form questions and omits empty custom answers', () => {
    assert.deepEqual(parseQuestionAnswer({ id: 'notes' }, '  explain why  '), {
      id: 'notes',
      selected: [],
      custom: 'explain why',
    })
    assert.deepEqual(parseQuestionAnswer({ id: 'notes', options: [] }, '   '), {
      id: 'notes',
      selected: [],
    })
    assert.deepEqual(parseQuestionAnswer(singleChoice, '   '), {
      id: 'runtime',
      selected: [],
    })
  })
})

describe('EventRenderer', () => {
  test('feeds every event to live status and preserves it around rendered output', () => {
    const output = captureOutput()
    const calls = []
    const liveStatus = {
      observe(event) { calls.push(['observe', event.type]) },
      beforeOutput() { calls.push(['before']) },
      afterOutput() { calls.push(['after']) },
    }
    const renderer = new EventRenderer({ output: output.stream, color: false, liveStatus })

    renderer.handle({
      type: 'assistant/chunk',
      data: { turn: 1, step: 1, chunk: { type: 'text-delta', text: 'hello' } },
    })

    assert.equal(output.text(), 'hello')
    assert.deepEqual(calls, [['observe', 'assistant/chunk'], ['before'], ['after']])
  })

  test('streams text deltas and suppresses the matching committed message', () => {
    const output = captureOutput()
    const renderer = new EventRenderer({ output: output.stream, color: false })

    renderer.beginTurn()
    renderer.handle({
      type: 'assistant/chunk',
      data: { turn: 2, step: 4, chunk: { type: 'text-delta', text: 'streamed' } },
    })
    renderer.handle(assistantMessage({
      turn: 2,
      step: 4,
      content: [{ type: 'text', text: 'streamed' }],
    }))
    renderer.handle(assistantMessage({
      turn: 2,
      step: 5,
      content: [
        { type: 'text', text: ' response' },
        { type: 'image', data: 'ignored' },
      ],
    }))
    renderer.handle({ type: 'turn/end', data: { reason: { kind: 'completed' } } })

    assert.equal(output.text(), 'streamed response\n')
  })

  test('renders reasoning when enabled and separates it from answer text', () => {
    const output = captureOutput()
    const renderer = new EventRenderer({ output: output.stream, color: false, showReasoning: true })

    renderer.handle({
      type: 'assistant/chunk',
      data: { turn: 1, step: 1, chunk: { type: 'reasoning-delta', text: 'inspect' } },
    })
    renderer.handle({
      type: 'assistant/chunk',
      data: { turn: 1, step: 1, chunk: { type: 'reasoning-delta', text: ' inputs' } },
    })
    renderer.handle({
      type: 'assistant/chunk',
      data: { turn: 1, step: 1, chunk: { type: 'text-delta', text: 'answer' } },
    })
    renderer.finish()

    assert.equal(output.text(), '思考 › inspect inputs\nanswer\n')
  })

  test('does not add a blank line when reasoning already ended with a newline', () => {
    const output = captureOutput()
    const renderer = new EventRenderer({ output: output.stream, color: false, showReasoning: true })

    renderer.handle({
      type: 'assistant/chunk',
      data: { turn: 1, step: 1, chunk: { type: 'reasoning-delta', text: 'done\n' } },
    })
    renderer.handle({
      type: 'assistant/chunk',
      data: { turn: 1, step: 1, chunk: { type: 'text-delta', text: 'answer' } },
    })
    renderer.finish()

    assert.equal(output.text(), '思考 › done\nanswer\n')
  })

  test('does not suppress a committed message after an empty text delta', () => {
    const output = captureOutput()
    const renderer = new EventRenderer({ output: output.stream, color: false })

    renderer.handle({
      type: 'assistant/chunk',
      data: { turn: 1, step: 1, chunk: { type: 'text-delta', text: '' } },
    })
    renderer.handle(assistantMessage({
      turn: 1,
      step: 1,
      content: [{ type: 'text', text: 'fallback' }],
    }))
    renderer.finish()

    assert.equal(output.text(), 'fallback\n')
  })

  test('does not print reasoning when it is disabled', () => {
    const output = captureOutput()
    const renderer = new EventRenderer({ output: output.stream, color: false })

    renderer.handle({
      type: 'assistant/chunk',
      data: { turn: 1, step: 1, chunk: { type: 'reasoning-delta', text: 'hidden' } },
    })
    renderer.handle(assistantMessage({ content: [{ type: 'text', text: 'visible' }] }))
    renderer.finish()

    assert.equal(output.text(), 'visible\n')
  })

  test('keys streamed-message suppression by both turn and step', () => {
    const output = captureOutput()
    const renderer = new EventRenderer({ output: output.stream, color: false })

    renderer.beginTurn()
    renderer.handle({
      type: 'assistant/chunk',
      data: { turn: 1, step: 1, chunk: { type: 'text-delta', text: 'turn one' } },
    })
    renderer.handle(assistantMessage({
      turn: 2,
      step: 1,
      content: [{ type: 'text', text: ', turn two' }],
    }))
    renderer.finish()

    assert.equal(output.text(), 'turn one, turn two\n')
  })

  test('beginTurn clears streamed-message suppression from the prior turn', () => {
    const output = captureOutput()
    const renderer = new EventRenderer({ output: output.stream, color: false })

    renderer.beginTurn()
    renderer.handle({
      type: 'assistant/chunk',
      data: { turn: 1, step: 1, chunk: { type: 'text-delta', text: 'first' } },
    })
    renderer.finish()
    renderer.beginTurn()
    renderer.handle(assistantMessage({
      turn: 1,
      step: 1,
      content: [{ type: 'text', text: 'second' }],
    }))
    renderer.finish()

    assert.equal(output.text(), 'first\nsecond\n')
  })

  test('closes an open assistant line before rendering a tool call', () => {
    const output = captureOutput()
    const renderer = new EventRenderer({ output: output.stream, color: false })

    renderer.handle({
      type: 'assistant/chunk',
      data: { turn: 1, step: 1, chunk: { type: 'text-delta', text: 'partial' } },
    })
    renderer.handle({
      type: 'tool/call',
      data: { callId: 'call-1', name: 'shell', arguments: '{}' },
    })

    assert.equal(output.text(), 'partial\n● shell\n')
  })

  test('does not add a newline when rendered text already ended with one', () => {
    const output = captureOutput()
    const renderer = new EventRenderer({ output: output.stream, color: false })

    renderer.handle({
      type: 'assistant/chunk',
      data: { turn: 1, step: 1, chunk: { type: 'text-delta', text: 'complete\n' } },
    })
    renderer.handle({ type: 'turn/end', data: { reason: { kind: 'completed' } } })
    renderer.finish()

    assert.equal(output.text(), 'complete\n')
  })

  test('renders tool calls, successful results, and at most five preview lines', () => {
    const output = captureOutput()
    const renderer = new EventRenderer({ output: output.stream, color: false })

    renderer.handle({
      type: 'tool/call',
      data: { callId: 'call-1', name: 'shell', arguments: JSON.stringify({ cmd: 'npm test' }) },
    })
    renderer.handle({
      type: 'tool/result',
      data: {
        message: {
          content: [{
            type: 'tool-result',
            toolCallId: 'call-1',
            content: [{ type: 'text', text: 'one\ntwo\nthree\nfour\nfive\nsix' }],
          }],
        },
      },
    })

    assert.equal(output.text(), [
      '● shell  npm test',
      '  ✓ shell',
      '    one',
      '    two',
      '    three',
      '    four',
      '    five',
      '',
    ].join('\n'))
  })

  test('marks errors and falls back to a generic tool name', () => {
    const output = captureOutput()
    const renderer = new EventRenderer({ output: output.stream, color: false })

    renderer.handle({
      type: 'tool/result',
      data: {
        error: { message: 'failed' },
        message: {
          content: [{
            type: 'tool-result',
            toolCallId: 'unknown-call',
            isError: true,
            content: [],
          }],
        },
      },
    })

    assert.equal(output.text(), '  ✗ tool\n')
  })

  test('emits nothing in quiet mode', () => {
    const output = captureOutput()
    const renderer = new EventRenderer({ output: output.stream, color: false, showReasoning: true, quiet: true })

    renderer.handle({
      type: 'assistant/chunk',
      data: { turn: 1, step: 1, chunk: { type: 'text-delta', text: 'hidden' } },
    })
    renderer.handle({
      type: 'tool/call',
      data: { callId: 'call-1', name: 'shell', arguments: '{}' },
    })
    renderer.finish()

    assert.equal(output.text(), '')
  })
})

describe('summarizeTurn', () => {
  test('ignores old and pre-start events and returns the latest committed text', () => {
    const completed = { kind: 'completed' }
    const events = [
      { seq: 1, type: 'turn/start', data: {} },
      assistantMessage({ seq: 2, content: [{ type: 'text', text: 'old turn' }] }),
      { seq: 3, type: 'turn/end', data: { reason: completed } },
      assistantMessage({ seq: 4, content: [{ type: 'text', text: 'before start' }] }),
      { seq: 5, type: 'turn/start', data: {} },
      { seq: 6, type: 'assistant/chunk', data: { chunk: { type: 'text-delta', text: 'uncommitted' } } },
      assistantMessage({
        seq: 7,
        content: [
          { type: 'text', text: 'first committed' },
          { type: 'image', data: 'ignored' },
        ],
      }),
      assistantMessage({ seq: 8, content: [{ type: 'text', text: 'final committed' }] }),
      { seq: 9, type: 'turn/end', data: { reason: completed } },
    ]

    assert.deepEqual(summarizeTurn(events, 4), {
      text: 'final committed',
      reason: completed,
    })
  })

  test('returns empty output when no turn starts at or after firstSeq', () => {
    const events = [
      { seq: 1, type: 'turn/start', data: {} },
      assistantMessage({ seq: 2, content: [{ type: 'text', text: 'too old' }] }),
      { seq: 3, type: 'turn/end', data: { reason: { kind: 'completed' } } },
    ]

    assert.deepEqual(summarizeTurn(events, 4), { text: '', reason: undefined })
  })

  test('includes a turn whose start sequence equals firstSeq', () => {
    const reason = { kind: 'blocked' }
    const events = [
      { seq: 20, type: 'turn/start', data: {} },
      assistantMessage({ seq: 21, content: [{ type: 'text', text: 'included' }] }),
      { seq: 22, type: 'turn/end', data: { reason } },
    ]

    assert.deepEqual(summarizeTurn(events, 20), { text: 'included', reason })
  })

  test('ignores messages and an end event when the cutoff excludes their turn start', () => {
    const events = [
      { seq: 20, type: 'turn/start', data: {} },
      assistantMessage({ seq: 21, content: [{ type: 'text', text: 'excluded' }] }),
      { seq: 22, type: 'turn/end', data: { reason: { kind: 'completed' } } },
    ]

    assert.deepEqual(summarizeTurn(events, 21), { text: '', reason: undefined })
  })

  test('does not replace a non-empty answer with an empty assistant message', () => {
    const events = [
      { seq: 10, type: 'turn/start', data: {} },
      assistantMessage({ seq: 11, content: [{ type: 'text', text: 'answer' }] }),
      assistantMessage({ seq: 12, content: [{ type: 'image', data: 'only an image' }] }),
    ]

    assert.deepEqual(summarizeTurn(events, 10), { text: 'answer', reason: undefined })
  })
})

describe('turnFailure', () => {
  test('maps terminal reasons to user-facing failures', () => {
    assert.equal(turnFailure(undefined), undefined)
    assert.equal(turnFailure({ kind: 'completed' }), undefined)
    assert.equal(turnFailure({ kind: 'error', error: { code: 'E_MODEL', message: 'unavailable' } }), 'E_MODEL: unavailable')
    assert.equal(turnFailure({ kind: 'aborted' }), '任务已取消')
    assert.equal(turnFailure({ kind: 'max-tokens' }), '达到输出 token 上限')
    assert.equal(turnFailure({ kind: 'blocked' }), '任务被阻止')
    assert.equal(turnFailure({ kind: 'custom' }), '任务结束：custom')
  })
})
