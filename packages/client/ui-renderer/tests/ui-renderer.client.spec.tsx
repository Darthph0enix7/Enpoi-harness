// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup } from '@testing-library/react'
import { Context } from '@deepseek-ai/cordis'
import { SlotRegistry } from '../src/client/registry.ts'
import type { SlotScopeAdapter, StandardSourceBinding } from '../src/client/index.ts'
import { apply as nodeApply } from '@deepseek-ai/dsh-client-ui-renderer'
import * as UiRenderer from '../src/client/index.ts'

const mounted: (() => void)[] = []

afterEach(() => {
  act(() => { for (const unmount of mounted.splice(0)) unmount() })
  vi.restoreAllMocks()
  cleanup()
  document.body.innerHTML = ''
})

const stabilize = async (fn: () => void | Promise<void>): Promise<void> => {
  await act(async () => { await fn() })
}

async function bench(options: { sessionScope?: boolean } = {}) {
  const ctx = new Context()
  const fiber = ctx.plugin({ inject: [...UiRenderer.inject], apply: UiRenderer.apply })
  await fiber.await()
  const slots = ctx.get('slots') as SlotRegistry
  const absentBinding: StandardSourceBinding = {
    key: undefined,
    hooks: {},
    keyedHooks: {},
    props: {},
  }
  const current = {
    getSnapshot: () => absentBinding,
    subscribe: () => () => {},
  }
  const adapter: SlotScopeAdapter = {
    current,
    bindingSource: () => current,
  }
  if (options.sessionScope !== false) slots.installScope('session', adapter)
  return { ctx, slots, fiber }
}

function container(): HTMLElement {
  const el = document.createElement('div')
  document.body.append(el)
  return el
}

describe('UI renderer plugin', () => {
  it('provides no host-side behavior', () => {
    expect(() => { nodeApply() }).not.toThrow()
  })

  it('installs the renderer and mounts the assembled application', async () => {
    const { ctx, slots } = await bench()
    slots.register({ name: 'root' }, () => <div data-testid="root-probe" />)
    const renderer = ctx.get('uiRenderer')
    expect(renderer).toBeDefined()
    const el = container()
    act(() => { mounted.push(renderer!.mount(el)) })
    expect(el.querySelector('[data-testid="root-probe"]')).toBeTruthy()
  })

  it('hydrates the boot page before switching to the assembled application', async () => {
    const { ctx, slots } = await bench()
    slots.register({ name: 'root' }, () => <div data-testid="root-probe" />)
    const el = container()
    el.innerHTML = '<div class="boot" data-dsh-boot=""><div><div class="spinner" data-dsh-boot-spinner="" style="--dsh-boot-arc: 180deg"></div><div>Loading plugins…</div></div></div>'
    const boot = el.firstElementChild
    const observer = new MutationObserver(() => {})
    observer.observe(el, { childList: true, subtree: true })
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})

    act(() => { mounted.push(ctx.get('uiRenderer')!.mount(el)) })

    const records = observer.takeRecords()
    observer.disconnect()
    expect(error).not.toHaveBeenCalled()
    error.mockRestore()
    expect(el.querySelector('[data-testid="root-probe"]')).toBeTruthy()
    expect(records.some(record => record.target === boot)).toBe(false)
  })

  it('keeps a visible fallback mounted when the application render crashes', async () => {
    const { ctx, slots } = await bench({ sessionScope: false })
    const el = container()
    const globals = globalThis as Record<string, unknown>
    const fatal = vi.fn()
    globals.__DSH_CLIENT_HEALTH__ = { fatal }
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})

    try {
      // The root entry declares a session child, but no session scope adapter is
      // installed: assembly fails inside the root render path.
      slots.register({
        name: 'root',
        children: { probe: { kind: 'single', scope: 'session' } },
      } as never, () => <div />)
      act(() => { mounted.push(ctx.get('uiRenderer')!.mount(el)) })
      expect(el.querySelector('[data-dsh-fatal-fallback]')).not.toBeNull()
      expect(fatal).toHaveBeenCalledOnce()
      expect(error).toHaveBeenCalled()
    } finally {
      delete globals.__DSH_CLIENT_HEALTH__
    }
  })

  it('falls back to the boot surface when the hydrated application crashes', async () => {
    const { ctx, slots } = await bench({ sessionScope: false })
    const el = container()
    el.innerHTML = '<div class="boot" data-dsh-boot=""><div data-dsh-boot-spinner=""></div></div>'
    const globals = globalThis as Record<string, unknown>
    const fatal = vi.fn()
    globals.__DSH_CLIENT_HEALTH__ = { fatal }
    vi.spyOn(console, 'error').mockImplementation(() => {})

    try {
      slots.register({
        name: 'root',
        children: { probe: { kind: 'single', scope: 'session' } },
      } as never, () => <div />)
      act(() => { mounted.push(ctx.get('uiRenderer')!.mount(el)) })
      expect(el.querySelector('[data-dsh-boot]')).not.toBeNull()
      expect(fatal).toHaveBeenCalledOnce()
    } finally {
      delete globals.__DSH_CLIENT_HEALTH__
    }
  })

  it('waits for the root registration instead of crashing after a renderer remount', async () => {
    const { ctx, slots } = await bench()
    const el = container()
    const globals = globalThis as Record<string, unknown>
    const fatal = vi.fn()
    globals.__DSH_CLIENT_HEALTH__ = { fatal }

    try {
      // The layout registration is still re-applying: nothing renders, nothing crashes.
      act(() => { mounted.push(ctx.get('uiRenderer')!.mount(el)) })
      expect(el.querySelector('[data-dsh-fatal-fallback]')).toBeNull()
      expect(fatal).not.toHaveBeenCalled()
      expect(el.querySelector('[data-testid="root-probe"]')).toBeNull()
      // The declaration arriving later attaches the application.
      await act(async () => {
        slots.register({ name: 'root' }, () => <div data-testid="root-probe" />)
      })
      expect(el.querySelector('[data-testid="root-probe"]')).toBeTruthy()
      expect(fatal).not.toHaveBeenCalled()
    } finally {
      delete globals.__DSH_CLIENT_HEALTH__
    }
  })

  it('returns an unmount disposer', async () => {
    const { ctx, slots } = await bench()
    slots.register({ name: 'root' }, () => <div data-testid="root-probe" />)
    const el = container()
    let unmount: () => void = () => {}
    act(() => { unmount = ctx.get('uiRenderer')!.mount(el) })
    act(() => { unmount() })
    expect(el.querySelector('[data-testid="root-probe"]')).toBeNull()
  })

  it('returns a safe unmount disposer before the root registration arrives', async () => {
    const { ctx } = await bench()
    const el = container()
    let unmount: () => void = () => {}
    act(() => { unmount = ctx.get('uiRenderer')!.mount(el) })
    act(() => { unmount() })
    expect(el.childElementCount).toBe(0)
  })

  it('retracts the service and renderer with its fiber', async () => {
    const { ctx, slots, fiber } = await bench()
    await stabilize(() => fiber.dispose())
    expect(ctx.get('uiRenderer')).toBeUndefined()
    expect(() => slots.renderSlot('root', {})).toThrow('not installed')
  })
})
