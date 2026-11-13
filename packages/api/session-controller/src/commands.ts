/** Session commands whose activation policy is explicit at each Remote method. */

import { modelAvailable } from './catalog.ts'
import { randomUUID } from 'node:crypto'
import { dirname } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { Agent, ModelSelection as AgentModelSelection } from '@deepseek-ai/dsh-agent'
import { AttachmentError } from '@deepseek-ai/dsh-attachment'
import type {
  AttachmentAdmissionPart, FileAttachmentRef, ImageAttachmentRef,
} from '@deepseek-ai/dsh-attachment'
import type { FileUploadReceiptId } from '@deepseek-ai/dsh-client-file-upload/types'
import type {} from '@deepseek-ai/dsh-client-file-upload'
import {
  ReasoningEffortId, createUserMessage, freezeMessage,
} from '@deepseek-ai/dsh-llm'
import type { AgentIterationIntent } from '@deepseek-ai/dsh-agent'
import type { MessageSource } from '@deepseek-ai/dsh-llm'
import { buildForkSeed } from '@deepseek-ai/dsh-session/fork'
import { SessionLogOffset, SessionSeq } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent, SessionHeader, SessionId, SessionSurface, UserMessage } from '@deepseek-ai/dsh-session'
import { SessionQueryError, type SessionObservation } from '@deepseek-ai/dsh-session-query'
import { SessionTitleInvalidError } from '@deepseek-ai/dsh-session-title'
import { canonicalClientTimeZone } from '@deepseek-ai/dsh-util-time'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import { RemoteError, remoteErrorOf, type RemoteErrorCode } from '@deepseek-ai/dsh-typert-protocol'
import type { Workspace } from '@deepseek-ai/dsh-workspace'
import {
  ApiSessionAgentController,
  ApiSessionCwdConflict,
  ApiSessionNotFound,
  ApiSessionPresetConflict,
  ApiSessionSubagentOwnership,
  apiSessionSubagentOwnershipError,
  hasApiSessionSubagentOwner,
  inspectApiSession,
} from './agent.ts'
import type {
  SessionAttachmentRequest,
  SessionAttachmentValue,
  SessionCancelRequest,
  SessionCancelValue,
  SessionCreateRequest,
  SessionCreateValue,
  SessionForkRequest,
  SessionForkValue,
  SessionPromptRequest,
  SessionPromptValue,
  SessionRenameRequest,
  SessionRenameValue,
  SessionRevertRequest,
  SessionRevertValue,
  SessionRevertRestoreRequest,
  SessionRevertRestoreValue,
  SessionRevertIterationsRequest,
  SessionRevertIterationsValue,
  SessionRevertIterationRestoreRequest,
  SessionRevertIterationRestoreValue,
  SessionIterationGroup,
  SessionIterationVariant,
  SessionVerifyLogRequest,
  SessionVerifyLogValue,
  SessionRepairLogRequest,
  SessionRepairLogValue,
  SessionResolveFileConflictRequest,
  SessionResolveFileConflictValue,
  SessionDeleteRequest,
  SessionDeleteValue,
  SessionSelectModelRequest,
  SessionSelectModelValue,
  SessionUpdateQueueRequest,
  SessionUpdateQueueValue,
  SessionRequestId,
  ContextRepairPreviewId,
  SessionContextRepairApplyRequest,
  SessionContextRepairApplyValue,
  SessionContextRepairPreviewRequest,
  SessionContextRepairPreviewValue,
  SessionContextRepairReceipt,
} from './types.ts'
import { SessionCommandIndex, referencedImage } from './session-command-index.ts'
import { truncateUnicodeCodePoints } from './list.ts'
import {
  iterationAnchorOf,
  iterationEdges,
  listIterationGroups,
  resolveIterationCheckpointAnchor,
  type IterationFoldState,
} from './iteration-fold.ts'
import { foldSurfaceNodes } from './surface-view.ts'
import { repairSessionLog, verifySessionLog } from './session-verify.ts'
import {
  ContextRepairRefusal,
  DEFAULT_CONTEXT_REPAIR_LIMITS,
  DEFAULT_CONTEXT_REPAIR_PREVIEW_MAX_PLANS,
  DEFAULT_CONTEXT_REPAIR_PREVIEW_TTL_MS,
  assertContextRepairBackupLocation,
  canonicalEventHead,
  copyContextRepairArtifact,
  createContextRepairBackupDirectory,
  isWithinDirectory,
  planContextRepair,
  projectSessionContext,
  resolveContextRepairBackupRoot,
  revalidateContextRepairPlan,
  sessionHead,
  writeContextRepairReceipt,
  type ContextRepairArtifactSnapshot,
  type ContextRepairBackupSnapshot,
  type ContextRepairLimits,
  type ContextRepairPlan,
  type ContextRepairPlanResult,
  type ContextRepairReceiptStatus,
} from './context-repair.ts'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'

/** Default and maximum groups/variants listed by `revertIterations`. */
const ITERATION_LIST_LIMIT_DEFAULT = 50
const ITERATION_LIST_LIMIT_MAX = 200
/** Preview text cap; a variant body is never returned in full. */
const ITERATION_PREVIEW_MAX_CODE_POINTS = 2000
/**
 * Bound on cancellation settlement before an iteration restore refuses with a
 * retryable busy error. Internal scheduling constant, not deployment policy:
 * it only caps how long a restore waits for an already-cancelled turn to
 * converge before any write.
 */
const ITERATION_RESTORE_IDLE_TIMEOUT_MS = 5_000

/** Deployment policy for the operator context-repair preview cache and backup root. */
export interface ContextRepairCommandOptions {
  /** Private directory for backups and receipts; defaults under the harness home. */
  readonly backupRoot?: string
  /** Lifetime of one prepared preview plan. */
  readonly previewTtlMs?: number
  /** Maximum retained prepared preview plans. */
  readonly previewMaxPlans?: number
  /** Maximum canonical artifact bytes copied by one backup. */
  readonly maxArtifactBytes?: number
  /** Maximum replacement code units. */
  readonly maxReplacementChars?: number
  /** Maximum serialized preview bytes returned to the operator. */
  readonly maxPreviewBytes?: number
}

/** One prepared preview retained until apply, expiry, or eviction. */
interface PreparedContextRepair {
  readonly plan: ContextRepairPlan
  readonly expiresAt: number
}

interface SessionReadState {
  readonly id: SessionId
  readonly header: SessionHeader
  readonly inheritedEventCount: SessionLogOffset
  readonly events: readonly SessionEvent[]
}

type PromptContentCandidate =
  | SessionPromptRequest['content'][number]
  | Extract<SessionUpdateQueueRequest['action'], { readonly kind: 'edit' }>['content'][number]

function hasPromptContent(content: readonly PromptContentCandidate[]): boolean {
  return content.some(part => part.type !== 'text' || part.text.trim().length > 0)
}

/**
 * Resolve the omitted-`atSeq` default to the latest completed-turn prefix,
 * including standalone events before the next turn begins.
 */
function latestCompletedPrefixBoundary(events: readonly SessionEvent[]): SessionSeq | undefined {
  const lastTurnEnd = events.findLast(event => event.type === 'turn/end')
  if (lastTurnEnd === undefined) return undefined
  let boundary = lastTurnEnd.seq
  for (const next of events.slice(boundary + 1)) {
    if (next.type === 'turn/start' || (next.type === 'user/message' && next.surfaceOp === 'append')
      || next.type === 'agent/inbox/spliced') break
    boundary = next.seq
  }
  return boundary
}

/** Implements Session business commands delegated by the Session Controller Remote service. */
export class SessionCommandController {
  /** Lazily built O(1) lookup indexes per Session, advanced by `session/event`. */
  private readonly commandIndexes = new Map<SessionId, SessionCommandIndex>()
  /**
   * Sessions with an in-flight iteration restore. Two concurrent restores
   * would each validate against the same surface and then switch branches
   * against a surface the other moved; serializing them keeps one switch per
   * surface state.
   */
  private readonly restoringSessions = new Set<SessionId>()
  /**
   * Recently handled iteration-restore request ids per Session, bounded to 32.
   * A restore appends no user message, so prompt-id idempotency cannot carry
   * it; a transport retry of the same request id returns the first receipt.
   */
  private readonly iterationRestoreRequests = new Map<SessionId, Set<string>>()
  /** Bounded, disposable preview plans; apply consumes its token before any write. */
  private readonly contextRepairPreviews = new Map<ContextRepairPreviewId, PreparedContextRepair>()
  /** One in-flight apply per Session; a second request is a retryable busy failure. */
  private readonly contextRepairApplying = new Set<SessionId>()
  private readonly contextRepairBackupRoot: string
  private readonly contextRepairPreviewTtlMs: number
  private readonly contextRepairPreviewMaxPlans: number
  private readonly contextRepairLimits: ContextRepairLimits
  private readonly contextRepairDshHome: string

  /**
   * @param ctx - Host context carrying Agent, model, attachment, title, and Workspace services.
   * @param agents - sole owner of create, resume, and Session-local model selection.
   * @param defaultCwd - project directory used when create names neither a Workspace nor a cwd.
   * @param contextRepair - preview-cache and private-backup policy.
   */
  constructor(
    private readonly ctx: Context,
    private readonly agents: ApiSessionAgentController,
    private readonly defaultCwd: string,
    contextRepair: ContextRepairCommandOptions = {},
  ) {
    this.contextRepairBackupRoot = resolveContextRepairBackupRoot(contextRepair.backupRoot)
    this.contextRepairDshHome = resolveDshHome()
    if (this.contextRepairBackupRoot === this.contextRepairDshHome
      || isWithinDirectory(this.contextRepairDshHome, this.contextRepairBackupRoot)) {
      throw new ContextRepairRefusal(
        'backup-root-invalid',
        'the shared harness home cannot be the context-repair backup root',
      )
    }
    this.contextRepairPreviewTtlMs = contextRepair.previewTtlMs ?? DEFAULT_CONTEXT_REPAIR_PREVIEW_TTL_MS
    this.contextRepairPreviewMaxPlans = contextRepair.previewMaxPlans ?? DEFAULT_CONTEXT_REPAIR_PREVIEW_MAX_PLANS
    this.contextRepairLimits = {
      maxArtifactBytes: contextRepair.maxArtifactBytes ?? DEFAULT_CONTEXT_REPAIR_LIMITS.maxArtifactBytes,
      maxReplacementChars: contextRepair.maxReplacementChars ?? DEFAULT_CONTEXT_REPAIR_LIMITS.maxReplacementChars,
      maxPreviewBytes: contextRepair.maxPreviewBytes ?? DEFAULT_CONTEXT_REPAIR_LIMITS.maxPreviewBytes,
    }
    this.contextRepairDshHome = resolveDshHome()
    ctx.on('session/event', (session, event) => {
      this.commandIndexes.get(session.id)?.ingest(event)
    }, { global: true })
    ctx.on('agent/disposed', ({ agent }) => {
      this.commandIndexes.delete(agent.session.id)
      this.iterationRestoreRequests.delete(agent.session.id)
      this.clearContextRepairPreviews(agent.session.id)
    }, { global: true })
    ctx.effect(() => () => {
      this.contextRepairPreviews.clear()
      this.contextRepairApplying.clear()
    }, 'session-controller: context repair previews')
  }

  /** Drop every prepared plan for one Session. */
  private clearContextRepairPreviews(sessionId: SessionId): void {
    for (const [previewId, prepared] of this.contextRepairPreviews) {
      if (prepared.plan.sessionId === sessionId) this.contextRepairPreviews.delete(previewId)
    }
  }

