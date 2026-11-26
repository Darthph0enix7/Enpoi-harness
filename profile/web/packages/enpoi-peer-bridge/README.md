# dsh-enpoi-peer-bridge

English | [中文](README.zh.md)

Caller side of the device-to-device peer API (doc 69 P2, doc 70, doc 27's thin
bridge). One harness drives a *remote* harness session: prompt it, follow it to
a terminal state, read the answer, answer its asks, cancel it. The remote keeps
its own tools, workspace, approvals, and model routing — this package never
executes anything remotely.

## Tools

| Tool | What it does |
|---|---|
| `peer_status {alias}` | Handshake (host identity, boot `instanceId`, digests, capabilities, protocol) + `peer.state`: exposure, target session, latch, descendants, pending asks, current model, and stop intent. Observed quiescence is not proof of teardown. |
| `peer_sessions {alias?}` | Discovery across every caller-role pairing: alias, peer, endpoint, the bound remote session id (local `remoteSessionId` pin or the host-reported session), exposure, latch summary, and last activity; an unreachable host is that row's error. Read-only. |
| `peer_models {alias, limit?, cursor?, zeroPrice?, tools?}` | The policy-filtered models and chains the peer lets this caller select, with each route's capability facts (tools, vision, context window, zero price, gating, training, reasoning efforts) and each chain member's live state (`ready`, `cooldown` with `cooldownUntil`, `deprecated`); the policy is echoed as `selectable`. Read-only. A host that does not advertise model discovery answers `peer/capability-missing` with "host does not advertise model-discovery; upgrade the host". |
| `peer_switch_model {alias, provider?, model?, chain?, reasoningEffort?, requestId?}` | Moves an idle remote session to another route for its next turn (`provider`+`model`, or a chain id alone for its first ready member; naming a route inside a chain is allowed). A `chain` or route named here replaces the pairing's pinned create route for this call only. Reports the applied route, the previous one, and `replayed` for a same-`requestId` retry. The peer enforces its own allow list; a refusal carries `peer/forbidden` and the policy reason (`model-not-allowed`, `chain-not-allowed`, `price-unproven`, …), and a busy session answers `peer/conflict` with the latch. A host that does not advertise model switching answers `peer/capability-missing` with "host does not advertise model-switch; upgrade the host". |
| `peer_ask {alias, message?, waitMs?, resume?, requestId?, provider?, model?, chain?, reasoningEffort?, maxTotalTokens?}` | Adopts/creates the session when needed, prompts it as an attributed peer turn, follows through reconnects and `peer.page` repair, and returns the FINAL turn once the session is settled (no live descendant or ask, quiet window elapsed); otherwise the structured pending/failure result. The route options apply only when this call creates the session (a route named here replaces the pairing's pinned `create` route) and `maxTotalTokens` records the session's token ceiling; on an already-bound session they are refused with a pointer to `peer_switch_model` instead of being dropped. A followed turn that enters `waiting_approval` returns EARLY with `status: 'waiting_approval'` and the pending ask(s) (`askId`, `kind`, `toolName`, `reason`, question options); `resume: <requestId>` continues that same turn to completion without re-sending the message. A host that stops answering mid-follow returns `status: 'host_unreachable'` after `probeIntervalMs` (never cancelling the remote turn). |
| `peer_asks {alias}` | Reads the host ask journal when the host advertises `durable-asks`, including `answered`, `expired`, and `cancelled` asks. On older hosts, warns and reads the live pending list instead. |
| `peer_answer {alias, askId, requestId?, outcome \| answers[]}` | Submits one approval (`allowed-once` \| `rejected`) or question decision (`answers: [{id, selected[], custom?}]`). Reusing the ID with the same decision can confirm a prior settlement (`replayed: true`) without delivering it again. |
| `peer_cancel {alias}` | Requests Stop with peer attribution. `stopIntent` separates the request from execution observations; `keepInbox: true` preserves queued work. A lost reply and an inactive turn do not prove the request took effect. |

## Pairing document

Reads caller-role entries from `$DSH_HOME/pairings.yaml` by default:

```yaml
version: 1
device: serverlocal
pairings:
  - alias: co-dev
    peer: laptop                  # device being called
    exposure: debug               # host-role; required by the host parser
    endpoint: https://laptop.pike-acrux.ts.net:8443
    remoteSessionId: sess-xyz     # optional; omit to address the alias (create/adopt)
    outboundToken: null           # optional; plaintext bearer secret sent when dialing endpoint
    tokenHash: null               # host-role inbound credential hash (ignored by caller)
    inboundToken: null            # host-role plaintext inbound credential (ignored by caller)
    insecure: false               # host-role auth opt-out (ignored by caller)
    create:
      cwd: /home/user/projects/thing
      agentPreset: standard
      provider: antigravity            # optional; pins the created session's route
      model: gemini-3.8-flash-tiered   # required with provider
      chain: loopback                  # optional; forwarded only with provider+model
      reasoningEffort: high            # optional; forwarded only with provider+model
```

Host-role fields (`sessionId`, `exposure`) are ignored by the caller; an entry
needs `alias`, `peer`, and `endpoint` to be dialable. A caller-role alias names
the pairing — under the fleet convention the member device — and is the same
string in both devices' documents, not the target host name. An unknown alias
fails with the caller-role aliases and the peer each targets,
e.g. `available: pc → serverlocal`. A `create` block forwards its session
defaults to a fresh create; `create.provider` and `create.model` additionally
pin that session's route (the host applies them with `persistDefault: false`,
so no deployment default changes) and must appear together — a lone half fails
document parsing — while `create.chain` / `create.reasoningEffort` are
forwarded only with the pair. The plugin's Config
fields (`pairingsPath`, `noticesPath`, `device`, `participantName`, `waitMs`,
`settleMs`, `maxReconnects`, `probeIntervalMs`) are declared `.volatile()`, so
the merged settings service exposes them as a live form persisted in the
profile patch.
`pairingsPath` in the plugin config (and `--pairings` on the CLI) points at
another document so a test never touches the operator's real file.

