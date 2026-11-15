/**
 * Lifecycle-edge publication for both subagent shapes: the contained emitter,
 * the one-shot run observer, and the continuable Activation observer.
 *
 * The public payload contracts ({@link SubagentRunInfo},
 * {@link SubagentRunEndInfo}) live in `./types.ts` with the rest of the seam's
 * consumer-facing types; this module owns only the implementation and the
 * package-private {@link ActivationObserver} the continuation manager consumes.
 * Keeping the internal control interface out of the published surface is
 * deliberate: the observer's `start`/`capture`/`settle` ordering is a contract
 * between this module and one in-package caller, not something a plugin may
 * depend on.
 *
 * @module @deepseek-ai/dsh-subagent/lifecycle
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { foldConsumedWork } from '@deepseek-ai/dsh-agent'
import { SessionLogOffset } from '@deepseek-ai/dsh-session'
import type {
  SessionEvent,
  SessionId,
  SessionLogOffset as SessionLogOffsetType,
  SessionSeq,
} from '@deepseek-ai/dsh-session'
import { finalAssistantOutput, joinedAssistantText } from './assistant-output.ts'
import { SubagentRunId } from './types.ts'
import type { SubagentResult, SubagentRun, SubagentRunEndInfo, SubagentRunInfo } from './types.ts'

/**
 * The structured reason one epoch stopped before finishing. The code is the
 * provider-neutral code the ending turn recorded when it recorded one; a
 * harness reason code otherwise. No error text is carried: the child's own log
 * remains the authority for details, and a notice stays bounded; credential redaction
 * is best-effort, not a security scanner.
 */
export interface ActivationFailure {
  /** Stable machine-routing code for the ending. */
  readonly code: string
  /**
   * Whether the ending provably discarded accepted input, so the work cannot
   * be recovered by continuing the child. Absent when that is unknown; absence
   * must not be read as a recovery promise.
   */
  readonly recoverable?: boolean
}

/**
 * The last log event in one epoch that proves the child completed a tool
 * operation successfully. It gives a parent a concrete seq to inspect without
 * treating the child's closing prose as verification.
 */
export interface ActivationOperationRef {
  /** Event seq of the last successful `tool/result` in the epoch. */
  readonly seq: SessionSeq
}

/**
 * How one Activation's residency epoch ended, as both the terminal lifecycle
 * edge and the manager's own parent delivery report it.
 */
export interface ActivationTerminal {
  /** Why this epoch's last ordinary turn ended, or `error` when teardown failed. */
  readonly stopReason: SubagentResult['stopReason']
  /** The epoch's final assistant content, absent when it produced none or failed. */
  readonly output?: readonly ContentBlock[]
  /** The structured ending when the epoch stopped before finishing. */
  readonly failure?: ActivationFailure
  /** Last successful tool operation in the epoch, when one is recorded. */
  readonly lastSuccessfulOperation?: ActivationOperationRef
  /** Last public (text-only) assistant content in the epoch, when one exists. */
  readonly lastPublicText?: string
}

/**
 * Lifecycle observer for one Activation's residency epoch, so continuable
 * children emit the same start/end pair as one-shot runs. Package-private: the
 * continuation manager is the only consumer, and its call ordering is an
 * in-package contract rather than a published extension point.
 */
