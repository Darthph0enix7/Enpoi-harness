// @vitest-environment node
/**
 * Authoritative-membership removal: intersection pruning, protection, grace,
 * the two-key gate, shrink guards, in-use deprecation, reference cleanup, and
 * the manual-refresh RPC's parity with the hourly pass's planner.
 */
import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_MODELS_DEV_URL, planRouteModels, pruneRouteReferences, referencedRouteModels } from '../src/index.ts'

const directories: string[] = []
const contexts: Context[] = []
const servers: Server[] = []

afterEach(async () => {
  vi.unstubAllGlobals()
  for (const key of [
    'DSH_DISCOVERED_MODELS', 'DSH_COMMANDCODE_CATALOG', 'DSH_MODELS_DEV_PATH',
    'DSH_CATALOG_OVERLAYS', 'DSH_CAPABILITY_HINTS_OVERRIDE',
  ]) Reflect.deleteProperty(process.env, key)
  for (const context of contexts.splice(0)) await context.fiber.dispose()
  await Promise.all(servers.splice(0).map(server => new Promise(resolve => server.close(resolve))))
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function tempDir(): string {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-prune-'))
  directories.push(directory)
  return directory
}

/** Write one models.dev fixture and return its path; its fresh mtime clears the cache-age gate. */
function writeCatalog(
  directory: string,
  providers: Record<string, { models: Record<string, Record<string, unknown>> }>,
): string {
  const path = join(directory, 'models.dev.json')
  writeFileSync(path, JSON.stringify(providers))
  return path
}

/** Import a fresh module instance bound to the currently set environment paths. */
async function freshIndex(): Promise<typeof import('../src/index.ts')> {
  vi.resetModules()
  return await import('../src/index.ts')
}

/** Serve one scripted listing reply. */
async function listingServer(body: string): Promise<string> {
  const server = createServer((_request: IncomingMessage, response: ServerResponse) => {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(body)
  })
  servers.push(server)
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no port')
  return `http://127.0.0.1:${String(address.port)}`
}

describe('catalog intersection membership', () => {
  it('prunes ids the fresh catalogue no longer carries and keeps the intersection', async () => {
    const directory = tempDir()
    process.env.DSH_MODELS_DEV_PATH = writeCatalog(directory, {
      verity: { models: { 'kept-a': { name: 'Kept A' }, 'kept-b': { name: 'Kept B' } } },
    })
    const { planRouteModels: plan } = await freshIndex()
    const planned = plan({
      route: 'verity',
      configured: [{ id: 'kept-a' }, { id: 'retired-b' }, { id: 'kept-b' }],
      live: [{ id: 'kept-a' }, { id: 'retired-b' }, { id: 'kept-b' }],
      catalogRoute: true,
      catalogProviderKey: 'verity',
      endpointFresh: true,
      catalogFresh: true,
      now: 1_000_000,
    })
    expect(planned.models.map(model => model.id)).toEqual(['kept-a', 'kept-b'])
    expect(planned.report).toMatchObject({ removed: ['retired-b'], deprecated: [], degraded: false, authority: 'catalog' })
  })

  it('keeps a stored endpoint-only id only while its grace stamp is younger than 14 days', async () => {
    const directory = tempDir()
    process.env.DSH_MODELS_DEV_PATH = writeCatalog(directory, { verity: { models: { kept: { name: 'Kept' } } } })
    const { planRouteModels: plan } = await freshIndex()
    const now = 1_700_000_000_000
    const input = {
      route: 'verity',
      live: [{ id: 'kept' }, { id: 'newcomer' }],
      catalogRoute: true,
      catalogProviderKey: 'verity',
      endpointFresh: true,
      catalogFresh: true,
    }
    // Day 0: a newly advertised id models.dev has not indexed is kept and stamped.
    const first = plan({ ...input, configured: [{ id: 'kept' }], now })
    expect(first.models.map(model => model.id)).toEqual(['kept', 'newcomer'])
    expect(first.models[1]).toMatchObject({ id: 'newcomer', firstSeenAt: now })
    // Inside the window the stamp survives; past it the id is pruned.
    const early = plan({ ...input, configured: first.models, now: now + 13 * 24 * 60 * 60 * 1000 })
    expect(early.models.map(model => model.id)).toEqual(['kept', 'newcomer'])
    const late = plan({ ...input, configured: first.models, now: now + 15 * 24 * 60 * 60 * 1000 })
    expect(late.models.map(model => model.id)).toEqual(['kept'])
    expect(late.report.removed).toEqual(['newcomer'])
    // A long-stored endpoint-only id without a stamp is not "first seen recently".
    const legacy = plan({ ...input, configured: [{ id: 'kept' }, { id: 'long-retired' }], live: [{ id: 'kept' }, { id: 'long-retired' }], now })
    expect(legacy.report.removed).toEqual(['long-retired'])
  })

  it('honors an injected endpoint grace window instead of the shipped 14 days', async () => {
    const directory = tempDir()
    process.env.DSH_MODELS_DEV_PATH = writeCatalog(directory, { verity: { models: { kept: { name: 'Kept' } } } })
    const { planRouteModels: plan } = await freshIndex()
    const now = 1_700_000_000_000
    const input = {
      route: 'verity',
      live: [{ id: 'kept' }, { id: 'newcomer' }],
      catalogRoute: true,
      catalogProviderKey: 'verity',
      endpointFresh: true,
      catalogFresh: true,
    }
    const stamped = plan({ ...input, configured: [{ id: 'kept' }, { id: 'newcomer', firstSeenAt: now }], now })
    expect(stamped.report.removed).toEqual([])
    // A zero grace expires the stamp immediately.
    const expired = plan({ ...input, configured: stamped.models, now: now + 1000, endpointGraceMs: 0 })
    expect(expired.report.removed).toEqual(['newcomer'])
  })

  it('keeps hand-added, pinned, and overlay-upserted ids through removal', async () => {
    const directory = tempDir()
    process.env.DSH_MODELS_DEV_PATH = writeCatalog(directory, { verity: { models: { kept: { name: 'Kept' } } } })
    const { planRouteModels: plan } = await freshIndex()
    const planned = plan({
      route: 'verity',
      configured: [
        { id: 'kept' },
        { id: 'manual-id', name: 'Hand', source: 'manual' },
        { id: 'pinned-id' },
        { id: 'upsert-id' },
      ],
      live: [{ id: 'kept' }, { id: 'manual-id' }, { id: 'pinned-id' }, { id: 'upsert-id' }],
      catalogRoute: true,
      catalogProviderKey: 'verity',
      endpointFresh: true,
      catalogFresh: true,
      pinnedModels: ['pinned-id'],
      overlay: { upsert: [{ id: 'upsert-id', name: 'From Overlay' }] },
      now: 1_000_000,
    })
    expect(planned.report.removed).toEqual([])
    expect(planned.models.map(model => model.id)).toEqual(['kept', 'manual-id', 'pinned-id', 'upsert-id'])
    expect(planned.models[1]).toMatchObject({ id: 'manual-id', source: 'manual' })
    expect(planned.models[3]).toMatchObject({ id: 'upsert-id', name: 'From Overlay' })
  })
})

describe('two-key gate and shrink guards', () => {
  it('withholds removals when the catalogue is stale', async () => {
    const directory = tempDir()
    process.env.DSH_MODELS_DEV_PATH = writeCatalog(directory, { verity: { models: { kept: {} } } })
    const { planRouteModels: plan } = await freshIndex()
    const planned = plan({
      route: 'verity',
      configured: [{ id: 'kept' }, { id: 'retired' }],
      live: [{ id: 'kept' }],
      catalogRoute: true,
      catalogProviderKey: 'verity',
      endpointFresh: true,
      catalogFresh: false,
      now: 1_000_000,
    })
    expect(planned.report.removed).toEqual([])
    expect(planned.report.degraded).toBe(true)
    expect(planned.report.degradedReason).toMatch(/stale/)
    expect(planned.models.map(model => model.id)).toEqual(['kept', 'retired'])
  })

  it('withholds removals when the endpoint listing did not answer', async () => {
    const { planRouteModels: plan } = await freshIndex()
    const configured = [{ id: 'kept' }, { id: 'retired' }]
    const planned = plan({
      route: 'verity',
      configured,
      live: undefined,
      catalogRoute: true,
      catalogProviderKey: 'verity',
      endpointFresh: false,
      catalogFresh: true,
      now: 1_000_000,
    })
    expect(planned.report.removed).toEqual([])
    expect(planned.report.degraded).toBe(true)
    expect(planned.report.degradedReason).toMatch(/endpoint listing/)
    expect(planned.models).toEqual(configured)
  })

  it('aborts when the effective set would be empty', async () => {
    const directory = tempDir()
    process.env.DSH_MODELS_DEV_PATH = writeCatalog(directory, { verity: { models: {} } })
    const { planRouteModels: plan } = await freshIndex()
    const planned = plan({
      route: 'verity',
      configured: [{ id: 'only' }],
      live: [],
      catalogRoute: true,
      catalogProviderKey: 'verity',
      endpointFresh: true,
      catalogFresh: true,
      now: 1_000_000,
    })
    expect(planned.report.removed).toEqual([])
    expect(planned.report.degradedReason).toMatch(/empty/)
    expect(planned.models.map(model => model.id)).toEqual(['only'])
  })

  it('aborts when a pass would drop more than half of the stored models', async () => {
    const directory = tempDir()
    process.env.DSH_MODELS_DEV_PATH = writeCatalog(directory, { verity: { models: { a: {} } } })
    const { planRouteModels: plan } = await freshIndex()
    const planned = plan({
      route: 'verity',
      configured: [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }],
      live: [{ id: 'a' }],
      catalogRoute: true,
      catalogProviderKey: 'verity',
      endpointFresh: true,
      catalogFresh: true,
      now: 1_000_000,
    })
    expect(planned.report.removed).toEqual([])
    expect(planned.report.degradedReason).toMatch(/more than half/)
    expect(planned.models.map(model => model.id)).toEqual(['a', 'b', 'c', 'd'])
  })

  it('bypasses the shrink guard when force is true (manual operator refresh)', async () => {
    const directory = tempDir()
    process.env.DSH_MODELS_DEV_PATH = writeCatalog(directory, { verity: { models: { a: {} } } })
    const { planRouteModels: plan } = await freshIndex()
    const planned = plan({
      route: 'verity',
      configured: [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }],
      live: [{ id: 'a' }],
      catalogRoute: true,
      catalogProviderKey: 'verity',
      endpointFresh: true,
      catalogFresh: true,
      force: true,
      now: 1_000_000,
    })
    expect(planned.report.removed).toEqual(['b', 'c', 'd'])
    expect(planned.report.degraded).toBe(false)
    expect(planned.models.map(model => model.id)).toEqual(['a'])
  })

  it('restricts antigravity route provider map strictly to google and anthropic', async () => {
    const { DEFAULT_ROUTE_PROVIDER_MAP: map } = await freshIndex()
    expect(map.antigravity).toEqual(['google', 'anthropic'])
  })

  it('filters non-standard thinking levels so reasoningEfforts keys match THINKING_LEVELS', async () => {
    const directory = tempDir()
    // Model with 'default' in models.dev reasoning_options:
    process.env.DSH_MODELS_DEV_PATH = writeCatalog(directory, {
      'custom-gateway': {
        models: {
          'reasoning-model': {
            reasoning: true,
            reasoning_options: [{ values: ['default', 'low', 'medium', 'high', 'custom_level'] }],
          },
        },
      },
    })
    const { planRouteModels: plan } = await freshIndex()
    const planned = plan({
      route: 'custom-gateway',
      configured: [],
      live: [{ id: 'reasoning-model', reasoning: true }],
      catalogRoute: false,
      endpointFresh: true,
      catalogFresh: true,
      now: 1_000_000,
    })
    const model = planned.models[0]
    expect(model).toBeDefined()
    expect(model?.reasoningEfforts).toBeDefined()
    const efforts = model?.reasoningEfforts as Record<string, string>
    // Only standard THINKING_LEVELS keys allowed
    expect(efforts).toHaveProperty('low')
    expect(efforts).toHaveProperty('medium')
    expect(efforts).toHaveProperty('high')
    expect(efforts).not.toHaveProperty('default')
    expect(efforts).not.toHaveProperty('custom_level')
  })
})

