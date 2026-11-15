// @vitest-environment jsdom
/** Compact chrome: header affordances, the drawer slide-over, and the surface seats. */
import { useRef } from 'react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import type { RenderOpts } from '@deepseek-ai/dsh-client-ui-slots'
import { MobileFrame } from '../src/client/MobileFrame.tsx'
import type { AppFrameProps } from '../src/client/AppFrame.tsx'
import type { MobileSurfacesOwnerProps } from '../src/client/index.ts'
import { createLayoutStore } from '../src/client/stores.ts'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import { backStack, getLayoutModeRuntime } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** Synthetic pointer event used by the drawer gesture assertions. */
type TouchLikeEvent = Event & {
  pointerId: number
  clientX: number
  clientY: number
  pointerType: string
}


/** Runtime guard for the compact surface owner share passed by MobileFrame. */
function isMobileSurfacesOwner(owner: object): owner is MobileSurfacesOwnerProps {
  return 'open' in owner && typeof owner.open === 'boolean'
    && 'openMore' in owner && typeof owner.openMore === 'function'
    && 'dismiss' in owner && typeof owner.dismiss === 'function'
    && 'onSelect' in owner && typeof owner.onSelect === 'function'
}

/** One compact chrome mounted inside a synthetic persistent frame. */
function mountMobile(overrides: { readonly dismissBack?: () => boolean } = {}) {
  const instance = createLayoutStore().create()
  const slotCalls: { key: string; props: object; options: RenderOpts | undefined }[] = []
  const renderSlot: AppFrameProps['renderSlot'] = (key, owner, options) => {
    slotCalls.push({ key, props: owner, options })
    if (key === 'sidebar') {
      return <button type="button" data-testid="sidebar-action">Pick</button>
    }
    if (key === 'shell.mobile.bar') {
      if (!isMobileSurfacesOwner(owner)) throw new Error('shell.mobile.bar owner share is missing')
      const surface = owner
      return (
        <div data-testid="shell.mobile.bar-content">
          <button type="button" data-testid="bar-more" aria-expanded={surface.open} onClick={surface.openMore}>
            More
          </button>
          <button type="button" data-testid="bar-entry" onClick={() => { surface.onSelect('files') }}>
            Files
          </button>
        </div>
      )
    }
    if (key === 'shell.mobile.more') {
      if (!isMobileSurfacesOwner(owner)) throw new Error('shell.mobile.more owner share is missing')
      const surface = owner
      return (
        <div data-testid="shell.mobile.more-content">
          <button type="button" data-testid="more-entry" onClick={() => { surface.onSelect('context') }}>
            Context
          </button>
        </div>
      )
    }
    return <div data-testid={`${key}-content`} />
  }
  const useSessions: AppFrameProps['useSessions'] = sel => sel({
    ids: ['s-1' as SessionId],
    byId: {
      ['s-1' as SessionId]: {
        id: 's-1' as SessionId, displayTitle: 'Display title', title: 'Session title', running: false,
        retainedBy: { mainView: 1 }, blank: false, updatedAt: 1,
      },
    },
    phase: 'ready',
    projectionsBySession: {},
  })
  const useStore = bindSnapshotSelector(instance)
  const usePanelInfo = bindSnapshotSelector({
    getSnapshot: () => instance.getSnapshot().panelInfo,
    subscribe: listener => instance.subscribe(listener),
  })
  const dismissBack = vi.fn(() => { overrides.dismissBack?.(); return true })

  function Harness(): ReactNode {
    const frameRef = useRef<HTMLDivElement | null>(null)
    return (
      <div ref={frameRef} data-mobile-frame="">
        <MobileFrame
          frameRef={frameRef}
          productTitle="Product"
          renderSlot={renderSlot}
          useSessions={useSessions}
          usePanelInfo={usePanelInfo}
          useStore={useStore}
          dismissBack={dismissBack}
          t={key => key}
          viewport={390}
        />
        <div data-testid="main-content" data-mobile-content="" />
      </div>
    )
  }
  const utils = render(<Harness />)
  return {
    ...utils, instance, slotCalls, dismissBack,
    frame: utils.container.querySelector<HTMLElement>('[data-mobile-frame]')!,
  }
}

beforeEach(() => {
  localStorage.clear()
  vi.stubGlobal('ResizeObserver', class { observe(): void {} unobserve(): void {} disconnect(): void {} })
})

