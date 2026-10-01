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

## 2. `ds doctor`

Fish function in the profile (`$PROFILE/fish/ds.fish:149-260`). On a non-fish shell run the equivalent checks:

| Check | What it does |
|---|---|
| Service | Linux: `systemctl --user is-active dsh-web.service` + PID/RSS; other platforms use the unit the installer created |
| HTTP | `curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:3080/` → expect `200` |
| Settings/credentials | `$DSH_HOME/settings.yaml` present; `$DSH_HOME/.credentials.yaml` present and `chmod 600` |
| Providers | RPC `llm.providers` → count configured |
| Presets | RPC `agentPreset.list` → count |
| Skills | count of dirs under `$DSH_HOME/skills/` |

`ds heal` also exists (chmod credentials, restart, 20s health probe) but it restarts the service — only run it when the caller is not the session host.

## 3. The four gates (exact commands, expected output)

Run from `$REPO`.

| Gate | Command | Expected |
|---|---|---|
| Error ledger | `node scripts/error-audit.mjs --ack $EVIDENCE/error-audit/baseline/acknowledged.json` | `exit 0` (no unexplained signal; exit 2 = harness/usage failure) |
| Tool rosters | `node scripts/tool-roster-diff.mjs` | `MATCH (39/39/40)` (per-preset rosters vs `scripts/tool-inventory/roster-baseline.json`) |
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
- Symptom: turn fails with an auth rejection, `QUOTA` / `ACCOUNT_QUOTA`, or a 402/429 that surfaces as a tool error; or a model is dimmed in the picker.
- Cause: missing/invalid credential; keyless route whose selected model needs sign-in (`gated: true`, `gateReason: sign-in required`); pool identity cooling after 401/403; free-tier quota exhausted.
- Fix: `ds pool <provider>` shows priority, cooldown, auth state; `ds reset-cooldown <provider> [identity]` clears a wedged identity; verify the model is not gated (or sign in); for keyless routes a supplied key switches that route to BYOK. Error classes: `HarnessError` carries the machine-routable class (`$REPO/packages/llm/llm/src/error.ts:13-31`).
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

## 5. Where the evidence lives

`$EVIDENCE/` — one directory per workstream, each with raw logs and verdict JSONs: `tool-eval`, `coding-trial`, `context-eval`, `error-audit` (including `baseline/acknowledged.json`), `heavy-providers`, `skin-freeze`, `perf`, `permissions`, `agent-comms-e2e`. The open backlog (`82-open-backlog.md`) lists every known open item; the porting playbook (`50-…`) holds the safeguards referenced by the gates. Cite a raw log path when reporting a failure; do not re-run a gate and call it fixed until it goes green on the changed tree.
