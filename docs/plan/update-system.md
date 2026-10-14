# Update system — reference (engine, host plugin, client surface, catalog, release pipeline)

> Fork-only reference for the in-app update system live at `0.1.7-enpoi.2.9x`. Read with [`ui-update-manifest.md`](ui-update-manifest.md) (design plan and phase history), [`../creator/02-install-and-update.md`](../creator/02-install-and-update.md) (installer, channels, update mechanics), and [`../creator/14-update-maintenance.md`](../creator/14-update-maintenance.md) (retention, on-disk footprint, the exhaustive failure table). Maintenance procedures and the per-symptom update failure table stay in file 14; this page links them instead of restating them.

Naming: "the engine" in this document is the updater engine `scripts/install.sh` reached through `dsh update` (the generated shim forwards `dsh update|repair|uninstall|doctor|clean` to `<prefix>/harness/current/scripts/update.sh`, which delegates to the installer; `scripts/install.sh:3524-3544`, `scripts/update.sh:1-10`). `packages/host/update-engine/` is a different, separate thing: the archived delta preservation engine that the default path does not use (`DSH_DELTA=1` opt-in only; strategy note in creator/14).

## 1. Component map

| Component | Home | Role |
|---|---|---|
| Engine (installer/updater) | `scripts/install.sh` | Lock, run marker, prepare/apply, switch, restart, self-check, health proof, rollback, retention |
| Release pipeline | `.github/workflows/harness-release.yml` | One GitHub Release per push to `stable`: three platform tarballs + sidecars + `SHA256SUMS`, then the catalogs |
| Catalog generator | `scripts/update-catalog.mjs` | Offline `git log`-built `<channel>.json` (schema 1, last 40 releases) |
| Host plugin | `profile/web/packages/enpoi-update-check/` | Periodic check, status/dismissal, run lifecycle (launch, watch, reconcile, cancel relay, clearStale), `updateCheck` Remote namespace |
| Client surface | `packages/client/ui-update/` | Polling controller, chrome pill, dialog, General-settings row, post-restart toast/reload |
| Catalog fetch target | `https://raw.githubusercontent.com/Darthph0enix7/Enpoi-harness/catalog/<channel>.json` | Branch `catalog`, maintained by the release workflow (`profile/web/packages/enpoi-update-check/src/catalog.ts:20-27`) |

Deliberately absent: auto-update of any kind, browser-side downloads, and a client push channel (clients poll; `profile/web/packages/enpoi-update-check/src/index.ts:19-24`, `docs/plan/ui-update-manifest.md` §2).

## 2. End-to-end flow (push → device updated)

```text
commit pushed to `stable` (and `beta`, same commit — only `stable` triggers)
  └─ harness-release.yml
       prepare: version = <package.json version>.<github.run_number>   (e.g. 0.1.7-enpoi.2.92)
                skip if this commit already has a published release; create DRAFT release
       build:   linux-x64 | darwin-arm64 | darwin-x64, in parallel
                pnpm run build:official  with DSH_CLIENT_VERSION=<full version>, DSH_CLIENT_COMMIT_HASH=<7 sha>
                stage → prune-release-tree.sh → smoke boot → tar + .sha256 → upload to the draft
       publish: concatenate the 3 .sha256 into SHA256SUMS → flip the release public
       catalog: update-catalog.mjs upserts the tag into stable.json + beta.json
                → upload as release assets → push both files to the `catalog` branch (fail-soft)
  └─ device (terminal `dsh update` or the UI's updateCheck.start)
       prepare: resolve /releases/latest → resolve release commit vs channel head (divergence pre-check)
                → download + checksum-verify the platform tarball (or build the channel ref from source)
                → install tree → profile refresh + deps + plugin build → migrations
                → write $PREFIX/harness/.staged-apply.json → exit 0 (current, service, state untouched)
       apply:   atomic switch of harness/current → restart the recorded service (systemd/launchd)
                → backfill → self-check → health proof → retention prune → delete .staged-apply.json
  └─ browser
       reconnect after the restart → identity read shows the new version → one-time toast → auto-reload
```

The engine never runs in the browser and never inside the process it replaces; the detached launcher survives the web service's own restart (`docs/plan/ui-update-manifest.md` §5; `profile/web/packages/enpoi-update-check/src/launcher.ts:1-45`).

