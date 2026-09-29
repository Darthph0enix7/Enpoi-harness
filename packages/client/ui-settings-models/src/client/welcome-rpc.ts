/**
 * Client half of the host `/system-analysis` routes. The wire is validated at
 * this boundary: a response that is not the expected envelope becomes a
 * displayable failure message, never an exception in the wizard.
 * @module ui-settings-models/welcome-rpc
 */

import type { WizardAnalysisApi, WizardAnalysisView, WizardRpcResult } from './welcome-wizard.ts'

/** Parse an analysis job payload, dropping unknown fields. */
function parseJob(value: unknown): WizardAnalysisView | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const job = value as Record<string, unknown>
  const state = job.state
  if (state !== 'idle' && state !== 'running' && state !== 'succeeded' && state !== 'failed') return undefined
  return {
    state,
    stage: typeof job.stage === 'string' ? job.stage : '',
    stageIndex: typeof job.stageIndex === 'number' ? job.stageIndex : 0,
    stageCount: typeof job.stageCount === 'number' ? job.stageCount : 0,
    pct: typeof job.pct === 'number' ? job.pct : 0,
    ...typeof job.error === 'string' ? { error: job.error } : {},
  }
}

/**
 * Call one analysis route.
 * @param path - route suffix (`start` or `status`).
 * @returns the parsed job, or a displayable failure message.
 */
async function call(path: 'start' | 'status'): Promise<WizardRpcResult<WizardAnalysisView>> {
  try {
    const response = await fetch(`/system-analysis/${path}`, {
      method: path === 'start' ? 'POST' : 'GET',
      headers: { 'Content-Type': 'application/json' },
    })
    if (!response.ok) return { ok: false, message: `analysis service responded ${String(response.status)}` }
    const body = await response.json() as { ok?: unknown; job?: unknown; message?: unknown }
    if (body.ok !== true) {
      return { ok: false, message: typeof body.message === 'string' ? body.message : 'the analysis request was rejected' }
    }
    const job = parseJob(body.job)
    return job === undefined
      ? { ok: false, message: 'the analysis service returned an unexpected payload' }
      : { ok: true, value: job }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}

/** The host analysis calls the wizard makes. */
export const analysisApi: WizardAnalysisApi = {
  start: () => call('start'),
  status: () => call('status'),
}
