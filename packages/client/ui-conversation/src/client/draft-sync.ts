/**
 * Server-backed draft sync for the per-session Conversation store.
 *
 * The store's own persistence stays the synchronous source — a draft rehydrates
 * and renders from localStorage before any request — while this binding mirrors
 * each change to the `enpoiUiState` namespace under conditional server revisions
 * and adopts the server's winning copy when newer. Pushes serialize per binding
 * so at most one `enpoiUiState.put` is in flight; on conflict the binding adopts
 * a newer remote winner or rebases an active local edit onto the winner's
 * revision without dropping keystrokes. Truncated attachment lists carry an
 * explicit incomplete marker to adopting devices. Everything here is best-effort:
 * a failed transport call skips the mirror, never the store, and logs once
 * until a call succeeds.
 */
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import type { AttachmentId, ImageAttachmentRef, ImageMediaType } from '@deepseek-ai/dsh-attachment'
import type { RestoredDraftAttachment } from './contract/input.ts'

/** The store instance face draft sync reads and writes. */
export interface DraftSyncTarget {
  getSnapshot(): {
    readonly draft: string
    readonly draftAttachments?: readonly RestoredDraftAttachment[] | undefined
    readonly draftAttachmentsIncomplete?: boolean | undefined
  }
  readonly actions: {
    setDraft(text: string, attachments?: readonly RestoredDraftAttachment[], incomplete?: boolean): void
  }
  subscribe(listener: () => void): () => void
}

/** One device's draft record as stored locally and transmitted on the wire. */
interface DraftRecord {
  readonly text: string
  /** Durable restored attachments; absent for text-only drafts and older records. */
  readonly attachments?: readonly RestoredDraftAttachment[]
  /** True when {@link attachments} was truncated at the server record cap. */
  readonly incompleteAttachments?: boolean
  readonly updatedAt: number
  readonly clientId: string
  /** Last server-owned revision observed or written by this device (local cache only). */
  readonly serverRevision?: number
  /** Whether local edits exist that have not yet been acknowledged at {@link serverRevision}. */
  readonly dirty?: boolean
}

/** Wire payload of `patch.draft` accepted by `enpoiUiState.put`. */
interface WireDraft {
  readonly text: string
  readonly attachments?: readonly RestoredDraftAttachment[]
  readonly incompleteAttachments?: boolean
  readonly updatedAt: number
  readonly clientId: string
}

/** Storage key prefix for the draft record's revision metadata; draft text lives in the store's own entry. */
const DRAFT_SYNC_KEY = 'dsh.conversation.draft-sync.v1'

/** How long a change waits before it reaches the server; a burst of keystrokes collapses into one push. */
const PUSH_DELAY_MS = 600

/**
 * Server draft contract for restored attachments (`enpoiUiState` rejects a
 * larger record wholesale, losing the text too). A push keeps the text,
 * sends only the references that fit these bounds, and marks the wire record
 * incomplete when references were dropped.
 */
const MAX_WIRE_ATTACHMENTS = 256
const MAX_WIRE_ATTACHMENTS_JSON_CHARS = 256_000

/** Optional binding callbacks. */
export interface DraftSyncOptions {
  /** Called at most once per binding when a push drops references beyond the server record cap. */
  onAttachmentOverflow?: (() => void) | undefined
}

/** One wire record with its attachment list bounded to the server contract. */
function boundedRecord(record: DraftRecord): { readonly record: WireDraft; readonly dropped: number } {
  const attachments = record.attachments ?? []
  const base: WireDraft = {
    text: record.text,
    ...(record.attachments !== undefined ? { attachments: record.attachments } : {}),
    ...(record.incompleteAttachments === true ? { incompleteAttachments: true } : {}),
    updatedAt: record.updatedAt,
    clientId: record.clientId,
  }
  if (attachments.length === 0) return { record: base, dropped: 0 }
  let kept = attachments.slice(0, MAX_WIRE_ATTACHMENTS)
  while (kept.length > 0 && JSON.stringify(kept).length > MAX_WIRE_ATTACHMENTS_JSON_CHARS) {
    kept = kept.slice(0, -1)
  }
  if (kept.length === attachments.length) return { record: base, dropped: 0 }
  return {
    record: {
      text: record.text,
      attachments: kept,
      incompleteAttachments: true,
      updatedAt: record.updatedAt,
      clientId: record.clientId,
    },
    dropped: attachments.length - kept.length,
  }
}

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

