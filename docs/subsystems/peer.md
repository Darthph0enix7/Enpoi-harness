# Peer Interconnect

English | [中文](peer.zh.md)

The device-to-device peer seam of [`@deepseek-ai/dsh-api-peer`](../../packages/api/peer). One host exposes a narrow `peer` namespace — `handshake`, `list`, `state`, `create`, `prompt`, `cancel`, `answer`, `page`, `follow` — that maps onto `session.*` operations behind a closed dispatch table; the other device drives and observes paired Sessions through it. Pairing is the addressing boundary: every call resolves its `PeerTarget` through the host's pairing table first, so only Sessions named there are audible, and exposure filtering, participant validation, the hop ceiling, and the orphan watchdog are applied host-side, never by the caller.

Source: [`packages/api/peer/src/host.ts`](../../packages/api/peer/src/host.ts)

## Host service and configuration

`ctx.peerService` is `PeerService`, a `TypertRemoteService` mounted under the `peer` namespace. It injects `agentDefaultModel`, `agents`, `sessionController`, and `sessionQuery`, loads the pairing document in its constructor (a malformed document fails the load loudly), installs the ask registry, and clears every orphan-watchdog timer on disposal.

```ts
/** Peer API deployment policy. */
interface Config {
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
```

The runtime constants are `PEER_PROTOCOL_VERSION = 1`, `DEFAULT_WATCHDOG_MS = 15 * 60 * 1000`, and `DEFAULT_HARNESS_VERSION = '0.1.6-alpha.2'`; `PEER_SCHEMA_DIGEST` is the SHA-256 of the protocol version plus the fixed method list. The handshake advertises the capabilities `state-latch`, `derived-latch`, `answer-routing`, `session-create`, and `runaway-ceiling`. The `PeerCapability` vocabulary also names `assistant-stream`, but this build does not advertise it — the feature is reachable only through the `follow` request flag.

## Pairing model

Two documents define the boundary. The human-edited pairing document (`~/.dsh/pairings.yaml`, 0600) describes this host's side of each link; created-session bindings live in a separate machine-written document (`~/.dsh/peer-state.json`, 0600, atomic replacement) that `peer.create` alone writes. `PeerPairingsStore.load()` re-reads the pairing file whenever its mtime or size changes; a reload that fails validation keeps the previous valid snapshot, a vanished file withdraws exposure (empty pairing table, device name falls back to the host name), and a malformed first load throws `PeerConfigError` rather than degrading to an empty table.

```ts
/**
 * Address a peer call resolves through the target's pairing file. An explicit
 * session id is accepted only when some pairing maps it; ambient addressing
 * ("the session I am working in") is rejected by design (doc 69 §8).
 */
type PeerTarget =
  | { readonly kind: 'alias'; readonly alias: PeerAlias }
  | { readonly kind: 'session'; readonly sessionId: SessionId }
```

```ts
/** The pairing and session a peer call resolved to, echoed on every response. */
interface PeerTargetResolved {
  readonly device: PeerDeviceName
  readonly sessionId: SessionId
  readonly exposure: PeerExposure
  readonly alias?: PeerAlias
}

/**
 * What a pairing lets a peer observe. `answer-only` carries the durable
 * dialogue plus asks and terminals; `debug` adds tool/step/subagent internals
 * and, on request, assistant stream frames (doc 69 §9.1).
 */
type PeerExposure = 'answer-only' | 'debug'
```

An alias resolves to the pairing's `sessionId`, or to the binding `peer.create` persisted under that alias; an explicit `sessionId` resolves through a pairing that names it directly or through any binding that does. The wire target carries no peer discriminator, so the loader rejects a repeated alias across entries (`peer pairings ... repeats alias`) — uniqueness is per host, not per peer.

The one pairing entry shape hosts and peers share is `PeerPairing`; `create` is present exactly when peers may create or adopt a Session under the alias.

