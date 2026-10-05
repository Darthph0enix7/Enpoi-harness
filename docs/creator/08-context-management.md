# 08 — Context management

The layers a long session passes through, in order, with the knobs that control each. Sources are repo-relative: `packages/…` = the harness repo; `profiles/<profile>/packages/…` = the installed fork packages. Design authority for the whole system: `~/dsh-migration/66-compaction-and-recall-design.md`; live evidence: `~/dsh-migration/evidence/context-eval/`.

Model-visible surface order (top to bottom): system prompt + tool list (frozen) → epoch stubs → segment summaries → state checkpoint (keeper brief) → whiteboard → recent tail (never compacted). Checkpoint and whiteboard are replace-in-place context blocks; segments are frozen once committed (`66…:283-300`).

## 1. Tool-result pruner (deterministic, every turn)

- Middle-span pruning only: when a tool result exceeds `thresholdChars`, keep `headChars` + `\n\n[... tool result middle pruned ...]\n\n` + `tailChars` (`packages/compaction/compaction-tool-result-pruner/src/config.ts:7-14`). Defaults: 8192 / 4096 / 1024 chars.
- Knobs: plugin config `thresholdChars`, `headChars`, `tailChars`; live overrides via `enpoi-orchestration.parameters.compaction.pruneThresholdChars|pruneHeadChars|pruneTailChars`, read per prune (`compaction-tool-result-pruner/src/settings.ts:41-57`).
- Guard: `headChars + marker + tailChars ≤ thresholdChars` must hold; at load a violation throws, and a settings combination that would grow the text is ignored whole (`config.ts:55-63,76-89`).
- Failure mode: a pruned middle is gone from the request but stays in the log — recover with `session_event_read` (eval: 371/371 call pairs pruned, 0 orphans, middles retrievable — `evidence/context-eval/report` figures in `66…:728-731`).

## 2. Context Keeper + Living Brief (background, model-backed)

- The keeper is a SERVICE, not a watcher (`profiles/web/packages/enpoi-context-keeper/src/index.ts:37`). Consumers (Oracle, councils) ask for a fresh brief at their own start. Disable switch: `capabilities.tools.keeper` (default true) — disabled ⇒ no prose distillation, consumers degrade to the deterministic fold (`index.ts:102-113,586-588`).
- The brief is five sections with a zero-filler rule: 🎯 goal/trajectory, 📚 documentation inventory, 🏛️ invariants/decisions, 🚫 rejected approaches, ⚡ blockers/open questions (`index.ts:158-189`). Secrets are excluded by prompt instruction (`index.ts:162`).
- Config defaults (per-wake, live-editable; `parameters.keeper` overrides with clamps — `index.ts:140-155,327-351`):
  - `provider`/`model` = `freellmapi`/`auto`; `fallbackProvider`/`fallbackModel` = `antigravity`/`gemini-3.7-flash-tiered`
  - `leaseMs` 45 s; `maxInputEvents` 80; `maxOutputTokens` 2048 (clamped to the 4096 ceiling; a cap-cut output is retried once at the ceiling — `index.ts:207-214`)
  - `structuralDistanceK` 24; `minRefreshMs` 60 s; `negativeCacheMs` 120 s
  - `claimsBatchSize` 8 or `claimsBatchMinutes` 5; `checkpointStaleEvents` 12; `checkpointStaleHours` 24
