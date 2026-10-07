/**
 * Settled-child notice delivery that cannot silently drop a settlement.
 *
 * Every notice either reaches a parent's durable inbox or is retained here.
 * A live parent receives the notice through the rail's own placement rule
 * (waking when idle, steering while busy, a non-waking durable enqueue during
 * teardown or park); a send failure retries on a bounded backoff, and a parent
 * Agent that cannot be resolved leaves a pending record that the next
 * activation, idle transition, or inbox claim drains.
 *
 * A placement that queued the message without a wake records WHY. A `held`
 * notice was queued because the parent was unavailable (its teardown, or a
 * missing Agent): the record owes a wake, so the parent's next activation or
 * idle transition re-runs the rail's placement and wakes over it. A `parked`
 * notice was queued deliberately for a root parent in a user-initiated park or
 * an in-flight revert: the operator's next turn claims it, and the record
 * retires on that claim without ever forcing a wake.
 *
 * Delivery is idempotent by settlement key: a duplicate settlement event never
 * produces a second model-visible notice.
 *
 * Every retry, hold, and unresolved record is reported through the structured
 * logger. The persistent logger sink is this repository's diagnostics-ledger
 * seam: a profile that persists logs turns each line below into one ledger row
 * keyed by a stable code, so a lost result stays discoverable.
 *
 * @module @deepseek-ai/dsh-subagent/settlement-outbox
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { errorChain } from '@deepseek-ai/dsh-llm'
import type { MessageId } from '@deepseek-ai/dsh-llm'
import type { SessionId, UserMessage } from '@deepseek-ai/dsh-session'
import type { SubagentResult } from './types.ts'

/**
 * How one placement put a notice into a parent's durable inbox: `waking`
 * delivery opened or steered a turn; `held` recorded the message without a
 * wake because the parent was unavailable, so the record owes a later wake;
 * `parked` recorded the message without a wake by design, so only a claimed
 * turn retires it.
 */
export type NoticePlacement = 'waking' | 'held' | 'parked'

/**
 * Place one settlement notice into a live parent Agent's inbox through the
 * receiving rail's own rules. `alreadyQueued` reports that the exact message
 * is already pending in that inbox, so the rail must wake over the queued copy
 * instead of enqueueing a second one. A throw means nothing was accepted and
 * the outbox retries the same message.
 */
export type SettlementNoticeSender = (
  parent: Agent,
  message: UserMessage,
  stopReason: SubagentResult['stopReason'],
  alreadyQueued: boolean,
) => NoticePlacement

/** Transient send failures retried before the notice is held for the next activation. */
export const NOTICE_RETRY_ATTEMPTS = 4

/** First retry delay; each further attempt doubles it (25ms, 50ms, 100ms). */
export const NOTICE_RETRY_BASE_MS = 25

/** Retained delivery keys: duplicate settlements older than this window are not expected. */
const DELIVERED_CAP = 256

/** One settlement whose notice is in flight or held for a later wake. */
interface PendingNotice {
  readonly id: string
  readonly parentSession: SessionId
  readonly childId: SessionId
  readonly message: UserMessage
  readonly stopReason: SubagentResult['stopReason']
  /** The message is durably queued without a wake by design; only a claim retires it. */
  parked: boolean
  attempts: number
  /** Whether the "held pending" line was already reported. */
  pendingLogged: boolean
  timer: NodeJS.Timeout | undefined
}

/**
 * Retained settlement notices and their redelivery state for every continuable
 * child the registry settles.
 */
export class SettlementNoticeOutbox {
  private readonly pending = new Map<string, PendingNotice>()
  private readonly delivered = new Map<string, true>()
  private disposed = false

  /**
   * @param ctx - context providing the Agent registry and the logger.
   * @param send - rail-owned placement of one notice into a live parent inbox.
   */
  constructor(
    private readonly ctx: Context,
    private readonly send: SettlementNoticeSender,
  ) {}

  /**
   * Queue one settlement notice and attempt immediate delivery.
   * @param parentSession - durable parent session the notice addresses.
   * @param childId - durable settled child, also the idempotency subject.
   * @param key - per-settlement idempotency key (one Activation epoch).
   * @param message - durable model-visible settlement message.
   * @param stopReason - the epoch's stop reason, which placement re-evaluates.
   */
  notify(
    parentSession: SessionId,
    childId: SessionId,
    key: string,
    message: UserMessage,
    stopReason: SubagentResult['stopReason'],
  ): void {
    if (this.disposed) {
      this.reportUnresolved('outbox disposed before the notice was queued', childId, parentSession)
      return
    }
    const id = `${parentSession}\u0000${key}`
    if (this.pending.has(id) || this.delivered.has(id)) return
    const entry: PendingNotice = {
      id,
      parentSession,
      childId,
      message,
      stopReason,
      parked: false,
      attempts: 0,
      pendingLogged: false,
      timer: undefined,
    }
    this.pending.set(id, entry)
    this.attempt(entry)
  }