```ts
/** One pairing entry in `~/.dsh/pairings.yaml` (this host's side of a link). */
interface PeerPairing {
  readonly alias: PeerAlias
  readonly peer: PeerDeviceName
  /** What this host exposes for its own `sessionId`; required, no implicit default. */
  readonly exposure: PeerExposure
  /** This host's session bound to the pairing; absent with `create` for a peer-created session. */
  readonly sessionId?: SessionId
  /** Present when a peer may create (or adopt) a session under this alias. */
  readonly create?: PeerCreateDefaults
  /** The session on `peer` this host calls; caller-role bookkeeping only. */
  readonly remoteSessionId?: SessionId
  /** Base URL of `peer`'s peer surface; caller-role addressing. */
  readonly endpoint?: string
  /** Reserved; never verified on the host (the peer path reads no request headers). */
  readonly token?: string
  /** Optional emergency stop; absent means unbounded agent-to-agent exchange. */
  readonly runawayCeiling?: number
  /** Allows an adopting `peer.create` to change routing; default off. */
  readonly allowModelChange?: boolean
}

/** The whole `~/.dsh/pairings.yaml` document (0600; loaded and validated on start and on change). */
interface PeerPairingsFile {
  readonly version: 1
  readonly device: PeerDeviceName
  readonly watchdogMs?: number
  readonly pairings: readonly PeerPairing[]
}
```

- `alias` matches `[A-Za-z0-9._-]+` and must be unique per host.
- `exposure` is required; there is no implicit default, so no pairing is implicitly `debug`.
- At least one of `sessionId` and `create` must be present, or the entry is unreachable and rejected at load.
- `watchdogMs` and `runawayCeiling` must be positive safe integers when present.
- `token` is parsed and reported only as `tokenRequired` in the handshake summary; it is never echoed and never enforced in this package.
- Bindings are keyed by alias and carry `{sessionId, device, createdAt}`; a malformed binding document throws `PeerConfigError`.

## Exposure filter

Filtering happens on the host while records and frames are produced, so an `answer-only` stream can never contain tool, step, subagent, or injection data. The decision function is `isExposedEvent(type, data, exposure)`; `toPeerRecord` applies it to durable events, and `follow` applies it to snapshot and event records alike.

| Event family | `answer-only` | `debug` |
|---|---|---|
| `assistant/message`, `turn/start`, `turn/end`, `approval/asked`, `approval/decided` | visible | visible |
| `user/message` whose `source.kind` is `user`, `user-rpc`, `webhook`, `agent-message`, `subagent-settled`, or `team-message`, or that carries no `source` | visible | visible |
| every other durable type (`tool/call`, `tool/result`, `step/*`, `assistant/attempt`, `subagent/*`, `goal/*`, `compaction/*`, `revert/*`, `model/selection`, `session/title`, …) | filtered | visible |
| `assistant-stream` frames (opt-in on `follow`) | `peer/forbidden` | visible |

## Handshake

`handshake` is the only method reachable without a pairing. It negotiates protocol generation and reports the host's identity, capabilities, and visible pairings.

```ts
/** `peer.handshake` request: the caller's protocol, build, and schema identity. */
interface PeerHandshakeRequest {
  readonly protocolVersion: number
  readonly harnessVersion: string
  readonly schemaDigest: string
  readonly device: PeerDeviceName
}

/** `peer.handshake` value: the host's identity, capabilities, and visible pairings. */
interface PeerHandshakeValue {
  readonly protocolVersion: PeerProtocolVersion
  readonly harnessVersion: string
  readonly schemaDigest: string
  readonly hostDevice: PeerDeviceName
  readonly capabilities: readonly PeerCapability[]
  readonly pairings: readonly PeerPairingSummary[]
}
```

`protocolVersion` is the hard compatibility gate: any value other than `1` throws `peer/version-skew` with the expected and received values before any other handshake work. `harnessVersion` and `schemaDigest` are advisory values the host returns for the caller's own comparison, so a differing digest at a matching protocol version is accepted. `device` must be a non-empty string (`gateway/bad-request` otherwise). Each pairing in the reply is a `PeerPairingSummary` of alias, peer, exposure, `tokenRequired`, and — when the alias currently resolves to a Session — the resolved target.

## Discovery

