/** Focused live walk of the modernized document preview: rich renderers by default, editor on demand. */
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Browser, Locator, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { pdfFixture } from '../../../packages/client/ui-sidebar-documentpreview/tests/pdf-fixture.ts'
import { launchWebScaffold, watchConsole, webSnapshotMode, type WebScaffold } from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, saveFailureShot } from './support.ts'

const FIXTURE = fileURLToPath(new URL('../../../snapshots/web/lifecycle-chrome/session.v3.jsonl', import.meta.url))
const PAGING_PATCH = fileURLToPath(new URL('../../../snapshots/web/document-preview/paging.patch.yml', import.meta.url))
/**
 * Evidence overlay for the editor half. The editor's `/sidebar/fsops` host
 * routes ship in the operator profile, not in the repository bundle, so the
 * editor walk is opt-in: point this at an overlay that also inserts the fsops
 * plugin (and keep the paging entries). Without it the editor test skips.
 */
const FSOPS_OVERLAY = process.env.DSH_PREVIEW_FSOPS_OVERLAY
const EVIDENCE = '/home/adam/dsh-migration/evidence'
const PROMPT = 'Reply with the single word LIGHTHOUSE and stop.'
const MODE = webSnapshotMode()
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
)

/** Select a workspace file through the Files tree and wait for its preview identity. */
async function openFile(column: Locator, preview: Locator, name: string): Promise<void> {
  await column.locator('[data-files-entry="file"]').getByRole('button', { name, exact: true }).click()
  await expect.poll(async () => (await preview.getAttribute('data-textpreview-url'))?.endsWith(`/${name}`)).toBe(true)
}

/** Screenshot one state into the evidence directory. */
async function shot(page: Page, name: string): Promise<void> {
  await mkdir(EVIDENCE, { recursive: true })
  await page.screenshot({ path: join(EVIDENCE, name) })
}

