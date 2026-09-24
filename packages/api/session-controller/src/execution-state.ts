/**
 * Host-published execution latch and Session digest (doc 69 §8 correction 3,
 * §9.1; doc 70 §4).
 *
 * {@link SessionExecutionStateReader} answers `session.executionState` and
 * `session.digest` from read-only live state: the live Agent registry for
 * descendants (quiet children included), the process-local question waterfall
 * for pending questions, the durable `executionState` projection for the open
 * turn, its terminal, pending approvals, and the last attributed action, and
 * the live Session's bounded tail for the digest's tool/injection views. No
 * call rewrites a log or appends an event.
 *
 * @module @deepseek-ai/dsh-api-session-controller/execution-state
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type { ParticipantTag } from '@deepseek-ai/dsh-llm'
import { carrierKeyOf } from '@deepseek-ai/dsh-scope'
import type { ScopeKey } from '@deepseek-ai/dsh-scope'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-subagent'
import type { SubagentRunEndInfo, SubagentRunId, SubagentRunInfo } from '@deepseek-ai/dsh-subagent'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { z } from 'zod'
import type {
  ExecutionStateProjectionState,
  SessionDigestInjection,
  SessionDigestRequest,
  SessionDigestSubagent,
  SessionDigestToolCall,
  SessionDigestValue,
  SessionExecutionStateValue,
  SessionLatch,
  SessionModelSelection,
  SessionParticipantAction,
  SessionPendingApproval,
  SessionPendingAsk,
  SessionQuestionItem,
  SessionTurnTerminal,
} from './types.ts'

/** Bounded reverse window the digest scans for tool traffic, injections, and the spawn catalog. */
const DIGEST_SCAN_EVENTS = 1000

/** Bounded prefix of a live child session the digest reads for its descriptor and first prompt. */
const CHILD_PREFIX_EVENTS = 128

/** Bounded child rows in one digest tree. */
const DIGEST_TREE_LIMIT = 50

/** Bounded injections in one digest index. */
const DIGEST_INJECTION_LIMIT = 16

/** Bounded displayed preview length for every digest text field. */
const PREVIEW_CHARS = 200

/** Bounded displayed label length for one injection row. */
const LABEL_CHARS = 80

/** Maximum `recentTools` a digest caller may request. */
const DIGEST_TOOLS_LIMIT = 50

/** Default `recentTools` when the request omits it. */
const DIGEST_TOOLS_DEFAULT = 10

const participantTagSchema = z.object({
  kind: z.enum(['human', 'peer']),
  name: z.string().min(1),
  device: z.string().min(1).optional(),
}) as unknown as z.ZodType<ParticipantTag>

const turnErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  provider: z.string().optional(),
  model: z.string().optional(),
})

const turnTerminalSchema = z.object({
  turn: z.number(),
  reason: z.string(),
  at: z.number(),
  error: turnErrorSchema.optional(),
}) as unknown as z.ZodType<SessionTurnTerminal>

const participantActionSchema = z.object({
  action: z.enum(['prompt', 'cancel']),
  actor: participantTagSchema,
  at: z.number(),
}) as unknown as z.ZodType<SessionParticipantAction>

const pendingApprovalSchema = z.object({
  askId: z.string(),
  toolName: z.string(),
  callId: z.string().optional(),
  reason: z.string().optional(),
  since: z.number(),
}) as unknown as z.ZodType<SessionPendingApproval>

const executionStateProjectionStateSchema = z.object({
  openTurn: z.number().nullable(),
  openTurnSince: z.number().nullable(),
  lastTurnEnd: turnTerminalSchema.nullable(),
  lastParticipantAction: participantActionSchema.nullable(),
  pendingApprovals: z.array(pendingApprovalSchema),
}) as unknown as z.ZodType<ExecutionStateProjectionState>

/** Local browser prompt or cancel with no participant tag: attributed to this device's human. */
const LOCAL_HUMAN: ParticipantTag = Object.freeze({ kind: 'human', name: 'local' })

