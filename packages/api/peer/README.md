---
description: "Device-to-device peer API: the narrow no-auth serving namespace, the pairing store, the execution latch, the ask registry, and the caller bridge."
kind: "package-reference"
---

# @deepseek-ai/dsh-api-peer

English | [中文](README.zh.md)

## Summary

Opt-in device-to-device peer API (doc 69 P2, contract in `dsh-migration/70-peer-api-contract.md`). One host exposes paired sessions through a small `peer` namespace — `handshake`, `list`, `create`, `prompt`, `follow`, `page`, `cancel`, `answer`, `state`, `models`, `selectModel` — while the other device drives and answers them through `PeerClient`. The serving surface is narrow by construction: every call resolves through `~/.dsh/pairings.yaml` and maps onto `session.*` behind a closed dispatch table, so it never re-exposes `settings.*`, `credentials.*`, `fs.*`, or `control.*`. There is no authentication on the peer path for now (doc 69 §9.2); binding stays tailnet/LAN-only, and the optional pairing `token` hook is reserved, not enforced — the host parses the field and callers send it, but no request header is read yet (doc 72 §2.4).

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

Config: `pairingsPath`, `bindingsPath`, `watchdogMs`, `harnessVersion`, `schemaDigest`, `receiptsPath` (default `~/.dsh/peer-receipts.json`), `receiptLimit` (default 512), `modelsLimit` (default 100) and `modelsLimitMax` (default 500). `harnessVersion` defaults to the running package manifest's version — the runtime version plugin compatibility reads — rather than a literal, and `schemaDigest` defaults to `PEER_SCHEMA_DIGEST`; both stay advisory in the handshake.

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
    create:                   # present ⇒ peer.create may create/adopt under this alias
      cwd: /home/user/projects/thing
      agentPreset: sysadmin
    remoteSessionId: sess-xyz # caller-role bookkeeping
    endpoint: https://laptop.pike-acrux.ts.net:8443
    token: null               # reserved; sent by callers, not verified by the host yet
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

`routing` is parsed strictly: an unknown key, a wrong type, an empty pattern, or a pattern outside `[A-Za-z0-9._:/@*+-]` fails host load, because a silently ignored cost guard would widen what a paired controller may select. `allowModels` patterns match `provider/model` with `*` as the only wildcard (any run of characters, `/` included, anchored at both ends); `allowChains` entries are exact chain ids. A create or adopt under a pairing with `routing` must name a route — `provider`+`model`, or `chain` alone — and the host applies the routing service's resolved `selection`, never the raw request. A chain-only request is resolved by the routing service, which owns the catalogue, chain registry, and route health. Without a mounted `peerRouting` service every routing request fails closed with `peer/forbidden` reason `routing-unavailable`, and the handshake withholds `model-discovery`, `model-routing-at-create`, and `model-switch`.

`peer.create` bindings persist in `~/.dsh/peer-state.json` (0600, versioned, atomic replacement); a `create` that replaces an alias binding moves the previous session into that binding's `retired` list, so a rebound alias resolves to the newest session while every replaced session stays addressable by explicit `sessionId`. Each binding also records the session's `maxTotalTokens` ceiling (requested, or capped to the policy value); `PeerService.ceilingOf(sessionId)` reads it, including for a session a later create retired. The pairing file is never rewritten by the host.

<a id="host-surface"></a>
## Host surface

