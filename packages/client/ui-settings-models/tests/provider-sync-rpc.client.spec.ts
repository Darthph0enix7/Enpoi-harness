// @vitest-environment jsdom
/** The provider-sync RPC client: envelope handling, payload validation, and fail-soft answers. */
import { afterEach, expect, it, vi } from 'vitest'
import { refreshRouteViaPlugin } from '../src/client/provider-sync-rpc.ts'

afterEach(() => { vi.unstubAllGlobals() })

/** Stub fetch with one response for the refresh call. */
function stubFetch(handler: (url: string, init?: RequestInit) => Promise<unknown>): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => handler(String(input), init))
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
