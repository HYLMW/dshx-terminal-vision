import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

/**
 * Collect every `baseURL` host declared in `~/.dsh/settings.yaml` and expose
 * them via PI_AI_MAX_TOKENS_DOMAINS (comma-separated).
 *
 * Why: pi-ai's openai-completions adapter hardcodes a domain whitelist to
 * decide between `max_tokens` and `max_completion_tokens`. Custom gateways
 * (self-hosted / corporate OpenAI-compatible endpoints) almost always expect
 * the classic `max_tokens` field. The apply-patches script teaches pi-ai to
 * consult this env var, and this hook populates it from whatever gateways the
 * user actually configured — so no gateway hostname is hardcoded anywhere.
 *
 * An explicit PI_AI_MAX_TOKENS_DOMAINS from the shell always wins.
 */
export function applyGatewayEnv() {
  if (process.env.PI_AI_MAX_TOKENS_DOMAINS !== undefined) return
  try {
    const settingsPath = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'settings.yaml')
    if (!existsSync(settingsPath)) return
    const src = readFileSync(settingsPath, 'utf8')
    const hosts = new Set()
    for (const line of src.split('\n')) {
      const m = line.match(/^\s*baseURL:\s*"?(https?:\/\/[^/\s"']+)/)
      if (m) hosts.add(m[1])
    }
    if (hosts.size > 0) process.env.PI_AI_MAX_TOKENS_DOMAINS = [...hosts].join(',')
  } catch {
    // best effort only — never block startup on env enrichment
  }
}
