# Enpoi Harness — Current State & Modification Ledger

Fork of [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)
(rc line `v0.1.1-rc.2`) running as **Enpoi Harness** on serverlocal.
Fork repo: `Darthph0enix7/enpoi-harness` (public). This file is the
authoritative record of everything changed on top of upstream.

> Update this file whenever the stand changes. Profile-side customizations
> live in the companion repo `Darthph0enix7/dsh-enpoi-web-profile`.

## 1. Branches

| Branch | Role |
|---|---|
| `master` | Pristine upstream tracking (`origin/master` = deepseek-ai upstream). Never commit here. |
| `local/serverlocal` | Our branch — all serverlocal customizations. Merge flow: `git fetch origin && git rebase origin/master` per `~/dsh-migration/28-upstream-merge-workflow.md`. |

Commits on `local/serverlocal` (beyond upstream):
1. `d6638b9723` — fix(remote): trusted-host access for privileged RPC methods
   + insecure-context `crypto.randomUUID` polyfills (Tailscale HTTP/HTTPS access,
   settings/credentials/presets over remote hosts).
2. `feat(enpoi)` — Enpoi Harness branding + docs (this commit).

## 2. Repo-level modifications (committed, this fork)

| File | Change |
|---|---|
| `packages/client/ui-brand-enpoi/` | NEW package — Enpoi branding plugin: `EnpoiLogo.tsx` (gradient glass "E" monogram), `Brand.tsx` (Enpoi Harness wordmark), slot injection (`sidebar.brand.mark`, `conversation.hero.brand.mark`). Built with tsdown like the official `ui-brand-official`. |
| `packages/bundle/web-app/package.json` | Dependency swap: `dsh-client-ui-brand-official` → `dsh-client-ui-brand-enpoi`. |
| `packages/bundle/web-app/cordis.patch.yml` | Entry swap: `ui-brand-official` → `ui-brand-enpoi`. |
| `apps/web/index.html` | `<title>Enpoi Harness</title>` (was DSH title). |
| `apps/web/public/favicon.svg` | Enpoi monogram favicon (replaces DeepSeek whale). |
| `pnpm-lock.yaml` | Lockfile updated for the brand swap. |

NOTE: `dsh-client-ui-brand-official` remains in the tree (unused). Do not
delete it — the fallback directory `~/.dsh/profiles/node_modules` symlinks
may still reference it.

## 3. Install / services (serverlocal)

- Checkout: `~/deepseek-harness` (branch `local/serverlocal`).
- `dsh-web.service` (user systemd): `node --import tsx/esm apps/cli/src/bin.ts web`
  on `127.0.0.1:3080`, `--trusted-host` incl. `serverlocal.pike-acrux.ts.net:8443`.
- `dsh-tailnet.service` (user systemd): `socat 100.122.163.25:3080 → 127.0.0.1:3080`.
- HTTPS: `tailscale serve --https=8443` → https://serverlocal.pike-acrux.ts.net:8443/
  (secure context required by the web client; fixes crypto.randomUUID on remote hosts).
- `DSH_HOME=~/.dsh`.
- Global `dsh` wrapper: `~/.local/bin/dsh` → `apps/cli/lib/bin.js`.

## 4. Web profile (`~/.dsh/profiles/web`) — see dsh-enpoi-web-profile repo

Bundles: `@deepseek-ai/dsh-base`, `@deepseek-ai/dsh-web-app`,
`dsh-better-sidebar@0.14.0` (patched), `@linxin666/dsh-client-ui-skin-center`
(active skin: summer-liquid-glass, obsidian liquid wallpaper).
The whole profile directory is versioned in
`Darthph0enix7/dsh-enpoi-web-profile` — patches, rebuild script, and the
dsh-better-sidebar source patch overlay live there (see its README for the
full customization ledger).

## 5. Upstream merge guardrails

- Rebase-only on `local/serverlocal`; never merge into `master`.
- After any rebase: rebuild the brand package
  (`pnpm --filter @deepseek-ai/dsh-client-ui-brand-enpoi run bundle`),
  re-run `~/.dsh/profiles/web/rebuild-sidebar.sh`, restart `dsh-web.service`,
  and spot-check via the Playwright probes in `/tmp/opencode/pwprobe/`.
- The brand-enpoi package imports may drift if upstream renames slot ids —
  check `packages/client/ui-brand-official` for the current slot vocabulary.
