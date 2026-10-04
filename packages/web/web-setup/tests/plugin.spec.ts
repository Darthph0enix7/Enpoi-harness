/**
 * Plugin wiring: the `name`/`inject`/`Config`/`apply` function form mounts the
 * service with lazily read seams, and the seams actually reach the global
 * fetch and logger when no override is supplied.
 */
import { Context } from '@deepseek-ai/cordis'
import { expect, it, vi } from 'vitest'
import * as WebSetup from '../src/index.ts'
import { FakeEditor, webRow } from './fakes.ts'

it('mounts directly with no seams and reports an unappliable setup', async () => {
  const ctx = new Context()
  WebSetup.apply(ctx)
  const status = await ctx.webSetup.status()
  expect(status.searchProvider).toBeNull()
  expect(status.mounted).toEqual([])
  expect(status.credentials.EXA_API_KEY).toEqual({ configured: false, writable: false })
  const applied = await ctx.webSetup.applySetup({ search: { provider: 'exa' } })
  expect(applied.ok).toBe(false)
  expect(applied.pendingRestart?.ns).toBe('web-setup')
})

it('reads live seams lazily and reaches global fetch and the logger', async () => {
  const ctx = new Context()
  ctx.provide('configEditor', new FakeEditor([webRow()]))
  ctx.provide('credentials', {
    describe: async () => { throw new Error('vault down') },
    resolve: async () => undefined,
    set: async () => {},
    unset: async () => {},
  })
  WebSetup.apply(ctx)
  // The failing describe crosses the plugin's log closure.
  const status = await ctx.webSetup.status()
  expect(status.credentials.EXA_API_KEY).toEqual({ configured: false, writable: false })

  vi.stubGlobal('fetch', async () => new Response('{"results":[{}]}', { status: 200 }))
  try {
    // No `now` seam is supplied, so the default monotonic clock runs too.
    const result = await ctx.webSetup.validateProvider(
      { kind: 'search', provider: 'exa', apiKey: 'k' },
      new AbortController().signal,
    )
    expect(result).toMatchObject({ ok: true, status: 200, sourcesCount: 1 })
    expect(typeof result.latencyMs).toBe('number')
  } finally {
    vi.unstubAllGlobals()
  }
})
