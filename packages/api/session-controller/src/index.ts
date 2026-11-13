/** Session Remote owner: cold reads, explicit Agent commands, and live control state. */

import { hostname } from 'node:os'
import { resolve } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-fs'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { errorChain, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-client-file-upload'
import { canOpenNativePath, nativeFileManager, nativeFileApplications, openNativeFileApplication, openNativeAssociatedPath, revealNativePath } from '@deepseek-ai/dsh-native-command'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionInspection } from '@deepseek-ai/dsh-session-persistence'
import { SessionQueryError, type SessionObservation } from '@deepseek-ai/dsh-session-query'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import {
  ApiSessionAgentController,
  inspectApiSession,
  type ApiSessionAgentResult,
} from './agent.ts'
import { SessionCommandController } from './commands.ts'
import { SessionControlController } from './control.ts'
import {
  DEFAULT_SESSION_FOLLOW_BUFFER_LIMITS,
  DEFAULT_SESSION_FOLLOW_RESUME_MAX_EVENTS,
  SessionHistoryController,
} from './history.ts'
import { SessionFileReferences } from './file-references.ts'
import { ApiSessionList } from './list.ts'
import { buildModelCatalog, hasProviderApiKey } from './catalog.ts'
import { installExecutionStateProjection, SessionExecutionStateReader } from './execution-state.ts'
import { installModelSelectionProjection, chainOfRequestConfig } from './model-selection-projection.ts'
import { SessionSkillCatalog } from './skill-catalog.ts'
import { SessionMediaReferences } from './media-references.ts'
import { SessionProjectionBackfill } from './projection-backfill.ts'
import { readSessionRequestSnapshot } from './request-snapshot.ts'
import {
  DEFAULT_CONTEXT_REPAIR_LIMITS,
  DEFAULT_CONTEXT_REPAIR_PREVIEW_MAX_PLANS,
  DEFAULT_CONTEXT_REPAIR_PREVIEW_TTL_MS,
} from './context-repair.ts'
import { ArchivedSessionGate } from './archived-session-gate.ts'
import type {
  ModelCatalog,
  SessionWorkspacePathApplication,
  SessionAttachmentRequest,
  SessionAttachmentValue,
  SessionCancelRequest,
  SessionCancelValue,
  SessionControlFrame,
  SessionCreateRequest,
  SessionCreateValue,
  SessionDeleteRequest,
  SessionDeleteValue,
  SessionDigestRequest,
  SessionDigestValue,
  SessionExecutionStateRequest,
  SessionExecutionStateValue,
  SessionResolveFileConflictRequest,
  SessionResolveFileConflictValue,
  SessionRevertRequest,
  SessionRevertValue,
  SessionRevertRestoreRequest,
  SessionRevertRestoreValue,
  SessionRevertIterationsRequest,
  SessionRevertIterationsValue,
  SessionRevertIterationRestoreRequest,
  SessionRevertIterationRestoreValue,
  SessionVerifyLogRequest,
  SessionVerifyLogValue,
  SessionRepairLogRequest,
  SessionRepairLogValue,
  SessionContextRepairPreviewRequest,
  SessionContextRepairPreviewValue,
  SessionContextRepairApplyRequest,
  SessionContextRepairApplyValue,
  SessionFollowFrame,
  SessionFollowRequest,
  SessionForkRequest,
  SessionForkValue,
  SessionListRequest,
  SessionListValue,
  SessionOpenWorkspacePathRequest,
  SessionOpenWorkspacePathValue,
  SessionPage,
  SessionPageRequest,
  SessionPromptRequest,
  SessionPromptValue,
  SessionRenameRequest,
  SessionRenameValue,
  SessionRequestSnapshotRequest,
  SessionRequestSnapshotValue,
  SessionSearchRequest,
  SessionSearchValue,
  SessionSelectModelRequest,
  SessionSelectModelValue,
  SessionProjectionsRequest,
  SessionProjectionsValue,
  SessionProjectionValues,
  SessionUpdateQueueRequest,
  SessionUpdateQueueValue,
} from './types.ts'

