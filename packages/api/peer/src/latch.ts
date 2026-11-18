/**
 * Derived execution-latch fold over a Session's durable event stream.
 *
 * Doc 69 §8 correction 3 requires one authoritative aggregate state. Until the
 * host publishes that latch as a projection (`readHostLatch` consumes it when
 * present), the peer host folds it from `turn/*`, `approval/*`,
 * `subagent/catalog`, and settlement notices; quiet children make descendant
 * liveness unprovable, which `descendantsExact` reports.
 *
 * @module @deepseek-ai/dsh-api-peer/latch
 */

import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {
  PeerActor,
  PeerExecutionState,
  PeerLatch,
  PeerModelHopData,
  PeerModelHopReason,
  PeerModelSelection,
  PeerParticipant,
  PeerPendingAsk,
  PeerTokenUsage,
  PeerTurnError,
  PeerTurnModelReport,
  PeerTurnTerminal,
} from './types.ts'

/** Minimal structural event the fold consumes; a durable Session event satisfies it. */
export interface PeerFoldEvent {
  readonly type: string
  readonly seq: number
  readonly time: number
  readonly data: unknown
}

/** Latch fields a host-published execution-state projection may carry. */
export interface HostLatchFacts {
  readonly latch: PeerLatch
  readonly activeDescendants: number
  readonly descendantsExact: boolean
  readonly since?: number
  readonly lastTurnEnd?: PeerTurnTerminal
  readonly model?: PeerModelSelection
  readonly lastParticipantAction?: PeerExecutionState['lastParticipantAction']
}

const LATCH_VALUES: readonly PeerLatch[] = ['running', 'waiting_approval', 'waiting_subagents', 'idle']

/**
 * Cap on the recent chain-hop window the fold retains. The wire state needs
 * only the newest hops of the current rolling run; older hops stay available
 * as durable `model-hop` stream records and through `peer.page`, and the fold
 * never holds a whole Session log to serve them.
 */
export const RECENT_MODEL_HOPS_LIMIT = 32

/**
 * Durable cancel-cause reason the host's ceiling watcher writes when it stops
 * a running turn. The Agent's `hook` cancel cause and its string `reason`
 * already exist in the session format, so the marker is a durable record that
 * older builds parse without a `SESSION_FORMAT_VERSION` bump.
 */
export const PEER_BUDGET_STOP_REASON = 'peer/budget'

/**
 * Read a host-published execution latch from projection values when one
 * exists (doc 69 §8 correction 3, digest work). Accepts the plan's snake_case
 * `active_descendants` and the JS `activeDescendants` spelling.
 * @param projections - projection values at one observation cut.
 * @returns host latch facts, or `undefined` when no compatible projection is mounted.
 */
export function readHostLatch(
  projections: Readonly<Record<string, unknown>> | undefined,
): HostLatchFacts | undefined {
  if (projections === undefined) return undefined
  const candidate = projections.executionState ?? projections.peerExecutionState
  if (!isRecord(candidate)) return undefined
  return hostLatchFactsOf(candidate)
}

/**
 * Read the host latch from a `session.executionState` response (doc 70 §10 D2).
 * The peer consumes the host's projection structurally: any value that does not
 * carry a valid latch and descendant count is ignored so the derived fold
 * stays in charge, and the peer never imports the Session Controller's type.
 * @param value - untyped `session.executionState` response value.
 * @returns host latch facts, or `undefined` when the value is not a host latch.
 */
export function readExecutionStateValue(value: unknown): HostLatchFacts | undefined {
  if (!isRecord(value)) return undefined
  return hostLatchFactsOf(value)
}

/** Validate and project the fields both host-latch carriers share. */
function hostLatchFactsOf(candidate: Record<string, unknown>): HostLatchFacts | undefined {
  const latch = candidate.latch
  if (typeof latch !== 'string' || !LATCH_VALUES.includes(latch as PeerLatch)) return undefined
  const descendants = candidate.activeDescendants ?? candidate.active_descendants
  if (typeof descendants !== 'number' || !Number.isSafeInteger(descendants) || descendants < 0) return undefined
  const exact = candidate.descendantsExact ?? candidate.descendants_exact
  const since = candidate.since
  const lastTurnEnd = parseTurnTerminal(candidate.lastTurnEnd)
  const model = parseModelSelection(candidate.model)
  const lastParticipantAction = parseParticipantAction(candidate.lastParticipantAction)
  return {
    latch: latch as PeerLatch,
    activeDescendants: descendants,
    descendantsExact: typeof exact === 'boolean' ? exact : false,
    ...typeof since === 'number' ? { since } : {},
    ...lastTurnEnd === undefined ? {} : { lastTurnEnd },
    ...model === undefined ? {} : { model },
    ...lastParticipantAction === undefined ? {} : { lastParticipantAction },
  }
}

