/**
 * The `updateCheck` profile namespace over the shared client-request envelope
 * (the same POST-per-method pattern `enpoiUiState.*` uses). The host plugin is
 * a profile plugin, so no generated Remote artifact exists on the client
 * assembly; these are the exact wire contracts its Remote methods declare.
 *
 * Every call is fail-soft: a transport or gatekeeper failure resolves to
 * `{ ok: false, message }` and never rejects.
 */

/** Check states the host reports. */
export type UpdateCheckState = 'unknown' | 'current' | 'available' | 'dismissed'

/** Newest-release summary carried by an `available` status. */
export interface UpdateCheckLatestWire {
  readonly version: string
  readonly commit: string
  readonly releasedAt: string
  readonly notes: readonly string[]
}

/** `updateCheck.status` / `updateCheck.checkNow` / `updateCheck.dismiss` reply. */
export interface UpdateCheckStatusWire {
  readonly state: UpdateCheckState
  readonly current: {
    readonly version: string
    readonly commit: string
    readonly channel: string
  }
  readonly latest?: UpdateCheckLatestWire
  readonly checkedAt?: string
  readonly error?: string
}

/** Run progress phases the host reports (`starting` precedes the first step). */
export type UpdateRunPhase =
  | 'starting'
  | 'fetch'
  | 'verify'
  | 'unpack'
  | 'deps'
  | 'profile'
  | 'switch'
  | 'selfcheck'
  | 'done'
  | 'failed'
  | 'rolledback'

/** Terminal run outcomes. */
export type UpdateRunResult = 'success' | 'failed' | 'rolledback'

/** `updateCheck.run` / `updateCheck.start` record. */
export interface UpdateRunWire {
  readonly runId: string
  readonly target: string
  readonly channel: string
  readonly phase: UpdateRunPhase
  readonly step: number
  readonly steps: number
  readonly lastLine: string
  readonly startedAt: string
  readonly pid: number | null
  readonly logPath: string
  readonly result: UpdateRunResult | null
  readonly rung: string
  readonly logTail: readonly string[]
  readonly finishedAt?: string
  readonly reason?: string
}

/** One call's outcome: the business value, or a displayable failure message. */
export type UpdateRpcResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly message: string }

let sequence = 0

/**
 * One `updateCheck.*` call over the gateway's client-request envelope.
 *
 * @param method - remote endpoint, e.g. `updateCheck.status`.
 * @param args - exact named wire arguments (empty for the no-argument methods).
 * @param fetchImpl - fetch implementation (tests inject a stub).
 * @returns the business value or a displayable failure message.
 */
export async function updateCheckRpc<T>(
  method: string,
  args: Record<string, unknown>,
  fetchImpl: typeof fetch = fetch,
): Promise<UpdateRpcResult<T>> {
  sequence += 1
  try {
    const response = await fetchImpl(`/api/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request',
        method,
        rpcId: `${method}-${String(sequence)}`,
        payload: { args },
      }),
    })
    if (!response.ok) return { ok: false, message: `gateway responded ${String(response.status)}` }
    const json = await response.json() as {
      result?: { ok?: boolean; value?: unknown; error?: { message?: unknown } }
    }
    const result = json.result
    if (result?.ok !== true) {
      const message = result?.error?.message
      return { ok: false, message: typeof message === 'string' && message !== '' ? message : 'update request was rejected' }
    }
    return { ok: true, value: result.value as T }
  } catch (error: unknown) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}
