#!/usr/bin/env node
/**
 * dshx-terminal vision patches
 *
 * Applied to node_modules after `npm install` (postinstall) and runnable any
 * time. All patches are idempotent: already-patched files are detected and
 * skipped, pristine backups (*.bak) are taken on first touch.
 *
 *   node scripts/apply-patches.mjs          # apply (default)
 *   node scripts/apply-patches.mjs --check  # report only
 *   node scripts/apply-patches.mjs --revert # restore *.bak
 *
 * Patch set:
 *   A. dsh-llm-deepseek — honour per-model `input: [text, image]` from the
 *      llm-deepseek settings catalog so `read_image` routing reflects reality.
 *   B. pi-ai openai-completions — extend the `max_tokens` field-name
 *      whitelist with hosts from PI_AI_MAX_TOKENS_DOMAINS (auto-populated
 *      from each ~/.dsh/settings.yaml baseURL by lib/gateway-env.js).
 *   C. dsh-web-search-deepseek — register an AnySearch REST (`/v1/search`)
 *      web-search provider next to the Anthropic-Messages DeepSeek provider.
 */

import { readFileSync, writeFileSync, copyFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// ─── target resolution ────────────────────────────────────────────────────────
// npm may hoist or nest transitive deps; probe both shapes, repo-local first,
// then common global install locations.

function candidateBases() {
  const bases = [join(ROOT, 'node_modules')];
  const nvmLib = join(homedir(), '.nvm/versions/node');
  try {
    for (const v of readdirSync(nvmLib)) {
      bases.push(join(nvmLib, v, 'lib/node_modules/dshx-terminal/node_modules'));
    }
  } catch { /* nvm not present or unreadable — repo-local only */ }
  return bases.filter(existsSync);
}

function resolveTargets() {
  for (const base of candidateBases()) {
    const deepseek = [
      join(base, '@deepseek-ai/dsh-base/node_modules/@deepseek-ai/dsh-llm-deepseek/lib/index.js'),
      join(base, '@deepseek-ai/dsh-llm-deepseek/lib/index.js'),
    ].find(existsSync);
    const piai = join(base, '@earendil-works/pi-ai/dist/api/openai-completions.js');
    const webSearch = [
      join(base, '@deepseek-ai/dsh-base/node_modules/@deepseek-ai/dsh-web-search-deepseek/lib/index.js'),
      join(base, '@deepseek-ai/dsh-web-search-deepseek/lib/index.js'),
    ].find(existsSync);
    if (deepseek || existsSync(piai) || webSearch) {
      return {
        deepseekTarget: deepseek ?? null,
        piAiTarget: existsSync(piai) ? piai : null,
        webSearchTarget: webSearch ?? null,
      };
    }
  }
  return { deepseekTarget: null, piAiTarget: null, webSearchTarget: null };
}

// ─── patch helpers ────────────────────────────────────────────────────────────

function applyOne(targetPath, label, transforms) {
  if (!targetPath || !existsSync(targetPath)) {
    console.log(`  - [${label}] module not installed (skipping)`);
    return 'missing';
  }
  const bak = targetPath + '.bak';
  if (!existsSync(bak)) copyFileSync(targetPath, bak);
  let src = readFileSync(targetPath, 'utf8');
  if (src.includes(transforms.marker)) {
    console.log(`  ✓ [${label}] already patched`);
    return 'already';
  }
  for (const [find, replace] of transforms.edits) {
    if (!src.includes(find)) {
      if (transforms.nativeMarker && src.includes(transforms.nativeMarker)) {
        console.log(`  · [${label}] skipped — upstream already supports this natively`);
        return 'native';
      }
      console.log(`  ✗ [${label}] anchor not found (upstream code changed?): ${find.slice(0, 60)}…`);
      copyFileSync(bak, targetPath); // restore pristine on partial failure
      return 'failed';
    }
    src = src.replace(find, replace);
  }
  writeFileSync(targetPath, src);
  console.log(`  ✓ [${label}] patched`);
  return 'applied';
}

// ─── patch definitions ────────────────────────────────────────────────────────

// dsh-llm-deepseek@0.1.0-rc.8+ 上游已原生支持 inputModalities 模型字段
// (schema 802: z.array(...).min(1).default(["text"])，stream 处 680 门禁)。
// rc.6 上需要本补丁；rc.8+ 走 native 路径，anchor 自然不命中即跳过。
const deepseekPatch = {
  marker: 'inputModalities: model.input ?? ["text"]',
  nativeMarker: 'inputModalities: z.array', // rc.8+ ships this schema natively
  edits: [
    [
      'maxTokens: z.number().step(1).min(1)\n});',
      'maxTokens: z.number().step(1).min(1),\n\tinput: z.array(z.union(["text", "image"]))\n});',
    ],
    [
      'inputModalities: ["text"]',
      'inputModalities: model.input ?? ["text"]',
    ],
    [
      '...model.maxTokens === void 0 ? {} : { maxTokens: model.maxTokens }\n\t\t};\n\t});',
      '...model.maxTokens === void 0 ? {} : { maxTokens: model.maxTokens },\n\t\t\t...model.input === void 0 ? {} : { input: [...model.input] }\n\t\t};\n\t});',
    ],
  ],
};

const piaiMaxTokensPatch = {
  marker: 'PI_AI_MAX_TOKENS_DOMAINS',
  edits: [
    [
      'const useMaxTokens = baseUrl.includes("chutes.ai") ||',
      'const useMaxTokens = baseUrl.includes("chutes.ai") || (process.env.PI_AI_MAX_TOKENS_DOMAINS ?? "").split(",").some((d) => d.length > 0 && baseUrl.includes(d)) ||',
    ],
  ],
};

// Custom gateways must not be treated as vanilla-OpenAI endpoints: the
// detected compat flips supportsDeveloperRole on, and corporate gateways
// reject the `developer` message role. Marking them non-standard keeps
// system-role messages and disables store-param passthrough (both safe).
const piaiNonStandardPatch = {
  marker: 'PI_AI_MAX_TOKENS_DOMAINS ?? "")\n    .split(",")\n    .some',
  edits: [
    [
      'const isNonStandard = isNvidia ||',
      'const isCustomGateway = (process.env.PI_AI_MAX_TOKENS_DOMAINS ?? "")\n    .split(",")\n    .some((d) => d.length > 0 && baseUrl.includes(d));\n    const isNonStandard = isCustomGateway || isNvidia ||',
    ],
  ],
};

// C. dsh-web-search-deepseek — register an additional AnySearch REST search
//    provider (`POST {baseURL}/search`) next to the Anthropic-Messages
//    DeepSeek provider, so the built-in web_search tool can run against any
//    AnySearch-compatible gateway without a local protocol bridge. The
//    provider is only `available()` when the section's baseURL host matches
//    `anysearch`, which keeps DeepSeek (and bridged) endpoints unambiguous.
const anysearchPatch = {
  marker: 'AnySearchRestProvider',
  edits: [
    [
      '//#endregion\n//#region lib/types/index.js',
      `// AnySearch REST provider — added by dshx vision fork patch C
function resolveAnySearchOptions(ctx, config) {
	const options = resolveOptions(ctx, config);
	return { ...options, baseURL: String(options.baseURL).replace(/\\/+$/u, "") };
}
/** Search AnySearch's native REST endpoint: POST {baseURL}/search, Bearer key. */
var AnySearchRestProvider = class {
	id = "anysearch";
	constructor(resolveOptions2) {
		this.resolveOptions = resolveOptions2;
	}
	available() {
		const options = this.resolveOptions();
		if (!((options.apiKey?.length ?? 0) > 0 || options.resolveApiKey !== void 0) || !URL.canParse(options.baseURL)) return false;
		return /anysearch/i.test(new URL(options.baseURL).hostname);
	}
	async search(request, signal) {
		const options = this.resolveOptions();
		const apiKey = await this.apiKey(options, signal);
		throwIfSearchAborted(signal);
		const endpoint = options.baseURL.replace(/\\/$/u, "") + "/search";
		const body = { query: request.query };
		options.recordRequest?.({ endpoint, body });
		throwIfSearchAborted(signal);
		let response;
		try {
			response = await fetch(endpoint, {
				method: "POST",
				redirect: "error",
				headers: {
					"authorization": "Bearer " + apiKey,
					"x-api-key": apiKey,
					"content-type": "application/json",
					"accept": "application/json",
					"user-agent": USER_AGENT
				},
				body: JSON.stringify(body),
				...signal !== void 0 ? { signal } : {}
			});
		} catch (error) {
			if (signal?.aborted === true || isAbortError(error)) throw searchAborted(signal, error);
			throw new WebError("AnySearch search request failed: " + String(error), "WEB_PROVIDER_ERROR", { cause: error });
		}
		if (!response.ok) {
			let message = "AnySearch API error (HTTP " + response.status + ")";
			try {
				const parsed = await response.json();
				const detail = typeof parsed.error === "string" ? parsed.error : parsed.error?.message ?? parsed.message;
				if (detail !== void 0 && detail.length > 0) message = detail;
			} catch {}
			throw new WebError(message, "WEB_PROVIDER_ERROR");
		}
		try {
			const parsed = await response.json();
			const results = parsed?.data?.results;
			if (!Array.isArray(results)) throw new Error("no data.results array in AnySearch response");
			const sources = [];
			const seen = new Set();
			for (const item of results) {
				if (!item || typeof item.url !== "string" || item.url.length === 0 || seen.has(item.url)) continue;
				seen.add(item.url);
				const source = { url: item.url };
				if (item.title != null && item.title.length > 0) source.title = item.title;
				if (item.snippet != null && item.snippet.length > 0) source.snippet = item.snippet;
				if (item.page_age != null && item.page_age.length > 0) source.publishedAt = item.page_age;
				sources.push(source);
			}
			return { sources, truncated: false };
		} catch (error) {
			if (signal?.aborted === true || isAbortError(error)) throw searchAborted(signal, error);
			if (error instanceof WebError) throw error;
			throw new WebError("AnySearch returned an unprocessable response body: " + String(error), "WEB_PROVIDER_ERROR", { cause: error });
		}
	}
	async apiKey(options, signal) {
		throwIfSearchAborted(signal);
		if (options.apiKey !== void 0 && options.apiKey.length > 0) return options.apiKey;
		let resolved;
		try {
			resolved = await abortable(options.resolveApiKey?.() ?? Promise.resolve(void 0), signal);
		} catch (error) {
			if (signal?.aborted === true || isAbortError(error)) throw searchAborted(signal, error);
			throw new WebError("AnySearch search credential resolution failed: " + String(error), "WEB_PROVIDER_ERROR", { cause: error });
		}
		if (resolved !== void 0 && resolved.length > 0) return resolved;
		throw new WebError("AnySearch search has no API key for \\"" + (options.apiKeyEnv ?? "ANYSEARCH_API_KEY") + "\\"; store it through the credentials service, export it in the launching environment, or set a literal \\"apiKey\\" in the web-search-deepseek config", "WEB_PROVIDER_CREDENTIAL_MISSING");
	}
};
//#endregion
//#region lib/types/index.js`,
    ],
    [
      'registerSearchProvider(new DeepSeekSearchProvider(() => resolveOptions(ctx, current())));',
      'registerSearchProvider(new DeepSeekSearchProvider(() => resolveOptions(ctx, current())));\n\tctx.web.registerSearchProvider(new AnySearchRestProvider(() => resolveAnySearchOptions(ctx, current())));',
    ],
    [
      'DeepSeekSearchProvider, WEB_SEARCH_DEEPSEEK_SETTINGS_NAMESPACE',
      'DeepSeekSearchProvider, AnySearchRestProvider, WEB_SEARCH_DEEPSEEK_SETTINGS_NAMESPACE',
    ],
  ],
};

// ─── main ─────────────────────────────────────────────────────────────────────

const mode = process.argv[2] ?? '--apply';
// dsh profiles have their own node_modules copy — patch each one found.
function resolveProfileTargets() {
  const profilesDir = join(homedir(), '.dsh', 'profiles');
  const targets = [];
  try {
    for (const prof of readdirSync(profilesDir)) {
      const base = join(profilesDir, prof, 'node_modules');
      for (const ds of [
        join(base, '@deepseek-ai/dsh-base/node_modules/@deepseek-ai/dsh-llm-deepseek/lib/index.js'),
        join(base, '@deepseek-ai/dsh-llm-deepseek/lib/index.js'),
      ]) {
        if (existsSync(ds)) { targets.push(ds); break; }
      }
      const pi = join(base, '@earendil-works/pi-ai/dist/api/openai-completions.js');
      if (existsSync(pi)) targets.push(pi);
    }
  } catch { /* no profiles — fine */ }
  return targets;
}

const { deepseekTarget, piAiTarget, webSearchTarget } = resolveTargets();
const profileExtras = resolveProfileTargets();

console.log('dshx vision patches —', mode);

if (mode === '--revert') {
  for (const p of [deepseekTarget, piAiTarget, webSearchTarget, ...profileExtras]) {
    if (typeof p === 'string' && existsSync(p + '.bak')) {
      copyFileSync(p + '.bak', p);
      console.log(`  reverted ${p.split('/').slice(-3).join('/')}`);
    }
  }
  process.exit(0);
}

const PATCHES = [
  [() => deepseekTarget, 'llm-deepseek:model.input', deepseekPatch],
  [() => piAiTarget, 'pi-ai:maxTokens-env-whitelist', piaiMaxTokensPatch],
  [() => piAiTarget, 'pi-ai:custom-gateway-nonstandard', piaiNonStandardPatch],
  [() => webSearchTarget, 'web-search:anysearch-rest-provider', anysearchPatch],
];
// Profile copies (~/.dsh/profiles/*/node_modules) need the same treatment.
for (const extra of profileExtras) {
  if (extra.includes('dsh-llm-deepseek')) {
    PATCHES.push([() => extra, `profile:${extra.split('/node_modules')[0].split('/').pop()} llm-deepseek`, deepseekPatch]);
  } else if (extra.includes('pi-ai')) {
    PATCHES.push([() => extra, `profile:${extra.split('/node_modules')[0].split('/').pop()} pi-ai:maxTokens`, piaiMaxTokensPatch]);
    PATCHES.push([() => extra, `profile:${extra.split('/node_modules')[0].split('/').pop()} pi-ai:nonstandard`, piaiNonStandardPatch]);
  }
}

if (mode === '--check') {
  let ok = 0;
  for (const [getPath, label, patch] of PATCHES) {
    const path = getPath();
    if (!path || !existsSync(path)) { console.log(`  [missing] ${label}`); continue; }
    const hit = readFileSync(path, 'utf8').includes(patch.marker);
    console.log(`  [${hit ? 'patched' : 'clean'}] ${label}`);
    if (hit) ok++;
  }
  console.log(`${ok}/${PATCHES.length} patches present`);
  process.exit(0);
}

for (const [getPath, label, patch] of PATCHES) {
  applyOne(getPath(), label, patch);
}
// postinstall must never fail the install — dependency trees change shape
process.exit(0);
