// @vitest-environment jsdom
/**
 * The provider-bound heavy status: a health snapshot read for provider A must
 * never surface under provider B when the same component instance switches
 * rows. The hook nulls a foreign snapshot while B's own read is in flight, and
 * the detail card's auto-populate trigger therefore never fires from a foreign
 * provider's status. Also pins the ONLINE dot states and the dashboard /
 * preflight surfaces.
 */
import type { ReactNode } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { HeavyProviderCard } from '../src/client/HeavyProviderCard.tsx'
import {
  HeavyDashboardLinks,
  HeavyPreflightNote,
  HeavyStatusDot,
  useHeavyStatus,
  resolveDashboardUrl,
  sanitizeDashboardUrl,
  isBrowserRemoteFromHost,
} from '../src/client/HeavyProviderStatus.tsx'
import { heavyStatusCache, type HeavyStatusView } from '../src/client/heavy-rpc.ts'
import { bindHostHeavyManifests, resetHeavyManifestSource } from '../src/client/heavy-manifest-source.ts'
import { fallbackHeavyManifest } from '../src/client/heavy-providers.ts'
import { en } from '../src/client/locales.ts'

afterEach(() => {
  cleanup()
  heavyStatusCache.invalidate()
  resetHeavyManifestSource()
  vi.unstubAllGlobals()
})

const t = (key: keyof typeof en): string => en[key]

/** One `enpoiHeavy.status` view for a provider. */
function status(id: string, overrides: Partial<HeavyStatusView> = {}): HeavyStatusView {
  return {
    id,
    configured: true,
    health: { ok: true, status: 200, checkedAt: 11 },
    platform: 'linux',
    ...overrides,
  }
}

/** One successful gateway envelope. */
function envelope(value: unknown): Response {
  return { ok: true, status: 200, json: async () => ({ result: { ok: true, value } }) } as unknown as Response
}

/** One refused `enpoiHeavy.status` answer. */
function refused(): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({ result: { ok: false, error: { message: 'gateway responded 503' } } }),
  } as unknown as Response
}

