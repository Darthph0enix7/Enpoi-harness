/**
 * The outward sessions-service face — what `ctx.sessions` exposes to feature
 * packages. Transport entry points and implementation internals stay on
 * the concrete class. Widening this interface is the
 * explicit act of widening what features may do to the sessions domain.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { SubagentAddress } from '@deepseek-ai/dsh-subagent/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { AgentContext } from '../scope.ts'
import type { SessionSearchResultItem } from '../sessions/manager.ts'
import type { SessionBinding, SessionListState } from '../sessions/service.ts'
import type {
  SessionIterationGroup,
  SessionRequestSnapshotRequest,
  SessionRequestSnapshotValue,
} from '../../types.ts'
import type { SessionFace } from './session.ts'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { SessionReferenceSource } from '../index.ts'

export type { AgentContext } from '../scope.ts'

/** Known Session identity or durable direct-parent subagent address; an address owns no lifetime. */
export type SessionTarget = SessionId | SubagentAddress

/** One independent use of an exact Client generation, without Host Agent ownership. */
export interface SessionReference extends Disposable {
  readonly sessionId: SessionId
  /** Shared binding; access fails after reference release or generation disposal. */
  readonly binding: SessionBinding
  /** This reference's cancellable wait for the shared initial `Session.open()` attempt to settle. */
  readonly ready: Promise<SessionBinding>
  /** Release once; the final reference starts local scope and history teardown. */
  release(): void
}

/** Consumer identity and optional cancellation of one acquisition waiter. */
export interface SessionRetainOptions {
  readonly source: SessionReferenceSource
  readonly signal?: AbortSignal | undefined
}

/** Local ownership counts, independent of catalog membership and never persisted. */
export interface SessionRetainInfo {
  readonly referenceCount: number
  /** Positive source counts only; a source without references is absent. */
  readonly retainedBy: Readonly<Partial<Record<SessionReferenceSource, number>>>
}

/** The sessions-service face injected as `ctx.sessions`. */
export interface ISessions {
  /** Host catalog and local reference-source counts; navigation belongs to view owners. */
  readonly list: ObservableSnapshot<SessionListState>
  /**
   * Retain an exact Client generation and start its shared initial history opening.
   * @param target - known identity or durable direct-parent address.
   * @param options - required consumer source and optional independent waiter cancellation.
   * @returns an owned reference immediately; await `reference.ready` when the initial open attempt must settle first.
   */
  retain(target: SessionTarget, options: SessionRetainOptions): SessionReference
  /**
   * Hold one reference through callback settlement, including synchronous and asynchronous failures.
   * @param target - Session to acquire.
   * @param options - source and acquisition cancellation.
   * @param operation - callback using the reference only until its returned value or Promise settles.
   * @returns the callback result after release; acquisition and callback failures propagate unchanged.
   */
  using<T>(target: SessionTarget, options: SessionRetainOptions, operation: (reference: SessionReference) => T | Promise<T>): Promise<T>
  /**
   * Observe local reference counts without retaining, creating a scope, or opening history.
   * The returned source keeps stable identity across same-id generations and remains allocated
   * until the Client root is disposed, even after its final subscriber leaves.
   * @param id - explicit Session identity; Host existence is not implied.
   * @returns a stable read-only source across same-id generations, with zero counts when none is live.
   */
  retainInfo(id: SessionId): ObservableSnapshot<SessionRetainInfo>
  /**
   * The `session.search` result bound the wire schema fixes, exposed to
   * presentation as injected data. Not per-connection state: every transport
   * (fixture included) reports the same number.
   */
  readonly searchResultLimit: number
  /**
   * Create or adopt a Session on the Host.
   * @param opts - target workspace, directory, and optional preallocated identity.
   * @returns the catalogued identity; retain it before borrowing its binding.
   */
  create(opts?: {
    workspaceId?: WorkspaceId
    cwd?: string
    sessionId?: SessionId
  }): Promise<SessionId>
  /**
   * Resolve an already discovered direct-parent address without opening it.
   * @param id - possible addressed child id.
   * @returns a retained or loaded-catalog address, without retaining a new selection or scope.
   */
  subagentAddress(id: SessionId): SubagentAddress | undefined

  /**
   * Load all Session projections once per connection; retry an unsuccessful initial read.
   * @param sessionId - Session to inspect without opening its conversation.
   * @returns completion of the current or newly started refresh.
   */
  refreshProjections(sessionId: SessionId): Promise<void>

