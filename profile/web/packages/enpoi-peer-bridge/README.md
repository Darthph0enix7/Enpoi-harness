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
| `peer_ask {alias, message, waitMs?}` | Adopts/creates the session when needed, prompts it as an attributed peer turn, follows with reconnect + `peer.page` repair, returns the answer or the structured terminal failure. |
| `peer_asks {alias}` | Pending remote asks (approval and question kinds); question rows carry the question ids and option labels. |
| `peer_answer {alias, askId, outcome \| answers[]}` | Settles an approval ask (`allowed-once` \| `rejected`) or a question ask (`answers: [{id, selected[], custom?}]`). First answer wins. A malformed selection is rejected locally with the reason; the host is never called. |
| `peer_cancel {alias}` | Cancels the remote active turn, attributed to this caller. |

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
```

Host-role fields (`sessionId`, `exposure`) are ignored by the caller; an entry
needs `alias`, `peer`, and `endpoint` to be dialable. The plugin's Config
fields (`pairingsPath`, `noticesPath`, `device`, `participantName`, `waitMs`,
`maxReconnects`) are declared `.volatile()`, so the merged settings service
exposes them as a live form persisted in the profile patch. `pairingsPath` in
the plugin config (and `--pairings` on the CLI) points at another document so a
test never touches the operator's real file.

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

`peer_sessions` (and `ds peer list`) discovers what the caller-role entries
currently address: each row shows the local `remoteSessionId` pin or the
session the host reports, with the host's latch summary and last activity, so
an operator can find the bound session before prompting or answering.

`peer.follow` snapshot/state frames read the host execution-state projection,
so on a host that mounts it they report `source: 'host-latch'`; a cold session
keeps the derived fold.

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
  contract in step with `packages/api/peer/src/client.ts`.
