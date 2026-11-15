/**
 * Child-turn delivery and settlement for the enpoi-oracle plugin (contract C9).
 *
 * The turn is read from the child's own log: the exact prompt message id names
 * the prompt, the nearest `turn/start` before it fixes the owning turn number,
 * and only that turn's assistant text plus `turn/end` give the report and stop
 * reason. Steering and synthetic user messages inside the turn are not turn
 * boundaries. A resident child is read from its live Session — the
 * child does not have to park first — while an absent child is read from
 * `sessionPersistence`. The wait is woken by the paired `subagent/end` edge and
 * falls back to polling for compositions that emit no lifecycle edge. When a
 * child genuinely ends without a readable asked turn, or a parked child's log
 * never carries it, the wait raises a bounded diagnostic error instead of
 * hanging forever. The child is never cancelled here; the caller owns aborts.
 *
 * @module dsh-enpoi-oracle/ask-child
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock, MessageId } from '@deepseek-ai/dsh-llm'
import type { SessionEvent, SessionId, SessionSeq, TurnEndReason } from '@deepseek-ai/dsh-session'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import type { SubagentRunEndInfo } from '@deepseek-ai/dsh-subagent'
import { queueHostSubagentPrompt } from '@deepseek-ai/dsh-subagent/internal'

/** Terminal outcome of one asked child turn. */
export interface ChildTurnResult {
  /** Durable child that owns the asked turn. */
  readonly childId: SessionId
  /** Inbox identity of the prompt that opened the turn. */
  readonly messageId: MessageId
  /** Assistant text collected between the prompt and the closing `turn/end`. */
  readonly text: string
  /** Why the child's turn ended. */
  readonly stopReason: 'completed' | 'error' | 'aborted' | 'max-tokens' | 'refusal'
  /** Provider or transport failure text when `stopReason` is `error`. */
  readonly error?: string
  /** Stable code recorded by the closing turn, when it recorded one. */
  readonly failureCode?: string
  /** Event seq of the last successful tool result inside the asked turn. */
  readonly lastSuccessfulOperationSeq?: SessionSeq
}

/** Raised when the child turn does not settle before the caller's deadline. */
export class ChildTurnTimeoutError extends Error {
  /**
   * @param childId - the still-running child whose turn was abandoned.
   * @param messageId - the prompt message that never settled.
   */
  constructor(readonly childId: SessionId, readonly messageId: MessageId) {
    super(`child ${childId} did not settle message ${messageId} before the deadline`)
    this.name = 'ChildTurnTimeoutError'
  }
}

/**
 * Why the asked turn can no longer be observed: the child ended without a
 * readable turn (`ended`), or it has been parked past the grace window while
 * its persisted log still lacks the asked prompt (`unreadable-parked`). Both
 * are watcher failures, not verdicts.
 */
export type ChildTurnUnavailableReason = 'ended' | 'unreadable-parked'

/** Raised when a settled or parked child cannot supply the asked turn. */
export class ChildTurnUnavailableError extends Error {
  /**
   * @param childId - the child whose asked turn cannot be read.
   * @param messageId - the prompt message that names the turn.
   * @param reason - whether the child ended or stayed parked without the turn.
   */
  constructor(
    readonly childId: SessionId,
    readonly messageId: MessageId,
    readonly reason: ChildTurnUnavailableReason,
  ) {
    super(reason === 'ended'
      ? `child ${childId} ended before it recorded the asked turn ${messageId}`
      : `child ${childId} is parked but its persisted log does not carry the asked turn ${messageId}`)
    this.name = 'ChildTurnUnavailableError'
  }
}

/** Default bound on a parked child whose persisted log still lacks the asked turn. */
export const DEFAULT_CHILD_ABSENCE_GRACE_MS = 30_000

/** Polling and cancellation inputs shared by both entry points. */
export interface ChildTurnOptions {
  /** Caller cancellation; never forwarded to the child. */
  readonly signal: AbortSignal
  /** Absolute epoch-millisecond instant after which the wait raises. */
  readonly deadline: number
  /** Fallback wake cadence when no `subagent/end` edge arrives. */
  readonly pollMs: number
  /**
   * Bound after which an absent child whose persisted log still lacks the
   * asked turn is reported as unreadable instead of waiting forever.
   */
  readonly absenceGraceMs?: number
}

/** Assistant text blocks only: the child's reasoning and tool calls stay private. */
export function textOfContent(blocks: unknown): string {
  if (!Array.isArray(blocks)) return ''
  return blocks
    .map(block => {
      if (typeof block !== 'object' || block === null || !('text' in block)) return ''
      const blockType = (block as { type?: unknown }).type
      return blockType === 'text' || blockType === undefined ? String((block as { text: unknown }).text) : ''
    })
    .filter(text => text.length > 0)
    .join(' ')
}

