/**
 * Device-to-device peer API contract (doc 69 P2).
 *
 * One closed, narrow vocabulary shared by the serving side (a host that exposes
 * paired sessions) and the calling side (a device that drives, observes, and
 * answers them): the seven `peer.*` endpoint payloads, the pairing-file schema,
 * the execution-state latch and its degraded derivation, exposure, participant
 * attribution, and the error codes. Method names are fixed; every peer call
 * resolves through the target's pairing file and maps to `session.*` calls
 * behind a closed dispatch table, never by method-name pass-through.
 *
 * @module @deepseek-ai/dsh-api-peer/types
 */

import type { Branded } from '@deepseek-ai/dsh-brand'
import type { SessionId, SessionSeq } from '@deepseek-ai/dsh-session/types'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval/types'
import type { AskUserQuestionAnswer, AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions/types'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'

/**
 * Protocol generation of the peer API. A handshake whose `protocolVersion`
 * differs is rejected with `peer/version-skew`; the runtime constant lives in
 * the serving package entry, this literal type is the contract.
 */
export type PeerProtocolVersion = 1

/** Deterministic pairing alias; the `alias` half of a `device:alias` address. */
export type PeerAlias = Branded<'PeerAlias'>

/** Host-minted identity of one pending ask exposed to a peer call. */
export type PeerAskId = Branded<'PeerAskId'>

/** Logical device name (hostname or tailnet name); the `device` half of `device:alias`. */
export type PeerDeviceName = string

/** Caller-minted prompt identity, deduplicating one admitted peer turn. */
export type PeerRequestId = Branded<'peer-request-id'>

/**
 * What a pairing lets a peer observe. `answer-only` carries the durable
 * dialogue plus asks and terminals; `debug` adds tool/step/subagent internals
 * and, on request, assistant stream frames (doc 69 §9.1).
 */
export type PeerExposure = 'answer-only' | 'debug'

/**
 * Participant attribution stamped on every peer-originated durable record
 * (doc 69 §11). Structurally assignable to `ParticipantTag` from
 * `@deepseek-ai/dsh-llm` with `kind: 'peer'`; the host writes it into the
 * message `source.participant`.
 */
export interface PeerParticipant {
  readonly kind: 'peer'
  readonly name: string
  readonly device?: PeerDeviceName
}

/** Who acted, including local humans, for the participant-action records a peer stream carries. */
export type PeerActor =
  | PeerParticipant
  | { readonly kind: 'human'; readonly name: string; readonly device?: PeerDeviceName }

/** One inbound prompt part. P2 admits text only; attachments stay a later addition. */
export interface PeerPromptTextPart {
  readonly type: 'text'
  readonly text: string
}

/** Every prompt part a peer may send in P2. */
export type PeerPromptContentPart = PeerPromptTextPart

/**
 * Address a peer call resolves through the target's pairing file. An explicit
 * session id is accepted only when some pairing maps it; ambient addressing
 * ("the session I am working in") is rejected by design (doc 69 §8).
 */
export type PeerTarget =
  | { readonly kind: 'alias'; readonly alias: PeerAlias }
  | { readonly kind: 'session'; readonly sessionId: SessionId }

/** The pairing and session a peer call resolved to, echoed on every response. */
export interface PeerTargetResolved {
  readonly device: PeerDeviceName
  readonly sessionId: SessionId
  readonly exposure: PeerExposure
  readonly alias?: PeerAlias
}

/**
 * Authoritative aggregate execution state of one session (doc 69 §8
 * correction 3). `waiting_approval` also covers pending user questions: either
 * ask kind means a human must act before the turn can proceed.
 */
export type PeerLatch = 'running' | 'waiting_approval' | 'waiting_subagents' | 'idle'

/**
 * Structured turn failure carried verbatim from the target's durable
 * `turn/end{reason:'error'|'aborted'}` (doc 69 §12.1) so a peer sees the same
 * record the target UI renders.
 */
export interface PeerTurnError {
  readonly code: string
  readonly message: string
  readonly provider?: string
  readonly model?: string
}

/** One turn terminal with its durable reason, at the event time it committed. */
export interface PeerTurnTerminal {
  readonly turn: number
  readonly reason: 'completed' | 'aborted' | 'blocked' | 'error' | 'max-tokens' | 'interrupted'
  readonly at: number
  readonly error?: PeerTurnError
  /** The route that produced this turn's output, folded from the durable stream; absent when no model answered. */
  readonly ran?: PeerTurnModelReport
  /**
   * Set to `budget` only when the host's ceiling watcher stopped this turn.
   * The classification comes from the durable cancel marker, so it survives a
   * restart; a human or peer cancel of an over-budget turn is never stamped.
   */
  readonly stop?: 'budget'
}

/**
 * The model that actually answered one turn. With a rolling chain this can
 * differ from the selection: `model` is the route that produced the final
 * output and `hops` counts the failed routes tried before it in the same turn.
 */
export interface PeerTurnModelReport {
  readonly provider: string
  readonly model: string
  readonly chain?: string
  readonly hops: number
  readonly usage?: PeerTokenUsage
}

/** Token totals in the host's four disjoint buckets. The harness has no billing data, so cost is never reported. */
export interface PeerTokenUsage {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens: number
  readonly cacheWriteTokens: number
}

/** Why one route in a chain was left; closed vocabulary, never provider prose. */
export type PeerModelHopReason = 'rate-limit' | 'error' | 'cooldown' | 'unavailable'

/**
 * Payload of the synthetic `model-hop` record the peer stream carries (all
 * exposures). Derived from the durable chain-failure records; it never carries
 * provider messages, URLs, or request ids.
 */
export interface PeerModelHopData {
  readonly from: { readonly provider: string; readonly model: string }
  /** The next route tried; absent when the chain was exhausted. */
  readonly to?: { readonly provider: string; readonly model: string }
  readonly reason: PeerModelHopReason
  readonly chain?: string
  readonly at: number
}

/** One model selection in the target's own routing vocabulary (doc 69 §10.3). */
export interface PeerModelSelection {
  readonly provider: string
  readonly model: string
  readonly chain?: string
  readonly reasoningEffort?: string
}

/** One durable participant action the peer stream surfaces (doc 69 §11.2). */
export interface PeerParticipantAction {
  readonly action: 'prompt' | 'steer' | 'cancel' | 'queue-edit' | 'answer' | 'model-change' | 'create'
  readonly actor: PeerActor
  readonly at: number
  readonly detail?: string
}

/** One ask a peer may answer, correlated by the host-minted `askId`. */
export type PeerPendingAsk =
  | {
    readonly kind: 'approval'
    readonly askId: PeerAskId
    readonly toolName: string
    readonly callId?: string
    readonly reason?: string
    readonly since: number
  }
  | {
    readonly kind: 'question'
    readonly askId: PeerAskId
    readonly questions: readonly AskUserQuestionItem[]
    readonly since: number
  }

/**
 * Aggregate execution state a peer observes instead of crawling child streams.
 * `source` says whether a host-owned latch produced it or whether it was
 * derived from the durable stream; `descendantsExact` is false when derivation
 * cannot prove descendant liveness (quiet children stay parent-invisible).
 */
export interface PeerExecutionState {
  readonly latch: PeerLatch
  readonly since: number
  readonly source: 'host-latch' | 'derived'
  readonly activeDescendants: number
  readonly descendantsExact: boolean
  readonly pendingAsks: readonly PeerPendingAsk[]
  readonly lastTurnEnd?: PeerTurnTerminal
  readonly lastParticipantAction?: PeerParticipantAction
  /**
   * The Session's current model selection (what the next request is configured
   * to run). The route that actually produced the last turn is
   * `lastTurnEnd.ran`; a rolling chain can make the two differ.
   */
  readonly model?: PeerModelSelection
  /** Session token totals from the durable usage projection; absent when none is recorded. */
  readonly usage?: PeerTokenUsage
  /**
   * The session's token ceiling and whether it was reached; absent without a
   * ceiling. `metered` is true only when the durable `tokenUsage` projection
   * was actually read for this session: with a ceiling but no readable usage
   * the host reports `{ usedTokens: 0, exceeded: false, metered: false }`
   * instead of claiming the ceiling is enforced. A host without the usage seam
   * refuses a create that asks for a ceiling (`peer/forbidden` reason
   * `budget-unmetered`).
   */
  readonly budget?: {
    readonly maxTotalTokens: number
    readonly usedTokens: number
    readonly exceeded: boolean
    readonly metered: boolean
  }
  /**
   * Newest chain hops the fold retains (bounded; see `RECENT_MODEL_HOPS_LIMIT`),
   * oldest first. Hops older than the window stay available as durable
   * `model-hop` records through `peer.follow`/`peer.page`.
   */
  readonly recentModelHops?: readonly PeerModelHopData[]
}

/**
 * One durable event as the peer wire carries it. `seq` is the durable position
 * of the source event; a derived record such as `model-hop` shares the seq of
 * the event it was projected from, so a `debug` window can carry two records at
 * one position (the raw failure and its synthetic hop).
 */
export interface PeerEventRecord {
  readonly seq: SessionSeq
  readonly time: number
  readonly type: string
  readonly data: JsonValue
}

/**
 * A capability the serving host advertises in its handshake. The union is the
 * full contract; a host advertises the subset it serves, and the serving
 * package's capability ledger marks each member served or planned. A peer must
 * not assume an unadvertised capability (for example `assistant-stream`, which
 * `peer.follow` serves only under `debug` exposure and opt-in).
 */
export type PeerCapability =
  | 'state-latch'
  | 'derived-latch'
  | 'assistant-stream'
  | 'answer-routing'
  | 'runaway-ceiling'
  | 'session-create'
  /** `peer.models`: policy-filtered provider/model/chain discovery. Served only when a routing service exists. */
  | 'model-discovery'
  /** `peer.create` accepts routing fields, evaluated against the pairing's `routing` policy. */
  | 'model-routing-at-create'
  /** `peer.selectModel`: idle-only switch between tasks. Served only when a routing service exists. */
  | 'model-switch'
  /** Turn terminals carry the model that ran and `model-hop` records are streamed. */
  | 'model-attribution'
  /**
   * `peer.create` accepts `maxTotalTokens`; the host stops the session at the
   * ceiling. Advertised only while the host can read the durable `tokenUsage`
   * projection (the token-meter service); a host without it refuses a create
   * that needs a ceiling.
   */
  | 'token-ceiling'

/** One pairing as the serving host reports it; never carries a token. */
export interface PeerPairingSummary {
  readonly alias: PeerAlias
  readonly peer: PeerDeviceName
  readonly exposure: PeerExposure
  readonly tokenRequired: boolean
  readonly target?: PeerTargetResolved
}

// ── Endpoint payloads ────────────────────────────────────────────────────────

/** `peer.handshake` request: the caller's protocol, build, and schema identity. */
export interface PeerHandshakeRequest {
  readonly protocolVersion: number
  readonly harnessVersion: string
  readonly schemaDigest: string
  readonly device: PeerDeviceName
}

/** `peer.handshake` value: the host's identity, capabilities, and visible pairings. */
export interface PeerHandshakeValue {
  readonly protocolVersion: PeerProtocolVersion
  readonly harnessVersion: string
  readonly schemaDigest: string
  readonly hostDevice: PeerDeviceName
  readonly capabilities: readonly PeerCapability[]
  readonly pairings: readonly PeerPairingSummary[]
}

/** `peer.state` request: one resolved target. */
export interface PeerStateRequest {
  readonly target: PeerTarget
}

/** `peer.state` value: the latch folded through `cursor`. */
export interface PeerStateValue {
  readonly target: PeerTargetResolved
  readonly state: PeerExecutionState
  readonly cursor: SessionSeq
}

/**
 * `peer.list` request: discovery over the host's pairing table. An absent
 * target lists every pairing; a supplied target resolves first, so a caller
 * pinned to one session can ask whether it is still bound.
 */
export interface PeerListRequest {
  readonly target?: PeerTarget
}

/** One pairing row `peer.list` reports with its cheap live summary. */
export interface PeerListEntry {
  readonly alias: PeerAlias
  readonly peer: PeerDeviceName
  readonly exposure: PeerExposure
  /** Whether the alias resolves to a Session right now (own pin or created binding). */
  readonly bound: boolean
  /** Session this host exposes for the pairing; the caller's `remoteSessionId`. */
  readonly sessionId?: SessionId
  /** The pairing's caller-role pin, echoed when the shared document declares one. */
  readonly remoteSessionId?: SessionId
  /** Host latch, present only for a bound Session that has a live execution state. */
  readonly latch?: PeerLatch
  /** Last activity time (epoch ms) the host latch carries without a durable scan. */
  readonly lastActivity?: number
  /** One-line latch summary for compact callers (`latch · asks · last turn`). */
  readonly summary: string
}

/** `peer.list` value: the serving host's device name and one row per pairing. */
export interface PeerListValue {
  readonly hostDevice: PeerDeviceName
  readonly pairings: readonly PeerListEntry[]
}

/** `peer.create` request: bind a fresh or explicitly adopted session to a pairing alias. */
export interface PeerCreateRequest {
  readonly alias: PeerAlias
  readonly participant: PeerParticipant
  readonly sessionId?: SessionId
  readonly workspaceId?: string
  readonly cwd?: string
  readonly agentPreset?: string
  readonly provider?: string
  readonly model?: string
  readonly chain?: string
  readonly reasoningEffort?: string
  /**
   * Total-token ceiling for the created session (sum of the four usage
   * buckets). Enforced by the host after each model response: an in-flight
   * request may finish, then the session is stopped with `stop: 'budget'`.
   * There is deliberately no cost ceiling: the harness has no billing data.
   */
  readonly maxTotalTokens?: number
}

/** `peer.create` value: `created` is false when an existing session was adopted. */
export interface PeerCreateValue {
  readonly target: PeerTargetResolved
  readonly created: boolean
}

/**
 * `peer.prompt` request: one inbound turn. Mode is fixed to `queue` so a human
 * message always preempts a peer (doc 69 §8); steer is not part of this API.
 */
export interface PeerPromptRequest {
  readonly target: PeerTarget
  readonly participant: PeerParticipant
  readonly requestId: PeerRequestId
  readonly content: readonly PeerPromptContentPart[]
  /** Telemetry only (doc 69 §9.3): incremented by each forwarding bridge, never enforced unless a ceiling is configured. */
  readonly hopCount?: number
}

/** `peer.prompt` value: the turn entered the target inbox. */
export interface PeerPromptValue {
  readonly accepted: true
  readonly queued: boolean
  readonly hopCount: number
}

/** `peer.cancel` request: cancel the target's active turn, attributed to the peer. */
export interface PeerCancelRequest {
  readonly target: PeerTarget
  readonly participant: PeerParticipant
}

/** `peer.cancel` value: `cancelled` is false when no turn was active. */
export interface PeerCancelValue {
  readonly accepted: true
  readonly cancelled: boolean
}

/** Outcomes a peer may grant. A peer never grants `allowed-always` (doc 69 §2). */
export type PeerApprovalOutcome = Extract<ApprovalOutcome, 'allowed-once' | 'rejected'>

/** One peer answer to a pending ask, discriminated by the ask kind. */
export type PeerAnswer =
  | { readonly kind: 'approval'; readonly outcome: PeerApprovalOutcome }
  | { readonly kind: 'question'; readonly answer: AskUserQuestionAnswer }

/** `peer.answer` request: settle the ask behind `askId`; races lose with `peer/conflict`. */
export interface PeerAnswerRequest {
  readonly target: PeerTarget
  readonly participant: PeerParticipant
  readonly askId: PeerAskId
  readonly answer: PeerAnswer
}

/** `peer.answer` value: the answer settled the ask. */
export interface PeerAnswerValue {
  readonly accepted: true
  readonly settled: true
}

/** `peer.page` request: backwards history repair from a follow opening cut (doc 69 §12.3). */
export interface PeerPageRequest {
  readonly target: PeerTarget
  readonly throughSeq: SessionSeq
  readonly beforeSeq?: SessionSeq
  readonly maxMessages?: number
}

/** `peer.page` value: one contiguous backwards window of the exposure-filtered stream. */
export interface PeerPageValue {
  readonly records: readonly PeerEventRecord[]
  readonly hasMore: boolean
}

/** `peer.follow` request: opening snapshot then live frames, filtered by exposure. */
export interface PeerFollowRequest {
  readonly target: PeerTarget
  readonly maxMessages?: number
  /** Debug exposure only; `answer-only` rejects the stream with `peer/forbidden`. */
  readonly assistantStream?: true
}

/** Opening frame: resolved target, wire header, latch, cursor, and a bounded recent window. */
export interface PeerFollowSnapshotFrame {
  readonly type: 'snapshot'
  readonly target: PeerTargetResolved
  readonly header: {
    readonly id: SessionId
    readonly version: number
    readonly createdAt: number
    readonly cwd?: string
    readonly agentPreset?: string
  }
  readonly cursor: SessionSeq
  readonly state: PeerExecutionState
  readonly records: readonly PeerEventRecord[]
  readonly hasMore: boolean
}

/**
 * One durable event frame. `record.seq` is the durable position of the visible
 * record; `cursor` is the durable position the host has scanned, which advances
 * across exposure-filtered events and is authoritative for `peer.page` repair.
 */
export interface PeerFollowEventFrame {
  readonly type: 'event'
  readonly record: PeerEventRecord
  readonly cursor: SessionSeq
}

/** One latch transition frame, emitted on every change of the execution state. */
export interface PeerFollowStateFrame {
  readonly type: 'state'
  readonly state: PeerExecutionState
  readonly cursor: SessionSeq
}

/** One opted-in assistant stream frame (debug exposure only). */
export interface PeerFollowAssistantStreamFrame {
  readonly type: 'assistant-stream'
  readonly frame: JsonValue
}

/** Terminal frame: the host closed the stream; callers re-follow and repair with `peer.page`. */
export interface PeerFollowEndFrame {
  readonly type: 'end'
  readonly reason: 'closed' | 'target-detached'
}

/** Every frame a `peer.follow` stream carries. */
export type PeerFollowFrame =
  | PeerFollowSnapshotFrame
  | PeerFollowEventFrame
  | PeerFollowStateFrame
  | PeerFollowAssistantStreamFrame
  | PeerFollowEndFrame

// ── Pairing file schema ──────────────────────────────────────────────────────

/** Defaults stamped on a session a peer creates through an alias (doc 69 §10.2). */
export interface PeerCreateDefaults {
  readonly workspaceId?: string
  readonly cwd?: string
  readonly agentPreset?: string
}

/**
 * One pairing entry in `~/.dsh/pairings.yaml`. An entry describes this host's
 * side of a link: `sessionId`/`create` are the sessions peers may address on
 * this host (target role), `remoteSessionId`/`endpoint` are what this host
 * calls on `peer` (caller role). `dsh update` renders the document from the
 * profile fleet registry (`profile/web/scripts/generate-pairings.mjs`), and a
 * pairing uses the same alias string in both devices' files.
 */
export interface PeerPairing {
  readonly alias: PeerAlias
  readonly peer: PeerDeviceName
  /** What this host exposes for its own `sessionId`; required so no pairing is implicitly debug. */
  readonly exposure: PeerExposure
  /** This host's session bound to the pairing; absent with `create` for a peer-created session. */
  readonly sessionId?: SessionId
  /** Present when a peer may create (or adopt) a session under this alias. */
  readonly create?: PeerCreateDefaults
  /** The session on `peer` this host calls; caller-role bookkeeping only. */
  readonly remoteSessionId?: SessionId
  /** Base URL of `peer`'s peer surface; caller-role addressing. */
  readonly endpoint?: string
  /** Reserved for doc 69 §8 correction 1; never verified on the host yet (the peer path reads no request headers). */
  readonly token?: string
  /** Optional emergency stop (doc 69 §9.3); absent means unbounded agent-to-agent exchange. */
  readonly runawayCeiling?: number
  /** Allows an adopting `peer.create` to change routing (doc 69 §10.1); default off. Legacy: ignored when `routing` is present. */
  readonly allowModelChange?: boolean
  /** Remote model-selection policy. When present it is authoritative for create, adopt, discovery, and switch. */
  readonly routing?: PeerRoutingPolicy
}

/**
 * What a paired controller may select. Validated strictly (unknown keys are a
 * configuration error). An empty `allowChains` and `allowModels` selects
 * nothing. Patterns match `provider/model` with `*` as the only wildcard
 * (any run of characters, `/` included), anchored at both ends.
 */
export interface PeerRoutingPolicy {
  readonly allowChains?: readonly string[]
  readonly allowModels?: readonly string[]
  /** Refuse any route the catalogue cannot prove is zero-price (unknown price is refused). */
  readonly requireZeroPrice?: boolean
  /** Refuse any route not proven to avoid training on prompts (`unknown` is refused). */
  readonly requireNoTraining?: boolean
  /** Refuse any route the catalogue cannot prove has tool calling (`unknown` is refused as `tools-unproven`). */
  readonly requireTools?: boolean
  /** Reasoning efforts a caller may name; absent allows any effort the model supports. */
  readonly allowReasoningEfforts?: readonly string[]
  /** `idle-only` lets `peer.selectModel` switch an idle session; `never` (default) refuses it. */
  readonly allowSwitch?: 'never' | 'idle-only'
  /** Upper bound on a caller's `maxTotalTokens`; a create above it is refused, one without it is capped to it. */
  readonly maxTotalTokens?: number
}

// ── Model discovery and switch ───────────────────────────────────────────────

/** Tri-state fact the catalogue may not know; never guessed. */
export type PeerKnown = boolean | 'unknown'

/** One selectable route with the facts a controller needs to choose it. */
export interface PeerModelInfo {
  readonly provider: string
  readonly model: string
  readonly tools: PeerKnown
  readonly vision: PeerKnown
  readonly contextWindow?: number
  readonly zeroPrice: PeerKnown
  readonly gated: PeerKnown
  readonly trainsOnData: 'yes' | 'no' | 'unknown'
  readonly reasoningEfforts: readonly string[]
}

/** One chain a controller may select, with its currently resolved members. */
export interface PeerChainInfo {
  readonly id: string
  readonly label?: string
  /** True when membership is re-resolved from the catalogue (adopt chains). */
  readonly dynamic: boolean
  readonly members: readonly {
    readonly provider: string
    readonly model: string
    /**
     * Live member state. `deprecated` means the catalogue kept the record only
     * for a route-local reference after the endpoint dropped it, so selecting
     * the chain is refused and naming this member is `model-not-allowed`;
     * `cooldown` is temporary and ready again once `cooldownUntil` passes.
     */
    readonly state: 'ready' | 'cooldown' | 'deprecated'
    readonly cooldownUntil?: number
  }[]
}

/** Optional narrowing a caller may apply on top of the pairing policy. */
export interface PeerModelsFilter {
  readonly zeroPrice?: boolean
  readonly tools?: boolean
  readonly gated?: boolean
  readonly minContextWindow?: number
}

/** `peer.models` request: policy-filtered discovery for one alias. */
export interface PeerModelsRequest {
  readonly alias: PeerAlias
  readonly participant: PeerParticipant
  readonly filter?: PeerModelsFilter
  /** Opaque cursor from a previous page. */
  readonly cursor?: string
  /** Page size for `models`; clamped by the host. */
  readonly limit?: number
}

/** `peer.models` value. Only routes the alias may select are returned; no credentials, URLs, or error text. */
export interface PeerModelsValue {
  readonly chains: readonly PeerChainInfo[]
  readonly models: readonly PeerModelInfo[]
  readonly nextCursor?: string
  /** The policy as configured, echoed so the controller sees what it may choose. */
  readonly selectableByThisAlias: {
    readonly chains: readonly string[]
    readonly models: readonly string[]
    readonly reasoningEfforts?: readonly string[]
    readonly requireZeroPrice: boolean
    readonly requireNoTraining: boolean
    readonly requireTools: boolean
    readonly allowSwitch: 'never' | 'idle-only'
  }
}

/** `peer.selectModel` request: switch one idle session's routing for its next turn. */
export interface PeerSelectModelRequest {
  readonly target: PeerTarget
  readonly participant: PeerParticipant
  /** Dedupes the call; the same id with a changed payload is a `peer/conflict`. */
  readonly requestId: PeerRequestId
  readonly provider: string
  readonly model: string
  readonly chain?: string
  readonly reasoningEffort?: string
}

/** `peer.selectModel` value; a replay of the same request returns the original with `replayed: true`. */
export interface PeerSelectModelValue {
  readonly accepted: true
  readonly selected: PeerModelSelection
  readonly previous?: PeerModelSelection
  readonly replayed: boolean
}

/** Verdict of evaluating one selection against a pairing's routing policy. */
export type PeerRoutingVerdict =
  | { readonly allowed: true; readonly selection: PeerModelSelection }
  | {
    readonly allowed: false
    readonly reason: 'chain-not-allowed' | 'model-not-allowed' | 'price-unproven' | 'training-unproven' | 'tools-unproven' | 'effort-not-allowed' | 'unknown-route'
    /** The identifier that was refused (`provider/model` or chain id); never the allow list. */
    readonly denied: string
  }

/**
 * Structural seam the peer host consumes through `ctx.get('peerRouting')`. The
 * profile owns the catalogue, selector rules, chain registry, and route health;
 * the peer package owns transport, pairing, and exposure. A host without this
 * service serves neither `model-discovery` nor `model-switch`, and refuses any
 * routing request on a pairing that carries a `routing` policy.
 */
export interface PeerRoutingService {
  /**
   * Policy-filtered discovery. Must not return credentials, URLs, or provider error text.
   * @param policy - the pairing's routing policy; runtime selection uses the host-attested copy.
   * @param request - optional filters plus opaque pagination cursor and page size.
   * @returns allowed chains and models, with the next cursor when more rows follow.
   */
  discover(policy: PeerRoutingPolicy, request: {
    readonly filter?: PeerModelsFilter
    readonly cursor?: string
    readonly limit?: number
  }): Promise<{
    readonly chains: readonly PeerChainInfo[]
    readonly models: readonly PeerModelInfo[]
    readonly nextCursor?: string
  }>
  /**
   * Evaluate one requested selection; resolves chain members and catalogue
   * facts at call time. A chain-only request carries empty `provider` and
   * `model` strings, and the verdict answers the concrete route to apply.
   * @param policy - the pairing's routing policy; runtime selection uses the host-attested copy.
   * @param selection - the requested route or chain, as the controller sent it.
   * @returns the applied route, or a closed refusal reason naming the denied identifier.
   */
  evaluate(policy: PeerRoutingPolicy, selection: PeerModelSelection): Promise<PeerRoutingVerdict>
}

/**
 * The whole `~/.dsh/pairings.yaml` document (0600; loaded and validated on
 * start and on change). `watchdogMs` gates the orphan-parking abort from
 * doc 69 §8; omitted uses 15 minutes.
 */
export interface PeerPairingsFile {
  readonly version: 1
  readonly device: PeerDeviceName
  readonly watchdogMs?: number
  readonly pairings: readonly PeerPairing[]
}

// ── Errors ───────────────────────────────────────────────────────────────────

/**
 * The closed peer failure vocabulary. `peer/target-unreachable` is raised by
 * the calling side when the target host cannot be reached at all (fail-fast,
 * doc 69 §12.4); the serving side never returns it. `peer/hop-limit` is
 * returned only when the resolved pairing configures `runawayCeiling`.
 */
export type PeerErrorCode =
  | 'peer/not-paired'
  | 'peer/not-found'
  | 'peer/forbidden'
  | 'peer/conflict'
  | 'peer/gap'
  | 'peer/hop-limit'
  | 'peer/version-skew'
  | 'peer/target-unreachable'

/** One structured peer failure: a stable code plus a human-readable message. */
export interface PeerError {
  readonly code: PeerErrorCode
  readonly message: string
  readonly details?: JsonValue
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** The target or alias does not resolve through the serving host's pairing file. */
    'peer/not-paired': { readonly alias?: string; readonly sessionId?: SessionId }
    /** A paired target has no such session, or the ask id is unknown or expired. */
    'peer/not-found': { readonly sessionId?: SessionId; readonly askId?: string; readonly alias?: string; readonly reason?: string }
    /** Exposure or pairing permission refuses the operation. */
    'peer/forbidden': { readonly reason?: string; readonly denied?: string }
    /**
     * An answer raced another participant's settled answer, a switch hit a busy
     * session, or a request id was reused with a different payload.
     */
    'peer/conflict': { readonly askId?: string; readonly reason?: string; readonly latch?: string }
    /** A follow generation cannot prove durable contiguity; repair with `peer.page`. */
    'peer/gap': { readonly expectedSeq?: number; readonly observedSeq?: number }
    /** The pairing's configured emergency hop ceiling refused the prompt. */
    'peer/hop-limit': { readonly hopCount?: number; readonly ceiling?: number }
    /** Handshake protocol or schema divergence. */
    'peer/version-skew': { readonly expected?: number; readonly received?: number; readonly schemaDigest?: string }
    /** Caller-side outcome: the target host could not be reached; the caller owns backoff. */
    'peer/target-unreachable': { readonly endpoint?: string }
  }
}