## 3. Release identity and versioning

- A prebuilt release version is `<tree base>.<run number>` (e.g. `0.1.7-enpoi.2.92`); the tree's `package.json` keeps the base (`0.1.7-enpoi.2`) and the release tag is `v<release version>` (`.github/workflows/harness-release.yml:80-88`, `scripts/install.sh:1606-1618`).
- A source build stamps `<base>+g<short commit>` (git-describe style, e.g. `0.1.7-enpoi.2+gbb12abc`) into the tree directory itself, the `.dsh-install-complete` marker, `install-state.json` (`version` + `harnessDir`), the backfill identity, `dsh --version`, the health proof, and the client build environment (`scripts/install.sh:1409-1426`, `scripts/install.sh:7807-7819`). Legacy `base`/`base-<short>` trees stay reusable and are upgraded on their next source build.
- Identity validation treats the marker as consistent when it descends from the tree's package.json base (`base`, `base.*`, `base-*`, `base+*`); a split is a conflict healed to the `current` symlink truth before planning, and the poisoned commit is ignored in favor of the tree build environment and the recorded state (`scripts/install.sh:1218-1267`, `scripts/install.sh:1272-1307`).
- Prebuilt releases ship the full release version to client artifacts: the build job exports the prepare job's full version as `DSH_CLIENT_VERSION`, so the Web UI's Settings → General row names the release while the installer keeps comparing the base (`.github/workflows/harness-release.yml:178-193`; `packages/client/ui-update/src/client/version.ts:12-29` renders the `+g<sha>` qualifier as a locale-owned "(source build)" label).
- Both channels (`stable`, `beta`) resolve the same newest published release because the two branches are pushed with the same commit; the channel still selects the source-archive ref when no release applies (`scripts/install.sh:1592-1604`, `.github/workflows/harness-release.yml:26-35`).
- Divergence pre-check: `stage_prebuilt` resolves the release's own commit and the channel head before fetching any bytes; when they differ the release is skipped up front with one warning and the run goes straight to the source build (`scripts/install.sh:2051-2068`, `scripts/install.sh:2204-2212`). An unresolvable side keeps the download path — never a false skip.

## 4. The engine: two-phase prepare / apply

- `dsh update --prepare` runs the whole flow — environment, source, pnpm pin, fetch/prebuilt or source build, profile refresh + deps, migrations — and stops immediately before the switch. It never touches `harness/current`, never restarts the service, keeps the migrated home deliberately, disarms the pre-switch restore, prunes scratch, and writes `$PREFIX/harness/.staged-apply.json` atomically (temp + rename), then exits 0 (`scripts/install.sh:7961-7983`, `scripts/install.sh:7321-7339`).
- The staged record's field set is the UI/plugin contract: `{version, treeDirName, channel, releaseCommit, prebuilt, preparedAt}`; `releaseCommit` is `null` when unresolved (source builds without git metadata). Do not add, rename, or drop fields without updating both consumers (`scripts/install.sh:7306-7317`; consumers: `profile/web/packages/enpoi-update-check/src/run.ts:216-232` and the shared staged semantics in `run-service.ts`).
- A second `--prepare` for the version already staged short-circuits (no download, no rebuild) when the record, channel, tree directory, and `.dsh-install-complete` all agree; any other state falls through and replaces the record (`scripts/install.sh:7639-7662`).
- `dsh update --apply` requires the record (typed `nothing staged at …` and non-zero exit otherwise), validates `treeDirName` against a strict character set, re-validates the record and tree under the update lock, then runs exactly: atomic switch → service restart (deferred when launched inside the unit) → self-check → health proof → retention prune → delete the record, rewriting `install-state.json` for the new tree as part of the switch (`scripts/install.sh:8078-8184`).
- Failure semantics: pre-switch refusals (no record, malformed record, missing/incomplete tree, record changed while waiting for the lock) change nothing and keep the record; a post-switch failure (self-check or health proof) rolls back to the previous tree with the pre-migration snapshot, archives the failed tree as `<dir>.failed-<ts>`, and keeps the record — a retry is deterministic and safe (`scripts/install.sh:8087-8094`, `scripts/install.sh:8150-8173`).
- A plain `dsh update` discards a staged record from an older target before any build work, so a late `--apply` can never switch back to it (`scripts/install.sh:7675-7680`).
- Steps are the shared 1–9 contract: prepare reports bands 1–7, apply reports 8 (switch) and 9 (self-check) (`scripts/install.sh:8126-8129`, `scripts/install.sh:7467-7475`).

