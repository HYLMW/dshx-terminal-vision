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
    if (deepseek || existsSync(piai)) {
      return {
        deepseekTarget: deepseek ?? null,
        piAiTarget: existsSync(piai) ? piai : null,
      };
    }
  }
  return { deepseekTarget: null, piAiTarget: null };
}

// ─── patch helpers ────────────────────────────────────────────────────────────

function applyOne(targetPath, label, transforms) {
  if (!targetPath || !existsSync(targetPath)) {
    console.log(`  ✗ [${label}] module not installed (skipping)`);
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
      console.log(`  ✗ [${label}] anchor not found: ${find.slice(0, 60)}…`);
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

const { deepseekTarget, piAiTarget } = resolveTargets();
const profileExtras = resolveProfileTargets();

console.log('dshx vision patches —', mode);

if (mode === '--revert') {
  for (const p of [deepseekTarget, piAiTarget, ...profileExtras]) {
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