export interface ActivationObserver {
  /**
   * Publish the start edge once the epoch is resident.
   * @param child - the resident child agent, whose log suffix bounds this epoch.
   */
  start(child: Agent): void
  /**
   * Snapshot the child-dependent terminal facts while the child is still
   * registered, because handle disposal unregisters it and consumers resolve it
   * to read the child's own log and scope.
   * @param child - the quiescent child agent about to be released.
   * @param joinTurns - join every assistant message of the epoch instead of
   *   selecting the last one, for an epoch the harness continued after an
   *   output-budget truncation.
   */
  capture(child: Agent, joinTurns?: boolean): void
  /**
   * Whether this epoch's latest settled turn was cut off by the model's output
   * budget. The owning registry asks before releasing a quiescent child, so a
   * truncated epoch can run its remaining continuation turns instead of
   * reporting a half answer as finished.
   * @param child - the quiescent child agent, whose log suffix bounds this epoch.
   */
  truncated(child: Agent): boolean
  /**
   * Resolve the terminal facts {@link settle} will publish, without publishing
   * them. The manager's parent delivery must run before the ownership release
   * that lets the parent settle, which is earlier than the terminal edge; both
   * therefore read one computation instead of restating the failure rule.
   * @param failure - the teardown or durability failure, or `undefined` on success.
   * @returns this epoch's stop reason and final assistant content.
   */
  terminal(failure: unknown): ActivationTerminal
  /**
   * Publish the terminal edge exactly once, pairing this epoch's {@link start},
   * after the disposal outcome is known. Called only for a resident epoch: a
   * failure before residency publishes no edge, because inventing one would
   * report a lifecycle the child never had.
   * @param failure - the teardown or durability failure, or `undefined` on success.
   */
  settle(failure: unknown): void
}

/**
 * Publish one lifecycle edge with per-listener exception containment. Run edges
 * carry the delegating parent that keys scoped dispatch; provider removal has no
 * parent carrier and reaches listeners unscoped.
 *
 * The service owns this closure because scoped dispatch keys its carrier by the
 * exact service instance, whose own context filter composes into the carrier;
 * a narrowed stand-in would silently change scope filtering.
 */
export type LifecycleEmitter = {
  (name: 'subagent/start', info: SubagentRunInfo, parent: Agent): void
  (name: 'subagent/end', info: SubagentRunEndInfo, parent: Agent): void
  (name: 'subagent/provider-removed', info: string): void
}

/**
 * Build the contained lifecycle emitter this seam publishes every edge through.
 * Every listener is independently contained: a synchronous throw or a rejected
 * returned promise is logged without starving peer listeners, changing the run,
 * or — for provider removal, which fires from a disposer — breaking teardown.
 * @param ctx - the service's own context, owning dispatch and the logger.
 * @param carrier - resolve the scoped dispatch carrier for one delegating parent.
 * @returns the emitter both observers and the provider registry publish through.
 */
export function createLifecycleEmitter(
  ctx: Context,
  carrier: (parent: Agent) => object,
): LifecycleEmitter {
  return (
    name: 'subagent/start' | 'subagent/end' | 'subagent/provider-removed',
    info: SubagentRunInfo | SubagentRunEndInfo | string,
    parent?: Agent,
  ): void => {
    const dispatchArgs: unknown[] = parent === undefined
      ? [name, info]
      : [carrier(parent), name, info]
    for (const callback of ctx.events.dispatch('emit', dispatchArgs)) {
      try {
        const returned: unknown = callback(info)
        void Promise.resolve(returned).catch((error: unknown) => {
          ctx.logger.warn(`subagent: ${name} listener rejected: ${renderThrown(error)}`)
        })
      } catch (error: unknown) {
        ctx.logger.warn(`subagent: ${name} listener threw: ${renderThrown(error)}`)
      }
    }
  }
}

/**
 * Emit the start/end lifecycle pair for one accepted one-shot run.
 * @param emit - the contained lifecycle emitter.
 * @param provider - the provider that established the run.
 * @param parent - the delegating parent keying scoped dispatch.
 * @param run - the published run whose settlement closes the pair.
 * @returns the same run, unchanged.
 */
export function observeRun(
  emit: LifecycleEmitter,
  provider: string,
  parent: Agent,
  run: SubagentRun,
): SubagentRun {
  const identity = {
    runId: SubagentRunId(randomUUID()),
    provider,
    id: run.id,
    local: run.localAgent !== undefined,
  }
  // Attach the terminal observer before dispatching start. Promise reactions
  // still run after this synchronous start emission, preserving start → end.
  void run.result.then(
    (result) => {
      emit('subagent/end', {
        ...identity,
        stopReason: result.stopReason,
        // Omit the field when no output exists, matching continuable epochs.
        ...result.output.length === 0 ? {} : { lastAssistantMessage: result.output },
      }, parent)
    },
    () => {
      emit('subagent/end', { ...identity, stopReason: 'error' }, parent)
    },
  )
  emit('subagent/start', identity, parent)
  return run
}

