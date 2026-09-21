// WP-SB probe (61-maintenance-2026-09-21): the chat header's subagent arrow
// ("Open <label> in sidebar") must open the sub-agent session view in the right
// Sidebar — never the file tree, never a split that wedges the panel — and the
// column must stay closable and switchable afterwards.
import { mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import { createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionId as SessionIdValue } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-subagent'
import type {} from '@deepseek-ai/dsh-workspace'
import { launchWebScaffold, watchConsole, type WebScaffold } from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, saveFailureShot } from './support.ts'

const LABEL = 'wp-sb probe child'
const CHILD_PROMPT = 'WP-SB probe child prompt'
const PROBE_PROVIDER = 'web-test-wp-sb'
const ARTIFACTS = fileURLToPath(new URL('../../../.artifacts', import.meta.url))

/** Model stub that completes every turn immediately. */
class CompletingAdapter extends LlmAdapter {
  override async *stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

async function waitForAgentGone(scaffold: WebScaffold, id: SessionIdValue): Promise<void> {
  const deadline = Date.now() + 20_000
  while (scaffold.ctx.agents.get(id) !== undefined) {
    if (Date.now() >= deadline) throw new Error(`subagent ${id} did not settle`)
    await new Promise<void>(resolve => setTimeout(resolve, 10))
  }
}

async function shot(page: Page, name: string): Promise<string> {
  await mkdir(ARTIFACTS, { recursive: true })
  const path = join(ARTIFACTS, `${name}.png`)
  await page.screenshot({ path, fullPage: false })
  return path
}

/** Panel/rail readouts the assertions share. */
async function panelFacts(page: Page): Promise<{
  panes: number
  filesTree: number
  chat: number
  chatVisible: boolean
  editorOpen: number
  activeTab: string
}> {
  const panel = page.locator('[data-sidebar-right-panel]')
  const active = panel.locator('[data-dockkit-pane] [role="tab"][aria-selected="true"]').first()
  return {
    panes: await panel.locator('[data-dockkit-pane]').count(),
    filesTree: await panel.locator('[data-files-body]').count(),
    chat: await page.locator('[data-sidebar-chat]').count(),
    chatVisible: await page.locator('[data-sidebar-chat]').isVisible().catch(() => false),
    editorOpen: await panel.locator('[data-sidebar-right-editor-open]').count(),
    activeTab: await active.innerText().catch(() => ''),
  }
}

describe('web e2e: WP-SB subagent arrow opens the session view in the Sidebar', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let parentHandle: AgentHandle
  let childId: SessionIdValue
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold()
    scaffold.ctx.effect(
      () => scaffold.ctx.llm.registerAdapter([PROBE_PROVIDER], new CompletingAdapter()),
      'wp-sb probe adapter',
    )
    const cwd = join(scaffold.workspaceCwd, 'workspace')
    await mkdir(cwd, { recursive: true })
    parentHandle = await scaffold.ctx.agents.create({
      sessionId: SessionId('wp-sb-owner'),
      meta: { cwd },
      agentOptions: { provider: PROBE_PROVIDER, model: 'probe' },
    })
    parentHandle.agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'Delegate one bounded probe task.' }],
      source: { kind: 'user' },
    }))
    await parentHandle.agent.whenIdle()
    const started = await scaffold.ctx.subagents.startContinuable({
      provider: 'spawn',
      label: LABEL,
      signal: new AbortController().signal,
      request: {
        prompt: [{ type: 'text', text: CHILD_PROMPT }],
        parent: parentHandle.agent,
      },
    })
    childId = started.childId
    await waitForAgentGone(scaffold, childId)

    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
    const workspace = await scaffold.ctx.workspaceRegistry.resolveByPath(cwd)
    if (workspace === undefined) throw new Error('connected Web workspace was not registered')
    await workspace.attachSession(parentHandle.agent.session.id)
    const ownerRow = page.getByRole('tree', { name: 'Sessions' }).getByRole('treeitem', {
      name: /Delegate one bounded probe task/,
    })
    await ownerRow.waitFor({ timeout: 15_000 })
    await ownerRow.click()
    // The lineage control renders once the session list and hierarchy projection
    // carry the child; a cold boot can land the header a few commits later.
    const lineageDeadline = Date.now() + 45_000
    while (await page.getByRole('button', { name: '1 subagent', exact: true }).count() === 0) {
      if (Date.now() >= lineageDeadline) throw new Error('subagent lineage control never appeared in the conversation header')
      await page.waitForTimeout(250)
    }
  }, 120_000)

  afterAll(async () => {
    const failures: unknown[] = []
    await browser?.close().catch((error: unknown) => failures.push(error))
    await parentHandle?.dispose().catch((error: unknown) => failures.push(error))
    await scaffold?.close().catch((error: unknown) => failures.push(error))
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, 'wp-sb probe teardown failed')
  })

  /** Hover the header count and click one row's arrow. */
  const clickArrow = async (): Promise<void> => {
    await page.getByRole('button', { name: '1 subagent', exact: true }).hover()
    const arrow = page.getByRole('button', { name: `Open ${LABEL} in sidebar` })
    await arrow.waitFor({ timeout: 15_000 })
    await arrow.click()
  }

  it('opens the session view without the file tree and keeps one pane', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-wp-sb-arrow'))
    await clickArrow()
    await page.locator('[data-sidebar-chat]').waitFor({ timeout: 15_000 })
    await page.locator('[data-sidebar-chat]').getByText(CHILD_PROMPT, { exact: false }).first().waitFor({ timeout: 15_000 })
    const facts = await panelFacts(page)
    // (a) the panel shows the session view, not the file tree and not a preview.
    expect(facts.chat).toBe(1)
    expect(facts.chatVisible).toBe(true)
    expect(facts.filesTree).toBe(0)
    expect(facts.editorOpen).toBe(0)
    expect(facts.activeTab).toContain(LABEL)
    // No split: the column is one pane, so closing the tab closes the view.
    expect(facts.panes).toBe(1)
    console.log(`WP-SB after-arrow: ${JSON.stringify(facts)}`)
    console.log(`WP-SB screenshot: ${await shot(page, 'wp-sb-after-arrow')}`)
  })

  it('closes the session view and the panel without wedging either', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-wp-sb-close'))
    // The session view's own close control. The enpoi rail hides the tab strip,
    // so the control is driven through its click handler, the same handler the
    // chip's button carries.
    await page.locator('[data-sidebar-right-panel] [data-dockkit-pane] [role="tab"][aria-selected="true"] [data-dockkit-tab-close]')
      .dispatchEvent('click')
    await page.locator('[data-sidebar-chat]').waitFor({ state: 'detached', timeout: 15_000 })
    expect((await panelFacts(page)).panes).toBe(1)

    // Reopen, then exercise the panel close through the rail's lit icon: the
    // first click brings its page forward (the session view holds the front),
    // the next collapses the column, and the session view survives as a tab.
    await clickArrow()
    await page.locator('[data-sidebar-chat]').waitFor({ timeout: 15_000 })
    const filesIcon = page.locator('[data-sidebar-right-rail-item="files"]')
    await filesIcon.click()
    await expect.poll(async () => (await panelFacts(page)).filesTree, { timeout: 10_000 }).toBe(1)
    // The service reads the mounted seat's committed binding; let that commit land.
    await page.waitForTimeout(300)
    await filesIcon.click()
    await expect.poll(
      async () => page.locator('[data-sidebar-right-panel][data-sidebar-right-open]').count(),
      { timeout: 10_000 },
    ).toBe(0)
    await page.waitForTimeout(300)
    await filesIcon.click()
    await expect.poll(
      async () => page.locator('[data-sidebar-right-panel][data-sidebar-right-open]').count(),
      { timeout: 10_000 },
    ).toBe(1)
    const reopened = await panelFacts(page)
    console.log(`WP-SB after-reopen: ${JSON.stringify(reopened)}`)
    expect(reopened.panes).toBe(1)
    expect(await page.locator('[data-sidebar-right-panel] [role="tab"]', { hasText: LABEL }).count()).toBe(1)
    console.log(`WP-SB screenshot: ${await shot(page, 'wp-sb-after-reopen')}`)
  })

  it('switches rail kinds without leaving a stale panel', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-wp-sb-rail'))
    await clickArrow()
    await page.locator('[data-sidebar-chat]').waitFor({ timeout: 15_000 })
    await page.locator('[data-sidebar-right-rail-item="capabilities"]').click()
    await expect.poll(async () => (await panelFacts(page)).chatVisible, { timeout: 10_000 }).toBe(false)
    const onCapabilities = await panelFacts(page)
    console.log(`WP-SB on-capabilities: ${JSON.stringify(onCapabilities)}`)
    expect(onCapabilities.panes).toBe(1)
    expect(onCapabilities.filesTree).toBe(0)
    await page.locator('[data-sidebar-right-rail-item="files"]').click()
    await expect.poll(async () => (await panelFacts(page)).filesTree, { timeout: 10_000 }).toBe(1)
    const onFiles = await panelFacts(page)
    console.log(`WP-SB on-files: ${JSON.stringify(onFiles)}`)
    expect(onFiles.panes).toBe(1)
    expect(onFiles.chatVisible).toBe(false)
    console.log(`WP-SB screenshot: ${await shot(page, 'wp-sb-after-rail-switch')}`)
  })

  it('keeps the page error free', () => {
    expect(tripwire.pageErrors).toEqual([])
    console.log(`WP-SB warnings: ${JSON.stringify(tripwire.warnings)}`)
  })
})
