/** Paired artwork follows the page's light and dark theme selectors and loads as a deferred chunk. */
import { useEffect, useState } from 'react'
import css from './DesktopOnboarding.module.css'

/** One artwork file's module: the packaged image URL. */
export interface OnboardingArtModule {
  default: string
}

/** One locale's light and dark artwork loaders; the owning step runs them on first render. */
export interface OnboardingArtLoaders {
  light: () => Promise<OnboardingArtModule>
  dark: () => Promise<OnboardingArtModule>
}

/** @param props - deferred artwork loaders and feature-owned geometry. @returns decorative theme variants. */
export function OnboardingIllustration({ className = '', art }: { className?: string | undefined; art: OnboardingArtLoaders }) {
  const [sources, setSources] = useState<{ light: string; dark: string } | undefined>(undefined)
  useEffect(() => {
    let live = true
    void Promise.all([art.light(), art.dark()]).then(
      ([light, dark]) => { if (live) setSources({ light: light.default, dark: dark.default }) },
      // Decorative artwork: a failed chunk load leaves the step without art.
      () => { if (live) setSources(undefined) },
    )
    return () => { live = false }
  }, [art])
  return <div className={`${css.illustration} ${className}`} aria-hidden="true">
    {sources !== undefined && <>
      <img className={css.lightIllustration} src={sources.light} alt="" />
      <img className={css.darkIllustration} src={sources.dark} alt="" />
    </>}
  </div>
}