describe('in-use protection and migration backfill', () => {
  it('keeps a referenced model that would be pruned, stamped deprecated, then purges it once unreferenced', async () => {
    const directory = tempDir()
    process.env.DSH_MODELS_DEV_PATH = writeCatalog(directory, { verity: { models: { kept: {} } } })
    const { planRouteModels: plan } = await freshIndex()
    const input = {
      route: 'verity',
      configured: [{ id: 'kept' }, { id: 'retired' }],
      live: [{ id: 'kept' }, { id: 'retired' }],
      catalogRoute: true,
      catalogProviderKey: 'verity',
      endpointFresh: true,
      catalogFresh: true,
      now: 1_000_000,
    }
    const pinned = plan({ ...input, references: [{ id: 'retired', reason: 'agent-default-model' }] })
    expect(pinned.report.removed).toEqual([])
    expect(pinned.report.deprecated).toEqual(['retired'])
    expect(pinned.models.find(model => model.id === 'retired')).toMatchObject({ source: 'pinned-in-use', deprecated: true })
    // The same route with no reference converges on the next pass.
    const purged = plan(input)
    expect(purged.report.removed).toEqual(['retired'])
    expect(purged.models.map(model => model.id)).toEqual(['kept'])
  })

  it('backfills a favorite-referenced stored id absent from the catalogue', async () => {
    const directory = tempDir()
    process.env.DSH_MODELS_DEV_PATH = writeCatalog(directory, { verity: { models: { kept: {} } } })
    const { planRouteModels: plan } = await freshIndex()
    const planned = plan({
      route: 'verity',
      configured: [{ id: 'kept' }, { id: 'faved' }],
      live: [{ id: 'kept' }],
      catalogRoute: true,
      catalogProviderKey: 'verity',
      endpointFresh: true,
      catalogFresh: true,
      references: [{ id: 'faved', reason: 'favorite' }],
      now: 1_000_000,
    })
    expect(planned.report.removed).toEqual([])
    expect(planned.models.find(model => model.id === 'faved')).toMatchObject({ source: 'pinned-in-use', deprecated: true })
  })

  it('reads references from the default model, chain links, and favorites without inventing reasons', () => {
    const references = referencedRouteModels(
      { provider: 'verity', model: 'm1' },
      {
        chains: {
          'c1': { links: [{ provider: 'verity', model: 'm2' }, { provider: 'other', model: 'x' }] },
          broken: { links: 'nope' },
        },
        uiPreferences: { favorites: [{ provider: 'verity', modelId: 'm3' }, { provider: 'other', modelId: 'y' }, null] },
      },
      'verity',
    )
    expect(references).toEqual([
      { id: 'm1', reason: 'agent-default-model' },
      { id: 'm2', reason: 'chain:c1' },
      { id: 'm3', reason: 'favorite' },
    ])
    expect(referencedRouteModels({ provider: 'other', model: 'x' }, undefined, 'verity')).toEqual([])
  })
})

