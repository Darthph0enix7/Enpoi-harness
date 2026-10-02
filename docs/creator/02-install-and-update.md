# 02 — Install, update, channels, overlay, safe restart, rollback

Read this file to install a machine, move it between channels, update it, or restart the service without killing a live turn. `$DSH_HOME` defaults to `~/.dsh` (`packages/util/home-paths/src/index.ts:84-91`); `<prefix>` is the install root (`--prefix`, default `$HOME/.dsh`). Every command below is verifiable from `scripts/install.sh`, `scripts/update.sh`, and `apps/cli/src/*` — cite them when explaining.

## 1. The installer (`scripts/install.sh`)

- Entry: `curl -fsSL <install.sh-url> | bash`, `./scripts/install.sh [options]`, or `install.sh --update` (`scripts/install.sh:5-7,105-150`).
- Supported platforms: Linux and macOS only, `x64`/`arm64`; anything else dies with "Linux and macOS only" (`scripts/install.sh:258-269`). This tree ships no PowerShell installer.
- **No sudo, ever.** A failing `sudo` stub is prepended to `PATH`, every call is appended to `<prefix>/.sudo-calls`, and the stub exits 42; exit code 42 from the installer means something tried to escalate (`scripts/install.sh:148,271-281`).
- Node: uses an existing `node >= 22.19` from `PATH`, else `<prefix>/runtime/node/current`, else downloads the official tarball into `<prefix>/runtime/node/<version>` and verifies its SHA-256 when published (`DSH_NODE_MIRROR` default `https://nodejs.org/dist`) (`scripts/install.sh:210-330`).
- pnpm: `corepack enable --install-directory <prefix>/bin` — no system packages (`scripts/install.sh:332-352`).
- Source: `--source` names a local directory, local tarball, or archive URL; otherwise the GitHub archive of the channel ref is fetched (`<repo>/archive/refs/heads/<ref>.tar.gz`) (`scripts/install.sh:442-461`). Version is read from the source `package.json`.
- Build: `pnpm install --frozen-lockfile` then `pnpm run build` inside `<prefix>/harness/<tree>` (`<version>`, or `<version>-<short-sha>` after a rolling rebuild); the build commit is resolved from the target ref (`git ls-remote`, then the GitHub API), a local checkout's HEAD, or a version digest, and stamped into `.dsh-install-complete` (`scripts/install.sh:517-560,613-670`). A completed tree is reused unless `--force`, and the recorded commit decides a rolling no-op (`scripts/install.sh:1564-1690`).
- Seed `$DSH_HOME`: `dsh --profile <name> --dump-default-config` runs `initProfile` and never touches existing files (`scripts/install.sh:528-535`). When a companion profile source is set, it is fetched into `$DSH_HOME/profiles/<name>` — at the selected channel's ref for the canonical Enpoi repo, where an explicit `--profile-ref` wins — its dependencies installed, and `build-plugins.sh` run when present (`scripts/install.sh:731-800,961-1055`).
- Seed-once home files: `fresh-settings.yaml` → `$DSH_HOME/settings.yaml`, profile `presets/` → `.agent-presets`, `skills/` → `skills/`, and `fish/ds.fish` + completions when `~/.config/fish` exists (`scripts/install.sh:643-671`).
- Shim and state: `<bin-dir>/dsh` (default `~/.local/bin`) resolves prefix node → embedded node → `PATH`, and forwards `dsh update` to `scripts/update.sh`; `<prefix>/harness/install-state.json` records version, channel, ref, source, profile, profile source/ref, bin dir, `DSH_HOME`, node/pnpm paths, and service unit (`scripts/install.sh:721-789`).
- Self-check before success: `--version`, `--help`, a `--dump-default-config` smoke run, and an error audit of `$DSH_HOME/sessions` when that corpus exists (exit 2 = skip); any hard failure exits 1 (`scripts/install.sh:938-967`).

