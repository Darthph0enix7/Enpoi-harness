---
description: "Enpoi fork host half of the browser terminal surfaces: the fenced PTY JSON API and its one WebSocket upgrade."
kind: "package-reference"
---

# @deepseek-ai/dsh-host-enpoi-terminal

Fork-only host half of the browser terminals the Enpoi operator asked for: the right sidebar's `terminal` page and the collapsible bottom dock (both in [`@deepseek-ai/dsh-client-ui-brand-enpoi`](../../client/ui-brand-enpoi/README.md)) share one PTY registry behind two fenced endpoints.

## Routes

| Route | Wire | Behavior |
|---|---|---|
| `POST /enpoi-terminal/api/open` | `{ key, sessionId, cwd?, cols?, rows? }` | Spawns the login shell under a PTY, or reuses the live process already behind `key`. Validates `cwd` (absolute existing directory; the process cwd otherwise). Enforces the per-session cap. |
| `POST /enpoi-terminal/api/close` | `{ key }` | Kills the process and forgets it. |
| `POST /enpoi-terminal/api/list` | `{ sessionId? }` | Live (and recently exited) keys. |
| `GET /enpoi-terminal/ws?key=…` (upgrade) | server `{t:'data'\|'exit'\|'error'}`; client `{t:'input'\|'resize'\|'kill'}` | Streams output, accepts input/resize/kill, replays the bounded transcript to a reattaching socket. |

Every route passes `connection.requestRejection` first — the same browser trust fence as the rest of the composition.

## Process lifetime

One `node-pty` process per `${sessionId}:${tabId}` key (`@deepseek-ai/dsh-client-ui-brand-enpoi` mints the tab ids). A process survives socket disconnects for the disconnect grace (90 s), so a page reload reattaches to the same shell; the last detach starts the grace, explicit closes kill immediately, and plugin teardown kills everything. Output is retained in a bounded in-memory transcript (512 KiB).

## Composition

The row lives in [`@deepseek-ai/dsh-web-app`](../../bundle/web-app/cordis.patch.yml) as `id: enpoi-terminal`. It requires the `webServer` route carrier and the `connection` trust fence; the shell comes from `$SHELL` (or `/bin/bash`; `COMSPEC`/`powershell.exe` on Windows).

## Known limits

- Sessions are process-local: they do not survive a harness restart.
- The dock and the sidebar page keep separate terminal tabs (one registry, two surfaces); moving a tab between surfaces is deferred.