  /**
   * Resolve the derived lookup index for one Session, building it on first use
   * from the existing durable-read path. A live Session registers only when
   * the snapshot covers its current seq, so an append racing the build is
   * still delivered to the live `session/event` listener.
   * @param sessionId - durable Session identity.
   * @returns the built or cached index.
   */
  private async indexFor(sessionId: SessionId): Promise<SessionCommandIndex> {
    const cached = this.commandIndexes.get(sessionId)
    if (cached !== undefined) return cached
    for (;;) {
      const state = await this.readSessionState(sessionId)
      const live = this.ctx.sessions.get(sessionId)
      if (live !== undefined && live.seq !== state.events.length) continue
      const index = SessionCommandIndex.fromEvents(state.events)
      this.commandIndexes.set(sessionId, index)
      return index
    }
  }

  private async hasPromptRequest(agent: Agent, requestId: SessionRequestId): Promise<boolean> {
    const matches = (message: UserMessage): boolean => {
      const source = message.source
      return source.kind === 'user' && 'rpcId' in source && source.rpcId === requestId
    }
    if (agent.inbox.nextTurn.some(matches) || agent.inbox.nextStep.some(matches)) return true
    return (await this.indexFor(agent.session.id)).hasPromptRequest(requestId)
  }

  /**
   * Create or idempotently adopt one ordinary Session.
   * @param request - requested identity, location, and Agent preset.
   * @returns the Session identity and resolved preset when configured.
   */
  async create(request: SessionCreateRequest): Promise<SessionCreateValue> {
    if (request.workspaceId !== undefined && request.cwd !== undefined) {
      throw new RemoteError('gateway/bad-request', 'session.create accepts workspaceId or cwd, not both', {})
    }
    const sessionId = request.sessionId ?? brandString<SessionId>(`session-${randomUUID()}`)
    let workspace: Workspace | undefined
    if (request.workspaceId !== undefined) {
      workspace = this.ctx.workspaceRegistry.get(request.workspaceId)
      if (workspace === undefined) {
        throw new RemoteError('workspace/not-found', `workspace "${request.workspaceId}" not found`, {
          workspaceId: request.workspaceId,
        })
      }
    }
    const cwd = workspace?.path ?? request.cwd ?? this.defaultCwd
    let adopted: Agent
    try {
      adopted = await this.agents.ensureSession(
        sessionId,
        cwd,
        request.sessionId !== undefined,
        request.agentPreset,
      )
    } catch (error) {
      this.rejectCreation(sessionId, error)
    }
    if (workspace !== undefined) {
      try {
        await workspace.attachSession(sessionId)
      } catch (error) {
        throw new RemoteError(
          'session/workspace-attach-failed',
          `session "${sessionId}" was created but could not attach to workspace "${workspace.id}": ${String(error)}`,
          { sessionId, workspaceId: workspace.id },
        )
      }
    }
    const agentPreset = this.agents.presetForSession(adopted.session)
    return { sessionId, ...(agentPreset === undefined ? {} : { agentPreset }) }
  }

  /**
   * Validate and install one Session-local model selection; save the default in the background.
   * @param request - Session identity and requested model selection.
   * @returns the normalized selection installed for the Session, without waiting for default persistence.
   */
  async selectModel(request: SessionSelectModelRequest): Promise<SessionSelectModelValue> {
    const agent = await this.resolveAgent(request.sessionId)
    return this.agents.serializeImageAdmission(agent, async () => {
      try {
        await this.requireModel(request)
        const resolved = await this.ctx.llm.resolveCallConfig({
          provider: request.provider,
          model: request.model,
          ...(request.reasoningEffort === undefined
            ? {}
            : { reasoningEffort: ReasoningEffortId(request.reasoningEffort) }),
        })
        // An empty group id is an absent assignment, never a durable value no
        // group registry can resolve.
        const chain = request.chain === undefined || request.chain.trim() === ''
          ? undefined
          : request.chain
        const selected: AgentModelSelection = {
          provider: resolved.provider,
          model: resolved.model,
          ...(chain === undefined ? {} : { chain }),
          ...(resolved.reasoningEffort === undefined
            ? {}
            : { reasoningEffort: resolved.reasoningEffort }),
        }
        this.agents.selectForNextRequest(agent, selected)
        if (request.persistDefault !== false) {
          void this.ctx.agentDefaultModel.saveSelection(selected).catch((error: unknown) => {
            this.ctx.logger.warn(
              `session-controller: model selection changed for the Session but the default was not saved: ${String(error)}`,
            )
          })
        }
        return { selected: { ...selected } }
      } catch (error) {
        if (remoteErrorOf(error) !== undefined) throw error
        throw new RemoteError(
          'session/model-unavailable',
          error instanceof Error ? error.message : String(error),
          { provider: request.provider, model: request.model },
        )
      }
    })
  }

  /**
   * Normalize and append a user-owned Session title.
   * @param request - Session identity and proposed title.
   * @returns the accepted title and durable event sequence.
   */
  async rename(request: SessionRenameRequest): Promise<SessionRenameValue> {
    const agent = await this.resolveAgent(request.sessionId)
    const titles = this.ctx.get('sessionTitle')
    if (titles === undefined) {
      throw new RemoteError('gateway/internal', 'renaming is unavailable: this deployment mounts no session-title service', {})
    }
    try {
      const accepted = titles.rename(agent.session, request.title)
      return { title: accepted.title, seq: accepted.eventSeq }
    } catch (error) {
      if (error instanceof SessionTitleInvalidError) {
        throw new RemoteError('session/title-invalid', error.message, { sessionId: request.sessionId })
      }
      throw new RemoteError(
        'gateway/internal',
        `failed to rename session "${request.sessionId}": ${String(error)}`,
        {},
      )
    }
  }

  /**
   * Create a new ordinary Session from an exact event prefix. An explicit
   * `atSeq` is the inclusive cut; an omitted value selects the latest
   * completed-turn prefix. An open cut receives synthetic fork closers.
   * @param request - source Session and optional exact event boundary.
   * @returns the new Session identity.
   */
  async fork(request: SessionForkRequest): Promise<SessionForkValue> {
    let atSeq: ReturnType<typeof SessionSeq> | undefined
    try {
      atSeq = request.atSeq === undefined ? undefined : SessionSeq(request.atSeq)
    } catch {
      throw new RemoteError('gateway/bad-request', 'atSeq must be a non-negative safe integer', {})
    }
    let observed: SessionObservation
    try {
      observed = await this.ctx.sessionQuery.observeSession(request.sessionId)
    } catch (error) {
      if (error instanceof SessionQueryError
        && error.code === 'SESSION_QUERY_SESSION_NOT_FOUND') {
        throw new RemoteError('session/not-found', `session "${request.sessionId}" not found`, {
          sessionId: request.sessionId,
        })
      }
      throw new RemoteError(
        'gateway/internal',
        `fork source unavailable for session "${request.sessionId}": ${String(error)}`,
        {},
      )
    }
    using source = observed
    const boundary = atSeq ?? latestCompletedPrefixBoundary(source.events)
    if (boundary === undefined || source.events[boundary]?.seq !== boundary) {
      throw new RemoteError(
        'session/fork-unavailable',
        request.atSeq === undefined
          ? `session "${request.sessionId}" has no completed turn to fork from`
          : `event ${String(request.atSeq)} does not exist in session "${request.sessionId}" (last seq: ${String(source.events.at(-1)?.seq ?? 'none')})`,
        { sessionId: request.sessionId },
      )
    }
    const seed = buildForkSeed(source.events, boundary)
    let workspace: Workspace | undefined
    try {
      workspace = await this.forkWorkspace(source.header)
    } catch (error) {
      throw new RemoteError(
        'gateway/internal',
        `failed to resolve fork workspace for session "${request.sessionId}": ${String(error)}`,
        {},
      )
    }
    const childId = brandString<SessionId>(`session-${randomUUID()}`)
    const composition = await this.agents.composeAgent(this.agents.presetForObservation(source))
    try {
      const { provider, model, chain } = this.ctx.agentDefaultModel.currentSelection()
      await this.ctx.agents.create({
        sessionId: childId,
        seed,
        inheritedEventCount: SessionLogOffset(boundary + 1),
        meta: {
          ...(source.header.cwd === undefined ? {} : { cwd: source.header.cwd }),
          parentSession: source.header.id,
          isSeeded: true,
          ...(composition.agentPreset === undefined
            ? {}
            : { agentPreset: composition.agentPreset }),
        },
        agentOptions: { provider, model, ...chain === undefined ? {} : { chain } },
        setup: composition.setup,
      })
    } catch (error) {
      throw new RemoteError(
        'gateway/internal',
        `failed to fork session "${request.sessionId}": ${String(error)}`,
        {},
      )
    }
    if (workspace !== undefined) {
      try {
        await workspace.attachSession(childId)
      } catch (error) {
        throw new RemoteError(
          'session/workspace-attach-failed',
          `session "${childId}" was forked but could not attach to workspace "${workspace.id}": ${String(error)}`,
          { sessionId: childId, workspaceId: workspace.id },
        )
      }
    }
    return { sessionId: childId }
  }

