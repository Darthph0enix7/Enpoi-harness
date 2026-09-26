#!/usr/bin/env node
/**
 * Glass-seam probe v2: proves the shell's glass edges stay glued while panels,
 * sidebars and the terminal dock move, including retargeting under spam clicks.
 *
 * Method (Oracle-amended): two samplers against a running `dsh web` origin.
 * - Live rAF sampling (never paused) for spam / dock / dock-sidebar / dock-reopen:
 *   frame-to-frame edge continuity, marker continuity, edge alignment. Since
 *   criterion v3 continuity is transition-clock aware: a move beyond
 *   NO_TRANSITION_JUMP_PX with no running track transition (and no completion
 *   tail at the previous frame) is a snap, while the browser's shortened
 *   reversal on a mid-ride retarget stays a running transition and passes.
 *   Dock edges keep the v2 fraction-of-span rule (element-owned transform).
 * - Stepped sampling (pause animations, walk currentTime in 10 ms steps) for the
 *   discrete single/both/crossed rides: geometric gap, marker presence, moving
 *   sample count, start skew.
 * The scenario matrix and the criterion constants are versioned and their
 * sha256 values land in every verdict so coverage and semantics cannot change
 * silently (matrixHash, criterionHash). Frozen mid-motion frames (sentinel page
 * background) classify the seam against the skin's own glass tokens; the
 * resting right-panel corridor is asserted against RIGHT_CORRIDOR_TARGET — the
 * one constant to flip when the panel's material choice is made.
 *
 * Usage: node scripts/glass-seam-probe.mjs [--origin=URL] [--out=DIR]
 *        [--width=1440] [--height=900] [--json] [--only=spam,material,...]
 * Exit: 0 pass, 1 violations, 2 harness error.
 */
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'

const requireFromWeb = createRequire(new URL('../apps/web/package.json', import.meta.url))

/** Probe method version; bump when the sampler or assertions change. */
const PROBE_VERSION = 3

/**
 * Versioned, append-only scenario matrix. `widths` lists the viewports a
 * scenario runs at; anything absent is recorded as skipped with a reason.
 */
const MATRIX = [
  { id: 'left-single', method: 'stepped', widths: [1440, 1024, 420], orient: 'left' },
  { id: 'right-single', method: 'stepped', widths: [1440, 1024], orient: 'right' },
  { id: 'both', method: 'stepped', widths: [1440, 1024], orient: 'both' },
  { id: 'crossed', method: 'stepped', widths: [1440, 1024], orient: 'both' },
  { id: 'spam', method: 'live', widths: [1440, 1024], orient: 'right' },
  { id: 'dock', method: 'live', widths: [1440, 1024, 420], orient: 'dock' },
  { id: 'dock-sidebar', method: 'live', widths: [1440, 1024, 420], orient: 'dock' },
  { id: 'dock-reopen', method: 'live', widths: [1440, 1024, 420], orient: 'dock' },
]
const matrixHash = createHash('sha256').update(JSON.stringify(MATRIX)).digest('hex').slice(0, 16)

/** Sentinel page background used for the layer-classification scan. */
const SENTINEL = [255, 0, 255]
const WINDOW = 8
const MIN_RUN = 3
const BORDER_RUN = 2
const CLASS_TOLERANCE = 12
const SENTINEL_TOLERANCE = 50
/** Geometry acceptance. */
const MAX_GAP_PX = 0.5
const MIN_MOVING_SAMPLES = 5
const MAX_STEP_FRACTION = 0.25
const MAX_START_SKEW_FRAMES = 1
/**
 * Live continuity is transition-clock aware (criterion v3): an edge move is a
 * snap only when no track transition can explain it. A running track transition
 * (including the browser's spec-mandated shortened reversal when a click
 * retargets a ride mid-flight) interpolates every painted value, so any delta it
 * produces is continuous by construction; the span-fraction test below is kept
 * for dock scenarios, whose edge is owned by the dock's own transform.
 */
const MAX_FRAME_DELTA_FRACTION = 0.25
/**
 * Frame gaps longer than this make a large delta interpolation, not a snap —
 * used only by the v2 dock fraction rule.
 */
const MAX_CONTINUITY_DT_MS = 16.7
/**
 * A frame-to-frame edge move beyond this many pixels with no running track
 * transition (and no just-finished one at the previous frame without a target
 * change) is a snap: nothing interpolated it. Sub-pixel layout noise stays below.
 */
const NO_TRANSITION_JUMP_PX = 2
/** Criterion version: 2 = fraction-of-span only, 3 = transition-clock aware. */
const CRITERION_VERSION = 3
const criterionHash = createHash('sha256').update(JSON.stringify({
  criterionVersion: CRITERION_VERSION,
  maxGapPx: MAX_GAP_PX,
  minMovingSamples: MIN_MOVING_SAMPLES,
  maxStepFraction: MAX_STEP_FRACTION,
  maxStartSkewFrames: MAX_START_SKEW_FRAMES,
  maxFrameDeltaFraction: MAX_FRAME_DELTA_FRACTION,
  maxContinuityDtMs: MAX_CONTINUITY_DT_MS,
  noTransitionJumpPx: NO_TRANSITION_JUMP_PX,
})).digest('hex').slice(0, 16)
/**
 * Resting material for the right-panel corridor, the ONE flip point:
 * 'panel-glass-double' (restored: panel fill + tab-body ground = the browser
 * page and editor depth, twice bg-base over the frame), 'panel-glass' (one
 * fill), 'frame-glass' (panel transparent over the frame ground), or
 * 'sidebar-fill' (the left sidebar's tint).
 */
