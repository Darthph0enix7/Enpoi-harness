/**
 * Provider detail card for a HEAVY provider: the live health probe, the
 * dashboard link, the "requires a browser" badges, the manifest quirks, and
 * the mode the configured route uses. Fail-soft: an unreachable host or
 * dashboard renders as a badge, never as an error that blocks the page.
 *
 * @module ui-settings-models/HeavyProviderCard
 */

import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { heavyProviderManifest } from './heavy-providers.ts'
import { heavyApi, type HeavyStatusView } from './heavy-rpc.ts'
import type { en } from './locales.ts'
import styles from './ModelsSection.module.css'

export interface HeavyProviderCardProps {
  /** Route id (the manifest lookup key). */
  providerId: string
  t: (key: keyof typeof en) => string
}

export function HeavyProviderCard({ providerId, t }: HeavyProviderCardProps): ReactNode {
  const manifest = heavyProviderManifest(providerId)
  const [status, setStatus] = useState<HeavyStatusView | null>(null)
  const [checking, setChecking] = useState(false)

  useEffect(() => {
    let cancelled = false
    setChecking(true)
    void heavyApi.status(providerId).then((result) => {
      if (cancelled) return
      if (result.ok) setStatus(result.value)
      setChecking(false)
    })
    return () => { cancelled = true }
  }, [providerId])

  if (manifest === undefined) return null

  const check = () => {
    setChecking(true)
    void heavyApi.status(providerId).then((result) => {
      if (result.ok) setStatus(result.value)
      setChecking(false)
    })
  }

  const health = status?.health
  const dashboardUrl = status?.mode === 'local'
    ? manifest.local.dashboardUrl ?? manifest.dashboardUrl
    : manifest.dashboardUrl
  return (
    <div className={styles['settingsCard']}>
      <div className={styles['cardHead']}>
        <div className={styles['cardTitleRow']}>
          <h3 className={styles['cardTitle']}>{t('heavyBadge')}</h3>
          <span className={styles['heavyHealthBadge']} data-ok={health?.ok === true ? 'true' : 'false'}>
            {health === undefined ? t('heavyHealthUnknown') : health.ok ? t('heavyHealthOk') : t('heavyHealthDown')}
            {health?.status !== undefined ? ` · ${String(health.status)}` : ''}
          </span>
          <span className={styles['heavyHealthBadge']}>
            {t('heavyModeInUse')}: {status?.mode === 'local' ? t('heavyModeLocal') : status?.mode === 'reuse' ? t('heavyModeReuse') : '—'}
          </span>
        </div>
        <div className={styles['poolHeaderActions']}>
          {dashboardUrl !== undefined && (
            <a className={styles['presetMetaItem']} href={dashboardUrl} target="_blank" rel="noreferrer">
              {t('heavyDashboard')} ↗
            </a>
          )}
          {manifest.docsUrl !== undefined && (
            <a className={styles['presetMetaItem']} href={manifest.docsUrl} target="_blank" rel="noreferrer">
              {t('heavyDocs')} ↗
            </a>
          )}
          <button type="button" className={styles['heavyLinkBtn']} onClick={check} disabled={checking}>
            {checking ? t('heavyChecking') : t('heavyCheck')}
          </button>
        </div>
      </div>

      <div className={styles['cardBody']}>
        <p className={styles['heavySummary']}>{manifest.summary}</p>
        {manifest.requiresBrowser.length > 0 && (
          <div className={styles['heavyBadges']}>
            {manifest.requiresBrowser.map(line => (
              <span key={line} className={styles['heavyBrowserBadge']} title={line}>
                {t('heavyBrowserBadge')}
              </span>
            ))}
          </div>
        )}
        <div className={styles['heavySectionLabel']}>{t('heavyQuirks')}</div>
        <ul className={styles['heavyList']}>
          {manifest.quirks.map(quirk => <li key={quirk}>{quirk}</li>)}
        </ul>
        {manifest.unsupported !== undefined && (
          <div className={styles['heavyBlocked']}>
            <strong>{t('heavyBlockedTitle')}</strong>
            <p>{manifest.unsupported.reason}</p>
            <p className={styles['heavyBlockedHint']}>
              {t('heavyBlockedHint').replace('{planned}', manifest.unsupported.plannedWith)}
              {' · '}
              <a href={manifest.unsupported.reuseUrl} target="_blank" rel="noreferrer">reuse URL ↗</a>
            </p>
          </div>
        )}
        {status?.job !== undefined && status.job.state === 'running' && (
          <div className={styles['heavyProgress']}>
            <div className={styles['heavyProgressHead']}>
              <span>{status.job.stage}</span>
              <span>{status.job.pct}%</span>
            </div>
            <div className={styles['heavyProgressTrack']}>
              <div className={styles['heavyProgressFill']} style={{ width: `${status.job.pct}%` }} data-state={status.job.state} />
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
