/**
 * enpoi: the collapsible bottom dock and its header toggle. The dock hosts
 * only terminals, spans the conversation column, and gives that column back
 * its space by squeezing it while open (a margin keyed on the marker this
 * component writes, never a change in another package's layout code).
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { IconChevronDownOutlineRegular, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { TerminalInjected } from './contract.ts'
import { clampDockHeight } from './registry.ts'
import type { TerminalTabState } from './registry.ts'
import { BottomPanelIcon, TerminalIcon } from './icons.tsx'
import { TerminalStatusBanner, TerminalTabStrip } from './TerminalPanel.tsx'
import { TerminalView } from './TerminalView.tsx'
import css from './TerminalPanel.module.css'

/** Empty selection kept reference-stable so a selector never re-renders the dock. */
const EMPTY_TABS: readonly TerminalTabState[] = []

/**
 * Closing-ride settle delay in ms: the stylesheet's slow transition plus a
 * frame of slack, so the dock stays mounted until its slide-out has finished.
 */
const DOCK_RIDE_MS = 360

/**
 * Body marker the dock's handle sets while dragging; the stylesheet pauses the
 * column's eased margin so it stays 1:1 with the pointer.
 */
const DOCK_RESIZE_MARKER = 'data-enpoi-bottom-dock-resizing'

/** Horizontal box of the conversation column's content, in viewport px. */
export interface DockBox {
  /** Left content edge in px. */
  readonly left: number
  /** Content width in px; 0 until the first successful measure. */
  readonly width: number
}

/**
 * Derive the dock's fixed box from the conversation column's border-box rect
 * and its horizontal padding: the dock spans the column's content box, so it
 * stops before any padding that reserves the collapsed sidebar rail.
 * @param rect - the column's border-box `left` and `width` in px.
 * @param paddingLeft - the column's computed left padding in px.
 * @param paddingRight - the column's computed right padding in px.
 * @returns the content-box left edge and width, width clamped at zero.
 */
export function dockBoxFromRect(
  rect: { readonly left: number; readonly width: number },
  paddingLeft: number,
  paddingRight: number,
): DockBox {
  return {
    left: rect.left + paddingLeft,
    width: Math.max(0, rect.width - paddingLeft - paddingRight),
  }
}

/**
 * Measure the conversation column's content box so the fixed dock can sit
 * exactly over it; observed through column resizes (panel drags, sidebar
 * collapse, viewport changes).
 * @param active - whether the dock is open.
 * @returns the column's content left edge and width in px.
 */
function useCenterColumnBox(active: boolean): DockBox {
  const [box, setBox] = useState<DockBox>({ left: 0, width: 0 })
  useEffect(() => {
    if (!active) return undefined
    let frame: number | null = null
    const column = (): HTMLElement | null => {
      const previous = document.querySelector<HTMLElement>('[data-rightbar-col]')?.previousElementSibling
      return previous instanceof HTMLElement ? previous : null
    }
    const measure = (): void => {
      const element = column()
      if (element === null) return
      const rect = element.getBoundingClientRect()
      const style = getComputedStyle(element)
      const next = dockBoxFromRect(
        rect,
        Number.parseFloat(style.paddingLeft) || 0,
        Number.parseFloat(style.paddingRight) || 0,
      )
      setBox(prev => Math.abs(prev.left - next.left) < 0.5 && Math.abs(prev.width - next.width) < 0.5
        ? prev
        : next)
    }
    const schedule = (): void => {
      if (frame !== null) return
      frame = requestAnimationFrame(() => { frame = null; measure() })
    }
    measure()
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(schedule)
    const element = column()
    if (element !== null) observer?.observe(element)
    window.addEventListener('resize', schedule)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', schedule)
      if (frame !== null) cancelAnimationFrame(frame)
    }
  }, [active])
  return box
}

/** Composed props of the bottom terminal dock. */
export type BottomTerminalDockProps =
  & PropsRuntime<'shell.overlay'>
  & InjectFace<TerminalInjected>

