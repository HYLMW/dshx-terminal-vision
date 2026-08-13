import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { describe, test } from 'node:test'

import {
  applyCliEnvironment,
  CliUsageError,
  parseCli,
} from '../lib/cli-options.js'

describe('parseCli', () => {
  test('returns stable defaults', () => {
    assert.deepEqual(parseCli([]), {
      help: false,
      version: false,
      cwd: undefined,
      continueSession: false,
      resumeSession: undefined,
      printMode: false,
      model: undefined,
      provider: undefined,
      permissionMode: undefined,
      tools: undefined,
      showReasoning: false,
      color: true,
      initialPrompt: '',
    })
  })

  test('parses aliases, values, negative booleans, and a multi-word prompt', () => {
    assert.deepEqual(parseCli([
      '-h',
      '-V',
      '-C',
      './example-workspace',
      '-c',
      '-p',
      '--model',
      'deepseek-chat',
      '--provider',
      'deepseek',
      '--read-only',
      '--tools',
      'both',
      '--reasoning',
      '--no-color',
      'explain',
      'this project',
    ]), {
      help: true,
      version: true,
      cwd: resolve('./example-workspace'),
      continueSession: true,
      resumeSession: undefined,
      printMode: true,
      model: 'deepseek-chat',
      provider: 'deepseek',
      permissionMode: 'read-only',
      tools: 'both',
      showReasoning: true,
      color: false,
      initialPrompt: 'explain this project',
    })
  })

  test('maps permission convenience flags to their canonical modes', () => {
    assert.equal(parseCli(['--dangerously-skip-permissions']).permissionMode, 'danger-full-access')
    assert.equal(parseCli(['--read-only']).permissionMode, 'read-only')
    assert.equal(parseCli(['--permission-mode', 'workspace-write']).permissionMode, 'workspace-write')
  })

  test('parses a requested resume session', () => {
    const parsed = parseCli(['--resume', 'session-123'])

    assert.equal(parsed.resumeSession, 'session-123')
    assert.equal(parsed.continueSession, false)
  })

  test('wraps parser failures in CliUsageError', () => {
    assert.throws(
      () => parseCli(['--definitely-unknown']),
      error => error instanceof CliUsageError && error.name === 'CliUsageError',
    )
    assert.throws(
      () => parseCli(['--model']),
      error => error instanceof CliUsageError && error.name === 'CliUsageError',
    )
  })

  test('rejects conflicting session selection flags', () => {
    assert.throws(
      () => parseCli(['--continue', '--resume', 'session-123']),
      new CliUsageError('--continue 和 --resume 不能同时使用'),
    )
  })

  test('rejects conflicting permission flags', () => {
    const conflicting = [
      ['--read-only', '--dangerously-skip-permissions'],
      ['--read-only', '--permission-mode', 'workspace-write'],
      ['--dangerously-skip-permissions', '--permission-mode', 'workspace-write'],
    ]

    for (const argv of conflicting) {
      assert.throws(
        () => parseCli(argv),
        new CliUsageError('权限模式参数只能选择一个'),
      )
    }
  })

  test('rejects unsupported permission and tool modes', () => {
    assert.throws(
      () => parseCli(['--permission-mode', 'root']),
      new CliUsageError('--permission-mode 必须是 read-only、workspace-write 或 danger-full-access'),
    )
    assert.throws(
      () => parseCli(['--tools', 'automatic']),
      new CliUsageError('--tools 必须是 native、code 或 both'),
    )
  })

  test('requires a non-empty prompt in print mode', () => {
    assert.throws(
      () => parseCli(['--print', '   ']),
      new CliUsageError('--print 需要提供提示词，例如：dshx -p "解释这个项目"'),
    )
  })
})

describe('applyCliEnvironment', () => {
  test('applies explicit CLI selections to an isolated environment object', () => {
    const env = {
      DSH_PERMISSION_MODE: 'workspace-write',
      DSH_TOOLS_MODE: 'native',
      UNRELATED: 'preserved',
    }
    const options = parseCli([
      '--read-only',
      '--tools',
      'code',
      '--reasoning',
      '--no-color',
      '--continue',
      '--model',
      'model-id',
      '--provider',
      'provider-id',
      '--print',
      'say hello',
    ])

    applyCliEnvironment(options, env)

    assert.deepEqual(env, {
      DSH_PERMISSION_MODE: 'read-only',
      DSH_TOOLS_MODE: 'code',
      DSHX_COLOR: '0',
      DSHX_REASONING: '1',
      DSHX_PRINT: '1',
      DSHX_INITIAL_PROMPT: 'say hello',
      DSHX_CONTINUE: '1',
      DSHX_MODEL: 'model-id',
      DSHX_PROVIDER: 'provider-id',
      UNRELATED: 'preserved',
    })
  })

  test('preserves configured defaults and removes stale optional selections', () => {
    const env = {
      DSH_PERMISSION_MODE: 'danger-full-access',
      DSH_TOOLS_MODE: 'both',
      DSHX_INITIAL_PROMPT: 'stale prompt',
      DSHX_CONTINUE: '1',
      DSHX_RESUME_SESSION: 'stale-session',
      DSHX_MODEL: 'stale-model',
      DSHX_PROVIDER: 'stale-provider',
    }

    applyCliEnvironment(parseCli([]), env)

    assert.deepEqual(env, {
      DSH_PERMISSION_MODE: 'danger-full-access',
      DSH_TOOLS_MODE: 'both',
      DSHX_COLOR: '1',
      DSHX_REASONING: '0',
      DSHX_PRINT: '0',
    })
  })

  test('uses application defaults when neither flags nor environment provide modes', () => {
    const env = {}

    applyCliEnvironment(parseCli([]), env)

    assert.equal(env.DSH_PERMISSION_MODE, 'workspace-write')
    assert.equal(env.DSH_TOOLS_MODE, 'native')
  })
})
