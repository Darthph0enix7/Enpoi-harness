/**
 * The first-run system analysis: one read-only scan run on the host while the
 * user keeps working, published as JSON over `/system-analysis/*` and stored
 * as the sysadmin system-context document. The run is a singleton, bounded,
 * and never fatal: a failed probe degrades one section, a failed run reports
 * its reason in the job view, and neither state blocks the harness.
 * @module @deepseek-ai/dsh-host-first-run/analysis
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
// Empty type import carries the `webServer` Context merge for the reads below.
import type {} from '@deepseek-ai/dsh-host-webserver'
import z from '@deepseek-ai/schemastery'
import { readSystemContext, systemContextPath, writeSystemContext } from './context-file.ts'
import { ANALYSIS_STAGES, runSystemScan, type SystemScanResult, type SystemScanSummary } from './scan.ts'
/** Route prefix this plugin owns. */
export const ANALYSIS_ROUTE = '/system-analysis'

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
  /** Scan facts once the run settled succeeded. */
  summary?: SystemScanSummary
  /** Document path the result was written to. */
  contextPath?: string
}

/** Replaceable run dependencies; production binds the real scan and writer. */
export interface AnalysisDependencies {
  scan: (onStage: (stage: string) => void) => Promise<SystemScanResult>
  write: (markdown: string) => string
  read: () => string | null
  now: () => number
}

/** The singleton analysis runner behind the route and the wizard. */
export interface AnalysisRunner {
  /** Start the run, or return the current view while one is live or settled. */
  start: () => AnalysisJobView
  /** Current run view without changing it. */
  status: () => AnalysisJobView
  /** Stored context text, or null before a successful run. */
  context: () => string | null
}

/** Stage list length drives the progress percentage. */
const STAGE_COUNT = ANALYSIS_STAGES.length

/**
 * Build one runner over the injected dependencies.
 * @param dependencies - scan, storage, and clock.
 * @returns the runner the route plugin and tests drive.
 */
export function createAnalysisRunner(dependencies: AnalysisDependencies): AnalysisRunner {
  let job: AnalysisJobView = {
    state: 'idle',
    stage: '',
    stageIndex: 0,
    stageCount: STAGE_COUNT,
    pct: 0,
  }

  let stageIndex = 0

  const advance = (stage: string): void => {
    const bounded = Math.min(stageIndex, STAGE_COUNT - 1)
    job = {
      ...job,
      stage,
      stageIndex: bounded,
      pct: Math.round((bounded / STAGE_COUNT) * 100),
    }
    stageIndex += 1
  }

  const run = async (): Promise<void> => {
    try {
      const result = await dependencies.scan(advance)
      const contextPath = dependencies.write(result.markdown)
      job = {
        ...job,
        state: 'succeeded',
        stage: 'done',
        stageIndex: STAGE_COUNT,
        pct: 100,
        finishedAt: dependencies.now(),
        summary: result.summary,
        contextPath,
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
      if (job.state === 'running') return { ...job }
      if (job.state === 'succeeded') return { ...job }
      stageIndex = 0
      job = {
        state: 'running',
        stage: 'hardware',
        stageIndex: 0,
        stageCount: STAGE_COUNT,
        pct: 0,
        startedAt: dependencies.now(),
      }
      void run()
      return { ...job }
    },
    status: () => ({ ...job }),
    context: () => dependencies.read(),
  }
}

/** Plugin config: the route can be switched off without unloading the package. */
export interface AnalysisConfig {
  /** Register the `/system-analysis` routes. */
  routes: boolean
}

/** Validated analysis-plugin configuration; the Loader resolves the row config with it. */
export const Config: z<AnalysisConfig> = z.object({
  routes: z.boolean().default(true),
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
    sendJson(res, 404, { ok: false, message: `unknown system-analysis path "${path}"` })
  } catch (error) {
    // Answering is the only failure mode left here; the harness must never
    // take a request handler failure into its own lifecycle.
    sendJson(res, 500, { ok: false, message: error instanceof Error ? error.message : String(error) })
  }
}

/**
 * Register the system-analysis routes over the host web server.
 * @param ctx - host context carrying the web server.
 * @param config - route registration policy.
 */
export function apply(ctx: Context, config: AnalysisConfig): void {
  if (!config.routes) return
  const runner = createAnalysisRunner({
    scan: onStage => runSystemScan(stage => onStage(stage)),
    write: markdown => writeSystemContext(markdown),
    read: () => readSystemContext(systemContextPath()),
    now: () => Date.now(),
  })
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: ANALYSIS_ROUTE,
    handler: (req, res) => { handleRequest(runner, req, res) },
  }), 'first-run: system-analysis routes')
}
