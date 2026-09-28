/**
 * Cached heavy-provider status surfaces.
 *
 * One shared TTL cache backs the ONLINE dot in the provider list and the
 * detail card, so a mounted page probes each manifest health URL at most once
 * per {@link HEAVY_HEALTH_TTL_MS} — never in a tight loop. Fail-soft: a
 * refused probe leaves the previous snapshot in place and the label stays
 * "not checked"/"unreachable"; it never renders or raises an error.
 *
 * @module ui-settings-models/HeavyProviderStatus
 */

import { useCallback, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { heavyProviderManifest, type HeavyProviderManifest } from './heavy-providers.ts'
import { HEAVY_HEALTH_TTL_MS, heavyStatusCache, type HeavyStatusView } from './heavy-rpc.ts'
import type { en } from './locales.ts'
import styles from './ModelsSection.module.css'

type Translate = (key: keyof typeof en) => string

/** One dashboard link with its role label. */
interface DashboardEntry {
  url: string
  label: 'heavyDashboardServer' | 'heavyDashboardLocal'
}

/** Dashboard entries for a heavy provider, in display order. */
function dashboardEntries(manifest: HeavyProviderManifest, mode?: 'reuse' | 'local'): DashboardEntry[] {
  const localUrl = manifest.local.dashboardUrl
  if (mode === 'reuse') {
    return manifest.dashboardUrl === undefined ? [] : [{ url: manifest.dashboardUrl, label: 'heavyDashboardServer' }]
  }
  if (mode === 'local') {
    const url = localUrl ?? manifest.dashboardUrl
    if (url === undefined) return []
    return [{ url, label: localUrl === undefined ? 'heavyDashboardServer' : 'heavyDashboardLocal' }]
  }
  const entries: DashboardEntry[] = []
  if (manifest.dashboardUrl !== undefined) entries.push({ url: manifest.dashboardUrl, label: 'heavyDashboardServer' })
  if (localUrl !== undefined && localUrl !== manifest.dashboardUrl) entries.push({ url: localUrl, label: 'heavyDashboardLocal' })
  return entries
}

/** Live status for one provider, served through the shared TTL cache. */
export function useHeavyStatus(
  providerId: string,
  options: { enabled?: boolean } = {},
): { status: HeavyStatusView | null; checking: boolean; refresh: () => void } {
  const enabled = options.enabled !== false
  const [status, setStatus] = useState<HeavyStatusView | null>(() => heavyStatusCache.peek(providerId) ?? null)
  const [checking, setChecking] = useState(false)
  useEffect(() => {
    setStatus(heavyStatusCache.peek(providerId) ?? null)
    if (!enabled) return
    let cancelled = false
    const pull = () => {
      setChecking(true)
      void heavyStatusCache.read(providerId).then((result) => {
        if (cancelled) return
        if (result.ok) setStatus(result.value)
        setChecking(false)
      })
    }
    pull()
    // One refresh per cache lifetime: the read either probes (entry expired)
    // or serves the cached snapshot, so this can never spin.
    const timer = setInterval(pull, HEAVY_HEALTH_TTL_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [providerId, enabled])
  const refresh = useCallback(() => {
    setChecking(true)
    void heavyStatusCache.read(providerId, { force: true }).then((result) => {
      if (result.ok) setStatus(result.value)
      setChecking(false)
    })
  }, [providerId])
  return { status, checking, refresh }
}

/** Compact ONLINE indicator for one provider (list row and card head). */
export function HeavyStatusDot({ providerId, t }: { providerId: string; t: Translate }): ReactNode {
  const { status } = useHeavyStatus(providerId)
  const health = status?.health
  const state = health === undefined ? 'unknown' : health.ok ? 'online' : 'offline'
  const label = state === 'online'
    ? t('heavyHealthOk')
    : state === 'offline' ? t('heavyHealthDown') : t('heavyHealthUnknown')
  return (
    <span
      className={styles['heavyOnlineDot']}
      data-state={state}
      title={`${t('heavyEndpoint')}: ${label}`}
      aria-label={`${t('heavyEndpoint')}: ${label}`}
    />
  )
}

/** The dashboard URLs known for one provider; renders nothing when none is known. */
export function HeavyDashboardLinks({
  providerId,
  mode,
  compact = false,
  t,
}: {
  providerId: string
  mode?: 'reuse' | 'local' | undefined
  compact?: boolean
  t: Translate
}): ReactNode {
  const manifest = heavyProviderManifest(providerId)
  if (manifest === undefined) return null
  const entries = dashboardEntries(manifest, mode)
  if (entries.length === 0) return null
  const shown = compact ? entries.slice(0, 1) : entries
  return (
    <>
      {shown.map(entry => (
        <a
          key={entry.url}
          className={styles['presetMetaItem']}
          href={entry.url}
          target="_blank"
          rel="noreferrer"
          onClick={(event) => { event.stopPropagation() }}
        >
          {compact ? `${t('heavyDashboard')} ↗` : `${t(entry.label)}: ${entry.url} ↗`}
        </a>
      ))}
    </>
  )
}