describe.skipIf(MODE === 'record')('web e2e: modernized document preview', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let column: Locator
  let preview: Locator
  let outsideRoot: string | undefined
  /** The settled Session's workspace; the workbench walk writes and reads its files. */
  let workCwd: string | undefined
  /** Console tripwire: the walk asserts zero page errors at the end. */
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    outsideRoot = await mkdtemp(join(tmpdir(), 'dsh-preview-modern-'))
    scaffold = await launchWebScaffold({
      replayFixture: FIXTURE, paceMs: 5, compareReplaySession: false, extraOverlayPath: FSOPS_OVERLAY ?? PAGING_PATCH,
    })
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
    const settled = scaffold.whenTurnSettled()
    const input = page.locator('[data-composer-input]').first()
    await input.fill(PROMPT)
    await input.press('Enter')
    const sessionId = await settled
    await page.getByText('LIGHTHOUSE', { exact: true }).waitFor({ timeout: 15_000 })
    const cwd = scaffold.ctx.agents.get(sessionId)?.session.header.cwd
    if (cwd === undefined) throw new Error('settled Session has no workspace cwd')
    workCwd = cwd
    await Promise.all([
      writeFile(join(cwd, 'preview.md'), '# Rendered heading\n\nBody paragraph for the rich preview.\n'),
      writeFile(join(cwd, 'preview.ts'), 'const answer: number = 42\nexport default answer\n'),
      writeFile(join(cwd, 'preview.html'), '<!doctype html><h1>Sandbox heading</h1><p id="r">pending</p>'
        + '<script>document.getElementById("r").textContent="SANDBOX_OK"</script>'),
      writeFile(join(cwd, 'preview.png'), TINY_PNG),
      writeFile(join(cwd, 'preview.pdf'), pdfFixture()),
    ])
    column = page.locator('[data-rightbar-col]')
    if (!(await column.locator('[data-files-state="tree"]').isVisible())) {
      await column.locator('[data-sidebar-right-rail-item="files"]').click()
    }
    await column.locator('[data-files-state="tree"]').waitFor({ state: 'visible' })
    await column.locator('[data-files-reload]').click()
    preview = column.locator('[data-document-preview]:visible')
  })

  afterAll(async () => {
    try {
      await browser?.close()
    } finally {
      try {
        await scaffold?.close()
      } finally {
        if (outsideRoot !== undefined) await rm(outsideRoot, { recursive: true, force: true })
      }
    }
  })

  it('renders each format richly by default, with the tree beside the pane', async () => {
    onTestFailed(async () => {
      await saveFailureShot(page, `screenshots/preview-modern-${process.pid}`)
    })
    const viewer = preview.locator('[data-document-viewer-menu]')

    await openFile(column, preview, 'preview.md')
    await expect.poll(() => viewer.innerText()).toBe('Markdown')
    await preview.getByRole('heading', { name: 'Rendered heading', exact: true }).waitFor({ timeout: 15_000 })
    await shot(page, 'preview-md.png')

    await openFile(column, preview, 'preview.ts')
    await expect.poll(() => viewer.innerText()).toBe('Code')
    await preview.locator('.shiki').waitFor({ timeout: 15_000 })
    await shot(page, 'preview-ts.png')

    await openFile(column, preview, 'preview.html')
    await expect.poll(() => viewer.innerText()).toBe('HTML')
    const iframe = preview.locator('[data-html-preview]')
    await iframe.waitFor({ timeout: 15_000 })
    expect(await iframe.getAttribute('sandbox')).toBe('allow-scripts')
    await page.frameLocator('[data-html-preview]').locator('#r').waitFor({ timeout: 15_000 })
    await shot(page, 'preview-html.png')

    await openFile(column, preview, 'preview.png')
    await preview.getByRole('img', { name: 'Image preview: preview.png', exact: true })
      .waitFor({ state: 'visible', timeout: 15_000 })
    await shot(page, 'preview-png.png')

    await openFile(column, preview, 'preview.pdf')
    await preview.getByRole('img', { name: 'PDF page 1', exact: true }).waitFor({ state: 'visible', timeout: 30_000 })
    await shot(page, 'preview-pdf.png')
  })

  it.skipIf(FSOPS_OVERLAY === undefined)('workbench: auto-save, retention, the conflict flow, live sync, and quick actions', async () => {
    onTestFailed(async () => {
      await saveFailureShot(page, `screenshots/preview-workbench-${process.pid}`)
    })
    const viewer = preview.locator('[data-document-viewer-menu]')
    const cwd = workCwd
    if (cwd === undefined) throw new Error('workspace cwd missing')

    await openFile(column, preview, 'preview.md')
    await viewer.click()
    await page.getByRole('menuitem', { name: 'Editor (CodeMirror)', exact: true }).click()
    await preview.locator('[data-enpoi-editor-cm]').waitFor({ timeout: 15_000 })
    await shot(page, 'workbench-editor.png')

    // Auto-save is on by default: the debounced write reaches disk and the
    // toolbar settles at Saved.
    await preview.locator('[data-enpoi-editor-cm] .cm-content').click()
    await page.keyboard.type('autosaved ')
    await preview.locator('[data-enpoi-editor-saved]').waitFor({ timeout: 10_000 })
    await expect.poll(async () => readFile(join(cwd, 'preview.md'), 'utf8'), { timeout: 5_000 })
      .toContain('autosaved')

    // Toggle auto-save off: edits stay dirty until Mod-S.
    await preview.locator('[data-enpoi-editor-autosave]').click()
    await expect.poll(() => preview.locator('[data-enpoi-editor-autosave]').getAttribute('aria-pressed')).toBe('false')
    await preview.locator('[data-enpoi-editor-cm] .cm-content').click()
    await page.keyboard.press('ControlOrMeta+End')
    await page.keyboard.type('manual ')
    await preview.locator('[data-enpoi-editor-dirty]').waitFor({ timeout: 5_000 })
    await preview.locator('[data-enpoi-editor-cm] .cm-content').click()
    await page.keyboard.press('ControlOrMeta+s')
    await expect.poll(() => preview.locator('[data-enpoi-editor-dirty]').count(), { timeout: 5_000 }).toBe(0)
    await expect.poll(async () => readFile(join(cwd, 'preview.md'), 'utf8'), { timeout: 5_000 })
      .toContain('manual')

    // Switching the display type away and back keeps the dirty buffer.
    await preview.locator('[data-enpoi-editor-cm] .cm-content').click()
    await page.keyboard.type('kept ')
    await preview.locator('[data-enpoi-editor-dirty]').waitFor({ timeout: 5_000 })
    await viewer.click()
    await page.getByRole('menuitem', { name: 'Code', exact: true }).click()
    await preview.locator('.shiki').waitFor({ timeout: 15_000 })
    await viewer.click()
    await page.getByRole('menuitem', { name: 'Editor (CodeMirror)', exact: true }).click()
    await preview.locator('[data-enpoi-editor-cm]').waitFor({ timeout: 15_000 })
    await expect.poll(() => preview.locator('[data-enpoi-editor-cm] .cm-content').innerText(), { timeout: 5_000 })
      .toContain('kept')
    await preview.locator('[data-enpoi-editor-dirty]').waitFor({ timeout: 5_000 })

    // Dirty + external change is a conflict with exactly three actions; Save
    // mine beside preserves the buffer in a create-only copy and loads disk.
    await writeFile(join(cwd, 'preview.md'), '# Agent rewrite\n')
    await preview.locator('[data-enpoi-editor-banner="conflict"]').waitFor({ timeout: 10_000 })
    await shot(page, 'workbench-conflict.png')
    await preview.locator('[data-enpoi-editor-beside]').click()
    await expect.poll(() => preview.locator('[data-enpoi-editor-dirty]').count(), { timeout: 10_000 }).toBe(0)
    await expect.poll(async () => readFile(join(cwd, 'preview.md'), 'utf8'), { timeout: 5_000 })
      .toBe('# Agent rewrite\n')
    await expect.poll(async () => (await readdir(cwd)).find(name => name.startsWith('preview.md.mine-')), { timeout: 5_000 })
      .toBeDefined()
    const copyName = (await readdir(cwd)).find(name => name.startsWith('preview.md.mine-'))
    expect(copyName).toBeDefined()
    expect(await readFile(join(cwd, String(copyName)), 'utf8')).toContain('kept')

    // Overwrite disk: the confirmation names the file-history promise, the
    // forced write lands, and the agent version yields.
    await preview.locator('[data-enpoi-editor-cm] .cm-content').click()
    await page.keyboard.type('mine-wins ')
    await preview.locator('[data-enpoi-editor-dirty]').waitFor({ timeout: 5_000 })
    await writeFile(join(cwd, 'preview.md'), '# Agent rewrite 2\n')
    await preview.locator('[data-enpoi-editor-banner="conflict"]').waitFor({ timeout: 10_000 })
    await preview.locator('[data-enpoi-editor-overwrite-ask]').click()
    await preview.locator('[data-enpoi-editor-confirm="overwrite"]').waitFor({ timeout: 5_000 })
    await preview.locator('[data-enpoi-editor-overwrite]').click()
    await expect.poll(() => preview.locator('[data-enpoi-editor-dirty]').count(), { timeout: 10_000 }).toBe(0)
    await expect.poll(async () => readFile(join(cwd, 'preview.md'), 'utf8'), { timeout: 5_000 })
      .toContain('mine-wins')

    // Plain Discard mine: the disk version replaces the buffer.
    await preview.locator('[data-enpoi-editor-cm] .cm-content').click()
    await page.keyboard.type('to-discard ')
    await preview.locator('[data-enpoi-editor-dirty]').waitFor({ timeout: 5_000 })
    await writeFile(join(cwd, 'preview.md'), '# Final\n')
    await preview.locator('[data-enpoi-editor-banner="conflict"]').waitFor({ timeout: 10_000 })
    await preview.locator('[data-enpoi-editor-discard-ask]').click()
    await preview.locator('[data-enpoi-editor-confirm="discard"]').waitFor({ timeout: 5_000 })
    await preview.locator('[data-enpoi-editor-discard]').click()
    await expect.poll(() => preview.locator('[data-enpoi-editor-dirty]').count(), { timeout: 10_000 }).toBe(0)
    await expect.poll(() => preview.locator('[data-enpoi-editor-cm] .cm-content').innerText(), { timeout: 5_000 })
      .toContain('# Final')

    // Clean + external change syncs in place: the pane follows the agent.
    await openFile(column, preview, 'preview.ts')
    await viewer.click()
    await page.getByRole('menuitem', { name: 'Editor (CodeMirror)', exact: true }).click()
    await preview.locator('[data-enpoi-editor-cm] .cm-content').waitFor({ timeout: 15_000 })
    await writeFile(join(cwd, 'preview.ts'), 'const answer: number = 42\nexport const live = 1\n')
    await expect.poll(() => preview.locator('[data-enpoi-editor-cm] .cm-content').innerText(), { timeout: 10_000 })
      .toContain('live')
    await shot(page, 'workbench-live-sync.png')

    // One toolbar row: exactly one header container and one reload control.
    expect(await page.locator('[data-textpreview-toolbar]').count()).toBe(1)
    expect(await page.locator('[data-textpreview-tool="reload"]').count()).toBe(1)
    expect(await page.locator('[data-enpoi-editor-toolbar]').count()).toBe(0)
    // Auto-save is an icon toggle with a pressed state, not a text button.
    const autoSave = preview.locator('[data-enpoi-editor-autosave]')
    expect(await autoSave.locator('svg').count()).toBe(1)
    // The walk left auto-save off: pressing the icon flips the pressed state.
    expect(await autoSave.getAttribute('aria-pressed')).toBe('false')
    await autoSave.click()
    expect(await autoSave.getAttribute('aria-pressed')).toBe('true')
    await autoSave.click()
    expect(await autoSave.getAttribute('aria-pressed')).toBe('false')
    await shot(page, 'workbench-toolbar-one-row.png')

    // Find opens OUR themed bar over CodeMirror's search API: query, count,
    // next/prev, toggles, Esc — and Mod-F opens it too.
    await preview.locator('[data-enpoi-editor-cm] .cm-content').click()
    await page.keyboard.press('ControlOrMeta+f')
    const findBar = preview.locator('[data-enpoi-editor-find]')
    await findBar.waitFor({ timeout: 5_000 })
    await findBar.locator('input').fill('answer')
    await expect.poll(() => findBar.locator('[data-enpoi-editor-find-count]').innerText(), { timeout: 5_000 })
      .toContain('/')
    await shot(page, 'workbench-toolbar-find.png')
    await findBar.locator('[data-enpoi-editor-find-next]').click()
    await findBar.locator('[data-enpoi-editor-find-prev]').click()
    await findBar.locator('[data-enpoi-editor-find-case]').click()
    await findBar.locator('[data-enpoi-editor-find-regex]').click()
    await findBar.locator('[data-enpoi-editor-find-close]').click()
    await expect.poll(() => preview.locator('[data-enpoi-editor-find]').count(), { timeout: 5_000 }).toBe(0)

    // Go to line is our popover: Mod-G opens it, a number and Enter jump the
    // CodeMirror cursor — no window.prompt anywhere (a prompt would stall the
    // page; we also observe the dialog event).
    let prompted = false
    page.on('dialog', (dialog) => { prompted = true; void dialog.dismiss() })
    await preview.locator('[data-enpoi-editor-cm] .cm-content').click()
    await page.keyboard.press('ControlOrMeta+g')
    const gotoField = preview.locator('[data-textpreview-popover="goto"] input')
    await gotoField.waitFor({ timeout: 5_000 })
    await gotoField.fill('1')
    await shot(page, 'workbench-toolbar-goto.png')
    await gotoField.press('Enter')
    // The pane is on preview.ts here: line 1 is its first statement.
    await expect.poll(() => preview.locator('[data-enpoi-editor-cm] .cm-activeLine').innerText(), { timeout: 5_000 })
      .toContain('const answer')
    expect(prompted).toBe(false)
    expect(await preview.locator('[data-textpreview-popover="goto"]').count()).toBe(0)

    // The host quick actions still work: copy path and copy content flash our
    // own notices, wrap toggles its pressed state, download and reload run.
    await preview.locator('[data-textpreview-tool="copy-path"]').click()
    await preview.locator('[data-textpreview-flash]').waitFor({ timeout: 5_000 })
    await preview.locator('[data-textpreview-tool="copy-content"]').click()
    await preview.locator('[data-textpreview-flash]').waitFor({ timeout: 5_000 })
    const wrap = preview.locator('[data-textpreview-tool="wrap"]')
    const wrapped = await wrap.getAttribute('aria-pressed')
    await wrap.click()
    await expect.poll(() => wrap.getAttribute('aria-pressed'), { timeout: 5_000 }).not.toBe(wrapped)
    await wrap.click()
    await preview.locator('[data-textpreview-tool="download"]').click()
    await preview.locator('[data-textpreview-tool="reload"]').click()
    await preview.locator('[data-enpoi-editor-cm] .cm-content').waitFor({ timeout: 10_000 })

    // A narrow column keeps the single row: trailing actions collapse behind ⋯.
    await page.setViewportSize({ width: 900, height: 1000 })
    const header = preview.locator('[data-textpreview-toolbar]')
    await expect.poll(async () => (await header.boundingBox())?.height ?? 0, { timeout: 5_000 }).toBeLessThan(60)
    const more = preview.locator('[data-textpreview-more]')
    await more.waitFor({ timeout: 5_000 })
    await more.click()
    expect(await page.getByRole('menuitem').count()).toBeGreaterThan(0)
    await page.keyboard.press('Escape')
    await page.setViewportSize({ width: 1440, height: 1000 })

    // The display-type pick survives a reload.
    await page.reload({ waitUntil: 'load' })
    await column.locator('[data-files-state="tree"]').waitFor({ state: 'visible', timeout: 15_000 })
    await openFile(column, preview, 'preview.md')
    await expect.poll(() => viewer.innerText(), { timeout: 15_000 }).toBe('Editor (CodeMirror)')
    expect(tripwire.pageErrors).toEqual([])
  })
})
