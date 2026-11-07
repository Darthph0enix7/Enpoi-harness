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
import { resolveHeavyManifest } from './heavy-manifest-source.ts'
import type { HeavyProviderManifest } from './heavy-providers.ts'
import { HEAVY_HEALTH_TTL_MS, heavyStatusCache, type HeavyStatusView } from './heavy-rpc.ts'
import type { en } from './locales.ts'
import styles from './ModelsSection.module.css'

type Translate = (key: keyof typeof en) => string

/** One dashboard link with its role label key. */
export interface DashboardEntry {
  url: string
  labelKey: 'heavyDashboard' | 'heavyDashboardLocal'
}

/**
 * Sanitize a dashboard URL:
 * - Rejects non-http(s) schemes (e.g. javascript:, file:, data:)
 * - Strips userinfo (username/password), query parameters, and hash fragments
 * - Malformed raw input returns undefined (cannot bypass sanitation)
 * - Relative paths (e.g. "/management.html") resolve only against an explicit,
 *   valid http(s) activeOrigin; otherwise they return undefined
 */
export function sanitizeDashboardUrl(rawUrl: string, activeOrigin?: string): string | undefined {
  if (typeof rawUrl !== 'string' || rawUrl.trim() === '') return undefined
  const trimmed = rawUrl.trim()
  try {
    let parsed: URL
    if (trimmed.startsWith('/') || !trimmed.includes('://')) {
      if (!activeOrigin || activeOrigin.trim() === '') return undefined
      const baseParsed = new URL(activeOrigin.trim())
      if (baseParsed.protocol !== 'http:' && baseParsed.protocol !== 'https:') return undefined
      parsed = new URL(trimmed, baseParsed.origin)
    } else {
      parsed = new URL(trimmed)
    }

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return undefined
    }

    parsed.username = ''
    parsed.password = ''
    parsed.search = ''
    parsed.hash = ''

    if (parsed.pathname === '/' && !trimmed.endsWith('/')) {
      return `${parsed.protocol}//${parsed.host}`
    }
    return parsed.toString()
  } catch {
    return undefined
  }
}

/**
 * Helper to check if a hostname is loopback.
 */
function isLoopbackHost(hostname: string): boolean {
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1'
}

/**
 * Resolve a dashboard URL for a heavy provider manifest against an active endpoint.
 *
 * Rules:
 * 1. CommandCode / direct delivery: declared dashboard is never rewritten.
 * 2. An already-external declared URL (an explicit overlay origin) is
 *    preserved verbatim.
 * 3. Relative dashboard paths resolve against the explicit active origin;
 *    without one they are omitted.
 * 4. A loopback dashboard is retargeted only when its port matches the
 *    service's declared default port; a distinct port (9000 vs 8317) stays
 *    distinct.
 */
export function resolveDashboardUrl(
  declaredUrl: string | undefined,
  activeEndpoint?: string,
  manifest?: HeavyProviderManifest,
): string | undefined {
  if (!declaredUrl || declaredUrl.trim() === '') return undefined
  const trimmedDeclared = declaredUrl.trim()

  // 1. Direct vendor routes: never rewritten
  if (manifest?.delivery === 'direct') {
    return sanitizeDashboardUrl(trimmedDeclared)
  }

  // 2. Relative paths: resolve against activeEndpoint origin
  if (trimmedDeclared.startsWith('/') || !trimmedDeclared.includes('://')) {
    return sanitizeDashboardUrl(trimmedDeclared, activeEndpoint)
  }

  // 3. Absolute URL: sanitize first
  const sanitizedDeclared = sanitizeDashboardUrl(trimmedDeclared)
  if (!sanitizedDeclared) return undefined

  try {
    const declaredParsed = new URL(sanitizedDeclared)
    const isDeclaredLoopback = isLoopbackHost(declaredParsed.hostname)

    // If declared is already an external URL (e.g. overlay external origin), preserve it
    if (!isDeclaredLoopback) {
      return sanitizedDeclared
    }

    // Declared is loopback. Check if declared dashboard port matches service default port
    if (manifest) {
      const declaredPort = declaredParsed.port || (declaredParsed.protocol === 'https:' ? '443' : '80')
      const servicePort = manifest.defaultPort
        ? String(manifest.defaultPort)
        : manifest.reuse.baseURL
          ? new URL(manifest.reuse.baseURL).port || (new URL(manifest.reuse.baseURL).protocol === 'https:' ? '443' : '80')
          : ''

      // If ports are distinct (e.g. 9000 vs 8317), keep distinct! Do not retarget to inference port.
      if (servicePort !== '' && declaredPort !== servicePort) {
        return sanitizedDeclared
      }
    }

    // Port matches: if activeEndpoint is a valid remote http(s) endpoint, retarget to active origin
    if (activeEndpoint && activeEndpoint.trim() !== '') {
      const activeParsed = new URL(activeEndpoint.trim())
      if ((activeParsed.protocol === 'http:' || activeParsed.protocol === 'https:')
        && !isLoopbackHost(activeParsed.hostname)) {
        const path = declaredParsed.pathname === '/' && !trimmedDeclared.endsWith('/') ? '' : declaredParsed.pathname
        return sanitizeDashboardUrl(`${activeParsed.origin}${path}`)
      }
    }

    return sanitizedDeclared
  } catch {
    return sanitizedDeclared
  }
}

