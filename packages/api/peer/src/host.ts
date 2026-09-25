/**
 * The serving side of the peer API: one narrow Typert namespace that maps
 * `peer.*` methods onto `session.*` operations behind a closed dispatch table.
 *
 * Everything a peer may do passes through `resolveTarget` first, so only
 * sessions named by the pairing table are audible; exposure filtering,
 * participant validation, the hop ceiling, and the orphan watchdog are applied
 * here, never in the caller (doc 69 §8, §9.2, §9.3, §10, §11, §12).
 *
 * @module @deepseek-ai/dsh-api-peer/host
 */

import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import { brandNumber, brandString } from '@deepseek-ai/dsh-brand'
import { SessionQueryError, type SessionObservation } from '@deepseek-ai/dsh-session-query'
import type { SessionId, SessionSeq } from '@deepseek-ai/dsh-session/types'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {
  SessionCreateRequest,
  SessionHistoryRecord,
  SessionPromptRequest,
  SessionRequestId,
} from '@deepseek-ai/dsh-api-session-controller/types'
import z from '@deepseek-ai/schemastery'
import { toPeerRecord } from './exposure.ts'
import {
  PeerLatchFold,
  readExecutionStateValue,
  readHostLatch,
  readModelSelectionProjection,
  type HostLatchFacts,
  type PeerFoldEvent,
} from './latch.ts'
import {
  DEFAULT_BINDINGS_PATH,
  DEFAULT_PAIRINGS_PATH,
  DEFAULT_WATCHDOG_MS,
  PeerPairingsStore,
  type ResolvedPeerPairing,
} from './pairings.ts'
import { PeerAskRegistry } from './registry.ts'
import type {
  PeerAnswer,
  PeerAnswerRequest,
  PeerAnswerValue,
  PeerAskId,
  PeerCancelRequest,
  PeerCancelValue,
  PeerCapability,
  PeerCreateRequest,
  PeerCreateValue,
  PeerExecutionState,
  PeerFollowFrame,
  PeerFollowRequest,
  PeerHandshakeRequest,
  PeerHandshakeValue,
  PeerPageRequest,
  PeerPageValue,
  PeerPairing,
  PeerPairingSummary,
  PeerParticipant,
  PeerParticipantAction,
  PeerPromptRequest,
  PeerPromptValue,
  PeerProtocolVersion,
  PeerStateRequest,
  PeerStateValue,
  PeerTarget,
} from './types.ts'

/** Peer protocol generation this build serves. */
export const PEER_PROTOCOL_VERSION: PeerProtocolVersion = 1

/** Version reported in the handshake when the deployment configures none. */
export const DEFAULT_HARNESS_VERSION = '0.1.6-alpha.2'

const PEER_METHODS = [
  'peer.answer',
  'peer.cancel',
  'peer.create',
  'peer.follow',
  'peer.handshake',
  'peer.page',
  'peer.prompt',
  'peer.state',
] as const

/** Digest of the peer method surface, compared by callers for skew diagnostics. */
export const PEER_SCHEMA_DIGEST = createHash('sha256')
  .update(`${PEER_PROTOCOL_VERSION}:${PEER_METHODS.join(',')}`)
  .digest('hex')

const PEER_CAPABILITIES: readonly PeerCapability[] = [
  'state-latch',
  'derived-latch',
  'answer-routing',
  'session-create',
  'runaway-ceiling',
]

const FOLLOW_SNAPSHOT_MAX_MESSAGES = 50

/** Peer API deployment policy. */
export interface Config {
  /** Pairing document path; defaults to `~/.dsh/pairings.yaml`. */
  readonly pairingsPath?: string
  /** Created-session binding path; defaults to `~/.dsh/peer-state.json`. */
  readonly bindingsPath?: string
  /** Orphan watchdog in milliseconds; defaults to 15 minutes. */
  readonly watchdogMs?: number
  /** Harness version reported by `peer.handshake`. */
  readonly harnessVersion?: string
  /** Schema digest reported by `peer.handshake`. */
  readonly schemaDigest?: string
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Narrow device-to-device peer API surface (namespace `peer`). */
    peerService: PeerService
  }
}

