# dsh-enpoi-update-check

English | [中文](README.zh.md)

The host-side update check and in-app update run (docs/plan/ui-update-manifest.md
P2 + P4): it reads the per-channel update catalog, compares it with this
install's recorded version, and exposes the result as the `updateCheck` Remote
namespace. The check is advisory; a run starts only from an explicit
`updateCheck.start`, where the operator's `[Update now]` click IS the restart
decision — the run then proceeds to switch and restart on its own.

## What it does

- Checks the catalog for **this install's channel** (`install-state.json` →
  `channel`; `stable` when absent or unreadable), a jittered ~30 s after boot
  and then every `intervalMinutes` (+ jitter).
- The catalog URL follows the contract `harness-release.yml` publishes:
  `https://raw.githubusercontent.com/Darthph0enix7/Enpoi-harness/catalog/<channel>.json`
  (branch `catalog`, file `<channel>.json` at the branch root; the same JSON
  ships as the `update-catalog-<channel>.json` release asset).
- Compares `install-state.json` `version`/`commit` (version falling back to the
  running tree's `package.json`) against the newest catalog entry. The version
  comparator orders the `0.1.7-enpoi.<n>` shape numerically; an unparseable
  version leaves the state `unknown`.
- States: `unknown` (never fetched, or a failure with no prior success) →
  `current` → `available` → `dismissed`. A failure keeps the last successful
  comparison and records `error`; a newer catalog version re-arms `available`
  after a skip.
- Fully fail-soft: one bounded fetch (15 s timeout) per attempt, no retries
  before the next interval, at most one debug log line per failed attempt.
- Persists the skip in `$DSH_HOME/update-check/dismissed.json` (atomic write;
  storage failure degrades to "nothing dismissed").

## Configuration

Patch row id `enpoi-update-check`:

```yaml
- id: enpoi-update-check
  name: 'dsh-enpoi-update-check'
  config:
    enabled: true
    intervalMinutes: 360
    jitterSeconds: 300
```

`enabled: false` stops the timer only; `updateCheck.checkNow` still works.

## Remote surface

| Method | Request | Result |
|---|---|---|
| `updateCheck.status` | — | `{ state, current: { version, commit, channel }, latest?: { version, commit, releasedAt, notes }, checkedAt?, error? }` |
| `updateCheck.checkNow` | — | the status after one check (single-flight with the timer; never rejects) |
| `updateCheck.dismiss` | `{ version }` | the status after recording the skip (`gateway/bad-request` when `version` is missing) |
| `updateCheck.start` | — | the fresh run record (`phase: 'starting'`); `gateway/bad-request` when no update is available, a run is already active, the shim is missing, or the launch fails |
| `updateCheck.run` | — | the current run record, or null when this install never started one |

There is no client push in this plugin family; clients poll `updateCheck.status`
and, while a run is active, `updateCheck.run`.

## Running the update (P4)

`updateCheck.start` pins the available target and channel, writes
`$DSH_HOME/update-check/run.json`, truncates `$DSH_HOME/update-check/run.log`,
and launches the installed `dsh` shim detached as
`dsh update --channel <channel>`:

- Linux: `systemd-run --user --unit=dsh-update-<runId> --collect --wait`;
  macOS: `launchctl submit -l com.dsh.update.<runId>`; fallback everywhere:
  `setsid` and finally a bare detached `sh`. Every rung runs the same POSIX
  wrapper, which records the updater's own pid in
  `$DSH_HOME/update-check/run.pid` and redirects stdout+stderr into `run.log`.
- A watcher polls the log tail (1 s) and refreshes the record: `step`/`steps`
  from the engine's `[N/9]` markers, `lastLine`, a bounded 40-line `logTail`,
  and `phase` from the documented step-band table (1–2 fetch, 3 verify,
  4 unpack, 5 deps, 6–7 profile, 8 switch, 9 selfcheck). Terminal result lines
  set `result` (`success` / `failed` / `rolledback`); an exit without one is
  `failed` with the last line as the reason.
- The service restarts at the switch, so the watcher dies with it. On plugin
  boot the record is reconciled: a still-live updater resumes the watcher; the
  install version already equal to the run's target records `success`;
  anything else is `failed` with an explicit reason. Reconcile is idempotent
  and never deletes the log (the UI tails it).

## Where it is mounted

As a host bundle from `profile/web/package.json` (`dsh.profile.bundles`), with
its mount row in this package's `cordis.patch.yml` (id `enpoi-update-check`).

## Build

```sh
bash profile/web/build-plugins.sh profile/web
```

## Tests

```sh
cd profile/web && ./node_modules/.bin/vitest run packages/enpoi-update-check
```
