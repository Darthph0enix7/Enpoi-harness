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
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { SessionQueryError, type SessionObservation } from '@deepseek-ai/dsh-session-query'
import type { SessionId, SessionSeq } from '@deepseek-ai/dsh-session/types'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-api-session-controller'
// Type-only: the `ctx.tokenMeter` Context merge for the usage-seam probe.
import type {} from '@deepseek-ai/dsh-token-meter'
import type {
  SessionCreateRequest,
  SessionHistoryRecord,
  SessionPromptRequest,
  SessionRequestId,
} from '@deepseek-ai/dsh-api-session-controller/types'
import z from '@deepseek-ai/schemastery'
import { toPeerRecords } from './exposure.ts'
import {
  PEER_BUDGET_STOP_REASON,
  PeerLatchFold,
  readExecutionStateValue,
  readHostLatch,
  readModelSelectionProjection,
  readTokenUsageProjection,
  tokenBudgetOf,
  type HostLatchFacts,
  type PeerFoldEvent,
} from './latch.ts'
import {
  DEFAULT_BINDINGS_PATH,
  DEFAULT_PAIRINGS_PATH,
  DEFAULT_WATCHDOG_MS,
  PeerPairingsStore,
  type LoadedPeerPairings,
  type ResolvedPeerPairing,
} from './pairings.ts'
import { DEFAULT_RECEIPTS_PATH, PeerReceiptStore, receiptKey } from './receipts.ts'
import { clampTokenCeiling } from './routing-policy.ts'
import { HARNESS_VERSION } from './version.ts'
import { PeerAskRegistry } from './registry.ts'
import type {
  PeerAlias,
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
  PeerListEntry,
  PeerListRequest,
  PeerListValue,
  PeerModelSelection,
  PeerModelsRequest,
  PeerModelsValue,
  PeerPageRequest,
  PeerPageValue,
  PeerPairing,
  PeerPairingSummary,
  PeerParticipant,
  PeerParticipantAction,
  PeerPromptRequest,
  PeerPromptValue,
  PeerProtocolVersion,
  PeerRoutingPolicy,
  PeerRoutingService,
  PeerRoutingVerdict,
  PeerSelectModelRequest,
  PeerSelectModelValue,
  PeerStateRequest,
  PeerStateValue,
  PeerTarget,
} from './types.ts'

/** Peer protocol generation this build serves. */
export const PEER_PROTOCOL_VERSION: PeerProtocolVersion = 1

/**
 * Version reported in the handshake when the deployment configures none. It is
 * the running package manifest's version, the runtime version plugin
 * compatibility reads through `getDshRuntimeVersion()`; a managed `dsh
 * --version` line adds the installer's release identity around it. The
 * handshake therefore identifies the shipped build without a drifting literal.
 */
export const DEFAULT_HARNESS_VERSION = HARNESS_VERSION

const PEER_METHODS = [
  'peer.answer',
  'peer.cancel',
  'peer.create',
  'peer.follow',
  'peer.handshake',
  'peer.list',
  'peer.models',
  'peer.page',
  'peer.prompt',
  'peer.selectModel',
  'peer.state',
] as const

/** Digest of the peer method surface, compared by callers for skew diagnostics. */
export const PEER_SCHEMA_DIGEST = createHash('sha256')
  .update(`${PEER_PROTOCOL_VERSION}:${PEER_METHODS.join(',')}`)
  .digest('hex')

const FOLLOW_SNAPSHOT_MAX_MESSAGES = 50

/**
 * Capability ledger: every `PeerCapability` the contract names, marked with
 * whether this build serves it. The `Record` key set is the union, so a new
 * union member fails the build here until it is explicitly marked; the
 * handshake advertises the `served` entries this deployment can actually
 * answer.
 *
 * `assistant-stream` is served: `peer.follow` yields
 * `assistant-stream` frames when the pairing's exposure is `debug` and the
 * caller opts in, and refuses the opt-in otherwise with `peer/forbidden`.
 * The routing three are served only while a `peerRouting` service is mounted
 * (see {@link ROUTING_CAPABILITIES}); `token-ceiling` is served only while the
 * host can read the durable usage projection (see
 * {@link TOKEN_CEILING_CAPABILITIES}); model-attribution is served by this
 * build's contract whenever a create carries it.
 */
export const PEER_CAPABILITY_LEDGER: Readonly<Record<PeerCapability, 'served' | 'planned'>> = {
  'state-latch': 'served',
  'derived-latch': 'served',
  'assistant-stream': 'served',
  'answer-routing': 'served',
  'runaway-ceiling': 'served',
  'session-create': 'served',
  'model-discovery': 'served',
  'model-routing-at-create': 'served',
  'model-switch': 'served',
  'model-attribution': 'served',
  'token-ceiling': 'served',
}

/**
 * Capabilities that need a mounted `peerRouting` service at handshake time.
 * Without it the host refuses every routing request, so advertising these
 * would promise a switch it cannot serve.
 */
const ROUTING_CAPABILITIES: readonly PeerCapability[] = [
  'model-discovery',
  'model-routing-at-create',
  'model-switch',
]

