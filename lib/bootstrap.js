import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { homedir, tmpdir } from 'node:os'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

const require = createRequire(import.meta.url)
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const packageJson = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'))
const PINNED_PNPM_VERSION = '11.7.0'

export const PACKAGE_NAME = packageJson.name
export const PACKAGE_VERSION = packageJson.version
export const PROFILE_NAME = 'dshx'
const ARTIFACT_FILE = `${PACKAGE_NAME}-${PACKAGE_VERSION}.tgz`
const ALLOWED_BUILD_PACKAGES = [
  '@deepseek-ai/dsh-subprocess-local',
  '@google/genai',
  'koffi',
  'node-pty',
  'protobufjs',
]

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
}

export function dshHome(env = process.env) {
  return resolve(env.DSH_HOME ?? join(homedir(), '.dsh'))
}

export function resolveDshBin() {
  const manifestPath = require.resolve('@deepseek-ai/dsh/package.json')
  const manifest = readJson(manifestPath)
  const relativeBin = typeof manifest?.bin === 'string' ? manifest.bin : manifest?.bin?.dsh
  if (typeof relativeBin !== 'string') throw new Error('@deepseek-ai/dsh 没有可执行入口')
  return resolve(dirname(manifestPath), relativeBin)
}

export function bundleIsCurrent(home = dshHome()) {
  const profileManifest = join(home, 'profiles', PROFILE_NAME, 'package.json')
  const manifest = readJson(profileManifest)
  const bundles = manifest?.dsh?.profile?.bundles
  if (!Array.isArray(bundles) || !bundles.includes(PACKAGE_NAME)) return false
  const dependency = manifest?.dependencies?.[PACKAGE_NAME]
  if (typeof dependency !== 'string' || !dependency.endsWith(ARTIFACT_FILE)) return false

  try {
    const profileRequire = createRequire(profileManifest)
    const installed = readJson(profileRequire.resolve(`${PACKAGE_NAME}/package.json`))
    return installed?.version === PACKAGE_VERSION
  } catch {
    return false
  }
}

function ensureArtifact(home) {
  const artifactDirectory = join(home, 'artifacts')
  const artifactPath = join(artifactDirectory, ARTIFACT_FILE)
  if (existsSync(artifactPath)) return artifactPath
  mkdirSync(artifactDirectory, { recursive: true, mode: 0o700 })
  const packed = spawnSync(
    'npm',
    ['pack', packageRoot, '--pack-destination', artifactDirectory, '--json'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], env: process.env },
  )
  if (packed.error !== undefined) throw packed.error
  if (packed.status !== 0 || !existsSync(artifactPath)) {
    throw new Error(`无法创建 dshx profile 安装归档（npm 退出码 ${packed.status ?? 'unknown'}）`)
  }
  return artifactPath
}

function pinnedPnpmEnvironment() {
  const check = spawnSync('corepack', [`pnpm@${PINNED_PNPM_VERSION}`, '--version'], { encoding: 'utf8' })
  if (check.status !== 0 || check.stdout.trim() !== PINNED_PNPM_VERSION) {
    throw new Error(`初始化 dshx 需要 Corepack 与 pnpm ${PINNED_PNPM_VERSION}。请先运行：corepack enable`)
  }

  const shimDirectory = mkdtempSync(join(tmpdir(), 'dshx-pnpm-'))
  if (process.platform === 'win32') {
    writeFileSync(
      join(shimDirectory, 'pnpm.cmd'),
      `@echo off\r\ncorepack pnpm@${PINNED_PNPM_VERSION} %*\r\n`,
    )
  } else {
    const shimPath = join(shimDirectory, 'pnpm')
    writeFileSync(shimPath, `#!/bin/sh\nexec corepack pnpm@${PINNED_PNPM_VERSION} "$@"\n`, { mode: 0o755 })
    chmodSync(shimPath, 0o755)
  }
  return {
    env: { ...process.env, PATH: `${shimDirectory}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH ?? ''}` },
    dispose: () => { rmSync(shimDirectory, { recursive: true, force: true }) },
  }
}

export function ensureBundle({ home = dshHome(), dshBin = resolveDshBin() } = {}) {
  if (process.env.DSHX_SKIP_BOOTSTRAP === '1' || bundleIsCurrent(home)) return
  process.stderr.write('正在同步 dshx 终端配置…\n')
  const artifactPath = ensureArtifact(home)
  const pinned = pinnedPnpmEnvironment()
  let result
  try {
    result = spawnSync(
      process.execPath,
      [
        dshBin,
        'plugin',
        '--profile',
        PROFILE_NAME,
        'add',
        `file:${artifactPath}`,
        ...ALLOWED_BUILD_PACKAGES.map(packageName => `--allow-build=${packageName}`),
      ],
      { stdio: 'inherit', env: pinned.env },
    )
  } finally {
    pinned.dispose()
  }
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) throw new Error(`dshx 配置初始化失败（退出码 ${result.status ?? 'unknown'}）`)
  if (!existsSync(join(home, 'profiles', PROFILE_NAME, 'package.json'))) {
    throw new Error('dshx 配置初始化后未找到 profile')
  }
}

export async function launchHarness(dshBin = resolveDshBin()) {
  process.argv = [process.execPath, dshBin, '--profile', PROFILE_NAME]
  await import(`${pathToFileURL(dshBin).href}?dshx=${Date.now()}`)
}
