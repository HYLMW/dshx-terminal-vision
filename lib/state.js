import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'

export function statePath(env = process.env) {
  const home = resolve(env.DSH_HOME ?? join(homedir(), '.dsh'))
  return join(home, 'dshx-state.json')
}

export function workspaceKey(cwd) {
  try {
    return realpathSync.native(cwd)
  } catch {
    return resolve(cwd)
  }
}

async function readState(path) {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8'))
    if (
      parsed?.version === 1
      && parsed.workspaces !== null
      && typeof parsed.workspaces === 'object'
      && !Array.isArray(parsed.workspaces)
    ) return parsed
  } catch {
    // A missing or partially written convenience index must never block Harness.
  }
  return { version: 1, workspaces: {} }
}

export async function lastSession(cwd, path = statePath()) {
  const state = await readState(path)
  const value = state.workspaces[workspaceKey(cwd)]
  return typeof value?.sessionId === 'string' ? value.sessionId : undefined
}

export async function rememberSession(cwd, sessionId, path = statePath()) {
  const state = await readState(path)
  state.workspaces[workspaceKey(cwd)] = {
    sessionId,
    updatedAt: new Date().toISOString(),
  }
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })
  await rename(temporary, path)
}