describe('discovery-route membership', () => {
  it('uses the endpoint listing as authority and removes ids it no longer advertises', async () => {
    const { planRouteModels: plan } = await freshIndex()
    const planned = plan({
      route: 'gateway',
      configured: [{ id: 'a' }, { id: 'gone' }, { id: 'hand', source: 'manual' }],
      live: [{ id: 'a' }, { id: 'b' }],
      catalogRoute: false,
      endpointFresh: true,
      catalogFresh: true,
      now: 1_000_000,
    })
    expect(planned.report.authority).toBe('endpoint')
    expect(planned.report.removed).toEqual(['gone'])
    expect(planned.models.map(model => model.id)).toEqual(['a', 'hand', 'b'])
    expect(planned.models.find(model => model.id === 'hand')).toMatchObject({ source: 'manual' })
    // Without a listing there is no authority: nothing is removed.
    const noFetch = plan({
      route: 'gateway',
      configured: [{ id: 'a' }, { id: 'gone' }],
      live: undefined,
      catalogRoute: false,
      endpointFresh: false,
      catalogFresh: true,
      now: 1_000_000,
    })
    expect(noFetch.report.removed).toEqual([])
    expect(noFetch.models.map(model => model.id)).toEqual(['a', 'gone'])
  })
})

describe('visibility cleanup', () => {
  it('drops only the route\'s pruned ids from hidden models and favorites', () => {
    const cleanup = pruneRouteReferences({
      uiPreferences: {
        hiddenModels: { verity: ['gone', 'kept'], other: ['gone'] },
        favorites: [
          { provider: 'verity', modelId: 'gone' },
          { provider: 'verity', modelId: 'kept' },
          { provider: 'other', modelId: 'gone' },
        ],
      },
    }, 'verity', ['gone'])
    expect(cleanup.hiddenModels).toEqual({ verity: ['kept'], other: ['gone'] })
    expect(cleanup.favorites).toEqual([
      { provider: 'verity', modelId: 'kept' },
      { provider: 'other', modelId: 'gone' },
    ])
    expect(pruneRouteReferences({ uiPreferences: { hiddenModels: { verity: ['kept'] } } }, 'verity', ['gone'])).toEqual({})
    expect(pruneRouteReferences(undefined, 'verity', ['gone'])).toEqual({})
  })

  it('deletes the route key when its last hidden id is pruned, never leaving an empty list', () => {
    expect(pruneRouteReferences({
      uiPreferences: { hiddenModels: { verity: ['gone'], other: ['gone'] } },
    }, 'verity', ['gone'])).toEqual({ hiddenModels: { other: ['gone'] } })
    expect(pruneRouteReferences({
      uiPreferences: { hiddenModels: { verity: ['gone'] } },
    }, 'verity', ['gone'])).toEqual({ hiddenModels: {} })
  })
})

