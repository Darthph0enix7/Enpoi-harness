// Web e2e probe: The Mark's keyed `tool.call.toolview` registrations must own
// every delegation Tool name. A seeded session renders one settled call per
// name; the fork card (`data-mark-task-card`) must be present inside each call
// wrapper and no upstream Tool row (`data-tool`, the Generic/Details row) may
// render there. Keyless replay: the fixture is the whole world, no model call.
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { launchWebScaffold, seedSession, watchConsole, webSnapshotMode, type WebScaffold } from './scaffold.ts'
import { expandTurnProcesses, newEnglishPage, saveFailureShot, WEB_FIXTURE_TIME } from './support.ts'

interface MarkCall {
  readonly callId: string
  readonly name: string
  readonly args: Record<string, unknown>
  readonly result: string
}

/** One settled call per registered key; subagent/oracle carry a child session id. */
const CALLS: readonly MarkCall[] = [
  {
    callId: 'mark-subagent',
    name: 'subagent',
    args: { description: 'Map the right sidebar seats', subagent_type: 'explorer', prompt: 'Map the seats.' },
    result: 'Started subagent session-11111111-2222-3333-4444-555555555555.',
  },
  {
    callId: 'mark-dispatch',
    name: 'dispatch_task',
    args: { description: 'Legacy dispatch alias', prompt: 'Dispatch the historical alias.' },
    result: 'Dispatched.',
  },
  {
    callId: 'mark-task',
    name: 'task',
    args: { description: 'Historical task alias', prompt: 'Run the historical alias.' },
    result: 'Task settled.',
  },
  {
    callId: 'mark-oracle',
    name: 'oracle_review',
    args: { query: 'Review the merged slot contract' },
    result: 'Oracle session session-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee returned a verdict.',
  },
  {
    callId: 'mark-roundtable',
    name: 'roundtable',
    args: { topic: 'Glass seam durability' },
    result: 'Council compiled a report.',
  },
  {
    callId: 'mark-chorus',
    name: 'chorus',
    args: { prompt: 'Brainstorm the next UI wave' },
    result: 'Chorus harvested idea groups.',
  },
]

/** Build the seed fixture: one closed turn with one settled call per Tool name. */
function markFixture(): string {
  const events: unknown[] = [
    {
      type: 'session', version: 3, id: '{{session:1}}', createdAt: 0, cwd: '{{cwd}}',
      isSeeded: false, delegationDepth: 0, agentPreset: 'orchestrator',
    },
    { type: 'permission/preset', data: { preset: 'danger-full-access' } },
    { type: 'sandbox/mode', data: { mode: 'danger-full-access' } },
    { type: 'approval/policy', data: { policy: 'ask' } },    { type: 'turn/start', data: { turn: 1 } },
    { type: 'user/message', data: { content: [{ type: 'text', text: 'Render every delegation card.' }], source: { kind: 'user' }, role: 'user', id: '{{message:1}}' }, surfaceOp: 'append' },
  ]
  let message = 2
  for (const [index, call] of CALLS.entries()) {
    const step = index + 1
    const args = JSON.stringify(call.args)
    events.push(
      { type: 'step/start', data: { turn: 1, step } },
      {
        type: 'assistant/message',
        data: {
          turn: 1,
          step,
          message: {
            role: 'assistant',
            content: [{ type: 'tool-call', id: call.callId, name: call.name, arguments: args }],
            source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-v4-flash' },
            id: `{{message:${String(message++)}}}`,
          },
          stream: [],
        },
        surfaceOp: 'append',
      },
      { type: 'tool/call', data: { turn: 1, step, callId: call.callId, name: call.name, arguments: args } },
      {
        type: 'tool/result',
        data: {
          turn: 1,
          step,
          message: {
            source: { kind: 'tool', callId: call.callId },
            content: [{ type: 'tool-result', toolCallId: call.callId, content: [{ type: 'text', text: call.result }], isError: false }],
            role: 'user',
            id: `{{message:${String(message++)}}}`,
          },
          sourceEventSeqs: [],
        },
        surfaceOp: 'append',
      },
      { type: 'step/end', data: { turn: 1, step } },
    )
  }
  events.push(
    { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
  )
  return `${events.map(event => JSON.stringify(event)).join('\n')}\n`
}

const SEED_ID = 'the-mark-card-web-e2e'
const MODE = webSnapshotMode()

describe.skipIf(MODE === 'record')('web e2e: The Mark tool cards own every delegation Tool name', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold({})
    await seedSession(scaffold, markFixture(), SEED_ID, undefined, { createdAt: WEB_FIXTURE_TIME })
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    await page.clock.setFixedTime(WEB_FIXTURE_TIME)
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })

    const groupRow = page.locator('[role="treeitem"]').first()
    await groupRow.waitFor({ timeout: 15_000 })
    await groupRow.click()
    const sessionRow = page.locator('[role="treeitem"]').nth(1)
    await sessionRow.waitFor({ timeout: 10_000 })
    await sessionRow.click()
    await expandTurnProcesses(page)
    await page.locator('[data-mark-task-card]').first().waitFor({ timeout: 15_000 })
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('renders the fork card, not the generic Tool row, for every registered key', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-the-mark-card'))
    for (const call of CALLS) {
      const wrapper = page.locator(`[data-chat-call-id="${call.callId}"]`)
      await wrapper.waitFor({ state: 'visible', timeout: 15_000 })
      await expect.poll(
        () => wrapper.locator('[data-mark-task-tool]').getAttribute('data-mark-task-tool'),
        { timeout: 10_000 },
      ).toBe(call.name)
      expect(await wrapper.locator('[data-tool]').count()).toBe(0)
    }
    expect(tripwire.pageErrors).toEqual([])
  })

  it('opens the subagent card into the child-session action', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-the-mark-card-open'))
    const head = page.locator('[data-chat-call-id="mark-subagent"] [data-mark-task-head]')
    await expect.poll(() => head.getAttribute('aria-expanded')).toBe('false')
    await head.click()
    await expect.poll(() => head.getAttribute('aria-expanded')).toBe('true')
    await page.getByText('Open Subagent Session', { exact: true }).waitFor({ timeout: 10_000 })
    expect(tripwire.pageErrors).toEqual([])
  })
})