/**
 * Read the current model selection from the durable `modelSelection`
 * projection (doc 69 §10.3). The projection's wire view publishes
 * `{ lastUsed, next }`, where `next` is already `pending ?? lastUsed`; the
 * fold therefore prefers `next` and only falls back to a raw projection state
 * (`pending` before `lastUsed`) for hosts that publish state instead of the
 * view.
 * @param projections - projection values at one observation cut.
 * @returns the effective selection, or `undefined` when the projection is absent.
 */
export function readModelSelectionProjection(
  projections: Readonly<Record<string, unknown>> | undefined,
): PeerModelSelection | undefined {
  const candidate = projections?.modelSelection
  if (!isRecord(candidate)) return undefined
  const pick = isRecord(candidate.next)
    ? candidate.next
    : isRecord(candidate.pending) ? candidate.pending : candidate.lastUsed
  return parseModelSelection(pick)
}

/** Mutable fold state; one instance tracks one Session. */
export class PeerLatchFold {
  private readonly pendingApprovals = new Map<string, { toolName: string; callId?: string; reason?: string; since: number }>()
  private readonly catalog = new Map<SessionId, { spawnSeq: number; createdAt: number; quietKnown: boolean }>()
  private readonly settledChildren = new Set<SessionId>()
  private openTurn: number | undefined
  private openTurnStartSeq: number | undefined
  /** Failed routes seen since this turn opened; attributed by log position. */
  private turnHops = 0
  /** Answering route of the newest assistant message in this turn, without the hop count. */
  private turnRan: Omit<PeerTurnModelReport, 'hops'> | undefined
  /** Bounded window of chain hops; oldest first, capped at the newest {@link RECENT_MODEL_HOPS_LIMIT}. */
  private readonly recentHops: PeerModelHopData[] = []
  /** Newest turn whose durable `aborted` terminal carries {@link PEER_BUDGET_STOP_REASON}. */
  private budgetStopTurn: number | undefined
  private lastTurnEnd: PeerTurnTerminal | undefined
  private model: PeerModelSelection | undefined
  private lastHumanAction: PeerExecutionState['lastParticipantAction']
  private lastPeerAction: PeerExecutionState['lastParticipantAction']
  private latch: PeerLatch = 'idle'
  private latchSince = 0
  private lastEventTime = 0

