// @vitest-environment jsdom
/** The mobile surface entry lists: what the bottom bar and the overflow sheet draw. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type { SidebarRightRailItem } from '../src/client/tab-registry.ts'
import { MobileSurfaces } from '../src/client/shell/MobileSurfaces.tsx'
import type { MobileSurfacesProps } from '../src/client/shell/MobileSurfaces.tsx'

const items: readonly SidebarRightRailItem[] = [
  { kind: 'files', title: () => 'Files' },
  { kind: 'terminal', title: () => 'Terminal' },
]

/** The framework seats this component does not read, stubbed to satisfy the composed props. */
const unusedStandard = {
  useSessions: () => '',
  useSessionStatus: () => undefined,
  useSessionRetainInfo: () => undefined,
  useWorkspaces: () => undefined,
  useResource: () => undefined,
} as unknown as Pick<MobileSurfacesProps, 'useSessions' | 'useSessionStatus' | 'useSessionRetainInfo' | 'useWorkspaces' | 'useResource'>

function mountSurfaces(
  presentation: 'bar' | 'more',
  railOpen = true,
  kind: string | null = 'files',
  seatMounted = true,
  entries: readonly SidebarRightRailItem[] = items,
  moreOpen = false,
) {
  const selectKind = vi.fn()
  const openMore = vi.fn()
  const dismiss = vi.fn()
  const onSelect = vi.fn()
  const props: MobileSurfacesProps = {
    ...unusedStandard,
    useRailItems: selector => selector(entries),
    useRail: selector => selector({ open: railOpen, kind, editorWidth: 420 }),
    usePanelInfo: selector => selector({ activePanelId: seatMounted ? null : 'plugin-manager' as MainPanelId }),
    selectKind,
    presentation,
    open: moreOpen,
    openMore,
    dismiss,
    onSelect,
    t: key => key,
  }
  const utils = render(<MobileSurfaces {...props} />)
  return { ...utils, selectKind, openMore, dismiss, onSelect }
}

afterEach(cleanup)

describe('MobileSurfaces', () => {
  const many: readonly SidebarRightRailItem[] = [
    { kind: 'files', title: () => 'Files' },
    { kind: 'terminal', title: () => 'Terminal' },
    { kind: 'browser', title: () => 'Browser' },
    { kind: 'models', title: () => 'Models' },
    { kind: 'capabilities', title: () => 'Capabilities' },
    { kind: 'context', title: () => 'Context' },
  ]

  it('draws one entry per rail item and selects before asking the owner to close', () => {
    const { getAllByRole, selectKind, onSelect, container } = mountSurfaces('bar')
    const buttons = getAllByRole('button')
    expect(buttons.map(button => button.getAttribute('aria-label'))).toEqual(['Files', 'Terminal'])
    expect(container.querySelectorAll('[data-mobile-surface]')).toHaveLength(2)
    fireEvent.click(buttons[1]!)
    expect(selectKind).toHaveBeenCalledWith('terminal')
    expect(onSelect).toHaveBeenCalledWith('terminal')
    expect(selectKind.mock.invocationCallOrder[0]).toBeLessThan(onSelect.mock.invocationCallOrder[0]!)
  })

  it('marks the lit entry only while the panel records an open intent', () => {
    const open = mountSurfaces('bar')
    expect(open.container.querySelector('[data-mobile-surface="files"]')?.hasAttribute('data-mobile-surface-active')).toBe(true)
    expect(open.container.querySelector('[data-mobile-surface="terminal"]')?.hasAttribute('data-mobile-surface-active')).toBe(false)
    open.unmount()
    const closed = mountSurfaces('more', false)
    expect(closed.container.querySelector('[data-mobile-surface-active]')).toBeNull()
  })

  it('keeps the entries inert while a global panel holds the main view', () => {
    const { container, selectKind, onSelect } = mountSurfaces('more', true, 'files', false)
    const button = container.querySelector<HTMLButtonElement>('[data-mobile-surface="files"]')!
    expect(button.disabled).toBe(true)
    fireEvent.click(button)
    expect(selectKind).not.toHaveBeenCalled()
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('bounds the bar to the first three plus the active entry and More', () => {
    const { container } = mountSurfaces('bar', true, 'context', true, many)
    const buttons = [...container.querySelectorAll<HTMLButtonElement>('[data-mobile-surface], [data-mobile-more]')]
    expect(buttons.map(button => button.getAttribute('aria-label'))).toEqual([
      'Files', 'Terminal', 'Browser', 'Context', 'mobile.more',
    ])
    expect(buttons).toHaveLength(5)
    const active = container.querySelector('[data-mobile-surface="context"]')!
    expect(active.hasAttribute('data-mobile-surface-active')).toBe(true)
    const more = container.querySelector<HTMLButtonElement>('[data-mobile-more]')!
    expect(more.getAttribute('aria-haspopup')).toBe('dialog')
    expect(more.getAttribute('aria-label')).toBe('mobile.more')
  })

  it('does not pin an entry while the rail records a close', () => {
    const { container } = mountSurfaces('bar', false, 'context', true, many)
    expect(container.querySelectorAll('[data-mobile-surface]')).toHaveLength(3)
    expect(container.querySelector('[data-mobile-surface-active]')).toBeNull()
    expect(container.querySelector('[data-mobile-more]')).not.toBeNull()
  })

  it('omits More when every entry fits in the bar', () => {
    const { container } = mountSurfaces('bar', true, 'files', true, many.slice(0, 3))
    expect(container.querySelectorAll('[data-mobile-surface]')).toHaveLength(3)
    expect(container.querySelector('[data-mobile-more]')).toBeNull()
  })

  it('keeps every registry entry reachable through the full More list', () => {
    const bar = mountSurfaces('bar', true, 'files', true, many)
    const barKinds = [...bar.container.querySelectorAll('[data-mobile-surface]')]
      .map(button => button.getAttribute('data-mobile-surface'))
    const more = mountSurfaces('more', true, 'files', true, many)
    const moreKinds = [...more.container.querySelectorAll('[data-mobile-surface]')]
      .map(button => button.getAttribute('data-mobile-surface'))
    expect(new Set([...barKinds, ...moreKinds])).toEqual(new Set(many.map(item => item.kind)))
    expect(more.container.querySelectorAll('[data-mobile-surface]')).toHaveLength(many.length)
  })

  it('opens the owner sheet from More and reflects its expanded state', () => {
    const closed = mountSurfaces('bar', true, 'files', true, many)
    const closedMore = closed.container.querySelector<HTMLButtonElement>('[data-mobile-more]')!
    expect(closedMore.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(closedMore)
    expect(closed.openMore).toHaveBeenCalledOnce()
    closed.unmount()
    const open = mountSurfaces('bar', true, 'files', true, many, true)
    expect(open.container.querySelector<HTMLButtonElement>('[data-mobile-more]')?.getAttribute('aria-expanded')).toBe('true')
  })
})
