---
description: "The in-app update surface: a shell-overlay availability pill, the changelog and run-progress dialog, the failure surface with retry, and the post-restart reload toast over the host's updateCheck namespace."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-update

English | [中文](README.zh.md)

## Summary

`dsh-client-ui-update` is the browser half of the two-phase in-app update flow. A small pill bottom-left in the shell overlay reading **Update** appears when the host reports a newer release; clicking it opens the dialog with the version pair, channel, a scrollable changelog, and `[Update now] [Later] [Skip this version]`. `Update now` prepares the update and the pill turns into a subtle `Restart to update` state that applies the staged tree. Failures show their reason and Retry; a skipped release stays updatable from Settings; after the restart the page returns with a one-time "Updated to X" toast.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Load the plugin through the web-app manifest. It renders nothing while the install is current or the check is unknown, so an ordinary session never grows an update control. A newer release shows the pill; skipping it hides the pill but leaves the General-settings control (below) in place, and a newer catalog version re-arms everything.

### The indicator

The pill lives in the `shell.overlay` list, the frame-wide floating layer that outlives every panel, and reads exactly **Update** (`更新` in zh) — no version, no arrow, no badge. It is deliberately slight: 11px type, a translucent raised fill, a soft shadow, and one restrained accent step (the same update accent the settings surface uses) over the neutral chrome; its accessible name is version-free too, because the dialog carries all release details. Its position derives from the shell insets the frame publishes on the document root (`--dsh-shell-inset-left/-right/-bottom`), so it stays inside the centre column — never over the left rail, the conversation's sidebars, or (on mobile) the action bar — and hides entirely while a fullscreen right panel owns the frame. Preparing/applying shows a quiet spinner label; a prepared update shows the distinct `Restart to update` state. On an engine without `--prepare` the host runs the **one-shot** rung instead (`rung: 'one-shot'`): the run restarts the service mid-flow, so the pill stays in the plain updating state, the switch step shows the disconnect warning, and the prepared/restart affordance never appears. The copy is locale-owned (`update` namespace, en + zh); versions, channels, and log lines are wire data rendered verbatim wherever they appear (dialog, settings row).

### The dialog

Beside the versions header the dialog carries a quiet inline **Check for updates** action (`updateCheck/checkNow` through the shared controller — one polling source): it disables while the single-flight check runs (`Checking…`) and surfaces a failure as a muted inline line, never a popup. The dialog renders the version pair, the channel, and the release notes as a changelog that grows with its content (up to most of the dialog) and scrolls internally, so dozens of long commit subjects stay readable. `Update now` calls `updateCheck/start` (the prepare on a two-phase engine, the one-shot update otherwise) and keeps the dialog open on the progress panel; `Later` closes it (an executing run continues); `Skip this version` records the dismissal through `updateCheck/dismiss` and the pill disappears. While the engine executes, the panel polls `updateCheck/run` every ~2 s and shows the phase label, step `N/9`, the log's last line, and — from the switch step on — the disconnect warning. The prepared state offers `[Restart to update]` (`updateCheck/apply`, two-phase only). A failed or rolled-back record renders its reason, the bounded log tail (last 40 lines), and Retry (which replays `apply` while a two-phase staged marker survived and re-runs `start` otherwise). When the failure kept a valid staged tree — or its reason names an already-running/stale condition — the surface also offers **Clear update state & retry**: the host clears only non-live state (it refuses while anything is genuinely live and never touches the engine marker or the staged tree), and the client re-applies the staged version without re-downloading, falling back to a fresh prepare when nothing is staged. While the run is still pre-switch the progress panel offers `[Cancel]` (`updateCheck/cancel`, which delegates to the engine's own SIGTERM/SIGKILL flow); past the switch — an apply from its launch, a one-shot from step 8 — the affordance disappears, mirroring the engine's refusal, and a refusal that still reaches the host surfaces the engine's message. A cancelled run renders `Update cancelled` with Retry.

A run started **outside the UI** (a plain `dsh update` in a terminal) arrives through the same record (`observed: true`, synthesized by the host from the engine marker), so the executing pill, the progress panel with its cancel affordance, and the failed/cancelled surfaces all render through exactly the same states — no separate path.

### The Settings entry (skipped versions stay updatable)