/**
 * Advance durable execution-latch facts by one committed event. Unrelated
 * events return the same state reference.
 * @param state - latch facts before the event.
 * @param event - next committed Session event.
 * @returns the original or advanced facts.
 */
function applyExecutionStateProjection(
  state: ExecutionStateProjectionState,
  event: SessionEvent,
): ExecutionStateProjectionState {
  switch (event.type) {
    case 'turn/start':
      return {
        ...state,
        openTurn: event.data.turn,
        openTurnSince: event.time,
        // An approval or question ask is turn-scoped: a new turn cannot start
        // while one is awaited, so any surviving record is crash residue.
        pendingApprovals: [],
      }
    case 'turn/end': {
      const reason = event.data.reason
      const failure = reason.kind === 'error' || reason.kind === 'aborted' ? reason.error : undefined
      const terminal: SessionTurnTerminal = {
        turn: event.data.turn,
        reason: reason.kind,
        at: event.time,
        ...failure === undefined ? {} : {
          error: {
            code: failure.code,
            message: failure.message,
            ...failure.provider === undefined ? {} : { provider: failure.provider },
            ...failure.model === undefined ? {} : { model: failure.model },
          },
        },
      }
      const cancelAction: SessionParticipantAction | undefined =
        reason.kind === 'aborted' && reason.reason.kind === 'user'
          ? { action: 'cancel', actor: reason.reason.participant ?? LOCAL_HUMAN, at: event.time }
          : undefined
      return {
        ...state,
        openTurn: null,
        openTurnSince: null,
        lastTurnEnd: terminal,
        // The audit pair is turn-enclosed, so an end closes every approval ask
        // the turn could have opened (a crash tail leaves only residue).
        pendingApprovals: [],
        ...cancelAction === undefined ? {} : { lastParticipantAction: cancelAction },
      }
    }
    case 'approval/asked': {
      if (state.pendingApprovals.some(ask => ask.askId === event.data.id)) return state
      return {
        ...state,
        pendingApprovals: [...state.pendingApprovals, {
          askId: event.data.id,
          toolName: event.data.toolName,
          ...event.data.callId === undefined ? {} : { callId: event.data.callId },
          ...event.data.reason === undefined ? {} : { reason: event.data.reason },
          since: event.time,
        }],
      }
    }
    case 'approval/decided': {
      const next = state.pendingApprovals.filter(ask => ask.askId !== event.data.id)
      return next.length === state.pendingApprovals.length ? state : { ...state, pendingApprovals: next }
    }
    case 'user/message': {
      const source = event.data.source
      if (source.kind !== 'user') return state
      return {
        ...state,
        lastParticipantAction: {
          action: 'prompt',
          actor: source.participant ?? LOCAL_HUMAN,
          at: event.time,
        },
      }
    }
    default:
      return state
  }
}

/** Durable execution-latch projection unit, registered on the Session Controller's context. */
export const executionStateProjectionDefinition = {
  key: 'executionState',
  stateSchema: executionStateProjectionStateSchema,
  init: (): ExecutionStateProjectionState => ({
    openTurn: null,
    openTurnSince: null,
    lastTurnEnd: null,
    lastParticipantAction: null,
    pendingApprovals: [],
  }),
  apply: applyExecutionStateProjection,
  stateVersion: 1,
} satisfies ProjectionDefinition<'executionState', ExecutionStateProjectionState>

/**
 * Register the durable execution-latch projection.
 * @param ctx - Session Controller context carrying the projection registry.
 */
export function installExecutionStateProjection(ctx: Context): void {
  ctx.sessionProjections.register(executionStateProjectionDefinition)
}

/** One in-flight question request tracked from the answerer waterfall. */
interface PendingQuestionRecord {
  readonly askId: string
  readonly sessionId: SessionId | undefined
  readonly questions: readonly SessionQuestionItem[]
  readonly since: number
}

/** Structural face of one question request; the seam is consumed through `ctx.get`. */
interface QuestionRequestFace {
  readonly questions: readonly SessionQuestionItem[]
  readonly agent?: { readonly id: SessionId; readonly session: { readonly id: SessionId } } | undefined
}

