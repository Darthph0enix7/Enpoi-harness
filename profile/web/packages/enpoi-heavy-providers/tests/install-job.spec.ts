/**
 * Install jobs: a failed step leaves NO route and NO credential; only a fully
 * successful run invokes the finalizer that writes them. Jobs are polled, so
 * the snapshot carries stage/pct/logTail while running.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { HeavyJobManager, visibleJobSnapshot } from '../src/jobs.js'
import { manifestById, resolveHeavyInstall } from '../src/manifests.js'
import { pendingRestartMessage, writeRoute, type HeavyDeps, type SettingsSeam, type StepOutcome } from '../src/planner.js'

const scratch: string[] = []
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function scratchDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'heavy-job-'))
  scratch.push(dir)
  return dir
}

/** Wait for a job to settle across event-loop turns (the runner is async). */
async function settled(manager: HeavyJobManager, id: string): Promise<NonNullable<ReturnType<HeavyJobManager['snapshot']>>> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const job = manager.snapshot(id)
    if (job !== undefined && job.state !== 'running') return job
    await new Promise(resolve => setImmediate(resolve))
  }
  throw new Error('job did not settle')
}

/** A promise resolved explicitly by the test, so ordering never depends on sleeps. */
function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((settle) => { resolve = settle })
  return { promise, resolve }
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

it('evict drops the in-memory snapshot and its persisted file', async () => {
  const dir = join(scratchDir(), 'heavy-jobs')
  const manager = new HeavyJobManager({ dir, run: async () => ({ exitCode: 0, output: 'ok' }) })
  manager.start('antigravity', 'install', resolveHeavyInstall(manifestById('antigravity')!.local, '').steps, undefined)
  await settled(manager, 'antigravity')
  const file = join(dir, 'antigravity.json')
  expect(existsSync(file)).toBe(true)

  // Removal evicts the snapshot so a terminal job cannot resurrect on status.
  expect(manager.evict('antigravity')).toBe(true)
  expect(manager.snapshot('antigravity')).toBeUndefined()
  expect(existsSync(file)).toBe(false)
  // Evicting an already-absent snapshot is a no-op, never an error.
  expect(manager.evict('antigravity')).toBe(true)
})

it('two managers sharing the job directory cannot run or evict the same provider', async () => {
  const dir = join(scratchDir(), 'heavy-jobs')
  const entered = deferred()
  const releaseStep = deferred<StepOutcome>()
  const secondRun = vi.fn(async (): Promise<StepOutcome> => ({ exitCode: 0, output: 'ok' }))
  const first = new HeavyJobManager({
    dir,
    run: async () => {
      entered.resolve()
      return releaseStep.promise
    },
  })
  const finalize = vi.fn(async () => {})
  first.start('antigravity', 'install', [{ label: 'Install', command: 'true' }], finalize)
  await entered.promise
  expect(first.snapshot('antigravity')?.state).toBe('running')

  const second = new HeavyJobManager({ dir, run: secondRun })
  // Recovery keeps the live owner's running file, and start returns that
  // snapshot instead of running a second job.
  expect(second.snapshot('antigravity')?.state).toBe('running')
  expect(second.start('antigravity', 'install', [{ label: 'Rival', command: 'true' }], vi.fn()).state).toBe('running')
  expect(secondRun).not.toHaveBeenCalled()
  expect(second.isRunning('antigravity')).toBe(true)
  expect(second.evict('antigravity')).toBe(false)
  expect(existsSync(join(dir, 'antigravity.json'))).toBe(true)

  // Locks are per provider: an unrelated provider still starts immediately.
  const other = new HeavyJobManager({ dir, run: async () => ({ exitCode: 0, output: 'ok' }) })
  other.start('freellmapi', 'install', [{ label: 'Other', command: 'true' }], undefined)
  expect((await settled(other, 'freellmapi')).state).toBe('succeeded')

  releaseStep.resolve({ exitCode: 0, output: 'ok' })
  const job = await settled(first, 'antigravity')
  expect(job.state).toBe('succeeded')
  expect(finalize).toHaveBeenCalledTimes(1)
  expect(second.evict('antigravity')).toBe(true)
})

it('a delayed finalizer keeps the lock until its terminal snapshot is persisted', async () => {
  const dir = join(scratchDir(), 'heavy-jobs')
  const entered = deferred()
  const releaseFinalize = deferred()
  const secondRun = vi.fn(async (): Promise<StepOutcome> => ({ exitCode: 0, output: 'ok' }))
  const manager = new HeavyJobManager({ dir, run: async () => ({ exitCode: 0, output: 'ok' }) })
  manager.start('antigravity', 'install', [{ label: 'Install', command: 'true' }], async () => {
    entered.resolve()
    await releaseFinalize.promise
  })
  await entered.promise
  expect(manager.snapshot('antigravity')?.stage).toBe('Finishing')
  expect(manager.isRunning('antigravity')).toBe(true)
  expect(manager.evict('antigravity')).toBe(false)
  expect(existsSync(join(dir, 'antigravity.json'))).toBe(true)

  const rival = new HeavyJobManager({ dir, run: secondRun })
  expect(rival.start('antigravity', 'install', [{ label: 'Rival', command: 'true' }], vi.fn()).state).toBe('running')
  expect(secondRun).not.toHaveBeenCalled()

  releaseFinalize.resolve()
  expect((await settled(manager, 'antigravity')).state).toBe('succeeded')
  expect(manager.evict('antigravity')).toBe(true)
})

