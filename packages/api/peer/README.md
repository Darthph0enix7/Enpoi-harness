---
description: "Device-to-device peer API: the narrow authenticated serving namespace, the pairing store, the execution latch, the ask registry, and the caller bridge."
kind: "package-reference"
---

# @deepseek-ai/dsh-api-peer

English | [中文](README.zh.md)

## Summary

Opt-in device-to-device peer API (doc 69 P2, contract in `dsh-migration/70-peer-api-contract.md`). One host exposes paired sessions through a small `peer` namespace (`handshake`, `list`, `create`, `prompt`, `receipt`, `follow`, `page`, `cancel`, `answer`, `state`, `models`, `selectModel`); another device drives them through `PeerClient`. The surface is narrow by construction: each call authenticates its `Authorization: Bearer` header against `~/.dsh/pairings.yaml`, resolves through the pairing gate, and maps onto `session.*` behind a closed dispatch table, so it never re-exposes `settings.*`, `credentials.*`, `fs.*`, or `control.*`. Pairings without inbound credentials load as unauthenticated-legacy (inbound refused, one warning per alias) unless `insecure: true`.

## Table of Contents

- [Use this package](#use-this-package)
- [Pairing file](#pairing-file)
- [Host surface](#host-surface)
- [Caller bridge](#caller-bridge)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount `PeerService` on a host that already runs the Session Controller; it registers the `peer` Typert namespace, fails loud when the pairing document is malformed, and installs the ask registry that races a peer answer against the local answerer chain. The shipped bundle mounts this row as `peer-api`; an overlay must be an **id-targeted config override** of that row — an `insert` double-registers `peerService` and fails the whole load (`tests/peer.overlay.yml`):

```yaml
- id: peer-api
  name: '@deepseek-ai/dsh-api-peer'
  config:
    pairingsPath: !!js dshHomePath('pairings.yaml')   # default
    bindingsPath: !!js dshHomePath('peer-state.json') # default
    watchdogMs: 900000                                # default 15 min
```

Config: `pairingsPath`, `bindingsPath`, `watchdogMs`, `harnessVersion`, `schemaDigest`, `receiptsPath` (default `~/.dsh/peer-receipts.json`), `receiptLimit` (default 512), `inputReceiptsPath` (default `~/.dsh/peer-input-receipts.json`, or next to `bindingsPath` when configured), `inputReceiptLimit` (default 1024), `inputReceiptMaxBytes` (default 1 MiB), `requestIdMaxLength` (default 256), `modelsLimit` (default 100) and `modelsLimitMax` (default 500). `harnessVersion` defaults to the running package manifest's version — the runtime version plugin compatibility reads — rather than a literal, and `schemaDigest` defaults to `PEER_SCHEMA_DIGEST`; both stay advisory in the handshake.

<a id="pairing-file"></a>
## Pairing file

`~/.dsh/pairings.yaml` (0600) is human-edited and strictly validated; a malformed document fails host load. Exposure is required per entry — there is no implicit `debug`.

```yaml
version: 1
device: serverlocal
watchdogMs: 900000
pairings:
  - alias: co-dev
    peer: laptop
    exposure: debug           # answer-only | debug
    sessionId: sess-abc       # this host's session peers may address
    create:                   # present ⇒ peer.create may create/adopt under this alias; fields act as limits
      cwd: /home/user/projects/thing
      agentPreset: sysadmin
      allowAgentPresets: [sysadmin, orchestrator]
    remoteSessionId: sess-xyz # caller-role bookkeeping
    endpoint: https://laptop.pike-acrux.ts.net:8443
    tokenHash: scrypt$...     # inbound credential (or `inboundToken` hashed with scrypt at load, never retained); or `insecure: true`
    outboundToken: ...        # optional plaintext bearer this host sends when dialing `endpoint`; never logged or echoed
    runawayCeiling: null      # optional emergency hop cap; null = unbounded; inert for the shipped callers, which send hopCount 0 (doc 70 §12)
    allowModelChange: false   # default false (doc 69 §10); ignored when `routing` is present
    routing:                  # optional remote model-selection policy; authoritative when present
      allowChains: [free]
      allowModels: ["kilo/*:free", "openrouter/*:free"]
      requireZeroPrice: true
      requireNoTraining: false
      requireTools: true
      allowReasoningEfforts: [minimal, medium]
      allowSwitch: idle-only  # never (default) | idle-only
      maxTotalTokens: 5000
```

Inbound and outbound credentials are separate optional fields: `tokenHash` (`scrypt$<salt>$<hash>` or `sha256$<hex>`) or `inboundToken` (hashed with scrypt at load, never retained on `PeerPairing` or logged) governs what this host requires from inbound callers; `outboundToken` is the plaintext bearer this host sends when dialing `endpoint` as a caller (never logged, never echoed in `handshake`/`list`/`state`, with a load warning if `pairings.yaml` is group/world-readable). Combining `inboundToken` with `tokenHash`, combining `insecure: true` with an inbound credential, or using the ambiguous legacy `token` key fails load with `PeerConfigError`. Entries with neither an inbound credential nor `insecure: true` load as unauthenticated-legacy: the host logs one warning per alias naming `tokenHash`/`inboundToken`/`insecure: true`, refuses every inbound request to that alias uniformly, and leaves outbound `endpoint`/`outboundToken` use working. Every `peer.*` method verifies the request's `Authorization: Bearer` token in constant time against the resolved pairing before running any method logic, binds `pairing.peer` as the authenticated device on the context and participant attribution, and returns a uniform `peer/forbidden` (`reason: 'unauthorized'`) error for missing/bad tokens, device mismatches, unauthenticated-legacy entries, and unknown targets so callers cannot probe whether an alias exists. HTTP `/api/peer/*` calls populate the header through the `connection/request` waterfall, WebSocket `/api/remote.mux` calls populate it from the upgrade request's `Authorization` header, and in-process callers use `withPeerAuth`.

Generate a `tokenHash` offline with `node -e "import('./packages/api/peer/src/pairings.ts').then(m => console.log(m.hashPairingToken(process.argv[1])))" <secret>` (or `npx tsx` when running from source).

`create.*` fields act as upper-bound limits on both fresh creation and adoption: `request.workspaceId` must equal `create.workspaceId` (`workspace-not-allowed`), `request.cwd` must resolve canonically inside or equal to `create.cwd` with symlinks resolved (`cwd-not-allowed`), and `request.agentPreset` must equal `create.agentPreset` or belong to `create.allowAgentPresets` (`preset-not-allowed`). Adoption via `peer.create` (`sessionId`) is restricted to sessions already bound to or created by that same alias (`session-adoption`).

`routing` is parsed strictly: an unknown key, a wrong type, an empty pattern, or a pattern outside `[A-Za-z0-9._:/@*+-]` fails host load, because a silently ignored cost guard would widen what a paired controller may select. `allowModels` patterns match `provider/model` with `*` as the only wildcard (any run of characters, `/` included, anchored at both ends); `allowChains` entries are exact chain ids. A create or adopt under a pairing with `routing` must name a route — `provider`+`model`, or `chain` alone — and the host applies the routing service's resolved `selection`, never the raw request. A chain-only request is resolved by the routing service, which owns the catalogue, chain registry, and route health. Without a mounted `peerRouting` service every routing request fails closed with `peer/forbidden` reason `routing-unavailable`, and the handshake withholds `model-discovery`, `model-routing-at-create`, and `model-switch`.

`peer.create` bindings persist in `~/.dsh/peer-state.json` (0600, versioned, atomic replacement); a `create` that replaces an alias binding moves the previous session into that binding's `retired` list, so a rebound alias resolves to the newest session while every replaced session stays addressable by explicit `sessionId`. Each binding also records the session's `maxTotalTokens` ceiling (requested, or capped to the policy value); `PeerService.ceilingOf(sessionId)` reads it, including for a session a later create retired. The pairing file is never rewritten by the host.

<a id="host-surface"></a>
## Host surface

### Worker sessions

`create.freshOnly: true` requires a caller-generated `requestId`, rejects every caller-supplied `sessionId`, and never adopts an existing session. An exact retained receipt can replay the same session. If a prepared receipt cannot establish ownership, the host refuses instead of guessing. These options have closed key sets.

A pairing's optional `worker` block accepts `allowedCapabilities`, `allowedMcpEndpoints`, `allowedToolNames`, and `maxLimits` (`maxSteps`, `maxToolCalls`, `maxWallMs`, `maxTotalTokens`). It requires an unpinned create alias, implicitly uses fresh-only creation, and requires bearer authentication. Worker creates must supply `job`: `{jobId, fence, expiresAt, capabilities, limits, mcpEndpointId?, credentialRef?, allowedToolNames?}`. Fence, timestamp and limit values are positive safe integers. Expiry is in epoch milliseconds and must be in the future, within `jobMaxTtlMs`. Requests outside policy are refused, not silently clamped; omitted job limits and tools inherit configured limits and allowed tools, with an empty tool list when none is configured. `credentialRef` is a reference name, not a token, a URL, or another credential value. The host does not resolve it. The create receipt hashes the job payload, including its reference name, without storing the payload.

- `peer.ready({alias})` returns `{ready, missing, capabilities, profile?, instanceId, version}`. Before an alias is bound, readiness checks dependencies, not a not-yet-created composition. For a bound worker, the host also attempts profile attestation. Compare the profile returned by `peer.create` (`{hash, presetId}`) against the expected composition before dispatch; a missing or failing identity service refuses create with `peer/unavailable` / `profile-identity-unavailable`.
- `peer.jobUpdate({alias, requestId, jobId, fence?, expiresAt?, revoked?})` returns `{accepted, binding, replayed, payloadHash, instanceId}`. A replacement fence must increase; a new expiry must fit the same TTL rule; `revoked: true` is permanent. The binding and update receipt commit together. An exact retry returns the original result even after a later mutation; it does not reapply the update. `peer.receipt` remains for create and prompt only.
- `peer.exportList({alias})` returns `{files: [{path, bytes, mtimeMs}], truncated}`. `peer.exportFetch({alias, path, maxBytes?})` returns `{path, bytes, sha256, contentBase64}`. Both require the alias's live job binding. The host creates `<exportRoot>/<sessionId>` with mode `0700` and takes only relative POSIX paths beneath it. Fetch refuses symlinks, unsafe paths, non-regular files, size changes, and oversize reads. The hub must independently verify the decoded bytes, hash, and job-specific acceptance criteria; do not treat a listing as a snapshot.

The host advertises `ready`, the canonical `shape-digest` (`schemaDigest` covers method names and wire fields, `methodsDigest` hashes names only), `fresh-only-create` when create receipts opened, `job-binding` when both stores opened, `profile-identity` when the provider is mounted, and `export-root` when the binding store and export root are available. A custom `schemaDigest` override suppresses `shape-digest` if it differs from the canonical digest.

Worker Config: `jobBindingsPath` (default `peer-job-bindings.json` beside input receipts), `jobBindingLimit` (1024), `jobBindingMaxBytes` (1 MiB), `jobIdMaxLength` and `jobIdentifierMaxLength` (128 each), `jobMaxTtlMs` (24 h), `jobCapabilitiesMax` (64), `jobToolsMax` (256), `exportRoot` (`peer-exports` beside peer state), `exportListMaxFiles` (256), `exportListMaxBytes` (256 KiB), `exportListMaxScannedEntries` and `exportPathMaxBytes` (4096 each), and `exportFetchMaxBytes` (8 MiB). The 0600 job store retains expired and revoked records; at capacity it refuses new bindings instead of forgetting existing restrictions.

Ask and stop Config: `asksPath` (`peer-asks.json` beside input receipts), `askLimit` (256 records), `askMaxBytes` (1 MiB per journal), `askRecordMaxBytes` (16 KiB per pending record), `waitQuiescentMaxMs` (10,000 ms), and `waitQuiescentPollMs` (100 ms). The journal uses atomic 0600 replacement; it evicts the oldest settlements first, never pending asks. If a record cannot fit or be written, the ask stays local. A journal that fails to open withholds `answer-routing`, `durable-asks`, and `ask-idempotent-answer`.

Follow Config: `followQueueMaxItems` (16,384 items), `followQueueMaxBytes` (8 MiB of serialized peer items), `followOpenMs` (10,000 ms), `followIdleMs` (30,000 ms), `followLifetimeMs` (900,000 ms), `followMaxPerAlias` (2), `followMaxPerHost` (16), `followOpensPerWindow` (12), and `followOpenWindowMs` (30,000 ms). These bounds apply to the peer generation; the Session Controller's upstream backlog independently defaults to 16,384 items / 8 MiB and the Gateway separately bounds socket writes. The peer queue counts items awaiting delivery or acknowledgement; loss replaces the queue with one small gap control frame.

`stop-intent` and `wait-quiescent` advertise Stop observations; `bounded-follow` and `follow-gap-frames` advertise the logical stream limits and recovery frames. A caller must not assume a missing capability is available.

- `peer.handshake` authenticates first, validates `request.device` against matching authorized `pairing.peer` entries, negotiates protocol/schema/capabilities, reports a fresh per-boot `instanceId`, and returns only authorized pairings for that device (never tokens or hashes); a protocol mismatch is `peer/version-skew`. `create-receipts`, `prompt-receipts`, and `input-disposition` are advertised only when `peer-input-receipts.json` opened cleanly at host startup.
- `peer.list` discovers authorized pairings: without a target it lists only pairings matching the presented credential (or `insecure: true`); with a target it authenticates and resolves through the pairing gate first (`peer/forbidden` `unauthorized` on auth failure or unknown session, `peer/not-paired` on an authenticated unbound alias).
- `peer.state` returns the execution latch (`running | waiting_approval | waiting_subagents | idle`), `activeDescendants`, pending asks, current model selection, `lastParticipantAction`, and the cursor. It reads the host's `session.executionState` latch when that call answers (`source: 'host-latch'`, quiet children included), and otherwise derives the latch from `turn/*`, `approval/*`, `subagent/catalog`, settlement notices, and the ask registry (`source: 'derived'`).
- `peer.follow` streams an opening snapshot plus exposure-filtered durable events and latch transitions; an ask mint or settle also pushes a `state` frame (the change key carries only `(askId, kind, since)` per pending ask), so a mid-tool-call ask surfaces without waiting for the next durable event; `cursor` is authoritative for repair because `answer-only` filters records.
- `peer.prompt` always queues (a human preempts); `hopCount` is telemetry and only a configured `runawayCeiling` enforces a cap. Before queueing, the host writes a `'prepared'` write-ahead receipt to `peer-input-receipts.json` (0600, atomic, bounded by `inputReceiptLimit` and `inputReceiptMaxBytes`) recording the SHA-256 hash of `(sessionId, content)` and `instanceId` (never the prompt text), then finalizes it after `sessionController.prompt` commits. A write-ahead persistence failure refuses with `peer/unavailable` before any prompt enters the inbox; identical retries replay with `replayed: true` and the current disposition, and changed payloads under the same `requestId` fail with `peer/conflict` (`reason: 'request-id-reuse'`).
- `peer.receipt` authenticates uniformly (`peer/forbidden` `unauthorized` on bad credentials or unknown alias) and looks up one `(alias, requestId, kind?)` entry in `peer-input-receipts.json`, returning `{ found, kind?, sessionId?, payloadHash?, instanceId?, phase?, replayedAcrossRestart, disposition, terminalState?, terminal?, acceptedAt?, finalizedAt? }`. Prompt dispositions (`queued`, `claimed`, `cancelled_before_dispatch`, `terminal` with `terminalState` `completed | aborted | failed | budget | blocked | max-tokens | interrupted`, or `unknown`) are derived host-side from the raw session log (`agent/inbox/spliced`, `turn/start`, `user/message`, `turn/end`) without exposure filtering, so lookups work at `answer-only` exposure too.
- `peer.asks` discovers pending and retained settlements by alias and Session; `peer.answer` requires a payload-bound `requestId` and journals the winning decision before delivery.
- `peer.cancel` requests Stop and returns `stopIntent` and `droppedQueued`, the number of this alias's pending prompts actually removed. Hosts that advertise `cancel-drop-queued` accept `dropQueued`; it defaults to `true` for `worker` pairings and `false` otherwise. `peer.waitQuiescent` polls for an observation, not proof of teardown. See [peer semantics](../../../docs/subsystems/peer.md).
- `peer.create` enforces `create.*` scope limits, restricts `sessionId` adoption to the same alias, and applies a policy-evaluated route before any session or selection exists, so a refusal leaves no session behind; a pairing without `routing` keeps the legacy `allowModelChange` gate for adopt-time routing. When optional `requestId` (bounded by `requestIdMaxLength`) is supplied, `peer.create` derives a deterministic `peer-<hex>` session id from `(alias, requestId)` when `sessionId` is omitted, persists a write-ahead payload-bound receipt before creating/adopting, replays identical retries with `replayed: true`, refuses changed payloads with `peer/conflict` (`reason: 'request-id-reuse'`), and refuses with `peer/unavailable` before side effects if the receipt cannot be persisted. Unkeyed `peer.create` preserves non-idempotent random creation, so controllers such as Jarvis must supply `requestId`. `maxTotalTokens` above the policy ceiling is refused with reason `budget`; an omitted value is capped to the policy value. A host that cannot read token usage refuses any create that would carry a ceiling with reason `budget-unmetered`, before any session exists.
- `peer.models` returns policy-filtered chains and models for one alias plus `selectableByThisAlias`, the policy echoed so a controller sees what it may choose. The page limit is clamped by `modelsLimit`/`modelsLimitMax`; no credentials, URLs, or provider error text cross the wire.
- `peer.selectModel` switches one idle session's routing for its next turn (`persistDefault: false`). A running or waiting session returns `peer/conflict` with `reason: 'busy'` and the latch; a cold session is treated as idle only when its agent is not running. Refusals are `peer/forbidden` with the policy's `reason` and the refused identifier. Retries are idempotent by `requestId` plus a SHA-256 of the canonical payload; the same id with a different payload is `peer/conflict` reason `request-id-reuse`. When `receipts.put()` fails, the host warns and returns `receiptPersisted: false`; when a post-restart retry arrives without a persisted receipt and the Session's live selection already matches `verdict.selection`, the host skips `sessionController.selectModel` to avoid duplicate selection events.

### Refusal reason table

| Code | `details.reason` | When raised |
|---|---|---|
| `peer/forbidden` | `unauthorized` | Missing/malformed/wrong bearer token, unknown alias/session on unauthenticated or unauthorized call, or device mismatch on handshake/participant. |
| `peer/forbidden` | `session-adoption` | `peer.create` attempts to adopt an existing or other-alias `sessionId` not bound to or created by the addressed alias. |
| `peer/forbidden` | `workspace-not-allowed` | `peer.create` `workspaceId` differs from the pairing's pinned `create.workspaceId`. |
| `peer/forbidden` | `cwd-not-allowed` | `peer.create` `cwd` resolves outside the pairing's pinned `create.cwd` (including `..` and symlink escapes). |
| `peer/forbidden` | `preset-not-allowed` | `peer.create` `agentPreset` differs from `create.agentPreset` or is absent from `create.allowAgentPresets`. |
| `peer/forbidden` | `model-change` | Adopting `peer.create` requests routing on a non-policy pairing without `allowModelChange: true`. |
| `peer/forbidden` | `routing-required`, `routing-not-configured`, `routing-unavailable`, `switch-not-allowed` | Missing create route under policy, absent `routing` block on `models`/`selectModel`, missing/failing `peerRouting`, or `allowSwitch !== 'idle-only'`. |
| `peer/forbidden` | `exposure` | `peer.follow` requested `assistantStream: true` under `answer-only` exposure. |
| `peer/forbidden` | `budget`, `budget-unmetered` | Token ceiling exceeded (`create` or `prompt`) or host lacks the `tokenUsage` projection. |
| `peer/forbidden` | `approval-outcome` | `peer.answer` received an outcome outside `allowed-once` / `rejected`. |
| `peer/forbidden` | `ask-session-mismatch` | `peer.answer` targeted a pending ask belonging to another Session. |
| `peer/forbidden` | `chain-not-allowed`, `model-not-allowed`, `price-unproven`, `training-unproven`, `tools-unproven`, `effort-not-allowed`, `unknown-route` | Routing policy verdict refusal (`details.denied` names the refused route or chain). |
| `peer/conflict` | `busy`, `request-id-reuse` | `peer.selectModel` on a running/waiting Session, or `peer.create`/`peer.prompt`/`peer.selectModel` reusing a `requestId` with a changed payload. |
| `peer/unavailable` | `receipt-store-unavailable`, `receipt-write-failed`, `receipt-finalize-failed` | Input receipt store failed to open at startup or refused a write-ahead/finalization flush for keyed `peer.create`, `peer.prompt`, or `peer.receipt`. |

### Model attribution and usage

`peer.state` and `peer.follow` report which route actually answered a turn. `lastTurnEnd.ran` carries `{ provider, model, chain?, hops, usage? }`, folded from the durable `assistant/message` `message.source` (the answering link) and the `llm/attempt-failed` records inside that turn's `turn/start`…`turn/end` window. `hops` counts the failed attempts seen in the window; `usage` is the answering message's own four-bucket sample when the adapter reported one. `state.model` remains the Session's current selection (what the next request is configured to run), so a rolling chain can make it differ from `lastTurnEnd.ran`.

Every durable `llm/attempt-failed` also yields one synthetic `model-hop` record (`{ from, to?, reason: 'rate-limit' | 'error' | 'cooldown' | 'unavailable', chain?, at }`) at the source event's durable `seq`, in both exposures. It never carries the provider `message`, `status`, or `requestId`, because provider prose can contain request text and URLs; `debug` additionally keeps the raw `llm/attempt-failed` record exactly as before. The reason mapping is closed: `RATE_LIMIT` and `PROVIDER_POOL_EXHAUSTED` answer `rate-limit`; credential, entitlement, quota, and route-capability codes answer `unavailable`; everything else answers `error`. No durable code represents a skipped cooling route yet, so `cooldown` is reserved. `state.recentModelHops` carries the newest 32 hops of the folded window (`RECENT_MODEL_HOPS_LIMIT`), oldest first; older hops stay available as stream records through `peer.follow` and `peer.page`.

`state.usage` maps the durable `tokenUsage` projection into the same four buckets (`inputTokens` is its uncached-input bucket; cache reads and writes are separate). The harness carries no billing data, so cost is never reported. `state.budget` appears only when a token ceiling is known (`{ maxTotalTokens, usedTokens, exceeded, metered }`, with `usedTokens` the sum of the four buckets). `metered` is true only when the `tokenUsage` projection was actually read for the session; with a ceiling but no readable usage the host reports `{ usedTokens: 0, exceeded: false, metered: false }` instead of claiming the ceiling is enforced. `lastTurnEnd.stop` is `'budget'` only on the turn the host's ceiling watcher stopped.

### Token-ceiling enforcement

The host enforces the ceiling a binding records. A watcher registered with the plugin listens to every durable `assistant/message` and `turn/end`; a Session without a binding ceiling costs one in-memory lookup and nothing else. For a capped Session the watcher reads the durable `tokenUsage` projection with at most one observation in flight per Session (events that land during the read collapse into one trailing re-check), and when the four-bucket total has reached the ceiling while the Agent is still running it stops the turn once through the Agent's cancel with the durable hook cause `{ kind: 'hook', reason: 'peer/budget' }`, keeping queued inbox work, and logs one bounded line. That cause already exists in the session format, so the marker needs no `SESSION_FORMAT_VERSION` bump. The request that crossed the ceiling always finishes first: the projection advances only when its Assistant message commits, so the stop lands on what follows and the terminal reports `stop: 'budget'`. The stamp is derived from the durable marker, not from the current budget sample, so it survives a host restart; a human or peer stop records a `user` cancel cause and is never stamped, even on an over-budget session. Repeated events in one turn never issue a second stop, and a later turn started while the Session stays over budget (for example an autonomous wake from a settlement or goal continuation) is stopped again after its own first Assistant message, which bounds the overshoot to one request per turn.

`peer.prompt` refuses new peer spend once the budget is exceeded: it answers `peer/forbidden` with reason `budget` and the configured ceiling as `denied`, before any prompt reaches the Session Controller. `peer.answer` and `peer.cancel` stay allowed because they spend nothing new and are stop controls; answering a pending ask can resume the turn, and the watcher stops it again after the next response. The ceiling counts the projection's four buckets, never cost, so a caller that reads `budget` between a response and its commit can see a sample one response behind. A create's requested `maxTotalTokens` is clipped to the pairing policy's ceiling (an omitted value takes the policy value), and the recorded binding value is what both the watcher and the prompt gate enforce.

Measured guidance (keyless sandbox self-test, 2026-11-17): a tool-using orchestrator turn costs about 13–17k input tokens, dominated by the tool schema, so a ceiling below ~40k can be crossed by ONE turn. Because the crossing request always finishes first, the stop lands after that answer is delivered (`stop: 'budget'` on a delivered turn); a 20k ceiling was observed to do exactly that. Budget at least ~40k for a first short turn and roughly 13–17k per further turn. A mid-turn `peer.cancel` is stamped `user`, never `budget`, consistent with the durable-marker rule above.

### Measured catalogue facts (keyless sandbox self-test, 2026-11-17)

On the shipped sandbox catalogue the `free` chain resolved 13 members, and `peer.models` returned 14 policy-filtered rows, all zero-price and ungated. All 14 reported `trainsOnData: 'yes'`, so `requireNoTraining: true` refuses the entire free group; every priced Kilo row is gated, so on this catalogue `price-unproven` is provable only by unit test on the engine. One real 429 during a chain turn surfaced as a single `model-hop` record, with no raw failure event or provider prose at `answer-only` exposure. These are observations of one keyless sandbox run, not guarantees about a different catalogue.

<a id="caller-bridge"></a>
## Caller bridge

`PeerClient` (or the `./client` export) speaks the unary envelope, opens `peer.follow` over the WS mux, reconnects with exponential backoff, repairs durable holes through `peer.page`, and reports `peer/target-unreachable` instead of retrying forever. Callers supply the pairing bearer credential via `outboundToken` (or `token` / `Authorization: Bearer` in `headers`), and loopback callers additionally pass the launch-token cookie through `headers` and a `webSocket` factory receiving `(url, headers)`.

<a id="model-experience"></a>
## Model Experience

### Peer-originated turns

#### What the model sees

A `peer.prompt` enters the target session as an ordinary attributed `user/message`; the host injects no prompt text, and the peer stream, latch frames, and ask traffic never reach a model request.

#### Token effect

One admitted peer prompt costs its message content plus the session's normal request envelope. An adopted session keeps its routing unless `allowModelChange` permits a model change, or the pairing's `routing` policy authorizes the switch. A `peer.selectModel` change applies to the next request only and never moves the deployment default.

#### KV Cache effect

A peer prompt appends at the normal user-turn boundary and preserves the reusable prefix; changing the model through `peer.create` changes the route and therefore the cache identity.

## Known Limitations and Deferred Work
<a id="known-limitations-and-deferred-work"></a>

- **A job binding records scope; it is not confinement.** Only the mounted execution lanes enforce their budgets. Peer enforces the reactive token ceiling with up to one in-flight model request of overshoot per turn, not a preventive token or hard cost cap. Steps, tool calls and wall time require the worker execution guard; file roots, subprocess isolation and egress require the external supervisor. Do not enable dispatch based on `ready` alone.

- **Peer attribution is durable for prompt and cancel only.** `peer.prompt` writes the peer tag into the target `user/message` source and `peer.cancel` into the abort cause, so the host latch reports them; `peer.create` and `peer.answer` remain visible through `peer.state`/`peer.follow` only. `peer.selectModel` records a process-local `model-change` action with actor and `provider/model`; it is not durable because the Session Controller's `model/selection` payload carries no participant and widening that persisted payload would need a format migration.
- **A switch and its receipt are not one transaction.** `peer.selectModel` appends the selection first and writes the idempotency receipt after it. When `receipts.put()` fails, the host warns and returns `receiptPersisted: false` so callers know cross-restart idempotency was not persisted. Retained receipts replay before the idle check and never overwrite a newer selection; on a post-restart retry without a persisted receipt, the host skips `sessionController.selectModel` when the Session's live selection already matches `verdict.selection`, though if a later switch moved the Session to a different route after an unpersisted write or receipt eviction, the host cannot distinguish a stale retry from a new request because `model/selection` carries no `requestId`.
- **The routing trio needs a mounted service.** `model-discovery`, `model-routing-at-create`, and `model-switch` are advertised only while `peerRouting` is present; the handshake computes capabilities per call, so the ledger stays build-wide while the advertisement stays deployment-accurate.
- **Ceiling enforcement needs the usage seam.** `token-ceiling` is advertised only while the token meter (the registrant of the `tokenUsage` projection) is mounted, and a create that would carry a ceiling on a host without it is refused with `peer/forbidden` reason `budget-unmetered` before any session exists. Enforcement is responsive, not preventive: the host stops a Session after the response that reaches `maxTotalTokens` commits, and a request already in flight is never aborted mid-stream. A Session whose Agent is not running when the over-budget response commits has nothing to stop, and a turn that re-enters while the budget is still exhausted is stopped after one further response. A binding that predates a restart into an unmetered host still answers `budget.metered: false`; the prompt gate and watcher then fall through rather than guess.
- **Unkeyed `peer.create` remains non-idempotent.** Controllers such as Jarvis must send `requestId` on `peer.create` to obtain deterministic session ids and payload-bound replay; without `requestId`, a retry after a lost response creates another Session and moves the alias binding (the retired Session stays addressable by explicit `sessionId`).
- **A `peer.selectModel` replay is answered from the receipt before the idle check.** A same-id, same-payload retry returns the original value with `replayed: true` even when the Session has since started running; the receipt is the authority, not the current latch.
- **Write-ahead `'prepared'` receipts stay `'unknown'` until reconciled.** A host crash between writing the `'prepared'` input receipt and completing `sessionController.create`/`prompt` leaves a `'prepared'` entry in `peer-input-receipts.json`; `peer.receipt` reports `'unknown'` when no session or log evidence exists (or when the log is unreadable), and reconciles honestly from the Session store/log when the side effect did commit. Unlike `peer.selectModel` (which returns `receiptPersisted: false`), `peer.create` (with `requestId`) and `peer.prompt` refuse with `peer/unavailable` before side effects when receipt persistence fails.
- **Queue removal requires durable alias attribution.** `peer.cancel` leaves older queued prompts without an alias-scoped `source.rpcId` untouched, even when their receipts can be read. A local operator can remove those prompts from the queue.
- **`peer.models.models` is empty when `allowModels` is empty.** `models` is the pinned-route projection; with `allowModels` absent or empty it is empty even when `chains` has ready members, so read `chains[].members` for the chain-selectable set.
- **`allowModels` also narrows every member of a selected chain.** A chain selection is not a bypass: each resolved member must match `allowModels`, `requireZeroPrice`, `requireNoTraining`, `requireTools`, and `allowReasoningEfforts` like a pinned route.
- **Follow limits end logical streams, not arbitrary shared Gateway sockets.** `PeerClient` closes its dedicated socket on failure and enforces its own open, idle, lifetime, item and byte limits. The server cannot make a non-reading socket receive its gap; raw callers must treat a missing terminal or carrier failure as a resync, never as completion.
- **A durable ask does not preserve its resolver.** Restart expires pending records without resuming their turns. A crash after journaling a winning decision but before delivery can leave a replayable decision without evidence that the turn received it. Retention is bounded; an evicted answer cannot be replayed.
- **Exposure is per pairing only** (per-session overrides were cut) and the debug read surface stays P3: request snapshots and diagnostics are not exposed.
- **SRC dispatch.** The namespace runs on `@Remote` SRC markers; generated strict Typert faces (`./typert`/`./remote`) are not published yet.
- **A settled ask is broadcast, never left answerable.** Any settle — a local client, a peer answer, the bounded wait, or a cancellation — aborts the ask's dispatch signal, so the forwarded-event gateway cancels the pending ask for every connected client and stops replaying it to clients that attach later. The profile peer bridge withdraws its locally surfaced card when the follow's next `state` frame drops the ask.
- **`peer.create` maps deeper failures into the peer vocabulary.** A create/adopt/routing failure raised by the Session Controller or preset registry (`agent-preset/not-found`, `session/model-unavailable`, …) becomes `peer/not-found` with the original code preserved in `details.reason` and as the cause; peer-domain and `gateway/bad-request` errors pass through unchanged.
- **`peer.create` routing** goes through `session.selectModel` with `persistDefault: false`, so a peer-created Session is routed without rewriting the deployment default model (doc 70 §6, doc 72 G6).
- **Aliases are unique per host.** The wire `PeerTarget` carries no peer discriminator, so the pairing loader rejects a repeated alias across peers instead of letting one device's `create` hijack another's bound session (doc 72 G8).
- **Hops are associated by log position.** `llm/attempt-failed` records carry no turn id, so the fold attributes them to the open turn. An attempt that interleaves from another emitter inside the same window (for example a parent-compaction request) could be counted toward that turn. Agent-loop step retries have no hop record at all: an `assistant/attempt` failure retried under a `request/header` reason `change` is not reported, and neither is a debug guess at its route.
- **Cost is out of scope.** Token totals come from provider-reported usage; the harness has no billing data, so `PeerTokenUsage` is never a bill and `budget` is a token ceiling only.
- The `api/` group README row is deferred to the translation tooling.

<a id="dev-note"></a>
### Dev Note

`src/latch.ts`, `src/exposure.ts`, `src/disposition.ts`, and `src/routing-policy.ts` are pure; `src/pairings.ts` is filesystem-bound; `src/receipts.ts` owns the bounded idempotency and write-ahead input receipt documents; `src/host.ts` owns the namespace, dispatch, routing enforcement, attribution, and watchdog; `src/client.ts` owns the caller transport. Tests: `tests/pairings.spec.ts`, `tests/latch.spec.ts`, `tests/disposition.spec.ts`, `tests/registry.host.spec.ts`, `tests/host.spec.ts` (real agent loop, fake routing service), `tests/routing-policy.spec.ts`, `tests/receipts.spec.ts`, `tests/client.spec.ts`, and `tests/live-host.e2e.ts` (real `dsh web` + `tests/peer.overlay.yml`).
