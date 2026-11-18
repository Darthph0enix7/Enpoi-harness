# 05 — Tools & tool groups

The surface a model sees = the mounted tool registry **minus** whatever the tool-group presentation filter denies. Path convention: `packages/enpoi-*` is the installed profile bundle's `packages/` tree; other `packages/...` paths are the harness checkout. Two mechanisms shape the surface; know which one you are touching: groups control *visibility*, the permission policy controls *execution* (file 04).

## 1. The default tool set on install

The captured rosters in `scripts/tool-inventory/expected-<preset>.json` record what each preset advertises in the built profile. Each fixture includes an artifact receipt; the fixture check rejects stale captures. `apps/web/tests/keyless-tool-inventory.e2e.ts` boots the shipped composition with an isolated child environment, owned home and state paths, and a local fake model. It captures the tool schemas from one simulated turn per preset and compares them with the runtime wire log.

| Preset | Inventory status | Fixture |
|---|---|---|
| orchestrator | Captured; count and artifact receipt in fixture | `scripts/tool-inventory/expected-orchestrator.json` |
| sysadmin | Captured; count and artifact receipt in fixture | `scripts/tool-inventory/expected-sysadmin.json` |
| creator | Captured; harness-authoring trio pre-attached | `scripts/tool-inventory/expected-creator.json` |

The captured counts are 50 tools for orchestrator, 50 for sysadmin, and 53 for creator; the creator's extra three are the `creator` group's authoring trio. The eight-tool `peer` family is on-demand and detached for every seat, so no `peer_*` name appears in any fixture and none of the three counts includes one.

Capture requires a current host build, verified profile-bundle fingerprints, and a validated client build record. Set `DSH_KEYLESS_INVENTORY_CAPTURE=1` to run it and `DSH_TOOL_INVENTORY_WRITE=1` to update fixtures after reviewing the printed tool differences. Requests are restricted to the test server's own port; this is a test guard, not an OS sandbox. The receipt records profile source/output fingerprints, external package artifacts, selected host artifacts, and the client build record. HEAD is informational, not a freshness condition. `DSH_INVENTORY_DEV_BLOCKED=1` permits only the development assertion for explicitly stale fixtures; it is not release evidence.

The capture includes shipped compatibility exemptions, but no operator settings. A live session can additionally advertise operator-enabled `web_search`, attached groups, custom tools, or operator compatibility overrides. `scripts/preset-tool-inventory.mjs` is the separate live-wire probe and spends one model call per preset. `scripts/tool-inventory/roster-baseline.json` is its historical baseline; `scripts/tool-roster-diff.mjs` can report drift from that baseline even when the shipped-default capture is current.

The **permission** side is complete by construction: `packages/enpoi-capabilities/tests/tool-defaults-completeness.spec.ts` fails a newly advertised preset tool until it has an explicit `SHIPPED_TOOL_DEFAULTS` row or a documented `SHIPPED_TOOL_DEFAULT_EXEMPTIONS` prefix, and the Permissions page reads the generated host mirror instead of a hand-kept list (04 §1).

A delegated child sees a narrower catalog than its parent. `SHARED_CHILD_DENY` removes `whiteboard_write`, `whiteboard_pin`, `whiteboard_unpin`, and `whiteboard_forget` — the whiteboard plugin refuses every mutation from a session with a durable parent — while `SHARED_CHILD_KEEP` adds `whiteboard_read` and `compressor_retrieve` to every child surface, including an explicit operator or role allowlist. Only an explicit operator `deny` removes a keep name (`packages/subagent/tool-subagent/src/index.ts:503-563`).

The shipped group catalog is data (`packages/enpoi-tool-groups/src/catalog.ts:86-234`). Static groups are always presented; on-demand groups must be attached:

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
| `recall` | static | session_event_read, session_event_search, session_search |
| `peer` | on-demand | peer_status, peer_sessions, peer_models, peer_switch_model, peer_ask, peer_asks, peer_answer, peer_cancel |
| `debug` | on-demand | diagnostics_report, session_debug, session_event_trace, session_trace |
| `creator` | on-demand | cordis_inspect_list, cordis_inspect_query, plugin_manager (pre-attached to the `creator` seat only) |