/**
 * The merge-extensible user-questions waterfall event is not part of this
 * package's compilation face, so the one listener that tracks pending
 * questions reaches it through this minimal structural bus.
 */
interface QuestionWaterfallBus {
  on(
    name: 'user-questions/request',
    listener: (request: QuestionRequestFace, next: () => Promise<unknown>) => Promise<unknown>,
    options: { readonly prepend: true },
  ): () => void
}

/** One active subagent run, from the lifecycle start/end pair. */
interface ActiveRunRecord {
  readonly childId: SessionId
  readonly parentId: SessionId | undefined
}

/** One tool-call row collected by the bounded reverse scan. */
interface ScannedToolCall {
  readonly seq: number
  readonly name: string
  readonly argumentPreview?: string
}

/** One tool-result row collected by the bounded reverse scan. */
interface ScannedToolResult {
  readonly seq: number
  readonly callId: string
  readonly status: 'ok' | 'error'
  readonly error?: SessionDigestToolCall['error']
  readonly resultPreview?: string
}

/** One parent-owned spawn catalog row collected by the bounded reverse scan. */
interface ScannedCatalogEntry {
  readonly childId: SessionId
  readonly mode: 'one-shot' | 'continuable'
  readonly label?: string
}

/** Everything the digest's one bounded reverse pass collects. */
interface ScannedTail {
  readonly calls: Map<string, ScannedToolCall>
  readonly results: readonly ScannedToolResult[]
  /** Every call id with a result inside the scan window, including rows past the tool budget. */
  readonly answered: ReadonlySet<string>
  readonly injections: readonly SessionDigestInjection[]
  readonly catalog: readonly ScannedCatalogEntry[]
}

/**
 * Read-only host latch and digest owner. One instance per Session Controller;
 * it registers the `subagent/start`/`end` and question-waterfall listeners as
 * effects of that context.
 */
export class SessionExecutionStateReader {
  private readonly pendingQuestions = new Map<string, PendingQuestionRecord>()
  private readonly activeRuns = new Map<SubagentRunId, ActiveRunRecord>()

  /** @param ctx - Session Controller context with agents, sessions, projections, and the model default. */
  constructor(private readonly ctx: Context) {
    const activeRuns = this.activeRuns
    ctx.on('subagent/start', function (info: SubagentRunInfo): void {
      activeRuns.set(info.runId, { childId: info.id, parentId: agentIdOf(carrierKeyOf(this)) })
    })
    ctx.on('subagent/end', function (info: SubagentRunEndInfo): void {
      activeRuns.delete(info.runId)
    })
    const bus = ctx as unknown as QuestionWaterfallBus
    const pendingQuestions = this.pendingQuestions
    ctx.effect(
      () => bus.on(
        'user-questions/request',
        (request, next) => trackQuestion(pendingQuestions, request, next),
        { prepend: true },
      ),
      'session-controller: pending question tracking',
    )
  }

  /**
   * Read the aggregate execution latch for one attached Session.
   * @param sessionId - attached Session identity.
   * @returns the host latch value.
   * @throws {RemoteError} `session/not-found` when no live Session owns the id.
   */
  executionState(sessionId: SessionId): SessionExecutionStateValue {
    const session = this.requireAttached(sessionId)
    const projection = this.requireProjection(session)
    const { ids, exact } = this.descendants(sessionId)
    const pendingAsks = this.pendingAsks(sessionId, projection, ids)
    const turnOpen = this.turnOpen(sessionId)
    const latch: SessionLatch = pendingAsks.length > 0
      ? 'waiting_approval'
      : turnOpen
        ? ids.size > 0 ? 'waiting_subagents' : 'running'
        : 'idle'
    const since = pendingAsks.length > 0
      ? Math.min(...pendingAsks.map(ask => ask.since))
      : turnOpen
        ? projection.openTurnSince ?? this.lastEventTime(session)
        : projection.lastTurnEnd?.at ?? 0
    const model = this.modelOf(session)
    return {
      latch,
      since,
      source: 'host-latch',
      activeDescendants: ids.size,
      descendantsExact: exact,
      pendingAsks,
      ...projection.lastTurnEnd === null ? {} : { lastTurnEnd: projection.lastTurnEnd },
      ...projection.lastParticipantAction === null ? {} : { lastParticipantAction: projection.lastParticipantAction },
      ...model === undefined ? {} : { model },
    }
  }

