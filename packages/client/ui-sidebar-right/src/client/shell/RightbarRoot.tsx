/** Root-scoped controller for the right Sidebar's Session content. */
import type { ReactNode } from 'react'
import type {
  HostObservable, InjectFace, PropsLocale, PropsRenderSlots, PropsRuntime,
} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '../contract/slots.ts'
import type { SidebarRightRailState } from '../rail.ts'
import type { SidebarRightRailItem } from '../tab-registry.ts'
import { Rail, type RightbarSeatProps } from './SidebarRight.tsx'

/** What the root seat injects beyond the framework shares. */
export interface RightbarRootInjected {
  readonly hooks: {
    /** One entry per page kind offering a guide box; what the session-less rail draws. */
    readonly railItems: HostObservable<readonly SidebarRightRailItem[]>
    /** The global rail state: the staged kind while no session exists. */
    readonly rail: HostObservable<SidebarRightRailState>
  }
  /**
   * Record a rail choice while no session surface exists. The first session's
   * seat applies the staged kind through its own open path.
   * @param kind - the page kind whose rail icon was clicked.
   */
  readonly stageKind: (kind: string) => void
}

/** Root seat props: frame geometry, the session seat, and the rail's own faces. */
export type RightbarRootProps =
  & PropsRuntime<'rightbar'>
  & PropsRenderSlots<'rightbar.session'>
  & PropsLocale<'sidebarRight'>
  & InjectFace<RightbarRootInjected>

/**
 * Render the Session-bound Sidebar only while the Conversation is selected.
 * @param props - frame geometry, panel selection, and the authorized Session renderer.
 * @returns the current Session's right Sidebar, or the session-less icon rail.
 */
export function RightbarRoot({
  usePanelInfo, SessionProvider, renderSlot, width, viewportWidth, canShow, mobile,
  useRail, useRailItems, stageKind, t,
}: RightbarRootProps): ReactNode {
  const visible = usePanelInfo(info => info.activePanelId === null)
  if (!visible) return null
  // enpoi: the icon rail is chrome, not session content — it stays mounted in
  // the no-session state (the wizard tour spotlights it before any session
  // exists) and records the operator's kind so the first session opens it.
  return (
    <SessionProvider
      empty={() => <SessionlessRail useRail={useRail} useRailItems={useRailItems} onSelect={stageKind} t={t} />}
    >
      {renderSlot('rightbar.session', {
        width, viewportWidth, canShow, mobile,
        active: true,
        retainTab: () => () => {},
      })}
    </SessionProvider>
  )
}

/** The rail in the no-session state: the page icons and terminal control, no panel. */
function SessionlessRail({ useRail, useRailItems, onSelect, t }: {
  readonly useRail: RightbarRootProps['useRail']
  readonly useRailItems: RightbarRootProps['useRailItems']
  readonly onSelect: (kind: string) => void
  readonly t: RightbarSeatProps['t']
}): ReactNode {
  const items = useRailItems(entries => entries)
  const rail = useRail(state => state)
  return (
    <Rail
      items={items}
      active={rail.kind ?? undefined}
      fullscreen={false}
      autoFullscreen={false}
      onSelect={onSelect}
      t={t}
    />
  )
}