it('a stale lock and persisted running job from an exited owner are recovered', async () => {
  const dir = join(scratchDir(), 'heavy-jobs')
  const previousOwner = spawnSync(process.execPath, ['-e', ''], { timeout: 5000 })
  expect(previousOwner.status).toBe(0)
  const providerDir = join(dir, 'locks', encodeURIComponent('antigravity'))
  mkdirSync(providerDir, { recursive: true })
  writeFileSync(join(providerDir, '000000000001.lock'), JSON.stringify({
    version: 1,
    id: 'antigravity',
    token: 'abandoned-token',
    pid: previousOwner.pid,
    startedAt: 1,
    processStart: null,
  }))
  writeFileSync(join(dir, 'antigravity.json'), JSON.stringify({
    id: 'antigravity',
    kind: 'install',
    state: 'running',
    stage: 'Install',
    stageIndex: 0,
    stageCount: 1,
    pct: 0,
    logTail: '',
    startedAt: 1,
  }))

  const manager = new HeavyJobManager({ dir, run: async () => ({ exitCode: 0, output: 'ok' }) })
  // The process has exited, unlike a live same-pid owner in another module.
  expect(manager.snapshot('antigravity')?.state).toBe('failed')
  expect(manager.snapshot('antigravity')?.error).toContain('interrupted')

  manager.start('antigravity', 'install', [{ label: 'Install', command: 'true' }], undefined)
  expect((await settled(manager, 'antigravity')).state).toBe('succeeded')
  // The dead generation is reclaimed and the completed generation released.
  expect(readdirSync(providerDir).filter(name => name.endsWith('.lock'))).toEqual([])
})

it('a malformed lock fails closed: start explains, evict refuses, recovery leaves the job alone', () => {
  const dir = join(scratchDir(), 'heavy-jobs')
  const providerDir = join(dir, 'locks', encodeURIComponent('antigravity'))
  mkdirSync(providerDir, { recursive: true })
  writeFileSync(join(providerDir, '000000000001.lock'), '{"version":1')
  writeFileSync(join(dir, 'antigravity.json'), JSON.stringify({
    id: 'antigravity',
    kind: 'install',
    state: 'running',
    stage: 'Install',
    stageIndex: 0,
    stageCount: 1,
    pct: 0,
    logTail: '',
    startedAt: 1,
  }))

  const manager = new HeavyJobManager({ dir, run: async () => ({ exitCode: 0, output: 'ok' }) })
  expect(manager.snapshot('antigravity')?.state).toBe('running')
  expect(manager.isRunning('antigravity')).toBe(true)
  expect(manager.evict('antigravity')).toBe(false)
  expect(existsSync(join(dir, 'antigravity.json'))).toBe(true)
  expect(() => manager.start('antigravity', 'install', [], undefined)).toThrow(/refusing to reclaim/)
  expect(() => manager.start('antigravity', 'install', [], undefined)).toThrow(join(providerDir, '000000000001.lock'))
})

it('failed jobs release ownership, so a later install and eviction proceed', async () => {
  const dir = join(scratchDir(), 'heavy-jobs')
  const manager = new HeavyJobManager({ dir, run: async () => ({ exitCode: 0, output: 'ok' }) })
  manager.start('antigravity', 'install', [{ label: 'Install', command: 'true' }], async () => {
    throw new Error('route write refused')
  })
  expect((await settled(manager, 'antigravity')).state).toBe('failed')
  expect(manager.isRunning('antigravity')).toBe(false)

  manager.start('antigravity', 'install', [{ label: 'Install', command: 'true' }], undefined)
  expect((await settled(manager, 'antigravity')).state).toBe('succeeded')
  expect(manager.evict('antigravity')).toBe(true)
  expect(manager.evict('antigravity')).toBe(true)
})

it('withProviderLock excludes start and allows eviction inside the operation', async () => {
  const dir = join(scratchDir(), 'heavy-jobs')
  const manager = new HeavyJobManager({ dir, run: async () => ({ exitCode: 0, output: 'ok' }) })
  const entered = deferred()
  const releaseOperation = deferred()
  const operation = manager.withProviderLock('antigravity', async () => {
    entered.resolve()
    await releaseOperation.promise
    expect(manager.evict('antigravity')).toBe(true)
  })
  await entered.promise
  const refusal = manager.start('antigravity', 'install', [{ label: 'Install', command: 'true' }], vi.fn())
  expect(refusal.state).toBe('failed')
  expect(refusal.error).toContain('is held by pid')
  expect(manager.isRunning('antigravity')).toBe(false)
  releaseOperation.resolve()
  await operation
})