The shipped host-side bundle row is `peer-api` (`packages/api/peer`); a
`--patch` overlay must override that row by id — an `insert` registers a second
namespace and the duplicate `peerService` fails the load (`tests/peer.overlay.yml`
in the fork is the working example).

## Remote asks

While `peer_ask` follows a remote turn, a pending approval ask is raised
*locally* through `ctx.approval.request` with the remote tool name and a
`remote ask on <alias>` reason; an `allowed-once` / `rejected` decision is
relayed as `peer.answer`. A question ask is raised through the local
`userQuestions` service the same way; the chosen labels are relayed as a
structured `peer.answer` with `{kind:'question', answer:{answers[]}}`. The local
card is linked to the follow's lifetime: if the follower goes away first (the
turn reaches a terminal, `waitMs` elapses, the caller aborts, or the socket
dies), the pending card is withdrawn (`cancelled`) and the remote ask is left
answerable through `peer_answer`. When the remote ask settles elsewhere first
(another device answered, the remote bound expired, or a browser at the host
won), the follow's next `state` frame drops it from `pendingAsks` and the
bridge withdraws that one card without relaying anything — settlement is not a
refusal and the host enforces first-answer-wins. Surfacing runs concurrently
with the follow loop under a small bounded in-flight set with contained
errors, so an open card never stalls frame processing. When the local service
cannot be used (no `approval`/`userQuestions` service, no agent, no open turn)
the ask — approval or question, with its options — is written to a durable
notice file (`<pairing dir>/peer-bridge/asks.jsonl`) and stays answerable
through `peer_answer` / `ds peer answer` (questions with `--select <label>`, or
`--select <questionId>=<label>` for multi-question asks). Nothing is auto-answered.

For each ask, the bridge records a generated answer ID in `answer-requests` beside its notices file before sending, without storing decision contents. `peer_answer` and local-card relays use the same ID for that ask and caller unless an explicit `requestId` is supplied. A lost reply does not establish who answered or whether the ask expired. To check for a replay, use the same ID and decision. Do not retry an expired ask or one from a worker generation the host rejected.

A followed turn that enters `waiting_approval` does not hold the caller until
`waitMs`: `peer_ask` returns EARLY with `ok: false`, `pending: true`,
`status: 'waiting_approval'`, the session id, the request id, and the pending
asks as structured `pendingAsks[]` rows (plus the summary `asks[]` lines). The
calling agent — or a human watching a non-interactive lane — decides each ask
with `peer_asks`/`peer_answer`; calling `peer_ask` again with
`resume: <requestId>` then follows the SAME remote turn to its terminal state
without re-sending the message (`resumed: true`, `admitted: false`). The
requestId is the follow's causal anchor: when the opening snapshot still
carries the original admission record (and even the terminal, when the turn
ended before the resume), the remaining result is attributed to exactly that
turn. The early return tears the follow generation down, so a local card that
was opened concurrently is withdrawn (`cancelled`) and the ask stays
answerable through `peer_answer`; `waitMs` remains the cap for stalls without
an ask.