- Route ladder (resolved once per run, `index.ts:354-444`): `personas.keeper` (with optional `chain` → frozen link list) > plugin Config primary → fixed fallback. A route link that fails 2 consecutive times is quarantined for 5 minutes (in-process memory, resets on restart); request-shaped failures (`CONTEXT_WINDOW_EXCEEDED`, `INVALID_REQUEST`, `UNSUPPORTED_CONTENT`, `IMAGE_OFFLOAD_REQUIRED`, `FREE_TIER_GATED`) never strike a route (`index.ts:1940-2023`).
- Brief freshness order (`index.ts:573-646`): negative-cache → anti-thrash floor (`minRefreshMs`) → structural distance (`structuralDistanceK`, counted over user/turn/tool events only) → single-flight join → distill. Silence never invalidates prose; a joiner never inherits the originator's abort.
- Shape gate: a published brief needs ≥1 recognized section header, ≥1 bullet, ≥40 chars (`KEEPER_MIN_BRIEF_CHARS`); tool-call echoes, markup blobs, and header-less landings are rejected and the route ladder advances (`index.ts:1597-1676`). The gate exists because a probe answer was once published as the brief (live defect 2026-09-27, `index.ts:1633-1638`).
- Claim extraction: one pass per 8 non-aborted turn-ends or 5 minutes, `CLAIMS:` JSON with `category` ARCHITECTURE|CONFIG_VALUES|PROJECT and `source` `tool` (execution-verified) or `chat` (`index.ts:191-202,1679-1699`). Claims feed memory (see §5).
- **State checkpoint**: append-only `state/checkpoint` event; the newest replaces the previous on the surface. Fields: `version` (monotonic), `basedOnSeq`, `basedOnStructuralCount`, `model`, `via` `llm|template`, five-section `text`, `telemetry` (`index.ts:759-800`). Rendered block is `### State checkpoint` + text + a telemetry line (`session started … · turn N · today … · refreshed at seq N · by route · via llm|template`) (`index.ts:810-862`).
  - Refresh triggers: a segment cut (`compaction/end|summary`), the staleness floor (12 structural events or 24 h, fires on its own), on demand; token pressure is an extra trigger only (`index.ts:759-772,1436-1461`).
  - The deterministic template fold always produces a valid checkpoint, so a provider outage cannot leave the layer empty (`index.ts:864-871`).
  - Failure mode: no reader consumes `state/checkpoint` today — it is log-only until the Watchtower State card lands (`index.ts:762-764`). Do not expect to find it in the prompt.

## 3. Compaction

- **Seat:** `personas.compaction` is the designated summariser seat (Settings → Agent Models, group BACKGROUND & SUPERVISION). Unassigned it INHERITS the session model — nothing changes by default. A `chain` resolves to its first enabled link; a stale/disabled chain inherits instead of failing (`packages/compaction/compaction-basic/src/settings.ts:128-161`).
- **Economics:** a different summariser model loses the prompt-prefix cache and pays full input price for the whole region, so only free/local routes are reliably cheaper (`role-registry.ts:161-167`, `AgentModelsBody.tsx:217`). The readout follows the seat assignment, else the catalog default (`compaction-policy.ts:75-131`).
- **Settings** (`parameters.compaction`, read fresh per decision, fail-open per field — `settings.ts:97-126`; UI mirrors at `packages/client/ui-brand-enpoi/src/client/params-store.ts:77-90`):
  - `thresholdRatio` 0.8 — pressure fraction; `retainRatio` 0.16 — verbatim tail as a fraction of (window − output reserve)
  - `headroomTokens` 65 536 — output reservation/headroom; `retainTokens` 0 — absolute tail (wins over `retainRatio` when > 0)
  - `pruneThresholdChars` 8192, `pruneHeadChars` 4096, `pruneTailChars` 1024 — the pruner (§1)
  - Validation: ratios in (0,1], positive integers; an invalid field is ignored, never a failed turn; a retention ≥ the threshold falls back to the resolved config (`66…:564-571`). Per-model overrides exist only in the plugin Config `modelPolicies`, not in settings (`66…:581-583`).
