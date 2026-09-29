# 05 — Tools & tool groups

The surface a model sees = the mounted tool registry **minus** whatever the tool-group presentation filter denies. Path convention: `packages/enpoi-*` is the installed profile bundle's `packages/` tree; other `packages/...` paths are the harness checkout. Two mechanisms shape the surface; know which one you are touching: groups control *visibility*, the permission policy controls *execution* (file 04).

## 1. The default tool set on install

The frozen wire rosters live in `scripts/tool-inventory/expected-<preset>.json` and are the authority for "what does preset X actually advertise":

| Preset | Wire tools | Fixture |
|---|---|---|
| orchestrator | 39 | `scripts/tool-inventory/expected-orchestrator.json` |
| sysadmin | 39 (≡ orchestrator) | `scripts/tool-inventory/expected-sysadmin.json` |
| creator | 40 | `scripts/tool-inventory/expected-creator.json` |

Capture notes: `scripts/tool-inventory/roster-baseline.json:1-3`. The fixtures are frozen at 0.1.7 and lag the live declarations: `preset-creator` now mounts `enpoi-tool-groups` (seat `creator`, `debug` pre-attached through the `toolGroups.seats.creator` document row) and `enpoi-debug`, so its live surface hides `peer` and gains `tool_groups` — the 40-tool fixture still lists `peer_*` and omits `tool_groups`. Probe before quoting a count: `node scripts/preset-tool-inventory.mjs --print --presets=creator` (one model call); `scripts/tool-roster-diff.mjs` diffs fixtures against the stored baseline offline.

The shipped group catalog is data (`packages/enpoi-tool-groups/src/catalog.ts:52-158`). Static groups are always presented; on-demand groups must be attached:

| Group | Mode | Members |
|---|---|---|
| `core` | static | ask_user_question, bash, edit, glob, grep, read, read_image, skill, subagent, todo_write, web_search, write, present |
| `goals` | static | create_goal, get_goal, update_goal |
| `plan` | static | exit_plan_mode |
| `councils` | static | chorus, council_list, council_register, oracle_review, request_evidence, roundtable |
| `jobs` | static | job_kill, job_list, job_output |
| `workflow` | static | ralph, workflow |
| `reporting` | static | fast_report |
| `whiteboard` | static | whiteboard_forget, whiteboard_pin, whiteboard_read, whiteboard_unpin, whiteboard_write |
| `memory` | static | memory_confirm, memory_rescind, memory_save, memory_search |
| `peer` | on-demand | peer_status, peer_ask, peer_asks, peer_answer, peer_cancel |
| `debug` | on-demand | diagnostics_report, session_debug, session_event_read, session_event_search, session_event_trace, session_search, session_trace |

Anything not named by a group is never denied by the filter — it fails open (`catalog.ts:277-303`). `tool_groups` itself is never a group member (`index.ts:54-55`). `run_code` is a reserved presentation transport and cannot be filtered (`catalog.ts:271-275`, `294-299`).

## 2. The `tool_groups` meta-tool

Registered by `enpoi-tool-groups` for every agent of the preset that mounts it (`index.ts:411-469`). Actions: `list`, `attach`, `detach`.

- `list` is read-only and never asks; `attach`/`detach` defer to the normal permission policy **unless** the target group is inside the calling seat's own declared pre-attach set — attaching what the seat already declares is the seat's own behaviour, not new authority (`index.ts:494-523`). The listener registers `prepend` so an allow runs before the capability policy's ask; an operator capability-disable still wins.
- A change is durable immediately but takes effect **next turn**: the tool result says "END YOUR TURN NOW" and calls to the pending group's tools return a named hint instead of `UNKNOWN_TOOL` (`index.ts:228-243`, `531-561`).
- Durable state is the `tool-groups/change` event carrying the complete post-change set (`projection.ts:18-26`, `51-57`), folded into the `toolGroups` session projection; a resumed session restores exactly its attached set (`projection.ts:3-9`). Planning reads the durable set, so two attaches in one turn compose (`index.ts:442-445`).

## 3. Seat pre-attach

A seat is a preset/agent identity. `Config.seat` defaults to `'default'` (`index.ts:44-52`). Resolution:

- Operator override: `enpoi-orchestration.toolGroups.seats.<seat>.preAttach` (string[]).
- Else the union of each group's own `preAttach` entries for that seat (`preAttachFor`, `catalog.ts:218-224`).
- Unknown ids are ignored and disabled groups dropped; order follows the catalog.
- The profile's `enpoi-orchestration.toolGroups.seats` document pre-attaches `debug` for `creator` and `broker`; the council seats (`skeptic`, `architect`, `pragmatist`, `referee`, `chair`) declare explicit empty lists. A seat entry replaces the group-level `preAttach` union, so an explicit empty list is how a seat opts out of a group default (`preAttachFor`, `catalog.ts:218-224`). No other seat has a row → nothing pre-attached; read the document before asserting a seat's set.
- A delegated child carries the **parent's** preset; its real seat is read from its `subagent/descriptor` label — `roundtable seat: pragmatist`, `council chair: …`, etc. (`seatOfAgent`, `index.ts:287-302`; `seatOfDescriptorLabel`, `catalog.ts:243-268`). An unrecognized label falls back to the mount seat.

## 4. Hiding vs advertising

- The filter is deny-only and membership-driven: a name is denied only when its group is disabled or is an enabled on-demand group that is not attached (`denyNames`, `catalog.ts:290-303`). It installs per agent as `tools.restrict({ deny })` in a plugin-owned scope (`index.ts:98-121`, `316-345`); a preset switch disposes the old filter with the old mount.
- **Fail open, never silently**: a filter that cannot install hides nothing and records a `tool-groups/inert` diagnostics incident once per session (`index.ts:333-344`); if the projection registry is missing, `attach`/`detach` refuse with "tool groups are unavailable … failing open" and the menu still renders (`index.ts:374-383`, `461-463`).
- Advertising under an impossible approval policy (`never`, i.e. delegated children): only tools whose resolution is a final `deny` are dropped; an `ask` **stays advertised** because it is forwarded to the nearest live root (file 04 §6). bash is judged by its tool-level row, not by the empty-command guard (`policy.ts:695-758`; caller at `index.ts:261-297`).
- Capability-disabled tools are stripped from the tool schema and their prompt guidance is pruned in the same assemble pass (`index.ts:252-311`). An operator can also disable the `tool_groups` meta-tool itself via `capabilities.tools.tool_groups === false` (`index.ts:503-511`).

## 5. The prompt menu

`tool-groups:menu` renders in the system prompt at order `2950` (after tool guidance, before MCP servers): one line per enabled on-demand group with purpose, tool count, and state — `attached`, `not attached`, or `attached — applies from the next turn` (`index.ts:385-409`; `renderMenuText`, `catalog.ts:344-371`). Static groups are omitted (there is nothing to attach). An agent with no on-demand groups gets no section.

## 6. The operator drawer

The operator surface is the **Capabilities & Tools** drawer (`profiles/web/sidebar-patch/src/client/CapabilitiesView.tsx`): it renders capability groups — MCP Tool Suites, Specialist Skills, Subagents & Debaters, Core System Tools — with on/off toggles backed by `enpoi-orchestration.capabilities`. Tool-group overrides have no dedicated UI yet; edit `enpoi-orchestration.toolGroups` through the settings document (`groups.<id>.enabled`, `seats.<seat>.preAttach`, schema at `packages/enpoi-capabilities/src/index.ts:112-113`, `146-149`). The plugin reads the document hot (`index.ts:277-278`), so an edit applies to the next ensure (next turn).

## 7. How groups and permissions interact

1. Groups shape what is *presented* (this file). The permission policy then resolves `allow/ask/deny` per dispatch (file 04).
2. A group never grants execution rights: attaching `debug` only makes its tools visible; their policy rows (ship: read-only introspection `allow`, `session_debug` `allow`) still decide each call (`packages/enpoi-capabilities/src/policy.ts:111-121`).
3. A capability-disable (drawer toggle) beats both: the call is denied before policy, and the schema is stripped so the model cannot even attempt it.

## 8. Failure modes

| Symptom | Cause | Fix |
|---|---|---|
| `unknown tool group "x"` | typo / group not shipped | the refusal lists known ids (`catalog.ts:326-329`) |
| attach refused "always on" | target is `static` | nothing to do; static groups are always presented |
| attach refused "disabled by the operator" | `toolGroups.groups.<id>.enabled: false` | re-enable in settings |
| tool call fails with "not callable yet" | attached this turn | end the turn; it is callable next turn (`index.ts:544-546`) |
| tool call fails with `UNKNOWN_TOOL` for a group tool | group never attached | call `tool_groups` attach first |
| `tool_groups` missing entirely | the preset declaration does not mount `enpoi-tool-groups` | add the row to that `preset-<id>` declaration's `config.plugins` in `$PROFILE/cordis.patch.yml`, then restart |
| attach refuses "failing open" | no `sessionProjections` service | restore the projection plugin; groups keep working only as a static base surface |
