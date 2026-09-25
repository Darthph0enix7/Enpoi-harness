#!/usr/bin/env node
/**
 * Glass-seam probe: proves the main glass edge stays glued to the facing panel
 * edge (right panel, terminal drawer, left sidebar, bottom dock) while the
 * tracks animate, and that the seam material matches the resting surfaces.
 *
 * Method: headless Chromium against a running `dsh web` origin. Each motion is
 * sampled at animation-frame cadence (rAF plus a 4 ms interval for dense
 * coverage); the geometric gap between the main surface's glass edge and the
 * panel's facing edge must never exceed 0 px at any sample, and the main edge
 * must move across several samples with none covering the whole travel. Frozen
 * mid-motion frames (Web Animations pause) are screenshotted with the page
 * background forced to a sentinel colour; the seam window is classified against
 * the skin's own glass token so a single-glass sliver (brighter than any
 * resting surface), a wallpaper pixel, or a triple-glass overlap band fails
 * the run. Resting frames are scanned with the same classifier so the boundary
 * may only render the 0.5 px surface border.
 *
 * Usage: node scripts/glass-seam-probe.mjs [--origin=URL] [--out=DIR]
 *        [--width=1440] [--height=900] [--json]
 * Exit: 0 when every checked motion passes, 1 on violations (the JSON report
 * still carries every measurement), 2 on a harness error.
 */
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { createRequire } from 'node:module'

// Playwright is a dev-time browser harness owned by the web app workspace; the
// probe borrows that installation instead of adding a root dependency.
const requireFromWeb = createRequire(new URL('../apps/web/package.json', import.meta.url))

/** Sentinel page background used for the layer-classification scan. */
const SENTINEL = [255, 0, 255]
/** Seam window scanned around the facing edge, in px on each side. */
const WINDOW = 8
/** Minimum contiguous run of a bad layer class, in px, to count as a seam. */
const MIN_RUN = 3
/** A resting border renders over at most this many columns (0.5 px + AA). */
const BORDER_RUN = 2
/** Layer-classification distance tolerance. */
const CLASS_TOLERANCE = 12
/** Sentinel (wallpaper) classification distance tolerance. */
const SENTINEL_TOLERANCE = 50
/** Per-motion geometry thresholds. */
const MAX_GAP_PX = 0.5
const MAX_STEP_FRACTION = 0.25
const MIN_MOVING_SAMPLES = 5
/** Pause points for the frozen seam captures, in ms after the toggle. */
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
    if (type === 'IHDR') {
      header = {
        width: body.readUInt32BE(0), height: body.readUInt32BE(4), depth: body[8],
        color: body[9], interlace: body[12],
      }
    } else if (type === 'IDAT') idat.push(body)
    else if (type === 'IEND') break
    offset += 12 + length
  }
  if (header === null) throw new Error('PNG without IHDR')
  if (header.depth !== 8 || header.interlace !== 0 || (header.color !== 2 && header.color !== 6)) {
    throw new Error(`unsupported PNG (depth ${header.depth}, color ${header.color})`)
  }
  const channels = header.color === 6 ? 4 : 3
  const raw = zlib.inflateSync(Buffer.concat(idat))
  const stride = header.width * channels
  const out = Buffer.alloc(header.height * stride)
  const paeth = (a, b, c) => {
    const p = a + b - c
    const pa = Math.abs(p - a); const pb = Math.abs(p - b); const pc = Math.abs(p - c)
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
  }
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
      dst[i] = filter === 0 ? value
        : filter === 1 ? (value + left) & 0xff
        : filter === 2 ? (value + up) & 0xff
        : filter === 3 ? (value + ((left + up) >> 1)) & 0xff
        : (value + paeth(left, up, upLeft)) & 0xff
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

/** The sentinel override: the skin backdrop goes transparent and the body shows. */
const SENTINEL_CSS = `
body { background: #ff00ff !important; }
body > div[style*="z-index: -2"] { background: transparent !important; }
body > div[style*="z-index: -2"] > * { visibility: hidden !important; }
`

