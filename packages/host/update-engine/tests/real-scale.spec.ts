/**
 * Real-scale journal/apply gate (stop-the-line regression): a ~100K-action
 * plan must apply in bounded wall time with O(n) journal volume. The v1
 * journal reserialized the whole plan plus a growing `completed` list after
 * EVERY action — O(n²) writes (tens of GB, hours at 107K actions). The v2
 * split journal writes the plan once, appends bounded progress batches, and
 * rewrites only a tiny head.
 *
 * The tree is built from 100 small sources hardlinked 1000× (100K entries),
 * which is what makes the fixture cheap to create while keeping the plan real.
 */

import { existsSync } from 'node:fs'
import { link, lstat, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { applyPlan, discardStaging } from '../src/apply.ts'
import { journalPlanPath, journalProgressPath, readJournalState } from '../src/journal.ts'
import { scanTree } from '../src/manifest.ts'
import { buildPlan } from '../src/plan.ts'
import type { Manifest } from '../src/types.ts'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

interface ScaleFixture {
  root: string
  localRoot: string
  releaseRoot: string
  baseRoot: string
  stagingRoot: string
  journalPath: string
  previous: Manifest
  next: Manifest
  local: Manifest
  actions: number
}

/** 100K hardlinked entries + 25 replacements + 5 additions. */
async function scaleFixture(): Promise<ScaleFixture> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-real-scale-'))
  roots.push(root)
  const localRoot = join(root, 'local')
  const src = join(localRoot, 'src')
  await mkdir(src, { recursive: true })
  const sources: string[] = []
  for (let index = 0; index < 100; index += 1) {
    const file = join(src, `f${index}`)
    await writeFile(file, `source ${index}\n${'x'.repeat(64)}\n`)
    sources.push(file)
  }
  for (let dir = 0; dir < 100; dir += 1) {
    const bulk = join(localRoot, 'bulk', `d${String(dir).padStart(3, '0')}`)
    await mkdir(bulk, { recursive: true })
    for (let index = 0; index < 1000; index += 1) {
      await link(sources[index % 100]!, join(bulk, `f${index}`))
    }
  }

  const releaseRoot = join(root, 'release')
  await mkdir(releaseRoot, { recursive: true })
  const previous = await scanTree(localRoot)
  const local = previous
  const next: Manifest = { ...previous }
  const paths = Object.keys(previous).filter(path => path.endsWith('.txt') || path.includes('/f'))
  // 25 replacements (release changes them, local is pristine -> shipped) and
  // 5 additions; one release scan after all files exist.
  const mutatedPaths: string[] = []
  for (let index = 0; index < 25; index += 1) {
    const path = paths[Math.floor((index + 1) * (paths.length / 30))]!
    if (mutatedPaths.includes(path)) continue
    mutatedPaths.push(path)
    const target = join(releaseRoot, ...path.split('/'))
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, `mutated ${index}\n${'y'.repeat(48)}\n`)
  }
  for (let index = 0; index < 5; index += 1) {
    const path = `added/new-${index}.txt`
    const target = join(releaseRoot, ...path.split('/'))
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, `new file ${index}\n`)
    mutatedPaths.push(path)
  }
  const releaseManifest = await scanTree(releaseRoot)
  for (const path of mutatedPaths) {
    const entry = releaseManifest[path]
    if (entry === undefined) throw new Error(`release scan missed ${path}`)
    next[path] = entry
    // A newly added path brings its parent directories into the release
    // manifest; the plan must cover them or verification flags them as
    // unexpected-untracked.
    const segments = path.split('/')
    for (let depth = 1; depth < segments.length; depth += 1) {
      const parent = segments.slice(0, depth).join('/')
      if (next[parent] === undefined && releaseManifest[parent] !== undefined) next[parent] = releaseManifest[parent]
    }
  }
  const baseRoot = join(root, 'base')
  await mkdir(baseRoot, { recursive: true })
  return {
    root,
    localRoot,
    releaseRoot,
    baseRoot,
    stagingRoot: join(root, 'staging'),
    journalPath: join(root, 'staging.journal.json'),
    previous,
    next,
    local,
    actions: 0,
  }
}

async function planFor(fixture: ScaleFixture) {
  return buildPlan({
    fromVersion: '2.63',
    toVersion: '2.64',
    previous: fixture.previous,
    next: fixture.next,
    local: fixture.local,
    localRoot: fixture.localRoot,
    baseRoot: fixture.baseRoot,
    releaseRoot: fixture.releaseRoot,
    tombstones: [],
    pins: [],
  })
}