/** Stub `/api/enpoiHeavy.*`, answering per request method and provider id. */
function stubHeavyFetch(answer: (id: string, method: string) => Response | Promise<Response>): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (_url: string, init?: { body?: string }) => {
    const body = JSON.parse(init?.body ?? '{}') as {
      method?: string
      payload?: { args?: { request?: { id?: string } } }
    }
    return answer(body.payload?.args?.request?.id ?? '', body.method ?? '')
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

/** Probe that renders the status id the hook returned, or `null`. */
function Probe({ providerId }: { providerId: string }): ReactNode {
  const { status: current } = useHeavyStatus(providerId)
  return <div data-testid="probe">{current === null ? 'null' : current.id}</div>
}

/** Probe that also exposes the refresh callback and the checking flag. */
function RefreshProbe({ providerId }: { providerId: string }): ReactNode {
  const { status: current, checking, refresh } = useHeavyStatus(providerId)
  return (
    <div>
      <div data-testid="refresh-status">{current === null ? 'null' : current.id}</div>
      <div data-testid="checking">{checking ? 'yes' : 'no'}</div>
      <button type="button" onClick={refresh}>refresh</button>
    </div>
  )
}

it('binds the status to its provider: a switch render never shows the previous provider snapshot', async () => {
  let releaseB: ((response: Response) => void) | undefined
  const gateB = new Promise<Response>((resolve) => { releaseB = resolve })
  stubHeavyFetch(id => (id === 'antigravity' ? envelope(status('antigravity')) : gateB))

  const view = render(<Probe providerId="antigravity" />)
  await waitFor(() => { expect(screen.getByTestId('probe').textContent).toBe('antigravity') })

  // Provider B's own read is still in flight: A's snapshot must read as null.
  view.rerender(<Probe providerId="freellmapi" />)
  expect(screen.getByTestId('probe').textContent).toBe('null')

  releaseB?.(envelope(status('freellmapi')))
  await waitFor(() => { expect(screen.getByTestId('probe').textContent).toBe('freellmapi') })
})

it('ignores a read that settles after the hook moved to another provider', async () => {
  let releaseA: ((response: Response) => void) | undefined
  const gateA = new Promise<Response>((resolve) => { releaseA = resolve })
  stubHeavyFetch(id => (id === 'antigravity' ? gateA : envelope(status('freellmapi'))))

  const view = render(<Probe providerId="antigravity" />)
  // A's read is parked; the switch happens before it settles.
  view.rerender(<Probe providerId="freellmapi" />)
  await waitFor(() => { expect(screen.getByTestId('probe').textContent).toBe('freellmapi') })

  const lateA = envelope(status('antigravity'))
  await act(async () => { releaseA?.(lateA) })

  // The late A snapshot never lands under B, even though it is now cached.
  expect(screen.getByTestId('probe').textContent).toBe('freellmapi')
  expect(heavyStatusCache.peek('antigravity')?.id).toBe('antigravity')
})

it('never auto-populates a switched route from the previous route cached status', async () => {
  let releaseB: ((response: Response) => void) | undefined
  const gateB = new Promise<Response>((resolve) => { releaseB = resolve })
  stubHeavyFetch((id) => {
    if (id === 'antigravity') return envelope(status('antigravity', { health: { ok: true, status: 200, checkedAt: 21 } }))
    if (id === 'freellmapi') return gateB
    return refused()
  })

  // A refused discovery keeps the trigger un-settled, so only the provider
  // binding can stop a foreign snapshot from firing it under B's id.
  const onAutoPopulate = vi.fn(async () => false)
  const view = render(
    <HeavyProviderCard providerId="antigravity" t={t} modelIds={[]} onAutoPopulate={onAutoPopulate} />,
  )
  await waitFor(() => { expect(onAutoPopulate).toHaveBeenCalledTimes(1) })
  onAutoPopulate.mockClear()

  // Switch to B before B's status answers: A's healthy snapshot must not fire
  // the trigger under B's id (the old contamination bug).
  view.rerender(<HeavyProviderCard providerId="freellmapi" t={t} modelIds={[]} onAutoPopulate={onAutoPopulate} />)
  expect(onAutoPopulate).not.toHaveBeenCalled()

  // B resolves non-configured with a non-empty model list: still no call.
  releaseB?.(envelope(status('freellmapi', { configured: false, health: { ok: true, status: 200, checkedAt: 31 } })))
  view.rerender(<HeavyProviderCard providerId="freellmapi" t={t} modelIds={['b1']} onAutoPopulate={onAutoPopulate} />)
  await waitFor(() => { expect(screen.getByText(`${en.heavyHealthOk} · 200`)).toBeTruthy() })
  expect(onAutoPopulate).not.toHaveBeenCalled()
})

it('renders the online indicator for the cached healthy, refused, and unknown probe states', async () => {
  stubHeavyFetch((id) => {
    if (id === 'dot-on') return envelope(status('dot-on'))
    if (id === 'dot-off') return envelope(status('dot-off', { health: { ok: false, status: 503, checkedAt: 2 } }))
    if (id === 'dot-auth') return envelope(status('dot-auth', { health: { ok: false, status: 401, checkedAt: 3, reachable: true } }))
    return refused()
  })
  // Seeded cache snapshots render their state synchronously.
  await heavyStatusCache.read('dot-on')
  await heavyStatusCache.read('dot-off')
  await heavyStatusCache.read('dot-auth')

  render(
    <div>
      <HeavyStatusDot providerId="dot-on" t={t} />
      <HeavyStatusDot providerId="dot-off" t={t} />
      <HeavyStatusDot providerId="dot-auth" t={t} />
      <HeavyStatusDot providerId="dot-never" t={t} />
    </div>,
  )

  const dot = (label: string): HTMLElement => screen.getByLabelText(`${en.heavyEndpoint}: ${label}`)
  expect(dot(en.heavyHealthOk).getAttribute('data-state')).toBe('online')
  expect(dot(en.heavyHealthDown).getAttribute('data-state')).toBe('offline')
  expect(dot(`${en.heavyHealthAuth} (401)`).getAttribute('data-state')).toBe('auth')
  expect(dot(en.heavyHealthUnknown).getAttribute('data-state')).toBe('unknown')
})

it('renders the preflight note: nothing without a verdict, and the chosen path with its requirements', () => {
  render(
    <div>
      <HeavyPreflightNote status={status('pre')} t={t} />
      <HeavyPreflightNote
        status={status('pre', { preflight: { path: 'podman', label: 'Podman path', missing: [], requires: ['podman'] } })}
        t={t}
      />
    </div>,
  )

  // No detected instance and no preflight verdict: the note renders nothing.
  expect(screen.getAllByText(/./, { selector: 'p' })).toHaveLength(1)
  expect(screen.getByText(
    `${en.heavyPreflightBest.replace('{label}', 'Podman path')} · ${en.heavyRequiresPodman}`,
  )).toBeTruthy()
})

it('renders dashboard entries by mode, fails soft without a manifest, and stops anchor propagation', () => {
  const base = fallbackHeavyManifest('freellmapi')!
  bindHostHeavyManifests({
    items: [{
      ...base,
      dashboardUrl: 'http://127.0.0.1:3002',
      local: { ...base.local, dashboardUrl: 'http://127.0.0.1:3999' },
    }],
  })
  const parentClick = vi.fn()
  const { container } = render(
    <div onClick={parentClick}>
      <HeavyDashboardLinks providerId="missing-provider" t={t} />
      <HeavyDashboardLinks providerId="freellmapi" t={t} />
    </div>,
  )

  // An unknown provider renders nothing; the known one offers both URLs.
  expect(container.querySelectorAll('a')).toHaveLength(2)
  const local = screen.getByRole('link', { name: `${en.heavyDashboardLocal}: http://127.0.0.1:3999 ↗` })
  expect(screen.getByRole('link', { name: `${en.heavyDashboardLocal}: http://127.0.0.1:3002 ↗` })).toBeTruthy()

  // The anchor stops the click from reaching the surrounding row.
  fireEvent.click(local)
  expect(parentClick).not.toHaveBeenCalled()
})

it('keeps the last snapshot when a forced refresh read fails', async () => {
  let loads = 0
  const fetchMock = stubHeavyFetch(() => {
    loads += 1
    return loads === 1 ? envelope(status('probe-refresh')) : refused()
  })

  render(<RefreshProbe providerId="probe-refresh" />)
  await waitFor(() => { expect(screen.getByTestId('refresh-status').textContent).toBe('probe-refresh') })

  fireEvent.click(screen.getByRole('button', { name: 'refresh' }))
  await waitFor(() => { expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2) })
  await waitFor(() => { expect(screen.getByTestId('checking').textContent).toBe('no') })

  // Fail-soft: the refused probe stores nothing and the old snapshot stays.
  expect(screen.getByTestId('refresh-status').textContent).toBe('probe-refresh')
})