- **Effective-policy readout:** Settings → Orchestration → Compaction shows the derived threshold and retained tail for the selected route, computed exactly like `resolveCompactSpec`: threshold = min(window × ratio, window − outputReserve − headroom), reserve = min(headroom, window/2); a `problem` line appears when the combination cannot fire or the catalog lacks the window (`compaction-policy.ts:63-131`).
- **Summariser call & window framing:** the LLM call is one cache-aligned pass; `summarizerFraming()` caps the input by the summariser's own window — `inputBudgetTokens = window − min(maxTokens, window/2)` — keeps the system head + newest messages that fit, and marks `windowClipped` (`compaction-basic/src/index.ts:331-346`, `summarizer.ts:190-222`). On a clip, the checkpoint gains a code-assembled `[compaction coverage]` note naming the seq span and the recall tools (`region.ts:454-460`). No window metadata ⇒ raw replay as before. A single message larger than the whole budget is not split; it relies on the output-cap guard and then the mechanical fallback (`66…:585-601`).
- **Failure ladder** (`66…:115-124,321-343,603-618`): model summary → validation (coverage, shrink ratio, schema) → deterministic template/mechanical fallback. The model summary must shrink the route-priced span or it is rejected (`SummaryNotSmallerError`, `region.ts:470-482`).
- **Mechanical fallback (automatic transactions only):** replace the oldest balanced prefix of the selected span with ONE code-assembled omission stub, sized to beat the stub's price; the rest of the span stays verbatim; events stay in the log (`region.ts:489-530`). The stub text names recovery: "Recover anything you need … with `session_event_search` (keywords), `session_event_read` (seq), or `session_search`" (`summarizer.ts:84`). A durable `compaction/summary` event for a mechanical stub records `provider: ''` / `model: ''` — never price it as a model route (`66…:615-616,640-641`).
- **Smart vs mechanical — the automatic/manual seam:** automatic (`owner: 'current-turn'`, whole-surface) passes `allowMechanicalFallback: true`; manual `/compact` (`selected-span`) passes `false` and stays fail-loud so the operator sees the real error (`compaction-basic/src/index.ts:507,544-546`). The `compaction/summary-error` waterfall (`packages/compaction/compaction/src/index.ts:93-107`) gets a chance to repair the input before either path.
- **Never alters the transcript (hard rule):** compaction writes a surface `replace` only. The chat fold shadows a span only for a user-initiated revert; automatic compaction, manual `/compact`, and keeper checkpoints render every row, with no marker card (`66…:529-537`). Verify: `node ~/dsh-migration/evidence/ghost-revert/ghost-revert-probe.mjs <sessionId> --json` → `shadowRanges: []` and all rows rendered.

## 4. Whiteboard (authored truth, replace-in-place)

- Storage: `enpoi-orchestration.whiteboard` = `{ version, docs: { global?, projects: { <cwd> }, sessions: { <id> } } }`; entries have `kind` path|rule|fact|task, `pinned`, `version`, and stale flags (`profiles/web/packages/enpoi-whiteboard/src/board.ts:7-14,37-54`).
- Resolution on read: global → project → parent session (direct-child inheritance) → session, later scopes overriding by entry id (`board.ts:16-22,394-414`). Injected as `### Pinned context (vN)` after the keeper checkpoint (context order 140; `board.ts:133-140,447-461`).
- Budget: hard 1500 rendered tokens (4 chars/token estimate); an over-budget write is refused, never trimmed; session buckets GC at 200 newest (`board.ts:142-149,478-505,741-757`).
- Tools: `whiteboard_read`, `whiteboard_write`, `whiteboard_pin`/`whiteboard_unpin`; `path` entries are validated on write and flagged `(stale)` — never auto-deleted (`board.ts:524-560`). Council fibers keep the whiteboard even when all retrieval and mutation tools are denied (`enpoi-council/src/core/fiber.ts:117-126`).
- Failure modes: a hand-edited settings file can't break a turn (malformed entries dropped, `board.ts:214-230`); a pin inside a later-reverted span dies with the span; "forget" removes an entry but the injection is a projection, so nothing else changes.

## 5. Memory (durable, tool-driven — no passive block)

- Tools (`profiles/web/packages/enpoi-memory/src/tools.ts`): `memory_save` (≤400 chars, saved with operator trust, dedupes), `memory_search` (returns facts; never injects), `memory_rescind` (tombstone — never injected again), `memory_confirm` (graduates a tentative, chat-sourced claim; `memory_save` already lands committed).
- Retriever top-K and char budget come from `parameters.memory` (`retrieverTopK` 10, `retrieverCharBudget` 1200 defaults; `params-store.ts:91-95`), resolved fresh per call (`tools.ts:73-75`).
- Failure modes: an invalid/duplicate fact answers `saved: false` with the reason; `memory_confirm` on an already-committed id says "Already <state>" rather than "unknown".

## 6. Recall tools (the backstop)