  /**
   * Fold one durable event into the cached state.
   * @param event - durable event in log order.
   */
  apply(event: PeerFoldEvent): void {
    this.lastEventTime = event.time
    switch (event.type) {
      case 'turn/start': {
        const turn = numberField(event.data, 'turn')
        this.turnHops = 0
        this.turnRan = undefined
        if (turn !== undefined) {
          this.openTurn = turn
          this.openTurnStartSeq = event.seq
        }
        this.settledChildren.clear()
        this.pendingApprovals.clear()
        break
      }
      case 'turn/end': {
        const turn = numberField(event.data, 'turn')
        const reason = recordField(event.data, 'reason')
        const kind = reason?.kind
        if (typeof kind === 'string' && turn !== undefined) {
          const error = parseTurnError(recordField(reason, 'error'))
          this.lastTurnEnd = {
            turn,
            reason: kind as PeerTurnTerminal['reason'],
            at: event.time,
            ...(error === undefined ? {} : { error }),
            ...(this.turnRan === undefined ? {} : { ran: { ...this.turnRan, hops: this.turnHops } }),
          }
          if (kind === 'aborted') {
            const cancelReason = recordField(reason, 'reason')
            // The ceiling watcher's stop is the one marker that survives a
            // restart; a human or peer cancel records `kind: 'user'` and is
            // never stamped `stop: 'budget'`.
            if (cancelReason?.kind === 'hook' && cancelReason.reason === PEER_BUDGET_STOP_REASON) {
              this.budgetStopTurn = turn
            }
            if (cancelReason?.kind === 'user') {
              this.lastHumanAction = {
                action: 'cancel',
                actor: participantToActor(recordField(cancelReason, 'participant')) ?? { kind: 'human', name: 'local' },
                at: event.time,
              }
            }
          }
        }
        this.openTurn = undefined
        this.openTurnStartSeq = undefined
        this.turnHops = 0
        this.turnRan = undefined
        this.settledChildren.clear()
        this.pendingApprovals.clear()
        break
      }
      case 'llm/attempt-failed': {
        // A failed attempt carries no turn identity, so the fold attributes it
        // by log position: everything between this turn's start and end.
        if (this.openTurn !== undefined) this.turnHops += 1
        const hop = modelHopOf(event)
        if (hop !== undefined) {
          this.recentHops.push(hop)
          if (this.recentHops.length > RECENT_MODEL_HOPS_LIMIT) {
            this.recentHops.splice(0, this.recentHops.length - RECENT_MODEL_HOPS_LIMIT)
          }
        }
        break
      }
      case 'assistant/message': {
        // Only a message inside the open turn answers it; the newest one is the
        // step that produced the turn's final output.
        if (this.openTurn === undefined) break
        const ran = modelReportOf(event)
        if (ran !== undefined) this.turnRan = ran
        break
      }
      case 'approval/asked': {
        const id = stringField(event.data, 'id')
        if (id !== undefined) {
          const callId = stringField(event.data, 'callId')
          const reason = stringField(event.data, 'reason')
          this.pendingApprovals.set(id, {
            toolName: stringField(event.data, 'toolName') ?? 'unknown',
            ...(callId === undefined ? {} : { callId }),
            ...(reason === undefined ? {} : { reason }),
            since: event.time,
          })
        }
        break
      }
      case 'approval/decided': {
        const id = stringField(event.data, 'id')
        if (id !== undefined) this.pendingApprovals.delete(id)
        break
      }
      case 'subagent/catalog': {
        const childId = stringField(event.data, 'childId')
        if (childId !== undefined) {
          this.catalog.set(childId as SessionId, {
            spawnSeq: event.seq,
            createdAt: numberField(event.data, 'childCreatedAt') ?? event.time,
            quietKnown: false,
          })
        }
        break
      }
      case 'user/message': {
        const source = recordField(event.data, 'source')
        if (source?.kind === 'subagent-settled') {
          const sender = stringField(source, 'senderSessionId')
          if (sender !== undefined) this.settledChildren.add(sender as SessionId)
        }
        if (source?.kind === 'user-rpc' || source?.kind === 'user') {
          const actor = participantToActor(recordField(source, 'participant')) ?? { kind: 'human', name: 'local' }
          if (actor.kind === 'human') this.lastHumanAction = { action: 'prompt', actor, at: event.time }
          else this.lastPeerAction = { action: 'prompt', actor, at: event.time }
        }
        break
      }
      case 'model/selection': {
        const selection = parseModelSelection(event.data)
        if (selection !== undefined) this.model = selection
        break
      }
      default:
        break
    }
  }

  /** Record a host-local peer action; supplemental to the durable participant attribution written into the session log. */
  recordPeerAction(action: PeerExecutionState['lastParticipantAction']): void {
    if (action !== undefined) this.lastPeerAction = action
  }

  /** The number of current-turn catalog children without an observed settlement. */
  activeDescendants(): number {
    if (this.openTurnStartSeq === undefined) return 0
    let active = 0
    for (const [childId, entry] of this.catalog) {
      if (entry.spawnSeq <= this.openTurnStartSeq) continue
      if (this.settledChildren.has(childId)) continue
      active += 1
    }
    return active
  }