| Knob | Default | Meaning |
|---|---|---|
| `--prefix DIR` | `$HOME/.dsh` | versioned trees under `harness/`, runtime, state |
| `--bin-dir DIR` | `$HOME/.local/bin` | where the `dsh` shim is written |
| `--channel NAME` | `stable` | `stable` or `beta` only (`scripts/install.sh:1227`) |
| `--ref REF` | the channel name | overrides the fetched git ref — use a tag/commit to pin |
| `--source SRC` | GitHub archive | local dir, tarball, or URL |
| `--profile NAME` | `web` | profile to seed |
| `--profile-source SRC` | distributor default for `web` | dir/tarball/git URL; empty disables (`DSH_PROFILE_SOURCE`) |
| `--profile-ref REF` | channel ref (`stable`/`beta`) for the canonical Enpoi profile repo, `HEAD` otherwise | ref for a git profile source; an explicit value always wins and an unset ref follows a channel switch (`scripts/install.sh:961-971`) |
| `--service-unit U` | auto-detected | unit/label restarted on update; detection scans systemd user units and launchd plists for the prefix (`scripts/install.sh:804-818`) |
| `--merge-baseline F` | unset | run the 3-layer settings merge during update (`scripts/install.sh:896-927`) |
| `--update` | off | mechanical update mode (same engine) |
| `--dry-run` | off | print the plan, write nothing |
| `--force` / `--force-downgrade` | off | reinstall same version / allow version decrease |
| `--write-rc` | off | append the bin dir to `~/.profile` and fish config |
| `--json` | off | one machine-readable status object on stdout |

Env: `DSH_GITHUB_REPO`/`DSH_GITHUB_URL` (repo slug/URL), `DSH_NODE_VERSION` (22.22.2), `DSH_INSTALL_TIMEOUT` (1800 s), `DSH_BUILD_TIMEOUT` (3600 s), `DSH_PROFILE_INSTALL_TIMEOUT` (900 s), `DSH_PROFILE_BUILD_TIMEOUT` (1200 s), `DSH_PROFILE_TOKEN` (falls back to `GH_TOKEN`/`GITHUB_TOKEN`/`gh auth token`) (`scripts/install.sh:43-62,137-147`).

- Failure modes: download/build failure leaves no `$DSH_HOME` changes and removes the incomplete tree (`scripts/install.sh:495-519`); a failed companion-profile fetch warns and continues with the shipped template — unless the source was given explicitly (`PROFILE_SOURCE_REQUIRED`) (`scripts/install.sh:688-693`); a relative `--prefix` or unknown channel dies up front (`scripts/install.sh:1227-1228`).

## 2. Channels

- `stable` and `beta` are git refs (branches by default) named by the channel; `--channel` only selects the default ref, and `--ref` overrides it to a tag or commit (`scripts/install.sh:118,444-445,1227`). Channel and ref are recorded in `install-state.json` and reused by every later update unless overridden (`scripts/install.sh:763-789,1113-1115`).
- Installing switches channels by re-pointing `current`; a semver downgrade is refused with "refusing to downgrade ... without --force-downgrade" (`scripts/install.sh:1173-1175`). Channel switching in either direction is a supported operation.
- Promotion is repository-side and deliberate: this tree contains no promotion command; its publish workflow runs only on manual dispatch (`.github/workflows/release-publish.yml:8-9`), so a green CI run moves nothing. Devices pick a promoted ref up with `dsh update`.
- Failure mode: after moving beta → stable, a session written by the newer format is refused by the older build, never rewritten (`../architecture.md:123`); committed generations are immutable and migrations are adjacent-only (`packages/session/session-persistence-jsonl/README.md:82-84`).

## 3. Device overlay — `$DSH_HOME/heavy-server-overlay.json`

