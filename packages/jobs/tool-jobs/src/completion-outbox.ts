/**
 * Completion-notice delivery that cannot silently drop a settled job.
 *
 * Every owned job's completion notice either reaches a live owner's inbox or
 * is retained here. A live owner receives the notice through the rail's own
 * placement rule — waking an idle owner while its wake budget lasts, injecting
 * into a busy one — while a send failure retries on a bounded backoff, and an
 * owner Agent that cannot be resolved leaves a pending record that the next
 * activation or idle transition drains with a real wake.
 *
 * Delivery is idempotent by job id, so a duplicate settlement event never
 * produces a second model-visible notice, and a copy left queued by a failed
 * send is replaced by the retry instead of accumulating.
 *
 * Records live only in this process: unloading the plugin reports each one it
 * still holds. Every retry, hold, and unresolved record is reported through
 * the structured logger under the `[SETTLEMENT_NOTICE_*]` codes the subagent
 * settlement outbox uses, so a diagnostics sink that persists those lines
 * records a lost result from either rail.
 *
 * @module @deepseek-ai/dsh-tool-jobs/completion-outbox
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { errorChain } from '@deepseek-ai/dsh-llm'
import type { MessageId } from '@deepseek-ai/dsh-llm'
import type { SessionId, UserMessage } from '@deepseek-ai/dsh-session'
import type { JobId } from '@deepseek-ai/dsh-jobs'

/**
 * Place one completion notice into a live owner Agent's inbox through the
 * rail's own rules. `alreadyQueued` reports that the exact message is already
 * pending in that inbox, so the rail replaces the queued copy instead of
 * enqueueing a second one. A throw means nothing was accepted and the outbox
 * retries the same message.
 */
export type CompletionNoticeSender = (
  owner: Agent,
  message: UserMessage,
  alreadyQueued: boolean,
) => void

/** Transient send failures retried before the notice is held for the next activation. */
export const NOTICE_RETRY_ATTEMPTS = 4

/** First retry delay; each further attempt doubles it (25ms, 50ms, 100ms). */
export const NOTICE_RETRY_BASE_MS = 25

/** Retained delivery keys: duplicate settlements older than this window are not expected. */
const DELIVERED_CAP = 256

/** One completion whose notice is in flight or held for a later wake. */
interface PendingNotice {
  readonly id: string
  readonly ownerSession: SessionId
  readonly jobId: JobId
  readonly message: UserMessage
  /** A send was attempted, so the message may already be queued from a throw after acceptance. */
  attempted: boolean
  attempts: number
  /** Whether the "held pending" line was already reported. */
  pendingLogged: boolean
  timer: NodeJS.Timeout | undefined
}

/**
 * Retained completion notices and their redelivery state for every owned job
 * this rail reports settled.
 */
export class CompletionNoticeOutbox {
  private readonly pending = new Map<string, PendingNotice>()
  private readonly delivered = new Map<string, true>()
  private disposed = false

  /**
   * @param ctx - context providing the Agent registry and the logger.
   * @param send - rail-owned placement of one notice into a live owner inbox.
   */
  constructor(
    private readonly ctx: Context,
    private readonly send: CompletionNoticeSender,
  ) {}

  /**
   * Queue one completion notice and attempt immediate delivery.
   * @param ownerSession - durable owner session the notice addresses.
   * @param jobId - settled job, also the idempotency subject.
   * @param message - durable model-visible completion message.
   */
  notify(ownerSession: SessionId, jobId: JobId, message: UserMessage): void {
    if (this.disposed) {
      this.reportUnresolved('outbox disposed before the notice was queued', jobId, ownerSession)
      return
    }
    const id = `${ownerSession}\u0000${jobId}`
    if (this.pending.has(id) || this.delivered.has(id)) return
    const entry: PendingNotice = {
      id,
      ownerSession,
      jobId,
      message,
      attempted: false,
      attempts: 0,
      pendingLogged: false,
      timer: undefined,
    }
    this.pending.set(id, entry)
    this.attempt(entry)
  }

  /**
   * Retry every held notice for one owner session. Called on the owner's
   * activation and when it returns to idle; a fresh trigger restores the
   * retry budget.
   * @param ownerSession - session whose held notices are retried.
   */
  flush(ownerSession: SessionId): void {
    if (this.disposed) return
    for (const entry of [...this.pending.values()]) {
      if (entry.ownerSession !== ownerSession) continue
      entry.attempts = 0
      this.attempt(entry)
    }
  }