- Mounted: `session_search`, `session_event_search`, `session_event_read`, `session_trace`, `session_event_trace` (`packages/session-query/tool-session-query/src/index.ts:66-109`). Search is FTS over directives/assistant text/tool metadata — never raw tool output (`66…:223-230`).
- Indexing runs off the hot path (background reconcile + targeted per-session indexing). A live session's documents are folded **incrementally**: only appended events are classified, and the SQLite writer applies row deltas (insert new documents, update surface flips by retained rowid) instead of deleting and rewriting the session; any failed write or non-continuation prefix falls back to the complete fold, with identical results (`packages/session-query/session-query-sqlite/src/live-documents.ts:36`; `src/index.ts:601-660`; measured ≈900× faster document build, ≈20,000× faster FTS row write at 20k docs — evidence `phase4/`). A cross-session search that must wait answers the coded `SESSION_QUERY_INDEXING` with `indexed/total` progress instead of aborting (`66…:732-744`).

## 7. Insights & `ds backfill`

- Context Insights (dsh-context) reads the persisted projection cache; the session log stays authoritative. Checkpoint writes are throttle-driven (`writeEveryEvents`, `writeIntervalMs` — both required) plus mandatory points: session creation, `turn/end`, disposal (`packages/session/session-projection-cache/README.md`).
- After a format/`stateVersion` change, stored rows become unreadable at the new generation: dashboards render blank until each session is opened once. Reindex with `ds backfill status` (first session-list page must show `withContextTimeline > 0`), then `ds backfill run` until it drains — idempotent, resumable (`--limit`), skips attached sessions (`~/.local/bin/dsh-projections-backfill.mjs`; playbook safeguard #15 in `~/dsh-migration/50-future-re-porting-and-upgrade-playbook.md:308`).
- Failure mode: `contextTimeline` missing from list rows makes the dashboard blank even when the cache is warm — check the exclusion list before re-running the fold.

## 8. Revert iterations (the ◀ x/y ▶ branch history)

Every user message committed over an earlier one belongs to a **variant group**: the original event is the anchor, each later send adds a variant whose `previousSeq` is the tree edge, and reverted-away versions stay restorable from their original events — no content or media is copied. The durable record is the fixed-size `revert/iteration` marker (log-only, `ignorable`, appended after the replacement with the assigned seq) (`packages/core/session/src/types.ts:480-492`). A pre-marker session derives the same edges from user-origin `surfaceOp.startSeq` replacements (`packages/api/session-controller/src/iteration-fold.ts:88-166`).

- **List:** `revertIterations` is cold-safe (an unattached session folds the log), bounded (default 50, max 200 groups/variants), returns capped text previews plus attachment ids, and marks a variant `surfaceActive` when it is a surface node or cited by a compaction checkpoint (`packages/api/session-controller/src/commands.ts:840-935`). The fold runs on host and client, so every attached client's x/y data refreshes from the event stream (`iteration-fold.ts:1-15`; wire block `SessionRevertFold.iterations`). History paging is incremental as well: prepending a page adopts the host's durable fold and folds only entries beyond its `asOfSeq`; a full-window replay remains only as the fallback for a window-derived fold (`packages/api/session-controller/src/client/sessions/session.ts:773-830`).
- **Restore is a branch swap, never a run:** `revertIterationRestore` validates the target before any write, then appends three `revert/state` markers (pin the current branch end, move the file boundary to the target branch end, disarm) plus one `revert/branch` whose `restoredSeqs` the surface fold splices in place of the current span; the target branch's original records are re-activated by identity — no user message, no turn, no model call (`commands.ts:930-1080`; `packages/core/session/src/surface.ts:453-530,658-662`; no-run proof `packages/api/session-controller/tests/revert-iterations.host.spec.ts`). Switching back and forth is exact because the displaced branch's records are recorded on each switch (`iteration-fold.ts:182-210`).
- **Attach on demand:** reverts, restores, branch switches, and file-conflict resolution resolve the session through the same attach path as a send, so they work on a freshly opened session whose agent is not live (`commands.ts:770-775,820-826,945-951,1122-1129`; `resolveAgent` `commands.ts:1197`).
- **Running turn:** a restore cancels the branch's running work, waits up to 5 s (`ITERATION_RESTORE_IDLE_TIMEOUT_MS`) for the agent to settle, and refuses with retryable `session/agent-busy` / `ITERATION_RESTORE_TURN_ACTIVE` **before any write** when it does not (`commands.ts:96-99,960-975`).
- **UI:** a visible user message in a group with more than one variant renders `◀ x / y ▶` (real buttons, localized `aria-label`s, `aria-live` position); arrows move a component-local preview only — transcript, log, and files are untouched until `Restore` writes through the host. Previews are fetched on first navigation, an active-pointer move resets the preview, and a failed restore shows "Restore failed — try again." on the row (`packages/client/ui-chat/src/client/chat/MessageItem.tsx:345-475`).
- **File state** follows the branch through the existing `revert/state` + file-revert plugin path: a backward switch reverts, a forward switch un-reverts; branches whose mutations were never captured surface through the conflict tray exactly like an ordinary revert.
- **Known limitation:** a specific variant can legitimately refuse with `revert-invalid` ("has no restorable branch records") when no commit independently shadowed its branch — a later user-origin commit from an independent earlier message can shadow a whole multi-group suffix, and pre-marker fallback logs record restorable branches only for spans a replacement cited, so some variants of a multi-group history are not restorable (`commands.ts:986-988`; `packages/api/session-controller/tests/revert-iterations.host.spec.ts:152-170`).

## 9. Failure modes → fix

| Symptom | Cause | Fix |
|---|---|---|
| Model sees a huge tool result | Pruner disabled/misconfigured; `head+marker+tail > threshold` ignored whole | Check `parameters.compaction.prune*`; confirm the plugin row is mounted; recover the middle with `session_event_read` |
| Brief stale or missing | both keeper routes dead → quarantine; or keeper disabled | Check `enpoi-keeper.log`; verify `personas.keeper` / Config routes; wait out the 5-min quarantine or fix the route |
| Keeper published a probe echo | shape gate rejected the landing (it is never published) | Route ladder is advancing; fix the keeper model or prompt env |
| Compaction never fires | retention ≥ threshold, headroom too large, or catalog has no window for the route | Read the Effective-policy readout `problem` line first |
| "Context was compacted but the chat lost messages" | Should be impossible by rule §3 | Run the ghost-revert probe; if rows are hidden outside a user revert, that is a regression |
| Whiteboard write refused | rendered board over 1500 tokens | Unpin/shorten entries; unpin is the only way to make one compactable |
| Cross-session search errors | FTS index not ready | Retry after the background pass; error names `SESSION_QUERY_INDEXING` with progress |
| Insights blank after update | stale projection cache generation | `ds backfill status`, then `ds backfill run` (check `withContextTimeline`) |

## 10. Token usage, prompt prefix anatomy & KV cache economics

- **Turn 1 input anatomy (~12.4k tokens)**:
  - 38 tools with detailed JSON schemas: ~8,200 tokens (32,924 characters of parameter definitions and descriptions).
  - System prompt (prefix + fleet doctrine + instructions): ~2,800 tokens (11,021 characters).
  - Initial turn context & user prompt: ~1,400 tokens.
- **KV prefix cache behavior**:
  - On Turn 1 Step 2, `cacheReadTokens` hits ~12,416 (a 99.9% cache hit). The model only bills/processes the delta tokens (e.g. 342 tokens).
  - Modern providers (DeepSeek, Claude, OpenAI) discount cached prompt tokens by 90–95% (e.g. DeepSeek bills prompt cache hits at $0.014 / 1M tokens).
  - The shared prefix parity law across `orchestrator`, `sysadmin`, and `creator` ensures that switching presets reuses the exact same 12.4k cached prefix without flushing the KV cache.

## 11. Session listing & query performance optimizations

- **`session.list` single-flight coalescing & window memo**:
  - Single-flight promise dedup (`listInFlight`) prevents redundant concurrent filesystem scans and is decoupled from caller abort signals (an aborting client never fails background readers).
  - In-memory 2,000ms ordered window memo (`cachedOrdered`) serves rapid repeat calls in ~50ms (down from 1,000ms+), with zero-staleness event listeners (`session/created`, `session/disposed`, `session/event`).
- **SQLite FTS5 PRAGMAs**:
  - `schema.ts` sets `synchronous = NORMAL`, `temp_store = MEMORY`, `mmap_size = 64MB`, `cache_size = -16MB` for the session-query FTS5 database, eliminating disk spills during window sorts.
- **ChatView virtual-window index memoization**:
  - Lazy getter `getIndexByKey()` memoizes the Map lookups across streaming chunks until item count changes, eliminating Map allocations on streaming chunks.
