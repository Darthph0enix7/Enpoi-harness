// @vitest-environment jsdom
/** Mobile container: header affordances, the drawer slide-over, and the surface seats. */
import { useRef } from 'react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import type { RenderOpts } from '@deepseek-ai/dsh-client-ui-slots'
import { MobileFrame } from '../src/client/MobileFrame.tsx'
import type { AppFrameProps } from '../src/client/AppFrame.tsx'
import { createLayoutStore } from '../src/client/stores.ts'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** Synthetic pointer event used by the drawer gesture assertions. */
type TouchLikeEvent = Event & {
  pointerId: number
  clientX: number
  clientY: number
  pointerType: string
}


/** One mounted mobile frame with the slot calls it made. */
function mountMobile(overrides: { readonly dismissBack?: () => boolean } = {}) {
  const instance = createLayoutStore().create()
  const slotCalls: { key: string; props: object; options: RenderOpts | undefined }[] = []
  const renderSlot: AppFrameProps['renderSlot'] = (key, owner, options) => {
    slotCalls.push({ key, props: owner, options })
    if (key === 'sidebar') {
      return <button type="button" data-testid="sidebar-action">Pick</button>
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
    subagentsByParent: {},
    jobsBySession: {},
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
      <MobileFrame
        frameRef={frameRef}
        productTitle="Product"
        main={<div data-testid="main-content" />}
        renderSlot={renderSlot}
        useSessions={useSessions}
        usePanelInfo={usePanelInfo}
        useStore={useStore}
        dismissBack={dismissBack}
        t={key => key}
        viewport={390}
      />
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

  it('hands the right column the mobile fullscreen owner props', () => {
    const { slotCalls } = mountMobile()
    expect(slotCalls.findLast(call => call.key === 'rightbar')?.props)
      .toEqual({ width: 390, viewportWidth: 390, canShow: true, mobile: true })
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

  it('folds the surfaces into the header overflow sheet', () => {
    const { frame, getByText, getByTestId } = mountMobile()
    fireEvent.click(frame.querySelector('[data-mobile-overflow-toggle]')!)
    expect(getByText('mobile.surfaces')).toBeTruthy()
    expect(getByTestId('shell.mobile.more-content')).toBeTruthy()
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
    fireEvent.click(getByRole('button', { name: 'mobile.exitFullscreen' }))
    expect(frame.hasAttribute('data-mobile-immersive')).toBe(false)
  })
})
