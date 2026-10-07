/**
 * Install jobs: a failed step leaves NO route and NO credential; only a fully
 * successful run invokes the finalizer that writes them. Jobs are polled, so
 * the snapshot carries stage/pct/logTail while running.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { HeavyJobManager, visibleJobSnapshot } from '../src/jobs.js'
import { manifestById, resolveHeavyInstall } from '../src/manifests.js'
import { pendingRestartMessage, writeRoute, type HeavyDeps, type SettingsSeam } from '../src/planner.js'

const scratch: string[] = []
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function scratchDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'heavy-job-'))
  scratch.push(dir)
  return dir
}

/** Wait for a job to settle (the runner is async). */
async function settled(manager: HeavyJobManager, id: string): Promise<NonNullable<ReturnType<HeavyJobManager['snapshot']>>> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const job = manager.snapshot(id)
    if (job !== undefined && job.state !== 'running') return job
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error('job did not settle')
}

it('a failed install step writes no route and fails the job', async () => {
  const mutations: Array<readonly Record<string, unknown>[]> = []
  const settings: SettingsSeam = {
    describe: () => [{ ns: 'llm-pi-ai', revision: 1, value: { providers: {} } }],
    mutate: async (_ns, ops) => { mutations.push(ops) },
  }
  const deps: HeavyDeps = {
    home: scratchDir(),
    dshHome: join(scratchDir(), '.dsh'),
    settings,
    credentials: { resolve: async () => undefined, set: async () => {}, unset: async () => {} },
    runStep: async step => step.label === 'Start the stack'
      ? { exitCode: 1, output: 'compose exploded' }
      : { exitCode: 0, output: 'ok' },
  }
  const manager = new HeavyJobManager({ dir: join(deps.dshHome, 'cache', 'heavy-jobs'), run: deps.runStep })
  const manifest = manifestById('freellmapi')!
  manager.start(manifest.id, 'install', resolveHeavyInstall(manifest.local, '').steps, async () => {
    await writeRoute(deps, manifest, 'local', [])
  })
  // The failed job must never reach the finalizer.
  const job = await settled(manager, manifest.id)
  expect(job.state).toBe('failed')
  expect(job.error).toContain('Start the stack')
  expect(job.logTail).toContain('compose exploded')
  expect(mutations).toHaveLength(0)
})

it('a successful install writes the local route and reports progress', async () => {
  const mutations: Array<{ ns: string; ops: readonly Record<string, unknown>[] }> = []
  const settings: SettingsSeam = {
    describe: () => [{ ns: 'llm-pi-ai', revision: 1, value: { providers: {} } }],
    mutate: async (ns, ops) => { mutations.push({ ns, ops }) },
  }
  const deps: HeavyDeps = {
    home: scratchDir(),
    dshHome: join(scratchDir(), '.dsh'),
    settings,
    credentials: { resolve: async () => undefined, set: async () => {}, unset: async () => {} },
    runStep: async () => ({ exitCode: 0, output: 'done' }),
  }
  const manager = new HeavyJobManager({ dir: join(deps.dshHome, 'cache', 'heavy-jobs'), run: deps.runStep })
  const manifest = manifestById('antigravity')!
  const finalize = vi.fn(async () => {
    await writeRoute(deps, manifest, 'local', [{ id: 'gemini-3.1-pro-high' }])
  })
  manager.start(manifest.id, 'install', resolveHeavyInstall(manifest.local, '').steps, finalize)
  const job = await settled(manager, manifest.id)
  expect(job.state).toBe('succeeded')
  expect(job.pct).toBe(100)
  expect(finalize).toHaveBeenCalledTimes(1)
  expect(mutations).toHaveLength(1)
  const value = (mutations[0]!.ops[0] as { value: Record<string, unknown> }).value
  expect(value.baseURL).toBe('http://127.0.0.1:8082')
  expect(value.models).toEqual([{ id: 'gemini-3.1-pro-high' }])
})

it('a local install finalizer on an unmounted namespace fails with the pendingRestart message, not a raw job error', async () => {
  const mutations: string[] = []
  const settings: SettingsSeam = {
    // The profile is running without the commandcode-provider entry.
    describe: () => [{ ns: 'llm-pi-ai', revision: 1, value: { providers: {} } }],
    mutate: async (ns) => { mutations.push(ns) },
  }
  const deps: HeavyDeps = {
    home: scratchDir(),
    dshHome: join(scratchDir(), '.dsh'),
    settings,
    runStep: async () => ({ exitCode: 0, output: 'ok' }),
  }
  const manager = new HeavyJobManager({ dir: join(deps.dshHome, 'cache', 'heavy-jobs'), run: deps.runStep })
  const manifest = manifestById('commandcode')!
  manager.start(manifest.id, 'install', resolveHeavyInstall(manifest.local, '').steps, async () => {
    await writeRoute(deps, manifest, 'local', [])
  })
  const job = await settled(manager, manifest.id)
  expect(job.state).toBe('failed')
  expect(job.error).toBe(pendingRestartMessage('commandcode-provider'))
  expect(mutations).toEqual([])
  console.info(`[heavy-install-guard] job error: ${job.error}`)
})

it('a failing finalizer marks the job failed instead of a partial success', async () => {
  const manager = new HeavyJobManager({
    dir: scratchDir(),
    run: async () => ({ exitCode: 0, output: 'ok' }),
  })
  const manifest = manifestById('freellmapi')!
  manager.start(manifest.id, 'install', resolveHeavyInstall(manifest.local, '').steps, async () => {
    throw new Error('route write refused')
  })
  const job = await settled(manager, manifest.id)
  expect(job.state).toBe('failed')
  expect(job.error).toContain('route write refused')
})

it('optional step failures do not fail the run', async () => {
  const manager = new HeavyJobManager({
    dir: scratchDir(),
    run: async step => step.optional === true
      ? { exitCode: 3, output: 'ignored' }
      : { exitCode: 0, output: 'ok' },
  })
  const manifest = manifestById('antigravity')!
  manager.start(manifest.id, 'teardown', manifest.removal.steps, undefined)
  const job = await settled(manager, manifest.id)
  expect(job.state).toBe('succeeded')
})

it('a succeeded snapshot is history once the route is configured; running and failed stay visible', () => {
  const base = {
    id: 'antigravity',
    kind: 'install' as const,
    stage: 'Finishing',
    stageIndex: 4,
    stageCount: 4,
    pct: 100,
    logTail: '',
    startedAt: 1,
  }
  expect(visibleJobSnapshot(undefined, true)).toBeUndefined()
  expect(visibleJobSnapshot({ ...base, state: 'running', pct: 50 }, true)?.state).toBe('running')
  expect(visibleJobSnapshot({ ...base, state: 'failed', error: 'boom' }, true)?.state).toBe('failed')
  // A success with no route yet (a non-install write path, or a just-finished
  // finalizer read before the settings reply settles) is still shown.
  expect(visibleJobSnapshot({ ...base, state: 'succeeded', finishedAt: 2 }, false)?.state).toBe('succeeded')
  expect(visibleJobSnapshot({ ...base, state: 'succeeded', finishedAt: 2 }, true)).toBeUndefined()
})
