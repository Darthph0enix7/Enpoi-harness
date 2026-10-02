# 09 — UI surfaces (what the operator sees and clicks)

Read this when: a change must land in the web GUI — a sidebar tab, a settings page, the composer, a theme — or the operator reports a surface that is missing, misplaced, or unreadable.

Conventions. `packages/...` paths are in the harness repo (`$REPO`); `$PROFILE` is the active profile dir (default `$DSH_HOME/profiles/web`). The client is all-plugin: every surface below is a slot registration, not a hard-wired page. A surface that "disappeared" is almost always a registration whose slot declaration or owning bundle went away — check the gate first (doc 11).

## Shell

- Three columns: left sidebar / conversation / right panel + icon rail (`packages/client/ui-layout/src/client/AppFrame.tsx`). Global panels (settings, plugin manager) replace the conversation but keep it mounted.
- `shell.overlay` is the frame-wide layer for dialogs/toasts/docks that must outlive the component that raised them (`ui-workspace/src/client/index.ts:303-320`).

## Left sidebar

| Piece | Owner | Where |
|---|---|---|
| Brand mark / name, New-session button | ui-sidebar + enpoi brand | `ui-sidebar/src/client/index.ts:70-95`; `ui-brand-enpoi/src/client/index.ts:211-217` |
| Panel rows (rail when collapsed) | `sidebar.panellist` registrants | ui-sidebar `index.ts:49-63`; Plugins `ui-plugin-manager/src/client/index.ts:130`; Tasks `ui-schedule/src/client/index.ts:178` |
| Workspace/session browser | ui-workspace (`sidebar.workspaces`) | `ui-workspace/src/client/index.ts:265-285` |
| Footer: Context Dashboard above Settings | dsh-context (external) | profile dep `dsh-context`; README "Context Dashboard" |
| Settings trigger + connection indicator | ui-settings-general | `SettingsRoot.tsx:298-323` |

Collapse is a slide+crossfade; the 56px rail keeps one icon per panel row. macOS desktop moves toggle/new-chat into the window-chrome seat (`ui-sidebar/src/client/index.ts:96-102`).

## Session rows and actions

- Menu items: pin (100), rename (200), fork (300) (`ui-workspace/src/client/index.ts:290-294`).
- Hover buttons: archive (100), pin (200) — `index.ts:295-299`.
- **Archive is the single entry** for both states: the same button archives a live row and restores an archived one (`session-actions/ArchiveSession.tsx:26-47`). There is no second archive path in the menu.
- Archiving a busy session raises a confirm dialog that lists the running turn/subagents/jobs/schedules it will stop (`ArchiveSession.tsx:49-146`); cancelling leaves the session running.
- The result notice is a `shell.overlay` toast with Undo and "show archived" (`session-actions/RowActionToast.tsx`).
- Failures (pin/archive rejections) surface on the same toast, not silently.
- The rail tops its window up automatically: while the loaded window holds fewer than a first screenful (`MIN_RENDERABLE_SESSION_ROWS = 12`) of non-blank renderable session rows and more windows remain, the browser pulls the next window single-flight, so a page made of subagent children cannot leave the rail empty; a failed pull renders a `SessionListError` alert row (`data-row-key="session-list-error"`) with the already-loaded rows kept (`ui-workspace/src/client/rows/WorkspaceBrowser.tsx:299-303,335-374,707,785`).

## Conversation

