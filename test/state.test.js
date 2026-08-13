import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, test } from 'node:test'

import {
  lastSession,
  rememberSession,
  statePath,
  workspaceKey,
} from '../lib/state.js'

async function temporaryDirectory(t) {
  const directory = await mkdtemp(join(tmpdir(), 'dshx-state-test-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  return directory
}

describe('state paths', () => {
  test('statePath honors and resolves DSH_HOME', () => {
    const configuredHome = join(tmpdir(), 'parent', '..', 'dsh-home')

    assert.equal(statePath({ DSH_HOME: configuredHome }), join(resolve(configuredHome), 'dshx-state.json'))
  })

  test('workspaceKey resolves existing symlinks to one canonical key', async (t) => {
    const root = await temporaryDirectory(t)
    const target = join(root, 'workspace')
    const link = join(root, 'workspace-link')
    await mkdir(target)
    await symlink(target, link, process.platform === 'win32' ? 'junction' : undefined)

    assert.equal(workspaceKey(link), realpathSync.native(target))
    assert.equal(workspaceKey(target), realpathSync.native(target))
  })

  test('workspaceKey resolves a missing path lexically', async (t) => {
    const root = await temporaryDirectory(t)
    const missing = join(root, 'missing', '..', 'future-workspace')

    assert.equal(workspaceKey(missing), resolve(missing))
  })
})

describe('lastSession and rememberSession', () => {
  test('returns undefined for a missing, corrupt, or unsupported state file', async (t) => {
    const root = await temporaryDirectory(t)
    const path = join(root, 'state', 'dshx-state.json')
    const cwd = join(root, 'workspace')

    assert.equal(await lastSession(cwd, path), undefined)

    await mkdir(join(root, 'state'))
    await writeFile(path, '{ not valid JSON')
    assert.equal(await lastSession(cwd, path), undefined)

    await writeFile(path, JSON.stringify({ version: 2, workspaces: { [workspaceKey(cwd)]: { sessionId: 'old' } } }))
    assert.equal(await lastSession(cwd, path), undefined)
  })

  test('treats a null workspaces index as invalid state', async (t) => {
    const root = await temporaryDirectory(t)
    const path = join(root, 'dshx-state.json')
    const cwd = join(root, 'workspace')
    await writeFile(path, JSON.stringify({ version: 1, workspaces: null }))

    assert.equal(await lastSession(cwd, path), undefined)
  })

  test('creates the state directory and remembers sessions for multiple workspaces', async (t) => {
    const root = await temporaryDirectory(t)
    const path = join(root, 'nested', 'state', 'dshx-state.json')
    const firstWorkspace = join(root, 'first-workspace')
    const secondWorkspace = join(root, 'second-workspace')

    await rememberSession(firstWorkspace, 'session-first', path)
    await rememberSession(secondWorkspace, 'session-second', path)

    assert.equal(await lastSession(firstWorkspace, path), 'session-first')
    assert.equal(await lastSession(secondWorkspace, path), 'session-second')

    const state = JSON.parse(await readFile(path, 'utf8'))
    assert.equal(state.version, 1)
    assert.equal(state.workspaces[workspaceKey(firstWorkspace)].sessionId, 'session-first')
    assert.equal(state.workspaces[workspaceKey(secondWorkspace)].sessionId, 'session-second')
    assert.equal(Number.isNaN(Date.parse(state.workspaces[workspaceKey(firstWorkspace)].updatedAt)), false)

    const neighboringFiles = await readdir(join(root, 'nested', 'state'))
    assert.deepEqual(neighboringFiles, ['dshx-state.json'])
  })

  test('updates one workspace without discarding the others', async (t) => {
    const root = await temporaryDirectory(t)
    const path = join(root, 'dshx-state.json')
    const firstWorkspace = join(root, 'first-workspace')
    const secondWorkspace = join(root, 'second-workspace')

    await rememberSession(firstWorkspace, 'session-first', path)
    await rememberSession(secondWorkspace, 'session-second', path)
    await rememberSession(firstWorkspace, 'session-replaced', path)

    assert.equal(await lastSession(firstWorkspace, path), 'session-replaced')
    assert.equal(await lastSession(secondWorkspace, path), 'session-second')
  })

  test('uses the same persisted session for a symlink and its real workspace', async (t) => {
    const root = await temporaryDirectory(t)
    const path = join(root, 'dshx-state.json')
    const workspace = join(root, 'workspace')
    const alias = join(root, 'workspace-alias')
    await mkdir(workspace)
    await symlink(workspace, alias, process.platform === 'win32' ? 'junction' : undefined)

    await rememberSession(alias, 'session-canonical', path)

    assert.equal(await lastSession(workspace, path), 'session-canonical')
  })

  test('recovers from a corrupt state file when remembering a session', async (t) => {
    const root = await temporaryDirectory(t)
    const path = join(root, 'dshx-state.json')
    const cwd = join(root, 'workspace')
    await writeFile(path, 'truncated JSON')

    await rememberSession(cwd, 'session-recovered', path)

    assert.equal(await lastSession(cwd, path), 'session-recovered')
  })

  test('recovers from an array used as the workspaces index', async (t) => {
    const root = await temporaryDirectory(t)
    const path = join(root, 'dshx-state.json')
    const cwd = join(root, 'workspace')
    await writeFile(path, JSON.stringify({ version: 1, workspaces: [] }))

    assert.equal(await lastSession(cwd, path), undefined)
    await rememberSession(cwd, 'session-recovered', path)

    assert.equal(await lastSession(cwd, path), 'session-recovered')
    const state = JSON.parse(await readFile(path, 'utf8'))
    assert.equal(Array.isArray(state.workspaces), false)
  })

  test('ignores entries whose sessionId is not a string', async (t) => {
    const root = await temporaryDirectory(t)
    const path = join(root, 'dshx-state.json')
    const cwd = join(root, 'workspace')
    await writeFile(path, JSON.stringify({
      version: 1,
      workspaces: {
        [workspaceKey(cwd)]: { sessionId: 123 },
      },
    }))

    assert.equal(await lastSession(cwd, path), undefined)
  })
})
