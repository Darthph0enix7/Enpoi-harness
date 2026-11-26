# Peer Interconnect

English | [中文](peer.zh.md)

The device-to-device peer seam of [`@deepseek-ai/dsh-api-peer`](../../packages/api/peer). One host exposes a narrow `peer` namespace — `handshake`, `list`, `state`, `create`, `prompt`, `receipt`, `cancel`, `answer`, `page`, `follow`, `models`, `selectModel` — that maps onto `session.*` operations behind a closed dispatch table; the other device drives and observes paired Sessions through it. Pairing is the addressing boundary: every call resolves its `PeerTarget` through the host's pairing table first, so only Sessions named there are audible, and exposure filtering, participant validation, the hop ceiling, and the orphan watchdog are applied host-side, never by the caller.

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
  /** Write-ahead input receipt path; defaults to `~/.dsh/peer-input-receipts.json` (or beside `bindingsPath`). */
  readonly inputReceiptsPath?: string
  /** Maximum retained create/prompt receipts; oldest evicted first. */
  readonly inputReceiptLimit?: number
  /** Maximum serialized UTF-8 byte size of the write-ahead receipt document. */
  readonly inputReceiptMaxBytes?: number
  /** Maximum code-unit length for caller-supplied `requestId` values. */
  readonly requestIdMaxLength?: number
}
```

`PEER_PROTOCOL_VERSION` is `1`, `DEFAULT_WATCHDOG_MS` is 15 minutes, and `DEFAULT_HARNESS_VERSION` comes from the running package manifest. The handshake advertises available capabilities; callers must not infer that an unadvertised capability is available. `peer.follow` carries `assistant-stream` frames only under `debug` exposure when the caller opts in.

## Pairing model

Two documents define the boundary. The pairing document (`~/.dsh/pairings.yaml`, 0600) is rendered by `dsh update` from the profile fleet registry (`profile/web/fleet.yaml` through `profile/web/scripts/generate-pairings.mjs`); a first-line `# dsh-managed: false` marker hands the document back to the operator, and every other local edit is replaced on the next install or update. The document describes this host's side of each link; created-session bindings live in a separate machine-written document (`~/.dsh/peer-state.json`, 0600, atomic replacement) that `peer.create` alone writes. `PeerPairingsStore.load()` re-reads the pairing file whenever its mtime or size changes; a reload that fails validation keeps the previous valid snapshot, a vanished file withdraws exposure (empty pairing table, device name falls back to the host name), and a malformed first load throws `PeerConfigError` rather than degrading to an empty table.

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

