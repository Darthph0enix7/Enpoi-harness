# 12 — Glossary

One line per term, harness-specific meaning first. `$DSH_HOME` is the user's harness home (default `~/.dsh`); `$PROFILE` is the active profile dir (default `$DSH_HOME/profiles/web`). If a term has no entry here, read the code before using it (doc 00 rule 1).

## Core

- **Harness / DSH / dsh** — the DeepSeek Harness: the all-plugin agent runtime (`$REPO/packages`); CLI name `dsh`.
- **Enpoi Harness** — our profile and fork on top of upstream DSH: providers, orchestration, diagnostics, UI tabs, skin.
- **plugin** — the only composition unit: a module exporting `apply` (and usually `name`/`inject`/`Config`); every feature, tool, and page is one.
- **fiber** — Cordis's plugin lifecycle instance; a plugin's fiber can be PENDING (waiting on an injected service), ACTIVE, or disposed. "Fiber death" = it never activated or was disposed.
- **bundle** — a composition package whose `cordis.patch.yml` inserts plugin rows into a profile (`@deepseek-ai/dsh-base`, `dsh-enpoi-council`, …).
- **profile** — a named composition under `$DSH_HOME/profiles/<name>`: bundle list + patch layers + presets + skills; `web` is the GUI profile.
- **patch layer** — `cordis.patch.yml`: rows are inserted/replaced by id, last write wins; the operator's profile patch is applied after every bundle.
- **overlay** — a `--patch file.yml` layer applied after the profile patch (test/pin overrides); also the per-device heavy-provider overlay `$DSH_HOME/heavy-server-overlay.json` (machine-local reuse/dashboard URLs).
- **row / plugin row** — one entry in a patch file: `id`, `name`, optional `config`, optional `disabled`.
- **DSH home (`$DSH_HOME`)** — per-user state root: sessions, settings, profiles, skills, credentials, diagnostics, logs.
- **settings namespace** — the document key an owner plugin registers and edits (`enpoi-orchestration`, `ui-theme`, …); `settings.describe` returns the merged document; unknown keys are refused.
- **document (settings document)** — the persisted value of one namespace, stored as a patch row in the owning profile; edits are hot (next read/spawn).
- **capabilities** — fork config under `enpoi-orchestration.capabilities`: tool/skill/MCP on-off switches plus personas, roles, councils, chains.
- **dynamic entities** — everything operator-definable as data in the `enpoi-orchestration` namespace (roles, councils, MCPs, skills, prompts); code ships defaults, an entry with the same id overrides them.
- **config editor** — the merged settings write path; it imports legacy `settings.yaml` sections into the profile patch row of the same id.

## Agents and orchestration

- **agent** — the model loop bound to one session; a **main agent** is the session's own, a **subagent** is a delegated child session.
- **preset** — an agent composition; the live form is a `preset-<id>` declaration row in `$PROFILE/cordis.patch.yml` (`config.plugins`), while `$PROFILE/presets/<id>/` is the pre-merge source; `orchestrator`, `sysadmin`, `creator`.
- **seat (fleet)** — a named model-routing slot in Agent Models (personas, councils, compaction, keeper); an unassigned seat shows `Inherit`.
- **seat (UI)** — a named extension position on a surface (composer seats, header seats); props are derived, never named ad hoc.
- **persona** — the role-specific prompt prefix a subagent receives when delegated (`librarian`, `fixer`, `explorer`, `designer`, `oracle`).
- **role** — a registry entry the delegation tool spawns; `seat: false` hides its Fleet row, `spawnable: false` makes it tool-only (the Oracle).
- **keeper** — `enpoi-context-keeper`: maintains the Living Brief; default model route `freellmapi/auto`; exempt from stop cascade.
- **Living Brief** — the keeper's compact, structured session summary (goal/docs/decisions/rejected/blockers/files) rendered in the Watchtower.
- **claims** — atomic facts the keeper extracts from the log with a batch cadence; claims feed memory and the brief.
- **compaction** — upstream context reduction (LLM summary + mechanical fallback) when the window fills; settings live under Orchestration and are hot-swapped.
- **summariser / compactor** — the model used for compaction; the `compaction` **designated seat** (always rendered, inherits the session model by default — a different model loses the prompt-prefix cache).
- **council** — structured multi-model debate tool (`roundtable`); seats = debaters.
- **roundtable / chorus** — debate vs. brainstorming flavors of the council; both addressed by tool name.
- **broker** — the Evidence Broker: extracts `NEED_EVIDENCE` lines from seats, dispatches explorer/librarian children, commits fact sheets to the vault.
- **vault** — the council's append-only, deduplicated fact store; entries are cited (`F-1`, …) and superseded rather than edited.
- **referee / chair / arbiter** — fixed council roles: scoring, chairing, and neutral rulings; never seats.
- **Oracle** — tool-only senior reviewer (`oracle_review`), scorecard + verdict contract; cannot be spawned as a worker.
- **reviewer seat / `review_run`** — read-only test runner for reviewer roles; fixed runner enum, workspace read-only, scratch-only writes.
- **settlement notice** — the runtime-owned parent message reporting a background child's outcome plus its closing report; one per settled child, distinct from model-authored relay messages.
- **turn / step** — one user-initiated model run / one model call inside it.
- **session / session log** — durable JSONL event log under `$DSH_HOME/sessions/`; current format version 4 (v4).
- **projection** — a derived, registered read over a session (`livingBrief`, `contextPressure`, `oracleScorecard`, …) published live.
- **whiteboard** — operator-authored durable facts pinned per session/project/ global scope (`enpoi-whiteboard`), readable by the agent.
- **memory** — durable project facts store (`enpoi-memory`, SQLite + FTS/backfill) with save/search/confirm/rescind tools.
- **peer** — cross-device interconnect (`enpoi-peer-bridge`): status, ask, answer, cancel against another harness instance.