  /**
   * Reject empty content, then admit one prompt after Agent and attachment
   * validation. A prompt carrying a `revertFromSeq` whose anchor is usable
   * commits a replacement from that anchor through the last surface node (a
   * failed or empty tail replaces the anchor itself); an unusable boundary
   * clears and appends plainly instead of rejecting.
   * @param request - Session identity, prompt content, source metadata, and delivery mode.
   * @returns acknowledgement that the Agent accepted the prompt.
   */
  async prompt(request: SessionPromptRequest): Promise<SessionPromptValue> {
    if (!hasPromptContent(request.content)) {
      throw new RemoteError(
        'gateway/bad-request',
        'prompt content must include non-whitespace text or an attachment',
        {},
      )
    }
    const clientTimeZone = request.clientTimeZone === undefined
      ? undefined
      : canonicalClientTimeZone(request.clientTimeZone)
    if (request.clientTimeZone !== undefined && clientTimeZone === undefined) {
      throw new RemoteError(
        'session/invalid-time-zone',
        'clientTimeZone must be UTC or a valid IANA Area/Location name',
        { value: request.clientTimeZone },
      )
    }
    const agent = await this.resolveAgent(request.sessionId)
    if (await this.hasPromptRequest(agent, request.requestId)) return { accepted: true }
    const source: MessageSource = {
      kind: 'user',
      rpcId: request.requestId,
      ...(clientTimeZone === undefined ? {} : { clientTimeZone }),
      ...(request.participant === undefined ? {} : { participant: request.participant }),
    }
    const hasImage = request.content.some(part => part.type === 'image')
    const admit = async (): Promise<SessionPromptValue> => {
      try {
        if (hasImage) {
          const current = this.agents.selectionFor(agent).current
          const model = await this.ctx.llm.resolveModelInfo(current.provider, current.model)
          if (model.inputModalities !== undefined && !model.inputModalities.includes('image')) {
            throw new RemoteError(
              'session/attachment-invalid',
              `Model "${current.model}" does not support image input.`,
              { reason: 'MODEL_DOES_NOT_SUPPORT_IMAGES' },
            )
          }
        }
        const admission = resolvePromptFileReceipts(
          request.content,
          receiptId => this.ctx.fileUploads.resolve(agent, receiptId),
        )
        const content = await this.ctx.attachments.admitPromptContent(admission.content)
        const message: UserMessage = createUserMessage({ content, source })
        if (this.ctx.agents.get(agent.id) !== agent) {
          throw new RemoteError(
            'session/not-found',
            `session "${agent.id}" was disposed during prompt admission`,
            { sessionId: agent.id },
          )
        }
        using binding = this.ctx.fileUploads.bindPrompt(agent, admission.receiptIds, request.requestId)
        const revertFromSeq = request.revertFromSeq
        if (typeof revertFromSeq === 'number') {
          const liveSession = agent.session
          const nodes = liveSession.surface.nodes
          if (request.mode === 'steer') {
            reject('revert-invalid', 'revert commit is only valid for queued prompts', { sessionId: request.sessionId })
          }
          // Quietly queued child settlement notices do not block the commit:
          // they are not operator input, they keep their FIFO order before the
          // edited message, and rejecting here would make the preserved
          // results from a revert impossible to land on the next send.
          const pendingUserInput = [...agent.inbox.nextTurn, ...agent.inbox.nextStep]
            .some(message => message.source.kind === 'user')
          if (agent.status === 'running' || pendingUserInput) {
            reject('revert-invalid', 'revert commit requires idle session with no pending input', { sessionId: request.sessionId })
          }
          const anchor = SessionSeq(revertFromSeq)
          const startIdx = nodes.indexOf(anchor)
          const lastSurfaceSeq = nodes[nodes.length - 1]
          const shadowable = startIdx !== -1
            && revertAnchorOf(liveSession, revertFromSeq) !== undefined
            && lastSurfaceSeq !== undefined
            // A failed or empty turn tail leaves the anchor itself as the last
            // surface node; the commit replaces exactly that node, which is
            // how taking back a failed message removes it from the surface.
            && (lastSurfaceSeq as number) >= revertFromSeq
          if (!shadowable) {
            // Always-promptable invariant: an unusable revert boundary (anchor
            // gone or no longer a user-message surface node) must not wedge
            // sends. Clear the stale boundary and admit the message as a plain
            // append instead of rejecting the prompt.
            liveSession.append('revert/state', { fromSeq: null, cause: 'commit' })
            // Revert commits are queue-only (steer was rejected above by the
            // flow-narrowing guard), so the append always queues.
            agent.followup(message)
          } else {
            const shadowedSeqs = nodes.filter(seq => (seq as number) >= revertFromSeq)
            const iterationIndex = (await this.indexFor(liveSession.id)).iterations
            const chain = resolveCommitIterationChain(liveSession, iterationIndex, revertFromSeq)
            const iteration: AgentIterationIntent = {
              // The reverted message may itself be a later variant; the group
              // anchor is the original variant that opened the chain. A revert
              // anchored at a compaction checkpoint resolves through the
              // variants the checkpoint cites, so the chain continues instead
              // of minting a new group keyed by the checkpoint seq.
              groupAnchor: chain.groupAnchor,
              previousSeq: chain.previousSeq,
              startSeq: revertFromSeq,
              endSeq: lastSurfaceSeq,
              cause: 'commit',
            }
            const intent = {
              surfaceOp: { op: 'replace' as const, startSeq: anchor, endSeq: lastSurfaceSeq },
              sourceEventSeqs: [...shadowedSeqs],
              clearRevert: true,
              iteration,
            }
            // Revert commits are queue-only (steer was rejected above by the
            // flow-narrowing guard), so the shadowed append always queues.
            agent.followup(message, intent)
          }
        } else {
          if (request.mode === 'steer') agent.steer(message)
          else agent.followup(message)
        }
        binding.commit()
      } catch (error) {
        if (remoteErrorOf(error) !== undefined) throw error
        if (error instanceof AttachmentError) {
          throw new RemoteError('session/attachment-invalid', error.message, { reason: error.code })
        }
        throw new RemoteError('session/agent-busy', 'prompt rejected', { reason: String(error) })
      }
      return { accepted: true }
    }
    return hasImage ? this.agents.serializeImageAdmission(agent, admit) : admit()
  }

  private async requireModel(selection: Pick<AgentModelSelection, 'provider' | 'model'>): Promise<void> {
    if (!await modelAvailable(this.ctx, selection)) {
      throw new RemoteError('session/model-unavailable', 'Select an available model before sending a message.',
        { provider: selection.provider, model: selection.model })
    }
  }

  /**
   * Read one durable image after proving the Session log references it.
   * @param request - Session and attachment identities used for authorization.
   * @returns the durable attachment reference and base64-encoded bytes.
   */
  async attachment(request: SessionAttachmentRequest): Promise<SessionAttachmentValue> {
    const attached = this.ctx.sessions.get(request.sessionId)
    let ref: ImageAttachmentRef | undefined
    if (attached !== undefined) {
      // Live Session: the derived index already covers every durable event.
      ref = (await this.indexFor(attached.id)).referencedImage(String(request.attachmentId))
    } else {
      let source: SessionReadState
      try {
        source = await this.readSessionState(request.sessionId)
      } catch (error) {
        if (error instanceof ApiSessionNotFound) {
          throw new RemoteError('session/not-found', error.message, { sessionId: request.sessionId })
        }
        throw new RemoteError(
          'gateway/internal',
          `attachment authorization unavailable for session "${request.sessionId}": ${String(error)}`,
          {},
        )
      }
      ref = referencedImage(source.events, String(request.attachmentId))
    }
    if (ref === undefined) {
      throw new RemoteError(
        'session/attachment-invalid',
        'Image is not referenced by this session.',
        { reason: 'ATTACHMENT_NOT_REFERENCED' },
      )
    }
    try {
      const stored = await this.ctx.attachments.readImage(ref)
      return {
        attachment: stored.ref,
        data: Buffer.from(stored.data).toString('base64'),
      }
    } catch (error) {
      if (error instanceof AttachmentError) {
        throw new RemoteError('session/attachment-invalid', error.message, { reason: error.code })
      }
      throw new RemoteError('gateway/internal', 'Unable to read image attachment.', {})
    }
  }

  /**
   * Mutate one pending Inbox occurrence, restoring an ordinary cold Agent when needed.
   * @param request - Session, queue item, and requested mutation.
   * @returns acknowledgement that the queue mutation was applied.
   */
  async updateQueue(request: SessionUpdateQueueRequest): Promise<SessionUpdateQueueValue> {
    if (request.action.kind === 'edit') {
      // oxlint-disable-next-line typescript/no-unnecessary-condition -- Remote callers can submit untyped JSON.
      if (request.action.content.some(block => block.type !== 'text')) {
        throw new RemoteError(
          'session/attachment-invalid',
          'queue edits accept text content only',
          { reason: 'QUEUE_EDIT_NON_TEXT' },
        )
      }
      if (!hasPromptContent(request.action.content)) {
        throw new RemoteError(
          'gateway/bad-request',
          'queue edit content must include non-whitespace text',
          {},
        )
      }
    }
    let agent = this.ctx.agents.get(request.sessionId)
    if (agent === undefined) {
      const found = await this.agents.resolveAgent(request.sessionId)
      if ('error' in found) {
        if (found.error.code !== 'session/not-found') throw found.error
        throw new RemoteError('session/queue-item-not-found', 'queued item is no longer pending', { itemId: request.itemId })
      }
      agent = found.agent
    }
    if (hasApiSessionSubagentOwner(this.ctx, agent.session, agent)) {
      const identity = this.ctx.sessionProjections
        .snapshot(agent.session, ['subagent'])
        .values.subagent
      if (identity?.mode !== 'continuable'
        || !agent.session.isOwnSeq(identity.seq)) {
        throw apiSessionSubagentOwnershipError(request.sessionId)
      }
    }
    const nextTurn = agent.inbox.nextTurn.find(message => message.id === request.itemId)
    const nextStep = agent.inbox.nextStep.find(message => message.id === request.itemId)
    const located = nextTurn === undefined
      ? nextStep === undefined ? undefined : { target: 'next-step' as const, message: nextStep }
      : { target: 'next-turn' as const, message: nextTurn }
    if (located === undefined) {
      throw new RemoteError('session/queue-item-not-found', 'queued item is no longer pending', { itemId: request.itemId })
    }
    const { target, message } = located
    if (request.action.kind === 'steer' && (target !== 'next-turn' || agent.status !== 'running')) {
      throw new RemoteError('session/steer-unavailable', 'current turn no longer accepts steering', { itemId: request.itemId })
    }
    switch (request.action.kind) {
      case 'edit':
        agent.inbox.replace(request.itemId, freezeMessage<UserMessage>({
          ...message,
          content: [...request.action.content],
        }))
        break
      case 'remove': {
        agent.inbox.remove(request.itemId)
        const source = message.source
        if (source.kind === 'user' && 'rpcId' in source) {
          this.ctx.fileUploads.retirePrompt(agent, source.rpcId)
        }
        break
      }
      case 'steer':
        agent.inbox.remove(request.itemId)
        agent.steer(message)
        break
      case 'wake':
        // A quietly queued settlement notice lands as its own next turn.
        agent.inbox.remove(request.itemId)
        agent.followup(message)
        break
      /* v8 ignore next 2 -- closed-union exhaustiveness guard */
      default:
        assertNever(request.action, 'queue action')
    }
    return { accepted: true }
  }

  /**
   * Cancel one live ordinary Agent while retaining pending inbox work.
   * @param request - Session whose active Agent turn is cancelled.
   * @returns acknowledgement that cancellation was requested.
   */
  cancel(request: SessionCancelRequest): SessionCancelValue {
    const agent = this.ctx.agents.get(request.sessionId)
    if (agent === undefined) {
      throw new RemoteError(
        'session/not-found',
        `session "${request.sessionId}" not found (not attached)`,
        { sessionId: request.sessionId },
      )
    }
    if (hasApiSessionSubagentOwner(this.ctx, agent.session, agent)) {
      throw apiSessionSubagentOwnershipError(request.sessionId)
    }
    agent.cancel(
      {
        kind: 'user',
        ...(request.participant === undefined ? {} : { participant: request.participant }),
        // Absent intent keeps the pre-intent wire behaviour: stop everything.
        intent: request.intent ?? 'stop-all',
      },
      { keepInbox: true },
    )
    return { accepted: true }
  }

  /**
   * Cancel running or pending user work for a revert boundary, preserving
   * child settlement notices (A3): they are captured, the cancel clears the
   * inbox, and they are re-queued quietly once the aborted activity converges,
   * so a revert never discards a child result and never wakes a turn to
   * deliver one.
   * @param agent - Agent owning the active or queued work.
   * @param fromSeq - boundary seq carried by the cancel intent.
   * @param participant - original requester, when the caller is a peer.
   */
  private cancelForRevert(
    agent: Agent,
    fromSeq: number,
    participant?: SessionRevertRequest['participant'],
  ): void {
    if (agent.status !== 'running' && agent.inbox.nextTurn.length === 0 && agent.inbox.nextStep.length === 0) return
    const preserved = [...agent.inbox.nextTurn, ...agent.inbox.nextStep]
      .filter(message => message.source.kind !== 'user')
    agent.cancel(
      {
        kind: 'user',
        ...(participant === undefined ? {} : { participant }),
        intent: 'revert',
        revertFromSeq: SessionSeq(fromSeq),
      },
      { keepInbox: false },
    )
    if (preserved.length > 0) {
      void agent.whenIdle().then(() => {
        for (const message of preserved) {
          try {
            agent.send(message, 'next-turn', false)
          } catch {
            // The Agent was disposed between convergence and this replay:
            // its inbox can no longer hold the preserved notices.
          }
        }
      }, () => {
        // Disposal or a failed driver: the preserved notices have no live
        // inbox left to hold them.
      })
    }
  }

