/**
 * The heavy-provider documentation view: everything an operator needs before
 * adding or removing one — what the service is, its protocol/auth mode, the
 * reuse-vs-local comparison with disk/dependency hints, the platform-resolved
 * install steps, dashboard/docs links, quirks (with "requires a browser"
 * badges), and the exact install/remove surface.
 *
 * The install platform defaults to the host's (`enpoiHeavy.status.platform`)
 * and is switchable so an operator can read the macOS/Windows path of a
 * Linux-hosted install. Renders pure manifest data; no network.
 *
 * @module ui-settings-models/HeavyProviderDocs
 */

import { useState } from 'react'
import type { ReactNode } from 'react'
import {
  HEAVY_PLATFORMS,
  resolveHeavyInstall,
  type HeavyPlatform,
  type HeavyPlatformInstall,
  type HeavyProviderManifest,
} from './heavy-providers.ts'
import { HeavyDashboardLinks } from './HeavyProviderStatus.tsx'
import type { en } from './locales.ts'
import styles from './ModelsSection.module.css'

export interface HeavyProviderDocsProps {
  manifest: HeavyProviderManifest
  /** Host platform installs execute on; '' selects the default fallback. */
  platform?: string | undefined
  t: (key: keyof typeof en) => string
}

/** The exact variant declared for a platform, when one is. */
function variantFor(manifest: HeavyProviderManifest, platform: string): HeavyPlatformInstall | undefined {
  return platform === 'linux' || platform === 'darwin' || platform === 'win32'
    ? manifest.local.install[platform]
    : undefined
}

/** The heavy-provider documentation view. */
export function HeavyProviderDocs({ manifest, platform, t }: HeavyProviderDocsProps): ReactNode {
  const [selected, setSelected] = useState<HeavyPlatform | null>(null)
  const activePlatform: string = selected ?? platform ?? ''
  const resolved = resolveHeavyInstall(manifest.local, activePlatform)
  const exact = variantFor(manifest, activePlatform)
  const authText = manifest.auth.kind === 'none'
    ? t('heavyAuthNone')
    : manifest.auth.kind === 'unified'
      ? t('heavyAuthUnified')
      : t('heavyAuthPlaceholder').replace('{ref}', manifest.auth.apiKeyEnv ?? '')
  const platformName = (value: HeavyPlatform): string =>
    value === 'linux' ? t('heavyPlatformLinux') : value === 'darwin' ? t('heavyPlatformMacos') : t('heavyPlatformWindows')

  return (
    <section className={styles['heavyDocs']}>
      <div className={styles['heavyDocsHead']}>
        <h4 className={styles['heavyDocsTitle']}>{manifest.label} · {t('heavyDocumentation')}</h4>
        <span className={styles['protocolTag']}>{manifest.protocol}</span>
        <span className={styles['routeSlugBadge']}>{manifest.id}</span>
      </div>
      <p className={styles['heavySummary']}>{manifest.summary}</p>
      <div className={styles['heavyMetaRow']}>
        <HeavyDashboardLinks providerId={manifest.id} t={t} />
        {manifest.docsUrl !== undefined && (
          <a className={styles['presetMetaItem']} href={manifest.docsUrl} target="_blank" rel="noreferrer">
            {t('heavyDocs')}: {manifest.docsUrl} ↗
          </a>
        )}
      </div>

      <div className={styles['heavySectionLabel']}>{t('heavyAuthTitle')}</div>
      <p className={styles['heavyModeNote']}>{authText}</p>
      {manifest.requiresBrowser.length > 0 && (
        <div className={styles['heavyBadges']}>
          {manifest.requiresBrowser.map(line => (
            <span key={line} className={styles['heavyBrowserBadge']} title={line}>
              {t('heavyBrowserBadge')}
            </span>
          ))}
        </div>
      )}

      <div className={styles['heavySectionLabel']}>{t('heavyReuseVsLocal')}</div>
      <div className={styles['heavyCompare']}>
        <div className={styles['heavyCompareCol']}>
          <strong>{manifest.reuse.label}</strong>
          <span className={styles['heavyModeNote']}>{manifest.reuse.note}</span>
          <code className={styles['heavyCode']}>{manifest.reuse.baseURL}</code>
          <span className={styles['heavyModeNote']}>{t('heavyHealthUrl')}: {manifest.reuse.health.url}</span>
          <span className={styles['heavyModeNote']}>{t('heavyNoLocalFootprint')}</span>
        </div>
        <div className={styles['heavyCompareCol']}>
          <strong>{resolved.label}</strong>
          <span className={styles['heavyModeNote']}>{t('heavyDeps')}: {resolved.deps.length === 0 ? t('heavyNone') : resolved.deps.join(', ')}</span>
          <span className={styles['heavyModeNote']}>{t('heavyDisk')}: {resolved.diskHint === '' ? t('heavyNone') : resolved.diskHint}</span>
          <code className={styles['heavyCode']}>{manifest.local.baseURL}</code>
          <span className={styles['heavyModeNote']}>{t('heavyHealthUrl')}: {manifest.local.health.url}</span>
        </div>
      </div>

      <div className={styles['heavySectionLabel']}>{t('heavyPlatform')}</div>
      <div className={styles['heavyPlatformRow']}>
        {HEAVY_PLATFORMS.map(value => (
          <button
            key={value}
            type="button"
            className={styles['heavyPlatformBtn']}
            aria-pressed={activePlatform === value}
            onClick={() => setSelected(value)}
          >
            {platformName(value)}
          </button>
        ))}
        <span className={styles['heavyModeNote']}>
          {t('heavyPlatformHost').replace('{platform}', platform === undefined || platform === '' ? t('heavyPlatformUnknown') : platform)}
        </span>
      </div>
      {exact === undefined && <p className={styles['heavyModeNote']}>{t('heavyPlatformFallback')}</p>}
      {resolved.unsupported !== undefined && <p className={styles['heavyModeNote']}>{resolved.unsupported}</p>}

      {resolved.unsupported === undefined && (
        <ol className={styles['heavyList']}>
          {resolved.steps.map(step => (
            <li key={step.label}>
              <strong>{step.label}</strong>
              {step.optional === true ? ` (${t('heavyOptional')})` : ''}
              <pre className={styles['heavyLog']}>{step.command}</pre>
            </li>
          ))}
        </ol>
      )}

      <div className={styles['heavySectionLabel']}>{t('heavyQuirks')}</div>
      <ul className={styles['heavyList']}>
        {manifest.quirks.map(quirk => <li key={quirk}>{quirk}</li>)}
      </ul>

      <div className={styles['heavySectionLabel']}>{t('heavyInstalls')}</div>
      <ul className={styles['heavyList']}>
        {resolved.steps.length === 0
          ? <li>{t('heavyNone')}</li>
          : resolved.steps.map(step => <li key={step.label}>{step.label}</li>)}
      </ul>

      <div className={styles['heavySectionLabel']}>{t('heavyRemoves')}</div>
      <ul className={styles['heavyList']}>
        {manifest.removal.steps.length === 0
          ? <li>{t('heavyNoRemovalSteps')}</li>
          : manifest.removal.steps.map(step => <li key={step.label}>{step.label}</li>)}
      </ul>

      <div className={styles['heavySectionLabel']}>{t('heavyRemoveWarnings')}</div>
      <ul className={styles['heavyList']}>
        {manifest.removal.warnings.map(warning => <li key={warning}>{warning}</li>)}
      </ul>
    </section>
  )
}
