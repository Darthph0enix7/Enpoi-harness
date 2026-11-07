/**
 * enpoi-heavy-providers — the polled install/teardown job.
 *
 * A heavy install can outlive one settings write, so it runs as a background
 * job: steps execute sequentially through an injected runner, every update is
 * persisted to `$DSH_HOME/cache/heavy-jobs/<id>.json`, and the UI polls the
 * snapshot for `{stage, pct, logTail}`. The route is written by the job's
 * finalizer ONLY after every required step succeeded: a failed install leaves
 * no route, no credential, and no partial settings.
 *
 * One provider's job owns a per-provider lock (`./provider-lock.ts`) from
 * before its first step until its terminal snapshot is persisted. A second
 * manager, process, or removal path therefore cannot run or evict the same
 * provider concurrently; eviction of an owned job is refused instead of
 * deleting the file its finalizer still updates.
 *
 * @module dsh-enpoi-heavy-providers/jobs
 */

import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { HeavyStep } from './manifests.js'
import type { StepOutcome } from './planner.js'
import {
  acquireProviderLock,
  HeavyProviderLockedError,
  HeavyProviderLockUnreadableError,
  inspectProviderLock,
  type HeavyProviderLock,
} from './provider-lock.js'

/** One job's observable state. */
export interface HeavyJobView {
  id: string
  kind: 'install' | 'teardown'
  state: 'running' | 'succeeded' | 'failed'
  /** Current step label. */
  stage: string
  stageIndex: number
  stageCount: number
  /** 0–100, weighted by each step's `weight` (default 1); 100 only on success. */
  pct: number
  /** Last chunk of accumulated step output (bounded). */
  logTail: string
  startedAt: number
  finishedAt?: number
  error?: string
}

/** Runs one declared step; the host wires this to the subprocess seam. */
export type HeavyStepRunner = (step: HeavyStep) => Promise<StepOutcome>

/** In-memory tail cap for one job's log. */
const LOG_CAP_BYTES = 8192

/** The host-wide job manager; each provider id is exclusive through its lock. */
export class HeavyJobManager {
  private readonly jobs = new Map<string, HeavyJobView>()
  private readonly running = new Set<string>()
  /** Provider ids currently covered by {@link withProviderLock}. */
  private readonly exclusive = new Set<string>()
  private readonly dir: string
  private readonly run: HeavyStepRunner
  private readonly now: () => number

  /**
   * @param options - cache directory, step runner, and a clock seam for tests.
   */
  constructor(options: { dir: string; run: HeavyStepRunner; now?: () => number }) {
    this.dir = options.dir
    this.run = options.run
    this.now = options.now ?? Date.now
    this.recoverInterrupted()
  }

  /**
   * A job persisted as `running` without a live lock owner belongs to a
   * previous process: the runner died with it, so the file is rewritten as
   * failed instead of leaving the UI polling a job nothing will ever finish.
   * A live owner, or a lock whose holder cannot be proven dead, keeps its
   * `running` file untouched.
   */
  private recoverInterrupted(): void {
    try {
      readdirSync(this.dir)
        .filter(name => name.endsWith('.json'))
        .forEach((name) => {
          const path = join(this.dir, name)
          try {
            const view = JSON.parse(readFileSync(path, 'utf8')) as HeavyJobView
            if (view?.state !== 'running' || typeof view.id !== 'string') return
            const ownership = inspectProviderLock(this.dir, view.id)
            if (ownership.kind === 'held' || ownership.kind === 'unverifiable') return
            view.state = 'failed'
            view.error = 'interrupted by harness restart'
            view.finishedAt = this.now()
            this.persist(view)
          } catch {
            // An unreadable job file is ignored; the next start overwrites it.
          }
        })
    } catch {
      // No cache directory yet: nothing to recover.
    }
  }

