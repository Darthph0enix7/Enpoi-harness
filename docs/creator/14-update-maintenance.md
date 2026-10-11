# 14 — Update system maintenance

Read this when you are about to update a device, an update behaved unexpectedly, you need to change what an update preserves (pins, tombstones), or you maintain disk and retention hygiene around the update system. File 02 owns the install/update mechanics — the ladder, the preservation net, the report, rollback; this file owns the maintenance procedures and the update failure table.

Conventions. `$PREFIX` is the install root (default `$HOME/.dsh`); `$DSH_HOME` is the harness home (default `~/.dsh`, recorded in `<prefix>/harness/install-state.json`); `<version>` names a directory under `$PREFIX/harness/`; `$PROFILE` is the active profile dir (default `$DSH_HOME/profiles/web`). Every path and flag below is verifiable from `scripts/install.sh`, `scripts/update-inspect.mjs`, `scripts/update-delta.mjs`, and `packages/host/update-engine/` — cite them when explaining. Never run a service restart from inside a turn: use `dsh restart --after-turn` (02 §5).

## 1. What a run leaves on disk

| Path under `$PREFIX/harness/` | Content and lifetime |
|---|---|
| `<version>/` | A completed version tree; `.dsh-install-complete` is its identity marker. `current` is a symlink to the active one. Newest K kept (`DSH_KEEP_VERSIONS`, default 3); the installed and previous trees are always pinned into K. |
| `.staging-<to>/`, `.staging-<to>.journal.json`, `.staging-<to>.owner` | Apply staging (seeded from the active tree by hardlink copy-on-write) plus the engine resume journal and the owner PID. Removed on success; kept after an interruption so a re-run resumes. |
| `.update-<to>-<pid>/`, `.release-<to>-<pid>/`, `.base-<from>-<pid>/` | Per-run scratch: fetched manifests, the extracted diff view, the extracted pristine base, the structured result. Removed at the end of the run. |
| `.bases/<version>.tar`, `.bases/<version>.tar.gz` | The retained pristine archive per installed version — the merge base for the *next* update (copied from the cached full release or synthesized from the verified staging tree). Removed together with its version tree by retention K=3; orphaned slots (no matching version tree) are reaped on the next update. §2 has the disk accounting. |
| `.cache/` | Resumable release downloads: platform tarballs (newest 2), manifests and diff artifacts (newest 4), each with its `.sha256`. `dsh clean` removes the whole cache. |
| `.backup-<ts>/` (and `-tree`, `-pre-migration`, `-pre-switch` variants) | Backup sets: the user-file snapshot under `root/`, the engine's modified-and-untracked tree latch with `baseline.json`, the pre-migration `$DSH_HOME` snapshot (the rollback source), and the forensic pre-switch snapshot. Newest 5 kept per location. |
| `.last-update-<version>.json`, `.last-update-<version>.txt` | The update report (§6). Kept by run: the JSON and human file of one update count as a single unit, newest 3 runs survive. |
| `<version>.failed-<ts>/` | A failed tree kept for diagnosis; newest 2 (`DSH_KEEP_FAILED`). Never a rollback target. |
| `install-state.json`, `../logs/install.log` | Recorded install state and the run log (`$DSH_HOME/diagnostics/update.jsonl` holds one ledger row per run). |

- `$DSH_HOME/update/pins.yaml` and `$DSH_HOME/update/tombstones.txt` are operator-written preservation controls (§4); an apply only reads them — the explicit `dsh update --forget` / `--accept-shipped` flags are the sanctioned writers.
- The profile side keeps its own backups: `$PROFILE/.backup-<ts>/` and `<file>.backup-<ts>` beside the live patch/manifest, newest 5 each (`scripts/install.sh` prune_update_artifacts).

## 2. Retention and disk hygiene

