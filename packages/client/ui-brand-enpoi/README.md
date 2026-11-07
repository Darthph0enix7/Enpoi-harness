---
description: "The Enpoi Harness brand and operator surfaces for the Web client: brand marks, the Watchtower view, right-sidebar operator tabs, settings sections, the MCP mounts chip, In-Chat task cards, and the terminal pages."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-brand-enpoi

English | [中文](README.zh.md)

## Summary

Replace the shipped Web brand and add the Enpoi operator surfaces: brand marks in the sidebar and conversation hero, the Watchtower conversation view, right-sidebar Capabilities, Agent Models, Subagent Sessions, Git and Terminal tabs, Orchestration, Dynamic and Permissions settings, the session-header MCP mounts chip, In-Chat task cards, and the bottom terminal dock. The package also owns the browser terminal registry that keeps PTYs connected while no terminal view is mounted, and loads each heavy tab body as a package-local chunk on first use.

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

Mount the package as a client plugin row beside the upstream conversation, sidebar, tool, and model-directory plugins it declares in `dsh.client.inject`. It has no configuration of its own; the operator data it edits lives in the `enpoi-orchestration` settings namespace and the Host terminal routes.

### When to choose it

Choose it for a deployment that wants the Enpoi brand and operator cockpit instead of the shipped brand occupants. A deployment that only needs the upstream Web surfaces omits this row and keeps the official brand plugin.

### Terminal pages

The right-sidebar Terminal tab and the bottom dock share one browser registry. Opening a terminal spawns it through the Host's fenced `/enpoi-terminal` API and attaches a WebSocket; the registry buffers output, so collapsing the dock, switching tabs, or leaving a terminal page never tears the shell down. Only an explicit close, the Host's disconnect grace, or plugin unload ends it. Worker, another page, or the Host's idle policy may still own the process outside this plugin's browser lifetime.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

`src/client/index.ts` registers every occupant inside one Cordis effect chain: brand marks, the Watchtower `conversation.view`, the keyed `sidebar.right.pane.tab` bodies, the `settings.section` pages, the session-header chip, keyed `tool.call.toolview` cards, and the `shell.overlay` bottom dock. Registrations own their slot identity and order; only the body components are deferred.

The terminal emulator is a package-local dynamic import (`terminal/lazy-terminal-view.tsx`). `src/client/lazy-surface.tsx` renders the `Suspense` fallback and an error boundary whose retry builds a fresh `React.lazy` component, so a transient chunk-fetch failure does not poison the page. The emulator (`TerminalView.tsx`), its xterm.js dependencies, and its stylesheet move into `lib/client.TerminalView.js`. The icons, the terminal tab strip, and the shared stores stay in the eager entry because the tab chrome and registration-time guide capsules use them before any body opens.

The terminal emulator module owns `@xterm/xterm`, `@xterm/addon-fit`, and the xterm stylesheet. The Client bundle preset converts that global CSS import into a style injector tagged for this plugin, and the package-local `client.TerminalView.js` chunk is fetched only when a terminal tab first renders. The registry in `terminal/registry.ts` imports no xterm: it opens the process, connects the socket, and replays the transcript independently of the view.

Package-local dynamic imports compile to `require.async("./client.<name>.js")`; the emitted entry keeps only the shared modules it imports statically. `package.json` publishes `lib/client.*.js` so the chunks travel with the package.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Right Sidebar](../ui-sidebar-right/README.md) — the tab registry these bodies register into.
- [Terminal controller](../../api/terminal-controller/README.md) — Host-side terminal ownership and recovery.
- [Slots](../ui-slots/README.md) — slot declaration, registration order, and composed props.
- [Client bundle preset](../tsdown.client.ts) — dynamic chunk compilation and CSS ownership.

<a id="model-experience"></a>
## Model Experience

### Browser operator surfaces

#### What the model sees

None; this package registers no model-facing input. Operator edits travel to the `enpoi-orchestration` settings document and the browser terminal registry, and never enter a prompt, tool schema, or session event through this package.

#### Token effect

None; no prompt text, tool schema, or result rendering is contributed.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- A body chunk arrives on first open of its tab or settings section, so that first open waits for one network round trip; there is no prefetch or hover warm-up.
- A failed chunk fetch shows the localized retry control; a user who never retries sees the failure until the surface remounts.
- Shared modules imported by the entry still load with it, so only the bodies listed above defer; moving a shared store behind a chunk would change registration-order behavior.
- The terminal emulator is deferred, but terminal processes still require the Host routes and a writable WebSocket; a Host restart ends them.
- The brand package occupies upstream slots at fixed priorities; a second occupant at the same priority fails loudly at load instead of merging.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

No runtime invariant: the package retains no mutable state, and its slot occupants install and leave through one transactional effect. The deferred chunks are covered by `scripts/client-boot-budget.spec.ts`, which walks the client entry's static import graph and rejects an eager xterm or body module, and by `tests/terminal-lazy.client.spec.tsx`, which mounts the pending marker, retry path, and the pre-view registry buffer.

</details>
