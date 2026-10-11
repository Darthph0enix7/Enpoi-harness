---
description: "Dependency-free delta update engine (design doc 95, P2): manifest hashing, the total preservation/classification matrix, an embedded 3-way merge, staged apply with journal and qualified verification."
kind: "package-reference"
---

# @deepseek-ai/dsh-host-update-engine

English | [中文](README.zh.md)

## Summary

Compute and execute an update between two shipped releases without losing anything the user added or changed. The package is the P2 slice of the optimal install/update design (`dsh-migration/95-optimal-install-update-design.md`): manifest utilities (§2.1), the total decision matrix (§3.2), the embedded 3-way merge net (§3.1–§3.5), and the staged apply with interruption journal and qualified verification (§2.3). It is pure Node/TypeScript with no dependencies, no Cordis, and no host `git`/`diff3`; it operates on explicit tree roots and never guesses a prefix. The updater invokes it later as a CLI over the shipped tree; wiring it into `scripts/install.sh` belongs to P3.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

### CLI

The CLI takes every path explicitly; nothing is derived from an installed layout.

```
dsh-update-engine hash    --root <dir> --out <manifest.json> [--ignore <glob>]...
dsh-update-engine plan    --previous <manifest> --next <manifest> --local <dir> --base <dir>
                          --release <dir> --to-version <v> [--from-version <v>]
                          [--tombstones <file>] [--pins <file>] [--out <plan.json>]
dsh-update-engine apply   --plan <plan.json> --local <dir> --base <dir> --release <dir>
                          --staging <dir> [--journal <file>] [--timestamp <iso>] [--backup <dir>]
dsh-update-engine discard --staging <dir> [--journal <file>]
```

`plan` exits 3 when the plan must abort (runtime-code merge conflict) and 0 otherwise; `apply` exits 0 for applied/no-op/interrupted, 3 for aborted, 4 when a foreign journal requires rollback, and 1 on failure. `--pins` reads `pins.yaml` in either a JSON-array or a simple YAML-list form; `--tombstones` accepts the same forms.

### Programmatic API

`buildPlan` classifies `(previous manifest, new manifest, local scan, tombstones, pins)` into one action per path and resolves every merge in memory; `applyPlan` executes that plan against a staging directory seeded from the local tree; `verifyStagedTree` runs the qualified verification alone; `createBackup` writes the §3.5 pre-update backup latch. The plan is JSON-serializable and fingerprint-bound: `parsePlan` refuses a document whose fingerprint no longer matches its content.

## Understand the implementation

### Manifest rules

A manifest is a JSON object mapping relative `/`-separated paths to `{sha256, size, type, mode, target, binary}` entries, written with sorted keys so identical trees produce byte-identical manifests. Regular files hash their bytes; symlinks hash their target string and record the target; directories are listed with a null hash; `binary` is true when a NUL byte appears in the first 8192 bytes. Modes are POSIX permission bits (`mode & 0o7777`). Every path read from a manifest is validated to stay under its root.

### Decision matrix

The §3.2 matrix is total over the union of the three manifests; each path gets exactly one action. `unchanged/unchanged` skips; `unchanged/changed` replaces; `modified/unchanged` keeps the local file; `modified/changed` runs the 3-way merge; untracked paths are kept; a newly shipped path colliding with an untracked path keeps the user file and writes `<file>.shipped-<version>`; a missing path without a tombstone is restored from the release (`integrity failure`); a tombstone is respected (the local copy is absent after apply). Files only present in the previous manifest are deleted only when unmodified and absent from the new manifest (§3.4), and deletions run last. Pins exclude replacement, merge, and upstream deletion; a pin suppresses nothing when there is nothing to replace, and a missing pinned path is still restored.

### Merge engine

The base is the pristine previous version directory; no remote base bytes are ever fetched. `merge3` computes patience-anchor LCS matches (with a bounded dynamic-programming fallback) and splits the file at lines unchanged in both sides, then applies the diff3 region rules; adjacent different-side changes conflict exactly as GNU diff3 does. The default conflict markers are `<<<<<<< local`, `||||||| baseline`, and `>>>>>>> shipped`. Binary both-changed files are never text-merged: local is kept and the shipped bytes go to `<file>.new-<version>`.

### Conflict severity