  /**
   * Revert the conversation from a user message: everything from `atSeq`
   * becomes reverted (hidden from the transcript on commit and from the model
   * surface on the next send) and the reverted query text is returned for the
   * input card. Appends the durable `revert/state { fromSeq, cause }` log
   * event. A user message with no following surface node (a failed or empty
   * turn tail) still arms the boundary; the next send commits a replacement
   * spanning exactly that message.
   * @param request - Session identity and the user-message seq anchoring the revert.
   * @returns the reverted query text and count for the input card.
   */
  async revert(request: SessionRevertRequest): Promise<SessionRevertValue> {
    // Attach on demand: reverting, restoring, switching a branch, and
    // resolving a file conflict are surface/state operations, not sends — an
    // operator may act on a freshly opened session whose agent is not
    // attached yet.
    const agent = await this.resolveAgent(request.sessionId)
    if (hasApiSessionSubagentOwner(this.ctx, agent.session, agent)) {
      rejectFailure(apiSessionSubagentOwnershipError(request.sessionId))
    }
    // If a turn is running or inbox has pending work, cancel it first so the
    // revert takes effect immediately instead of rejecting with agent-busy.
    this.cancelForRevert(agent, request.atSeq, request.participant)
    const session = agent.session
    const nodes = session.surface.nodes
    const startIdx = nodes.indexOf(SessionSeq(request.atSeq))
    if (startIdx === -1) {
      reject('revert-invalid', `event ${String(request.atSeq)} is not an active surface node (revert anchors on a user message)`, { sessionId: request.sessionId, atSeq: request.atSeq })
    }
    const target = revertAnchorOf(session, request.atSeq)
    if (target === undefined) {
      reject('revert-invalid', `event ${String(request.atSeq)} is not a user message (revert anchors on a user message)`, { sessionId: request.sessionId, atSeq: request.atSeq })
    }
    const revertedText = messageTextOf(target.data)
    const shadowedSeqs = nodes.slice(startIdx + 1)
    const revertedCount = shadowedSeqs
      // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
      .filter(seq => session.eventAt(seq)?.type === 'user/message').length
    session.append('revert/state', { fromSeq: request.atSeq, cause: 'revert' })
    return { accepted: true, revertedText, revertedCount }
  }

  /**
   * Restore reverted messages: `restoreSeq` omitted restores everything
   * (clears the revert boundary); `restoreSeq` set restores that message and
   * everything after it (moves the boundary back). Appends the durable
   * `revert/state` log event. No-op when no revert is active.
   */
  async revertRestore(request: SessionRevertRestoreRequest): Promise<SessionRevertRestoreValue> {
    // Attach on demand: reverting, restoring, switching a branch, and
    // resolving a file conflict are surface/state operations, not sends — an
    // operator may act on a freshly opened session whose agent is not
    // attached yet.
    const agent = await this.resolveAgent(request.sessionId)
    if (hasApiSessionSubagentOwner(this.ctx, agent.session, agent)) {
      rejectFailure(apiSessionSubagentOwnershipError(request.sessionId))
    }
    const session = agent.session
    const boundary = (await this.indexFor(session.id)).latestRevertBoundary()
    if (boundary === undefined) {
      // No active revert — no-op success.
      return { accepted: true }
    }
    if (request.restoreSeq !== undefined) {
      const target = revertAnchorOf(session, request.restoreSeq)
      if (target === undefined) {
        reject('revert-invalid', `event ${String(request.restoreSeq)} is not a user message (restore target)`, { sessionId: request.sessionId, atSeq: request.restoreSeq })
      }
    }
    const fromSeq = request.restoreSeq ?? null
    session.append('revert/state', { fromSeq, cause: 'restore' })
    return { accepted: true }
  }

  /**
   * List durable iteration groups for a Session: the variant chains folded
   * from `revert/iteration` markers plus the pre-marker `surfaceOp.startSeq`
   * fallback. Cold-safe: an unattached Session folds the full log instead of
   * activating an Agent. Variant bodies are capped previews; media is returned
   * as attachment ids, never bytes.
   * @param request - session, optional group anchor, and listing bounds.
   * @returns the bounded groups with previews and surface-activity flags.
   */
  async revertIterations(request: SessionRevertIterationsRequest): Promise<SessionRevertIterationsValue> {
    let index: SessionCommandIndex
    try {
      index = await this.indexFor(request.sessionId)
    } catch (error) {
      if (error instanceof ApiSessionNotFound) {
        throw new RemoteError('session/not-found', error.message, { sessionId: request.sessionId })
      }
      throw error
    }
    const attached = this.ctx.sessions.get(request.sessionId)
    let events: readonly SessionEvent[] | undefined
    let nodes: readonly SessionSeq[]
    if (attached !== undefined) {
      // The live surface already maintains the node list; the listing never
      // copies the log (`snapshotEvents`) or scans it.
      nodes = attached.surface.nodes
    } else {
      let state: SessionReadState
      try {
        state = await this.readSessionState(request.sessionId)
      } catch (error) {
        if (error instanceof ApiSessionNotFound) {
          throw new RemoteError('session/not-found', error.message, { sessionId: request.sessionId })
        }
        throw error
      }
      events = state.events
      nodes = events.length === 0 ? [] : foldSurfaceNodes(events)
    }
    const limit = Math.min(
      ITERATION_LIST_LIMIT_MAX,
      Math.max(1, request.limit ?? ITERATION_LIST_LIMIT_DEFAULT),
    )
    const listed = listIterationGroups(index.iterations, {
      ...(request.anchorSeq === undefined ? {} : { anchorSeq: request.anchorSeq }),
      limit,
      ...(request.beforeVariantSeq === undefined ? {} : { beforeVariantSeq: request.beforeVariantSeq }),
    })
    // Resolve surface-activity only for the returned variants: one pass over
    // the current nodes instead of materializing a membership set of the whole
    // surface (the M5 budget at 10^6 events).
    const candidates = new Set<number>()
    for (const group of listed) {
      for (const variant of group.variants) candidates.add(variant.seq)
    }
    const activeCandidates = new Set<number>()
    if (candidates.size > 0) {
      for (const node of nodes) {
        if (candidates.has(node)) activeCandidates.add(node)
      }
    }
    const cited = index.iterations.checkpointCited
    const groups: SessionIterationGroup[] = listed.map(group => ({
      anchorSeq: group.anchorSeq,
      activeVariantSeq: group.activeVariantSeq,
      variants: group.variants.map((variant): SessionIterationVariant => {
        const event = attached !== undefined
          // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
          ? attached.eventAt(SessionSeq(variant.seq))
          : events?.[variant.seq]
        const preview = iterationPreviewOf(event)
        return {
          seq: variant.seq,
          previousSeq: variant.previousSeq,
          time: event?.time ?? 0,
          // Only a compaction checkpoint represents the variants it cites; a
          // replacement's shadowed-source citations are not representations.
          surfaceActive: activeCandidates.has(variant.seq) || cited.has(variant.seq),
          ...preview,
        }
      }),
    }))
    return { groups }
  }

  /**
   * Switch the active conversation branch to one iteration variant: the
   * target branch's original records become the model surface and the
   * displaced branch becomes shadowed, through one log-only `revert/branch`
   * event. No user message, no turn, and no model call is produced — a
   * restore is a surface-state swap, not a resend. File state follows the
   * branch position through the existing `revert/state` boundary: the current
   * branch end is pinned first, the target branch end moves the boundary
   * (revert backward or un-revert forward), and the boundary is disarmed.
   * The target is validated as a known variant of a represented group with
   * restorable branch records; missing, foreign, already-active, or
   * branchless targets reject with `revert-invalid` before any write.
   * @param request - session, target variant, and the idempotency request id.
   * @returns acknowledgement that the branch switch committed.
   */
  async revertIterationRestore(request: SessionRevertIterationRestoreRequest): Promise<SessionRevertIterationRestoreValue> {
    // Attach on demand: reverting, restoring, switching a branch, and
    // resolving a file conflict are surface/state operations, not sends — an
    // operator may act on a freshly opened session whose agent is not
    // attached yet.
    const agent = await this.resolveAgent(request.sessionId)
    if (hasApiSessionSubagentOwner(this.ctx, agent.session, agent)) {
      rejectFailure(apiSessionSubagentOwnershipError(request.sessionId))
    }
    if (this.restoringSessions.has(request.sessionId)) {
      reject('session/agent-busy', 'another iteration restore is already in flight for this session', { reason: 'ITERATION_RESTORE_IN_FLIGHT' })
    }
    if (this.iterationRestoreRequests.get(request.sessionId)?.has(request.requestId) === true) {
      return { accepted: true }
    }
    const session = agent.session
    // Bounded serialization against a running turn: the restore plans against
    // the settled surface, so a settlement append cannot invalidate the branch
    // lists between planning and the switch. The turn is cancelled first; a
    // turn that does not settle within the bound refuses with a retryable
    // busy error before any write (the plan would be stale, and a partial
    // restore must never land).
    if (agent.status === 'running' || agent.inbox.nextTurn.length > 0 || agent.inbox.nextStep.length > 0) {
      this.cancelForRevert(agent, request.variantSeq)
      if (!await awaitAgentIdle(agent, ITERATION_RESTORE_IDLE_TIMEOUT_MS)) {
        reject(
          'session/agent-busy',
          'the running turn did not settle before the iteration restore deadline; retry when the session is idle',
          { reason: 'ITERATION_RESTORE_TURN_ACTIVE' },
        )
      }
    }
    const index = await this.indexFor(session.id)
    const group = iterationEdges(index.iterations)
      .find(candidate => candidate.variants.some(variant => variant.seq === request.variantSeq))
    if (group === undefined) {
      reject('revert-invalid', `event ${String(request.variantSeq)} is not a known iteration variant`, { sessionId: request.sessionId, atSeq: request.variantSeq })
    }
    if (group.activeVariantSeq === request.variantSeq) {
      reject('revert-invalid', `event ${String(request.variantSeq)} is already the active version`, { sessionId: request.sessionId, atSeq: request.variantSeq })
    }
    const targetBranch = index.iterations.branchSeqs.get(request.variantSeq)
    if (targetBranch === undefined || targetBranch.length === 0) {
      reject('revert-invalid', `iteration variant ${String(request.variantSeq)} has no restorable branch records`, { sessionId: request.sessionId, atSeq: request.variantSeq })
    }
    const variants = new Set(group.variants.map(variant => variant.seq))
    const anchor = resolveIterationSurfaceAnchor(session, variants)
    if (anchor === undefined) {
      reject('revert-invalid', `iteration group ${String(group.anchorSeq)} is no longer represented on the surface`, { sessionId: request.sessionId, atSeq: request.variantSeq })
    }
    // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
    const target = session.eventAt(SessionSeq(request.variantSeq))
    if (target === undefined || target.type !== 'user/message') {
      reject('revert-invalid', `event ${String(request.variantSeq)} is not a user message (iteration target)`, { sessionId: request.sessionId, atSeq: request.variantSeq })
    }
    const nodes = session.surface.nodes
    const endSeq = nodes.at(-1)
    /* v8 ignore next -- the surface always contains the resolved anchor */
    if (endSeq === undefined) reject('revert-invalid', 'the session surface is empty', { sessionId: request.sessionId, atSeq: request.variantSeq })
    const shadowedSeqs = assertIterationRestorePlan(request.sessionId, nodes, anchor, endSeq)
    const active = new Set<number>(nodes)
    const restoredSeqs = [...new Set(targetBranch)].sort((left, right) => left - right)
    const alreadyActive = restoredSeqs.find(seq => active.has(seq))
    if (alreadyActive !== undefined) {
      reject('revert-invalid', `restored branch record ${String(alreadyActive)} is already on the surface`, { sessionId: request.sessionId, atSeq: request.variantSeq })
    }
    const targetEnd = restoredSeqs[restoredSeqs.length - 1]
    /* v8 ignore next -- a non-empty branch always has a last record */
    if (targetEnd === undefined) reject('revert-invalid', 'the restored branch is empty', { sessionId: request.sessionId, atSeq: request.variantSeq })
    // Validate the branch switch against the current surface before any
    // write. `revert/state` moves the file-revert boundary when the plugin is
    // mounted, so a switch that would throw at append time must be refused
    // before the boundary is touched (D3).
    const branchData = {
      groupAnchor: group.anchorSeq,
      variantSeq: request.variantSeq,
      previousVariantSeq: group.activeVariantSeq,
      startSeq: anchor,
      endSeq,
      shadowedSeqs: [...shadowedSeqs],
      restoredSeqs,
    }
    ;(session.surface as SessionSurface & SurfaceBranchValidator).validateNext({
      type: 'revert/branch',
      seq: SessionSeq(session.seq),
      time: 0,
      data: branchData,
    })
    this.restoringSessions.add(request.sessionId)
    try {
      // File state follows the branch position through the existing
      // file-revert boundary. The first marker pins the current branch end so
      // a forward switch is classified as an un-revert; the second moves the
      // target branch's end; the third disarms the boundary. All three are
      // log-only and append before the branch switch commits.
      session.append('revert/state', { fromSeq: endSeq, cause: 'revert' })
      session.append('revert/state', { fromSeq: targetEnd, cause: 'restore' })
      session.append('revert/state', { fromSeq: null, cause: 'commit' })
      // The branch switch itself: the target branch's original records become
      // the active surface, the displaced branch's records become shadowed.
      // No user message, no turn, no model call.
      session.append('revert/branch', branchData)
      const handled = this.iterationRestoreRequests.get(request.sessionId) ?? new Set<string>()
      handled.add(request.requestId)
      if (handled.size > 32) {
        const oldest = handled.values().next().value
        if (oldest !== undefined) handled.delete(oldest)
      }
      this.iterationRestoreRequests.set(request.sessionId, handled)
    } finally {
      this.restoringSessions.delete(request.sessionId)
    }
    return { accepted: true }
  }