it('sanitizes dashboard URLs by rejecting non-http(s), stripping userinfo/query/hash, and safely handling relative paths', () => {
  // Query parameters and hash stripped
  expect(sanitizeDashboardUrl('http://100.122.163.25:8317/management.html?token=secret#hash')).toBe('http://100.122.163.25:8317/management.html')
  expect(sanitizeDashboardUrl('http://127.0.0.1:3002?key=xyz')).toBe('http://127.0.0.1:3002')
  expect(sanitizeDashboardUrl('http://127.0.0.1:3002/')).toBe('http://127.0.0.1:3002/')

  // Userinfo stripped
  expect(sanitizeDashboardUrl('http://admin:pass@127.0.0.1:8317/panel')).toBe('http://127.0.0.1:8317/panel')

  // Non-http(s) rejected
  expect(sanitizeDashboardUrl('javascript:alert(1)')).toBeUndefined()
  expect(sanitizeDashboardUrl('file:///etc/passwd')).toBeUndefined()
  expect(sanitizeDashboardUrl('data:text/html,bad')).toBeUndefined()
  expect(sanitizeDashboardUrl('ftp://example.com')).toBeUndefined()

  // Malformed input rejected
  expect(sanitizeDashboardUrl('not a url')).toBeUndefined()
  expect(sanitizeDashboardUrl('')).toBeUndefined()

  // Relative paths: only resolve when explicit trusted activeOrigin is provided
  expect(sanitizeDashboardUrl('/management.html', 'http://100.122.163.25:8317/v1')).toBe('http://100.122.163.25:8317/management.html')
  expect(sanitizeDashboardUrl('/management.html')).toBeUndefined()
  expect(sanitizeDashboardUrl('/management.html', 'javascript:alert(1)')).toBeUndefined()
})