- `peer.handshake` negotiates protocol/schema/capabilities and reports visible pairings (never tokens); a protocol mismatch is `peer/version-skew`.
- `peer.list` discovers the exposed sessions: each row carries the pairing alias, peer, exposure, whether the alias resolves to a Session right now, the bound session id (the caller's `remoteSessionId`), and a one-line latch summary with last activity when the host latch answers cheaply. An optional target resolves through the same pairing gate first, so an unpaired session is `peer/not-paired` rather than listed.
- `peer.state` returns the execution latch (`running | waiting_approval | waiting_subagents | idle`), `activeDescendants`, pending asks, current model selection, `lastParticipantAction`, and the cursor. It reads the host's `session.executionState` latch when that call answers (`source: 'host-latch'`, quiet children included), and otherwise derives the latch from `turn/*`, `approval/*`, `subagent/catalog`, settlement notices, and the ask registry (`source: 'derived'`).
- `peer.follow` streams an opening snapshot plus exposure-filtered durable events and latch transitions; an ask mint or settle also pushes a `state` frame (the change key carries only `(askId, kind, since)` per pending ask), so a mid-tool-call ask surfaces without waiting for the next durable event; `cursor` is authoritative for repair because `answer-only` filters records.
- `peer.prompt` always queues (a human preempts); `hopCount` is telemetry and only a configured `runawayCeiling` enforces a cap.
- `peer.answer` settles a pending ask; the local chain still sees the ask and the first settlement wins — a late answer is `peer/conflict`.
- `peer.cancel` cancels the active turn with peer attribution; the orphan watchdog aborts a peer turn whose follower never attaches (15 min default).
- `peer.create` applies a policy-evaluated route before any session or selection exists, so a refusal leaves no session behind; a pairing without `routing` keeps the legacy `allowModelChange` gate for adopt-time routing. `maxTotalTokens` above the policy ceiling is refused with reason `budget`; an omitted value is capped to the policy value. A host that cannot read token usage refuses any create that would carry a ceiling with reason `budget-unmetered`, before any session exists.
- `peer.models` returns policy-filtered chains and models for one alias plus `selectableByThisAlias`, the policy echoed so a controller sees what it may choose. The page limit is clamped by `modelsLimit`/`modelsLimitMax`; no credentials, URLs, or provider error text cross the wire.
- `peer.selectModel` switches one idle session's routing for its next turn (`persistDefault: false`). A running or waiting session returns `peer/conflict` with `reason: 'busy'` and the latch; a cold session is treated as idle only when its agent is not running. Refusals are `peer/forbidden` with the policy's `reason` and the refused identifier. Retries are idempotent by `requestId` plus a SHA-256 of the canonical payload; the same id with a different payload is `peer/conflict` reason `request-id-reuse`.

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

`PeerClient` (or the `./client` export) speaks the unary envelope, opens `peer.follow` over the WS mux, reconnects with exponential backoff, repairs durable holes through `peer.page`, and reports `peer/target-unreachable` instead of retrying forever. Loopback callers pass the launch-token cookie through `headers` (and a WebSocket factory); tailnet callers need no credentials while §9.2 holds.

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

- **Peer attribution is durable for prompt and cancel only.** `peer.prompt` writes the peer tag into the target `user/message` source and `peer.cancel` into the abort cause, so the host latch reports them; `peer.create` and `peer.answer` remain visible through `peer.state`/`peer.follow` only. `peer.selectModel` records a process-local `model-change` action with actor and `provider/model`; it is not durable because the Session Controller's `model/selection` payload carries no participant and widening that persisted payload would need a format migration.
- **A switch and its receipt are not one transaction.** `peer.selectModel` appends the selection first and writes the idempotency receipt after it. A crash in that gap re-applies the identical selection on retry, which is harmless; a receipt write failure is logged and the switch still returns success.
- **The routing trio needs a mounted service.** `model-discovery`, `model-routing-at-create`, and `model-switch` are advertised only while `peerRouting` is present; the handshake computes capabilities per call, so the ledger stays build-wide while the advertisement stays deployment-accurate.
- **Ceiling enforcement needs the usage seam.** `token-ceiling` is advertised only while the token meter (the registrant of the `tokenUsage` projection) is mounted, and a create that would carry a ceiling on a host without it is refused with `peer/forbidden` reason `budget-unmetered` before any session exists. Enforcement is responsive, not preventive: the host stops a Session after the response that reaches `maxTotalTokens` commits, and a request already in flight is never aborted mid-stream. A Session whose Agent is not running when the over-budget response commits has nothing to stop, and a turn that re-enters while the budget is still exhausted is stopped after one further response. A binding that predates a restart into an unmetered host still answers `budget.metered: false`; the prompt gate and watcher then fall through rather than guess.
- **`peer.create` has no idempotency key.** A retry after a lost response creates another Session and rebinds the alias, retiring the previous binding; the retired Session stays addressable by explicit `sessionId`. Reconcile through `peer.list` and the binding state before retrying, and treat an unknown create outcome as uncertain.
- **A `peer.selectModel` replay is answered from the receipt before the idle check.** A same-id, same-payload retry returns the original value with `replayed: true` even when the Session has since started running; the receipt is the authority, not the current latch.
- **`peer.prompt` deduplication binds the `requestId` only.** The Session Controller's live-inbox and logged `source.rpcId` index answer the same id with `accepted: true` without comparing content, so a changed payload under a reused id is not a conflict; callers must mint a fresh request id per attempt and bind their own content hash.
- **A human Stop clears queued peer prompts.** Peer prompts enter as source kind `user`, so the Stop's inbox clear discards a queued peer prompt before it becomes a durable `user/message`; the splice carries `outcome: canceled` but not the removed message identity, so the only evidence is the missing durable user/message. A caller that saw `accepted: true` must detect that its `requestId` never reached the log and re-drive it.
- **`peer.models.models` is empty when `allowModels` is empty.** `models` is the pinned-route projection; with `allowModels` absent or empty it is empty even when `chains` has ready members, so read `chains[].members` for the chain-selectable set.
- **`allowModels` also narrows every member of a selected chain.** A chain selection is not a bypass: each resolved member must match `allowModels`, `requireZeroPrice`, `requireNoTraining`, `requireTools`, and `allowReasoningEfforts` like a pinned route.
- **`peer.follow` reads the execution-state projection for its snapshot and `state` frames too** (`host.ts` `follow`), so on a host with the projection mounted those frames report `source: 'host-latch'` like `peer.state`; a cold Session keeps the derived path, because `session.executionState` addresses attached Sessions. The live-host e2e still asserts only `peer.state` (doc 72 §2.2).
- **Pending questions are process-local.** A restart drops them, exactly like a browser; the peer sees the interrupted terminal plus `idle`.
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

`src/latch.ts`, `src/exposure.ts`, and `src/routing-policy.ts` are pure; `src/pairings.ts` is filesystem-bound; `src/receipts.ts` owns the bounded idempotency document; `src/host.ts` owns the namespace, dispatch, routing enforcement, attribution, and watchdog; `src/client.ts` owns the caller transport. Tests: `tests/pairings.spec.ts`, `tests/latch.spec.ts`, `tests/registry.host.spec.ts`, `tests/host.spec.ts` (real agent loop, fake routing service), `tests/routing-policy.spec.ts`, `tests/receipts.spec.ts`, `tests/client.spec.ts`, and `tests/live-host.e2e.ts` (real `dsh web` + `tests/peer.overlay.yml`).