  /**
   * Start a job unless the provider is already owned. Ownership is taken
   * before the initial snapshot is written and held through the finalizer and
   * the terminal persist. A live owner elsewhere returns its snapshot (when
   * one is readable) or a failed refusal view; a lock that cannot be proven
   * dead throws `HeavyProviderLockUnreadableError` instead of guessing.
   * The returned view is the initial snapshot; `finalize` runs only after all
   * required steps succeed, and its failure marks the job failed.
   * @param id - provider id (the job file name).
   * @param kind - install or teardown.
   * @param steps - declared steps in order.
   * @param finalize - success action (route write); absent means none.
   * @returns the initial job snapshot.
   */
  start(id: string, kind: HeavyJobView['kind'], steps: readonly HeavyStep[], finalize?: () => Promise<void>): HeavyJobView {
    if (this.running.has(id)) return this.snapshot(id) ?? failed(id, 'job already running')
    let lock: HeavyProviderLock
    try {
      lock = acquireProviderLock(this.dir, id, this.now)
    } catch (error) {
      if (!(error instanceof HeavyProviderLockedError)) throw error
      const current = this.snapshot(id)
      return current?.state === 'running' ? current : failed(id, error.message)
    }
    try {
      const total = steps.reduce((sum, step) => sum + (step.weight ?? 1), 0)
      const view: HeavyJobView = {
        id,
        kind,
        state: 'running',
        stage: steps[0]?.label ?? 'Finishing',
        stageIndex: 0,
        stageCount: steps.length,
        pct: 0,
        logTail: '',
        startedAt: this.now(),
      }
      this.jobs.set(id, view)
      this.running.add(id)
      this.persist(view)
      void this.runAll(view, steps, total, lock, finalize)
      return { ...view }
    } catch (error) {
      this.running.delete(id)
      this.jobs.delete(id)
      lock.release()
      throw error
    }
  }

  /** The latest snapshot: in-memory first, then the persisted file (survives a restart). */
  snapshot(id: string): HeavyJobView | undefined {
    const memory = this.jobs.get(id)
    if (memory !== undefined) return { ...memory }
    try {
      const raw = JSON.parse(readFileSync(join(this.dir, `${id}.json`), 'utf8')) as HeavyJobView
      return raw !== null && typeof raw === 'object' ? raw : undefined
    } catch {
      return undefined
    }
  }

  /**
   * Whether this provider is owned by a running job: this manager's own job,
   * or a live owner in another manager or process. An unverifiable lock is
   * reported as running so callers fail closed and never evict its files.
   * @param id - provider id.
   * @returns true while the provider's install/teardown must not be evicted.
   */
  isRunning(id: string): boolean {
    if (this.running.has(id)) return true
    if (this.exclusive.has(id)) return false
    const ownership = inspectProviderLock(this.dir, id)
    return ownership.kind === 'held' || ownership.kind === 'unverifiable'
  }

  /**
   * Evict one provider's snapshot: the in-memory view and its persisted file.
   * A removed provider's terminal job must not resurrect on the next status
   * poll. Eviction owns the provider lock while it removes the file, so a
   * concurrent `start` either loses to a live eviction or runs after it. A
   * running job — including one owned by another manager or process — keeps
   * both the snapshot and its file; a lock that cannot be proven dead also
   * refuses eviction.
   * @param id - provider id.
   * @returns true when the snapshot and file were removed, false when a live
   * or unverifiable owner refused the eviction.
   */
  evict(id: string): boolean {
    if (this.running.has(id)) return false
    if (this.exclusive.has(id)) {
      this.removeSnapshot(id)
      return true
    }
    let lock: HeavyProviderLock
    try {
      lock = acquireProviderLock(this.dir, id, this.now)
    } catch (error) {
      if (error instanceof HeavyProviderLockedError || error instanceof HeavyProviderLockUnreadableError) return false
      throw error
    }
    try {
      this.removeSnapshot(id)
      return true
    } finally {
      lock.release()
    }
  }