`peer_sessions` (and `ds peer list`) discovers what the caller-role entries
currently address: each row shows the local `remoteSessionId` pin or the
session the host reports, with the host's latch summary and last activity, so
an operator can find the bound session before prompting or answering.

`peer.follow` snapshot/state frames read the host execution-state projection,
so on a host that mounts it they report `source: 'host-latch'`; a cold session
keeps the derived fold.

## Follow reliability

`peer_ask` assigns one prompt `requestId` and derives a separate `createRequestId`. On a lost reply it checks `peer.receipt` and reports the host's disposition without resending. For a prompt this can be `queued`, `claimed`, `cancelled_before_dispatch`, `terminal`, or `unknown`; a missing or unreadable receipt means `unknown`, not “never admitted.” To retry the operation, supply the returned `requestId` with the same message and create options; use `resume` instead to follow an admitted prompt without resending. Keep credentials out of request IDs. Hosts with bounded receipts can forget earlier requests; do not assume an old ID is safe to replay.

Handshake digest differences and missing optional ask capabilities are warnings. Worker readiness, job updates, export reads, and waiting for a quiescence observation are CLI-only; they do not add tools or permissions to the peer group.

`peer_ask` and `ds peer ask`/`follow` keep following past the first `turn/end`
while a child, an ask, or a follow-up turn is live, and accept the session as
settled only after a quiet window (`settleMs`, default 2000 ms; `--settle-ms`
on the CLI) and a confirming `peer.state` read at the cut. Records are
deduplicated by seq, so a reconnect snapshot replay never appends the same
assistant text twice, and a later turn REPLACES the previous turn's text.
Answers are attributed causally: only the turn whose `turn/start` precedes our
admitted `user/message` (or a later continuation turn) feeds the result, so a
concurrent third-party turn is never returned as ours. Once our turn has a
terminal, a later turn opened by a different operator's prompt freezes the
result on our own turn (`superseded: true`), and a terminal carries only the
answer text committed for that same turn. `admitted` reports the host's prompt
acceptance (the accepted `peer.prompt` response or the durable `user/message`),
so a recorded prompt is never reported as unadmitted.

With `bounded-follow`, the caller acknowledges each consumed nonterminal frame in order. A `gap` frame or `peer/gap` reopens the follow and repairs history with `peer.page`; it never reports completion. The caller stops after three consecutive gap retries without new durable events. If the host returns `follow-capacity`, back off before opening another follow.

A host that dies mid-turn (a sleeping laptop, a cut link) leaves the follow
socket open and silent, so silence alone can never distinguish "the host is
gone" from "the model is generating". After `probeIntervalMs` (default 30000
ms; 0 disables) without a frame, `peer_ask` makes one cheap bounded `peer.state`
call: any answer — even a structured error — keeps the follow waiting; only a
host that does not answer at all ends the follow early with
`status: 'host_unreachable'`, `sessionId`, the last observed `latch`/`cursor`,
and a note that the remote turn was NOT cancelled and may resume if the host
wakes. `waitMs` remains the outer bound for reachable-but-silent turns.

## Known limitations and deferred work

- `hopCount` is sent as 0: this bridge does not track autonomous-exchange
  chains, so `runawayCeiling` cannot fire for traffic this caller generates
  (doc 69 §9.3 / doc 70 §12 reserve the counter, it is not implemented).
- The caller sends `outboundToken` as `Authorization: Bearer` when dialing `endpoint` and never logs or echoes it in tool output or errors; host-role fields (`tokenHash`, `inboundToken`, `insecure`, `create.allowAgentPresets`) are accepted and ignored, while the ambiguous legacy `token` key is rejected with a configuration error naming `outboundToken`. Keep the peer path tailnet/LAN-only when a pairing sets `insecure: true`.
- The host-side `peer.create` binding and the host pairing are separate
  concerns; this package only reads caller-role entries.
- The caller handshake reports the installed harness version, resolved from
  the `@deepseek-ai/dsh-api-peer` manifest beside the running profile or the
  installer's `harness/install-state.json` under `$DSH_HOME`;
  `DSH_PEER_HARNESS_VERSION` overrides it, and a build with neither source
  fails closed with a clear error instead of sending a made-up identity.
- Uses a local copy of the harness peer client (`src/peer-client.ts`) because `@deepseek-ai/dsh-api-peer` is not a profile dependency; keep it in step with `packages/api/peer/src/client.ts`. Local answer ID files are not pruned automatically; the host independently bounds its journal, so a retained local ID does not guarantee replay.
