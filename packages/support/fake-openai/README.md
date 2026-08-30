---
description: "Synthetic OpenAI-compatible fake provider proxy for keypool matrix tests, for test authors exercising pool rotation and quota recovery without a provider key."
kind: "package-library"
---

# @deepseek-ai/dsh-fake-openai

English | [中文](README.zh.md)

## Summary

`dsh-fake-openai` is a synthetic OpenAI-compatible HTTP proxy for `llm-pi-ai` keypool matrix tests: it binds a loopback `http` server on an OS-chosen port, serves `GET /v1/models` and `POST /v1/chat/completions` with real rate-limit headers and SSE chunk streams, and exposes `setScenario` / `resetKey` so tests can exhaust one identity, rotate to the next, and verify repromotion without hitting a real gateway. Each key carries its own rolling-window counters (`requests` per `windowMs`) and scenario overrides (`429`, `500`, `mid-stream`) that the request handler consumes deterministically.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

This package lets a pool matrix test speak the OpenAI protocol without a provider: create the fake, point a real `llm-pi-ai` adapter at its `url`, and script per-key quota and failure behavior through `setScenario`.

### Creating the fake

```ts
import { createFakeOpenAI } from '@deepseek-ai/dsh-fake-openai'

const fake = await createFakeOpenAI({
  port: 0,
  keys: [
    { id: 'pri-1', key: 'sk-pri-1', limits: { requests: 2, windowMs: 60_000 } },
    { id: 'pri-2', key: 'sk-pri-2', limits: { requests: 10, windowMs: 60_000 } },
  ],
})
// POST /v1/chat/completions with Authorization: Bearer sk-pri-1 now enforces quota.
fake.setScenario('pri-1', { failMode: '429', resetAfterMs: 46_000 })
fake.resetKey('pri-1')
await fake.close()
```

`createFakeOpenAI` validates host, port, and key uniqueness, allocates per-key `KeyState` (`count`, `windowStart`, `scenario`), and listens on `127.0.0.1` by default. Every `POST /v1/chat/completions` request is recorded in `handle.requests` with its parsed JSON body, detached headers, matched `keyId`, and response `status` for assertions.

### Quota and scenario behavior

Per-key rolling windows advance `count` on each successful request and reset after `windowMs`; exceeding `requests` returns `429` with `x-ratelimit-*` and `retry-after` headers derived from the window. A `setScenario` override takes precedence: `remaining: 0` or `failMode: '429'` forces a quota response with `resetAfterMs` (defaults to the window remainder), `failMode: '500'` returns `500`, and `failMode: 'mid-stream'` streams two SSE `chat.completion.chunk` events then destroys the socket to exercise the harness commit barrier. `resetKey` / `resetAll` clears counters, windows, and scenarios.

### Running the CLI demo

```sh
FAKE_OPENAI_PORT=0 pnpm exec dsh-fake-openai
# fake-openai listening at http://127.0.0.1:<port>
#   GET  http://127.0.0.1:<port>/v1/models
#   POST http://127.0.0.1:<port>/v1/chat/completions  (Bearer sk-pri-1 / sk-pri-2)
```

The bin starts a loopback server with two demo keys (`pri-1` / `sk-pri-1` with `requests: 2`, `pri-2` / `sk-pri-2` with `requests: 10`) and prints its URL. Use `FAKE_OPENAI_HOST` and `FAKE_OPENAI_PORT` to override the listener.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design of the fake; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design

The fake is built on one rule: each accepted `POST /v1/chat/completions` request either serves a deterministic success (JSON or SSE with `hello` plus `usage: { prompt_tokens: 3, completion_tokens: 1 }`) or a scripted failure chosen by per-key rolling-window state and an optional scenario override. Header construction (`quotaHeadersFor`) and durable request recording (`FakeRequestRecord`) are isolated helpers so the handler stays a single arrival-ordered branch.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | `createFakeOpenAI`: listener, `FakeKeyConfig` / `FakeOpenAIOptions`, quota windows, `setScenario` / `resetKey`, SSE and JSON responses |
| [`src/bin.ts`](src/bin.ts) | `dsh-fake-openai` CLI entry with env `FAKE_OPENAI_HOST` / `FAKE_OPENAI_PORT` |
| [`src/invariant.ts`](src/invariant.ts) | Invariant companion (no runtime invariant; quota and streaming are exercised through HTTP tests) |

