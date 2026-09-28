/**
 * Wire-safe approval identifiers and outcome vocabulary, free of
 * cordis/service imports so browser type chains can
 * consume them without loading this package's Context augmentation.
 * @module @deepseek-ai/dsh-user-approval/types
 */

import type { Branded } from '@deepseek-ai/dsh-brand'
import type { Scoped } from '@deepseek-ai/dsh-scope'
import type { Agent } from '@deepseek-ai/dsh-agent/types'
import type { ToolCallId } from '@deepseek-ai/dsh-llm/brand'

/**
 * Pairs one `approval/asked` audit event with its `approval/decided`.
 * Service-issued (one fresh id per {@link ApprovalService.request} call).
 */
export type ApprovalRequestId = Branded<'ApprovalRequestId'>

/**
 * Brand a string as an {@link ApprovalRequestId}.
 * @param id - the raw id string to brand.
 * @returns the same string carrying the brand.
 */
export function ApprovalRequestId(id: string): ApprovalRequestId {
  return id as ApprovalRequestId
}

/**
 * Closed approval outcomes: a one-shot grant, the DEFAULT standing
 * allow-always decision, the answerer's explicit BROAD standing decision (the
 * card's separate "allow all" action, offered only when the asker supplies
 * {@link ApprovalRequestEvent.broadAllow}), explicit rejection, withdrawn
 * request, or unavailable answerer. Both standing outcomes grant the call;
 * the asker decides what each pin covers. Callers fail closed on `unavailable`.
 */
export type ApprovalOutcome = 'allowed-once' | 'allowed-always' | 'allowed-always-broad' | 'rejected' | 'cancelled' | 'unavailable'

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * An approval question was put to the answerer chain — log-only audit
     * (like `hook/*`; NOT a surface event, carries no `surfaceOp`). `id` pairs
     * it with the `approval/decided` that always follows; `toolName` is the
     * tool the question is about, `callId` the exact tool call when the asker
     * had one, `reason` the asker's human-readable explanation (e.g. a hook's
     * permission-decision reason).
     */
    'approval/asked': {
      id: ApprovalRequestId
      toolName: string
      callId?: ToolCallId
      reason?: string
    }
    /**
     * The outcome of a prior `approval/asked` (same `id`) — log-only audit.
     * Exactly one per ask, appended when the outcome is known: a decision, a
     * cancellation, or the fail-closed `'unavailable'`.
     */
    'approval/decided': {
      id: ApprovalRequestId
      outcome: ApprovalOutcome
    }
  }
}

/** Client-safe payload declared for the approval answerer waterfall. */
export interface ApprovalRequestEvent {
  /** Agent identity projected to the corresponding Client Context in transit. */
  readonly agent: Agent
  /** Tool whose operation requires a decision. */
  readonly toolName: string
  /** Exact tool call being decided, when available. */
  readonly callId?: ToolCallId
  /** Human-readable reason supplied by the asker. */
  readonly reason?: string
  /** Localized presentation only; never persisted in approval audit events. */
  readonly displayReason?: { readonly en: string; readonly [locale: string]: string }
  /**
   * Presentation-only offer of the explicit broad standing action: the card
   * adds a separate "allow all {label}" button that answers
   * `'allowed-always-broad'`. Absent means the card offers only once/default.
   */
  readonly broadAllow?: { readonly label: string }
  /**
   * Presentation-only advisory recommendation for a forwarded ask (Enpoi
   * forwarded child approvals). The card renders it as its own highlighted
   * line with the suggestion as a hint; it is NEVER applied automatically and
   * never persisted in the approval audit events — only a human (or the
   * session's own standing approval mode) decides. Absent on ordinary asks.
   */
  readonly recommendation?: ApprovalRecommendation
  /** Cancellation lifetime of the pending request. */
  readonly signal?: AbortSignal
}

/** Advisory recommendation line one forwarded approval card renders (never applied automatically). */
export interface ApprovalRecommendation {
  /** One short sentence the card shows. */
  readonly text: string
  /** Advisory suggestion shown as a hint; the human still answers the card. */
  readonly suggestion?: 'allow' | 'reject' | 'allow-once'
  /** Who produced the line: the root-side model, or the forwarder's derived heuristic. */
  readonly source?: 'model' | 'derived'
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * Ask composed answerers for one decision. Return an outcome to claim the
     * request or call `next()` to delegate. Scope-filtered dispatch
     * (`@deepseek-ai/dsh-scope`): agent-scoped listeners receive only that agent.
     * @param req - pending approval request.
     * @mode waterfall
     */
    'approval/request'(
      this: Scoped<Agent>,
      req: ApprovalRequestEvent,
      next: () => Promise<ApprovalOutcome>,
    ): Promise<ApprovalOutcome>
  }
}
