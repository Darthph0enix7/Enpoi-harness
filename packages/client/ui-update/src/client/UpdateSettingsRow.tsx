/**
 * General-settings update control: the durable entry point beside the current
 * version row, so a skipped release stays reachable after the shell pill
 * hides. It shares the update controller with the pill (the same published
 * store and actions — one polling source), and every action either opens the
 * shared dialog or performs the prepared restart.
 * @module @deepseek-ai/dsh-client-ui-update/client/UpdateSettingsRow
 */

import type { ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls the settings shell's SlotMap merge (the 'settings.general.item' entry).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { UpdateUiState } from './controller.ts'
import { NS } from './locales.ts'
import { isExecutingPhase } from './rpc.ts'
import css from './UpdateSettingsRow.module.css'

/** Actions and live state delivered through the renderer-bound hooks. */
export interface UpdateSettingsInjected {
  hooks: { update: ObservableSnapshot<UpdateUiState> }
  actions: {
    open: () => void
    apply: () => void
  }
}

/** Full props for the General-settings update row. */
export type UpdateSettingsRowProps =
  PropsRuntime<'settings.general.item'>
  & PropsLocale<typeof NS>
  & InjectFace<UpdateSettingsInjected>

/** One rendered state of the row. */
type RowView = 'current' | 'available' | 'skipped' | 'updating' | 'prepared' | 'failed'

/**
 * Render the General-settings update row: a quiet current-state line, or the
 * state-aware control (Update / View progress / Restart to update / Retry).
 * @param props - live update state, row actions, and localized labels.
 * @returns the row, or nothing before the first check result.
 */
export function UpdateSettingsRow({ useUpdate, actions, t }: UpdateSettingsRowProps): ReactNode {
  const state = useUpdate(snapshot => snapshot)
  const status = state.status
  const run = state.run
  const latest = status?.latest
  if (status === null) return null

  const activeRun = run !== null && isExecutingPhase(run.phase) ? run : null
  const preparedRun = run !== null && run.rung === 'two-phase' && run.phase === 'prepared' ? run : null
  const failedRun = run !== null && run.result !== null && run.result !== 'success' ? run : null

  let view: RowView
  let label: string
  let hint: string | undefined
  let action: { readonly label: string; readonly run: () => void; readonly primary: boolean } | undefined

  if (activeRun !== null) {
    view = 'updating'
    label = t('indicator.updating')
    action = { label: t('action.viewProgress'), run: actions.open, primary: false }
  } else if (preparedRun !== null) {
    view = 'prepared'
    label = t('settings.prepared')
    // The prepared row performs the restart directly (the same controller
    // action the dialog's primary button calls).
    action = { label: t('action.restart'), run: actions.apply, primary: true }
  } else if (failedRun !== null) {
    view = 'failed'
    label = t('settings.failed')
    // The dialog carries the reason, the log tail, and Retry.
    action = { label: t('action.retry'), run: actions.open, primary: false }
  } else if (status.state === 'dismissed' && latest !== undefined) {
    view = 'skipped'
    label = t('settings.newVersion', { version: latest.version })
    hint = t('settings.skipped')
    action = { label: t('action.updateNow'), run: actions.open, primary: true }
  } else if (status.state === 'available' && latest !== undefined) {
    view = 'available'
    label = t('settings.newVersion', { version: latest.version })
    action = { label: t('action.updateNow'), run: actions.open, primary: true }
  } else if (status.state === 'current') {
    view = 'current'
    label = t('settings.upToDate')
  } else {
    // `unknown` (never checked / offline): the row stays out of the way.
    return null
  }

  return (
    <div className={css.row} data-dsh-update-settings={view}>
      <span className={css.text}>
        <span className={css.label}>{label}</span>
        {hint !== undefined && <span className={css.hint}>{hint}</span>}
      </span>
      {action !== undefined && (
        <Button
          {...(action.primary ? { variant: 'primary' as const } : {})}
          disabled={state.busy}
          onClick={action.run}
        >
          {action.label}
        </Button>
      )}
    </div>
  )
}