The `creator` group also declares `seats: ['creator']`, so orchestrator and sysadmin can neither see nor attach it. The `peer` family is on-demand for every seat: it declares no `seats` restriction and an empty `preAttach`, so a fresh session starts with all eight tools detached, and only an operator `seats.<seat>.preAttach` entry starts one attached. `peer_models` is read-only discovery; `peer_switch_model` mutates the remote session's next-turn route. Anything not named by a group is never denied by the filter — it fails open (`catalog.ts:497-525`). `tool_groups` itself is never a group member (`index.ts:54-55`). `run_code` is a reserved presentation transport and cannot be filtered (`catalog.ts:482-495`).

## 2. The `tool_groups` meta-tool

Registered by `enpoi-tool-groups` for every agent of the preset that mounts it (`index.ts:451-520`). Actions: `list`, `attach`, `detach`.

- `list` is read-only and never asks; `attach`/`detach` defer to the normal permission policy **unless** the target group is inside the calling seat's own declared pre-attach set — attaching what the seat already declares is the seat's own behaviour, not new authority (`index.ts:558-572`). The listener registers `prepend` so an allow runs before the capability policy's ask; an operator capability-disable still wins.
- A change is durable immediately but takes effect **next turn**: the tool result says "END YOUR TURN NOW" and calls to the pending group's tools return a named hint instead of `UNKNOWN_TOOL` (`index.ts:232-242`, `601-607`).
- Durable state is the `tool-groups/change` event carrying the complete post-change set (`projection.ts:18-26`, `51-57`), folded into the `toolGroups` session projection; a resumed session restores exactly its attached set (`projection.ts:3-9`). Planning reads the durable set, so two attaches in one turn compose (`index.ts:480-483`).

## 3. Seat pre-attach

A seat is a preset/agent identity. `Config.seat` defaults to `'default'` (`index.ts:44-52`). Resolution:

- Operator override: `enpoi-orchestration.toolGroups.seats.<seat>.preAttach` (string[]).
- Else the union of each group's own `preAttach` entries for that seat (`preAttachFor`, `catalog.ts:410-425`).
- Unknown ids are ignored and disabled groups dropped; order follows the catalog.
- Shipped group defaults: the `creator` group carries `preAttach: ['creator']`, so only the creator seat starts with its harness-authoring trio attached; `peer` and `debug` declare `preAttach: []` and every other seat starts detached (`catalog.ts`). Operator `seats.<seat>.preAttach` entries override this.
- An operator seat entry replaces the group-level `preAttach` union, so an explicit empty list is how a seat opts out of any future group default (`preAttachFor`, `catalog.ts:410-425`). Read the profile document before asserting a seat's set; an operator override always wins.
- A delegated child carries the **parent's** preset; its real seat is read from its `subagent/descriptor` label — `roundtable seat: pragmatist`, `council chair: …`, etc. (`seatOfAgent`, `index.ts:300-338`; `seatOfDescriptorLabel`, `catalog.ts:464-483`). An unrecognized label falls back to the mount seat.

## 4. Hiding vs advertising

- The filter is deny-only and membership-driven: a name is denied only when its group is disabled or is an enabled on-demand group that is not attached (`denyNames`, `catalog.ts:497-525`). It installs per agent as `tools.restrict({ deny })` in a plugin-owned scope (`index.ts:352-390`); a preset switch disposes the old filter with the old mount.
- **Fail open, never silently**: a filter that cannot install hides nothing and records a `tool-groups/inert` diagnostics incident once per session (`index.ts:374-382`); if the projection registry is missing, `attach`/`detach` refuse with "tool groups are unavailable … failing open" and the menu still renders (`index.ts:496-503`).
- Advertising under an impossible approval policy (`never`, i.e. delegated children): only tools whose resolution is a final `deny` are dropped; an `ask` **stays advertised** because it is forwarded to the nearest live root (file 04 §6). bash is judged by its tool-level row, not by the empty-command guard (`policy.ts:695-758`; caller at `index.ts:261-297`).
- Capability-disabled tools are stripped from the tool schema and their prompt guidance is pruned in the same assemble pass (`index.ts:252-311`). An operator can also disable the `tool_groups` meta-tool itself via `capabilities.tools.tool_groups === false` (`index.ts:503-511`).

