# UI Update Manifest + In-App Updates — Plan

Status: P1 (catalog), P2 (host check), P3 (client UI), and P4 (run surface + the two-phase engine split) are implemented and live-verified on `local/serverlocal` (2026-10-13/14). Live evidence to date: the full prepare → apply cycle on serverlocal for 2.85 (health PASS, retention sweep, no orphaned artifacts), the Mac's 2.86 update mounting the host plugin after the profile-bundle merge fix, the terminal attach/cancel drills, the 2.90 cross-device pass (serverlocal full UI flow; the PC's clean prebuilt update with the divergence pre-check and the full-version display; the profile-bundle mount on both), and the loop-free commit-identity check (source-built and released installs both stay quiet at the same commit). The five owner decisions are resolved in §9; decision 2's prepare-then-apply split ships as engine flags `dsh update --prepare` / `dsh update --apply` (§5), and the shipped run reconciles across the service restart it causes (§5, reconcile).

## 1. Goal

A user on the Web UI learns, rarely and quietly, that a newer harness exists; can see
what changed between *their* version and the newest one; and can start an update that
runs **server-side in the background** — surviving a browser close, reporting progress
into the UI, locking only for the final restart, and landing with the engine's existing
atomic switch, self-check, and rollback guarantees.

Experience sketch:

1. A small dot/pill appears next to the version in the UI chrome ("2.81 → 2.84").
2. Clicking opens a dialog: current version → newest version, the **changelog between
   them**, size/time estimate, `[Update now] [Later] [Skip this version]`.
3. During the download the user keeps working; a progress strip shows the phase.
4. The dialog (if open) or a toast summarizes: `Downloading 43%`, `Verifying`,
   `Switching`, `Restarting`, `Reconnecting…`.
5. The switch locks the UI for ~15–30 s (an overlay), the service restarts, the page
   reconnects and auto-reloads into the new version.

## 2. Non-goals

- No auto-update of any kind: manual only, always (decision 3).
- No per-launch nagging: checks are rare, dismissible, and skippable per version.
- No browser-side downloads or updates: the browser only talks to its own host.

## 3. The update manifest (the "catalog")

A tiny generated file, fetched cheaply, carrying exactly what the UI needs.

**Schema (`<channel>.json`, ~1–2 KB per release):**

```jsonc
{
  "schemaVersion": 1,
  "channel": "stable",            // or "beta"
  "generatedAt": "2026-10-13T12:30:00Z",
  "releases": [                   // newest first, last K=40 kept
    {
      "version": "0.1.7-enpoi.2.84",
      "commit": "abc1234",
      "releasedAt": "…",
      "notes": ["fix(update): …", "feat(feedback): …"],   // one line per commit
      "highlights": ["…"],        // optional curated summary for big releases
      "minFrom": "0.1.7-enpoi.2.40"                          // optional floor
    }
  ]
}
```

**Generation:** `scripts/update-catalog.mjs` builds/updates a catalog from git alone (offline, idempotent: a new tag prepends, a re-run replaces its own entry, the last 40 releases are kept, merge and `[skip ci]` subjects are skipped). A `harness-release.yml` job runs whenever the target release tag is published — including on a re-run that deduped to an already-published release, so a run that died before the catalog copy self-heals. Both channels are maintained from the one shared release stream (the two channel branches are pushed with the same commit): the same releases land in `stable.json` and `beta.json` with the per-file `channel` field, and both ride the release as `update-catalog-<channel>.json` assets; the asset pair is the immutable per-release record, the branch files are the always-current fetch targets. The branch push (one commit carrying both files) is fail-soft so a published release never fails on it.

**Hosting & fetch:** `https://raw.githubusercontent.com/Darthph0enix7/Enpoi-harness/catalog/<channel>.json` — branch `catalog`, file `<channel>.json` at the branch root (CDN-cached, ETag-friendly). The **host fetches it, never the browser** — server-side fetch keeps CSP/offline behavior simple and lets one check serve all connected clients.