`list` is the read-only discovery call. Without a target it reports every pairing the host exposes; with a `target` it resolves that target through the same pairing gate as every other call (`peer/not-paired` when it does not resolve) and returns only that pairing. Each row carries the alias, peer, and exposure, whether the alias resolves to a Session right now, the bound session id — the caller's `remoteSessionId`, from the pairing's own pin or the `peer.create` binding — and, when `sessionController.executionState` answers cheaply for the bound Session, the host latch, a last-activity time, and a one-line summary (`latch · asks · last turn`). A pin declared only as the pairing's caller-role `remoteSessionId` also resolves an explicit `peer.state`/`peer.list` session target, so a shared document authored from the other device's side stays addressable without granting an arbitrary session id.

```ts
/** `peer.list` request: an absent target lists every pairing; a target narrows the answer. */
interface PeerListRequest { readonly target?: PeerTarget }

/** One pairing row `peer.list` reports. */
interface PeerListEntry {
  readonly alias: PeerAlias
  readonly peer: PeerDeviceName
  readonly exposure: PeerExposure
  readonly bound: boolean
  readonly sessionId?: SessionId
  readonly remoteSessionId?: SessionId
  readonly latch?: PeerLatch
  readonly lastActivity?: number
  readonly summary: string
}

/** `peer.list` value: the serving host's device name and one row per pairing. */
interface PeerListValue {
  readonly hostDevice: PeerDeviceName
  readonly pairings: readonly PeerListEntry[]
}
```

## Sessions: create, prompt, cancel

`create` requires the addressed pairing to carry a `create` block (`peer/not-paired` otherwise). With an explicit `sessionId` that already exists, the Session is adopted and `created` is false; routing fields on an adoption are refused with `peer/forbidden` unless the pairing sets `allowModelChange: true`. Otherwise the Session is created through `sessionController.create`, with the request's `workspaceId`, `cwd`, and `agentPreset` falling back to the pairing's `create` defaults, and the alias→session binding is persisted.

```ts
/** `peer.create` request: bind a fresh or explicitly adopted session to a pairing alias. */
interface PeerCreateRequest {
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
interface PeerCreateValue {
  readonly target: PeerTargetResolved
  readonly created: boolean
}
```

Routing on a create is applied through `sessionController.selectModel` with `persistDefault: false`, so a peer's routing affects that Session and never the deployment default; `provider` and `model` must be supplied together (`gateway/bad-request`). Every create records a host-local `create` participant action for the resolved Session.

```ts
/**
 * `peer.prompt` request: one inbound turn. Mode is fixed to `queue` so a human
 * message always preempts a peer (doc 69 §8); steer is not part of this API.
 */
interface PeerPromptRequest {
  readonly target: PeerTarget
  readonly participant: PeerParticipant
  readonly requestId: PeerRequestId
  readonly content: readonly PeerPromptContentPart[]
  /** Telemetry only: incremented by each forwarding bridge, never enforced unless a ceiling is configured. */
  readonly hopCount?: number
}

/** `peer.prompt` value: the turn entered the target inbox. */
interface PeerPromptValue {
  readonly accepted: true
  readonly queued: boolean
  readonly hopCount: number
}

/** `peer.cancel` request: cancel the target's active turn, attributed to the peer. */
interface PeerCancelRequest {
  readonly target: PeerTarget
  readonly participant: PeerParticipant
}

/** `peer.cancel` value: `cancelled` is false when no turn was active. */
interface PeerCancelValue {
  readonly accepted: true
  readonly cancelled: boolean
}
```

`prompt` admits exactly one queued turn. Its content must be a non-empty list of text parts, each with non-whitespace text (`gateway/bad-request` otherwise); the caller-minted `requestId` is the dedupe identity, and the `participant` becomes durable attribution in the target log's `user/message`, which is what the latch's `lastParticipantAction` reports. When the resolved pairing configures `runawayCeiling` and `hopCount >= ceiling`, the prompt is refused with `peer/hop-limit`; otherwise the reply returns `hopCount + 1`. Prompt admission schedules the orphan watchdog.

`cancel` attributes the cancellation to the caller, reports `cancelled: true` only when an agent for the Session was `running` at call time, and clears that Session's watchdog.

## Execution state