export type * from './types.ts'
export { ApiSessionNotFound } from './agent.ts'
export { SessionFileReferences } from './file-references.ts'
export { SessionSkillCatalog } from './skill-catalog.ts'
export {
  assertRemovalSafe,
  computeRetentionPins,
  computeSessionRetentionPins,
  retentionGuardOf,
  RetentionViolationError,
} from './retention-pins.ts'
export type {
  RetentionPin,
  RetentionPinCategory,
  RetentionPinEvent,
  RetentionPinManifest,
  RetentionViolation,
} from './retention-pins.ts'
export { repairSessionLog, verifySessionLog } from './session-verify.ts'
export type {
  SessionRepairAction,
  SessionRepairKind,
  SessionRepairResult,
  SessionVerificationInput,
  SessionVerifyEvent,
  SessionVerifyIssue,
  SessionVerifyIssueKind,
  SessionVerifyReport,
} from './session-verify.ts'
export { foldSurfaceNodes } from './surface-view.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Host Session business API and Remote namespace owner. */
    sessionController: SessionController
  }
}

/** Session Controller deployment policy. */
export interface Config {
  /** Override platform desktop-opener detection. */
  readonly nativeOpen?: boolean
  /** Default rows in one `session.list` page (the client loads further pages on demand). */
  readonly listPageSize?: number
  /** Live items one follow generation retains while the client is not pulling; default 16384. */
  readonly sessionFollowBufferMaxItems?: number
  /** Estimated retained bytes one follow generation accepts before a resync; default 8 MiB. */
  readonly sessionFollowBufferMaxBytes?: number
  /** Whether a Client-held follow cursor may be answered with a durable suffix; default true. */
  readonly sessionFollowResume?: boolean
  /** Dense durable events one resumed follow opening may carry before a full snapshot; default 2048. */
  readonly sessionFollowResumeMaxEvents?: number
  /**
   * Private directory for operator context-repair backup artifacts and
   * receipts; created with owner-only mode outside every Session log tree.
   * Defaults to `$DSH_HOME/backups/context-repair`. A relative path or an
   * unsupported tilde prefix refuses at load; `~/` expands to the OS home.
   */
  readonly contextRepairBackupRoot?: string
  /** Lifetime of one prepared context-repair preview plan; default 5 minutes. */
  readonly contextRepairPreviewTtlMs?: number
  /** Maximum prepared context-repair plans retained per controller; default 32. */
  readonly contextRepairPreviewMaxPlans?: number
  /** Maximum canonical artifact bytes copied by one context-repair backup; default 256 MiB. */
  readonly contextRepairMaxArtifactBytes?: number
  /** Maximum replacement code units accepted by one context repair; default 16384. */
  readonly contextRepairMaxReplacementChars?: number
  /** Maximum serialized context-repair preview bytes; default 512 KiB. */
  readonly contextRepairMaxPreviewBytes?: number
}

/** Host integrations replaceable by direct unit tests. */
export interface SessionControllerInternals {
  /** Native default-application handoff. */
  readonly openPath?: (path: string, signal: AbortSignal) => Promise<void>
  /** Native file-association query. */
  readonly fileApplications?: typeof nativeFileApplications
  /** Explicit registered-application handoff. */
  readonly openFileApplication?: typeof openNativeFileApplication
  /** Native file-manager handoff. */
  readonly revealPath?: (path: string, signal: AbortSignal) => Promise<void>
  /** Native handoff availability probe. */
  readonly canOpenPath?: () => boolean
  /** Override the per-Session wire-capture log root; defaults to `DSH_WIRE_LOG`'s directory or `~/.dsh/logs`. */
  readonly wireLogRoot?: string
}

/** Host service backing the generated `ctx.remote.session` namespace. */
export class SessionController extends TypertRemoteService {
  static inject = [
    'agentDefaultModel',
    'agents',
    'attachments',
    'fileUploads',
    'fs',
    'llm',
    'sessions',
    'sessionProjections',
    'sessionQuery',
    'typert',
    'workspaceRegistry',
  ]

