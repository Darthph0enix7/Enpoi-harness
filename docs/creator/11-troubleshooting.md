# 11 — Troubleshooting

Read this when: something is failing, a surface vanished, a model call is rejected, a rebuild did not take effect, or you need proof before/after a fix.

Conventions. `$PROFILE` = the active profile dir (default `$DSH_HOME/profiles/web`); `$REPO` = the harness checkout; `$EVIDENCE` = the migration evidence root (reference install: `~/dsh-migration/evidence`). Never `systemctl restart` / `ds restart` from inside a turn — see "Restart" below.

## 1. The diagnostics ledger (first stop)

`enpoi-diagnostics` records every swallowed failure into one SQLite store:

- Store: `$DSH_HOME/diagnostics/incidents.sqlite` (override `dbPath`), `maxIncidents` 5000, `maxPatterns` 2000, `cooldownMs` 300000 (same fingerprint collapses inside the window), `flushMs` 250, `captureLogs` true (`$PROFILE/packages/enpoi-diagnostics/src/index.ts:58-90,188`).
- Fold default: 15-minute degrade window (`report.ts:69`).
- Ask it from a session with the **`diagnostics_report` tool**: `window` (default 24h), `limit` (default 10, max 25), `includeLogs` (default true) (`tools.ts:28-60`). Deterministic fold — no model in the detection path.
- Or from code/UI through the `diagnostics` Remote namespace: `diagnostics.report` / `.list` / `.patterns` / `.mute` (`api.ts:18-78`). The Watchtower Live Debug card reads the same incident tail (`ui-brand-enpoi/src/client/WatchtowerView.tsx:183-205`).
- Degrade posture: a store failure returns an empty report with `ok: false` instead of failing the turn (`tools.ts:1-8`).
- Known gap: fiber deaths **before** the diagnostics plugin mounts have no ledger line (pre-boot listener proposed, open backlog item 11).

## 2. `ds doctor` and `dsh doctor`

Both run the same standalone diagnostic, `scripts/doctor.mjs`: `dsh doctor` through the CLI (`apps/cli/src/bin.ts:22-30,40`) or the installed shim (`scripts/update.sh:32-59`); `ds doctor` through the fish function (`$PROFILE/fish/ds.fish:149-176`), which resolves `scripts/doctor.mjs` from `$REPO` or `$DSH_HOME/harness/current`, requires Node ≥22.19, and forwards flags (`ds doctor --json`, `--strict`). `dsh doctor` is the form that works from any shell — including Windows — and the one a script, support report, or first-run self-check should call.

Flags: `--json`, `--strict`, `--no-color`, `--home <path>`, `--port <port>`, `--service <unit>`, `--profile <name>`, `--help`, `--version`; env defaults `DSH_HOME` / `DSH_PORT` / `DSH_PROFILE` / `DSH_SERVICE_UNIT`.

| Section | What it checks | Failure posture |
|---|---|---|
| Service & HTTP | `systemctl --user show <unit>` state/PID/memory/restarts (Linux only), local HTTP probe on the configured port | unit not active or probe unreachable/5xx → error, with a suggested fix |
| Host & Environment | Node.js ≥22.19 (version + executable), platform/CPU/uptime, free space on `$DSH_HOME` and `/` (warn ≥90%, error ≥97%), `.credentials.yaml` presence and mode 0600, `.env` presence and mode | missing or insecure secrets → warn; unsupported Node → error |
| Providers & Keys | `settings.yaml` (root or `profiles/<name>/`), configured LLM providers with per-provider key presence, `agent-default-model`, credential-vault refs, web-search provider + its key, live `llm.providers` RPC when the server answers | no providers / missing keys / unknown default provider → warn; RPC unavailable is informational (settings.yaml is used instead) |
| Diagnostics | `incidents.sqlite` presence, top recurring warning/error patterns (muted patterns reported separately), incidents in the last 24 h, error-priority journal lines | recurring errors or journal errors after the current service start → warn; pre-start lines are informational |
| Sessions | session-store inventory (sessions/projects) and the session-query index at `$DSH_HOME/cache/session-query/index.sqlite` | missing index → warn (suggest `ds backfill`) |

Exit status: `0` healthy, `1` any error (`--strict` also fails on warnings), `2` usage failure. `--json` prints the whole report (checks, host, service, http, settings, providers, defaultModel, credentials, env, webKeys, webSearch, rpc, diagnostics, patterns, incidents24h, journal, sessions, sessionIndex, summary) for scripts and bug reports.

`ds heal` also exists (chmod credentials, restart, 20s health probe) but it restarts the service — only run it when the caller is not the session host.