const RIGHT_CORRIDOR_TARGET = 'panel-glass-double'
/** RGB distance allowed between the measured corridor and the chosen target. */
const MATERIAL_CLASS_TOLERANCE = 12
/** RGB distance at which left and right interiors would read as the same material. */
const MATERIAL_PARITY_TOLERANCE = 10
const FROZEN_MS = [60, 120, 180, 240]

const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const hit = args.find(a => a.startsWith(`--${name}=`))
  return hit === undefined ? fallback : hit.slice(name.length + 3)
}
const ORIGIN = flag('origin', process.env.DSH_GLASS_ORIGIN ?? 'https://serverlocal.pike-acrux.ts.net:8443/')
const OUT = flag('out', '')
const WIDTH = Number(flag('width', '1440'))
const HEIGHT = Number(flag('height', '900'))
const JSON_ONLY = args.includes('--json')
/** Optional comma-separated scenario filter for diagnosis; absent = full matrix. */
const ONLY = flag('only', '').split(',').filter(Boolean)
const { chromium } = requireFromWeb('playwright')

/** Minimal PNG decoder: 8-bit RGB/RGBA, non-interlaced, all filter types. */
function decodePng(buffer) {
  if (buffer.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG')
  let offset = 8
  let header = null
  const idat = []
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset)
    const type = buffer.toString('ascii', offset + 4, offset + 8)
    const body = buffer.subarray(offset + 8, offset + 8 + length)
    if (type === 'IHDR') header = { width: body.readUInt32BE(0), height: body.readUInt32BE(4), depth: body[8], color: body[9], interlace: body[12] }
    else if (type === 'IDAT') idat.push(body)
    else if (type === 'IEND') break
    offset += 12 + length
  }
  if (header === null) throw new Error('PNG without IHDR')
  if (header.depth !== 8 || header.interlace !== 0 || (header.color !== 2 && header.color !== 6)) throw new Error(`unsupported PNG (depth ${header.depth}, color ${header.color})`)
  const channels = header.color === 6 ? 4 : 3
  const raw = zlib.inflateSync(Buffer.concat(idat))
  const stride = header.width * channels
  const out = Buffer.alloc(header.height * stride)
  const paeth = (a, b, c) => { const p = a + b - c; const pa = Math.abs(p - a); const pb = Math.abs(p - b); const pc = Math.abs(p - c); return pa <= pb && pa <= pc ? a : pb <= pc ? b : c }
  for (let y = 0; y < header.height; y++) {
    const filter = raw[y * (stride + 1)]
    const src = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride)
    const dst = out.subarray(y * stride, (y + 1) * stride)
    const prev = y === 0 ? null : out.subarray((y - 1) * stride, y * stride)
    for (let i = 0; i < stride; i++) {
      const left = i >= channels ? dst[i - channels] : 0
      const up = prev === null ? 0 : prev[i]
      const upLeft = prev === null || i < channels ? 0 : prev[i - channels]
      const value = src[i]
      dst[i] = filter === 0 ? value : filter === 1 ? (value + left) & 0xff : filter === 2 ? (value + up) & 0xff : filter === 3 ? (value + ((left + up) >> 1)) & 0xff : (value + paeth(left, up, upLeft)) & 0xff
    }
  }
  return { width: header.width, height: header.height, channels, data: out }
}

const dist = (a, b) => Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2)
const composite = (fg, bg) => [
  Math.round(fg[3] * fg[0] + (1 - fg[3]) * bg[0]),
  Math.round(fg[3] * fg[1] + (1 - fg[3]) * bg[1]),
  Math.round(fg[3] * fg[2] + (1 - fg[3]) * bg[2]),
]
const parseColor = css => {
  const m = /rgba?\(([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+))?\)/.exec(css)
  return m === null ? null : [Number(m[1]), Number(m[2]), Number(m[3]), m[4] === undefined ? 1 : Number(m[4])]
}

const SENTINEL_CSS = `
body { background: #ff00ff !important; }
body > div[style*="z-index: -2"] { background: transparent !important; }
body > div[style*="z-index: -2"] > * { visibility: hidden !important; }
`

