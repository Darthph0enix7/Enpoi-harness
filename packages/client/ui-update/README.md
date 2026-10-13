---
description: "The in-app update surface: a shell-overlay availability pill, the changelog and run-progress dialog, the failure surface with retry, and the post-restart reload toast over the host's updateCheck namespace."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-update

English | [中文](README.zh.md)

## Summary

`dsh-client-ui-update` is the browser half of the in-app update flow. A pill in the shell overlay appears when the host reports a newer release; clicking it opens the dialog with the version pair, channel, release notes, and `[Update now] [Later] [Skip this version]`. A running update shows the engine step (`N/9`), last log line, progress bar, and disconnect warning; a failed or rolled-back run shows its reason and log tail with Retry. After the switch restarts the service, the reconnected page reloads and shows a one-time "Updated to X" toast. Nothing installs automatically: `Update now` is the operator's restart decision.

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

Load the plugin through the web-app manifest. It renders nothing while the install is current, the check is unknown, or the newest release was skipped, so an ordinary session never grows an update control. A newer release re-arms the pill after a skip.

### The indicator

The pill lives in the `shell.overlay` list, the frame-wide floating layer that outlives every panel, and reads `{latest version} ↑`. Updating shows a spinner with the same label. The copy is locale-owned (`update` namespace, en + zh); the version and channel are wire data rendered verbatim.

### The dialog

The dialog renders the version pair, the channel, and the release notes as the changelog. `Update now` calls `updateCheck/start` and keeps the dialog open on the progress panel; `Later` closes it (an active run continues); `Skip this version` records the dismissal through `updateCheck/dismiss` and closes. While a run is active the panel polls `updateCheck/run` every ~2 s; a failed or rolled-back record renders its reason, the bounded log tail (last 40 lines), and Retry.

### Polling and the restart

`updateCheck/status` is read on mount, every 60 s while the tab is visible, and on window focus or visibility restore (coalesced into at most one call per second). The run record is polled only while a run is active. `start` pins the pre-run install version in session storage; after the update's switch restarts the service, the reconnected page compares the host's reported version, writes the one-time toast payload, and reloads. A manual reload mid-run keeps that marker, so completion is still detected.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The host plugin (`profile/web/packages/enpoi-update-check`) is a profile plugin, so no generated Remote artifact exists on the client assembly: every call is one `POST /api/updateCheck.<method>` carrying the shared client-request envelope (`{type, method, rpcId, payload:{args}}`), the same pattern `enpoiUiState.*` uses. The controller owns all polling and publishes through one snapshot store bound into the slot entry's `hooks` compartment; the component holds no subscription machinery and no transport state.

| File | Role |
|---|---|
| [`src/client/index.ts`](src/client/index.ts) | dictionaries + the `shell.overlay` registration |
| [`src/client/controller.ts`](src/client/controller.ts) | polling policy, start/dismiss, restart detection, the toast marker |
| [`src/client/rpc.ts`](src/client/rpc.ts) | the `updateCheck.*` envelope caller and the wire contracts |
| [`src/client/UpdateIndicator.tsx`](src/client/UpdateIndicator.tsx) | pill, dialog, progress, failure surface, toast |
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

- **The prepare/apply split is not implemented** — `Update now` starts the engine, which prepares and then switches in one run; a `ready` state with a user-triggered `Restart to update` remains the future refinement recorded in the plan.
- **Progress granularity is the engine's step line** — the bar follows `[N/9]`; byte-level progress needs the engine's state file, which the host watcher does not consume yet.

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
