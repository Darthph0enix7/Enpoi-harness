/**
 * Synthetic closer events that balance a session log whose tail turn is open.
 * Two producers share the mechanism: crash recovery closes an interrupted
 * persisted log on reload, and fork-seed construction closes a prefix cut
 * inside the source's open turn. Both preserve every fully written event and
 * close the unfinished step and turn. Calls in already closed steps remain
 * unchanged, including any missing results.
 * @module @deepseek-ai/dsh-session/repair
 */

import { brandString } from '@deepseek-ai/dsh-brand'
import type { MessageId, ToolCallId, ToolResultMessage } from '@deepseek-ai/dsh-llm'
import { deepFreeze } from '@deepseek-ai/dsh-util-values'
import { SessionSeq } from './types.ts'
import type { SessionEvent, SessionSeq as SessionSeqType } from './types.ts'

/** Recovery code for an assistant tool request that never reached a recorded call start. */
export const TOOL_NOT_STARTED = 'TOOL_NOT_STARTED'

/** Recovery code for a recorded tool call whose completed outcome was not durably recorded. */
export const TOOL_OUTCOME_UNKNOWN = 'TOOL_OUTCOME_UNKNOWN'

/**
 * Recovery code for a recorded tool call that was still waiting on an
 * undecided approval when the log was cut. The approval gate precedes
 * execution, so the call never began: no outcome exists to be unknown.
 */
export const TOOL_APPROVAL_NOT_DECIDED = 'TOOL_APPROVAL_NOT_DECIDED'

/**
 * Recovery code for a recorded tool call whose approval was decided against
 * execution (`rejected`). The approval gate precedes execution, so the call
 * never began: no outcome exists to be unknown.
 */
export const TOOL_APPROVAL_DENIED = 'TOOL_APPROVAL_DENIED'

/**
 * Recovery code for a recorded tool call whose approval gate lapsed without a
 * decision (`cancelled` or `unavailable`). The approval gate precedes
 * execution, so the call never began: no outcome exists to be unknown.
 */
export const TOOL_APPROVAL_EXPIRED = 'TOOL_APPROVAL_EXPIRED'

/**
 * Why an open tail turn is closed with synthetic events: `interrupted` is
 * crash recovery over a persisted log; `forked` is a fork seed cut inside the
 * source's open turn. The cause selects the synthetic `turn/end` reason, the
 * model-visible wording of synthetic error tool results, and the
 * deterministic synthetic message-id prefix. The error codes
 * ({@link TOOL_NOT_STARTED} / {@link TOOL_OUTCOME_UNKNOWN} /
 * {@link TOOL_APPROVAL_NOT_DECIDED} / {@link TOOL_APPROVAL_DENIED} /
 * {@link TOOL_APPROVAL_EXPIRED}) are shared: both causes state the same fact
 * about the call's recorded lifecycle.
 */
export type OpenTurnCloseCause = { readonly kind: 'interrupted' } | { readonly kind: 'forked' }

/** Model-visible wording of the synthetic error tool results, keyed by cause. */
const CLOSER_TEXT = {
  interrupted: {
    started: 'The tool call was interrupted after it was recorded, but no result was durably recorded. Its outcome is unknown. Decide whether to retry from the tool semantics: retry only if the operation is read-only or idempotent; if it may have side effects, first verify external state or ask the user. Do not retry blindly.',
    notStarted: 'The tool call was interrupted before the Harness recorded it as started. Retry it if it is still needed.',
    approvalPending: 'The tool call was waiting for an approval that was never decided, so the tool was not executed. Retry it if it is still needed.',
    approvalDenied: 'The tool call\'s approval was rejected, so the tool was not executed. Do not retry it unless the user changes that decision.',
    approvalExpired: 'The tool call\'s approval gate lapsed without a decision, so the tool was not executed. Retry it if it is still needed.',
  },
  forked: {
    started: 'The history inherited by this branch records this tool call starting but does not include its result. The parent session may have completed it after the fork point. Decide whether to retry from the tool semantics: retry only if the operation is read-only or idempotent; if it may have side effects, first verify external state or ask the user. Do not retry blindly.',
    notStarted: 'The history inherited by this branch has no record of this tool call starting. The parent session may have executed it after the fork point. Decide whether to retry from the tool semantics: retry only if the operation is read-only or idempotent; if it may have side effects, first verify external state or ask the user. Do not retry blindly.',
    approvalPending: 'The history inherited by this branch records this tool call waiting for an approval that is not decided in the branch. The parent session may have decided it after the fork point; the tool was not executed before this branch was cut. Retry it if it is still needed, after verifying whether the action already ran.',
    approvalDenied: 'The history inherited by this branch records this tool call\'s approval being rejected before the fork point, so the tool was not executed. Do not retry it unless the user changes that decision.',
    approvalExpired: 'The history inherited by this branch records this tool call\'s approval gate lapsing without a decision before the fork point, so the tool was not executed. Retry it if it is still needed.',
  },
} as const