interface ObservationView {
  readonly header: SessionObservation['header']
  readonly cursor: number
  readonly events: readonly PeerFoldEvent[]
  readonly projections: Readonly<Record<string, unknown>> | undefined
}

/**
 * Host service backing the generated `ctx.remote.peer` namespace.
 * @typert service peerService
 */
export class PeerService extends TypertRemoteService {
  static inject = ['agentDefaultModel', 'agents', 'sessionController', 'sessionQuery']

  static Config: z<Config> = z.object({
    pairingsPath: z.string(),
    bindingsPath: z.string(),
    watchdogMs: z.number().step(1).min(1).default(DEFAULT_WATCHDOG_MS),
    harnessVersion: z.string().default(DEFAULT_HARNESS_VERSION),
    schemaDigest: z.string().default(PEER_SCHEMA_DIGEST),
  })

  /** Pairing table and created-session bindings. */
  readonly pairings: PeerPairingsStore
  /** Ask registry resolving the local-versus-peer answer race. */
  readonly registry: PeerAskRegistry

  private readonly resolved: Required<Config>
  private readonly followers = new Map<SessionId, number>()
  private readonly peerActions = new Map<SessionId, PeerParticipantAction>()
  private readonly orphans = new Map<SessionId, ReturnType<typeof setTimeout>>()

  /**
   * @param ctx - host context with agents, session query, and Session Controller active.
   * @param config - peer deployment policy.
   */
  constructor(ctx: Context, config: Config) {
    super(ctx, 'peerService', { namespace: 'peer' })
    this.resolved = {
      pairingsPath: config.pairingsPath ?? DEFAULT_PAIRINGS_PATH,
      bindingsPath: config.bindingsPath ?? DEFAULT_BINDINGS_PATH,
      watchdogMs: config.watchdogMs ?? DEFAULT_WATCHDOG_MS,
      harnessVersion: config.harnessVersion ?? DEFAULT_HARNESS_VERSION,
      schemaDigest: config.schemaDigest ?? PEER_SCHEMA_DIGEST,
    }
    this.pairings = new PeerPairingsStore(this.resolved.pairingsPath, this.resolved.bindingsPath)
    // Fail loud at load when the operator's pairing document is malformed.
    this.pairings.load()
    this.registry = new PeerAskRegistry(ctx, this.pairings)
    this.registry.install()
    ctx.effect(() => () => {
      for (const timer of this.orphans.values()) clearTimeout(timer)
      this.orphans.clear()
    }, 'peer-api: orphan watchdog')
  }

  /**
   * Negotiate protocol, capability, and pairing identity.
   * @param request - caller protocol, harness version, schema digest, and device name.
   * @returns the host identity, capabilities, and visible pairings.
   * @throws {@link RemoteError} `gateway/bad-request` when the request is
   * absent or not an object, `peer/version-skew` on protocol divergence.
   */
  @Remote('handshake')
  handshake(request: PeerHandshakeRequest): PeerHandshakeValue {
    // SRC descriptors cannot see which parameters are required, so an empty
    // args object reaches the method as undefined; reject it as a clean input
    // error instead of the `request.protocolVersion` TypeError it would raise.
    if (request === null || typeof request !== 'object') {
      throw new RemoteError(
        'gateway/bad-request',
        'handshake requires a request object with protocolVersion, harnessVersion, schemaDigest, and device',
        {},
      )
    }
    if (request.protocolVersion !== PEER_PROTOCOL_VERSION) {
      throw new RemoteError(
        'peer/version-skew',
        `peer protocol ${String(request.protocolVersion)} is not supported`,
        { expected: PEER_PROTOCOL_VERSION, received: request.protocolVersion },
      )
    }
    if (typeof request.device !== 'string' || request.device.length === 0) {
      throw new RemoteError('gateway/bad-request', 'handshake device must be a non-empty string', {})
    }
    const loaded = this.pairings.load()
    return {
      protocolVersion: PEER_PROTOCOL_VERSION,
      harnessVersion: this.resolved.harnessVersion,
      schemaDigest: this.resolved.schemaDigest,
      hostDevice: loaded.device,
      capabilities: [...PEER_CAPABILITIES],
      pairings: loaded.pairings.map(pairing => this.describePairing(pairing)),
    }
  }

