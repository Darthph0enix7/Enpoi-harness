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

The per-session cap refusal renders in the host locale — `DSH_LOCALE`, then `LC_ALL`/`LC_MESSAGES`/`LANG`, falling back to `en` — with the zh/en dictionaries in [`src/locales.ts`](src/locales.ts).

## Process lifetime

One `node-pty` process per `${sessionId}:${tabId}` key (`@deepseek-ai/dsh-client-ui-brand-enpoi` mints the tab ids). A process survives socket disconnects for the disconnect grace (default 90 s), so a page reload reattaches to the same shell; the last detach starts the grace, explicit closes kill immediately, and plugin teardown kills everything. Output is retained in a bounded in-memory transcript (default 512 KiB).

## Configuration

The plugin row takes a validated `Config`; every field defaults to the shipped value, so an omitted config behaves exactly as before. Wire constants stay frozen: `MAX_BODY_BYTES` (request bodies) and the 4404 unknown-key close code are protocol surface, not config.

| Field | Default | Effect |
|---|---|---|
| `maxPerSession` | `8` | Concurrent terminals per conversation; a further `open` is refused with `session-limit`. |
| `disconnectGraceMs` | `90000` | How long a process outlives its last attached socket. |
| `transcriptLimitBytes` | `524288` | Replay transcript bound per terminal; the head is dropped past it. |
| `shell` | `$SHELL` then `/bin/bash` (`COMSPEC`/`powershell.exe` on Windows) | Login shell spawned for every terminal. |

## Composition

The row lives in [`@deepseek-ai/dsh-web-app`](../../bundle/web-app/cordis.patch.yml) as `id: enpoi-terminal`. It requires the `webServer` route carrier and the `connection` trust fence; the shell comes from `$SHELL` (or `/bin/bash`; `COMSPEC`/`powershell.exe` on Windows) unless `config.shell` overrides it.

## Known limits

- Sessions are process-local: they do not survive a harness restart.
- The dock and the sidebar page keep separate terminal tabs (one registry, two surfaces); moving a tab between surfaces is deferred.