describe('real-scale apply (100K actions)', () => {
  it('applies within budget with bounded journal batches and O(n) write volume', async () => {
    const fixture = await scaleFixture()
    const plan = await planFor(fixture)
    expect(plan.actions.length).toBeGreaterThan(100_000)
    const mutated = plan.actions.filter(action => action.kind !== 'skip').length
    expect(mutated).toBeLessThan(50)

    const started = Date.now()
    const result = await applyPlan({
      plan,
      localRoot: fixture.localRoot,
      baseRoot: fixture.baseRoot,
      releaseRoot: fixture.releaseRoot,
      stagingRoot: fixture.stagingRoot,
      journalPath: fixture.journalPath,
      localManifest: fixture.local,
      localScanCompletedAt: Date.now(),
      journalEveryActions: 2000,
      journalEveryMs: 5000,
    })
    const wallMs = Date.now() - started
    if (result.status !== 'applied') {
      console.log(`[real-scale] detail=${result.detail} mismatches=${JSON.stringify(result.verification?.mismatches.slice(0, 3))}`)
    }
    expect(result.status).toBe('applied')
    expect(result.verification?.ok).toBe(true)
    expect(result.verification?.mismatches).toEqual([])
    // The v1 regression would take tens of minutes here; the budget is
    // deliberately generous for CI but catches any per-action serialization.
    expect(wallMs).toBeLessThan(120_000)
    // eslint-disable-next-line no-console
    console.log(`[real-scale] actions=${plan.actions.length} mutated=${mutated} wall=${wallMs}ms batches=${(await readJournalState(fixture.journalPath))?.head.batches}`)

    // Journal discipline: one immutable plan write, bounded batches, tiny head.
    const state = await readJournalState(fixture.journalPath)
    expect(state?.head.phase).toBe('complete')
    expect(state?.head.batches).toBeLessThanOrEqual(Math.ceil(plan.actions.length / 2000) + 2)
    expect(state?.completed.length).toBe(plan.actions.length)
    const headBytes = (await stat(fixture.journalPath)).size
    const planBytes = (await stat(journalPlanPath(fixture.journalPath))).size
    const progressBytes = (await stat(journalProgressPath(fixture.journalPath))).size
    expect(headBytes).toBeLessThan(2048)
    // O(n) volume: the progress log is path bytes, never plan × actions.
    expect(progressBytes).toBeLessThan(planBytes * 2 + 2 * 1024 * 1024)
    const progressLines = (await readFile(journalProgressPath(fixture.journalPath), 'utf8')).trim().split('\n')
    expect(progressLines.length).toBe(state?.head.batches)

    // The new tree's scan index was seeded before any rename.
    expect(existsSync(join(fixture.stagingRoot, '.dsh-scan-index'))).toBe(true)
  }, 240_000)

  it('resumes a mid-apply interruption to the same end state at real scale', async () => {
    const fixture = await scaleFixture()
    const plan = await planFor(fixture)
    const options = {
      plan,
      localRoot: fixture.localRoot,
      baseRoot: fixture.baseRoot,
      releaseRoot: fixture.releaseRoot,
      stagingRoot: fixture.stagingRoot,
      journalPath: fixture.journalPath,
      localManifest: fixture.local,
      localScanCompletedAt: Date.now(),
      journalEveryActions: 2000,
    }
    const first = await applyPlan({ ...options, stopAfterActions: 500 })
    expect(first.status).toBe('interrupted')
    expect(existsSync(fixture.stagingRoot)).toBe(true)
    const midState = await readJournalState(fixture.journalPath)
    expect(midState?.head.phase).toBe('applying')
    expect(midState?.head.batches).toBeLessThanOrEqual(1)

    const second = await applyPlan({ ...options, localScanCompletedAt: Date.now() })
    expect(second.status).toBe('applied')
    expect(second.resumed).toBe(true)
    expect(second.verification?.ok).toBe(true)
    expect(second.verification?.mismatches).toEqual([])

    // A foreign plan still requires an explicit discard (v2 binding intact).
    await discardStaging(fixture.stagingRoot, fixture.journalPath)
    await expect(lstat(fixture.journalPath)).rejects.toThrow()
  }, 240_000)
})