/**
 * One superseded alias binding. `peer.create` replaces the alias's current
 * binding; the previous session is retained here so an explicit `PeerTarget`
 * for it stays page-able through the same pairing.
 */
export interface RetiredPeerBinding {
  readonly sessionId: SessionId
  readonly device: PeerDeviceName
  readonly createdAt: number
  readonly retiredAt: number
  /** Token ceiling the retired session was created with; absent when none was set. */
  readonly maxTotalTokens?: number
}

/**
 * One alias's current created-session binding, persisted by the serving host
 * in `~/.dsh/peer-state.json`, plus the sessions it replaced.
 */
export interface PeerBinding {
  readonly sessionId: SessionId
  readonly device: PeerDeviceName
  readonly createdAt: number
  /** Earlier sessions this alias was bound to, newest last; empty when never rebound. */
  readonly retired?: readonly RetiredPeerBinding[]
  /**
   * Total-token ceiling recorded for the bound session, requested or clamped at
   * create time. Absent when the create named none and the pairing policy caps
   * none; `PeerService.ceilingOf` reads it for the enforcement lane.
   */
  readonly maxTotalTokens?: number
}

/**
 * The whole created-session binding document (0600, versioned). Bindings are
 * written only by `peer.create`; the human-edited pairing file is never touched.
 */
export interface PeerBindingsFile {
  readonly version: 1
  readonly bindings: Readonly<Record<string, PeerBinding>>
}