  /**
   * Read the aggregate execution state for one paired Session. The host's
   * `session.executionState` latch wins when it answers (`source:'host-latch'`);
   * a cold Session or a host without that call keeps the derived fold.
   * @param request - resolved target.
   * @returns latch, descendants, pending asks, model selection, and cursor.
   */
  @Remote('state')
  async state(request: PeerStateRequest): Promise<PeerStateValue> {
    const resolved = this.resolveTarget(request.target)
    const observation = await this.observe(resolved.sessionId)
    const fold = this.foldOf(resolved.sessionId, observation)
    const hostLatch = this.hostLatchOf(resolved.sessionId) ?? readHostLatch(observation.projections)
    return {
      target: this.pairings.describe(resolved),
      state: this.snapshotState(resolved.sessionId, fold, hostLatch, observation.projections),
      cursor: brandNumber<SessionSeq>(observation.cursor),
    }
  }

  /**
   * Create or explicitly adopt a Session and bind it to a pairing alias.
   * @param request - pairing alias, participant, optional explicit session and routing.
   * @returns the resolved target and whether a new Session was created.
   */
  @Remote('create')
  async create(request: PeerCreateRequest): Promise<PeerCreateValue> {
    const pairing = this.pairings.load().pairings.find(candidate => candidate.alias === request.alias)
    if (pairing === undefined || pairing.create === undefined) {
      throw new RemoteError('peer/not-paired', `alias ${JSON.stringify(request.alias)} exposes no create binding`, {
        alias: request.alias,
      })
    }
    const participant = requireParticipant(request.participant)
    const routingRequested = request.provider !== undefined
      || request.model !== undefined
      || request.chain !== undefined
      || request.reasoningEffort !== undefined
    let created = true
    let sessionId = request.sessionId
    if (sessionId !== undefined && await this.sessionExists(sessionId)) {
      created = false
      if (routingRequested && pairing.allowModelChange !== true) {
        throw new RemoteError(
          'peer/forbidden',
          'adopting an existing Session may not change its routing without allowModelChange',
          { reason: 'model-change' },
        )
      }
    } else {
      const workspaceId = request.workspaceId ?? pairing.create.workspaceId
      const cwd = request.cwd ?? pairing.create.cwd
      const agentPreset = request.agentPreset ?? pairing.create.agentPreset
      const createRequest: SessionCreateRequest = {
        ...sessionId === undefined ? {} : { sessionId },
        ...workspaceId === undefined ? {} : { workspaceId: brandString<NonNullable<SessionCreateRequest['workspaceId']>>(workspaceId) },
        ...cwd === undefined ? {} : { cwd },
        ...agentPreset === undefined ? {} : { agentPreset },
      }
      sessionId = (await this.ctx.sessionController.create(createRequest)).sessionId
    }
    if (routingRequested) {
      await this.applySessionRouting(sessionId, request)
    }
    await this.pairings.bind(pairing.alias, pairing.peer, sessionId)
    this.recordPeerAction(sessionId, { action: 'create', actor: participant, at: Date.now() })
    return {
      target: {
        device: pairing.peer,
        sessionId,
        exposure: pairing.exposure,
        alias: pairing.alias,
      },
      created,
    }
  }

