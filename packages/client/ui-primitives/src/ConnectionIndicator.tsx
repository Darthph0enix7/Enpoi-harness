import { useEffect, useState } from 'react'
import {
  IconCheckOutlineRegular,
  IconRefreshOutlineRegular,
  IconWarningTriangleOutlineRegular,
} from './icons/index.tsx'
import { StateDot } from './StateDot.tsx'
import css from './ConnectionIndicator.module.css'

/** Visual state rendered by {@link ConnectionIndicator}. */
export type ConnectionIndicatorState =
  | 'disconnected'
  | 'connecting'
  | 'recovered'

/** Exit-transition length; keep equal to the `.leaving` transition duration in the stylesheet. */
const EXIT_MS = 150

/** Owner-supplied terminal presentation when Connection reports a diagnosis. */
export interface ConnectionTerminalPresentation {
  /** Bounded, sanitized detail from the Connection diagnosis. */
  readonly text: string
  /** Concise stopped-state label, e.g. Connection stopped. */
  readonly stoppedLabel: string
  /** Accessible name of the single warning-details control. */
  readonly detailsLabel: string
  /** Localized instruction to reload from a clean state. */
  readonly reloadInstruction: string
  /** Localized explicit manual reload action. */
  readonly reloadLabel: string
  /** User-intent reload; this primitive never reloads on its own. */
  readonly onReload: () => void
}

/**
 * Render an inline connection-recovery control. The outage and retry-attempt
 * states are one button whose static label already names the retry action;
 * clicking it requests an immediate reconnect. The indicator animates in on
 * appearance and fades out for {@link EXIT_MS} before unmounting.
 * @param props.state - visible outage, retry-attempt, or recovered state.
 * @param props.disconnectedLabel - localized outage text naming the retry action.
 * @param props.connectingLabel - localized retry text followed by the attempt dots.
 * @param props.recoveredLabel - localized recovery confirmation.
 * @param props.reconnectActionLabel - accessible label for the outage action.
 * @param props.restartActionLabel - accessible label for replacing an active attempt.
 * @param props.onReconnect - request an immediate reconnect attempt.
 * @param props.diagnosis - optional terminal presentation; when present on
 * `disconnected`, the pill reads Connection stopped and exposes details.
 * @returns the indicator, or null when no connection feedback is active.
 */
export function ConnectionIndicator({
  state,
  disconnectedLabel,
  connectingLabel,
  recoveredLabel,
  reconnectActionLabel,
  restartActionLabel,
  onReconnect,
  diagnosis,
}: {
  state: ConnectionIndicatorState | undefined
  disconnectedLabel: string
  connectingLabel: string
  recoveredLabel: string
  reconnectActionLabel: string
  restartActionLabel: string
  onReconnect: () => void
  diagnosis?: ConnectionTerminalPresentation | undefined
}) {
  const [rendered, setRendered] = useState(state)
  const leaving = state === undefined && rendered !== undefined
  useEffect(() => {
    if (state !== undefined) {
      setRendered(state)
      return
    }
    if (rendered === undefined) return
    const timeout = window.setTimeout(() => { setRendered(undefined) }, EXIT_MS)
    return () => { window.clearTimeout(timeout) }
  }, [state, rendered])

  if (rendered === undefined) return null
  const leavingClass = leaving ? ` ${css.leaving}` : ''
  if (rendered === 'recovered') {
    return (
      <div
        className={`${css.indicator} ${css.success}${leavingClass}`}
        role="status"
        aria-label={recoveredLabel}
      >
        <span className={css.icon} aria-hidden="true"><IconCheckOutlineRegular size={14} /></span>
        <span className={css.label}>{recoveredLabel}</span>
      </div>
    )
  }

  if (rendered === 'disconnected' && diagnosis !== undefined) {
    return (
      <div className={`${css.stopped}${leavingClass}`} data-phase="stopped">
        <button
          type="button"
          className={css.stoppedAction}
          aria-label={reconnectActionLabel}
          onClick={onReconnect}
        >
          <span className={css.icon} aria-hidden="true"><IconRefreshOutlineRegular size={14} /></span>
          <span className={css.label}>{diagnosis.stoppedLabel}</span>
        </button>
        <details className={css.details}>
          <summary className={css.detailsSummary} aria-label={diagnosis.detailsLabel}>
            <IconWarningTriangleOutlineRegular size={14} />
          </summary>
          <div className={css.detailsPanel} role="note" aria-label={diagnosis.detailsLabel}>
            <p className={css.detailsText}>{diagnosis.text}</p>
            <p className={css.detailsInstruction}>{diagnosis.reloadInstruction}</p>
            <button type="button" className={css.reloadAction} onClick={diagnosis.onReload}>
              {diagnosis.reloadLabel}
            </button>
          </div>
        </details>
      </div>
    )
  }

  const connecting = rendered === 'connecting'
  return (
    <button
      type="button"
      className={`${css.indicator} ${css.warning}${leavingClass}`}
      data-phase={rendered}
      aria-label={connecting ? restartActionLabel : reconnectActionLabel}
      onClick={onReconnect}
    >
      <span className={css.icon} aria-hidden="true">
        {connecting
          ? <StateDot state="ongoing" />
          : <IconRefreshOutlineRegular size={14} />}
      </span>
      <span className={css.label}>
        {connecting
          ? (
            <>
              {connectingLabel}
              <span className={css.dots} aria-hidden="true">
                <span>.</span>
                <span className={css.secondDot}>.</span>
                <span className={css.thirdDot}>.</span>
              </span>
            </>
          )
          : disconnectedLabel}
      </span>
    </button>
  )
}
