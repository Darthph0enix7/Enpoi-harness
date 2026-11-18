# 13 — Upstream Merge Runbook & Core Delta Inventory

This document is the authoritative reference for merging future upstream releases (e.g. 0.2.0+) into the Enpoi Harness fork. It catalogs every core modification we maintain over upstream, explains the architectural contract behind each delta, and gives an ordered step-by-step merge runbook with automated verification probes to ensure zero regressions.

---

## Part 1: Core Delta Inventory by Subsystem

### 1. Session Storage, Paging, and Revert Core

| File | Upstream Behavior | Enpoi Fork Contract | Why / What Breaks if Overwritten |
|---|---|---|---|
| `packages/api/session-controller/src/list.ts` | Rescans every session directory from disk on every `session.list` RPC; no memory cache; unhandled duplicates throw and blank the session list. | (1) Deduplicated listing with generation tie-breaking.<br>(2) Single-flight promise coalescing (`listInFlight`) decoupled from caller abort signal.<br>(3) In-memory 2,000ms ordered window memo (`cachedOrdered`) invalidated on `session/created`, `session/disposed`, `session/event`. | Upstream re-scans 1,300+ sessions on every tab switch or refresh (1,000ms+ latency). An unhandled duplicate or disk race crashes listing and empties the rail. |
| `packages/api/session-controller/src/commands.ts` | Keeps restore requests in Map without clearing on agent disposal. | Disposed agent hook cleans up `this.iterationRestoreRequests.delete(agent.session.id)`. | Memory leak across long-lived processes. |
| `packages/session/session-persistence-jsonl/src/index.ts` | Throws `duplicate JSONL session id` on collision, failing the entire corpus listing. | `listArtifacts` logs a warning and yields the newest generation rather than throwing. | One stray or copied directory hides all 1,300+ sessions from the UI. |
| `packages/session-query/session-query-sqlite/src/schema.ts` | Default SQLite PRAGMAs (disk spill on window sorts). | Sets `PRAGMA synchronous = NORMAL`, `temp_store = MEMORY`, `mmap_size = 64MB`, `cache_size = -16MB`. | 10x-20x slowdown during full-text event search. |
| `packages/core/session/src/revert-fold.ts`<br>`packages/api/session-controller/src/history.ts` | Reverting truncates or shadows without branch-switching markers; no version navigator. | Introduces `revert/branch` event and `SessionRevertFold` tracking active surface vs inactive variants; `revertIterationRestore` swaps records by identity without re-running the agent turn. | Upstream re-runs the prompt and burns model tokens when restoring an older turn; fork swaps branches instantly and cleanly. |
| `packages/session/session-persistence/src/retention-pins.ts` | Basic session log cleanup. | Enforces retention pins for iterations, image offloads, compaction checkpoints, and branch records (`RetentionViolationError`). | GC or compaction would destroy historical revision trees. |

#### Session format V5 fork collision rule

- `SESSION_FORMAT_VERSION` is one integer and the format catalog requires exactly one `v4->v5` package. Two different V5 semantics cannot coexist.
- When the fork implemented V5, upstream `origin/master` still wrote V4 and had no `session-format-v4-to-v5` package. Before any future integration, re-check upstream and sync branches for `SESSION_FORMAT_VERSION = 5` or a V5 edge. If upstream lands a V5 first, stop and reconcile semantics with the owner; never add a second V5 package.
- After acceptance, `docs/persistence-changes/finalized/v5.json` locks the fork's V5 semantics. A later upstream V5 must be adopted if compatible, or explicitly refused while coordinating a new number/scheme; the integer has no fork discriminator.

### 2. Client Rendering, Markdown, and Navigation