  /**
   * Admit one queued peer turn into a paired Session.
   * @param request - target, participant, dedupe id, text content, and hop telemetry.
   * @param signal - carrier cancellation before prompt admission begins.
   * @returns acceptance and the incremented hop count.
   * @throws {@link RemoteError} `peer/hop-limit` only when the pairing configures a ceiling.
   */
  @Remote('prompt')
  async prompt(request: PeerPromptRequest, signal: AbortSignal): Promise<PeerPromptValue> {
    const resolved = this.resolveTarget(request.target)
    const participant = requireParticipant(request.participant)
    const hopCount = request.hopCount ?? 0
    const ceiling = resolved.pairing.runawayCeiling
    if (ceiling !== undefined && hopCount >= ceiling) {
      throw new RemoteError(
        'peer/hop-limit',
        `peer hop budget ${String(hopCount)} reached the configured ceiling ${String(ceiling)}`,
        { hopCount, ceiling },
      )
    }
    const content = requirePromptContent(request.content)
    const promptRequest: SessionPromptRequest = {
      requestId: brandString<SessionRequestId>(request.requestId),
      sessionId: resolved.sessionId,
      mode: 'queue',
      content,
      // Durable attribution: the target log's `user/message` carries the peer
      // tag, which is what the host latch's `lastParticipantAction` reports.
      participant,
    }
    await this.ctx.sessionController.prompt(promptRequest, signal)
    this.recordPeerAction(resolved.sessionId, { action: 'prompt', actor: participant, at: Date.now() })
    this.scheduleWatchdog(resolved)
    return { accepted: true, queued: true, hopCount: hopCount + 1 }
  }

  /**
   * Cancel the active turn of a paired Session, attributed to the peer.
   * @param request - target and participant.
   * @returns acceptance and whether a turn was active.
   */
  @Remote('cancel')
  cancel(request: PeerCancelRequest): PeerCancelValue {
    const resolved = this.resolveTarget(request.target)
    const participant = requireParticipant(request.participant)
    const active = this.ctx.agents.get(resolved.sessionId)?.status === 'running'
    const value = this.ctx.sessionController.cancel({ sessionId: resolved.sessionId, participant })
    this.recordPeerAction(resolved.sessionId, { action: 'cancel', actor: participant, at: Date.now() })
    this.clearWatchdog(resolved.sessionId)
    return { accepted: value.accepted, cancelled: active }
  }

  /**
   * Settle a pending ask for a paired Session.
   * @param request - target, participant, ask id, and answer payload.
   * @returns acceptance after the ask settled.
   */
  @Remote('answer')
  answer(request: PeerAnswerRequest): PeerAnswerValue {
    const resolved = this.resolveTarget(request.target)
    const participant = requireParticipant(request.participant)
    const value = this.registry.answer(
      resolved,
      brandString<PeerAskId>(request.askId),
      requireAnswer(request.answer),
    )
    this.recordPeerAction(resolved.sessionId, {
      action: 'answer',
      actor: participant,
      at: Date.now(),
      detail: request.askId,
    })
    return value
  }

  /**
   * Repair history backwards from a follow cut, exposure-filtered.
   * @param request - target, inclusive cut, and optional backwards cursor.
   * @param signal - carrier cancellation for persistence reads.
   * @returns one contiguous backwards window of visible records.
   */
  @Remote('page')
  async page(request: PeerPageRequest, signal: AbortSignal): Promise<PeerPageValue> {
    const resolved = this.resolveTarget(request.target)
    const page = await this.ctx.sessionController.page({
      address: { kind: 'session', sessionId: resolved.sessionId },
      throughSeq: request.throughSeq,
      ...(request.beforeSeq === undefined
        ? {}
        : { beforeSeq: request.beforeSeq }),
      ...(request.maxMessages === undefined ? {} : { maxMessages: request.maxMessages }),
    }, signal)
    const records = page.records
      .map(record => toPeerRecord(record.event, resolved.exposure))
      .filter((record): record is NonNullable<typeof record> => record !== undefined)
    return { records, hasMore: page.hasMore }
  }

