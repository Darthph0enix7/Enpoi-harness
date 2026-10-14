/**
 * The `updateCheck` profile namespace over the shared client-request envelope
 * (the same POST-per-method pattern `enpoiUiState.*` uses). The host plugin is
 * a profile plugin, so no generated Remote artifact exists on the client
 * assembly; these are the exact wire contracts its Remote methods declare.
 *
 * The envelope's `payload.args` carries the descriptor's **named parameters**,
 * keyed by the parameter name — not the request fields. The current
 * descriptors and their exact arg shapes:
 *
 * | endpoint              | host signature                     | `payload.args` |
 * |-----------------------|------------------------------------|----------------|
 * | `updateCheck.status`  | `status()`                         | `{}` |
 * | `updateCheck.checkNow`| `checkNow()`                       | `{}` |
 * | `updateCheck.dismiss` | `dismiss(request: {version})`      | `{request: {version}}` |
 * | `updateCheck.start`   | `start()`                          | `{}` |
 * | `updateCheck.apply`   | `apply()`                          | `{}` |
 * | `updateCheck.run`     | `run()`                            | `{}` |
 * | `updateCheck.cancel`  | `cancel()`                         | `{}` |
 * | `updateCheck.clearStale` | `clearStale()`                  | `{}` |
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

/** Run phases the host reports (the two-phase contract). */
export type UpdateRunPhase =
  | 'starting'
  | 'preparing'
  | 'prepared'
  | 'applying'
  | 'success'
  | 'failed'
  | 'rolledback'
  | 'cancelled'

/** Terminal run outcomes. */
export type UpdateRunResult = 'success' | 'failed' | 'rolledback' | 'cancelled'

/** The engine invocation a run drives. */
export type UpdateRunMode = 'prepare' | 'apply' | 'one-shot'

/** Which engine generation a run targets (one-shot updates restart mid-run). */
export type UpdateRung = 'two-phase' | 'one-shot'

/** `updateCheck.run` / `updateCheck.start` / `updateCheck.apply` record. */
export interface UpdateRunWire {
  readonly runId: string
  readonly target: string
  readonly channel: string
  readonly mode: UpdateRunMode
  /** Which engine generation the run targets; a one-shot run never prepares. */
  readonly rung: UpdateRung
  readonly phase: UpdateRunPhase
  readonly step: number
  readonly steps: number
  readonly lastLine: string
  readonly startedAt: string
  readonly pid: number | null
  readonly logPath: string
  readonly result: UpdateRunResult | null
  /** OS launcher rung (`systemd-run|launchctl|setsid|spawn`). */
  readonly launcher: string
  /**
   * Whether a complete staged update is ready to apply: the engine's
   * staged-apply record exists AND names a tree with its
   * `.dsh-install-complete` witness. False after a rollback archived the tree,
   * so Retry re-prepares instead of replaying apply against a dead tree.
   */
  readonly staged: boolean
  readonly logTail: readonly string[]
  readonly finishedAt?: string
  readonly reason?: string
  /** True when the host synthesized this record from a run started outside the UI. */
  readonly observed?: boolean
}

/** One engine-cancel attempt's outcome (`updateCheck/cancel`). */
export interface UpdateCancelOutcomeWire {
  /** `cancelled` (runner stopped) / `refused` (past the switch) / `noop` (nothing live) / `failed`. */
  readonly status: 'cancelled' | 'refused' | 'noop' | 'failed'
  /** Human message: the engine's own words, or the local failure reason. */
  readonly message: string
  /** The record after the attempt. */
  readonly record: UpdateRunWire | null
}

/** One call's outcome: the business value, or a displayable failure message. */
export type UpdateRpcResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly message: string }

/** Exact `payload.args` shapes the descriptors accept (see the module table). */
export type UpdateRpcArgs =
  | Record<string, never>
  | { readonly request: { readonly version: string } }

/** Whether a run phase means the engine process is working. */
export function isExecutingPhase(phase: UpdateRunPhase): boolean {
  return phase === 'starting' || phase === 'preparing' || phase === 'applying'
}

/** The engine step where the apply's switch (and its service restart) begins. */
export const APPLY_SWITCH_STEP = 8

let sequence = 0

/**
 * One `updateCheck.*` call over the gateway's client-request envelope.
 *
 * @param method - remote endpoint, e.g. `updateCheck.status`.
 * @param args - exact named wire arguments (the descriptor's parameter names).
 * @param fetchImpl - fetch implementation (tests inject a stub).
 * @returns the business value or a displayable failure message.
 */
export async function updateCheckRpc<T>(
  method: string,
  args: UpdateRpcArgs,
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