  /**
   * Retry every held notice for one parent session. Called on the parent's
   * activation and when it returns to idle; a fresh trigger restores the
   * retry budget. A parked notice is skipped: it waits for a claimed turn.
   * @param parentSession - session whose held notices are retried.
   */
  flush(parentSession: SessionId): void {
    if (this.disposed) return
    for (const entry of [...this.pending.values()]) {
      if (entry.parentSession !== parentSession || entry.parked) continue
      entry.attempts = 0
      this.attempt(entry)
    }
  }

  /**
   * Forget a notice the parent's inbox has now claimed: the model has the
   * message, so no later activation owes it a wake.
   * @param parentSession - session whose inbox changed.
   * @param messageId - the claimed message identity.
   */
  claimed(parentSession: SessionId, messageId: MessageId): void {
    for (const entry of [...this.pending.values()]) {
      if (entry.parentSession !== parentSession || entry.message.id !== messageId) continue
      this.complete(entry)
    }
  }

  /**
   * Clear retry timers. A notice still held when the owner unloads is reported
   * as unresolved instead of vanishing with the plugin.
   */
  dispose(): void {
    this.disposed = true
    for (const entry of this.pending.values()) {
      if (entry.timer !== undefined) clearTimeout(entry.timer)
      this.reportUnresolved('outbox disposed with the notice still undelivered', entry.childId, entry.parentSession)
    }
    this.pending.clear()
  }

  /** Attempt one placement, scheduling a bounded retry on a throw. */
  private attempt(entry: PendingNotice): void {
    if (entry.timer !== undefined) {
      clearTimeout(entry.timer)
      entry.timer = undefined
    }
    /* v8 ignore next -- dispose clears every timer and guards flush/notify, so no attempt starts after the outbox is disposed. */
    if (this.disposed) return
    const parent = this.ctx.agents.get(entry.parentSession)
    if (parent === undefined) {
      this.reportPending(entry)
      return
    }
    try {
      const placement = this.send(parent, entry.message, entry.stopReason, this.inInbox(parent, entry.message.id))
      if (placement === 'waking') {
        this.complete(entry)
        return
      }
      entry.parked = placement === 'parked'
    } catch (error: unknown) {
      entry.attempts += 1
      if (entry.attempts < NOTICE_RETRY_ATTEMPTS) {
        this.ctx.logger.warn(
          `subagent "${entry.childId}" settlement notice was not delivered `
          + `[SETTLEMENT_NOTICE_RETRY] attempt=${entry.attempts}/${NOTICE_RETRY_ATTEMPTS} `
          + `parent="${entry.parentSession}": ${errorChain(error)}`,
        )
        entry.timer = setTimeout(() => {
          entry.timer = undefined
          this.attempt(entry)
        }, NOTICE_RETRY_BASE_MS * 2 ** (entry.attempts - 1))
      } else {
        this.ctx.logger.warn(
          `subagent "${entry.childId}" settlement notice was not delivered after `
          + `${entry.attempts} attempts [SETTLEMENT_NOTICE_HELD] parent="${entry.parentSession}": `
          + `${errorChain(error)}; held for the parent's next activation or idle transition`,
        )
        entry.pendingLogged = true
      }
    }
  }

  /** Whether the exact message is already pending in one parent's inbox. */
  private inInbox(parent: Agent, messageId: MessageId): boolean {
    return parent.inbox.nextTurn.some(message => message.id === messageId)
      || parent.inbox.nextStep.some(message => message.id === messageId)
  }

  /** Remove one delivered notice and remember its key against a duplicate settlement. */
  private complete(entry: PendingNotice): void {
    /* v8 ignore next -- a throwing placement queues nothing for a claim to retire; timer and completion cannot overlap. */
    if (entry.timer !== undefined) clearTimeout(entry.timer)
    this.pending.delete(entry.id)
    this.delivered.set(entry.id, true)
    /* v8 ignore next 5 -- DELIVERED_CAP bounds retained keys across a long-lived process; no test drives 257 distinct settlements. */
    if (this.delivered.size > DELIVERED_CAP) {
      const oldest = this.delivered.keys().next().value
      if (oldest !== undefined) this.delivered.delete(oldest)
    }
  }

  /** Report a notice waiting for its parent, once per hold. */
  private reportPending(entry: PendingNotice): void {
    if (entry.pendingLogged) return
    entry.pendingLogged = true
    this.ctx.logger.info(
      `subagent "${entry.childId}" settlement notice held pending [SETTLEMENT_NOTICE_PENDING] `
      + `parent="${entry.parentSession}": the parent Agent is not live; `
      + 'it is delivered on the parent\'s next activation or wake',
    )
  }

  /** Report a notice the outbox could no longer recover. */
  private reportUnresolved(reason: string, childId: SessionId, parentSession: SessionId): void {
    this.ctx.logger.warn(
      `subagent "${childId}" settlement notice unresolved [SETTLEMENT_NOTICE_UNRESOLVED] `
      + `parent="${parentSession}": ${reason}`,
    )
  }
}