  /**
   * Open a filtered stream: opening snapshot, then durable events and latch transitions.
   * @param request - target, window budget, and debug-only assistant stream opt-in.
   * @param signal - carrier cancellation owned by the Remote stream.
   * @returns peer follow frames; `event`/`state` frames carry the durable scan cursor.
   */
  @Remote({ mode: 'stream' })
  async *follow(request: PeerFollowRequest, signal: AbortSignal): AsyncIterable<PeerFollowFrame> {
    const resolved = this.resolveTarget(request.target)
    if (request.assistantStream === true && resolved.exposure !== 'debug') {
      throw new RemoteError('peer/forbidden', 'assistant stream requires debug exposure', { reason: 'exposure' })
    }
    const observation = await this.observe(resolved.sessionId)
    const fold = this.foldOf(resolved.sessionId, observation)
    const hostLatch = readHostLatch(observation.projections)
    const target = this.pairings.describe(resolved)
    let stateKey = latchKey(this.snapshotState(resolved.sessionId, fold, hostLatch, observation.projections))
    // Ask membership has no durable event, so the registry pushes a wakeup on
    // mint and settle; the loop turns each key change into at most one frame.
    const askChanges = new AskChangeSignal()
    const unsubscribe = this.registry.onChange((sessionId) => {
      if (sessionId === resolved.sessionId) askChanges.notify()
    })
    const onAbort = (): void => { askChanges.notify() }
    signal.addEventListener('abort', onAbort, { once: true })
    const stream = this.ctx.sessionController.follow({
      address: { kind: 'session', sessionId: resolved.sessionId },
      maxMessages: request.maxMessages ?? FOLLOW_SNAPSHOT_MAX_MESSAGES,
      ...(request.assistantStream === true ? { assistantStream: true as const } : {}),
    }, signal)
    const durable = stream[Symbol.asyncIterator]()
    this.incrementFollowers(resolved.sessionId)
    try {
      type DurableResult = Awaited<ReturnType<typeof durable.next>>
      type Wake =
        | { readonly kind: 'durable'; readonly result: DurableResult }
        | { readonly kind: 'durable-error'; readonly error: unknown }
        | { readonly kind: 'change' }
      let durableWake: Promise<Wake> | undefined
      let changeWake: Promise<Wake> | undefined
      let expectedSeq: number | undefined
      // Durable position the generation has scanned; a pushed state frame
      // carries it so repair from any frame cut stays contiguous.
      let scanned = -1
      let opened = false
      for (;;) {
        if (signal.aborted) break
        // Arm each source once and keep the loser pending: re-issuing `next()`
        // after a race would drop the frame that made the loser resolve.
        durableWake ??= durable.next().then(
          result => ({ kind: 'durable' as const, result }),
          (error: unknown) => ({ kind: 'durable-error' as const, error }),
        )
        // Changes stay unarmed until the opening snapshot has fixed the key,
        // so no state frame can precede it.
        if (opened && changeWake === undefined) {
          changeWake = askChanges.next().then(() => ({ kind: 'change' as const }))
        }
        const wake = changeWake === undefined
          ? await durableWake
          : await Promise.race([durableWake, changeWake])
        if (wake.kind === 'change') {
          changeWake = undefined
          const state = this.snapshotState(resolved.sessionId, fold, hostLatch, observation.projections)
          const nextKey = latchKey(state)
          if (nextKey === stateKey) continue
          stateKey = nextKey
          yield { type: 'state', state, cursor: brandNumber<SessionSeq>(scanned) }
          continue
        }
        durableWake = undefined
        if (wake.kind === 'durable-error') throw wake.error
        const frame = wake.result
        if (frame.done === true) break
        const current = frame.value
        if (current.type === 'snapshot') {
          expectedSeq = current.cursor + 1
          scanned = current.cursor
          const state = this.snapshotState(resolved.sessionId, fold, hostLatch, observation.projections)
          stateKey = latchKey(state)
          yield {
            type: 'snapshot',
            target,
            header: {
              id: current.header.id,
              version: current.header.version,
              createdAt: current.header.createdAt,
              ...(current.header.cwd === undefined ? {} : { cwd: current.header.cwd }),
              ...(current.header.agentPreset === undefined ? {} : { agentPreset: current.header.agentPreset }),
            },
            cursor: brandNumber<SessionSeq>(current.cursor),
            state,
            records: current.records
              .map(record => toPeerRecord(record.event, resolved.exposure))
              .filter((record): record is NonNullable<typeof record> => record !== undefined),
            hasMore: current.hasMore,
          }
          opened = true
          continue
        }
        if (current.type === 'assistant-stream') {
          yield { type: 'assistant-stream', frame: current.frame }
          continue
        }
        const entry: SessionHistoryRecord = current
        if (expectedSeq === undefined) continue
        if (entry.event.seq !== expectedSeq) {
          throw new RemoteError(
            'peer/gap',
            `peer follow lost durable continuity: expected ${String(expectedSeq)}, saw ${String(entry.event.seq)}`,
            { expectedSeq, observedSeq: entry.event.seq },
          )
        }
        expectedSeq += 1
        fold.apply(entry.event)
        scanned = entry.event.seq
        const cursor = brandNumber<SessionSeq>(entry.event.seq)
        const record = toPeerRecord(entry.event, resolved.exposure)
        if (record !== undefined) yield { type: 'event', record, cursor }
        const state = this.snapshotState(resolved.sessionId, fold, hostLatch, observation.projections)
        const nextKey = latchKey(state)
        if (nextKey !== stateKey) {
          stateKey = nextKey
          yield { type: 'state', state, cursor }
        }
      }
      yield { type: 'end', reason: 'closed' }
    } catch (error) {
      if (error instanceof RemoteError && error.code === 'peer/not-found') {
        yield { type: 'end', reason: 'target-detached' }
        return
      }
      throw error
    } finally {
      signal.removeEventListener('abort', onAbort)
      unsubscribe()
      askChanges.dispose()
      void durable.return?.()
      this.decrementFollowers(resolved.sessionId)
    }
  }