  /**
   * Verify one Session log against the durability invariants: contiguous
   * commit, marker targets present, branch records reachable, offload targets
   * present, compaction sources present, the surface fold resolvable, and the
   * iteration fold identical to a fresh recompute. This is the host operator
   * surface; the model-facing session-query tools stay read-only and
   * workspace-scoped.
   * @param request - Session to verify.
   * @returns the findings and the committed prefix length.
   */
  async verifyLog(request: SessionVerifyLogRequest): Promise<SessionVerifyLogValue> {
    const attached = this.ctx.sessions.get(request.sessionId)
    const events = attached === undefined
      ? (await this.readSessionStateOrNotFound(request.sessionId)).events
      // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
      : attached.snapshotEvents()
    const report = verifySessionLog({
      events,
      index: SessionCommandIndex.fromEvents(events).iterations,
      ...(attached === undefined ? {} : { nodes: attached.surface.nodes }),
    })
    return { ok: report.ok, committedEventCount: report.committedEventCount, issues: report.issues }
  }

  /**
   * Self-heal one Session log: recover the committed prefix, neutralize
   * dangling references in the derived view, and rebuild the iteration and
   * surface folds. A live Session's cached command index is replaced by the
   * rebuilt fold. Durable events are never rewritten or deleted.
   * @param request - Session to repair.
   * @returns the repair receipt and verification of the repaired view.
   */
  async repairLog(request: SessionRepairLogRequest): Promise<SessionRepairLogValue> {
    const attached = this.ctx.sessions.get(request.sessionId)
    const events = attached === undefined
      ? (await this.readSessionStateOrNotFound(request.sessionId)).events
      // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
      : attached.snapshotEvents()
    const result = repairSessionLog({
      events,
      index: SessionCommandIndex.fromEvents(events).iterations,
      ...(attached === undefined ? {} : { nodes: attached.surface.nodes }),
    })
    if (attached !== undefined) {
      // Adopt the rebuilt folds so the live index self-heals with the receipt.
      this.commandIndexes.set(request.sessionId, SessionCommandIndex.fromEvents(result.events))
    }
    return {
      ok: result.report.ok,
      committedEventCount: result.report.committedEventCount,
      repairs: result.applied,
      issues: result.report.issues,
    }
  }

  /**
   * Preview one single-line correction to an active generated context message
   * without writing the Session or calling a model. The target must be a
   * `user/message` whose source is a compaction checkpoint or Enpoi keeper
   * checkpoint; the plan is validated through a detached Session replay.
   * @param request - Session, target block hashes, replacement line, and optional expected head.
   * @returns the one-use preview id, fingerprint, and detached before/after context metadata.
   * @throws RemoteError `session/context-repair-invalid` or `session/context-repair-stale`.
   */
  async contextRepairPreview(request: SessionContextRepairPreviewRequest): Promise<SessionContextRepairPreviewValue> {
    const sessionId = request.sessionId
    const state = await this.readSessionStateOrNotFound(sessionId)
    const live = this.ctx.agents.get(sessionId)
    if (state.header.origin === 'subagent'
      || (live !== undefined && hasApiSessionSubagentOwner(this.ctx, live.session, live))) {
      throw new RemoteError('session/context-repair-invalid', 'a subagent Session cannot be repaired by the operator surface', {
        sessionId,
        reason: 'subagent-owned',
      })
    }
    const currentHead = sessionHead(state.events)
    if (request.expectedHeadSeq !== undefined || request.expectedHeadSha256 !== undefined) {
      if (request.expectedHeadSeq !== currentHead.seq
        || request.expectedHeadSha256?.toLowerCase() !== currentHead.sha256) {
        throw new RemoteError('session/context-repair-stale',
          'the Session head no longer matches the expected seq and hash', {
            sessionId,
            expectedHeadSeq: request.expectedHeadSeq ?? -1,
            actualHeadSeq: currentHead.seq,
          })
      }
    }
    let result: ContextRepairPlanResult
    try {
      result = planContextRepair({
        sessionId,
        header: state.header,
        inheritedEventCount: state.inheritedEventCount,
        events: state.events,
        projections: this.ctx.sessions.messageProjections,
        target: request.target,
        limits: this.contextRepairLimits,
        ...(request.expectedHeadSeq === undefined ? {} : { expectedHeadSeq: request.expectedHeadSeq }),
        ...(request.expectedHeadSha256 === undefined ? {} : { expectedHeadSha256: request.expectedHeadSha256 }),
      })
    } catch (error: unknown) {
      this.rejectContextRepair(sessionId, error, currentHead.seq, request.expectedHeadSeq ?? -1)
    }
    this.rememberContextRepairPreview(result.plan)
    return result.preview
  }

  /**
   * Apply one prepared context-repair preview under `Agent.runMaintenance`.
   * The replacement text comes only from the stored plan. The API reports a
   * guarded `partial` receipt when the append commits but its durability
   * barrier or final receipt write fails; it never claims atomicity across
   * those independent writes.
   * @param request - Session, one-use preview id, and plan fingerprint.
   * @returns the applied or partial receipt and the derived context after the append.
   * @throws RemoteError for invalid, stale, busy, unsupported-persistence, backup, or failed applies.
   */
  async contextRepairApply(request: SessionContextRepairApplyRequest): Promise<SessionContextRepairApplyValue> {
    const sessionId = request.sessionId
    if (this.contextRepairApplying.has(sessionId)) {
      throw new RemoteError('session/context-repair-busy', 'another context repair is already applying', {
        sessionId,
        reason: 'apply-in-flight',
      })
    }
    const plan = this.takeContextRepairPreview(sessionId, request.previewId, request.fingerprint)
    this.contextRepairApplying.add(sessionId)
    try {
      const agent = this.ctx.agents.get(sessionId)
      if (agent === undefined) {
        throw new RemoteError('session/context-repair-busy', 'the Session has no live Agent to fence', {
          sessionId,
          reason: 'not-attached',
        })
      }
      this.assertContextRepairOwner(agent)
      this.assertContextRepairIdle(agent)
      let maintenance: Promise<SessionContextRepairApplyValue>
      try {
        maintenance = agent.runMaintenance(async signal =>
          await this.applyContextRepairUnderMaintenance(agent, plan, signal))
      } catch (error: unknown) {
        throw new RemoteError('session/context-repair-busy', 'the Agent is already running or maintaining work', {
          sessionId,
          reason: error instanceof Error ? error.message : String(error),
        })
      }
      try {
        return await maintenance
      } catch (error: unknown) {
        if (error instanceof ContextRepairRefusal) {
          // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
          this.rejectContextRepair(sessionId, error, sessionHead(agent.session.snapshotEvents()).seq, plan.headSeq)
        }
        if (remoteErrorOf(error) !== undefined) throw error
        throw new RemoteError(
          'session/context-repair-failed',
          `context repair failed for session "${sessionId}": ${error instanceof Error ? error.message : String(error)}`,
          { sessionId, reason: error instanceof Error ? error.message : String(error) },
        )
      }
    } finally {
      this.contextRepairApplying.delete(sessionId)
    }
  }

  /** Retain one prepared preview under the configured bounds. */
  private rememberContextRepairPreview(plan: ContextRepairPlan): void {
    const now = Date.now()
    for (const [previewId, prepared] of this.contextRepairPreviews) {
      if (prepared.expiresAt <= now) this.contextRepairPreviews.delete(previewId)
    }
    while (this.contextRepairPreviews.size >= this.contextRepairPreviewMaxPlans) {
      const oldest = this.contextRepairPreviews.keys().next().value
      if (oldest === undefined) break
      this.contextRepairPreviews.delete(oldest)
    }
    this.contextRepairPreviews.set(plan.previewId, {
      plan,
      expiresAt: now + this.contextRepairPreviewTtlMs,
    })
  }

  /** Consume one preview token; any replay or fingerprint mismatch is refused before a write. */
  private takeContextRepairPreview(
    sessionId: SessionId,
    previewId: ContextRepairPreviewId,
    fingerprint: SessionContextRepairApplyRequest['fingerprint'],
  ): ContextRepairPlan {
    const prepared = this.contextRepairPreviews.get(previewId)
    if (prepared === undefined) {
      throw new RemoteError('session/context-repair-invalid',
        'the context-repair preview is unknown, expired, or already consumed', {
          sessionId,
          reason: 'preview-unavailable',
        })
    }
    if (prepared.plan.sessionId !== sessionId || prepared.plan.fingerprint !== fingerprint) {
      throw new RemoteError('session/context-repair-invalid',
        'the context-repair preview does not match this Session and fingerprint', {
          sessionId,
          reason: 'fingerprint-mismatch',
        })
    }
    this.contextRepairPreviews.delete(previewId)
    if (prepared.expiresAt <= Date.now()) {
      throw new RemoteError('session/context-repair-invalid', 'the context-repair preview expired', {
        sessionId,
        reason: 'preview-expired',
      })
    }
    return prepared.plan
  }

