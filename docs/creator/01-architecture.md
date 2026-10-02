# 01 — Architecture: process, durability, plugins, profiles, disk

Read this file to answer "how does a dsh machine fit together"; read `02-install-and-update.md` for install, update, channels, overlay, restart, rollback. Every behavioural claim cites a source file; run the checks in the commands given, never guess. `$DSH_HOME` resolves as explicit path > `$DSH_HOME` > `~/.dsh` (`packages/util/home-paths/src/index.ts:84-91`), and every path below is relative to it.

## 1. Process model — the service hosts sessions, the browser is a client

- `dsh <profile>` boots exactly one long-lived Node process per profile: an empty root config patched by ordered layers into a Cordis plugin tree (`docs/architecture.md:17-27`).
- The web surface runs `@deepseek-ai/dsh-host-webserver`, a plain `node:http` server. The shipped web bundle defaults `host: 127.0.0.1` and `port: 3080` (the bare webserver package example shows 3000) (`packages/bundle/web-app/cordis.patch.yml:191`; `packages/host/webserver/README.md:12,33-39`); `0.0.0.0` is deliberate exposure and carries no TLS, authentication, or origin policy of its own.
- Sessions live in that process (`ctx.sessions`, `docs/architecture.md:63`). The browser follows durable events over the session-controller RPC and streams; its echoes, drafts, and live frames are client memory only, and a reload rebuilds the conversation from the durable log (`packages/api/session-controller/README.md`, "Use this package").
- Only a tree that provides the `webServer` service installs the restart-after-turn watcher; headless, sdk, sdk-minimal, and acp surfaces never act on a restart marker (`apps/cli/src/profile-boot.ts:320-327`).
- Signals: SIGTERM exits 0, SIGINT exits 130 (`apps/cli/src/profile-boot.ts:278-282`). Uncaught failures are fail-loud, never silently swallowed (`packages/boot/app-boot/src/index.ts:644`).
- Failure mode: killing the process kills live turns and any unmaterialized tail; committed log data survives (§2). Never restart the service from inside a turn — use `dsh restart` (file 02 §5).

## 2. Durability — append-only session logs, format v4, projections

