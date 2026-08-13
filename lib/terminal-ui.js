import { createInterface } from 'node:readline/promises'

const ANSI = {
  reset: '\u001b[0m',
  bold: '\u001b[1m',
  dim: '\u001b[2m',
  cyan: '\u001b[36m',
  green: '\u001b[32m',
  yellow: '\u001b[33m',
  red: '\u001b[31m',
  gray: '\u001b[90m',
}

function oneLine(value, limit = 120) {
  const compact = String(value).replace(/\s+/gu, ' ').trim()
  return compact.length <= limit ? compact : `${compact.slice(0, limit - 1)}…`
}

export function summarizeToolArguments(rawArguments) {
  try {
    const args = JSON.parse(rawArguments)
    if (args === null || typeof args !== 'object') return oneLine(rawArguments)
    for (const key of ['command', 'cmd', 'path', 'file_path', 'query', 'pattern', 'objective', 'prompt', 'description', 'url']) {
      if (typeof args[key] === 'string' && args[key].trim() !== '') return oneLine(args[key])
    }
    const keys = Object.keys(args)
    return keys.length === 0 ? '' : oneLine(keys.join(', '))
  } catch {
    return oneLine(rawArguments)
  }
}

function toolResultText(message) {
  const result = message?.content?.find(block => block?.type === 'tool-result')
  if (result === undefined) return ''
  return result.content
    ?.filter(block => block?.type === 'text')
    .map(block => block.text)
    .join('') ?? ''
}

export function parseQuestionAnswer(question, rawAnswer) {
  const raw = rawAnswer.trim()
  const options = question.options ?? []
  if (options.length === 0) {
    return { id: question.id, selected: [], ...(raw === '' ? {} : { custom: raw }) }
  }

  const tokens = question.multiSelect ? raw.split(',').map(value => value.trim()).filter(Boolean) : [raw]
  const selected = []
  const custom = []
  for (const token of tokens) {
    const numeric = /^\d+$/u.test(token) ? Number(token) - 1 : -1
    const byNumber = options[numeric]
    const byLabel = options.find(option => option.label.toLocaleLowerCase() === token.toLocaleLowerCase())
    const choice = byNumber ?? byLabel
    if (choice !== undefined) {
      if (!selected.includes(choice.label)) selected.push(choice.label)
    } else if (token !== '') {
      custom.push(token)
    }
  }
  return {
    id: question.id,
    selected,
    ...(custom.length === 0 ? {} : { custom: custom.join(', ') }),
  }
}

export class TerminalUI {
  constructor({ input = process.stdin, output = process.stdout, error = process.stderr, color = true } = {}) {
    this.input = input
    this.output = output
    this.error = error
    this.colorEnabled = color && output.isTTY !== false && process.env.NO_COLOR === undefined
    this.closed = false
    this.readline = createInterface({
      input,
      output,
      terminal: Boolean(input.isTTY && output.isTTY),
      historySize: 500,
      removeHistoryDuplicates: true,
    })
  }

  style(text, style) {
    return this.colorEnabled ? `${ANSI[style]}${text}${ANSI.reset}` : text
  }

  line(text = '') {
    this.output.write(`${text}\n`)
  }

  errorLine(text) {
    this.error.write(`${this.style(text, 'red')}\n`)
  }

  async question(prompt, signal) {
    if (this.closed) throw new Error('terminal input is closed')
    return this.readline.question(prompt, signal === undefined ? undefined : { signal })
  }

  onSigint(listener) {
    this.readline.on('SIGINT', listener)
  }

  close() {
    if (this.closed) return
    this.closed = true
    this.readline.close()
  }

  banner({ cwd, model, provider, permissionMode, sessionId }) {
    this.line(this.style('DeepSeek Harness · dshx', 'bold'))
    this.line(`${this.style('工作目录', 'gray')}  ${cwd}`)
    this.line(`${this.style('模型', 'gray')}      ${provider}/${model}`)
    this.line(`${this.style('权限', 'gray')}      ${permissionMode}`)
    this.line(`${this.style('会话', 'gray')}      ${sessionId}`)
    this.line(this.style('输入 /help 查看命令；Ctrl-C 取消当前任务或退出。', 'dim'))
    this.line()
  }

  async askApproval(request, { unattended = false } = {}) {
    if (unattended && !this.input.isTTY) return 'rejected'
    this.line()
    this.line(`${this.style('权限确认', 'yellow')}  ${request.toolName}`)
    if (request.reason) this.line(`  ${request.reason}`)
    try {
      const answer = await this.question(this.style('允许这一次操作？[y/N] ', 'yellow'), request.signal)
      return /^(?:y|yes|是|允许)$/iu.test(answer.trim()) ? 'allowed-once' : 'rejected'
    } catch {
      return request.signal?.aborted ? 'cancelled' : 'unavailable'
    }
  }