Config/data conflicts keep local, write the `.new-<version>` inspection sidecar, and the apply continues. Runtime-code conflicts (`.js`, `.mjs`, `.cjs`, `.jsx`, `.ts`, `.tsx`, `.mts`, `.cts`, `.wasm`, `.node`) mark the plan `switchDecision: 'abort'`: apply writes the inspection sidecars next to the live files and returns without touching staging, so the current version stays active.

### Staged apply and verification

Seeding hardlinks the local tree into staging; every write unlinks its target first and goes through a fixed-name temp file plus rename, so no write can mutate the live tree through a shared inode. A journal binds the staging directory to the plan fingerprint, records each completed action, and is written at every phase. Re-entry with a matching fingerprint resumes idempotently (each action re-checks and repairs its staged state); a mismatching fingerprint is reported as `rollback-required`, because the staging directory belongs to another plan. `stopAfterActions` is the deterministic interruption point used by the crash-recovery tests. Qualified verification accepts a shipped path only at the manifest hash, a preserved path only at its recorded merge-keep/merge-output hash, a tombstone only when absent, and every untracked path when present and listed; it also reports any staged path the plan does not explain. The pass ends by re-hashing the touched live paths and proving their inodes and hashes are unchanged.

### Source map

| File | Role |
|---|---|
| [`src/manifest.ts`](src/manifest.ts) | Tree scan, hashing rules, schema read/write, path safety |
| [`src/plan.ts`](src/plan.ts) | §3.2 classification, merge resolution, fingerprint |
| [`src/diff3.ts`](src/diff3.ts) | Embedded LCS/diff3 merge engine |
| [`src/apply.ts`](src/apply.ts) | Staging seed, copy-on-write actions, journal phases, live-tree gate |
| [`src/verify.ts`](src/verify.ts) | Qualified verification contract |
| [`src/backup.ts`](src/backup.ts) | §3.5 pre-update backup latch |
| [`src/journal.ts`](src/journal.ts) | Journal read/write and phase records |
| [`src/report.ts`](src/report.ts) | Structured + human update report |
| [`src/pins.ts`](src/pins.ts) | Pin/tombstone list parsing |
| [`src/glob.ts`](src/glob.ts) | Relative-path glob matching |
| [`src/cli.ts`](src/cli.ts) | CLI over explicit directories |

## Further Exploration

Start with the design document this package implements, then the updater that will call it.

- [95 — Optimal install & update system](../../../dsh-migration/95-optimal-install-update-design.md) — §2.3 staged apply, §3 preservation matrix, §5 reporting, §8 P2 scope.
- [`scripts/install.sh`](../../../scripts/install.sh) — the existing installer whose `switch_current` pattern P3 reuses.

<a id="model-experience"></a>
## Model Experience

None, as nothing in this package reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Transport, atomic switch, and rollback remain P3.** This package stages a new tree, verifies it, and reports; applying diffs, choosing the ladder rung, and moving `current` are out of scope here.
- **Directories and symlinks are not merged.** A both-changed directory or symlink keeps local and reports; only regular text files reach the merge engine.
- **Deleting a directory never removes untracked content.** A non-empty directory scheduled for deletion is retained and reported as `retained`.
- **The runtime-code split is extension-based.** A binary module path (`.node`, `.wasm`) aborts like other runtime code when changed on both sides.
- **Non-empty tombstoned directories are retained** when untracked content lives inside; verification accepts the retained directory and the report calls it out.
- **The backup latch copies a directory, not a tar.** Modified and untracked files are copied byte-for-byte plus a `baseline.json`, which keeps the dependency-free constraint.
- **Case-insensitive filesystem behavior is not exercised here** (design §7.5); it needs the platform acceptance lane.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

Decisions the design left open, recorded here so P3 and the CI manifest emitter stay consistent:

- Symlink hash input is the raw target string (`sha256(target)`), and the entry records `target` plus the lstat mode.
- Sidecar naming: `.shipped-<version>` carries the newly shipped bytes when an untracked file collides; `.new-<version>` carries the conflict-marked merge attempt (or the shipped bytes for binary/type conflicts).
- A merge keeps the local file mode, so a user mode-bit edit survives a content merge.
- Config/data conflicts continue even when a text merge produced conflict markers; only runtime-code conflicts abort.
- `stopAfterActions` and the explicit `timestamp` exist to keep apply deterministic and testable; production callers pass the real timestamp and omit the interruption point.
- Journal default location is `<stagingRoot>.journal.json` (outside the staged tree), so a staging scan never sees the journal.

</details>
