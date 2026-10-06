#!/usr/bin/env node
/**
 * Branding re-apply + guard for the served web artifact.
 *
 * Why this exists: a full client build that selects the `official` build
 * profile (`DSH_BUILD_CLIENT_PROFILE=official`) hard-codes
 * `DSH_CLIENT_TITLE: 'DeepSeek Harness'` and bakes it into
 * `apps/web/dist/{index.html,preview.html}` and the built
 * `packages/client/ui-layout/lib/client.js` (`const productTitle = ...`).
 * The dist the running `dsh-web.service` serves is exactly
 * `apps/web/dist/index.html` (resolved through the workspace link named by
 * `@deepseek-ai/dsh-web-frontend`), so an official-profile build silently
 * reverts the fork branding. The hostless `preview.html` additionally has no
 * `ui-theme` index injection, so it painted light no matter what the profile
 * preference said.
 *
 * This script is the install/build step that re-applies the fork identity and
 * the guard that detects the next regression:
 *   - dist index/preview titles + the branded favicon/manifest set,
 *   - the dark boot default marker on `preview.html` (no host injection there),
 *   - the runtime `productTitle` fallback compiled into ui-layout's client,
 *   - the active skin's overlay text/background contrast (the inverted static
 *     ramps that made the archive/revert banners dark-on-dark) through
 *     ./dsh-token-contrast.mjs — safeguard 20 in ~/dsh-migration/50-…md.
 *
 * Usage:
 *   node scripts/dsh-rebrand.mjs            # apply (idempotent)
 *   node scripts/dsh-rebrand.mjs --check    # verify only; exit 1 on drift
 *   node scripts/dsh-rebrand.mjs --check --live   # also probe the running origin
 *
 * Run after every client rebuild / pnpm reinstall, like rebuild-sidebar.sh.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, existsSync, copyFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { contrastDrift } from './dsh-token-contrast.mjs'

/** Harness checkout: explicit override, the documented clone, or the installer layout. */
function resolveHarness() {
  const candidates = [
    process.env.HARNESS_ROOT,
    process.env.DSH_REPO,
    join(homedir(), 'deepseek-harness'),
    join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'harness', 'current'),
  ]
  return candidates.filter(Boolean).find(candidate => existsSync(candidate)) ?? join(homedir(), 'deepseek-harness')
}

const HARNESS = resolveHarness()
const DIST = join(HARNESS, 'apps/web/dist')
const PUBLIC = join(HARNESS, 'apps/web/public')
const UI_LAYOUT = join(HARNESS, 'packages/client/ui-layout/lib/client.js')
const ORIGIN = process.env.DSH_WEB_ORIGIN ?? 'http://127.0.0.1:3080'

// Install hook on other devices: no checkout, nothing to re-apply.
if (!existsSync(HARNESS)) {
  console.log(`[rebrand] no harness checkout at ${HARNESS}; nothing to re-apply`)
  process.exit(0)
}

const CHECK = process.argv.includes('--check')
const LIVE = process.argv.includes('--live')
const ENPOI = 'Enpoi Harness'
const UPSTREAM_TITLES = ['DeepSeek Harness', 'DSH Local Build']
const DARK_BOOT = '<style data-dsh-brand="dark-boot">:root{color-scheme:dark}body{background-color:#151517;--dsh-boot-bg:#151517}</style>'
// The host injects this pre-plugin palette selector on every served index; the
// hostless preview page gets the same default baked in, or it boots light.
const DARK_BOOT_SCRIPT = '<script data-dsh-brand="dark-boot-script">document.documentElement.dataset.dsThemeSource="dark";document.body.toggleAttribute("data-ds-dark-theme",true);document.body.style.setProperty("--dsh-content-font-size","14px")</script>'
const BRAND_ASSETS = ['favicon.svg', 'favicon-dark.svg', 'apple-touch-icon.png', 'icon-maskable-512.png', 'manifest.webmanifest']

const drift = []
const skips = []

/** Record a drift (check mode) or apply a transform (apply mode). */
function settle(file, label, transform) {
  const before = readFileSync(file, 'utf8')
  const after = transform(before)
  if (after === before) return
  if (CHECK) drift.push(`${label}: ${file}`)
  else {
    writeFileSync(file, after)
    console.log(`[rebrand] fixed ${label}: ${file}`)
  }
}

/** Replace one upstream product title with the fork title in an HTML shell. */
function brandedHtml(html) {
  let out = html
  for (const upstream of UPSTREAM_TITLES) out = out.replaceAll(`<title>${upstream}</title>`, `<title>${ENPOI}</title>`)
  return out
}

/** Title/meta drift in one built HTML page (and the preview dark marker). */
function checkPages() {
  const pages = ['index.html', 'preview.html']
  for (const page of pages) {
    const file = join(DIST, page)
    if (!existsSync(file)) { drift.push(`missing built page: ${file}`); continue }
    const html = readFileSync(file, 'utf8')
    const title = /<title>([^<]*)<\/title>/u.exec(html)?.[1]
    if (title !== ENPOI) drift.push(`${page} title ${JSON.stringify(title)} != ${JSON.stringify(ENPOI)}`)
    if (!html.includes('apple-mobile-web-app-title" content="Enpoi Harness"')) drift.push(`${page} PWA apple title not Enpoi`)
  }
  const preview = join(DIST, 'preview.html')
  if (existsSync(preview)) {
    const html = readFileSync(preview, 'utf8')
    if (!html.includes('data-dsh-brand="dark-boot"')) drift.push('preview.html lacks the dark boot style')
    if (!html.includes('data-dsh-brand="dark-boot-script"')) drift.push('preview.html lacks the dark boot script')
  }
}

