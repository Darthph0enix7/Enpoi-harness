// Web e2e scenario: the Models page opens the seeded keyless Kilo model in
// the metadata dialog and saves its display name through the real settings
// wire. Zero model calls and zero credentials: the first-run seed creates the
// route and its one model, and this file edits the built client the web server
// actually serves, not the source component in isolation.
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { launchWebScaffold, watchConsole, type WebScaffold } from './scaffold.ts'
import { openSettings, saveFailureShot, ZH_BROWSER_LOCALE } from './support.ts'

const SEEDED_MODEL_ID = 'poolside/laguna-s-2.1:free'
const SEEDED_MODEL_NAME = 'Poolside Laguna S 2.1 (free)'
const UPDATED_MODEL_NAME = 'E2E Kilo Display'

describe('web e2e: model metadata dialog edits the seeded route keylessly', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold({})
    browser = await chromium.launch()
    page = await browser.newPage({ viewport: { width: 1680, height: 1000 }, locale: ZH_BROWSER_LOCALE })
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('saves one model metadata edit without a provider key', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-model-metadata'))
    // A fresh keyless home opens the first-run wizard over the shell; skip it
    // so the Settings trigger is clickable. Skipping keeps the seeded route
    // and its model this scenario edits.
    const wizard = page.getByRole('dialog', { name: '欢迎使用 Enpoi Harness' })
    const notice = page.getByRole('dialog', { name: '内测声明' })
    await expect.poll(
      async () => await wizard.isVisible() || await notice.isVisible(),
      { timeout: 15_000 },
    ).toBe(true)
    if (await wizard.isVisible()) {
      await wizard.getByRole('button', { name: '跳过导览', exact: true }).click()
      const finish = wizard.getByRole('button', { name: '完成设置', exact: true })
      await finish.waitFor({ timeout: 10_000 })
      await finish.click()
      await wizard.waitFor({ state: 'detached', timeout: 10_000 })
    } else {
      await notice.getByRole('button', { name: '继续', exact: true }).click()
      await notice.waitFor({ state: 'detached', timeout: 10_000 })
    }

    await openSettings(page, 'zh')
    const settings = page.getByRole('dialog', { name: '设置' })
    await settings.waitFor({ timeout: 10_000 })
    await settings.getByRole('button', { name: '模型', exact: true }).click()

    // The seeded Kilo Gateway route is the default selection; click it so the
    // detail panel owns the model row regardless of selection timing.
    const provider = settings.getByText('Kilo Gateway', { exact: true }).first()
    await provider.waitFor({ timeout: 15_000 })
    await provider.click()
    const edit = settings.getByRole('button', { name: `编辑模型 ${SEEDED_MODEL_ID}` })
    await edit.waitFor({ timeout: 15_000 })
    await edit.click()

    const metadata = page.getByRole('dialog', { name: '模型详情' })
    await metadata.waitFor({ timeout: 10_000 })
    await metadata.getByText(/kilo · /).waitFor({ timeout: 10_000 })
    expect(await metadata.getByRole('textbox', { name: '模型 ID' }).inputValue()).toBe(SEEDED_MODEL_ID)
    const name = metadata.getByLabel('显示名称')
    expect(await name.inputValue()).toBe(SEEDED_MODEL_NAME)

    await name.fill(UPDATED_MODEL_NAME)
    await metadata.getByRole('button', { name: '保存', exact: true }).click()
    await metadata.waitFor({ state: 'detached', timeout: 10_000 })

    const document = await readFile(
      join(scaffold.harnessHome, 'profiles', 'scaffold', 'cordis.patch.yml'),
      'utf8',
    )
    expect(document).toContain(UPDATED_MODEL_NAME)
    expect(document).not.toContain(SEEDED_MODEL_NAME)

    // The mounted page must adopt the saved settings without navigation.
    await settings.getByText(UPDATED_MODEL_NAME, { exact: true }).waitFor({ timeout: 10_000 })
    expect(await settings.getByText(SEEDED_MODEL_NAME, { exact: true }).count()).toBe(0)

    // Reload proves the persisted row is the one the browser renders: this
    // read uses a fresh describe, not the panel's pre-save settings mirror.
    await page.reload({ waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await openSettings(page, 'zh')
    const reloaded = page.getByRole('dialog', { name: '设置' })
    await reloaded.getByRole('button', { name: '模型', exact: true }).click()
    const reloadedProvider = reloaded.getByText('Kilo Gateway', { exact: true }).first()
    await reloadedProvider.waitFor({ timeout: 15_000 })
    await reloadedProvider.click()
    await reloaded.getByText(UPDATED_MODEL_NAME, { exact: true }).waitFor({ timeout: 15_000 })
    expect(tripwire.pageErrors).toEqual([])
  }, 90_000)
})
