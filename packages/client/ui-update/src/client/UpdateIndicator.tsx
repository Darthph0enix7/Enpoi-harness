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

// The engine's three download-progress forms, written onto its throttled
// non-TTY progress lines: the size-watch byte form, the chunk engine's
// `.progress` bar line, and the downloader's own stdout line — which becomes
// the run's last line for observed CLI runs, whose marker names install.log.
// The percentage is ASCII digits either way, so the match is
// locale-independent.
const SIZE_WATCH_PROGRESS = /(\d+(?:\.\d+)?)\s*MB\s+of\s+(\d+(?:\.\d+)?)\s*MB\s*\(\s*(\d+(?:\.\d+)?)\s*%\s*\)/i
const FAST_PATH_PROGRESS = /\[[^\]]*\]\s*(\d+(?:\.\d+)?)\s*%\s*·\s*(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)\s*MB/i
const CLI_DOWNLOAD_PROGRESS = /\[download\]\s*(\d+(?:\.\d+)?)\s*%\s*\(/i

/** Clamp a captured percentage into a whole 0-100 bar position. */
function clampPercent(raw: string | undefined): number {
  /* v8 ignore next -- a matched pattern always carries its mandatory capture group. */
  return Math.max(0, Math.min(100, Math.round(Number(raw ?? '0'))))
}

/**
 * The download percentage a progress line announces, or null when the line
 * carries neither engine form. Pure string matching: never throws.
 * @param lastLine - the run's last log line, verbatim.
 * @returns the announced percentage, or null.
 */
function downloadPercent(lastLine: string): number | null {
  const sizeWatch = SIZE_WATCH_PROGRESS.exec(lastLine)
  if (sizeWatch !== null) return clampPercent(sizeWatch[3])
  const fastPath = FAST_PATH_PROGRESS.exec(lastLine)
  if (fastPath !== null) return clampPercent(fastPath[1])
  const cli = CLI_DOWNLOAD_PROGRESS.exec(lastLine)
  if (cli !== null) return clampPercent(cli[1])
  return null
}

/** Whether the run is in its fetch/prepare steps, before the apply switch. */
function isFetchStep(run: UpdateRunWire): boolean {
  return run.phase === 'preparing' && run.step < APPLY_SWITCH_STEP
}

/**
 * Bar position: the last line's own download percentage while it carries one
 * during the fetch steps, else the step share.
 * @param run - the executing run.
 * @returns the whole-percent bar position.
 */
function barPercent(run: UpdateRunWire): number {
  if (isFetchStep(run)) {
    const parsed = downloadPercent(run.lastLine)
    if (parsed !== null) return parsed
  }
  return stepPercent(run)
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
  // A landed run suppresses the pill only while it landed the release that is
  // still the newest offer (the status read simply has not caught up). A
  // NEWER catalog version re-arms the pill even though the terminal success
  // record persists — the old unscoped guard hid the pill forever after any
  // successful update.
  const landedOffering = landedRun !== null && latest !== undefined && landedRun.target === latest.version
  const showPill = executing || prepared || (available && !landedOffering)
  const percent = activeRun === null ? 0 : barPercent(activeRun)
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
  // A failure that kept a valid staged tree (or that the host stamps
  // `recoverable`, or — on a host predating the field — whose reason names an
  // already-running/stale condition) while a release is still offered gets the
  // recovery affordance: clear the stale state and retry. Without a staged
  // tree, recovery starts a fresh prepare, which needs an offered release —
  // without one the failure is historical (status `current`) and no
  // Retry/apply/recover action may appear, because none of them leads
  // anywhere. The reason regex is a transitional fallback for the
  // update-switch window only (an old host with this client); drop it once
  // hosts always ship `recoverable`.
  const staleFailure = failedRun !== null
    && (failedRun.staged
      || (canStart && (failedRun.recoverable ?? /already running|stale/i.test(failedRun.reason ?? ''))))

  const footer: ReactNode = executing ? (
    <Button onClick={actions.close}>{t('action.later')}</Button>
  ) : prepared ? (
    <>
      <Button variant="primary" disabled={state.busy} onClick={actions.apply}>{t('action.restart')}</Button>
      <Button disabled={state.busy} onClick={actions.close}>{t('action.later')}</Button>
    </>
  ) : failedRun !== null ? (
    <>
      {failedRun.staged ? (
        // The staged tree is complete: Retry replays apply without a download.
        <Button variant="primary" disabled={state.busy} onClick={actions.retry}>{t('action.retry')}</Button>
      ) : canStart ? (
        // The staged tree is gone (a rollback archived it): a fresh prepare is
        // the only path forward, never a replay of apply against a dead tree.
        <Button variant="primary" disabled={state.busy} onClick={actions.start}>{t('action.updateNow')}</Button>
      ) : null}
      <Button {...(failedRun.staged || canStart ? {} : { variant: 'primary' as const })} disabled={state.busy} onClick={actions.close}>{t('action.close')}</Button>
    </>
  ) : canStart ? (
    <>
      <Button variant="primary" disabled={state.busy} onClick={actions.start}>{t('action.updateNow')}</Button>
      <Button disabled={state.busy} onClick={actions.close}>{t('action.later')}</Button>
      <Button disabled={state.busy} onClick={actions.skip}>{t('action.skip')}</Button>
    </>
  ) : (
    <Button variant="primary" disabled={state.busy} onClick={actions.close}>{t('action.close')}</Button>
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
                  {canStart && formatVersion(status.current.version, t) !== latest.version
                    ? t('dialog.versions', { current: formatVersion(status.current.version, t), latest: latest.version })
                    : formatVersion(status.current.version, t)}
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
