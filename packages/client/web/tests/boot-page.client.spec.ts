// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BootPage } from '../src/boot-page.ts'

afterEach(() => { document.body.innerHTML = '' })

function mount() {
  const el = document.createElement('div')
  document.body.append(el)
  return { el, page: new BootPage(el) }
}

describe('BootPage', () => {
  it('draws the loading skeleton before any plugin state arrives', () => {
    const { el } = mount()
    expect(el.firstElementChild?.getAttribute('data-dsh-boot')).toBe('')
    expect(el.textContent).toContain('ENPOI')
    expect(el.textContent).toContain('Loading plugins…')
  })

  it('replaces the status line for the reveal gate without touching the wordmark', () => {
    const { el, page } = mount()
    page.setHint('Preparing workspace…')
    expect(el.textContent).toContain('Preparing workspace…')
    expect(el.textContent).not.toContain('Loading plugins…')
    expect(el.textContent).toContain('ENPOI')
    expect(el.querySelector('[data-dsh-boot-spinner]')).not.toBeNull()
  })

  it('keeps loading while entries are active or loading', () => {
    const { el, page } = mount()
    page.setTotal(2)
    const spinner = el.querySelector<HTMLElement>('[data-dsh-boot-spinner]')
    expect(spinner?.style.getPropertyValue('--dsh-boot-arc')).toBe('72deg')
    page.setState('a', 'active')
    expect(spinner?.style.getPropertyValue('--dsh-boot-arc')).toBe('180deg')
    page.setState('b', 'loading')
    expect(el.querySelector('[data-dsh-boot-spinner]')).toBe(spinner)
    page.setState('b', 'active')
    expect(spinner?.style.getPropertyValue('--dsh-boot-arc')).toBe('288deg')
    expect(el.textContent).toContain('Loading plugins…')
    expect(el.textContent).not.toContain('Failed to load plugins')
  })

  it('lists failed entries', () => {
    const { el, page } = mount()
    page.setState('@deepseek-ai/dsh-client-ui-layout', 'failed')
    page.setState('ok', 'active')
    page.setState('@deepseek-ai/dsh-client-ui-tool', 'failed')
    expect(el.textContent).toContain('@deepseek-ai/dsh-client-ui-layout')
    expect(el.textContent).toContain('@deepseek-ai/dsh-client-ui-tool')
    expect(el.textContent).not.toContain('ok')
    expect(el.textContent).not.toContain('Loading plugins…')
  })

  it('renders one explicit retry action on a failure report', () => {
    const { el, page } = mount()
    const retry = vi.fn()
    page.fail('offline', retry)
    const button = el.querySelector<HTMLButtonElement>('[data-dsh-boot-retry]')
    expect(button?.textContent).toBe('Retry')
    button?.click()
    expect(retry).toHaveBeenCalledOnce()
  })

  it('renders suppressed retry feedback and disables a terminal action', () => {
    const { el, page } = mount()
    const retry = vi.fn(() => ({ message: 'Retry limit reached; reload the page manually.', disabled: true }))
    page.fail('offline', retry)
    const button = el.querySelector<HTMLButtonElement>('[data-dsh-boot-retry]')
    button?.click()
    expect(el.textContent).toContain('Retry limit reached; reload the page manually.')
    const disabled = el.querySelector<HTMLButtonElement>('[data-dsh-boot-retry]')
    expect(disabled?.disabled).toBe(true)
    disabled?.click()
    expect(retry).toHaveBeenCalledOnce()
  })

  it('keeps a cooldown retry action enabled for a later attempt', () => {
    const { el, page } = mount()
    const retry = vi.fn(() => ({ message: 'Retry is cooling down; try again in 4s.' }))
    page.fail('offline', retry)
    const button = el.querySelector<HTMLButtonElement>('[data-dsh-boot-retry]')
    button?.click()
    expect(el.textContent).toContain('Retry is cooling down; try again in 4s.')
    expect(button?.disabled).toBe(false)
  })

  it('keeps a failure without a retry action button-free', () => {
    const { el, page } = mount()
    page.fail('config is broken')
    expect(el.querySelector('[data-dsh-boot-retry]')).toBeNull()
  })

  it('shows the complete sweep report', () => {
    const { el, page } = mount()
    const report = 'web boot: 1 entry did not activate\nx: pending (waiting for service: y)'
    page.fail(report)
    page.setState('a', 'active')
    expect(el.textContent).toContain(report)
    expect(el.textContent).not.toContain('Loading plugins…')
  })

  it('detaches on disposal', () => {
    const { el, page } = mount()
    page.dispose()
    expect(el.childNodes).toHaveLength(0)
  })
})