## 5. The prompt menu

`tool-groups:menu` renders in the system prompt at order `2950` (after tool guidance, before MCP servers): one line per enabled on-demand group with purpose, tool count, and state — `attached`, `not attached`, or `attached — applies from the next turn` (`index.ts:423-447`; `renderMenuText`, `catalog.ts:569-600`). Static groups are omitted (there is nothing to attach). An agent with no on-demand groups gets no section.

## 6. The operator surface (Capabilities Control Center)

The operator surface is the **Capabilities Control Center** right-sidebar tab (`$REPO/packages/client/ui-brand-enpoi/src/client/CapabilitiesBody.tsx`; registration `index.ts:294-358`): it renders the effective surface for its bound session — MCP Tool Suites, Specialist Skills, Subagents, Councils, Tool Flags — as on/off toggles. On a blank/new-session page it authors the profile defaults (`enpoi-orchestration.capabilities`); in a live session it writes durable session overrides (the `capabilities/overrides` event), with a per-row `session` badge and Reset (09, 10 §Defaults vs session overrides). Tool-group overrides still have no dedicated UI: edit `enpoi-orchestration.toolGroups` through the settings document (`groups.<id>.enabled`, `seats.<seat>.preAttach`, schema at `packages/enpoi-capabilities/src/index.ts:140,184`). The plugin reads the document hot (`index.ts:277-278`), so an edit applies to the next ensure (next turn).

## 7. How groups and permissions interact

1. Groups shape what is *presented* (this file). The permission policy then resolves `allow/ask/deny` per dispatch (file 04).
2. A group never grants execution rights: attaching `debug` only makes its tools visible; their policy rows (ship: read-only introspection `allow`, `session_debug` `allow`) still decide each call (`packages/enpoi-capabilities/src/policy.ts:237-240`).
3. A capability-disable (Capabilities toggle) beats both: the call is denied before policy, and the schema is stripped so the model cannot even attempt it.

## 8. Custom command tools (operator-authored)