afterEach(() => {
  cleanup()
  backStack.clear()
  act(() => { getLayoutModeRuntime().setFrameWidth(1440) })
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('MobileFrame', () => {
  it('renders the session title, both chrome rows, and the seat outlets', () => {
    const { getByText, getByTestId } = mountMobile()
    expect(getByText('Session title')).toBeTruthy()
    expect(getByTestId('shell.mobile.header-content')).toBeTruthy()
    expect(getByTestId('shell.mobile.bar-content')).toBeTruthy()
    expect(getByTestId('shell.overlay-content')).toBeTruthy()
  })

  it('opens the left column as a drawer over the content and closes it through the scrim', () => {
    const { frame, getByTestId } = mountMobile()
    expect(frame.querySelector('[data-mobile-drawer]')?.getAttribute('data-mobile-drawer')).toBe('closed')
    fireEvent.click(getByTestId('main-content').ownerDocument.querySelector('[data-mobile-nav-toggle]')!)
    expect(frame.querySelector('[data-mobile-drawer]')?.getAttribute('data-mobile-drawer')).toBe('open')
    // The drawer occupant is the frame's sidebar slot at its wide width.
    expect(getByTestId('sidebar-action')).toBeTruthy()
    fireEvent.click(frame.querySelector('[data-mobile-scrim]')!)
    expect(frame.querySelector('[data-mobile-drawer]')?.getAttribute('data-mobile-drawer')).toBe('closed')
    expect(frame.querySelector('[data-mobile-back]')).toBeNull()
  })

  it('dismisses the drawer when a control inside it acts', () => {
    const { frame, getByTestId } = mountMobile()
    fireEvent.click(frame.querySelector('[data-mobile-nav-toggle]')!)
    fireEvent.click(getByTestId('sidebar-action'))
    expect(frame.querySelector('[data-mobile-drawer]')?.getAttribute('data-mobile-drawer')).toBe('closed')
  })

  it('keeps the drawer occupant mounted after the drawer closes', async () => {
    const { frame, getByTestId } = mountMobile()
    fireEvent.click(frame.querySelector('[data-mobile-nav-toggle]')!)
    fireEvent.click(getByTestId('sidebar-action'))
    await act(async () => { await new Promise((resolve) => { setTimeout(resolve, 0) }) })
    expect(frame.querySelector('[data-mobile-drawer]')?.getAttribute('data-mobile-drawer')).toBe('closed')
    expect(getByTestId('sidebar-action')).toBeTruthy()
  })

  it('shows the back affordance with an open surface and dismisses the stack', () => {
    const { frame, instance, dismissBack } = mountMobile()
    expect(frame.querySelector('[data-mobile-back]')).toBeNull()
    fireEvent.click(frame.querySelector('[data-mobile-nav-toggle]')!)
    const back = frame.querySelector<HTMLElement>('[data-mobile-back]')
    expect(back).toBeTruthy()
    fireEvent.click(back!)
    expect(dismissBack).toHaveBeenCalledTimes(1)
    fireEvent.click(frame.querySelector('[data-mobile-scrim]')!)
    expect(frame.querySelector('[data-mobile-back]')).toBeNull()
    // The right column's own shown report also raises the affordance.
    act(() => { instance.actions.openRightbar(true, true) })
    expect(frame.querySelector('[data-mobile-back]')).toBeTruthy()
  })

  it('folds the surfaces into the header overflow sheet and closes after a selection', () => {
    const { frame, getByText, getByTestId, queryByRole } = mountMobile()
    fireEvent.click(frame.querySelector('[data-mobile-overflow-toggle]')!)
    expect(getByText('mobile.surfaces')).toBeTruthy()
    expect(getByTestId('shell.mobile.more-content')).toBeTruthy()
    fireEvent.click(getByTestId('more-entry'))
    expect(queryByRole('dialog', { name: 'mobile.surfaces' })).toBeNull()
  })

  it('passes one typed More contract to the bar and the overflow seat', () => {
    const { slotCalls } = mountMobile()
    for (const key of ['shell.mobile.bar', 'shell.mobile.more']) {
      const call = slotCalls.find(entry => entry.key === key)
      expect(call).toBeDefined()
      const owner = call?.props
      expect(owner !== undefined && isMobileSurfacesOwner(owner)).toBe(true)
      if (owner === undefined || !isMobileSurfacesOwner(owner)) throw new Error(`${key} owner share is missing`)
      expect(owner).toMatchObject({ open: false })
      expect(typeof owner.openMore).toBe('function')
      expect(typeof owner.dismiss).toBe('function')
      expect(typeof owner.onSelect).toBe('function')
    }
  })

  it('opens the owner sheet from More, enters the dialog, traps Tab, and returns focus to More', () => {
    const { getByTestId, getByRole, queryByRole } = mountMobile()
    const more = getByTestId('bar-more')
    more.focus()
    fireEvent.click(more)
    const dialog = getByRole('dialog', { name: 'mobile.surfaces' })
    expect(document.activeElement).not.toBe(dialog)
    expect(dialog.contains(document.activeElement)).toBe(true)
    expect(more.getAttribute('aria-expanded')).toBe('true')
    const entry = getByTestId('more-entry')
    entry.focus()
    fireEvent.keyDown(document, { key: 'Tab' })
    expect(document.activeElement).toBe(dialog.querySelector('button[aria-label="close"]'))
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(queryByRole('dialog', { name: 'mobile.surfaces' })).toBeNull()
    expect(document.activeElement).toBe(more)
    expect(more.getAttribute('aria-expanded')).toBe('false')
  })

  it('registers one More history record and one pop dismisses it', () => {
    act(() => { getLayoutModeRuntime().setFrameWidth(800) })
    const { getByTestId, queryByRole, container } = mountMobile()
    const push = vi.spyOn(window.history, 'pushState')
    const back = vi.spyOn(window.history, 'back').mockImplementation(() => { /* traversal is dispatched below */ })
    fireEvent.click(getByTestId('bar-more'))
    expect(backStack.depth()).toBe(1)
    expect(push).toHaveBeenCalledTimes(1)
    expect(container.ownerDocument.querySelector('[data-sheet-root]')).not.toBeNull()
    expect(backStack.dismissTop()).toBe(true)
    expect(back).toHaveBeenCalledTimes(1)
    act(() => {
      window.dispatchEvent(new PopStateEvent('popstate', { state: { dsh_surface_depth: 0 } }))
    })
    expect(queryByRole('dialog', { name: 'mobile.surfaces' })).toBeNull()
    expect(backStack.depth()).toBe(0)
  })

  it('closes the More sheet on selection and on the scrim, returning focus to More each time', () => {
    const { getByTestId, queryByRole, container } = mountMobile()
    const more = getByTestId('bar-more')
    more.focus()
    fireEvent.click(more)
    fireEvent.click(getByTestId('more-entry'))
    expect(queryByRole('dialog', { name: 'mobile.surfaces' })).toBeNull()
    expect(document.activeElement).toBe(more)
    fireEvent.click(more)
    fireEvent.click(container.ownerDocument.querySelector('[data-sheet-root] [aria-hidden="true"]') as HTMLElement)
    expect(queryByRole('dialog', { name: 'mobile.surfaces' })).toBeNull()
    expect(document.activeElement).toBe(more)
  })

  it('opens the drawer from a left-edge touch swipe and closes it with a leftward swipe', () => {
    const { frame, getByTestId } = mountMobile()
    const content = frame.querySelector('[data-mobile-content]')!
    const touch = (type: string, clientX: number, clientY = 0): void => {
      const event = new Event(type, { bubbles: true, cancelable: true }) as TouchLikeEvent
      event.pointerId = 1
      event.clientX = clientX
      event.clientY = clientY
      event.pointerType = 'touch'
      fireEvent(content, event)
    }
    touch('pointerdown', 8)
    touch('pointermove', 120)
    expect(frame.querySelector('[data-mobile-drawer]')?.getAttribute('data-mobile-drawer')).toBe('open')
    expect(getByTestId('sidebar-action')).toBeTruthy()
    const drawer = frame.querySelector('[data-mobile-drawer-panel]')!
    const close = new Event('pointerdown', { bubbles: true, cancelable: true }) as TouchLikeEvent
    close.pointerId = 2
    close.clientX = 200
    close.clientY = 0
    close.pointerType = 'touch'
    fireEvent(drawer, close)
    const move = new Event('pointermove', { bubbles: true, cancelable: true }) as TouchLikeEvent
    move.pointerId = 2
    move.clientX = 80
    move.clientY = 0
    move.pointerType = 'touch'
    fireEvent(drawer, move)
    expect(frame.querySelector('[data-mobile-drawer]')?.getAttribute('data-mobile-drawer')).toBe('closed')
  })

  it('restores the chrome from the immersive fold', () => {
    const { frame, getByRole } = mountMobile()
    fireEvent.click(frame.querySelector('[data-mobile-immersive-toggle]')!)
    expect(frame.hasAttribute('data-mobile-immersive')).toBe(true)
    expect(document.documentElement.hasAttribute('data-mobile-immersive')).toBe(true)
    fireEvent.click(getByRole('button', { name: 'mobile.showControls' }))
    expect(frame.hasAttribute('data-mobile-immersive')).toBe(false)
    expect(document.documentElement.hasAttribute('data-mobile-immersive')).toBe(false)
  })

  it('restores the chrome with Escape while immersive', () => {
    const { frame } = mountMobile()
    fireEvent.click(frame.querySelector('[data-mobile-immersive-toggle]')!)
    expect(frame.hasAttribute('data-mobile-immersive')).toBe(true)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(frame.hasAttribute('data-mobile-immersive')).toBe(false)
  })
})