## 5. Run marker contract

- File: `$PREFIX/harness/.update-run.json`. Sole writer: the running installer (engine); the plugin and `dsh update` attach are read-only (`scripts/install.sh:7356-7364`, `profile/web/packages/enpoi-update-check/src/marker.ts:1-10`).
- Fields: `runId` (`<epoch>-<pid>`), `pid` (the installer process), `mode` (`plain|prepare|apply|one-shot`), `step`, `steps`, `phase`, `startedAt`, `logPath`, `version`, `target` (`scripts/install.sh:7384-7406`).
- Phases: `running → switching → applying → done`, with `failed`, `rolledback`, and `cancelled` terminal. The marker advances at every numbered step and on phase changes; the EXIT-trap hook writes the terminal phase once from the real exit status unless a terminal phase is already set (rollback writes `rolledback` before exiting 1); signalled exits read `cancelled` (`scripts/install.sh:248-255`, `scripts/install.sh:7421-7439`, `scripts/install.sh:6629-6631`, `scripts/install.sh:7245-7248`).
- Staleness: a dead (or zombie) pid makes the marker stale — it never blocks anything and the next run replaces it; a stale `phase` still names what the last run did (`scripts/install.sh:7361-7363`). The plugin additionally never treats terminal phases as live and applies a progress-staleness window (below).
- `DSH_UPDATE_MODE=one-shot` lets a launcher label a no-flag run explicitly; the launcher exports it for the one-shot rung (`scripts/install.sh:7363-7364`, `profile/web/packages/enpoi-update-check/src/launcher.ts:126,297`).
- The marker is live state, not scratch: every sweep that would scrape `.update-*` skips it (`scripts/install.sh:7376-7382`), and `dsh clean`/the orphan sweep/retention never remove it while its pid may be live (`scripts/install.sh:6887-6890`).

## 6. Update lock semantics

- One update per install prefix protects the version tree, the `current` symlink, and the user-file backups. `--dry-run` is read-only and skips the lock entirely (`scripts/install.sh:7157-7162`, `scripts/install.sh:7237`).
- Linux rung — `flock`: exclusive non-blocking `flock -n 9` on `<prefix>/harness/.update.lock`; the kernel releases it with the holder, so it cannot go stale. After acquiring, the engine still reaps a stray mkdir lock as hygiene (copied installs, PATH-restricted runs); a live one is kept and logged (`scripts/install.sh:7260-7279`).
- macOS rung — `mkdir`: macOS ships no flock, so the lock is the atomic directory `<prefix>/harness/.update.lock.d` plus its `pid` file written by the holder (`scripts/install.sh:7171-7181`, `scripts/install.sh:7281-7303`).
- Stale reclaim (mkdir rung, and cancel/apply entry points): the recorded pid is verified with the zombie-aware `pid_live` (`kill -0` plus a `Z*` state check). Dead, zombie, or unreadable owner → reclaimed with one warning naming the stale pid and the run proceeds; a live pid is never touched (`scripts/install.sh:7186-7207`, `scripts/install.sh:7445-7451`).
- Contention: with a live holder, a plain update attaches; every other mode (prepare/apply/cancel) refuses with `another update is already running (PID …)`; a missing/stale marker keeps the refusal. A released-then-recreated lock falls back to the same decision for its recorded owner (`scripts/install.sh:8197-8203`, `scripts/install.sh:7263-7297`).
- One lock per process: `UPDATE_LOCK_OWNED` makes a re-acquire a no-op — `do_update` takes the lock and the apply path re-enters through `do_apply_staged`; on the mkdir rung the second attempt would otherwise see the process's own live pid and refuse the run against itself (`scripts/install.sh:7236-7242`).
- Never break a live holder: every reclaim path checks liveness first; the only manual-removal hint left is the rare PID-reuse case for a live recorded pid (creator/14 §8).
- `--cancel` reaps a dead-owner mkdir lock up front (live owners kept), so it never refuses for a lock the next run would auto-break (`scripts/install.sh:8353-8356`).

## 7. Attach (lock-free subscription)

