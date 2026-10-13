# UI Update Manifest + In-App Updates — Plan

Status: P1 (catalog), P2 (host check), P3 (client UI), and P4 (run surface + the two-phase engine split) are implemented on `local/serverlocal` (2026-10-13). The five owner decisions are resolved in §9; decision 2's prepare-then-apply split ships as engine flags `dsh update --prepare` / `dsh update --apply` (§5), and the shipped run reconciles across the service restart it causes (§5, reconcile).

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
- **Progress contract (implemented):** the shipped watcher derives progress from the runner's `[N/9]` step lines in `$DSH_HOME/update-check/run.log` plus the terminal result lines (`successfully updated` / `FAILED` / `rolled back`), and persists the pollable record to `$DSH_HOME/update-check/run.json` (`{runId, target, channel, phase, step, steps, lastLine, startedAt, pid, logPath, result, rung, logTail, finishedAt?, reason?}`). The step-band table is `1–2 fetch, 3 verify, 4 unpack, 5 deps, 6–7 profile, 8 switch, 9 selfcheck`, with `done`/`failed`/`rolledback` terminal phases. The originally proposed engine-side `harness/update-state.json` with byte counts is not consumed; byte-level progress stays deferred, and clients poll `updateCheck/run` (the UI polls ~2 s only while a run is active) instead of a host push.
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

- `ui-update` (new client package): a chrome indicator (version pill, subtle dot),
  the dialog (versions, changelog list, estimate, actions), the progress strip, the
  lock overlay, the failure surface (message + log tail + retry/rollback info).
- Changelog rendering: the aggregated `notes` from the user's version (exclusive) up to
  the newest, grouped by conventional-commit type (feat/fix/chore), capped with a
  "show all" expander.
- Settings (existing settings UI): check frequency, channel, "check automatically" toggle, skip-list management.
- i18n: locale-owned copy in `ui-update` + zh pair; snapshots for the dialog states.

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