/** Whether a stored media-type string is one the image attachment vocabulary accepts. */
function isImageMediaType(value: string): value is ImageMediaType {
  return value === 'image/png' || value === 'image/jpeg' || value === 'image/webp' || value === 'image/gif'
}

/** Whether a value is a non-negative finite number. */
function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

/** Non-negative integer revision from a server record or response, when present. */
function readRevision(value: unknown): number | undefined {
  if (!isWireRecord(value)) return undefined
  const rev = value.revision
  return typeof rev === 'number' && Number.isInteger(rev) && rev >= 0 ? rev : undefined
}

/** Conflict descriptor returned by `enpoiUiState.put` when a conditional write lost a revision race. */
function parsePutConflict(value: unknown): {
  readonly revision: number | undefined
  readonly record: Record<string, unknown> | undefined
} | undefined {
  if (!isWireRecord(value) || value.ok !== false || value.conflict !== true) return undefined
  return {
    revision: readRevision(value),
    record: isWireRecord(value.record) ? value.record : undefined,
  }
}

/**
 * Validate one persisted restored attachment. The reference only drives the
 * composer chip and the prompt citation; the Host canonicalizes it from the
 * Session log at send, so the accepted structure is what the chip renders.
 * @param value - one stored attachment entry.
 * @returns the typed reference, or undefined when the entry is malformed.
 */
function restoredAttachmentOf(value: unknown): RestoredDraftAttachment | undefined {
  if (!isWireRecord(value) || !isWireRecord(value.attachment)) return undefined
  const attachment = value.attachment
  const attachmentId = attachment.attachmentId
  if (typeof attachmentId !== 'string' || attachmentId === '') return undefined
  if (value.kind === 'image') {
    const { mediaType, bytes, width, height, name } = attachment
    if (typeof mediaType !== 'string' || !isImageMediaType(mediaType)) return undefined
    if (!isCount(bytes) || !isCount(width) || !isCount(height)) return undefined
    if (name !== undefined && typeof name !== 'string') return undefined
    const ref: ImageAttachmentRef = {
      attachmentId: attachmentId as AttachmentId,
      mediaType,
      bytes,
      width,
      height,
      ...(typeof name === 'string' && name !== '' ? { name } : {}),
    }
    return { kind: 'image', attachment: ref }
  }
  if (value.kind !== 'file') return undefined
  const { name, bytes } = attachment
  if (typeof name !== 'string' || !isCount(bytes)) return undefined
  return {
    kind: 'file',
    attachment: { attachmentId: attachmentId as AttachmentId, name, bytes },
  }
}

/** Validate one stored attachment list; absent means a text-only draft, malformed means untrusted. */
function storedAttachmentsOf(value: Record<string, unknown>): readonly RestoredDraftAttachment[] | undefined {
  if (value.attachments === undefined) return []
  if (!Array.isArray(value.attachments)) return undefined
  const attachments: RestoredDraftAttachment[] = []
  for (const entry of value.attachments) {
    const attachment = restoredAttachmentOf(entry)
    if (attachment === undefined) return undefined
    attachments.push(attachment)
  }
  return attachments
}

/** Whether two attachment lists cite the same durable references in the same order. */
function sameAttachments(
  left: readonly RestoredDraftAttachment[],
  right: readonly RestoredDraftAttachment[],
): boolean {
  if (left.length !== right.length) return false
  return left.every((reference, index) => {
    const other = right[index]
    return other !== undefined
      && other.kind === reference.kind
      && String(other.attachment.attachmentId) === String(reference.attachment.attachmentId)
  })
}