  static Config: z<Config> = z.object({
    nativeOpen: z.boolean(),
    listPageSize: z.number().step(1).min(1).max(500).default(50),
    sessionFollowBufferMaxItems: z.number().step(1).min(1).default(DEFAULT_SESSION_FOLLOW_BUFFER_LIMITS.maxItems),
    sessionFollowBufferMaxBytes: z.number().step(1).min(1).default(DEFAULT_SESSION_FOLLOW_BUFFER_LIMITS.maxBytes),
    sessionFollowResume: z.boolean().default(true),
    sessionFollowResumeMaxEvents: z.number().step(1).min(1).default(DEFAULT_SESSION_FOLLOW_RESUME_MAX_EVENTS),
    contextRepairBackupRoot: z.string(),
    contextRepairPreviewTtlMs: z.number().step(1).min(1).default(DEFAULT_CONTEXT_REPAIR_PREVIEW_TTL_MS),
    contextRepairPreviewMaxPlans: z.number().step(1).min(1).default(DEFAULT_CONTEXT_REPAIR_PREVIEW_MAX_PLANS),
    contextRepairMaxArtifactBytes: z.number().step(1).min(1).default(DEFAULT_CONTEXT_REPAIR_LIMITS.maxArtifactBytes),
    contextRepairMaxReplacementChars: z.number().step(1).min(1).default(DEFAULT_CONTEXT_REPAIR_LIMITS.maxReplacementChars),
    contextRepairMaxPreviewBytes: z.number().step(1).min(1).default(DEFAULT_CONTEXT_REPAIR_LIMITS.maxPreviewBytes),
  })

  private readonly agents: ApiSessionAgentController
  private readonly commands: SessionCommandController
  private readonly controlState: SessionControlController
  private readonly execution: SessionExecutionStateReader
  private readonly history: SessionHistoryController
  private readonly listState: ApiSessionList
  private readonly openPath: (path: string, signal: AbortSignal) => Promise<void>
  private readonly fileApplications: typeof nativeFileApplications
  private readonly openFileApplication: typeof openNativeFileApplication
  private readonly revealPath: (path: string, signal: AbortSignal) => Promise<void>
  private readonly canOpenPath: () => boolean
  private readonly wireLogRoot: string | undefined
  private readonly promotions = new Set<Promise<void>>()

  /**
   * @param ctx - Host context containing the Session capability assembly.
   * @param config - native-opener deployment policy.
   * @param internals - host integrations replaceable by direct unit tests.
   */
  constructor(ctx: Context, config: Config, internals: SessionControllerInternals = {}) {
    super(ctx, 'sessionController', { namespace: 'session' })
    installModelSelectionProjection(ctx)
    installExecutionStateProjection(ctx)
    this.agents = new ApiSessionAgentController(ctx)
    this.commands = new SessionCommandController(ctx, this.agents, process.cwd(), {
      ...(config.contextRepairBackupRoot === undefined
        ? {}
        : { backupRoot: config.contextRepairBackupRoot }),
      previewTtlMs: config.contextRepairPreviewTtlMs ?? DEFAULT_CONTEXT_REPAIR_PREVIEW_TTL_MS,
      previewMaxPlans: config.contextRepairPreviewMaxPlans ?? DEFAULT_CONTEXT_REPAIR_PREVIEW_MAX_PLANS,
      maxArtifactBytes: config.contextRepairMaxArtifactBytes ?? DEFAULT_CONTEXT_REPAIR_LIMITS.maxArtifactBytes,
      maxReplacementChars: config.contextRepairMaxReplacementChars ?? DEFAULT_CONTEXT_REPAIR_LIMITS.maxReplacementChars,
      maxPreviewBytes: config.contextRepairMaxPreviewBytes ?? DEFAULT_CONTEXT_REPAIR_LIMITS.maxPreviewBytes,
    })
    this.execution = new SessionExecutionStateReader(ctx)
    ctx.effect(() => ctx.fileUploads.registerAgentResolver(async (sessionId) => {
      const result = await this.agents.resolveAgent(sessionId)
      if ('error' in result) throw result.error
      return result.agent
    }), 'session-controller: file-upload Agent resolver')
    this.controlState = new SessionControlController(ctx)
    // Registered before history so reverse-order teardown closes every
    // follower before waiting for already-admitted promotions.
    ctx.effect(() => async () => {
      await Promise.allSettled([...this.promotions])
    }, 'session-controller.promotions')
    this.history = new SessionHistoryController(ctx, (observation) => { this.promote(observation) }, {
      maxItems: config.sessionFollowBufferMaxItems ?? DEFAULT_SESSION_FOLLOW_BUFFER_LIMITS.maxItems,
      maxBytes: config.sessionFollowBufferMaxBytes ?? DEFAULT_SESSION_FOLLOW_BUFFER_LIMITS.maxBytes,
    }, {
      enabled: config.sessionFollowResume ?? true,
      maxEvents: config.sessionFollowResumeMaxEvents ?? DEFAULT_SESSION_FOLLOW_RESUME_MAX_EVENTS,
    })
    this.listState = new ApiSessionList(ctx, config.listPageSize ?? 50)
    this.fileApplications = internals.fileApplications ?? nativeFileApplications
    this.openFileApplication = internals.openFileApplication ?? openNativeFileApplication
    this.openPath = internals.openPath ?? openNativeAssociatedPath
    this.revealPath = internals.revealPath ?? revealNativePath
    this.canOpenPath = internals.canOpenPath
      ?? (() => config.nativeOpen ?? (internals.openPath !== undefined || canOpenNativePath()))
    this.wireLogRoot = internals.wireLogRoot
    ctx.plugin(SessionFileReferences)
    ctx.plugin(SessionMediaReferences)
    ctx.plugin(SessionProjectionBackfill)
    ctx.plugin(SessionSkillCatalog)
    // An archived Session, or a subagent descendant of one, runs no model step
    // until it is restored; what it still runs is stopped by the owners that
    // answer the Workspace registry's archive-admission events.
    ctx.plugin(ArchivedSessionGate)

    ctx.on('session/created', (session) => {
      ctx.emit('api-session/added', this.listState.summaryFor(session))
    })
    ctx.on('session/disposed', (session) => {
      ctx.emit('api-session/removed', session.id)
    })
    const publishAgentAvailability = ({ agent }: { agent: Agent }): undefined => {
      if (ctx.sessions.get(agent.id) === agent.session) {
        ctx.emit('api-session/added', this.listState.summaryFor(agent.session))
      }
    }
    ctx.on('agent/created', publishAgentAvailability)
    ctx.on('agent/disposed', publishAgentAvailability)
    ctx.on('agent/status', ({ agent, status }) => {
      ctx.emit('api-session/status', agent.id, status === 'running')
    })
    ctx.on('agent/error', ({ agent, error }) => {
      ctx.emit('api-session/error', agent.id, errorChain(error))
    })
    ctx.on('session/event', (session, event) => {
      if (event.type === 'request/header') {
        const agent = ctx.agents.get(session.id)
        if (agent?.session === session) this.agents.consumeSelection(
          agent,
          event.data.header.config.provider,
          event.data.header.config.model,
          event.data.header.config.reasoningEffort,
          chainOfRequestConfig(event.data.header.config),
        )
      }
      if (event.type !== 'user/message' || event.data.source.kind !== 'user') return
      ctx.emit('api-session/activity', session.id, event.time)
    })
  }

