#!/usr/bin/env node
/**
 * Token-contrast probe — the readability guard for the liquid-glass skin.
 *
 * Why this exists: the skin remaps the whole `--dsw-*` vocabulary, and the
 * static ramps are INVERTED (upstream 00 = white, this skin 00 = #071321 navy;
 * 1000 = ink). Upstream surfaces that consume a static ramp end as *ink*
 * therefore silently resolve dark-on-dark under the skin. The archive/revert
 * banners were exactly that class: upstream's `--dsw-alias-toast-label:
 * var(--dsw-static-neutral-bluish-00)` became #071321 on the skin's dark
 * `--dsw-alias-toast-bg` (1.07:1). A merge that brings a new upstream surface
 * (or drops the `patches.css` repaint for a hard-coded one) must fail here,
 * not on the operator's screen.
 *
 * What it checks, for the dark AND light base themes:
 *   1. the critical overlay pairs (toast, tooltip, dialog/Modal, menu) plus
 *      the state pills the skin had to repair — the pool error pill and the
 *      trajectory success/context/warn/revert chips — and the badge family
 *      (agent-preset broken badge, ui-primitives solid tag, composer
 *      recommended badge, RevertTray error badge) — each endpoint resolved
 *      through the real cascade: upstream design-platform light block, its
 *      dark block, then the skin's `:root` overrides (the served skin wins in
 *      both modes because the skin-center scopes it under `html[data-dsh-skin]`,
 *      which outranks `body` and `body[data-ds-dark-theme]`);
 *   2. every `color` + `background` rule in the client CSS whose selector
 *      names an overlay surface (toast/tooltip/dialog/menu/popover/sheet/
 *      hovercard/...), so a new dark-on-dark rule cannot land unnoticed.
 *      Tooltip.module.css is exempt because `patches.css` repaints its
 *      hard-coded static ink under `[role="tooltip"]`, and the pool error pill
 *      likewise under `[class*="poolPillError"]`; the probe asserts both
 *      repaints still exist, so losing one fails the run. The four badge
 *      repaints are asserted the same way: when a repaint is gone the pair
 *      falls back to the module's broken source pairing and fails;
 *   3. the menu material — `--dsw-menu-backdrop-filter` must stay defined in
 *      the ui-theme styles or the skin, because MenuSurface.module.css
 *      consumes it (upstream's dark theme once left it undefined and menus
 *      silently lost their blur);
 *   4. the dotfiles mirror — `~/dotfiles/dsh-dotfiles/skins/summer-liquid-glass`
 *      must byte-match the live skin, or a `ds pull` would silently revert
 *      the frozen state.
 *
 * FROZEN: this probe is the freeze gate for the summer-liquid-glass skin
 * (pinned at 1.0.0-frozen). Any change to the skin or its token vocabulary
 * must be deliberate and must keep this probe and `dsh-rebrand.mjs --check`
 * green.
 *
 * Translucent fills are composited over the skin's night ground (the same
 * ground both themes render, since the skin is dark-only), and WCAG contrast
 * is computed on the result. The floor is 4.5:1 (AA normal text).
 *
 * Usage:
 *   node scripts/dsh-token-contrast.mjs           # table + PASS/DRIFT
 *   node scripts/dsh-token-contrast.mjs --json    # machine-readable rows
 *
 * Exported `contrastDrift()` folds the same verdict into dsh-rebrand.mjs
 * --check (safeguard 20 in ~/dsh-migration/50-…md).
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
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
// The skin the server actually serves is the user-directory skin under
// $DSH_HOME/skins (skin-center precedence: DSH_SKINS_HOME → DSH_SKINS_DIR →
// $DSH_HOME/skins). The profile-local copy is a development snapshot; prefer
// the live one so this guard gates what the operator sees.
const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const LIVE_SKIN = join(DSH_HOME, 'skins', 'summer-liquid-glass')
const PROFILE_SKIN = join(HERE, '..', 'skins', 'summer-liquid-glass')
const SKIN_DIR = process.env.DSH_SKIN_DIR ?? (existsSync(LIVE_SKIN) ? LIVE_SKIN : PROFILE_SKIN)
// The dotfiles mirror is a `ds pull` source: when present it must byte-match
// the live skin, or a pull would silently revert the frozen state.
const MIRROR_SKIN = process.env.DSH_SKIN_MIRROR ?? join(homedir(), 'dotfiles', 'dsh-dotfiles', 'skins', 'summer-liquid-glass')
const DESIGN_PLATFORM = join(HARNESS, 'packages/client/ui-theme/src/styles/design-platform.css')
const FLOOR = 4.5

/** Every `--token: value` declaration in blocks whose selector passes `selectorTest`. */
function blockTokens(css, selectorTest) {
  const tokens = new Map()
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, '')
  const re = /([^{}]+)\{([^{}]*)\}/g
  let match
  while ((match = re.exec(clean)) !== null) {
    if (!selectorTest(match[1].trim())) continue
    for (const declaration of match[2].matchAll(/--([\w-]+)\s*:\s*([^;]+);/g)) {
      tokens.set(`--${declaration[1]}`, declaration[2].trim())
    }
  }
  return tokens
}

