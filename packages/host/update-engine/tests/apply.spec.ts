/**
 * Apply-mechanics pins (§2.3): hardlink seeding with copy-on-write, the
 * live-inode gate, journal binding and rollback detection, deletions last,
 * resumable interruption, the pre-update backup latch, and abort-sidecar
 * idempotency.
 */

import { lstat, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { applyPlan, discardStaging } from '../src/apply.ts'
import { readJournal, writeJournal } from '../src/journal.ts'
import { buildPlan } from '../src/plan.ts'
import { makeUpdateFixture, readStaged, runUpdate, writeTreeFile, type UpdateFixture } from './fixture.ts'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function fixture(
  label: string,
  base: Record<string, string>,
  release: Record<string, string>,
  edit?: (localRoot: string) => Promise<void>,
): Promise<UpdateFixture> {
  const built = await makeUpdateFixture(label, base, release, edit)
  roots.push(built.root)
  return built
}

async function build(f: UpdateFixture) {
  return buildPlan({
    fromVersion: '1.0.0',
    toVersion: '2.0.0',
    previous: f.previous,
    next: f.next,
    local: f.local,
    localRoot: f.localRoot,
    baseRoot: f.baseRoot,
    releaseRoot: f.releaseRoot,
  })
}

function applyOptions(f: UpdateFixture) {
  return {
    localRoot: f.localRoot,
    baseRoot: f.baseRoot,
    releaseRoot: f.releaseRoot,
    stagingRoot: f.stagingRoot,
    journalPath: f.journalPath,
    timestamp: '2026-01-01T00:00:00.000Z',
  } as const
}

describe('staged apply mechanics', () => {
  it('seeds kept files by hardlink and never writes through the live inode', async () => {
    const f = await fixture('hardlink', { 'keep.txt': 'keep\n', 'replace.txt': 'v1\n' }, { 'keep.txt': 'keep\n', 'replace.txt': 'v2\n' })
    const { result, staging } = await runUpdate(f)
    expect(result.status).toBe('applied')
    expect(result.liveTreeIntact).toBe(true)

    const liveKeep = await lstat(join(f.localRoot, 'keep.txt'))
    const stagedKeep = await lstat(join(f.stagingRoot, 'keep.txt'))
    expect(stagedKeep.ino).toBe(liveKeep.ino)
    expect(stagedKeep.nlink).toBeGreaterThanOrEqual(2)

    const liveReplace = await lstat(join(f.localRoot, 'replace.txt'))
    const stagedReplace = await lstat(join(f.stagingRoot, 'replace.txt'))
    expect(stagedReplace.ino).not.toBe(liveReplace.ino)
    expect(await readFile(join(f.localRoot, 'replace.txt'), 'utf8')).toBe('v1\n')
    expect(await readStaged(f.stagingRoot, 'replace.txt')).toBe('v2\n')

    // Verification saw the shipped outcome for the replaced path.
    expect(result.verification?.ok).toBe(true)
    expect(result.verification?.manifestChecked).toBe(2)
    // The journal records the plan fingerprint and completion.
    const journal = await readJournal(f.journalPath)
    expect(journal?.fingerprint).toBe(result.planFingerprint)
    expect(journal?.phase).toBe('complete')
    void staging
  })

  it('emits opt-in progress updates and stays silent without a callback', async () => {
    const f = await fixture(
      'progress',
      { 'a.txt': 'one\n', 'b.txt': 'two\n', 'c.txt': 'three\n', 'd.txt': 'four\n' },
      { 'a.txt': 'one v2\n', 'b.txt': 'two v2\n', 'c.txt': 'three v2\n', 'd.txt': 'four v2\n', 'e.txt': 'new\n' },
    )
    const updates: { phase: string; processed: number; total: number }[] = []
    const { plan, result } = await runUpdate(f, {
      progress: update => updates.push({ phase: update.phase, processed: update.processed, total: update.total }),
      progressEveryActions: 2,
    })
    expect(result.status).toBe('applied')
    expect(updates[0]?.phase).toBe('starting')
    expect(updates.some(update => update.phase === 'verifying')).toBe(true)
    const applying = updates.filter(update => update.phase === 'applying')
    expect(applying.length).toBeGreaterThanOrEqual(2)
    // The final action always reports, so the last tick equals the plan size.
    expect(applying.at(-1)?.processed).toBe(applying.at(-1)?.total)
    expect(applying.at(-1)?.total).toBe(plan.actions.length)
    // Same fixture without the callback: same result, no observable progress.
    const silent = await runUpdate(f, { timestamp: '2030-01-01T00:00:00.000Z' })
    expect(silent.result.status).toBe('noop')
  })

  it('detects a foreign journal and requires rollback before rebuilding', async () => {
    const f = await fixture('foreign-journal', { 'a.txt': 'a\n' }, { 'a.txt': 'b\n' })
    const plan = await build(f)
    await writeJournal(f.journalPath, {
      schema: 1,
      toVersion: '9.9.9',
      fingerprint: 'deadbeef',
      createdAt: '2026-01-01T00:00:00.000Z',
      phase: 'applying',
      completed: [],
      detail: null,
    })
    const result = await applyPlan({ plan, ...applyOptions(f) })
    expect(result.status).toBe('rollback-required')
    await expect(lstat(f.stagingRoot)).rejects.toThrow()

    await discardStaging(f.stagingRoot, f.journalPath)
    await expect(lstat(f.journalPath)).rejects.toThrow()
    const retry = await applyPlan({ plan, ...applyOptions(f) })
    expect(retry.status).toBe('applied')
  })

  it('runs deletions last and resumes an interrupted apply', async () => {
    const f = await fixture('delete-last', { 'a.txt': 'a\n', 'gone.txt': 'gone\n' }, { 'a.txt': 'a2\n' })
    const plan = await build(f)
    const last = plan.actions[plan.actions.length - 1]
    expect(last?.kind).toBe('delete')

    const interrupted = await applyPlan({ plan, ...applyOptions(f), stopAfterActions: plan.actions.length - 1 })
    expect(interrupted.status).toBe('interrupted')
    expect(await readStaged(f.stagingRoot, 'gone.txt')).toBe('gone\n')
    expect((await readFile(join(f.localRoot, 'gone.txt'), 'utf8'))).toBe('gone\n')

    const resumed = await applyPlan({ plan, ...applyOptions(f) })
    expect(resumed.status).toBe('applied')
    expect(resumed.resumed).toBe(true)
    await expect(lstat(join(f.stagingRoot, 'gone.txt'))).rejects.toThrow()
    expect(resultDeleteCount(resumed)).toBe(1)
  })

  it('backs up modified and untracked files with baseline hashes before writing', async () => {
    const f = await fixture(
      'backup',
      { 'mod.txt': 'v1\n', 'stable.txt': 'stable\n' },
      { 'mod.txt': 'v2\n', 'stable.txt': 'stable\n' },
      async (localRoot) => {
        await writeFile(join(localRoot, 'mod.txt'), 'user-mod\n')
        await writeTreeFile(localRoot, 'user.txt', 'user-data\n')
      },
    )
    const plan = await build(f)
    const result = await applyPlan({ plan, ...applyOptions(f), backupDir: f.backupDir })
    expect(result.status).toBe('applied')
    expect(result.backupDir).toBe(f.backupDir)
    expect(await readFile(join(f.backupDir, 'mod.txt'), 'utf8')).toBe('user-mod\n')
    expect(await readFile(join(f.backupDir, 'user.txt'), 'utf8')).toBe('user-data\n')
    const baseline = JSON.parse(await readFile(join(f.backupDir, 'baseline.json'), 'utf8')) as Record<string, { baselineSha256: string; localSha256: string; reason: string }>
    expect(baseline['mod.txt']?.reason).toBe('modified')
    expect(baseline['mod.txt']?.baselineSha256).toBe(f.previous['mod.txt']?.sha256)
    expect(baseline['mod.txt']?.localSha256).toBe(f.local['mod.txt']?.sha256)
    expect(baseline['user.txt']?.reason).toBe('untracked')
    expect(baseline['stable.txt']).toBeUndefined()

    const live = await lstat(join(f.localRoot, 'mod.txt'))
    const backup = await lstat(join(f.backupDir, 'mod.txt'))
    expect(backup.ino).not.toBe(live.ino)
  })

  it('writes abort inspection sidecars once and keeps them on repeated aborts', async () => {
    const f = await fixture(
      'abort-sidecar',
      { 'core/runtime.js': 'export const a = 1\nb\nc\nd\n' },
      { 'core/runtime.js': 'export const a = 2\nb\nc\nd\n' },
      async (localRoot) => {
        await writeFile(join(localRoot, 'core/runtime.js'), 'export const a = 3\nb\nc\nd\n')
      },
    )
    const plan = await build(f)
    const first = await applyPlan({ plan, ...applyOptions(f) })
    expect(first.status).toBe('aborted')
    const sidecarPath = join(f.localRoot, 'core/runtime.js.new-2.0.0')

    const second = await applyPlan({ plan, ...applyOptions(f) })
    expect(second.status).toBe('aborted')
    await expect(lstat(`${sidecarPath}.1`)).rejects.toThrow()
    expect(await readFile(sidecarPath, 'utf8')).toContain('<<<<<<< local')
  })

  it('repairs a torn staging write and clears the stale temp sibling on resume', async () => {
    const f = await fixture('stale-temp', { 'a.txt': 'a\n' }, { 'a.txt': 'b\n' })
    const plan = await build(f)
    const first = await applyPlan({ plan, ...applyOptions(f), stopAfterActions: 1 })
    expect(first.status).toBe('interrupted')
    // Simulate a crash mid-write: a truncated target and an abandoned temp file.
    await writeFile(join(f.stagingRoot, 'a.txt'), 'torn')
    await writeFile(join(f.stagingRoot, 'a.txt.dsh-update.tmp'), 'torn')
    const resumed = await applyPlan({ plan, ...applyOptions(f) })
    expect(resumed.status).toBe('applied')
    expect(await readStaged(f.stagingRoot, 'a.txt')).toBe('b\n')
    await expect(lstat(join(f.stagingRoot, 'a.txt.dsh-update.tmp'))).rejects.toThrow()
  })
})

function resultDeleteCount(result: { results: { kind: string }[] }): number {
  return result.results.filter(item => item.kind === 'delete').length
}