  /**
   * Read the one-call debug digest for one attached Session.
   * @param request - Session identity and the recent-tool-call budget.
   * @returns latch, model, attribution, recent tool traffic, injections, tree, and pending asks.
   * @throws {RemoteError} `session/not-found` when no live Session owns the id.
   */
  digest(request: SessionDigestRequest): SessionDigestValue {
    const sessionId = request.sessionId
    const session = this.requireAttached(sessionId)
    const state = this.executionState(sessionId)
    const maxTools = clampRecentTools(request.recentTools)
    const { ids } = this.descendants(sessionId)
    const tail = this.scanTail(session, maxTools)
    return {
      sessionId,
      state,
      ...state.model === undefined ? {} : { model: state.model },
      ...state.lastParticipantAction === undefined ? {} : { lastParticipantAction: state.lastParticipantAction },
      recentToolCalls: this.recentToolCalls(tail, maxTools),
      injectionIndex: tail.injections,
      subagentTree: this.subagentTree(tail.catalog, ids),
      pendingInteractions: state.pendingAsks,
    }
  }

  /** Attach + live-registry check for one addressed Session. */
  private requireAttached(sessionId: SessionId): Session {
    const session = this.ctx.sessions.get(sessionId)
    if (session === undefined) {
      throw new RemoteError(
        'session/not-found',
        `session "${sessionId}" not found (not attached)`,
        { sessionId },
      )
    }
    return session
  }

  /** The durable latch projection for one attached Session. */
  private requireProjection(session: Session): ExecutionStateProjectionState {
    const state = this.ctx.sessionProjections.stateOf(session, 'executionState')
    if (state === undefined) {
      throw new RemoteError(
        'gateway/internal',
        'session execution-state projection is not registered',
        {},
      )
    }
    return state
  }

  /** Whether the live driver currently owns an open turn. */
  private turnOpen(sessionId: SessionId): boolean {
    return this.ctx.agents.get(sessionId)?.status === 'running'
  }

  /** Most recent committed event time, used when the durable turn start is unavailable. */
  private lastEventTime(session: Session): number {
    const last = Number(session.seq) - 1
    if (last < 0) return 0
    // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
    return session.eventAt(SessionSeq(last))?.time ?? 0
  }

  /**
   * Approval asks of this Session and its visible descendants, plus pending
   * questions attributed to it, oldest first.
   */
  private pendingAsks(
    sessionId: SessionId,
    projection: ExecutionStateProjectionState,
    visibleDescendants: ReadonlySet<SessionId>,
  ): readonly SessionPendingAsk[] {
    const asks: SessionPendingAsk[] = []
    const scopes = new Set<SessionId>([sessionId, ...visibleDescendants])
    for (const id of scopes) {
      const session = this.ctx.sessions.get(id)
      if (session === undefined) continue
      const state = id === sessionId ? projection : this.ctx.sessionProjections.stateOf(session, 'executionState')
      if (state === undefined) continue
      for (const ask of state.pendingApprovals) {
        asks.push({
          kind: 'approval',
          askId: ask.askId,
          toolName: ask.toolName,
          ...ask.callId === undefined ? {} : { callId: ask.callId },
          ...ask.reason === undefined ? {} : { reason: ask.reason },
          since: ask.since,
        })
      }
    }
    for (const question of this.pendingQuestions.values()) {
      if (question.sessionId === undefined) continue
      if (this.rootOf(question.sessionId) !== sessionId) continue
      asks.push({
        kind: 'question',
        askId: question.askId,
        questions: question.questions,
        since: question.since,
      })
    }
    return asks.sort((left, right) => left.since - right.since)
  }