- Operator-owned JSON, never shipped, never synced; absent or malformed reads as "no override" (fail-soft, per read) (`$DSH_HOME/profiles/<name>/packages/enpoi-heavy-providers/src/planner.ts:299-315`).
- Shape: `{ "providers": { "<manifest-id>": { "reuseBaseURL"?: string, "reuseHealthURL"?: string, "dashboardUrl"?: string } } }` (`planner.ts:292-297,321-332`).
- Use it when a provider instance lives on another host/port or behind a tunnel: `reuseBaseURL`/`reuseHealthURL` retarget the "detected instance" path and `dashboardUrl` the card's link. Everything else stays as shipped.
- The client table is a pre-connection fallback only; the host's manifest reply is authoritative and replaces it wholesale, so no operator URL belongs in code (`packages/client/ui-settings-models/src/client/heavy-providers.ts:1-13`).
- Failure mode: a JSON typo makes the overlay silently ignored — the symptom is a provider card still pointing at the shipped loopback URL. Fix: validate with `jq . $DSH_HOME/heavy-server-overlay.json` and confirm `providers` is an object.

## 4. Updating

**Mechanical engine — `dsh update`** (`scripts/update.sh:6-7`; shim branch `scripts/install.sh:735-738`). Pipeline: load recorded state → (dry-run prints and exits) → fetch/install/build the target version → profile refresh + deps + plugin build → migrations (seed, `scripts/migrations/*.mjs`, never fail closed) → switch `current` symlink → restart the recorded service unit → projection backfill → self-check → on success rewrite state and prune old trees (keeps current + previous, skips `*.failed-*`) (`scripts/install.sh:1108-1211,1094-1106`).
- Same-version update: the target ref's commit SHA (`git ls-remote`, then the GitHub API; a local `--source` checkout answers from its HEAD) is compared with the commit the active tree recorded in `.dsh-install-complete` (falling back to `.dsh-build/client-build-environment.json`). A matching commit refreshes the seed, profile files/deps, and plugin build only and prints "already up to date"; a moved rolling branch rebuilds into `<version>-<short-sha>` so the previous build stays rollback-able, and an unresolvable target (no git, no network) keeps the version-only behavior (`scripts/install.sh:1564-1690`).
- `--merge-baseline <file>` runs the profile's 3-layer merge engine: global baseline + device patch (`device-patches/<host>.yaml`) + local overrides (`$DSH_HOME/sync-local.yaml`), writes a dry-run diff into the backup dir, and applies only on success; an unmergeable change keeps the user's file (`scripts/install.sh:896-927`). Device-specific sections (`enpoi-orchestration.mcpServers`/`capabilities`) live only in the device patch; `mcpStatus` is runtime state, preserved on pull and stripped on sync (`$DSH_HOME/profiles/<name>/scripts/dsh-sync-merge.mjs:1-23,33-37`).
- Projection backfill: when `scripts/dsh-projections-backfill.mjs` exists it runs `status`, then `run` once a service unit is recorded (`scripts/install.sh:833-857`). Idempotent; required after a session-format or projection stateVersion change.
- **`ds update` (seeded shell function):** when the companion profile ships `fish/ds.fish`, the installer seeds it (`scripts/install.sh:940-955`). Its update path pulls the tracked checkout, builds `build:lib` + `build:web`, restarts safely (`--after-turn` inside a session, `--now` outside), then runs the projection backfill. It never falls back to a direct service restart when the build lacks the `restart` command — it tells the operator to rebuild.
- **Fish-only helper:** `ds` is a fish function (`$PROFILE/fish/ds.fish`); the installer seeds it only when `~/.config/fish` exists. Bash/zsh users run `dsh update`, `dsh repair`, and `dsh restart --after-turn` directly — the `dsh` shim is shell-agnostic.
- Failure modes: install/build failure → previous tree stays active and exit 1; migration failure → same, before the symlink switch; post-switch failure → rollback (§6). A stale build can parse `dsh restart` as a profile name, so verify `dsh restart --help` contains `after-turn` before scripting it.

## 5. Safe restart — `dsh restart`

Never run `systemctl --user restart <unit>` (or any direct service restart) from inside a turn: it kills the process hosting the turn, the tool result never returns, and the caller is stuck (`apps/cli/src/restart-after-turn.ts:1-23`). Use one of:

