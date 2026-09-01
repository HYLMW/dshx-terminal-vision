#!/usr/bin/env node

import { chdir } from 'node:process'
import { applyCliEnvironment, CliUsageError, HELP, parseCli } from '../lib/cli-options.js'
import { applyGatewayEnv } from '../lib/gateway-env.js'
import { ensureBundle, launchHarness, PACKAGE_VERSION, resolveDshBin } from '../lib/bootstrap.js'

async function main() {
  const options = parseCli(process.argv.slice(2))
  if (options.help) {
    process.stdout.write(HELP)
    return
  }
  if (options.version) {
    process.stdout.write(`dshx ${PACKAGE_VERSION}\n`)
    return
  }

  if (options.cwd !== undefined) {
    try {
      chdir(options.cwd)
    } catch (error) {
      throw new CliUsageError(`无法进入目录 ${options.cwd}：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  applyCliEnvironment(options)
  applyGatewayEnv()
  const dshBin = resolveDshBin()
  ensureBundle({ dshBin })
  await launchHarness(dshBin)
}

main().catch((error) => {
  const prefix = error instanceof CliUsageError ? '用法错误' : 'dshx'
  process.stderr.write(`${prefix}：${error instanceof Error ? error.message : String(error)}\n`)
  if (error instanceof CliUsageError) process.stderr.write('运行 dshx --help 查看帮助。\n')
  process.exitCode = 1
})