  /**
   * Assemble the peer-visible state.
   * @param pendingAsks - asks the host registry currently exposes for this Session.
   * @param hostLatch - host-published latch facts overriding the derived fold.
   * @returns the aggregate execution state; `stop: 'budget'` is stamped only on
   * the turn whose durable `aborted` terminal carries the watcher marker.
   */
  snapshot(
    pendingAsks: readonly PeerPendingAsk[],
    hostLatch?: HostLatchFacts,
  ): PeerExecutionState {
    const activeDescendants = hostLatch?.activeDescendants ?? this.activeDescendants()
    const latch = hostLatch?.latch ?? this.derivedLatch(pendingAsks)
    if (latch !== this.latch) {
      this.latch = latch
      this.latchSince = this.lastEventTime
    }
    const lastTurnEnd = stampBudgetStop(
      mergeTerminalRan(hostLatch?.lastTurnEnd, this.lastTurnEnd),
      this.budgetStopTurn,
    )
    const model = hostLatch?.model ?? this.model
    const lastParticipantAction = this.lastPeerAction ?? hostLatch?.lastParticipantAction ?? this.lastHumanAction
    return {
      latch,
      since: hostLatch?.since ?? (this.latchSince === 0 ? this.lastEventTime : this.latchSince),
      source: hostLatch === undefined ? 'derived' : 'host-latch',
      activeDescendants,
      descendantsExact: hostLatch?.descendantsExact ?? activeDescendants === 0,
      // Only the host ask registry mints answerable ask ids; durable approval
      // ids stay internal to the latch fold.
      pendingAsks: [...pendingAsks],
      ...(lastTurnEnd === undefined ? {} : { lastTurnEnd }),
      ...(lastParticipantAction === undefined ? {} : { lastParticipantAction }),
      ...(model === undefined ? {} : { model }),
      ...(this.recentHops.length === 0 ? {} : { recentModelHops: [...this.recentHops] }),
    }
  }

  private derivedLatch(pendingAsks: readonly PeerPendingAsk[]): PeerLatch {
    if (this.pendingApprovals.size > 0 || pendingAsks.length > 0) return 'waiting_approval'
    if (this.openTurn !== undefined) {
      return this.activeDescendants() > 0 ? 'waiting_subagents' : 'running'
    }
    return 'idle'
  }
}

/**
 * Fold a complete durable prefix into one derived state.
 * @param events - durable events in log order.
 * @param pendingAsks - asks the host registry currently exposes for this Session.
 * @returns the derived aggregate state, including the watcher's `stop: 'budget'` marker.
 */
export function foldExecutionState(
  events: readonly PeerFoldEvent[],
  pendingAsks: readonly PeerPendingAsk[] = [],
): PeerExecutionState {
  const fold = new PeerLatchFold()
  for (const event of events) fold.apply(event)
  return fold.snapshot(pendingAsks)
}

/**
 * Classify one durable chain-failure code into the closed peer hop
 * vocabulary. Transient rate-limit codes answer `rate-limit`; credential,
 * entitlement, quota, and route-capability codes answer `unavailable`;
 * everything else — a transient server failure, an empty response, a policy
 * refusal, an unknown adapter code — answers `error`. No durable code
 * represents skipping a cooling route, so `cooldown` is reserved for that
 * future record shape and never produced today.
 * @param code - stable provider-neutral failure code from `llm/attempt-failed`.
 * @returns the peer-facing reason; never provider prose.
 */
export function modelHopReasonOf(code: string): PeerModelHopReason {
  switch (code) {
    case 'RATE_LIMIT':
    case 'PROVIDER_POOL_EXHAUSTED':
      return 'rate-limit'
    case 'AUTH':
    case 'FREE_TIER_GATED':
    case 'ENTITLEMENT_GATED':
    case 'INVALID_CREDENTIAL':
    case 'MISSING_CREDENTIAL':
    case 'QUOTA':
    case 'ACCOUNT_QUOTA':
    case 'NO_ADAPTER':
    case 'UNKNOWN_MODEL':
    case 'PROVIDER_MODEL_OUTAGE':
      return 'unavailable'
    default:
      return 'error'
  }
}

/**
 * Derive the peer hop payload from one durable `llm/attempt-failed` record.
 * Only the route pair, the closed reason, the group id, and the event time
 * cross the boundary; the record's `message`, `status`, and `requestId` are
 * deliberately dropped because provider prose can carry request text and URLs.
 * A credential-pool rotation names no next route, so `to` repeats the same
 * provider/model the rotated identity retried; a record with no `next` object
 * carries no `to` at all.
 * @param event - durable event time and payload.
 * @returns the hop payload, or `undefined` when the record lacks route facts.
 */
export function modelHopOf(event: { readonly time: number; readonly data: unknown }): PeerModelHopData | undefined {
  const data = event.data
  if (!isRecord(data)) return undefined
  const provider = stringField(data, 'provider')
  const model = stringField(data, 'model')
  const code = stringField(data, 'code')
  if (provider === undefined || model === undefined || code === undefined) return undefined
  const chain = stringField(data, 'chain')
  const next = recordField(data, 'next')
  const nextProvider = next === undefined ? undefined : stringField(next, 'provider')
  const nextModel = next === undefined ? undefined : stringField(next, 'model')
  const to = next === undefined
    ? undefined
    : nextProvider !== undefined && nextModel !== undefined
      ? { provider: nextProvider, model: nextModel }
      : { provider, model }
  return {
    from: { provider, model },
    ...(to === undefined ? {} : { to }),
    reason: modelHopReasonOf(code),
    ...(chain === undefined ? {} : { chain }),
    at: event.time,
  }
}