  /** The Session's current selection: durable selection first, deployment default last. */
  private modelOf(session: Session): SessionModelSelection | undefined {
    const state = this.ctx.sessionProjections.stateOf(session, 'modelSelection')
    const picked = state === undefined ? undefined : state.pending ?? state.lastUsed ?? undefined
    if (picked !== undefined) return selectionOf(picked)
    return selectionOf(this.ctx.agentDefaultModel.currentSelection())
  }

  /**
   * Live descendants: every *working* Agent whose durable parent chain reaches
   * this Session, plus every active subagent run whose delegating parent does.
   * A resident-but-idle child (parked between turns, or a child that finished
   * earlier) does not hold the latch: counting it would pin every parent that
   * ever spawned one to `waiting_subagents`. Quiet children work like any
   * other, so a working quiet child counts; `exact` is false when any
   * candidate's chain cannot be resolved here.
   */
  private descendants(sessionId: SessionId): { ids: ReadonlySet<SessionId>; exact: boolean } {
    const ids = new Set<SessionId>()
    let exact = true
    for (const agent of this.ctx.agents.list()) {
      if (agent.id === sessionId) continue
      const root = this.rootOf(agent.id)
      if (root === undefined) {
        exact = false
        continue
      }
      if (root === sessionId && agent.status === 'running') ids.add(agent.id)
    }
    for (const run of this.activeRuns.values()) {
      if (run.childId === sessionId || ids.has(run.childId)) continue
      const parentId = run.parentId
      if (parentId === undefined) {
        exact = false
        continue
      }
      const root = this.rootOf(parentId)
      if (root === undefined) {
        exact = false
        continue
      }
      if (root === sessionId) ids.add(run.childId)
    }
    return { ids, exact }
  }

  /**
   * The root Session of one live or attached identity, walking durable
   * parent links. Returns undefined when a link leaves this host's view.
   */
  private rootOf(sessionId: SessionId): SessionId | undefined {
    let current = sessionId
    const seen = new Set<SessionId>([current])
    while (true) {
      const header = this.ctx.agents.get(current)?.session.header ?? this.ctx.sessions.get(current)?.header
      if (header === undefined) return undefined
      const parent = header.parentSession
      if (parent === undefined) return current
      if (seen.has(parent)) return undefined
      seen.add(parent)
      current = parent
    }
  }

  /** One bounded reverse pass over the Session tail. */
  private scanTail(session: Session, maxTools: number): ScannedTail {
    const calls = new Map<string, ScannedToolCall>()
    const results: ScannedToolResult[] = []
    const answered = new Set<string>()
    const injections: SessionDigestInjection[] = []
    const catalog = new Map<SessionId, ScannedCatalogEntry>()
    const end = Number(session.seq) - 1
    const floor = Math.max(0, end - DIGEST_SCAN_EVENTS + 1)
    for (let seq = end; seq >= floor; seq -= 1) {
      // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
      const event = session.eventAt(SessionSeq(seq))
      if (event === undefined) continue
      switch (event.type) {
        case 'tool/call': {
          const argumentPreview = preview(event.data.arguments)
          calls.set(event.data.callId, {
            seq,
            name: event.data.name,
            ...argumentPreview === undefined ? {} : { argumentPreview },
          })
          break
        }
        case 'tool/result': {
          const block = event.data.message.content[0]
          // Mark every witnessed result, even past the row budget: a call with
          // a result must never be reported as still running.
          answered.add(block.toolCallId)
          if (results.length >= maxTools) break
          const resultPreview = preview(messageText(block))
          results.push({
            seq,
            callId: block.toolCallId,
            status: block.isError === true ? 'error' : 'ok',
            ...event.data.error === undefined ? {} : { error: { ...event.data.error } },
            ...resultPreview === undefined ? {} : { resultPreview },
          })
          break
        }
        case 'user/message': {
          const source = event.data.source
          if (source.kind !== 'plugin' || injections.length >= DIGEST_INJECTION_LIMIT) break
          const label = injectionLabel(source)
          injections.push({
            kind: source.plugin,
            ...label === undefined ? {} : { label },
            chars: messageChars(event.data),
            seq,
          })
          break
        }
        case 'subagent/catalog': {
          if (catalog.size >= DIGEST_TREE_LIMIT) break
          catalog.set(event.data.childId, {
            childId: event.data.childId,
            mode: event.data.mode,
            ...event.data.label === undefined ? {} : { label: event.data.label },
          })
          break
        }
        default:
          break
      }
    }
    return {
      calls,
      results,
      answered,
      injections: injections.reverse(),
      catalog: [...catalog.values()].reverse(),
    }
  }

