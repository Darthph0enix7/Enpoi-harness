/**
 * Child-turn delivery and settlement for the enpoi-oracle plugin (contract C9).
 *
 * A continuable child parks (its Agent leaves `ctx.agents`) when its turn
 * settles, so the wait is woken by the paired `subagent/end` edge and falls
 * back to polling for compositions that emit no lifecycle edge. The turn is
 * read from the child's own durable log: the exact prompt message id names the
 * turn, and the following assistant text plus `turn/end` give the report and
 * its stop reason. The child is never cancelled here; the caller owns aborts.
 *
 * @module dsh-enpoi-oracle/ask-child
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock, MessageId } from '@deepseek-ai/dsh-llm'
import type { SessionEvent, SessionId, TurnEndReason } from '@deepseek-ai/dsh-session'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import type { SubagentRunEndInfo } from '@deepseek-ai/dsh-subagent'
import { queueHostSubagentPrompt } from '@deepseek-ai/dsh-subagent/internal'

/** Terminal outcome of one asked child turn. */
export interface ChildTurnResult {
  /** Inbox identity of the prompt that opened the turn. */
  readonly messageId: MessageId
  /** Assistant text collected between the prompt and the closing `turn/end`. */
  readonly text: string
  /** Why the child's turn ended. */
  readonly stopReason: 'completed' | 'error' | 'aborted' | 'max-tokens' | 'refusal'
  /** Provider or transport failure text when `stopReason` is `error`. */
  readonly error?: string
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

/** Polling and cancellation inputs shared by both entry points. */
export interface ChildTurnOptions {
  /** Caller cancellation; never forwarded to the child. */
  readonly signal: AbortSignal
  /** Absolute epoch-millisecond instant after which the wait raises. */
  readonly deadline: number
  /** Fallback wake cadence when no `subagent/end` edge arrives. */
  readonly pollMs: number
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

/**
 * Read the child log once and settle the asked turn when it is closed.
 * @param ctx - context carrying `sessionPersistence`.
 * @param childId - parked child session.
 * @param messageId - prompt identity that opens the turn.
 * @returns the settled turn, or `undefined` while the log does not carry it.
 */
async function readSettledTurn(
  ctx: Context,
  childId: SessionId,
  messageId: MessageId,
): Promise<ChildTurnResult | undefined> {
  const persistence = ctx.get('sessionPersistence') as SessionPersistence | undefined
  if (persistence === undefined) return undefined
  const handle = await persistence.open(childId, 'read')
  let events: readonly SessionEvent[]
  try {
    events = (await handle.read(0, undefined)).events
  } finally {
    await handle.close()
  }
  const start = events.findIndex(event => event.type === 'user/message' && event.data.id === messageId)
  if (start < 0) return undefined
  const parts: string[] = []
  for (let index = start + 1; index < events.length; index += 1) {
    const event = events[index]!
    if (event.type === 'assistant/message') {
      const text = textOfContent(event.data.message.content)
      if (text.length > 0) parts.push(text)
      continue
    }
    if (event.type === 'turn/end') {
      const error = errorOf(event.data.reason)
      return {
        messageId,
        text: parts.join('\n'),
        stopReason: stopReasonOf(event.data.reason),
        ...(error === undefined ? {} : { error }),
      }
    }
    // A later prompt means this turn was never opened under the asked id.
    if (event.type === 'user/message') return undefined
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
 * Wakes on the child's `subagent/end` edge with a `pollMs` fallback. While the
 * child is parked the log is read for the asked turn; until it carries the
 * closing `turn/end` the wait continues. The child is never cancelled.
 * @param ctx - context carrying `agents` and `sessionPersistence`.
 * @param childId - continuable child session.
 * @param messageId - inbox identity returned when the prompt was accepted.
 * @param options - cancellation, absolute deadline, and poll cadence.
 * @returns the settled turn's text, stop reason, and failure text.
 * @throws {@link ChildTurnTimeoutError} when the deadline passes first.
 * @throws the signal's reason when the caller aborts.
 */
export async function waitForChildMessageTurn(
  ctx: Context,
  childId: SessionId,
  messageId: MessageId,
  options: ChildTurnOptions,
): Promise<ChildTurnResult> {
  const { signal, deadline, pollMs } = options
  if (ctx.get('sessionPersistence') === undefined) {
    throw new Error('waitForChildMessageTurn requires the sessionPersistence service')
  }
  let wake: (() => void) | undefined
  const nudge = (): void => { wake?.() }
  const onEnd = (info: SubagentRunEndInfo): void => { if (info.id === childId) nudge() }
  const off = ctx.on('subagent/end', onEnd)
  signal.addEventListener('abort', nudge, { once: true })
  try {
    for (;;) {
      if (signal.aborted) throw abortError(signal)
      if (ctx.agents.get(childId) === undefined) {
        const settled = await readSettledTurn(ctx, childId, messageId)
        if (settled !== undefined) return settled
      }
      if (signal.aborted) throw abortError(signal)
      const remaining = deadline - Date.now()
      if (remaining <= 0) throw new ChildTurnTimeoutError(childId, messageId)
      await new Promise<void>(resolve => {
        const timer = setTimeout(resolve, Math.max(1, Math.min(pollMs, remaining)))
        wake = () => {
          clearTimeout(timer)
          resolve()
        }
      })
    }
  } finally {
    off()
    signal.removeEventListener('abort', nudge)
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
