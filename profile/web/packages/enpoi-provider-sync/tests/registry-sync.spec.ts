// @vitest-environment node
/**
 * Provider-sync integration with the exact CLIProxyAPI registry metadata and
 * the endpoint-authoritative empty listing. Membership always comes from the
 * inference endpoint; the registry supplies metadata only, scoped by the
 * listing's exact owner (or a declared channel/owner override).
 */
import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import type { Config, RouteMetadataSourceConfig } from '../src/index.ts'
import {
  apply,
  discoveredCachePath,
  mergeDiscoveredModels,
  normalizeListingEntry,
  planRouteModels,
} from '../src/index.ts'
import { loadBundledRegistryMetadataIndex } from '../src/registry-metadata.ts'

const directories: string[] = []
const contexts: Context[] = []
const servers: Server[] = []
const modelsDevPath = process.env.DSH_MODELS_DEV_PATH
process.env.DSH_MODELS_DEV_PATH = join(tmpdir(), 'dsh-sync-registry-no-models-dev.json')
afterAll(() => {
  if (modelsDevPath === undefined) Reflect.deleteProperty(process.env, 'DSH_MODELS_DEV_PATH')
  else process.env.DSH_MODELS_DEV_PATH = modelsDevPath
})

afterEach(async () => {
  vi.unstubAllGlobals()
  for (const context of contexts.splice(0)) await context.fiber.dispose()
  await Promise.all(servers.splice(0).map(server => new Promise(resolve => server.close(resolve))))
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
  Reflect.deleteProperty(process.env, 'DSH_DISCOVERED_MODELS')
})

function tempDir(): string {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-registry-sync-'))
  directories.push(directory)
  return directory
}

/** One mutable listing response; tests change status/body between passes. */
interface MutableListing {
  url: string
  set: (status: number, body: unknown) => void
}

async function mutableListing(initialBody: unknown, initialStatus = 200): Promise<MutableListing> {
  let status = initialStatus
  let body = initialBody
  const server = createServer((_request: IncomingMessage, response: ServerResponse) => {
    response.writeHead(status, { 'content-type': 'application/json' })
    response.end(JSON.stringify(body))
  })
  servers.push(server)
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no port')
  return {
    url: `http://127.0.0.1:${String(address.port)}`,
    set: (nextStatus, nextBody) => { status = nextStatus; body = nextBody },
  }
}

/** Stub only the public models.dev refresh; local listing servers stay real. */
function stubModelsDevOffline(): void {
  const realFetch = globalThis.fetch
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).startsWith('https://models.dev/')) {
      return { ok: false, status: 503, json: async () => ({}) }
    }
    return await realFetch(input, init)
  })
}

/** One route profile the harness serves. */
interface HarnessRoute {
  baseURL?: string
  api?: string
  models?: Array<Record<string, unknown>>
  catalogAuthority?: 'catalog' | 'endpoint'
}

interface SyncMutation {
  ns: string
  ops: Array<{ op: string; path: string[]; value: unknown }>
}

interface MountedSync extends Context {
  providerSync: {
    refreshRoutes(routes?: readonly string[]): Promise<{
      routes: Array<{
        route: string
        status: string
        modelCount: number
        removed: string[]
        degraded: boolean
        cached: boolean
        message?: string
      }>
    }>
  }
}