| File | Upstream Behavior | Enpoi Fork Contract | Why / What Breaks if Overwritten |
|---|---|---|---|
| `packages/client/ui-chat/src/client/chat/ChatView.tsx` | Rebuilds `indexByKey` Map on every virtual window render / streaming chunk. | Lazy getter `getIndexByKey()` memoizes the Map across streaming chunks until item count changes. | High CPU churn during streaming in long sessions. |
| `packages/client/ui-primitives/src/markdown/parse.ts` | `micromark-extension-math` parses single `$…$` without boundary guards, turning currency like `**$4** … **$7**` into math AST. | `singleDollarTextMath: false` + `mathTextGuard` rejecting digit-adjacent, whitespace-padded, or multiline single `$`. | Currency symbols break bold/italic formatting and substitute Unicode math glyphs (`∗`, `⋅`). |
| `packages/client/ui-primitives/src/markdown/MarkdownText.tsx`<br>`copy.ts` | Native browser copy serializes KaTeX MathML elements into per-glyph newlines. | Container-level `onCopy` interceptor extracts formula source and serializes clean Markdown + KaTeX-free HTML. | Copy-pasting text from chat produces broken one-character-per-line strings. |
| `packages/client/ui-sidebar-right/src/client/service.ts` | Clicking a file card in chat opens the file in whatever dock tab is active (even watchtower or subagents). | File/diff cards (`dsh-resource://file/...`) auto-focus or mount the Workspace Files tree tab so preview docks beside the file tree. | Files open docked next to subagent transcripts instead of the project directory. |
| `packages/client/ui-sidebar-documentpreview/src/client/TextPreview.tsx` | File preview title is static read-only text. | Interactive inline input: click to edit, Enter navigates relative/absolute paths (even outside workspace), Escape cancels. | Quick file inspection requires multiple tool clicks. |
| `packages/client/ui-layout/src/client/columns.ts` | `RIGHTBAR_DEFAULT_RATIO` = 0.45 (~648px on 1440px). | `defaultRightbarWidth()` = max(sidebar 280 + 96px, 22% of the frame) capped at 420px (300px floor); a dragged width stores px + frame ratio, cached per origin and hosted in `enpoiUiState.layout`. | Right sidebar opens excessively wide by default, and a per-origin cache lost the width whenever the entry URL changed. |

### 3. Orchestration, Presets, and Permissions

| File | Upstream Behavior | Enpoi Fork Contract | Why / What Breaks if Overwritten |
|---|---|---|---|
| `profile/web/cordis.patch.yml`<br>`profile/web/presets/*/agent.cordis.yml` | Each agent preset has separate system prompt headers; switching agents flushes prefix cache. | **Shared Prefix Parity Law:** Orchestrator, Sysadmin, and Creator share byte-identical system prompt prefixes; role differences live strictly in suffix. | Switching presets invalidates the 12.4k token KV cache and forces full prompt re-ingestion. |
| `packages/enpoi-capabilities/src/policy.ts` | Tools without exact entries fall through to `defaults.unknownTools: ask`. | Shipped defaults table (`SHIPPED_TOOL_DEFAULTS`) explicitly maps every advertised tool; completeness spec guards against unconfigured tools. | Integrated tools (goals, ralph, workflow) prompt user approval cards repeatedly. |
| `packages/enpoi-capabilities/src/forwarding.ts` | Subagent approval requests either prompt user or fail silently under unattended modes. | Subagent requests forward to main session; in Full Access the child matches the root's standing consent with no model judgement or budget, an explicit root deny still wins, a child deny applies at every spawn, and the child keeps its own sandbox limits. Idle parent requests park in `~/.dsh/cache/approval-parks.json`. | Subagents either stall indefinitely or execute dangerous commands without parent oversight. |
| `packages/enpoi-capabilities/src/policy.ts` (danger rails) | Bare regex matching on command line. | Recursive wrapper inspection (`sudo`, `nice`, `timeout`, `env`) + expanded danger vocabulary (`shred`, `truncate`, `find -delete`, `find -exec rm`). Delegated children cannot consume standing operator grants. | Destructive commands bypass approval via shell wrappers or inherited grants. |
| `packages/subagent/tool-subagent/src/index.ts` | Subagents see same tool list as parent or generic deny list. | Creator-only tools (`plugin_manager`, `cordis_inspect_*`) stripped from all child roles (`SHARED_CHILD_DENY`); subagents receive PTC batching guidance. | Subagents attempt to install plugins or execute creator surgery. |
| `packages/enpoi-whiteboard/src/index.ts` | Any subagent can write/pin/unpin/forget entries on the shared whiteboard. | `CHILD_AUTHORING_REFUSAL` enforces subagents are read-only; only main orchestrator/operator can author entries. | Subagents overwrite or wipe user's pinned whiteboard context. |