The fleet registry's alias convention follows from that host-side resolution: a pairing uses the same alias string in both devices' files, and that alias names the pairing's member device — the non-hub side. The live `serverlocal` file carries `alias: macbook`/`peer: macbook` and `alias: pc`/`peer: pc`; the member's own file carries the same alias string with `endpoint` pointing at the hub, so on a member the entry for the hub uses the member's own alias. The registry member named by the alias also supplies the entry's `exposure` and `create.agentPreset`, which keeps a member's serving defaults consistent wherever its alias is addressed.

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
  /** Present when a peer may create (or adopt) a session under this alias; fields act as limits. */
  readonly create?: PeerCreateDefaults
  /** The session on `peer` this host calls; caller-role bookkeeping only. */
  readonly remoteSessionId?: SessionId
  /** Base URL of `peer`'s peer surface; caller-role addressing. */
  readonly endpoint?: string
  /** Hashed inbound bearer credential (`scrypt$...` or `sha256$...`); plaintext `inboundToken` in YAML is hashed at load and never retained. */
  readonly tokenHash?: string
  /** Plaintext bearer credential this host sends when dialing `endpoint` as a caller; never logged or echoed in RPC replies. */
  readonly outboundToken?: string
  /** Explicit opt-out allowing unauthenticated inbound calls when no credential is configured. */
  readonly insecure?: boolean
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
- Inbound and outbound credentials are separate optional fields: `tokenHash` (`scrypt$<salt>$<hash>` or `sha256$<hex>`) or `inboundToken` (hashed with scrypt at load, never retained or logged) governs inbound calls to this alias; `outboundToken` is the plaintext bearer this host sends toward `endpoint` (never logged, never echoed in `handshake`/`list`/`state`, with a load warning when `pairings.yaml` is group/world-readable). Combining `inboundToken` and `tokenHash`, combining `insecure: true` with an inbound credential, or using the ambiguous legacy `token` key throws `PeerConfigError`. Entries with neither an inbound credential nor `insecure: true` load as unauthenticated-legacy: the host warns once per alias naming `tokenHash`/`inboundToken`/`insecure: true`, refuses all inbound calls to that alias with uniform `peer/forbidden` (`reason: 'unauthorized'`), and keeps outbound `endpoint`/`outboundToken` calls working. Every peer method verifies `Authorization: Bearer` in constant time against the resolved pairing before running, binds `pairing.peer` as the authenticated device, and returns uniform `peer/forbidden` (`reason: 'unauthorized'`) on auth failure or unknown targets.
- Bindings are keyed by alias and carry `{sessionId, device, createdAt}` plus an optional `retired` list of earlier sessions; a malformed binding document throws `PeerConfigError`. A later `peer.create` under the same alias replaces the current binding and moves it to `retired`, so the alias resolves to the newest session while each replaced session stays addressable by explicit `sessionId` target through the same pairing.

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
  readonly instanceId: string
  readonly capabilities: readonly PeerCapability[]
  readonly pairings: readonly PeerPairingSummary[]
}
```

`protocolVersion` is the hard compatibility gate after authentication: an unauthenticated request fails with `peer/forbidden` (`reason: 'unauthorized'`), and an authenticated request whose `protocolVersion` differs from `1` throws `peer/version-skew` with the expected and received values before any other handshake work. `harnessVersion` and `schemaDigest` are advisory values the host returns for the caller's own comparison, so a differing digest at a matching protocol version is accepted. `instanceId` is a fresh per-boot UUID generated per `PeerService` instance and stored in write-ahead receipts so restarts are observable. `device` must be a non-empty string (`gateway/bad-request` otherwise) and must match an authorized pairing's `peer` (`peer/forbidden` `unauthorized` otherwise). Each pairing in the reply is an authorized `PeerPairingSummary` for `request.device` carrying alias, peer, exposure, `tokenRequired`, and — when the alias currently resolves to a Session — the resolved target.

## Discovery

`list` is the read-only discovery call. Without a target it reports every pairing the caller is authorized to see; with a `target` it authenticates and resolves that target through the same pairing gate as every other call (`peer/forbidden` `unauthorized` on auth failure or unknown session, `peer/not-paired` on an authenticated unbound alias) and returns only that pairing. Each row carries the alias, peer, and exposure, whether the alias resolves to a Session right now, the bound session id — the caller's `remoteSessionId`, from the pairing's own pin or the `peer.create` binding — and, when `sessionController.executionState` answers cheaply for the bound Session, the host latch, a last-activity time, and a one-line summary (`latch · asks · last turn`). A pin declared only as the pairing's caller-role `remoteSessionId` also resolves an explicit `peer.state`/`peer.list` session target, so a shared document authored from the other device's side stays addressable without granting an arbitrary session id.

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

`create` requires the addressed pairing to carry a `create` block (`peer/not-paired` otherwise). Pairing `create.*` fields act as upper-bound limits on both fresh creation and adoption: `workspaceId` must equal `create.workspaceId` (`workspace-not-allowed`), `cwd` must resolve canonically inside or equal to `create.cwd` (`cwd-not-allowed`), and `agentPreset` must equal `create.agentPreset` or belong to `create.allowAgentPresets` (`preset-not-allowed`). With an explicit `sessionId` that already exists, adoption is allowed only when that Session is already bound to or was created by this same alias (`session-adoption` otherwise) and `created` is false; routing fields on an adoption are refused with `peer/forbidden` unless the pairing sets `allowModelChange: true`. When optional `requestId` is supplied, `create` derives a deterministic `peer-<hex>` session id from `(alias, requestId)` when `sessionId` is omitted, writes a `'prepared'` write-ahead receipt to `peer-input-receipts.json` before creating/adopting (refusing with `peer/unavailable` before side effects if persistence fails), replays matching retries with `replayed: true`, and rejects changed payloads under the same id with `peer/conflict` (`reason: 'request-id-reuse'`); deterministic ids cannot adopt sessions bound outside that alias or unbound local sessions (`session-adoption`). Without `requestId`, the Session is created non-idempotently through `sessionController.create`, so callers such as Jarvis must send `requestId`. Creating under an alias that resolves through its binding replaces that binding; the previous binding moves to `retired`, so every later alias call reaches the newest Session and the replaced Session stays addressable by explicit `sessionId` target. An alias pinned by the pairing's own `sessionId` keeps resolving to that pin, and the binding `create` writes is reachable only by explicit `sessionId`; a caller that needs a fresh Session without moving the alias's current target seeds a distinct alias instead.

```ts
/** `peer.create` request: bind a fresh or explicitly adopted session to a pairing alias. */
interface PeerCreateRequest {
  readonly alias: PeerAlias
  readonly participant: PeerParticipant
  readonly requestId?: PeerRequestId
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
  readonly replayed?: boolean
  readonly payloadHash?: string
  readonly instanceId?: string
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
  readonly replayed?: boolean
  readonly payloadHash?: string
  readonly instanceId?: string
  readonly disposition?: string
}

