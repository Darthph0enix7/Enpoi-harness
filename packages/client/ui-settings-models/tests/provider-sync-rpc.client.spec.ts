// @vitest-environment jsdom
/** The provider-sync RPC client: envelope handling, payload validation, and fail-soft answers. */
import { afterEach, expect, it, vi } from 'vitest'
import { refreshRouteViaPlugin, refreshRoutesViaPlugin } from '../src/client/provider-sync-rpc.ts'

afterEach(() => { vi.unstubAllGlobals() })

/** Stub fetch with one response for the refresh call. */
function stubFetch(handler: (url: string, init?: RequestInit) => Promise<unknown>): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => handler(
    typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    init,
  ))
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

/** One successful envelope around `value`. */
function answer(value: unknown) {
  return { ok: true, json: async () => ({ result: { ok: true, value } }) }
}

it('returns the validated host refresh view', async () => {
  const fetchMock = stubFetch(async () => answer({
    route: 'opencode-go',
    models: [{ id: 'kept' }, 'not-an-object'],
    removed: ['gone', 7],
    deprecated: ['pinned'],
    degraded: true,
    degradedReason: 'catalogue stale',
    source: 'live',
    authority: 'catalog',
    fetchedAt: 42,
  }))
  const result = await refreshRouteViaPlugin('opencode-go')
  expect(result).toEqual({
    ok: true,
    value: {
      route: 'opencode-go',
      models: [{ id: 'kept' }],
      removed: ['gone'],
      deprecated: ['pinned'],
      degraded: true,
      degradedReason: 'catalogue stale',
      source: 'live',
      authority: 'catalog',
      fetchedAt: 42,
    },
  })
  expect(fetchMock).toHaveBeenCalledWith('/api/providerSync.refreshRoute', expect.objectContaining({ method: 'POST' }))
})

it('defaults every optional field on a minimally valid payload', async () => {
  stubFetch(async () => answer({ models: [] }))
  await expect(refreshRouteViaPlugin('gateway')).resolves.toEqual({
    ok: true,
    value: { route: '', models: [], removed: [], deprecated: [], degraded: false, source: 'none', authority: 'none', fetchedAt: 0 },
  })
})

it('reports a non-OK HTTP status instead of throwing', async () => {
  stubFetch(async () => ({ ok: false, status: 404, json: async () => ({}) }))
  await expect(refreshRouteViaPlugin('gateway')).resolves.toEqual({
    ok: false,
    message: 'providerSync.refreshRoute responded 404',
  })
})

it('reports the host refusal message, with a fallback when it names none', async () => {
  stubFetch(async () => ({ ok: true, json: async () => ({ result: { ok: false, error: { message: 'route not configured' } } }) }))
  await expect(refreshRouteViaPlugin('gateway')).resolves.toEqual({ ok: false, message: 'route not configured' })
  stubFetch(async () => ({ ok: true, json: async () => ({ result: { ok: false } }) }))
  await expect(refreshRouteViaPlugin('gateway')).resolves.toEqual({ ok: false, message: 'providerSync.refreshRoute was rejected' })
})

it('treats a payload without a models array as unusable', async () => {
  stubFetch(async () => answer({ route: 'gateway' }))
  await expect(refreshRouteViaPlugin('gateway')).resolves.toEqual({
    ok: false,
    message: 'providerSync.refreshRoute returned an unusable payload',
  })
  stubFetch(async () => answer(null))
  await expect(refreshRouteViaPlugin('gateway')).resolves.toEqual({
    ok: false,
    message: 'providerSync.refreshRoute returned an unusable payload',
  })
  stubFetch(async () => answer([]))
  await expect(refreshRouteViaPlugin('gateway')).resolves.toEqual({
    ok: false,
    message: 'providerSync.refreshRoute returned an unusable payload',
  })
})

it('reports a transport failure as a displayable message', async () => {
  stubFetch(async () => { throw new Error('network down') })
  await expect(refreshRouteViaPlugin('gateway')).resolves.toEqual({ ok: false, message: 'network down' })
  stubFetch(async () => { throw 'socket closed' })
  await expect(refreshRouteViaPlugin('gateway')).resolves.toEqual({ ok: false, message: 'socket closed' })
})

it('returns every route status from the full pass', async () => {
  const fetchMock = stubFetch(async () => answer({
    refreshedAt: 99,
    routes: [
      {
        route: 'alpha',
        status: 'ok',
        source: 'live',
        authority: 'endpoint',
        advertised: 3,
        modelCount: 3,
        removed: ['gone', 5],
        deprecated: [],
        degraded: false,
        cached: true,
        fetchedAt: 98,
      },
      { route: 'beta', status: 'unreachable', source: 'none', authority: 'none', modelCount: 1, message: 'HTTP 404', cached: false },
      { status: 'ok' },
      'not a route',
    ],
  }))
  await expect(refreshRoutesViaPlugin()).resolves.toEqual({
    ok: true,
    value: {
      refreshedAt: 99,
      routes: [
        {
          route: 'alpha',
          status: 'ok',
          source: 'live',
          authority: 'endpoint',
          advertised: 3,
          modelCount: 3,
          removed: ['gone'],
          deprecated: [],
          degraded: false,
          cached: true,
          fetchedAt: 98,
        },
        {
          route: 'beta',
          status: 'unreachable',
          source: 'none',
          authority: 'none',
          modelCount: 1,
          removed: [],
          deprecated: [],
          degraded: false,
          cached: false,
          message: 'HTTP 404',
          fetchedAt: 0,
        },
      ],
    },
  })
  expect(fetchMock).toHaveBeenCalledWith('/api/providerSync.refreshRoutes', expect.objectContaining({ method: 'POST' }))
})

it('sends an explicit route list when the caller restricts the pass', async () => {
  const bodies: string[] = []
  stubFetch(async (_url, init) => {
    bodies.push(init?.body as string)
    return answer({ refreshedAt: 1, routes: [] })
  })
  await refreshRoutesViaPlugin(['alpha', 'beta'])
  expect((JSON.parse(bodies[0]!) as { payload?: unknown }).payload).toEqual({ args: { routes: ['alpha', 'beta'] } })
})

it('reports a rejected or unusable full pass instead of throwing', async () => {
  stubFetch(async () => ({ ok: true, json: async () => ({ result: { ok: false, error: { message: 'settings seam absent' } } }) }))
  await expect(refreshRoutesViaPlugin()).resolves.toEqual({ ok: false, message: 'settings seam absent' })
  stubFetch(async () => ({ ok: false, status: 503, json: async () => ({}) }))
  await expect(refreshRoutesViaPlugin()).resolves.toEqual({
    ok: false,
    message: 'providerSync.refreshRoutes responded 503',
  })
  stubFetch(async () => answer({ routes: 'nope' }))
  await expect(refreshRoutesViaPlugin()).resolves.toEqual({
    ok: false,
    message: 'providerSync.refreshRoutes returned an unusable payload',
  })
  stubFetch(async () => { throw new Error('network down') })
  await expect(refreshRoutesViaPlugin()).resolves.toEqual({ ok: false, message: 'network down' })
})