`state` observes the Session and folds its aggregate execution state through the observation cursor. The priority order is deterministic, first match wins.

1. `waiting_approval` — pending asks are non-empty; an approval and a question both mean a human must act.
2. `waiting_subagents` — a turn is open and `activeDescendants > 0`.
3. `running` — a turn is open with no descendants and no pending ask.
4. `idle` — no turn is open.

```ts
/**
 * Authoritative aggregate execution state of one session (doc 69 §8
 * correction 3). `waiting_approval` also covers pending user questions: either
 * ask kind means a human must act before the turn can proceed.
 */
type PeerLatch = 'running' | 'waiting_approval' | 'waiting_subagents' | 'idle'

/**
 * Aggregate execution state a peer observes instead of crawling child streams.
 * `source` says whether a host-owned latch produced it or whether it was
 * derived from the durable stream; `descendantsExact` is false when derivation
 * cannot prove descendant liveness (quiet children stay parent-invisible).
 */
interface PeerExecutionState {
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
```

The host latch wins when it answers. `state` first calls `sessionController.executionState({ sessionId })` and accepts the value only when it structurally carries a valid latch and a non-negative safe-integer descendant count; otherwise it reads the `executionState` or `peerExecutionState` projection, and with neither it derives from the durable stream (`source: 'derived'`). `follow` reads only the projection form. Derivation counts `subagent/catalog` children spawned after the open turn started and not yet settled by a `subagent-settled` user message, so quiet children keep `descendantsExact` false and callers should re-read `peer.state` rather than declare idle. Model selection comes from the last durable `model/selection`, else the target's `modelSelection` projection with `pending` before `lastUsed`, else the host's `agentDefaultModel.currentSelection()`. `lastParticipantAction` prefers the host-local action recorded by `create`, `prompt`, `cancel`, and `answer`, then a host-latch value, then the folded human action.

## Asks: answer and the race

The ask registry observes `approval/request` and `user-questions/request` with `prepend: true`, so it mints a `PeerAskId` before any local forwarding parks the waterfall. Only asks whose root Session is exposed by a pairing are published; an ask raised by a child agent is bound to the root Session a peer follows by walking the `parentSession` chain (bounded to 32 levels), and an ask with no attributable agent or no resolvable root Session stays local.

The local chain is started immediately with `next()` and the registry races it against the peer answer: whichever settles first decides and the loser's value is discarded. The services own the settle broadcast: every dispatched ask carries a service-owned signal that aborts as soon as the ask settles by any route — a local answerer, the peer registry winning, the approval bound expiring, or the caller cancelling — and the forwarded-event gateway watches that signal to cancel the pending ask on every connected client and to stop replaying it to clients that attach later. The profile peer bridge likewise withdraws its locally surfaced card when the follow's next `state` frame drops the ask. A settled ask is retired with bounded 256-entry tombstones, so a late answer is `peer/conflict` rather than `peer/not-found`. Since pending-ask membership has no durable event, the registry pushes a coalesced change wakeup on mint and settle, and a `follow` generation turns a latch-key change into at most one `state` frame.

```ts
/** One ask a peer may answer, correlated by the host-minted `askId`. */
type PeerPendingAsk =
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

/** One peer answer to a pending ask, discriminated by the ask kind. */
type PeerAnswer =
  | { readonly kind: 'approval'; readonly outcome: PeerApprovalOutcome }
  | { readonly kind: 'question'; readonly answer: AskUserQuestionAnswer }

/** `peer.answer` request: settle the ask behind `askId`; races lose with `peer/conflict`. */
interface PeerAnswerRequest {
  readonly target: PeerTarget
  readonly participant: PeerParticipant
  readonly askId: PeerAskId
  readonly answer: PeerAnswer
}

/** `peer.answer` value: the answer settled the ask. */
interface PeerAnswerValue {
  readonly accepted: true
  readonly settled: true
}
```

`answer` validates before claiming, so a malformed answer leaves the ask pending while a valid one claims it. Peer approval outcomes are limited to `allowed-once` and `rejected` (`peer/forbidden` for anything else), and a structured question answer is normalized from `{answers: [{id, selected, custom?}]}` (`peer/not-found` when malformed). An unknown ask id is `peer/not-found`, an ask belonging to another Session is `peer/forbidden`, and an answer whose kind does not match the ask kind is `peer/not-found`.