- Knobs: `DSH_KEEP_VERSIONS` (version trees retained after a successful update; default 3, values below 2 are clamped up) and `DSH_KEEP_FAILED` (failed trees kept; default 2). Pruning runs after every successful update and logs each removal with the freed size.
- `$PREFIX/.pnpm-store/` is the pnpm content-addressable store every installer-driven profile/harness install uses (`--store-dir` plus an exported `npm_config_store_dir`). It lives beside the version trees so it survives switches, and it is the sandbox-safe location: the default store under `~/.local/share/pnpm` is outside agent-sandbox allowed roots and fails with EROFS on the operation lock. It is never pruned automatically — `du -sh "$PREFIX/.pnpm-store"` reports it, and deleting it by hand is safe (the next install re-downloads). Normal terminal runs use the same store deliberately, so agent-driven and terminal updates share one cache instead of diverging.
- The pnpm version is pinned per install: the profile's `packageManager`, else the installed tree's (the release pins it), activated through `corepack prepare --activate`. A profile without its own pin therefore cannot drift across pnpm majors; `DSH_PNPM_PIN=0` opts out (the ambient/corepack default is used and the drift risk returns).
- Inspect before deleting anything: `ls -1dt "$PREFIX/harness"/*/` lists trees newest-first; `ls -d "$PREFIX/harness"/*.failed-*` lists failed trees; `du -sh "$PREFIX/harness"/* "$PREFIX/harness"/.bases "$PREFIX/harness"/.cache` shows where the space went.
- `dsh clean --dry-run` (the `--clean` mode) lists exactly what a clean would remove — failed trees, incomplete trees untouched for 2 h (a concurrent build is skipped), staging/scratch directories, the download cache, and temp profile-build dirs — and writes nothing; `dsh clean` performs it. User data under `$DSH_HOME` (sessions, settings, credentials) is never touched.
- `.bases/` prunes automatically with version retention: a base archive is removed together with its version tree, and orphaned slots (no complete version tree, including crash leftovers) are reaped on the next update; the apply UX reports the retained archive and its size (`merge base: retained for <v> — ...`). Never delete the base of a tree still retained — the next update from that tree then degrades to keep-local-plus-sidecar for files changed on both sides.
- Never remove `harness/current`, the tree it points to, a retained tree's `.dsh-install-complete`, or a `.staging-*` directory whose `.staging-<to>.owner` PID is still alive — that is another update mid-apply.
- Disk pressure: an update fails cleanly before the switch when it runs out of space (`current` stays active); the staging seed is hardlinks, but downloads, the diff chain, and backup sets need real space. Run `dsh clean`, then re-run `dsh update`.

## 3. Reading `dsh update --dry-run`

The command prints the installer plan first (active tree/version/build commit, target, profile, step list, rollback line) and then, for a published release, the read-only manifest inspection (02 §4). The inspection lines and their meanings:

