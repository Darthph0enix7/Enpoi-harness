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

function mountSurfaces(presentation: 'bar' | 'more', railOpen = true, kind: string | null = 'files', seatMounted = true) {
  const selectKind = vi.fn()
  const props: MobileSurfacesProps = {
    ...unusedStandard,
    useRailItems: selector => selector(items),
    useRail: selector => selector({ open: railOpen, kind, editorWidth: 420 }),
    usePanelInfo: selector => selector({ activePanelId: seatMounted ? null : 'plugin-manager' as MainPanelId }),
    selectKind,
    presentation,
    t: key => key,
  }
  const utils = render(<MobileSurfaces {...props} />)
  return { ...utils, selectKind }
}

afterEach(cleanup)

describe('MobileSurfaces', () => {
  it('draws one entry per rail item and opens its kind through the rail gesture', () => {
    const { getAllByRole, selectKind, container } = mountSurfaces('bar')
    const buttons = getAllByRole('button')
    expect(buttons.map(button => button.getAttribute('aria-label'))).toEqual(['Files', 'Terminal'])
    expect(container.querySelectorAll('[data-mobile-surface]')).toHaveLength(2)
    fireEvent.click(buttons[1]!)
    expect(selectKind).toHaveBeenCalledWith('terminal')
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
    const { container, selectKind } = mountSurfaces('more', true, 'files', false)
    const button = container.querySelector<HTMLButtonElement>('[data-mobile-surface="files"]')!
    expect(button.disabled).toBe(true)
    fireEvent.click(button)
    expect(selectKind).not.toHaveBeenCalled()
  })
})