  private describePairing(pairing: PeerPairing): PeerPairingSummary {
    const resolved = this.pairings.resolve({ kind: 'alias', alias: pairing.alias })
    return {
      alias: pairing.alias,
      peer: pairing.peer,
      exposure: pairing.exposure,
      tokenRequired: pairing.token !== undefined,
      ...(resolved === undefined ? {} : { target: this.pairings.describe(resolved) }),
    }
  }

  private resolveTarget(target: PeerTarget): ResolvedPeerPairing {
    const resolved = this.pairings.resolve(target)
    if (resolved === undefined) {
      throw new RemoteError(
        'peer/not-paired',
        target.kind === 'alias'
          ? `alias ${JSON.stringify(target.alias)} is not paired`
          : `session ${JSON.stringify(target.sessionId)} is not paired`,
        target.kind === 'alias' ? { alias: target.alias } : { sessionId: target.sessionId },
      )
    }
    return resolved
  }

  private snapshotState(
    sessionId: SessionId,
    fold: PeerLatchFold,
    hostLatch: HostLatchFacts | undefined,
    projections: Readonly<Record<string, unknown>> | undefined,
  ): PeerExecutionState {
    const state = fold.snapshot(this.registry.pendingFor(sessionId), hostLatch)
    // Durable selection, else the target's own default; peers never invent one.
    const model = state.model
      ?? readModelSelectionProjection(projections)
      ?? this.ctx.agentDefaultModel.currentSelection()
    return { ...state, model }
  }

  /**
   * Read the host's authoritative execution latch for one Session (doc 70 §4,
   * doc 69 §8 correction 3). A missing or failing `session.executionState`
   * keeps the derived fold in charge; the host value is consumed structurally.
   */
  private hostLatchOf(sessionId: SessionId): HostLatchFacts | undefined {
    try {
      const value: unknown = this.ctx.sessionController.executionState({ sessionId })
      return readExecutionStateValue(value)
    } catch {
      // The host latch is authoritative when present and an accelerator only:
      // a cold Session or a host without the RPC falls back to the derived fold.
      return undefined
    }
  }

  private foldOf(sessionId: SessionId, observation: ObservationView): PeerLatchFold {
    const fold = new PeerLatchFold()
    for (const event of observation.events) fold.apply(event)
    fold.recordPeerAction(this.peerActions.get(sessionId))
    return fold
  }

