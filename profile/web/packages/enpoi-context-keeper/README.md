# dsh-enpoi-context-keeper

English | [中文](README.zh.md)

Demand-driven cognition for the Enpoi Harness: the prose Living Brief is materialized only when the Oracle or Council asks for it, while the state checkpoint is refreshed at segment cuts and on the staleness floor. The prose brief is consumer and display output; it is not injected into model requests. The state checkpoint is the model-visible derived-state layer.

## Living Brief

`BriefService.ensureFreshBrief()` distills the five-section brief from the recent active surface through the keeper route chain. Freshness is structural-event distance (`structuralDistanceK`, default 24) with an anti-thrash floor (`minRefreshMs`, default 60 s); failures are negative-cached (`negativeCacheMs`, default 120 s). Consumers share one in-flight distillation per freshness window, and a structurally stale `turn/end` schedules one debounced background prefetch so the next Oracle or Council call usually hits the cache. Raw tool-call echoes, JSON tool envelopes, and mostly-markup payloads are rejected before they can become prose.

The keeper reads the current model-visible surface, not the raw append-only log. Reverted or abandoned branches cannot supply operator text or a checkpoint anchor. A bare `user` producer is visible as `USER_ROLE_UNVERIFIED`, not as operator authority; peer and subagent-parent messages are derived context; assistant text is public observation with private reasoning excluded; tool calls and results are observed, not verified execution. Disposing the brief service clears its cache and advances per-session ownership, so an in-flight pass cannot publish stale prose after disposal or session eviction.

## State checkpoints

`CheckpointService.ensureCheckpoint()` writes a durable `state/checkpoint` event and one plugin-sourced surface `user/message` that replaces the previous checkpoint node in place. The model path asks for one current-continuity JSON item draft: operator goals, constraints, stated decisions, observed evidence, and unresolved work. For operator items, code accepts only an exact quote of a complete text block or complete line run from a currently active human operator message at the cited sequence. Invalid JSON, an inactive or wrong-source anchor, a future sequence, or a non-exact quote discards the whole draft and uses the deterministic template once, with no retry. An accepted quote proves the words, not their interpretation or truth; the template always produces a valid checkpoint when every route fails.

The newest active `enpoi-keeper` `user/message` is the authoritative prior derived state. Every wake and every cache hit reads its `content`, strips the public `State checkpoint` wrapper, and uses that text; the raw `state/checkpoint` event and the source's duplicated `sections` are not read for continuity. A context repair that replaces one line on that active message is therefore visible on the next wake with zero model calls and zero appends on a cache hit. A deferred pending commit is dropped when the active keeper sequence changed, so an older rendered block cannot replace a repaired surface.

`checkpointMaxChars` bounds the complete emitted block, including the header, derived-state notice, body, and telemetry line. It accepts an integer from 256 to 12,000 and defaults to 2,400; the body is clipped on a code-point boundary and the fixed wrapper survives when possible.

While a `compaction/start` bracket is open, a refresh that finishes writes only the durable `state/checkpoint` event; its surface message is parked until the matching `compaction/end`, clean or errored. An open tool batch defers the same way. Each completed compaction refreshes the checkpoint once: held summary ids pair with their matching clean end, and handled ids stay in a bounded per-session ring so a replay cannot refresh twice. A forced refresh arriving during an older pass waits for it and then runs one pass covering the boundary. A refresh that completes after session or plugin disposal publishes nothing.

After HMR or a remount, compaction bracket state is rehydrated from at most the last 64 events. If that bounded reverse probe ends before finding a `compaction/start`, hydration stays conservatively unknown and surface commits are held; a later `turn/start` proves the old boundary cannot still be mid-summary and clears the hold. If a cold reopen finds the newest durable checkpoint but the active keeper surface node is missing, the service re-materializes that block at the same version instead of inventing a new version.

The Watchtower State display reads the raw `state/checkpoint` event. After an active-surface repair it can show the pre-repair text until the next genuine refresh. That is display lag only, not a functional gap and not a reason to fake a version bump.

## Claims

One batched claims pass runs per `claimsBatchSize` non-aborted `turn/end` events or `claimsBatchMinutes`, whichever comes first. Every extracted claim is filed as tentative `untrusted_external`, including a claim whose exact human quote passed verification: the quote proves the words existed, not their interpretation, acceptance, or truth. Operator authority stays with explicit `memory_save`, `memory_confirm`, and operator tools. Each batch carries one structural settlement proof: `source: keeper`, a non-empty `sessionId`, a non-negative integer `batchBasedOnSeq`, and `settled: true`.

## Configuration

Every field is a live-editable `.volatile()` value; `enpoi-orchestration.parameters.keeper` overrides the plugin row per wake.

| Field | Default | Meaning |
|---|---:|---|
| `provider` / `model` | `kilo` / `poolside/laguna-s-2.1:free` | Primary keeper route |
| `fallbackProvider` / `fallbackModel` | absent | Optional second route; both must be set |
| `leaseMs` | 45000 | Bound on one wake |
| `maxInputEvents` | 80 | Active-surface events retained in one framed input |
| `maxOutputTokens` | 2048 | Brief/claim output cap, clamped to the 4096 ceiling |
| `structuralDistanceK` | 24 | Structural-event distance that triggers a re-distillation |
| `minRefreshMs` | 60000 | Anti-thrash reuse floor |
| `negativeCacheMs` | 120000 | Failure negative-cache window |
| `claimsBatchSize` | 8 | Non-aborted turn ends per claims pass |
| `claimsBatchMinutes` | 5 | Minutes per claims pass |
| `checkpointStaleEvents` | 12 | Structural events before a staleness-floor refresh |
| `checkpointStaleHours` | 24 | Hours before a staleness-floor refresh |
| `checkpointMaxChars` | 2400 | Complete emitted checkpoint block bound, validated 256–12000 |

The keeper can be disabled through `enpoi-orchestration.capabilities.tools.keeper`; when disabled, prose distillation, claims extraction, and checkpoint refreshes are skipped.

## Known limitations

- The checkpoint surface message stores the rendered block in `content` and again in its `source.sections` entry. The durable log therefore carries the body twice, but continuity reads only the active `content`. This is an existing `SourceContextFormed` snapshot form, with no new event, source kind, or format version.
- The raw `state/checkpoint` event and the Watchtower State display can lag behind a repaired active surface until the next genuine refresh. The model-visible active message is authoritative.
- An exact operator quote is evidence of wording, not of interpretation, acceptance, or current truth; a one-off request is not a standing rule.

## Tests

```sh
cd profile/web
npx vitest run packages/enpoi-context-keeper/tests
```
