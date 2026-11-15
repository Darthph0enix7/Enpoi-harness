/**
 * Settings shell root: the sidebar-foot trigger row plus the centered modal
 * panel (figma 501:29947, 1080x700) with the section nav rail. The shell is
 * a pure composition face — slot-owned text (trigger label, panel title,
 * close label, sections) arrives from registrants through slots; accessible
 * names resolve from localized content (trigger: shell locale; dialog:
 * aria-labelledby the title node; close: visually-hidden slot text). Modal
 * open state and the active section id are component-local viewing state;
 * the onboarding coordinator mounts exactly one ordered registrant while the
 * sessions-derived empty-Hero fact or an explicit reopen request is active.
 * Visible dialog chrome belongs
 * to the step, so a mounted-but-deciding step paints nothing here.
 *
 * One body-portalled surface serves both modes: desktop chrome is the centered
 * panel and nav rail; compact chrome is a full-screen list -> detail page whose
 * control is close at the list and back at the detail. Only chrome/classes
 * toggle, so the dialog, content host, and mounted section survive a live
 * 1440 <-> 800 <-> 390 resize without losing draft, selection, or scroll. The
 * body portal also keeps both modes out of the transformed sidebar drawer.
 */
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import clsx from 'clsx'
import {
  ConnectionIndicator, IconArchiveOutlineMedium, IconChevronLeftOutlineRegular, IconChevronRightOutlineRegular,
  IconCloseOutlineMedium, IconDataOutlineMedium,
  IconPersonalizationOutlineMedium, IconSettingsOutlineMedium, useBackHandler, useLayoutMode, useModalLayer,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { ConnectionIndicatorState } from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  SettingsRootComponentProps, SettingsSectionRow, SettingsSurfaceComponentProps, SettingsTriggerComponentProps,
} from './shell-contract.ts'
import {
  IconAgentPresetStroke16,
  IconDynamicStroke16,
  IconOrchestrationStroke16,
  IconPermissionsStroke16,
} from './nav-icons.tsx'
import css from './SettingsRoot.module.css'
import { DesktopUpdateIndicator } from './DesktopUpdateIndicator.tsx'
import { sanitizeConnectionDiagnosis } from './connection-status.ts'

const RECOVERY_CONFIRMATION_MS = 2_000

/** Minimum visible time for the connecting pill; shorter attempts read as flicker. */
const CONNECTING_MIN_VISIBLE_MS = 800

/** Nav glyph by section id; unknown ids fall back to the settings gear. */
function navIcon(id: string) {
  if (id === 'models') return <IconDataOutlineMedium className={css.navIcon} size={16} />
  if (id === 'agent-presets') return <IconAgentPresetStroke16 className={css.navIcon} size={16} />
  if (id === 'orchestration') return <IconOrchestrationStroke16 className={css.navIcon} size={16} />
  if (id === 'permissions') return <IconPermissionsStroke16 className={css.navIcon} size={16} />
  if (id === 'dynamic') return <IconDynamicStroke16 className={css.navIcon} size={16} />
  if (id === 'plugins') return <IconPersonalizationOutlineMedium className={css.navIcon} size={16} />
  if (id === 'archived-sessions') return <IconArchiveOutlineMedium className={css.navIcon} size={16} />
  return <IconSettingsOutlineMedium className={css.navIcon} size={16} />
}

type SettingsSurfaceProps = {
  rows: readonly SettingsSectionRow[]
  renderSlot: SettingsRootComponentProps['renderSlot']
  activeId: string | undefined
  compact: boolean
  onSelect: (id: string) => void
  onBack: () => void
  onClose: () => void
  t: SettingsRootComponentProps['t']
}

/**
 * The one body-portalled settings surface. Desktop and compact are the same
 * component tree: only chrome/class names toggle. The section host keeps its
 * position and component identity across a live resize, so a mounted section's
 * draft, selection, and scroll survive 1440 <-> 800 <-> 390. List -> detail and
 * back focus the visible Back control / originating row for keyboard and
 * screen-reader users.
 */
