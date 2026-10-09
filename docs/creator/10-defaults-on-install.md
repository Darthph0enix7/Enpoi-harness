# 10 — Defaults on install

Read this when: you need to know what a fresh Enpoi profile ships with before changing a default, adding an optional component, or diagnosing "it worked before this feature existed".

Conventions. `$PROFILE` is the active profile dir (default `$DSH_HOME/profiles/web`); `$REPO` is the harness checkout. Everything a fresh install gets is either an upstream bundle, a fork bundle in `$PROFILE/package.json` → `dsh.profile.bundles`, or a seeded setting in `$PROFILE/fresh-settings.yaml`. Machine-specific state (which provider is signed in, pool keys, gated flags at discovery time) lives in settings — never in these docs.

## Default plugin set (profile bundles)

Load order is `dsh.profile.bundles`, then `$PROFILE/cordis.patch.yml`, then `--patch` overlays (`$PROFILE/cordis.yml` is an empty root). Shipped list (`$PROFILE/package.json`):

| Layer | Bundles |
|---|---|
| Upstream | `@deepseek-ai/dsh-base`, `@deepseek-ai/dsh-web-app` |
| Skin | `@linxin666/dsh-client-ui-skin-center` |
| Fork core | `dsh-enpoi-diagnostics`, `dsh-enpoi-verify-gate`, `dsh-enpoi-provider-sync`, `dsh-enpoi-runtime-probe` |
| Context/orchestration | `dsh-enpoi-living-brief`, `dsh-enpoi-context-keeper`, `dsh-enpoi-cascade`, `dsh-enpoi-memory`, `dsh-enpoi-council`, `dsh-enpoi-capabilities`, `dsh-enpoi-model-chains`, `dsh-enpoi-catalog-rules` |
| Files/tools | `dsh-enpoi-file-revert`, `dsh-enpoi-fs-ops`, `dsh-enpoi-git`, `dsh-enpoi-ui-state` |
| Agents/interconnect | `dsh-enpoi-agent-switch`, `dsh-enpoi-peer-bridge`, `dsh-enpoi-role-registry`, `dsh-enpoi-whiteboard` |
| Providers/external | `dsh-enpoi-heavy-providers`, `dsh-enpoi-commandcode-provider`, `dsh-fast`, `dsh-context` |

Not profile bundles: `dsh-enpoi-oracle`, `dsh-enpoi-debug`, and `dsh-enpoi-tool-groups` load from the agent presets, and `dsh-enpoi-contracts` is a shared library (dependency). Heavy providers install nothing until an operator adds one (below).

## Default provider preset: Kilo Gateway (keyless)

- Preset data: id `kilo`, protocol `openai-completions`, base URL `https://api.kilo.ai/api/gateway`, env `KILO_API_KEY` (`$REPO/packages/client/ui-settings-models/src/client/provider-presets.ts:887-895`).
- **Keyless by policy**: `kilo` is in `KEYLESS_PRESET_IDS` (`provider-templates.ts:49`), so the Add-Provider wizard does not require a key; a supplied key switches the same route to BYOK.
- What works without sign-in: the free tier — `kilo-auto/free` (256k context, tools, reasoning), `stealth/space-bunny-alpha`, `poolside/laguna-s-2.1:free`, `nvidia/nemotron-3-ultra-550b-a55b:free`, `dots-studio/dots-3-note-preview:free`; discovery syncs the full catalogue into the route after first boot.
- What needs sign-in: paid/gated models carry `gated: true` + `gateReason: sign-in required` — `kilo-auto/efficient`, `anthropic/claude-opus-5.5`, `openai/gpt-6-sol`, and the `deepseek/*` set in the same block. The picker dims them with that reason; a `gated` rule can exclude them (doc 03).
- `enpoi-provider-sync` stamps `gated` from the listing (`isFree === false` ⇒ gated) and merges the gate reason (`enpoi-provider-sync/src/index.ts:106,458,895-899`).
- Default session route is seeded by the first-run plugin (`packages/host/first-run/src/index.ts:19-27,113-128`): provider `kilo`, model `kilo-auto/free`; the seed runs once per settings document (route and default model written only while no provider routes exist, then a stored marker), so a route the operator removed is never re-added. The stored `agent-default-model` row appears in the profile patch after the first boot — check the row, do not assume.
- Add/remove in Settings → Models or the Add-Provider wizard; discovery runs automatically after add (doc 03).

## First-run system analysis (opt-in)