/** All source CSS files under packages/client, minus node_modules and build outputs. */
function cssFiles(root) {
  const out = []
  const walk = (dir) => {
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === 'lib' || entry.name === 'dist' || entry.name.startsWith('.')) continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name.endsWith('.css')) out.push(full)
    }
  }
  walk(join(root, 'packages/client'))
  return out
}

/** Split on top-level commas only (rgba alpha may hold var(..., fallback)). */
function splitTopLevel(text) {
  const parts = []
  let depth = 0
  let current = ''
  for (const char of text) {
    if (char === '(') depth += 1
    else if (char === ')') depth -= 1
    if (char === ',' && depth === 0) { parts.push(current); current = '' } else current += char
  }
  parts.push(current)
  return parts.map(part => part.trim())
}

/** Compute `+ - * /` over substituted numeric vars; unknown vars take their fallback or 0. */
function evalCalc(expr, lookup) {
  const substituted = expr.replace(/var\(\s*(--[\w-]+)\s*(?:,\s*([^()]*(?:\([^()]*\)[^()]*)*))?\)/g, (_, name, fallback) => {
    const value = lookup(name)
    if (value !== undefined && /^[\d.]+$/.test(value.trim())) return value.trim()
    return fallback === undefined ? '0' : fallback
  })
  if (!/^[\s\d.+\-*/()]+$/.test(substituted)) return null
  try { return Function(`"use strict"; return (${substituted})`)() } catch { return null }
}

/** Resolve one CSS color literal or var() chain to {r,g,b,a}, or null when unhandled. */
function parseColor(raw, lookup, depth = 0) {
  if (raw === undefined || depth > 16) return null
  const value = raw.trim()
  const varMatch = /^var\(\s*(--[\w-]+)\s*(?:,\s*([\s\S]+))?\)$/.exec(value)
  if (varMatch !== null) {
    const resolved = lookup(varMatch[1])
    if (resolved === undefined || resolved === 'initial') {
      return varMatch[2] === undefined ? null : parseColor(varMatch[2], lookup, depth + 1)
    }
    return parseColor(resolved, lookup, depth + 1)
  }
  const mixMatch = /^color-mix\(\s*in srgb\s*,\s*([\s\S]+)\)$/.exec(value)
  if (mixMatch !== null) {
    const parts = splitTopLevel(mixMatch[1])
    if (parts.length !== 2) return null
    const parsed = parts.map(part => {
      const weight = /\s+([\d.]+)%$/.exec(part)
      return {
        color: parseColor(weight === null ? part : part.slice(0, weight.index), lookup, depth + 1),
        pct: weight === null ? null : parseFloat(weight[1]),
      }
    })
    if (parsed[0].color === null || parsed[1].color === null) return null
    const first = parsed[0].pct ?? (parsed[1].pct === null ? 50 : 100 - parsed[1].pct)
    const second = parsed[1].pct ?? 100 - first
    return {
      r: parsed[0].color.r * first / 100 + parsed[1].color.r * second / 100,
      g: parsed[0].color.g * first / 100 + parsed[1].color.g * second / 100,
      b: parsed[0].color.b * first / 100 + parsed[1].color.b * second / 100,
      a: parsed[0].color.a * first / 100 + parsed[1].color.a * second / 100,
    }
  }
  if (/^#([0-9a-f]{3,8})$/i.test(value)) {
    const hex = value.slice(1)
    const full = hex.length <= 4 ? [...hex].map(char => char + char).join('') : hex
    const int = parseInt(full.slice(0, 6), 16)
    return { r: int >> 16 & 255, g: int >> 8 & 255, b: int & 255, a: full.length === 8 ? parseInt(full.slice(6, 8), 16) / 255 : 1 }
  }
  const rgbMatch = /^rgba?\(([\s\S]+)\)$/.exec(value)
  if (rgbMatch === null) return null
  const parts = splitTopLevel(rgbMatch[1])
  const channel = (text) => {
    const calcMatch = /^calc\(([\s\S]*)\)$/.exec(text.trim())
    if (calcMatch !== null) return evalCalc(calcMatch[1], lookup)
    const parsed = parseFloat(text)
    return Number.isNaN(parsed) ? null : parsed
  }
  const [r, g, b] = parts.slice(0, 3).map(channel)
  const a = parts[3] === undefined ? 1 : channel(parts[3])
  if (r === null || g === null || b === null || a === null || a === undefined) return null
  return { r, g, b, a: Math.max(0, Math.min(1, a)) }
}

