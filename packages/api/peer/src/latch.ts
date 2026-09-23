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
  PeerModelSelection,
  PeerParticipant,
  PeerPendingAsk,
  PeerTurnError,
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
 * projection (`pending` wins over `lastUsed`), for Sessions with no explicit
 * `model/selection` event yet (doc 69 §10.3).
 * @param projections - projection values at one observation cut.
 * @returns the selection, or `undefined` when the projection is absent.
 */
export function readModelSelectionProjection(
  projections: Readonly<Record<string, unknown>> | undefined,
): PeerModelSelection | undefined {
  const candidate = projections?.modelSelection
  if (!isRecord(candidate)) return undefined
  const pick = isRecord(candidate.pending) ? candidate.pending : candidate.lastUsed
  return parseModelSelection(pick)
}

/** Mutable fold state; one instance tracks one Session. */
export class PeerLatchFold {
  private readonly pendingApprovals = new Map<string, { toolName: string; callId?: string; reason?: string; since: number }>()
  private readonly catalog = new Map<SessionId, { spawnSeq: number; createdAt: number; quietKnown: boolean }>()
  private readonly settledChildren = new Set<SessionId>()
  private openTurn: number | undefined
  private openTurnStartSeq: number | undefined
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
          }
          if (kind === 'aborted') {
            const cancelReason = recordField(reason, 'reason')
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
        this.settledChildren.clear()
        this.pendingApprovals.clear()
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

  /** Record a host-local peer action (in-memory attribution until the durable path lands). */
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
   * @returns the aggregate execution state.
   */
  snapshot(pendingAsks: readonly PeerPendingAsk[], hostLatch?: HostLatchFacts): PeerExecutionState {
    const activeDescendants = hostLatch?.activeDescendants ?? this.activeDescendants()
    const latch = hostLatch?.latch ?? this.derivedLatch(pendingAsks)
    if (latch !== this.latch) {
      this.latch = latch
      this.latchSince = this.lastEventTime
    }
    const lastTurnEnd = hostLatch?.lastTurnEnd ?? this.lastTurnEnd
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
 * @returns the derived aggregate state.
 */
export function foldExecutionState(
  events: readonly PeerFoldEvent[],
  pendingAsks: readonly PeerPendingAsk[] = [],
): PeerExecutionState {
  const fold = new PeerLatchFold()
  for (const event of events) fold.apply(event)
  return fold.snapshot(pendingAsks)
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