- Data is the `customTools` array in the `enpoi-orchestration` document: `{ id, name, description, params: [{ name, type: string|number|boolean, required, description }], command }`; ids and param names are kebab-case, max 16 params, 8192 command chars (`$PROFILE/packages/enpoi-custom-tools/src/render.ts:8-19,45-63`).
- Authored in Settings → Dynamic → Skills & tools → Tools → **+ Add tool** (params editor with per-row name/type/required/description; the command template textarea uses `{{param}}` placeholders); Edit and Delete sit on each custom row (`$REPO/packages/client/ui-brand-enpoi/src/client/dynamic/SkillsPanel.tsx:790-903,671-702`).
- Each record registers one real harness tool `custom_<id>` with the declared JSON parameter schema, hot-applied on `settings/document-updated` (`enpoi-custom-tools/src/index.ts:150-208,256`); the model sees the record's description and parameters.
- Execution renders the template: every `{{param}}` becomes a POSIX single-quoted shell word (`'…'`, embedded `'` escaped as `'\''`) — never raw interpolation — then runs through `ctx.shell` under the session's standing sandbox policy; stdout, stderr, exit code, signal, and timeout are returned honestly (`render.ts:116-118,144-162`; `index.ts:169-200`).
- The guard is the same `tools/pre-execute` listener bash uses: the plugin exposes the `customToolCommands` seam, enpoi-capabilities renders the command through it and feeds it into `resolvePolicy`, so dangerous verbs, wrappers, and interpreters ask or deny exactly as for bash — a deny wins (`enpoi-custom-tools/src/index.ts:241-250`; `packages/enpoi-capabilities/src/index.ts:1384-1394`; the same danger evaluation, `policy.ts:939-953`).
- Permission default: creating a tool writes its `permissions.tools.custom_<id>` row as `ask` in the same settings write as the record, so first use is operator-granted; the Permissions page lists the row automatically from the live registry (`$REPO/packages/client/ui-brand-enpoi/src/client/dynamic/SkillsPanel.tsx:495-498`; `$REPO/packages/client/ui-brand-enpoi/src/client/permissions-model.ts:413-448`). Delete removes the record and unsets that permission row in one write (`$REPO/packages/client/ui-brand-enpoi/src/client/dynamic/SkillsPanel.tsx:516-523`).
- Failure modes: an invalid record is skipped with its reason on stderr and keeps its last good registration (`index.ts:210-231`); a malformed placeholder or unknown parameter fails before execution (`render.ts:154-160`); without the plug-in the name alone resolves through the matrix/defaults.
- Shipped research tools (the two worked-example records; wire names `custom_research-fetch` and `custom_research-verify`, both seeded `allow` in this profile): `custom_research-fetch` renders `node $PROFILE/scripts/research-fetch.mjs --url {{url}} --dir {{dir}} --name {{name}}` — required `url` (public http(s)) and `dir` (the run's `sources/`), optional `name` slug — fetches one page, archives it as `sources/NN-slug.md` plus an `index.json` entry, and returns metadata only, so the page text never enters the conversation; `custom_research-verify` renders `node $PROFILE/scripts/research-verify.mjs --run-dir {{run-dir}}` — required `run-dir` containing `sources/` and `claims/` — mechanically anchors every claim's verbatim quote against its archived source (exact → normalized → fuzzy ≥0.85 = weak) and exits non-zero unless all claims anchor, writing `verification.json`/`verification.md`. The `research` skill consumes both end-to-end; `07` §2/§6 documents the librarian that runs it. The records themselves are ordinary `customTools` entries — copy them as the template for a new tool's params and command (`06` §7 owns the authoring surface).

## 9. Failure modes

| Symptom | Cause | Fix |
|---|---|---|
| `unknown tool group "x"` | typo / group not shipped | the refusal lists known ids (`catalog.ts:527-538`) |
| attach refused "always on" | target is `static` | nothing to do; static groups are always presented |
| attach refused "disabled by the operator" | `toolGroups.groups.<id>.enabled: false` | re-enable in settings |
| tool call fails with "not callable yet" | attached this turn | end the turn; it is callable next turn (`index.ts:584-590`) |
| tool call fails with `UNKNOWN_TOOL` for a group tool | group never attached | call `tool_groups` attach first |
| `tool_groups` missing entirely | the preset declaration does not mount `enpoi-tool-groups` | add the row to that `preset-<id>` declaration's `config.plugins` in `$PROFILE/cordis.patch.yml`, then restart |
| attach refuses "failing open" | no `sessionProjections` service | restore the projection plugin; groups keep working only as a static base surface |
| `peer_*` answers `peer/capability-missing` | the remote host does not advertise the capability | upgrade the host: the message reads `host does not advertise <cap>; upgrade the host` |
| `peer_switch_model` answers `peer/conflict` with `reason: busy` | the remote session is running or waiting | wait for the session to go idle, then switch; a switch never interrupts a live turn |

## 10. Programmatic tool calling (run_code) & execution rules

`run_code` provides Programmatic Tool Calling (PTC) via `packages/workflow/workflow-ptc`. It allows models to write and execute a TypeScript script that orchestrates tool calls in a single round-trip without multi-turn LLM latency or transcript bloating:
- **Presentation mode**: Configured as `mode: both` across all main agents (`orchestrator`, `sysadmin`, `creator`) and subagents (`fixer`, `explorer`), giving agents both direct tools and `run_code`.
- **Permission default**: Shipped as `allow` in `SHIPPED_TOOL_DEFAULTS`, so script execution runs silently without approval pauses. Inner tool calls (e.g. `tools.bash`, file writes) still pass through the `enpoi-capabilities` pre-execute danger evaluator.
- **Three binding execution rules**:
  1. **Fresh Node process**: Each invocation executes in a separate Node subprocess. No variables, modules, or memory carry across calls. Never park intermediate state in a temporary directory.
  2. **Erasable TypeScript only**: Uses Node's type-stripping runtime. Do not use runtime TypeScript constructs like `enum` or `namespace`; use plain objects and types.
  3. **Lossless JSON arguments**: Arguments passed to tools must be strictly JSON-serializable. Do not pass `undefined` inside objects or arrays; the bridge serializer rejects them outright.

## 11. Per-tool behavior contracts

### `list_agents` paging

`list_agents` takes `status` (`running` | `inactive`) and `query` (a case-insensitive substring over the child id and label) filters, plus `limit` and `offset`. `limit` defaults to 20 and clamps to 100; `offset` clamps at 0. Both bound only the rendered text: the structured result carries every matching row, so a `run_code` program receives the full array and filters it itself, while the rendered footer reports the displayed range, the running/inactive totals, and the next offset. A `status` filter drops diagnostic rows (they carry no status); a `query` can still select one by id. `scope: 'descendants'` adds each row's `parent` and `depth` (`packages/subagent/tool-subagent-control/src/list-agents.ts`).

### `compressor_retrieve`

`dsh-compressor` mounts from the profile patch row and crushes eligible tool results in-process, replacing each with a `<<compressor:<64 hex>>` locator. `compressor_retrieve` takes that locator or the bare hash and returns the original text from `$DSH_HOME/dsh-compressor/<sha256>`; an unknown hash is an error. The store is content-addressed and not session-scoped, so a session that holds a hash can retrieve text another session produced — the hash is the only key. Compression skips a fixed tool set (`read`, `glob`, `grep`, `write`, `edit`, `web_search`, `web_fetch`, `compressor_retrieve`, `headroom_retrieve`), results under 50 estimated tokens or 500 characters, protected error output of at most 8,000 characters (an `isError` result, or two distinct error indicators), recent source code, and results already carrying a compressor locator or an official spill notice. There is no compressor-specific control: the profile mounts the row unconditionally, a `capabilities.tools.compressor_retrieve: false` entry hides the retrieval tool (it is not a Tool Flag row on a fresh home), and a missing native addon leaves content unchanged with one stderr warning. The shipped `dsh-base` composition mounts `spill-policy` with `maxInlineTokens: 12500` before the profile's compressor row, so a successfully spilled result carries the official notice and the compressor leaves it untouched; compression therefore applies to results the spill policy kept inline.

### Memory tools

- `memory_save` stores one self-contained fact per call, at most 400 characters. The secret guard runs at intake for every origin (root, keeper, compaction, worker), so a credential-shaped fact is rejected before storage: `memory_save` answers `saved: false` with `rejected: looks like a credential or secret`, and the automated origins skip the fact silently; no path throws. The same fact text and category store once. A saved fact whose tokens closely match an existing active fact is still saved; the note names the closest existing id and its Jaccard similarity without merging the two.
- `memory_search` ranks first, then applies `retrieverCharBudget` (default 1,200 characters, configurable under `parameters.memory` and clamped to [200, 4,000]): it keeps whole facts in rank order, always keeps the top-ranked fact even when it alone exceeds the budget, and reports the omitted count so the model refines the query instead of assuming the facts do not exist. `retrieverTopK` (default 10, clamped to [1, 20]) caps the ranked set.
- Trust follows the calling session, not the tool name. A root save lands committed with operator trust; a delegated child saves a tentative `untrusted_external` `worker:<role>` claim. `memory_confirm` and `memory_rescind` are root-only: a delegated child gets `delegated_session_denied`, and a call with no trusted session context gets `root_session_required`, both with no database write (fail closed).

### Goal tools

`create_goal` requires `objective` and optionally takes `max_goal_rounds`; `update_goal` requires `goal_id`, `revision`, and `action` (`edit`, `pause`, `resume`, `complete`, `blocked`), with `objective` and `max_goal_rounds` valid only with `edit` and `blocked_reason` only with `blocked`; `get_goal` takes no parameters. Create, edit, pause, and resume require a direct human root request; complete and blocked also accept the exact current goal round, and blocked from an automatic continuation is rejected until the configured number of goal rounds has started (`packages/goal/tool-goal/src/index.ts:196-338`).
