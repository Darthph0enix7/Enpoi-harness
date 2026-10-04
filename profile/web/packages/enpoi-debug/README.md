# dsh-enpoi-debug

The agent-facing **debug/transparency read surface** (doc 69 §9.1, P3): one
read-only tool, `session_debug`, that answers "what is this Session actually
doing?" in a single bounded call.

## What it exposes

| Section | Content |
|---|---|
| `digest` (default) | execution latch + `since`, live descendants (quiet children included), current model, pending asks (approval ids / question items), last turn terminal with its structured error, bounded recent tool calls with argument/result previews, the injection index, the subagent tree |
| `snapshot` | the exact main-model request summary: provider/model, system chars + SHA-256, tool names, message role/size rows; **bodies only behind `includeBodies: true` plus a local `allowed-once` approval card** (heavy, secret-bearing). Any other outcome refuses the bodies and returns the bounded summary only. |
| `incidents` | the diagnostics incident tail, this session's rows first |

Read-only by construction: it calls the same in-process services the wire RPCs
wrap (`ctx.sessionController` / `ctx.remote.session`, plus `ctx.diagnostics`),
never prompts the model, never mutates, and never writes the session log (the
only prompt it can raise is the operator's own `includeBodies` approval card).
Output is hard-capped and previewed (~4k tokens), errors keep the gateway's
code (`session/not-found`, `gateway/bad-request`, …).

## Where it is mounted

Inside the `enpoi-orchestration` agent-plane group of the **`orchestrator`**
and **`sysadmin`** presets only (`~/.dsh/profiles/web/presets/*/agent.cordis.yml`).
The tool lands in those agents' own tools layer; every other preset does not
see it. The package is intentionally **not** in `dsh.profile.bundles` — a
host-plane mount would register the tool globally.

## Build

```sh
pnpm --dir ~/.dsh/profiles/web/packages/enpoi-debug build
```

Or rebuild every profile plugin with `~/.dsh/profiles/web/build-plugins.sh`.

## Tests

```sh
cd ~/.dsh/profiles/web && pnpm vitest run packages/enpoi-debug
```
