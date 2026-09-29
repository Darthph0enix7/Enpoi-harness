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
 * On a phone the modal becomes a full-screen page instead: a section list
 * pushes to one section detail, both under a chrome header whose control is a
 * close at the list and a back at the detail, and the shared dismissal stack
 * runs the same step. The page never covers its own close path, which is what
 * the ≤768px modal layout did. It renders through a body portal: the trigger
 * lives in the sidebar, whose mobile drawer slides on a transform, and a
 * fixed-position page inside that drawer would be trapped and clipped by it.
 */
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import clsx from 'clsx'
import {
  ConnectionIndicator, IconArchiveOutlineMedium, IconChevronLeftOutlineRegular, IconChevronRightOutlineRegular,
  IconCloseOutlineMedium, IconDataOutlineMedium,
  IconPersonalizationOutlineMedium, IconSettingsOutlineMedium, useBackHandler,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { ConnectionIndicatorState } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SettingsRootComponentProps, SettingsSectionRow } from './shell-contract.ts'
import {
  IconAgentPresetStroke16,
  IconDynamicStroke16,
  IconOrchestrationStroke16,
  IconPermissionsStroke16,
} from './nav-icons.tsx'
import css from './SettingsRoot.module.css'
import { DesktopUpdateIndicator } from './DesktopUpdateIndicator.tsx'

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

type PanelProps = {
  rows: readonly SettingsSectionRow[]
  renderSlot: SettingsRootComponentProps['renderSlot']
  activeId: string | undefined
  onSelect: (id: string) => void
  onClose: () => void
}

/**
 * The modal layer: full-viewport mask + centered panel. Close paths: the
 * header button, a mask click, and document-level Escape (mounted only while
 * open, so the listener lifetime is the panel's).
 */
function SettingsPanel({ rows, renderSlot, activeId, onSelect, onClose }: PanelProps) {
  // Entries can unmount underneath the requested id, so the render-time
  // projection falls back to the first row when the id is gone.
  const active = rows.find(r => r.id === activeId)?.id ?? rows[0]?.id
  const titleId = useId()

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => { document.removeEventListener('keydown', onKeyDown) }
  }, [onClose])

  // Entering the dialog focuses the close button; the root restores its trigger on close.
  const closeButton = useRef<HTMLButtonElement | null>(null)
  useEffect(() => { closeButton.current?.focus() }, [])

  return (
    <div className={css.overlay} role="presentation">
      <div className={css.mask} aria-hidden="true" onClick={onClose} />
      <div className={css.panel} role="dialog" aria-modal="true" aria-labelledby={titleId} data-shortcut-modal="settings">
        <nav className={css.nav}>
          <div className={css.navTitle} id={titleId}>{renderSlot('settings.header', {})}</div>
          <div className={css.navList}>
            {rows.map(row => (
              <button
                key={row.id}
                type="button"
                className={clsx(css.navCell, row.id === active && css.active)}
                aria-current={row.id === active ? 'true' : undefined}
                onClick={() => { onSelect(row.id) }}
              >
                {navIcon(row.id)}
                <span className={css.navLabel}>{row.label}</span>
              </button>
            ))}
          </div>
        </nav>
        <div className={css.content}>
          <div className={css.header}>
            <div className={css.actions}>{renderSlot('settings.action', {})}</div>
            <button ref={closeButton} type="button" className={css.close} onClick={onClose}>
              <IconCloseOutlineMedium size={14} />
              <span className={css.hiddenLabel}>{renderSlot('settings.close', {})}</span>
            </button>
          </div>
          <div className={css.options}>
            {active !== undefined && renderSlot('settings.section', { close: onClose }, { only: active })}
          </div>
        </div>
      </div>
    </div>
  )
}

type MobilePageProps = {
  rows: readonly SettingsSectionRow[]
  renderSlot: SettingsRootComponentProps['renderSlot']
  activeId: string | undefined
  onSelect: (id: string) => void
  onBack: () => void
  onClose: () => void
  t: SettingsRootComponentProps['t']
}

/**
 * The phone page: a header whose control closes at the list and returns to it
 * at the detail, then either the single-column section list or the pushed
 * section. Escape and the shared back gesture run the same step
 * (`SettingsRoot` owns the stack registration).
 */