/**
 * The bottom dock: terminals only, collapsed or sized by its top edge.
 * @param props - framework shares and the terminal inject face.
 * @returns the dock, or nothing while it is closed or no session is current.
 */
export function BottomTerminalDock({
  useSessions, useTerminals, openTerminal, closeTerminal, activateTerminal,
  writeTerminal, resizeTerminal, subscribeTerminal, readTerminal, toggleTerminalDock, setTerminalDockHeight,
}: BottomTerminalDockProps): ReactNode {
  const dock = useTerminals(state => state.dock)
  // The merged session list has no global "current" selection (navigation is
  // per-view): the dock binds the first listed session, preserving its old
  // fallback behavior.
  const fallbackSessionId = useSessions(state => state?.ids?.[0] ?? Object.keys(state?.byId ?? {})[0])
  const sessionId = fallbackSessionId ?? 'global'
  const cwd = useSessions(state => (sessionId === undefined ? undefined : state?.byId?.[sessionId as never]?.cwd))
  const session = useTerminals(state => (sessionId === undefined ? undefined : state.bySession[sessionId]))
  const tabs = useMemo(() => session?.tabs.filter(tab => tab.place === 'bottom') ?? EMPTY_TABS, [session])
  const active = tabs.find(tab => tab.id === session?.active.bottom) ?? tabs[0]
  const box = useCenterColumnBox(dock.open)

  // Opening the dock spawns its first shell when it hosts none; the guard
  // keeps React's double-invoked mount effect from opening two.
  const spawned = useRef(false)
  useEffect(() => {
    if (!dock.open || sessionId === undefined || spawned.current) return
    if (tabs.length > 0) return
    spawned.current = true
    openTerminal(sessionId, 'bottom', cwd)
  }, [cwd, dock.open, openTerminal, sessionId, tabs.length])

  const [preview, setPreview] = useState<number | undefined>(undefined)
  const [dragging, setDragging] = useState(false)
  const drag = useRef<{ pointerId: number; startY: number; startHeight: number; height: number } | undefined>(undefined)
  const height = preview ?? dock.height

  // The dock rides in and out on the same slow curve the conversation column's
  // margin uses, so the main glass edge and the dock's top edge stay glued. The
  // element stays mounted for the closing ride (the stylesheet moves it to
  // translateY(100%) while the column's margin eases back to zero); the settle
  // timer clears the short overlap after the transition has certainly ended.
  // The closing marker must exist in the commit that drops `dock.open`: a later
  // commit would remove the open body marker first, and the column's margin
  // rule — which carries its transition — would stop matching before the margin
  // target moved, landing the main edge in one step.
  const [closing, setClosing] = useState(false)
  const previousOpen = useRef(dock.open)
  const justClosed = !dock.open && previousOpen.current
  previousOpen.current = dock.open
  if (justClosed && !closing) setClosing(true)
  if (dock.open && closing) setClosing(false)
  useEffect(() => {
    if (!closing) return undefined
    const timer = window.setTimeout(() => { setClosing(false) }, DOCK_RIDE_MS)
    return () => { window.clearTimeout(timer) }
  }, [closing])
  const visible = dock.open || closing

  // The conversation column gives up exactly the dock's height while open. On
  // the closing ride the height target drops to zero in the same commit, so the
  // margin eases back beneath the descending dock.
  useEffect(() => {
    if (!visible) return undefined
    document.body.setAttribute('data-enpoi-bottom-dock-open', '')
    document.documentElement.style.setProperty('--enpoi-bottom-dock-height', `${dock.open ? height : 0}px`)
    return () => {
      document.body.removeAttribute('data-enpoi-bottom-dock-open')
      document.documentElement.style.removeProperty('--enpoi-bottom-dock-height')
    }
  }, [visible, dock.open, height])

  // A handle gesture writes heights at pointer cadence: the column's margin
  // must follow it without easing, so the gesture marks the body for the
  // stylesheet and clears the mark when it ends.
  useEffect(() => {
    if (!dragging) {
      document.body.removeAttribute(DOCK_RESIZE_MARKER)
      return undefined
    }
    document.body.setAttribute(DOCK_RESIZE_MARKER, '')
    return () => { document.body.removeAttribute(DOCK_RESIZE_MARKER) }
  }, [dragging])

  if (!visible || sessionId === undefined) return null

  return (
    <div
      className={css.dock}
      style={{ left: box.left, width: box.width === 0 ? undefined : box.width, height }}
      data-enpoi-bottom-dock
      data-enpoi-terminal-dock
      data-enpoi-bottom-dock-open={dock.open || undefined}
      data-session={sessionId}
    >
      <div
        className={css.dockHandle}
        data-enpoi-bottom-dock-handle
        data-dragging={dragging || undefined}
        onPointerDown={(event) => {
          if (event.button !== 0) return
          event.preventDefault()
          event.currentTarget.setPointerCapture(event.pointerId)
          drag.current = { pointerId: event.pointerId, startY: event.clientY, startHeight: height, height }
          setDragging(true)
        }}
        onPointerMove={(event) => {
          const held = drag.current
          if (held === undefined || held.pointerId !== event.pointerId) return
          // Dragging the top edge up grows the dock.
          held.height = clampDockHeight(held.startHeight - (event.clientY - held.startY), window.innerHeight)
          setPreview(held.height)
        }}
        onPointerUp={(event) => {
          const held = drag.current
          if (held === undefined || held.pointerId !== event.pointerId) return
          drag.current = undefined
          setDragging(false)
          setPreview(undefined)
          setTerminalDockHeight(held.height)
        }}
        onPointerCancel={() => {
          drag.current = undefined
          setDragging(false)
          setPreview(undefined)
        }}
      />
      <div className={css.dockBar}>
        <span className={css.dockBarTitle}>
          <TerminalIcon size={14} />
          Terminals
        </span>
        <TerminalTabStrip
          sessionId={sessionId}
          place="bottom"
          tabs={tabs}
          activeId={active?.id}
          onOpen={() => { openTerminal(sessionId, 'bottom', cwd) }}
          onClose={(id) => { closeTerminal(sessionId, id) }}
          onActivate={(id) => { activateTerminal(sessionId, 'bottom', id) }}
        />
        <Tooltip label="Collapse terminal panel" side="bottom" delayMs={400}>
          <button
            type="button"
            className={css.iconButton}
            aria-label="Collapse terminal panel"
            data-enpoi-bottom-dock-collapse
            onClick={toggleTerminalDock}
          >
            <IconChevronDownOutlineRegular size={14} />
          </button>
        </Tooltip>
      </div>
      <div className={css.dockBody}>
        {active === undefined ? (
          <div className={css.empty} data-enpoi-bottom-terminal-empty>
            <p>No terminal in the bottom panel.</p>
            <button type="button" className={css.newButton} onClick={() => { openTerminal(sessionId, 'bottom', cwd) }}>
              New terminal
            </button>
          </div>
        ) : (
          <>
            <TerminalStatusBanner tab={active} />
            <TerminalView
              sessionId={sessionId}
              tab={active}
              active
              write={writeTerminal}
              resize={resizeTerminal}
              subscribe={subscribeTerminal}
              read={readTerminal}
            />
          </>
        )}
      </div>
    </div>
  )
}

/** Composed props of the header's dock toggle. */
export type BottomDockToggleProps =
  & PropsRuntime<'conversation.session.header.actions'>
  & InjectFace<TerminalInjected>

/**
 * The conversation header's terminal-panel toggle.
 * @param props - framework shares and the terminal inject face.
 * @returns the toggle button.
 */
export function BottomDockToggle({ useTerminals, toggleTerminalDock }: BottomDockToggleProps): ReactNode {
  const open = useTerminals(state => state.dock.open)
  return (
    <Tooltip label="Terminal panel" side="bottom" delayMs={500}>
      <button
        type="button"
        className={css.headerToggle}
        aria-label="Terminal panel"
        aria-pressed={open}
        data-enpoi-bottom-dock-toggle
        onClick={toggleTerminalDock}
      >
        <BottomPanelIcon size={15} />
      </button>
    </Tooltip>
  )
}
