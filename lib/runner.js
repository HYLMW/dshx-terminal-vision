import { randomUUID } from 'node:crypto'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { EventRenderer, summarizeTurn, TerminalUI, turnFailure } from './terminal-ui.js'
import { lastSession, rememberSession } from './state.js'

export const name = 'dshx-terminal'
export const inject = ['agentDefaultModel', 'agents', 'sessions', 'commands', 'userQuestions']

function envFlag(name) {
  return process.env[name] === '1'
}

function errorText(error) {
  return error instanceof Error ? error.message : String(error)
}

function selectionFromEnvironment(defaultModel) {
  const selected = defaultModel.currentSelection()
  return {
    ...selected,
    provider: process.env.DSHX_PROVIDER ?? selected.provider,
    model: process.env.DSHX_MODEL ?? selected.model,
  }
}

function setupSelection(selection) {
  return (agentCtx) => {
    installModelSelection(agentCtx, { current: selection, assembled: undefined })
  }
}

async function runTerminal(ctx, exit) {
  await ctx.get('loader')?.await()
  const agents = ctx.get('agents')
  const defaultModel = ctx.get('agentDefaultModel')
  const sessions = ctx.get('sessions')
  const commands = ctx.get('commands')
  const userQuestions = ctx.get('userQuestions')
  if (agents === undefined || defaultModel === undefined || sessions === undefined || commands === undefined || userQuestions === undefined) return

  const printMode = envFlag('DSHX_PRINT')
  const color = process.env.DSHX_COLOR !== '0'
  const ui = new TerminalUI({ color })
  const renderer = new EventRenderer({ color, showReasoning: envFlag('DSHX_REASONING'), quiet: printMode })
  const selection = selectionFromEnvironment(defaultModel)
  const permissionMode = process.env.DSH_PERMISSION_MODE ?? 'workspace-write'
  let currentHandle
  let activeCommandController
  let exitRequested = false
  let exitCode = 0

  const sessionEventsDisposer = ctx.on('session/event', (session, event) => {
    if (currentHandle?.agent.session === session) renderer.handle(event)
  })

  const approvalDisposer = ctx.on('approval/request', (request, next) => {
    if (request.agent !== currentHandle?.agent) return next()
    return ui.askApproval(request, { unattended: printMode })
  }, { prepend: true })

  const questionDisposer = userQuestions.registerProvider({
    ask: async (request) => {
      if (request.agent !== undefined && request.agent !== currentHandle?.agent) {
        throw new Error('dshx 只能回答当前根 Agent 的问题')
      }
      return ui.askUserQuestions(request, { unattended: printMode })
    },
  })

  async function persistCurrent() {
    if (currentHandle === undefined) return
    try {
      await sessions.flush(currentHandle.agent.session)
      await rememberSession(process.cwd(), currentHandle.agent.id)
    } catch (error) {
      ui.errorLine(`会话状态保存失败：${errorText(error)}`)
    }
  }

  async function makeHandle(resumeSessionId) {
    const setup = setupSelection(selection)
    const agentOptions = { provider: selection.provider, model: selection.model }
    const handle = resumeSessionId === undefined
      ? await agents.create({
          sessionId: SessionId(`session-${randomUUID()}`),
          meta: { cwd: process.cwd() },
          agentOptions,
          setup,
        })
      : await agents.resume({
          resumeSessionId: SessionId(resumeSessionId),
          agentOptions,
          setup,
        })
    await handle.agent.whenIdle()
    return handle
  }

  async function switchSession(resumeSessionId) {
    if (resumeSessionId !== undefined && currentHandle?.agent.id === resumeSessionId) return currentHandle
    const nextHandle = await makeHandle(resumeSessionId)
    const previous = currentHandle
    currentHandle = nextHandle
    if (previous !== undefined) {
      try {
        await sessions.flush(previous.agent.session)
      } finally {
        await previous.dispose()
      }
    }
    await rememberSession(process.cwd(), nextHandle.agent.id)
    return nextHandle
  }

  async function runTurn(prompt) {
    const agent = currentHandle.agent
    const firstSeq = agent.session.seq
    renderer.beginTurn()
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: prompt }],
      source: { kind: 'user' },
    }))
    await agent.whenIdle()
    await sessions.flush(agent.session)
    renderer.finish()
    const outcome = summarizeTurn(agent.session.events, firstSeq)
    if (printMode) process.stdout.write(`${outcome.text}\n`)
    const failure = turnFailure(outcome.reason)
    if (failure !== undefined) ui.errorLine(failure)
    return outcome.reason?.kind === 'completed'
  }

  function showHelp() {
    ui.line('dshx 命令：')
    ui.line('  /help              显示本帮助')
    ui.line('  /session           显示当前会话 ID')
    ui.line('  /new               新建会话')
    ui.line('  /resume <ID>       恢复指定会话')
    ui.line('  /reasoning [on|off] 开关推理流')
    ui.line('  /clear             清屏')
    ui.line('  /exit              退出')
    const available = commands.list(currentHandle.agent)
    if (available.length > 0) {
      ui.line()
      ui.line('Harness 命令：')
      for (const command of available) {
        const hint = command.input?.hint ? ` ${command.input.hint}` : ''
        ui.line(`  /${command.name}${hint}  ${command.description}`)
      }
    }
  }

  async function handleBuiltin(line) {
    const trimmed = line.trim()
    if (trimmed === '/exit' || trimmed === '/quit') {
      exitRequested = true
      return true
    }
    if (trimmed === '/help') {
      showHelp()
      return true
    }
    if (trimmed === '/session') {
      ui.line(currentHandle.agent.id)
      return true
    }
    if (trimmed === '/clear') {
      if (process.stdout.isTTY) process.stdout.write('\u001bc')
      else ui.line()
      return true
    }
    if (trimmed === '/new') {
      const handle = await switchSession(undefined)
      ui.line(`已新建会话：${handle.agent.id}`)
      return true
    }
    if (trimmed === '/resume' || trimmed.startsWith('/resume ')) {
      const id = trimmed.slice('/resume'.length).trim()
      if (id === '') ui.errorLine('用法：/resume <会话ID>')
      else {
        const handle = await switchSession(id)
        ui.line(`已恢复会话：${handle.agent.id}`)
      }
      return true
    }
    if (trimmed === '/reasoning' || trimmed.startsWith('/reasoning ')) {
      const value = trimmed.slice('/reasoning'.length).trim()
      if (value === '') renderer.showReasoning = !renderer.showReasoning
      else if (value === 'on') renderer.showReasoning = true
      else if (value === 'off') renderer.showReasoning = false
      else {
        ui.errorLine('用法：/reasoning [on|off]')
        return true
      }
      ui.line(`推理流：${renderer.showReasoning ? '开启' : '关闭'}`)
      return true
    }
    return false
  }

  async function executeSlashCommand(line) {
    if (await handleBuiltin(line)) return
    activeCommandController = new AbortController()
    try {
      const execution = await commands.execute(currentHandle.agent, line, activeCommandController.signal)
      if (execution === undefined) {
        ui.errorLine(`未知命令：${line.split(/\s/u, 1)[0]}（输入 /help 查看命令）`)
        return
      }
      const result = execution.result
      if (result.text) {
        if (result.kind === 'error') ui.errorLine(result.text)
        else ui.line(result.text)
      }
      await sessions.flush(currentHandle.agent.session)
    } catch (error) {
      ui.errorLine(`命令失败：${errorText(error)}`)
    } finally {
      activeCommandController = undefined
    }
  }

  ui.onSigint(() => {
    if (currentHandle?.agent.status === 'running') {
      ui.line('\n正在取消当前任务…')
      currentHandle.agent.cancel({ kind: 'user' })
      return
    }
    if (activeCommandController !== undefined) {
      activeCommandController.abort(new Error('命令已取消'))
      return
    }
    exitRequested = true
    ui.close()
  })

  try {
    let requestedSession = process.env.DSHX_RESUME_SESSION
    if (requestedSession === undefined && envFlag('DSHX_CONTINUE')) {
      requestedSession = await lastSession(process.cwd())
      if (requestedSession === undefined && !printMode) ui.line('当前目录没有可恢复的 dshx 会话，将新建会话。')
    }
    await switchSession(requestedSession)

    if (!printMode) {
      ui.banner({
        cwd: process.cwd(),
        model: selection.model,
        provider: selection.provider,
        permissionMode,
        sessionId: currentHandle.agent.id,
      })
    }

    const initialPrompt = process.env.DSHX_INITIAL_PROMPT?.trim()
    if (initialPrompt) {
      const ok = await runTurn(initialPrompt)
      if (printMode) {
        exitCode = ok ? 0 : 1
        exitRequested = true
      } else {
        ui.line()
      }
    }

    while (!exitRequested) {
      let line
      try {
        line = await ui.question(ui.style('❯ ', 'cyan'))
      } catch {
        break
      }
      const prompt = line.trim()
      if (prompt === '') continue
      try {
        if (prompt.startsWith('/')) await executeSlashCommand(prompt)
        else {
          await runTurn(prompt)
          ui.line()
        }
      } catch (error) {
        ui.errorLine(errorText(error))
      }
    }
  } catch (error) {
    ui.errorLine(`dshx：${errorText(error)}`)
    exitCode = 1
  } finally {
    try {
      await persistCurrent()
      if (currentHandle?.agent.status === 'running') currentHandle.agent.cancel({ kind: 'disposed' })
      await currentHandle?.dispose()
    } catch (error) {
      ui.errorLine(`退出清理失败：${errorText(error)}`)
      exitCode = 1
    }
    questionDisposer()
    approvalDisposer()
    sessionEventsDisposer()
    ui.close()
    exit(exitCode)
  }
}

export function apply(ctx) {
  const exit = ctx.get('appExit')
  if (exit === undefined) throw new Error('dshx-terminal 必须由 dsh 命令行启动器加载')
  void runTerminal(ctx, exit).catch((error) => {
    process.stderr.write(`dshx：${errorText(error)}\n`)
    exit(1)
  })
}