  private async observe(sessionId: SessionId, signal?: AbortSignal): Promise<ObservationView> {
    await Promise.resolve()
    let observation: SessionObservation
    try {
      observation = await this.ctx.sessionQuery.observeSession(sessionId, {
        projectionMode: 'all',
        ...(signal === undefined ? {} : { signal }),
      })
    } catch (error) {
      if (error instanceof SessionQueryError && error.code === 'SESSION_QUERY_SESSION_NOT_FOUND') {
        throw new RemoteError('peer/not-found', `session ${JSON.stringify(sessionId)} was not found`, { sessionId })
      }
      throw error
    }
    try {
      return {
        header: observation.header,
        cursor: observation.cursor,
        events: [...observation.events],
        projections: observation.projections?.values as unknown as Readonly<Record<string, unknown>> | undefined,
      }
    } finally {
      observation[Symbol.dispose]()
    }
  }

  private async sessionExists(sessionId: SessionId): Promise<boolean> {
    await Promise.resolve()
    try {
      const observation = await this.ctx.sessionQuery.observeSession(sessionId, { projectionMode: 'none' })
      observation[Symbol.dispose]()
      return true
    } catch (error) {
      if (error instanceof SessionQueryError && error.code === 'SESSION_QUERY_SESSION_NOT_FOUND') return false
      throw error
    }
  }

  /**
   * Install routing on one Session without touching the deployment default. A
   * peer's create-time routing must affect this Session and nothing else, so
   * the selection is threaded through `session.selectModel` with
   * `persistDefault: false` (doc 70 §6, doc 72 G6); the controller's own
   * validation/normalization (resolve, append, pending-for-next-request) is
   * otherwise unchanged.
   * @param sessionId - Session the routing applies to.
   * @param request - create request carrying the routing fields.
   * @throws {@link RemoteError} `gateway/bad-request` when provider/model are incomplete.
   */
  private async applySessionRouting(sessionId: SessionId, request: PeerCreateRequest): Promise<void> {
    const provider = request.provider
    const model = request.model
    if (provider === undefined || model === undefined) {
      throw new RemoteError('gateway/bad-request', 'provider and model must be provided together', {})
    }
    await this.ctx.sessionController.selectModel({
      sessionId,
      provider,
      model,
      ...(request.chain === undefined ? {} : { chain: request.chain }),
      ...(request.reasoningEffort === undefined ? {} : { reasoningEffort: request.reasoningEffort }),
      persistDefault: false,
    })
  }

  private recordPeerAction(sessionId: SessionId, action: PeerParticipantAction): void {
    this.peerActions.set(sessionId, action)
  }

  private incrementFollowers(sessionId: SessionId): void {
    this.followers.set(sessionId, (this.followers.get(sessionId) ?? 0) + 1)
    this.clearWatchdog(sessionId)
  }

  private decrementFollowers(sessionId: SessionId): void {
    const next = (this.followers.get(sessionId) ?? 1) - 1
    if (next > 0) {
      this.followers.set(sessionId, next)
      return
    }
    this.followers.delete(sessionId)
    // The last follower left: an open turn with no observer is exactly what the
    // orphan watchdog exists for, so a peer that prompts and drops still gets
    // its turn bounded. Nothing to arm for an unpaired or idle session.
    let resolved: ResolvedPeerPairing | undefined
    try {
      resolved = this.resolveTarget({ kind: 'session', sessionId })
    } catch {
      // An unpaired session has no watchdog to arm; the resolve failure is the
      // signal here, not a condition to surface.
      resolved = undefined
    }
    if (resolved !== undefined && this.ctx.agents.get(sessionId)?.status === 'running') {
      this.scheduleWatchdog(resolved)
    }
  }

  private scheduleWatchdog(resolved: ResolvedPeerPairing): void {
    this.clearWatchdog(resolved.sessionId)
    const ms = this.resolved.watchdogMs
    const timer = setTimeout(() => {
      this.orphans.delete(resolved.sessionId)
      if ((this.followers.get(resolved.sessionId) ?? 0) > 0) return
      if (this.ctx.agents.get(resolved.sessionId)?.status !== 'running') return
      this.ctx.logger.warn(
        `peer-api: aborting orphaned peer turn in session ${resolved.sessionId} after ${String(ms)}ms without a follower`,
      )
      this.ctx.sessionController.cancel({ sessionId: resolved.sessionId })
    }, ms)
    timer.unref()
    this.orphans.set(resolved.sessionId, timer)
  }