### Wire flow

A request enters the handler, is routed by method and path (`GET /v1/models*` vs `POST */chat/completions`), validates `Authorization: Bearer <key>` against `tokenToId`, parses the JSON body for `stream` / `model`, records a `FakeRequestRecord`, checks scenario overrides for forced `429` / `500` / `mid-stream`, enforces rolling-window quota, advances counters, and emits either `application/json` or `text/event-stream` chunks. `close()` calls `server.close()` and `closeAllConnections()`.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from the fake to the pool and retry policies it exercises.

- [llm-pi-ai pool](../../llm/llm-pi-ai/README.md) — the key rotation and cooldown policy this fake exercises.
- [llm-retry](../../llm/llm-retry/README.md) — the retry executor for provider failures.
- [llm mock server](../../test-support/llm-mock-server/README.md) — the scriptable provider fault server that complements this fake.
- [Testing policy](../../../docs/testing.md) — the coverage tiers and recovery tests this fake serves.
- [Support group map](../README.md) — sibling support packages.

-----

<a id="model-experience"></a>
## Model Experience

### Synthetic provider proxy

#### What the model sees

The fake proxy never contacts a real model; the harness adapter under test receives synthetic `chat.completions` payloads that `createFakeOpenAI` serves from memory, including per-key quota headers and SSE `chat.completion.chunk` streams. The synthetic success carries `hello` as `content` and a minimal `usage` block so adapter recovery and key-rotation tests can run without a provider key.

#### Token effect

Synthetic completions return fixed `prompt_tokens: 3` and `completion_tokens: 1`, so token-meter assertions can check stable totals without provider variance.

#### KV Cache effect

No provider cache is involved; requests terminate at the loopback server and never reach a provider KV cache.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define when the fake needs special care. They are current package constraints, not a task backlog.

- **Rolling window only; no monthly quota simulation** — each key's `windowMs` enforces an in-memory rolling counter that resets after the window elapses; calendar-month resets and gateway-side monthly quotas are deferred and must be tested against a real gateway or a higher-level mock.
- **QUOTA cooldown floor lowered from 60m to 30s** — `PoolEngine`'s `CLASS_COOLDOWN_MS.QUOTA` changed from `60*60_000` to `30_000`; a monthly-exhausted key without a `Resets in` hint is now re-probed every 30s, burning one failed `429` attempt per request cycle until a hint or `recordSuccess` clears it. This is intentional for rolling windows but hammers monthly quotas — the rolling-vs-monthly window distinction is deferred (see above).
- **Probing is hint-driven, not scheduled every 30s** — the fake itself does not probe keys on a timer; the real `llm-pi-ai` pool probes cooling identities optimistically on the next request, with the `30_000` ms QUOTA cooldown floor and parsed `resetAfterMs` hints (clamped to `[30s, 24h]`) driving rotation, not a fixed 30s probe loop.
- **Single-process, in-memory state** — quota counters, windows, and scenario overrides live in the test process and are not durable; parallel test workers must use separate fake instances to avoid cursor sharing, and `resetKey` / `resetAll` is the only window control.
- **Limited wire surface** — only `GET /v1/models*` and `POST */chat/completions` are implemented; other OpenAI routes return `404`, non-POST chat completions return `405`, and `mid-stream` failure destroys the socket after two SSE chunks rather than emulating gateway-specific framing errors.
- **No persistence or metrics** — request records are held in `handle.requests` for assertions and are not forwarded to telemetry or the session log.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