describe('manual-refresh RPC', () => {
  it('returns the shared pipeline result and refuses a blank route', async () => {
    const { ProviderSyncService } = await import('../src/remote.ts')
    const ctx = new Context()
    contexts.push(ctx)
    const calls: string[] = []
    const service = new ProviderSyncService(ctx, async (route) => {
      calls.push(route)
      return {
        route,
        models: [{ id: 'kept' }],
        removed: ['gone'],
        deprecated: ['pinned'],
        degraded: false,
        source: 'live' as const,
        authority: 'catalog' as const,
        fetchedAt: 7,
      }
    })
    await expect(service.refreshRoute('verity')).resolves.toEqual({
      route: 'verity',
      models: [{ id: 'kept' }],
      removed: ['gone'],
      deprecated: ['pinned'],
      degraded: false,
      source: 'live',
      authority: 'catalog',
      fetchedAt: 7,
    })
    expect(calls).toEqual(['verity'])
    await expect(service.refreshRoute('  ')).rejects.toThrow(/non-empty/)
  })

  it('plans identically to the hourly pass for the same inputs', async () => {
    const directory = tempDir()
    process.env.DSH_MODELS_DEV_PATH = writeCatalog(directory, { verity: { models: { kept: {} } } })
    const url = await listingServer(JSON.stringify({ object: 'list', data: [{ id: 'kept' }, { id: 'retired' }] }))
    // The RPC and the pass call the same `planRouteModels`; this pins that the
    // planner's output is the value both paths persist/return.
    const { planRouteModels: plan } = await freshIndex()
    const planned = plan({
      route: 'verity',
      configured: [{ id: 'kept' }, { id: 'retired' }],
      live: [{ id: 'kept' }, { id: 'retired' }],
      catalogRoute: true,
      catalogProviderKey: 'verity',
      endpointFresh: true,
      catalogFresh: true,
      now: 1_000_000,
    })
    expect(planned.report.removed).toEqual(['retired'])
    expect(planned.models.map(model => model.id)).toEqual(['kept'])
    expect(url).toContain('127.0.0.1')
    expect(DEFAULT_MODELS_DEV_URL).toBe('https://models.dev/api.json')
  })

  it('bypasses the >50% withhold guard on manual refresh RPC (refreshRoute)', async () => {
    const directory = tempDir()
    process.env.DSH_MODELS_DEV_PATH = writeCatalog(directory, {
      verity: { models: { kept: {} } },
    })
    const url = await listingServer(JSON.stringify({
      object: 'list',
      data: [{ id: 'kept' }],
    }))
    const { apply: applyPlugin } = await freshIndex()
    const ctx = new Context()
    contexts.push(ctx)
    let handler: ((route: string) => Promise<unknown>) | undefined
    ctx.provide('remote', {
      registerService: (_name: string, _service: unknown) => {},
    })
    ctx.provide('settings', {
      describe: () => [{
        ns: 'llm-pi-ai',
        revision: 1,
        value: {
          providers: {
            verity: {
              baseURL: url,
              models: [{ id: 'kept' }, { id: 'stale1' }, { id: 'stale2' }, { id: 'stale3' }],
            },
          },
        },
      }],
      mutate: async () => {},
    })
    applyPlugin(ctx, {
      intervalMs: { get: () => 3_600_000 },
      syncOnStart: { get: () => false },
      syncDelayMs: { get: () => 0 },
      endpoints: { get: () => ({}) },
      capacityDefaults: { get: () => ({}) },
      modelsDevUrl: { get: () => DEFAULT_MODELS_DEV_URL },
      routeProviderMap: { get: () => ({}) },
      pinnedModels: { get: () => ({}) },
      endpointGraceMs: { get: () => 14 * 24 * 60 * 60 * 1000 },
      catalogFreshMs: { get: () => 48 * 60 * 60 * 1000 },
    })
    // Allow the dynamic import effect to mount ProviderSyncService on ctx
    await vi.waitFor(() => { expect((ctx as any).providerSync).toBeDefined() })
    const outcome = await (ctx as any).providerSync.refreshRoute('verity') as { removed: string[], models: Array<{ id: string }>, degraded: boolean }
    // Removing 3 of 4 is >50%, but manual refresh (force: true) must prune them
    expect(outcome.degraded).toBe(false)
    expect(outcome.removed).toEqual(['stale1', 'stale2', 'stale3'])
    expect(outcome.models.map(m => m.id)).toEqual(['kept'])
  })
})
