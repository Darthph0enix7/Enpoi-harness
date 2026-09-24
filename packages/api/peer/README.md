---
description: "Device-to-device peer API: the narrow no-auth serving namespace, the pairing store, the execution latch, the ask registry, and the caller bridge."
kind: "package-reference"
---

# @deepseek-ai/dsh-api-peer

English | [中文](README.zh.md)

## Summary

Opt-in device-to-device peer API (doc 69 P2, contract in `dsh-migration/70-peer-api-contract.md`). One host exposes paired sessions through a small `peer` namespace — `handshake`, `create`, `prompt`, `follow`, `page`, `cancel`, `answer`, `state` — while the other device drives and answers them through `PeerClient`. The serving surface is narrow by construction: every call resolves through `~/.dsh/pairings.yaml` and maps onto `session.*` behind a closed dispatch table, so it never re-exposes `settings.*`, `credentials.*`, `fs.*`, or `control.*`. There is no authentication on the peer path for now (doc 69 §9.2); binding stays tailnet/LAN-only, and the optional pairing `token` hook is enforced as soon as one is configured.

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

Mount `PeerService` on a host that already runs the Session Controller; it registers the `peer` Typert namespace, fails loud when the pairing document is malformed, and installs the ask registry that races a peer answer against the local answerer chain:

```yaml
- id: api-peer
  name: '@deepseek-ai/dsh-api-peer'
  config:
    pairingsPath: !!js dshHomePath('pairings.yaml')   # default
    bindingsPath: !!js dshHomePath('peer-state.json') # default
    watchdogMs: 900000                                # default 15 min
```

Config: `pairingsPath`, `bindingsPath`, `watchdogMs`, `harnessVersion`, `schemaDigest`.

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
      cwd: /home/adam/projects/thing
      agentPreset: sysadmin
    remoteSessionId: sess-xyz # caller-role bookkeeping
    endpoint: https://laptop.pike-acrux.ts.net:8443
    token: null               # reserved; enforced when non-null
    runawayCeiling: null      # optional emergency hop cap; null = unbounded
    allowModelChange: false   # default false (doc 69 §10)
```

`peer.create` bindings persist in `~/.dsh/peer-state.json` (0600, versioned, atomic replacement); the pairing file is never rewritten by the host.

<a id="host-surface"></a>
## Host surface

- `peer.handshake` negotiates protocol/schema/capabilities and reports visible pairings (never tokens); a protocol mismatch is `peer/version-skew`.
- `peer.state` returns the execution latch (`running | waiting_approval | waiting_subagents | idle`), `activeDescendants`, pending asks, current model selection, `lastParticipantAction`, and the cursor. It reads the host's `session.executionState` latch when that call answers (`source: 'host-latch'`, quiet children included), and otherwise derives the latch from `turn/*`, `approval/*`, `subagent/catalog`, settlement notices, and the ask registry (`source: 'derived'`).
- `peer.follow` streams an opening snapshot plus exposure-filtered durable events and latch transitions; `cursor` is authoritative for repair because `answer-only` filters records.
- `peer.prompt` always queues (a human preempts); `hopCount` is telemetry and only a configured `runawayCeiling` enforces a cap.
- `peer.answer` settles a pending ask; the local chain still sees the ask and the first settlement wins — a late answer is `peer/conflict`.
- `peer.cancel` cancels the active turn with peer attribution; the orphan watchdog aborts a peer turn whose follower never attaches (15 min default).

<a id="caller-bridge"></a>
## Caller bridge

`PeerClient` (or the `./client` export) speaks the unary envelope, opens `peer.follow` over the WS mux, reconnects with exponential backoff, repairs durable holes through `peer.page`, and reports `peer/target-unreachable` instead of retrying forever. Loopback callers pass the launch-token cookie through `headers` (and a WebSocket factory); tailnet callers need no credentials while §9.2 holds.

<a id="model-experience"></a>
## Model Experience

### Peer-originated turns

#### What the model sees

A `peer.prompt` enters the target session as an ordinary attributed `user/message`; the host injects no prompt text, and the peer stream, latch frames, and ask traffic never reach a model request.

#### Token effect

One admitted peer prompt costs its message content plus the session's normal request envelope. An adopted session keeps its routing unless `allowModelChange` permits a model change.

#### KV Cache effect

A peer prompt appends at the normal user-turn boundary and preserves the reusable prefix; changing the model through `peer.create` changes the route and therefore the cache identity.

## Known Limitations and Deferred Work

- **Peer attribution is durable for prompt and cancel only.** `peer.prompt` writes the peer tag into the target `user/message` source and `peer.cancel` into the abort cause, so the host latch reports them; `peer.create` and `peer.answer` remain visible through `peer.state`/`peer.follow` only.
- **`peer.follow` latch frames stay derived.** The opening snapshot and every `state` frame fold `turn/*`, `approval/*`, `subagent/catalog`, and settlement notices, so a quiet child can make `descendantsExact` false there; only `peer.state` reads the host latch. A cold Session also keeps the derived path, because `session.executionState` addresses attached Sessions.
- **Pending questions are process-local.** A restart drops them, exactly like a browser; the peer sees the interrupted terminal plus `idle`.
- **Exposure is per pairing only** (per-session overrides were cut) and the debug read surface stays P3: request snapshots and diagnostics are not exposed.
- **SRC dispatch.** The namespace runs on `@Remote` SRC markers; generated strict Typert faces (`./typert`/`./remote`) are not published yet.
- **A peer-answered ask is not actively cancelled in connected browsers** until the client answers or delegates, so a human may briefly still see a settled ask.
- **`peer.create` routing** goes through `session.selectModel` after creation because `session.create` accepts no provider/model today.
- README translation (`README.zh.md`, `README.i18n.yaml`) and the `api/` group README row are deferred to the translation tooling.

<a id="dev-note"></a>
### Dev Note

`src/latch.ts` and `src/exposure.ts` are pure; `src/pairings.ts` is filesystem-bound; `src/host.ts` owns the namespace, dispatch, attribution, and watchdog; `src/client.ts` owns the caller transport. Tests: `tests/pairings.spec.ts`, `tests/latch.spec.ts`, `tests/registry.host.spec.ts`, `tests/host.spec.ts` (real agent loop), `tests/client.spec.ts`, and `tests/live-host.e2e.ts` (real `dsh web` + `tests/peer.overlay.yml`).