/** Mount the plugin over an in-memory llm-pi-ai profile that mutations update. */
async function mountSync(
  llm: Record<string, HarnessRoute>,
  metadataSources: Record<string, RouteMetadataSourceConfig>,
): Promise<{ ctx: MountedSync; mutations: SyncMutation[]; diagnostics: Array<{ kind: string; message: string }> }> {
  const mutations: SyncMutation[] = []
  const diagnostics: Array<{ kind: string; message: string }> = []
  const settings = {
    describe: () => [{ ns: 'llm-pi-ai', revision: 1, value: { providers: llm } }],
    mutate: async (ns: string, ops: SyncMutation['ops']) => {
      mutations.push({ ns, ops })
      for (const op of ops) {
        if (op.path[0] !== 'providers' || typeof op.path[1] !== 'string') continue
        const route = llm[op.path[1]]
        if (route === undefined) continue
        if (op.path[2] === 'models') route.models = op.value as Array<Record<string, unknown>>
        if (op.path[2] === 'catalogAuthority') route.catalogAuthority = op.value as 'catalog' | 'endpoint'
      }
    },
  }
  const ctx = new Context()
  contexts.push(ctx)
  ctx.provide('remote', { registerService: () => {} })
  ctx.provide('settings', settings)
  ctx.provide('diagnostics', {
    report: (request: { kind: string, message: string }) => {
      diagnostics.push(request)
      return {}
    },
  })
  ;(apply as (ctx: Context, config: Config) => void)(ctx, {
    intervalMs: { get: () => 3_600_000 },
    syncOnStart: { get: () => false },
    syncDelayMs: { get: () => 0 },
    endpoints: { get: () => ({}) },
    capacityDefaults: { get: () => ({}) },
    sessionHeaders: { get: () => ({}) },
    modelsDevUrl: { get: () => 'https://models.dev/api.json' },
    routeProviderMap: { get: () => ({}) },
    pinnedModels: { get: () => ({}) },
    endpointGraceMs: { get: () => 14 * 24 * 60 * 60 * 1000 },
    catalogFreshMs: { get: () => 48 * 60 * 60 * 1000 },
    metadataSources: { get: () => metadataSources },
  })
  await vi.waitFor(() => { expect((ctx as unknown as { providerSync?: unknown }).providerSync).toBeDefined() })
  return { ctx: ctx as MountedSync, mutations, diagnostics }
}

/** The discovered cache route record, when the pass has written one. */
function cacheRoute(route: string): { fetchedAt: number; models: Array<{ id: string; deprecated?: boolean }> } | undefined {
  if (!existsSync(discoveredCachePath())) return undefined
  const raw = JSON.parse(readFileSync(discoveredCachePath(), 'utf8')) as {
    routes?: Record<string, { fetchedAt: number; models: Array<{ id: string; deprecated?: boolean }> }>
  }
  return raw.routes?.[route]
}

const registry = loadBundledRegistryMetadataIndex()
const metadata = { index: registry }
const planBase = {
  route: 'cliproxyapi',
  catalogRoute: false,
  endpointFresh: true,
  catalogFresh: true,
  now: 1_000,
  metadata,
} as const