- A plain `dsh update` checks `update_run_is_subscribable` before ever competing for the lock: the marker exists, its pid is live, and the lock is held. The probe is read-only — the flock rung acquires and releases atomically, the mkdir rung only tests directory existence — so the subscriber never creates, reclaims, or holds the lock (`scripts/install.sh:7209-7234`, `scripts/install.sh:7250-7258`).
- On attach: a banner names mode/PID/start time, then the marker's `[N/9]` step banners render with the canonical step labels, `switching`/`applying` print live lines, and the run log is tailed from the last consumed line (rotation/truncation restarts the tail) (`scripts/install.sh:8205-8262`).
- Ctrl-C (or SIGTERM) detaches: the signal is never forwarded to the runner — a different process/unit — and the subscriber exits 130 with an explicit message (`scripts/install.sh:8219-8221`). Any subscriber exit (signal, crash, zombie) leaves no lock behind because it never owned one.
- After the pid dies, attach waits up to 10 s for a terminal phase, flushes the remaining log, and exits with the run's outcome: `done` → exit 0 (`The attached update finished successfully`), `cancelled` or any other phase → exit 1 (`scripts/install.sh:8263-8299`). `--json` emits one `{ok, action: "attach", …}` object (`scripts/install.sh:8302-8306`).
- Prepare/apply runs are deliberately not substitutable: meeting a live run they keep the engine's own refusal, because those flags own a staged/apply transaction.

## 8. `--cancel`

- Bounded kill: `dsh update --cancel` SIGTERMs the marker pid, waits `DSH_CANCEL_TIMEOUT` seconds (default 10), then escalates to SIGKILL and waits up to 5 s (`scripts/install.sh:8346-8408`).
- Refusal past the switch: phases `switching`/`applying` refuse with exit 1 and the message `refusing — the update is past the switch (…); … a failure rolls back automatically`. The switch→self-check window is seconds and the engine's own rollback is the protected failure path (`scripts/install.sh:8382-8389`).
- Before that: no marker, no usable pid, or a dead pid is a `noop` (exit 0); a live pre-switch run is stopped and its marker reads `cancelled` — written by the runner's own EXIT trap on SIGTERM, or by cancel itself when a SIGKILLed runner could not write it (`mark_run_cancelled` preserves every other marker field) (`scripts/install.sh:8358-8381`, `scripts/install.sh:8308-8316`).
- What stays safe afterwards (all pre-switch): `current` was never switched, the runner's EXIT trap restored the pre-switch user-file snapshot (`PRE_SWITCH_RESTORE` was armed), the update lock is released by that same trap, partial downloads and dead-owner staging are swept (`prune_orphaned_update_artifacts` + `sweep_dead_staging`, live artifacts untouched), and a later `dsh update` is a normal idempotent run (`scripts/install.sh:8338-8345`, `scripts/install.sh:8417-8429`).
- `--cancel` is not valid with `--prepare`/`--apply`/`--dry-run` (`scripts/install.sh:9085`).

## 9. Host plugin: check and run lifecycle

Home: `profile/web/packages/enpoi-update-check/`, mounted as profile bundle `dsh-enpoi-update-check`; config row `{enabled: true, intervalMinutes: 360 (clamped 1–10080), jitterSeconds: 300 (clamped 0–3600)}` (`src/index.ts:61-79`). A mount failure disables the plugin loudly on stderr and never takes the boot down (`src/index.ts:169-171`).

**The check.** On boot (30 s base + jitter) and then every interval (re-jittered), the host fetches `<channel>.json` for the install's channel, compares, and publishes `unknown | current | available | dismissed`; `enabled: false` stops the timer but `checkNow` still works (`src/service.ts:232-256`, `src/index.ts:153-164`). A failed or malformed fetch preserves the last successful comparison and records `error`; one debug log line per failure, no retries before the next interval; `checkNow` is single-flight (`src/service.ts:101-105`, `src/service.ts:122-181`). "Skip this version" persists per install in `$DSH_HOME/update-check/dismissed.json` (`{version, at}`, atomic write) and a newer catalog version re-arms `available` (`src/store.ts:1-56`, `src/service.ts:155-158`). The channel comes from `install-state.json` (`channel`, default `stable`), the identity carries `version` + `commit` (`src/catalog.ts:206-225`).