it('retargets loopback dashboard URLs only when port matches service default port, preserving distinct ports and direct delivery', () => {
  const serviceManifest = {
    id: 'test-service',
    label: 'Test Service',
    summary: 'Test',
    protocol: 'openai-completions',
    delivery: 'service' as const,
    defaultPort: 8317,
    dashboardUrl: 'http://127.0.0.1:8317/management.html',
    reuse: { label: 'Reuse', baseURL: 'http://127.0.0.1:8317/v1', note: '', health: { url: 'http://127.0.0.1:8317/healthz' } },
    local: { label: 'Local', baseURL: 'http://127.0.0.1:8317/v1', deps: [], diskHint: '', install: { default: { steps: [] } }, health: { url: 'http://127.0.0.1:8317/healthz' } },
    auth: { kind: 'none' as const, keyless: true },
    requiresBrowser: [],
    quirks: [],
    removal: { steps: [], warnings: [] },
  }

  // 1. Port matches service default port (8317 === 8317) -> retargets to active remote origin
  expect(resolveDashboardUrl('http://127.0.0.1:8317/management.html', 'http://100.122.163.25:8317/v1', serviceManifest))
    .toBe('http://100.122.163.25:8317/management.html')

  // 2. Distinct dashboard port 9000 vs service port 8317: NOT retargeted to 8317, kept distinct
  expect(resolveDashboardUrl('http://127.0.0.1:9000/management.html', 'http://100.122.163.25:8317/v1', serviceManifest))
    .toBe('http://127.0.0.1:9000/management.html')

  // 3. Direct delivery (CommandCode): never rewritten
  const directManifest = {
    ...serviceManifest,
    id: 'commandcode',
    delivery: 'direct' as const,
    dashboardUrl: 'https://commandcode.ai',
  }
  expect(resolveDashboardUrl('https://commandcode.ai', 'http://100.122.163.25:8317/v1', directManifest))
    .toBe('https://commandcode.ai')

  // 4. Explicit overlay external origin/path: preserved verbatim
  expect(resolveDashboardUrl('http://100.122.163.25:9000/management.html', 'http://100.122.163.25:8317/v1', serviceManifest))
    .toBe('http://100.122.163.25:9000/management.html')

  // 5. Does not retarget if activeEndpoint is loopback
  expect(resolveDashboardUrl('http://127.0.0.1:8317/management.html', 'http://127.0.0.1:8317/v1', serviceManifest))
    .toBe('http://127.0.0.1:8317/management.html')
})

it('renders retargeted remote dashboard link with neutral dashboard label (no false Local)', () => {
  render(<HeavyDashboardLinks providerId="freellmapi" mode="reuse" activeEndpoint="http://100.122.163.25:3002/v1" t={t} />)
  expect(screen.getByRole('link', { name: `${en.heavyDashboard}: http://100.122.163.25:3002 ↗` })).toBeTruthy()
  expect(screen.queryByText(/Local dashboard/)).toBeNull()
  expect(screen.queryByText(/127\.0\.0\.1/)).toBeNull()
})

it('detects when browser location is remote relative to host loopback URL', () => {
  expect(isBrowserRemoteFromHost('http://127.0.0.1:8317', '100.122.163.25')).toBe(true)
  expect(isBrowserRemoteFromHost('http://localhost:8317', '100.122.163.25')).toBe(true)
  expect(isBrowserRemoteFromHost('http://100.122.163.25:8317', '100.122.163.25')).toBe(false)
  expect(isBrowserRemoteFromHost('http://127.0.0.1:8317', 'localhost')).toBe(false)
  expect(isBrowserRemoteFromHost('http://127.0.0.1:8317', '127.0.0.1')).toBe(false)
})
