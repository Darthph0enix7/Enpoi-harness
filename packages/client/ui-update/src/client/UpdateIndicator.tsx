/**
 * Frame-wide update surface: a small, quiet pill in the shell overlay (bottom
 * left, inside the centre column) that appears only when a newer release is
 * available, an update is executing, or a prepared update awaits its restart.
 * Behind it sits the dialog — version pair, channel, the release notes as a
 * generously sized scrollable changelog, the prepare/apply progress with its
 * switch disconnect warning, the prepared [Restart to update] action, and the
 * failure surface with the log tail and Retry. The post-restart toast rides
 * the same component.
 *
 * Nothing here polls: the controller owns the cadence and publishes through
 * the injected hook, so an ordinary session with no update renders nothing.
 * @module @deepseek-ai/dsh-client-ui-update/client/UpdateIndicator
 */

import type { ReactNode } from 'react'
import { Button, Modal, StateDot, Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { UpdateUiState } from './controller.ts'
import { NS } from './locales.ts'
import { APPLY_SWITCH_STEP, isExecutingPhase, type UpdateRunWire } from './rpc.ts'
import { formatVersion } from './version.ts'
import css from './UpdateIndicator.module.css'

/** Actions and live state delivered through the renderer-bound hooks. */
export interface UpdateIndicatorInjected {
  hooks: { update: ObservableSnapshot<UpdateUiState> }
  actions: {
    open: () => void
    close: () => void
    start: () => void
    apply: () => void
    retry: () => void
    skip: () => void
    cancel: () => void
    checkNow: () => void
    recover: () => void
    toastDone: () => void
  }
}

/** Full props for the shell-overlay indicator entry. */
export type UpdateIndicatorProps =
  PropsRuntime<'shell.overlay'>
  & PropsLocale<typeof NS>
  & InjectFace<UpdateIndicatorInjected>

/** Whole-percent bar position for a run step. */
function stepPercent(run: UpdateRunWire): number {
  if (run.steps <= 0) return 0
  return Math.max(0, Math.min(100, Math.round((run.step / run.steps) * 100)))
}

/**
 * Render the update indicator, its dialog, and the one-time toast.
 * @param props - live update state, dialog actions, and localized labels.
 * @returns the pill with its dialog, the toast, or nothing.
 */
export function UpdateIndicator({ useUpdate, actions, t }: UpdateIndicatorProps): ReactNode {
  const state = useUpdate(snapshot => snapshot)
  const status = state.status
  const latest = status?.latest
  const run = state.run
  const activeRun = run !== null && isExecutingPhase(run.phase) ? run : null
  // A prepared record only exists on the two-phase rung; a one-shot run owns
  // its own restart and must never render the restart affordance.
  const preparedRun = run !== null && run.rung === 'two-phase' && run.phase === 'prepared' ? run : null
  const failedRun = run !== null && run.result !== null && run.result !== 'success' ? run : null
  const landedRun = run !== null && run.result === 'success' ? run : null
  const executing = activeRun !== null
  const prepared = preparedRun !== null
  const available = status?.state === 'available' && latest !== undefined
  // A dismissed release is still startable: the Settings control (and this
  // dialog, when opened from it) offers Update now for a skipped version.
  const canStart = (status?.state === 'available' || status?.state === 'dismissed') && latest !== undefined
  const skipped = status?.state === 'dismissed'
  // A landed run hides the pill even if the 6 h check has not re-read the
  // status yet; a failed run keeps it, because Retry starts from here.
  const showPill = executing || prepared || (available && landedRun === null)
  const percent = activeRun === null ? 0 : stepPercent(activeRun)
  const pillMode = executing ? 'updating' : prepared ? 'prepared' : 'available'
  const pillLabel = activeRun !== null
    ? t('indicator.updatingAria', { step: activeRun.step, steps: activeRun.steps })
    : preparedRun !== null ? t('indicator.preparedAria') : t('indicator.pillAria')
  const executingLabel = activeRun === null || activeRun.phase === 'starting'
    ? t('progress.starting')
    // A one-shot update switches inside its own run (phase stays `preparing`),
    // so the switch step is the same warning point on both rungs.
    : activeRun.step >= APPLY_SWITCH_STEP && (activeRun.phase === 'applying' || activeRun.rung === 'one-shot')
      ? t('progress.switching')
      : activeRun.phase === 'applying'
        ? t('progress.applying')
        : t('progress.preparing')
  const showDisconnectWarning = activeRun !== null
    && activeRun.step >= APPLY_SWITCH_STEP
    && (activeRun.phase === 'applying' || activeRun.rung === 'one-shot')
  // Cancel mirrors the engine's refusal window: past the switch (apply from
  // its launch, a one-shot from step 8) the run cannot be interrupted safely.
  const cancelPastSwitch = activeRun !== null
    && (activeRun.phase === 'applying' || (activeRun.rung === 'one-shot' && activeRun.step >= APPLY_SWITCH_STEP))
  // A failure that kept a valid staged tree (or that names an already-running/
  // stale condition) gets the recovery affordance: clear the stale state and
  // re-apply without re-downloading.
  const staleFailure = failedRun !== null
    && (failedRun.staged || /already running|stale/i.test(failedRun.reason ?? ''))

  const footer: ReactNode = executing ? (
    <Button onClick={actions.close}>{t('action.later')}</Button>
  ) : prepared ? (
    <>
      <Button variant="primary" disabled={state.busy} onClick={actions.apply}>{t('action.restart')}</Button>
      <Button disabled={state.busy} onClick={actions.close}>{t('action.later')}</Button>
    </>
  ) : failedRun !== null ? (
    <>
      <Button variant="primary" disabled={state.busy} onClick={actions.retry}>{t('action.retry')}</Button>
      <Button disabled={state.busy} onClick={actions.close}>{t('action.close')}</Button>
    </>
  ) : (
    <>
      <Button variant="primary" disabled={state.busy || !canStart} onClick={actions.start}>{t('action.updateNow')}</Button>
      <Button disabled={state.busy} onClick={actions.close}>{t('action.later')}</Button>
      <Button disabled={state.busy} onClick={actions.skip}>{t('action.skip')}</Button>
    </>
  )

  return (
    <>
      {state.toastVersion !== null && (
        <Toast
          text={t('toast.updated', { version: formatVersion(state.toastVersion, t) })}
          tone="success"
          onDone={actions.toastDone}
        />
      )}
      {showPill && (
        <button
          type="button"
          className={css.pill}
          data-dsh-update-indicator={pillMode}
          aria-label={pillLabel}
          title={pillLabel}
          onClick={actions.open}
        >
          {pillMode === 'available' && (
            <span className={css.pillText}>{t('indicator.pill')}</span>
          )}
          {pillMode !== 'available' && (
            <>
              <StateDot state={pillMode === 'prepared' ? 'warning' : 'ongoing'} size={9} />
              <span className={css.pillText}>
                {pillMode === 'prepared' ? t('indicator.prepared') : t('indicator.updating')}
              </span>
            </>
          )}
        </button>
      )}
      <Modal
        open={state.dialogOpen}
        onClose={actions.close}
        title={t('dialog.title')}
        closeLabel={t('dialog.close')}
        className={css.dialog as string}
        footer={footer}
      >
        <div className={css.content}>
          {status !== null && (
            <div className={css.head}>
              {latest !== undefined && (
                <p className={css.versions} data-dsh-update-versions>
                  {t('dialog.versions', { current: formatVersion(status.current.version, t), latest: latest.version })}
                </p>
              )}
              <div className={css.headMeta}>
                <span className={css.channel}>{t('dialog.channel', { channel: status.current.channel })}</span>
                <button
                  type="button"
                  className={css.checkAction}
                  data-dsh-update-check
                  disabled={state.checking}
                  onClick={actions.checkNow}
                >
                  {state.checking ? t('check.checking') : t('check.action')}
                </button>
              </div>
            </div>
          )}
          {state.checkError !== null && (
            <p className={css.checkError} role="status" data-dsh-update-check-error>
              {t('check.failed', { message: state.checkError })}
            </p>
          )}
          {activeRun !== null && (
            <section className={css.section} data-dsh-update-progress={activeRun.phase}>
              <div className={css.progressHead}>
                <strong>{executingLabel}</strong>
                <span data-dsh-update-step>{t('progress.step', { step: activeRun.step, steps: activeRun.steps })}</span>
              </div>
              <div className={css.bar}>
                <div className={css.fill} data-dsh-update-fill style={{ width: `${String(percent)}%` }} />
              </div>
              <pre className={css.lastLine} data-dsh-update-lastline>
                {activeRun.lastLine !== '' ? activeRun.lastLine : t('progress.starting')}
              </pre>
              {showDisconnectWarning && (
                <p className={css.warning}>{t('progress.disconnectWarning')}</p>
              )}
              {!cancelPastSwitch && (
                <div className={css.progressActions}>
                  <Button disabled={state.busy} onClick={actions.cancel}>{t('action.cancel')}</Button>
                </div>
              )}
            </section>
          )}
          {preparedRun !== null && (
            <section className={css.section} data-dsh-update-prepared>
              <p className={css.preparedHint}>{t('progress.prepared')}</p>
            </section>
          )}
          {failedRun !== null && (
            <section className={css.section} data-dsh-update-failure={failedRun.result}>
              <p className={css.failureTitle}>
                {failedRun.result === 'rolledback'
                  ? t('result.rolledback')
                  : failedRun.result === 'cancelled' ? t('result.cancelled') : t('result.failed')}
              </p>
              {failedRun.reason !== undefined && failedRun.reason !== '' && (
                <p className={css.reason} data-dsh-update-reason>{failedRun.reason}</p>
              )}
              {failedRun.logTail.length > 0 && (
                <>
                  <p className={css.logHead}>{t('failure.log')}</p>
                  <pre className={css.log} data-dsh-update-log>{failedRun.logTail.join('\n')}</pre>
                </>
              )}
              {staleFailure && (
                <div className={css.recover} data-dsh-update-recover>
                  <p className={css.warning}>{t('failure.recoverHint')}</p>
                  <Button disabled={state.busy} onClick={actions.recover}>{t('action.recover')}</Button>
                </div>
              )}
            </section>
          )}
          {landedRun !== null && (
            <p className={css.success} data-dsh-update-success>
              {t('result.success', { version: landedRun.target })}
            </p>
          )}
          {!executing && !prepared && failedRun === null && latest !== undefined && (
            <section className={css.section}>
              <p className={css.logHead}>{t('dialog.notes')}</p>
              {latest.notes.length > 0 && (
                <ul className={css.notes} data-dsh-update-notes>
                  {latest.notes.map((note, index) => <li key={`${String(index)}:${note}`}>{note}</li>)}
                </ul>
              )}
              {latest.notes.length === 0 && <p className={css.reason}>{t('dialog.notesEmpty')}</p>}
            </section>
          )}
          {skipped && (
            <p className={css.warning} data-dsh-update-skipped-hint>{t('dialog.skippedHint')}</p>
          )}
          {state.actionError !== null && (
            <p className={css.error} role="alert">{t('error.action', { message: state.actionError })}</p>
          )}
        </div>
      </Modal>
    </>
  )
}