const STOP_REASONS = new Set<ChildTurnResult['stopReason']>(['completed', 'error', 'aborted', 'max-tokens', 'refusal'])

/** Map the log's merge-extensible turn-end reason onto the C9 vocabulary. */
function stopReasonOf(reason: TurnEndReason): ChildTurnResult['stopReason'] {
  const kind = String(reason.kind)
  return STOP_REASONS.has(kind as ChildTurnResult['stopReason'])
    ? kind as ChildTurnResult['stopReason']
    : 'error'
}

/** Provider failure text carried by an `error` turn end. */
function errorOf(reason: TurnEndReason): string | undefined {
  if (reason.kind !== 'error') return undefined
  return reason.error.message
}

/** Stable code recorded by a closing turn, for a bounded diagnostic notice. */
function failureCodeOf(reason: TurnEndReason): string | undefined {
  switch (reason.kind) {
    case 'completed':
      return undefined
    case 'error':
      return reason.error.code === '' ? 'UNKNOWN' : reason.error.code
    case 'aborted':
      return reason.error === undefined
        ? 'TURN_ABORTED'
        : reason.error.code === '' ? 'UNKNOWN' : reason.error.code
    case 'blocked':
      return 'TURN_BLOCKED'
    case 'max-tokens':
      return 'OUTPUT_TOKEN_LIMIT'
    case 'interrupted':
      return 'TURN_INTERRUPTED'
    /* v8 ignore next 4 -- `forked` exists only in constructor seed history, and
     * `TurnEndReason` is merge-extensible; name an unnameable ending instead of
     * pretending it completed. */
    default:
      return 'UNRECOGNIZED_TURN_END'
  }
}

/** Read one child log from the live Session when present, else from persistence. */
async function readChildLog(
  ctx: Context,
  childId: SessionId,
): Promise<readonly SessionEvent[]> {
  const live = ctx.agents.get(childId)
  if (live !== undefined) {
    return live.session.snapshotEvents()
  }
  const persistence = ctx.get('sessionPersistence') as SessionPersistence | undefined
  if (persistence === undefined) {
    throw new Error('waitForChildMessageTurn requires a live child or the sessionPersistence service')
  }
  const handle = await persistence.open(childId, 'read')
  try {
    return (await handle.read(0, undefined)).events
  } finally {
    await handle.close()
  }
}

/**
 * Read the child log once and settle the asked turn when it is closed.
 *
 * The prompt message id locates the turn; only a `turn/end` after it closes
 * that turn. Assistant text from any later consultation is therefore never
 * reported as this turn's result.
 * @param ctx - context carrying `agents` and `sessionPersistence`.
 * @param childId - resident or parked child session.
 * @param messageId - prompt identity that opens the turn.
 * @returns the settled turn, or `undefined` while the log does not carry it.
 */
async function readSettledTurn(
  ctx: Context,
  childId: SessionId,
  messageId: MessageId,
): Promise<ChildTurnResult | undefined> {
  const events = await readChildLog(ctx, childId)
  const start = events.findIndex(event => event.type === 'user/message' && event.data.id === messageId)
  if (start < 0) return undefined
  // The nearest turn boundary before the prompt is the turn that owns it.
  // Steering and synthetic context can add user messages inside that turn, so
  // only the turn number decides which end and assistant messages belong here.
  let askedTurn: number | undefined
  for (let index = start; index >= 0; index -= 1) {
    const event = events[index]
    if (event !== undefined && event.type === 'turn/start') {
      askedTurn = event.data.turn
      break
    }
  }
  const parts: string[] = []
  let lastSuccessfulOperationSeq: SessionSeq | undefined
  for (let index = start + 1; index < events.length; index += 1) {
    const event = events[index]!
    if (event.type === 'turn/start') {
      // A different turn opened before the asked turn closed: the prompt was
      // never owned by a turn in this epoch.
      if (askedTurn !== undefined && event.data.turn !== askedTurn) return undefined
      continue
    }
    if (event.type === 'assistant/message') {
      if (askedTurn !== undefined && event.data.turn !== askedTurn) continue
      const text = textOfContent(event.data.message.content)
      if (text.length > 0) parts.push(text)
      continue
    }
    if (event.type === 'tool/result') {
      if (askedTurn !== undefined && event.data.turn !== askedTurn) continue
      if (event.data.error === undefined && event.data.message.isError !== true) {
        lastSuccessfulOperationSeq = event.seq
      }
      continue
    }
    if (event.type === 'turn/end') {
      // A different turn's end proves this prompt had no open turn here.
      if (askedTurn !== undefined && event.data.turn !== askedTurn) return undefined
      const error = errorOf(event.data.reason)
      const failureCode = failureCodeOf(event.data.reason)
      return {
        childId,
        messageId,
        text: parts.join('\n'),
        stopReason: stopReasonOf(event.data.reason),
        ...(error === undefined ? {} : { error }),
        ...(failureCode === undefined ? {} : { failureCode }),
        ...(lastSuccessfulOperationSeq === undefined ? {} : { lastSuccessfulOperationSeq }),
      }
    }
    // User messages inside the open turn are steering or synthetic context;
    // they never close the asked turn.
  }
  return undefined
}