/**
 * Fold one approval audit event into the closers' approval-audit state.
 * The session package does not depend on the approval plugin's merged event
 * declarations, so the two audit types are read structurally: `callId` is the
 * exact tool call an ask belongs to, and only a matching `approval/decided`
 * resolves it.
 *
 * @param event - one log event, typed structurally by its `type` string.
 * @param asked - per-call ids of unanswered `approval/asked` events, mutated in place.
 * @param decided - approval ids answered by an `approval/decided` event mapped to
 *   their outcome, mutated in place. The outcome stays structurally read: the
 *   package does not depend on the approval plugin's outcome vocabulary.
 */
function observeApprovalEvent(
  event: { readonly type: string; readonly data: unknown },
  asked: Map<ToolCallId, Set<string>>,
  decided: Map<string, unknown>,
): void {
  if (typeof event.data !== 'object' || event.data === null) return
  if (!('id' in event.data) || typeof event.data.id !== 'string') return
  const id = event.data.id
  if (event.type === 'approval/decided') {
    decided.set(id, 'outcome' in event.data ? event.data.outcome : undefined)
    return
  }
  if (event.type !== 'approval/asked') return
  if (!('callId' in event.data) || typeof event.data.callId !== 'string') return
  const callId = brandString<ToolCallId>(event.data.callId)
  const pending = asked.get(callId)
  if (pending === undefined) asked.set(callId, new Set([id]))
  else pending.add(id)
}

/**
 * How the recorded approval asks classify one call's recovery. `undecided`
 * means at least one ask has no decision; `denied` and `expired` mean every
 * ask was decided and none granted execution; `unknown` covers a granted or
 * unrecognized outcome (the call may have begun) and no recorded ask at all.
 */
type ApprovalRecovery = 'undecided' | 'denied' | 'expired' | 'unknown'

/**
 * Classify the approval asks recorded for one call. The approval gate runs
 * before the operation, so an ask that closed without a grant proves the call
 * never began. A granted outcome (`allowed-once`, `allowed-always`,
 * `allowed-always-broad`) or an outcome outside the known vocabulary leaves
 * the classification `unknown`: the call may have executed.
 *
 * @param callId - the recorded call to inspect.
 * @param asked - per-call approval ask ids collected from the log.
 * @param decided - approval ids mapped to the outcome read from the log.
 * @returns the call's approval recovery classification.
 */
function approvalRecovery(
  callId: ToolCallId,
  asked: ReadonlyMap<ToolCallId, ReadonlySet<string>>,
  decided: ReadonlyMap<string, unknown>,
): ApprovalRecovery {
  const pending = asked.get(callId)
  if (pending === undefined) return 'unknown'
  let denied = false
  let expired = false
  for (const id of pending) {
    if (!decided.has(id)) return 'undecided'
    const outcome = decided.get(id)
    if (outcome === 'rejected') denied = true
    else if (outcome === 'cancelled' || outcome === 'unavailable') expired = true
    else if (outcome !== 'allowed-once' && outcome !== 'allowed-always' && outcome !== 'allowed-always-broad') {
      // An unrecognized outcome may have granted execution; stay conservative.
      return 'unknown'
    }
  }
  if (denied) return 'denied'
  if (expired) return 'expired'
  return 'unknown'
}

/**
 * Return deterministic synthetic events that close an open tail turn. Unmatched
 * calls in its open step receive error results, followed by `step/end` and a
 * `turn/end` carrying the cause's reason. Calls in closed steps remain unchanged.
 * Sequences continue the log and timestamps reuse the last real event. A balanced or empty log returns no
 * events.
 *
 * Package-internal: each cause has exactly one owner, so external callers go
 * through {@link interruptedTurnClosers} (persistence crash recovery) or
 * `buildForkSeed` in `./fork.ts` (fork seeds) instead of selecting a cause.
 *
 * @param events - the log to scan: a valid committed prefix, possibly ending
 *   inside an open turn (a crash tail or a mid-turn fork cut).
 * @param cause - why the turn is being closed; selects the `turn/end` reason
 *   and the model-visible wording of synthetic error tool results.
 * @returns the synthetic closer events to append after `events`, in order; empty when the log is already balanced.
 */
