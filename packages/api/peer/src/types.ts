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
  readonly model?: PeerModelSelection
}

/** One durable event as the peer wire carries it; `seq` is contiguous per stream. */
export interface PeerEventRecord {
  readonly seq: SessionSeq
  readonly time: number
  readonly type: string
  readonly data: JsonValue
}

/** A capability the serving host advertises in its handshake. */
export type PeerCapability =
  | 'state-latch'
  | 'derived-latch'
  | 'assistant-stream'
  | 'answer-routing'
  | 'runaway-ceiling'
  | 'session-create'

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
  /** Allows an adopting `peer.create` to change routing (doc 69 §10.1); default off. */
  readonly allowModelChange?: boolean
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
    'peer/forbidden': { readonly reason?: string }
    /** An answer raced another participant's settled answer. */
    'peer/conflict': { readonly askId?: string }
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

/** One created-session binding persisted by the serving host (`~/.dsh/peer-state.json`). */
export interface PeerBinding {
  readonly sessionId: SessionId
  readonly device: PeerDeviceName
  readonly createdAt: number
}

/**
 * The whole created-session binding document (0600, versioned). Bindings are
 * written only by `peer.create`; the human-edited pairing file is never touched.
 */
export interface PeerBindingsFile {
  readonly version: 1
  readonly bindings: Readonly<Record<string, PeerBinding>>
}