### 4. PTC / `run_code` Integration

| File | Upstream Behavior | Enpoi Fork Contract | Why / What Breaks if Overwritten |
|---|---|---|---|
| `profile/web/cordis.patch.yml`<br>`presets/*/agent.cordis.yml` | `tool-presentation mode: native` in default presets; `run_code` disabled. | `tool-presentation mode: both` across orchestrator, sysadmin, creator, and subagents (`fixer`, `explorer`). | Multi-file loops and batch inspection require dozens of serial turns instead of one single Node turn. |
| `profile/web/presets/orchestrator/agent.cordis.yml`<br>`packages/subagent/tool-subagent/src/index.ts` | Generic run_code prompt descriptions. | Explicitly documents the three runtime conventions: (1) Fresh Node process (never park state in `/tmp`), (2) Erasable TypeScript only (no `enum`/namespaces), (3) Lossless JSON arguments (no `undefined` in objects). | Models fail on turn 1 due to bridge serialization errors or syntax errors. |

### 5. MCP Architecture and On-Demand Lifecycle

| File | Upstream Behavior | Enpoi Fork Contract | Why / What Breaks if Overwritten |
|---|---|---|---|
| `packages/enpoi-capabilities/src/mcp-mounts.ts` | Default-off server in capabilities was hidden from `mcp list`; slash-commands bypassed mount hooks. | (1) `mcpVisibleIds` lists all configured servers truthfully.<br>(2) Turn-entry notice injected on skill mount: `[mcp] Auto-mounted MCP server...`.<br>(3) Turn-scoped gesture scanning prevents turn-1 commands from re-mounting unmounted servers on turn 2.<br>(4) Immediate deactivation warning on unmount. | Agent is blind to available servers, does redundant recon, or resurrects unmounted servers. |
| `packages/enpoi-capabilities/src/policy.ts`<br>`packages/client/ui-brand-enpoi/src/client/permissions-model.ts` | Unzips all individual tools (145+ rows) into Settings; `mcpLadder` had an allow-resolution bug. | Consolidates permissions to server-level rows (`mcp__<server>__*`); mounted tools default to `allow (default)`; zero per-tool unzipping in UI. | Settings UI explodes with 180+ individual tool rows and asks approval on every MCP call. |

### 6. Web Search and Deep Research Subsystem

| File | Upstream Behavior | Enpoi Fork Contract | Why / What Breaks if Overwritten |
|---|---|---|---|
| `packages/web/web-setup/` | Upstream has no unified web setup service or multi-provider wizard. | First-party service `@deepseek-ai/dsh-web-setup` providing status, credential checks, and configuration mutator. | Welcome wizard cannot configure web search. |
| `packages/web/web-search-exa/` | Snapshot env API key at startup; no date filtering. | Vault-aware per-request resolution (`apiKeyEnv`), `searchType: auto`, date filtering (`startPublishedDate`), text fallbacks. | Exa keys cannot be updated in UI without daemon restart; date-scoped research impossible. |
| `packages/web/web-search-brave/`<br>`packages/web/web-search-tavily/`<br>`packages/web/web-search-searxng/`<br>`packages/web/web-fetch-jina/` | Did not exist upstream. | First-party search and fetch adapters in `packages/web/`. | Limits user to single search provider. |
| `profile/web/skills/research/`<br>`scripts/research-fetch.mjs`<br>`scripts/research-verify.mjs` | Did not exist upstream. | Offloaded research system: `custom_research-fetch` archives pages without polluting model context; `custom_research-verify` performs mechanical 4-pass anchor & date verification. | Deep research blows up context window to 200k+ tokens. |

### 7. Orchestration, memory, and peer model control (v0.1.7-enpoi.2.130)

Every row is a fork change an upstream merge can silently undo. Run the re-check after the merge and reconcile, never stack two variants of the same fix.

