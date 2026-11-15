/**
 * The mobile shell's surface entries: the bottom action bar and, when the bar
 * folds away (soft keyboard, landscape, short viewport), the full entry list
 * inside the header overflow sheet.
 *
 * The entries are the registry's rail items — the page kinds that offer a
 * guide box — so the bar grows with the registry instead of naming kinds here,
 * and one tap opens the same surface the desktop icon rail opens. The bar is
 * bounded to the first three entries plus the active entry when that entry is
 * further down the registry, so the current surface always stays visible and a
 * long registry never scrolls the bar off-screen. The More control opens the
 * shell's existing overflow sheet, which carries the whole list. The active
 * entry stays marked while its page is the one in front, and tapping it again
 * runs the rail's own collapse gesture through `selectKind`.
 */
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { IconEllipsisOutlineMedium } from '@deepseek-ai/dsh-client-ui-primitives'
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

/** Registry entries the bottom bar shows before the active pin and More. */
const BAR_LIMIT = 3

/** The active entry's kind, or undefined while the rail records a close. */
function activeKindOf(
  items: readonly SidebarRightRailItem[],
  rail: SidebarRightRailState,
): string | undefined {
  const kind = rail.kind ?? items[0]?.kind
  return rail.open === false ? undefined : kind
}

/**
 * The bar's bounded entry list: the first registry entries plus the active one
 * when it is further down. Order stays registry order; the pinned active entry
 * is appended, not moved ahead of the first entries.
 * @param items - rail items in registry order.
 * @param rail - the global rail state.
 * @returns the entries the bar draws.
 */
export function barEntries(
  items: readonly SidebarRightRailItem[],
  rail: SidebarRightRailState,
): readonly SidebarRightRailItem[] {
  const activeKind = activeKindOf(items, rail)
  const visible = items.slice(0, BAR_LIMIT)
  if (activeKind === undefined || visible.some(item => item.kind === activeKind)) return visible
  const pinned = items.find(item => item.kind === activeKind)
  return pinned === undefined ? visible : [...visible, pinned]
}

/** Whether the bar has entries behind its More control. */
export function hasHiddenEntries(
  items: readonly SidebarRightRailItem[],
  rail: SidebarRightRailState,
): boolean {
  const visible = barEntries(items, rail)
  return items.some(item => !visible.some(entry => entry.kind === item.kind))
}

/**
 * Render one surface entry list.
 * @param props - the registry hooks, the rail gesture, and the presentation.
 * @returns the entry buttons in registry order.
 */
export function MobileSurfaces({
  useRailItems, useRail, usePanelInfo, selectKind, presentation, open, openMore, onSelect, t,
}: MobileSurfacesProps) {
  const items = useRailItems(list => list)
  const rail = useRail(state => state)
  // A surface with no mounted seat has no session to open into; the entries
  // stay drawn but inert rather than failing the click.
  const seatAvailable = usePanelInfo(info => info.activePanelId === null)
  const activeKind = activeKindOf(items, rail)
  const bar = presentation === 'bar'
  const shown = bar ? barEntries(items, rail) : items
  const showMore = bar && hasHiddenEntries(items, rail)
  return (
    <>
      {shown.map((item) => {
        const Icon = item.icon
        const label = item.title()
        const active = item.kind === activeKind
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
            onClick={() => {
              selectKind(item.kind)
              onSelect(item.kind)
            }}
          >
            {Icon !== undefined && <Icon size={bar ? 18 : 16} />}
            <span className={css.surfaceLabel}>{label}</span>
          </button>
        )
      })}
      {showMore && (
        <button
          type="button"
          className={css.barItem}
          aria-label={t('mobile.more')}
          aria-haspopup="dialog"
          aria-expanded={open}
          data-mobile-more=""
          onClick={openMore}
        >
          <IconEllipsisOutlineMedium size={18} />
          <span className={css.surfaceLabel}>{t('mobile.more')}</span>
        </button>
      )}
      {items.length === 0 && <span className={css.surfaceEmpty}>{t('rail.aria')}</span>}
    </>
  )
}