- `dsh restart --after-turn` — writes the marker `$DSH_HOME/state/restart-after-turn.json` naming session, profile, and unit (`restart-after-turn.ts:49,428-438`). The web surface owns the watcher (`apps/cli/src/profile-boot.ts:320-327`); it sweeps on every `turn/end` plus a 2 s interval (`restart-after-turn.ts:618-622`).
- Default scope is whole-service idle: fire only when every live session is idle, bounded by `--max-wait` (default 600 s). Past the bound it falls back to the marked session alone and logs once, naming the running sessions it will stop waiting for ("wait-all bound elapsed — ... sessions with running turns that will be aborted: ...") (`restart-after-turn.ts:42-46,516-551`).
- `--session <id>` selects per-session scope immediately; default is `$DSH_SESSION_ID`, and `--after-turn` errors without one (`restart-after-turn.ts:350-356`). `--wait-all` forces the whole-service scope back.
- Marker lifecycle: consumed atomically before firing, so a crash during restart cannot re-fire it; malformed markers are ignored; a stale per-session marker is dropped; a marker left by a crash fires once on the next boot (`restart-after-turn.ts:109-158,524-529,553-557,631-632`). Markers name their profile; another profile's watcher ignores them (`restart-after-turn.ts:520`).
- `dsh restart --now` — restarts detached, so the caller survives: Linux `systemd-run --user --collect --quiet -- systemctl --user restart <unit>` (detached `systemctl` fallback), macOS `launchctl kickstart -k gui/<uid>/<label>`, Windows `powershell.exe ... Restart-Service -Name <unit> -Force` (`restart-after-turn.ts:177-200,227-244`). Use only when the caller is not the session host.
- `dsh restart --cancel` — clears a pending marker (`restart-after-turn.ts:409-416`). `--json` emits one object for scripts.
- Defaults and env: unit `$DSH_RESTART_UNIT` or `dsh-web.service`; profile `$DSH_PROFILE` or `web`; max wait 600 s via `--max-wait <sec>` (`restart-after-turn.ts:34-46,282-289,309-311`).
- Failure modes: no detached mechanism exists for other platforms (throws, `restart-after-turn.ts:198`); a spawn error is reported and never thrown into the turn (`restart-after-turn.ts:219-249`); a fire failure logs "could not restart" after the marker is consumed — investigate the journal, then rerun.

## 6. Rollback

- Before touching anything, update copies user files to `<prefix>/harness/.backup-<ts>/root/<absolute-path>`: `$DSH_HOME/settings.yaml`, `$DSH_HOME/cordis.patch.yml`, the profile's `cordis.patch.yml`, its `package.json`, and `$DSH_HOME/sync-local.yaml` (`scripts/install.sh:859-868,1178-1181`).
- On failure after the switch: repoint `harness/current` to the previous version, restore those files, archive the failed tree as `<version>.failed-<timestamp>`, self-check the previous tree, append a `rolled-back` row to `$DSH_HOME/diagnostics/update.jsonl`, and exit 1 (`scripts/install.sh:1070-1092`).
- Manual rollback: `ln -sfn <prefix>/harness/<previous-version> <prefix>/harness/current`, restore files from `.backup-<ts>/root/`, then restart the unit with `dsh restart --now` (`scripts/install.sh:870-881`).
- Old versions are pruned on each successful update but the current and previous trees are kept, and `.failed-*` trees are never pruned (`scripts/install.sh:1094-1106`).
- Failure mode: the previous tree also failing its self-check is reported ("inspect ...") — then treat it as a host problem (Node, disk, permissions), not an update problem.

## Deeper sources

- `../subsystems/web-server.md`, `../subsystems/persistence.md` — server and storage semantics; `../session-format-status.md` — why downgrades never rewrite data.
- [`../../.github/workflows/release-publish.yml`](../../.github/workflows/release-publish.yml) — publication is manual dispatch only; [`../../scripts/release/pack.ts`](../../scripts/release/pack.ts) and [`../../scripts/release/publish.ts`](../../scripts/release/publish.ts) — the pack/publish commands.
- [`../../apps/cli/src/restart-after-turn.ts`](../../apps/cli/src/restart-after-turn.ts) — the complete marker/watcher contract; `scripts/install.sh` header (`:1-34`) — the authoritative step list.
