# UI Update Manifest + In-App Updates — Plan

Status: P1 (catalog) + P2 (host check) implemented on `local/serverlocal` (2026-10-13); P3+ proposed. The five owner decisions are resolved in §9.

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

- Trigger: the UI calls `update/start`; the host validates (no run active, disk ok),
  then **launches a detached runner**:
  - Linux: `systemd-run --user --unit=dsh-update-<ts>` (transient, survives the web restart).
  - macOS: `launchd` transient job (the installer already owns launchd handling); fallback
    `setsid nohup` where neither exists.
  - The runner = the existing installer in its JSON mode
    (`DSH_JSON=1 scripts/update.sh --channel …`), unchanged engine, or `--no-prebuilt`
    when the user asks for a source build.
- **Two-phase runner (from decision 2):** the runner first prepares the update fully in the background — fetch, verify, unpack, deps, profile — while the user keeps working; preparation alone never switches. When the prepared tree is complete the run state becomes `ready`, and the UI offers a user-triggered **`Restart to update`**; only that action performs the switch + service restart, so the soft lock covers the switch → reconnect window rather than the whole download.
- **Progress contract:** the runner writes `harness/update-state.json` at every substep
  and a line per event to a run log:
  ```jsonc
  { "runId": "…", "phase": "fetch|verify|unpack|deps|profile|switch|selfcheck|health|done|failed|rolledback",
    "step": 3, "steps": 9, "bytesTotal": 319651879, "bytesDone": 137000000,
    "message": "Unpacking prebuilt release", "startedAt": …, "pid": …, "result": "…" }
  ```
  The host streams this (poll 1 s while a run is active) to clients via the existing
  push channel; the dialog renders phase + bar from `bytesDone/bytesTotal` or step N/9.
- **Survival:** closing the browser changes nothing (the runner is a unit/process of its
  own). If the *service* restarts mid-run, the runner keeps going and its state file is
  read again after reconnect. A stale-run lock (pid + startedAt) prevents double runs;
  a crashed runner leaves `failed` state with the log tail for **Retry**.
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
3. **P3 — Indicator + dialog**: `ui-update` chrome pill + dialog with changelog;
   i18n + snapshots. (Medium.)
4. **P4 — Run + progress**: detached runner launcher + `update-state.json` contract + host streaming + progress strip + reconnect/reload; two-phase per decision 2 (prepare in the background → `ready` → user-triggered `Restart to update` performs switch + service restart). (Medium-large; the core.)
5. **P5 — Polish**: lock overlay, skip-list, failure surfaces,
   docs; macOS launchd path verification. (Medium.)

## 9. Owner decisions (resolved 2026-10-13)

1. **Check cadence**: "every 6 hours + once shortly after web start (jittered)" — implemented as §4 describes.
2. **Lock policy**: "SOFT lock; additionally the final switch/restart must be USER-TRIGGERED (the runner prepares in the background, then the UI offers a 'Restart to update' action). Only design for this now — the runner itself is a later phase." — the P4 shape is recorded in §5 and §8.
3. **Auto-update**: "No automatic updates: manual only, always."
4. **Catalog scope**: "each install checks ITS OWN channel only (stable install → stable catalog; beta → beta). The release workflow maintains the catalog for the channel it released." — implemented in §3: both channel catalogs are mirrored from the one shared release stream, so each install still reads only its own file.
5. **Changelog source**: "commit subjects, zero curation."
