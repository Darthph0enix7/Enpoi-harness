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
    return refused()
  })
  // Seeded cache snapshots render their state synchronously.
  await heavyStatusCache.read('dot-on')
  await heavyStatusCache.read('dot-off')

  render(
    <div>
      <HeavyStatusDot providerId="dot-on" t={t} />
      <HeavyStatusDot providerId="dot-off" t={t} />
      <HeavyStatusDot providerId="dot-never" t={t} />
    </div>,
  )

  const dot = (label: string): HTMLElement => screen.getByLabelText(`${en.heavyEndpoint}: ${label}`)
  expect(dot(en.heavyHealthOk).getAttribute('data-state')).toBe('online')
  expect(dot(en.heavyHealthDown).getAttribute('data-state')).toBe('offline')
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