const over = (color, background) => color.a >= 1
  ? color
  : {
      r: color.r * color.a + background.r * (1 - color.a),
      g: color.g * color.a + background.g * (1 - color.a),
      b: color.b * color.a + background.b * (1 - color.a),
      a: 1,
    }

function luminance(color) {
  const channel = (value) => {
    const scaled = value / 255
    return scaled <= 0.03928 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b)
}

const contrast = (foreground, background) => {
  const first = luminance(foreground)
  const second = luminance(background)
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05)
}

const show = (color) => color === null
  ? 'unresolved'
  : `rgb(${String(Math.round(color.r))} ${String(Math.round(color.g))} ${String(Math.round(color.b))}${color.a < 1 ? ` / ${color.a.toFixed(2)}` : ''})`

/** Load the two mode maps and the critical pairs; shared by CLI and rebrand. */
export function loadContrastModel() {
  const design = readFileSync(DESIGN_PLATFORM, 'utf8')
  const skin = readFileSync(join(SKIN_DIR, 'skin.css'), 'utf8')
  const patches = readFileSync(join(SKIN_DIR, 'patches.css'), 'utf8')
  const lightBase = blockTokens(design, selector => selector === 'body')
  // The macOS-platform block also keys on body[data-ds-dark-theme]; it is not
  // this checkout's platform and would skew the dark map with darwin values.
  const darkBase = blockTokens(design, selector => selector.includes('body[data-ds-dark-theme]') && !selector.includes('data-platform'))
  // The served skin is scoped under html[data-dsh-skin], which outranks both
  // base blocks on body and below, so its declarations win in either mode.
  const skinTokens = new Map([
    ...blockTokens(skin, selector => selector === ':root'),
    ...blockTokens(patches, selector => selector === ':root'),
  ])
  const modes = {
    dark: new Map([...lightBase, ...darkBase, ...skinTokens]),
    light: new Map([...lightBase, ...skinTokens]),
  }
  const tooltipRepaint = /\[role="tooltip"\][\s\S]*?color:\s*var\(--dsw-static-neutral-bluish-1000/.test(patches)
  // Upper-layer surfaces inherit upstream's broken pairings (error-primary ink
  // on an error-secondary ground; a translucent layer token used as ink over a
  // light fill; raw upstream reds on the dark glass). patches.css must repaint
  // each. Extract the repaint's own declarations so the critical pairs measure
  // what the operator actually sees; a pair without its repaint falls back to
  // the module's source pairing, which must fail.
  const repaintRule = (selector) => {
    const rule = new RegExp(`${selector}\\s*\\{([^}]*)\\}`).exec(patches)
    return rule === null ? undefined : {
      fg: /(?:^|;)\s*color\s*:\s*([^;]+)/.exec(rule[1])?.[1]?.trim(),
      bg: /(?:^|;)\s*background(?:-color)?\s*:\s*([^;]+)/.exec(rule[1])?.[1]?.trim(),
    }
  }
  const poolPillRepaint = repaintRule('\\[class\\*="poolPillError"\\]')
  const brokenBadgeRepaint = repaintRule('\\[class\\*="brokenBadge"\\]')
  const solidTagRepaint = repaintRule('\\[data-tone=[\'"]solid[\'"]\\]')
  const composerBadgeRepaint = repaintRule('\\[class\\*="optionLine"\\]\\s*>\\s*\\[class\\*="badge"\\]')
  const badgeErrorRepaint = repaintRule('\\[class\\*="badgeError"\\]')
  return { modes, tooltipRepaint, poolPillRepaint, brokenBadgeRepaint, solidTagRepaint, composerBadgeRepaint, badgeErrorRepaint }
}

/** The menu material token must stay defined in the theme styles or the skin. */
function menuBackdropDefined() {
  const candidates = [join(SKIN_DIR, 'skin.css'), join(SKIN_DIR, 'patches.css')]
  const themeStyles = join(HARNESS, 'packages/client/ui-theme/src/styles')
  try {
    for (const name of readdirSync(themeStyles)) if (name.endsWith('.css')) candidates.push(join(themeStyles, name))
  } catch { /* theme styles unreadable; the skin files above still count */ }
  return candidates.some(file => {
    try { return /--dsw-menu-backdrop-filter\s*:/.test(readFileSync(file, 'utf8')) } catch { return false }
  })
}

/** Recursive relative file list of a skin directory. */
function skinFiles(root) {
  const out = []
  const walk = (dir) => {
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.isFile()) out.push(relative(root, full))
    }
  }
  walk(root)
  return out.sort()
}