**Size budget:** entries are commit subjects; 40 entries ≈ 40–60 KB worst case, ~10 KB
typical. If it grows, split: a 300-byte `latest.json` for the poll and a
`changelog/<version>.json` fetched only when the dialog opens.

**Trust:** the catalog is *advisory* (version, notes). The authoritative artifacts stay
the release assets the updater already checksums; a tampered catalog can at worst show
wrong notes or point at a version whose real release assets fail verification.

## 4. The check

- The host plugin `enpoi-update-check` (`profile/web/packages/enpoi-update-check`) runs on web start (+30 s, jittered) and then every 6 h; the config row `enpoi-update-check` carries `enabled`, `intervalMinutes: 360`, `jitterSeconds: 300`.
- States: `unknown` (never fetched / offline) → `current` → `available {version, notes}` → `dismissed(version)`; `updating` arrives with P4. A failed check keeps the last successful comparison and records `error`; one debug log line per failed attempt, no retries before the next interval.
- "Skip this version" persists per install (`$DSH_HOME/update-check/dismissed.json`); a newer version re-arms the indicator.
- Channel follows the install's channel (beta installs see beta; `install-state.json` → `channel`, default `stable`).
- The result is exposed through the `updateCheck` Remote namespace (`status`, `checkNow`, `dismiss`). The profile plugin family has no client push, so clients poll; the P3 UI surface owns any push.

## 5. Running the update (background, resumable)

The engine never runs in the browser and never inside the process it replaces.

- Trigger: the UI calls `updateCheck/start`; the host validates (an update is available, no run active, the shim is present), writes `run.json`, and **launches a detached runner**:
  - Linux: `systemd-run --user --unit=dsh-update-<runId> --collect --wait` (transient, survives the web restart).
  - macOS: `launchctl submit -l com.dsh.update.<runId>`; fallback `setsid`, then a bare detached `sh`, everywhere.
  - The runner = the installed `dsh` shim (`<binDir>/dsh update --channel <channel>`), unchanged engine. Every rung shares one POSIX wrapper that records the updater pid in `run.pid` and redirects stdout+stderr into `run.log`.