/** Branded static assets must byte-match the repo's public/ set. */
function checkAssets() {
  for (const asset of BRAND_ASSETS) {
    const from = join(PUBLIC, asset)
    const to = join(DIST, asset)
    if (!existsSync(from)) { drift.push(`source brand asset missing: ${from}`); continue }
    if (!existsSync(to)) { drift.push(`dist brand asset missing: ${to}`); continue }
    if (!readFileSync(from).equals(readFileSync(to))) drift.push(`dist brand asset differs from public: ${asset}`)
  }
}

/** The runtime title fallback compiled into ui-layout must be the fork title. */
function checkRuntimeTitle() {
  if (!existsSync(UI_LAYOUT)) { drift.push(`missing built client: ${UI_LAYOUT}`); return }
  const js = readFileSync(UI_LAYOUT, 'utf8')
  if (js.includes('const productTitle = "DeepSeek Harness";')) drift.push('ui-layout client still bakes the upstream productTitle')
  else if (!js.includes('const productTitle = "Enpoi Harness";')) skips.push('ui-layout productTitle literal not found (rebuilt shape changed; verify manually)')
}

/** Mint the auth cookie from the running service journal, like preset-tool-inventory.mjs. */
function liveCookie() {
  try {
    const log = execFileSync('journalctl', ['--user', '-u', 'dsh-web.service', '-n', '400', '--no-pager'], { encoding: 'utf8' })
    // The journal window can hold several boots; only the newest token is live.
    const tokens = [...log.matchAll(/dsh web: http:\/\/127\.0\.0\.1:\d+\/\?token=([A-Za-z0-9_-]+)/gu)]
    return tokens.at(-1)?.[1]
  } catch {
    return undefined
  }
}

/** Probe the live origin: pre-boot title + dark/skin injection markers. */
async function checkLive() {
  const token = liveCookie()
  if (token === undefined) { skips.push('live probe skipped: no dsh web token in the service journal'); return }
  const handshake = await fetch(`${ORIGIN}/?token=${token}`, { redirect: 'manual' })
  const cookie = handshake.headers.get('set-cookie')?.split(';')[0]
  if (cookie === undefined) { drift.push('live probe: auth handshake returned no cookie'); return }
  const page = await (await fetch(`${ORIGIN}/`, { headers: { cookie } })).text()
  if (!page.includes(`<title>${ENPOI}</title>`)) drift.push('served index title is not Enpoi Harness')
  if (!page.includes('data-dsh-skin=')) drift.push('served index has no skin binding')
  if (!page.includes('const preference = "dark"')) drift.push('served index does not carry the dark theme default')
}

/** Apply mode: restore pages, preview dark boot, assets, runtime title. */
function apply() {
  for (const page of ['index.html', 'preview.html']) {
    const file = join(DIST, page)
    if (existsSync(file)) settle(file, `${page} title`, brandedHtml)
  }
  const preview = join(DIST, 'preview.html')
  if (existsSync(preview)) {
    settle(preview, 'preview dark boot', (html) => {
      let out = html
      if (!out.includes('data-dsh-brand="dark-boot"')) out = out.replace('<head>', `<head>${DARK_BOOT}`)
      if (!out.includes('data-dsh-brand="dark-boot-script"')) out = out.replace('<body>', `<body>${DARK_BOOT_SCRIPT}`)
      return out
    })
  }
  for (const asset of BRAND_ASSETS) {
    const from = join(PUBLIC, asset)
    const to = join(DIST, asset)
    if (!existsSync(from) || !existsSync(to)) { console.warn(`[rebrand] warn missing brand asset ${from} or ${to}`); continue }
    if (!readFileSync(from).equals(readFileSync(to))) {
      copyFileSync(from, to)
      console.log(`[rebrand] synced brand asset: ${asset}`)
    }
  }
  if (existsSync(UI_LAYOUT)) {
    settle(UI_LAYOUT, 'ui-layout productTitle',
      (js) => js.replace('const productTitle = "DeepSeek Harness";', 'const productTitle = "Enpoi Harness";'))
  } else {
    console.warn(`[rebrand] warn missing built client ${UI_LAYOUT}`)
  }
}

if (CHECK) {
  checkPages()
  checkAssets()
  checkRuntimeTitle()
  for (const item of contrastDrift()) drift.push(item)
  if (LIVE) await checkLive()
  for (const note of skips) console.warn(`[rebrand] warn ${note}`)
  if (drift.length > 0) {
    console.error(`[rebrand] DRIFT (${String(drift.length)}):`)
    for (const item of drift) console.error(`  - ${item}`)
    process.exit(1)
  }
  console.log(`[rebrand] PASS${LIVE ? ' (live)' : ''}: Enpoi title, dark preview boot, brand assets, runtime title, overlay contrast`)
} else {
  apply()
  console.log('[rebrand] applied; run with --check to verify')
}
