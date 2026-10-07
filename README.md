# Enpoi Harness

English | [中文](README.zh.md)

The Enpoi Harness is **upstream [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`) plus our operator profile**: a curated bundle of providers, orchestration, diagnostics, UI surfaces, and a frozen default skin that turns the all-plugin `dsh` runtime into a working multi-model fleet.

- Runtime and packages up to `packages/` are upstream, with a small set of fork patches (`patches/`).
- Everything in `$DSH_HOME/profiles/<name>` (default profile: `web`) is ours: the `dsh-enpoi-*` bundle packages, the default skin, the fleet presets, the gates, and the Creator docs.
- Documentation for operating the harness: **[docs/creator/](docs/creator/00-index.md)** — start at the index (map + operating rules), then read the one file for the task.

<a id="run"></a>

## Install (Linux + macOS, no sudo)

```sh
curl -fsSL https://raw.githubusercontent.com/Darthph0enix7/enpoi-harness/stable/scripts/install.sh | bash
```

The installer detects OS/arch, uses Node ≥ 22.19 from `PATH` (or downloads one into the prefix), enables pnpm through corepack, fetches a versioned harness build, builds it, seeds `$DSH_HOME` (settings, presets, skills), and installs the `dsh` shim into `~/.local/bin`. It never uses sudo, never overwrites seeded settings, and is idempotent.

<a id="run-from-source"></a>

From a checkout (also how the tests install):

```sh
bash scripts/install.sh --source . --channel stable
```

## Channels

| Channel | Meaning |
|---|---|
| `stable` (default) | Released, verified builds. Used when `--channel` is omitted. |
| `beta` | Same commit stream and prebuilt releases as `stable`, for pre-release validation. |

```sh
dsh update                    # update on the current channel
dsh update --channel beta     # switch to beta (then back with --channel stable)
dsh update --dry-run          # show the plan without touching anything
```

Updates are versioned directory switches with rollback on failure; `$DSH_HOME` is only ever seeded, never overwritten. A restart is scheduled safely with `dsh restart --after-turn` — never restart the service from inside an agent turn.

## What is ours vs upstream

| Ours (`dsh-enpoi-*` packages + profile) | Upstream (`deepseek-harness`) |
|---|---|
| Provider sync, heavy-provider installs, key pools, catalog rules, model chains | Core runtime, session log, client framework, plugin loader, tools, compaction |
| Orchestration: roles/seats, councils, Oracle, keeper, living brief, whiteboard, memory | Web UI shell, conversation, settings framework and most built-in pages |
| Diagnostics ledger, verification gates, Creator docs | Desktop/headless bundles, SDKs, benchmarks |

When working on upstream code, follow upstream `AGENTS.md`, `docs/`, and the contributing guide. When working on the harness the operator actually runs, start from `docs/creator/` and keep it in sync with every change.

## Safety and license

Read [SAFETY.md](SAFETY.md) before running an agent with shell access — a `creator`/`sysadmin` session is shell access to the machine. Upstream is MIT-licensed; our packages live in this repository and the companion profile. Third-party dependencies are disclosed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