  /**
   * Refresh the Host-authoritative Session list window.
   * @returns completion of the current or newly started Session-list refresh.
   */
  refresh(): Promise<void>
  /**
   * Append the next older window of Host Session rows for consumers that need
   * beyond the newest-first window (scroll, search, archived views).
   * @returns completion of the current or newly started next-window pull.
   */
  loadMore(): Promise<void>
  /**
   * Search the Host's visible message-content index. Results stay
   * request-local; the list snapshot remains the metadata authority.
   * @param query - non-blank literal phrase.
   * @param signal - cancellation for a superseded search.
   * @returns bounded results, or a business/transport error.
   */
  search(
    query: string,
    signal: AbortSignal,
  ): Promise<RemoteResult<{ items: SessionSearchResultItem[]; hasMore: boolean }>>
  /**
   * Read what the model was actually sent for one Session's most recent main
   * request (the LLM seam's per-Session wire capture). The default summary
   * carries digests and sizes only; `includeBodies` also returns the
   * secret-bearing bodies (full system prompt, tool schemas, message text).
   * @param request - Session identity and whether bodies are requested.
   * @param signal - cancellation for the capture read.
   * @returns the captured request, or a business/transport failure.
   */
  requestSnapshot(
    request: SessionRequestSnapshotRequest,
    signal: AbortSignal,
  ): Promise<RemoteResult<SessionRequestSnapshotValue>>
  /**
   * Fork a session from an exact inclusive prefix of the source; on
   * resolution the child is catalogued and can be explicitly retained.
   * @param opts - source session id, the optional exact inclusive boundary
   *   seq (a real event seq the caller already knows; a cut inside an open
   *   turn is balanced Host-side with synthetic closers, and omission selects
   *   the latest completed-turn prefix), and whether to increment an
   *   inherited durable title before resolving.
   * @returns the child session id.
   * @throws when the fork fails, or when a requested child-title rename fails after creation.
   */
  fork(opts: { sessionId: SessionId; atSeq?: number; increaseTitle?: boolean }): Promise<SessionId>
  /**
   * Select a model for one Session (durable model-selection fold).
   * @param opts - session and the provider/model/effort selection.
   * @returns the accepted selection after Host resolution.
   */
  selectModel(opts: {
    sessionId: SessionId
    provider: string
    model: string
    reasoningEffort?: string
  }): Promise<{ selected: { provider: string; model: string; reasoningEffort?: string } }>
  /**
   * Revert the conversation from a user message: everything after `atSeq`
   * becomes reverted (hidden from the transcript and the model surface on the
   * next commit). Returns the reverted query text for the input card.
   * @param opts - session and the user-message seq anchoring the revert.
   * @returns the reverted query text and the number of reverted messages.
   * @throws when the host rejects the anchor.
   */
  revert(opts: { sessionId: SessionId; atSeq: number }): Promise<{ revertedText: string; revertedCount: number }>
  /**
   * Restore reverted messages: `restoreSeq` omitted restores everything;
   * `restoreSeq` set restores that message and everything after it.
   * @param opts - session and the optional restore boundary.
   * @throws when the host rejects the restore.
   */
  revertRestore(opts: { sessionId: SessionId; restoreSeq?: number }): Promise<void>
  /**
   * List the durable iteration groups of one Session: the variant chains the
   * ◀ x/y ▶ control navigates. Cold-safe; previews are capped and media is
   * referenced by attachment id.
   * @param opts - session, optional group anchor, and listing bounds.
   * @returns groups in anchor order with variants in creation order.
   * @throws when the host rejects the read.
   */
  revertIterations(opts: {
    sessionId: SessionId
    anchorSeq?: number
    limit?: number
    beforeVariantSeq?: number
  }): Promise<readonly SessionIterationGroup[]>
  /**
   * Switch the active conversation branch to one iteration variant: the
   * target branch's original records become the model surface and the
   * displaced branch becomes shadowed. No user message, turn, or model call
   * runs; the switch is one durable log event. `requestId` makes a retried
   * call idempotent.
   * @param opts - session and the target variant seq.
   * @throws when the host rejects the target (foreign, branchless, or already active).
   */
  revertIterationRestore(opts: {
    sessionId: SessionId
    variantSeq: number
  }): Promise<void>
  /**
   * Resolve a file revert conflict (e.g. user manual edits detected or missing file).
   * @param opts - session, conflictId, and the chosen resolution.
   * @throws when the host rejects the resolution.
   */
  resolveFileConflict(opts: {
    sessionId: SessionId
    conflictId: string
    resolution: 'keep' | 'restore' | 'recreate' | 'trash'
  }): Promise<void>
  /**
   * Permanently delete a session (log, revert history, file history; memory
   * summaries kept). Destructive — the UI confirms before calling.
   * @param sessionId - session to delete.
   * @throws when the host rejects the delete.
   */
  delete(sessionId: SessionId): Promise<void>
  /**
   * Borrow an already-retained Agent-scoped Context without extending its lifetime.
   * @param id - session id.
   * @returns the live scoped Context, or undefined without a retained generation.
   */
  scope(id: SessionId): AgentContext | undefined
  /**
   * Read the Agent scope tag off a context (service-method boundary: fetch
   * bundles must reach scope resolution through ctx.sessions).
   * @param ctx - any client context.
   * @returns the session id, or undefined on root contexts.
   */
  scopeOf(ctx: Context): SessionId | undefined
  /**
   * Resolve the session face behind an Agent-scoped context.
   * @param ctx - an Agent-scoped context.
   * @returns the matching live Session, or undefined for an untagged, foreign, or ended generation.
   */
  sessionOf(ctx: Context): SessionFace | undefined
  /**
   * Borrow an already-retained Session binding without extending its lifetime.
   * @param id - session id.
   * @returns the live binding, or undefined without a retained generation.
   */
  binding(id: SessionId): SessionBinding | undefined
}
