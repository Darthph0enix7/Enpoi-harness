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

- Row `first-run-analysis` (`@deepseek-ai/dsh-host-first-run/analysis`, base bundle `packages/bundle/base/cordis.patch.yml:101-102`); routes `/system-analysis/status|start|accept|reject` plus `/context` for the stored document (`packages/host/first-run/src/analysis.ts:33-34,276-305`).
- Defaults: preset `sysadmin`, route `kilo`/`kilo-auto/free`, permission preset `workspace-write`, 15-minute bound, routes on (`analysis.ts:244-254`); nothing at boot starts or re-offers a run (`:1-9,195-213`).
- One read-only agent session investigates over eight todo-driven stages — `machine`, `usage`, `hosting`, `tooling`, `runtimes`, `networking`, `resources`, `writing profile` — and must state an evidence path per claim, reporting failed probes instead of dropping them (`investigation.ts:32-34,81-84`); the chip rail follows the session's `todo/write` list (`:107-124,273-277`).
- Artifacts: `$DSH_HOME/system-profile.md` (header + the agent's Markdown body) and `$DSH_HOME/system-profile.json` (structured profile), written atomically; `$DSH_HOME/system-profile.decision` records `accepted`/`rejected` (`analysis.ts:117-125,157-176`; `context-file.ts:19-26,191-226`). Accept keeps the files; Reject removes both and records the decision (`analysis.ts:216-224`).
- Sysadmin context: the `first-run-context` row (`@deepseek-ai/dsh-host-first-run/context`), mounted by the orchestrator and sysadmin presets (`$PROFILE/cordis.patch.yml`), contributes one bounded essentials line (120-char fields) plus a reference to `$DSH_HOME/system-profile.md` (`context.ts:29-34`; `context-file.ts:48-52,143-149,176-183`).
- Before any run — and after a Reject — it contributes the documented default instead: `System profile: no analysis is stored for this machine yet.` (`context-file.ts:37-41`).

## Default tool set

Two layers:

1. **Base plugin rows** (`$REPO/packages/bundle/base/cordis.patch.yml:267-499`): bash, pwsh (Windows), jobs, fs, fs-search, skill, skill-filesystem, skill-badge, tool-skill, subagent + subagent-control (+list-agents), workflow, call-timeout-policy, todo, goal, ralph, web, mcp-resources, tools. Web-app adds session-query, cordis inspection, subagent model settings (`packages/bundle/web-app/cordis.patch.yml`).
2. **Presentation groups** (`dsh-enpoi-tool-groups`, shipped catalog):
- `static` (always presented): core (`bash edit glob grep read read_image skill subagent todo_write web_search write present` + `ask_user_question`), goals, plan, councils (`oracle_review`, `roundtable`, `chorus`, `council_*`, `request_evidence`), jobs, workflow, reporting, whiteboard, memory.
   - `on-demand` (attached per session): peer, debug/observability.
- Defaults: `enabled: true`, `preAttach: []` for every group (`$PROFILE/packages/enpoi-tool-groups/src/catalog.ts:52-158`). Operator overrides live in `enpoi-orchestration.toolGroups` (doc 05).

## Default skin

- Active skin: `summer-liquid-glass` (frozen `1.0.0-frozen`); guard default `DSH_GUARD_SKIN=summer-liquid-glass` restores it only when `skin-center-active.json` says `active: null` (`$PROFILE/scripts/dsh-skin-guard.mjs:20-40`).
- Seed settings: dark preference, background enabled (80% opacity, blur 15/20/8), `skin-wallpaper` off (`$PROFILE/fresh-settings.yaml:8-17`).
- The skin is a right-rail/console-wide surface; contrast and rebrand gates in doc 11 are the acceptance test.

## Default seats (fleet)

- Seats come from the role registry. Defaults: every built-in role is seat-enabled unless its entry sets `seat: false`; `spawnable` defaults true except the tool-only Oracle (`$REPO/packages/subagent/tool-subagent/src/index.ts:487-540,669-683,394`).
- Keeper seat default route: `freellmapi/auto` — the keeper has no parent turn to inherit from (`ui-brand-enpoi/src/client/role-registry.ts:61`).
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
| Heavy providers (FreeLLMAPI / Antigravity / Command Code) | nothing installed | Add Provider → heavy group → detect/install; Remove cleans route, credential, pool, cache, chains (doc 03) |

Settings-document toggles apply hot on the next spawn/render; bundle list changes (`$PROFILE/package.json` → `dsh.profile.bundles`) need a profile rebuild and `dsh restart --after-turn` (never restart from inside a turn).

## Where "install defaults" come from

- Installer seeds `$DSH_HOME` once: `fresh-settings.yaml` → `settings.yaml`, plus presets, skills, systemd/fish helpers (`$REPO/scripts/install.sh:1-25,627,664`).
- The profile's own patch layer (`$PROFILE/cordis.patch.yml`) ships as a fresh-install template: composition rows plus the orchestration parameters that `fresh-settings.yaml` also carries. Operator state (providers, default model, UI settings, seats, permissions, grants, MCP catalog, chains, favorites, whiteboard) is written into a machine's own patch by the settings service; `scripts/install.sh` and the sandbox strip those rows from a freshly copied patch, and they are never committed to the profile repo. Read the template before claiming a value is a "fresh default".