/** In-page live sampler: never pauses; records once per animation frame. */
const LIVE_SAMPLER = `
(() => {
  const rect = el => { if (!el) return null; const r = el.getBoundingClientRect(); return [+r.left.toFixed(2), +r.top.toFixed(2), +r.right.toFixed(2), +r.bottom.toFixed(2)] };
  const frame = () => document.querySelector('[data-rightbar-col]')?.parentElement ?? null;
  const glass = () => {
    const f = frame(); if (!f) return null;
    const center = f.children[1]; const cr = center.getBoundingClientRect();
    for (const el of center.querySelectorAll('*')) {
      const bg = getComputedStyle(el).backgroundColor;
      const m = /rgba?\\(([^)]+)\\)/.exec(bg);
      const parts = m === null ? [] : m[1].split(',').map(Number);
      const alpha = parts.length === 4 ? parts[3] : (m === null ? 0 : 1);
      if (alpha < 0.2) continue;
      const b = el.getBoundingClientRect();
      if (b.width > cr.width * 0.4 && b.height > cr.height * 0.5) return { el, cls: String(el.className).split(' ')[0] };
    }
    return { el: center, cls: 'center' };
  };
  window.__liveProbe = {
    frames: [], clicks: [], running: false,
    start() {
      this.frames = []; this.clicks = []; this.running = true;
      document.addEventListener('click', event => {
        const item = event.target?.closest?.('[data-sidebar-right-rail-item]');
        if (item) this.clicks.push(+performance.now().toFixed(1));
      }, true);
      const loop = () => {
        if (!this.running) return;
        const f = frame();
        const panel = document.querySelector('[data-sidebar-right-panel]');
        const dock = document.querySelector('[data-enpoi-bottom-dock]');
        this.frames.push({
          t: +performance.now().toFixed(1),
          glass: (() => { const g = glass(); return g === null ? null : rect(g.el) })(),
          glassCls: glass()?.cls ?? null,
          sidebar: rect(f ? f.children[0] : null),
          panel: panel ? { left: +panel.getBoundingClientRect().left.toFixed(2), open: panel.hasAttribute('data-sidebar-right-open') } : null,
          dock: dock ? { rect: rect(dock), open: dock.hasAttribute('data-enpoi-bottom-dock-open'), marker: document.body.hasAttribute('data-enpoi-bottom-dock-open') } : null,
          anim: f ? f.hasAttribute('data-animating') : false,
          progress: (() => {
            if (!f) return null;
            const raw = getComputedStyle(f).getPropertyValue('--dsh-rightbar-progress').trim();
            return raw === '' ? null : Number(raw);
          })(),
          anims: f ? f.getAnimations().map(a => (a.transitionProperty ?? a.animationName ?? '?') + ':' + a.playState) : [],
          spec: f ? f.style.getPropertyValue('--dsh-rightbar-progress') : null,
          specSidebar: f ? f.style.getPropertyValue('--dsh-sidebar-track') : null,
          trans: f ? f.getAnimations().filter(a => a.transitionProperty === '--dsh-rightbar-progress' || a.transitionProperty === '--dsh-sidebar-track').map(a => ({
            p: a.transitionProperty,
            state: a.playState,
            ct: a.currentTime === null ? null : +a.currentTime.toFixed(1),
            st: a.startTime === null ? null : +a.startTime.toFixed(1),
            dur: a.effect ? a.effect.getTiming().duration : null,
            pr: a.effect ? a.effect.getComputedTiming().progress : null,
          })) : [],
        });
        requestAnimationFrame(loop);
      };
      requestAnimationFrame(loop);
    },
    stop() { this.running = false; return { frames: this.frames, clicks: this.clicks } },
  };
})();
`