  /** Assemble the newest-first recent tool calls from one scan. */
  private recentToolCalls(tail: ScannedTail, maxTools: number): readonly SessionDigestToolCall[] {
    const rows: { seq: number; call: SessionDigestToolCall }[] = []
    for (const result of tail.results) {
      const call = tail.calls.get(result.callId)
      rows.push({
        seq: result.seq,
        call: {
          tool: call?.name ?? 'unknown',
          status: result.status,
          ...result.error === undefined ? {} : { error: result.error },
          ...call?.argumentPreview === undefined ? {} : { argumentPreview: call.argumentPreview },
          ...result.resultPreview === undefined ? {} : { resultPreview: result.resultPreview },
        },
      })
    }
    for (const [callId, call] of tail.calls) {
      if (tail.answered.has(callId)) continue
      rows.push({
        seq: call.seq,
        call: {
          tool: call.name,
          status: 'running',
          ...call.argumentPreview === undefined ? {} : { argumentPreview: call.argumentPreview },
        },
      })
    }
    return rows
      .sort((left, right) => right.seq - left.seq)
      .slice(0, maxTools)
      .map(row => row.call)
  }

  /** Merge the durable spawn catalog with visible live/tracked children. */
  private subagentTree(
    catalog: readonly ScannedCatalogEntry[],
    visible: ReadonlySet<SessionId>,
  ): readonly SessionDigestSubagent[] {
    const rows = new Map<SessionId, SessionDigestSubagent>()
    for (const entry of catalog) {
      const queryPreview = entry.label === undefined ? undefined : preview(entry.label)
      rows.set(entry.childId, {
        childSessionId: entry.childId,
        mode: entry.mode,
        quiet: false,
        status: this.childStatus(entry.childId),
        ...queryPreview === undefined ? {} : { queryPreview },
      })
    }
    for (const childId of visible) {
      if (rows.has(childId)) continue
      rows.set(childId, {
        childSessionId: childId,
        mode: 'unknown',
        quiet: false,
        status: this.childStatus(childId),
      })
    }
    const tree: SessionDigestSubagent[] = []
    for (const [childId, row] of rows) {
      tree.push({ ...row, ...this.childFacts(childId) })
      if (tree.length >= DIGEST_TREE_LIMIT) break
    }
    return tree
  }

  /** Live status of one child identity. */
  private childStatus(childId: SessionId): SessionDigestSubagent['status'] {
    const agent = this.ctx.agents.get(childId)
    if (agent !== undefined) return agent.status === 'running' ? 'running' : 'idle'
    for (const run of this.activeRuns.values()) {
      if (run.childId === childId) return 'running'
    }
    return 'inactive'
  }

  /** Descriptor mode/quiet and first prompt of one live child, from a bounded prefix. */
  private childFacts(childId: SessionId): Partial<SessionDigestSubagent> {
    const session = this.ctx.sessions.get(childId)
    if (session === undefined) return {}
    const start = Number(session.inheritedEventCount)
    const end = Math.min(Number(session.seq) - 1, start + CHILD_PREFIX_EVENTS - 1)
    let mode: SessionDigestSubagent['mode'] | undefined
    let quiet: boolean | undefined
    let prompt: string | undefined
    for (let seq = start; seq <= end; seq += 1) {
      // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
      const event = session.eventAt(SessionSeq(seq))
      if (event === undefined) continue
      if (event.type === 'subagent/descriptor') {
        mode = event.data.mode
        if (event.data.mode === 'continuable' && event.data.quiet !== undefined) quiet = event.data.quiet
        continue
      }
      if (prompt === undefined && event.type === 'user/message' && event.data.source.kind === 'user') {
        prompt = preview(messageText(event.data))
      }
    }
    return {
      ...mode === undefined ? {} : { mode },
      ...quiet === undefined ? {} : { quiet },
      ...prompt === undefined ? {} : { queryPreview: prompt },
    }
  }
}

