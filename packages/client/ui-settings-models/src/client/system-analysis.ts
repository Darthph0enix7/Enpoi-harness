/**
 * Client half of the host `/system-analysis` routes and the frame-wide chip
 * store. The wire is validated at this boundary: a response that is not the
 * expected envelope becomes a displayable failure message, never an exception
 * in the chip. The store auto-starts the analysis on a machine that has no
 * profile and no recorded rejection, follows the run, and carries the
 * accept/reject decision.
 * @module ui-settings-models/system-analysis
 */

import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'

/** One analysis run as the chip renders it. */
export interface SystemAnalysisView {
  state: 'idle' | 'running' | 'succeeded' | 'failed'
  stage: string
  stageIndex: number
  stageCount: number
  pct: number
  error?: string
  /** Whether a profile document is stored right now. */
  hasProfile: boolean
  /** The operator's recorded decision, or null when none was recorded. */
  decision: 'accepted' | 'rejected' | null
}

/** Why one analysis call failed, before the chip localizes it. */
export type SystemAnalysisFailure =
  /** The route answered a non-OK status. */
  | { kind: 'service'; status: number }
  /** The route answered `ok: false` with an optional host diagnostic. */
  | { kind: 'rejected'; message?: string }
  /** The route answered a payload this client does not understand. */
  | { kind: 'payload' }
  /** The request itself failed (network, abort). */
  | { kind: 'transport'; message: string }

/** One RPC outcome at this module's wire boundary. */
export type SystemAnalysisRpcResult<T> = { ok: true; value: T } | { ok: false; failure: SystemAnalysisFailure }

/** The host calls the chip makes. */
export interface SystemAnalysisApi {
  start: () => Promise<SystemAnalysisRpcResult<SystemAnalysisView>>
  status: () => Promise<SystemAnalysisRpcResult<SystemAnalysisView>>
  context: () => Promise<SystemAnalysisRpcResult<string | null>>
  accept: () => Promise<SystemAnalysisRpcResult<SystemAnalysisView>>
  reject: () => Promise<SystemAnalysisRpcResult<SystemAnalysisView>>
}

/** Snapshot rendered by the chip. */
export interface SystemAnalysisState {
  /** Hidden until a run is live, a profile awaits a decision, or a run failed. */
  phase: 'hidden' | 'running' | 'ready' | 'failed'
  stage: string
  stageIndex: number
  stageCount: number
  pct: number
  /** Dynamic failure reason (a host diagnostic or a transport error), or null. */
  error: string | null
  /** Static failure kind the chip localizes; null when `error` carries the reason. */
  errorCode: 'service' | 'rejected' | 'payload' | null
  /** Whether the results panel is open. */
  open: boolean
  /** Stored profile text once the panel fetched it. */
  text: string | null
  /** A decision write is in flight. */
  busy: boolean
}

/** How often the chip polls a running analysis. */
const POLL_MS = 300

/** Parse an analysis job payload, dropping unknown fields. */
function parseJob(value: unknown): SystemAnalysisView | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const job = value as Record<string, unknown>
  const state = job.state
  if (state !== 'idle' && state !== 'running' && state !== 'succeeded' && state !== 'failed') return undefined
  const decision = job.decision
  return {
    state,
    stage: typeof job.stage === 'string' ? job.stage : '',
    stageIndex: typeof job.stageIndex === 'number' ? job.stageIndex : 0,
    stageCount: typeof job.stageCount === 'number' ? job.stageCount : 0,
    pct: typeof job.pct === 'number' ? job.pct : 0,
    hasProfile: job.hasProfile === true,
    decision: decision === 'accepted' || decision === 'rejected' ? decision : null,
    ...typeof job.error === 'string' ? { error: job.error } : {},
  }
}

/**
 * Call one analysis route.
 * @param path - route suffix.
 * @returns the parsed job, or a classified failure.
 */
async function call(path: 'start' | 'status' | 'accept' | 'reject'): Promise<SystemAnalysisRpcResult<SystemAnalysisView>> {
  try {
    const response = await fetch(`/system-analysis/${path}`, {
      method: path === 'status' ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json' },
    })
    if (!response.ok) return { ok: false, failure: { kind: 'service', status: response.status } }
    const body = await response.json() as { ok?: unknown; job?: unknown; message?: unknown }
    if (body.ok !== true) {
      return { ok: false, failure: { kind: 'rejected', ...typeof body.message === 'string' ? { message: body.message } : {} } }
    }
    const job = parseJob(body.job)
    return job === undefined
      ? { ok: false, failure: { kind: 'payload' } }
      : { ok: true, value: job }
  } catch (error) {
    return { ok: false, failure: { kind: 'transport', message: error instanceof Error ? error.message : String(error) } }
  }
}

/**
 * Read the stored profile document.
 * @returns the document text (null before a successful run), or a classified failure.
 */