- Header seats: lineage, actions, utilities, corner, leading (`ui-conversation/src/client/contract/slots.ts:133-183`).
- View tabs: upstream Chat + Trajectory; the fork adds **Watchtower** at order 30 (`ui-brand-enpoi/src/client/index.ts:219-230`); dsh-context/dsh-context-lens add Context and Request Context tabs.
- **The Mark** task cards shadow the upstream tool rows for `subagent`, `dispatch_task`, `task`, `oracle_review`, `roundtable`, `chorus` at priority -1 (`index.ts:483-502`; lower priority wins the key).
- Plan cards: submitted plans appear in the turn's final artifact area and open in the right sidebar (`ui-plan/README.md`); the plan-review card answers `exit_plan_mode` (`ui-user-questions/README.md:34-36`). Pending plan reviews are the review queue: the card's View-full-plan link opens the sidebar preview and Approve/Request-changes answers the wait (`ui-plan/src/client/review-store.ts`, `ui-user-questions/README.md:34-40`).
- **Chat virtualization**: above 80 committed render items the transcript renders through `@tanstack/react-virtual`; below it the plain list is unchanged. At a 10k-message session this mounts 17–26 rows instead of 20,000 and cuts transcript DOM from ~285k to ~1,000 nodes (≈5× faster load, 2.7× faster scroll; evidence `phase4/`). Key-anchored offsets keep the reader's row stable across prepends/appends/window changes; browser find still works inside rendered rows but cannot reach an unrendered one — session search and the turn rail cover those (`ui-chat/src/client/chat/chat-virtual-items.ts:21`; `ChatView.tsx:346`).
- **Iteration navigator**: a user message in a multi-variant revert group carries `◀ x / y ▶`; arrows move a local preview only, `Restore` asks the host to switch the branch, and a failed restore renders on the row (08 §8).

## Input card (composer)

Declared seats (`ui-conversation/src/client/contract/slots.ts:195-233`):

- `conversation.input.plan` — ui-plan chip; `/plan` toggles (`ui-plan/src/client/index.ts:116`).
- `conversation.input.agent` — agent-preset seat (`ui-agent-preset/src/client/index.ts:187`).
- `conversation.input.permission` — access mode (`ui-permission-presets/src/client/index.ts:167`).
- `conversation.input.model` — model + effort picker (`ui-model-selection/src/client/index.ts:195`).
- Attachments, activity (working indicator), overlay, left/right lists.

**The dock** is `conversation.input.dock`: a list above the composer hosting GoalBar (`ui-goal`), TodoDock (`ui-conversation/src/client/skeleton/TodoPanel.tsx:116`), QueueDock (`ui-conversation/src/client/queue/QueueDock.tsx:490-493`, order 20) and the revert dock. A queue made only of subagent settlement notices reads "N results pending" (`ui-conversation/src/client/locales.ts:886`) and parks the results instead of waking a turn.

## Right panel + rail

- The rail never hides; one button per registered page kind, plus the bottom terminal-dock toggle and panel chrome (`ui-sidebar-right/src/client/shell/SidebarRight.tsx:363-440`).
- Tab kinds come from `sidebarRightTabs.register`; fork operator tabs are `priority: 'extension'` with guide entries at orders 55-59 (`ui-brand-enpoi/src/client/index.ts:294-358`):

| Tab | Registered at |
|---|---|
| Guide (built-in) | `ui-sidebar-right/src/client/index.ts:241` |
| Files, Browser, Documents, Terminal, Plan, subagent chat, schedule task | `packages/client/ui-sidebar-files/src/client/index.ts:67`, `ui-sidebar-browser/src/client/index.ts:74`, `ui-sidebar-documentpreview/src/client/index.ts:98`, `ui-sidebar-terminal/src/client/index.ts:71`, `ui-plan/src/client/index.ts:65`, `ui-subagent/src/client/sidebar-chat/index.tsx:181` |
| Capabilities / Agent Models / Subagent Sessions / Git / Terminal | `ui-brand-enpoi/src/client/index.ts:294-358` |

Terminal: one PTY registry backs both the sidebar page and the bottom dock; `shell.overlay` id `enpoi-bottom-terminal` (`index.ts:360-481`).

- **Document editor** (`ui-enpoi-editor`): its own themed Find bar over CodeMirror (deliberately not the stock `@codemirror/search` panel) — every match is decorated, the revealed match is selected and centered in one transaction, an invalid regex is a quiet no-match instead of a throw, case and regex toggles are in the bar, and Go-to-line flashes the target line for 1.4 s (`EditorFindBar.tsx:1-40,58-120`; `CodeMirrorEditor.tsx:46-60,139-160`; `search.ts:1-15,110-160`).

## Settings