/** Whether two draft records carry the same text, attachments, and incomplete state. */
function sameDraftContent(left: DraftRecord, right: DraftRecord): boolean {
  return left.text === right.text
    && (left.incompleteAttachments === true) === (right.incompleteAttachments === true)
    && sameAttachments(left.attachments ?? [], right.attachments ?? [])
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
function readRecord(
  sessionId: string,
  snapshot: {
    readonly draft: string
    readonly draftAttachments?: readonly RestoredDraftAttachment[] | undefined
    readonly draftAttachmentsIncomplete?: boolean | undefined
  },
): DraftRecord | undefined {
  if (typeof localStorage === 'undefined') return undefined
  let raw: string | null
  try { raw = localStorage.getItem(`${DRAFT_SYNC_KEY}.${sessionId}`) }
  catch (_storageUnavailable) { return undefined }
  if (raw === null) return undefined
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!isWireRecord(parsed)) return undefined
    const { text: storedText, updatedAt, clientId: storedClient, serverRevision, dirty, incompleteAttachments } = parsed
    const attachments = storedAttachmentsOf(parsed)
    // A record that disagrees with the store proves nothing: treat the local
    // draft as having no revision metadata, so the server's record wins.
    if (typeof storedText !== 'string' || storedText !== snapshot.draft) return undefined
    if (attachments === undefined || !sameAttachments(attachments, snapshot.draftAttachments ?? [])) return undefined
    if ((incompleteAttachments === true) !== (snapshot.draftAttachmentsIncomplete === true)) return undefined
    if (typeof updatedAt !== 'number' || !Number.isFinite(updatedAt) || updatedAt <= 0) return undefined
    const parsedRev = typeof serverRevision === 'number' && Number.isInteger(serverRevision) && serverRevision >= 0
      ? serverRevision
      : undefined
    return {
      text: snapshot.draft,
      attachments,
      ...(incompleteAttachments === true ? { incompleteAttachments: true } : {}),
      updatedAt: Math.floor(updatedAt),
      clientId: typeof storedClient === 'string' ? storedClient : clientId(),
      ...(parsedRev !== undefined ? { serverRevision: parsedRev } : {}),
      ...(dirty === true ? { dirty: true } : {}),
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

/** The `enpoiUiState.get` or winning conflict draft, or `undefined` when the record holds none. */
function remoteDraft(value: unknown): DraftRecord | undefined {
  if (!isWireRecord(value) || !isWireRecord(value.draft)) return undefined
  const { text, updatedAt, clientId: storedClient, incompleteAttachments } = value.draft
  if (typeof text !== 'string') return undefined
  if (typeof updatedAt !== 'number' || !Number.isFinite(updatedAt) || updatedAt <= 0) return undefined
  return {
    text,
    // A malformed attachment list never blocks adopting the text; the chip
    // loss is visible and recoverable, a stuck draft is not.
    attachments: storedAttachmentsOf(value.draft) ?? [],
    ...(incompleteAttachments === true ? { incompleteAttachments: true } : {}),
    updatedAt: Math.floor(updatedAt),
    clientId: typeof storedClient === 'string' ? storedClient : clientId(),
  }
}

/**
 * Mirror one session's draft to the server and adopt a newer server draft.
 *
 * Pushes are serialized per binding (at most one `enpoiUiState.put` in flight)
 * and carry the observed `expectedRevision` for conditional server updates.
 * On conflict, the binding adopts a newer remote winner unless the user has a
 * live keystroke buffer or a non-draft revision bump occurred, in which case it
 * rebases onto the winner's revision. A failed read leaves the session
 * local-only silently: without the server's record there is no honest ordering.
 * A failed write skips only that attempt — the local store is never touched,
 * one log line marks the first failure, and the next change retries.
 *
 * Call once per live store instance, at its creation. The binding returns a
 * stop that cancels its pending push.
 * @param instance - the session's store instance.
 * @param sessionId - the session whose draft this instance holds.
 * @param options - optional binding callbacks.
 * @returns a stop for the binding's pending push.
 */
export function bindDraftSync(
  instance: DraftSyncTarget,
  sessionId: string,
  options: DraftSyncOptions = {},
): () => void {
  if (typeof localStorage === 'undefined' || typeof fetch !== 'function') return () => {}
  let stopped = false
  let overflowNotified = false
  let adopting = false
  let readFailed = false
  let readComplete = false
  let failureLogged = false
  let inFlight = false
  let typedSinceAttach = false
  let pushTimer: ReturnType<typeof setTimeout> | undefined

  const initial = instance.getSnapshot()
  let local: DraftRecord = readRecord(sessionId, initial)
    ?? {
      text: initial.draft,
      attachments: initial.draftAttachments ?? [],
      ...(initial.draftAttachmentsIncomplete === true ? { incompleteAttachments: true } : {}),
      updatedAt: 0,
      clientId: clientId(),
    }
  let knownRevision: number | undefined = local.serverRevision
  let syncedDraft: DraftRecord | undefined = local.dirty !== true && local.serverRevision !== undefined
    ? local
    : undefined
  let localSeq = local.dirty === true ? 1 : 0
  let pushedSeq = 0
  let pendingPush = local.dirty === true

  const applyDraftToStore = (remote: DraftRecord): void => {
    if (remote.incompleteAttachments === true) {
      instance.actions.setDraft(remote.text, remote.attachments ?? [], true)
      return
    }
    instance.actions.setDraft(remote.text, remote.attachments ?? [])
  }

  const adopt = (remote: DraftRecord, rev: number | undefined): void => {
    adopting = true
    local = {
      text: remote.text,
      attachments: remote.attachments ?? [],
      ...(remote.incompleteAttachments === true ? { incompleteAttachments: true } : {}),
      updatedAt: remote.updatedAt,
      clientId: remote.clientId,
      ...(rev !== undefined ? { serverRevision: rev } : {}),
      dirty: false,
    }
    writeRecord(sessionId, local)
    syncedDraft = local
    pushedSeq = localSeq
    pendingPush = false
    applyDraftToStore(remote)
    adopting = false
  }

  const flushPush = (): void => {
    if (stopped || readFailed || !readComplete || inFlight || !pendingPush) return
    const targetSeq = localSeq
    if (targetSeq <= pushedSeq) {
      pendingPush = false
      return
    }
    const targetDraft = local
    const expectedRevision = knownRevision
    const baseDraft = syncedDraft
    pendingPush = false
    const wire = boundedRecord(targetDraft)
    if (wire.dropped > 0 && !overflowNotified) {
      overflowNotified = true
      options.onAttachmentOverflow?.()
    }
    inFlight = true
    const patch: Record<string, unknown> = { draft: wire.record }
    if (expectedRevision !== undefined) patch.expectedRevision = expectedRevision

    void uiStateRpc<unknown>('enpoiUiState.put', { sessionId, patch }).then((result) => {
      inFlight = false
      if (stopped) return
      if (!result.ok) {
        if (!failureLogged) {
          failureLogged = true
          console.error(`enpoiUiState.put (draft) failed for session "${sessionId}": ${result.message}`)
        }
        return
      }
      failureLogged = false

      const conflict = parsePutConflict(result.value)
      if (conflict !== undefined) {
        const winnerRev = conflict.revision
        const winner = conflict.record === undefined ? undefined : remoteDraft(conflict.record)
        if (winnerRev !== undefined) knownRevision = winnerRev
        syncedDraft = winner

        // Never drop a live keystroke buffer typed while the push was in flight.
        if (localSeq > targetSeq || pushTimer !== undefined) {
          local = {
            ...local,
            ...(winnerRev !== undefined ? { serverRevision: winnerRev } : {}),
          }
          writeRecord(sessionId, local)
          pendingPush = true
          if (pushTimer === undefined) flushPush()
          return
        }

        // If the server already holds the exact content we pushed, settle cleanly.
        if (winner !== undefined && sameDraftContent(winner, targetDraft)) {
          pushedSeq = targetSeq
          local = {
            ...local,
            ...(winnerRev !== undefined ? { serverRevision: winnerRev } : {}),
            dirty: false,
          }
          writeRecord(sessionId, local)
          return
        }

        // A non-draft revision bump (e.g. sidebar surface write) leaves the
        // remote draft equal to our base: rebase and re-apply the newer local edit.
        if ((winner === undefined || (baseDraft !== undefined && sameDraftContent(winner, baseDraft)))
          && winnerRev !== undefined && winnerRev > (expectedRevision ?? -1)) {
          local = { ...local, serverRevision: winnerRev }
          writeRecord(sessionId, local)
          pendingPush = true
          flushPush()
          return
        }

        if (winner !== undefined) adopt(winner, winnerRev)
        return
      }

      const newRev = readRevision(result.value)
      if (newRev !== undefined) knownRevision = newRev
      syncedDraft = targetDraft
      pushedSeq = Math.max(pushedSeq, targetSeq)
      if (localSeq === targetSeq) {
        local = {
          ...local,
          ...(newRev !== undefined ? { serverRevision: newRev } : {}),
          dirty: false,
        }
        writeRecord(sessionId, local)
        return
      }
      local = {
        ...local,
        ...(newRev !== undefined ? { serverRevision: newRev } : {}),
      }
      writeRecord(sessionId, local)
      if (pendingPush && pushTimer === undefined) flushPush()
    })
  }

  const mirror = (): void => {
    if (readFailed) return
    pendingPush = true
    if (pushTimer !== undefined) clearTimeout(pushTimer)
    pushTimer = setTimeout(() => {
      pushTimer = undefined
      // The read is still in flight; its handler flushes what is pending.
      if (readComplete) flushPush()
    }, PUSH_DELAY_MS)
  }

  const unsubscribe = instance.subscribe(() => {
    if (stopped || adopting) return
    const snapshot = instance.getSnapshot()
    const attachments = snapshot.draftAttachments ?? []
    const incomplete = snapshot.draftAttachmentsIncomplete === true
    if (snapshot.draft === local.text
      && sameAttachments(attachments, local.attachments ?? [])
      && incomplete === (local.incompleteAttachments === true)) return
    typedSinceAttach = true
    localSeq += 1
    local = {
      text: snapshot.draft,
      attachments,
      ...(incomplete ? { incompleteAttachments: true } : {}),
      updatedAt: Date.now(),
      clientId: clientId(),
      ...(knownRevision !== undefined ? { serverRevision: knownRevision } : {}),
      dirty: true,
    }
    writeRecord(sessionId, local)
    mirror()
  })

  void uiStateRpc<unknown>('enpoiUiState.get', { sessionId }).then((result) => {
    if (stopped) return
    if (!result.ok) {
      readFailed = true
      pendingPush = false
      return
    }
    readComplete = true
    const remoteRev = readRevision(result.value)
    const remote = remoteDraft(result.value)
    if (remoteRev !== undefined) knownRevision = remoteRev
    syncedDraft = remote

    // A local change since attach is newer than the fetched record; its own
    // mirror follows, so adoption would only undo the operator's typing.
    if (typedSinceAttach) {
      local = {
        ...local,
        ...(remoteRev !== undefined ? { serverRevision: remoteRev } : {}),
      }
      writeRecord(sessionId, local)
      if (pushTimer === undefined && pendingPush) flushPush()
      return
    }

    if (remote === undefined && local.updatedAt === 0
      && (local.text !== '' || (local.attachments?.length ?? 0) > 0)) {
      // A draft from before the mirror existed carries no revision time; give
      // it one so it can seed the server and order future merges.
      local = {
        ...local,
        updatedAt: Date.now(),
        ...(remoteRev !== undefined ? { serverRevision: remoteRev } : {}),
        dirty: true,
      }
      writeRecord(sessionId, local)
      localSeq = Math.max(localSeq, 1)
      pendingPush = true
      flushPush()
      return
    }

    const shouldAdopt = remote !== undefined && (
      remoteRev !== undefined && local.serverRevision !== undefined
        ? remoteRev > local.serverRevision
        : local.updatedAt === 0 || remote.updatedAt > local.updatedAt
    )
    if (shouldAdopt) {
      adopt(remote, remoteRev)
      return
    }

    // Local is newer (or the server has nothing): seed the server from here.
    if (local.dirty === true || local.updatedAt > (remote?.updatedAt ?? 0)) {
      localSeq = Math.max(localSeq, 1)
      pendingPush = true
      flushPush()
    }
  })

  return () => {
    stopped = true
    if (pushTimer !== undefined) clearTimeout(pushTimer)
    pushTimer = undefined
    pendingPush = false
    unsubscribe()
  }
}