/**
 * Build the observer for one continuable Activation's residency epoch. Observers
 * see the same vocabulary as a one-shot run, so a child's start and settlement
 * remain observable without exposing whether the manager materialized, woke, or
 * cold-resumed it. Creation failure before residency emits no lifecycle edge.
 * @param emit - the contained lifecycle emitter.
 * @param provider - the provider name recorded in the durable descriptor.
 * @param childId - the durable child session id.
 * @param parent - the exact live direct parent keying scoped dispatch.
 * @returns the observer whose edges this epoch publishes.
 */
export function createActivationObserver(
  emit: LifecycleEmitter,
  provider: string,
  childId: SessionId,
  parent: Agent,
): ActivationObserver {
  const identity = { runId: SubagentRunId(randomUUID()), provider, id: childId, local: true }
  // A cold resume replays earlier turns, so this epoch's telemetry must come
  // from the suffix it actually produced — never the whole session, which
  // would report a previous epoch's answer when this one opened no turn.
  let boundary: SessionLogOffsetType = SessionLogOffset(0)
  // Assigned by `capture()`, which the disposal path always runs before
  // `settle()`; a resident epoch therefore always has its facts by then.
  let captured: ActivationTerminal = { stopReason: 'completed' }
  // Teardown failure overrides the epoch's own outcome and withholds its
  // output: an answer this harness could not durably release is not a result.
  // The diagnostic facts (evidence seq, last public text) still travel: they
  // describe what the log recorded, not a result the harness failed to keep.
  const terminal = (failure: unknown): ActivationTerminal => failure === undefined
    ? captured
    : {
      stopReason: 'error',
      failure: { code: 'TEARDOWN_FAILED' },
      ...captured.lastSuccessfulOperation === undefined
        ? {}
        : { lastSuccessfulOperation: captured.lastSuccessfulOperation },
      ...captured.lastPublicText === undefined ? {} : { lastPublicText: captured.lastPublicText },
    }
  return {
    start: (child: Agent): void => {
      boundary = child.session.seq
      emit('subagent/start', identity, parent)
    },
    capture: (child: Agent, joinTurns = false): void => {
      // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
      const own = child.session.snapshotEvents(boundary)
      const output = (joinTurns ? joinedAssistantText(own) : finalAssistantOutput(own)) ?? undefined
      const consumed = foldConsumedWork(own)
      const failure = activationFailure(consumed)
      const lastSuccessfulOperation = lastSuccessfulOperationOf(own)
      const lastPublicText = lastPublicTextOf(own)
      captured = {
        stopReason: epochStopReasonOf(consumed),
        ...output === undefined ? {} : { output },
        ...failure === undefined ? {} : { failure },
        ...lastSuccessfulOperation === undefined ? {} : { lastSuccessfulOperation },
        ...lastPublicText === undefined ? {} : { lastPublicText },
      }
    },
    truncated: (child: Agent): boolean => {
      // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
      return epochStopReason(child.session.snapshotEvents(boundary)) === 'max-tokens'
    },
    terminal,
    settle: (failure: unknown): void => {
      const { stopReason, output } = terminal(failure)
      emit('subagent/end', {
        ...identity,
        stopReason,
        ...output === undefined ? {} : { lastAssistantMessage: output },
      }, parent)
    },
  }
}

/**
 * Why this child's epoch ended, for the terminal lifecycle edge and the
 * manager's own parent delivery. The child's own log is authoritative:
 * teardown succeeding says nothing about whether the model errored, hit its
 * token ceiling, or was cancelled, so deriving the reason from disposal would
 * report failed work as completed.
 *
 * {@link foldConsumedWork} supplies both halves the raw turn sequence cannot:
 * which turn accounts for the work this epoch consumed, and whether accepted
 * work was cancelled after it without any turn opening over it. A recorded
 * failure still wins over a cancellation — stopping a child that had already
 * failed does not turn its failure into a cancellation.
 * @param events - this epoch's own event suffix.
 * @returns its terminal stop reason; `completed` only for an epoch that both
 *   closed cleanly and had nothing left to run.
 */