  private promote(observation: SessionObservation): void {
    const sessionId = observation.header.id
    const task = (async () => {
      using ownedObservation = observation
      const result = await this.agents.resolveObservedAgent(ownedObservation)
      if ('error' in result) this.ctx.emit('api-session/error', sessionId, result.error.message)
    })().catch((error: unknown) => {
      this.ctx.logger.error(`session-controller: background activation for "${sessionId}" failed: ${errorChain(error)}`)
    })
    this.promotions.add(task)
    void task.finally(() => { this.promotions.delete(task) })
  }

  /**
   * Resolve or resume one ordinary Session for another Host API domain.
   * @param sessionId - Session identity whose Agent owns the operation.
   * @returns the live Agent or the stable Session-domain failure.
   */
  resolveAgent(sessionId: SessionId): Promise<ApiSessionAgentResult> {
    return this.agents.resolveAgent(sessionId)
  }

  /**
   * Inspect one attached or persisted Session without activating its Agent.
   * @param sessionId - durable Session identity.
   * @param signal - optional caller cancellation for persistence reads.
   * @returns the current attached state or persisted header and event prefix.
   */
  inspect(
    sessionId: SessionId,
    signal?: AbortSignal,
  ): Promise<SessionInspection> {
    const attached = this.ctx.sessions.get(sessionId)
    if (attached !== undefined) {
      return Promise.resolve({
        meta: attached.header,
        inheritedEventCount: attached.inheritedEventCount,
        // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
        events: attached.snapshotEvents(),
      })
    }
    return inspectApiSession(this.ctx, sessionId, signal)
  }

  /**
   * Read one newest-first window of visible Session rows without resuming an Agent.
   * @param request - optional continuation cursor and page size.
   * @param signal - cancellation for persistence reads.
   * @returns the page's visible Session summaries plus a cursor when older rows remain.
   */
  @Remote('list')
  async list(request: SessionListRequest, signal: AbortSignal): Promise<SessionListValue> {
    return await this.listState.list(request, signal)
  }

