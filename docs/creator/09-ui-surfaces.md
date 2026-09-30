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

## Conversation

- Header seats: lineage, actions, utilities, corner, leading (`ui-conversation/src/client/contract/slots.ts:133-183`).
- View tabs: upstream Chat + Trajectory; the fork adds **Watchtower** at order 30 (`ui-brand-enpoi/src/client/index.ts:219-230`); dsh-context/dsh-context-lens add Context and Request Context tabs.
- **The Mark** task cards shadow the upstream tool rows for `subagent`, `dispatch_task`, `task`, `oracle_review`, `roundtable`, `chorus` at priority -1 (`index.ts:483-502`; lower priority wins the key).
- Plan cards: submitted plans appear in the turn's final artifact area and open in the right sidebar (`ui-plan/README.md`); the plan-review card answers `exit_plan_mode` (`ui-user-questions/README.md:34-36`). Pending plan reviews are the review queue: the card's View-full-plan link opens the sidebar preview and Approve/Request-changes answers the wait (`ui-plan/src/client/review-store.ts`, `ui-user-questions/README.md:34-40`).

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

## Settings

Trigger and modal: `ui-settings-general/src/client/SettingsRoot.tsx` (Escape, mask click, close button; phone gets a full-screen list→detail flow at `:212-217`). Sections are `settings.section` registrations, ordered:

| Order | Id | Owner |
|---|---|---|
| -10 | account | `ui-settings-account/src/client/index.ts:270` |
| 0 | general | `ui-settings-general/src/client/index.ts:242-245` |
| 10 | models (providers) | `ui-settings-models/src/client/index.ts:213-217` |
| 15 | plugins | `ui-settings-plugins/src/client/index.ts:76-80` |
| 20 | agent-presets | `ui-agent-preset/src/client/index.ts:234-237` |
| 20 | orchestration | `ui-brand-enpoi/src/client/index.ts:257-273` |
| 21 | permissions | `ui-brand-enpoi/src/client/index.ts:285-290` |
| 22 | dynamic | `ui-brand-enpoi/src/client/index.ts:277-282` |

- **Models/add provider** (`ui-settings-models`): provider list + detail, add wizard, discovery, heavy-provider group (docs 03/10).
- **Orchestration** (`OrchestrationSettings.tsx`): groups High Council (`:59-68`), Context Keeper (`:70-79`), Compaction (`:81-89`), Memory (`:91-94`), Oracle (`:96-98`); per-group reset; edits are hot-swapped (intro `:240`). Compaction shows the derived effective policy for the selected summariser route (`:164-191`).
- **Permissions**: policy editor over the enpoi-capabilities engine (doc 04).
- **Capabilities and Agent Models are not settings pages** — they are right sidebar tabs (`index.ts:294-358`); settings cross-links open them through the `settingsUi` service (`settings-nav.ts:16-28`).
- **Dynamic** (`dynamic/DynamicSettings.tsx`): Roles, Councils, MCPs, Skills, Prompts panels, all editing the `enpoi-orchestration` document hot.

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

- Skin center (external plugin) persists the active skin in `$DSH_HOME/skin-center-active.json`; `summer-liquid-glass` is the shipped default and **frozen at `1.0.0-frozen`** (`$PROFILE/skins/summer-liquid-glass/README.md`).
- Freeze rules: any edit to the skin or its token vocabulary must be deliberate, keep both guards green, bump the version, and re-sync the dotfiles mirror.
- `dsh-skin-guard.mjs` restores the skin only when the state file says `active: null`; a deliberate switch is never overridden (`:20-40`).
- Gates: `dsh-token-contrast.mjs` (overlay/state-pill contrast ≥ 4.5:1 both base modes, repaints present, mirror byte-identical) and `dsh-rebrand.mjs --check` (fork branding + contrast) — commands and expected output in doc 11.

## Notifications and toasts

There is no global toast stack: each surface renders the shared `Toast` primitive (`packages/client/ui-primitives/src/Toast.tsx`, exported at `ui-primitives/src/index.ts:72`). Live notifications come from the surface that owns the failure: session-row notices (`RowActionToast.tsx`), account quota notices (`ui-settings-account/src/client/AccountQuotaNotice.tsx`, held while a quota check is in flight), schedule delete toast, open-in-app failure toast, and the composer prompt-failure notice (`InputBar.tsx`). The connection indicator (connecting/disconnected/recovered, 2s recovery confirmation) lives on the settings trigger row (`SettingsRoot.tsx:40-43,240-296`).