function SettingsSurface({
  rows, renderSlot, activeId, compact, onSelect, onBack, onClose, t,
}: SettingsSurfaceProps) {
  // Desktop falls back to the first row if the requested section vanished;
  // compact uses the store's exact id so undefined stays the list step.
  const desktopActiveId = rows.find(row => row.id === activeId)?.id ?? rows[0]?.id
  const active = compact
    ? rows.find(row => row.id === activeId)
    : rows.find(row => row.id === desktopActiveId)
  const activeSectionId = active?.id
  const titleId = useId()
  const dialog = useRef<HTMLDivElement | null>(null)
  const mobileControl = useRef<HTMLButtonElement | null>(null)
  const previous = useRef({ compact, active: activeSectionId })
  useModalLayer(dialog, true, compact && active !== undefined ? onBack : onClose)

  useLayoutEffect(() => {
    const last = previous.current
    previous.current = { compact, active: activeSectionId }
    if (!compact || !last.compact || last.active === activeSectionId) return
    if (activeSectionId !== undefined) {
      mobileControl.current?.focus()
      return
    }
    if (last.active !== undefined && dialog.current !== null) {
      const rows = [...dialog.current.querySelectorAll<HTMLElement>('[data-settings-mobile-row]')]
      const row = rows.find(candidate => candidate.dataset.settingsMobileRow === last.active)
      ;(row ?? mobileControl.current)?.focus()
    }
  }, [activeSectionId, compact])

  return (
    <div
      className={compact ? css.mobilePage : css.overlay}
      data-settings-compact={compact ? '' : undefined}
      role="presentation"
    >
      {!compact && <div key="mask" className={css.mask} aria-hidden="true" onClick={onClose} />}
      <div
        key="dialog"
        ref={dialog}
        tabIndex={-1}
        className={compact ? css.mobilePagePanel : css.panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-shortcut-modal="settings"
        data-settings-surface=""
      >
        <div className={css.chromeHost}>
          {compact ? (
            <header className={css.mobileHeader}>
              <button
                ref={mobileControl}
                type="button"
                className={css.mobileControl}
                aria-label={active === undefined ? t('close') : t('back')}
                data-settings-mobile-control=""
                data-modal-autofocus
                onClick={active === undefined ? onClose : onBack}
              >
                {active === undefined ? <IconCloseOutlineMedium size={16} /> : <IconChevronLeftOutlineRegular size={16} />}
              </button>
              <div className={css.mobileTitle} id={titleId}>
                {active === undefined ? renderSlot('settings.header', {}) : active.label}
              </div>
              <div className={css.mobileActions}>{renderSlot('settings.action', {})}</div>
            </header>
          ) : (
            <nav className={css.nav}>
              <div className={css.navTitle} id={titleId}>{renderSlot('settings.header', {})}</div>
              <div className={css.navList}>
                {rows.map(row => (
                  <button
                    key={row.id}
                    type="button"
                    className={clsx(css.navCell, row.id === activeSectionId && css.active)}
                    aria-current={row.id === activeSectionId ? 'true' : undefined}
                    onClick={() => { onSelect(row.id) }}
                  >
                    {navIcon(row.id)}
                    <span className={css.navLabel}>{row.label}</span>
                  </button>
                ))}
              </div>
            </nav>
          )}
        </div>
        <div className={compact ? css.mobileBody : css.content}>
          {!compact && (
            <div key="desktop-header" className={css.header}>
              <div className={css.actions}>{renderSlot('settings.action', {})}</div>
              <button type="button" className={css.close} data-modal-autofocus onClick={onClose}>
                <IconCloseOutlineMedium size={14} />
                <span className={css.hiddenLabel}>{renderSlot('settings.close', {})}</span>
              </button>
            </div>
          )}
          {compact && active === undefined && (
            <div key="mobile-list" className={css.mobileList} data-settings-mobile-list="" data-settings-scroll="">
              {rows.map(row => (
                <button
                  key={row.id}
                  type="button"
                  className={css.mobileRow}
                  data-settings-mobile-row={row.id}
                  onClick={() => { onSelect(row.id) }}
                >
                  {navIcon(row.id)}
                  <span className={css.mobileRowLabel}>{row.label}</span>
                  <IconChevronRightOutlineRegular size={14} />
                </button>
              ))}
            </div>
          )}
          <div
            key="section-content"
            className={compact ? css.mobileDetail : css.options}
            data-settings-mobile-detail={compact && active !== undefined ? active.id : undefined}
            data-settings-content=""
            data-settings-scroll={!compact || active !== undefined ? '' : undefined}
            hidden={compact && active === undefined}
          >
            {active !== undefined && renderSlot('settings.section', { close: onClose }, { only: active.id })}
          </div>
        </div>
      </div>
    </div>
  )
}

/**
 * Shell placement. The sidebar slot renders the trigger row only; the stable
 * root slot renders the panel and onboarding. The bare component renders both
 * (the isolated shell test and embedded consumers).
 */
export type SettingsRootPlacement = {
  /** Sidebar trigger row only; no dialog or onboarding. */
  readonly triggerOnly?: boolean
  /** Stable root surface only; no sidebar trigger row. */
  readonly surfaceOnly?: boolean
}

/**
 * Render the settings trigger and/or panel.
 * @param props - composed slot props (contract/slots.ts) plus the placement flags.
 * @returns the settings shell element tree.
 */
export function SettingsRoot(props: SettingsRootComponentProps & SettingsRootPlacement) {
  const {
    wide, reconnect, useConnectionState, useConnectionDiagnosis, useSections, useOnboardingSteps,
    useOnboardingRequest, useSessions, renderSlot, t,
    useDesktopUpdate, openDesktopUpdate, publishOpenSection, clearOnboardingRequest, useStore, actions,
    triggerOnly = false, surfaceOnly = false,
  } = props
  const { open, activeId } = useStore(state => state)
  const { close, openSection } = actions
  const [completedOnboarding, setCompletedOnboarding] = useState<ReadonlySet<string>>(() => new Set())
  const [showRecovery, setShowRecovery] = useState(false)
  const [holdConnecting, setHoldConnecting] = useState(false)
  const connectingShownAt = useRef<number | undefined>(undefined)
  const triggerButton = useRef<HTMLButtonElement | null>(null)
  const wasOpen = useRef(open)
  // Restore after the close commit, when the dialog can no longer own focus.
  useEffect(() => {
    if (wasOpen.current && !open) triggerButton.current?.focus()
    wasOpen.current = open
  }, [open])

  // The compact page steps list → detail → closed; the shared stack runs the
  // same step for the back gesture, and both land on a visible control.
  const compact = useLayoutMode() === 'compact'
  const backToList = useCallback(() => { actions.select(undefined) }, [actions])
  useBackHandler('ui-settings:compact', () => {
    if (activeId === undefined) close()
    else backToList()
  }, !triggerOnly && compact && open)

  // The `settingsUi` service opens the panel through this live handler; one
  // stable root surface owns it, not the sidebar trigger occurrence.
  useEffect(() => {
    if (triggerOnly) return undefined
    return publishOpenSection(openSection)
  }, [publishOpenSection, openSection, triggerOnly])

  // The ledger tick keeps the nav rows fresh: registrants re-register with
  // freshly localized text on locale change, and the trigger/header/close
  // seats re-render through their own outlets' subscriptions.
  const rows = useSections(s => s)
  const desktopUpdate = useDesktopUpdate(state => state)
  const connectionState = useConnectionState(state => state)
  const connectionDiagnosis = sanitizeConnectionDiagnosis(useConnectionDiagnosis(state => state))
  const previousConnectionState = useRef(connectionState)
  const onboardingSteps = useOnboardingSteps(s => s)
  const onboardingRequested = useOnboardingRequest(snapshot => snapshot.requested)
  const onboardingActive = useSessions((state) => {
    const main = Object.values(state.byId)
      .find(session => (session.retainedBy.mainView ?? 0) > 0)
    return state.phase === 'ready' && (main === undefined || main.blank)
  }) || onboardingRequested
  const onboardingStep = onboardingActive
    ? (onboardingRequested
      // An explicit request always starts the chain at its first step: the
      // process-local completed set records earlier mounts, not the flow the
      // operator just asked for.
      ? onboardingSteps[0]
      : onboardingSteps.find(step => !completedOnboarding.has(step.id)))
    : undefined

  useEffect(() => {
    if (onboardingActive) return
    setCompletedOnboarding(new Set())
  }, [onboardingActive])

  // An explicit request takes over the screen; the settings modal yields so
  // the wizard (which sits below the shared modal layer) is visible and
  // clickable. Guarded on the rising edge: a request that never clears cannot
  // keep the panel shut.
  const previousOnboardingRequest = useRef(false)
  useEffect(() => {
    if (onboardingRequested && !previousOnboardingRequest.current) close()
    previousOnboardingRequest.current = onboardingRequested
  }, [onboardingRequested, close])

  useLayoutEffect(() => {
    const previous = previousConnectionState.current
    previousConnectionState.current = connectionState
    if (connectionState !== 'connected') {
      setShowRecovery(false)
      return
    }
    if (previous !== 'disconnected' && previous !== 'connecting') return
    setShowRecovery(true)
  }, [connectionState])

  // The confirmation window starts when the recovered pill becomes visible,
  // which the connecting minimum-visible hold can delay past the transition.
  useLayoutEffect(() => {
    if (!showRecovery || holdConnecting) return
    const timeout = window.setTimeout(() => { setShowRecovery(false) }, RECOVERY_CONFIRMATION_MS)
    return () => { window.clearTimeout(timeout) }
  }, [showRecovery, holdConnecting])

  useLayoutEffect(() => {
    if (connectionState === 'connecting') {
      connectingShownAt.current = Date.now()
      return
    }
    const shownAt = connectingShownAt.current
    if (shownAt === undefined) return
    connectingShownAt.current = undefined
    const remaining = CONNECTING_MIN_VISIBLE_MS - (Date.now() - shownAt)
    if (remaining <= 0) return
    setHoldConnecting(true)
    const timeout = window.setTimeout(() => { setHoldConnecting(false) }, remaining)
    return () => {
      window.clearTimeout(timeout)
      setHoldConnecting(false)
    }
  }, [connectionState])

  const completeOnboardingStep = useCallback((id: string) => {
    setCompletedOnboarding((previous) => {
      if (previous.has(id)) return previous
      return new Set([...previous, id])
    })
    if (onboardingRequested) clearOnboardingRequest()
  }, [onboardingRequested, clearOnboardingRequest])

  let connectionIndicator: ConnectionIndicatorState | undefined
  if (connectionState === 'disconnected' && connectionDiagnosis !== undefined) {
    // A terminal diagnosis wins over a residual connecting minimum-visible
    // hold: there is no active attempt to describe as reconnecting.
    connectionIndicator = 'disconnected'
  } else if (connectionState === 'connecting' || holdConnecting) {
    connectionIndicator = 'connecting'
  } else if (connectionState === 'disconnected') {
    connectionIndicator = 'disconnected'
  } else if (showRecovery) {
    connectionIndicator = 'recovered'
  }

  return (
    <>
      {!surfaceOnly && (
        <div className={clsx(css.triggerRow, !wide && css.railRow)}>
          <button
            ref={triggerButton}
            type="button"
            className={clsx(css.trigger, !wide && css.rail)}
            aria-label={t('trigger')}
            aria-haspopup="dialog"
            aria-expanded={open}
            data-dsh-tour="settings"
            onClick={() => { actions.open() }}
          >
            {renderSlot('settings.trigger', { wide })}
          </button>
          <ConnectionIndicator
            state={wide && desktopUpdate.presentation?.phase !== 'installing' ? connectionIndicator : undefined}
            disconnectedLabel={t('connection.error')}
            connectingLabel={t('connection.connecting')}
            recoveredLabel={t('connection.connected')}
            reconnectActionLabel={t('connection.reconnect')}
            restartActionLabel={t('connection.restart')}
            onReconnect={reconnect}
            diagnosis={connectionDiagnosis === undefined ? undefined : {
              text: connectionDiagnosis,
              stoppedLabel: t('connection.stopped'),
              detailsLabel: t('connection.details'),
              reloadInstruction: t('connection.reloadInstruction'),
              reloadLabel: t('connection.reload'),
              onReload: () => { window.location.reload() },
            }}
          />
          <DesktopUpdateIndicator wide={wide} hidden={connectionIndicator !== undefined && desktopUpdate.presentation?.phase !== 'installing'}
            t={t} view={desktopUpdate} onOpen={openDesktopUpdate} />
        </div>
      )}
      {!triggerOnly && open && createPortal((
        <SettingsSurface
          rows={rows}
          renderSlot={renderSlot}
          activeId={activeId}
          compact={compact}
          onSelect={actions.select}
          onBack={backToList}
          onClose={close}
          t={t}
        />
      ), document.body)}
      {/* Dialog chrome and `#root` inert ownership live inside each step's
          visible branch. A step still deciding (private facts loading)
          renders null, so nothing paints or blocks while it decides. */}
      {!triggerOnly && onboardingStep !== undefined && renderSlot('settings.onboarding', {
        stepId: onboardingStep.id,
        complete: () => { completeOnboardingStep(onboardingStep.id) },
        openSection,
      }, { only: onboardingStep.id })}
    </>
  )
}


/**
 * Sidebar seat adapter: the trigger row only. It uses the shared shell store
 * from the slot declaration, so open/close state is the same as the root
 * surface's.
 * @param props - sidebar slot props.
 * @returns the trigger row.
 */
export function SettingsTriggerSlot(props: SettingsTriggerComponentProps) {
  return <SettingsRoot {...(props as unknown as SettingsRootComponentProps)} triggerOnly />
}

/**
 * Stable root surface adapter. AppFrame renders this once outside the compact
 * chrome/sidebar swap; the dialog and mounted section therefore keep identity
 * across layout-mode changes.
 * @param props - settings.surface slot props (no sidebar-wide flag).
 * @returns the portalled settings surface and onboarding coordinator.
 */
export function SettingsSurfaceSlot(props: SettingsSurfaceComponentProps) {
  return <SettingsRoot {...(props as unknown as SettingsRootComponentProps)} wide={false} surfaceOnly />
}
