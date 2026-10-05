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

### 2. Client Rendering, Markdown, and Navigation

| File | Upstream Behavior | Enpoi Fork Contract | Why / What Breaks if Overwritten |
|---|---|---|---|
| `packages/client/ui-chat/src/client/chat/ChatView.tsx` | Rebuilds `indexByKey` Map on every virtual window render / streaming chunk. | Lazy getter `getIndexByKey()` memoizes the Map across streaming chunks until item count changes. | High CPU churn during streaming in long sessions. |
| `packages/client/ui-primitives/src/markdown/parse.ts` | `micromark-extension-math` parses single `$…$` without boundary guards, turning currency like `**$4** … **$7**` into math AST. | `singleDollarTextMath: false` + `mathTextGuard` rejecting digit-adjacent, whitespace-padded, or multiline single `$`. | Currency symbols break bold/italic formatting and substitute Unicode math glyphs (`∗`, `⋅`). |
| `packages/client/ui-primitives/src/markdown/MarkdownText.tsx`<br>`copy.ts` | Native browser copy serializes KaTeX MathML elements into per-glyph newlines. | Container-level `onCopy` interceptor extracts formula source and serializes clean Markdown + KaTeX-free HTML. | Copy-pasting text from chat produces broken one-character-per-line strings. |
| `packages/client/ui-sidebar-right/src/client/service.ts` | Clicking a file card in chat opens the file in whatever dock tab is active (even watchtower or subagents). | File/diff cards (`dsh-resource://file/...`) auto-focus or mount the Workspace Files tree tab so preview docks beside the file tree. | Files open docked next to subagent transcripts instead of the project directory. |
| `packages/client/ui-sidebar-documentpreview/src/client/TextPreview.tsx` | File preview title is static read-only text. | Interactive inline input: click to edit, Enter navigates relative/absolute paths (even outside workspace), Escape cancels. | Quick file inspection requires multiple tool clicks. |
| `packages/client/ui-layout/src/client/columns.ts` | `RIGHTBAR_DEFAULT_RATIO` = 0.45 (~648px on 1440px). | `RIGHTBAR_DEFAULT_RATIO` = 0.35 (~504px on 1440px). | Right sidebar opens excessively wide by default. |

### 3. Orchestration, Presets, and Permissions

| File | Upstream Behavior | Enpoi Fork Contract | Why / What Breaks if Overwritten |
|---|---|---|---|
| `profile/web/cordis.patch.yml`<br>`profile/web/presets/*/agent.cordis.yml` | Each agent preset has separate system prompt headers; switching agents flushes prefix cache. | **Shared Prefix Parity Law:** Orchestrator, Sysadmin, and Creator share byte-identical system prompt prefixes; role differences live strictly in suffix. | Switching presets invalidates the 12.4k token KV cache and forces full prompt re-ingestion. |
| `packages/enpoi-capabilities/src/policy.ts` | Tools without exact entries fall through to `defaults.unknownTools: ask`. | Shipped defaults table (`SHIPPED_TOOL_DEFAULTS`) explicitly maps all 50+ tools; completeness spec guards against unconfigured tools. | Integrated tools (goals, ralph, workflow) prompt user approval cards repeatedly. |
| `packages/enpoi-capabilities/src/forwarding.ts` | Subagent approval requests either prompt user or fail silently under unattended modes. | Subagent requests forward to main session; in Full Access (YOLO), parent model-judgement applies with standing-consent audit. Idle parent requests park in `~/.dsh/cache/approval-parks.json`. | Subagents either stall indefinitely or execute dangerous commands without parent oversight. |
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