- **Two-phase runner (implemented, decision 2):** `dsh update --prepare` runs the full flow (fetch → verify → unpack/stage → deps → profile → migrations) and stops immediately before the switch: it never touches `harness/current`, never restarts the service, and exits 0. It writes the staged record `$PREFIX/harness/.staged-apply.json` atomically, whose field set is the UI/plugin contract: `{version, treeDirName, channel, releaseCommit, prebuilt, preparedAt}` (`releaseCommit` null when unresolved). Re-running prepare for the already-staged version short-circuits (no download, no rebuild); a newer target replaces the record. `dsh update --apply` requires that record (a typed `nothing staged` message and non-zero exit otherwise), then performs exactly: atomic switch to `treeDirName` → service restart (delegated when launched inside the unit) → self-check → health proof → retention prune → delete the record, rewriting `install-state.json` for the new tree as part of the switch. The record survives any failure so the UI can retry: a pre-switch refusal changes nothing; a post-switch failure rolls back (previous tree + service, failed tree archived as `*.failed-<ts>`) and a retry is deterministic. A plain `dsh update` discards a stale record before any build work, so an old prepared target can never be applied after the install moved on. The runner is launched as `dsh update --channel <channel> --prepare`, unchanged shim plumbing.
- **Engine run marker, attach, cancel (implemented):** the running installer is the sole writer of `$PREFIX/harness/.update-run.json` — `{runId, pid, mode (plain|prepare|apply|one-shot), step, steps, phase, startedAt, logPath, version, target}`, rewritten at every numbered step; phases are `running` → `switching` → `applying` → terminal `done`/`failed`/`rolledback`/`cancelled` (a signalled exit reads `cancelled`; `DSH_UPDATE_MODE=one-shot` lets a launcher label the no-flag rung). A plain `dsh update` that meets a held lock with a live marker **attaches**: it renders the marker's step banners plus the runner's live log and exits with the run's outcome; Ctrl-C detaches without touching the runner. `dsh update --cancel` SIGTERMs the marker pid (bounded by `DSH_CANCEL_TIMEOUT`, then SIGKILL), sweeps dead-owner partial downloads/staging, and marks the run cancelled; it refuses once past the switch (`switching`/`applying`), where the engine's own rollback is the protected path. After a pre-switch cancel `current` was never touched, the pre-switch user-file snapshot was restored by the runner's exit trap, and a re-run is a normal idempotent update. A dead pid makes the marker stale — it never blocks, and the next run replaces it; prepare/apply keep the plain "another update is already running" refusal.
- **Profile bundle mount (implemented):** the update-time profile merge unions the shipped template's `dsh.profile.bundles` into the live profile `package.json` — missing template entries are appended, the operator's order and custom entries are never removed or reordered, an absent live list adopts the template's, and a non-array live value is kept and reported. The refresh log names every appended bundle (`… bundle(s) added (…; bundles:<name>)`), so a bundle added to the template by a later release — like `dsh-enpoi-update-check` — actually mounts on updated installs instead of silently missing (the live defect this fixes).
- **Progress contract (implemented):** the shipped watcher derives progress from the runner's `[N/9]` step lines in `$DSH_HOME/update-check/run.log` plus the terminal result lines (`successfully updated` / `Update applied:` / `FAILED` / `rolled back`), and persists the pollable record to `$DSH_HOME/update-check/run.json` (`{runId, target, channel, mode, rung, phase, step, steps, lastLine, startedAt, pid, logPath, result, launcher, staged, logTail, finishedAt?, reason?}`). Phases: `starting` → `preparing` → `prepared` → `applying` → `success`/`failed`/`rolledback` (the one-shot rung skips `prepared` and `applying`); prepare reports the step bands `1–7`, apply reports 8 (switch) and 9 (self-check). The originally proposed engine-side `harness/update-state.json` with byte counts is not consumed; byte-level progress stays deferred, and clients poll `updateCheck/run` (the UI reads it once on mount and then polls ~2 s only while the engine process executes) instead of a host push.
- **Launch environment (implemented):** the web service's environment is not the login environment, so the launcher probes for a Node.js runtime (the install's `$PREFIX/runtime/node/current/bin`, the nvm layouts newest-first, the inherited `PATH`, then common system directories) and the wrapper exports the composed `PATH` plus `DSH_HOME`/`PREFIX` before exec'ing the shim; no runtime resolving fails the run with the probed list in run.json's `reason`.
- **Engine capability probe (implemented):** the two-phase flags only exist in newer engines, so the controller probes the installed shim once per plugin boot (`<shim> update --help`, bounded at 10 s) and caches the answer; only help output naming `--prepare` is supported, and every failure mode defaults to unsupported. An unsupported engine runs the **one-shot** rung (`dsh update --channel <c>`, `rung: 'one-shot'`): the run includes the switch and restart itself, never becomes `prepared`, and `apply` refuses it with a clear "nothing to apply" message; reconcile treats a dead one-shot record with the same success/failed logic. `launcher` records the OS rung, `rung` the engine generation. `start` deliberately refuses while an update is already prepared (`already-prepared`): the staged target is pinned by the engine's own record, so the offered action is Restart to update rather than prepare again; a dismissed ("skipped") version stays startable, because the skip only hides the client indicator and the Settings row is the durable entry point.
- **Commit-identity current-detection (implemented):** the check compares commits before versions — both hex-ish, ≥ 7 chars, prefix-compatible (short vs full sha) means `current` even when the stamped version (`0.1.7-enpoi.2+g<sha>` or the bare base) is older than the catalog's newest; the version comparator stays the fallback when either side lacks a commit. Source-build stamps render with a locale-owned `(source build)` qualifier in the dialog and the toast; the pill stays version-free.
- **Stale-state self-healing (implemented):** one liveness truth — pid live and non-zombie AND the run log moved within `RUN_STALE_WINDOW_MS` (5 min), terminal phases never live — heals stale records on every `run`, at boot, and at the `start`/`apply` gates (terminal or prepared as appropriate, dead pid file dropped); the gates also defer to the engine's own truth (live non-terminal non-stalled marker or the mkdir-lock's live owner pid) and let the engine's precise refusal speak when it truly holds the lock. `updateCheck.clearStale` exposes the healing to the UI (refuses while anything is live, never touches the engine marker/staged tree), and a failed apply with a valid staged marker is re-appliable without a new prepare (the staged version is pinned as the target).
- **Engine marker, observe-in-UI, and cancel (implemented):** the installer's marker `$PREFIX/harness/.update-run.json` (`runId, pid, mode plain|prepare|apply|one-shot, step, steps, phase running → switching → applying → done, terminal failed|rolledback|cancelled, startedAt, logPath, version, target`; sole writer = the running installer) lets `updateCheck.run` observe a terminal-started run: the plugin reads it per call, verifies a live non-zombie pid, and synthesizes the same record shape (`observed: true`; `plain`/`one-shot` → one-shot rung, `running` → `preparing`, `switching`/`applying` → `applying`, terminal → result, `logTail` from the marker's `logPath`); a stale dead-pid marker reports nothing, and a surviving plugin run reconciles with the marker's pid/phase. `DSH_UPDATE_MODE=one-shot` labels the launcher's no-flag rung. `updateCheck.cancel` shells the installed shim (`dsh update --cancel --json`, 30 s bound) so SIGTERM→SIGKILL, the past-the-switch refusal, the partial sweeps, and the terminal marker all stay in the engine; the plugin relays the outcome into a `cancelled` record (or surfaces the refusal message). After a terminal success (or a reconnect with a pending update) the client re-reads the identity every ~2 s for at most 60 s and reloads on change, so the post-switch service needs no manual refresh.
- **Overlay geometry (implemented):** the frames publish overlay-safe insets on the document root (`--dsh-shell-inset-left/-right/-bottom` plus a covered marker) so body-portalled overlay chips — the update pill (bottom-left, inside the centre column), the system-analysis chip, and the feedback pipeline chip — never sit over a rail or a fullscreen right panel; Modal masks dim the page and add a subtle backdrop blur.
- **Survival:** closing the browser changes nothing (the runner is a unit/process of its own); if the *service* restarts mid-run, the runner keeps going and its state file is read again after reconnect. The shipped reconcile is idempotent and log-preserving: a still-live updater (its wrapper pid file) resumes the watcher; an install version equal to the run's target records `success`; any other dead run is `failed` with an explicit reason. A stale-run lock (pid + startedAt) prevents double runs; a crashed runner leaves `failed` state with the log tail for **Retry**.
- **The restart window:** the engine switches the tree, restarts `dsh-web`, self-checks
  and rolls back on failure. The UI: soft-lock from `switch` until reconnect — an overlay
  "Updating — the UI will reload automatically", then reconnect + auto-reload with the
  new version. Before `switch`, the user keeps working.