describe('authoritative empty listing', () => {
  it('writes an empty catalog, declares endpoint authority, then picks the models up when they return', async () => {
    const directory = tempDir()
    process.env.DSH_DISCOVERED_MODELS = join(directory, 'discovered-models.json')
    process.env.DSH_MODELS_DEV_PATH = join(directory, 'models.json')
    writeFileSync(process.env.DSH_MODELS_DEV_PATH, '{}')
    stubModelsDevOffline()
    const listing = await mutableListing({ object: 'list', data: [] })
    const llm: Record<string, HarnessRoute> = {
      cliproxyapi: {
        baseURL: listing.url,
        api: 'openai-completions',
        catalogAuthority: 'endpoint',
        models: [{ id: 'claude-sonnet-4-6', name: 'Stored Label' }],
      },
    }
    const { ctx, mutations, diagnostics } = await mountSync(llm, { cliproxyapi: { source: 'cliproxyapi' } })

    const empty = await ctx.providerSync.refreshRoutes(['cliproxyapi'])
    expect(empty.routes[0]).toMatchObject({
      route: 'cliproxyapi',
      status: 'ok',
      modelCount: 0,
      removed: ['claude-sonnet-4-6'],
      cached: true,
    })
    // The empty model list and endpoint authority land in one fenced write.
    expect(mutations).toHaveLength(1)
    expect(mutations[0]!.ops).toEqual([
      { op: 'set', path: ['providers', 'cliproxyapi', 'models'], value: [] },
    ])
    expect(llm.cliproxyapi!.catalogAuthority).toBe('endpoint')
    const emptyCache = cacheRoute('cliproxyapi')
    expect(emptyCache?.models).toEqual([])
    expect(emptyCache?.fetchedAt).toBeGreaterThan(0)

    // Another successful empty probe bumps lastSuccess even though the set is
    // unchanged. A failed probe is tested separately and keeps this stamp.
    await new Promise(resolve => setTimeout(resolve, 5))
    await ctx.providerSync.refreshRoutes(['cliproxyapi'])
    expect(cacheRoute('cliproxyapi')?.fetchedAt).toBeGreaterThan(emptyCache!.fetchedAt)

    listing.set(200, { object: 'list', data: [{ id: 'claude-sonnet-4-6', owned_by: 'anthropic' }] })
    const returned = await ctx.providerSync.refreshRoutes(['cliproxyapi'])
    expect(returned.routes[0]).toMatchObject({ status: 'ok', modelCount: 1, cached: true })
    const model = llm.cliproxyapi!.models![0]!
    // Exact registry metadata for the listing's owner, not a family guess.
    expect(model).toMatchObject({
      id: 'claude-sonnet-4-6',
      name: 'Claude 4.6 Sonnet',
      contextWindow: 200_000,
      maxTokens: 64_000,
      input: ['text', 'image'],
      reasoning: true,
    })
    expect(model.reasoningEfforts).toEqual({ off: null, low: 'low', medium: 'medium', high: 'high', max: 'max' })
    expect(cacheRoute('cliproxyapi')?.models.map(entry => entry.id)).toEqual(['claude-sonnet-4-6'])
    expect(diagnostics.some(entry => entry.kind === 'provider-sync/registry-metadata'
      && entry.message.includes('v8.0.54')
      && entry.message.includes('resolved 1/1'))).toBe(true)
  })

  it('does not grant membership authority from a metadata declaration', async () => {
    const directory = tempDir()
    process.env.DSH_DISCOVERED_MODELS = join(directory, 'discovered-models.json')
    process.env.DSH_MODELS_DEV_PATH = join(directory, 'models.json')
    writeFileSync(process.env.DSH_MODELS_DEV_PATH, '{}')
    stubModelsDevOffline()
    const listing = await mutableListing({ object: 'list', data: [] })
    const llm: Record<string, HarnessRoute> = {
      cliproxyapi: {
        baseURL: listing.url,
        api: 'openai-completions',
        models: [{ id: 'claude-sonnet-4-6', name: 'Stored Label' }],
      },
    }
    const { ctx, mutations } = await mountSync(llm, { cliproxyapi: { source: 'cliproxyapi' } })
    const answer = await ctx.providerSync.refreshRoutes(['cliproxyapi'])
    // The empty listing is not authoritative: the global guard keeps the
    // stored model and no authority field or empty cache is written.
    expect(answer.routes[0]).toMatchObject({
      status: 'ok',
      modelCount: 1,
      removed: [],
      degraded: true,
      cached: false,
    })
    expect(llm.cliproxyapi!.catalogAuthority).toBeUndefined()
    // The degraded merge refreshes the kept record, but never writes authority
    // or an empty discovered cache from a metadata declaration alone.
    expect(mutations).toHaveLength(1)
    expect(mutations[0]!.ops.map(op => op.path.join('.'))).toEqual(['providers.cliproxyapi.models'])
    expect(mutations[0]!.ops[0]!.value).toMatchObject([{ id: 'claude-sonnet-4-6', source: 'configured' }])
    expect(cacheRoute('cliproxyapi')).toBeUndefined()
  })

  it('refuses an unversioned refresh URL and stays on the bundled baseline', async () => {
    const directory = tempDir()
    process.env.DSH_DISCOVERED_MODELS = join(directory, 'discovered-models.json')
    process.env.DSH_MODELS_DEV_PATH = join(directory, 'models.json')
    writeFileSync(process.env.DSH_MODELS_DEV_PATH, '{}')
    stubModelsDevOffline()
    const listing = await mutableListing({ object: 'list', data: [{ id: 'claude-sonnet-4-6', owned_by: 'anthropic' }] })
    const llm: Record<string, HarnessRoute> = {
      cliproxyapi: { baseURL: listing.url, api: 'openai-completions', models: [] },
    }
    const { ctx, diagnostics } = await mountSync(llm, {
      cliproxyapi: { source: 'cliproxyapi', refreshUrl: 'http://127.0.0.1:1/registry.json' },
    })
    expect(diagnostics.some(entry => entry.message.includes('without sourceVersion'))).toBe(true)
    await ctx.providerSync.refreshRoutes(['cliproxyapi'])
    expect(llm.cliproxyapi!.models![0]).toMatchObject({ name: 'Claude 4.6 Sonnet', contextWindow: 200_000 })
  })

  it('retains the last good cache on 401 and on an invalid 200 body', async () => {
    const directory = tempDir()
    process.env.DSH_DISCOVERED_MODELS = join(directory, 'discovered-models.json')
    process.env.DSH_MODELS_DEV_PATH = join(directory, 'models.json')
    writeFileSync(process.env.DSH_MODELS_DEV_PATH, '{}')
    stubModelsDevOffline()
    const listing = await mutableListing({ object: 'list', data: [{ id: 'claude-sonnet-4-6', owned_by: 'anthropic' }] })
    const llm: Record<string, HarnessRoute> = {
      cliproxyapi: {
        baseURL: listing.url,
        api: 'openai-completions',
        catalogAuthority: 'endpoint',
        models: [],
      },
    }
    const { ctx } = await mountSync(llm, { cliproxyapi: { source: 'cliproxyapi' } })
    await ctx.providerSync.refreshRoutes(['cliproxyapi'])
    const good = cacheRoute('cliproxyapi')
    expect(good?.models.map(entry => entry.id)).toEqual(['claude-sonnet-4-6'])

    listing.set(401, { error: 'unauthorized' })
    const unauthorized = await ctx.providerSync.refreshRoutes(['cliproxyapi'])
    expect(unauthorized.routes[0]).toMatchObject({ status: 'unreachable', degraded: true, cached: false })
    expect(cacheRoute('cliproxyapi')).toEqual(good)

    listing.set(200, { unexpected: [] })
    const invalid = await ctx.providerSync.refreshRoutes(['cliproxyapi'])
    expect(invalid.routes[0]).toMatchObject({ status: 'unreachable', degraded: true, cached: false })
    expect(cacheRoute('cliproxyapi')).toEqual(good)
  })
})