/**
 * Whether the dashboard URL is on host loopback while the user's browser is remote.
 */
export function isBrowserRemoteFromHost(
  urlStr: string,
  currentHost: string = typeof window === 'undefined' ? '' : window.location.hostname,
): boolean {
  try {
    const parsed = new URL(urlStr)
    const isTargetLoopback = isLoopbackHost(parsed.hostname)
    const isBrowserLoopback = currentHost === '127.0.0.1' || currentHost === 'localhost' || currentHost === ''
    return isTargetLoopback && !isBrowserLoopback
  } catch {
    return false
  }
}

/** Dashboard entries for a heavy provider, in display order (loopback-first). */
export function dashboardEntries(
  manifest: HeavyProviderManifest,
  mode?: 'reuse' | 'local' | 'unknown',
  activeEndpoint?: string,
): DashboardEntry[] {
  const detectedUrl = resolveDashboardUrl(manifest.dashboardUrl, activeEndpoint, manifest)
  const localUrl = resolveDashboardUrl(manifest.local.dashboardUrl ?? manifest.dashboardUrl, undefined, manifest)
  const entries: DashboardEntry[] = []

  const addEntry = (url: string | undefined) => {
    if (!url) return
    const isLoopback = (() => {
      try { return isLoopbackHost(new URL(url).hostname) } catch { return false }
    })()
    // Neutral dashboard label for remote and local, no false Local:
    const labelKey: 'heavyDashboard' | 'heavyDashboardLocal' = isLoopback ? 'heavyDashboardLocal' : 'heavyDashboard'
    if (!entries.some(e => e.url === url)) {
      entries.push({ url, labelKey })
    }
  }

  if (mode !== 'local' && detectedUrl !== undefined) {
    addEntry(detectedUrl)
  }
  if (mode !== 'reuse' && localUrl !== undefined) {
    addEntry(localUrl)
  }
  return entries
}

