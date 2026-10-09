/**
 * Provider detail card for a HEAVY provider: the cached health probe, the
 * dashboard URL(s), the "requires a browser" badges, the manifest quirks, the
 * live install job (polled while it runs; the progress block shows while
 * running, a failure keeps its error and log tail, and a finished run collapses
 * to one line), and the full documentation view. Fail-soft: an unreachable host
 * or dashboard renders as a badge, never as an error that blocks the page.
 *
 * @module ui-settings-models/HeavyProviderCard
 */

import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { resolveHeavyManifest } from './heavy-manifest-source.ts'
import { autoPopulateDue, type AutoPopulateAttempt } from './heavy-auto-populate.ts'
import { pollHeavyJob, HEAVY_JOB_POLL_MS, type HeavyJobView } from './heavy-rpc.ts'
import { HeavyDashboardLinks, HeavyPreflightNote, useHeavyStatus } from './HeavyProviderStatus.tsx'
import { HeavyProviderDocs } from './HeavyProviderDocs.tsx'
import type { en } from './locales.ts'
import styles from './ModelsSection.module.css'
import cardStyles from './HeavyProviderCard.module.css'

export interface HeavyProviderCardProps {
  /** Route id (the manifest lookup key). */
  providerId: string
  t: (key: keyof typeof en) => string
  /** The route's configured model ids; the automatic-population trigger watches these. */
  modelIds?: readonly string[]
  /**
   * Run discovery and merge it into the route; resolves true once the catalog
   * holds at least one discovered model. Called automatically at most once per
   * successful status check while the route still declares no real model, and
   * never again for this card after a populated write. Absent on non-heavy
   * surfaces.
   */
  onAutoPopulate?: () => Promise<boolean>
}

/** Provider detail card for a heavy provider. */
export function HeavyProviderCard({ providerId, t, modelIds = [], onAutoPopulate }: HeavyProviderCardProps): ReactNode {
  // Host truth first: the status reply carries the manifest the running
  // profile executes; the shared table covers the pre-reply render.
  const listed = resolveHeavyManifest(providerId)
  const { status, checking, refresh } = useHeavyStatus(providerId, { enabled: listed !== undefined })
  const manifest = status?.manifest ?? listed
  const [job, setJob] = useState<HeavyJobView | null>(null)
  const [showDocs, setShowDocs] = useState(false)
  const autoAttempt = useRef<AutoPopulateAttempt | undefined>(undefined)
  const autoSettled = useRef(false)

  // Auto-population: a configured route with no real model (empty or only a
  // fabricated legacy fallback) discovers once per successful status check
  // while the service answers. The refs make the guard exact: a re-render or
  // an unchanged cached snapshot can never attempt twice, and a completed
  // write ends automatic attempts for this card (the manual Refresh stays).
  useEffect(() => {
    if (onAutoPopulate === undefined || autoSettled.current || status === null) return
    if (!autoPopulateDue(autoAttempt.current, {
      providerId,
      configured: status.configured,
      healthOk: status.health.ok,
      checking,
      checkedAt: status.health.checkedAt,
      modelIds,
    })) return
    autoAttempt.current = { providerId, checkedAt: status.health.checkedAt }
    void onAutoPopulate().then((settled) => {
      if (settled) autoSettled.current = true
    })
  }, [status, checking, providerId, modelIds, onAutoPopulate])

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
  // progress must move. The effect's abort signal owns the loop, so unmount or
  // a job that settled elsewhere stops the polling at its next sleep. A
  // terminal snapshot forces a status refresh so the mode/dashboard badges
  // pick up the route the finalizer just wrote.
  useEffect(() => {
    if (job?.state !== 'running') return
    const controller = new AbortController()
    void pollHeavyJob(providerId, (next) => { setJob(next) }, {
      intervalMs: HEAVY_JOB_POLL_MS,
      signal: controller.signal,
    }).then((final) => {
      if (final !== null && final.state !== 'running') refresh()
    })
    return () => { controller.abort() }
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
              <a href={manifest.unsupported.reuseUrl} target="_blank" rel="noreferrer">{t('heavyReuseUrl')} ↗</a>
            </p>
          </div>
        )}
        {job !== null && job.state !== 'succeeded' && (
          <div
            className={`${styles['heavyProgress']} ${cardStyles['heavyProgress']}`}
            data-heavy-progress
            data-state={job.state}
          >
            <div className={styles['heavyProgressHead']}>
              <span>{t('heavyProgress').replace('{step}', String(job.stageIndex + 1)).replace('{total}', String(job.stageCount))}</span>
              <span>{job.pct}%</span>
            </div>
            <div className={styles['heavyProgressTrack']}>
              <div className={styles['heavyProgressFill']} style={{ width: `${job.pct}%` }} data-state={job.state} />
            </div>
            <div className={styles['heavyStage']}>{job.stage}</div>
            {job.state === 'running' && <p className={styles['heavyModeNote']}>{t('heavyJobBackground')}</p>}
            {job.state === 'failed' && (
              <p className={styles['heavyProgressError']}>{t('heavyFailed')}: {job.error ?? t('heavyJobFailedHint')}</p>
            )}
            {job.logTail !== '' && (
              <pre
                className={`${styles['heavyLog']} ${cardStyles['heavyLog']}`}
                data-heavy-log
              >
                {job.logTail}
              </pre>
            )}
          </div>
        )}
        {/* A finished run collapses to one line: the bar, stage, and log tail
            are process clutter once the job is done. The host stops reporting
            the snapshot altogether once the route is configured, so this line
            never survives a page reopen. */}
        {job?.state === 'succeeded' && (
          <p className={styles['heavyModeNote']} data-heavy-progress-done>{t('heavyJobSucceeded')}</p>
        )}
        {showDocs && <HeavyProviderDocs manifest={manifest} platform={status?.platform} t={t} />}
      </div>
    </div>
  )
}
