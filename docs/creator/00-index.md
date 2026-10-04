# 00 — Creator docs index and operating rules

This directory is the Creator's knowledge base: everything needed to diagnose, change, add, and remove parts of the Enpoi Harness on any machine. The Creator loads this file (the map + the rules) and then **reads the one deep file for the task** — it never guesses from memory.

## The map

| File | One line | Read this when… |
|---|---|---|
| `00-index.md` | This map + the ground rules. | Starting any harness task. |
| `01-architecture.md` | Process model (web service hosts sessions), durability (append-only logs, session format v4, retention pins, verify/repair), plugin/fiber model, profiles and config layers, on-disk layout, peer seam. | You need to know where a thing lives or which process owns it. |
| `02-install-and-update.md` | Installer (per-OS, no sudo, versioned dirs, shim), the locked Git-bootstrap distribution model (offline-bundled profile, no npm), channels (stable/beta), the overlay, `ds update`/`dsh update`, safe restart (`dsh restart --after-turn`), rollback. | Installing, updating, restarting, or rolling back a machine. |
| `03-providers-and-models.md` | models.dev catalogue + sync, adding/removing providers, discovery, keyless routes, heavy providers, key pools, model groups/chains, reasoning effort, rules/filters, error classes. | A model is missing, dimmed, rejected, or must be added/removed. |
| `04-permissions-and-approvals.md` | allow/ask/deny, grants + exact-command pins + broad-allow, Full access, forwarded child approvals, hard rails, per-agent rules. | An agent asks, is denied, or you must change approval policy. |
| `05-tools-and-groups.md` | Default tool set + permission-completeness guard, on-demand tool groups (catalog, attach/detach, seat pre-attach), hiding vs advertising, tool permissions. | A tool is absent, over-advertised, or must be grouped/hidden. |
| `06-skills-mcp.md` | Skills and MCP servers: add/remove/define, mount/unmount, the disposable-fiber pattern, granting permissions. Also covers custom command tools (incl. the shipped research tools). | Adding a skill or MCP, or one fails to mount. |
| `07-agents-and-orchestration.md` | Presets, main agents vs subagents, seats + fleet routing, creating agents, councils (roundtable: debaters/referee/chair, broker, vault), the Oracle, delegation rules + fleet lifecycle (child jobs, settlement notices, bounded list_agents), tier workflows, research delegation (one librarian + dials), keeper exemption. | Changing who runs what, or wiring a seat/council. |
| `08-context-management.md` | Tool-result pruner, context keeper + Living Brief, compaction (LLM + mechanical fallback, smart/mechanical toggle, coverage notes), summariser seat, revert iterations (◀ x/y ▶ branch history), whiteboard, memory, incremental search indexing, insights/backfill, what never changes the transcript. | Context is filling, the brief is stale, or compaction misbehaves. |
| `09-ui-surfaces.md` | Shell + sidebars, every settings page (orchestration, permissions, models/providers, general, …), context panel/insights, Watchtower, review surfaces, the first-run system-analysis chip and wizard reopen, model picker, skins/themes + freeze rules, dock, session actions (window top-up, iteration navigator, chat virtualization), toasts. | A surface is missing, misplaced, or must be changed. |
| `10-defaults-on-install.md` | Default plugins, the Kilo Gateway keyless preset, the opt-in first-run system analysis, default tools, skin, seats; what is optional (keeper/compactor/whiteboard/heavy providers) and how to toggle. | Comparing a machine to a fresh install, or changing a default. |
| `11-troubleshooting.md` | Diagnostics ledger + `ds doctor` and `dsh doctor` (checks and exit codes), the four gates with exact commands, common failures symptom→cause→fix (session listing, search partial results, verify-gate control plane, crash-recovery codes), the first-run system-analysis chip, evidence locations. | Something is broken; before/after any fix. |
| `12-glossary.md` | Every harness term in one line (seat, fiber, profile, overlay, heavy provider, gate, group, grant, rail, preset, council, broker, vault, projection, …). | A word in another file is unclear. |

## The rules (non-negotiable)