/** Live skin ↔ dotfiles mirror must stay byte-identical (freeze: no drift). */
function mirrorDrift() {
  if (!existsSync(MIRROR_SKIN)) return [] // no mirror on this device
  const live = skinFiles(SKIN_DIR)
  const mirror = skinFiles(MIRROR_SKIN)
  const drift = []
  for (const file of live) {
    if (!mirror.includes(file)) {
      drift.push(`skin mirror: ${file} missing in ${MIRROR_SKIN} (a ds pull would revert the live skin)`)
      continue
    }
    try {
      if (!readFileSync(join(SKIN_DIR, file)).equals(readFileSync(join(MIRROR_SKIN, file)))) {
        drift.push(`skin mirror: ${file} differs from the live skin (a ds pull would revert it)`)
      }
    } catch (error) {
      drift.push(`skin mirror: cannot compare ${file} (${error instanceof Error ? error.message : String(error)})`)
    }
  }
  for (const file of mirror) if (!live.includes(file)) drift.push(`skin mirror: extra ${file} in ${MIRROR_SKIN} (not in the live skin)`)
  return drift
}

/**
 * Composer-seat band guard (input-card glass): the seat must never carry a
 * session-wide glass layer of its own. The card is the composer's only glass
 * (the skin-center frost painted on [data-composer-card]); a seat `::before`
 * mask paints a full-column band to the left and right of the card, which
 * reads as a second glazed pane of the session and stops the card from
 * floating. The skin-center scene neutralizer removed the same layer only
 * while backdrop art was mounted, so any marker-less state (skin activation,
 * try-on/switch, a scene-controller teardown, first paint) exposed it. Kept
 * as a guard so a skin pass cannot reintroduce the band.
 */
