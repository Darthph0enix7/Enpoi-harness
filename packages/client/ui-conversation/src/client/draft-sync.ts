/**
 * Server-backed draft sync for the per-session Conversation store.
 *
 * The store's own persistence stays the synchronous source — a draft rehydrates
 * and renders from localStorage before any request — while this binding mirrors
 * each change to the `enpoiUiState` namespace and adopts the server's copy when
 * it is newer. Ordering is last-write-wins by the record's own revision time, so
 * a stale local draft never overwrites a newer server one and an equal timestamp
 * keeps local. Everything here is best-effort: a failed call only skips the
 * mirror, never the store, and logs once until a call succeeds.
 */
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'

/** The store instance face draft sync reads and writes. */
export interface DraftSyncTarget {
  getSnapshot(): { readonly draft: string }
  readonly actions: { setDraft(text: string): void }
  subscribe(listener: () => void): () => void
}

/** One device's draft record as the server carries it. */
interface DraftRecord {
  readonly text: string
  readonly updatedAt: number
  readonly clientId: string
}

/** Storage key prefix for the draft record's revision time; the draft text itself lives in the store's own entry. */
const DRAFT_SYNC_KEY = 'dsh.conversation.draft-sync.v1'

/** How long a change waits before it reaches the server; a burst of keystrokes collapses into one push. */
const PUSH_DELAY_MS = 600

/** This tab's identity, minted once on first use. */
let tabClientId: string | undefined

/** The per-tab client id every record this tab writes carries. */
function clientId(): string {
  tabClientId ??= randomUUID()
  return tabClientId
}

/** Whether a wire value is a JSON object rather than an array or a primitive. */
function isWireRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/* jscpd:ignore-start -- the fork's enpoi namespaces share this envelope caller,
 * and cross-plugin value imports are forbidden, so each half carries its copy. */
/** One `enpoiUiState.*` call's outcome. */
type UiStateResult<T> = { ok: true; value: T } | { ok: false; message: string }

let uiStateSeq = 0

/**
 * One `enpoiUiState.*` call over the shared client-request envelope, the same
 * POST-per-method pattern `/api/enpoiGit.*` uses.
 * @param method - remote endpoint (`enpoiUiState.get`, `enpoiUiState.put`).
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

/** The local revision record, which must agree with the store's persisted draft to be trusted. */
function readRecord(sessionId: string, text: string): DraftRecord | undefined {
  if (typeof localStorage === 'undefined') return undefined
  let raw: string | null
  try { raw = localStorage.getItem(`${DRAFT_SYNC_KEY}.${sessionId}`) }
  catch (_storageUnavailable) { return undefined }
  if (raw === null) return undefined
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!isWireRecord(parsed)) return undefined
    const { text: storedText, updatedAt, clientId: storedClient } = parsed
    // A record that disagrees with the store proves nothing: treat the local
    // draft as having no revision time, so the server's record wins.
    if (typeof storedText !== 'string' || storedText !== text) return undefined
    if (typeof updatedAt !== 'number' || !Number.isFinite(updatedAt) || updatedAt <= 0) return undefined
    return {
      text,
      updatedAt: Math.floor(updatedAt),
      clientId: typeof storedClient === 'string' ? storedClient : clientId(),
    }
  } catch (_invalidRecord) {
    return undefined
  }
}

/** Persist one session's revision record; failures leave the store untouched. */
function writeRecord(sessionId: string, record: DraftRecord): void {
  if (typeof localStorage === 'undefined') return
  try { localStorage.setItem(`${DRAFT_SYNC_KEY}.${sessionId}`, JSON.stringify(record)) }
  catch (_storageUnavailable) { /* The store's own 0ms cache still holds the draft. */ }
}

/**
 * Drop one session's revision record; the store's persisted value is cleared separately.
 * @param sessionId - the session being dropped.
 */
export function clearDraftSync(sessionId: string): void {
  if (typeof localStorage === 'undefined') return
  try { localStorage.removeItem(`${DRAFT_SYNC_KEY}.${sessionId}`) }
  catch (_storageUnavailable) { /* The stale record merely loses its next comparison. */ }
}