/** Live status for one provider, served through the shared TTL cache. */
export function useHeavyStatus(
  providerId: string,
  options: { enabled?: boolean } = {},
): { status: HeavyStatusView | null; checking: boolean; refresh: () => void } {
  const enabled = options.enabled !== false
  // The status is bound to the provider it was read for: when the hook is
  // reused for another provider id (a switch render), the previous provider's
  // snapshot must read as null — never as this provider's status — until its
  // own read answers. Without the binding a consumer could probe or act on a
  // foreign provider's health snapshot.
  const [view, setView] = useState<{ providerId: string; status: HeavyStatusView | null }>(
    () => ({ providerId, status: heavyStatusCache.peek(providerId) ?? null }),
  )
  const [checking, setChecking] = useState(false)
  useEffect(() => {
    setView({ providerId, status: heavyStatusCache.peek(providerId) ?? null })
    if (!enabled) return
    let cancelled = false
    const pull = () => {
      setChecking(true)
      void heavyStatusCache.read(providerId).then((result) => {
        if (cancelled) return
        if (result.ok) setView({ providerId, status: result.value })
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
      // A read that settled after the hook moved to another provider updates
      // nothing: its snapshot belongs to the provider id it was read for.
      if (result.ok) setView({ providerId, status: result.value })
      setChecking(false)
    })
  }, [providerId])
  return { status: view.providerId === providerId ? view.status : null, checking, refresh }
}

/**
 * The runtime preflight / detection offer line: an answering local instance
 * first ("Running at … — use it"), else the platform's best install path with
 * its Docker/Podman requirement, else the exact missing dependency.
 */
export function HeavyPreflightNote({ status, t }: { status: HeavyStatusView | null; t: Translate }): ReactNode {
  if (status === null) return null
  const healthStatus = status.health.status
  if (healthStatus === 401 || healthStatus === 403) {
    const target = status.detectedEndpoint ?? 'endpoint'
    return (
      <p className={styles['heavyPreflight']} data-state="auth-required">
        {t('heavyHealthAuthRequired')
          .replace('{endpoint}', target)
          .replace('{status}', String(healthStatus))}
      </p>
    )
  }
  if (status.detectedEndpoint !== undefined) {
    return (
      <p className={styles['heavyPreflight']} data-state="detected">
        {t('heavyDetectedOffer').replace('{endpoint}', status.detectedEndpoint)}
      </p>
    )
  }
  const preflight = status.preflight
  if (preflight === undefined) return null
  if (preflight.path === 'unsupported') {
    return (
      <p className={styles['heavyPreflight']} data-state="missing">
        {t('heavyPreflightMissing').replace('{missing}', preflight.missing.join(', '))}
      </p>
    )
  }
  return (
    <p className={styles['heavyPreflight']} data-state="ready">
      {t('heavyPreflightBest').replace('{label}', preflight.label)}
      {preflight.requires.includes('docker') ? ` · ${t('heavyRequiresDocker')}` : ''}
      {preflight.requires.includes('podman') ? ` · ${t('heavyRequiresPodman')}` : ''}
    </p>
  )
}

/** Compact ONLINE indicator for one provider (list row and card head). */
export function HeavyStatusDot({ providerId, t }: { providerId: string; t: Translate }): ReactNode {
  const { status } = useHeavyStatus(providerId)
  const health = status?.health
  const healthStatus = health?.status
  const isAuth = healthStatus === 401 || healthStatus === 403
  const state = health === undefined ? 'unknown' : isAuth ? 'auth' : health.ok ? 'online' : 'offline'
  const label = isAuth
    ? `${t('heavyHealthAuth')} (${String(healthStatus)})`
    : state === 'online'
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
  activeEndpoint,
  compact = false,
  t,
}: {
  providerId: string
  mode?: 'reuse' | 'local' | 'unknown'
  activeEndpoint?: string
  compact?: boolean
  t: Translate
}): ReactNode {
  const manifest = resolveHeavyManifest(providerId)
  const { status } = useHeavyStatus(providerId, { enabled: manifest !== undefined })
  if (manifest === undefined) return null
  const effectiveEndpoint = activeEndpoint ?? status?.detectedEndpoint ?? (mode === 'reuse' ? manifest.reuse.baseURL : undefined)
  const entries = dashboardEntries(manifest, mode, effectiveEndpoint)
  if (entries.length === 0) return null
  const shown = compact ? entries.slice(0, 1) : entries
  return (
    <>
      {shown.map((entry) => {
        const remoteHost = isBrowserRemoteFromHost(entry.url)
        return (
          <a
            key={entry.url}
            className={styles['presetMetaItem']}
            href={entry.url}
            target="_blank"
            rel="noreferrer"
            title={remoteHost ? t('heavyDashboardHostLoopbackTitle') : undefined}
            onClick={(event) => { event.stopPropagation() }}
          >
            {compact
              ? `${t('heavyDashboard')} ↗`
              : `${t(entry.labelKey)}: ${entry.url} ↗${remoteHost ? ` (${t('heavyHostLoopback')})` : ''}`}
          </a>
        )
      })}
    </>
  )
}