/** `peer.cancel` request: cancel the target's active turn, attributed to the peer. */
interface PeerCancelRequest {
  readonly target: PeerTarget
  readonly participant: PeerParticipant
  /** Discard this alias's pending peer prompts. Defaults to true for worker pairings, false otherwise. */
  readonly dropQueued?: boolean
}

/** `peer.cancel` value: `cancelled` is false when no turn was active. */
interface PeerCancelValue {
  readonly accepted: true
  readonly cancelled: boolean
  readonly stopIntent: PeerStopIntent
  /** Pending prompts actually removed. Never counts work already claimed by the driver. */
  readonly droppedQueued: number
}
```

`prompt` admits exactly one queued turn. Its content must be a non-empty list of text parts, each with non-whitespace text (`gateway/bad-request` otherwise); the caller-minted `requestId` is bounded by `requestIdMaxLength` and bound to the SHA-256 of `(sessionId, content)` in a write-ahead receipt in `peer-input-receipts.json` (never storing prompt text), refusing with `peer/unavailable` before inbox insertion when receipt persistence fails, replaying matching retries with `replayed: true`, and rejecting changed payloads with `peer/conflict` (`reason: 'request-id-reuse'`). The `participant` becomes durable attribution in the target log's `user/message`, which is what the latch's `lastParticipantAction` reports. When the resolved pairing configures `runawayCeiling` and `hopCount >= ceiling`, the prompt is refused with `peer/hop-limit`; otherwise the reply returns `hopCount + 1`. Prompt admission schedules the orphan watchdog.

`receipt` authenticates uniformly (`peer/forbidden` `unauthorized`) and looks up `(alias, requestId, kind?)` in `peer-input-receipts.json` (throwing `gateway/bad-request` when `kind` is omitted and both `'create'` and `'prompt'` match `requestId`). It reports `replayedAcrossRestart` (`entry.instanceId !== host.instanceId`) and derives prompt dispositions (`queued`, `claimed`, `cancelled_before_dispatch`, `terminal` with `terminalState` `completed | aborted | failed | budget | blocked | max-tokens | interrupted`, or `unknown`) host-side directly from raw Session events (`agent/inbox/spliced`, `turn/start`, `user/message`, `turn/end`) without exposure filtering, so lookups work under `answer-only` as well as `debug`.

`cancel` attributes the stop to the caller, reports `cancelled: true` only if the Agent was `running`, and clears the Session's watchdog. Stop uses `keepInbox: true`; with `dropQueued: true` (the default for `worker` pairings), the host then removes only still-pending prompts admitted by that alias. Human input, other aliases' prompts, and settlement or job notices remain queued. `droppedQueued` counts only successful removals, not prompts the driver has already claimed. Each removal records an `agent/inbox/spliced` event with `outcome: 'canceled'`, so `peer.receipt` reports `cancelled_before_dispatch`; a Stop acknowledgement alone does not establish that disposition or quiescence.

## Worker control

`create.freshOnly` prohibits explicit `sessionId` and requires `requestId`. A `worker` policy implies fresh-only creation and requires a bearer-authenticated, unpinned alias and a job descriptor. The create response attests `{hash, presetId}` only after the worker profile provider describes the bound job. An absent description fails closed before the alias exposes the worker.

`ctx.peerJobBindings.get(sessionId)` returns a detached snapshot; an expired binding retains its original `expiresAt` and a revoked binding reports `revoked: true`. A guard must check both at each admission. `revoke(sessionId)` persists terminal revocation. Only authenticated `peer.jobUpdate` accepts a fence increase or expiry change and persists that mutation and its receipt together. `ctx.get('peerProfileIdentity')` is optional; `describe(sessionId)` returns `{hash, presetId, toolNames, configDigest}` or `undefined`.

`peer.ready` reports dependency readiness and, when available, a bound worker's profile. `peer.exportList` and `peer.exportFetch` read only the current alias's live job export directory. See the [package contract](../../packages/api/peer/README.md#host-surface) for parameters, limits, and hub verification. `schemaDigest` hashes the method and field descriptors; `methodsDigest` hashes method names only.

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
  readonly stopIntent?: PeerStopIntent
  readonly lastTurnEnd?: PeerTurnTerminal
  readonly lastParticipantAction?: PeerParticipantAction
  readonly model?: PeerModelSelection
}
```

