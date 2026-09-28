/**
 * Setup settings section: the entry that reopens the first-run welcome flow
 * after it was completed. It renders the shared wizard store's reopen action,
 * so both surfaces drive one handle.
 */

import type { ReactNode } from 'react'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { WelcomeWizardState, WelcomeWizardStore } from './welcome-wizard.ts'
import type { en } from './locales.ts'
import styles from './ModelsSection.module.css'

/** Registration-side dependencies of {@link SetupSection}. */
export interface SetupSectionInjected {
  hooks: {
    /** Wizard completion and reopen state. */
    wizard: SnapshotStore<WelcomeWizardState>
  }
  /** Wizard controller carrying the reopen action. */
  store: WelcomeWizardStore
  /** Feature copy. */
  t: (key: keyof typeof en) => string
}

/** Section owner props plus this section's injected face. */
export type SetupSectionProps = PropsRuntime<'settings.section'> & InjectFace<SetupSectionInjected>

/**
 * Render the Setup row content: a short description and the re-run action.
 * @param props - settings-shell owner state and wizard dependencies.
 * @returns the Setup section body.
 */
export function SetupSection(props: SetupSectionProps): ReactNode {
  const { useWizard, store, t } = props
  const state = useWizard(snapshot => snapshot)
  return (
    <div className={styles.section}>
      <h2>{t('wizSetupTitle')}</h2>
      <p>{t('wizSetupIntro')}</p>
      <p>{state.completed ? t('wizSetupCompleted') : t('wizSetupNotCompleted')}</p>
      <Button variant="primary" onClick={() => { store.reopen() }}>{t('wizSetupRun')}</Button>
    </div>
  )
}