**Commit-identity current-detection.** The check compares commits first: both sides hex-ish and ≥ 7 chars, prefix-compatible (short vs full sha) means `current` even when the stamped version is older than the catalog's newest; the segment-wise version comparator (numeric-aware, `0.1.7-enpoi.2.9 < 0.1.7-enpoi.2.10`) is the fallback when either side lacks a commit (`src/catalog.ts:69-114`, `src/service.ts:130-147`). This is what keeps a source-built install (`base+g<sha>`) or a bare-base stamp from being offered the same release forever.

**The run controller** (`src/run-service.ts`). One controller per plugin instance owns at most one run; the installed engine's two-phase capability is probed once per boot via `<shim> update --help` (bounded 10 s; every failure defaults to unsupported → the one-shot rung) (`src/probe.ts:1-120`, `src/run-service.ts:287-308`).

- `start` pins channel + target from the current `available`/`dismissed` status and launches the detached shim (`--prepare` on a two-phase engine, `--channel <c>` only on the one-shot rung); refusals: `not-available`, `already-running`, `already-prepared`, `shim-missing`, `launch-failed` (`src/run-service.ts:390-424`, `src/remote.ts:96-117`). A dismissed version stays startable — the skip only hides the indicator (`src/run-service.ts:393-400`).
- `apply` launches `dsh update --apply`; refusals: `already-running`, `not-prepared` (also for a one-shot record), and a missing staged marker. A failed record with a valid staged marker is re-appliable without a new prepare, pinned to the staged record's version — this is the UI's recovery path (`src/run-service.ts:434-473`).
- The launcher ladder (first rung whose command exists; `spawn` is the everywhere-fallback): Linux `systemd-run --user --collect --quiet --wait --unit=dsh-update-<runId>` → `setsid` → `spawn`; macOS `launchctl submit -l com.dsh.update.<runId>` → `setsid` → `spawn` (`src/launcher.ts:352-410`). The POSIX wrapper exports a composed `PATH` plus `DSH_HOME`/`PREFIX`, records `echo $$ > pid-file`, then `exec`s the shim with stdout+stderr redirected into `run.log` (`src/launcher.ts:320-349`).
- Launch environment: the web service's environment is not the login environment, so the launcher probes for a Node runtime — `$PREFIX/runtime/node/current/bin`, then the nvm layouts newest-first, then the inherited `PATH`, then `/usr/local/bin:/usr/bin:/bin` (plus `/opt/homebrew/bin` on macOS). Nothing resolving throws `LaunchEnvironmentError`, which becomes the record's failure `reason` (`src/launcher.ts:17-26,195-247,281-306`).
- Launch environment fallback for one-shot: `DSH_UPDATE_MODE=one-shot` is exported so the engine's marker reads `one-shot`, not `plain` (`src/launcher.ts:125-126,295-297`).
- Watcher: `run.json` is refreshed from the log tail (step markers `[N/9]`, terminal lines `rolled back` → rolledback, `successfully updated|already up to date|Update applied:` → success, `FAILED|✗ ERROR:` → failed; `Update prepared:` is deliberately not a result) (`src/run.ts:234-288`). One-shot and observed records never become `prepared`; a prepare process exiting with the staged marker present rests at `prepared` (`src/run-service.ts:710-743`).
- Boot reconcile resolves a record whose watcher died with the previous service instance: a live updater resumes watching (the engine marker's pid/phase/step win when it names the same run); a prepared record with a surviving staged marker stays prepared; a dead run's terminal log line decides; the install version equal to the target means success; anything else is `failed` with an explicit reason. The log is never deleted (`src/run-service.ts:327-372`, `src/run.ts:517-579`).
- One liveness truth: a run is live only when the pid is live and non-zombie AND the run's log moved within `RUN_STALE_WINDOW_MS` (5 min); terminal phases are never live, so a recycled pid cannot block; missing file evidence counts as fresh (never auto-heal on absent evidence) (`src/marker.ts:98-165`, `src/run-service.ts:784-808`).
- Self-heal: every `run()` read heals a stale persisted record — not live by pid and the engine agrees nothing (else) runs → reconcile to terminal (`success` when the install reached the target, else `failed` with a reason), drop the dead pid file, stop the watcher; runs younger than the 15 s start grace and prepared records are left alone (`src/run-service.ts:263-285`).
- Gates vs the engine's truth: `blockingRun` = strong liveness OR the engine's own live run matching the record (`engineRunActiveFor`); the engine's truth is a live non-terminal non-stalled marker, or the mkdir-fallback lock directory's live owner pid (the flock file's presence is never consulted — it stays on disk after release) (`src/run-service.ts:241-261`, `src/run-service.ts:810-814`). When the engine truly holds the lock, its precise refusal speaks (`src/run-service.ts:410-416`).
- `clearStale` (Remote `updateCheck/clearStale`): refuses while the observed record, the persisted record, or the engine is genuinely live; otherwise reconciles the persisted record to a terminal state and drops the dead pid file. It never touches the engine marker or the staged tree, so a valid staged update survives for an immediate re-apply (`src/run-service.ts:475-519`, `src/remote.ts:152-172`).
- `cancel` shells the installed shim (`dsh update --cancel --json`, 30 s bound) so SIGTERM→SIGKILL, the past-the-switch refusal, the partial sweeps, and the terminal marker stay in the engine; the plugin relays a successful cancel into a `cancelled` record (its own, or one synthesized from the now-terminal marker) (`src/cancel.ts:1-14,103-166`, `src/run-service.ts:521-568`).
- The Remote namespace exposes `status`, `checkNow`, `dismiss`, `start`, `apply`, `run`, `cancel`, `clearStale`; every `RunRefusedError` maps to `gateway/bad-request` (`src/remote.ts:1-13,64-191`).

## 10. Client surface: states, surfaces, reload

Home: `packages/client/ui-update/`, registered as one `shell.overlay` entry (the pill+dialog+toast) and one `settings.general.item` row (order 101, beside the current-version row) sharing one controller store — there is exactly one polling source (`src/client/index.ts:55-99`). Polling: status on mount, every 60 s while visible, and on focus/visibility-restore (coalesced by a 1 s gap, single-flight); run once on mount and every 2 s only while the engine executes; a prepared record is not polled (`src/client/controller.ts:14-22,29-44,423-458`).

Phase → surface mapping (`src/client/rpc.ts:117-122`, `src/client/UpdateIndicator.tsx:60-130`, `src/client/UpdateSettingsRow.tsx:46-139`):

| Host phase | Pill (`shell.overlay`) | Dialog | Settings row |
|---|---|---|---|
| `starting` / `preparing` | "Updating" (dot + label) with progress | Progress strip (`progress.starting` / `preparing`), step `N/9`, last log line, Cancel (still allowed) | `updating` + View progress |
| `applying` (two-phase) / one-shot at step ≥ 8 | "Updating" with switch label | Progress strip (`progress.switching` at step ≥ 8, else `applying`), disconnect warning, Cancel hidden past the switch | `updating` + View progress |
| `prepared` (two-phase only) | "Restart to update" (warning dot) | Prepared hint; primary **Restart to update** — `updateCheck/apply` | `prepared` + primary **Restart to update** |
| `success` | hidden, unless a newer offer exists | Success line (`result.success` with the target) | `current` unless a newer offer exists |
| `failed` / `rolledback` / `cancelled` | hidden for its own state | Failure section: title by result, reason, bounded 40-line log tail, Retry; "Clear update state & retry" when the failure kept a staged tree (or names an already-running/stale condition) | `failed`/`cancelled` + **Retry** (opens the dialog) |
| status `available` | "Update" (text-only, version-free) | Version pair, scrollable notes, `[Update now] [Later] [Skip this version]` | `available` + primary **Update now** |
| status `dismissed` | hidden | Skipped hint; Update now stays offered | `skipped` + hint + primary **Update now** |
| status `unknown` / `current` | hidden | Manual **Check for updates** with checking/failure states | quiet line + **Check for updates** |

- The switch disconnect warning and the cancel affordance both use step 8: on a one-shot run the switch happens inside `preparing`, so step ≥ 8 is the same warning point on both rungs (`src/client/UpdateIndicator.tsx:90-105`).
- "Update now" runs `updateCheck/start` (prepare); **Restart to update** runs `updateCheck/apply`; **Retry** replays `apply` while a two-phase staged marker survived and prepares otherwise (`src/client/controller.ts:295-339`).
- **Clear update state & retry** calls `updateCheck/clearStale`, then re-applies when the returned record still names a staged tree (no re-download) and prepares otherwise (`src/client/controller.ts:273-293`).
- Dismissal/re-arm: `skip` persists the version host-side and closes the dialog; the pill hides, but the settings row and the dialog keep the action; a newer catalog version re-arms the indicator host-side (`src/client/controller.ts:341-361`, `src/service.ts:155-158`).
- Landed-run guard (scoped): a terminal success suppresses the pill only while it landed the release the status still offers; a newer catalog version re-arms immediately (`landedOffering = run.target === latest.version` in both surfaces) (`src/client/UpdateIndicator.tsx:78-84`, `src/client/UpdateSettingsRow.tsx:56-58`).
- Post-restart completion: the controller pins `{from, target}` before starting, and on reconnect/reload-watch compares the served identity. `maybeCompleteUpdate` fires when the served version changed from the pinned `from`, or when the run record reads `success`; it stores the one-time toast payload, clears the pending marker, and reloads (`src/client/controller.ts:460-485`). The reload watch re-reads the status every 2 s for at most 60 s after a terminal success or a reconnect with a pending update, and never extends itself (`src/client/controller.ts:487-510`). A reconnect re-reads the run unconditionally and a status read reporting `current` reconciles an executing record on the spot, which is what clears a stale "Updating…" frame after a successful update (`src/client/controller.ts:407-416,434-439`). The toast payload is consumed exactly once at controller construction (`src/client/controller.ts:212-217`).

## 11. Platform matrix

| Concern | Linux | macOS |
|---|---|---|
| Service | systemd **user unit** (e.g. `dsh-web.service`); restart `systemctl --user restart <unit>` | LaunchAgent (`launchctl`); restart `kickstart -k gui/<uid>/<label>`, with `bootout`/`bootstrap`/`kickstart` when the plist was rewritten or the job is not loaded (`scripts/install.sh:3713-3786`) |
| Update lock | `flock` on `<prefix>/harness/.update.lock` — the kernel releases it with the holder, so it cannot go stale | atomic `mkdir` `.update.lock.d` + holder pid — stale (dead/zombie/unreadable owner) is reclaimed with one warning; a live owner is never broken (creator/14 §8) |
| Detached launcher rung 1 | `systemd-run --user --collect --quiet --wait --unit=dsh-update-<runId>` (the launcher client lives for the unit's lifetime, so its pid is a liveness anchor until the wrapper's pid file appears) | `launchctl submit -l com.dsh.update.<runId>` (the transient job the installer's own service-guard uses) (`src/launcher.ts:29-45,358-410`) |
| Ladder fallback | `setsid` → detached `spawn` | `setsid` → detached `spawn` (`src/launcher.ts:405-409`) |
| Runtime probe extra | `/usr/local/bin`, `/usr/bin`, `/bin` | plus `/opt/homebrew/bin` (`src/launcher.ts:146-151`) |
| Guarantees | Lock staleness impossible; kill/switching protections identical to macOS | Stale locks self-heal and never need manual removal in the common case; PID reuse remains the documented manual case |

Both rungs guarantee the same invariants: one update per prefix, a live holder is never broken, attach never leaves a lock behind, and `--cancel` refuses past the switch on both.

## 12. Invariants and recovery

Core invariants (each verifiable in the cited code):

1. **A live run is never broken.** Reclaim checks liveness before removing anything; a live mkdir-lock holder or live marker pid only ever leads to attach or a typed refusal; `--cancel` refuses once the run is past the switch (`scripts/install.sh:7186-7207`, `scripts/install.sh:7285-7287`, `scripts/install.sh:8382-8389`).
2. **Terminal phases never read as running.** The engine writes a terminal phase once; the plugin's liveness treats `done|failed|rolledback|cancelled` as never live regardless of a recycled pid, so terminal state cannot block a gate or render the pill (`scripts/install.sh:7426-7439`, `profile/web/packages/enpoi-update-check/src/marker.ts:155-165`).
3. **A free engine lock always allows a new run.** The flock rung cannot go stale; the mkdir rung reclaims a dead-owner lock on every entry point (update, prepare, apply, cancel) with one warning (`scripts/install.sh:7164-7170`, `scripts/install.sh:7289-7297`, `scripts/install.sh:8353-8356`).
4. **Every failure has a recovery path.** Prepare never switches; a failed apply rolls back and keeps the staged record so the UI can retry; a failed record with a valid staged tree is re-appliable without re-preparing; `clearStale` + "Clear update state & retry" recovers a stale state without touching the engine marker or the staged tree; a pre-switch cancel restores the pre-switch snapshot and leaves a normal idempotent update (`scripts/install.sh:7961-7983`, `scripts/install.sh:8087-8094`, `profile/web/packages/enpoi-update-check/src/run-service.ts:449-473,475-519`).
5. **One writer, one run, one lock.** The installer is the marker's sole writer; the plugin owns at most one run per instance; the engine holds one lock per prefix and one lock per process (`scripts/install.sh:7356-7360`, `scripts/install.sh:7236-7242`, `run-service.ts:1-22`).
6. **The catalog is advisory; release artifacts are authoritative.** A tampered catalog can at worst show wrong notes; the tarball is checksum-verified and the release commit is compared with the channel head before fetching (`docs/plan/ui-update-manifest.md` §3, `scripts/install.sh:2051-2068`).

The exhaustive symptom → cause → fix table is maintained in [`../creator/14-update-maintenance.md`](../creator/14-update-maintenance.md) §8 (including the attach/refusal rows, the pnpm no-TTY hardening, and the divergence and source-stamp fixes); do not duplicate it here. Quick recovery map for the surfaces this document owns:

| Symptom | First move |
|---|---|
| `another update is already running` | A plain `dsh update` attaches automatically; otherwise wait, or `dsh update --cancel` for a pre-switch run; a dead-owner lock self-heals with one warning |
| Stale "Updating…" pill / block after a dead run | Reconnect or a status read heals it; the dialog's "Clear update state & retry" calls `updateCheck/clearStale` |
| Apply failed after the switch | The engine rolled back and kept the staged record; **Retry** re-applies (staged marker survives), "Clear update state & retry" is the escape when the record is stuck |
| `dsh update --cancel` refuses | The run is past the switch — let it finish; rollback is the protected path |
| A release was skipped / source-built instead of pruned | Check the divergence warning; expected when the channel head moved past the newest release |

## 13. Fleet reference

| Device | OS | Service path | Channel | Notes |
|---|---|---|---|---|
| serverlocal | Linux | user systemd, **dev/source run** (`dsh-web.service`: `node --import tsx/esm apps/cli/src/bin.ts web`) | beta | Primary development host; live-verified the full UI prepare→apply flow (2.85) and the 2.90 cross-device pass |
| The PC | Linux | installed service | beta | Live-verified the clean prebuilt update with the divergence pre-check and full-version display (2.90); reported at 2.92 |
| The MacBook | macOS | LaunchAgent | beta | Live-verified the plugin mount after the profile-bundle merge fix (2.86); exercises the mkdir lock + `launchctl` rung |

Versions advance: the table is a topology reference, not a version ledger — read the device's `dsh --version` / `install-state.json` for the current release. Cross-device verification evidence lives in the status line of [`ui-update-manifest.md`](ui-update-manifest.md) and the arc log in [`update-release-log.md`](update-release-log.md).

## 14. Source index

- Engine: `scripts/install.sh` (lock 7157-7304, marker 7356-7465, flags 640-710, prepare stop 7961-7983, apply 8078-8184, attach 8192-8306, cancel 8338-8430, divergence 2033-2212, source identity 1409-1426, 7807-7819), `scripts/update.sh` (delegation).
- Host plugin: `profile/web/packages/enpoi-update-check/src/{index,service,catalog,store,remote,run,run-service,marker,launcher,probe,cancel}.ts`.
- Client: `packages/client/ui-update/src/client/{index,controller,rpc,version,UpdateIndicator,UpdateSettingsRow}.tsx?`.
- Pipeline: `.github/workflows/harness-release.yml`, `scripts/update-catalog.mjs`.
- Related docs: [`ui-update-manifest.md`](ui-update-manifest.md) (design/plan), [`../creator/02-install-and-update.md`](../creator/02-install-and-update.md) (mechanics), [`../creator/14-update-maintenance.md`](../creator/14-update-maintenance.md) (maintenance + failure table), [`update-release-log.md`](update-release-log.md) (arc 2.78 → 2.92 work log).
