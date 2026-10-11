/**
 * CLI face pins: the updater invokes the engine as a CLI over explicit
 * directories. Hash → plan → apply round-trips through `main`; an aborting
 * plan reports exit code 3 to the caller.
 */

import { readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { main, type CliIo } from '../src/cli.ts'
import { makeUpdateFixture, readStaged } from './fixture.ts'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

interface Captured {
  io: CliIo
  stdout: string[]
  stderr: string[]
}

function capture(): Captured {
  const stdout: string[] = []
  const stderr: string[] = []
  return { io: { stdout: text => stdout.push(text), stderr: text => stderr.push(text) }, stdout, stderr }
}

describe('update-engine CLI', () => {
  it('round-trips hash → plan → apply over fixture trees', async () => {
    const f = await makeUpdateFixture(
      'cli',
      { 'a.txt': 'v1\n', 'keep.txt': 'keep\n' },
      { 'a.txt': 'v2\n', 'keep.txt': 'keep\n', 'new.txt': 'new\n' },
      async (localRoot) => {
        await writeFile(join(localRoot, 'user.txt'), 'user\n')
      },
    )
    roots.push(f.root)
    const baseManifest = join(f.root, 'base.json')
    const releaseManifest = join(f.root, 'release.json')
    const planPath = join(f.root, 'plan.json')
    expect(await main(['hash', '--root', f.baseRoot, '--out', baseManifest], capture().io)).toBe(0)
    expect(await main(['hash', '--root', f.releaseRoot, '--out', releaseManifest], capture().io)).toBe(0)

    const planCap = capture()
    const planExit = await main([
      'plan',
      '--previous', baseManifest,
      '--next', releaseManifest,
      '--local', f.localRoot,
      '--base', f.baseRoot,
      '--release', f.releaseRoot,
      '--to-version', '2.0.0',
      '--from-version', '1.0.0',
      '--out', planPath,
    ], planCap.io)
    expect(planExit).toBe(0)
    expect(planCap.stdout.join('\n')).toContain('switch proceed')
    const planJson = JSON.parse(await readFile(planPath, 'utf8')) as { fingerprint: string }
    expect(planJson.fingerprint).toMatch(/^[0-9a-f]{64}$/u)

    const applyCap = capture()
    const applyExit = await main([
      'apply',
      '--plan', planPath,
      '--local', f.localRoot,
      '--base', f.baseRoot,
      '--release', f.releaseRoot,
      '--staging', f.stagingRoot,
      '--journal', f.journalPath,
      '--timestamp', '2026-01-01T00:00:00.000Z',
    ], applyCap.io)
    expect(applyExit).toBe(0)
    expect(applyCap.stdout.join('\n')).toContain('verification: ok')
    expect(await readStaged(f.stagingRoot, 'a.txt')).toBe('v2\n')
    expect(await readStaged(f.stagingRoot, 'user.txt')).toBe('user\n')

    // A second apply is a verified no-op.
    expect(await main([
      'apply',
      '--plan', planPath,
      '--local', f.localRoot,
      '--base', f.baseRoot,
      '--release', f.releaseRoot,
      '--staging', f.stagingRoot,
      '--journal', f.journalPath,
      '--timestamp', '2026-01-01T00:00:00.000Z',
    ], capture().io)).toBe(0)
  })

  it('exits 3 for an aborting plan and for its apply', async () => {
    const f = await makeUpdateFixture(
      'cli-abort',
      { 'core/runtime.js': 'export const a = 1\nb\nc\nd\n' },
      { 'core/runtime.js': 'export const a = 2\nb\nc\nd\n' },
      async (localRoot) => {
        await writeFile(join(localRoot, 'core/runtime.js'), 'export const a = 3\nb\nc\nd\n')
      },
    )
    roots.push(f.root)
    const baseManifest = join(f.root, 'base.json')
    const releaseManifest = join(f.root, 'release.json')
    const planPath = join(f.root, 'plan.json')
    await main(['hash', '--root', f.baseRoot, '--out', baseManifest], capture().io)
    await main(['hash', '--root', f.releaseRoot, '--out', releaseManifest], capture().io)
    const planExit = await main([
      'plan', '--previous', baseManifest, '--next', releaseManifest, '--local', f.localRoot,
      '--base', f.baseRoot, '--release', f.releaseRoot, '--to-version', '2.0.0', '--out', planPath,
    ], capture().io)
    expect(planExit).toBe(3)
    const applyExit = await main([
      'apply', '--plan', planPath, '--local', f.localRoot, '--base', f.baseRoot,
      '--release', f.releaseRoot, '--staging', f.stagingRoot, '--journal', f.journalPath,
    ], capture().io)
    expect(applyExit).toBe(3)
  })

  it('fails loudly on a missing required flag', async () => {
    const cap = capture()
    expect(await main(['hash', '--root', '/tmp'], cap.io)).toBe(1)
    expect(cap.stderr.join('\n')).toContain('missing required --out')
  })
})