- A session is an append-only `SessionEvent` log plus an in-memory store; the log is the source of model history (`docs/architecture.md:63,121`).
- The writer constant is `SESSION_FORMAT_VERSION = 4` (`packages/core/session/src/types.ts:90`); v4 is finalized with an accepted compatibility baseline, and v3 is the latest *released* format (`docs/session-format-status.md:31-33,44-49`). Only structural changes bump it; ordinary new event types are covered by the per-event `ignorable` guard.
- Storage (`@deepseek-ai/dsh-session-persistence-jsonl`): one directory per session under `<root>/--<normalized-cwd>--/<encoded-id>/`, files `session.vN.jsonl[.zstd]`; zstd frames by default, `compression: 'none'` for raw newline-delimited JSONL (`packages/session/session-persistence-jsonl/README.md:45-70`). Root comes from the base bundle: `dshHomePath('sessions')` (`packages/bundle/base/cordis.patch.yml:133`).
- Append semantics: a session materializes lazily on its first append, which writes and `fsync`s the header plus first batch; every later batch appends and `fsync`s before resolving; a caught write/fsync failure rolls the file back to its prior length (`README.md:76`).
- Immutability: committed generations are never renamed, replaced, or deleted; migration is adjacent-only (N→N+1), a read open never publishes a successor, a write open publishes one beside the unchanged source (`README.md:82-84`; `docs/session-format-status.md:35`).
- Crash recovery: an interrupted final turn stays; the resuming reader appends synthetic closers through its write handle. An incomplete final raw line is discarded; a torn zstd frame contributes its complete decoded records only. Corruption inside a complete committed frame rejects (`README.md:76`). An open `tool/call` whose approval was asked but never decided is closed with `TOOL_APPROVAL_NOT_DECIDED` and the definite "not executed" text, instead of the older unknown-outcome result (`packages/core/session/src/repair.ts:28,190-220`).
- One live writer per session: in-process claim plus a kernel lock (`flock(2)` on `session.lock`; a named semaphore on Windows). A crashed holder's lock dies with its process (`README.md:164`).
- Projections: `dsh-session-projection` folds committed events into typed state; host readers call `stateOf()`, carriers batch cropped client views with `snapshot()` (`docs/architecture.md:127`). The persisted projection cache is a write-behind derivative under the storage root; every durable write is fail-soft and self-heals (`packages/session/session-projection-cache/src/index.ts:2-10,96-102`). Session search uses a separate SQLite index at `cache/session-query/index.sqlite` (`packages/bundle/web-app/cordis.patch.yml:27-30`).
- Query indexes and scale: a Session's command index folds the durable log once and answers iteration/revert listings from the fold instead of rescanning (`packages/api/session-controller/src/session-command-index.ts:21-71`); the per-call cost of `revertIterations` does not scale with log length (benchmark at 10⁶ events: 60.4 ms first call, 0.204 ms mean — `packages/api/session-controller/bench/revert-iterations.bench.ts`).
- Log safety: no rotation or GC ships. The retention-pin manifest computes the never-delete set — iteration markers and every seq they name, `revert/branch` spans and their records, live surface nodes and their `sourceEventSeqs`, `image/offload` targets, compaction shadowed seqs and checkpoint citations, `revert/state` boundaries — and `assertRemovalSafe` / `retentionGuardOf` refuses any cleanup plan that touches a pinned seq (`packages/api/session-controller/src/retention-pins.ts:164,263,278-302`). `verifyLog` / `repairLog` walk a log's invariants and rebuild derivable state without rewriting durable events (`packages/api/session-controller/src/session-verify.ts:447,554`; remotes `src/index.ts:530-543`).
- Failure modes: a future-format log is refused, not rewritten (`docs/architecture.md:123`); a corrupt session never blocks the rest of the list. Projections are derivable — when a cache stateVersion is rejected, rebuild it (backfill); never hand-edit log files.

## 3. Plugin/fiber model (Cordis)

- Everything is a plugin, including the model adapter, tool registry, session log, and agent loop; plugins contribute services, typed events, and reversible effects to one shared context. There is no privileged core to patch (`docs/architecture.md:9-13`).
- A loader **entry** mounts one plugin; its **fiber** is the lifecycle instance. Inactive entries are not fatal by default: startup warns once per entry, naming its id, package, and error (or the missing services for a fiber still `PENDING`), and leaves healthy siblings running (`packages/boot/app-boot/src/index.ts:850-855,870-883,909-914`).
- Required entries — the bootstrap Include plus the global required list — throw `StartupError` with every inactive plugin listed; the CLI prints it and exits 1 (`packages/boot/app-boot/src/index.ts:925-939`; `apps/cli/src/bin.ts:34-37`).
- Read the tree the machine actually boots with `dsh --profile <name> --dump-config` (no mount) or `--dump-default-config` (bundle layers only, no user patch); both compose exactly what the include mounts (`apps/cli/src/args.ts:178-181`; `packages/boot/app-boot/src/profile.ts:841-848`).
- Reloads: base enables config-only HMR; a patch edit is picked up without a process restart; headless/sdk/acp disable it (`docs/architecture.md:29`). The config editor writes the profile patch atomically, reconciles the tree, and on reconcile failure restores the previous file (`packages/boot/config-editor/src/index.ts:254-268`).
- Failure mode: a plugin that fails stays inactive with its error in the startup diagnostic; find it there, fix or disable its row by id, or dump the composed config to see the effective row.

## 4. Profiles and the config layers