## Providers and models

- **provider / route** — a configured endpoint (`kilo`, `opencode-go`, `freellmapi`): wire protocol, base URL, credential reference.
- **catalog / catalogue** — the provider's model list; sync writes discovered models into the settings document; the picker reads it.
- **discovery** — per-provider model enumeration (runs automatically after a provider is added; models appear without a manual refresh).
- **keyless** — a route that serves requests without a credential (`keyless: true`; e.g. Kilo Gateway). Supplying a key switches to BYOK.
- **gated / gate reason** — a model the provider lists as unavailable without sign-in/paid plan; the picker dims it with `sign-in required`.
- **pool / identity** — embedded multi-key pool for one provider; each identity has `priority`, `enabled`, `credentialRef`, a cooldown, and a last status. Strategy `priority-sticky` (default) rides the top identity.
- **heavy provider** — FreeLLMAPI / Antigravity / Command Code: listed but nothing installed until the operator adds one; install/health/remove are manifest-driven, and removal cleans route, credential, pool, cache, chains.
- **model group / chain** — ordered links (`provider/model`) with `attempts` and `onCut: failover`; assigning a chain to a seat routes through its first enabled link.
- **rules engine** — `enpoi-catalog-rules`: evaluates `catalogRules` against every catalogue entry and publishes only non-default decisions.
- **visibility decision** — per-model resolve: `visible|hidden`, `reason`, `source: default|manual|rule|gated`; precedence manual hidden > manual shown
  > gated > hide rules > visible.
- **error classes** — machine-routable failure kinds on `HarnessError` (`AUTH`, `QUOTA`, `ACCOUNT_QUOTA`, `RATE_LIMIT`, …); route on the class, never on message text.

## UI and process

- **rail** — an always-visible icon column: left sidebar's collapsed panel rows; right panel's per-kind tab buttons plus dock/chrome controls.
- **tab kind** — a right-panel page type registered in `sidebarRightTabs` (Files, Git, Capabilities, Context, …); the rail button is automatic.
- **dock** — (a) `conversation.input.dock`: the list above the composer (goal bar, todos, queue, revert notices); (b) the bottom terminal dock.
- **Watchtower** — full-canvas session cockpit: keeper freshness, brief, whiteboard, Live Debug.
- **The Mark** — the fork's in-chat task card for subagent/Oracle/Council dispatches, shadowing upstream tool rows.
- **QueueDock** — the composer dock that lists queued messages and subagent settlement notices ("N results pending"; parks results instead of waking a turn).
- **tool group** — named set of tool names in `enpoi-tool-groups`; `static` groups are always presented, `on-demand` groups attach per session; `preAttach` lists seats that start with a group attached.
- **`tool_groups`** — the meta-tool (`list`/`attach`/`detach`) over the on-demand families; an attach commits durably but applies from the next turn.
- **console (operator console)** — the web GUI's read surfaces for a session: the Chat/Trajectory/Watchtower conversation views plus the right-rail tabs (Capabilities, Agent Models, Subagent Sessions, Git, Terminal); no surface is literally named Console.
- **agent picker** — the composer's preset selector (`conversation.input.agent`): switches an idle session's preset; Settings → Agent presets sets the new-task default.
- **incident / incident store** — bounded failure rows at `$DSH_HOME/diagnostics/incidents.sqlite` from the logger sink, plugin lifecycle failures, session-event error paths, and client reports; read with `diagnostics_report`.
- **gate** — one of the four automated acceptance checks (error audit, tool roster diff, token contrast, rebrand) — see doc 11.
- **grant / pin / Full access / approval** — the permission model: policy outcomes (`allow/ask/deny`), standing grants, exact-command pins, broad-allow, Full access (no prompts; parent judgement applies), approval cards naming the child session, agent label, depth, and matched rule, plus a parent recommendation — see doc 04.
- **pack_sig** — **not a harness term.** It belongs to a different project's document toolchain; do not use it when describing this harness.