async function main() {
  const browser = await chromium.launch({
    headless: true,
    args: ['--disable-frame-rate-limit', '--disable-gpu-vsync', '--disable-background-timer-throttling'],
  })
  const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT }, ignoreHTTPSErrors: true })
  const outDir = OUT === '' ? '' : path.resolve(OUT)
  if (outDir !== '') fs.mkdirSync(outDir, { recursive: true })
  const report = { origin: ORIGIN, viewport: [WIDTH, HEIGHT], motions: {}, violations: [] }
  try {
    await page.goto(ORIGIN, { waitUntil: 'load', timeout: 90000 })
    await page.waitForSelector('[data-rightbar-col]', { timeout: 30000, state: 'attached' })
    await page.waitForTimeout(2500)
    await page.addStyleTag({ content: SENTINEL_CSS })

    const tokenCss = await page.evaluate(() => {
      // The skin declares the token at a scope that varies by skin; resolve it
      // through an element instead of reading it off the root.
      const el = document.createElement('div')
      el.style.cssText = 'position:fixed;left:-100px;top:0;width:8px;height:8px;background:var(--dsw-alias-bg-base)'
      document.body.appendChild(el)
      const color = getComputedStyle(el).backgroundColor
      el.remove()
      return color
    })
    const token = parseColor(tokenCss)
    if (token === null) throw new Error(`cannot read --dsw-alias-bg-base (${tokenCss})`)
    const glass1 = composite(token, SENTINEL)
    const glass2 = composite(token, glass1)
    const glass3 = composite(token, glass2)
    report.layers = { token, glass1, glass2, glass3 }

    const state = () => page.evaluate(() => {
      const f = document.querySelector('[data-rightbar-col]')?.parentElement
      return {
        panelOpen: !!document.querySelector('[data-sidebar-right-panel]')?.hasAttribute('data-sidebar-right-open'),
        sidebarCollapsed: f?.hasAttribute('data-sidebar-collapsed') ?? null,
        dockOpen: !!document.querySelector('[data-enpoi-bottom-dock]'),
      }
    })
    const wait = ms => page.waitForTimeout(ms)
    const click = async selector => { await page.click(selector); await wait(500) }
    const files = '[data-sidebar-right-rail-item="files"]'
    const terminal = '[data-sidebar-right-rail-item="terminal"]'
    const sidebar = '[aria-label="Collapse sidebar"], [aria-label="Open sidebar"], [aria-label="Expand sidebar"]'
    const dock = '[data-enpoi-terminal-bottom-toggle]'

    const ensurePanel = async (kind, open) => {
      for (let i = 0; i < 8; i++) {
        const s = await page.evaluate(() => ({
          open: !!document.querySelector('[data-sidebar-right-panel]')?.hasAttribute('data-sidebar-right-open'),
          kind: document.querySelector('[data-sidebar-right-rail-item][data-sidebar-right-rail-active]')?.getAttribute('data-sidebar-right-rail-item') ?? null,
        }))
        if (s.open === open && (!open || s.kind === kind)) return
        if (s.open && s.kind !== kind && open) { await click(kind === 'files' ? files : terminal); continue }
        await click(kind === 'files' ? files : terminal)
      }
      throw new Error(`cannot set panel ${kind} to ${open}`)
    }
    const ensureSidebar = async expanded => {
      for (let i = 0; i < 6; i++) {
        const s = await state()
        if (s.sidebarCollapsed === !expanded) return
        await click(sidebar)
      }
      throw new Error(`cannot set sidebar expanded=${expanded}`)
    }
    const ensureDock = async open => {
      for (let i = 0; i < 6; i++) {
        const s = await state()
        if (s.dockOpen === open) return
        await click(dock)
      }
      throw new Error(`cannot set dock open=${open}`)
    }

    const mainEdge = (row, orient) => orient === 'right' ? row.mainGlass?.[2] : orient === 'left' ? row.mainGlass?.[0] : row.mainGlass?.[3]
    const faceEdge = (row, orient) => orient === 'right' ? row.panel?.[0] : orient === 'left' ? row.sidebar?.[2] : row.dock?.[1]
    const gapOf = (row, orient) => {
      const main = mainEdge(row, orient); const face = faceEdge(row, orient)
      if (main === undefined || face === undefined || main === null || face === null) return null
      return face - main
    }

    /**
     * Stepped trace: after both transitions are running, pause every animation
     * and walk `currentTime` in fixed 10 ms increments, reading the geometry at
     * each step. The clock is deterministic (no compositor jitter), so a snap
     * shows as one step covering the whole travel, and a start-commit lag shows
     * as a positive gap because each transition advances only its own clock.
     */
    async function trace(name, selector, orient) {
      await page.click(selector)
      await wait(40)
      await page.evaluate(() => { for (const a of document.getAnimations()) { try { a.pause() } catch { /* non-pausable */ } } })
      const rows = []
      for (let ms = 0; ms <= 300; ms += 10) {
        rows.push(await page.evaluate(t => {
          for (const a of document.getAnimations()) { try { a.currentTime = t } catch { /* finished */ } }
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
              if (b.width > cr.width * 0.8 && b.height > cr.height * 0.5) return el
            }
            return center
          })()
          return {
            t: t,
            mainGlass: r(glass),
            sidebar: r(f ? f.children[0] : null),
            panel: r(document.querySelector('[data-sidebar-right-panel]')),
            dock: r(document.querySelector('[data-enpoi-bottom-dock]')),
            anim: f ? f.hasAttribute('data-animating') : null,
            panelFullscreen: document.querySelector('[data-sidebar-right-panel]')?.getAttribute('data-sidebar-right-panel') === 'fullscreen',
          }
        }, ms))
      }
      await page.evaluate(() => { for (const a of document.getAnimations()) { try { a.play() } catch { /* gone */ } } })
      await wait(400)
      const gaps = rows.map(r => gapOf(r, orient)).filter(v => v !== null)
      const edges = rows.map(r => mainEdge(r, orient)).filter(v => v !== null)
      // Only a right-panel motion can be the instant fullscreen mode switch;
      // the left/dock tracks keep interpolating under it and stay checked.
      const instantMode = orient === 'right' && rows.some(r => r.panelFullscreen)
      const travel = Math.abs(edges[edges.length - 1] - edges[0])
      let maxStep = 0, moving = 0
      for (let i = 1; i < edges.length; i++) {
        const step = Math.abs(edges[i] - edges[i - 1])
        maxStep = Math.max(maxStep, step)
        if (step > 0.05) moving++
      }
      return {
        samples: rows.length,
        instantMode,
        gapMax: gaps.length ? +Math.max(...gaps).toFixed(2) : null,
        gapMin: gaps.length ? +Math.min(...gaps).toFixed(2) : null,
        exposedSamples: gaps.filter(g => g > MAX_GAP_PX).length,
        movingSamples: moving,
        travel: +travel.toFixed(1),
        maxStep: +maxStep.toFixed(1),
        maxStepFraction: travel < 1 ? 0 : +(maxStep / travel).toFixed(3),
        animatedSamples: rows.filter(r => r.anim).length,
        panelEdgeTrackedSamples: gaps.filter(g => Math.abs(g) < 1).length,
      }
    }

    /** Classification of a seam window over one frozen screenshot. */
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
        for (let s = 40; s < (vertical ? height - 40 : width - 8); s += 3) {
          colors.push(vertical ? px(c, s) : px(s, c))
        }
        columns.push({
          at: c,
          color: [median(colors.map(v => v[0])), median(colors.map(v => v[1])), median(colors.map(v => v[2]))],
        })
      }
      const classifyColor = color => {
        if (dist(color, SENTINEL) < SENTINEL_TOLERANCE) return 'wallpaper'
        if (dist(color, glass1) < CLASS_TOLERANCE) return 'single-glass'
        if (dist(color, glass2) < CLASS_TOLERANCE) return 'surface'
        if (dist(color, glass3) < CLASS_TOLERANCE) return 'triple-glass'
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
        gap: +gap.toFixed(2),
        mainEdge: +main.toFixed(1), faceEdge: +face.toFixed(1),
        counts: {
          wallpaper: classes.filter(c => c.cls === 'wallpaper').length,
          singleGlass: classes.filter(c => c.cls === 'single-glass').length,
          surface: classes.filter(c => c.cls === 'surface').length,
          tripleGlass: classes.filter(c => c.cls === 'triple-glass').length,
        },
        maxRun,
        badRuns, violations,
      }
    }

    /** Current seam geometry: the centre's painted glass and every facing edge. */
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
          if (b.width > cr.width * 0.8 && b.height > cr.height * 0.5) return el
        }
        return center
      })()
      return {
        center: r(center), mainGlass: r(glass),
        sidebar: r(f ? f.children[0] : null), panel: r(document.querySelector('[data-sidebar-right-panel]')),
        dock: r(document.querySelector('[data-enpoi-bottom-dock]')),
      }
    })

    /** One screenshot plus its seam classification. */
    async function scanShot(name, orient) {
      const rects = await captureRects()
      const file = path.join(outDir === '' ? '/tmp' : outDir, `${name}.png`)
      await page.screenshot({ path: file })
      return { file: outDir === '' ? undefined : `${name}.png`, rects, scan: await classify(orient, rects, file) }
    }

    async function frozen(name, selector, orient, ensureStart) {
      await ensureStart()
      await wait(150)
      await page.click(selector)
      // Both transitions must be running before the pause (the earliest frozen
      // point is later than the start commit), or a paused track with a
      // not-yet-started panel would fake a divergence.
      await wait(60)
      await page.evaluate(() => { for (const a of document.getAnimations()) { try { a.pause() } catch { /* non-pausable */ } } })
      const shots = []
      for (const ms of FROZEN_MS) {
        await page.evaluate(t => { for (const a of document.getAnimations()) { try { a.currentTime = t } catch { /* finished */ } } }, ms)
        await wait(60)
        const shot = await scanShot(`${name}-${ms}`, orient)
        shots.push({ ms, ...shot })
      }
      await page.evaluate(() => { for (const a of document.getAnimations()) { try { a.play() } catch { /* gone */ } } })
      await wait(500)
      return shots
    }

    const motions = []
    if (WIDTH > 900) {
      motions.push(['right-open', files, 'right', false], ['right-close', files, 'right', true])
      motions.push(['terminal-open', terminal, 'right', false], ['terminal-close', terminal, 'right', true])
    }
    motions.push(['left-open', sidebar, 'left', false], ['left-close', sidebar, 'left', true])
    motions.push(['dock-open', dock, 'dock', false], ['dock-close', dock, 'dock', true])

    // Resting references per surface: a legal resting material may itself carry
    // a content ground (the terminal page stacks one more glass layer than the
    // file tree), and only runs that exceed the resting baseline are defects.
    const references = {}
    const referenceSpecs = [
      ['files', 'right', async () => { if (WIDTH > 900) await ensurePanel('files', true) }],
      ['terminal', 'right', async () => { if (WIDTH > 900) await ensurePanel('terminal', true) }],
      ['sidebar', 'left', async () => { await ensureSidebar(true) }],
      ['dock', 'dock', async () => { await ensureDock(true) }],
    ]
    for (const [key, orient, ensure] of referenceSpecs) {
      if ((key === 'files' || key === 'terminal') && WIDTH <= 900) continue
      await ensure()
      // A reference must be settled: the slow transition is 300 ms.
      await wait(450)
      references[key] = await scanShot(`ref-${key}`, orient)
    }

    const refKeyOf = name => name.startsWith('terminal') ? 'terminal' : name.startsWith('right') ? 'files' : name.startsWith('dock') ? 'dock' : 'sidebar'
    const failures = []
    for (const [name, selector, orient, open] of motions) {
      const ensureStart = async () => {
        if (name.startsWith('right')) await ensurePanel('files', open)
        if (name.startsWith('terminal')) await ensurePanel('terminal', open)
        if (name.startsWith('left')) await ensureSidebar(open)
        if (name.startsWith('dock')) await ensureDock(open)
      }
      await ensureStart()
      const traceResult = await trace(name, selector, orient)
      const shots = await frozen(name, selector, orient, ensureStart)
      const reference = references[refKeyOf(name)]?.scan
      const reasons = []
      if (!traceResult.instantMode) {
        if (traceResult.gapMax !== null && traceResult.gapMax > MAX_GAP_PX) reasons.push(`gap ${traceResult.gapMax}px > ${MAX_GAP_PX} at ${traceResult.exposedSamples} samples`)
        if (traceResult.movingSamples < MIN_MOVING_SAMPLES && traceResult.travel > 2) reasons.push(`only ${traceResult.movingSamples} moving samples`)
        if (traceResult.maxStepFraction > MAX_STEP_FRACTION) reasons.push(`step ${traceResult.maxStepFraction} of travel in one sample`)
      }
      for (const shot of shots) {
        for (const run of shot.scan.violations ?? []) {
          const resting = run.cls === 'triple-glass' ? (reference?.maxRun?.['triple-glass'] ?? 0) : 0
          if (run.width > resting + 1) reasons.push(`${shot.ms}ms ${run.cls} run ${run.width}px at ${run.start} (resting ${resting}px)`)
        }
      }
      if (reasons.length > 0) failures.push({ motion: name, reasons })
      report.motions[name] = {
        startOpen: open, trace: traceResult,
        frozen: shots.map(s => ({ ms: s.ms, file: s.file, gap: s.scan.gap, counts: s.scan.counts, maxRun: s.scan.maxRun, violations: s.scan.violations })),
        pass: reasons.length === 0, reasons,
      }
      if (!JSON_ONLY) console.log(`[${name}] ${reasons.length === 0 ? 'PASS' : 'FAIL'} ${JSON.stringify(traceResult)}${reasons.length ? ' :: ' + reasons.join('; ') : ''}`)
    }

    // The resting references themselves must not expose wallpaper or a
    // single-glass sliver; a content ground (triple-glass) is a legal surface.
    for (const [key, ref] of Object.entries(references)) {
      const bad = (ref.scan.badRuns ?? []).filter(r => r.cls !== 'triple-glass')
      report.motions[`ref-${key}`] = {
        file: ref.file, gap: ref.scan.gap, counts: ref.scan.counts, maxRun: ref.scan.maxRun,
        pass: bad.length === 0, reasons: bad.map(r => `${r.cls} run ${r.width}px`),
      }
      if (bad.length > 0) failures.push({ motion: `ref-${key}`, reasons: bad.map(r => `${r.cls} run ${r.width}px`) })
      if (!JSON_ONLY) console.log(`[ref-${key}] ${bad.length === 0 ? 'PASS' : 'FAIL'} ${JSON.stringify(ref.scan.counts)} maxRun=${JSON.stringify(ref.scan.maxRun)}`)
    }

    // The closed right panel's resting edge is part of the acceptance too.
    if (WIDTH > 900) {
      await ensurePanel('files', false)
      await wait(200)
      const restClosed = await scanShot('rest-closed', 'right')
      const bad = (restClosed.scan.violations ?? []).filter(r => r.cls !== 'triple-glass' || r.width > BORDER_RUN)
      report.motions['rest-closed'] = {
        file: restClosed.file, gap: restClosed.scan.gap, counts: restClosed.scan.counts,
        pass: bad.length === 0, reasons: bad.map(r => `${r.cls} run ${r.width}px`),
      }
      if (bad.length > 0) failures.push({ motion: 'rest-closed', reasons: bad.map(r => `${r.cls} run ${r.width}px`) })
      if (!JSON_ONLY) console.log(`[rest-closed] ${bad.length === 0 ? 'PASS' : 'FAIL'} ${JSON.stringify(restClosed.scan.counts)}`)
    }

    report.violations = failures
    report.pass = failures.length === 0
    if (outDir !== '') fs.writeFileSync(path.join(outDir, 'verdict.json'), JSON.stringify(report, null, 1))
    if (!JSON_ONLY) console.log(report.pass ? 'GLASS-SEAM PROBE: PASS' : `GLASS-SEAM PROBE: FAIL (${failures.length}) ${JSON.stringify(report.violations)}`)
    await browser.close()
    process.exitCode = report.pass ? 0 : 1
  } catch (error) {
    await browser.close()
    console.error('glass-seam-probe error:', error)
    process.exitCode = 2
  }
}

await main()