## 3. The four gates (exact commands, expected output)

Run from `$REPO`.

| Gate | Command | Expected |
|---|---|---|
| Error ledger | `node scripts/error-audit.mjs --ack $EVIDENCE/error-audit/baseline/acknowledged.json` | `exit 0` (no unexplained signal; exit 2 = harness/usage failure) |
| Tool rosters | `node scripts/tool-roster-diff.mjs` | Fixtures are 53/53/53; the stored baseline is the frozen 0.1.7 capture, so the current run reports `DRIFT` naming the additions (39/40 → 53) — a `MATCH` means the baseline was refreshed, never that the fixtures are stale |
| Token contrast | `node "$PROFILE/scripts/dsh-token-contrast.mjs"` | `PASS`, drift `[]`; floor 4.5:1, both base modes |
| Branding live | `node "$PROFILE/scripts/dsh-rebrand.mjs" --check --live` | `PASS (live)` — fork title + contrast, probes the served origin |

Owners/behaviour:

- `error-audit.mjs` extracts error-class signals from session logs, comms, Adam sessions (last 30) and journals (24h), assigns `expected` vs `unexplained`, and exits 1 on any unexplained signal; `--ack` reclassifies reviewed history only (`scripts/error-audit.mjs:1-40`).
- `tool-roster-diff.mjs` diffs fixture rosters against the frozen baseline and exits 1 on drift; `--json`, `--preset`, `--current`, `--baseline` (`scripts/tool-roster-diff.mjs:1-25`).
- `dsh-token-contrast.mjs` resolves the real cascade (design platform light → dark → skin `:root`), checks overlay/state-pill/badge pairs, asserts the repaints and `--dsw-menu-backdrop-filter` still exist, and requires the dotfiles mirror to byte-match (`:1-58`). Skin dir precedence: `DSH_SKINS_HOME` → `DSH_SKINS_DIR` → `$DSH_HOME/skins` (`:62-72`).
- `dsh-rebrand.mjs` re-applies dist titles/favicons + the dark boot default and imports the contrast probe; live probes `DSH_WEB_ORIGIN` (default `http://127.0.0.1:3080`) (`:38-58`).

Also part of a rebuild: `pnpm run -s verify-cordis-catalog` (generated docs) and `systemctl --user is-active dsh-web.service` + journal with no error/failed lines.

## 4. Common failures: symptom → cause → fix

