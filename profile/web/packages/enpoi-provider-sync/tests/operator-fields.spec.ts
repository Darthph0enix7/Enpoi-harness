// @vitest-environment node
/**
 * Operator-only per-model declarations survive refresh and discovery merges:
 * `nativeFileInputs` and `compat` are statements about the deployment's own
 * gateway that no listing, registry, models.dev row, or installed catalog can
 * disclose, so a refresh must carry them by model id instead of replacing the
 * record wholesale — and an explicit removal (a pruned model, a deleted
 * field) must stay removed.
 */
import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_MODELS_DEV_URL, mergeConfiguredModels, planRouteModels } from '../src/index.ts'
import type { Config } from '../src/index.ts'

const directories: string[] = []
const contexts: Context[] = []
const servers: Server[] = []

afterEach(async () => {
  vi.unstubAllGlobals()
  for (const key of [
    'DSH_DISCOVERED_MODELS', 'DSH_MODELS_DEV_PATH', 'DSH_CATALOG_OVERLAYS', 'DSH_CAPABILITY_HINTS_OVERRIDE',
  ]) Reflect.deleteProperty(process.env, key)
  for (const context of contexts.splice(0)) await context.fiber.dispose()
  await Promise.all(servers.splice(0).map(server => new Promise(resolve => server.close(resolve))))
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

/** The operator's own native-file policy; a valid `nativeFileInputs` declaration. */
const NATIVE_FILE_INPUTS = {
  version: 1,
  encoder: 'openai-chat-input-audio',
  mime: ['audio/wav', 'audio/mpeg'],
  perFileBytes: 1_000_000,
  totalBytes: 4_000_000,
  maxPayloadBytes: 5_000_000,
  tokenReserve: { perFile: 16, perByte: 0.5 },
}

/** The operator's own wire-compatibility switches; note the `false` value is meaningful. */
const COMPAT = {
  supportsStore: true,
  supportsReasoningEffort: true,
  requiresThinkingAsText: false,
}

function tempDir(): string {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-operator-fields-'))
  directories.push(directory)
  return directory
}

/** Write one fresh models.dev fixture so the catalogue-age gate never matters. */
function writeCatalog(directory: string, providers: Record<string, unknown> = {}): string {
  const path = join(directory, 'models.dev.json')
  writeFileSync(path, JSON.stringify(providers))
  return path
}

/** Import a fresh module instance bound to the environment paths set by the test. */
async function freshIndex(): Promise<typeof import('../src/index.ts')> {
  vi.resetModules()
  return await import('../src/index.ts')
}

/** Serve one scripted listing reply and record every request path. */
async function listingServer(body: unknown): Promise<{ url: string, paths: string[] }> {
  const paths: string[] = []
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    paths.push(request.url ?? '')
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify(body))
  })
  servers.push(server)
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no port')
  return { url: `http://127.0.0.1:${String(address.port)}`, paths }
}

/** Fail models.dev refreshes loudly so the pass uses the fresh local fixture. */
function stubModelsDevOffline(): void {
  const realFetch = globalThis.fetch
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).startsWith('https://models.dev/')) return { ok: false, status: 503, json: async () => ({}) }
    return await realFetch(input, init)
  })
}

/** One captured settings mutation. */
interface CapturedMutation {
  ns: string
  ops: Array<{ op: string, path: string[], value: Array<Record<string, unknown>> }>
}

/** Mount the plugin over a real Context with one fixed settings document. */
async function mountSync(input: {
  providers: Record<string, Record<string, unknown>>
  endpoints?: Record<string, string>
  mutate?: (ns: string, ops: unknown[]) => Promise<void>
}): Promise<Context & { providerSync: { refreshRoutes(routes?: readonly string[]): Promise<{
  routes: Array<{ route: string, status: string, modelCount: number, removed: string[] }>
}> } }> {
  const ctx = new Context()
  contexts.push(ctx)
  ctx.provide('remote', { registerService: () => {} })
  ctx.provide('settings', {
    describe: () => [{ ns: 'llm-pi-ai', revision: 1, value: { providers: input.providers } }],
    mutate: input.mutate ?? (async () => {}),
  })
  const { apply } = await freshIndex()
  apply(ctx, {
    intervalMs: { get: () => 3_600_000 },
    syncOnStart: { get: () => false },
    syncDelayMs: { get: () => 0 },
    endpoints: { get: () => input.endpoints ?? {} },
    capacityDefaults: { get: () => ({}) },
    sessionHeaders: { get: () => ({}) },
    modelsDevUrl: { get: () => DEFAULT_MODELS_DEV_URL },
    routeProviderMap: { get: () => ({}) },
    pinnedModels: { get: () => ({}) },
    endpointGraceMs: { get: () => 14 * 24 * 60 * 60 * 1000 },
    catalogFreshMs: { get: () => 48 * 60 * 60 * 1000 },
    metadataSources: { get: () => ({}) },
  } as unknown as Config)
  await vi.waitFor(() => { expect((ctx as unknown as { providerSync?: unknown }).providerSync).toBeDefined() })
  return ctx as Context & { providerSync: { refreshRoutes(routes?: readonly string[]): Promise<{
    routes: Array<{ route: string, status: string, modelCount: number, removed: string[] }>
  }> } }
}

