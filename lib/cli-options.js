import { parseArgs } from 'node:util'
import { resolve } from 'node:path'

const PERMISSION_MODES = new Set(['read-only', 'workspace-write', 'danger-full-access'])
const TOOL_MODES = new Set(['native', 'code', 'both'])

export class CliUsageError extends Error {
  constructor(message) {
    super(message)
    this.name = 'CliUsageError'
  }
}

export function parseCli(argv) {
  let parsed
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      allowNegative: true,
      strict: true,
      options: {
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'V' },
        cwd: { type: 'string', short: 'C' },
        continue: { type: 'boolean', short: 'c' },
        resume: { type: 'string', short: 'r' },
        print: { type: 'boolean', short: 'p' },
        model: { type: 'string' },
        provider: { type: 'string' },
        'permission-mode': { type: 'string' },
        'dangerously-skip-permissions': { type: 'boolean' },
        'read-only': { type: 'boolean' },
        tools: { type: 'string' },
        reasoning: { type: 'boolean' },
        color: { type: 'boolean', default: true },
      },
    })
  } catch (error) {
    throw new CliUsageError(error instanceof Error ? error.message : String(error))
  }

  const values = parsed.values
  if (values.continue && values.resume !== undefined) {
    throw new CliUsageError('--continue 和 --resume 不能同时使用')
  }

  const permissionFlags = [
    values['permission-mode'] !== undefined,
    values['dangerously-skip-permissions'] === true,
    values['read-only'] === true,
  ].filter(Boolean).length
  if (permissionFlags > 1) {
    throw new CliUsageError('权限模式参数只能选择一个')
  }

  let permissionMode = values['permission-mode']
  if (values['dangerously-skip-permissions']) permissionMode = 'danger-full-access'
  if (values['read-only']) permissionMode = 'read-only'
  if (permissionMode !== undefined && !PERMISSION_MODES.has(permissionMode)) {
    throw new CliUsageError('--permission-mode 必须是 read-only、workspace-write 或 danger-full-access')
  }

  const tools = values.tools
  if (tools !== undefined && !TOOL_MODES.has(tools)) {
    throw new CliUsageError('--tools 必须是 native、code 或 both')
  }

  const initialPrompt = parsed.positionals.join(' ').trim()
  if (values.print && initialPrompt === '') {
    throw new CliUsageError('--print 需要提供提示词，例如：dshx -p "解释这个项目"')
  }

  return {
    help: values.help === true,
    version: values.version === true,
    cwd: values.cwd === undefined ? undefined : resolve(values.cwd),
    continueSession: values.continue === true,
    resumeSession: values.resume,
    printMode: values.print === true,
    model: values.model,
    provider: values.provider,
    permissionMode,
    tools,
    showReasoning: values.reasoning === true,
    color: values.color !== false,
    initialPrompt,
  }
}

export function applyCliEnvironment(options, env = process.env) {
  env.DSH_PERMISSION_MODE = options.permissionMode ?? env.DSH_PERMISSION_MODE ?? 'workspace-write'
  env.DSH_TOOLS_MODE = options.tools ?? env.DSH_TOOLS_MODE ?? 'native'
  env.DSHX_COLOR = options.color ? '1' : '0'
  env.DSHX_REASONING = options.showReasoning ? '1' : '0'
  env.DSHX_PRINT = options.printMode ? '1' : '0'

  if (options.initialPrompt !== '') env.DSHX_INITIAL_PROMPT = options.initialPrompt
  else delete env.DSHX_INITIAL_PROMPT
  if (options.continueSession) env.DSHX_CONTINUE = '1'
  else delete env.DSHX_CONTINUE
  if (options.resumeSession !== undefined) env.DSHX_RESUME_SESSION = options.resumeSession
  else delete env.DSHX_RESUME_SESSION
  if (options.model !== undefined) env.DSHX_MODEL = options.model
  else delete env.DSHX_MODEL
  if (options.provider !== undefined) env.DSHX_PROVIDER = options.provider
  else delete env.DSHX_PROVIDER
}

export const HELP = `dshx — DeepSeek Harness 原生终端客户端

用法：
  dshx [选项] [初始提示词]
  dshx -p "一次性任务"

选项：
  -C, --cwd <目录>                 在指定目录工作
  -c, --continue                   恢复当前目录最近一次会话
  -r, --resume <会话ID>            恢复指定会话
  -p, --print                      一次性执行，结果输出后退出
      --model <模型ID>             覆盖默认模型
      --provider <提供方ID>        覆盖默认模型提供方
      --permission-mode <模式>     read-only | workspace-write | danger-full-access
      --read-only                  只读模式
      --dangerously-skip-permissions
                                   完全访问且不再确认（谨慎使用）
      --tools <模式>               native | code | both（默认 native）
      --reasoning                  显示推理流
      --no-color                   禁用颜色
  -h, --help                       显示帮助
  -V, --version                    显示版本

交互命令：
  /help        帮助与 Harness 命令列表
  /session     显示当前会话 ID
  /model       查看或切换模型
  /status      模型、用量与上下文状态
  /usage       Token 与缓存明细
  /new         新建会话
  /resume ID   切换到已有会话
  /reasoning   开关推理流
  /clear       清屏
  /exit        退出

默认采用 workspace-write：可读全局文件，可写当前工作目录和受控临时目录；其他越界操作会询问你。
`