  private clearWatchdog(sessionId: SessionId): void {
    const timer = this.orphans.get(sessionId)
    if (timer === undefined) return
    clearTimeout(timer)
    this.orphans.delete(sessionId)
  }
}

function latchKey(state: PeerExecutionState): string {
  return JSON.stringify([
    state.latch,
    state.activeDescendants,
    // Compact ask fingerprint (id, kind, since); question payloads stay out of
    // the key, and a mint or settle is a change even with no durable event.
    state.pendingAsks.map(ask => [ask.askId, ask.kind, ask.since]),
    state.lastTurnEnd?.turn ?? null,
    state.lastTurnEnd?.reason ?? null,
    state.lastParticipantAction?.at ?? null,
  ])
}

/**
 * Coalescing wakeup for ask-registry pushes. A notification with a waiter
 * parked resolves it; notifications arriving before the next `next()` collapse
 * into one pending wake, so a follow loop re-reads the state at most once per
 * observation and key equality suppresses the frame when nothing changed.
 */
class AskChangeSignal {
  private armed = false
  private readonly waiters = new Set<() => void>()

  /** Record a change; wake the parked waiter when one exists. */
  notify(): void {
    if (this.waiters.size === 0) {
      this.armed = true
      return
    }
    for (const wake of [...this.waiters]) wake()
  }

  /** Resolve when a change arrives, or immediately when one is already pending. */
  async next(): Promise<void> {
    if (this.armed) {
      this.armed = false
      return
    }
    await new Promise<void>((resolve) => {
      const wake = (): void => {
        this.waiters.delete(wake)
        resolve()
      }
      this.waiters.add(wake)
    })
  }

  /** Release every waiter; the stream loop calls this on teardown. */
  dispose(): void {
    this.armed = false
    for (const wake of [...this.waiters]) wake()
    this.waiters.clear()
  }
}

function requireParticipant(value: unknown): PeerParticipant {
  if (typeof value !== 'object' || value === null) {
    throw new RemoteError('gateway/bad-request', 'participant must be an object', {})
  }
  const record = value as Record<string, unknown>
  if (record.kind !== 'peer' || typeof record.name !== 'string' || record.name.length === 0) {
    throw new RemoteError('gateway/bad-request', 'participant must be {kind: "peer", name}', {})
  }
  if (record.device !== undefined && (typeof record.device !== 'string' || record.device.length === 0)) {
    throw new RemoteError('gateway/bad-request', 'participant.device must be a non-empty string when present', {})
  }
  return {
    kind: 'peer',
    name: record.name,
    ...(record.device === undefined ? {} : { device: record.device }),
  }
}

function requirePromptContent(value: unknown): readonly { readonly type: 'text'; readonly text: string }[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new RemoteError('gateway/bad-request', 'prompt content must be a non-empty list', {})
  }
  return value.map((part) => {
    if (typeof part !== 'object' || part === null
      || (part as Record<string, unknown>).type !== 'text'
      || typeof (part as Record<string, unknown>).text !== 'string') {
      throw new RemoteError('gateway/bad-request', 'P2 peer prompts admit text parts only', {})
    }
    const text = (part as Record<string, unknown>).text as string
    if (text.trim().length === 0) {
      throw new RemoteError('gateway/bad-request', 'prompt text must contain non-whitespace content', {})
    }
    return { type: 'text' as const, text }
  })
}

function requireAnswer(value: unknown): PeerAnswer {
  if (typeof value !== 'object' || value === null) {
    throw new RemoteError('gateway/bad-request', 'answer must be an object', {})
  }
  const record = value as Record<string, unknown>
  if (record.kind === 'approval') {
    if (record.outcome !== 'allowed-once' && record.outcome !== 'rejected') {
      throw new RemoteError('gateway/bad-request', 'approval outcome must be allowed-once or rejected', {})
    }
    return { kind: 'approval', outcome: record.outcome }
  }
  if (record.kind === 'question') {
    return { kind: 'question', answer: record.answer as never }
  }
  throw new RemoteError('gateway/bad-request', 'answer kind must be approval or question', {})
}
