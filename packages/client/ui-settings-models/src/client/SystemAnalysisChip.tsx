/**
 * Frame-wide bottom-right chip for the system analysis: a compact collapsible
 * bar with live progress once a run is in flight, "System analysis ready" once
 * the profile is stored, and the failure reason with a retry when the run
 * failed. A machine that needs nothing from the operator renders nothing: the
 * investigation is offered only by the setup wizard's agents step. The bar is
 * portaled out of the shell frame so it sits above the application and above
 * the first-run modal; expanding it grows the phase rail upward. Clicking the
 * ready bar opens the stored document with Accept and Reject; clicking
 * elsewhere dismisses the panel and accepts. Nothing here blocks the app.
 * @module ui-settings-models/SystemAnalysisChip
 */

import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import { clampPct, type SystemAnalysisState } from './system-analysis.ts'
import css from './SystemAnalysisChip.module.css'

/** Actions and live state delivered through the renderer-bound hooks. */
export interface SystemAnalysisChipInjected {
  actions: {
    open: () => void
    accept: () => void
    reject: () => void
    dismiss: () => void
    retry: () => void
  }
  hooks: { analysis: ObservableSnapshot<SystemAnalysisState> }
}

/** Display order of the investigation stages; index maps to `stageIndex`. */
const PHASE_KEYS = [
  'wizPhaseMachine', 'wizPhaseUsage', 'wizPhaseHosting', 'wizPhaseTooling',
  'wizPhaseRuntimes', 'wizPhaseNetworking', 'wizPhaseResources', 'wizPhaseWriting',
] as const

/** Host stage id to locale key; an unknown stage renders verbatim. */
const STAGE_KEYS: Readonly<Record<string, typeof PHASE_KEYS[number]>> = {
  'machine': 'wizPhaseMachine',
  'usage': 'wizPhaseUsage',
  'hosting': 'wizPhaseHosting',
  'tooling': 'wizPhaseTooling',
  'runtimes': 'wizPhaseRuntimes',
  'networking': 'wizPhaseNetworking',
  'resources': 'wizPhaseResources',
  'writing profile': 'wizPhaseWriting',
}

/** Static failure kind to locale key; a dynamic host reason renders verbatim. */
const ERROR_KEYS = {
  service: 'sysAnalysisErrorService',
  rejected: 'sysAnalysisErrorRejected',
  payload: 'sysAnalysisErrorPayload',
} as const

/** One phase's render state from the live job position of a run in flight. */
function phaseState(state: SystemAnalysisState, index: number): 'done' | 'active' | 'pending' {
  if (index < state.stageIndex) return 'done'
  return index === state.stageIndex ? 'active' : 'pending'
}

/**
 * Render the frame-wide system-analysis chip.
 * @param props - live analysis state, chip actions, and localized labels.
 * @returns the chip, its results panel, or nothing while hidden.
 */
export function SystemAnalysisChip({
  useAnalysis, actions, t,
}: PropsRuntime<'shell.overlay'> & PropsLocale<'settings.models'> & InjectFace<SystemAnalysisChipInjected>): ReactNode {
  const state = useAnalysis(snapshot => snapshot)
  const [expanded, setExpanded] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  // The compact bar is the resting state: a settled run (or a new one) starts
  // collapsed again.
  useEffect(() => {
    if (state.phase !== 'running') setExpanded(false)
  }, [state.phase])
  useEffect(() => {
    if (!state.open) return
    const onPointerDown = (event: PointerEvent): void => {
      if (root.current !== null && event.target instanceof Node && root.current.contains(event.target)) return
      actions.dismiss()
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => { document.removeEventListener('pointerdown', onPointerDown) }
  }, [state.open, actions])
  if (state.phase === 'hidden') return null
  const pct = clampPct(state.pct)
  const phases = PHASE_KEYS.slice(0, Math.max(0, Math.min(state.stageCount, PHASE_KEYS.length)))
  const stageKey = STAGE_KEYS[state.stage]
  // Portaled to the document body: the shell overlay layer is capped by the
  // frame's stacking context, so the chip would sit behind the first-run
  // settings modal without escaping it.
  return createPortal(
    <div className={css.root} ref={root} data-dsh-system-analysis data-phase={state.phase}>
      {state.open && (
        <section className={css.panel} role="dialog" aria-label={t('sysAnalysisTitle')} data-dsh-system-analysis-panel>
          <header className={css.panelHead}>
            <strong>{t('sysAnalysisTitle')}</strong>
            <span className={css.hint}>{t('sysAnalysisDismissHint')}</span>
          </header>
          <pre className={css.document} data-dsh-system-analysis-document>{state.text ?? ''}</pre>
          <div className={css.panelActions}>
            <Button variant="primary" disabled={state.busy} onClick={actions.accept}>{t('sysAnalysisAccept')}</Button>
            <Button disabled={state.busy} onClick={actions.reject}>{t('sysAnalysisReject')}</Button>
          </div>
        </section>
      )}
      {state.phase === 'running' && (
        <div className={css.dock} role="status" data-dsh-system-analysis-chip="running">
          {expanded && phases.length > 0 && (
            <ol className={css.phases} data-dsh-system-analysis-phases>
              {phases.map((key, index) => (
                <li key={key} data-phase={key} data-state={phaseState(state, index)}>{t(key)}</li>
              ))}
            </ol>
          )}
          <button
            type="button"
            className={css.bar}
            data-dsh-system-analysis-toggle
            data-expanded={expanded || undefined}
            aria-expanded={expanded}
            onClick={() => { setExpanded(value => !value) }}
          >
            <span className={css.spinner} aria-hidden="true" />
            <span className={css.body}>
              <strong>{t('sysAnalysisTitle')}</strong>
              <span className={css.stage} data-dsh-system-analysis-stage>{stageKey === undefined ? state.stage : t(stageKey)}</span>
            </span>
            <span className={css.pct} data-dsh-system-analysis-pct>{pct}%</span>
            <span className={css.chevron} aria-hidden="true" />
          </button>
          <div className={css.track} data-dsh-system-analysis-track>
            <div className={css.fill} data-dsh-system-analysis-fill style={{ width: `${pct}%` }} />
          </div>
        </div>
      )}
      {state.phase === 'ready' && (
        <button type="button" className={css.chip} data-dsh-system-analysis-chip="ready" onClick={actions.open}>
          <span className={css.readyDot} aria-hidden="true" />
          <span className={css.body}>
            <strong>{t('sysAnalysisReady')}</strong>
            <span className={css.stage}>{t('sysAnalysisOpenHint')}</span>
          </span>
        </button>
      )}
      {state.phase === 'failed' && (
        <div className={css.chip} role="alert" data-dsh-system-analysis-chip="failed">
          <span className={css.body}>
            <strong>{t('sysAnalysisFailed')}</strong>
            <span className={css.stage} data-dsh-system-analysis-error>
              {state.error ?? (state.errorCode === null ? '' : t(ERROR_KEYS[state.errorCode]))}
            </span>
          </span>
          <Button onClick={actions.retry}>{t('sysAnalysisRetry')}</Button>
        </div>
      )}
    </div>,
    document.body,
  )
}
