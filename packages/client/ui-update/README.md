---
description: "The in-app update surface: a shell-overlay availability pill, the changelog and run-progress dialog, the failure surface with retry, and the post-restart reload toast over the host's updateCheck namespace."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-update

English | [中文](README.zh.md)

## Summary

`dsh-client-ui-update` is the browser half of the two-phase in-app update flow. A small pill bottom-left in the shell overlay appears when the host reports a newer release; clicking it opens the dialog with the version pair, channel, a scrollable changelog, and `[Update now] [Later] [Skip this version]`. `Update now` prepares the update and the pill turns into a subtle `Restart to update` state that applies the staged tree. A failed or rolled-back run shows its reason, log tail, and Retry. After the restart, the page reloads with a one-time "Updated to X" toast.

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

The pill lives in the `shell.overlay` list, the frame-wide floating layer that outlives every panel, and reads `{latest version} ↑`. It is deliberately slight: 11px type, a translucent raised fill, a hairline border. Its position derives from the shell insets the frame publishes on the document root (`--dsh-shell-inset-left/-right/-bottom`), so it stays inside the centre column — never over the left rail, the conversation's sidebars, or (on mobile) the action bar — and hides entirely while a fullscreen right panel owns the frame. Preparing/applying shows a spinner with the same label; a prepared update shows the distinct `Restart to update` state. On an engine without `--prepare` the host runs the **one-shot** rung instead (`rung: 'one-shot'`): the run restarts the service mid-flow, so the pill stays in the plain updating state, the switch step shows the disconnect warning, and the prepared/restart affordance never appears. The copy is locale-owned (`update` namespace, en + zh); versions, channels, and log lines are wire data rendered verbatim.

### The dialog

The dialog renders the version pair, the channel, and the release notes as a changelog that grows with its content (up to most of the dialog) and scrolls internally, so dozens of long commit subjects stay readable. `Update now` calls `updateCheck/start` (the prepare on a two-phase engine, the one-shot update otherwise) and keeps the dialog open on the progress panel; `Later` closes it (an executing run continues); `Skip this version` records the dismissal through `updateCheck/dismiss` and the pill disappears. While the engine executes, the panel polls `updateCheck/run` every ~2 s and shows the phase label, step `N/9`, the log's last line, and — from the switch step on — the disconnect warning. The prepared state offers `[Restart to update]` (`updateCheck/apply`, two-phase only). A failed or rolled-back record renders its reason, the bounded log tail (last 40 lines), and Retry (which replays `apply` while a two-phase staged marker survived and re-runs `start` otherwise).

### Polling and the restart

`updateCheck/status` is read on mount, every 60 s while the tab is visible, and on window focus or visibility restore (coalesced into at most one call per second). The run record is read once on mount — so a prepared update reopened in a fresh tab is offered again — and then polled every ~2 s only while the engine process executes (`starting`/`preparing`/`applying`). `start` and `apply` pin the pre-run install version in session storage; after the apply's switch restarts the service, the reconnected page compares the host's reported version, writes the one-time toast payload, and reloads. A manual reload mid-run keeps that marker, so completion is still detected.

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