describe('shared listing parser', () => {
  it('keeps the input cap separate from the combined context and owner-scopes the registry lookup', () => {
    const model = normalizeListingEntry({
      id: 'explicit-id',
      slug: 'alias-id',
      owned_by: 'anthropic',
      context_length: 200_000,
      max_input_tokens: 100_000,
      max_output_tokens: 50_000,
      limit: { context: 300_000, output: 40_000 },
      supported_reasoning_levels: ['low', 'ultra'],
    })!
    expect(model).toMatchObject({
      id: 'explicit-id',
      contextWindow: 200_000,
      maxInputTokens: 100_000,
      maxTokens: 50_000,
      owner: 'anthropic',
      reasoningEfforts: { low: 'low' },
      unsupportedReasoningEfforts: ['ultra'],
    })
  })
})

describe('registry metadata precedence', () => {
  it('resolves the same id differently by exact owner and never leaks one owner into another', () => {
    const anthropic = planRouteModels({
      ...planBase,
      configured: [],
      live: [{ id: 'claude-sonnet-4-6', owner: 'anthropic' }],
    })
    expect(anthropic.models[0]).toMatchObject({
      id: 'claude-sonnet-4-6',
      name: 'Claude 4.6 Sonnet',
      contextWindow: 200_000,
      maxTokens: 64_000,
      reasoning: true,
      reasoningEfforts: { off: null, low: 'low', medium: 'medium', high: 'high', max: 'max' },
    })

    const unscoped = planRouteModels({
      ...planBase,
      configured: [],
      live: [{ id: 'claude-sonnet-4-6' }],
    })
    // No owner and no channel is UNKNOWN, never an id-only registry match.
    expect(unscoped.models[0]!.name).not.toBe('Claude 4.6 Sonnet')
    expect(unscoped.models[0]!.contextWindow).toBeUndefined()

    const antigravity = planRouteModels({
      ...planBase,
      configured: [],
      live: [{ id: 'claude-sonnet-4-6', owner: 'antigravity' }],
    })
    expect(antigravity.models[0]).toMatchObject({
      id: 'claude-sonnet-4-6',
      name: 'Claude Sonnet 4.6 (Thinking)',
      contextWindow: 200_000,
      maxTokens: 64_000,
      reasoning: true,
    })
    // Antigravity publishes only `off`: no claude-channel max/medium leaks in.
    expect(antigravity.models[0]!.reasoningEfforts).toBeUndefined()
  })

  it('keeps input cap separate, leaves unknown context absent, and offers no fake ladder for budget-only reasoning', () => {
    const planned = planRouteModels({
      ...planBase,
      configured: [],
      live: [{ id: 'gemini-2.5-pro', owner: 'google' }],
    })
    const model = planned.models[0]!
    expect(model).toMatchObject({
      id: 'gemini-2.5-pro',
      name: 'Gemini 2.5 Pro',
      maxInputTokens: 1_048_576,
      maxTokens: 65_536,
      input: ['text', 'image', 'audio', 'video'],
      reasoning: true,
    })
    // context_length was null upstream; the 1M registry value is input-only.
    expect(model.contextWindow).toBeUndefined()
    expect(model.reasoningEfforts).toBeUndefined()
    // The hint table may label provenance, but it never injects a ladder claim
    // over a registry disclosure.
    expect(model.capabilityHints).not.toMatchObject({ reasoning: true })
    const [discovered] = mergeDiscoveredModels(
      'cliproxyapi',
      [{ id: 'gemini-2.5-pro', owner: 'google' }],
      undefined,
      undefined,
      metadata,
    )
    // The cache stores the reasoning flag even though the catalog lane currently
    // drops it when materializing a discovered record.
    expect(discovered).toMatchObject({ id: 'gemini-2.5-pro', reasoning: true })
    expect(discovered?.reasoningEfforts).toBeUndefined()

    const unknown = planRouteModels({
      ...planBase,
      configured: [],
      live: [{ id: 'zzz-mystery-registry-id', owner: 'openai' }],
    })
    expect(unknown.models[0]).toMatchObject({ id: 'zzz-mystery-registry-id', unverified: true })
    expect(unknown.models[0]!.contextWindow).toBeUndefined()
    expect(unknown.models[0]!.maxInputTokens).toBeUndefined()
  })

  it('keeps omitted registry thinking unknown, not false, and emits unsupported raw effort names only as diagnostics', () => {
    const unknownPlan = planRouteModels({
      ...planBase,
      configured: [],
      live: [{ id: 'grok-build-0.1', owner: 'xai' }],
    })
    expect(unknownPlan.models[0]).toMatchObject({ id: 'grok-build-0.1', name: 'Grok Build 0.1' })
    expect(unknownPlan.models[0]!.reasoning).toBeUndefined()
    expect(unknownPlan.models[0]!.reasoningEfforts).toBeUndefined()
    expect(unknownPlan.models[0]!.capabilityHints).toBeUndefined()

    // A registry record that omits thinking does not suppress a labelled
    // operator hint; the hint never becomes a named ladder.
    const hinted = planRouteModels({
      ...planBase,
      configured: [],
      live: [{ id: 'grok-4.20-0309-reasoning', owner: 'xai' }],
    })
    expect(hinted.models[0]!.reasoning).toBeUndefined()
    expect(hinted.models[0]!.reasoningEfforts).toBeUndefined()
    expect(hinted.models[0]!.capabilityHints).toMatchObject({ reasoning: true, source: 'shipped-hints' })

    const grok = normalizeListingEntry({ id: 'grok-4.3', owned_by: 'xai' })!
    const grokPlan = planRouteModels({ ...planBase, configured: [], live: [grok] })
    expect(grokPlan.models[0]!.reasoningEfforts).toEqual({ off: null, low: 'low', medium: 'medium', high: 'high' })
    expect(JSON.stringify(grokPlan.models[0]!.reasoningEfforts)).not.toContain('none')
    const [discovered] = mergeDiscoveredModels('cliproxyapi', [grok], undefined, undefined, metadata)
    expect(discovered?.unsupportedReasoningEfforts).toEqual(['none'])
  })

  it('lets every operator-declared manual field win over registry metadata', () => {
    const planned = planRouteModels({
      ...planBase,
      configured: [{
        id: 'claude-sonnet-4-6',
        source: 'manual',
        name: 'Operator Label',
        contextWindow: 12_345,
        maxInputTokens: 1_111,
        maxTokens: 2_222,
        input: ['text'],
        reasoning: false,
        reasoningEfforts: { high: 'high' },
      }],
      live: [{ id: 'claude-sonnet-4-6', owner: 'anthropic' }],
    })
    expect(planned.models[0]).toMatchObject({
      id: 'claude-sonnet-4-6',
      source: 'manual',
      name: 'Operator Label',
      contextWindow: 12_345,
      maxInputTokens: 1_111,
      maxTokens: 2_222,
      input: ['text'],
      reasoning: false,
      reasoningEfforts: { high: 'high' },
    })
  })

  it('adds, removes, and changes membership while a reference keeps the retired id deprecated', () => {
    const added = planRouteModels({
      ...planBase,
      configured: [],
      live: [{ id: 'claude-sonnet-4-6', owner: 'anthropic' }],
    })
    expect(added.models.map(model => model.id)).toEqual(['claude-sonnet-4-6'])

    const referenced = planRouteModels({
      ...planBase,
      configured: [{ id: 'claude-sonnet-4-6', name: 'Old' }],
      live: [],
      allowEmpty: true,
      references: [{ id: 'claude-sonnet-4-6', reason: 'favorite' }],
    })
    expect(referenced.report).toMatchObject({ removed: [], deprecated: ['claude-sonnet-4-6'], degraded: false })
    expect(referenced.models[0]).toMatchObject({ id: 'claude-sonnet-4-6', source: 'pinned-in-use', deprecated: true })

    const removed = planRouteModels({
      ...planBase,
      configured: [{ id: 'claude-sonnet-4-6' }],
      live: [],
      allowEmpty: true,
    })
    expect(removed.report).toMatchObject({ removed: ['claude-sonnet-4-6'], degraded: false })
    expect(removed.models).toEqual([])

    // The global empty-set guard still withholds an undeclared empty route.
    const undeclared = planRouteModels({
      ...planBase,
      configured: [{ id: 'claude-sonnet-4-6' }],
      live: [],
    })
    expect(undeclared.report.degraded).toBe(true)
    expect(undeclared.models.map(model => model.id)).toEqual(['claude-sonnet-4-6'])
  })

  it('smokes all 41 current live metadata-only ids through the shared parser and exact registry', () => {
    const fixture = JSON.parse(readFileSync(
      new URL('./fixtures/cliproxyapi-current41.models.json', import.meta.url),
      'utf8',
    )) as { data: Array<{ id: string; owned_by?: string }> }
    const live = fixture.data.map(row => normalizeListingEntry(row)).filter((model): model is NonNullable<typeof model> => model !== undefined)
    expect(live).toHaveLength(41)
    expect(live.every(model => model.owner !== undefined)).toBe(true)
    const planned = planRouteModels({ ...planBase, configured: [], live, metadata })
    expect(planned.models).toHaveLength(41)
    // 25 records carry a named ladder (22 exact + 3 Codex tier-consensus ladders); 7 budget-only records stay ladderless.
    expect(planned.models.filter(model => model.reasoningEfforts !== undefined)).toHaveLength(25)
    expect(planned.models.filter(model => model.reasoning === true && model.reasoningEfforts === undefined)).toHaveLength(7)
    const claude = planned.models.find(model => model.id === 'claude-sonnet-4-6')!
    expect(claude).toMatchObject({
      name: 'Claude 4.6 Sonnet',
      contextWindow: 200_000,
      maxTokens: 64_000,
      reasoning: true,
    })
    // Budget-only legacy records stay ladderless instead of inventing all six.
    const legacy = planned.models.find(model => model.id === 'claude-opus-4-1-20250805')
    expect(legacy?.reasoning).toBe(true)
    expect(legacy?.reasoningEfforts).toBeUndefined()
  })
})