  async askUserQuestions(request, { unattended = false } = {}) {
    if (unattended && !this.input.isTTY) {
      throw new Error('ask_user_question 在非交互式 --print 模式下不可用')
    }
    const answers = []
    for (const question of request.questions) {
      this.line()
      if (question.header) this.line(this.style(question.header, 'cyan'))
      this.line(this.style(question.question, 'bold'))
      if (question.detail) this.line(question.detail)
      const options = question.options ?? []
      options.forEach((option, index) => {
        const description = option.description ? ` — ${option.description}` : ''
        this.line(`  ${index + 1}. ${option.label}${this.style(description, 'dim')}`)
      })

      let parsed
      do {
        const hint = options.length === 0
          ? '回答：'
          : question.multiSelect
            ? '选择编号（可用逗号分隔）或输入自定义答案：'
            : '选择编号或输入自定义答案：'
        const raw = await this.question(this.style(hint, 'cyan'), request.signal)
        parsed = parseQuestionAnswer(question, raw)
      } while (parsed.selected.length === 0 && parsed.custom === undefined)
      answers.push(parsed)
    }
    return { answers }
  }
}

export class EventRenderer {
  constructor({ output = process.stdout, color = true, showReasoning = false, quiet = false } = {}) {
    this.output = output
    this.colorEnabled = color && output.isTTY !== false && process.env.NO_COLOR === undefined
    this.showReasoning = showReasoning
    this.quiet = quiet
    this.lineOpen = false
    this.reasoningOpen = false
    this.streamedSteps = new Set()
    this.calls = new Map()
  }

  style(text, style) {
    return this.colorEnabled ? `${ANSI[style]}${text}${ANSI.reset}` : text
  }

  beginTurn() {
    this.streamedSteps.clear()
    this.calls.clear()
    this.lineOpen = false
    this.reasoningOpen = false
  }

  ensureNewline() {
    if (this.quiet) return
    if (this.lineOpen) this.output.write('\n')
    this.lineOpen = false
    this.reasoningOpen = false
  }

  writeText(text) {
    if (this.quiet || text === '') return
    if (this.reasoningOpen) this.ensureNewline()
    this.output.write(text)
    this.lineOpen = !text.endsWith('\n')
  }

  handle(event) {
    if (this.quiet) return
    if (event.type === 'assistant/chunk') {
      const chunk = event.data.chunk
      const stepKey = `${event.data.turn}:${event.data.step}`
      if (chunk.type === 'text-delta') {
        if (chunk.text !== '') this.streamedSteps.add(stepKey)
        this.writeText(chunk.text)
      } else if (chunk.type === 'reasoning-delta' && this.showReasoning) {
        if (!this.reasoningOpen) {
          this.ensureNewline()
          this.output.write(this.style('思考 › ', 'gray'))
          this.reasoningOpen = true
        }
        this.output.write(this.style(chunk.text, 'dim'))
        this.lineOpen = !chunk.text.endsWith('\n')
      }
      return
    }

    if (event.type === 'assistant/message') {
      const stepKey = `${event.data.turn}:${event.data.step}`
      if (this.streamedSteps.has(stepKey)) return
      const text = event.data.message.content
        .filter(block => block.type === 'text')
        .map(block => block.text)
        .join('')
      this.writeText(text)
      return
    }

    if (event.type === 'tool/call') {
      this.ensureNewline()
      this.calls.set(event.data.callId, event.data.name)
      const summary = summarizeToolArguments(event.data.arguments)
      this.output.write(`${this.style('●', 'cyan')} ${this.style(event.data.name, 'bold')}${summary ? `  ${summary}` : ''}\n`)
      return
    }

    if (event.type === 'tool/result') {
      this.ensureNewline()
      const block = event.data.message?.content?.find(item => item?.type === 'tool-result')
      const failed = event.data.error !== undefined || block?.isError === true
      const name = this.calls.get(block?.toolCallId) ?? 'tool'
      const marker = failed ? this.style('✗', 'red') : this.style('✓', 'green')
      this.output.write(`  ${marker} ${name}\n`)
      const rawPreview = toolResultText(event.data.message).trim()
      if (rawPreview !== '') {
        const lines = rawPreview.split(/\r?\n/u).slice(0, 5).join('\n')
        const preview = lines.length <= 600 ? lines : `${lines.slice(0, 599)}…`
        for (const line of preview.split('\n')) this.output.write(`    ${this.style(line, 'dim')}\n`)
      }
      return
    }

    if (event.type === 'turn/end') this.ensureNewline()
  }

  finish() {
    this.ensureNewline()
  }
}

export function summarizeTurn(events, firstSeq) {
  let started = false
  let text = ''
  let reason
  for (const event of events) {
    if (event.seq < firstSeq) continue
    if (event.type === 'turn/start') {
      started = true
      continue
    }
    if (!started) continue
    if (event.type === 'assistant/message') {
      const joined = event.data.message.content
        .filter(block => block.type === 'text')
        .map(block => block.text)
        .join('')
      if (joined !== '') text = joined
    }
    if (event.type === 'turn/end') reason = event.data.reason
  }
  return { text, reason }
}

export function turnFailure(reason) {
  if (reason === undefined || reason.kind === 'completed') return undefined
  if (reason.kind === 'error') return `${reason.error.code}: ${reason.error.message}`
  if (reason.kind === 'aborted') return '任务已取消'
  if (reason.kind === 'max-tokens') return '达到输出 token 上限'
  if (reason.kind === 'blocked') return '任务被阻止'
  return `任务结束：${reason.kind}`
}
