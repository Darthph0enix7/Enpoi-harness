/**
 * The system analysis: one read-only scan run on the host while the user keeps
 * working, summarised by the configured free route into a capability-level
 * living document, published as JSON over `/system-analysis/*`. The run is a
 * singleton, bounded, and never fatal: a failed probe degrades one section, a
 * failed run reports its reason in the job view, and neither state blocks the
 * harness. Accept keeps the document; reject removes it and records the
 * decision so no later boot re-runs the analysis.
 * @module @deepseek-ai/dsh-host-first-run/analysis
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
// Empty type imports carry the `webServer` and `llm` Context merges for the reads below.
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-llm'
import z from '@deepseek-ai/schemastery'
import {
  readSystemProfile,
  readSystemProfileDecision,
  removeSystemProfile,
  systemProfilePath,
  writeSystemProfile,
  writeSystemProfileDecision,
  writeSystemProfileScan,
  type SystemProfileDecision,
} from './context-file.ts'
import { ANALYSIS_STAGES, runSystemScan, type AnalysisStage, type SystemScanFacts, type SystemScanResult, type SystemScanSummary } from './scan.ts'
import { summariseSystemFacts } from './summarise.ts'
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
  /** Whether a profile document is stored right now. */
  hasProfile: boolean
  /** The operator's recorded decision, or null when none was recorded. */
  decision: SystemProfileDecision | null
}

/** Replaceable run dependencies; production binds the real scan, summariser, and storage. */
export interface AnalysisDependencies {
  scan: (onStage: (stage: AnalysisStage) => void) => Promise<SystemScanResult>
  summarise: (facts: SystemScanFacts) => Promise<string>
  writeProfile: (markdown: string) => string
  writeScan: (json: string) => string
  readProfile: () => string | null
  removeProfile: () => void
  readDecision: () => SystemProfileDecision | null
  writeDecision: (decision: SystemProfileDecision) => void
  /** `provider/model` label the document header records. */
  route: string
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
 * Build one runner over the injected dependencies.
 * @param dependencies - scan, summariser, storage, and clock.
 * @returns the runner the route plugin and tests drive.
 */
export function createAnalysisRunner(dependencies: AnalysisDependencies): AnalysisRunner {
  let job: AnalysisJobView = {
    state: 'idle',
    stage: '',
    stageIndex: 0,
    stageCount: STAGE_COUNT,
    pct: 0,
    hasProfile: false,
    decision: null,
  }

  let stageIndex = 0

  const view = (): AnalysisJobView => ({
    ...job,
    hasProfile: dependencies.readProfile() !== null,
    decision: dependencies.readDecision(),
  })

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
      advance('summarising')
      const body = await dependencies.summarise(result.facts)
      advance('writing profile')
      dependencies.writeScan(JSON.stringify(result.facts, null, 2))
      const contextPath = dependencies.writeProfile([
        '# System profile',
        '',
        `_Read-only scan summarised ${new Date(dependencies.now()).toISOString()} by ${dependencies.route}. Capability-level; the raw scan facts are stored beside this document._`,
        '',
        body,
        '',
      ].join('\n'))
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
      if (job.state === 'running') return view()
      // A settled success whose document is gone (rejected, or removed by hand)
      // is no longer settled: the next start runs the analysis again.
      if (job.state === 'succeeded' && dependencies.readProfile() !== null) return view()
      stageIndex = 0
      job = {
        state: 'running',
        stage: 'hardware',
        stageIndex: 0,
        stageCount: STAGE_COUNT,
        pct: 0,
        startedAt: dependencies.now(),
        hasProfile: false,
        decision: null,
      }
      void run()
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

/** Plugin config: the route can be switched off without unloading the package. */
export interface AnalysisConfig {
  /** Register the `/system-analysis` routes. */
  routes: boolean
  /** Provider route the summariser call uses. */
  provider: string
  /** Model the summariser call uses. */
  model: string
  /** Output cap for the profile body. */
  maxTokens: number
}

/** Validated analysis-plugin configuration; the Loader resolves the row config with it. */
export const Config: z<AnalysisConfig> = z.object({
  routes: z.boolean().default(true),
  provider: z.string().default('kilo'),
  model: z.string().default('kilo-auto/free'),
  maxTokens: z.number().default(800),
})

/** Stable Cordis plugin name. */
export const name = 'first-run-analysis'

/** The analysis serves browser calls through the host web server and summarises through the LLM service. */
export const inject = ['webServer', 'llm']

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
 * @param ctx - host context carrying the web server and the LLM service.
 * @param config - route registration policy and summariser route.
 */
export function apply(ctx: Context, config: AnalysisConfig): void {
  if (!config.routes) return
  const runner = createAnalysisRunner({
    scan: onStage => runSystemScan(onStage),
    summarise: facts => summariseSystemFacts(ctx.llm, facts, {
      provider: config.provider,
      model: config.model,
      maxTokens: config.maxTokens,
    }),
    writeProfile: markdown => writeSystemProfile(markdown),
    writeScan: json => writeSystemProfileScan(json),
    readProfile: () => readSystemProfile(),
    removeProfile: () => { removeSystemProfile() },
    readDecision: () => readSystemProfileDecision(),
    writeDecision: (decision) => { writeSystemProfileDecision(decision) },
    route: `${config.provider}/${config.model}`,
    now: () => Date.now(),
  })
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: ANALYSIS_ROUTE,
    handler: (req, res) => { handleRequest(runner, req, res) },
  }), 'first-run: system-analysis routes')
  // The document path is a stable fact of this plugin; expose it for diagnostics.
  ctx.logger.debug('first-run: system profile document at %s', systemProfilePath())
}
