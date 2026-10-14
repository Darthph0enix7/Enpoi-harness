# dsh-enpoi-update-check

English | [中文](README.zh.md)

The host-side update check and two-phase in-app update run
(docs/plan/ui-update-manifest.md P2 + P4): it reads the per-channel update
catalog, compares it with this install's recorded version, and exposes the
result as the `updateCheck` Remote namespace. The check is advisory; a run
starts only from an explicit `updateCheck.start`. The operator's
`[Update now]` click is the consent to **prepare** (`dsh update --prepare`),
the staged tree waits in `$PREFIX/harness/.staged-apply.json`, and the
`[Restart to update]` click **applies** it (`dsh update --apply`: switch,
service restart, self-check, health, retention).

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
| `updateCheck.dismiss` | `{ request: { version } }` | the status after recording the skip (`gateway/bad-request` when `version` is missing) |
| `updateCheck.start` | — | the fresh record (`mode: 'prepare'` on a two-phase engine, `mode: 'one-shot'` on an older one, `phase: 'starting'`); `gateway/bad-request` when no update is available, a run is active, an update is already prepared, the shim is missing, or the launch fails (including no resolvable Node.js runtime) |
| `updateCheck.apply` | — | the fresh apply record (`mode: 'apply'`, `phase: 'applying'`); `gateway/bad-request` when nothing is staged or the launch fails |
| `updateCheck.run` | — | the current run record, or null: the plugin's own run when one is executing, otherwise a live run observed from the engine marker (a `dsh update` started in a terminal), otherwise the persisted record |
| `updateCheck.cancel` | — | the engine cancel outcome (`cancelled`/`refused`/`noop`/`failed`) with its message and the resulting record (`cancelled` on success); `gateway/bad-request` only when the shim is missing |
| `updateCheck.clearStale` | — | the record after stale state was cleared; `gateway/bad-request` while a run or the engine's lock is genuinely live (the message names it) |

The Remote arguments mirror the descriptors' **parameter names**: `dismiss`
wraps its `request` object (`payload.args.request.version`), every
no-parameter method takes an empty `args` object. There is no client push in
this plugin family; clients poll `updateCheck.status` and, while the engine
process executes, `updateCheck.run`.

## Running the update (P4)

`updateCheck.start` pins the available target and channel, writes
`$DSH_HOME/update-check/run.json`, truncates `$DSH_HOME/update-check/run.log`,
and launches the installed `dsh` shim detached. `updateCheck.apply` repeats
that against the recorded staged tree. A dismissed ("skipped") version stays
startable — the skip only hides the client indicator, and the Settings control
re-arms the update — while an already-prepared update is deliberately refused
by `start` (`already-prepared`): the staged target is pinned by the engine's
record, so the offered action is Restart to update.

- **Capability probe.** The two-phase flags only exist in newer engines, so
  the controller probes the installed shim once per plugin boot
  (`<shim> update --help`, bounded at 10 s) and caches the answer. Only help
  output naming `--prepare` counts as supported; a probe failure, timeout, or
  empty output defaults to UNSUPPORTED because guessing wrong would break the
  very first update on an old device.
- **Rungs.** The one-shot rung exports `DSH_UPDATE_MODE=one-shot` so the
  engine's marker labels the no-flag run. A supported engine gets `dsh update --channel <c> --prepare`
  (`rung: 'two-phase'`): the run stages the tree and rests at `prepared` until
  `apply`. An older engine gets the one-shot `dsh update --channel <c>`
  (`rung: 'one-shot'`): the run includes the switch and service restart
  itself, never becomes `prepared`, and `updateCheck.apply` refuses it with a
  clear "nothing to apply" message. `launcher` records the OS rung
  (`systemd-run|launchctl|setsid|spawn`); `rung` records the engine
  generation.

- **Launch environment.** The web service's environment is not the login
  environment, so the launcher probes for a Node.js runtime itself — the
  install's recorded `$PREFIX/runtime/node/current/bin`, the nvm layout
  (`$HOME/.local/share/nvm/<version>/bin`, then `$HOME/.nvm/versions/node/<version>/bin`,
  newest first), the inherited `PATH`, then common system directories — and the
  wrapper exports the composed `PATH` plus `DSH_HOME`/`PREFIX` before exec'ing
  the shim. Nothing resolving fails the run with that list in run.json's
  `reason`, never as a cryptic engine line.