/**
 * Read the session token totals from the durable `tokenUsage` projection.
 * @param projections - projection values at one observation cut.
 * @returns the four disjoint buckets, or `undefined` when the projection is absent or malformed.
 */
export function readTokenUsageProjection(
  projections: Readonly<Record<string, unknown>> | undefined,
): PeerTokenUsage | undefined {
  const usage = projections?.tokenUsage
  if (!isRecord(usage)) return undefined
  const input = tokenCount(usage.uncachedInputTokens)
  const output = tokenCount(usage.outputTokens)
  const cacheRead = tokenCount(usage.cacheReadTokens)
  const cacheWrite = tokenCount(usage.cacheWriteTokens)
  if (input === undefined || output === undefined || cacheRead === undefined || cacheWrite === undefined) {
    return undefined
  }
  return { inputTokens: input, outputTokens: output, cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite }
}

/**
 * Compute the session's token ceiling view. The harness has no billing data,
 * so this reports tokens and never a cost. `metered` is true only when the
 * durable `tokenUsage` projection was actually read: an unreadable projection
 * reports zero usage and `exceeded: false` rather than pretending the ceiling
 * is enforced.
 * @param usage - session totals, absent before the first reported sample or when the projection is not mounted.
 * @param ceiling - configured total-token ceiling, if any.
 * @returns the budget facts, or `undefined` when no valid ceiling is configured.
 */
export function tokenBudgetOf(
  usage: PeerTokenUsage | undefined,
  ceiling: number | undefined,
): PeerExecutionState['budget'] | undefined {
  if (ceiling === undefined || !Number.isSafeInteger(ceiling) || ceiling < 0) return undefined
  if (usage === undefined) {
    return { maxTotalTokens: ceiling, usedTokens: 0, exceeded: false, metered: false }
  }
  const usedTokens = usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens
  return { maxTotalTokens: ceiling, usedTokens, exceeded: usedTokens >= ceiling, metered: true }
}

/** Read the answering route and usage sample carried by one durable assistant message. */
function modelReportOf(event: PeerFoldEvent): Omit<PeerTurnModelReport, 'hops'> | undefined {
  const source = recordField(recordField(event.data, 'message'), 'source')
  if (source?.kind !== 'model') return undefined
  const provider = stringField(source, 'provider')
  const model = stringField(source, 'model')
  if (provider === undefined || model === undefined) return undefined
  const chain = stringField(source, 'chain')
  const usage = recordField(event.data, 'usage')
  const mapped = usage === undefined ? undefined : parseTokenUsage(usage)
  return {
    provider,
    model,
    ...chain === undefined ? {} : { chain },
    ...mapped === undefined ? {} : { usage: mapped },
  }
}

/** Map one provider usage sample into the peer's four disjoint buckets. */
function parseTokenUsage(value: Record<string, unknown>): PeerTokenUsage | undefined {
  const input = tokenCount(value.inputTokens)
  const output = tokenCount(value.outputTokens)
  if (input === undefined || output === undefined) return undefined
  const cacheRead = value.cacheReadTokens === undefined ? 0 : tokenCount(value.cacheReadTokens)
  const cacheWrite = value.cacheWriteTokens === undefined ? 0 : tokenCount(value.cacheWriteTokens)
  if (cacheRead === undefined || cacheWrite === undefined) return undefined
  return { inputTokens: input, outputTokens: output, cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite }
}

/** Accept one non-negative finite token count. */
function tokenCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

/**
 * Prefer the host latch's terminal facts but keep this fold's route
 * attribution: the host execution-state projection carries no `ran`, and the
 * derived fold is what saw the answering message and the preceding hops.
 */
function mergeTerminalRan(
  hostTerminal: PeerTurnTerminal | undefined,
  derivedTerminal: PeerTurnTerminal | undefined,
): PeerTurnTerminal | undefined {
  if (hostTerminal === undefined) return derivedTerminal
  if (hostTerminal.ran !== undefined || derivedTerminal === undefined) return hostTerminal
  if (hostTerminal.turn !== derivedTerminal.turn || derivedTerminal.ran === undefined) return hostTerminal
  return { ...hostTerminal, ran: derivedTerminal.ran }
}

