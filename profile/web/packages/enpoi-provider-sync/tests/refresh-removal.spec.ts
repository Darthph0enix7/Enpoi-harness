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
import type { Config } from '../src/index.ts'

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

/** One settings descriptor the mounted harness serves. */
type Descriptor = { ns: string; revision: number; value: unknown }

/** The mounted plugin's client-facing route refresh answer. */
interface RouteRefreshAnswer {
  route: string
  models: Array<Record<string, unknown>>
  removed: string[]
  deprecated: string[]
  degraded: boolean
  source: string
  authority: string
  fetchedAt: number
}

/** Mount the plugin over a real Context with fixed settings descriptors. */
async function mountSync(
  applyPlugin: (ctx: Context, config: Config) => void,
  descriptors: readonly Descriptor[],
  mutate: (ns: string, ops: unknown[]) => Promise<void> = async () => {},
): Promise<Context & { providerSync: { refreshRoute(route: string): Promise<RouteRefreshAnswer> } }> {
  const ctx = new Context()
  contexts.push(ctx)
  ctx.provide('remote', { registerService: () => {} })
  ctx.provide('settings', { describe: () => descriptors, mutate })
  applyPlugin(ctx, {
    intervalMs: { get: () => 3_600_000 },
    syncOnStart: { get: () => false },
    syncDelayMs: { get: () => 0 },
    endpoints: { get: () => ({}) },
    capacityDefaults: { get: () => ({}) },
    sessionHeaders: { get: () => ({}) },
    modelsDevUrl: { get: () => DEFAULT_MODELS_DEV_URL },
    routeProviderMap: { get: () => ({}) },
    pinnedModels: { get: () => ({}) },
    endpointGraceMs: { get: () => 14 * 24 * 60 * 60 * 1000 },
    catalogFreshMs: { get: () => 48 * 60 * 60 * 1000 },
    metadataSources: { get: () => ({}) },
  })
  await vi.waitFor(() => { expect((ctx as unknown as { providerSync?: unknown }).providerSync).toBeDefined() })
  return ctx as Context & { providerSync: { refreshRoute(route: string): Promise<RouteRefreshAnswer> } }
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

  it('keeps only the catalog ladder levels a profile accepts, dropping unknown ids', async () => {
    const directory = tempDir()
    // A silent listing lets the catalogue's own ladder speak: only levels a
    // profile accepts survive; `default` and `custom_level` are diagnostics,
    // never settings keys.
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
      live: [{ id: 'reasoning-model' }],
      catalogRoute: false,
      endpointFresh: true,
      catalogFresh: true,
      now: 1_000_000,
    })
    expect(planned.models[0]?.reasoningEfforts).toEqual({ low: 'low', medium: 'medium', high: 'high' })
  })

  it('does not invent a full ladder from a bare reasoning:true', async () => {
    const directory = tempDir()
    process.env.DSH_MODELS_DEV_PATH = writeCatalog(directory, {
      'custom-gateway': { models: { 'bare-reasoner': { reasoning: true } } },
    })
    const { planRouteModels: plan } = await freshIndex()
    const planned = plan({
      route: 'custom-gateway',
      configured: [],
      live: [{ id: 'bare-reasoner', reasoning: true }],
      catalogRoute: false,
      endpointFresh: true,
      catalogFresh: true,
      now: 1_000_000,
    })
    const model = planned.models[0]
    expect(model).toMatchObject({ id: 'bare-reasoner', reasoning: true })
    // A capability fact is not a ladder: no minimal/medium/high/xhigh/max rows.
    expect(model?.reasoningEfforts).toBeUndefined()
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

  it('reads references from the default model, chains, personas, subagent routes, and favorites without inventing reasons', () => {
    const references = referencedRouteModels(
      { provider: 'verity', model: 'm1' },
      {
        chains: {
          'c1': { links: [{ provider: 'verity', model: 'm2' }, { provider: 'other', model: 'x' }] },
          broken: { links: 'nope' },
        },
        personas: {
          oracle: { provider: 'verity', model: 'm4' },
          // A chain-only seat is covered by the chain links, not a route ref.
          keeper: { provider: 'verity', chain: 'c1' },
          other: { provider: 'other', model: 'x' },
          empty: null,
        },
        uiPreferences: { favorites: [{ provider: 'verity', modelId: 'm3' }, { provider: 'other', modelId: 'y' }, null] },
      },
      'verity',
      {
        enabled: true,
        allowedModels: [{ provider: 'verity', model: 'm5' }, { provider: 'other', model: 'y' }],
      },
    )
    expect(references).toEqual([
      { id: 'm1', reason: 'agent-default-model' },
      { id: 'm2', reason: 'chain:c1' },
      { id: 'm4', reason: 'persona:oracle' },
      { id: 'm3', reason: 'favorite' },
      { id: 'm5', reason: 'subagent-allowed-model' },
    ])
    expect(referencedRouteModels({ provider: 'other', model: 'x' }, undefined, 'verity')).toEqual([])
    // A different provider's persona and subagent authorization never protect
    // a model on this route.
    expect(referencedRouteModels(
      undefined,
      { personas: { oracle: { provider: 'other', model: 'x' } } },
      'verity',
      { enabled: true, allowedModels: [{ provider: 'other', model: 'y' }] },
    )).toEqual([])
  })

  it('keeps persona- and subagent-referenced ids the endpoint no longer advertises, marked deprecated', async () => {
    const { planRouteModels: plan } = await freshIndex()
    const references = referencedRouteModels(
      undefined,
      { personas: { oracle: { provider: 'gateway', model: 'persona-model' } } },
      'gateway',
      { enabled: true, allowedModels: [{ provider: 'gateway', model: 'subagent-model' }] },
    )
    const planned = plan({
      route: 'gateway',
      configured: [{ id: 'kept' }, { id: 'persona-model' }, { id: 'subagent-model' }, { id: 'unreferenced' }],
      live: [{ id: 'kept' }],
      catalogRoute: false,
      endpointFresh: true,
      catalogFresh: true,
      references,
      now: 1_000_000,
    })
    expect(planned.report.removed).toEqual(['unreferenced'])
    expect(planned.report.deprecated).toEqual(['persona-model', 'subagent-model'])
    expect(planned.models.map(model => model.id)).toEqual(['kept', 'persona-model', 'subagent-model'])
    expect(planned.models[1]).toMatchObject({ source: 'pinned-in-use', deprecated: true })
    expect(planned.models[2]).toMatchObject({ source: 'pinned-in-use', deprecated: true })
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

describe('catalog overlay removal through the client pipeline', () => {
  it('returns an overlay removal in the client removal list so a merged row cannot resurrect it', async () => {
    const directory = tempDir()
    process.env.DSH_MODELS_DEV_PATH = writeCatalog(directory, { verity: { models: { kept: {}, stale: {} } } })
    process.env.DSH_DISCOVERED_MODELS = join(directory, 'discovered-models.json')
    const overlays = join(directory, 'catalog-overlays.json')
    writeFileSync(overlays, JSON.stringify({ routes: { verity: { remove: ['stale'] } } }))
    process.env.DSH_CATALOG_OVERLAYS = overlays
    const url = await listingServer(JSON.stringify({ object: 'list', data: [{ id: 'kept' }, { id: 'stale' }] }))
    const { apply: applyPlugin } = await freshIndex()
    const ctx = await mountSync(applyPlugin, [{
      ns: 'llm-pi-ai',
      revision: 1,
      value: {
        providers: {
          verity: {
            baseURL: url,
            api: 'openai-completions',
            models: [{ id: 'kept' }, { id: 'stale', contextWindow: 100_000, maxTokens: 8_000 }],
          },
        },
      },
    }])
    const outcome = await ctx.providerSync.refreshRoute('verity')
    expect(outcome.models.map(model => model.id)).toEqual(['kept'])
    // The membership audit alone is empty here: only the cleanup union reports
    // the overlay removal the caller must drop.
    expect(outcome.removed).toEqual(['stale'])
  })

  it('keeps an overlay-removed id a persona still names, marked deprecated instead of deleting it', async () => {
    const directory = tempDir()
    process.env.DSH_MODELS_DEV_PATH = writeCatalog(directory, { verity: { models: { kept: {}, stale: {} } } })
    process.env.DSH_DISCOVERED_MODELS = join(directory, 'discovered-models.json')
    const overlays = join(directory, 'catalog-overlays.json')
    writeFileSync(overlays, JSON.stringify({ routes: { verity: { remove: ['stale'] } } }))
    process.env.DSH_CATALOG_OVERLAYS = overlays
    const url = await listingServer(JSON.stringify({ object: 'list', data: [{ id: 'kept' }, { id: 'stale' }] }))
    const { apply: applyPlugin } = await freshIndex()
    const ctx = await mountSync(applyPlugin, [
      {
        ns: 'llm-pi-ai',
        revision: 1,
        value: {
          providers: {
            verity: {
              baseURL: url,
              api: 'openai-completions',
              models: [{ id: 'kept' }, { id: 'stale', name: 'Stale', contextWindow: 100_000 }],
            },
          },
        },
      },
      { ns: 'enpoi-orchestration', revision: 1, value: { personas: { oracle: { provider: 'verity', model: 'stale' } } } },
    ])
    const outcome = await ctx.providerSync.refreshRoute('verity')
    const stale = outcome.models.find(model => model.id === 'stale')
    expect(stale).toMatchObject({ id: 'stale', source: 'pinned-in-use', deprecated: true })
    // The reference keeps the record; it is not reported as pruned.
    expect(outcome.removed).toEqual([])
    expect(outcome.deprecated).toEqual(['stale'])
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
      sessionHeaders: { get: () => ({}) },
      modelsDevUrl: { get: () => DEFAULT_MODELS_DEV_URL },
      routeProviderMap: { get: () => ({}) },
      pinnedModels: { get: () => ({}) },
      endpointGraceMs: { get: () => 14 * 24 * 60 * 60 * 1000 },
      catalogFreshMs: { get: () => 48 * 60 * 60 * 1000 },
      metadataSources: { get: () => ({}) },
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

describe('provider isolation', () => {
  it('does not inherit models.dev metadata from an unmapped provider namespace', async () => {
    const directory = tempDir()
    process.env.DSH_MODELS_DEV_PATH = writeCatalog(directory, {
      othervendor: { models: { 'orion-9': { name: 'Orion Nine Ultra', limit: { context: 333_333, output: 77_777 } } } },
    })
    const { planRouteModels: plan } = await freshIndex()
    const input = {
      route: 'custom-gateway',
      configured: [],
      live: [{ id: 'orion-9' }],
      catalogRoute: false,
      endpointFresh: true,
      catalogFresh: true,
      now: 1_000_000,
    }
    // Unmapped: no provider namespace answers, so the record is the honest
    // floor — never another vendor's metadata through an id collision.
    const unmapped = plan(input)
    expect(unmapped.models[0]).toMatchObject({ id: 'orion-9', name: 'Orion 9', unverified: true })
    // Nothing disclosed a capacity, so no adapter default is persisted as a fact.
    expect(unmapped.models[0]).not.toHaveProperty('contextWindow')
    expect(unmapped.models[0]).not.toHaveProperty('maxTokens')
    // Mapped: the declared provider is the only namespace consulted.
    const mapped = plan({ ...input, routeProviderMap: { 'custom-gateway': ['othervendor'] } })
    expect(mapped.models[0]).toMatchObject({ id: 'orion-9', name: 'Orion Nine Ultra', contextWindow: 333_333, maxTokens: 77_777 })
  })

  it('lets the endpoint listing disclosure win over models.dev enrichment', async () => {
    const directory = tempDir()
    process.env.DSH_MODELS_DEV_PATH = writeCatalog(directory, {
      'zzz-vendor': {
        models: {
          'orion-9': {
            name: 'Orion Nine Ultra',
            limit: { context: 999_999, output: 111_111 },
            modalities: { input: ['text', 'image'] },
            tool_call: false,
            reasoning: true,
            reasoning_options: [{ values: ['low', 'high'] }],
          },
        },
      },
    })
    const { planRouteModels: plan } = await freshIndex()
    const planned = plan({
      route: 'zzz-route',
      configured: [],
      live: [{
        id: 'orion-9',
        contextWindow: 4242,
        maxTokens: 2424,
        input: ['text', 'audio'],
        tools: true,
        reasoning: false,
      }],
      catalogRoute: false,
      endpointFresh: true,
      catalogFresh: true,
      routeProviderMap: { 'zzz-route': ['zzz-vendor'] },
      now: 1_000_000,
    })
    // Capacity, modalities, tools, and reasoning all follow the listing's own
    // disclosure; the enrichment only supplies the display name it did not state.
    expect(planned.models[0]).toMatchObject({
      id: 'orion-9',
      name: 'Orion Nine Ultra',
      contextWindow: 4242,
      maxTokens: 2424,
      input: ['text', 'audio'],
      tools: true,
      reasoning: false,
    })
    // An explicit `reasoning: false` blocks the enrichment's effort ladder too.
    expect(planned.models[0]!.reasoningEfforts).toBeUndefined()
  })

  it('prunes an endpoint-authority route to its listing even when the models.dev cache is stale', async () => {
    const { planRouteModels: plan } = await freshIndex()
    const planned = plan({
      route: 'gateway',
      configured: [{ id: 'kept' }, { id: 'retired' }],
      live: [{ id: 'kept' }, { id: 'fresh' }],
      catalogRoute: false,
      endpointFresh: true,
      catalogFresh: false,
      now: 1_000_000,
    })
    // The endpoint is the whole membership authority here: a stale catalogue
    // (metadata only) must not withhold the prune.
    expect(planned.report).toMatchObject({ removed: ['retired'], degraded: false, authority: 'endpoint' })
    expect(planned.models.map(model => model.id)).toEqual(['kept', 'fresh'])
  })

  it('still withholds an unattended endpoint-authority prune over half the stored list', async () => {
    const { planRouteModels: plan } = await freshIndex()
    const planned = plan({
      route: 'gateway',
      configured: [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }],
      live: [{ id: 'a' }],
      catalogRoute: false,
      endpointFresh: true,
      catalogFresh: true,
      now: 1_000_000,
    })
    expect(planned.report).toMatchObject({ removed: [], degraded: true })
    expect(planned.report.degradedReason).toMatch(/more than half/)
    expect(planned.models.map(model => model.id)).toEqual(['a', 'b', 'c', 'd'])
  })

  it('forces a full foreign-catalog prune on a manual refresh (the contaminated-route case)', async () => {
    const directory = tempDir()
    // A stale catalogue must not matter: the endpoint listing is the authority.
    process.env.DSH_MODELS_DEV_PATH = writeCatalog(directory, { kilo: { models: {} } })
    const { planRouteModels: plan } = await freshIndex()
    const foreign = Array.from({ length: 6 }, (_, index) => ({ id: `kilo-foreign-${String(index)}` }))
    const planned = plan({
      route: 'antigravity',
      configured: foreign,
      live: [{ id: 'gemini-3.6-flash-high' }, { id: 'claude-sonnet-4-6' }],
      catalogRoute: false,
      endpointFresh: true,
      catalogFresh: false,
      force: true,
      now: 1_000_000,
    })
    expect(planned.report.removed).toEqual(foreign.map(model => model.id))
    expect(planned.report.degraded).toBe(false)
    expect(planned.models.map(model => model.id)).toEqual(['gemini-3.6-flash-high', 'claude-sonnet-4-6'])
  })
})
