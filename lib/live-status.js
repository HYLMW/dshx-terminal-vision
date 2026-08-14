import { cacheHitPercent, contextOccupancy, formatDuration, formatTokens } from './stats.js'

export const LIVE_STATUS_INTERVAL_MS = 1_000

const ANSI = {
  reset: '\u001b[0m',
  dim: '\u001b[2m',
  saveCursor: '\u001b7',
  restoreCursor: '\u001b8',
  clearLine: '\r\u001b[2K',
}

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function eventTime(event, fallback) {
  return typeof event?.time === 'number' && Number.isFinite(event.time) ? event.time : fallback
}

function isWide(codePoint) {
  return codePoint >= 0x1100 && (
    codePoint <= 0x115f
    || codePoint === 0x2329
    || codePoint === 0x232a
    || (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f)
    || (codePoint >= 0xac00 && codePoint <= 0xd7a3)
    || (codePoint >= 0xf900 && codePoint <= 0xfaff)
    || (codePoint >= 0xfe10 && codePoint <= 0xfe19)
    || (codePoint >= 0xfe30 && codePoint <= 0xfe6f)
    || (codePoint >= 0xff00 && codePoint <= 0xff60)
    || (codePoint >= 0xffe0 && codePoint <= 0xffe6)
    || (codePoint >= 0x1f300 && codePoint <= 0x1faff)
    || (codePoint >= 0x20000 && codePoint <= 0x3fffd)
  )
}

function characterWidth(character) {
  const codePoint = character.codePointAt(0)
  if (codePoint === undefined || codePoint === 0) return 0
  if (codePoint < 32 || (codePoint >= 0x7f && codePoint < 0xa0)) return 0
  return isWide(codePoint) ? 2 : 1
}

export function displayWidth(text) {
  return Array.from(String(text)).reduce((sum, character) => sum + characterWidth(character), 0)
}

export function truncateDisplay(text, maximumWidth) {
  if (!Number.isFinite(maximumWidth) || maximumWidth <= 0) return ''
  const characters = Array.from(String(text))
  const totalWidth = displayWidth(text)
  if (totalWidth <= maximumWidth) return characters.join('')
  if (maximumWidth === 1) return '…'
  let width = 0
  let result = ''
  for (const character of characters) {
    const next = width + characterWidth(character)
    if (next > maximumWidth - 1) break
    width = next
    result += character
  }
  return `${result}…`
}

function stepKey(event) {
  return `${event.data?.turn ?? ''}:${event.data?.step ?? ''}`
}

function usageTotal(usages, key) {
  let total = 0
  for (const usage of usages.values()) total += finite(usage?.[key])
  return total
}

export class LiveTurnMetrics {
  constructor({ now = Date.now } = {}) {
    this.now = now
    this.reset()
  }

  reset(startedAt = this.now()) {
    this.startedAt = startedAt
    this.stepStartedAt = new Map()
    this.outputBytes = new Map()
    this.firstTokenByStep = new Map()
    this.decodeEndedAt = new Map()
    this.activity = '等待模型'
    this.activeTools = new Map()
    this.usages = new Map()
  }