- **Ladder.** Linux: `systemd-run --user --unit=dsh-update-<runId> --collect
  --wait`; macOS: `launchctl submit -l com.dsh.update.<runId>`; fallback
  everywhere: `setsid`, then a bare detached `sh`. Every rung runs the same
  POSIX wrapper, which records the updater's own pid in
  `$DSH_HOME/update-check/run.pid` and redirects stdout+stderr into `run.log`.
- **Phases.** Two-phase: `starting` → `preparing` → `prepared` (the prepare
  process exited 0 and left the staged marker; nothing is watched while it
  waits) → `applying` → `success | failed | rolledback`. One-shot:
  `starting` → `preparing` → `success | failed | rolledback` (never
  `prepared`). The watcher polls the log tail (1 s) and the wrapper pid file:
  `step`/`steps` from the engine's `[N/9]` markers, `lastLine`, a bounded
  40-line `logTail`, and the terminal result lines (`successfully updated` /
  `Update applied:` / `FAILED` / `rolled back`).
- **Engine marker & terminal-started runs (implemented).** The running
  installer's marker (`$PREFIX/harness/.update-run.json`: `runId, pid, mode
  (plain|prepare|apply|one-shot), step, steps, phase (running → switching →
  applying → done, terminal failed/rolledback/cancelled), startedAt, logPath,
  version, target`) lets the plugin observe an update started outside the UI:
  `updateCheck.run` reads it on each call (a small file; no watch), verifies
  the pid is live and not a zombie (`kill 0` + `ps -o stat=` / `/proc`), and
  synthesizes a record whose mode/phase map onto the same client states
  (`plain`/`one-shot` → one-shot-style rung, `running` → `preparing`,
  `switching`/`applying` → `applying`, terminal phases → their results,
  `logTail` from the marker's `logPath`). A stale dead-pid marker reports
  nothing. A surviving plugin run reconciles with the marker's pid/phase when
  the marker names the same run.
- **Cancel (implemented).** `updateCheck.cancel` shells the installed shim
  (`dsh update --cancel --json`, bounded 30 s) so every safety rule stays in
  the engine: SIGTERM → bounded wait → SIGKILL, refusal past the switch,
  partial sweeps, marker → `cancelled`. The plugin relays the outcome; a
  successful cancel becomes a `cancelled` record (the plugin's own when it
  started the run, otherwise one synthesized from the terminal marker) and a
  refusal surfaces the engine's message.
- **Stale state & self-healing (implemented).** Liveness is one truth: a run is
  live only when its pid is live and non-zombie AND its log moved inside the
  stall window (`RUN_STALE_WINDOW_MS`, 5 min), and terminal phases
  (`failed`/`rolledback`/`cancelled`/`done`) are never live regardless of a
  recycled pid. Every `run` read, the boot reconcile, and the `start`/`apply`
  gates heal a stale persisted record into a terminal one (success when the
  install already reached the target, otherwise `failed` with a clear reason)
  and drop the dead pid file, so stale state can never block a new run. The
  gates also consult the engine's own truth — a live non-terminal non-stalled
  marker, or the mkdir-fallback lock's live owner pid (the flock file's
  presence means nothing) — and defer to the engine when it really holds the
  lock (its refusal is precise). `updateCheck.clearStale` exposes the same
  healing to the UI: it refuses while anything is genuinely live, never
  touches the engine marker or the staged tree, and returns the terminal
  record. A failed apply whose staged marker is still valid is **re-appliable
  without a new prepare** — `apply` re-validates against the staged record and
  pins the staged version as the target — which is what the dialog's
  *Clear update state & retry* uses after a stale already-running failure.
- **Restart reconcile.** Either rung's switch restarts the service, so the
  watcher dies with it. On plugin boot the record is reconciled against the log
  tail (a terminal line the watcher missed), the staged marker, and the install
  identity: a prepared record with its marker survives untouched; a still-live
  updater resumes the watcher; an install version equal to the target is
  `success`; anything else is `failed` with an explicit reason. Reconcile is
  idempotent and never deletes the log (the UI tails it).

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