async function readContext(): Promise<SystemAnalysisRpcResult<string | null>> {
  try {
    const response = await fetch('/system-analysis/context', { method: 'GET' })
    if (!response.ok) return { ok: false, failure: { kind: 'service', status: response.status } }
    const body = await response.json() as { ok?: unknown; text?: unknown; message?: unknown }
    if (body.ok !== true) {
      return { ok: false, failure: { kind: 'rejected', ...typeof body.message === 'string' ? { message: body.message } : {} } }
    }
    return { ok: true, value: typeof body.text === 'string' ? body.text : null }
  } catch (error) {
    return { ok: false, failure: { kind: 'transport', message: error instanceof Error ? error.message : String(error) } }
  }
}

/** The host analysis calls the chip makes. */
export const systemAnalysisApi: SystemAnalysisApi = {
  start: () => call('start'),
  status: () => call('status'),
  context: () => readContext(),
  accept: () => call('accept'),
  reject: () => call('reject'),
}

/** Coordinates the chip's auto-start, poll, and decision. */
export class SystemAnalysisStore {
  /** uSES-safe state source the chip renders from. */
  readonly store: SnapshotStore<SystemAnalysisState> = createSnapshotStore<SystemAnalysisState>({
    phase: 'hidden',
    stage: '',
    stageIndex: 0,
    stageCount: 0,
    pct: 0,
    error: null,
    errorCode: null,
    open: false,
    text: null,
    busy: false,
  })

  private poll: ReturnType<typeof setInterval> | undefined

  /** @param api - the host analysis calls. */
  constructor(private readonly api: SystemAnalysisApi) {}

  /**
   * Read the current state and auto-start the analysis when this machine has
   * no profile and no recorded rejection.
   * @returns settlement after the first status answer is applied.
   */
  async load(): Promise<void> {
    const result = await this.api.status()
    if (!result.ok) {
      this.fail(result.failure)
      return
    }
    this.apply(result.value)
    // A machine with no stored profile and no recorded rejection starts the
    // analysis; a live or failed run keeps its own chip instead.
    if (!result.value.hasProfile && result.value.decision !== 'rejected'
      && result.value.state !== 'running' && result.value.state !== 'failed') {
      await this.start()
    }
  }

  /** Start the run, or adopt the one already in flight. */
  async start(): Promise<void> {
    const result = await this.api.start()
    if (!result.ok) {
      this.fail(result.failure)
      return
    }
    this.apply(result.value)
    if (result.value.state === 'running') this.follow()
  }

  /** Fetch the stored document and open the results panel. */
  async open(): Promise<void> {
    const result = await this.api.context()
    if (!result.ok) {
      this.fail(result.failure)
      return
    }
    this.store.update((state) => {
      state.open = true
      state.text = result.value
    })
  }

  /** Keep the document and record the acceptance. */
  async accept(): Promise<void> {
    await this.decide('accept')
  }

  /** Remove the document, record the rejection, and fall back to the default prompt. */
  async reject(): Promise<void> {
    await this.decide('reject')
  }

  /** Dismiss the open panel by accepting; a closed chip is left alone. */
  async dismiss(): Promise<void> {
    if (!this.store.getSnapshot().open) return
    await this.accept()
  }

  /** Retry a failed run. */
  async retry(): Promise<void> {
    await this.start()
  }

  /** Stop following a running analysis. */
  dispose(): void {
    if (this.poll !== undefined) clearInterval(this.poll)
    this.poll = undefined
  }

  private async decide(action: 'accept' | 'reject'): Promise<void> {
    this.store.update((state) => { state.busy = true })
    const result = action === 'accept' ? await this.api.accept() : await this.api.reject()
    this.store.update((state) => { state.busy = false })
    if (!result.ok) {
      this.fail(result.failure)
      return
    }
    this.store.update((state) => {
      state.phase = 'hidden'
      state.open = false
      state.text = null
      state.error = null
    })
  }

  private apply(view: SystemAnalysisView): void {
    this.store.update((state) => {
      state.stage = view.stage
      state.stageIndex = view.stageIndex
      state.stageCount = view.stageCount
      state.pct = view.pct
      state.error = view.error ?? null
      state.errorCode = null
      if (view.state === 'running') {
        state.phase = 'running'
        state.open = false
        state.text = null
        return
      }
      if (view.state === 'failed') {
        state.phase = 'failed'
        state.open = false
        return
      }
      if (view.state === 'succeeded') {
        state.phase = view.hasProfile ? 'ready' : 'hidden'
        return
      }
      state.phase = view.hasProfile && view.decision === null ? 'ready' : 'hidden'
    })
  }

  private fail(failure: SystemAnalysisFailure): void {
    this.store.update((state) => {
      state.phase = 'failed'
      state.open = false
      if (failure.kind === 'transport') {
        state.error = failure.message
        state.errorCode = null
        return
      }
      state.error = failure.kind === 'rejected' ? failure.message ?? null : null
      state.errorCode = failure.kind
    })
  }

  private follow(): void {
    if (this.poll !== undefined) return
    this.poll = setInterval(() => {
      void this.api.status().then((result) => {
        if (!result.ok) return
        this.apply(result.value)
        if (result.value.state !== 'running' && this.poll !== undefined) {
          clearInterval(this.poll)
          this.poll = undefined
        }
      })
    }, POLL_MS)
  }
}
