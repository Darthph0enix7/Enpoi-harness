/** Welcome page with a required explicit start. */
import type { RefObject } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { DesktopOnboardingProps } from './onboarding-contract.ts'
import { OnboardingIllustration, type OnboardingArtLoaders } from './OnboardingIllustration.tsx'
import css from './DesktopOnboarding.module.css'

// The welcome artwork is ~2.5 MB of base64 PNG; the step loads its pair from a
// package-local chunk on first render instead of the eager application combo.
const WELCOME_ART: Readonly<Record<'en' | 'zh', OnboardingArtLoaders>> = {
  en: {
    light: () => import('./assets/onboarding-welcome.png'),
    dark: () => import('./assets/onboarding-welcome-dark.png'),
  },
  zh: {
    light: () => import('./assets/onboarding-welcome-zh.png'),
    dark: () => import('./assets/onboarding-welcome-zh-dark.png'),
  },
}

/** @param props - localized content, focus target and navigation. @returns the welcome step. */
export function OnboardingWelcomeStep({ t, locale, heading, busy, onStart }: Pick<DesktopOnboardingProps, 't' | 'locale'> & {
  heading: RefObject<HTMLHeadingElement>
  busy: boolean
  onStart: () => void
}) {
  return <div className={`${css.content} ${css.welcome}`}>
    <div className={css.copy}>
      <h1 id="desktop-onboarding-title" ref={heading} tabIndex={-1}>{t('onboardingWelcome')} <em className={css.brand}>{t('onboardingBrand')}</em></h1>
      <p className={css.heroDescription}>{t('onboardingIntroduction')}</p>
      <Button variant="primary" className={`${css.action} ${css.start}`} disabled={busy} onClick={onStart}>{t('onboardingStart')}</Button>
    </div>
    <div className={css.welcomeIllustration} aria-hidden="true">
      <OnboardingIllustration className={css.welcomeArtwork} art={locale === 'zh' ? WELCOME_ART.zh : WELCOME_ART.en} />
    </div>
  </div>
}
