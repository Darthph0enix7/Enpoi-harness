// The adaptive foundation classifies capability, not width alone: a touch
// viewport at phone width reports `data-device="phone"` / `data-pointer="coarse"`
// on the root element, while a 1440x900 fine-pointer page keeps `desktop` and
// the untouched three-column frame. Both pages must boot without page errors,
// which is the assembled proof that the classifier runs inside the real graph.
import { chromium } from 'playwright'
import { expect, it } from 'vitest'
import { launchWebScaffold, watchConsole } from './scaffold.ts'

it('classifies a 390x844 touch viewport as phone and a 1440x900 desktop as desktop', async () => {
  const scaffold = await launchWebScaffold({})
  try {
    const browser = await chromium.launch()
    try {
      const phone = await browser.newPage({
        viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, locale: 'en-US',
      })
      const phoneWatch = watchConsole(phone)
      await phone.goto(scaffold.authenticatedUrl)
      await expect.poll(() => phone.locator('html').getAttribute('data-device'), { timeout: 30_000 }).toBe('phone')
      expect(await phone.locator('html').getAttribute('data-pointer')).toBe('coarse')
      await phone.locator('[data-device="phone"] #root').waitFor({ timeout: 15_000 })
      expect(phoneWatch.pageErrors).toEqual([])

      const desktop = await browser.newPage({ viewport: { width: 1440, height: 900 }, locale: 'en-US' })
      const desktopWatch = watchConsole(desktop)
      await desktop.goto(scaffold.authenticatedUrl)
      await expect.poll(() => desktop.locator('html').getAttribute('data-device'), { timeout: 30_000 }).toBe('desktop')
      expect(await desktop.locator('html').getAttribute('data-pointer')).toBe('fine')
      await desktop.locator('[data-device="desktop"] #root').waitFor({ timeout: 15_000 })
      expect(desktopWatch.pageErrors).toEqual([])
    } finally {
      await browser.close()
    }
  } finally {
    await scaffold.close()
  }
})