## History: page and follow

`page` repairs history backwards from a follow cut and returns one contiguous window of exposure-filtered records.

```ts
/** `peer.page` request: backwards history repair from a follow opening cut (doc 69 §12.3). */
interface PeerPageRequest {
  readonly target: PeerTarget
  readonly throughSeq: SessionSeq
  readonly beforeSeq?: SessionSeq
  readonly maxMessages?: number
}

/** `peer.page` value: one contiguous backwards window of the exposure-filtered stream. */
interface PeerPageValue {
  readonly records: readonly PeerEventRecord[]
  readonly hasMore: boolean
}
```

```ts
/** `peer.follow` request: opening snapshot then live frames, filtered by exposure. */
interface PeerFollowRequest {
  readonly target: PeerTarget
  readonly maxMessages?: number
  /** Debug exposure only; `answer-only` rejects the stream with `peer/forbidden`. */
  readonly assistantStream?: true
}

/** Every frame a `peer.follow` stream carries. */
type PeerFollowFrame =
  | PeerFollowSnapshotFrame
  | PeerFollowEventFrame
  | PeerFollowStateFrame
  | PeerFollowAssistantStreamFrame
  | PeerFollowEndFrame
```

`follow` opens with a `snapshot` frame carrying the resolved target, a wire header (`id`, `version`, `createdAt`, optional `cwd` and `agentPreset`), the execution state, the durable cursor, a bounded recent window (default 50 messages), and `hasMore`. It then emits `event` frames for visible durable records, `state` frames on every latch-key change, opt-in `assistant-stream` frames, and a terminal `end`. `event` and `state` frames carry `cursor`, the durable position the host has scanned: under `answer-only` the filter drops records, so `record.seq` may skip while `cursor` advances, and `cursor` is what `peer.page` repairs from. Durable contiguity itself is enforced across visible events — a gap throws `peer/gap`. Observing a Session that has disappeared ends the stream with `{type: 'end', reason: 'target-detached'}`; a normal host-side end is `'closed'`. `assistantStream: true` requires `debug` exposure.

## Orphan watchdog

A peer turn whose follower leaves is bounded. Prompt admission arms the watchdog; the last follower leaving re-arms it when the agent is still running; opening a follower or cancelling clears it. After `watchdogMs` (default 15 minutes) the host checks again, and if no follower is present and the agent is still running it logs a warning and cancels the turn. The watchdog cancel is not attributed to any participant. Timers are `unref()`ed and cleared on service disposal.

## Limits and known gaps

- Pending asks live only in the registry's in-memory tables: a host restart loses them, and only asks minted while the host process lives can be answered. Question asks are the strictest case — the host accepts structured `{answers: [...]}` replies at `peer.answer`, but the shipped caller surfaces answer approvals only, so a remote question parks the turn until a browser answers or the watchdog aborts (doc 72 G1).
- A local chain that rejects settles the race with that rejection and retires the ask; a peer-settled ask aborts the dispatched request's settle signal (the settle broadcast) and is never replayed to a client that attaches afterwards.
- `hopCount` and `runawayCeiling` are effectively reserved for shipped callers: the ceiling is enforced only when a pairing configures it, and it compares the raw caller-supplied `hopCount`, which the shipped callers send as `0`.
- `token` is reserved, not enforced: the host parses it and reports only `tokenRequired`; no request header is read in this package, so any reachable caller may address a paired alias.
- The follow latch key omits the model selection, so a model-only change emits no `state` frame (and `model/selection` is filtered at `answer-only` exposure); `peer.state` remains authoritative.
- A host latch can report `latch: 'waiting_approval'` while `pendingAsks` is empty when the ask was never minted by the registry, such as an unattributable question; the state does not join the two sources.
- Watchdog cancellations are unattributed. A `create`/routing failure raised deeper in the stack is mapped to `peer/not-found` with the original code preserved in `details.reason` and as the cause, so the closed `peer/*` vocabulary holds at the wire.
- `create` is gated by the pairing's `create` block, but participant identity is validated only structurally — it is not matched against the pairing's `peer` device.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxpeerservice--peerservice"></a>