/** The caller's abort reason, or a plain abort error. */
function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('aborted')
}

/**
 * Wait for one already-delivered child prompt to settle.
 *
 * Wakes on the child's `subagent/end` edge with a `pollMs` fallback. Every pass
 * reads the asked turn from the resident child's live log or, when it is
 * parked, from its durable log; the wait never reports a later consultation's
 * text. A child that ends without the asked turn, or stays parked past the
 * absence grace without it, raises {@link ChildTurnUnavailableError}. The child
 * is never cancelled.
 * @param ctx - context carrying `agents` and `sessionPersistence`.
 * @param childId - continuable child session.
 * @param messageId - inbox identity returned when the prompt was accepted.
 * @param options - cancellation, absolute deadline, poll cadence, and absence grace.
 * @returns the settled turn's text, stop reason, and failure facts.
 * @throws {@link ChildTurnTimeoutError} when the deadline passes first.
 * @throws {@link ChildTurnUnavailableError} when the asked turn can no longer be read.
 * @throws the signal's reason when the caller aborts.
 */
export async function waitForChildMessageTurn(
  ctx: Context,
  childId: SessionId,
  messageId: MessageId,
  options: ChildTurnOptions,
): Promise<ChildTurnResult> {
  const { signal, deadline, pollMs } = options
  const absenceGraceMs = options.absenceGraceMs ?? DEFAULT_CHILD_ABSENCE_GRACE_MS
  if (ctx.get('sessionPersistence') === undefined && ctx.agents.get(childId) === undefined) {
    throw new Error('waitForChildMessageTurn requires a live child or the sessionPersistence service')
  }
  let wake: (() => void) | undefined
  const nudge = (): void => { wake?.() }
  let ended = false
  const onEnd = (info: SubagentRunEndInfo): void => {
    if (info.id !== childId) return
    ended = true
    nudge()
  }
  const off = ctx.on('subagent/end', onEnd)
  signal.addEventListener('abort', nudge, { once: true })
  let absentSince: number | undefined
  try {
    for (;;) {
      if (signal.aborted) throw abortError(signal)
      const live = ctx.agents.get(childId) !== undefined
      absentSince = live ? undefined : (absentSince ?? Date.now())
      const settled = await readSettledTurn(ctx, childId, messageId)
      if (settled !== undefined) return settled
      if (signal.aborted) throw abortError(signal)
      // The activation ended and its flushed log still has no closing turn for
      // the asked prompt: this turn will never become readable.
      // The end event can arrive while a read is in flight, so the read above
      // may have started before the child's final flush. Re-read once after the
      // end before declaring the asked turn unreadable.
      if (ended) {
        const finalRead = await readSettledTurn(ctx, childId, messageId)
        if (finalRead !== undefined) return finalRead
        throw new ChildTurnUnavailableError(childId, messageId, 'ended')
      }
      const remaining = deadline - Date.now()
      if (remaining <= 0) throw new ChildTurnTimeoutError(childId, messageId)
      if (!live && absentSince !== undefined && Date.now() - absentSince >= absenceGraceMs) {
        throw new ChildTurnUnavailableError(childId, messageId, 'unreadable-parked')
      }
      await new Promise<void>(resolve => {
        const timer = setTimeout(resolve, Math.max(1, Math.min(pollMs, remaining)))
        wake = () => {
          clearTimeout(timer)
          wake = undefined
          resolve()
        }
      })
    }
  } finally {
    off()
    signal.removeEventListener('abort', nudge)
    wake = undefined
  }
}

/**
 * Deliver one prompt to a continuable child and wait for its turn to settle.
 * @param ctx - context carrying `subagents`, `agents`, and `sessionPersistence`.
 * @param parent - exact live direct parent authorizing delivery.
 * @param childId - continuable child session.
 * @param content - host-authored prompt content.
 * @param options - cancellation, absolute deadline, and poll cadence.
 * @returns the settled turn's text, stop reason, and failure text.
 * @throws {@link ChildTurnTimeoutError} when the deadline passes first.
 */
export async function askChild(
  ctx: Context,
  parent: Agent,
  childId: SessionId,
  content: ContentBlock[],
  options: ChildTurnOptions,
): Promise<ChildTurnResult> {
  const messageId = await queueHostSubagentPrompt(
    ctx.subagents,
    parent,
    childId,
    content,
    { kind: 'user' },
    options.signal,
  )
  return waitForChildMessageTurn(ctx, childId, messageId, options)
}
