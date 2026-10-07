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
 * @module dsh-enpoi-heavy-providers/jobs
 */

import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { HeavyStep } from './manifests.js'
import type { StepOutcome } from './planner.js'

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

/** One job manager per heavy provider id at a time. */
export class HeavyJobManager {
  private readonly jobs = new Map<string, HeavyJobView>()
  private readonly running = new Set<string>()
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
   * A job persisted as `running` belongs to a previous process: the runner
   * died with it, so the file is rewritten as failed instead of leaving the
   * UI polling a job nothing will ever finish.
   */
  private recoverInterrupted(): void {
    try {
      readdirSync(this.dir)
        .filter(name => name.endsWith('.json'))
        .forEach((name) => {
          const path = join(this.dir, name)
          try {
            const view = JSON.parse(readFileSync(path, 'utf8')) as HeavyJobView
            if (view?.state === 'running') {
              view.state = 'failed'
              view.error = 'interrupted by harness restart'
              view.finishedAt = this.now()
              this.persist(view)
            }
          } catch {
            // An unreadable job file is ignored; the next start overwrites it.
          }
        })
    } catch {
      // No cache directory yet: nothing to recover.
    }
  }

  /**
   * Start a job unless one is already running for that id. The returned view
   * is the initial snapshot; `finalize` runs only after all required steps
   * succeed, and its failure marks the job failed.
   * @param id - provider id (the job file name).
   * @param kind - install or teardown.
   * @param steps - declared steps in order.
   * @param finalize - success action (route write); absent means none.
   * @returns the initial job snapshot.
   */
  start(id: string, kind: HeavyJobView['kind'], steps: readonly HeavyStep[], finalize?: () => Promise<void>): HeavyJobView {
    if (this.running.has(id)) return this.snapshot(id) ?? failed(id, 'job already running')
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
    void this.runAll(view, steps, total, finalize)
    return { ...view }
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
    finalize?: () => Promise<void>,
  ): Promise<void> {
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
