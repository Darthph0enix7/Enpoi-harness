# dsh-enpoi-peer-bridge

Caller side of the device-to-device peer API (doc 69 P2, doc 70, doc 27's thin
bridge). One harness drives a *remote* harness session: prompt it, follow it to
a terminal state, read the answer, answer its asks, cancel it. The remote keeps
its own tools, workspace, approvals, and model routing — this package never
executes anything remotely.

## Tools

| Tool | What it does |
|---|---|
| `peer_status {alias}` | Handshake (host identity, capabilities, protocol) + `peer.state`: exposure, target session, latch, descendants, pending asks, current model. |
| `peer_sessions {alias?}` | Discovery across every caller-role pairing: alias, peer, endpoint, the bound remote session id (local `remoteSessionId` pin or the host-reported session), exposure, latch summary, and last activity; an unreachable host is that row's error. Read-only. |
| `peer_ask {alias, message?, waitMs?, resume?}` | Adopts/creates the session when needed, prompts it as an attributed peer turn, follows through reconnects and `peer.page` repair, and returns the FINAL turn once the session is settled (no live descendant or ask, quiet window elapsed); otherwise the structured pending/failure result. A followed turn that enters `waiting_approval` returns EARLY with `status: 'waiting_approval'` and the pending ask(s) (`askId`, `kind`, `toolName`, `reason`, question options); `resume: <requestId>` continues that same turn to completion without re-sending the message. A host that stops answering mid-follow returns `status: 'host_unreachable'` after `probeIntervalMs` (never cancelling the remote turn). |
| `peer_asks {alias}` | Pending remote asks (approval and question kinds); question rows carry the question ids and option labels. |
| `peer_answer {alias, askId, outcome \| answers[]}` | Settles an approval ask (`allowed-once` \| `rejected`) or a question ask (`answers: [{id, selected[], custom?}]`). First answer wins. A malformed selection is rejected locally with the reason; the host is never called. A transport failure re-reads `peer.state` and reports `confirmation: 'lost'` when the ask is already gone, instead of a failure that invites a blind retry. |
| `peer_cancel {alias}` | Cancels the remote active turn, attributed to this caller. A transport failure re-reads the latch: no active turn surfaces as `confirmation: 'lost'`, not as a failed cancel. |

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
    token: null                   # reserved; sent as Authorization: Bearer, not verified by the host yet
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
`--select <questionId>=<label>` for multi-question asks). A `peer/conflict`
answer means another participant settled it first — the bridge reports that
and never retries blind. Nothing is auto-answered.

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
so a recorded prompt is never reported as unadmitted. An error frame for
`peer/not-paired`, `peer/not-found`, `peer/forbidden`, or `peer/version-skew`
stops the follow with that code instead of reconnecting at backoff cadence; a
durable hole `peer.page` cannot prove contiguous is reported through the
warning sink with its `[from, to)` range and the replay continues past it.

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
- The pairing `token` is sent as `Authorization: Bearer` but never verified by
  the host yet; the peer path must stay tailnet/LAN-only.
- The host-side `peer.create` binding and the host pairing are separate
  concerns; this package only reads caller-role entries.
- Uses a local copy of the harness peer client (`src/peer-client.ts`) because
  `@deepseek-ai/dsh-api-peer` is not a profile dependency; keep the frame
  contract in step with `packages/api/peer/src/client.ts`. The local copy
  additionally breaks on caller-terminal error frames, warns on accepted
  repair holes, and (in `src/index.ts`) settles a followed turn before
  returning; the harness client still retries every non-skew error.