function epochStopReason(events: readonly SessionEvent[]): SubagentResult['stopReason'] {
  return epochStopReasonOf(foldConsumedWork(events))
}

/** Apply the epoch stop rule to an already-folded account of consumed work. */
function epochStopReasonOf(
  consumed: ReturnType<typeof foldConsumedWork>,
): SubagentResult['stopReason'] {
  const { end, droppedUnrun } = consumed
  switch (end?.data.reason.kind) {
    case 'max-tokens':
      return 'max-tokens'
    case 'aborted':
    case 'interrupted':
      return 'aborted'
    case 'error':
      return 'error'
    // A pre-step rejection — a hook deny, a policy plugin — discarded input
    // this epoch had claimed: the work was declined, not done.
    case 'blocked':
      return 'refusal'
    // A clean ending and no accounting turn at all share one rule: the epoch
    // finished what it was given unless a cancelled queue says otherwise.
    case undefined:
    case 'completed':
      return droppedUnrun ? 'aborted' : 'completed'
    /* v8 ignore next 4 -- `forked` appears only in constructor seed history, while
     * this function reads an epoch-owned suffix. `TurnEndReason` is merge-extensible,
     * so a backend-added variant cannot be listed; treating an unnameable reason as
     * success would report failed work as completed. */
    default:
      return 'error'
  }
}

/**
 * Name the structured reason one epoch stopped early. A recorded provider
 * failure wins over a later unrun cancellation, mirroring the stop rule; a
 * clean ending with cancelled unrun work still reports the cancellation. A
 * `completed` epoch with no dropped work has no failure.
 */
function activationFailure(
  consumed: ReturnType<typeof foldConsumedWork>,
): ActivationFailure | undefined {
  const reason = consumed.end?.data.reason
  if (reason === undefined) {
    return consumed.droppedUnrun ? { code: 'WORK_DROPPED_UNRUN', recoverable: false } : undefined
  }
  switch (reason.kind) {
    case 'error':
      return { code: reason.error.code === '' ? 'UNKNOWN' : reason.error.code }
    case 'aborted':
      return reason.error === undefined
        ? { code: 'TURN_ABORTED' }
        : { code: reason.error.code === '' ? 'UNKNOWN' : reason.error.code }
    // A pre-step rejection discarded the claimed input, so continuing the
    // child starts new work rather than recovering this task.
    case 'blocked':
      return { code: 'TURN_BLOCKED', recoverable: false }
    case 'max-tokens':
      return { code: 'OUTPUT_TOKEN_LIMIT' }
    case 'interrupted':
      return { code: 'TURN_INTERRUPTED' }
    case 'completed':
      return consumed.droppedUnrun
        ? { code: 'WORK_DROPPED_UNRUN', recoverable: false }
        : undefined
    /* v8 ignore next 4 -- See epochStopReasonOf: `forked` is seed-only and a
     * backend-added ending cannot be listed; name it instead of claiming success. */
    default:
      return { code: 'UNRECOGNIZED_TURN_END' }
  }
}

/** The last successful tool result in one epoch-owned suffix. */
function lastSuccessfulOperationOf(
  events: readonly SessionEvent[],
): ActivationOperationRef | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event === undefined || event.type !== 'tool/result') continue
    if (event.data.error !== undefined || event.data.message.isError === true) continue
    return { seq: event.seq }
  }
  return undefined
}

/** The last public (text-only) assistant content in one epoch-owned suffix. */
function lastPublicTextOf(events: readonly SessionEvent[]): string | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event === undefined || event.type !== 'assistant/message') continue
    const text = event.data.message.content
      .flatMap(block => block.type === 'text' && block.text.trim() !== '' ? [block.text.trim()] : [])
      .join('\n')
    if (text !== '') return text
  }
  return undefined
}

/** Render any listener-thrown value without letting coercion escape containment. */
function renderThrown(value: unknown): string {
  try {
    return value instanceof Error ? `${value.name}: ${value.message}` : String(value)
  } catch {
    return '<unrenderable thrown value>'
  }
}