The host latch wins when it answers. `state` and `follow` read `sessionController.executionState({ sessionId })` when available. With no host latch, `state` reads the `executionState` or `peerExecutionState` projection before falling back to the durable fold (`source: 'derived'`). The fold counts `subagent/catalog` children spawned in the open turn with no `subagent-settled` message. This count can miss quiet children. Model selection comes from the last durable `model/selection`, else the `modelSelection` projection (`pending` before `lastUsed`), else `agentDefaultModel.currentSelection()`. `lastParticipantAction` prefers host-local peer attribution, then the host latch, then the folded human action.

`stopIntent` reports the last accepted peer Stop's `requestedAt` on this host instance, `keepInbox: true`, the observed `turnState`, `activeDescendants`, `descendantsExact`, and `inFlightTools` when the session log can match `tool/call` to `tool/result`. The immediate cancel acknowledgement does not scan the log and reports `quiescence: 'unknown'`. State reports `observed` only when the host latch is idle, descendants are exactly zero, and there are no pending peer asks or unmatched tool calls; otherwise it reports `unknown`. The host never reports `confirmed`: the latch and log cannot rule out held settlement notices or independently running effects.

`peer.waitQuiescent({alias, timeoutMs})` polls the binding internally for the same observation, up to the configured limit, and returns `{observation: 'observed', timedOut, last?}`. `last` is the last complete state read, absent if none completed. An observation is not evidence that a particular input applied, that a tool's effects were undone, or that queued work cannot later wake. Use `peer.receipt` for each input's disposition.

## Asks: answer and the race

The ask registry observes `approval/request` and `user-questions/request` with `prepend: true`, so it mints a `PeerAskId` before any local forwarding parks the waterfall. Only asks whose root Session is exposed by a pairing are published; an ask raised by a child agent is bound to the root Session a peer follows by walking the `parentSession` chain (bounded to 32 levels), and an ask with no attributable agent or no resolvable root Session stays local.

The local chain starts immediately with `next()`. The first settlement wins. `peer.asks({alias, sessionId?})` returns `{instanceId, asks}` for the alias's current or retained Session, using the same ask details as `state.pendingAsks`. Each record also carries `alias`, `sessionId`, creation `instanceId`, `createdAt`, `state` (`pending`, `answered`, `expired`, or `cancelled`), and optional `settledAt`, `settlementReason`, and `answeredBy: {requestId, payloadHash}`. A new host generation marks old pending records `expired` with `settlementReason: 'host-restarted'`; no resolver survives. Only live pending asks appear in `state.pendingAsks`. The follow stream also observes ask changes without waiting for a durable Session event.

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
  readonly requestId: PeerRequestId
  readonly answer: PeerAnswer
}

/** `peer.answer` value: the decision was committed. A replay does not deliver it again. */
interface PeerAnswerValue {
  readonly accepted: true
  readonly settled: true
  readonly replayed: boolean
  readonly payloadHash: string
  readonly instanceId: string
}
```

`answer` validates before claiming. Peer approval outcomes are limited to `allowed-once` and `rejected`; question answers use `{answers: [{id, selected, custom?}]}`. Write failure returns `peer/unavailable` (`ask-write-failed`) without delivering the answer. A matching `requestId` and normalized payload replay the persisted decision without another delivery, even after restart. Different payload under the same id gives `peer/conflict` (`request-id-reuse`); a different id gives `ask-already-settled` for a settled current ask, `stale-generation` for a prior host's ask, and `ask-expired` for a current ask without a live resolver. Unknown or evicted ids return `peer/not-found` (`ask-not-found`); asking about a different binding is forbidden.

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
  | PeerFollowGapFrame
  | PeerFollowEndFrame
```

