import { randomUUID } from 'node:crypto'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { buildModelCatalog, parseModelCommand, resolveModelSelection, selectionFromSession } from './models.js'
import {
  formatContextDetails,
  formatStatsLine,
  formatUsageDetails,
  statsFromSnapshot,
  usageDelta,
} from './stats.js'
import { EventRenderer, summarizeTurn, TerminalUI, turnFailure } from './terminal-ui.js'
import { lastSession, rememberSession } from './state.js'
import { LiveStatusBar } from './live-status.js'
import { EndpointManager } from './endpoints.js'

export const name = 'dshx-terminal'
export const inject = ['agentDefaultModel', 'agents', 'sessions', 'commands', 'userQuestions', 'llm', 'sessionProjections', 'settings']

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

function explicitSelectionFromEnvironment(defaultModel) {
  if (process.env.DSHX_PROVIDER === undefined && process.env.DSHX_MODEL === undefined) return undefined
  return selectionFromEnvironment(defaultModel)
}

async function runTerminal(ctx, exit, endpointManager) {
  await ctx.get('loader')?.await()
  const agents = ctx.get('agents')
  const defaultModel = ctx.get('agentDefaultModel')
  const sessions = ctx.get('sessions')
  const commands = ctx.get('commands')
  const userQuestions = ctx.get('userQuestions')
  const llm = ctx.get('llm')
  const sessionProjections = ctx.get('sessionProjections')
  if (
    agents === undefined
    || defaultModel === undefined
    || sessions === undefined
    || commands === undefined
    || userQuestions === undefined
    || llm === undefined
    || sessionProjections === undefined
  ) return

  await endpointManager.initialize(process.env.DSHX_ENDPOINT)

  const printMode = envFlag('DSHX_PRINT')
  const color = process.env.DSHX_COLOR !== '0'
  const liveStatus = new LiveStatusBar({ color, enabled: !printMode })
  const ui = new TerminalUI({ color, liveStatus })
  const renderer = new EventRenderer({ color, showReasoning: envFlag('DSHX_REASONING'), quiet: printMode, liveStatus })
  const permissionMode = process.env.DSH_PERMISSION_MODE ?? 'workspace-write'
  const selections = new WeakMap()
  const lastTurnUsage = new WeakMap()
  const modelNames = new Map()
  let currentHandle
  let activeCommandController
  let exitRequested = false
  let exitCode = 0

  function selectionFor(agent = currentHandle?.agent) {
    const selection = agent === undefined ? undefined : selections.get(agent)
    if (selection === undefined) throw new Error('当前会话的模型选择尚未初始化')
    return selection
  }

  function statsFor(agent = currentHandle?.agent) {
    if (agent === undefined) return statsFromSnapshot(undefined)
    return statsFromSnapshot(sessionProjections.snapshot(agent.session))
  }

  function routeKey(selection) {
    return `${selection.provider}\u0000${selection.model}`
  }

  function modelNameFor(selection) {
    return modelNames.get(routeKey(selection)) ?? selection.model
  }

  async function rememberModelName(selection) {
    try {
      const info = await llm.resolveModelInfo(selection.provider, selection.model)
      modelNames.set(routeKey(selection), info.name)
    } catch {
      // A valid route may not expose display metadata; its stable id remains useful.
    }
  }

  function showStatsLine() {
    if (printMode || currentHandle === undefined) return
    const selected = selectionFor().current
    ui.statusLine({
      provider: selected.provider,
      model: modelNameFor(selected),
      text: formatStatsLine(statsFor()),
    })
  }

  function endpointSummary() {
    const endpoint = endpointManager.current()
    return `${endpoint.name ?? '未命名'} (${endpoint.baseURL})`
  }

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
    const initial = selectionFromEnvironment(defaultModel)
    const override = explicitSelectionFromEnvironment(defaultModel)
    let installedSelection
    const setup = (agentCtx) => {
      const agent = agentCtx.agent
      if (agent === undefined) throw new Error('模型选择初始化时没有 Agent 上下文')
      installedSelection = selectionFromSession(agent, () => defaultModel.currentSelection(), override)
      installModelSelection(agentCtx, installedSelection)
    }
    const agentOptions = {
      provider: initial.provider,
      model: initial.model,
      ...(initial.reasoningEffort === undefined ? {} : { reasoningEffort: initial.reasoningEffort }),
    }
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
    if (installedSelection === undefined) throw new Error('模型选择初始化失败')
    selections.set(handle.agent, installedSelection)
    await rememberModelName(installedSelection.current)
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
    const beforeUsage = statsFor(agent).usage
    renderer.beginTurn()
    const selected = selectionFor(agent).current
    liveStatus.begin({
      provider: selected.provider,
      model: modelNameFor(selected),
      getStats: () => statsFor(agent),
    })
    try {
      agent.followup(createUserMessage({
        content: [{ type: 'text', text: prompt }],
        source: { kind: 'user' },
      }))
      await agent.whenIdle()
      await sessions.flush(agent.session)
    } finally {
      liveStatus.stop()
      renderer.finish()
    }
    const afterStats = statsFor(agent)
    lastTurnUsage.set(agent, usageDelta(beforeUsage, afterStats.usage))
    const outcome = summarizeTurn(agent.session.events, firstSeq)
    if (printMode) process.stdout.write(`${outcome.text}\n`)
    const failure = turnFailure(outcome.reason)
    if (failure !== undefined) ui.errorLine(failure)
    if (!printMode) {
      ui.statusLine({ provider: selected.provider, model: modelNameFor(selected), text: formatStatsLine(afterStats) })
    }
    return outcome.reason?.kind === 'completed'
  }

  async function selectModel(requested) {
    const selected = await resolveModelSelection(llm, requested)
    selectionFor().current = selected
    await rememberModelName(selected)
    try {
      await defaultModel.saveSelection(selected)
    } catch (error) {
      ui.errorLine(`模型已切换，但保存为默认模型失败：${errorText(error)}`)
    }
    const effort = selected.reasoningEffort === undefined ? '' : ` · 推理 ${selected.reasoningEffort}`
    ui.line(`已切换模型：${modelNameFor(selected)} (${selected.provider}/${selected.model})${effort}`)
  }

  async function chooseModel(argument) {
    const direct = parseModelCommand(argument)
    if (direct !== undefined) {
      await selectModel(direct)
      return
    }
    ui.line('正在读取模型列表…')
    const catalog = await buildModelCatalog(llm)
    const requested = await ui.askModelSelection({
      ...catalog,
      current: selectionFor().current,
    })
    if (requested !== undefined) await selectModel(requested)
  }

  async function chooseEndpoint(argument) {
    const requested = argument.trim()
    let name = requested
    if (name === '') {
      const endpoints = endpointManager.list()
      if (endpoints.length === 0) {
        const path = endpointManager.documentPath() ?? '~/.dsh/settings.yaml'
        ui.errorLine(`没有命名端点；请先在 ${path} 的 dshx-terminal.endpoints 中配置。`)
        return
      }
      name = await ui.askEndpointSelection({
        endpoints,
        currentName: endpointManager.current().name,
      })
      if (name === undefined) return
    }
    const endpoint = await endpointManager.select(name)
    ui.line(`已切换端点：${endpoint.name} (${endpoint.baseURL})`)
    ui.line(`API Key 引用：${endpoint.apiKeyEnv}`)
  }

  function showUsage() {
    const agent = currentHandle.agent
    for (const line of formatUsageDetails(statsFor(agent), lastTurnUsage.get(agent))) ui.line(line)
  }

  function showStatus() {
    const selected = selectionFor().current
    const effort = selected.reasoningEffort === undefined ? '提供方默认' : selected.reasoningEffort
    ui.line(`模型          ${modelNameFor(selected)}`)
    ui.line(`路由          ${selected.provider}/${selected.model}`)
    ui.line(`推理强度      ${effort}`)
    ui.line(`权限          ${permissionMode}`)
    ui.line(`端点          ${endpointSummary()}`)
    ui.line(`API Key 引用  ${endpointManager.current().apiKeyEnv}`)
    ui.line(`会话          ${currentHandle.agent.id}`)
    const line = formatStatsLine(statsFor())
    if (line !== '') ui.line(line)
    for (const detail of formatContextDetails(statsFor())) ui.line(detail)
  }

  function showHelp() {
    ui.line('dshx 命令：')
    ui.line('  /help              显示本帮助')
    ui.line('  /session           显示当前会话 ID')
    ui.line('  /model [路由]       查看或切换模型')
    ui.line('  /endpoint [名称]     查看或切换 Base URL 端点')
    ui.line('  /status            显示模型、用量和上下文状态')
    ui.line('  /usage             显示 Token 与缓存明细')
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
    if (trimmed === '/status') {
      showStatus()
      return true
    }
    if (trimmed === '/usage') {
      showUsage()
      return true
    }
    if (trimmed === '/model' || trimmed.startsWith('/model ')) {
      await chooseModel(trimmed.slice('/model'.length))
      return true
    }
    if (trimmed === '/endpoint' || trimmed.startsWith('/endpoint ')) {
      await chooseEndpoint(trimmed.slice('/endpoint'.length))
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
      showStatsLine()
      return true
    }
    if (trimmed === '/resume' || trimmed.startsWith('/resume ')) {
      const id = trimmed.slice('/resume'.length).trim()
      if (id === '') ui.errorLine('用法：/resume <会话ID>')
      else {
        const handle = await switchSession(id)
        ui.line(`已恢复会话：${handle.agent.id}`)
        showStatsLine()
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
      const selected = selectionFor().current
      ui.banner({
        cwd: process.cwd(),
        model: modelNameFor(selected),
        provider: selected.provider,
        permissionMode,
        sessionId: currentHandle.agent.id,
        endpoint: endpointSummary(),
      })
      showStatsLine()
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
    endpointManager.dispose()
    ui.close()
    exit(exitCode)
  }
}

export function apply(ctx) {
  const exit = ctx.get('appExit')
  if (exit === undefined) throw new Error('dshx-terminal 必须由 dsh 命令行启动器加载')
  const settings = ctx.get('settings')
  if (settings === undefined) throw new Error('dshx-terminal 需要 Harness settings 服务')
  const endpointManager = new EndpointManager(settings)
  void runTerminal(ctx, exit, endpointManager).catch((error) => {
    endpointManager.dispose()
    process.stderr.write(`dshx：${errorText(error)}\n`)
    exit(1)
  })
}