| File | Upstream Behavior | Enpoi Fork Contract | Re-check after a merge |
|---|---|---|---|
| `packages/core/agent-loop/src/inbox.ts` | `inbox.clear()` discards only user-authored input. | `revokesOnStop` also discards `source.kind: 'goal'` (the driver's own continuation request) while settlement, job, relay, and context observations stay pending. A user-only rewrite silently re-queues a round the operator refused. | `pnpm exec vitest run packages/core/agent-loop/tests/inbox.spec.ts -t 'goal continuation'` |
| `packages/goal/goal-round-driver/src/index.ts` | Upstream carries its own variant of the descendant-wait fix; reconcile the semantics, do not keep both wait paths. | Before reserving a round the driver awaits `subagents.waitForTreeWork(root)`, races it against plugin unload, withdraws a still-queued round at idle, and pauses the goal. | `pnpm exec vitest run packages/goal/goal-round-driver/tests/goal-round-driver.spec.ts -t 'descendants'` |
| `packages/subagent/subagent/src/continuation-activation.ts` | No Stop-all window; a settlement notice wakes whenever it lands. | A user Stop-all opens a window: a natural completion that races the stop queues in the parent's next-turn inbox and wakes nothing, and the next turn claims it once. `waitForTreeWork` joins running descendants and pending admissions, never idle members. | `pnpm exec vitest run packages/subagent/subagent/tests/continuation.spec.ts -t 'Stop-all'` |
| `packages/subagent/subagent/src/continuation-messages.ts` | Copies the child's full closing report into the notice. | `settlementReportMaxChars` (12000) and `settlementReportMaxImages` (4) bound the copy; an over-bound report keeps a surrogate-safe head/tail and one omission line naming the child's session and the recall calls. | `pnpm exec vitest run packages/subagent/subagent/tests/continuation-messages.spec.ts -t 'bounded closing report'` |
| `packages/subagent/tool-subagent-control/src/list-agents.ts` | Lists every row with `limit` only. | `status` and `query` filter before projection; `offset` pages only the rendered text; the structured result still carries every matching row. | `pnpm exec vitest run packages/subagent/tool-subagent-control/tests/list-agents.spec.ts` |
| `packages/subagent/tool-subagent/src/index.ts` | A child surface may carry board mutations. | `SHARED_CHILD_DENY` carries `whiteboard_write`, `whiteboard_pin`, `whiteboard_unpin`, and `whiteboard_forget`; `SHARED_CHILD_KEEP` carries the read-only `whiteboard_read` and `compressor_retrieve`; the whiteboard plugin refusal stays the execution backstop. | `pnpm exec vitest run packages/subagent/tool-subagent/tests/child-tool-filter.spec.ts packages/subagent/tool-subagent/tests/child-keep-restrict.spec.ts` |
| `profile/web/packages/enpoi-memory/src/session-authority.ts` | No shared root/child predicate. | One `isDelegatedSession` decides root-only actions and compaction-fact capture: a typed `origin: 'subagent'` or positive `delegationDepth` is a child; a bare `parentSession` is a child unless `isSeeded: true`. | `pnpm --dir profile/web exec vitest run packages/enpoi-memory/tests/tools.spec.ts packages/enpoi-memory/tests/compaction-facts.spec.ts` |
| `profile/web/packages/enpoi-memory/src/pipeline.ts`<br>`profile/web/packages/enpoi-memory/src/retriever.ts` | Intake stores any fact; search returns the top-K unmodified. | The secret guard runs at intake for every origin, including keeper claims and compaction capture (skip, never throw); `memory_save` keeps near-matches and names the closest id; `memory_search` keeps whole facts in rank order under `retrieverCharBudget`, always returning the top fact and reporting omissions. | `pnpm --dir profile/web exec vitest run packages/enpoi-memory/tests` |
| `profile/web/packages/enpoi-whiteboard/src/index.ts` | Mutations may return the board; a child may author. | Child mutations refuse; every mutation returns a short bounded receipt; identical writes and repeated pin/unpin are deterministic no-ops; `whiteboard_forget` returns the removed entry. | `pnpm --dir profile/web exec vitest run packages/enpoi-whiteboard/tests` |
| `packages/api/peer/src/` | No model discovery, selection, attribution, or ceiling. | `peer.models`/`peer.selectModel` with durable idempotency receipts; the routing policy is evaluated before any session exists; the per-turn attribution fold (`lastTurnEnd.ran`) plus synthetic `model-hop`; the ceiling watcher stops with the existing `{ kind: 'hook', reason: 'peer/budget' }` cause (no `SESSION_FORMAT_VERSION` bump); the strict pairing parser keeps the previous snapshot with one bounded warning; the handshake version comes from the running manifest. | `pnpm exec vitest run packages/api/peer/tests` |
| `profile/web/packages/enpoi-peer-routing/`<br>`profile/web/package.json` | No peer routing service. | The bundle provides `peerRouting` (catalogue, chain, and route-health evaluation) and is registered in `dsh.profile.bundles`; without it the handshake withholds `model-discovery`, `model-routing-at-create`, and `model-switch`. | `pnpm --dir profile/web exec vitest run packages/enpoi-peer-routing/tests`; `dsh --profile web --dump-config` lists the `enpoi-peer-routing` row |
| `profile/web/scripts/generate-pairings.mjs`<br>`profile/web/fleet.yaml` | The generator renders aliases and endpoints only. | A member's `routing` block is validated with the peer parser's rules (closed fields, pattern charset, proof guards, `allowSwitch`, positive `maxTotalTokens`), rendered into that alias's entry, and the whole document is parsed by the peer package's own validator before the atomic write; a rejection leaves the existing document untouched. | `pnpm exec vitest run profile/web/tests/generate-pairings-routing.spec.ts` |
| `profile/web/packages/enpoi-peer-bridge/`<br>`scripts/dsh-peer.mjs` | No model tools or CLI commands. | `peer_models`/`peer_switch_model` and the `ds peer models` / `ds peer switch` commands; the caller reports the installed harness identity and fails closed when it cannot resolve one. | `pnpm --dir profile/web exec vitest run packages/enpoi-peer-bridge/tests`; `pnpm exec vitest run scripts/dsh-peer.spec.ts` |

---

## Part 2: Step-by-Step Upstream Merge Runbook

When upstream publishes a new release (e.g. `v0.2.0`):

### Step 1: Pre-Merge Snapshot & Safety Baseline
1. Ensure working tree is clean: `git status`.
2. Tag current working state: `git tag backup/pre-0.2.0-merge-$(date +%Y%m%d)`.
3. Create dedicated merge branch off our current branch:
   ```bash
   git checkout -b merge/upstream-0.2.0
   ```
4. Fetch upstream:
   ```bash
   git fetch origin --tags
   ```

### Step 2: Merge Execution
Run the supervised merge (never rebase):
```bash
git merge origin/master --no-commit
```
*(If merging a specific tag, use `git merge v0.2.0 --no-commit`)*.

### Step 3: Conflict Resolution Strategy ("Ours vs Theirs")
Resolve conflicts using this strict policy:
1. **Core Runtime & API (`packages/api/session-controller/`, `packages/session/`, `packages/core/`):**
   - **KEEP OURS** for: `list.ts` (listing memoization & deduplication), `commands.ts` (leak fix), `revert-fold.ts`, `retention-pins.ts`.
   - **MERGE THEIRS** for: New session event types or protocol additions, while preserving our `revert/branch` event and `SessionRevertFold` properties.
2. **UI & Client Components (`packages/client/ui-chat/`, `packages/client/ui-primitives/`, `packages/client/ui-sidebar-right/`):**
   - **KEEP OURS** for: `parse.ts` (currency math guard), `MarkdownText.tsx` / `copy.ts` (copy-as-markdown serializer), `ChatView.tsx` (lazy `getIndexByKey()`), `TextPreview.tsx` (editable path header), `columns.ts` (0.35 rightbar ratio).
   - **MERGE THEIRS** for: New UI icons, layout improvements, or unrelated widgets.
3. **Capabilities & Permissions (`packages/enpoi-capabilities/`, `packages/subagent/`):**
   - **KEEP OURS**: Entire `enpoi-capabilities` package and fork role charters in `tool-subagent/src/index.ts`.
   - Ensure upstream didn't add new tools without assigning default policies in `SHIPPED_TOOL_DEFAULTS`.
4. **Bundles & Presets (`profile/web/cordis.patch.yml`, `profile/web/presets/`):**
   - **KEEP OURS**: System prompt prefixes, PTC `mode: both`, research tool registrations, and MCP settings.

### Step 4: Dependency and Symlink Refresh
```bash
pnpm install
node ~/.dsh/refresh-workspace-links.mjs
```

### Step 5: Post-Merge Verification Probes
Run these non-negotiable verification gates:

```bash
# 1. Typecheck Host and Client
pnpm exec tsc -b tsconfig.host.json && pnpm exec tsc -b tsconfig.client.json

# 2. Preset Prompt Parity (Confirms 0.12k token KV prefix cache remains byte-identical)
pnpm --dir ~/.dsh/profiles/web vitest run tests/preset-prompt-parity.spec.ts

# 3. Session Listing & Query Integrity
npx vitest run packages/api/session-controller/tests/session-list*
npx vitest run packages/session-query/session-query-sqlite/tests/

# 4. Chat Virtualization & Markdown Math
npx vitest run packages/client/ui-chat/tests/
npx vitest run packages/client/ui-primitives/tests/markdown*

# 5. Capabilities, Policy & Child Surfaces
npx vitest run packages/enpoi-capabilities/tests/
npx vitest run packages/subagent/tool-subagent/tests/child-*

# 6. Web Client Bundle Build & Rebrand
pnpm run build:web
node profile/web/scripts/dsh-rebrand.mjs --check

# 7. Standalone Doctor Diagnostics
./scripts/doctor.mjs
```

Post-merge peer probe (run on a host whose profile mounts `enpoi-peer-routing` and whose `$A` pairing carries a `routing` block with `allowSwitch: idle-only` and a ceiling of at least 40000; `$E` is that alias's endpoint, and the refusal pair runs before the alias has any binding — use a second unbound alias when re-running). A merge that drops the peer package, the routing bundle, or the bridge tools fails one of these lines:

```bash
ds peer handshake "$E"                                             # capabilities list model-discovery, model-routing-at-create, model-switch, model-attribution, token-ceiling
ds peer models "$A"                                                # the free chain is present with per-member state and the policy echo
ds peer list                                                       # record the bound session ids before the refusal probes
ds peer ask "$A" --model kilo/not-a-real-model "probe"             # peer/forbidden unknown-route
ds peer list                                                       # same bound session ids: the refusal created no session
ds peer ask "$A" --chain free --max-tokens 40000 "reply with ok"   # creates/adopts on the free chain and answers
ds peer status "$A"                                                # last turn ran a provider/model; budget metered=true and usedTokens>0
ds peer switch "$A" --chain free --request-id merge-probe          # accepted on an idle session
ds peer switch "$A" --chain free --request-id merge-probe          # replayed=true; no second selection
ds peer switch "$A" --model kilo/poolside/laguna-s-2.1:free --request-id merge-probe   # peer/conflict request-id-reuse
```

A ceiling reached on a later `ds peer ask` must answer `peer/forbidden` reason `budget`, and a deliberately broken `routing` key in `$DSH_HOME/pairings.yaml` must leave the previous table serving with one `peer-api: pairings reload rejected; previous snapshot kept: …` line. The full keyless sandbox self-test recipe (HTTP/WS peer protocol, catalogue facts, ceiling guidance) lives in [07](07-agents-and-orchestration.md) §10; link it rather than copying it here.

### Step 6: Promotion Pipeline
1. Commit the merge: `git commit -m "chore(upstream): merge v0.2.0 with Enpoi core invariants preserved"`.
2. Push to `beta` branch first:
   ```bash
   git push enpoi merge/upstream-0.2.0:beta
   ```
3. Test live in the beta environment / secondary devices.
4. Once verified stable, fast-forward promote to `stable` and `local/serverlocal`:
   ```bash
   git push enpoi beta:stable
   ```