- **Safety (already in the engine, reused; not rebuilt):** checksum-verified prebuilt,
  atomic symlink switch, post-switch self-check, automatic rollback, user-file
  backups + pre-switch restore, version retention (K=3), divergence fallback to a real
  source build, disk-full halt. New: the state file + run log make the process
  observable and resumable from the UI.

## 6. UI pieces

- `ui-update` (implemented): the bottom-left chrome indicator (the version-free **Update** pill in one restrained accent step; the prepared `Restart to update` state; the quiet executing label), the General-settings update row (`settings.general.item`, order 101, beside the current-version row) that keeps a skipped release updatable with the same controller store/actions (no second polling source), the dialog (versions, scrollable changelog, a quiet inline manual `checkNow` action with its checking/failure states, actions), the prepare/apply progress strip with the switch disconnect warning, and the failure surface (message + log tail + retry/rollback info), plus the post-restart reload with its one-time toast. The dedicated switch lock overlay and the settings knobs stay P5.
- Changelog rendering (implemented, simplified): the aggregated `notes` from the catalog entry are listed verbatim in a generously sized, internally scrolling list; the conventional-commit grouping and the "show all" expander stay deferred.
- Settings (existing settings UI): check frequency, channel, "check automatically" toggle, skip-list management.
- i18n: locale-owned copy in `ui-update` + zh pair (implemented); dialog-state snapshots remain with P5.

