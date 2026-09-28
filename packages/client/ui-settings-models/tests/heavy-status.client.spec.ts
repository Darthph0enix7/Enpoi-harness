/**
 * The online-indicator cache: one probe per TTL, in-flight dedupe, forced
 * refresh, and fail-soft errors that store nothing and surface as a message.
 */
import { expect, it, vi } from 'vitest'
import {
  createHeavyStatusCache,
  HEAVY_HEALTH_TTL_MS,
  type HeavyRpcResult,
  type HeavyStatusView,
} from '../src/client/heavy-rpc.ts'

function view(ok: boolean): HeavyStatusView {
  return {
    id: 'freellmapi',
    configured: true,
    health: { ok, status: ok ? 200 : 503, checkedAt: 1 },
    platform: 'linux',
  }
}

it('keeps the 60s TTL contract', () => {
  expect(HEAVY_HEALTH_TTL_MS).toBe(60_000)
})

it('serves a cached snapshot within the TTL and re-probes after it', async () => {
  let clock = 0
  const load = vi.fn(async () => ({ ok: true as const, value: view(true) }))
  const cache = createHeavyStatusCache({ ttlMs: HEAVY_HEALTH_TTL_MS, now: () => clock, load })
  expect(await cache.read('freellmapi')).toEqual({ ok: true, value: view(true) })
  expect(cache.peek('freellmapi')?.health.ok).toBe(true)
  clock = HEAVY_HEALTH_TTL_MS - 1
  await cache.read('freellmapi')
  expect(load).toHaveBeenCalledTimes(1)
  clock = HEAVY_HEALTH_TTL_MS
  await cache.read('freellmapi')
  expect(load).toHaveBeenCalledTimes(2)
})

it('force bypasses the cache and invalidate drops entries', async () => {
  const clock = 0
  const load = vi.fn(async () => ({ ok: true as const, value: view(true) }))
  const cache = createHeavyStatusCache({ now: () => clock, load })
  await cache.read('freellmapi')
  await cache.read('freellmapi', { force: true })
  expect(load).toHaveBeenCalledTimes(2)
  cache.invalidate('freellmapi')
  expect(cache.peek('freellmapi')).toBeUndefined()
  await cache.read('freellmapi')
  cache.invalidate()
  expect(cache.peek('freellmapi')).toBeUndefined()
})

it('shares one in-flight load between concurrent readers', async () => {
  let release: (() => void) | undefined
  const load = vi.fn(() => new Promise<HeavyRpcResult<HeavyStatusView>>((resolve) => {
    release = () => resolve({ ok: true, value: view(true) })
  }))
  const cache = createHeavyStatusCache({ load })
  const first = cache.read('freellmapi')
  const second = cache.read('freellmapi')
  release?.()
  expect(await first).toEqual(await second)
  expect(load).toHaveBeenCalledTimes(1)
})

it('fails soft: a refused probe stores nothing and carries the message', async () => {
  const cache = createHeavyStatusCache({ load: async () => ({ ok: false, message: 'gateway responded 503' }) })
  expect(await cache.read('freellmapi')).toEqual({ ok: false, message: 'gateway responded 503' })
  expect(cache.peek('freellmapi')).toBeUndefined()
})

it('fails soft: a rejected load becomes a displayable message', async () => {
  const cache = createHeavyStatusCache({
    load: async () => { throw new Error('network down') },
  })
  expect(await cache.read('freellmapi')).toEqual({ ok: false, message: 'network down' })
  expect(cache.peek('freellmapi')).toBeUndefined()
})