### `ctx.peerService` — `PeerService`

Host service backing the generated `ctx.remote.peer` namespace.

```ts cordis-catalog
/**
 * Negotiate protocol, capability, and pairing identity.
 * @param request - caller protocol, harness version, schema digest, and device name.
 * @returns the host identity, capabilities, and visible pairings.
 * @throws {@link RemoteError} `gateway/bad-request` when the request is
 * absent or not an object, `peer/version-skew` on protocol divergence.
 */
@Remote('handshake') handshake(request: PeerHandshakeRequest): PeerHandshakeValue

/**
 * Read the aggregate execution state for one paired Session. The host's
 * `session.executionState` latch wins when it answers (`source:'host-latch'`);
 * a cold Session or a host without that call keeps the derived fold.
 * @param request - resolved target.
 * @returns latch, descendants, pending asks, model selection, and cursor.
 */
@Remote('state') async state(request: PeerStateRequest): Promise<PeerStateValue>

/**
 * List the pairings this host exposes with a cheap live summary. Discovery
 * is read-only and reports each pairing at its own exposure; a supplied
 * target resolves through the same pairing gate as every other call, so an
 * unpaired session is refused rather than listed.
 * @param request - optional target narrowing the answer to one pairing.
 * @returns the host device and one row per selected pairing.
 * @throws {@link RemoteError} `peer/not-paired` when a supplied target does not resolve.
 */
@Remote('list') list(request?: PeerListRequest): PeerListValue

/**
 * Create or explicitly adopt a Session and bind it to a pairing alias.
 * @param request - pairing alias, participant, optional explicit session and routing.
 * @returns the resolved target and whether a new Session was created.
 * @throws {@link RemoteError} `peer/not-paired`, `peer/forbidden`, or
 * `peer/not-found` (a deeper create failure such as `agent-preset/not-found`
 * is mapped into the peer vocabulary).
 */
@Remote('create') async create(request: PeerCreateRequest): Promise<PeerCreateValue>

/**
 * Admit one queued peer turn into a paired Session.
 * @param request - target, participant, dedupe id, text content, and hop telemetry.
 * @param signal - carrier cancellation before prompt admission begins.
 * @returns acceptance and the incremented hop count.
 * @throws {@link RemoteError} `peer/hop-limit` only when the pairing configures a ceiling.
 */
@Remote('prompt') async prompt(request: PeerPromptRequest, signal: AbortSignal): Promise<PeerPromptValue>

/**
 * Cancel the active turn of a paired Session, attributed to the peer.
 * @param request - target and participant.
 * @returns acceptance and whether a turn was active.
 */
@Remote('cancel') cancel(request: PeerCancelRequest): PeerCancelValue

/**
 * Settle a pending ask for a paired Session.
 * @param request - target, participant, ask id, and answer payload.
 * @returns acceptance after the ask settled.
 */
@Remote('answer') answer(request: PeerAnswerRequest): PeerAnswerValue

/**
 * Repair history backwards from a follow cut, exposure-filtered.
 * @param request - target, inclusive cut, and optional backwards cursor.
 * @param signal - carrier cancellation for persistence reads.
 * @returns one contiguous backwards window of visible records.
 */
@Remote('page') async page(request: PeerPageRequest, signal: AbortSignal): Promise<PeerPageValue>

/**
 * Open a filtered stream: opening snapshot, then durable events and latch transitions.
 * @param request - target, window budget, and debug-only assistant stream opt-in.
 * @param signal - carrier cancellation owned by the Remote stream.
 * @returns peer follow frames; `event`/`state` frames carry the durable scan cursor.
 */
@Remote({ mode: 'stream' }) async *follow(request: PeerFollowRequest, signal: AbortSignal): AsyncIterable<PeerFollowFrame>
```

Source: [`packages/api/peer/src/host.ts`](../../packages/api/peer/src/host.ts)
<!-- END GENERATED cordis-surface -->
