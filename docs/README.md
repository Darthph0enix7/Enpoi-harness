# Documentation map

This repository is the Enpoi fork of `deepseek-ai/deepseek-harness`. The `docs/` tree is upstream's and is kept current by upstream generators and gates; the fork overlay is small and explicit: this map, [`archive/`](archive/README.md), and the Creator knowledge base in [`creator/`](creator/00-index.md). Fork-only behaviour belongs in those three places — never invented into an upstream page — so upstream merges stay conflict-free.

## Start here

| If you are… | Read |
|---|---|
| Installing or updating a machine | [`../README.md`](../README.md) (fork install line), [`creator/02-install-and-update.md`](creator/02-install-and-update.md) (installer, channels, overlay, safe restart, rollback) |
| Asking about fork behaviour (defaults, providers, permissions, tool groups) | [`creator/00-index.md`](creator/00-index.md), then the one deep file it points at |
| Changing `packages/` | [`architecture.md`](architecture.md), then [`subsystems/`](subsystems/README.md) |
| Extending the harness | [`cookbook/`](cookbook/adding-a-package.md), [`user/develop/`](user/develop/basic/index.md), [`cordis-tutorial/`](cordis-tutorial/index.md) |
| Using the product | [`user/`](user/guide/index.md) |
| Contributing to this repo | [`AGENTS.md`](AGENTS.md) (doc standard), [`development.md`](development.md) |

## Ownership and state

| Path | Origin | State | Notes |
|---|---|---|---|
| `docs/creator/**` | ours (fork) | current — live | Creator agent knowledge base; fork truth lives here, not in upstream pages |
| `docs/README.md`, `docs/archive/**` | ours (fork) | current | this map; frozen pages with banners |
| `docs/subsystems/**` | upstream (+ fork pages `peer.md`, `settings.md`) | current | page prose is hand-maintained; the `cordis-surface` regions are generated — never edit between the markers |
| `docs/persistence-changes/**` | upstream + four fork records (`2026-09-23-*`) | current | historical acknowledgements; `.schema.json` snapshots are tool-generated |
| `docs/postmortem/**` | upstream | current — frozen history | incident records are evidence, never rewritten |
| `docs/cookbook/**`, `docs/cordis-api/**`, `docs/cordis-tutorial/**`, `docs/user/**` | upstream | current | published by `website/docs.ts`; see "Upstream pages that are not the fork's path" below |
| `docs/i18n/**` | upstream | current | translation contract and pipeline assets |
| Top-level references: `architecture.md`, `development.md`, `testing.md`, `glossary.md`, `defensive-patterns.md`, `session-format-status.md`, `rescope.md`, `api-gateway.md`, `deepseek-llm-api-wire-extensions.md`, `ui-radius.md`, `web-styling.md` | upstream | current | hand-maintained, budget- or link-gated |
| Generated top-level files (next section) | upstream generators | generated | regenerate, never hand-edit |
| `docs/archive/**` | ours (fork) | archive | see the policy below |

Nothing under `docs/` is currently classified stale or misleading for the upstream path; the fork-relevant divergences are declared in the last section. Every `foo.md`/`foo.zh.md` pair that exists is complete. The root README carries explicit `#run`/`#run-from-source` anchors again, so the four upstream pages that link them resolve. The fork-only docs (`creator/`, this file, `archive/`) are English-only by policy and excluded from pairing in [`scripts/translation-pairing.manifest.json`](../scripts/translation-pairing.manifest.json); see the i18n section.

## Generated references — regenerate, never hand-edit

| File(s) | Regenerate | Verify (gates) |
|---|---|---|
| `agent-lifecycle.md`, `capability-seams.md`, `event-producer-consumer.md`, `graph-atlas.md`, `tool-execution-pipeline.md` | `pnpm run gen-doc-graphs` | `verify-doc-graphs` |
| `module-graph.md` | `pnpm run gen-module-graph` | `verify-module-graph` |
| `tool-catalog.md` | `pnpm run gen-tool-catalog` | `verify-tool-catalog` |
| `config-catalog.md` | `pnpm run gen-config-catalog` | `verify-config-catalog` |
| `persistence-catalog.md`, `persistence-schema.json` | `pnpm run gen-persistence-catalog` | `verify-persistence-catalog` |
| `dependency-catalog.json` | `pnpm run gen-dependency-catalog` | `verify-dependency-catalog` |
| `cordis-api/*.md` and every `cordis-surface` region under `subsystems/` | `pnpm run gen-cordis-catalog` (`gen-cordis-api` is the compatibility entry) | `verify-cordis-catalog` / `verify-cordis-api` |
| `persistence-changes/**/*.schema.json` | persistence record tooling (`scripts/persistence-changes.ts`; see [`persistence-changes/README.md`](persistence-changes/README.md)) | `verify-persistence-catalog`, the persistence verifiers |

`docs/i18n/terminology.md` is an input to `gen-translation-brief`, not an output. `docs/i18n/style-samples.md` and `translation-prompt.md` are pipeline assets and are excluded from pairing.

## Internationalization