function composerBandDrift() {
  const drift = []
  let patches
  try {
    patches = readFileSync(join(SKIN_DIR, 'patches.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, ' ')
  } catch (error) {
    return [`composer band: cannot read ${join(SKIN_DIR, 'patches.css')} (${error instanceof Error ? error.message : String(error)})`]
  }
  const rule = /([^{}]*composerSeat[^{}]*)\{([^{}]*)\}/g
  let match
  while ((match = rule.exec(patches)) !== null) {
    const selector = match[1].trim()
    const body = match[2]
    if (!/::?before\b/.test(selector)) continue
    const values = []
    for (const property of ['background', 'background-image', 'background-color', 'backdrop-filter', '-webkit-backdrop-filter']) {
      const declaration = new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([^;]+)`, 'g')
      for (const hit of body.matchAll(declaration)) values.push(hit[1].trim())
    }
    if (values.some(value => !/^(none|transparent)\b/.test(value))) {
      drift.push(`composer band: ${selector} paints a session-wide layer (${body.replace(/\s+/g, ' ').trim().slice(0, 90)})`)
    }
  }
  return drift
}

/** One resolved pair → {ratio, fg, bg} for a mode, or null when a token is unhandled. */
function measureRaw(mode, fgRaw, bgRaw) {
  const lookup = (name) => mode.get(name)
  const ground = parseColor('var(--dsw-static-neutral-00)', lookup) ?? { r: 7, g: 19, b: 33, a: 1 }
  const fg = parseColor(fgRaw, lookup)
  const bgRawColor = parseColor(bgRaw, lookup)
  if (fg === null || bgRawColor === null) return null
  const bg = over(bgRawColor, ground)
  return { ratio: contrast(over(fg, bg), bg), fg: over(fg, bg), bg }
}

/** The named surfaces this skin must keep readable; each pair is checked in both modes. */
function criticalPairs({ tooltipRepaint, poolPillRepaint, brokenBadgeRepaint, solidTagRepaint, composerBadgeRepaint, badgeErrorRepaint }) {
  const poolPatched = poolPillRepaint?.fg !== undefined && poolPillRepaint?.bg !== undefined
  return [
    { id: 'toast text', fg: 'var(--dsw-alias-toast-label)', bg: 'var(--dsw-alias-toast-bg)' },
    { id: 'toast action', fg: 'var(--dsw-static-deepseek-400)', bg: 'var(--dsw-alias-toast-bg)' },
    tooltipRepaint
      ? { id: 'tooltip text (patched)', fg: 'var(--dsw-static-neutral-bluish-1000)', bg: 'var(--dsw-alias-tooltip-bg)' }
      : { id: 'tooltip text (patches repaint MISSING)', fg: 'var(--dsw-static-neutral-bluish-00)', bg: 'var(--dsw-alias-tooltip-bg)' },
    { id: 'dialog body', fg: 'var(--dsw-alias-label-primary)', bg: 'var(--dsw-alias-bg-layer-2)' },
    { id: 'menu row', fg: 'var(--dsw-alias-label-primary)', bg: 'var(--dsw-menu-surface-fill)' },
    // State pills (frozen 2026-09-27): upstream's dark theme maps error-primary
    // onto error-secondary (1.21:1 in the skin), and the skin's success/warn
    // tertiary chip grounds were too light for their primary inks (3.8-4.1:1).
    poolPatched
      ? { id: 'pool error pill (patched)', fg: poolPillRepaint.fg, bg: poolPillRepaint.bg }
      : { id: 'pool error pill (patches repaint MISSING)', fg: 'var(--dsw-alias-state-error-primary)', bg: 'var(--dsw-alias-state-error-secondary)' },
    { id: 'state success chip', fg: 'var(--dsw-alias-state-success-primary)', bg: 'var(--dsw-alias-state-success-tertiary)' },
    { id: 'state context chip', fg: 'color-mix(in srgb, var(--dsw-alias-state-success-primary) 68%, var(--dsw-alias-label-secondary))', bg: 'var(--dsw-alias-state-success-tertiary)' },
    { id: 'state warn chip', fg: 'var(--dsw-alias-state-warn-label)', bg: 'var(--dsw-alias-state-warn-tertiary)' },
    { id: 'state revert chip', fg: 'var(--dsw-alias-state-error-secondary)', bg: 'color-mix(in srgb, var(--dsw-alias-state-error-primary) 14%, var(--dsw-alias-bg-layer-1))' },
    // Badge family (frozen 2026-09-27): module-level ink/ground pairings the
    // token map cannot express — see the badge legibility block in
    // patches.css. Each pair measures the repaint when present and the
    // module's own broken pairing otherwise, so a removed repaint fails here.
    brokenBadgeRepaint?.fg !== undefined && brokenBadgeRepaint?.bg !== undefined
      ? { id: 'broken preset badge (patched)', fg: brokenBadgeRepaint.fg, bg: brokenBadgeRepaint.bg }
      : { id: 'broken preset badge (patches repaint MISSING)', fg: 'var(--dsw-alias-bg-layer-3)', bg: 'var(--dsw-alias-state-error-primary)' },
    solidTagRepaint?.fg !== undefined
      ? { id: 'solid tag (patched)', fg: solidTagRepaint.fg, bg: 'var(--dsw-alias-label-primary)' }
      : { id: 'solid tag (patches repaint MISSING)', fg: 'var(--dsw-alias-bg-layer-3)', bg: 'var(--dsw-alias-label-primary)' },
    composerBadgeRepaint?.fg !== undefined
      ? { id: 'composer badge (patched)', fg: composerBadgeRepaint.fg, bg: 'var(--dsw-specific-sidebar-nav-item-active-accent)' }
      : { id: 'composer badge (patches repaint MISSING)', fg: 'var(--dsw-alias-button-info-fill)', bg: 'var(--dsw-specific-sidebar-nav-item-active-accent)' },
    badgeErrorRepaint?.fg !== undefined && badgeErrorRepaint?.bg !== undefined
      ? { id: 'revert error badge (patched)', fg: badgeErrorRepaint.fg, bg: badgeErrorRepaint.bg }
      : { id: 'revert error badge (patches repaint MISSING)', fg: '#ef4444', bg: 'rgba(239, 68, 68, 0.2)' },
  ]
}

const SURFACE_SELECTOR = /toast|tooltip|dialog|menu|popover|sheet|overlay|lightbox|hovercard|modal|confirm/i

/** Scan client CSS rules that paint ink over their own surface. */
function scanSurfaceRules() {
  const rows = []
  for (const file of cssFiles(HARNESS)) {
    const css = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
    const re = /([^{}]+)\{([^{}]*)\}/g
    let match
    while ((match = re.exec(css)) !== null) {
      const selector = match[1].trim()
      const body = match[2]
      if (!SURFACE_SELECTOR.test(selector)) continue
      if (/Tooltip\.module\.css$/.test(file)) continue // repainted by patches.css; asserted above
      const colorMatch = /(?:^|;)\s*color\s*:\s*([^;]+)/.exec(body)
      const backgroundMatch = /(?:^|;)\s*background(?:-color)?\s*:\s*([^;]+)/.exec(body)
      if (colorMatch === null || backgroundMatch === null) continue
      const bg = backgroundMatch[1].trim()
      if (bg === 'transparent' || bg === 'none' || /gradient|url\(/.test(bg)) continue
      rows.push({ file: file.slice(HARNESS.length + 1), selector: selector.slice(0, 70), fgToken: colorMatch[1].trim(), bgToken: bg })
    }
  }
  return rows
}

/** Run the whole verdict; returns failure strings (empty = clean). */
export function contrastDrift({ report = false } = {}) {
  const drift = [...mirrorDrift(), ...composerBandDrift()]
  let model
  try {
    model = loadContrastModel()
  } catch (error) {
    return [...drift, `token-contrast: cannot load ${DESIGN_PLATFORM} / ${SKIN_DIR} (${error instanceof Error ? error.message : String(error)})`]
  }
  const rows = []
  if (!menuBackdropDefined()) {
    drift.push('token-contrast: --dsw-menu-backdrop-filter is defined nowhere (ui-theme styles + skin) — every MenuSurface loses its backdrop blur')
  }
  for (const pair of criticalPairs(model)) {
    for (const modeName of ['dark', 'light']) {
      const measured = measureRaw(model.modes[modeName], pair.fg, pair.bg)
      if (measured === null) {
        drift.push(`token-contrast ${modeName}: ${pair.id} unresolved (${pair.fg} on ${pair.bg})`)
        continue
      }
      rows.push({ surface: pair.id, mode: modeName, fg: show(measured.fg), bg: show(measured.bg), ratio: measured.ratio })
      if (measured.ratio < FLOOR) {
        drift.push(`token-contrast ${modeName}: ${pair.id} ${measured.ratio.toFixed(2)}:1 < ${String(FLOOR)}:1 (${show(measured.fg)} on ${show(measured.bg)})`)
      }
    }
  }
  for (const rule of scanSurfaceRules()) {
    for (const modeName of ['dark', 'light']) {
      const measured = measureRaw(model.modes[modeName], rule.fgToken, rule.bgToken)
      if (measured === null) continue
      rows.push({ surface: `${rule.selector} (${rule.file})`, mode: modeName, fg: show(measured.fg), bg: show(measured.bg), ratio: measured.ratio })
      if (measured.ratio < FLOOR) {
        drift.push(`token-contrast ${modeName}: ${rule.selector} ${measured.ratio.toFixed(2)}:1 < ${String(FLOOR)}:1 (${rule.fgToken} on ${rule.bgToken}, ${rule.file})`)
      }
    }
  }
  if (report) {
    const byMode = { dark: [], light: [] }
    for (const row of rows) byMode[row.mode]?.push(row)
    for (const modeName of ['dark', 'light']) {
      console.log(`[contrast] ${modeName} (floor ${String(FLOOR)}:1):`)
      for (const row of byMode[modeName]) {
        console.log(`  ${row.ratio.toFixed(2).padStart(6)}:1  ${row.surface} — ${row.fg} on ${row.bg}`)
      }
    }
  }
  return drift
}

const invokedDirectly = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) {
  const asJson = process.argv.includes('--json')
  const drift = contrastDrift({ report: !asJson })
  if (asJson) console.log(JSON.stringify({ drift }, null, 2))
  if (drift.length > 0) {
    console.error(`[contrast] DRIFT (${String(drift.length)}):`)
    for (const item of drift) console.error(`  - ${item}`)
    process.exit(1)
  }
  console.log(`[contrast] PASS: overlay pairs + state pills >= ${String(FLOOR)}:1 in dark and light; menu material defined`)
}