## 7. Edge cases

| Case | Handling |
|---|---|
| Branch advanced, its release still building | Catalog carries published releases only; `available` shows the newest published; the divergence path is a runner concern (already fixed). |
| Offline / fetch fails | Silent retry next interval; status stays `unknown`; never blocks the UI. |
| Multiple tabs / devices | One host-side run; all tabs see the same pushed state; other devices check independently. |
| Active agent run during `switch` | Engine waits for the turn/uses its existing quiesce; UI shows "will interrupt" before the user-triggered switch. |
| Update fails + rollback | State `rolledback` with the engine's reason; UI offers Retry / details; the install stays healthy (proven today). |
| macOS vs Linux detach | systemd-run / launchd / setsid ladder; the runner is shell-portable. |
| Movement during a run (channel switch) | `update/start` pins the channel+target at launch; the runner does not re-resolve. |

## 8. Phasing

1. **P1 — Catalog** (implemented): `scripts/update-catalog.mjs` + tests; the `harness-release.yml` catalog job publishes both channel files and the asset pair for every published release (self-healing on re-runs); the schema above and the 40-release cap are enforced. (Small.)
2. **P2 — Host check** (implemented): `enpoi-update-check` profile plugin (interval, fetch, compare, `updateCheck` remote, dismissed store); unit tests with a stubbed catalog. (Small-medium.)
3. **P3 — Indicator + dialog** (implemented): `ui-update` chrome pill in the frame-wide `shell.overlay` + dialog with changelog; i18n en+zh; controller tests, i18n gate, client build. (Medium.)
4. **P4 — Run + progress** (implemented): detached runner launcher (systemd-run / launchctl / setsid / spawn ladder) + `run.json` watcher + progress strip + reconnect/reload, the boot reconcile across the service restart, and the two-phase engine split per decision 2 (`dsh update --prepare` staged record → user-triggered `dsh update --apply`; exact flags and state-file contract in §5). Prepare steps report through the existing `[N/9]` bands 1–7; apply reports 8 (switch) and 9 (self-check). (Medium-large; the core.)
5. **P5 — Polish** (partly implemented with P4): failure surface, skip-list, docs; remaining: the dedicated lock overlay, settings knobs (frequency/channel/auto-check), and macOS launchd path verification.

## 9. Owner decisions (resolved 2026-10-13)

1. **Check cadence**: "every 6 hours + once shortly after web start (jittered)" — implemented as §4 describes.
2. **Lock policy**: "SOFT lock; additionally the final switch/restart must be USER-TRIGGERED (the runner prepares in the background, then the UI offers a 'Restart to update' action). Only design for this now — the runner itself is a later phase." — the P4 shape is recorded in §5 and §8.
3. **Auto-update**: "No automatic updates: manual only, always."
4. **Catalog scope**: "each install checks ITS OWN channel only (stable install → stable catalog; beta → beta). The release workflow maintains the catalog for the channel it released." — implemented in §3: both channel catalogs are mirrored from the one shared release stream, so each install still reads only its own file.
5. **Changelog source**: "commit subjects, zero curation."