/** The `enpoiUiState.get` draft, or `undefined` when the record holds none. */
function remoteDraft(value: unknown): DraftRecord | undefined {
  if (!isWireRecord(value) || !isWireRecord(value.draft)) return undefined
  const { text, updatedAt, clientId: storedClient } = value.draft
  if (typeof text !== 'string') return undefined
  if (typeof updatedAt !== 'number' || !Number.isFinite(updatedAt) || updatedAt <= 0) return undefined
  return { text, updatedAt: Math.floor(updatedAt), clientId: typeof storedClient === 'string' ? storedClient : clientId() }
}

/**
 * Mirror one session's draft to the server and adopt a newer server draft.
 *
 * A failed read leaves the session local-only, silently: without the server's
 * record there is no honest ordering, so a blind push could overwrite a newer
 * remote draft. A failed write only skips that attempt — the local store is
 * never touched, one log line marks the first failure, and the next change
 * retries.
 *
 * Call once per live store instance, at its creation. The binding returns a
 * stop that cancels its pending push.
 * @param instance - the session's store instance.
 * @param sessionId - the session whose draft this instance holds.
 * @returns a stop for the binding's pending push.
 */
export function bindDraftSync(instance: DraftSyncTarget, sessionId: string): () => void {
  if (typeof localStorage === 'undefined' || typeof fetch !== 'function') return () => {}
  let stopped = false
  let adopting = false
  let readFailed = false
  let readComplete = false
  let failureLogged = false
  let lastPushedUpdatedAt = -1
  let pushTimer: ReturnType<typeof setTimeout> | undefined
  let pending: DraftRecord | undefined
  let local = readRecord(sessionId, instance.getSnapshot().draft)
    ?? { text: instance.getSnapshot().draft, updatedAt: 0, clientId: clientId() }

  const push = (): void => {
    const next = pending
    pending = undefined
    if (stopped || next === undefined || next.updatedAt <= lastPushedUpdatedAt) return
    void uiStateRpc<unknown>('enpoiUiState.put', { sessionId, patch: { draft: next } })
      .then((result) => {
        if (stopped) return
        if (!result.ok) {
          if (!failureLogged) {
            failureLogged = true
            console.error(`enpoiUiState.put (draft) failed for session "${sessionId}": ${result.message}`)
          }
          return
        }
        failureLogged = false
        // A response may settle out of order; the highest revision stays pushed.
        lastPushedUpdatedAt = Math.max(lastPushedUpdatedAt, next.updatedAt)
      })
  }

  const mirror = (record: DraftRecord): void => {
    if (readFailed) return
    pending = record
    if (pushTimer !== undefined) clearTimeout(pushTimer)
    pushTimer = setTimeout(() => {
      pushTimer = undefined
      // The read is still in flight; its handler flushes what is pending.
      if (readComplete) push()
    }, PUSH_DELAY_MS)
  }

  const unsubscribe = instance.subscribe(() => {
    if (stopped || adopting) return
    const text = instance.getSnapshot().draft
    if (text === local.text) return
    local = { text, updatedAt: Date.now(), clientId: local.clientId }
    writeRecord(sessionId, local)
    mirror(local)
  })

  void uiStateRpc<unknown>('enpoiUiState.get', { sessionId }).then((result) => {
    if (stopped) return
    if (!result.ok) {
      readFailed = true
      pending = undefined
      return
    }
    readComplete = true
    // A local change since attach is newer than the fetched record; its own
    // mirror follows, so adoption would only undo the operator's typing.
    if (pending !== undefined) {
      push()
      return
    }
    const remote = remoteDraft(result.value)
    if (remote === undefined && local.updatedAt === 0 && local.text !== '') {
      // A draft from before the mirror existed carries no revision time; give
      // it one so it can seed the server and order future merges.
      local = { text: local.text, updatedAt: Date.now(), clientId: local.clientId }
      writeRecord(sessionId, local)
    }
    if (remote !== undefined && remote.updatedAt > local.updatedAt) {
      adopting = true
      local = remote
      writeRecord(sessionId, remote)
      lastPushedUpdatedAt = Math.max(lastPushedUpdatedAt, remote.updatedAt)
      instance.actions.setDraft(remote.text)
      adopting = false
      return
    }
    // Local is newer (or the server has nothing): seed the server from here.
    if (local.updatedAt > (remote?.updatedAt ?? 0)) {
      pending = local
      push()
    }
  })

  return () => {
    stopped = true
    if (pushTimer !== undefined) clearTimeout(pushTimer)
    pushTimer = undefined
    pending = undefined
    unsubscribe()
  }
}