  observe(event) {
    const time = eventTime(event, this.now())
    if (event.type === 'turn/start') {
      this.activity = '等待模型'
      return
    }
    if (event.type === 'step/start') {
      this.stepStartedAt.set(stepKey(event), time)
      this.activity = '等待模型'
      return
    }
    if (event.type === 'assistant/chunk') {
      const chunk = event.data.chunk
      if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') {
        if (chunk.text !== '') {
          const key = stepKey(event)
          if (!this.firstTokenByStep.has(key)) this.firstTokenByStep.set(key, time)
          this.outputBytes.set(key, (this.outputBytes.get(key) ?? 0) + Buffer.byteLength(chunk.text, 'utf8'))
          this.activity = chunk.type === 'reasoning-delta' ? '思考中' : '生成中'
        }
      } else if (chunk.type === 'usage') {
        const key = stepKey(event)
        this.usages.set(key, chunk.usage)
      }
      return
    }
    if (event.type === 'assistant/message') {
      if (event.data.usage !== undefined) {
        const key = stepKey(event)
        this.usages.set(key, event.data.usage)
      }
      const key = stepKey(event)
      if (this.firstTokenByStep.has(key)) this.decodeEndedAt.set(key, time)
      return
    }
    if (event.type === 'tool/call') {
      this.activeTools.set(event.data.callId, event.data.name)
      this.activity = event.data.name
      return
    }
    if (event.type === 'tool/result') {
      const block = event.data.message?.content?.find(item => item?.type === 'tool-result')
      if (block?.toolCallId !== undefined) this.activeTools.delete(block.toolCallId)
      this.activity = this.activeTools.size > 0 ? Array.from(this.activeTools.values()).at(-1) : '等待模型'
      return
    }
    if (event.type === 'turn/end') this.activity = '完成中'
  }

  snapshot(at = this.now()) {
    const stepKeys = new Set([...this.outputBytes.keys(), ...this.usages.keys()])
    let outputTokens = 0
    let outputEstimated = stepKeys.size === 0
    for (const key of stepKeys) {
      const usage = this.usages.get(key)
      if (usage === undefined) {
        outputTokens += Math.ceil((this.outputBytes.get(key) ?? 0) / 4)
        outputEstimated = true
      } else {
        outputTokens += finite(usage.outputTokens)
      }
    }
    let decodeMs = 0
    for (const [key, start] of this.firstTokenByStep) {
      decodeMs += Math.max(0, (this.decodeEndedAt.get(key) ?? at) - start)
    }
    let ttftMs = 0
    let ttftSteps = 0
    for (const [key, firstToken] of this.firstTokenByStep) {
      ttftMs += Math.max(0, firstToken - (this.stepStartedAt.get(key) ?? this.startedAt))
      ttftSteps += 1
    }
    const inputTokens = usageTotal(this.usages, 'inputTokens')
    const cacheReadTokens = usageTotal(this.usages, 'cacheReadTokens')
    const cacheWriteTokens = usageTotal(this.usages, 'cacheWriteTokens')
    const usage = this.usages.size === 0 ? undefined : {
      uncachedInputTokens: inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
    }
    return {
      activity: this.activity,
      elapsedMs: Math.max(0, at - this.startedAt),
      ttftMs: ttftSteps === 0 ? undefined : ttftMs / ttftSteps,
      outputTokens,
      outputEstimated,
      tokensPerSecond: decodeMs > 0 ? outputTokens / (decodeMs / 1_000) : undefined,
      usage,
    }
  }
}

export function formatLiveStatus({ provider, model, metrics, stats, compact = false }) {
  const route = provider === undefined || provider === '' ? model : `${provider}/${model}`
  const hit = cacheHitPercent(metrics.usage)
  const context = contextOccupancy(stats?.pressure)
  if (compact) {
    const activity = metrics.activity.replace(/中$/u, '').replace(/^等待模型$/u, '等待')
    const fields = [
      `● ${model}`,
      `${activity} ${formatDuration(metrics.elapsedMs)}`,
      `T ${metrics.ttftMs === undefined ? '—' : formatDuration(metrics.ttftMs)}`,
    ]
    if (metrics.tokensPerSecond !== undefined) {
      fields.push(`~${Math.round(metrics.tokensPerSecond * 10) / 10}t/s`)
    }
    fields.push(`O${metrics.outputEstimated ? '~' : ''}${formatTokens(metrics.outputTokens)}`)
    fields.push(`C${hit === undefined ? '—' : `${hit}%`}`)
    if (context !== undefined) fields.push(`X${context.percent}%`)
    return fields.join(' · ')
  }
  const fields = [
    `● ${route}`,
    `${metrics.activity} ${formatDuration(metrics.elapsedMs)}`,
    `TTFT ${metrics.ttftMs === undefined ? '—' : formatDuration(metrics.ttftMs)}`,
  ]
  if (metrics.tokensPerSecond !== undefined) {
    fields.push(`~${Math.round(metrics.tokensPerSecond * 10) / 10} tok/s`)
  }
  fields.push(`输出 ${metrics.outputEstimated ? '~' : ''}${formatTokens(metrics.outputTokens)}`)
  fields.push(`缓存 ${hit === undefined ? '—' : `${hit}%`}`)
  if (context !== undefined) fields.push(`上下文 ${context.percent}%`)
  return fields.join(' · ')
}

