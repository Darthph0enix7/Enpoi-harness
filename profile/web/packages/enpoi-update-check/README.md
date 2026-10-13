# dsh-enpoi-update-check

English | [中文](README.zh.md)

The host-side update check (docs/plan/ui-update-manifest.md P2): it reads the
per-channel update catalog, compares it with this install's recorded version,
and exposes the result as the `updateCheck` Remote namespace. Advisory only —
no download, no switch, no auto-update; the user-triggered restart flow is a
later phase.

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

There is no client push in this plugin family; clients poll `updateCheck.status`.
The P3 UI surface owns any push.

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