  /**
   * Forget a notice the owner's inbox has now claimed: the model has the
   * message, so no later activation owes it a wake.
   * @param ownerSession - session whose inbox changed.
   * @param messageId - the claimed message identity.
   */
  claimed(ownerSession: SessionId, messageId: MessageId): void {
    for (const entry of [...this.pending.values()]) {
      if (entry.ownerSession !== ownerSession) continue
      if (entry.message.id !== messageId) continue
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
      this.cancelRetry(entry)
      this.reportUnresolved('outbox disposed with the notice still undelivered', entry.jobId, entry.ownerSession)
    }
    this.pending.clear()
  }

  /** Drop one entry's pending retry, if any. */
  private cancelRetry(entry: PendingNotice): void {
    if (entry.timer === undefined) return
    clearTimeout(entry.timer)
    entry.timer = undefined
  }

  /** Attempt one placement, scheduling a bounded retry on a throw. */
  private attempt(entry: PendingNotice): void {
    this.cancelRetry(entry)
    /* v8 ignore next -- dispose clears every timer and guards flush/notify, so no attempt starts after the outbox is disposed. */
    if (this.disposed) return
    const owner = this.ctx.get('agents')?.get(entry.ownerSession)
    if (owner === undefined) {
      this.reportPending(entry)
      return
    }
    try {
      // A first placement owns a fresh message; only a re-attempt can find a
      // copy the previous send queued before throwing.
      const alreadyQueued = entry.attempted && this.inInbox(owner, entry.message.id)
      entry.attempted = true
      this.send(owner, entry.message, alreadyQueued)
      this.complete(entry)
    } catch (error: unknown) {
      entry.attempts += 1
      if (entry.attempts < NOTICE_RETRY_ATTEMPTS) {
        this.ctx.logger.warn(
          `background job "${entry.jobId}" completion notice was not delivered `
          + `[SETTLEMENT_NOTICE_RETRY] attempt=${entry.attempts}/${NOTICE_RETRY_ATTEMPTS} `
          + `owner="${entry.ownerSession}": ${errorChain(error)}`,
        )
        entry.timer = setTimeout(() => {
          entry.timer = undefined
          this.attempt(entry)
        }, NOTICE_RETRY_BASE_MS * 2 ** (entry.attempts - 1))
      } else {
        this.ctx.logger.warn(
          `background job "${entry.jobId}" completion notice was not delivered after `
          + `${entry.attempts} attempts [SETTLEMENT_NOTICE_HELD] owner="${entry.ownerSession}": `
          + `${errorChain(error)}; held for the owner's next activation or idle transition`,
        )
        entry.pendingLogged = true
      }
    }
  }

  /** Whether the exact message is already pending in one owner's inbox. */
  private inInbox(owner: Agent, messageId: MessageId): boolean {
    const pending = [...owner.inbox.nextTurn, ...owner.inbox.nextStep]
    return pending.some(message => message.id === messageId)
  }

  /** Remove one delivered notice and remember its key against a duplicate settlement. */
  private complete(entry: PendingNotice): void {
    this.cancelRetry(entry)
    this.pending.delete(entry.id)
    this.delivered.set(entry.id, true)
    this.trimDelivered()
  }

  /** Evict the oldest delivered key once the retained window fills. */
  private trimDelivered(): void {
    /* v8 ignore start -- DELIVERED_CAP bounds retained keys across a long-lived process; no test drives 257 distinct settlements. */
    if (this.delivered.size > DELIVERED_CAP) {
      const oldest = this.delivered.keys().next().value
      if (oldest !== undefined) this.delivered.delete(oldest)
    }
    /* v8 ignore stop */
  }

  /** Report a notice waiting for its owner, once per hold. */
  private reportPending(entry: PendingNotice): void {
    if (entry.pendingLogged) return
    entry.pendingLogged = true
    this.ctx.logger.info(
      `background job "${entry.jobId}" completion notice held pending [SETTLEMENT_NOTICE_PENDING] owner="${entry.ownerSession}": the owner Agent is not live; it is delivered on the owner's next activation or wake`,
    )
  }

  /** Report a notice the outbox could no longer recover. */
  private reportUnresolved(reason: string, jobId: JobId, ownerSession: SessionId): void {
    this.ctx.logger.warn(
      `background job "${jobId}" completion notice unresolved [SETTLEMENT_NOTICE_UNRESOLVED] `
      + `owner="${ownerSession}": ${reason}`,
    )
  }
}