export function openTurnClosers(events: readonly SessionEvent[], cause: OpenTurnCloseCause): SessionEvent[] {
  let openTurn: number | null = null
  let openStep: number | null = null
  // Reset at each turn boundary so earlier calls cannot leak into tail repair.
  // Assistant blocks register calls; later `tool/call` events add their seqs to `sourceEventSeqs`.
  const pendingCalls = new Map<ToolCallId, { step: number; callSeq?: SessionSeqType }>()
  // Approval audit state outlives turn boundaries: an ask belongs to one exact
  // call id, so only the open tail's pending calls are ever consulted.
  const askedApprovals = new Map<ToolCallId, Set<string>>()
  const decidedApprovals = new Map<string, unknown>()
  for (const event of events) {
    observeApprovalEvent(event, askedApprovals, decidedApprovals)
    switch (event.type) {
      case 'turn/start':
        openTurn = event.data.turn
        openStep = null
        pendingCalls.clear()
        break
      case 'turn/end':
        openTurn = null
        openStep = null
        pendingCalls.clear()
        break
      case 'step/start':
        openStep = event.data.step
        break
      case 'step/end':
        pendingCalls.clear()
        openStep = null
        break
      case 'assistant/message':
        // The assistant message carries the tool-call blocks; each is pending
        // until a tool/result event with the same callId is logged.
        for (const block of event.data.message.content) {
          if (block.type === 'tool-call') pendingCalls.set(block.id, { step: event.data.step })
        }
        break
      case 'tool/call':
        // Cite the `tool/call` seq from the synthetic result.
        {
          const entry = pendingCalls.get(event.data.callId)
          if (entry) {
            entry.callSeq = event.seq
          }
        }
        break
      case 'tool/result':
        pendingCalls.delete(event.data.message.source.callId)
        break
      // Other event types do not move the turn/step boundary cursor.
      default:
        break
    }
  }

  // Balanced log (no open tail turn): nothing to close. An open turn implies
  // `events` is non-empty (its turn/start was logged), so `last` exists.
  const last = events.at(-1)
  if (openTurn === null || last === undefined) return []

  // The last real event supplies the seq base and the timestamp for the
  // synthetic closers (reusing the last timestamp keeps them deterministic and
  // never invents a "future" time).
  let seq = last.seq + 1
  const time = last.time
  const closers: SessionEvent[] = []

  // Close calls before their step; Map insertion order preserves transcript order.
  const text = CLOSER_TEXT[cause.kind]
  for (const [callId, { step, callSeq }] of pendingCalls) {
    const started = callSeq !== undefined
    const approval = started ? approvalRecovery(callId, askedApprovals, decidedApprovals) : 'unknown'
    let contentText: string
    let error: { name: string; code: string }
    if (approval === 'undecided') {
      contentText = text.approvalPending
      error = { name: 'ToolApprovalNotDecidedError', code: TOOL_APPROVAL_NOT_DECIDED }
    } else if (approval === 'denied') {
      contentText = text.approvalDenied
      error = { name: 'ToolApprovalDeniedError', code: TOOL_APPROVAL_DENIED }
    } else if (approval === 'expired') {
      contentText = text.approvalExpired
      error = { name: 'ToolApprovalExpiredError', code: TOOL_APPROVAL_EXPIRED }
    } else if (started) {
      contentText = text.started
      error = { name: 'ToolOutcomeUnknownError', code: TOOL_OUTCOME_UNKNOWN }
    } else {
      contentText = text.notStarted
      error = { name: 'ToolNotStartedError', code: TOOL_NOT_STARTED }
    }
    const message: ToolResultMessage = deepFreeze({
      id: brandString<MessageId>(`${cause.kind}-tool-result-${callId}-${seq}`),
      role: 'tool',
      toolCallId: callId,
      isError: true,
      source: { kind: 'tool', callId },
      content: [{
        type: 'text',
        text: contentText,
      }],
    })
    closers.push({
      type: 'tool/result',
      seq: SessionSeq(seq++),
      time,
      data: {
        turn: openTurn,
        step,
        message,
        error,
      },
      surfaceOp: 'append',
      ...started ? { sourceEventSeqs: [callSeq] } : {},
    })
  }

  // Close an open step next — a turn/end while a step is open is an invariant
  // violation, so the step's boundary must be synthesized before the turn's.
  if (openStep !== null) {
    closers.push({ type: 'step/end', seq: SessionSeq(seq++), time, data: { turn: openTurn, step: openStep } })
  }
  closers.push({ type: 'turn/end', seq: SessionSeq(seq++), time, data: { turn: openTurn, reason: { kind: cause.kind } } })
  return closers
}

/**
 * Crash-recovery entry point: synthetic closers that balance a persisted log
 * whose tail turn was interrupted. Used by crash-recovery callers; fork
 * seeds receive their `forked`-cause closers through `buildForkSeed` in
 * `./fork.ts`, and cause selection stays internal to those two owners.
 *
 * @param events - the persisted log to scan, possibly ending inside an open turn.
 * @returns the synthetic `interrupted` closer events to append after `events`; empty when the log is already balanced.
 */
export function interruptedTurnClosers(events: readonly SessionEvent[]): SessionEvent[] {
  return openTurnClosers(events, { kind: 'interrupted' })
}