  /** Reject a subagent-owned or non-root Session before any apply work. */
  private assertContextRepairOwner(agent: Agent): void {
    if (hasApiSessionSubagentOwner(this.ctx, agent.session, agent)
      || agent.session.header.origin === 'subagent') {
      throw new RemoteError('session/context-repair-invalid',
        'a subagent Session cannot be repaired by the operator surface', {
          sessionId: agent.session.id,
          reason: 'subagent-owned',
        })
    }
    if (this.hasActiveDescendants(agent.session.id)) {
      throw new RemoteError('session/context-repair-busy',
        'the Session has active descendant work', {
          sessionId: agent.session.id,
          reason: 'active-descendants',
        })
    }
  }

  /** Require an idle Agent with no queued inbox work or pending approval ask. */
  private assertContextRepairIdle(agent: Agent): void {
    if (agent.status !== 'idle') {
      throw new RemoteError('session/context-repair-busy', 'the Agent is not idle', {
        sessionId: agent.session.id,
        reason: 'agent-running',
      })
    }
    if (agent.inbox.nextTurn.length > 0 || agent.inbox.nextStep.length > 0) {
      throw new RemoteError('session/context-repair-busy', 'the Agent has pending inbox work', {
        sessionId: agent.session.id,
        reason: 'pending-inbox',
      })
    }
    const state = this.ctx.sessionProjections.stateOf(agent.session, 'executionState')
    if (state === undefined) {
      throw new RemoteError('session/context-repair-busy', 'the execution-state projection is unavailable', {
        sessionId: agent.session.id,
        reason: 'execution-state-unavailable',
      })
    }
    if (state.pendingApprovals.length > 0) {
      throw new RemoteError('session/context-repair-busy', 'the Agent has a pending approval ask', {
        sessionId: agent.session.id,
        reason: 'pending-approval',
      })
    }
    if (this.hasActiveDescendants(agent.session.id)) {
      throw new RemoteError('session/context-repair-busy', 'the Session has active descendant work', {
        sessionId: agent.session.id,
        reason: 'active-descendants',
      })
    }
  }

  /** Whether any running live Agent descends from this Session through durable parent links. */
  private hasActiveDescendants(sessionId: SessionId): boolean {
    for (const candidate of this.ctx.agents.list()) {
      if (candidate.id === sessionId || candidate.status !== 'running') continue
      let current = candidate.session.header.parentSession
      const seen = new Set<SessionId>()
      while (current !== undefined) {
        if (current === sessionId) return true
        if (seen.has(current)) break
        seen.add(current)
        const parent = this.ctx.agents.get(current)?.session ?? this.ctx.sessions.get(current)
        if (parent === undefined) break
        current = parent.header.parentSession
      }
    }
    return false
  }

  /** Flush, verify, back up, append, and record one guarded repair. */
  private async applyContextRepairUnderMaintenance(
    agent: Agent,
    plan: ContextRepairPlan,
    signal: AbortSignal,
  ): Promise<SessionContextRepairApplyValue> {
    const session = agent.session
    const sessionId = session.id
    const assertCurrent = (): void => {
      if (signal.aborted) throw new ContextRepairRefusal('cancelled', 'the context repair was cancelled before commit')
      this.assertContextRepairIdle(agent)
      try {
        revalidateContextRepairPlan(session, plan)
      } catch (error: unknown) {
        // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
        this.rejectContextRepair(sessionId, error, sessionHead(session.snapshotEvents()).seq, plan.headSeq)
      }
    }
    try {
      assertCurrent()
      let flushed: boolean
      try {
        flushed = await this.ctx.sessions.flush(session)
      } catch (error: unknown) {
        throw this.contextRepairBackupFailure(error, signal, 'the pre-repair durability barrier failed')
      }
      if (!flushed) {
        throw new ContextRepairRefusal('unsupported-persistence', 'no persistence backend accepted the Session flush')
      }
      assertCurrent()
      const artifactPath = await this.contextRepairArtifactPath(sessionId, signal)
      const decodedBefore = await this.verifyContextRepairHead(sessionId, plan, signal)
      const canonical = await assertContextRepairBackupLocation({
        backupRoot: this.contextRepairBackupRoot,
        sessionLogRoot: artifactPath.sessionLogRoot,
        artifactPath: artifactPath.path,
        dshHome: this.contextRepairDshHome,
      })
      let directory: string
      try {
        directory = await createContextRepairBackupDirectory(this.contextRepairBackupRoot)
      } catch (error: unknown) {
        throw this.contextRepairBackupFailure(error, signal, 'the repair backup directory failed')
      }
      let copied: { readonly artifact: ContextRepairArtifactSnapshot; readonly backup: ContextRepairBackupSnapshot }
      try {
        copied = await copyContextRepairArtifact({
          sourcePath: canonical.artifactPath,
          directory,
          maxBytes: this.contextRepairLimits.maxArtifactBytes,
          signal,
        })
      } catch (error: unknown) {
        throw this.contextRepairBackupFailure(error, signal, 'the canonical artifact backup failed')
      }
      const decodedAfter = await this.verifyContextRepairHead(sessionId, plan, signal)
      if (decodedAfter.seq !== decodedBefore.seq || decodedAfter.sha256 !== decodedBefore.sha256) {
        throw new ContextRepairRefusal('artifact-changed', 'the decoded canonical head changed during backup')
      }

      const prepared = this.contextRepairReceiptData('prepared', plan, copied.artifact, copied.backup, decodedAfter)
      let preparedPath: string
      try {
        preparedPath = await writeContextRepairReceipt(directory, 'prepared', prepared)
        assertCurrent()
      } catch (error: unknown) {
        // Close the attempt explicitly when the prepared receipt exists; an
        // orphaned prepared status would hide why no append happened.
        const reason = error instanceof Error ? error.message : String(error)
        await writeContextRepairReceipt(directory, 'failed', {
          ...prepared,
          status: 'failed',
          reason,
        }).catch(() => undefined)
        if (error instanceof ContextRepairRefusal || remoteErrorOf(error) !== undefined) throw error
        throw this.contextRepairBackupFailure(error, signal, 'the prepared repair receipt failed')
      }

      let appendedSeq: number
      let headAfter: { readonly seq: number; readonly sha256: string }
      let next: ReturnType<typeof projectSessionContext>
      try {
        const appended = session.append('user/message', plan.repairedMessage, {
          surfaceOp: { op: 'replace', startSeq: SessionSeq(plan.targetSeq), endSeq: SessionSeq(plan.targetSeq) },
          sourceEventSeqs: plan.sourceEventSeqs.map(seq => SessionSeq(seq)),
        })
        appendedSeq = appended.seq
        headAfter = canonicalEventHead(appended)
        next = projectSessionContext(session, headAfter.seq)
      } catch (error: unknown) {
        const reason = error instanceof Error ? error.message : String(error)
        const failedPath = await writeContextRepairReceipt(directory, 'failed', {
          ...prepared,
          status: 'failed',
          reason,
        }).catch(() => undefined)
        throw new RemoteError('session/context-repair-failed',
          `the context-repair append failed: ${reason}`, {
            sessionId,
            reason,
            ...(failedPath === undefined ? {} : { receiptPath: failedPath }),
          })
      }

      let warning: string | undefined
      try {
        this.ctx.emit('session/context-repair/committed', {
          sessionId,
          targetSeq: plan.targetSeq,
          sourceKind: plan.sourceKind,
          oldLine: plan.oldLine,
          replacementLine: plan.replacementLine,
          oldBlockText: plan.oldBlockText,
          newBlockText: plan.newBlockText,
          preparedReceiptPath: preparedPath,
          appendedSeq,
          headAfter,
        })
      } catch (error: unknown) {
        warning = `keeper context-repair hook failed after commit: ${error instanceof Error ? error.message : String(error)}`
      }
      const surfaceAfterHook = session.surface.nodes
      if (surfaceAfterHook.length !== next.activeSeqs.length
        || surfaceAfterHook.some((seq, index) => seq !== next.activeSeqs[index])) {
        warning = warning === undefined
          ? 'a context-repair hook changed the model surface after commit'
          : `${warning}; a context-repair hook changed the model surface after commit`
      }

      try {
        const postFlush = await this.ctx.sessions.flush(session)
        if (!postFlush) throw new Error('no persistence backend accepted the post-repair flush')
      } catch (error: unknown) {
        const reason = error instanceof Error ? error.message : String(error)
        return await this.partialContextRepairResult({
          directory,
          preparedPath,
          plan,
          artifact: copied.artifact,
          backup: copied.backup,
          decodedHead: decodedAfter,
          appendedSeq,
          headAfter,
          next,
          reason,
          ...(warning === undefined ? {} : { warning }),
        })
      }

      const baseReceipt = {
        ...prepared,
        status: 'applied' as const,
        appendedSeq,
        headAfter,
        ...(warning === undefined ? {} : { warning }),
      }
      let finalPath: string | undefined
      try {
        finalPath = await writeContextRepairReceipt(directory, 'applied', baseReceipt)
      } catch (error: unknown) {
        warning = warning === undefined
          ? `applied receipt write failed after commit: ${error instanceof Error ? error.message : String(error)}`
          : `${warning}; applied receipt write failed after commit: ${error instanceof Error ? error.message : String(error)}`
      }
      return {
        status: 'applied',
        receipt: this.contextRepairReceiptValue({
          status: 'applied',
          directory,
          preparedPath,
          ...(finalPath === undefined ? {} : { finalPath }),
          plan,
          artifact: copied.artifact,
          backup: copied.backup,
          decodedHead: decodedAfter,
          appendedSeq,
          headAfter,
          ...(warning === undefined ? {} : { warning }),
        }),
        next,
      }
    } catch (error: unknown) {
      if (error instanceof ContextRepairRefusal) throw error
      if (signal.aborted) throw new ContextRepairRefusal('cancelled', 'the context repair was cancelled before commit')
      throw error
    }
  }

  /** Record and return a post-append partial result without pretending durability. */
  private async partialContextRepairResult(input: {
    readonly directory: string
    readonly preparedPath: string
    readonly plan: ContextRepairPlan
    readonly artifact: ContextRepairArtifactSnapshot
    readonly backup: ContextRepairBackupSnapshot
    readonly decodedHead: { readonly seq: number; readonly sha256: string }
    readonly appendedSeq: number
    readonly headAfter: { readonly seq: number; readonly sha256: string }
    readonly next: ReturnType<typeof projectSessionContext>
    readonly reason: string
    readonly warning?: string
  }): Promise<SessionContextRepairApplyValue> {
    let finalPath: string | undefined
    try {
      finalPath = await writeContextRepairReceipt(input.directory, 'partial', {
        ...this.contextRepairReceiptData('partial', input.plan, input.artifact, input.backup, input.decodedHead, input.reason),
        status: 'partial',
        appendedSeq: input.appendedSeq,
        headAfter: input.headAfter,
        ...(input.warning === undefined ? {} : { warning: input.warning }),
      })
    } catch {
      // The prepared receipt remains the rollback source even when the
      // partial-status receipt cannot be written.
    }
    return {
      status: 'partial',
      receipt: this.contextRepairReceiptValue({
        status: 'partial',
        directory: input.directory,
        preparedPath: input.preparedPath,
        ...(finalPath === undefined ? {} : { finalPath }),
        plan: input.plan,
        artifact: input.artifact,
        backup: input.backup,
        decodedHead: input.decodedHead,
        appendedSeq: input.appendedSeq,
        headAfter: input.headAfter,
        reason: input.reason,
        ...(input.warning === undefined ? {} : { warning: input.warning }),
      }),
      next: input.next,
    }
  }