describe('operator-declared model fields', () => {
  it('keeps nativeFileInputs through a healthy endpoint refresh', async () => {
    const { planRouteModels: plan } = await freshIndex()
    const planned = plan({
      route: 'operator-route',
      configured: [{ id: 'kept', name: 'Kept', nativeFileInputs: NATIVE_FILE_INPUTS }],
      live: [{ id: 'kept', name: 'Kept (listed)', contextWindow: 128_000 }],
      catalogRoute: false,
      endpointFresh: true,
      catalogFresh: true,
      now: 1_000,
    })
    const kept = planned.models.find(model => model.id === 'kept')
    // The listing still refreshes the facts it discloses...
    expect(kept).toMatchObject({ id: 'kept', name: 'Kept (listed)', contextWindow: 128_000 })
    // ...while the operator's native-file policy rides along untouched.
    expect(kept?.nativeFileInputs).toEqual(NATIVE_FILE_INPUTS)
  })

  it('keeps nativeFileInputs through the degraded configured merge', async () => {
    const merged = mergeConfiguredModels(
      'operator-route',
      [{ id: 'kept', nativeFileInputs: NATIVE_FILE_INPUTS }],
      [{ id: 'kept', contextWindow: 128_000 }],
    )
    expect(merged.models[0]).toMatchObject({ id: 'kept', contextWindow: 128_000 })
    expect(merged.models[0]?.nativeFileInputs).toEqual(NATIVE_FILE_INPUTS)
  })

  it('persists nativeFileInputs across a full refresh pass', async () => {
    const listed = await listingServer({ object: 'list', data: [{ id: 'kept', context_length: 128_000 }] })
    const directory = tempDir()
    process.env.DSH_DISCOVERED_MODELS = join(directory, 'discovered-models.json')
    process.env.DSH_MODELS_DEV_PATH = writeCatalog(directory)
    stubModelsDevOffline()
    const mutations: CapturedMutation[] = []
    const ctx = await mountSync({
      providers: {
        'operator-route': {
          baseURL: listed.url,
          api: 'openai-completions',
          models: [{ id: 'kept', nativeFileInputs: NATIVE_FILE_INPUTS }],
        },
      },
      mutate: async (ns, ops) => { mutations.push({ ns, ops: ops as CapturedMutation['ops'] }) },
    })
    const answer = await ctx.providerSync.refreshRoutes(['operator-route'])
    expect(answer.routes[0]).toMatchObject({ route: 'operator-route', status: 'ok', modelCount: 1 })
    expect(mutations).toHaveLength(1)
    expect(mutations[0]?.ns).toBe('llm-pi-ai')
    expect(mutations[0]?.ops[0]?.path).toEqual(['providers', 'operator-route', 'models'])
    const persisted = mutations[0]!.ops[0]!.value.find(model => model.id === 'kept')
    expect(persisted?.nativeFileInputs).toEqual(NATIVE_FILE_INPUTS)
    expect(persisted?.contextWindow).toBe(128_000)
  })

  it('keeps compat through a healthy endpoint refresh', async () => {
    const { planRouteModels: plan } = await freshIndex()
    const planned = plan({
      route: 'operator-route',
      configured: [{ id: 'kept', compat: COMPAT }],
      live: [{ id: 'kept', tools: true }],
      catalogRoute: false,
      endpointFresh: true,
      catalogFresh: true,
      now: 1_000,
    })
    const kept = planned.models.find(model => model.id === 'kept')
    expect(kept).toMatchObject({ id: 'kept', tools: true })
    expect(kept?.compat).toEqual(COMPAT)
  })

  it('keeps compat through the degraded configured merge and persists it', async () => {
    const merged = mergeConfiguredModels('operator-route', [{ id: 'kept', compat: COMPAT }], [{ id: 'kept' }])
    expect(merged.models[0]?.compat).toEqual(COMPAT)

    const listed = await listingServer({ object: 'list', data: [{ id: 'kept' }] })
    const directory = tempDir()
    process.env.DSH_DISCOVERED_MODELS = join(directory, 'discovered-models.json')
    process.env.DSH_MODELS_DEV_PATH = writeCatalog(directory)
    stubModelsDevOffline()
    const mutations: CapturedMutation[] = []
    const ctx = await mountSync({
      providers: {
        'operator-route': { baseURL: listed.url, api: 'openai-completions', models: [{ id: 'kept', compat: COMPAT }] },
      },
      mutate: async (ns, ops) => { mutations.push({ ns, ops: ops as CapturedMutation['ops'] }) },
    })
    await ctx.providerSync.refreshRoutes(['operator-route'])
    expect(mutations).toHaveLength(1)
    expect(mutations[0]!.ops[0]!.value.find(model => model.id === 'kept')?.compat).toEqual(COMPAT)
  })

  it('does not invent nativeFileInputs or compat for a model that never declared them', async () => {
    const { planRouteModels: plan } = await freshIndex()
    const planned = plan({
      route: 'operator-route',
      configured: [{ id: 'kept' }],
      live: [{ id: 'kept', contextWindow: 128_000 }, { id: 'unknown-model' }],
      catalogRoute: false,
      endpointFresh: true,
      catalogFresh: true,
      now: 1_000,
    })
    for (const model of planned.models) {
      expect(model).not.toHaveProperty('nativeFileInputs')
      expect(model).not.toHaveProperty('compat')
    }
  })

  it('leaves an explicitly deleted field deleted when the entry is refreshed', async () => {
    const { planRouteModels: plan } = await freshIndex()
    // The operator removed `nativeFileInputs` from an entry that previously
    // declared one (only `compat` remains configured now).
    const planned = plan({
      route: 'operator-route',
      configured: [{ id: 'kept', compat: COMPAT }],
      live: [{ id: 'kept', contextWindow: 128_000 }],
      catalogRoute: false,
      endpointFresh: true,
      catalogFresh: true,
      now: 1_000,
    })
    const kept = planned.models.find(model => model.id === 'kept')
    expect(kept).not.toHaveProperty('nativeFileInputs')
    expect(kept?.compat).toEqual(COMPAT)
  })

  it('keeps an explicitly removed model removed, with its operator fields gone', async () => {
    const { planRouteModels: plan } = await freshIndex()
    const planned = plan({
      route: 'operator-route',
      configured: [
        { id: 'kept' },
        { id: 'pruned', nativeFileInputs: NATIVE_FILE_INPUTS, compat: COMPAT },
      ],
      live: [{ id: 'kept' }],
      catalogRoute: false,
      endpointFresh: true,
      catalogFresh: true,
      now: 1_000,
    })
    expect(planned.report.removed).toEqual(['pruned'])
    expect(planned.models.map(model => model.id)).toEqual(['kept'])
    expect(planned.models.some(model => model.nativeFileInputs !== undefined || model.compat !== undefined)).toBe(false)
  })

  it('honors an overlay removal over a model the endpoint still advertises', async () => {
    const { planRouteModels: plan } = await freshIndex()
    const planned = plan({
      route: 'operator-route',
      configured: [
        { id: 'kept' },
        { id: 'overlay-removed', nativeFileInputs: NATIVE_FILE_INPUTS },
      ],
      live: [{ id: 'kept' }, { id: 'overlay-removed' }],
      overlay: { remove: ['overlay-removed'] },
      catalogRoute: false,
      endpointFresh: true,
      catalogFresh: true,
      now: 1_000,
    })
    expect(planned.models.map(model => model.id)).toEqual(['kept'])
  })
})

describe('route baseURL precedence', () => {
  it('probes the configured profile baseURL instead of the shipped endpoint table', async () => {
    const profileEndpoint = await listingServer({ object: 'list', data: [{ id: 'from-profile' }] })
    const shippedEndpoint = await listingServer({ object: 'list', data: [{ id: 'from-shipped' }] })
    const directory = tempDir()
    process.env.DSH_DISCOVERED_MODELS = join(directory, 'discovered-models.json')
    process.env.DSH_MODELS_DEV_PATH = writeCatalog(directory)
    stubModelsDevOffline()
    const ctx = await mountSync({
      providers: {
        'operator-route': { baseURL: profileEndpoint.url, api: 'openai-completions', models: [] },
      },
      // The shipped table names a different endpoint for this route; the
      // operator's own profile must win.
      endpoints: { 'operator-route': shippedEndpoint.url },
    })
    const answer = await ctx.providerSync.refreshRoutes(['operator-route'])
    expect(answer.routes[0]).toMatchObject({ route: 'operator-route', status: 'ok', modelCount: 1 })
    expect(profileEndpoint.paths.length).toBeGreaterThan(0)
    expect(shippedEndpoint.paths).toEqual([])
  })
})
