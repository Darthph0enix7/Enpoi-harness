# dsh-enpoi-web-profile

The Enpoi Harness web profile (`~/.dsh/profiles/web`) — versioned so the
whole customization layer survives reinstalls and can be reproduced on any
device. Companion to the fork repo `Darthph0enix7/enpoi-harness`
(see its `STATE.md` for the repo-side modifications).

## Layout

| Path | Purpose |
|---|---|
| `package.json` | Profile manifest: `dsh.profile.bundles` = dsh-base, dsh-web-app, skin-center + the `dsh-enpoi-*` plugins (see the file) |
| `cordis.patch.yml` | User patch layer: pins `- id: better-sidebar / disabled: false` (the npm bundle's `!!js` double-mount guard silently disables the plugin on this setup) |
| `cordis.yml` | Loader root (empty entry list; patches compose on top) |
| `pnpm-lock.yaml`, `pnpm-workspace.yaml` | Install reproducibility (hoisted linker, build allow-list: node-pty, cpu-features, ssh2) |
| `fleet.yaml` | Fleet registry for device-to-device peer pairings: `hub`, members with `name`/optional `alias`/`exposure`/`create` (default `orchestrator`)/hostname patterns/fallback tailnet `ip`/optional `port`. `scripts/install.sh` runs the generator after every profile refresh, so devices change only through `dsh update`. |
| `scripts/generate-pairings.mjs` | Renders this device's `$DSH_HOME/pairings.yaml` from `fleet.yaml`: live tailnet IPv4 lookup with registry fallback, strict validation through the peer package's own parser, atomic 0600 write with backup, first-line `# dsh-managed: false` opt-out, always exit 0. Alias convention: a pairing uses the member's own name in both devices' files. |
| `rebuild-sidebar.sh` | **Legacy (dsh-better-sidebar was retired in the 0.1.5 sync).** Restores the patched sidebar sources + rebuilds that plugin's bundle + restarts dsh-web. Not run by the fresh-install flow; it fails fast with "dsh-better-sidebar not installed" when the plugin is absent. |
| `sidebar-patch/` | **Legacy.** Patch overlay for dsh-better-sidebar: `src/client/{Sidebar.tsx,split-pane.tsx,layout.css}` + `build-client.{mjs,cjs}` (import paths are rewritten to the local esbuild by `rebuild-sidebar.sh`; the shipped files keep serverlocal paths only as placeholders) |
| `scripts/dsh-rebrand.mjs` | Re-applies the fork branding to the served web artifact after any client rebuild or pnpm reinstall (Enpoi title in `apps/web/dist/{index.html,preview.html}`, the preview's dark boot marker, the branded favicon/manifest set, and the baked `productTitle` in `ui-layout`'s built client). Wired as this profile's `postinstall`; guard mode `node scripts/dsh-rebrand.mjs --check --live` also probes the running origin for the served title, the skin binding and the dark theme default, and folds in the skin's overlay-contrast verdict (safeguards 19–20 in `~/dsh-migration/50-…md`). |
| `scripts/dsh-token-contrast.mjs` | Resolves the active skin's tokens through the upstream light/dark base plus the skin's overrides and checks every overlay pair (toast, tooltip, dialog/Modal, menu) against 4.5:1 in both base themes, plus a scan of every client-CSS rule that paints ink over its own overlay surface. Run `node scripts/dsh-token-contrast.mjs` (or via `dsh-rebrand.mjs --check`); exits 1 on any dark-on-dark pair — safeguard 20. |
| `patches/@deepseek-ai__dsh-web-frontend@0.1.7-enpoi.1.patch` | Registry-install half of the same branding fix, referenced by `pnpm.patchedDependencies` in `package.json` (workspace links are not patchable, so on this checkout the script above is the operative route; `pnpm.allowNonAppliedPatches` keeps installs quiet). |

## Settings & plugin Config (0.1.7 settings→Config migration)

The merged engine (0.1.7) derives every settings form from the owning plugin's
Cordis `Config`: live fields are declared with `.volatile()`, forms are keyed by
**profile entry id**, and edits persist into this profile's `cordis.patch.yml`
through the config editor. The old `settings-file` service and the
`settings.get(ns)` / `installSection` seams are gone.

- **Shared document owner:** the `enpoi-capabilities` bundle is mounted as entry
  **`enpoi-orchestration`** (see `packages/enpoi-capabilities/cordis.patch.yml`)
  and declares the whole shared document as its `.volatile()` Config
  (`capabilities`, `mcpServers`, `mcpStatus`, `personas`, `roles`, `councils`,
  `chains`, `parameters`, `uiPreferences`, `permissions`, `whiteboard`). The
  legacy `settings.yaml` section of the same id imports into this entry — entry
  ids must match section names or the import is logged and kept only in the
  renamed `settings.yaml.imported`.
- **Readers:** every other enpoi plugin reads the document through
  `dsh-enpoi-contracts`' `readOrchestrationDocument()` / `readSettingsDocument()`
  (the settings service's `describe()` value, with the pre-0.1.7 `get()`
  fallback so the profile boots on both engines during the sync window).
  Writers keep the revision-fenced `settings.mutate(ns, ops, revision)` path.
- **Hot-swap events:** the merged service emits `settings/document-updated`;
  the pre-0.1.7 service emitted `settings/updated`. Plugins that react to
  document changes subscribe to both.
- **Provider entries:** the base bundle mounts entry id `llm-deepseek` naming
  `@deepseek-ai/dsh-llm-deepseek-api-key`. The new Messages adapter throws on a
  stored `protocol:` field and the pi-ai adapter refuses `provider` /
  `maxRetries` / `maxRetryDelayMs` inside a route profile — keep those out of
  `settings.yaml` (verified absent). Pool/route data lives under `llm-pi-ai`.
- **Default model:** `agent-default-model {provider, model, chain}` now lives as
  a composition row in **`cordis.patch.yml`** (the config-editor document). The
  one-shot `settings.yaml` import lands the same row here; the row is what keeps
  the default model-group chain alive.
- **OpenCode free tier is retired by profile policy.** `opencode/*-free` links
  answer `403 FreeTierError` to any non-OpenCode client ("You cannot use the
  free tier in other harnesses", anomalyco/opencode#49621), so the `free` chain
  stays present but `disabled: true`, no enabled chain may link one, and the
  default seat names a paid `opencode-go` route. Because any settings write
  re-persists the live row into `cordis.patch.yml` (the Model Groups enable
  toggle writes `chains.<id>.disabled`; every model picker writes the seat's
  `chain`), re-run **`node scripts/disable-free-tier.mjs`** after settings
  edits; `packages/enpoi-capabilities/tests/profile-patch.spec.ts` fails the
  profile test run if the invariant drifts.

Operator checklist at the switch: the first 0.1.7 boot renames
`~/.dsh/settings.yaml` to `settings.yaml.imported` and imports each section into
the entry of the same id (sections with no entry stay only in the renamed file,
reported as `settings: section ... was not imported`). Keep the `.imported` file
until every section is confirmed.

## dsh-better-sidebar modification ledger (legacy — retired in the 0.1.5 sync)

`dsh-better-sidebar` is no longer a bundle in this profile; the first-party
right sidebar (`ui-sidebar-right` + `ui-sidebar-files` +
`ui-sidebar-documentpreview` + `ui-dockkit`) now owns docking, previews,
resize, splits, and chat→preview opens. The ledger below and the
`sidebar-patch/` + `rebuild-sidebar.sh` pair are kept only for profiles still
running the 0.1.x engine with that plugin installed. Do not run
`rebuild-sidebar.sh` on a fresh profile.

The npm-published 0.14.0 is broken against dsh rc.2 in three ways; all are
fixed in `sidebar-patch/` + `cordis.patch.yml`:

1. Bare global `React` in `RenderBoundary` (classic JSX runtime with
   externed react) → `ReferenceError: React is not defined` at mount.
   Fixed via `var React = require("react")` in the build banner.
2. `activeTabType` `useMemo` after the no-session early return → React
   error #310 on the welcome→session transition. Fixed by moving the hook
   above the early return (with a `state === undefined` guard).
3. Bundle `!!js` double-mount guard disables the whole row (host
   `/sidebar/api` 404 → client silently unmounts). Fixed by the
   `disabled: false` pin in `cordis.patch.yml`.

Customizations on top:

- **Welcome-screen activity bar**: the vertical icon rail (Files/Git/
  Terminal/Tasks/Browser) renders on the welcome screen too, not just in
  sessions.
- **Layout push includes the 44px activity rail** (`writeGeometry`:
  `width + ACTIVITY_RAIL`) so `#root` snaps exactly to the panel's left
  edge (no dark-line gap between chat and panel).
- **Bottom-panel squeeze anchor**: `#root :has(> [data-slot="conversation"])`
  in `layout.css` — the upstream `[data-dsh-frame] > [data-pane="conversation"]`
  anchor no longer matches this DSH version (bottom panel used to overlay
  the composer).
- **Bottom toggle kick**: `kickMeasure()` re-runs the locate+measure chain
  (hoisted `locateRef` + 8× retry loop) so the panel can't stay
  visibility-hidden. An OPEN panel is never hidden (full-width fallback
  geometry until measured).
- **Single-instance activity views**: activity-rail clicks re-activate the
  pane's existing tab of that type instead of minting new ones (the editor's
  file-tree tab = editor tab with `path === undefined`). No more "new
  terminal every toggle".
- **Terminal-only tab strip**: per-pane `TabBar` renders only when the
  active tab is a terminal (terminal tabs + a `+` that opens another
  terminal + close buttons); other views have no strip.
- **Resize freeze-on-release** (Oracle-reviewed):
  - The layout-push effect never deletes the CSS vars on committed updates
    (cleanup moved to a separate unmount-only effect) — the transient 0px
    fallback forced a sync layout at full width, causing the "reload"
    animation and the host app's left-rail flapping on release.
  - `pointerup` never bails on missing pointer capture and commits
    `lastAppliedRef` (the exact on-screen geometry) first.
  - `abortDrag` is freeze-first: `lastAppliedRef` → pending rAF frame →
    event coordinates (only when real) — **no revert to store sizes**; a
    pure down+up leaves the DOM alone.
  - Bottom drags carry `width = 0` while the right panel is closed (no
    empty right-panel gap mid-drag).
- A width clamp (center ≥ 760px to stop the app's left-rail auto-collapse)
  was tried and REJECTED — do not reintroduce.

## Rebuild pipeline

```bash
# after any reinstall of the profile (dsh plugin / pnpm install):
~/.dsh/profiles/web/build-plugins.sh
# (legacy, only for a profile that still has dsh-better-sidebar installed:)
# ~/.dsh/profiles/web/rebuild-sidebar.sh
# after rebasing the fork: rebuild the brand package too
cd ~/deepseek-harness && pnpm --filter @deepseek-ai/dsh-client-ui-brand-enpoi run bundle
# restart (serverlocal uses its own systemd unit; other installs: dsh service restart)
systemctl --user restart dsh-web.service
```

## Verification probes

Headless Playwright probes (serverlocal scratch scripts; point them at your own
Chromium binary, e.g. `~/.cache/ms-playwright/chromium-*/chrome-linux64/chrome`):
`/tmp/opencode/pwprobe/` — `probe-resize.mjs` (freeze stress),
`probe-cancel.mjs` (capture-loss sim), `probe-nospike2.mjs` (12ms-sampled
post-release monotonic check), `probe-behavior.mjs` (activity rail +
terminal strip), `probe-bottom.mjs` / `probe-bottom2.mjs` (bottom panel
toggle/squeeze/drag with right panel open/closed).

## Fresh install on a new device

**Supported path:** the canonical installer stages this whole profile (plugins,
patches, scripts, skills, skins, fish function, fresh settings) and seeds
`$DSH_HOME`:

```bash
curl -fsSL https://raw.githubusercontent.com/Darthph0enix7/enpoi-harness/stable/scripts/install.sh | bash
```

It strips operator state (`device-patches/`, `settings.yaml`, `fresh-settings`
is seeded instead) and never installs the serverlocal `systemd/` units. The
manual checkout flow below is for development installs; keep the copy list in
sync with the installer's `copy_profile_tree`.

1. **Harness fork** (our engine + UI + orchestration core):
   ```bash
   git clone -b stable https://github.com/Darthph0enix7/enpoi-harness ~/deepseek-harness
   cd ~/deepseek-harness && pnpm install && pnpm run build:lib && pnpm run build:web
   ```
2. **Profile** (our plugins + sidebar patches — this repo):
   ```bash
   git clone https://github.com/Darthph0enix7/dsh-enpoi-web-profile ~/dotfiles/dsh-dotfiles
   mkdir -p ~/.dsh/profiles/web
   cp -r ~/dotfiles/dsh-dotfiles/{build-plugins.sh,cordis.patch.yml,cordis.yml,package.json,packages,patches,pnpm-lock.yaml,pnpm-workspace.yaml,rebuild-sidebar.sh,scripts,sidebar-patch,skills,skin-center-active.json,skins,vitest.config.ts} ~/.dsh/profiles/web/
   cd ~/.dsh/profiles/web && pnpm install && bash build-plugins.sh
   ```
   `systemd/` is intentionally absent: those are serverlocal's units (see
   `systemd/README.md`); use `dsh service install` on a new machine.
3. **Fresh settings** (no providers, no personal config):
   ```bash
   cp ~/dotfiles/dsh-dotfiles/fresh-settings.yaml ~/.dsh/settings.yaml
   ```
4. **Presets + skills**: the active agent presets are declared in
   `cordis.patch.yml` (already copied above), and the shipped skills live in the
   profile's `skills/` dir (also copied above), which every preset mounts.
   `~/.dsh/.agent-presets` is the legacy directory format an older engine read;
   the installer still seeds it for those engines:
   ```bash
   cp -r ~/dotfiles/dsh-dotfiles/presets ~/.dsh/.agent-presets   # legacy engines only
   ```
5. **ds CLI** (fish users only): `cp ~/dotfiles/dsh-dotfiles/fish/ds.fish ~/.config/fish/functions/`
   and `cp ~/dotfiles/dsh-dotfiles/fish/completions/ds.fish ~/.config/fish/completions/`.
6. Configure your own providers in Settings → Models, then `ds sync` to create your device patch.

**Personal bits never shared**: `settings.yaml` (providers/personas),
`device-patches/` (per-host overlays such as `serverlocal.yaml`),
`~/.dsh/sync-local.yaml`. `fresh-settings.yaml` is the only settings file meant
for public use.

## Fallback links after `pnpm`

Running `pnpm install` (or any `pnpm <script>`) inside this profile rebuilds `node_modules` and can prune the dsh-managed **fallback links**, so plugin rows log `<id>: failed to import` on the next reload and some UI surfaces look broken or stale until repaired.

`dsh` now guards both moments: before rows mount it verifies every bundle and reports one line — `profile bundles: N resolvable, M repaired, K missing` — and an import that fails with a module-resolution error repairs the fallback once per package and retries the import once (`profile-heal: repaired N links; retrying <package>`). Any other failure is rethrown untouched.

Manual check (read-only-safe, prints the same report):

```bash
cd ~/deepseek-harness && node --import tsx/esm --input-type=module -e "const {checkProfileBundleResolution}=await import('./packages/boot/app-boot/src/index.ts'); const home=process.env.DSH_HOME||process.env.HOME+'/.dsh'; console.log(JSON.stringify(await checkProfileBundleResolution({installAnchor:process.cwd()+'/apps/cli/package.json',profileDir:home+'/profiles/web',home}),null,2))"
```
