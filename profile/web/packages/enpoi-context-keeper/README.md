# dsh-enpoi-context-keeper

English | [中文](README.zh.md)

Demand-driven cognition for the Enpoi Harness: the prose Living Brief is materialized only when the Oracle or Council asks for it, while the state checkpoint is refreshed at segment cuts and on the staleness floor.

## Living Brief

`BriefService.ensureFreshBrief()` distills a five-section brief from the recent session log through the keeper route chain. Freshness is structural-event distance (`structuralDistanceK`, default 24) with an anti-thrash floor (`minRefreshMs`, default 60 s); failures are negative-cached (`negativeCacheMs`, default 120 s). Consumers share one in-flight distillation per freshness window, and a structurally stale `turn/end` schedules one debounced background prefetch so the next Oracle or Council call usually hits the cache. Raw tool-call echoes, JSON tool envelopes, and mostly-markup payloads are rejected before they can become prose.

## State checkpoints

`CheckpointService.ensureCheckpoint()` renders the brief into a durable `state/checkpoint` event plus the single plugin-sourced surface message that replaces the previous checkpoint node in place. The deterministic template fallback keeps the layer valid when every model route fails.

While a `compaction/start` bracket is open, a refresh that finishes writes only the durable `state/checkpoint` event: its surface message is parked until the matching `compaction/end`, clean or errored. That end flush is the boundary's single surface write; the forced end call returns the flushed checkpoint instead of paying a second pass, so the bracket contains zero keeper surface messages.

A segment cut refreshes the checkpoint exactly once per completed compaction: the listener holds every `compaction/summary` id and refreshes on the first matching `compaction/end` that carries no `error`. The end decides the transaction, so model-written, mechanical, and summarizer-failure summaries all refresh on a clean end; a summary alone, a mismatched id, an errored end, and a duplicate end never refresh. Handled ids are remembered per session in a fixed-size ring, so a completed summary/end pair that replays cannot refresh twice; the per-session memory is LRU-bounded and cleared on `session/disposed` and plugin disposal.

A forced refresh that arrives while an older refresh is in flight awaits that pass and then runs one refresh covering the boundary; it never returns the older snapshot as the boundary's checkpoint. A failed pass is not retried eagerly, leaving the natural staleness floor to try again. A refresh that completes after `session/disposed` or plugin disposal publishes nothing. The staleness floor fires at `turn/end` after `checkpointStaleEvents` structural events (default 12) or `checkpointStaleHours` hours (default 24), whichever comes first; token pressure is an extra trigger only.

## Configuration

Every `Config` field is a live-editable `.volatile()` value, and `enpoi-orchestration.parameters.keeper` overrides the plugin row per wake. The route fields (`provider`, `model`, `fallbackProvider`, `fallbackModel`) follow the keeper persona assignment; `leaseMs`, `maxInputEvents`, and `maxOutputTokens` bound one wake. The brief uses `structuralDistanceK`, `minRefreshMs`, and `negativeCacheMs`; claims use `claimsBatchSize` and `claimsBatchMinutes`; checkpoints use `checkpointStaleEvents` and `checkpointStaleHours`.

The keeper can be disabled through `enpoi-orchestration.capabilities.tools.keeper`; when disabled, prose distillation, claims extraction, and checkpoint refreshes are skipped.

## Tests

```sh
cd profile/web
npx vitest run packages/enpoi-context-keeper/tests
```