/**
 * Capabilities that need the durable token-usage seam at handshake time.
 * Without it the host cannot report `budget.metered`, cannot enforce a
 * ceiling, and refuses a create that asks for one, so advertising
 * `token-ceiling` would promise a cost guard that silently does nothing.
 */
const TOKEN_CEILING_CAPABILITIES: readonly PeerCapability[] = ['token-ceiling']

/**
 * Capabilities this build serves. The handshake advertises this set minus the
 * members whose seam is not mounted on the current host.
 */
export const PEER_CAPABILITIES: readonly PeerCapability[] =
  (Object.keys(PEER_CAPABILITY_LEDGER) as PeerCapability[])
    .filter(capability => PEER_CAPABILITY_LEDGER[capability] === 'served')

/**
 * Capabilities the contract defines but this build does not serve yet. The
 * capability gate test requires every ledger entry to be served or planned,
 * and exactly one of the two.
 */
export const PLANNED_PEER_CAPABILITIES: readonly PeerCapability[] =
  (Object.keys(PEER_CAPABILITY_LEDGER) as PeerCapability[])
    .filter(capability => PEER_CAPABILITY_LEDGER[capability] === 'planned')

/** Peer API deployment policy. */
export interface Config {
  /** Pairing document path; defaults to `~/.dsh/pairings.yaml`. */
  readonly pairingsPath?: string
  /** Created-session binding path; defaults to `~/.dsh/peer-state.json`. */
  readonly bindingsPath?: string
  /** Orphan watchdog in milliseconds; defaults to 15 minutes. */
  readonly watchdogMs?: number
  /** Harness version reported by `peer.handshake`; defaults to the running package manifest version. */
  readonly harnessVersion?: string
  /** Schema digest reported by `peer.handshake`. */
  readonly schemaDigest?: string
  /** Idempotency receipt document path; defaults to `~/.dsh/peer-receipts.json`. */
  readonly receiptsPath?: string
  /** Most `peer.selectModel` receipts retained; oldest evicted first. */
  readonly receiptLimit?: number
  /** `peer.models` page size when the caller names none. */
  readonly modelsLimit?: number
  /** Hard `peer.models` page cap, whatever the caller asks for. */
  readonly modelsLimitMax?: number
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Narrow device-to-device peer API surface (namespace `peer`). */
    peerService: PeerService
    /**
     * Optional routing seam the profile provides. The peer host reads it with
     * `ctx.get` at call time and never injects it, because a deployment without
     * a catalogue still serves the non-routing surface.
     */
    peerRouting: PeerRoutingService
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
    receiptsPath: z.string(),
    receiptLimit: z.number().step(1).min(1).default(512),
    modelsLimit: z.number().step(1).min(1).default(100),
    modelsLimitMax: z.number().step(1).min(1).default(500),
  })

  /** Pairing table and created-session bindings. */
  readonly pairings: PeerPairingsStore
  /** Ask registry resolving the local-versus-peer answer race. */
  readonly registry: PeerAskRegistry
  /** Restart-safe idempotency receipts for `peer.selectModel`. */
  readonly receipts: PeerReceiptStore

  private readonly resolved: Required<Config>
  private readonly followers = new Map<SessionId, number>()
  private readonly peerActions = new Map<SessionId, PeerParticipantAction>()
  private readonly orphans = new Map<SessionId, ReturnType<typeof setTimeout>>()
  /** Turn each Session was last stopped at for its ceiling; a later turn stops again. */
  private readonly budgetStopped = new Map<SessionId, number>()
  /** Single-flight guard for the ceiling observation, with the newest pending turn. */
  private readonly budgetChecks = new Map<SessionId, { again: boolean; turn: number; ceiling: number }>()
  /** In-memory reverse index of binding ceilings, rebuilt when the bindings change. */
  private ceilingIndex: {
    readonly bindings: LoadedPeerPairings['bindings']
    readonly ceilings: ReadonlyMap<SessionId, number>
  } | undefined

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
      receiptsPath: config.receiptsPath ?? DEFAULT_RECEIPTS_PATH,
      receiptLimit: config.receiptLimit ?? 512,
      modelsLimit: config.modelsLimit ?? 100,
      modelsLimitMax: config.modelsLimitMax ?? 500,
    }
    this.pairings = new PeerPairingsStore(this.resolved.pairingsPath, this.resolved.bindingsPath, {
      // A rejected reload keeps the previous valid snapshot; without this sink
      // the host would run a stale policy silently. The store dedupes by
      // diagnostic and strips parser code frames before the message arrives.
      onConfigError: (message) => { ctx.logger.warn(`peer-api: pairings reload rejected; previous snapshot kept: ${message}`) },
    })
    this.receipts = new PeerReceiptStore(this.resolved.receiptsPath, this.resolved.receiptLimit)
    // Fail loud at load when the operator's pairing document is malformed.
    this.pairings.load()
    this.registry = new PeerAskRegistry(ctx, this.pairings)
    this.registry.install()
    ctx.effect(() => () => {
      for (const timer of this.orphans.values()) clearTimeout(timer)
      this.orphans.clear()
    }, 'peer-api: orphan watchdog')
    // The ceiling watcher is an effect like every other registration: it rides
    // this plugin's fiber and never survives its disposal.
    ctx.on('session/event', (session, event) => { this.onSessionEvent(session, event) })
    // Per-session ceiling bookkeeping must not outlive the Session or its
    // Agent: a detached agent cannot be stopped, and a later attach starts a
    // fresh turn sequence that must be allowed to stop again.
    ctx.on('agent/disposed', ({ agent }) => { this.forgetBudgetStop(agent.id) })
    ctx.on('session/disposed', (session) => { this.forgetBudgetStop(session.id) })
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
      capabilities: [...this.advertisedCapabilities()],
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
   * List the pairings this host exposes with a cheap live summary. Discovery
   * is read-only and reports each pairing at its own exposure; a supplied
   * target resolves through the same pairing gate as every other call, so an
   * unpaired session is refused rather than listed.
   * @param request - optional target narrowing the answer to one pairing.
   * @returns the host device and one row per selected pairing.
   * @throws {@link RemoteError} `peer/not-paired` when a supplied target does not resolve.
   */
  @Remote('list')
  list(request?: PeerListRequest): PeerListValue {
    const loaded = this.pairings.load()
    const selected = request?.target === undefined
      ? loaded.pairings
      : [this.resolveTarget(request.target).pairing]
    return {
      hostDevice: loaded.device,
      pairings: selected.map(pairing => this.describeListEntry(pairing)),
    }
  }

  /** One `peer.list` row: binding facts plus the host latch when that read is cheap. */
  private describeListEntry(pairing: PeerPairing): PeerListEntry {
    const base = {
      alias: pairing.alias,
      peer: pairing.peer,
      exposure: pairing.exposure,
      ...(pairing.remoteSessionId === undefined ? {} : { remoteSessionId: pairing.remoteSessionId }),
    }
    const resolved = this.pairings.resolve({ kind: 'alias', alias: pairing.alias })
    if (resolved === undefined) {
      return { ...base, bound: false, summary: 'not bound to a session' }
    }
    const latch = this.hostLatchOf(resolved.sessionId)
    if (latch === undefined) {
      // A cold Session has no attached execution state; the row still reports
      // the binding without paying for a durable scan.
      return {
        ...base,
        bound: true,
        sessionId: resolved.sessionId,
        summary: 'bound; latch unavailable (cold session)',
      }
    }
    const pendingAsks = this.registry.pendingFor(resolved.sessionId).length
    const lastActivity = latch.lastParticipantAction?.at
      ?? latch.lastTurnEnd?.at
      ?? (latch.latch === 'idle' ? undefined : latch.since)
    return {
      ...base,
      bound: true,
      sessionId: resolved.sessionId,
      latch: latch.latch,
      ...(lastActivity === undefined ? {} : { lastActivity }),
      summary: latchSummary(latch, pendingAsks),
    }
  }

  /**
   * Create or explicitly adopt a Session and bind it to a pairing alias.
   *
   * A pairing with a `routing` policy is authoritative: every create (new or
   * adopt) must name a route, the policy is evaluated before any session or
   * selection exists, and the applied selection is the verdict's `selection`
   * (a chain-only request is resolved there). Without a policy the legacy
   * behavior is unchanged and `allowModelChange` gates adopt-time routing.
   * @param request - pairing alias, participant, optional explicit session, routing, and token ceiling.
   * @returns the resolved target and whether a new Session was created.
   * @throws {@link RemoteError} `peer/not-paired`; `peer/forbidden` for a policy
   * refusal, a missing routing service, a ceiling on a host without the usage
   * seam (reason `budget-unmetered`), or an adopt without `allowModelChange`;
   * `peer/not-found` for a deeper create failure.
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
    const policy = pairing.routing
    const routingRequested = request.provider !== undefined
      || request.model !== undefined
      || request.chain !== undefined
      || request.reasoningEffort !== undefined
    // Policy decisions run before any create/adopt/select: a refusal must leave
    // no Session and no selection event behind.
    const policySelection = policy === undefined
      ? undefined
      : await this.evaluateCreateRouting(policy, request)
    // A ceiling that is not a positive safe integer would disable enforcement
    // (negative, NaN) or make the stored binding unreadable on the next load.
    if (request.maxTotalTokens !== undefined
      && (!Number.isSafeInteger(request.maxTotalTokens) || request.maxTotalTokens <= 0)) {
      throw new RemoteError('gateway/bad-request', 'maxTotalTokens must be a positive integer', {})
    }
    const clamped = clampTokenCeiling(policy, request.maxTotalTokens)
    if (clamped === 'over') {
      throw routingForbidden(
        'budget',
        `maxTotalTokens exceeds the pairing ceiling of ${String(policy?.maxTotalTokens)}`,
        String(request.maxTotalTokens),
      )
    }
    const ceiling = clamped
    // A ceiling without the usage seam would record a guard that can never
    // read its own spend. Refuse before any Session exists so a caller never
    // believes it capped the worker.
    if (ceiling !== undefined && !this.hasTokenUsageSeam()) {
      throw routingForbidden(
        'budget-unmetered',
        'this host cannot read token usage, so it cannot enforce a token ceiling',
        String(ceiling),
      )
    }
    let created = true
    let sessionId = request.sessionId
    try {
      if (sessionId !== undefined && await this.sessionExists(sessionId)) {
        created = false
        if (policy === undefined && routingRequested && pairing.allowModelChange !== true) {
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
      if (policySelection !== undefined) {
        await this.applySelection(sessionId, policySelection)
      } else if (routingRequested) {
        await this.applySessionRouting(sessionId, request)
      }
    } catch (error) {
      // Deeper stacks raise their own codes (`agent-preset/not-found`,
      // `session/not-found`, …); a peer caller gets the closed peer vocabulary
      // with the original code preserved as `reason` and the cause.
      throw createFailure(error, pairing.alias)
    }
    await this.pairings.bind(
      pairing.alias,
      pairing.peer,
      sessionId,
      ceiling === undefined ? {} : { maxTotalTokens: ceiling },
    )
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
   * Evaluate one create request against a pairing's routing policy, before any
   * Session exists.
   * @param policy - the pairing's authoritative routing policy.
   * @param request - create request naming the route.
   * @returns the exact selection the verdict resolved.
   * @throws {@link RemoteError} `peer/forbidden` for a missing service, a
   * request that names no route, or a policy refusal.
   */
  private async evaluateCreateRouting(
    policy: PeerRoutingPolicy,
    request: PeerCreateRequest,
  ): Promise<PeerModelSelection> {
    const pinned = request.provider !== undefined || request.model !== undefined
    if (!pinned && request.chain === undefined) {
      throw routingForbidden(
        'routing-required',
        'this pairing requires provider/model or chain on every create',
      )
    }
    const routing = this.routingService()
    if (routing === undefined) {
      throw routingForbidden('routing-unavailable', 'this host has no model routing service')
    }
    if (pinned && (request.provider === undefined || request.model === undefined)) {
      throw new RemoteError('gateway/bad-request', 'provider and model must be provided together', {})
    }
    // A chain-only request uses the routing service's empty-route encoding
    // (`provider`/`model` empty); the verdict resolves the concrete selection.
    const selection: PeerModelSelection = {
      provider: request.provider ?? '',
      model: request.model ?? '',
      ...(request.chain === undefined ? {} : { chain: request.chain }),
      ...(request.reasoningEffort === undefined ? {} : { reasoningEffort: request.reasoningEffort }),
    }
    const verdict = await this.evaluateRoutes(routing, policy, selection)
    if (!verdict.allowed) {
      throw routingForbidden(
        verdict.reason,
        `routing policy refused the requested model (${verdict.reason})`,
        verdict.denied,
      )
    }
    return verdict.selection
  }

  /**
   * Policy-filtered model and chain discovery for one alias.
   * @param request - alias, participant, optional filter, cursor, and page limit.
   * @returns selectable chains/models with the policy echoed for the caller.
   * @throws {@link RemoteError} `peer/not-paired` for an unknown alias,
   * `peer/forbidden` when the pairing configures no policy or the host mounts
   * no routing service, `gateway/bad-request` for an invalid page cursor, and
   * `peer/forbidden` reason `routing-unavailable` when the service throws.
   */
  @Remote('models')
  async models(request: PeerModelsRequest): Promise<PeerModelsValue> {
    if (request === null || typeof request !== 'object') {
      throw new RemoteError('gateway/bad-request', 'models requires a request object', {})
    }
    requireParticipant(request.participant)
    const pairing = this.pairings.load().pairings.find(candidate => candidate.alias === request.alias)
    if (pairing === undefined) {
      throw new RemoteError('peer/not-paired', `alias ${JSON.stringify(request.alias)} is not paired`, {
        alias: request.alias,
      })
    }
    const policy = pairing.routing
    if (policy === undefined) {
      throw routingForbidden('routing-not-configured', 'this pairing configures no routing policy')
    }
    const routing = this.routingService()
    if (routing === undefined) {
      throw routingForbidden('routing-unavailable', 'this host has no model routing service')
    }
    const discovered = await this.discoverRoutes(routing, policy, request)
    return {
      ...discovered,
      selectableByThisAlias: {
        chains: policy.allowChains ?? [],
        models: policy.allowModels ?? [],
        ...(policy.allowReasoningEfforts === undefined
          ? {}
          : { reasoningEfforts: policy.allowReasoningEfforts }),
        requireZeroPrice: policy.requireZeroPrice === true,
        requireNoTraining: policy.requireNoTraining === true,
        requireTools: policy.requireTools === true,
        allowSwitch: policy.allowSwitch ?? 'never',
      },
    }
  }

  /** Clamp one discovery page size to the deployment bounds. */
  private modelsLimitOf(requested: number | undefined): number {
    const max = this.resolved.modelsLimitMax
    const fallback = Math.min(this.resolved.modelsLimit, max)
    if (requested === undefined || !Number.isSafeInteger(requested) || requested <= 0) return fallback
    return Math.min(requested, max)
  }

  /**
   * Run one discovery call and translate the routing service's failures into
   * the peer vocabulary. The service signals an unusable cursor with a plain
   * `Error('invalid cursor')`; every other throw is a service fault and fails
   * closed without the raw message or stack reaching the caller.
   * @param routing - mounted routing seam.
   * @param policy - the pairing's routing policy.
   * @param request - caller filter, cursor, and clamped page limit.
   * @returns the service's discovery page.
   * @throws {@link RemoteError} `gateway/bad-request` for an invalid cursor,
   * `peer/forbidden` reason `routing-unavailable` for any other throw.
   */
  private async discoverRoutes(
    routing: PeerRoutingService,
    policy: PeerRoutingPolicy,
    request: PeerModelsRequest,
  ): Promise<{
    readonly chains: PeerModelsValue['chains']
    readonly models: PeerModelsValue['models']
    readonly nextCursor?: string
  }> {
    try {
      return await routing.discover(policy, {
        ...(request.filter === undefined ? {} : { filter: request.filter }),
        ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
        limit: this.modelsLimitOf(request.limit),
      })
    } catch (error) {
      throw routingFailure(error)
    }
  }

  /**
   * Run one selection evaluation and translate a service throw like
   * {@link discoverRoutes}; a verdict, allowed or refused, is passed through.
   * @param routing - mounted routing seam.
   * @param policy - the pairing's routing policy.
   * @param selection - the requested route or chain.
   * @returns the service's verdict.
   * @throws {@link RemoteError} `peer/forbidden` reason `routing-unavailable`.
   */
  private async evaluateRoutes(
    routing: PeerRoutingService,
    policy: PeerRoutingPolicy,
    selection: PeerModelSelection,
  ): Promise<PeerRoutingVerdict> {
    try {
      return await routing.evaluate(policy, selection)
    } catch (error) {
      throw routingFailure(error)
    }
  }

  /**
   * Switch one idle Session's routing for its next turn. The policy decides the
   * exact selection; the caller's request is only an input. A replay of the
   * same `requestId` with the same payload returns the original value without
   * appending another selection.
   * @param request - target, participant, request id, and requested route.
   * @returns the applied selection, the previous one when known, and replay status.
   * @throws {@link RemoteError} `peer/forbidden` for a policy refusal or a
   * disallowed switch, `peer/conflict` for a busy Session or a reused request
   * id, `peer/not-paired` for an unresolved target.
   */
  @Remote('selectModel')
  async selectModel(request: PeerSelectModelRequest): Promise<PeerSelectModelValue> {
    if (request === null || typeof request !== 'object') {
      throw new RemoteError('gateway/bad-request', 'selectModel requires a request object', {})
    }
    const participant = requireParticipant(request.participant)
    const resolved = this.resolveTarget(request.target)
    const policy = resolved.pairing.routing
    if (policy === undefined) {
      throw routingForbidden('routing-not-configured', 'this pairing configures no routing policy')
    }
    const routing = this.routingService()
    if (routing === undefined) {
      throw routingForbidden('routing-unavailable', 'this host has no model routing service')
    }
    if (policy.allowSwitch !== 'idle-only') {
      throw routingForbidden('switch-not-allowed', 'this pairing does not allow mid-session switches')
    }
    const requestId = requireRequestId(request.requestId)
    const key = receiptKey(resolved.sessionId, requestId)
    const hash = selectionHash(request)
    const receipt = this.receipts.get(key)
    if (receipt !== undefined) {
      if (receipt.hash !== hash) {
        throw new RemoteError(
          'peer/conflict',
          `requestId ${JSON.stringify(requestId)} was already used with a different payload`,
          { reason: 'request-id-reuse' },
        )
      }
      return { ...receipt.value, replayed: true }
    }
    this.requireIdleForSwitch(resolved.sessionId)
    const verdict = await this.evaluateRoutes(routing, policy, {
      provider: request.provider,
      model: request.model,
      ...(request.chain === undefined ? {} : { chain: request.chain }),
      ...(request.reasoningEffort === undefined ? {} : { reasoningEffort: request.reasoningEffort }),
    })
    if (!verdict.allowed) {
      throw routingForbidden(
        verdict.reason,
        `routing policy refused the requested model (${verdict.reason})`,
        verdict.denied,
      )
    }
    const previous = await this.currentSelectionOf(resolved.sessionId)
    // The evaluation and the durable read awaited; a turn may have started in
    // that window, so re-prove idleness immediately before applying.
    this.requireIdleForSwitch(resolved.sessionId)
    await this.applySelection(resolved.sessionId, verdict.selection)
    const value: PeerSelectModelValue = {
      accepted: true,
      selected: verdict.selection,
      ...(previous === undefined ? {} : { previous }),
      replayed: false,
    }
    // In-memory attribution: the Session Controller's `model/selection` event
    // carries the selection but no participant, and widening that durable
    // payload would change the persisted format.
    this.recordPeerAction(resolved.sessionId, {
      action: 'model-change',
      actor: participant,
      at: Date.now(),
      detail: `${verdict.selection.provider}/${verdict.selection.model}`,
    })
    try {
      await this.receipts.put(key, hash, value)
    } catch (error) {
      // The switch already applied; the idempotency receipt is an accelerator.
      // A retry re-applies the identical selection, which is harmless.
      this.ctx.logger.warn(
        `peer-api: model selection applied but its receipt was not persisted: ${String(error)}`,
      )
    }
    return value
  }

  /**
   * The total-token ceiling recorded for one created Session, for the
   * enforcement lane that stops a Session at its budget.
   *
   * The answer comes from an in-memory reverse index so the per-append
   * watcher check never reads the pairing document; the index is rebuilt
   * whenever a `bind` republishes the binding snapshot. Ceilings themselves
   * only change through `peer.create`.
   * @param sessionId - Session to look up.
   * @returns the ceiling, or `undefined` when none was requested or clamped.
   */
  ceilingOf(sessionId: SessionId): number | undefined {
    const loaded = this.pairings.current()
    if (this.ceilingIndex?.bindings !== loaded.bindings) {
      this.ceilingIndex = { bindings: loaded.bindings, ceilings: ceilingsOf(loaded.bindings) }
    }
    return this.ceilingIndex.ceilings.get(sessionId)
  }

  /**
   * Watch one committed Session event for the token-ceiling enforcement lane.
   *
   * The durable `tokenUsage` projection advances only when an Assistant
   * message carrying provider usage commits, so checking on
   * `assistant/message` lets the in-flight request finish before the host
   * stops what follows. `turn/end` is the second trigger because a turn can
   * cross the ceiling on its final response with no later checkpoint. A
   * Session without a binding ceiling costs one in-memory lookup and returns
   * before any durable read.
   * @param session - the Session whose append produced the event.
   * @param event - the committed durable event.
   */
  private onSessionEvent(session: Session, event: SessionEvent): void {
    if (event.type !== 'assistant/message' && event.type !== 'turn/end') return
    const sessionId = session.id
    const ceiling = this.ceilingOf(sessionId)
    if (ceiling === undefined) return
    void this.checkBudget(sessionId, ceiling, event.data.turn)
  }

  /**
   * Enforce one Session's ceiling with at most one observation in flight.
   *
   * Events that arrive while the durable read is open collapse into one
   * trailing re-check, so a burst cannot multiply observations and the newest
   * read still decides. A turn already stopped is skipped, which keeps the
   * stop to one cancel per turn even when several events observe the same
   * over-budget state.
   * @param sessionId - Session to check.
   * @param ceiling - the Session's configured total-token ceiling.
   * @param turn - the turn the triggering event belongs to.
   */
  private async checkBudget(sessionId: SessionId, ceiling: number, turn: number): Promise<void> {
    if (this.budgetStopped.get(sessionId) === turn) return
    const inFlight = this.budgetChecks.get(sessionId)
    if (inFlight !== undefined) {
      inFlight.again = true
      inFlight.turn = turn
      return
    }
    const state = { again: true, turn, ceiling }
    this.budgetChecks.set(sessionId, state)
    try {
      while (state.again) {
        state.again = false
        await this.enforceBudget(sessionId, state.ceiling, state.turn)
      }
    } finally {
      this.budgetChecks.delete(sessionId)
    }
  }

  /**
   * Observe one Session's usage and stop its running turn when the ceiling is
   * reached. The stop is the Agent's own cancel with the durable
   * {@link PEER_BUDGET_STOP_REASON} hook cause, so the terminal it produces is
   * indistinguishable from a human stop only until the log is read: the fold
   * stamps `stop: 'budget'` solely from that marker.
   * @param sessionId - Session to check.
   * @param ceiling - the Session's configured total-token ceiling.
   * @param turn - the turn the triggering event belongs to.
   */
  private async enforceBudget(sessionId: SessionId, ceiling: number, turn: number): Promise<void> {
    if (this.budgetStopped.get(sessionId) === turn) return
    const budget = await this.budgetOf(sessionId, ceiling)
    if (budget?.exceeded !== true) return
    const agent = this.ctx.agents.get(sessionId)
    if (agent?.status !== 'running') return
    this.budgetStopped.set(sessionId, turn)
    try {
      agent.cancel({ kind: 'hook', reason: PEER_BUDGET_STOP_REASON }, { keepInbox: true })
    } catch {
      // The Agent detached between the status read and the stop: the turn is
      // already over, so there is nothing left to cancel.
      return
    }
    this.ctx.logger.warn(
      `peer-api: session ${sessionId} reached its token ceiling of ${String(ceiling)}; stopped turn ${String(turn)}`,
    )
  }

  /** Drop one Session's watcher bookkeeping when its Agent or Session is disposed. */
  private forgetBudgetStop(sessionId: SessionId): void {
    this.budgetStopped.delete(sessionId)
    this.budgetChecks.delete(sessionId)
  }

  /**
   * Read one Session's ceiling facts through a durable observation without
   * materializing its event log.
   * @param sessionId - Session to read.
   * @param ceiling - the Session's configured total-token ceiling.
   * @param signal - optional carrier cancellation for the read.
   * @returns the budget view, or `undefined` when the read or projection fails.
   */
  private async budgetOf(
    sessionId: SessionId,
    ceiling: number,
    signal?: AbortSignal,
  ): Promise<PeerExecutionState['budget']> {
    let observation: SessionObservation
    try {
      observation = await this.ctx.sessionQuery.observeSession(sessionId, {
        projectionMode: 'all',
        ...(signal === undefined ? {} : { signal }),
      })
    } catch {
      // The watcher guards committed appends and the prompt gate guards spend:
      // a transient observation failure must not become a host error. A prompt
      // falls through to the controller, which owns its own refusals.
      return undefined
    }
    try {
      return tokenBudgetOf(readTokenUsageProjection(observation.projections?.values), ceiling)
    } finally {
      observation[Symbol.dispose]()
    }
  }

  /** Install one resolved selection on a Session without touching the default. */
  private async applySelection(sessionId: SessionId, selection: PeerModelSelection): Promise<void> {
    await this.ctx.sessionController.selectModel({
      sessionId,
      provider: selection.provider,
      model: selection.model,
      ...(selection.chain === undefined ? {} : { chain: selection.chain }),
      ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }),
      persistDefault: false,
    })
  }

  /**
   * Refuse a switch on a Session that is not provably idle. The host latch is
   * authoritative when it answers; a cold Session falls back to the agent's
   * live status, because a running agent is never a safe switch target.
   */
  private requireIdleForSwitch(sessionId: SessionId): void {
    const hostLatch = this.hostLatchOf(sessionId)
    if (hostLatch !== undefined) {
      if (hostLatch.latch === 'idle') return
      throw new RemoteError(
        'peer/conflict',
        `session is ${hostLatch.latch}; a model switch requires an idle session`,
        { reason: 'busy', latch: hostLatch.latch },
      )
    }
    if (this.ctx.agents.get(sessionId)?.status === 'running') {
      throw new RemoteError(
        'peer/conflict',
        'session is running; a model switch requires an idle session',
        { reason: 'busy', latch: 'running' },
      )
    }
  }

  /** The Session's durable selection, when its log records one. */
  private async currentSelectionOf(sessionId: SessionId): Promise<PeerModelSelection | undefined> {
    const observation = await this.observe(sessionId)
    return readModelSelectionProjection(observation.projections)
  }

  /**
   * Admit one queued peer turn into a paired Session.
   * @param request - target, participant, dedupe id, text content, and hop telemetry.
   * @param signal - carrier cancellation before prompt admission begins.
   * @returns acceptance and the incremented hop count.
   * @throws {@link RemoteError} `peer/hop-limit` only when the pairing
   * configures a ceiling; `peer/forbidden` with reason `budget` once the
   * Session's token ceiling is reached.
   */
  @Remote('prompt')
  async prompt(request: PeerPromptRequest, signal: AbortSignal): Promise<PeerPromptValue> {
    const resolved = this.resolveTarget(request.target)
    const participant = requireParticipant(request.participant)
    const hopCount = request.hopCount ?? 0
    const hopCeiling = resolved.pairing.runawayCeiling
    if (hopCeiling !== undefined && hopCount >= hopCeiling) {
      throw new RemoteError(
        'peer/hop-limit',
        `peer hop budget ${String(hopCount)} reached the configured ceiling ${String(hopCeiling)}`,
        { hopCount, ceiling: hopCeiling },
      )
    }
    const content = requirePromptContent(request.content)
    // Refuse new peer spend once the binding's ceiling is reached. The check
    // costs one in-memory lookup for an uncapped Session; an unreadable
    // projection falls through to the Session Controller's own admission, so
    // the read can never become a second refusal authority.
    const ceiling = this.ceilingOf(resolved.sessionId)
    if (ceiling !== undefined) {
      const budget = await this.budgetOf(resolved.sessionId, ceiling, signal)
      if (budget?.exceeded === true) {
        throw new RemoteError('peer/forbidden', 'session token ceiling reached', {
          reason: 'budget',
          denied: String(ceiling),
        })
      }
    }
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
   * Settle a pending ask for a paired Session. An answer may resume a turn
   * the host paused on that ask; the ceiling watcher stops it after the next
   * response when the Session is already over budget.
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
    const records = page.records.flatMap(record => toPeerRecords(record.event, resolved.exposure))
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
            records: current.records.flatMap(record => toPeerRecords(record.event, resolved.exposure)),
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
        for (const peerRecord of toPeerRecords(entry.event, resolved.exposure)) {
          yield { type: 'event', record: peerRecord, cursor }
        }
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

  /**
   * Capabilities this host can serve right now. The ledger is build-wide, but
   * the routing trio needs a mounted `peerRouting` service and `token-ceiling`
   * needs the usage seam: advertising either without its seam would promise a
   * call the host refuses.
   */
  private advertisedCapabilities(): readonly PeerCapability[] {
    const routingServed = this.routingService() !== undefined
    const usageServed = this.hasTokenUsageSeam()
    return PEER_CAPABILITIES.filter(capability =>
      (routingServed || !ROUTING_CAPABILITIES.includes(capability))
      && (usageServed || !TOKEN_CEILING_CAPABILITIES.includes(capability)))
  }

  /**
   * Whether this host can read the durable `tokenUsage` projection. The token
   * meter registers that projection in its constructor, so the mounted service
   * is the cheapest honest probe: the registry exposes no key lookup and the
   * handshake has no Session to read.
   */
  private hasTokenUsageSeam(): boolean {
    return this.ctx.get('tokenMeter') !== undefined
  }

  /** The mounted routing seam, if this deployment has one. */
  private routingService(): PeerRoutingService | undefined {
    return this.ctx.get('peerRouting')
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
    const usage = readTokenUsageProjection(projections)
    const budget = tokenBudgetOf(usage, this.ceilingOf(sessionId))
    const state = fold.snapshot(this.registry.pendingFor(sessionId), hostLatch)
    // Durable selection, else the target's own default; peers never invent one.
    // `state.lastTurnEnd.ran` says which route actually answered the turn.
    const model = state.model
      ?? readModelSelectionProjection(projections)
      ?? this.ctx.agentDefaultModel.currentSelection()
    return {
      ...state,
      model,
      ...(usage === undefined ? {} : { usage }),
      ...(budget === undefined ? {} : { budget }),
    }
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

/** One compact latch line for `peer.list` rows. */
function latchSummary(latch: HostLatchFacts, pendingAskCount: number): string {
  const asks = pendingAskCount === 0 ? 'no asks' : `${String(pendingAskCount)} ask${pendingAskCount === 1 ? '' : 's'}`
  const descendants = latch.activeDescendants === 0
    ? ''
    : ` · ${String(latch.activeDescendants)} descendant${latch.activeDescendants === 1 ? '' : 's'}`
  const turn = latch.lastTurnEnd === undefined
    ? ''
    : ` · last turn ${String(latch.lastTurnEnd.turn)} ${latch.lastTurnEnd.reason}`
  return `${latch.latch} · ${asks}${descendants}${turn}`
}

/**
 * Map a failure from the create/adopt/routing stack into the peer vocabulary.
 * Peer-domain and transport-shape errors pass through unchanged; any deeper
 * code (`agent-preset/not-found`, `session/not-found`, …) becomes
 * `peer/not-found` with the original code preserved in `reason` and as cause.
 */
function createFailure(error: unknown, alias: PeerAlias): unknown {
  const code = errorCodeOf(error)
  if (error instanceof RemoteError && (code === 'gateway/bad-request' || code?.startsWith('peer/') === true)) {
    return error
  }
  const message = error instanceof Error ? error.message : String(error)
  return new RemoteError(
    'peer/not-found',
    `create for alias ${JSON.stringify(alias)} failed: ${code === undefined ? message : `${code} (${message})`}`,
    {
      alias,
      ...(code === undefined ? {} : { reason: code }),
    },
    { cause: error },
  )
}

/**
 * One routing refusal in the peer vocabulary. `denied` is only the offending
 * identifier, never an allow list; the message stays route-agnostic.
 */
function routingForbidden(reason: string, message: string, denied?: string): RemoteError {
  return new RemoteError('peer/forbidden', message, {
    reason,
    ...(denied === undefined ? {} : { denied }),
  })
}

/**
 * Translate a throw from the routing service into the peer vocabulary. The
 * only error with caller meaning is the service's plain `Error('invalid
 * cursor')`; everything else is a service fault that fails closed. The raw
 * message and stack never cross the wire because they can carry catalogue or
 * provider internals.
 */
function routingFailure(error: unknown): RemoteError {
  if (error instanceof Error && error.message === 'invalid cursor') {
    return new RemoteError('gateway/bad-request', 'invalid cursor', {})
  }
  return routingForbidden('routing-unavailable', 'the model routing service failed on this host')
}

/** Require the caller-minted request identity a switch dedupes on. */
function requireRequestId(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new RemoteError('gateway/bad-request', 'selectModel requires a non-empty requestId', {})
  }
  return value
}

/** Canonical SHA-256 of the four payload fields a switch hash covers. */
function selectionHash(request: PeerSelectModelRequest): string {
  return createHash('sha256')
    .update(JSON.stringify([
      request.provider,
      request.model,
      request.chain ?? null,
      request.reasoningEffort ?? null,
    ]))
    .digest('hex')
}

/** Read one thrown value's stable error code structurally; no class is assumed. */
function errorCodeOf(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const code: unknown = (error as { readonly code?: unknown }).code
  return typeof code === 'string' && code.length > 0 ? code : undefined
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

/**
 * Reverse the binding document into one ceiling per Session, including a
 * Session a later create retired. The first recorded ceiling wins, matching
 * the pairing store's own lookup order.
 * @param bindings - the loaded created-session bindings.
 * @returns Session id to recorded ceiling; Sessions without one are absent.
 */
function ceilingsOf(bindings: LoadedPeerPairings['bindings']): Map<SessionId, number> {
  const ceilings = new Map<SessionId, number>()
  const record = (sessionId: SessionId, ceiling: number | undefined): void => {
    if (ceiling !== undefined && !ceilings.has(sessionId)) ceilings.set(sessionId, ceiling)
  }
  for (const binding of Object.values(bindings)) {
    record(binding.sessionId, binding.maxTotalTokens)
    for (const retired of binding.retired ?? []) record(retired.sessionId, retired.maxTotalTokens)
  }
  return ceilings
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
