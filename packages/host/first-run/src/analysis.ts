/**
 * The system analysis: one opt-in, read-only agent investigation of this
 * machine, started from the client and published as JSON over
 * `/system-analysis/*`. The run is a singleton, bounded by a configured time
 * limit, and never fatal: a refused preset or a failed investigation reports
 * its reason in the job view and leaves the harness untouched. Accept keeps
 * the stored document; reject removes it and records the decision so no later
 * boot re-offers the analysis. The run only ever starts on an explicit client
 * action; nothing at boot schedules it.
 * @module @deepseek-ai/dsh-host-first-run/analysis
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
// Empty type imports carry the `webServer` Context merge for the reads below.
import type {} from '@deepseek-ai/dsh-host-webserver'
import z from '@deepseek-ai/schemastery'
import {
  readSystemProfile,
  readSystemProfileDecision,
  removeSystemProfile,
  systemProfilePath,
  writeSystemProfile,
  writeSystemProfileDecision,
  writeSystemProfileJson,
  type SystemProfileDecision,
} from './context-file.ts'
import {
  INVESTIGATION_STAGES, investigationWorkspacePath, runSystemInvestigation,
  type InvestigationOutcome, type InvestigationStage,
} from './investigation.ts'

/** Route prefix this plugin owns. */
export const ANALYSIS_ROUTE = '/system-analysis'

/** Every stage one investigation run reports, in execution order. */
export const ANALYSIS_STAGES = INVESTIGATION_STAGES

/** One stage name from {@link ANALYSIS_STAGES}. */
export type AnalysisStage = InvestigationStage

/** One analysis run as the client renders and polls it. */
export interface AnalysisJobView {
  state: 'idle' | 'running' | 'succeeded' | 'failed'
  /** Current stage label; empty while idle. */
  stage: string
  /** Zero-based stage index among the fixed stage list. */
  stageIndex: number
  /** Total stages in one run. */
  stageCount: number
  /** Completion percentage derived from the stage position. */
  pct: number
  startedAt?: number
  finishedAt?: number
  /** Failure reason once the run settled failed. */
  error?: string
  /** Document path the result was written to. */
  contextPath?: string
  /** Whether a profile document is stored right now. */
  hasProfile: boolean
  /** The operator's recorded decision, or null when none was recorded. */
  decision: SystemProfileDecision | null
}

/** Replaceable run dependencies; production binds the real investigation and storage. */
export interface AnalysisDependencies {
  /**
   * Run the bounded investigation.
   * @param onStage - observer called as the investigating agent enters each stage.
   * @param signal - cancellation for the run's whole lifetime.
   * @returns the published structured profile and Markdown document.
   */
  investigate: (onStage: (stage: AnalysisStage) => void, signal: AbortSignal) => Promise<InvestigationOutcome>
  writeProfile: (markdown: string) => string
  writeProfileJson: (json: string) => string
  readProfile: () => string | null
  removeProfile: () => void
  readDecision: () => SystemProfileDecision | null
  writeDecision: (decision: SystemProfileDecision) => void
  /** `provider/model` label the document header records. */
  route: string
  /** Agent preset the document header records. */
  preset: string
  now: () => number
}

/** The singleton analysis runner behind the route and the client chip. */
export interface AnalysisRunner {
  /** Start the run, or return the current view while one is live or settled. */
  start: () => AnalysisJobView
  /** Current run view without changing it. */
  status: () => AnalysisJobView
  /** Stored profile text, or null before a successful run. */
  context: () => string | null
  /** Keep the stored document and record the acceptance. */
  accept: () => AnalysisJobView
  /** Remove the stored document and record the rejection. */
  reject: () => AnalysisJobView
}

/** Stage list length drives the progress percentage. */
const STAGE_COUNT = ANALYSIS_STAGES.length

/**
 * Percentage one stage position reports, clamped to the 0..100 the client bar
 * can render.
 * @param stageIndex - zero-based position of the stage being entered.
 * @param stageCount - stages in the run.
 * @returns the integer percentage for that position.
 */