- `ladder: rung 0 — already up to date (...)` — the installed version is the newest release; a re-run still refreshes the profile but downloads no tree.
- `ladder: rung 1 — consecutive-diff: diff-<os>-<arch>-<from>-<to>.tar.gz (X vs full Y, n%)` — one diff from the installed release applies; `rung 2` names the chain joined with ` + ` (each hop from its own release).
- `ladder: rung 3 — full tarball <name> (Y)` plus the `reason:` line — no usable diff chain (pre-manifest install, channel switch, more than three hops, missing asset/chain break, release metadata unavailable); the full tarball is the safe path, not an error.
- `changed: N path(s), raw X` and the sample lines `path (size)` — release-side changes between the installed version's manifest and the target manifest; `modeChanges` counts mode-only changes. These are not local edits.
- `deletions: N candidate(s); A would be deleted, K kept (locally modified)` with `- would delete:` / `- kept:` lines — shipped files absent from the target; a locally modified file is never deleted.
- `local: M modified, O mode-only, ! missing, + untracked (+N installer state)` with `~`, `m`, `!`, `+` sample lines — the live tree classified against the installed manifest. `~` modified files are preserved (kept, merged, or sidecar'd), `+` untracked files are always kept, `!` missing shipped files are restored unless tombstoned, `m` mode-only differences are applied to shipped files.
- `baseline:` names the manifest asset the classification used; `unavailable` is honest (pre-manifest install or the release asset is missing), not a failure.
- `pins:` / `tombstones:` name how many entries would be respected; `none (no file at ...)` means the file does not exist.
- `note:` lines name every degraded conclusion (no reachable release, missing input, source build). Nothing here is guessed.

Read-only guarantee: no lock is taken, no log file or staging directory is created, manifests are decompressed in memory, and artifact sizes are probed with network requests. `dsh update --dry-run --json` emits one object with `schema: dsh-update-inspection/1` and the keys `target`, `installed`, `ladder`, `changed`, `deletions`, `localChanges`, `baseline`, `pins`, `tombstones`, `notes` (a skipped inspection emits an object with `available: false` and a note) for scripts.

## 4. Pins and tombstones (how-to)

- **Keep a path through every update (pin).** Write the relative path or glob into `$DSH_HOME/update/pins.yaml`, one entry per line under `pins:` or as plain one-per-line entries (`- path` rows, `#` comments, and quoted paths are accepted):

```yaml
pins:
  - packages/core/session/src/index.ts
  - profile/web/packages/enpoi-*/**
```

- A pinned file is excluded from replacement, 3-way merge, and upstream deletion; the dry run reports how many changed paths the pins would match and the apply report lists every skipped pin. Removing the line resumes normal handling; a missing pinned path is still restored from the release (a pin suppresses replacement, not restoration).
- **Keep a shipped file deleted (tombstone).** Record the relative path in `$DSH_HOME/update/tombstones.txt`, one path per line (`tombstones.yaml` is read when the `.txt` is absent; `#` comments and quoted paths are accepted):

```
packages/client/ui-settings-models/src/client/heavy-providers.ts
```

- A tombstoned path stays absent across updates. If a file still exists at that path and diverges from what was recorded as forgotten, the update keeps the user's bytes and reports the divergence instead of silently removing them.
- **CLI parity (the same edits without hand-editing).** `dsh update --forget <path>` appends the path to `tombstones.txt` before the update plans, so the same run already respects it; re-recording an existing entry is a reported no-op (`already`). `dsh update --accept-shipped <path>` removes that path's pin from `pins.yaml` and, when the installed version's pristine archive is present and checksum-verified, restores the shipped file into the active tree immediately (the archive is the release tree by construction, so the member carries the file at its manifest hash); without that archive the pin is still removed and the next update takes the shipped file — the run says which happened. Both flags are repeatable, take relative paths only (absolute paths, `..`, backslashes, and control characters are refused loudly), report through `--dry-run` as `would ...` lines without writing, and appear in `--json` as `updateActions.forgot[]` (with `recorded`/`already`/`refused`) and `updateActions.acceptedShipped[]` (`{path, restored, note}`).
- Both files are read at plan time from the paths above, and the two flags write them just before planning; edits take effect on the next dry-run or apply, with no restart. A pin or tombstone that lists no dry-run match usually has a typo or points outside the harness tree — patterns are relative to the version tree root.

## 5. Interrupted updates

- **Download interruption.** Nothing is installed and `$DSH_HOME` is untouched; re-run `dsh update`. Resumable downloads pick up from `<prefix>/harness/.cache`.
- **Apply interruption.** A delta rung that is interrupted prints "apply interrupted; the staged tree and its journal were kept. resume: re-run 'dsh update'" and appends `delta-interrupted` to the ledger; re-running the same command on the same target re-enters the journal and completes idempotently (each action re-checks and repairs its staged state). A full-tarball apply that is interrupted discards its staging and says "re-run 'dsh update'" — the next run rebuilds the staging seed and applies again.
- If the staging directory belongs to a different plan (fingerprint mismatch), the engine reports `rollback-required`, the updater discards that staging and retries once; if it still mismatches, it falls back to the full path (delta) or the legacy path (full). Nothing the user owns is lost in either case.
- An interrupted or failed download is not an interrupted apply: no `.staging-*` remains, so there is nothing to resume beyond re-running.
- The `current` symlink is renamed over atomically: after any interruption it points at a complete tree, never at half of one.

## 6. The update report

- After an apply, stdout shows the transport rung and downloaded-vs-full bytes, then `update: <from> -> <to>; N replaced, N added, N restored, N merged, N kept local, N untracked kept, N pinned, N deleted, N conflict(s)` and the report path.
- `<prefix>/harness/.last-update-<version>.json` is the structured result: `status`, `transport` (`mode` `delta`/`full`, archives, hops, base mode), `plan.counts`, `plan.conflicts`, `report.preserved` (every path kept and why), `report.sidecars`, `report.deletions`, `report.pinned`, and `verification` (`ok`, counts, mismatches). Query it with `jq`, e.g. `jq '.verification.ok, .report.preserved' "$PREFIX/harness/.last-update-<version>.json"`.
- `<prefix>/harness/.last-update-<version>.txt` is the deterministic human report: per-action counts, every conflict with severity and sidecar, every preserved path with its reason, deletions, skipped pins, sidecars, the backup directory, bytes written/replaced, and the verification summary. An aborted run writes the same two files before exiting (`delta-aborted`), so the conflict list survives the non-switch.
- `$DSH_HOME/diagnostics/update.jsonl` records the outcome of every run (`migrated`, `migrated-partial`, `install-failed`, `profile-failed`, `migrations-failed`, `delta-interrupted`, `delta-aborted`, `rolled-back`, `rolled-back-partial`); `jq` it or read it with the other diagnostics in file 11.
- Sidecars live next to the affected file: `<file>.shipped-<version>` (newly shipped bytes colliding with an untracked file), `<file>.new-<version>` (the merge attempt or the shipped bytes for a binary/type conflict). They are for inspection; delete one after reconciling the file, then re-run.

## 7. Rollback

- Automatic: a failure after the `current` switch repoints `current`, restarts the recorded unit back onto the previous tree, restores the pristine pre-migration snapshot, archives the failed tree as `<version>.failed-<ts>`, appends `rolled-back`, and exits 1 (02 §6). A failure before the switch never changes `current`; the incomplete staging is discarded.
- Diagnosis after an automatic rollback: read `$PREFIX/harness/<version>.failed-<ts>/logs` and `<prefix>/logs/install.log`, the two report files, and the ledger row. If the previous tree also fails its self-check, treat it as a host problem (Node, disk, permissions), not an update problem.
- Manual rollback to an older retained tree (from outside the session hosting the work):

```sh
ls -1dt "$PREFIX/harness"/*/                      # completed trees, newest first
ln -sfn "$PREFIX/harness/<version>" "$PREFIX/harness/current"
# restore operator files if the run had migrated $DSH_HOME:
#   cp -a "$PREFIX/harness/.backup-<ts>-pre-migration/root/." /
dsh restart --now
dsh doctor
```

- Restore user files from the matching backup set's `root/` (or the `-pre-migration` set) before restarting when the failed run had reached migrations; profile-side files restore from `$PROFILE/.backup-<ts>/`.
- After a rollback to an older build, sessions written by the newer format are refused and never rewritten (02 §2); that is expected, not corruption.

## 8. Update failure table (symptom → cause → fix)

| Symptom | Cause | Fix |
|---|---|---|
| Dry run shows `baseline: unavailable` and rung 3 for a same-line version jump | The installed release predates manifest emission, or its manifest asset is missing | Expected legacy path; the first manifest-era update to a tree with retained manifests arms diffs (degradation is reported, never guessed) |
| Dry run `changed:` lists paths you did not touch | These are release-side differences between the two manifests | Read the release assets; pin a path only if the shipped change must not land |
| Dry run `local:` shows an unexpected modified/untracked entry | The classification is against the installed release manifest; your edits and installer state appear there | Inspect the file; pin it if it must survive, or accept the merge/preservation |
| Update aborts: "runtime-code merge conflicts; `current` stays active" | A runtime-code file was edited locally and also changed upstream | Reconcile with the `<file>.new-<version>` sidecars; delete a sidecar after reconciling; or pin the file; then re-run |
| "apply interrupted; re-run 'dsh update'" | The apply process died mid-run (delta rung: staging and journal kept; full rung: staging discarded) | Re-run the same command — the delta journal resumes; a foreign staging is discarded and retried once |
| Update fails before the switch; `current` unchanged | Build/download/migration failure | Read `<prefix>/logs/install.log` and the ledger row; fix the cause (often disk space: `dsh clean`), re-run |
| Post-switch self-check fails and the run rolls back | The new tree failed its smoke checks | Inspect `.failed-<ts>` and the backups; if the previous tree also fails, the host (Node, disk, permissions) is the problem |
| Every update lands on rung 3 | No consecutive diff exists for the installed version (pre-manifest install, channel switch, more than three hops, or the previous release has no manifest) | Expected; rung 3 is the preservation-applied full tarball |
| Both-changed files were "kept local with sidecars" instead of merged | No pristine merge base archive for the installed version (`.bases/<version>.tar*` missing or its checksum failed) | Zero-loss degradation; keep or reconcile the file, a later full update restores merge fidelity |
| Two updates at once: "another update is already running" | The single-updater lock | Wait for the running update; remove `.update.lock.d` only when its recorded PID is dead |
| A pinned file still changed | The pin pattern matched nothing (typo, or a path outside the tree) | Check the dry run's pins line for the matched count; fix the pattern |
| A tombstoned file came back | The tombstone matched nothing, or the local file diverged (reported) | Check the dry-run tombstone line; fix the path or remove the diverging file |
| `$PREFIX/harness/.bases` grows with every version | No automatic GC for retained merge bases | §2: delete `.bases/<version>.tar*` for versions without a retained tree |

## 9. Evidence locations

`<prefix>/logs/install.log` (run log), `$PREFIX/harness/.last-update-<version>.{json,txt}` (reports), `$PREFIX/harness/.backup-<ts>-*` (snapshots, tree latch with `baseline.json`), `$PREFIX/harness/<version>.failed-<ts>/` (failed tree), `$DSH_HOME/diagnostics/update.jsonl` (ledger), `$DSH_HOME/diagnostics/incidents.sqlite` and `dsh doctor` (host health; file 11). When reporting an update problem, cite the ledger row plus the two report files and the transport rung.