async function main() {
  const browser = await chromium.launch({ headless: true, args: ['--disable-frame-rate-limit', '--disable-gpu-vsync', '--disable-background-timer-throttling'] })
  const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT }, ignoreHTTPSErrors: true })
  const outDir = OUT === '' ? '' : path.resolve(OUT)
  if (outDir !== '') fs.mkdirSync(outDir, { recursive: true })
  const report = {
    probeVersion: PROBE_VERSION,
    criterionVersion: CRITERION_VERSION,
    criterionHash,
    matrixHash,
    width: WIDTH,
    height: HEIGHT,
    origin: ORIGIN,
    only: ONLY.length > 0 ? ONLY : null,
    scenarios: {},
    violations: [],
  }
  try {
    await page.goto(ORIGIN, { waitUntil: 'load', timeout: 90000 })
    await page.waitForSelector('[data-rightbar-col]', { timeout: 30000, state: 'attached' })
    await page.waitForTimeout(2500)
    await page.addStyleTag({ content: SENTINEL_CSS })

    const resolveToken = name => page.evaluate(token => {
      const el = document.createElement('div')
      el.style.cssText = `position:fixed;left:-100px;top:0;width:8px;height:8px;background:var(${token})`
      document.body.appendChild(el)
      const color = getComputedStyle(el).backgroundColor
      el.remove()
      return color
    }, name)
    const frameToken = parseColor(await resolveToken('--dsw-alias-bg-base'))
    const sidebarToken = parseColor(await resolveToken('--dsw-specific-sidebar-fill'))
    if (frameToken === null) throw new Error('cannot resolve --dsw-alias-bg-base')
    if (frameToken[3] >= 1) {
      report.violations.push({ motion: 'skin-active', reasons: [`--dsw-alias-bg-base is opaque (alpha ${frameToken[3]}): the layer classifier would degenerate`] })
    }
    const glass1 = composite(frameToken, SENTINEL)
    const glass2 = composite(frameToken, glass1)
    const glass3 = composite(frameToken, glass2)
    const sidebarLayer = sidebarToken === null ? glass1 : composite(sidebarToken, glass1)
    const targetComposites = { 'panel-glass-double': glass3, 'panel-glass': glass2, 'frame-glass': glass1, 'sidebar-fill': sidebarLayer }
    report.layers = { frameToken, sidebarToken, glass1, glass2, glass3, sidebarLayer, rightCorridorTarget: RIGHT_CORRIDOR_TARGET, targetComposite: targetComposites[RIGHT_CORRIDOR_TARGET] }

    const state = () => page.evaluate(() => {
      const f = document.querySelector('[data-rightbar-col]')?.parentElement
      const dock = document.querySelector('[data-enpoi-bottom-dock]')
      return {
        panelOpen: !!document.querySelector('[data-sidebar-right-panel]')?.hasAttribute('data-sidebar-right-open'),
        panelKind: document.querySelector('[data-sidebar-right-rail-item][data-sidebar-right-rail-active]')?.getAttribute('data-sidebar-right-rail-item') ?? null,
        sidebarCollapsed: f?.hasAttribute('data-sidebar-collapsed') ?? null,
        dockOpen: !!dock?.hasAttribute('data-enpoi-bottom-dock-open'),
      }
    })
    const wait = ms => page.waitForTimeout(ms)
    const files = '[data-sidebar-right-rail-item="files"]'
    const sidebar = '[aria-label="Collapse sidebar"], [aria-label="Open sidebar"], [aria-label="Expand sidebar"]'
    const dockSel = '[data-enpoi-terminal-bottom-toggle]'

    const ensurePanel = async (kind, open) => {
      for (let i = 0; i < 8; i++) {
        const s = await state()
        if (s.panelOpen === open && (!open || s.panelKind === kind)) return
        if (s.panelOpen && s.panelKind !== kind && open) { await page.click(kind === 'files' ? files : files); await wait(450); continue }
        await page.click(files)
        await wait(450)
      }
      throw new Error(`cannot set panel ${kind} to ${open}`)
    }
    const ensureSidebar = async expanded => {
      for (let i = 0; i < 6; i++) {
        const s = await state()
        if (s.sidebarCollapsed === !expanded) return
        await page.click(sidebar)
        await wait(500)
      }
      throw new Error(`cannot set sidebar expanded=${expanded}`)
    }
    const ensureDock = async open => {
      for (let i = 0; i < 6; i++) {
        const s = await state()
        if (s.dockOpen === open) return
        await page.click(dockSel)
        await wait(500)
      }
      throw new Error(`cannot set dock open=${open}`)
    }

    const captureRects = () => page.evaluate(() => {
      const r = el => { if (!el) return null; const b = el.getBoundingClientRect(); return [+b.left.toFixed(2), +b.top.toFixed(2), +b.right.toFixed(2), +b.bottom.toFixed(2)] }
      const f = document.querySelector('[data-rightbar-col]')?.parentElement
      const center = f ? f.children[1] : null
      const glass = (() => {
        if (center === null) return null
        const cr = center.getBoundingClientRect()
        for (const el of center.querySelectorAll('*')) {
          const bg = getComputedStyle(el).backgroundColor
          const m = /rgba?\(([^)]+)\)/.exec(bg)
          const parts = m === null ? [] : m[1].split(',').map(Number)
          const alpha = parts.length === 4 ? parts[3] : (m === null ? 0 : 1)
          if (alpha < 0.2) continue
          const b = el.getBoundingClientRect()
          if (b.width > cr.width * 0.4 && b.height > cr.height * 0.5) return el
        }
        return center
      })()
      const dock = document.querySelector('[data-enpoi-bottom-dock]')
      return {
        center: r(center), mainGlass: r(glass),
        sidebar: r(f ? f.children[0] : null),
        panel: r(document.querySelector('[data-sidebar-right-panel]')),
        panelOpen: !!document.querySelector('[data-sidebar-right-panel]')?.hasAttribute('data-sidebar-right-open'),
        dock: r(dock), dockOpen: !!dock?.hasAttribute('data-enpoi-bottom-dock-open'),
        anim: f ? f.hasAttribute('data-animating') : false,
      }
    })

    async function scanShot(name, orient) {
      const rects = await captureRects()
      const file = path.join(outDir === '' ? '/tmp' : outDir, `${name}.png`)
      await page.screenshot({ path: file })
      return { file: outDir === '' ? undefined : `${name}.png`, rects, scan: await classify(orient, rects, file) }
    }

    async function classify(orient, rects, file) {
      const png = decodePng(fs.readFileSync(file))
      const { width, height, channels, data } = png
      const px = (x, y) => { const i = (y * width + x) * channels; return [data[i], data[i + 1], data[i + 2]] }
      const median = list => { const s = [...list].sort((a, b) => a - b); return s[Math.floor(s.length / 2)] }
      const main = orient === 'right' ? rects.mainGlass?.[2] : orient === 'left' ? rects.mainGlass?.[0] : rects.mainGlass?.[3]
      const face = orient === 'right' ? rects.panel?.[0] : orient === 'left' ? rects.sidebar?.[2] : rects.dock?.[1]
      if (main === undefined || face === undefined || main === null || face === null) return { skipped: 'missing rect' }
      const gap = face - main
      const vertical = orient !== 'dock'
      const lo = Math.floor(Math.min(main, face)) - WINDOW
      const hi = Math.ceil(Math.max(main, face)) + WINDOW
      const columns = []
      for (let c = lo; c <= hi; c++) {
        const colors = []
        for (let s = 40; s < (vertical ? height - 40 : width - 8); s += 3) colors.push(vertical ? px(c, s) : px(s, c))
        columns.push({ at: c, color: [median(colors.map(v => v[0])), median(colors.map(v => v[1])), median(colors.map(v => v[2]))] })
      }
      const classifyColor = color => {
        if (dist(color, SENTINEL) < SENTINEL_TOLERANCE) return 'wallpaper'
        if (dist(color, glass1) < CLASS_TOLERANCE) return 'single-glass'
        if (dist(color, glass2) < CLASS_TOLERANCE) return 'surface'
        if (dist(color, glass3) < CLASS_TOLERANCE) return 'triple-glass'
        if (sidebarToken !== null && dist(color, sidebarLayer) < CLASS_TOLERANCE) return 'sidebar-fill'
        return 'content'
      }
      const classes = columns.map(c => ({ ...c, cls: classifyColor(c.color) }))
      const runs = cls => {
        const out = []
        for (const col of classes) {
          if (col.cls !== cls) continue
          const last = out[out.length - 1]
          if (last !== undefined && col.at - last.end <= 1) last.end = col.at
          else out.push({ start: col.at, end: col.at })
        }
        return out.map(r => ({ start: r.start, end: r.end, width: r.end - r.start + 1, cls }))
      }
      const badRuns = [...runs('wallpaper'), ...runs('single-glass'), ...runs('triple-glass')]
      const violations = badRuns.filter(r => r.width >= (r.cls === 'wallpaper' ? 1 : MIN_RUN))
      const maxRun = {
        wallpaper: Math.max(0, ...badRuns.filter(r => r.cls === 'wallpaper').map(r => r.width)),
        'single-glass': Math.max(0, ...badRuns.filter(r => r.cls === 'single-glass').map(r => r.width)),
        'triple-glass': Math.max(0, ...badRuns.filter(r => r.cls === 'triple-glass').map(r => r.width)),
      }
      return {
        gap: +gap.toFixed(2), mainEdge: +main.toFixed(1), faceEdge: +face.toFixed(1),
        counts: {
          wallpaper: classes.filter(c => c.cls === 'wallpaper').length,
          singleGlass: classes.filter(c => c.cls === 'single-glass').length,
          surface: classes.filter(c => c.cls === 'surface').length,
          tripleGlass: classes.filter(c => c.cls === 'triple-glass').length,
          sidebarFill: classes.filter(c => c.cls === 'sidebar-fill').length,
        },
        maxRun, badRuns, violations,
      }
    }

    /** Stepped trace for discrete rides; retried once when nothing moved. */
    async function runStepped(scenario) {
      for (let attempt = 0; attempt < 2; attempt++) {
        const result = await steppedPass(scenario)
        if (result.travel >= 2 || attempt === 1) {
          if (outDir !== '') {
            // One fresh real-skin still at ~40 % of the ride for the report.
            await scenario.settle()
            await wait(400)
            await scenario.act()
            await wait(120)
            await page.screenshot({ path: path.join(outDir, `${scenario.id}-mid.png`) })
            await wait(400)
          }
          return result
        }
        await wait(300)
      }
      /* v8 ignore next -- the loop always returns */
      throw new Error(`stepped ride never moved: ${scenario.id}`)
    }

    async function steppedPass(scenario) {
      await scenario.settle()
      await wait(500)
      await scenario.act()
      await wait(60)
      const steps = await page.evaluate(() => {
        const r = el => { if (!el) return null; const b = el.getBoundingClientRect(); return [+b.left.toFixed(2), +b.top.toFixed(2), +b.right.toFixed(2), +b.bottom.toFixed(2)] }
        const read = () => {
          const f = document.querySelector('[data-rightbar-col]')?.parentElement
          const center = f ? f.children[1] : null
          const glass = (() => {
            if (center === null) return null
            const cr = center.getBoundingClientRect()
            for (const el of center.querySelectorAll('*')) {
              const bg = getComputedStyle(el).backgroundColor
              const m = /rgba?\(([^)]+)\)/.exec(bg)
              const parts = m === null ? [] : m[1].split(',').map(Number)
              const alpha = parts.length === 4 ? parts[3] : (m === null ? 0 : 1)
              if (alpha < 0.2) continue
              const b = el.getBoundingClientRect()
              if (b.width > cr.width * 0.4 && b.height > cr.height * 0.5) return el
            }
            return center
          })()
          return {
            marker: f ? f.hasAttribute('data-animating') : false,
            glass: r(glass),
            sidebar: r(f ? f.children[0] : null),
            panelLeft: document.querySelector('[data-sidebar-right-panel]')?.getBoundingClientRect().left ?? null,
            panelOpen: !!document.querySelector('[data-sidebar-right-panel]')?.hasAttribute('data-sidebar-right-open'),
            dockTop: document.querySelector('[data-enpoi-bottom-dock]')?.getBoundingClientRect().top ?? null,
            dockRect: r(document.querySelector('[data-enpoi-bottom-dock]')),
          }
        }
        for (const a of document.getAnimations()) { try { a.pause() } catch { /* non-pausable */ } }
        const rows = []
        for (let ms = 0; ms <= 300; ms += 10) {
          for (const a of document.getAnimations()) { try { a.currentTime = ms } catch { /* finished */ } }
          rows.push(read())
        }
        for (const a of document.getAnimations()) { try { a.play() } catch { /* gone */ } }
        return rows
      })
      if (outDir !== '') fs.writeFileSync(path.join(outDir, `${scenario.id}-steps.json`), JSON.stringify(steps))
      await wait(450)
      return summarizeStepped(scenario, steps)
    }

    function edgeGap(row, orient) {
      const g = row.glass
      if (g === null) return null
      if (orient === 'right') return row.panelLeft === null ? null : row.panelLeft - g[2]
      if (orient === 'left') return row.sidebar === null ? null : g[0] - row.sidebar[2]
      return row.dockTop === null ? null : row.dockTop - g[3]
    }
    function mainEdge(row, orient) {
      const g = row.glass
      if (g === null) return null
      return orient === 'right' ? g[2] : orient === 'left' ? g[0] : g[3]
    }

    function summarizeOne(steps, orient) {
      const edges = steps.map(s => mainEdge(s, orient)).filter(v => v !== null)
      const gaps = steps.map(s => edgeGap(s, orient)).filter(v => v !== null)
      const travel = Math.abs(edges[edges.length - 1] - edges[0])
      let maxStep = 0, moving = 0
      for (let i = 1; i < edges.length; i++) {
        const step = Math.abs(edges[i] - edges[i - 1])
        maxStep = Math.max(maxStep, step)
        if (step > 0.05) moving++
      }
      const firstMainMove = edges.findIndex((value, index) => index > 0 && Math.abs(value - edges[index - 1]) > 0.05)
      const faceSeries = steps.map(s => orient === 'right' ? s.panelLeft : orient === 'left' ? s.sidebar?.[2] ?? null : s.dockTop)
      const firstFaceMove = faceSeries.findIndex((value, index) => index > 0 && value !== null && faceSeries[index - 1] !== null && Math.abs(value - faceSeries[index - 1]) > 0.05)
      const markerContinuity = (() => {
        if (firstMainMove === -1) return { present: steps.every(s => s.marker), dropped: 0 }
        const relevant = steps.slice(firstMainMove)
        return { present: relevant.every(s => s.marker), dropped: relevant.filter((s, i) => !s.marker && i > 0).length }
      })()
      return {
        samples: steps.length,
        gapMin: gaps.length ? +Math.min(...gaps).toFixed(2) : null,
        gapMax: gaps.length ? +Math.max(...gaps).toFixed(2) : null,
        exposedSamples: gaps.filter(g => g > MAX_GAP_PX).length,
        movingSamples: moving,
        travel: +travel.toFixed(1),
        maxStepFraction: travel < 1 ? 0 : +(maxStep / travel).toFixed(3),
        markerPresentThroughRide: markerContinuity.present,
        markerDroppedWhileMoving: markerContinuity.dropped,
        startSkewFrames: firstMainMove === -1 || firstFaceMove === -1 ? null : firstFaceMove - firstMainMove,
      }
    }

    function summarizeStepped(scenario, steps) {
      if (scenario.orient !== 'both') return { method: 'stepped', ...summarizeOne(steps, scenario.orient) }
      const left = summarizeOne(steps, 'left')
      const right = summarizeOne(steps, 'right')
      const skew = [left.startSkewFrames, right.startSkewFrames].filter(v => v !== null)
      return {
        method: 'stepped',
        samples: steps.length,
        gapMin: Math.min(left.gapMin ?? 0, right.gapMin ?? 0),
        gapMax: Math.max(left.gapMax ?? 0, right.gapMax ?? 0),
        exposedSamples: left.exposedSamples + right.exposedSamples,
        movingSamples: Math.max(left.movingSamples, right.movingSamples),
        travel: Math.max(left.travel, right.travel),
        maxStepFraction: Math.max(left.maxStepFraction, right.maxStepFraction),
        markerPresentThroughRide: left.markerPresentThroughRide && right.markerPresentThroughRide,
        markerDroppedWhileMoving: left.markerDroppedWhileMoving + right.markerDroppedWhileMoving,
        startSkewFrames: skew.length === 0 ? null : skew.reduce((a, b) => Math.abs(b) > Math.abs(a) ? b : a),
        detail: { left, right },
      }
    }

    /** Live rAF trace: never paused; sees retargets and marker drops. */
    async function runLive(scenario) {
      await scenario.settle()
      await wait(500)
      await page.evaluate(LIVE_SAMPLER)
      await page.evaluate(() => window.__liveProbe.start())
      await scenario.act()
      if (outDir !== '') {
        await wait(120)
        await page.screenshot({ path: path.join(outDir, `${scenario.id}-mid.png`) })
      }
      await wait(Math.max(200, (scenario.durationMs ?? 1500) - 200))
      const { frames, clicks } = await page.evaluate(() => window.__liveProbe.stop())
      if (outDir !== '') fs.writeFileSync(path.join(outDir, `${scenario.id}-trace.json`), JSON.stringify({ clicks, frames }))
      return summarizeLive(scenario, frames, clicks)
    }

    function summarizeLive(scenario, frames, clicks = []) {
      const edgeOf = row => {
        if (scenario.orient === 'right') return row.glass?.[2] ?? null
        if (scenario.orient === 'left') return row.glass?.[0] ?? null
        if (scenario.orient === 'dock') return row.dock?.rect?.[1] ?? null
        return row.glass?.[2] ?? null
      }
      const gapOf = row => {
        if (scenario.orient === 'right') return row.panel === null || row.glass === null ? null : row.panel.left - row.glass[2]
        if (scenario.orient === 'left') return row.sidebar === null || row.glass === null ? null : row.glass[0] - row.sidebar[2]
        return row.dock === null || row.glass === null ? null : row.dock.rect[1] - row.glass[3]
      }
      // Criterion v3: the frame-owned track vars (left sidebar / rightbar
      // progress) interpolate through the browser's own CSS transitions, so an
      // edge move is a snap only when no track transition can explain it. The
      // shortened reversal the engine creates on a mid-ride retarget is still a
      // running transition and therefore continuous. Dock scenarios measure an
      // element-owned transform and keep the v2 fraction test.
      const frameOwnedTrack = scenario.orient === 'left' || scenario.orient === 'right'
      const trackProp = scenario.orient === 'left' ? '--dsh-sidebar-track' : '--dsh-rightbar-progress'
      const specOf = row => (scenario.orient === 'left' ? row.specSidebar : row.spec)
      const runningTrack = row => Array.isArray(row.trans)
        && row.trans.some(t => (t.p ?? trackProp) === trackProp && t.state === 'running')
      const gaps = frames.map(gapOf).filter(v => v !== null)
      const edges = []
      let maxDelta = 0, maxDeltaDt = 0, unexplainedJumpPx = 0, unexplainedJumpFrames = 0
      let previousRow = null, previousEdge = null
      for (let i = 0; i < frames.length; i++) {
        const row = frames[i]
        const edge = edgeOf(row)
        if (edge === null) { edges.length = 0; previousRow = null; previousEdge = null; continue }
        edges.push(edge)
        if (previousEdge !== null && previousRow !== null) {
          // A resolver switch (a different painted element) is a measurement
          // artifact, never a motion jump.
          if (row.glassCls === previousRow.glassCls) {
            const delta = Math.abs(edge - previousEdge)
            if (delta > maxDelta) { maxDelta = delta; maxDeltaDt = row.t - previousRow.t }
            if (frameOwnedTrack) {
              // A running transition interpolates the value; a transition that
              // just finished at the previous frame without a target change
              // explains the completion tail. Anything else that moves the edge
              // is a snap.
              const targetChanged = specOf(row) !== specOf(previousRow)
              const explained = runningTrack(row) || (runningTrack(previousRow) && !targetChanged)
              if (!explained && delta > NO_TRANSITION_JUMP_PX) {
                unexplainedJumpFrames++
                unexplainedJumpPx = Math.max(unexplainedJumpPx, delta)
              }
            }
          }
        }
        previousRow = row
        previousEdge = edge
      }
      const span = edges.length < 2 ? 0 : Math.max(...edges) - Math.min(...edges)
      // Continuity window: from the first marker rise (or first move) to the end.
      const firstMarker = frames.findIndex(f => f.anim || f.dock?.marker)
      const relevant = firstMarker === -1 ? frames : frames.slice(firstMarker)
      let markerDropWhileMoving = 0
      for (let i = 1; i < relevant.length; i++) {
        const prev = edgeOf(relevant[i - 1]); const next = edgeOf(relevant[i])
        const moved = prev !== null && next !== null && Math.abs(next - prev) > 0.05
        const marked = relevant[i].anim || relevant[i].dock?.marker === true
        if (moved && !marked && firstMarker !== -1 && i > 1) markerDropWhileMoving++
      }
      const dockAlign = scenario.orient === 'dock'
        ? frames.filter(f => f.dock !== null && f.dock.rect !== null && f.dock.rect[2] - f.dock.rect[0] > 1 && f.glass !== null).map(f => ({
          dLeft: Math.abs(f.dock.rect[0] - f.glass[0]),
          dRight: Math.abs(f.dock.rect[2] - f.glass[2]),
          dTop: Math.abs(f.dock.rect[1] - f.glass[3]),
        }))
        : []
      return {
        method: 'live',
        frames: frames.length,
        clicks: clicks.map(t => +t.toFixed(1)),
        span: +span.toFixed(1),
        maxFrameDelta: +maxDelta.toFixed(1),
        maxFrameDeltaFraction: span < 1 ? 0 : +(maxDelta / span).toFixed(3),
        maxDeltaDtMs: +maxDeltaDt.toFixed(1),
        unexplainedJumpPx: +unexplainedJumpPx.toFixed(1),
        unexplainedJumpFrames,
        gapMin: gaps.length ? +Math.min(...gaps).toFixed(2) : null,
        gapMax: gaps.length ? +Math.max(...gaps).toFixed(2) : null,
        exposedSamples: gaps.filter(g => g > MAX_GAP_PX).length,
        markerDropWhileMoving,
        markerFrames: frames.filter(f => f.anim).length,
        dockAlignLeftMax: dockAlign.length ? +Math.max(...dockAlign.map(a => a.dLeft)).toFixed(2) : null,
        dockAlignRightMax: dockAlign.length ? +Math.max(...dockAlign.map(a => a.dRight)).toFixed(2) : null,
        dockTopDeltaMax: dockAlign.length ? +Math.max(...dockAlign.map(a => a.dTop)).toFixed(2) : null,
      }
    }

    // --- scenario definitions -------------------------------------------------
    const scenarioDefs = {
      'left-single': {
        settle: async () => { await ensurePanel('files', false); await ensureDock(false); await ensureSidebar(true) },
        act: async () => { await page.click(sidebar) },
      },
      'right-single': {
        settle: async () => { await ensureDock(false); await ensureSidebar(true); await ensurePanel('files', false) },
        act: async () => { await page.click(files) },
      },
      both: {
        settle: async () => { await ensureDock(false); await ensurePanel('files', false); await ensureSidebar(false) },
        act: async () => { await page.evaluate(() => { document.querySelector('[aria-label="Open sidebar"]').click(); document.querySelector('[data-sidebar-right-rail-item="files"]').click() }) },
      },
      crossed: {
        settle: async () => { await ensureDock(false); await ensurePanel('files', false); await ensureSidebar(true) },
        act: async () => { await page.evaluate(() => { document.querySelector('[aria-label="Collapse sidebar"]').click(); document.querySelector('[data-sidebar-right-rail-item="files"]').click() }) },
      },
      spam: {
        settle: async () => { await ensureDock(false); await ensureSidebar(true); await ensurePanel('files', false) },
        act: async () => { await page.evaluate(() => { for (let i = 0; i < 6; i++) setTimeout(() => document.querySelector('[data-sidebar-right-rail-item="files"]').click(), i * 80) }) },
        durationMs: 1600,
      },
      dock: {
        settle: async () => { await ensurePanel('files', false); await ensureSidebar(true); await ensureDock(false) },
        act: async () => { await page.click(dockSel) },
        durationMs: 900,
      },
      'dock-sidebar': {
        settle: async () => { await ensurePanel('files', false); await ensureSidebar(true); await ensureDock(true) },
        act: async () => { await page.click(sidebar) },
        durationMs: 900,
      },
      'dock-reopen': {
        settle: async () => { await ensurePanel('files', false); await ensureSidebar(true); await ensureDock(true) },
        act: async () => {
          await page.click(dockSel)
          await wait(120)
          await page.click(dockSel)
        },
        durationMs: 1200,
      },
    }

    for (const scenario of MATRIX) {
      const def = scenarioDefs[scenario.id]
      if (def === undefined) throw new Error(`matrix scenario without definition: ${scenario.id}`)
      if (ONLY.length > 0 && !ONLY.includes(scenario.id)) continue
      if (!scenario.widths.includes(WIDTH)) {
        report.scenarios[scenario.id] = { skipped: `not run at width ${WIDTH}`, matrixWidths: scenario.widths }
        if (!JSON_ONLY) console.log(`[${scenario.id}] SKIP (width ${WIDTH} not in ${scenario.widths.join('/')})`)
        continue
      }
      const scenarioOrient = scenario.orient === 'both' ? 'right' : scenario.orient
      const bound = { ...scenario, orient: scenarioOrient, ...def }
      const result = scenario.method === 'live' ? await runLive(bound) : await runStepped(bound)
      const reasons = []
      if (result.gapMax !== null && result.gapMax > MAX_GAP_PX) reasons.push(`gap ${result.gapMax}px > ${MAX_GAP_PX}`)
      if (result.method === 'stepped') {
        if (result.movingSamples < MIN_MOVING_SAMPLES && result.travel > 2) reasons.push(`only ${result.movingSamples} moving samples`)
        if (result.maxStepFraction > MAX_STEP_FRACTION) reasons.push(`step ${result.maxStepFraction} of travel`)
        if (!result.markerPresentThroughRide) reasons.push('data-animating dropped while the track was moving')
        if (result.startSkewFrames !== null && Math.abs(result.startSkewFrames) > MAX_START_SKEW_FRAMES) reasons.push(`start skew ${result.startSkewFrames} frames`)
      } else {
        // v3: frame-owned tracks use the transition-clock rule; the dock's
        // element-owned transform keeps the v2 span-fraction rule.
        if (scenario.orient === 'dock') {
          const continuityJump = result.maxFrameDeltaFraction > MAX_FRAME_DELTA_FRACTION && result.maxDeltaDtMs <= MAX_CONTINUITY_DT_MS
          if (continuityJump) reasons.push(`frame delta ${result.maxFrameDeltaFraction} of span in ${result.maxDeltaDtMs}ms`)
        } else if (result.unexplainedJumpFrames > 0) {
          reasons.push(`edge jumped ${result.unexplainedJumpPx}px with no track transition running (${result.unexplainedJumpFrames} frame pairs)`)
        }
        if (result.markerDropWhileMoving > 0) reasons.push(`marker dropped for ${result.markerDropWhileMoving} frames while moving`)
        if (scenario.id === 'dock-sidebar' || scenario.id === 'dock-reopen') {
          if (result.dockAlignLeftMax !== null && result.dockAlignLeftMax > MAX_GAP_PX) reasons.push(`dock left off glass by ${result.dockAlignLeftMax}px`)
          if (result.dockAlignRightMax !== null && result.dockAlignRightMax > MAX_GAP_PX) reasons.push(`dock right off glass by ${result.dockAlignRightMax}px`)
        }
      }
      report.scenarios[scenario.id] = { ...result, pass: reasons.length === 0, reasons }
      if (reasons.length > 0) report.violations.push({ motion: scenario.id, reasons })
      if (!JSON_ONLY) console.log(`[${scenario.id}] ${reasons.length === 0 ? 'PASS' : 'FAIL'} ${JSON.stringify(result)}${reasons.length ? ' :: ' + reasons.join('; ') : ''}`)
    }

    // --- resting material -----------------------------------------------------
    // 'material' is selectable through --only= like a scenario id.
    if (WIDTH > 900 && (ONLY.length === 0 || ONLY.includes('material'))) {
      await ensureDock(false)
      await ensureSidebar(true)
      await ensurePanel('files', true)
      await wait(450)
      const rest = await scanShot('rest-open', 'right')
      const png = decodePng(fs.readFileSync(path.join(outDir === '' ? '/tmp' : outDir, 'rest-open.png')))
      const median = list => { const s = [...list].sort((a, b) => a - b); return s[Math.floor(s.length / 2)] }
      const px = (x, y) => { const i = (y * png.width + x) * png.channels; return [png.data[i], png.data[i + 1], png.data[i + 2]] }
      const boundary = rest.rects.mainGlass[2]
      const corridor = (from, to) => {
        const cols = []
        for (let x = from; x <= to; x++) {
          const rows = []
          for (let y = 150; y < 750; y += 3) rows.push(px(x, y))
          cols.push([median(rows.map(v => v[0])), median(rows.map(v => v[1])), median(rows.map(v => v[2]))])
        }
        return [median(cols.map(v => v[0])), median(cols.map(v => v[1])), median(cols.map(v => v[2]))]
      }
      const rightCorridor = corridor(Math.round(boundary) + 14, Math.round(boundary) + 30)
      const leftCorridor = corridor(Math.round(rest.rects.sidebar[2]) - 30, Math.round(rest.rects.sidebar[2]) - 14)
      const target = targetComposites[RIGHT_CORRIDOR_TARGET]
      const material = {
        target: RIGHT_CORRIDOR_TARGET,
        targetComposite: target,
        rightCorridor,
        leftCorridor,
        rightVsTarget: +dist(rightCorridor, target).toFixed(1),
        leftVsRight: +dist(leftCorridor, rightCorridor).toFixed(1),
        parityTolerance: MATERIAL_PARITY_TOLERANCE,
        parityWithinTolerance: dist(leftCorridor, rightCorridor) <= MATERIAL_PARITY_TOLERANCE,
        choices: { 'panel-glass-double': glass3, 'panel-glass': glass2, 'frame-glass': glass1, 'sidebar-fill': sidebarLayer },
      }
      const bad = []
      if (material.rightVsTarget > MATERIAL_CLASS_TOLERANCE) bad.push(`right corridor ${rightCorridor} is ${material.rightVsTarget} from target ${RIGHT_CORRIDOR_TARGET}`)
      report.material = { ...material, pass: bad.length === 0, reasons: bad }
      if (bad.length > 0) report.violations.push({ motion: 'material', reasons: bad })
      if (!JSON_ONLY) console.log(`[material] ${bad.length === 0 ? 'PASS' : 'FAIL'} right=${rightCorridor} target=${target} d=${material.rightVsTarget} left-vs-right=${material.leftVsRight} parity<=${MATERIAL_PARITY_TOLERANCE}:${material.parityWithinTolerance}`)
    }

    report.pass = report.violations.length === 0
    if (outDir !== '') fs.writeFileSync(path.join(outDir, 'verdict.json'), JSON.stringify(report, null, 1))
    if (!JSON_ONLY) console.log(report.pass ? `GLASS-SEAM PROBE v${PROBE_VERSION} PASS` : `GLASS-SEAM PROBE v${PROBE_VERSION} FAIL (${report.violations.length}) ${JSON.stringify(report.violations)}`)
    await browser.close()
    process.exitCode = report.pass ? 0 : 1
  } catch (error) {
    await browser.close()
    console.error('glass-seam-probe error:', error)
    process.exitCode = 2
  }
}

await main()