Trigger and modal: `ui-settings-general/src/client/SettingsRoot.tsx` (Escape, mask click, close button; phone gets a full-screen list→detail flow at `:212-217`). Sections are `settings.section` registrations, ordered:
| Order | Id | Owner |
|---|---|---|
| -10 | account | `ui-settings-account/src/client/index.ts:270` |
| 0 | general | `ui-settings-general/src/client/index.ts:242-245` |
| 10 | models (providers) | `ui-settings-models/src/client/index.ts:213-217` |
| 15 | plugins | `ui-settings-plugins/src/client/index.ts:76-80` |
| 20 | agent-presets | `ui-agent-preset/src/client/index.ts:239-243` |
| 20 | orchestration | `ui-brand-enpoi/src/client/index.ts:257-273` |
| 21 | permissions | `ui-brand-enpoi/src/client/index.ts:285-290` |
| 22 | dynamic | `ui-brand-enpoi/src/client/index.ts:277-282` |

- **Models/add provider** (`ui-settings-models`): provider list + detail, add wizard, discovery, heavy-provider group (docs 03/10).
- **Agent presets** (`ui-agent-preset/src/client/AgentPresetSection.tsx`): the roster with the new-task default, mode help, the read-only composition viewer, the Creator-mode entry, and manual authoring — one **New preset** button (a single rendered `+` icon; the label carries no second plus, `locales.ts:100`) opens a dialog that picks a base among presets with a shared persona and takes id/name/description/persona suffix; the clone copies the base composition byte-for-byte and rewrites only the suffix. **Edit**/**Delete** appear only on user rows; shipped presets render read-only (`manualProtected`). The host side is `profiles/web/packages/enpoi-preset-authoring` (fenced `/sidebar/presets`, `configEditor` insert/edit/remove); the manual block is disabled until Coding Tools are on in General settings (`AgentPresetSection.tsx:99,122,180-193`). See 07 §1.
- **Orchestration** (`OrchestrationSettings.tsx`): groups High Council (`:59-68`), Context Keeper (`:70-79`), Compaction (`:81-89`), Memory (`:91-94`), Oracle (`:96-98`); per-group reset; edits are hot-swapped (intro `:240`). Compaction shows the derived effective policy for the selected summariser route (`:164-191`).
- **Permissions** (`PermissionsSettings.tsx`): the policy editor over the enpoi-capabilities engine (doc 04) — global defaults, bash patterns, standing grants, and per-agent panes. The tool policy folds families derived from the shipped tool-group catalog — one aggregate row per enabled group with at least two same-policy members, named by the group label (**Goals**, **Councils**, **Jobs**, **Workflows**, **Whiteboard**, **Memory**, **Peer interconnect**, **Debug & observability**, **Creator (harness authoring)**; `core` stays per-tool and single-member groups fold nothing) — labels the `mcp` tool **MCP servers (mount / unmount)**, groups concrete `mcp__<server>__<tool>` names under a `<server> (MCP)` row, and derives the **All MCP tools** master; a family or master chip fans its policy out to every member key and owns no settings key itself (`permissions-model.ts:319-362,434-472`). A member whose shipped policy differs from the family's (the asking `council_register` and `job_kill`) renders as its own concrete row instead of hiding a mixed decision behind the family chip. Rows come from the live registry (`enpoiCapabilities.registeredTools`), so a custom tool or a new plugin's tools appear with no client change. Every row's shipped decision comes from the generated host mirror (`permissions-defaults.generated.ts`), written by `scripts/generate-permissions-mirror.ts` from the host policy tables and exemptions, the tool-group catalog, the seat guard, the child role tables, and the advertised main-agent surface; a digest and a client parity spec fail on drift, so the mirror is never hand-edited (04 §1). The availability eye reads a per-seat surface: orchestrator and sysadmin hold the shared advertised inventory, the creator additionally holds the creator tool group, a seat never shows a tool its own `SHIPPED_SEAT_TOOL_DENY` row denies (`operatorSurfaceFor`), and such a row carries no allowlist eye at all (`seatDeniesTool`) because no allowlist entry could make it visible.
- **Capabilities and Agent Models are not settings pages** — they are right sidebar tabs (`index.ts:294-358`); settings cross-links open them through the `settingsUi` service (`settings-nav.ts:16-28`).
- **Capabilities Control Center** (`CapabilitiesBody.tsx`): the effective surface for the bound session — profile defaults ⊕ per-role availability (the roles registry's `tools.available` gate, `policy.ts:201`) ⊕ session overrides (`effectiveCapabilitiesState`, `capability-overrides.ts:139-150`) — with a mode bar — **Editing defaults** on the blank/new-session page (or with no bound session) and **This session** inside a live session (`scopingModeOf`, `capability-scoping.ts:37-39`; `CapabilitiesBody.tsx:1341-1348`). Defaults edits write the `enpoi-orchestration` document (every future session inherits); session edits write the durable `capabilities/overrides` session event (the `capabilityOverrides` projection, wire-visible, logged) and leave the default untouched. Overridden rows carry a **Reset** control that returns the row to the default; a row the session layer turns ON — a durable mount, or a `true` session override for a skill, tool, or always-on server — additionally carries the subtle `mounted` badge and a thin inset rail, so a session pull reads differently from a profile default and from an always-on server, while an override that turns a row OFF keeps the plain `session` marker (`isSessionMounted`, `capability-scoping.ts:100`; `CapabilitiesBody.tsx`). MCP mounts are session overrides too — an on-demand server reads enabled exactly when this session mounted it, and Reset unmounts (`enpoiCapabilities.mcpMount`/`mcpUnmount`). The runtime applies the effective state in the system-prompt surface filter, the skill-catalog filter, and the pre-execute backstop (doc 10). Adding, removing, and editing entities stays in Settings → Dynamic (defaults-authoring); the center's footer links there.
- **Dynamic** (`dynamic/DynamicSettings.tsx`): Roles, Councils, MCPs, Skills & tools, Prompts panels, all editing the `enpoi-orchestration` document hot (defaults-authoring). The Skills & tools panel (`dynamic/SkillsPanel.tsx`) carries skill CRUD (Add/Edit/Delete over `/sidebar/fsops` `skills.*`, `dynamic/skills-api.ts`): user rows editable, shipped tier rows read-only; tool rows stay capability toggles. The same panel authors **custom command tools** (+ Add tool; id/name/description, the params editor, and a `{{param}}` command template; Edit/Delete per row) — see 05 §8.
- **Open configuration file** (loopback only, header action): `ui-settings-general` locates the settings document through the profile's fenced `/sidebar/fsops/settings.document` route, closes Settings, then reveals it in the right panel — the files page rooted at the document's containing directory (an ephemeral operator view: a `files` navigation `root` param, no Workspace entity and no workspace-list entry) and the document itself opened for the harness preview/editor (never an OS application). The fenced `fs.list`/`fs.write` grants cover exactly that directory; the agents' tool paths (fs/bash policy) never cross those routes. A failed locate leaves Settings open and renders the action's error line (`settings-document-open.ts:1-15,32-79`).

## First-run system analysis

- Frame-wide chip: `shell.overlay` id `system-analysis` (`ui-settings-models/src/client/index.ts:336-342`), portaled to `document.body` at z 1050 — above the settings modal (1000) and the wizard backdrop/tour (1010/1020), below transient menus (1100) (`SystemAnalysisChip.tsx:95-99,164`; `SystemAnalysisChip.module.css:1-10`; `WelcomeWizard.module.css:7-13,427-435`).
- The chip never starts the first run: hidden → running (bar button reveals the eight-phase rail, pct, 300 ms poll) → ready (the bar is a button; the panel shows the document with Accept/Reject, a click outside accepts, and the ready chip's × accepts without opening the panel) → hidden once a decision is recorded; failed shows the reason and Retry (`system-analysis.ts:66-84,204-215,296-325,347-360`; `SystemAnalysisChip.tsx:95-180`). Reject removes the stored files and records the decision; a stored undecided profile is displayed once and marked `seen` by that load — against an idle host or a settled run — so every later load stays hidden while the profile stays (doc 10).
- The wizard's agents step is the first-run start (Investigate in the background / Skip this step); a run in flight or settled swaps the buttons for a status line plus Back/Continue — progress and the decision stay in the chip (`WelcomeWizard.tsx:752-797`; `ui-settings-models/src/client/index.ts:175-184`).
- **Run setup again** (General section item, order 90) reopens the wizard at step 1 through the settings shell's explicit onboarding request even with a retained conversation; the wizard is a takeover above the settings modal and clears the request when a step completes (`SetupRow.tsx:27-37`; `welcome-wizard.ts:329-342`; `shell-contract.ts:93-102`; `ui-settings-general/src/client/SettingsRoot.tsx:231-245,289-295`).

## Watchtower

Full-canvas session cockpit (`conversation.view` @30): keeper freshness + as-of seq, Living Brief sections, whiteboard, and Live Debug (digest, pending ask, tool/injection/subagent counts, incident tail). Refresh: debug 10s + live facts, whiteboard 10s (`WatchtowerView.tsx:130-134,153-220`); Emergency Halt posts `session.cancel` (`:296-304`). Projection-only — it invents nothing.

## Context surfaces (dsh-context)

- **Context Dashboard** in the sidebar foot above Settings: cross-session KPIs, heatmap, composition ring, session cards.
- **Context tab** per session: stats, composition, per-request trend, events, file activity, agent network.
- **Context panel**: the same dashboard as a right-sidebar tab.
- dsh-context-lens adds **Request Context**: committed request fingerprints, cache/structure drift, recent-request list. Both are external profile deps (`$PROFILE/package.json`).

## Model picker

Composer seat + `/model` popup share one directory. Search filters models and assignable groups; favourites and recents show when not searching (`ModelSelect.tsx:450-478,711`). Rule-hidden models resurface **dimmed with their reason** on an explicit search and stay selectable only through a manual shown pin (`:871-890`; decision map `catalog-visibility.ts`). Gated models (`gated: true`, e.g. `sign-in required`) render dimmed with the reason; the hide precedence is manual hidden > manual shown > gated > hide rules > visible (`$PROFILE/packages/enpoi-catalog-rules/src/rules.ts:11`).

## Skins/themes

- Skin center (external plugin) persists the active skin in `$DSH_HOME/skin-center-active.json`; `summer-liquid-glass` is the shipped default and **frozen at `1.0.1-frozen`** (`$PROFILE/skins/summer-liquid-glass/README.md`).
- **Skin surface hook:** shared rounded surfaces that scroll an inset list mark the box `data-dsh-list-surface` and publish `--dsh-surface-radius`/`--dsh-surface-inset` (`MenuSurface`, `Sheet`, `Modal`, the schedule picker); `ui-theme/src/styles/base.css` derives the nested `[role='listbox']` radius from them. A skin decorates the marked surface, never the inset viewport (the profile's `patches.css` targets `[data-dsh-list-surface]` and excludes roles nested inside one). The keyboard ring is themed through `--dsw-focus-ring-color`/`--dsw-focus-ring-width`; a skin's global ring default belongs in a cascade layer (skin-center scopes patches to `html[data-dsh-skin="…"]`, so only layering guarantees unlayered component resets win), never in an unlayered `:focus-visible` rule.
- Freeze rules: any edit to the skin or its token vocabulary must be deliberate, keep both guards green, bump the version, and re-sync the dotfiles mirror.
- `dsh-skin-guard.mjs` restores the skin only when the state file says `active: null`; a deliberate switch is never overridden (`:20-40`).
- Gates: `dsh-token-contrast.mjs` (overlay/state-pill contrast ≥ 4.5:1 both base modes, repaints present, mirror byte-identical) and `dsh-rebrand.mjs --check` (fork branding + contrast) — commands and expected output in doc 11.

## Notifications and toasts

There is no global toast stack: each surface renders the shared `Toast` primitive (`packages/client/ui-primitives/src/Toast.tsx`, exported at `ui-primitives/src/index.ts:72`). Live notifications come from the surface that owns the failure: session-row notices (`RowActionToast.tsx`), account quota notices (`ui-settings-account/src/client/AccountQuotaNotice.tsx`, held while a quota check is in flight), schedule delete toast, open-in-app failure toast, and the composer prompt-failure notice (`InputBar.tsx`). The connection indicator (connecting/disconnected/recovered, 2s recovery confirmation) lives on the settings trigger row (`SettingsRoot.tsx:40-43,240-296`).