- Every `foo.md` in the paired tiers has `foo.zh.md` plus a `foo.i18n.yaml` record; update the pair together, in one change, and re-record with `pnpm run verify-translation-pairing --write <path>` (see [`i18n/README.md`](i18n/README.md)).
- Do not edit only the English side of a paired upstream page: the pairing gate reads the recorded hash and fails. Fork-only facts avoid this entirely by living in unpaired fork docs (`creator/`, this file, `archive/`).
- **Fork-only docs are English-only by policy.** `docs/creator/**`, this file, and `docs/archive/**` must not get `.zh.md` or `.i18n.yaml` counterparts; they are excluded in [`scripts/translation-pairing.manifest.json`](../scripts/translation-pairing.manifest.json) and the pairing gate skips them entirely. Upstream paired tiers keep the bilingual contract, and generated English sources still flow to Chinese through pairing.
- Generated English sources are refreshed by their generator first; the Chinese side follows through pairing only.

## Archive policy

Frozen pages live in [`archive/`](archive/README.md). A page is archived only when it no longer describes the upstream path (moved, renamed, or replaced mechanism). Each archived file starts with one line:

> Archived — superseded; see <pointer>

Archiving is a move, never a delete: the original path's inbound links must be updated or removed in the same change, and the page keeps its content below the banner. Pages that remain accurate for the upstream path stay in place — see the declarations below.

## Upstream pages that are not the fork's path (left in place, declared)

The root [`../README.md`](../README.md) is fork-owned now (Enpoi identity, one-line installer, channel table, pointer to the Creator index); the upstream pages below still describe the upstream path, so they stay.

| Page | Why it stays, and where the fork truth is |
|---|---|
| `user/guide/index.md` | Upstream product guide; its first step types a DeepSeek API key. The shipped web profile presets the keyless Kilo Gateway route, so a key is not required (see below). |
| `user/develop/basic/publish.md` | Upstream npm publishing under the `@deepseek-ai` scope; the fork does not publish npm packages. |
| `development.md` | Upstream contributor setup (pnpm, corepack, Windows/WSL). Still the correct path for working on this fork's code. |

## Fork layer: install, channels, defaults

- **Installer.** `scripts/install.sh` is the one-line installer (`curl -fsSL <install.sh-url> | bash`, header lines 3–7) and the single engine; `scripts/update.sh` delegates to it with `--update`, and the generated `dsh` shim forwards `dsh update` to it. Linux/macOS only, no sudo ever (a failing `sudo` stub makes any escalation exit 42), versioned trees under `<prefix>/harness/<version>` with `current` as a symlink, `$DSH_HOME` seeded once and never overwritten, rollback to the previous tree plus user-file backups on a failed update. The fork [`../README.md`](../README.md) prints the concrete one-liner; deep detail is in [`creator/02-install-and-update.md`](creator/02-install-and-update.md).
- **Defaults.** `--prefix` `$HOME/.dsh`; `--bin-dir` `$HOME/.local/bin`; `--profile web`; `--channel stable`; `--dsh-home DIR` overrides `$DSH_HOME` and update fails loudly when it disagrees with the recorded state; profile source `Darthph0enix7/dsh-enpoi-web-profile.git` (a profile fetch failure warns and falls back to the shipped template unless the source was explicit). State is recorded in `<prefix>/harness/install-state.json`.
- **Channels.** `stable` and `beta` are git refs named by `--channel`; `--ref` overrides with a tag/commit, and every later update reuses the recorded channel/ref. Downgrades are refused without `--force-downgrade`. Verified on 2026-09-28: the fork remote publishes `stable`; `beta` is accepted by the installer but has no published ref yet.
- **Kilo default.** The web profile (`$DSH_HOME/profiles/web/cordis.patch.yml`) defines the `kilo` route ("Kilo Gateway", `https://api.kilo.ai/api/gateway`) with `kilo-auto/*` models including the keyless `kilo-auto/free`, and `kilo` is the hand-kept keyless preset (`KEYLESS_PRESET_IDS`). Making Kilo the default for a *fresh* install is still open work (fresh-install defaults item in the migration backlog), so treat "default on new machines" as planned, not shipped.
- **Fork caveats.** The harness archive URL must be reachable from the target machine; for a private repo use `--source <dir|tarball|URL>`. The default profile repo is separate and private-friendly (`DSH_PROFILE_TOKEN`, falling back to `GH_TOKEN`/`GITHUB_TOKEN`/`gh auth token`).

## Standing rules

1. **`docs/creator/*` is the Creator agent's knowledge base.** It is the fork's source of truth for behaviour and must be updated with every behavioural change: any change that alters what the harness does, what a user sees, or what an operator must do lands in the owning creator file in the same change. Read the file for the task; never guess from memory.
2. **Never hand-edit generated English sources or regions.** Run the generator, then its verifier (table above). A hand edit loses to the next regeneration and fails `doc-sync`.
3. **Generated-first, Chinese through pairing.** Regenerate the English source, then update the paired Chinese file and re-record; never edit a `.zh.md` alone.
4. **One home per fact.** The tier taxonomy in [`AGENTS.md`](AGENTS.md) decides where content lives; link instead of duplicating.
5. **Fork facts never fork upstream prose.** Defaults, install/channels, and fork plugin behaviour go in `creator/`, this file, or the fork README — nowhere else — so upstream merges remain mechanical.
6. **Archive by move, banner every page, fix every inbound link.** Content is never deleted silently.
7. **Verify before landing docs changes:** `pnpm run verify-md-links`, `verify-md-wrap`, `verify-doc-budgets`, the catalog freshness checks above, and `verify-translation-pairing`.