- Row `first-run-analysis` (`@deepseek-ai/dsh-host-first-run/analysis`, base bundle `packages/bundle/base/cordis.patch.yml:101-102`); routes `/system-analysis/status|start|accept|reject|seen` plus `/context` for the stored document (`packages/host/first-run/src/analysis.ts:36,309-318,397-405`).
- Defaults: preset `sysadmin`, route `kilo`/`kilo-auto/free`, permission preset `system-analysis` (workspace-write sandbox, approval never; shipped in the composed preset table at `packages/interaction/permission-presets/src/index.ts:202-204`), 15-minute bound, routes on (`analysis.ts:267-291`); nothing at boot starts or re-offers a run (`:1-9,227-245`).
- One read-only agent session investigates over six todo-driven stages — `machine`, `usage`, `hosting`, `networking`, `tooling`, `writing profile` (`INVESTIGATION_STAGES`, `investigation.ts:32-34`) — and records a general picture: machine kind and hardware classes, what the machine is used for, hosting categories, and general networking and tooling (prompt sections and the generalization rules, `investigation.ts:64-94`). The profile may not carry exact version numbers, folder/repo/project names, domains, IP addresses, or hostnames; failed probes are noted in general terms, never invented (`investigation.ts:84-89`). A leak scanner still runs over the published Markdown — IPv4 addresses, dotted version numbers, and domain-like strings (`documentViolations`, `investigation.ts:150-198`) — and the run logs the matched facts as a warning rather than failing the analysis (`investigation.ts:357-366`); the chip rail follows the session's `todo/write` list (`:329-336`).
- Artifacts: `$DSH_HOME/system-profile.md` (header + the agent's Markdown body; the header is `# System profile` plus one line naming the investigating preset — deliberately no provider/model route, `analysis.ts:126-154`, and a body that repeats its own leading `# …` title has that line dropped) and `$DSH_HOME/system-profile.json` (structured profile), written atomically; `$DSH_HOME/system-profile.decision` records `accepted`/`rejected`/`seen` (`analysis.ts:133-149,185-200,247-263`; `context-file.ts:19-35,258-292`). Accept keeps the files; Reject removes both and records the decision (`analysis.ts:247-256`).
- The review is one-time: the stored profile is shown once, then settled — Accepted, Rejected, or ignored (the `seen` marker; ignored counts as accepted and the files stay). A client load that finds a stored profile with no decision (after a host restart or against a settled run) renders the ready chip and fire-and-forget records `seen` (`ui-settings-models/src/client/system-analysis.ts:202-213,267-275`), so no later load re-shows it; the chip's × on the ready bar accepts without opening the panel (`SystemAnalysisChip.tsx:145-165`). A new investigation publishes a new profile and clears the marker (`analysis.ts:191-198`), so its review opens again; removing the two files and the marker by hand is the manual reset.
- Sysadmin context: the `first-run-context` row (`@deepseek-ai/dsh-host-first-run/context`), mounted by the orchestrator and sysadmin presets (`$PROFILE/cordis.patch.yml`), contributes one bounded essentials line (120-char fields) plus a reference to `$DSH_HOME/system-profile.md` (`context.ts:29-34`; `context-file.ts:48-52,143-149,176-183`).
- Before any run — and after a Reject — it contributes the documented default instead: `System profile: no analysis is stored for this machine yet.` (`context-file.ts:37-41`).

## Default tool set

Two layers:

1. **Base plugin rows** (`$REPO/packages/bundle/base/cordis.patch.yml:267-499`): bash, pwsh (Windows), jobs, fs, fs-search, skill, skill-filesystem, skill-badge, tool-skill, subagent + subagent-control (+list-agents), workflow, call-timeout-policy, todo, goal, ralph, web, mcp-resources, tools. Web-app adds session-query, cordis inspection, subagent model settings (`packages/bundle/web-app/cordis.patch.yml`).
2. **Presentation groups** (`dsh-enpoi-tool-groups`, shipped catalog):
- `static` (always presented): core (`bash edit glob grep read read_image skill subagent todo_write web_search write present` + `ask_user_question`), goals, plan, councils (`oracle_review`, `roundtable`, `chorus`, `council_*`, `request_evidence`), jobs, workflow, reporting, whiteboard, memory.
   - `on-demand` (attached per session): peer, debug/observability, creator (harness authoring).
- Defaults: `enabled: true` for every group; `preAttach: []` except `debug`, which the shipped catalog pre-attaches for every main-agent seat (`orchestrator`, `sysadmin`, `creator`) and the council broker, and `creator`, which pre-attaches to the creator seat alone so orchestrator and sysadmin never see the three harness-authoring tools (`$PROFILE/packages/enpoi-tool-groups/src/catalog.ts`). Switching from the creator to another operator therefore rebuilds the provider's prompt prefix once; switches among the other main agents stay byte-identical. Operator overrides live in `enpoi-orchestration.toolGroups` (doc 05).
- Main-agent composition: the three shipped presets declare the same rows in the same order, so a switch between orchestrator and sysadmin keeps the cached prompt prefix; the creator seat carries the three creator-group tools on top. Per-seat restrictions remain as the execution backstop (`enpoi-orchestration.seatToolDeny`, shipped default in `$PROFILE/packages/enpoi-capabilities/src/policy.ts`: `plugin_manager`, `cordis_inspect_list`, `cordis_inspect_query` are creator-only). User presets created with **+ New preset** copy the chosen base composition byte-for-byte and rewrite only the persona suffix, so they inherit the canonical shape.
- **Completeness is enforced:** every tool a shipped preset advertises must have an explicit `SHIPPED_TOOL_DEFAULTS` row or a documented `SHIPPED_TOOL_DEFAULT_EXEMPTIONS` prefix (`custom_*`, `mcp__*`, `peer_*`), and the guard pins the client mirror digest — a newly registered preset tool fails until its default is decided (04 §1; `$PROFILE/packages/enpoi-capabilities/tests/tool-defaults-completeness.spec.ts`).

## MCP servers: on-demand vs always-on

- Catalog: `enpoi-orchestration.mcpServers.<id>` = `{ serverName, transport, url, headers, apiKeyEnv, toolCallTimeoutMs, mode }`; `mode` absent means `always-on`, and `on-demand` servers are never auto-connected (`$PROFILE/packages/enpoi-capabilities/src/index.ts:87-99`; `mcp-mounts.ts:91-97`). A fresh profile seeds no catalog entry — the machine's own catalog is operator state in its patch; authoring lives in Settings → Dynamic → MCPs (06).
- Mounting is a session action: the agent calls the `mcp` tool (`list`/`mount`/`unmount`) or loads a skill whose frontmatter carries `mcp: [server]`. The shipped `mcp` policy row is `allow` — `list` is read-only and mount/unmount touch only operator-configured, operator-allowed servers, scoped to the calling session and reversible (`policy.ts:169-173`; `index.ts:761-866`).
- The session's mounted set is durable (`mcp/mounts` event → `mcpMounts` projection, `mcp-mounts.ts:32-77`) and comes back on resume; always-on servers count as mounted implicitly. One shared connection per server serves every session that mounted it, and it is disposed when the last session unmounts or at session teardown (`index.ts:505-533,556-618,653-666,710-724`).
- Honesty: a server this session has not mounted is stripped from the advertised surface and denied at pre-execute with a "mount it first" reason (`index.ts:419-450,1361-1376`). Doctrine: a mount made for continuing work stays; a one-shot errand unmounts when done; unsure → leave it mounted (`index.ts:858-866`). The session header chip lists the current mounts and offers unmount (09).

## Default skin

- Active skin: `summer-liquid-glass` (frozen `1.0.0-frozen`); guard default `DSH_GUARD_SKIN=summer-liquid-glass` restores it only when `skin-center-active.json` says `active: null` (`$PROFILE/scripts/dsh-skin-guard.mjs:20-40`).
- Seed settings: dark preference, background enabled (80% opacity, blur 15/20/8), `skin-wallpaper` off (`$PROFILE/fresh-settings.yaml:8-17`).
- The skin is a right-rail/console-wide surface; contrast and rebrand gates in doc 11 are the acceptance test.

## Default seats (fleet)

- Seats come from the role registry. Defaults: every built-in role is seat-enabled unless its entry sets `seat: false`; `spawnable` defaults true except the tool-only Oracle (`$REPO/packages/subagent/tool-subagent/src/index.ts:487-540,669-683,394`).
- Keeper seat default route: `kilo/kilo-auto/free` — the keyless route first-run seeds, because the keeper has no parent turn to inherit from and a fresh install has no `freellmapi` route. The keeper/compaction persona assignment is seeded by the same first-run write (never by the tracked template: personas name a provider, so they are route state), and re-applying the template preserves operator persona edits. The client label and the plugin Config default must agree (`ui-brand-enpoi/src/client/role-registry.ts:60`; `$PROFILE/packages/enpoi-context-keeper/src/index.ts` Config defaults).
- Compaction is a **designated seat**: always rendered, inherits the session model by default; a different summariser breaks the prompt-prefix cache (`ui-brand-enpoi/src/client/AgentModelsBody.tsx:12-18,217`; `role-registry.ts:268`).
- Assign/reset per seat in the Agent Models tab; `Inherit` clears the assignment (doc 07).

## What is optional, and how to toggle

| Optional | Default | Toggle |
|---|---|---|
| Context keeper (`enpoi-context-keeper`) | on; capability `keeper: true` | Settings → Capabilities (or `enpoi-orchestration.capabilities.tools.keeper`); removing the bundle disables the feature entirely |
| Compaction seat ("compactor") | on; compaction is upstream; seat inherits session model | assign/clear `enpoi-orchestration.personas.compaction`; tune in Orchestration → Compaction; upstream compaction itself is not removable via settings |
| Whiteboard (`enpoi-whiteboard`) | bundle + `whiteboard` tool group enabled | `enpoi-orchestration.toolGroups.groups.whiteboard.enabled: false`, or remove the bundle |
| Memory (`enpoi-memory`) | on; `memory` tools | capability/config `enpoi-orchestration` memory group; tool group switch |
| Council/Oracle | on; `councils` group | `capabilities.tools.roundtable` / `.oracle_review` |
| Peer interconnect | tool group `peer` on-demand | attach per session, or `toolGroups.groups.peer.enabled: false` |
| Heavy providers (FreeLLMAPI / Antigravity / Command Code) | nothing installed | Add Provider → heavy group → detect/install (Command Code links the provider package, then talks to the vendor directly); Remove cleans route, credential, pool, cache, chains (doc 03) |

Settings-document toggles apply hot on the next spawn/render; bundle list changes (`$PROFILE/package.json` → `dsh.profile.bundles`) need a profile rebuild and `dsh restart --after-turn` (never restart from inside a turn).

## Defaults vs session overrides (capability scoping)

The effective capability surface is **profile DEFAULTS ⊕ per-role availability ⊕ SESSION OVERRIDES**; the runtime's own effective state folds defaults ⊕ overrides (`effectiveCapabilitiesState`, `$PROFILE/packages/enpoi-capabilities/src/capability-overrides.ts:139-150`), while a role's `tools.available` allowlist gates which agents hold a tool on top (07 §8; `policy.ts:201`).

- **Defaults** live in the `enpoi-orchestration` document (`capabilities.skills/tools/mcp`, plus the per-role availability). Editing on the blank/new-session page of the Capabilities Control Center writes them; every future session inherits, and a session without overrides reads them directly.
- **Session overrides** live in the session log: the `capabilities/overrides` event carries the complete post-change record (`skills`/`tools`/`mcp` maps; an absent key inherits) and the `capabilityOverrides` projection folds it with a wire view, so a resumed session comes back with exactly its overrides (`$PROFILE/packages/enpoi-capabilities/src/capability-overrides.ts:15-30,80-100`). Editing inside a live session writes only this layer — durable, logged, the default untouched. A per-row **Reset** removes the override.
- **MCP mounts are session overrides**: the `mcp/mounts` event + `mcpMounts` projection (on-demand servers; always-on servers are implicitly mounted). Reset unmounts.
- **Runtime application**: the system-prompt tool-surface filter, the skill-catalog filter, and the pre-execute capability backstop all compute the effective state per session (`effectiveCapabilitiesState`), so a default change reaches new sessions and override-free sessions, while an override is hot-applied to its own session only. The surface change is logged (model-visible ⟺ logged).

## Where "install defaults" come from

- Installer seeds `$DSH_HOME` once: `fresh-settings.yaml` → `settings.yaml`, plus presets, skills, systemd/fish helpers (`$REPO/scripts/install.sh:1-25,627,664`).
- The profile's own patch layer (`$PROFILE/cordis.patch.yml`) ships as a fresh-install template: composition rows plus the orchestration parameters that `fresh-settings.yaml` also carries. Operator state (providers, default model, UI settings, seats, personas, permissions, grants, MCP catalog, chains, favorites, whiteboard) is written into a machine's own patch by the settings service; `scripts/install.sh` and the sandbox strip those rows from a freshly copied patch, and they are never committed to the profile repo. Personas are route state and ship through neither file: the first-run seed (`packages/host/first-run`) writes the keeper/compaction assignments once, pinned to the keyless Kilo route it seeds. Read the template before claiming a value is a "fresh default".