`follow` opens with a `snapshot` containing the target, header, execution state, cursor, and a recent history window (default 50 messages). It sends `event`, `state`, and opt-in `assistant-stream` frames; `assistantStream: true` requires `debug`. The `cursor` is the durable position scanned by the host; exposure can omit records without breaking contiguity. A detached target can produce `end`; this describes the stream, not a completed input.

On `/api/remote.mux`, send `{type: 'item', streamId, value: {type: 'ack', frame}}` after consuming each nonterminal frame. `frame` starts at 1 and increments per generation. An in-process iterator acknowledges by requesting the next item. Concurrency and open-rate refusals are `peer/unavailable` with `reason: 'follow-capacity'`; back off. A lost or timed-out generation emits `{type: 'gap', fromSeq, toSeq, reason, resync: 'refollow-and-page'}` and fails with `peer/gap`, never a normal `end`. The inclusive sequence bounds are `null` when unknown. Repair durable history with `peer.page` from the last reliable cursor and open a fresh follow; transient assistant deltas cannot be recovered. If the carrier cannot deliver the gap, treat the broken generation the same way.

## Orphan watchdog

A peer turn whose follower leaves is bounded. Prompt admission arms the watchdog; the last follower leaving re-arms it when the agent is still running; opening a follower or cancelling clears it. After `watchdogMs` (default 15 minutes) the host checks again, and if no follower is present and the agent is still running it logs a warning and cancels the turn. The watchdog cancel is not attributed to any participant. Timers are `unref()`ed and cleared on service disposal.

## Limits and known gaps

