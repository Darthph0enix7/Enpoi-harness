/**
 * General Settings row that reopens the first-run welcome flow after it was
 * completed. It drives the shared wizard store's reopen action, so the wizard
 * and this entry act on one handle.
 */

import type { ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import css from './SetupRow.module.css'

/** Registration-side dependencies of {@link SetupRow}. */
export interface SetupRowInjected {
  /** Reopen the first-run wizard through the settings shell's onboarding request. */
  reopen(): void
}

/** General-item owner props plus this row's injected face and feature copy. */
export type SetupRowProps =
  PropsRuntime<'settings.general.item'> & PropsLocale<'settings.models'> & InjectFace<SetupRowInjected>

/**
 * Render the setup row: the label, its description, and the re-run action.
 * @param props - settings-shell owner state, localized copy, and the wizard action.
 * @returns the General Settings row.
 */
export function SetupRow({ reopen, t }: SetupRowProps): ReactNode {
  return (
    <div className={css.row}>
      <div>
        <div className={css.title}>{t('wizSetupNav')}</div>
        <div className={css.description}>{t('wizSetupIntro')}</div>
      </div>
      <Button variant="primary" onClick={() => { reopen() }}>{t('wizSetupRun')}</Button>
    </div>
  )
}