  /**
   * Run one provider-scoped operation under the same exclusive lock an
   * install owns. Removal uses this so route, credential, pool, and cache
   * cleanup cannot overlap a live install; `evict` is permitted inside the
   * operation. A live owner refuses with {@link HeavyProviderLockedError}; an
   * unverifiable record fails closed with `HeavyProviderLockUnreadableError`.
   * @param id - provider id.
   * @param operation - async work to run while holding the lock.
   * @returns the operation's result.
   */
  async withProviderLock<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const lock = acquireProviderLock(this.dir, id, this.now)
    this.exclusive.add(id)
    try {
      return await operation()
    } finally {
      this.exclusive.delete(id)
      lock.release()
    }
  }

  /** Drop the in-memory view and the persisted snapshot; callers own the lock. */
  private removeSnapshot(id: string): void {
    this.jobs.delete(id)
    try {
      rmSync(join(this.dir, `${id}.json`), { force: true })
    } catch {
      // Removing the file is best-effort: an unremovable file is recovered as
      // failed on the next boot, and the in-memory view is already gone.
    }
  }

  private appendLog(view: HeavyJobView, chunk: string): void {
    view.logTail = `${view.logTail}${chunk}`.slice(-LOG_CAP_BYTES)
  }

  private persist(view: HeavyJobView): void {
    try {
      mkdirSync(this.dir, { recursive: true })
      const path = join(this.dir, `${view.id}.json`)
      const temporary = `${path}.tmp-${String(process.pid)}`
      writeFileSync(temporary, JSON.stringify(view), 'utf8')
      renameSync(temporary, path)
    } catch {
      // Persistence is a convenience for polling across restarts; the
      // in-memory snapshot already serves the live poll.
    }
  }

  private async runAll(
    view: HeavyJobView,
    steps: readonly HeavyStep[],
    total: number,
    lock: HeavyProviderLock,
    finalize?: () => Promise<void>,
  ): Promise<void> {
    try {
      let done = 0
      for (const [index, step] of steps.entries()) {
        view.stage = step.label
        view.stageIndex = index
        this.persist(view)
        let outcome: StepOutcome
        try {
          outcome = await this.run(step)
        } catch (error) {
          if (step.optional === true) {
            this.appendLog(view, `$ ${step.label}: optional step failed — ${error instanceof Error ? error.message : String(error)}\n`)
            done += step.weight ?? 1
            view.pct = Math.min(99, Math.round((done / total) * 99))
            continue
          }
          this.fail(view, `${step.label}: ${error instanceof Error ? error.message : String(error)}`)
          return
        }
        this.appendLog(view, `$ ${step.label}\n${outcome.output}\n`)
        if (outcome.exitCode !== 0) {
          if (step.optional === true) {
            this.appendLog(view, `$ ${step.label}: optional step exited ${String(outcome.exitCode)}\n`)
          } else {
            this.fail(view, `${step.label}: exit ${String(outcome.exitCode)}`)
            return
          }
        }
        done += step.weight ?? 1
        view.pct = Math.min(99, Math.round((done / total) * 99))
        this.persist(view)
      }
      view.stage = 'Finishing'
      this.persist(view)
      try {
        await finalize?.()
      } catch (error) {
        this.fail(view, error instanceof Error ? error.message : String(error))
        return
      }
      view.state = 'succeeded'
      view.pct = 100
      view.finishedAt = this.now()
      this.running.delete(view.id)
      this.persist(view)
    } finally {
      lock.release()
    }
  }

  private fail(view: HeavyJobView, error: string): void {
    view.state = 'failed'
    view.error = error
    view.finishedAt = this.now()
    this.running.delete(view.id)
    this.persist(view)
  }
}

/** A minimal failed view for the duplicate-start guard. */
function failed(id: string, error: string): HeavyJobView {
  return {
    id,
    kind: 'install',
    state: 'failed',
    stage: 'rejected',
    stageIndex: 0,
    stageCount: 0,
    pct: 0,
    logTail: '',
    startedAt: 0,
    finishedAt: 0,
    error,
  }
}

/**
 * The snapshot a status reply may expose. A succeeded install is history once
 * its route is configured: the route is the durable outcome, and the terminal
 * snapshot would otherwise re-render finished progress on every page open. A
 * running job (progress to show) and a failed one (the operator needs the
 * error) stay visible.
 * @param job - the stored snapshot, when one exists.
 * @param configured - whether the provider's route is already written.
 * @returns the snapshot to expose, or undefined when it is history.
 */
export function visibleJobSnapshot(job: HeavyJobView | undefined, configured: boolean): HeavyJobView | undefined {
  return job !== undefined && job.state === 'succeeded' && configured ? undefined : job
}