- The ask journal records a decision, not the delivery of that decision to a turn. Retention and transport limits are in the [peer package reference](../../packages/api/peer/README.md#host-surface).
- A local chain that rejects settles the race with that rejection and retires the ask; a peer-settled ask aborts the dispatched request's settle signal (the settle broadcast) and is never replayed to a client that attaches afterwards.
- `hopCount` and `runawayCeiling` are effectively reserved for shipped callers: the ceiling is enforced only when a pairing configures it, and it compares the raw caller-supplied `hopCount`, which the shipped callers send as `0`.
- HTTP `/api/peer/*` requests carry `Authorization: Bearer` through `connection/request`, and WebSocket `/api/remote.mux` streams propagate the upgrade request's `Authorization` header (and no other headers) through `RemoteStreamMuxServer` so `PeerService.follow` verifies the same bearer credential.
- The follow latch key omits the model selection, so a model-only change emits no `state` frame (and `model/selection` is filtered at `answer-only` exposure); `peer.state` remains authoritative.
- A host latch can report `latch: 'waiting_approval'` while `pendingAsks` is empty when the ask was never minted by the registry, such as an unattributable question; the state does not join the two sources.
- Watchdog cancellations are unattributed. A `create`/routing failure raised deeper in the stack is mapped to `peer/not-found` with the original code preserved in `details.reason` and as the cause, so the closed `peer/*` vocabulary holds at the wire.
- Authenticated calls bind `pairing.peer` as the caller device on handshake and `participant.device`; when `participant.device` is supplied and differs from `pairing.peer`, the call fails with `peer/forbidden` (`unauthorized`). `participant.name` remains caller-supplied within that authenticated peer.
- Write-ahead input receipts (`peer-input-receipts.json`) are bounded by `inputReceiptLimit` and `inputReceiptMaxBytes` (LRU eviction); an evicted receipt falls back to session-log presence (`create` deterministic id bound to same alias) or `'unknown'` on `peer.receipt`. A crash leaving a `'prepared'` receipt reports `'unknown'` until reconciled against the session store or log.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxpeerjobbindings--peerjobbindingsservice"></a>

### `ctx.peerJobBindings` — `PeerJobBindingsService`

Cordis service interface registered under `peerJobBindings`.

```ts cordis-catalog
/**
 * Deny subsequent guard reads immediately and persist before acknowledging.
 * @param sessionId - bound session identifier to revoke.
 * @returns true when a binding existed and was revoked, false when absent.
 */
revoke(sessionId: SessionId): Promise<boolean>
```

Types: [SessionId](core.md)

Source: [`packages/api/peer/src/types.ts`](../../packages/api/peer/src/types.ts)

<a id="ctxpeerprofileidentity--peerprofileidentityservice"></a>

### `ctx.peerProfileIdentity` — `PeerProfileIdentityService`

Optional service seam implemented by the profile layer and read through `ctx.get('peerProfileIdentity')` to attest effective worker session identity.

```ts cordis-catalog
/**
 * Describe the effective profile identity for a session.
 * @param sessionId - created or bound session identifier.
 * @returns profile identity facts, or `undefined` when unavailable.
 */
describe(sessionId: SessionId): PeerProfileIdentity | undefined
```

Types: [SessionId](core.md)

Source: [`packages/api/peer/src/types.ts`](../../packages/api/peer/src/types.ts)

<a id="ctxpeerrouting--peerroutingservice"></a>

### `ctx.peerRouting` — `PeerRoutingService`

Structural seam the peer host consumes through `ctx.get('peerRouting')`. The profile owns the catalogue, selector rules, chain registry, and route health; the peer package owns transport, pairing, and exposure. A host without this service serves neither `model-discovery` nor `model-switch`, and refuses any routing request on a pairing that carries a `routing` policy.

```ts cordis-catalog
/**
 * Policy-filtered discovery. Must not return credentials, URLs, or provider error text.
 * @param policy - the pairing's routing policy; runtime selection uses the host-attested copy.
 * @param request - optional filters plus opaque pagination cursor and page size.
 * @returns allowed chains and models, with the next cursor when more rows follow.
 */
discover(policy: PeerRoutingPolicy, request: { readonly filter?: PeerModelsFilter readonly cursor?: string readonly limit?: number }): Promise<{ readonly chains: readonly PeerChainInfo[] readonly models: readonly PeerModelInfo[] readonly nextCursor?: string }>

/**
 * Evaluate one requested selection; resolves chain members and catalogue
 * facts at call time. A chain-only request carries empty `provider` and
 * `model` strings, and the verdict answers the concrete route to apply.
 * @param policy - the pairing's routing policy; runtime selection uses the host-attested copy.
 * @param selection - the requested route or chain, as the controller sent it.
 * @returns the applied route, or a closed refusal reason naming the denied identifier.
 */
evaluate(policy: PeerRoutingPolicy, selection: PeerModelSelection): Promise<PeerRoutingVerdict>
```

Source: [`packages/api/peer/src/types.ts`](../../packages/api/peer/src/types.ts)

<a id="ctxpeerservice--peerservice"></a>

### `ctx.peerService` — `PeerService`

Host service backing the generated `ctx.remote.peer` namespace.

```ts cordis-catalog
/**
 * Negotiate protocol, capability, and pairing identity.
 * @param request - caller protocol, harness version, schema digest, and device name.
 * @returns the host identity, boot `instanceId`, capabilities, and authorized pairings for `request.device`.
 * @throws {@link RemoteError} `peer/forbidden` (`reason: 'unauthorized'`) when
 * credentials fail or `device` does not match the authenticated pairing,
 * `gateway/bad-request` when the request is absent or not an object,
 * `peer/version-skew` on protocol divergence.
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
 * Read retained pending and settled asks for an authenticated binding.
 * @param request - alias and optional current or retired Session id.
 * @returns retained ask records and the current host identity.
 */
@Remote('asks') asks(request: PeerAsksRequest): PeerAsksValue

/**
 * Poll one binding for an observed quiet state; never certify descendant teardown.
 * @param request - alias and bounded polling timeout in milliseconds.
 * @param signal - carrier cancellation.
 * @returns last observed state and whether the deadline elapsed.
 */
@Remote('waitQuiescent') async waitQuiescent(request: PeerWaitQuiescentRequest, signal: AbortSignal): Promise<PeerWaitQuiescentValue>

/**
 * List the pairings this caller is authorized to see with a cheap live
 * summary. Discovery is read-only and reports each pairing at its own
 * exposure; a supplied target authenticates and resolves through the same
 * pairing gate as every other call.
 * @param request - optional target narrowing the answer to one pairing.
 * @returns the host device and one row per authorized pairing.
 * @throws {@link RemoteError} `peer/forbidden` (`reason: 'unauthorized'`) on
 * invalid credentials; `peer/not-paired` when an authenticated unbound alias
 * is targeted.
 */
@Remote('list') list(request?: PeerListRequest): PeerListValue

/**
 * Create or explicitly adopt a Session and bind it to a pairing alias.
 *
 * Pairing `create.*` values (`workspaceId`, `cwd`, `agentPreset`,
 * `allowAgentPresets`) act as upper-bound limits: callers may narrow `cwd`
 * within the pinned directory or select a preset within the allowed set, and
 * any attempt to widen is refused with `peer/forbidden`. Adoption is
 * restricted to sessions already bound to or created by this alias (`reason:
 * 'session-adoption'`).
 *
 * When `requestId` is supplied, the host derives a deterministic session id
 * from `(alias, requestId)` when `sessionId` is omitted, writes a write-ahead
 * payload-bound receipt before creating/adopting, replays identical retries
 * with `replayed: true`, and rejects changed payloads under the same id with
 * `peer/conflict` (`reason: 'request-id-reuse'`). If the write-ahead receipt
 * cannot be persisted, creation is refused with `peer/unavailable` before any
 * session or binding side effect.
 *
 * A pairing with a `routing` policy is authoritative: every create (new or
 * adopt) must name a route, the policy is evaluated before any session or
 * selection exists, and the applied selection is the verdict's `selection`
 * (a chain-only request is resolved there). Without a policy the legacy
 * behavior is unchanged and `allowModelChange` gates adopt-time routing.
 * @param request - pairing alias, participant, optional requestId/session, routing, and token ceiling.
 * @returns the resolved target, whether a new Session was created, and receipt metadata when `requestId` was supplied.
 * @throws {@link RemoteError} `peer/not-paired`; `peer/forbidden` for auth,
 * scope limits (`workspace-not-allowed`, `cwd-not-allowed`,
 * `preset-not-allowed`, `session-adoption`), policy refusal, a missing
 * routing service, a ceiling on a host without the usage seam (reason
 * `budget-unmetered`), or an adopt without `allowModelChange`;
 * `peer/conflict` (`reason: 'request-id-reuse'`); `peer/unavailable` when
 * receipt persistence fails; `peer/not-found` for a deeper create failure.
 */
@Remote('create') async create(request: PeerCreateRequest): Promise<PeerCreateValue>

/**
 * Policy-filtered model and chain discovery for one alias.
 * @param request - alias, participant, optional filter, cursor, and page limit.
 * @returns selectable chains/models with the policy echoed for the caller.
 * @throws {@link RemoteError} `peer/forbidden` (`reason: 'unauthorized'`) on
 * invalid credentials, `peer/forbidden` when the pairing configures no policy
 * or the host mounts no routing service, `gateway/bad-request` for an invalid
 * page cursor, and `peer/forbidden` reason `routing-unavailable` when the
 * service throws.
 */
@Remote('models') async models(request: PeerModelsRequest): Promise<PeerModelsValue>

/**
 * Switch one idle Session's routing for its next turn. The policy decides the
 * exact selection; the caller's request is only an input.
 *
 * Durability and retry guarantees:
 * - A replay of the same `requestId` with the same payload while the receipt is
 *   retained returns the original value (`replayed: true`) before the idle
 *   check and without re-applying over any newer selection.
 * - If `receipts.put()` fails after applying, the host logs a warning and
 *   returns `receiptPersisted: false` (and in-memory replays also carry
 *   `receiptPersisted: false`) so callers know cross-restart idempotency is
 *   not guaranteed.
 * - On a post-restart retry without a persisted receipt, the host compares the
 *   Session's live selection to the resolved verdict selection before calling
 *   `sessionController.selectModel` and skips re-applying when they already
 *   match (no duplicate `model/selection` event).
 * @param request - target, participant, request id, and requested route.
 * @returns the applied selection, the previous one when known, replay status,
 * and `receiptPersisted: false` when durable receipt storage failed.
 * @throws {@link RemoteError} `peer/forbidden` for auth, a policy refusal, or
 * a disallowed switch, `peer/conflict` for a busy Session or a reused request
 * id, `peer/not-paired` for an unresolved target.
 */
@Remote('selectModel') async selectModel(request: PeerSelectModelRequest): Promise<PeerSelectModelValue>

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
ceilingOf(sessionId: SessionId): number | undefined

/**
 * Admit one queued peer turn into a paired Session with write-ahead payload-bound
 * receipt persistence.
 * @param request - target, participant, dedupe id, text content, and hop telemetry.
 * @param signal - carrier cancellation before prompt admission begins.
 * @returns acceptance, incremented hop count, receipt metadata, and disposition.
 * @throws {@link RemoteError} `peer/hop-limit` only when the pairing
 * configures a ceiling; `peer/forbidden` with reason `budget` once the
 * Session's token ceiling is reached; `peer/conflict` (`reason: 'request-id-reuse'`)
 * when `requestId` is reused with different content; `peer/unavailable` when
 * the write-ahead receipt cannot be persisted.
 */
@Remote('prompt') async prompt(request: PeerPromptRequest, signal: AbortSignal): Promise<PeerPromptValue>

/**
 * Look up a durable `peer.create` or `peer.prompt` receipt and derive its
 * current host-side disposition directly from the Session store / log.
 * @param request - pairing alias, caller request id, and optional kind disambiguator.
 * @returns receipt metadata, `replayedAcrossRestart`, and derived disposition.
 * @throws {@link RemoteError} `peer/forbidden` (`reason: 'unauthorized'`) on
 * invalid credentials or unknown alias, `gateway/bad-request` on malformed input
 * or ambiguous match without `kind`, `peer/unavailable` when the receipt store failed to open.
 */
@Remote('receipt') async receipt(request: PeerReceiptRequest): Promise<PeerReceiptValue>

/**
 * Update a bound worker job's fence, expiration timestamp, or revocation
 * state. Fence bumps are strictly monotonic and exposed only through this
 * authenticated method, with payload-bound idempotency receipts persisted
 * alongside the binding.
 * @param request - pairing alias, request id, job id, and mutation fields.
 * @returns the updated binding and receipt metadata.
 * @throws {@link RemoteError} `peer/forbidden` on auth failure or non-worker
 * pairing, `gateway/bad-request` on malformed input, `peer/not-found` when
 * the job binding is absent, `peer/conflict` on fence regression, expired
 * non-extended job, already-revoked job, or changed payload under the same
 * `requestId`, `peer/unavailable` when binding persistence is unavailable.
 */
@Remote('jobUpdate') async jobUpdate(request: PeerJobUpdateRequest): Promise<PeerJobUpdateValue>

/**
 * Probe authenticated host and pairing readiness before dispatching work.
 * @param request - pairing alias to check.
 * @returns readiness boolean, missing capability list, advertised capabilities,
 * optional attested profile summary when bound, boot `instanceId`, and harness `version`.
 * @throws {@link RemoteError} `peer/forbidden` (`reason: 'unauthorized'`) on
 * invalid credentials or unknown alias, `gateway/bad-request` on malformed input.
 */
@Remote('ready') ready(request: PeerReadyRequest): PeerReadyValue

/**
 * List regular files inside the bound worker session's fixed export root.
 * Requires a live (non-expired, non-revoked) job binding.
 * @param request - pairing alias owning the worker session.
 * @returns bounded list of regular files with relative paths and truncation flag.
 */
@Remote('exportList') exportList(request: PeerExportListRequest): PeerExportListValue

/**
 * Fetch one bounded regular file from the bound worker session's fixed export
 * root, refusing traversal, symlinks, non-regular files, oversize reads, and
 * size changes between stat and read. Requires a live job binding; the hub
 * must still independently re-verify returned bytes and SHA-256.
 * @param request - pairing alias, relative file path, and optional caller byte cap.
 * @returns relative path, exact byte length, SHA-256 over the returned bytes, and base64 content.
 */
@Remote('exportFetch') exportFetch(request: PeerExportFetchRequest): PeerExportFetchValue

/**
 * Stop a paired Session and optionally discard the pairing's pending prompts.
 * @param request - target, participant, and optional queue removal intent.
 * @returns acceptance, whether a turn was active, the immediate stop observation, and the number removed.
 */
@Remote('cancel') cancel(request: PeerCancelRequest): PeerCancelValue

/**
 * Settle a pending ask for a paired Session. An answer may resume a turn
 * the host paused on that ask; the ceiling watcher stops it after the next
 * response when the Session is already over budget.
 * @param request - target, participant, ask id, retry id, and answer payload.
 * @returns the persisted decision receipt, replayed without another delivery on a matching retry.
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
 * @returns acknowledgement-paced peer frames; a gap item is followed by a `peer/gap` failure.
 */
@Remote({ mode: 'stream' }) follow(request: PeerFollowRequest, signal: AbortSignal): RemoteStream<PeerFollowFrame, PeerFollowAck>
```

Types: [SessionId](core.md)

Source: [`packages/api/peer/src/host.ts`](../../packages/api/peer/src/host.ts)
<!-- END GENERATED cordis-surface -->