1. **Read the code before claiming.** Every behavioural statement must be verifiable in the source; cite `path:line` where it matters. No memory, no assumption. If a doc conflicts with the code, the code wins — fix the doc.
2. **Dense, not long.** Tables and bullets; one idea per line. A file that grew past its target is a signal to split or cut, not a reason to skim.
3. **Task-shaped.** Start from "how do I do X / where is Y / what breaks and why", then answer it.
4. **Name the knobs.** Every setting, flag, CLI option, and env var that matters, with its default and the file that owns it.
5. **State failure modes.** Symptom → cause → fix, and the gate that catches it. Silent failure is the default in an all-plugin system; say so.
6. **Pointers, not duplication.** Link to the owning source, the safeguards playbook, and the evidence tree instead of copying text that will drift.
7. **Update with the change.** A behavior change updates the affected doc in the same change; a doc that contradicts the code is a defect, not a historical note.

## Server-agnostic rule

These files ship with the code and must work on any OS and any machine. Write `$REPO`, `$DSH_HOME`, `$PROFILE` — never an IP, hostname, absolute user path, or a value that only exists on one box. Machine values live in the device overlay (`$DSH_HOME/heavy-server-overlay.json`) and profile settings; point the reader there.

## How the Creator operates

- **Scope.** Harness only: packages, profiles, skills, MCPs, UI bundles, plugins, settings. Hardware/OS work (systemd, Docker, GPU, network) belongs to the `sysadmin` preset; general application code to `orchestrator`. The `creator` preset prompt is the `preset-creator` declaration in `$PROFILE/cordis.patch.yml` — this index pointed at as the knowledge base, plus the operating rules; the `presets/<id>/agent.cordis.yml` directories are the pre-merge source and are not loaded.
- **Orientation.** Read the file for the task; check `$REPO` and `$PROFILE` before editing. Prefer reading a file over guessing its shape.
- **Change loop.** Make the smallest change; rebuild the owning artifact (client bundle / `lib/`); run the gates in doc 11 that cover the surface. A client rebuild silently reverts fork branding — re-run `dsh-rebrand.mjs` every time.
- **Never restart the service from inside a turn.** A restart command run from a tool call kills the process hosting the turn: the tool result never returns. Use `dsh restart --after-turn` (default: bounded whole-service idle wait, 10 min); `dsh restart --cancel` withdraws it; detached `dsh restart --now` only from a caller that is not the session host.
- **Verify, then report.** "Done" means the gate is green on the changed tree, not that the edit was made. Cite the command and its output.

## Distribution model (locked)

- **Git-bootstrap, one line.** `curl -fsSL https://raw.githubusercontent.com/Darthph0enix7/deepseek-harness/stable/scripts/install.sh | bash` clones the harness at the channel ref, installs and builds it, seeds `$DSH_HOME`, and writes the `dsh` shim (02 §1). The repo is pull-only and disposable; everything the user owns lives in `$DSH_HOME`.
- **The profile is offline-bundled.** The Enpoi profile (plugins, skills, research scripts, shipped composition) lives in `$REPO/profile/<name>`; the installer seeds `$DSH_HOME/profiles/<name>` from that tree, with no profile-repo fetch on the default path (`scripts/install.sh:979-1005`; 02 §0).
- **Updates ride the same tree.** `dsh update` re-fetches the channel ref, rebuilds, refreshes the profile, runs migrations, restarts safely, and rolls back on failure (02 §4).
- **npm publication is deferred / not used.** The fork is not published to any registry and the package family keeps its upstream names; there is no rename, no `@enpoi/*` scope, and no npm install path. Decision A7 (`~/dsh-migration/81-packaging-distribution-and-channels.md`); do not wire npm installs meanwhile.

## Companion material

- Migration/porting workbook: `~/dsh-migration/` — the open backlog (`82`), the upgrade playbook safeguards (`50`), the verification guide (`84`). On other machines these may be absent; the code and the gates are the authority.
- Upstream docs stay upstream: `$REPO/docs/` (architecture, subsystems, cookbook) and package READMEs. The Creator docs describe *our* fork on top, and point back to upstream pages instead of restating them.