The General settings page carries one more entry beside the current-version row (`settings.general.item`, order 101): the same controller state rendered as a row. `current` shows a quiet up-to-date line plus the same inline **Check for updates** action; `unknown` (never checked / offline) shows 'Not checked yet' with that action; `available` shows `New version X available` with an **Update** button that opens the shared dialog; `dismissed` shows the same button plus a "you skipped this version" hint — this is what keeps a skipped release reachable after the pill hides, and the host accepts `updateCheck/start` for a dismissed version; `preparing`/`applying` show the progress label with **View progress** opening the dialog; `prepared` shows **Restart to update**, which performs the restart through the same controller action; a failed run shows **Retry**, opening the failure surface. The row shares the pill's controller store and actions — one polling source, no second transport state.

### Polling and the restart

`updateCheck/status` is read on mount, every 60 s while the tab is visible, and on window focus or visibility restore (coalesced into at most one call per second). The run record is read once on mount — so a prepared update reopened in a fresh tab is offered again — and then polled every ~2 s only while the engine process executes (`starting`/`preparing`/`applying`). `start` and `apply` pin the pre-run install version in session storage; after an update's switch restarts the service, the reconnected page compares the host's reported version, writes the one-time toast payload, and reloads. A terminal success (or a reconnect with a pending update) also starts a **bounded identity watch**: the status is re-read every ~2 s for at most 60 s, and the page reloads as soon as the served identity changes — a restarted service that needs a few seconds to answer no longer requires a manual refresh. The watch never extends itself and is disposed with the plugin; a manual reload mid-run keeps the pending marker, so completion is still detected.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The host plugin (`profile/web/packages/enpoi-update-check`) is a profile plugin, so no generated Remote artifact exists on the client assembly: every call is one `POST /api/updateCheck.<method>` carrying the shared client-request envelope (`{type, method, rpcId, payload:{args}}`), the same pattern `enpoiUiState.*` uses. The args carry the descriptor's named parameters, not the request fields: `dismiss` sends `{request: {version}}`, every no-parameter method sends `{}`. The controller owns all polling and publishes through one snapshot store bound into the slot entry's `hooks` compartment; the component holds no subscription machinery and no transport state.

| File | Role |
|---|---|
| [`src/client/index.ts`](src/client/index.ts) | dictionaries + the `shell.overlay` registration |
| [`src/client/controller.ts`](src/client/controller.ts) | polling policy, prepare/apply/retry/dismiss, restart detection, the toast marker |
| [`src/client/rpc.ts`](src/client/rpc.ts) | the `updateCheck.*` envelope caller, the descriptor arg table, and the wire contracts |
| [`src/client/UpdateIndicator.tsx`](src/client/UpdateIndicator.tsx) | pill, dialog, changelog, progress, restart, failure surface, toast |
| [`src/client/locales.ts`](src/client/locales.ts) | the `update` namespace copy (zh source of truth) |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [`dsh-enpoi-update-check`](../../../profile/web/packages/enpoi-update-check/README.md) — the host half: the catalog check, the run launcher/watcher, `run.json`, and the `updateCheck` Remote methods.
- [`ui-layout`](../ui-layout/README.md) — the frame whose `shell.overlay` seat hosts the pill.
- [`ui-message-feedback`](../ui-message-feedback/README.md) — the sibling dialog/toast composition over a non-generated namespace.

-----

<a id="model-experience"></a>
## Model Experience

None, as this package renders host-reported update state for a human and touches no prompt, message, schema, stream, or tool result.

#### KV Cache effect

None; the package never assembles or sends provider requests.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define current package constraints, not a task backlog.

- **Progress granularity is the engine's step line** — the bar follows `[N/9]`; byte-level progress needs an engine state file, which the host watcher does not consume yet.
- **A prepared update is offered again in any tab of this browser profile** — the prepared state lives in the host's `run.json`, so a reopened tab discovers it through the mount read; the restart itself always dispatches from the tab that clicks it.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

```sh
pnpm --filter @deepseek-ai/dsh-client-ui-update bundle
npx vitest run packages/client/ui-update
```

</details>

**Runtime invariant:** No companion is published. This package is a read-only projection plus four operator actions onto the host's `updateCheck` namespace; it emits no Cordis events, owns no cross-plugin mutable state, and its single slot registration proves disposal through the browser-half spec.
