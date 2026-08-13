function finite(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

export function formatTokens(value) {
  const tokens = Math.max(0, Math.round(finite(value)))
  const scaled = number => number >= 100 ? String(Math.round(number)) : String(Math.round(number * 10) / 10)
  if (tokens < 1_000) return String(tokens)
  if (tokens < 1_000_000) return `${scaled(tokens / 1_000)}K`
  return `${scaled(tokens / 1_000_000)}M`
}

export function formatDuration(value) {
  const milliseconds = Math.max(0, finite(value))
  const seconds = milliseconds / 1_000
  if (seconds < 60) return `${Math.round(seconds * 10) / 10}s`
  const whole = Math.round(seconds)
  return `${Math.floor(whole / 60)}m${whole % 60}s`
}

export function billedInputTokens(usage) {
  if (usage === undefined) return 0
  return finite(usage.uncachedInputTokens) + finite(usage.cacheReadTokens) + finite(usage.cacheWriteTokens)
}

export function cacheHitPercent(usage) {
  const denominator = billedInputTokens(usage)
  return denominator === 0 ? undefined : Math.round(finite(usage.cacheReadTokens) / denominator * 100)
}

export function contextOccupancy(pressure) {
  const usedTokens = pressure?.projectedTokens ?? pressure?.pressureTokens
  const contextWindow = pressure?.contextWindow
  if (!Number.isFinite(usedTokens) || !Number.isFinite(contextWindow) || contextWindow <= 0) return undefined
  return {
    percent: Math.min(100, Math.round(Math.max(0, usedTokens) / contextWindow * 100)),
    usedTokens: Math.max(0, usedTokens),
    contextWindow,
  }
}

function emptyUsage() {
  return { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
}

export function usageDelta(before, after) {
  const left = before ?? emptyUsage()
  const right = after ?? emptyUsage()
  return {
    uncachedInputTokens: Math.max(0, finite(right.uncachedInputTokens) - finite(left.uncachedInputTokens)),
    outputTokens: Math.max(0, finite(right.outputTokens) - finite(left.outputTokens)),
    cacheReadTokens: Math.max(0, finite(right.cacheReadTokens) - finite(left.cacheReadTokens)),
    cacheWriteTokens: Math.max(0, finite(right.cacheWriteTokens) - finite(left.cacheWriteTokens)),
  }
}

export function statsFromSnapshot(snapshot) {
  const values = snapshot?.values ?? {}
  return {
    usage: values.tokenUsage,
    pressure: values.contextPressure,
    breakdown: values.contextBreakdown,
    session: values.sessionStats,
  }
}

export function formatStatsLine(stats) {
  const groups = []
  const session = stats?.session
  if (session?.steps > 0) {
    groups.push(`${session.turns} 轮 · ${session.steps} 步`)
    const durations = []
    if (session.llmMs > 0) durations.push(`模型 ${formatDuration(session.llmMs)}`)
    if (session.toolMs > 0) durations.push(`工具 ${formatDuration(session.toolMs)}`)
    if (durations.length > 0) groups.push(durations.join(' · '))
    const speeds = []
    if (session.ttftSteps > 0) speeds.push(`TTFT ${formatDuration(session.ttftMs / session.ttftSteps)}`)
    if (session.decodeMs > 0) {
      const throughput = session.decodeTokens / (session.decodeMs / 1_000)
      speeds.push(`${Math.round(throughput * 10) / 10} tok/s`)
    }
    if (speeds.length > 0) groups.push(speeds.join(' · '))
  }

  const usage = stats?.usage
  if (usage !== undefined && (billedInputTokens(usage) > 0 || finite(usage.outputTokens) > 0)) {
    const hit = cacheHitPercent(usage)
    if (hit !== undefined) groups.push(`缓存命中 ${hit}%`)
    groups.push(`输入 ${formatTokens(billedInputTokens(usage))} · 输出 ${formatTokens(usage.outputTokens)}`)
  }

  const context = contextOccupancy(stats?.pressure)
  if (context !== undefined) groups.push(`上下文 ${context.percent}%`)
  return groups.join('  |  ')
}

export function formatUsageDetails(stats, lastTurnUsage) {
  const usage = stats?.usage ?? emptyUsage()
  const input = billedInputTokens(usage)
  const hit = cacheHitPercent(usage)
  const lines = [
    `累计输入      ${formatTokens(input)}`,
    `  未缓存      ${formatTokens(usage.uncachedInputTokens)}`,
    `  缓存读取    ${formatTokens(usage.cacheReadTokens)}`,
    `  缓存写入    ${formatTokens(usage.cacheWriteTokens)}`,
    `累计输出      ${formatTokens(usage.outputTokens)}`,
    `缓存命中率    ${hit === undefined ? '—' : `${hit}%`}`,
  ]
  if (lastTurnUsage !== undefined) {
    lines.push(
      '',
      `上一轮输入    ${formatTokens(billedInputTokens(lastTurnUsage))}`,
      `上一轮输出    ${formatTokens(lastTurnUsage.outputTokens)}`,
      `上一轮缓存读  ${formatTokens(lastTurnUsage.cacheReadTokens)}`,
      `上一轮缓存写  ${formatTokens(lastTurnUsage.cacheWriteTokens)}`,
    )
  }
  return lines
}

export function formatContextDetails(stats) {
  const context = contextOccupancy(stats?.pressure)
  const breakdown = stats?.breakdown
  if (context === undefined) return ['上下文统计尚不可用；模型完成一次请求后会显示。']
  const lines = [
    `上下文占用    ${context.percent}%`,
    `预计用量      ~${formatTokens(context.usedTokens)} / ${formatTokens(context.contextWindow)}`,
  ]
  if (breakdown !== undefined) {
    lines.push(
      `  系统提示    ~${formatTokens(breakdown.systemTokens)}`,
      `  工具定义    ~${formatTokens(breakdown.toolsTokens)}`,
      `  对话消息    ~${formatTokens(breakdown.messageTokens)}`,
    )
  }
  return lines
}