- A profile is `$DSH_HOME/profiles/<name>/`: `package.json` (`dsh.profile.bundles` order plus out-of-tree dependencies), `cordis.patch.yml` (the user's own layer), `pnpm-workspace.yaml`, `node_modules`, and `cordis.yml` — an empty root that is rewritten on every boot and must never be edited (`packages/boot/app-boot/src/profile.ts:5-13,244-263`; `apps/cli/src/profile-boot.ts:153-174`).
- Shipped templates: `web` (base + web app), `headless`, `sdk`, `sdk-minimal`, `acp`; a missing named profile is initialized from its template once and existing files are never touched (`packages/boot/app-boot/src/profile.ts:180-196,237-263`). A custom name requires `--from-default-profile <template>` (`apps/cli/src/args.ts:177`).
- A **bundle** is an npm package whose manifest declares `dsh.bundle.patch` (one file or an ordered list); bundle names resolve installation-first, then from the profile directory (`packages/boot/app-boot/src/profile.ts:618-641`).
- Layer order, low → high (last wins): each bundle's patches in `dsh.profile.bundles` order → the profile's `cordis.patch.yml` → `$DSH_HOME/cordis.patch.yml` → `--patch <file>` overlays in argv order → the telemetry hard-disable patch when `DSH_TELEMETRY_DISABLED` is non-empty (`packages/boot/app-boot/src/profile-context.ts:63-74`; `docs/architecture.md:27`). Within a layer, edits are sparse per-entry merges.

| File | Owner | Update may overwrite? |
|---|---|---|
| bundle patch files (inside installed packages) | installation | yes — shipped with the package |
| `profiles/<name>/package.json` | user | no |
| `profiles/<name>/cordis.patch.yml` | user | no |
| `$DSH_HOME/cordis.patch.yml` | user | no |
| `profiles/<name>/cordis.yml` | launcher | rewritten every boot — never edit |
| `--patch` files | caller/transient | n/a |

- The installer's profile refresh skips `settings.yaml`, `device-patches/`, `node_modules/`, `.backup-*/`, `presets/`, `skills/`, `fish/`, `systemd/`, and (on refresh) `cordis.patch.yml`; `seed_file_once` never replaces an existing file (`scripts/install.sh:616-660`). The repo tree itself is pull-only and disposable; rollback is a symlink move (`scripts/install.sh:32-33`).
- Editor writes: `configEditor.edit()` persists a candidate only when it differs from the live config, refuses when a home patch or CLI overlay would override the effective value, and writes mode `0600` (`packages/boot/config-editor/src/index.ts:206-212,239-261`). Settings forms expose `.volatile()` config only and are revision-fenced — a stale write raises `SettingsConflictError` (`packages/settings/settings/README.md:12,33-39`; `packages/settings/settings/src/index.ts:71-85`).
- Legacy `$DSH_HOME/settings.yaml` (pre-0.1.7 store) is imported once after the Loader settles, then renamed `settings.yaml.imported` before the first write; rejected sections survive only there (`packages/settings/settings/README.md:35`; `packages/settings/settings/src/index.ts:279-285`).

## 5. Where everything lives on disk

| Path under `$DSH_HOME` | Contents / owner |
|---|---|
| `profiles/<name>/` | profile manifest, patch layer, deps, `node_modules` (§4) |
| `sessions/` | append-only JSONL session logs (`packages/bundle/base/cordis.patch.yml:133`) |
| `storages/` | JSON storage domains, incl. the persisted projection cache (`packages/bundle/base/cordis.patch.yml:171`) |
| `cache/session-query/index.sqlite` | derived session-search index (`packages/bundle/web-app/cordis.patch.yml:27-30`) |
| `state/restart-after-turn.json` | safe-restart marker (file 02 §5) |
| `.credentials.yaml` | credential refs/records, mode 0600 (`packages/credentials/credentials-local/src/index.ts:61,90`) |
| `settings.yaml` / `settings.yaml.imported` | legacy settings and its one-shot import target (§4) |
| `pairings.yaml`, `peer-state.json` | peer seam documents (§7) |
| `heavy-server-overlay.json` | operator-owned heavy-provider overlay (file 02 §4) |
| `skills/`, `.agent-presets/` | seeded once by the installer; user-owned after (`scripts/install.sh:662-671`) |
| `diagnostics/update.jsonl` | updater ledger (`scripts/install.sh:883-890`) |

## 6. Provider / session / client planes

- **Provider plane** — model adapters register on `ctx.llm` behind one message/stream vocabulary (`docs/architecture.md:69`); credentials resolve from the launch environment or `.credentials.yaml` (`packages/credentials/credentials-local/src/index.ts:2-7`); routes, pools, and model groups are settings rows, not code.
- **Session plane** — `ctx.sessions` log, the persistence backend, projections, and `ctx.sessionController` (list/search/history/follow/control) (`packages/api/session-controller/README.md`).
- **Client plane** — the webserver plus the browser plugin packages. Web is pure presentation: anything model-visible must be logged first; renderers derive from raw events and persisted metadata (`docs/architecture.md:125`; `packages/client/AGENTS.md`, "Layering red lines").
- Cross-plane rule to diagnose by: if the model can see it, it is in the session log; if only the UI shows it, it is process-local and disappears on reload.

## 7. Peer / interconnect seam

- `@deepseek-ai/dsh-api-peer` exposes `ctx.peerService`, a `peer` namespace with `handshake`, `state`, `create`, `prompt`, `cancel`, `answer`, `page`, `follow`; the other device drives and observes paired Sessions (`docs/subsystems/peer.md:5-11`).
- Pairing is the addressing boundary: only Sessions named in the host's pairing table are audible; exposure filtering, participant validation, the hop ceiling, and the orphan watchdog are applied host-side (`docs/subsystems/peer.md:5,106-115`).
- Documents: `pairings.yaml` (human-edited, 0600, reloaded on mtime/size change) and `peer-state.json` (machine-written bindings, atomic replace, written only by `peer.create`) (`docs/subsystems/peer.md:31-33,104`).
- Knobs (`docs/subsystems/peer.md:15-26`): `pairingsPath` (default `$DSH_HOME/pairings.yaml`), `bindingsPath` (default `$DSH_HOME/peer-state.json`), `watchdogMs` (default 900000 = 15 min), `harnessVersion`, `schemaDigest`. Protocol constant `PEER_PROTOCOL_VERSION = 1`.
- Exposure: `answer-only` (dialogue, asks, terminals) or `debug` (adds tool/step/subagent internals and opt-in assistant-stream frames); required, no implicit default (`docs/subsystems/peer.md:55-61,99-102`).
- Failure modes: a malformed *first* pairing load throws `PeerConfigError` (loud); a later failed reload keeps the previous valid snapshot; a vanished pairing file withdraws exposure entirely (`docs/subsystems/peer.md:33`). Removing an alias while peers still call it yields resolution failures, not silent fallback.

## Deeper sources

- [`../architecture.md`](../architecture.md) — the ordered composition map; [`../subsystems/persistence.md`](../subsystems/persistence.md) — persistence semantics.
- [`../subsystems/session-projection.md`](../subsystems/session-projection.md), [`../subsystems/settings.md`](../subsystems/settings.md), [`../subsystems/web-server.md`](../subsystems/web-server.md), [`../subsystems/peer.md`](../subsystems/peer.md).
- [`../cordis-primer.md`](../cordis-primer.md) — Cordis service/effect/fiber semantics; [`../session-format-status.md`](../session-format-status.md) — version and release authority.
- [`../../packages/boot/app-boot/README.md`](../../packages/boot/app-boot/README.md), [`../../packages/boot/config-editor/README.md`](../../packages/boot/config-editor/README.md), [`../../packages/session/session-persistence-jsonl/README.md`](../../packages/session/session-persistence-jsonl/README.md) — package-level contracts.