export function stagePct(stageIndex: number, stageCount: number): number {
  if (stageCount <= 0) return 0
  const bounded = Math.max(0, Math.min(stageIndex, stageCount - 1))
  return Math.round((bounded / stageCount) * 100)
}

/** The document header written above the agent-authored profile body. */
function profileHeader(route: string, preset: string, at: number): string[] {
  return [
    '# System profile',
    '',
    `_Read-only investigation by the ${preset} agent on ${route}, completed ${new Date(at).toISOString()}. The structured profile is stored beside this document as system-profile.json; inventories in both are a snapshot of that investigation._`,
    '',
  ]
}

/**
 * Build one runner over the injected dependencies.
 * @param dependencies - investigation, storage, and clock.
 * @param lifetime - aborts a live run when the owning plugin unloads.
 * @returns the runner the route plugin and tests drive.
 */
export function createAnalysisRunner(dependencies: AnalysisDependencies, lifetime?: AbortSignal): AnalysisRunner {
  let job: AnalysisJobView = {
    state: 'idle',
    stage: '',
    stageIndex: 0,
    stageCount: STAGE_COUNT,
    pct: 0,
    hasProfile: false,
    decision: null,
  }

  const view = (): AnalysisJobView => ({
    ...job,
    hasProfile: dependencies.readProfile() !== null,
    decision: dependencies.readDecision(),
  })

  /** Enter one stage. A repeated or unknown stage never moves the rail. */
  const enter = (stage: AnalysisStage): void => {
    const index = ANALYSIS_STAGES.indexOf(stage)
    if (index < 0) return
    job = { ...job, stage, stageIndex: index, pct: stagePct(index, STAGE_COUNT) }
  }

  const run = async (signal: AbortSignal): Promise<void> => {
    try {
      const outcome = await dependencies.investigate(enter, signal)
      enter('writing profile')
      try {
        dependencies.writeProfileJson(JSON.stringify(outcome.profile, null, 2))
        const contextPath = dependencies.writeProfile([
          ...profileHeader(dependencies.route, dependencies.preset, dependencies.now()),
          outcome.document.trim(),
          '',
        ].join('\n'))
        job = {
          ...job,
          state: 'succeeded',
          stage: 'done',
          stageIndex: STAGE_COUNT,
          pct: 100,
          finishedAt: dependencies.now(),
          contextPath,
        }
      } catch (error) {
        // A half-written publication is not a profile: remove both files so
        // `hasProfile` and the next start agree, then settle failed with the
        // real reason.
        dependencies.removeProfile()
        throw error
      }
    } catch (error) {
      job = {
        ...job,
        state: 'failed',
        stage: 'failed',
        finishedAt: dependencies.now(),
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }

  return {
    start: () => {
      if (job.state === 'running') return view()
      // A settled success whose document is gone (rejected, or removed by hand)
      // is no longer settled: the next start runs the analysis again.
      if (job.state === 'succeeded' && dependencies.readProfile() !== null) return view()
      job = {
        state: 'running',
        stage: ANALYSIS_STAGES[0],
        stageIndex: 0,
        stageCount: STAGE_COUNT,
        pct: 0,
        startedAt: dependencies.now(),
        hasProfile: false,
        decision: null,
      }
      void run(lifetime ?? new AbortController().signal)
      return view()
    },
    status: () => view(),
    context: () => dependencies.readProfile(),
    accept: () => {
      dependencies.writeDecision('accepted')
      return view()
    },
    reject: () => {
      dependencies.removeProfile()
      dependencies.writeDecision('rejected')
      return view()
    },
  }
}

/** Plugin config: the route, the investigation preset and route, and its bound. */
export interface AnalysisConfig {
  /** Register the `/system-analysis` routes. */
  routes: boolean
  /** Agent preset that performs the investigation. */
  preset: string
  /** Provider route the investigation agent runs on. */
  provider: string
  /** Model the investigation agent runs on. */
  model: string
  /** Permission preset enforced on the investigation session. */
  permissionPreset: string
  /** Hard bound on one investigation, in minutes. */
  timeoutMinutes: number
}

/** Validated analysis-plugin configuration; the Loader resolves the row config with it. */
export const Config: z<AnalysisConfig> = z.object({
  routes: z.boolean().default(true),
  preset: z.string().default('sysadmin'),
  provider: z.string().default('kilo'),
  model: z.string().default('kilo-auto/free'),
  // The investigation is read-only toward the host; this preset gives its own
  // scratch workspace just enough room to write the two profile artifacts.
  permissionPreset: z.string().default('workspace-write'),
  timeoutMinutes: z.number().default(15),
})

/** Stable Cordis plugin name. */
export const name = 'first-run-analysis'

/** The analysis serves browser calls through the host web server. */
export const inject = ['webServer']

/** Write one JSON response with no caching. */
function sendJson(res: ServerResponse, status: number, value: unknown): void {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json')
  res.setHeader('Cache-Control', 'no-store')
  res.end(JSON.stringify(value))
}

/**
 * Handle one `/system-analysis/*` request.
 * @param runner - the singleton runner.
 * @param req - incoming request.
 * @param res - response owner.
 */
export function handleRequest(runner: AnalysisRunner, req: IncomingMessage, res: ServerResponse): void {
  try {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname.slice(ANALYSIS_ROUTE.length)
    if (path === '/start') {
      sendJson(res, 200, { ok: true, job: runner.start() })
      return
    }
    if (path === '/status') {
      sendJson(res, 200, { ok: true, job: runner.status() })
      return
    }
    if (path === '/context') {
      sendJson(res, 200, { ok: true, text: runner.context() })
      return
    }
    if (path === '/accept') {
      sendJson(res, 200, { ok: true, job: runner.accept() })
      return
    }
    if (path === '/reject') {
      sendJson(res, 200, { ok: true, job: runner.reject() })
      return
    }
    sendJson(res, 404, { ok: false, message: `unknown system-analysis path "${path}"` })
  } catch (error) {
    // Answering is the only failure mode left here; the harness must never
    // take a request handler failure into its own lifecycle.
    sendJson(res, 500, { ok: false, message: error instanceof Error ? error.message : String(error) })
  }
}

/**
 * Register the system-analysis routes over the host web server.
 * @param ctx - host context carrying the web server and the agent runtime.
 * @param config - route, preset, investigation route, and bound.
 */
export function apply(ctx: Context, config: AnalysisConfig): void {
  if (!config.routes) return
  // A run must not outlive the row that owns it; the effect aborts any live
  // investigation when the plugin unloads.
  const lifetime = new AbortController()
  ctx.effect(() => () => {
    lifetime.abort(new Error('the first-run analysis plugin unloaded'))
  }, 'first-run: investigation lifetime')
  const runner = createAnalysisRunner({
    investigate: (onStage, signal) => runSystemInvestigation({
      ctx,
      workspace: investigationWorkspacePath(),
      provider: config.provider,
      model: config.model,
      preset: config.preset,
      permissionPreset: config.permissionPreset,
      timeoutMinutes: config.timeoutMinutes,
    }, { onStage, signal: AbortSignal.any([signal, lifetime.signal]) }),
    writeProfile: markdown => writeSystemProfile(markdown),
    writeProfileJson: json => writeSystemProfileJson(json),
    readProfile: () => readSystemProfile(),
    removeProfile: () => { removeSystemProfile() },
    readDecision: () => readSystemProfileDecision(),
    writeDecision: (decision) => { writeSystemProfileDecision(decision) },
    route: `${config.provider}/${config.model}`,
    preset: config.preset,
    now: () => Date.now(),
  }, lifetime.signal)
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: ANALYSIS_ROUTE,
    handler: (req, res) => { handleRequest(runner, req, res) },
  }), 'first-run: system-analysis routes')
  // The document path is a stable fact of this plugin; expose it for diagnostics.
  ctx.logger.debug('first-run: system profile document at %s', systemProfilePath())
}