/** Admit one question request into the pending set, clearing it on settlement. */
function trackQuestion(
  pending: Map<string, PendingQuestionRecord>,
  request: QuestionRequestFace,
  next: () => Promise<unknown>,
): Promise<unknown> {
  const settled = next()
  const sessionId = request.agent?.session.id ?? request.agent?.id
  if (sessionId === undefined) return settled
  const askId = `question-${randomUUID()}`
  pending.set(askId, {
    askId,
    sessionId,
    questions: request.questions,
    since: Date.now(),
  })
  const retire = (): void => { pending.delete(askId) }
  void settled.then(retire, retire)
  return settled
}

/** Branded Session id from a carrier key, when the key is an Agent. */
function agentIdOf(value: ScopeKey | undefined): SessionId | undefined {
  const carrier: { readonly id?: unknown } | undefined = value
  const id = carrier?.id
  return typeof id === 'string' && id.length > 0 ? brandString<SessionId>(id) : undefined
}

/** Clamp one `recentTools` request into the digest's supported window. */
function clampRecentTools(requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested)) return DIGEST_TOOLS_DEFAULT
  return Math.max(0, Math.min(DIGEST_TOOLS_LIMIT, Math.trunc(requested)))
}

/** Truncate one display preview to the digest bound. */
function preview(value: string): string | undefined {
  if (value.length === 0) return undefined
  return value.length <= PREVIEW_CHARS ? value : `${value.slice(0, PREVIEW_CHARS - 1)}…`
}

/**
 * Concatenated text of one message-like value's text blocks.
 * @param value - message data or a tool-result block carrying model content.
 * @returns the joined text of every `text` block.
 */
function messageText(value: { readonly content: readonly { readonly type: string }[] }): string {
  return value.content
    .flatMap(block => block.type === 'text' && 'text' in block && typeof block.text === 'string'
      ? [block.text]
      : [])
    .join('\n')
}

/**
 * UTF-16 length of one user message's text content.
 * @param value - user message event data.
 * @returns the character count of its text blocks.
 */
function messageChars(value: { readonly content: readonly { readonly type: string }[] }): number {
  return messageText(value).length
}

/**
 * Display label of one injected plugin message.
 * @param source - plugin source of a logged `user/message`.
 * @returns bounded section names, notice summary, or the declared form.
 */
function injectionLabel(source: {
  readonly plugin: string
  readonly form?: string
  readonly sections?: readonly { readonly name: string }[]
  readonly summary?: string
}): string | undefined {
  if (source.form === 'snapshot') {
    const names = (source.sections ?? []).map(section => section.name).join(', ')
    return names.length === 0 ? undefined : bound(names, LABEL_CHARS)
  }
  if (source.form === 'notice') {
    const summary = source.summary ?? ''
    return summary.length === 0 ? undefined : bound(summary, LABEL_CHARS)
  }
  return source.form
}

/**
 * Map one stored selection into the latch's provider/model/chain view.
 * @param selection - durable or deployment-default selection.
 * @returns the provider/model/chain subset the latch publishes.
 */
function selectionOf(selection: { readonly provider: string; readonly model: string; readonly chain?: string }): SessionModelSelection {
  return {
    provider: selection.provider,
    model: selection.model,
    ...selection.chain === undefined ? {} : { chain: selection.chain },
  }
}

/**
 * Truncate one display string to a fixed bound.
 * @param value - display string of any length.
 * @param limit - maximum UTF-16 code units to keep.
 * @returns the string, ellipsized when it exceeds the limit.
 */
function bound(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`
}
