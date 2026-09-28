/**
 * Provider detail card for a HEAVY provider: the cached health probe, the
 * dashboard URL(s), the "requires a browser" badges, the manifest quirks, the
 * live install job (polled while it runs, persisted on the host), and the full
 * documentation view. Fail-soft: an unreachable host or dashboard renders as a
 * badge, never as an error that blocks the page.
 *
 * @module ui-settings-models/HeavyProviderCard
 */

import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { resolveHeavyManifest } from './heavy-manifest-source.ts'
import { heavyApi, HEAVY_JOB_POLL_MS, type HeavyJobView } from './heavy-rpc.ts'
import { HeavyDashboardLinks, HeavyPreflightNote, useHeavyStatus } from './HeavyProviderStatus.tsx'
import { HeavyProviderDocs } from './HeavyProviderDocs.tsx'
import type { en } from './locales.ts'
import styles from './ModelsSection.module.css'

export interface HeavyProviderCardProps {
  /** Route id (the manifest lookup key). */
  providerId: string
  t: (key: keyof typeof en) => string
}

/** Provider detail card for a heavy provider. */
export function HeavyProviderCard({ providerId, t }: HeavyProviderCardProps): ReactNode {
  // Host truth first: the status reply carries the manifest the running
  // profile executes; the shared table covers the pre-reply render.
  const listed = resolveHeavyManifest(providerId)
  const { status, checking, refresh } = useHeavyStatus(providerId, { enabled: listed !== undefined })
  const manifest = status?.manifest ?? listed
  const [job, setJob] = useState<HeavyJobView | null>(null)
  const [showDocs, setShowDocs] = useState(false)

  // A host snapshot (page reopened, or another surface started the job) is
  // adopted unless the locally polled copy is newer. A same-start terminal
  // snapshot still wins, so a finished run is never masked by a cached
  // running status reply.
  useEffect(() => {
    const snapshot = status?.job
    if (snapshot === undefined) return
    setJob((previous) => {
      if (previous === null) return snapshot
      if (snapshot.startedAt > previous.startedAt) return snapshot
      if (snapshot.startedAt === previous.startedAt && snapshot.state !== 'running') return snapshot
      return previous
    })
  }, [status])

  // While a job runs, poll it directly: status is TTL-cached for health, but
  // progress must move. A terminal snapshot forces a status refresh so the
  // mode/dashboard badges pick up the route the finalizer just wrote.
  useEffect(() => {
    if (job?.state !== 'running') return
    let cancelled = false
    const timer = setInterval(() => {
      void heavyApi.job(providerId).then((result) => {
        if (cancelled) return
        const next = result.ok ? result.value.job : undefined
        if (next === undefined) return
        setJob(next)
        if (next.state !== 'running') refresh()
      })
    }, HEAVY_JOB_POLL_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [job?.state, providerId, refresh])

  if (manifest === undefined) return null

  const health = status?.health
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
          <HeavyDashboardLinks providerId={providerId} mode={status?.mode} t={t} />
          {manifest.docsUrl !== undefined && (
            <a className={styles['presetMetaItem']} href={manifest.docsUrl} target="_blank" rel="noreferrer">
              {t('heavyDocs')} ↗
            </a>
          )}
          <button type="button" className={styles['heavyLinkBtn']} aria-pressed={showDocs} onClick={() => setShowDocs(open => !open)}>
            {showDocs ? t('heavyHideDocumentation') : t('heavyDocumentation')}
          </button>
          <button type="button" className={styles['heavyLinkBtn']} onClick={refresh} disabled={checking}>
            {checking ? t('heavyChecking') : t('heavyCheck')}
          </button>
        </div>
      </div>

      <div className={styles['cardBody']}>
        <p className={styles['heavySummary']}>{manifest.summary}</p>
        {/* Detection + runtime preflight: offered on mount, fail-soft. */}
        <HeavyPreflightNote status={status} t={t} />
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
        {job !== null && (
          <div className={styles['heavyProgress']}>
            <div className={styles['heavyProgressHead']}>
              <span>{t('heavyProgress').replace('{step}', String(job.stageIndex + 1)).replace('{total}', String(job.stageCount))}</span>
              <span>{job.pct}%</span>
            </div>
            <div className={styles['heavyProgressTrack']}>
              <div className={styles['heavyProgressFill']} style={{ width: `${job.pct}%` }} data-state={job.state} />
            </div>
            <div className={styles['heavyStage']}>{job.stage}</div>
            {job.state === 'running' && <p className={styles['heavyModeNote']}>{t('heavyJobBackground')}</p>}
            {job.state === 'succeeded' && <p className={styles['heavyModeNote']}>{t('heavyJobSucceeded')}</p>}
            {job.state === 'failed' && (
              <p className={styles['heavyProgressError']}>{t('heavyFailed')}: {job.error ?? t('heavyJobFailedHint')}</p>
            )}
            {job.logTail !== '' && <pre className={styles['heavyLog']}>{job.logTail}</pre>}
          </div>
        )}
        {showDocs && <HeavyProviderDocs manifest={manifest} platform={status?.platform} t={t} />}
      </div>
    </div>
  )
}