export class LiveStatusBar {
  constructor({
    output = process.stdout,
    color = true,
    intervalMs = LIVE_STATUS_INTERVAL_MS,
    enabled = true,
    now = Date.now,
    setIntervalFn = setInterval,
    clearIntervalFn = clearInterval,
  } = {}) {
    this.output = output
    this.colorEnabled = color && output.isTTY !== false && process.env.NO_COLOR === undefined
    this.enabled = enabled && output.isTTY === true
    this.intervalMs = intervalMs
    this.now = now
    this.setIntervalFn = setIntervalFn
    this.clearIntervalFn = clearIntervalFn
    this.metrics = new LiveTurnMetrics({ now })
    this.active = false
    this.visible = false
    this.pauseDepth = 0
    this.timer = undefined
    this.cachedText = ''
    this.cachedCompactText = ''
  }

  begin({ provider, model, getStats = () => undefined }) {
    this.stop()
    if (!this.enabled) return
    this.provider = provider
    this.model = model
    this.getStats = getStats
    this.metrics.reset(this.now())
    this.active = true
    this.refresh()
    this.timer = this.setIntervalFn(() => this.refresh(), this.intervalMs)
    this.timer?.unref?.()
  }

  observe(event) {
    if (this.active) this.metrics.observe(event)
  }

  refresh() {
    if (!this.active) return
    let stats
    try {
      stats = this.getStats?.()
    } catch {
      // Live display is best-effort; final stats still use the normal projection path.
    }
    const status = {
      provider: this.provider,
      model: this.model,
      metrics: this.metrics.snapshot(this.now()),
      stats,
    }
    this.cachedText = formatLiveStatus(status)
    this.cachedCompactText = formatLiveStatus({ ...status, compact: true })
    if (this.pauseDepth > 0) return
    this.clear()
    this.draw()
  }

  draw() {
    if (!this.active || this.visible || this.pauseDepth > 0 || this.cachedText === '') return
    const columns = finite(this.output.columns)
    const width = columns > 1 ? columns - 1 : 119
    const candidate = displayWidth(this.cachedText) <= width ? this.cachedText : this.cachedCompactText
    const text = truncateDisplay(candidate, width)
    const styled = this.colorEnabled ? `${ANSI.dim}${text}${ANSI.reset}` : text
    this.output.write(`${ANSI.saveCursor}\n${ANSI.clearLine}${styled}`)
    this.visible = true
  }

  clear() {
    if (!this.visible) return
    this.output.write(`${ANSI.clearLine}${ANSI.restoreCursor}`)
    this.visible = false
  }

  beforeOutput() {
    this.clear()
  }

  afterOutput() {
    this.draw()
  }

  pause() {
    this.pauseDepth += 1
    if (this.pauseDepth === 1) this.clear()
  }

  resume() {
    if (this.pauseDepth === 0) return
    this.pauseDepth -= 1
    if (this.pauseDepth === 0) this.draw()
  }

  stop() {
    this.clear()
    if (this.timer !== undefined) this.clearIntervalFn(this.timer)
    this.timer = undefined
    this.active = false
    this.pauseDepth = 0
    this.cachedText = ''
    this.cachedCompactText = ''
  }
}