  /** Resolve the provider artifact path plus its canonical Session log tree root. */
  private async contextRepairArtifactPath(
    sessionId: SessionId,
    signal: AbortSignal,
  ): Promise<{ readonly path: string; readonly sessionLogRoot: string }> {
    const persistence = this.ctx.get('sessionPersistence') as {
      readonly resolveCurrentLog?: (id: SessionId, signal?: AbortSignal) => Promise<string | undefined>
      readonly config?: { readonly root?: unknown }
    } | undefined
    const resolveCurrentLog = persistence?.resolveCurrentLog
    if (persistence === undefined || typeof resolveCurrentLog !== 'function') {
      throw new ContextRepairRefusal('unsupported-persistence',
        'the mounted persistence provider exposes no canonical artifact location')
    }
    let path: string | undefined
    try {
      path = await resolveCurrentLog.call(persistence, sessionId, signal)
    } catch (error: unknown) {
      if (signal.aborted) throw new ContextRepairRefusal('cancelled', 'the context repair was cancelled before commit')
      if (error instanceof ContextRepairRefusal) throw error
      throw this.contextRepairBackupFailure(error, signal, 'the persistence provider could not locate the canonical artifact')
    }
    if (path === undefined) {
      throw new ContextRepairRefusal('unsupported-persistence',
        'the persistence provider has no current-generation artifact for this Session')
    }
    const configuredRoot = persistence.config?.root
    return {
      path,
      sessionLogRoot: typeof configuredRoot === 'string' ? configuredRoot : dirname(path),
    }
  }

  /** Verify the provider-decoded canonical head and exact log length before append. */
  private async verifyContextRepairHead(
    sessionId: SessionId,
    plan: ContextRepairPlan,
    signal: AbortSignal,
  ): Promise<{ readonly seq: number; readonly sha256: string }> {
    const persistence = this.ctx.get('sessionPersistence')
    if (persistence === undefined) {
      throw new ContextRepairRefusal('unsupported-persistence', 'no persistence backend is mounted')
    }
    let handle
    try {
      handle = await persistence.open(sessionId, 'read', { signal })
    } catch (error: unknown) {
      if (signal.aborted) throw new ContextRepairRefusal('cancelled', 'the context repair was cancelled before commit')
      throw this.contextRepairBackupFailure(error, signal, 'the canonical Session artifact could not be opened')
    }
    try {
      if (handle.header.id !== sessionId) {
        throw new ContextRepairRefusal('logical-head-mismatch', 'the canonical artifact belongs to another Session')
      }
      const slice = await handle.read(plan.headSeq, 2, { signal })
      const first = slice.events[0]
      if (first === undefined || first.seq !== plan.headSeq || slice.events.length !== 1) {
        throw new ContextRepairRefusal(
          'logical-head-mismatch',
          'the decoded canonical log does not end at the previewed head',
        )
      }
      const head = canonicalEventHead(first)
      if (head.sha256 !== plan.headSha256) {
        throw new ContextRepairRefusal(
          'logical-head-mismatch',
          'the decoded canonical head does not match the previewed head hash',
          head,
        )
      }
      return head
    } catch (error: unknown) {
      if (signal.aborted) throw new ContextRepairRefusal('cancelled', 'the context repair was cancelled before commit')
      if (error instanceof ContextRepairRefusal) throw error
      throw this.contextRepairBackupFailure(error, signal, 'the canonical Session artifact could not be decoded')
    } finally {
      await handle.close().catch(() => undefined)
    }
  }

  /** Classify one pre-append backup failure without masking cancellation. */
  private contextRepairBackupFailure(error: unknown, signal: AbortSignal, context: string): ContextRepairRefusal {
    if (signal.aborted) return new ContextRepairRefusal('cancelled', 'the context repair was cancelled before commit')
    if (error instanceof ContextRepairRefusal) return error
    const code = (error as NodeJS.ErrnoException | null)?.code
    if (code === 'ENOSPC' || code === 'EACCES' || code === 'EPERM' || code === 'EROFS') {
      return new ContextRepairRefusal('backup-failed', `${context}: ${code}`, undefined)
    }
    return new ContextRepairRefusal(
      'backup-failed',
      `${context}: ${error instanceof Error ? error.message : String(error)}`,
    )
  }

  /** Build the immutable receipt payload shared by prepared, applied, partial, and failed files. */
  private contextRepairReceiptData(
    status: ContextRepairReceiptStatus,
    plan: ContextRepairPlan,
    artifact: ContextRepairArtifactSnapshot,
    backup: ContextRepairBackupSnapshot,
    decodedHead: { readonly seq: number; readonly sha256: string },
    reason?: string,
  ): Readonly<Record<string, unknown>> {
    return {
      schema: 'dsh-context-repair-receipt/1',
      status,
      createdAt: Date.now(),
      sessionId: plan.sessionId,
      previewId: plan.previewId,
      fingerprint: plan.fingerprint,
      headBefore: { seq: plan.headSeq, sha256: plan.headSha256 },
      logicalHead: decodedHead,
      target: {
        seq: plan.targetSeq,
        sourceKind: plan.sourceKind,
        blockIndex: plan.blockIndex,
        blockSha256: plan.blockSha256,
        oldLineSha256: plan.oldLineSha256,
        oldLine: plan.oldLine,
        oldBlockText: plan.oldBlockText,
        newBlockText: plan.newBlockText,
        replacementLine: plan.replacementLine,
        previousSourceEventSeqs: [...plan.previousSourceEventSeqs],
      },
      surfaceOp: { op: 'replace', startSeq: plan.targetSeq, endSeq: plan.targetSeq },
      sourceEventSeqs: [...plan.sourceEventSeqs],
      artifact: {
        path: artifact.path,
        sha256: artifact.sha256,
        sizeBytes: artifact.sizeBytes,
        mode: artifact.mode,
        dev: artifact.dev,
        ino: artifact.ino,
        mtimeMs: artifact.mtimeMs,
      },
      backup,
      ...(reason === undefined ? {} : { reason }),
    }
  }

  /** Narrow one receipt for the wire without exposing private text bodies. */
  private contextRepairReceiptValue(input: {
    readonly status: 'applied' | 'partial'
    readonly directory: string
    readonly preparedPath: string
    readonly finalPath?: string
    readonly plan: ContextRepairPlan
    readonly artifact: ContextRepairArtifactSnapshot
    readonly backup: ContextRepairBackupSnapshot
    readonly decodedHead: { readonly seq: number; readonly sha256: string }
    readonly appendedSeq: number
    readonly headAfter: { readonly seq: number; readonly sha256: string }
    readonly reason?: string
    readonly warning?: string
  }): SessionContextRepairReceipt {
    return {
      status: input.status,
      directory: input.directory,
      preparedPath: input.preparedPath,
      ...(input.finalPath === undefined ? {} : { finalPath: input.finalPath }),
      backupPath: input.backup.path,
      backupSha256: input.backup.sha256,
      artifactPath: input.artifact.path,
      artifactSha256: input.artifact.sha256,
      artifactSizeBytes: input.artifact.sizeBytes,
      artifactDev: input.artifact.dev,
      artifactIno: input.artifact.ino,
      artifactMtimeMs: input.artifact.mtimeMs,
      artifactMode: input.artifact.mode,
      logicalHead: input.decodedHead,
      headBefore: { seq: input.plan.headSeq, sha256: input.plan.headSha256 },
      appendedSeq: input.appendedSeq,
      headAfter: input.headAfter,
      ...(input.reason === undefined ? {} : { reason: input.reason }),
      ...(input.warning === undefined ? {} : { warning: input.warning }),
    }
  }

  /** Map one helper refusal onto its stable operator failure. */
  private rejectContextRepair(
    sessionId: SessionId,
    error: unknown,
    actualHeadSeq?: number,
    expectedHeadSeq?: number,
  ): never {
    if (!(error instanceof ContextRepairRefusal)) {
      if (remoteErrorOf(error) !== undefined) throw error
      throw new RemoteError('session/context-repair-invalid',
        error instanceof Error ? error.message : String(error), {
          sessionId,
          reason: 'unexpected',
        })
    }
    switch (error.reason) {
      case 'stale-head':
      case 'logical-head-mismatch':
        throw new RemoteError('session/context-repair-stale', error.message, {
          sessionId,
          expectedHeadSeq: expectedHeadSeq ?? -1,
          actualHeadSeq: error.head?.seq ?? actualHeadSeq ?? -1,
        })
      case 'busy':
        throw new RemoteError('session/context-repair-busy', error.message, { sessionId, reason: error.reason })
      case 'unsupported-persistence':
        throw new RemoteError('session/context-repair-unsupported-persistence', error.message, {
          sessionId,
          reason: error.reason,
        })
      case 'backup-failed':
      case 'backup-root-invalid':
      case 'invalid-artifact':
      case 'artifact-changed':
      case 'artifact-too-large':
      case 'backup-corrupt':
        throw new RemoteError('session/context-repair-backup-failed', error.message, {
          sessionId,
          reason: error.reason,
        })
      case 'cancelled':
        throw new RemoteError('gateway/cancelled', error.message, {})
      default:
        throw new RemoteError('session/context-repair-invalid', error.message, {
          sessionId,
          reason: error.reason,
        })
    }
  }

  /**
   * Apply the operator's resolution for one pending file-revert conflict
   * (surfaced via `revert/file-conflict` log events by the `enpoi-file-revert`
   * plugin). The host bridges to the plugin through the `file-revert/resolve`
   * waterfall; without the plugin mounted the call degrades to a clear error.
   * A mounted plugin that refuses the id (no such conflict, or a stale card)
   * rejects with `file-revert-invalid`; its own diagnostics and resolution
   * audit stay with the plugin.
   */
  async resolveFileConflict(request: SessionResolveFileConflictRequest): Promise<SessionResolveFileConflictValue> {
    // Attach on demand: resolving a file conflict is a state operation, not
    // a send — an operator may act on a freshly opened session whose agent
    // is not attached yet.
    await this.resolveAgent(request.sessionId)
    const waterfall = (this.ctx as unknown as {
      waterfall?: (name: string, payload: unknown, next: () => unknown) => Promise<unknown>
    }).waterfall
    if (waterfall === undefined) {
      reject('file-revert-unavailable', 'file-revert plugin is not mounted; cannot resolve conflicts', { sessionId: request.sessionId })
    }
    const outcome = await waterfall('file-revert/resolve', {
      sessionId: request.sessionId,
      conflictId: request.conflictId,
      resolution: request.resolution,
    }, () => ({ accepted: false as const, reason: 'file-revert plugin not mounted' })) as
      | { readonly accepted?: boolean; readonly reason?: string }
      | undefined
    if (outcome === undefined || outcome.accepted !== true) {
      if (outcome === undefined || outcome.reason === 'file-revert plugin not mounted') {
        reject('file-revert-unavailable', 'file-revert plugin is not mounted; cannot resolve conflicts', { sessionId: request.sessionId })
      }
      const reason = outcome.reason ?? 'the file-revert bridge returned no outcome'
      reject(
        'file-revert-invalid',
        `session "${request.sessionId}" cannot resolve file-revert conflict "${request.conflictId}": ${reason}`,
        { sessionId: request.sessionId, conflictId: request.conflictId, reason },
      )
    }
    return { accepted: true }
  }