  /**
   * Search visible Session content without resuming an Agent.
   * @param request - literal message-content query.
   * @param signal - cancellation for list and search reads.
   * @returns authorized bounded Session search results.
   */
  @Remote('search')
  search(request: SessionSearchRequest, signal: AbortSignal): Promise<SessionSearchValue> {
    return this.listState.search(request.query, signal)
  }

  /**
   * Create or idempotently adopt one ordinary Session.
   * @param request - requested identity, location, and Agent preset.
   * @returns the Session identity and resolved preset when configured.
   */
  @Remote('create')
  create(request: SessionCreateRequest): Promise<SessionCreateValue> {
    return this.commands.create(request)
  }

  /**
   * Select one Session-local model after explicitly resuming the Session; save the default in the background.
   * @param request - Session identity and requested model selection.
   * @returns the normalized selection installed for the Session, without waiting for default persistence.
   */
  @Remote('selectModel')
  selectModel(request: SessionSelectModelRequest): Promise<SessionSelectModelValue> {
    return this.commands.selectModel(request)
  }

  /**
   * Select the first available account model after login when no provider API key is configured.
   * @returns after saving the first available model or retaining the existing default.
   */
  @Remote
  async initializeDefaultModel(): Promise<void> {
    const provider = 'deepseek-account'
    if (await hasProviderApiKey(this.ctx)) return
    const catalog = await buildModelCatalog(this.ctx)
    const model = catalog.groups.find(group => group.id === provider)?.models[0]
    if (model === undefined) throw new RemoteError('session/provider-models-unavailable',
      `provider "${provider}" has no available models`, { provider })
    const selection = { provider, model: model.id,
      ...model.reasoning?.defaultEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(model.reasoning.defaultEffort) },
    }
    await this.ctx.agentDefaultModel.saveSelection(selection)
  }

  /**
   * Describe every currently routable model for Host-generation selectors.
   * @returns provider-grouped models, the deployment default, and isolated provider failures.
   */
  @Remote('modelCatalog')
  modelCatalog(): Promise<ModelCatalog> {
    return buildModelCatalog(this.ctx)
  }

  /**
   * Report whether this deployment can hand a Session workspace path to a native desktop.
   * @returns true when the matching open operation is available.
   */
  @Remote
  canOpenWorkspacePath(): boolean {
    return this.canOpenPath()
  }

  /**
   * Describe the serving desktop for authenticated file-action routes.
   * @returns Host name, configured availability, and platform-specific file-manager behavior.
   */
  workspaceDesktop(): { name: string; available: boolean; fileManager: 'finder' | 'explorer' | 'directory' | null } {
    const fileManager = nativeFileManager()
    return { name: hostname(), available: fileManager !== null && this.canOpenPath(), fileManager }
  }

  /**
   * Verify one path through the composed filesystem and open it on the Host desktop.
   * @param request - path after best-effort Session workspace resolution.
   * @param signal - caller lifetime; abort terminates the native command.
   * @returns confirmation after the native opener accepts the path.
   * @throws RemoteError when the request is invalid, has no verified Host mapping, is cancelled, or the opener fails.
   */
  @Remote('openWorkspacePath')
  async openWorkspacePath(
    request: SessionOpenWorkspacePathRequest,
    signal: AbortSignal,
  ): Promise<SessionOpenWorkspacePathValue> {
    try {
      const path = await this.verifyDesktopPath(request.path, signal)
      if (request.action === 'reveal') await this.revealPath(path, signal)
      else if (request.application !== undefined) await this.openFileApplication(path, request.application, signal)
      else await this.openPath(path, signal)
      return { opened: true }
    } catch (error: unknown) {
      if (signal.aborted) throw new RemoteError('gateway/cancelled', 'path open was aborted', {})
      if (error instanceof RemoteError) throw error
      throw new RemoteError(
        'gateway/internal',
        'path open failed',
        {},
        { cause: error },
      )
    }
  }

  /**
   * Query current file handlers on the serving desktop without activating an Agent.
   * @param request - file path in Host filesystem syntax.
   * @param signal - caller lifetime, propagated to filesystem and desktop queries.
   * @returns OS application names, icons, and default selection; empty when desktop opening is unavailable.
   * @throws RemoteError when the path is invalid, the query is cancelled, or native discovery fails.
   */
  @Remote('workspacePathApplications')
  async workspacePathApplications(
    request: { readonly path: string }, signal: AbortSignal,
  ): Promise<readonly SessionWorkspacePathApplication[]> {
    if (!this.canOpenPath()) return []
    try {
      const path = await this.verifyDesktopPath(request.path, signal)
      return await this.fileApplications(path, signal)
    } catch (error: unknown) {
      if (signal.aborted) throw new RemoteError('gateway/cancelled', 'application query was aborted', {})
      if (error instanceof RemoteError) throw error
      throw new RemoteError('gateway/internal', 'file application query failed', {}, { cause: error })
    }
  }

  private async verifyDesktopPath(path: string, signal: AbortSignal): Promise<string> {
    if (path.length === 0) throw new RemoteError('gateway/bad-request', 'A non-empty file path is required', {})
    signal.throwIfAborted()
    const hostPath = resolve(path)
    const { fs } = this.ctx
    const mapped = fs.processPathFromHostPath(hostPath)
    if (mapped === undefined || fs.processPath(await fs.resolve(mapped, { signal })) !== hostPath) {
      throw new RemoteError('gateway/bad-request', 'Path has no verified Host path', {})
    }
    signal.throwIfAborted()
    return hostPath
  }

  /**
   * Rename one Session after explicitly resuming it.
   * @param request - Session identity and proposed title.
   * @returns the accepted title and durable event sequence.
   */
  @Remote('rename')
  rename(request: SessionRenameRequest): Promise<SessionRenameValue> {
    return this.commands.rename(request)
  }

  /**
   * Fork one cold-readable exact event prefix into a new Session. An omitted
   * boundary selects the latest completed-turn prefix; an open cut receives
   * synthetic fork closers.
   * @param request - source Session and optional exact inclusive event boundary.
   * @returns the new Session identity.
   */
  @Remote('fork')
  fork(request: SessionForkRequest): Promise<SessionForkValue> {
    return this.commands.fork(request)
  }

  /**
   * Revert the conversation from a user message (revert-from-here).
   * @param request - session and the user-message seq anchoring the revert.
   * @returns the reverted query text and count for the input card; an unusable
   *   anchor is rejected with `revert-invalid`.
   */
  @Remote('revert')
  revert(request: SessionRevertRequest): Promise<SessionRevertValue> {
    return this.commands.revert(request)
  }

  /**
   * Restore reverted messages (restoreSeq omitted restores everything).
   * @param request - session and the optional restore boundary.
   * @returns acknowledgement that the restore was accepted.
   */
  @Remote('revertRestore')
  revertRestore(request: SessionRevertRestoreRequest): Promise<SessionRevertRestoreValue> {
    return this.commands.revertRestore(request)
  }

  /**
   * List the Session's durable iteration groups (variant chains).
   * @param request - session, optional group anchor, and listing bounds.
   * @returns bounded groups with capped previews and surface-activity flags.
   */
  @Remote('revertIterations')
  revertIterations(request: SessionRevertIterationsRequest): Promise<SessionRevertIterationsValue> {
    return this.commands.revertIterations(request)
  }

  /**
   * Restore one iteration variant as the active version (overwrite-since-point commit).
   * @param request - session, target variant, and the idempotency request id.
   * @returns acknowledgement that the restore was accepted.
   */
  @Remote('revertIterationRestore')
  revertIterationRestore(request: SessionRevertIterationRestoreRequest): Promise<SessionRevertIterationRestoreValue> {
    return this.commands.revertIterationRestore(request)
  }

  /**
   * Verify one Session log against the durability invariants (marker targets,
   * branch reachability, offload targets, compaction sources, surface and
   * iteration folds).
   * @param request - Session to verify.
   * @returns the findings and the committed prefix length.
   */
  @Remote('verifyLog')
  verifyLog(request: SessionVerifyLogRequest): Promise<SessionVerifyLogValue> {
    return this.commands.verifyLog(request)
  }

  /**
   * Self-heal one Session log: rebuild derived folds and neutralize dangling
   * references in the derived view without rewriting durable events.
   * @param request - Session to repair.
   * @returns the repair receipt and verification of the repaired view.
   */
  @Remote('repairLog')
  repairLog(request: SessionRepairLogRequest): Promise<SessionRepairLogValue> {
    return this.commands.repairLog(request)
  }

  /**
   * Preview one single-line correction inside an active generated context
   * message (compaction or Enpoi keeper checkpoint). Read-only: it validates a
   * detached Session replay, captures the current head, and reveals the
   * before/after derived-context hashes and minimal line diff only to the
   * authenticated operator.
   * @param request - Session, exact block/line hashes, replacement line, and optional expected head.
   * @returns the one-use preview id, plan fingerprint, and detached before/after projections.
   * @throws RemoteError `session/context-repair-invalid` for an ineligible target,
   *   `session/context-repair-stale` when an expected head does not match.
   */
  @Remote('contextRepairPreview')
  contextRepairPreview(request: SessionContextRepairPreviewRequest): Promise<SessionContextRepairPreviewValue> {
    return this.commands.contextRepairPreview(request)
  }

  /**
   * Apply one prepared context-repair preview under `Agent.runMaintenance` on
   * an idle live root Session. The API returns an `applied` receipt only after
   * the append and its durability barrier succeed; a committed append whose
   * barrier or final receipt write fails is reported as a guarded `partial`
   * with the prepared receipt path for explicit operator rollback.
   * @param request - Session, one-use preview id, and stored plan fingerprint.
   * @returns the applied or partial receipt and the derived context after the append.
   * @throws RemoteError for invalid, stale, busy, unsupported-persistence, backup, or failed applies.
   */
  @Remote('contextRepairApply')
  contextRepairApply(request: SessionContextRepairApplyRequest): Promise<SessionContextRepairApplyValue> {
    return this.commands.contextRepairApply(request)
  }

  /**
   * Resolve a file revert conflict (bridged to the enpoi-file-revert plugin).
   * @param request - session, conflictId, and the chosen resolution.
   * @returns acknowledgement that the resolution was accepted.
   */
  @Remote('resolveFileConflict')
  resolveFileConflict(request: SessionResolveFileConflictRequest): Promise<SessionResolveFileConflictValue> {
    return this.commands.resolveFileConflict(request)
  }

  /**
   * Permanently delete a session (log, revert history, file history).
   * @param request - session to delete.
   * @returns acknowledgement that the session was deleted.
   */
  @Remote('delete')
  delete(request: SessionDeleteRequest): Promise<SessionDeleteValue> {
    return this.commands.delete(request)
  }

  /**
   * Admit one prompt after explicitly resuming its Session.
   * @param request - Session identity, prompt content, source metadata, and delivery mode.
   * @param signal - caller cancellation before prompt admission begins.
   * @returns acknowledgement that the Agent accepted the prompt.
   */
  @Remote('prompt')
  prompt(request: SessionPromptRequest, signal: AbortSignal): Promise<SessionPromptValue> {
    signal.throwIfAborted()
    return this.commands.prompt(request)
  }

  /**
   * Read what the model was actually sent for one Session's most recent main
   * request (the LLM seam's per-Session wire capture).
   *
   * The default summary is a digest-and-size view: `system` reports character
   * count and SHA-256, `tools` names, and one `{role, chars}` row per message.
   * `includeBodies: true` additionally returns the SECRET-BEARING bodies — the
   * full system prompt, tool schemas, and message text — so callers must treat
   * the result as sensitive. When the capture exceeded its byte cap, the bodies
   * are unavailable and the response keeps `bodiesIncluded: false` with
   * `bodiesOmitted: 'size-cap'`.
   * @param request - Session identity and whether secret-bearing bodies are requested.
   * @param signal - caller cancellation for the capture read.
   * @returns the captured request summary, or the bodies too when requested.
   * @throws RemoteError `gateway/bad-request` for an unaddressable Session id, `session/not-found` when no capture exists.
   */
  @Remote('requestSnapshot')
  requestSnapshot(
    request: SessionRequestSnapshotRequest,
    signal: AbortSignal,
  ): Promise<SessionRequestSnapshotValue> {
    return readSessionRequestSnapshot(request, signal, this.wireLogRoot)
  }

  /**
   * Read the aggregate execution latch of one attached Session: the
   * `running | waiting_approval | waiting_subagents | idle` state, live
   * descendants (quiet children included), pending approvals and questions,
   * the last turn terminal, the last attributed participant action, and the
   * current model selection (doc 69 §8 correction 3; doc 70 §4). Read-only:
   * the count comes from the live Agent registry and subagent lifecycle
   * events, never from crawling the parent log.
   * @param request - attached Session identity.
   * @returns the host-published latch value.
   * @throws RemoteError `session/not-found` when no live Session owns the id.
   */
  @Remote('executionState')
  executionState(request: SessionExecutionStateRequest): SessionExecutionStateValue {
    return this.execution.executionState(request.sessionId)
  }

  /**
   * Read the one-call Session digest for a debugging consumer: the execution
   * latch, current model, last attributed action, recent tool calls, the
   * injection index, the subagent tree, and pending interactions (doc 69
   * §9.1). Every preview is bounded and no credentials or captured request
   * bodies are included.
   * @param request - attached Session identity and the recent-tool-call budget.
   * @returns the bounded digest value.
   * @throws RemoteError `session/not-found` when no live Session owns the id.
   */
  @Remote('digest')
  digest(request: SessionDigestRequest): Promise<SessionDigestValue> {
    return this.execution.digest(request)
  }

  /**
   * Read one image proven reachable from the addressed Session log.
   * @param request - Session and attachment identities used for authorization.
   * @returns the durable attachment reference and base64-encoded bytes.
   */
  @Remote('attachment')
  attachment(request: SessionAttachmentRequest): Promise<SessionAttachmentValue> {
    return this.commands.attachment(request)
  }

  /**
   * Mutate one still-pending queue occurrence, resuming a cold Agent first.
   * @param request - Session, queue item, and requested mutation.
   * @returns acknowledgement that the queue mutation was applied.
   */
  @Remote('updateQueue')
  updateQueue(request: SessionUpdateQueueRequest): Promise<SessionUpdateQueueValue> {
    return this.commands.updateQueue(request)
  }

  /**
   * Cancel one active Agent turn without dropping its pending inbox.
   * @param request - Session whose active Agent turn is cancelled.
   * @returns acknowledgement that cancellation was requested.
   */
  @Remote('cancel')
  cancel(request: SessionCancelRequest): SessionCancelValue {
    return this.commands.cancel(request)
  }

  /**
   * Read one cold-safe, message-aligned Session history page.
   * @param request - durable address, backward cursor, and page budget.
   * @param signal - cancellation for persistence reads.
   * @returns one chronological page.
   */
  @Remote('page')
  page(request: SessionPageRequest, signal: AbortSignal): Promise<SessionPage> {
    return this.history.page(request, signal)
  }

  /**
   * Follow one Session log from its opening or resume cursor.
   * @param request - durable address and last committed sequence already held by the caller.
   * @param signal - cancellation owned by the Remote stream carrier.
   * @returns a complete opening snapshot followed by gap-free durable event
   *   frames and optional cursorless assistant-stream frames.
   */
  @Remote({ mode: 'stream' })
  follow(request: SessionFollowRequest, signal: AbortSignal): AsyncIterable<SessionFollowFrame> {
    return this.history.follow(request, signal)
  }

  /**
   * Read all registered projections without activating an Agent.
   * @param request - Session whose current values are required.
   * @param signal - cancellation for the Session observation.
   * @returns complete baseline, or null when the Session does not exist.
   */
  @Remote('projections')
  async projections(request: SessionProjectionsRequest, signal: AbortSignal): Promise<SessionProjectionsValue> {
    const { sessionId } = request
    if (sessionId.length === 0) {
      throw new RemoteError('gateway/bad-request', 'sessionId must not be empty', {})
    }
    try {
      using observation = await this.ctx.sessionQuery.observeSession(sessionId, { signal })
      const projections = observation.projections
      if (projections === undefined) {
        throw new RemoteError('session/projections-unavailable', 'Session projections are unavailable', {})
      }
      return { asOfSeq: projections.asOfSeq, values: projections.values as SessionProjectionValues }
    } catch (error: unknown) {
      if (error instanceof SessionQueryError && error.code === 'SESSION_QUERY_SESSION_NOT_FOUND') return null
      if (signal.aborted
        || (error instanceof SessionQueryError && error.code === 'SESSION_QUERY_ABORTED')) {
        throw new RemoteError('gateway/cancelled', 'Session projection read was cancelled', {}, { cause: error })
      }
      if (error instanceof RemoteError) throw error
      throw new RemoteError('gateway/internal', 'Session projection read failed', {}, { cause: error })
    }
  }

  /**
   * Stream a complete live-control baseline followed by replacement frames.
   * @param signal - cancellation owned by the Remote stream carrier.
   * @returns one complete baseline followed by live replacement frames.
   */
  @Remote({ mode: 'stream' })
  control(signal: AbortSignal): AsyncIterable<SessionControlFrame> {
    return this.controlState.control(signal)
  }
}

export { buildModelCatalog }
export default SessionController
