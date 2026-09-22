/**
 * The mobile shell's surface entries: the bottom action bar and, when the bar
 * folds away (soft keyboard, landscape, short viewport), the same entries
 * inside the header overflow sheet.
 *
 * The entries are the registry's rail items — the page kinds that offer a
 * guide box — so the bar grows with the registry instead of naming kinds here,
 * and one tap opens the same surface the desktop icon rail opens. The active
 * entry stays marked while its page is the one in front, and tapping it again
 * runs the rail's own collapse gesture through `selectKind`.
 */
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type { SidebarRightRailItem } from '../tab-registry.ts'
import type { SidebarRightRailState } from '../rail.ts'
import css from './SidebarRight.module.css'

/** What one mobile entry registration injects. */
export interface MobileSurfacesInjected {
  /** The registry's rail items and the global rail state. */
  readonly hooks: {
    readonly railItems: HostObservable<readonly SidebarRightRailItem[]>
    readonly rail: HostObservable<SidebarRightRailState>
  }
  /** The rail's one gesture, shared with the desktop icon rail. */
  readonly selectKind: (kind: string) => void
  /** Which presentation this occurrence draws. */
  readonly presentation: 'bar' | 'more'
}

/**
 * Composed props of one mobile entry list. Both shell seats carry the same
 * framework shares, so one component type serves the bar and the sheet.
 */
export type MobileSurfacesProps =
  & PropsRuntime<'shell.mobile.bar'>
  & InjectFace<MobileSurfacesInjected>
  & PropsLocale<'sidebarRight'>

/**
 * Render one surface entry list.
 * @param props - the registry hooks, the rail gesture, and the presentation.
 * @returns the entry buttons in registry order.
 */
export function MobileSurfaces({ useRailItems, useRail, usePanelInfo, selectKind, presentation, t }: MobileSurfacesProps) {
  const items = useRailItems(list => list)
  const rail = useRail(state => state)
  // A surface with no mounted seat has no session to open into; the entries
  // stay drawn but inert rather than failing the click.
  const seatAvailable = usePanelInfo(info => info.activePanelId === null)
  const activeKind = rail.kind ?? items[0]?.kind
  const bar = presentation === 'bar'
  return (
    <>
      {items.map((item) => {
        const Icon = item.icon
        const label = item.title()
        const active = rail.open && item.kind === activeKind
        return (
          <button
            key={item.kind}
            type="button"
            className={bar ? css.barItem : css.moreItem}
            aria-label={label}
            aria-pressed={active}
            disabled={!seatAvailable}
            data-mobile-surface={item.kind}
            data-mobile-surface-active={active || undefined}
            onClick={() => { selectKind(item.kind) }}
          >
            {Icon !== undefined && <Icon size={bar ? 18 : 16} />}
            <span className={css.surfaceLabel}>{label}</span>
          </button>
        )
      })}
      {items.length === 0 && <span className={css.surfaceEmpty}>{t('rail.aria')}</span>}
    </>
  )
}