function MobileSettingsPage({ rows, renderSlot, activeId, onSelect, onBack, onClose, t }: MobilePageProps) {
  const active = rows.find(row => row.id === activeId)
  return (
    <div className={css.mobilePage} role="dialog" aria-modal="true" aria-label={t('title')} data-shortcut-modal="settings">
      <header className={css.mobileHeader}>
        <button
          type="button"
          className={css.mobileControl}
          aria-label={active === undefined ? t('close') : t('back')}
          data-settings-mobile-control=""
          onClick={active === undefined ? onClose : onBack}
        >
          {active === undefined ? <IconCloseOutlineMedium size={16} /> : <IconChevronLeftOutlineRegular size={16} />}
        </button>
        <div className={css.mobileTitle}>{active === undefined ? renderSlot('settings.header', {}) : active.label}</div>
        <div className={css.mobileActions}>{renderSlot('settings.action', {})}</div>
      </header>
      {active === undefined
        ? (
          <div className={css.mobileList} data-settings-mobile-list="">
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
        )
        : (
          <div className={css.mobileDetail} data-settings-mobile-detail={active.id}>
            {renderSlot('settings.section', { close: onClose }, { only: active.id })}
          </div>
        )}
    </div>
  )
}

/**
 * Render the settings trigger and panel.
 * @param props - composed slot props (contract/slots.ts).
 * @returns the settings shell element tree.
 */
export function SettingsRoot(props: SettingsRootComponentProps) {
  const {
    wide, reconnect, useConnectionState, useSections, useOnboardingSteps, useOnboardingRequest, useSessions, renderSlot, t,
    useDesktopUpdate, useDevice, openDesktopUpdate, publishOpenSection, clearOnboardingRequest, useStore, actions,
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

  // The phone page steps list → detail → closed; the shared stack runs the
  // same step for the back gesture, and both land on a visible control.
  const phone = useDevice(snapshot => snapshot).device === 'phone'
  const backToList = useCallback(() => { actions.select(undefined) }, [actions])
  useBackHandler('ui-settings:mobile', () => {
    if (activeId === undefined) close()
    else backToList()
  }, phone && open)

  // The `settingsUi` service opens the panel through this live handler; the
  // published reference is cleared when this occurrence unmounts.
  useEffect(() => publishOpenSection(openSection), [publishOpenSection, openSection])

  // The ledger tick keeps the nav rows fresh: registrants re-register with
  // freshly localized text on locale change, and the trigger/header/close
  // seats re-render through their own outlets' subscriptions.
  const rows = useSections(s => s)
  const desktopUpdate = useDesktopUpdate(state => state)
  const connectionState = useConnectionState(state => state)
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
  if (connectionState === 'connecting' || holdConnecting) {
    connectionIndicator = 'connecting'
  } else if (connectionState === 'disconnected') {
    connectionIndicator = 'disconnected'
  } else if (showRecovery) {
    connectionIndicator = 'recovered'
  }

  return (
    <>
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
        />
        <DesktopUpdateIndicator wide={wide} hidden={connectionIndicator !== undefined && desktopUpdate.presentation?.phase !== 'installing'}
          t={t} view={desktopUpdate} onOpen={openDesktopUpdate} />
      </div>
      {open && (phone ? createPortal((
        <MobileSettingsPage
          rows={rows}
          renderSlot={renderSlot}
          activeId={activeId}
          onSelect={actions.select}
          onBack={backToList}
          onClose={close}
          t={t}
        />
      ), document.body) : (
        <SettingsPanel
          rows={rows}
          renderSlot={renderSlot}
          activeId={activeId}
          onSelect={actions.select}
          onClose={close}
        />
      ))}
      {/* Dialog chrome and `#root` inert ownership live inside each step's
          visible branch. A step still deciding (private facts loading)
          renders null, so nothing paints or blocks while it decides. */}
      {onboardingStep !== undefined && renderSlot('settings.onboarding', {
        stepId: onboardingStep.id,
        complete: () => { completeOnboardingStep(onboardingStep.id) },
        openSection,
      }, { only: onboardingStep.id })}
    </>
  )
}