  /**
   * Permanently delete a session: cancels and disposes a live session,
   * removes its workspace accounting, deletes the durable log, and
   * best-effort removes per-session side files. An unknown id is rejected
   * with `session/not-found`; a known session that is already gone from disk
   * still succeeds. Destructive — the client must confirm before calling.
   */
  async delete(request: SessionDeleteRequest): Promise<SessionDeleteValue> {
    const agent = this.ctx.agents.get(request.sessionId)
    if (agent !== undefined) {
      if (hasApiSessionSubagentOwner(this.ctx, agent.session, agent)) {
        rejectFailure(apiSessionSubagentOwnershipError(request.sessionId))
      }
      agent.cancel({ kind: 'user' }, { keepInbox: false })
      const disposer = (this.agents as unknown as { dispose?: (id: SessionId) => Promise<void> }).dispose
      if (disposer !== undefined) {
        await disposer(request.sessionId)
      }
    } else if (this.ctx.sessions.get(request.sessionId) === undefined) {
      try {
        await inspectApiSession(this.ctx, request.sessionId)
      } catch (error: unknown) {
        if (error instanceof ApiSessionNotFound) {
          reject('session-not-found', `session "${request.sessionId}" not found`, { sessionId: request.sessionId })
        }
        throw error
      }
    }
    const persistence = this.ctx.get('sessionPersistence') as { delete?: (id: SessionId) => Promise<void> } | undefined
    if (persistence?.delete !== undefined) {
      await persistence.delete(request.sessionId)
    }
    // Detach the live Session after its durable log is gone so `executionState`
    // and `digest` stop answering for a deleted Session. Safe from an RPC: the
    // Agent was cancelled above and the Session's own owner treats the later
    // detach as a no-op.
    this.ctx.sessions.dispose(request.sessionId)
    this.commandIndexes.delete(request.sessionId)
    return { deleted: true }
  }

  private async resolveAgent(sessionId: SessionId): Promise<Agent> {
    const found = await this.agents.resolveAgent(sessionId)
    if ('error' in found) throw found.error
    return found.agent
  }

  private rejectCreation(sessionId: SessionId, error: unknown): never {
    if (remoteErrorOf(error) !== undefined) throw error
    if (error instanceof Error && error.name === 'SessionAlreadyOwnedError') {
      throw new RemoteError('session/writer-held', error.message, { sessionId })
    }
    if (error instanceof ApiSessionPresetConflict) {
      throw new RemoteError('agent-preset/conflict', error.message, {
        sessionId: error.sessionId,
        requestedPreset: error.requestedPreset,
        ...(error.existingPreset === undefined ? {} : { existingPreset: error.existingPreset }),
      })
    }
    if (error instanceof ApiSessionCwdConflict) {
      throw new RemoteError('session/conflict', error.message, {
        sessionId: error.sessionId,
        requestedCwd: error.requestedCwd,
        ...(error.existingCwd === undefined ? {} : { existingCwd: error.existingCwd }),
      })
    }
    if (error instanceof ApiSessionSubagentOwnership) {
      throw apiSessionSubagentOwnershipError(error.sessionId)
    }
    throw new RemoteError('gateway/internal', `failed to create session "${sessionId}": ${String(error)}`, {})
  }

  private async readSessionStateOrNotFound(sessionId: SessionId): Promise<SessionReadState> {
    try {
      return await this.readSessionState(sessionId)
    } catch (error) {
      if (error instanceof ApiSessionNotFound) {
        throw new RemoteError('session/not-found', error.message, { sessionId })
      }
      throw error
    }
  }

  private async readSessionState(sessionId: SessionId): Promise<SessionReadState> {
    const attached = this.ctx.sessions.get(sessionId)
    if (attached !== undefined) {
      return {
        id: attached.id,
        header: attached.header,
        inheritedEventCount: attached.inheritedEventCount,
        // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
        events: attached.snapshotEvents(),
      }
    }
    const inspected = await inspectApiSession(this.ctx, sessionId)
    return {
      id: inspected.meta.id,
      header: inspected.meta,
      inheritedEventCount: inspected.inheritedEventCount,
      events: inspected.events,
    }
  }

  private async forkWorkspace(source: SessionHeader): Promise<Workspace | undefined> {
    const workspaces = this.ctx.workspaceRegistry.list()
    const direct = workspaces.find(workspace => workspace.sessionIds.includes(source.id))
    if (direct !== undefined || source.origin !== 'subagent') return direct
    const lineage = await this.ctx.sessionQuery.traceSession(source.id)
    for (const ancestor of lineage.ancestors) {
      const workspace = workspaces.find(candidate => candidate.sessionIds.includes(ancestor.header.id))
      if (workspace !== undefined) return workspace
    }
    return undefined
  }
}

/** Best-effort text extraction from a user/message event payload. */
function messageTextOf(data: unknown): string {
  if (!data || typeof data !== 'object') return ''
  const content = (data as { content?: unknown }).content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part
        if (part !== null && typeof part === 'object' && 'text' in part && typeof (part as { text: unknown }).text === 'string') {
          return (part as { text: string }).text
        }
        return ''
      })
      .filter(text => text.length > 0)
      .join(' ')
  }
  return ''
}

/**
 * Resolve the surface node currently representing one iteration group.
 *
 * The active variant itself when it is a surface node; otherwise the nearest
 * later surface node whose `sourceEventSeqs` cites a variant — the compaction
 * checkpoint that replaced the group position. A shadowed variant with no
 * citing checkpoint is deliberately unresolvable: appending a replacement
 * anchored there would throw, and the group is no longer on the surface.
 * @param session - live Agent Session.
 * @param variants - every variant seq of the group.
 * @returns the current surface anchor, or undefined when the group is gone.
 */
function resolveIterationSurfaceAnchor(
  session: Session,
  variants: ReadonlySet<number>,
): SessionSeq | undefined {
  const nodes = session.surface.nodes
  for (let index = nodes.length - 1; index >= 0; index--) {
    const seq = nodes[index]
    /* v8 ignore next -- dense node arrays never carry holes */
    if (seq === undefined) continue
    if (variants.has(seq)) return seq
    // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
    const event = session.eventAt(seq)
    if (event?.type === 'user/message') {
      // The compaction plugin owns this source kind; read it structurally.
      const kind: string = event.data.source.kind
      if (kind === 'compact-checkpoint'
        && event.sourceEventSeqs?.some(source => variants.has(source)) === true) return seq
    }
  }
  return undefined
}

/**
 * Validate a planned restore replacement against the current surface before any
 * write. The append path re-validates the same rules; this exists so a rejected
 * plan cannot leave the file-revert boundary (D3) or the iteration marker
 * behind.
 * @param nodes - current model-visible surface sequences.
 * @param anchor - first replaced node (inclusive); the group's surface anchor.
 * @param endSeq - last replaced node (inclusive).
 * @returns every shadowed surface seq, for the replacement's cited sources.
 * @throws {RemoteError} kind `revert-invalid` when the range or its coverage is invalid.
 */
function assertIterationRestorePlan(
  sessionId: SessionId,
  nodes: readonly SessionSeq[],
  anchor: SessionSeq,
  endSeq: SessionSeq,
): readonly SessionSeq[] {
  const startIdx = nodes.indexOf(anchor)
  if (startIdx === -1) {
    throw new RemoteError('revert-invalid', `iteration restore anchor ${String(anchor)} is not a surface node`, { sessionId, atSeq: anchor })
  }
  const endIdx = nodes.indexOf(endSeq)
  if (endIdx === -1 || endIdx < startIdx) {
    throw new RemoteError('revert-invalid', `iteration restore end ${String(endSeq)} is not a surface node after the anchor`, { sessionId, atSeq: endSeq })
  }
  const shadowed = nodes.slice(startIdx, endIdx + 1)
  const sources = new Set(shadowed)
  if (sources.size !== shadowed.length) {
    throw new RemoteError('revert-invalid', 'iteration restore plan contains duplicate surface seqs', { sessionId, atSeq: anchor })
  }
  return shadowed
}

/** Bounded preview fields of one iteration variant event. */
function iterationPreviewOf(event: SessionEvent | undefined): {
  text?: string
  attachmentIds?: string[]
} {
  if (event === undefined || event.type !== 'user/message') return {}
  const parts: string[] = []
  const attachmentIds: string[] = []
  for (const block of event.data.content) {
    if (typeof block === 'string') {
      parts.push(block)
      continue
    }
    if (block.type === 'text') {
      parts.push(block.text)
      continue
    }
    if (block.type === 'image' || block.type === 'file') {
      attachmentIds.push(String(block.attachment.attachmentId))
    }
  }
  const text = parts.join('\n')
  const capped = truncateUnicodeCodePoints(text, ITERATION_PREVIEW_MAX_CODE_POINTS)
  return {
    ...capped.length === 0 ? {} : { text: capped },
    ...attachmentIds.length === 0 ? {} : { attachmentIds },
  }
}

/** The append-boundary validator `Session.surface` exposes behind its readonly interface. */
interface SurfaceBranchValidator {
  validateNext(event: SessionEvent): void
}

/**
 * Resolve the iteration group a revert commit belongs to. A known variant
 * resolves through the folded index; a revert anchored at a compaction
 * checkpoint resolves through the variants the checkpoint cites, so the chain
 * continues in the original group instead of minting a group keyed by the
 * checkpoint seq. An unknown anchor keeps today's behavior (it opens the
 * group).
 */
function resolveCommitIterationChain(
  session: Session,
  index: IterationFoldState,
  anchorSeq: number,
): { readonly groupAnchor: number; readonly previousSeq: number } {
  const direct = iterationAnchorOf(index, anchorSeq)
  if (direct !== undefined) return { groupAnchor: direct, previousSeq: anchorSeq }
  // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
  const event = session.eventAt(SessionSeq(anchorSeq))
  if (event?.type === 'user/message') {
    // The compaction plugin owns this source kind; read it structurally.
    const kind: string = event.data.source.kind
    if (kind === 'compact-checkpoint') {
      const resolved = resolveIterationCheckpointAnchor(index, event.sourceEventSeqs)
      if (resolved !== undefined) return resolved
    }
  }
  return { groupAnchor: anchorSeq, previousSeq: anchorSeq }
}

/**
 * Wait for the Agent to reach quiescence, bounded. The timer is cleared on
 * both outcomes; `false` means the bound elapsed first.
 */
async function awaitAgentIdle(agent: Agent, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      agent.whenIdle().then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => { resolve(false) }, timeoutMs)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/** Validate a revert anchor: an active surface node that is a user message. */
function revertAnchorOf(session: Session, seq: number): SessionEvent<'user/message'> | undefined {
  // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
  const event = session.eventAt(SessionSeq(seq))
  if (event === undefined || event.type !== 'user/message') return undefined
  return event
}

function rejectFailure(error: { readonly code: RemoteErrorCode; readonly message: string; readonly details: object }): never {
  throw new RemoteError(error.code, error.message, error.details)
}

function reject(code: RemoteErrorCode, message: string, details: object): never {
  throw new RemoteError(code, message, details)
}

function resolvePromptFileReceipts(
  content: SessionPromptRequest['content'],
  stagedFile: (receiptId: FileUploadReceiptId) => FileAttachmentRef | undefined,
): { readonly content: AttachmentAdmissionPart[]; readonly receiptIds: readonly FileUploadReceiptId[] } {
  const receiptIds = new Set<FileUploadReceiptId>()
  const resolved = content.map((part): AttachmentAdmissionPart => {
    if (part.type !== 'file') return part
    const attachment = stagedFile(part.receiptId)
    if (attachment === undefined) {
      throw new RemoteError(
        'session/attachment-invalid',
        'File was not uploaded for this session.',
        { reason: 'FILE_NOT_STAGED' },
      )
    }
    receiptIds.add(part.receiptId)
    return { type: 'file', attachment }
  })
  return { content: resolved, receiptIds: [...receiptIds] }
}