/**
 * Stamp the budget stop onto the reported terminal: only the turn whose durable
 * `aborted` terminal carries {@link PEER_BUDGET_STOP_REASON} becomes
 * `stop: 'budget'`. The marker is durable, so the classification survives a
 * host restart; a human or peer cancel records a `user` cause and is never
 * stamped, even when the session is over budget.
 */
function stampBudgetStop(
  terminal: PeerTurnTerminal | undefined,
  budgetStopTurn: number | undefined,
): PeerTurnTerminal | undefined {
  if (terminal === undefined || budgetStopTurn === undefined) return terminal
  if (terminal.turn !== budgetStopTurn) return terminal
  return { ...terminal, stop: 'budget' }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function recordField(value: unknown, key: string): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined
  const field = value[key]
  return isRecord(field) ? field : undefined
}

function stringField(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) return undefined
  const field = value[key]
  return typeof field === 'string' ? field : undefined
}

function numberField(value: unknown, key: string): number | undefined {
  if (!isRecord(value)) return undefined
  const field = value[key]
  return typeof field === 'number' && Number.isFinite(field) ? field : undefined
}

function participantToActor(value: Record<string, unknown> | undefined): PeerActor | undefined {
  if (value === undefined) return undefined
  const kind = value.kind
  const name = value.name
  if ((kind !== 'human' && kind !== 'peer') || typeof name !== 'string' || name.length === 0) return undefined
  const device = value.device
  return {
    kind,
    name,
    ...typeof device === 'string' && device.length > 0 ? { device } : {},
  }
}

function parseTurnError(value: Record<string, unknown> | undefined): PeerTurnError | undefined {
  if (value === undefined) return undefined
  const code = value.code
  const message = value.message
  if (typeof code !== 'string') return undefined
  const provider = value.provider
  const model = value.model
  return {
    code,
    message: typeof message === 'string' ? message : code,
    ...typeof provider === 'string' ? { provider } : {},
    ...typeof model === 'string' ? { model } : {},
  }
}

function parseTurnTerminal(value: unknown): PeerTurnTerminal | undefined {
  if (!isRecord(value)) return undefined
  const turn = value.turn
  const reason = value.reason
  const at = value.at
  if (typeof turn !== 'number' || typeof reason !== 'string' || typeof at !== 'number') return undefined
  const error = parseTurnError(recordField(value, 'error'))
  return {
    turn,
    reason: reason as PeerTurnTerminal['reason'],
    at,
    ...(error === undefined ? {} : { error }),
  }
}

function parseModelSelection(value: unknown): PeerModelSelection | undefined {
  if (!isRecord(value)) return undefined
  const provider = value.provider
  const model = value.model
  if (typeof provider !== 'string' || typeof model !== 'string') return undefined
  const chain = value.chain
  const reasoningEffort = value.reasoningEffort
  return {
    provider,
    model,
    ...typeof chain === 'string' ? { chain } : {},
    ...typeof reasoningEffort === 'string' ? { reasoningEffort } : {},
  }
}

const PARTICIPANT_ACTIONS = [
  'prompt', 'steer', 'cancel', 'queue-edit', 'answer', 'model-change', 'create',
] as const

/** Validate one host-published participant action without importing the host's type. */
function parseParticipantAction(value: unknown): PeerExecutionState['lastParticipantAction'] {
  if (!isRecord(value)) return undefined
  const action = value.action
  if (typeof action !== 'string' || !PARTICIPANT_ACTIONS.includes(action as (typeof PARTICIPANT_ACTIONS)[number])) {
    return undefined
  }
  const actor = participantToActor(recordField(value, 'actor'))
  if (actor === undefined) return undefined
  const at = value.at
  if (typeof at !== 'number') return undefined
  const detail = value.detail
  return {
    action: action as (typeof PARTICIPANT_ACTIONS)[number],
    actor,
    at,
    ...typeof detail === 'string' ? { detail } : {},
  }
}

/** Narrowing helper for callers assembling a peer participant from the wire. */
export function isPeerParticipant(value: unknown): value is PeerParticipant {
  if (!isRecord(value)) return false
  return value.kind === 'peer' && typeof value.name === 'string' && value.name.length > 0
}
