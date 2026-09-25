/** Credit introduction retains the action ordering selected on first entry. */
import type { RefObject } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { DesktopOnboardingProps } from './onboarding-contract.ts'
import { OnboardingIllustration, type OnboardingArtLoaders } from './OnboardingIllustration.tsx'
import css from './DesktopOnboarding.module.css'

// The credit artwork is ~1.5 MB of base64 PNG; the step loads its pair from a
// package-local chunk on first render instead of the eager application combo.
const CREDIT_ART: Readonly<Record<'en' | 'zh', OnboardingArtLoaders>> = {
  en: {
    light: () => import('./assets/onboarding-recharge.png'),
    dark: () => import('./assets/onboarding-recharge-dark.png'),
  },
  zh: {
    light: () => import('./assets/onboarding-recharge-zh.png'),
    dark: () => import('./assets/onboarding-recharge-zh-dark.png'),
  },
}

/** @param props - credit facts, localized content and recharge/navigation actions. @returns the credit step. */
export function OnboardingCreditStep({ t, locale, heading, busy, funded, canRecharge, onContinue, onRecharge, onLater }:
  Pick<DesktopOnboardingProps, 't' | 'locale'> & {
    heading: RefObject<HTMLHeadingElement>
    busy: boolean
    funded: boolean
    canRecharge: boolean
    onContinue: () => void
    onRecharge: () => void
    onLater: () => void
  }) {
  return <div className={`${css.content} ${css.credit}`}>
    <OnboardingIllustration className={css.creditIllustration} art={locale === 'zh' ? CREDIT_ART.zh : CREDIT_ART.en} />
    <div className={css.copy}>
      <h1 id="desktop-onboarding-title" ref={heading} tabIndex={-1}>{t('onboardingCredit')}</h1>
      <p className={css.heroDescription}>{t('onboardingCreditDescription')}</p>
      <div className={css.creditActions}>
        <Button className={css.action} variant="primary" disabled={busy || (!funded && !canRecharge)} onClick={funded ? onContinue : onRecharge}>{t(funded ? 'onboardingContinue' : 'onboardingTopUp')}</Button>
        <Button variant="outline" className={`${css.action} ${css.laterAction}`} disabled={busy || (funded && !canRecharge)} onClick={funded ? onRecharge : onLater}>{t(funded ? 'onboardingFundedTopUp' : 'onboardingLater')}</Button>
      </div>
    </div>
  </div>
}