### Silent plugin fiber death
- Symptom: a tab/tool/surface is simply absent; no UI error; turn works.
- Cause: a plugin fiber failed during load (unsatisfied `inject` stays PENDING forever; a load throw before the diagnostics sink is mounted only reaches stderr/journal).
- Fix: check the journal (`journalctl --user -u dsh-web.service`, or the platform's service log) and `$DSH_HOME/logs/*.log`; run `diagnostics_report`; `ds doctor`. A stale client bundle looks identical — rebuild the owning package (`pnpm --filter <pkg> bundle`) and re-run `dsh-rebrand.mjs` (client rebuilds revert fork branding).
- Gate: error audit (journal lines) + a surface smoke check.

### Settings namespace not registered before a rebuild
- Symptom: a settings page is empty, edits do not persist, or provider sync writes are refused; the value is present in source but absent at runtime.
- Cause: the settings document is derived from the owning plugin row, `lib/` output or client bundle was built before the namespace/owner code landed (upstream 0.1.5 moved `settingsNamespace()` to plain literals and made `enpoi-orchestration` an owner; a source port invisible until rebuild).
- Fix: rebuild the owning package, harvest the client bundle, then `dsh restart --after-turn`. The fork's registration call is a no-op on the merged engine and only bootstraps pre-0.1.7 engines (`$PROFILE/packages/enpoi-capabilities/src/index.ts:191-204`).
- Gate: open the page after restart; `settings.describe` must list the namespace.

### Provider 401 / quota / gated
- Symptom: turn fails with an auth rejection, `QUOTA` / `ACCOUNT_QUOTA`, an entitlement refusal, or a 402/429 that surfaces as a tool error; or a model is dimmed in the picker.
- Cause: missing/invalid credential; keyless route whose selected model needs sign-in (`gated: true`, `gateReason: sign-in required`); pool identity cooling after 401/403; an identity-specific entitlement gate; free-tier quota exhausted.
- Fix: `ds pool <provider>` shows priority, cooldown, auth state; `ds reset-cooldown <provider> [identity]` clears a wedged identity; verify the model is not gated (or sign in); for keyless routes a supplied key switches that route to BYOK. An entitlement-gated identity cools 6 h while the pool rotates to the next identity; the free-tier gate is terminal and never cools (03 §6/§9). Error classes: `HarnessError` carries the machine-routable class (`$REPO/packages/llm/llm/src/error.ts:13-31,226-236`).
- Gate: error audit `provider-capacity` class must stay at zero; the picker's dimmed reason is the operator-facing truth (doc 03).

### MCP server will not mount / a tool says "not mounted"
- Symptom: `mcp mount` returns a reason; the header chip lists no mounts; or a call fails "`X` is not available: its MCP server is on-demand and this session has not mounted it."
- Cause: the id is not in `enpoi-orchestration.mcpServers`, has no `url`, or `capabilities.mcp.<id>` is not `true`; or the server's `mode` is `on-demand` and this session never mounted it; or the initial connection failed (transport/credential).
- Fix: `mcp` action `list` shows every row's `mode` and `state` (`mounted` / `available` / `unavailable`) with the reason (`mcp` tool, `$PROFILE/packages/enpoi-capabilities/src/index.ts:761-813`); fix the catalog entry or the allow toggle in Dynamic → MCPs, then `mount` the id — the mounted set is session-durable and its tools appear next turn. `list` and `mount`/`unmount` are `allow`; the server's own tools keep their own permission rows (`policy.ts:169-173`). Logs: `[enpoi-capabilities] mcp mount failed for <id>` / `mcp sync` / `mcp teardown`; reachability heartbeats land in `mcpStatus` (the Dynamic MCP dots). Removing a server through the panel is the safe delete: the catalog `unset` and every `mcp__<server>__*` permission row (global and per-agent) go in one revision-fenced write, so no inert rows remain (`mcp-tools.ts:116-142`). The surface filter and the pre-execute backstop mean an unmounted on-demand tool is absent, then denied — never an `UNKNOWN_TOOL`.

### First-run system-analysis chip
- Symptom: the chip reads failed; Retry starts a fresh investigation from stage 1.
- Cause: the chip localizes three kinds — `service` (route answered non-OK), `rejected` (host answered `ok: false`, its message shown verbatim), `payload` (job shape not understood); a transport failure shows the raw message (`SystemAnalysisChip.tsx:54-59,171-181`; `system-analysis.ts:29-41,310-322`).
- Leak scan: the published Markdown is checked for IPv4 addresses, dotted version numbers, and domain-like strings (`documentViolations`, `investigation.ts:150-198`); matches are logged with the exact facts and the profile still publishes — the analysis is advisory, never fatal (`:357-366`).
- State on disk: `$DSH_HOME/system-profile.md` and `$DSH_HOME/system-profile.json` (the stored profile), `$DSH_HOME/system-profile.decision` (`accepted`/`rejected`/`seen`); a run's scratch workspace is `$DSH_HOME/system-analysis-work` (`context-file.ts:19-35,55-68`; `investigation.ts:50-53`).
- Fix/reset: Reject removes both profile files and records the decision, so the sysadmin falls back to the "no analysis is stored" default (doc 10) and the ready surface does not return; an ignored profile records `seen` on the load that displayed it, so the chip stays hidden while the files stay. To start a fresh run by hand, remove both `$DSH_HOME/system-profile.md` and `system-profile.json` plus the decision marker, then reload and start from the wizard's agents step (`analysis.ts:247-263`; `system-analysis.ts:204-215,296-325`). The chip's Retry restarts a failed run; the chip itself never offers a first run (`SystemAnalysisChip.tsx:166-179`), and the runner removes both files when a durable write fails, so a half-written publication is never reviewable (`analysis.ts:208-214`).
- Check: `/system-analysis/status` answers `ok: true` with the job view; after a Reject the sysadmin context must contribute the "no analysis is stored" default (doc 10).

### Verification records a dispatch failure as a failed check
- Symptom: persisted `verify/unmet` incidents with an empty `messagePreview` after a capacity rejection or another orchestration result; the V4 session looks "failed" although no work failed.
- Cause: the gate parsed only the retired V3 nested tool-result shape (native V4 results lifted 0 text and 0 `isError` flags), and every tool result counted as verification evidence.
- Fix: the parser reads `message.isError` and top-level `content[].type:'text'`; `CONTROL_PLANE_TOOLS` (`subagent`, `task`, `create_goal`, `get_goal`, `update_goal`, `send_message`, `interrupt_agent`, `list_agents`) is excluded entirely — it neither opens the gate nor clears a prior work failure — and the dead V3 branch was dropped (`$PROFILE/packages/enpoi-verify-gate/src/index.ts:157-180`; `src/verify.ts:54-66,185`). Gate: the package suite plus a replay over the diagnosis session.

### grep/glob fails although files matched
- Symptom: `SEARCH_FAILED` while readable files matched, or a pointless reduced-thread retry after a locked file.
- Cause: any ripgrep exit other than 0/1 threw before parsing stdout, and the thread-spawn `EAGAIN` pattern matched per-file `Resource temporarily unavailable` lines in stderr.
- Fix: exit 2 now returns the parsed matches plus a bounded `Warning: ripgrep could not search N path(s): … Results may be incomplete.`; zero parsed results still throw; per-file `EAGAIN` no longer retries while a genuine thread-spawn `EAGAIN` still retries once with `--threads 1` (`$REPO/packages/fs/tool-fs-search/src/search-core.ts:194,392,480-492`; `grep.ts:209-233`).

### The sidebar shows only sessions created since the last restart
- Symptom: older sessions are missing from the rail, search, and open, with no visible error.
- Cause: a duplicate session id anywhere under the root threw and failed the entire persisted listing — the client kept only in-process additions — and unsupported, corrupt, or malformed headers were skipped silently.
- Fix: the listing resolves a duplicate once (highest stored generation, path tie-break) and reports it and every skipped artifact with its raw path through the plugin logger; root-level faults still fail loud, and `open`/`load` still reject an ambiguous duplicated id (`$REPO/packages/session/session-persistence-jsonl/src/index.ts:213,1105-1145`). A rail with fewer than a first screenful (12) of renderable rows now tops itself up; a failed pull renders the `SessionListError` row instead of a silent empty rail (09).

### A child's long command ran twice
- Symptom: a child's bash command that outlived the executor timeout was re-run because the child could not collect the promoted job.
- Cause: `SHARED_CHILD_DENY` removed `job_output`/`job_list`/`job_kill` (children have no per-bash promotion config).
- Fix: the job controls are no longer denied — a promoted job is owned by the child's session and fenced by it, and the child context tells it to collect with `job_output (wait: true)` (07 §2). Do not re-add them to the deny floor.

### An interrupted tool call reports an outcome its durable approval already settled
- Symptom: after a crash, a resumed session shows a synthetic error result for a call whose approval the log already answered — `TOOL_OUTCOME_UNKNOWN` ("may have side effects") although the operator rejected it, or an uninterpreted `TOOL_APPROVAL_*` code.
- Cause: recovery classifies each unanswered `tool/call` from its durable approval audit. An ask with no decision, a `rejected` decision, and a lapsed gate (`cancelled`/`unavailable`) all prove the gate never granted execution, so the call never began; a granting decision (`allowed-once`/`allowed-always`/`allowed-always-broad`) or an outcome outside that vocabulary may have executed and must stay unknown.
- Expected: `TOOL_APPROVAL_NOT_DECIDED` (ask never decided), `TOOL_APPROVAL_DENIED` (`rejected`), and `TOOL_APPROVAL_EXPIRED` (lapsed gate) each state "not executed"; retry only the undecided/expired calls when still needed, and verify external state or ask the user before retrying any `TOOL_OUTCOME_UNKNOWN` result. Source: `packages/core/session/src/repair.ts`; codes re-exported from `@deepseek-ai/dsh-session`.

### A child's tool call sits parked while the parent session is idle
- Symptom: a delegated child's approval-requiring call waits with no card and no error while the root session is between turns; if the root never returns, the call is denied after about ten minutes with `approval was not resolved in time`.
- Cause: the approval audit pair must be turn-enclosed, so a forwarded ask cannot dispatch a card into an idle root; the failsafe parks the ask instead of failing closed, and the root's next `turn/start` resolves it.
- Expected: `$PROFILE/packages/enpoi-capabilities/src/forwarding.ts` records the park durably (reason, child identity, tool/command, 10-minute window) in `~/.dsh/cache/approval-parks.json`, replays it in FIFO park order at the root's next turn (Full access: parent judgement, audit line, no card; otherwise the operator card), and settles the child on every exit — expiry, abort, session end, plugin disposal. A restart expires restored records (the waiting child died with the previous process). Nothing needs manual clearing; when the denial was wrong, run the action from the root session or ask again while it is active. Source: `forwarding.ts`, `approval-parks.ts`, wired at `index.ts` (park replay on `session/event` + `session/disposed`).

### Repeated `block.content is not iterable` / `agent/disposed listener threw … 'catch'`
- Symptom (two high-volume incident families): one warning per V4 tool result from the fast collector, or `agent "…": agent/disposed listener threw: TypeError: Cannot read properties of undefined (reading 'catch')`.
- Cause: `dsh-fast`'s `flattenToolResultText` assumed the pre-V4 wrapper shape; and `file-reference-local` / `tool-subagent` called `.catch` on a single-shot `Fiber.dispose()` that returns `undefined` when its epoch is already retired (scope disposal runs before `agent/disposed`).
- Fix: `dsh-fast` folds both shapes — the profile pins the fix as a committed pnpm patch (`patches/dsh-fast@0.2.14.patch` with the entry in `pnpm-workspace.yaml`; pnpm 11 ignores `package.json#pnpm.patchedDependencies`), so installs keep it until upstream ships the V4 flatten. The two listener sites normalize with `Promise.resolve(fiber.dispose())` (`$REPO/packages/context/file-reference-local/src/index.ts:86`; `$REPO/packages/subagent/tool-subagent/src/index.ts:1319`; regression `packages/context/file-reference-local/tests/agent-dispose-order.spec.ts`).

### Search index building
- Symptom: cross-session search rejects with the coded `SESSION_QUERY_INDEXING` state.
- Cause: the first whole-corpus index pass is background work; on a large store it takes minutes. Not an error.
- Fix: wait — the rejection carries `indexed/total`; per-session event search and exact reads answer immediately. `firstSearchWaitMs` (default 20000, capped at 25000; `0` disables the wait) bounds how long a search blocks (`$REPO/packages/session-query/session-query-sqlite/README.md:54,60`). A restart starts a fresh pass (already-current sessions are skipped, `:149`). `indexState` reports status/counts.

### Restart aborts the turn / other sessions
- Symptom A: a `restart` command issued from a tool call never returns; the turn dies mid-call.
- Symptom B: `dsh restart --after-turn` waited and then aborted unrelated sessions.
- Cause A: the restarted service hosts the turn.
- Cause B (pre-fix): per-session scope, or an unbounded wait-all.
- Fix: always `dsh restart --after-turn` from inside a session — default is whole-service idle, bounded by `--max-wait` (default 10 min); past the bound it falls back to the marked session alone and warns which sessions would be aborted. `--cancel` withdraws a scheduled restart; `--now` is detached and only for callers that are not the session host (`apps/cli/src/restart-after-turn.ts:1-22,42-43,271-287`). After the restart the browser reconnects to the same page/session/draft; an interrupted turn renders honestly, not a stuck spinner.
- Gate: verification guide's restart-safety click-through (doc 84 §2).

### `run_code` fails with bridge or syntax error
- Symptom: `run_code` script throws `cannot serialize argument` or `unexpected token` on valid-looking TypeScript.
- Cause: (1) passing `undefined` inside an object or array (bridge serializer requires strictly lossless JSON); (2) using runtime TypeScript constructs like `enum` or `namespace` (Node type-stripping only supports erasable syntax); (3) assuming state persists across calls (each execution runs in a fresh isolated process).
- Fix: clean up object properties (`delete obj.key` instead of `obj.key = undefined`), replace `enum` with `const` objects / string unions, and ensure scripts are self-contained without writing state to `/tmp`.

### Tool call rejected with `[CAPABILITY_DISABLED]` on MCP tool
- Symptom: calling an `mcp__<server>__*` tool fails immediately with `[CAPABILITY_DISABLED] MCP Tool suite '<server>' is disabled by the operator`.
- Cause: the MCP server's master capability switch is `false` (default-off / on-demand) and the calling session has not pulled it in via a skill `mcp: [...]` hint or explicit `mcp mount <server>`, or the agent explicitly unmounted it.
- Fix: invoke the skill that declares the server, call `mcp mount <server>` to pull it into the active session, or turn on the server's toggle in the Capabilities Control Center.

## 5. Where the evidence lives

`$EVIDENCE/` — one directory per workstream, each with raw logs and verdict JSONs: `tool-eval`, `coding-trial`, `context-eval`, `error-audit` (including `baseline/acknowledged.json`), `heavy-providers`, `skin-freeze`, `perf`, `permissions`, `permissions-mirror`, `agent-comms-e2e`, plus the recent fix lanes `tool-defaults`, `iterations`, `session-scale`, `phase3`, `phase4`, `fleet-fixes`, `verify-gate-fix`, `fs-search-fix`, `incident-fixes`, `live-sessions-ui`, `session-list`, `pool-media`, `keypool-fixes`, `skill-mcp-hint`, `mcp-on-demand`. The open backlog (`82-open-backlog.md`) lists every known open item; the porting playbook (`50-…`) holds the safeguards referenced by the gates. Cite a raw log path when reporting a failure; do not re-run a gate and call it fixed until it goes green on the changed tree.
