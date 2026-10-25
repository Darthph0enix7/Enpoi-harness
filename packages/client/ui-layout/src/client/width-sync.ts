/**
 * Host durability for the frame's column widths.
 *
 * The local cache in `stores.ts` is per origin, and the operator reaches the
 * same harness through several (a tailnet address, its DNS name, a tunnel
 * URL), so a width dragged on one origin did not exist on another — the panel
 * kept "forgetting" a resize whenever the entry URL changed. The
 * `enpoiUiState.layout` record is the host-side authority: one record for the
 * harness, because the width is the operator's preference for this host, not
 * a per-session fact. The local record stays the synchronous first-paint
 * cache and yields to the host record once that read settles.
 */
import type { HostLayoutWidths, LayoutWidths } from './stores.ts'

/** The `enpoiUiState` Remote namespace (its session record is the sibling feature). */
const NAMESPACE = 'enpoiUiState'

/** Quiet window after a gesture before the host hears about it; a drag collapses into one write. */
const PUSH_DELAY_MS = 500

/** Wire shape of the host's layout record. */
interface HostLayoutRecord {
  sidebar?: unknown
  rightbar?: unknown
  updatedAt?: unknown
}

/** One `enpoiUiState.*` call's outcome. */
type UiStateResult<T> = { ok: true; value: T } | { ok: false; message: string }

/** Whether a wire value is a JSON object rather than an array or a primitive. */
function isWireRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/* jscpd:ignore-start -- the fork's enpoi namespaces share this envelope caller,
 * and cross-plugin value imports are forbidden, so each half carries its copy. */
let uiStateSeq = 0

/**
 * One `enpoiUiState.*` call over the shared client-request envelope, the same
 * POST-per-method pattern the session-record and draft mirrors use.
 * @param method - remote endpoint (`enpoiUiState.getLayout`, `enpoiUiState.putLayout`).
 * @param args - exact named wire arguments.
 * @returns the business value or a displayable failure message.
 */
async function uiStateRpc<T>(method: string, args: Record<string, unknown>): Promise<UiStateResult<T>> {
  try {
    const response = await fetch(`/api/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request',
        method,
        rpcId: `${method}-${uiStateSeq += 1}`,
        payload: { args },
      }),
    })
    if (!response.ok) return { ok: false, message: `gateway responded ${response.status}` }
    const json = await response.json() as {
      result?: { ok?: boolean; value?: unknown; error?: { message?: unknown } }
    }
    const result = json.result
    if (result?.ok !== true) {
      const message = result?.error?.message
      return { ok: false, message: typeof message === 'string' && message !== '' ? message : 'ui state request was rejected' }
    }
    return { ok: true, value: result.value as T }
  } catch (error: unknown) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}
/* jscpd:ignore-end */

/**
 * Validate one host layout response. `{ updatedAt: 0 }` is the service's
 * "nothing stored" answer, so an equal-or-earlier stamp carries no preference.
 * @param value - the raw `enpoiUiState.getLayout` value.
 * @returns the adopted widths (the right panel member only when the host has
 *   one), or null when the host holds nothing usable.
 */
export function readHostWidths(value: unknown): HostLayoutWidths | null {
  if (!isWireRecord(value)) return null
  const record = value as HostLayoutRecord
  const updatedAt = record.updatedAt
  if (typeof updatedAt !== 'number' || !Number.isFinite(updatedAt) || updatedAt <= 0) return null
  const sidebar = record.sidebar
  if (typeof sidebar !== 'number' || !Number.isFinite(sidebar) || sidebar < 0) return null
  const rightbar = record.rightbar
  if (rightbar === undefined) return { sidebar }
  if (!isWireRecord(rightbar)) return null
  const { px, ratio } = rightbar
  if (typeof px !== 'number' || !Number.isFinite(px) || px <= 0) return null
  if (typeof ratio !== 'number' || !Number.isFinite(ratio) || ratio <= 0 || ratio > 1) return null
  return { sidebar, rightbar: { px, ratio } }
}

/** The two faces the layout plugin wires into the store and its teardown. */
export interface HostWidthSync {
  /**
   * Mirror one committed width record after the quiet window.
   * @param widths - the committed record.
   */
  mirror(widths: LayoutWidths): void
  /**
   * Hand the host's record to the store once it arrives. A failed read leaves
   * the local cache in force; the next gesture still pushes.
   * @param adopt - store action applying the record.
   */
  hydrate(adopt: (widths: HostLayoutWidths) => void): void
  /** Cancel pending work when the plugin unloads. */
  dispose(): void
}

/**
 * Create the host mirror for the column widths.
 * @returns the sync faces; every network failure is silent except one log line.
 */
export function createHostWidthSync(): HostWidthSync {
  let disposed = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let pending: LayoutWidths | undefined
  let lastPushed = ''
  let failureLogged = false

  const push = (next: LayoutWidths): void => {
    // A client with no right panel drag sends only the sidebar, so a host
    // record written from another device keeps its right width.
    const wire: HostLayoutWidths = next.rightbar === null
      ? { sidebar: next.sidebar }
      : { sidebar: next.sidebar, rightbar: next.rightbar }
    const json = JSON.stringify(wire)
    if (json === lastPushed) return
    void uiStateRpc<unknown>(`${NAMESPACE}.putLayout`, { widths: wire }).then((result) => {
      if (disposed) return
      if (!result.ok) {
        if (!failureLogged) {
          failureLogged = true
          console.error(`enpoiUiState.putLayout failed: ${result.message}`)
        }
        return
      }
      failureLogged = false
      lastPushed = json
    })
  }

  return {
    mirror: (widths) => {
      if (disposed) return
      pending = widths
      if (timer !== undefined) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = undefined
        const next = pending
        pending = undefined
        if (next !== undefined) push(next)
      }, PUSH_DELAY_MS)
    },
    hydrate: (adopt) => {
      if (typeof fetch !== 'function') return
      void uiStateRpc<unknown>(`${NAMESPACE}.getLayout`, {}).then((result) => {
        if (disposed || !result.ok) return
        const widths = readHostWidths(result.value)
        if (widths === null) return
        // A record equal to what this page last pushed proves nothing new; the
        // store already holds it and adopting would only rewrite the cache.
        const json = JSON.stringify(widths)
        if (json === lastPushed) return
        lastPushed = json
        adopt(widths)
      })
    },
    dispose: () => {
      disposed = true
      if (timer !== undefined) clearTimeout(timer)
      timer = undefined
      pending = undefined
    },
  }
}
