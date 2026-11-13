// @vitest-environment node
/**
 * Explicit per-field manual freezing for edited model records.
 *
 * A `source: 'manual'` record with an explicit `manualFields` list keeps
 * exactly the listed fields through every merge path; an empty list keeps
 * none, and an absent list keeps the legacy seven exactly as before. A field
 * deleted from the record is not resurrected, so "reset this field" lets the
 * next provider disclosure through. Prices are USD per million tokens and a
 * zero price is a disclosed price, not an absence.
 */
import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { Config as PiAiConfig } from '@deepseek-ai/dsh-llm-pi-ai'
import { plainConfig, projectForm, volatileForm } from '@deepseek-ai/dsh-settings/src/schema.ts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_MODELS_DEV_URL,
  MANUAL_MODEL_FIELDS,
  applyCatalogOverlay,
  mergeConfiguredModels,
  planRouteModels,
} from '../src/index.ts'
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

const ROUTE = 'manual-route'
const MODEL_ID = 'probe-manual-model'

function tempDir(): string {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-manual-fields-'))
  directories.push(directory)
  return directory
}

/**
 * One fresh models.dev catalogue row. It states a different price, tier set,
 * release date, and tool support from the operator's row, so a preserved
 * field proves the freeze rather than a missing disclosure.
 */
function writeCatalog(directory: string): string {
  const path = join(directory, 'models.dev.json')
  writeFileSync(path, JSON.stringify({
    [ROUTE]: {
      id: ROUTE,
      models: {
        [MODEL_ID]: {
          id: MODEL_ID,
          tool_call: true,
          release_date: '2024-01-01',
          cost: {
            input: 9,
            output: 19,
            cache_read: 0.9,
            cache_write: 1.9,
            context_over_200k: { input: 7, output: 17 },
          },
        },
      },
    },
  }))
  return path
}

/** Import a fresh module instance bound to the environment paths set by the test. */
async function freshIndex(): Promise<typeof import('../src/index.ts')> {
  vi.resetModules()
  return await import('../src/index.ts')
}

/** Fail the online models.dev refresh so the local fixture is the only catalogue. */
function stubModelsDevOffline(): void {
  const realFetch = globalThis.fetch
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).startsWith('https://models.dev/')) return { ok: false, status: 503, json: async () => ({}) }
    return await realFetch(input, init)
  })
}

/** Serve one scripted listing reply. */
async function listingServer(body: unknown): Promise<string> {
  const server = createServer((_request: IncomingMessage, response: ServerResponse) => {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify(body))
  })
  servers.push(server)
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no port')
  return `http://127.0.0.1:${String(address.port)}`
}

/** One captured settings mutation. */
interface CapturedMutation {
  ns: string
  ops: Array<{ op: string, path: string[], value: Array<Record<string, unknown>> }>
}

/** Mount the plugin over a real Context with one fixed settings document. */
async function mountSync(input: {
  providers: Record<string, Record<string, unknown>>
  mutate: (ns: string, ops: unknown[]) => Promise<void>
}): Promise<Context & { providerSync: { refreshRoutes(routes?: readonly string[]): Promise<unknown> } }> {
  const ctx = new Context()
  contexts.push(ctx)
  ctx.provide('remote', { registerService: () => {} })
  ctx.provide('settings', {
    describe: () => [{ ns: 'llm-pi-ai', revision: 1, value: { providers: input.providers } }],
    mutate: input.mutate,
  })
  const { apply } = await freshIndex()
  apply(ctx, {
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
  } as unknown as Config)
  await vi.waitFor(() => { expect((ctx as unknown as { providerSync?: unknown }).providerSync).toBeDefined() })
  return ctx as Context & { providerSync: { refreshRoutes(routes?: readonly string[]): Promise<unknown> } }
}

/** The operator's edited row: frozen fields differ from every disclosure. */
function manualRow(manualFields: string[], overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: MODEL_ID,
    source: 'manual',
    manualFields,
    name: 'Operator Name',
    contextWindow: 1_000_000,
    maxInputTokens: 900_000,
    maxTokens: 50_000,
    input: ['text', 'image'],
    reasoning: true,
    reasoningEfforts: { high: 'high' },
    tools: false,
    cost: { input: 0, output: 0 },
    costTiers: [{ inputTokensAbove: 1_000_000, input: 0.5, output: 1.5 }],
    releaseDate: '2026-01-01',
    ...overrides,
  }
}

/** The listing's own answer for the same id: a smaller window and a new name. */
const LIVE = [{
  id: MODEL_ID,
  name: 'Listed Name',
  contextWindow: 64_000,
  maxInputTokens: 70_000,
  maxTokens: 8_000,
  tools: true,
  reasoning: false,
  input: ['text'] as Array<'text'>,
}]

/**
 * Run the production settings projection end to end: `Config` validation, the
 * volatile form, and `projectForm` — exactly what `settings.describe()` feeds
 * the Models page. The point is absence: schemastery gives arrays `[]` and
 * objects `{}` as implicit defaults, so only a schema that preserves absence
 * keeps a legacy row distinct from an explicit empty freeze list.
 * @param models - the raw stored model records.
 * @returns the projected records the Models page and the sync receive.
 */
function describeStoredModels(models: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const raw = {
    providers: {
      [ROUTE]: { api: 'openai-completions', baseURL: 'http://127.0.0.1:1', models },
    },
  }
  const validated: unknown = PiAiConfig['~standard'].validate(raw)
  if (validated === null || typeof validated !== 'object' || 'then' in validated) {
    throw new Error('llm-pi-ai returned no synchronous validation result')
  }
  if ('issues' in validated) throw new Error(JSON.stringify(validated.issues))
  const value = (validated as { value: unknown }).value
  const form = volatileForm(PiAiConfig)
  if (form === undefined) throw new Error('llm-pi-ai has no volatile form')
  const projected = projectForm(form, plainConfig(value)) as {
    providers: Record<string, { models?: Array<Record<string, unknown>> }>
  }
  return projected.providers[ROUTE]?.models ?? []
}

describe('explicit manual field lists', () => {
  it('exports the closed editor vocabulary', () => {
    expect(MANUAL_MODEL_FIELDS).toEqual([
      'name', 'contextWindow', 'maxInputTokens', 'maxTokens', 'input', 'output',
      'tools', 'reasoning', 'reasoningEfforts', 'cost', 'costTiers', 'releaseDate',
    ])
  })

  it('freezes exactly the listed fields on a healthy provider refresh and lets the rest disclose', async () => {
    const directory = tempDir()
    process.env.DSH_MODELS_DEV_PATH = writeCatalog(directory)
    const { planRouteModels: plan } = await freshIndex()
    const planned = plan({
      route: ROUTE,
      configured: [manualRow(['cost', 'costTiers', 'releaseDate', 'tools'])],
      live: LIVE,
      catalogRoute: false,
      endpointFresh: true,
      catalogFresh: true,
      now: 1_000,
    })
    const kept = planned.models.find(model => model.id === MODEL_ID)
    // The named fields are the operator's claim, zero price included.
    expect(kept).toMatchObject({
      id: MODEL_ID,
      source: 'manual',
      manualFields: ['cost', 'costTiers', 'releaseDate', 'tools'],
      cost: { input: 0, output: 0 },
      costTiers: [{ inputTokensAbove: 1_000_000, input: 0.5, output: 1.5 }],
      releaseDate: '2026-01-01',
      tools: false,
    })
    // Every unnamed field follows the provider's answer, including negative
    // answers: a stated false and a stated text-only list replace the old
    // claim instead of losing to the monotonic safeguard.
    expect(kept).toMatchObject({
      name: 'Listed Name',
      contextWindow: 64_000,
      maxInputTokens: 70_000,
      maxTokens: 8_000,
      reasoning: false,
      input: ['text'],
    })
    expect(kept).not.toHaveProperty('reasoningEfforts')
  })

  it('freezes the reserved output modalities when the list names them', async () => {
    const directory = tempDir()
    process.env.DSH_MODELS_DEV_PATH = writeCatalog(directory)
    const { planRouteModels: plan } = await freshIndex()
    const planned = plan({
      route: ROUTE,
      configured: [manualRow(['output'], { output: ['text', 'image'] })],
      live: LIVE,
      catalogRoute: false,
      endpointFresh: true,
      catalogFresh: true,
      now: 1_000,
    })
    expect(planned.models.find(model => model.id === MODEL_ID)).toMatchObject({
      output: ['text', 'image'],
      source: 'manual',
      manualFields: ['output'],
    })
  })

  it('freezes an explicit non-reasoning declaration when the list names reasoningEfforts', async () => {
    const directory = tempDir()
    process.env.DSH_MODELS_DEV_PATH = writeCatalog(directory)
    const { planRouteModels: plan } = await freshIndex()
    const planned = plan({
      route: ROUTE,
      configured: [
        manualRow(['reasoningEfforts'], { reasoningEfforts: false, reasoning: true }),
      ],
      live: LIVE,
      catalogRoute: false,
      endpointFresh: true,
      catalogFresh: true,
      now: 1_000,
    })
    expect(planned.models.find(model => model.id === MODEL_ID)).toMatchObject({
      reasoningEfforts: false,
      manualFields: ['reasoningEfforts'],
    })
  })

  it('keeps the same frozen fields through the degraded configured merge', async () => {
    const directory = tempDir()
    process.env.DSH_MODELS_DEV_PATH = writeCatalog(directory)
    const { mergeConfiguredModels: merge } = await freshIndex()
    const merged = merge(ROUTE, [manualRow(['cost', 'costTiers', 'releaseDate', 'tools'])], LIVE)
    expect(merged.models[0]).toMatchObject({
      id: MODEL_ID,
      source: 'manual',
      manualFields: ['cost', 'costTiers', 'releaseDate', 'tools'],
      cost: { input: 0, output: 0 },
      costTiers: [{ inputTokensAbove: 1_000_000, input: 0.5, output: 1.5 }],
      releaseDate: '2026-01-01',
      tools: false,
      name: 'Listed Name',
      contextWindow: 64_000,
    })
  })

  it('keeps the frozen fields over an overlay upsert while the upsert wins for unnamed fields', async () => {
    const directory = tempDir()
    process.env.DSH_MODELS_DEV_PATH = writeCatalog(directory)
    const { planRouteModels: plan } = await freshIndex()
    const planned = plan({
      route: ROUTE,
      configured: [manualRow(['cost', 'costTiers', 'releaseDate', 'tools'])],
      live: LIVE,
      catalogRoute: false,
      endpointFresh: true,
      catalogFresh: true,
      overlay: {
        upsert: [{
          id: MODEL_ID,
          name: 'Overlay Name',
          contextWindow: 777,
          maxTokens: 77,
          cost: { input: 1, output: 2 },
          costTiers: [{ inputTokensAbove: 200_000, input: 1, output: 2 }],
          releaseDate: '2025-05-05',
          tools: true,
        }],
      },
      now: 1_000,
    })
    const kept = planned.models.find(model => model.id === MODEL_ID)
    expect(kept).toMatchObject({
      name: 'Overlay Name',
      contextWindow: 777,
      maxTokens: 77,
      cost: { input: 0, output: 0 },
      costTiers: [{ inputTokensAbove: 1_000_000, input: 0.5, output: 1.5 }],
      releaseDate: '2026-01-01',
      tools: false,
      source: 'manual',
      manualFields: ['cost', 'costTiers', 'releaseDate', 'tools'],
    })
  })

  it('keeps the frozen fields when the overlay keeps a manual record past its removal', async () => {
    const directory = tempDir()
    process.env.DSH_MODELS_DEV_PATH = writeCatalog(directory)
    const { applyCatalogOverlay: apply } = await freshIndex()
    const applied = apply(
      [{ ...manualRow(['cost', 'releaseDate']), name: 'Operator Name' }],
      { upsert: [{ id: MODEL_ID, name: 'Overlay Name', cost: { input: 1, output: 2 }, releaseDate: '2025-05-05' }] },
      { keep: new Set([MODEL_ID]) },
    )
    expect(applied[0]).toMatchObject({
      id: MODEL_ID,
      source: 'manual',
      manualFields: ['cost', 'releaseDate'],
      // `name` is not in this list, so the overlay's own field wins.
      name: 'Overlay Name',
      cost: { input: 0, output: 0 },
      releaseDate: '2026-01-01',
    })
  })

  it('an empty list freezes nothing, so every field refreshes', async () => {
    const directory = tempDir()
    process.env.DSH_MODELS_DEV_PATH = writeCatalog(directory)
    const { planRouteModels: plan } = await freshIndex()
    const planned = plan({
      route: ROUTE,
      configured: [manualRow([])],
      live: LIVE,
      catalogRoute: false,
      endpointFresh: true,
      catalogFresh: true,
      now: 1_000,
    })
    const kept = planned.models.find(model => model.id === MODEL_ID)
    expect(kept).toMatchObject({
      id: MODEL_ID,
      source: 'manual',
      manualFields: [],
      name: 'Listed Name',
      contextWindow: 64_000,
      maxTokens: 8_000,
      cost: { input: 9, output: 19, cache_read: 0.9, cache_write: 1.9 },
      releaseDate: '2024-01-01',
      costTiers: [{ inputTokensAbove: 200_000, input: 7, output: 17 }],
      tools: true,
    })
    // Provider truth wins on negative answers too: no stale ladder survives
    // and a stated text-only list replaces the old vision claim.
    expect(kept).toMatchObject({ reasoning: false, input: ['text'] })
    expect(kept).not.toHaveProperty('reasoningEfforts')
  })

  it('an explicitly frozen reasoning claim survives a provider refusal', async () => {
    const directory = tempDir()
    process.env.DSH_MODELS_DEV_PATH = writeCatalog(directory)
    const { planRouteModels: plan } = await freshIndex()
    const planned = plan({
      route: ROUTE,
      configured: [manualRow(['reasoning', 'reasoningEfforts'])],
      live: LIVE,
      catalogRoute: false,
      endpointFresh: true,
      catalogFresh: true,
      now: 1_000,
    })
    // Both fields are the operator's own claim, so the stated false does not
    // clear them; the unfrozen input list still follows the provider.
    expect(planned.models.find(model => model.id === MODEL_ID)).toMatchObject({
      reasoning: true,
      reasoningEfforts: { high: 'high' },
      input: ['text'],
    })
  })

  it('keeps a known vision claim when the listing says nothing about modalities', async () => {
    const directory = tempDir()
    process.env.DSH_MODELS_DEV_PATH = writeCatalog(directory)
    const { planRouteModels: plan } = await freshIndex()
    const planned = plan({
      route: ROUTE,
      configured: [manualRow(['cost'])],
      // No `input` and no reasoning on the listing: silence, not a refusal.
      live: [{ id: MODEL_ID, name: 'Listed Name', contextWindow: 64_000 }],
      catalogRoute: false,
      endpointFresh: true,
      catalogFresh: true,
      now: 1_000,
    })
    expect(planned.models.find(model => model.id === MODEL_ID)).toMatchObject({
      input: ['text', 'image'],
      reasoning: true,
      reasoningEfforts: { high: 'high' },
    })
  })

  it('a field deleted from the record is not resurrected by the freeze list', async () => {
    const directory = tempDir()
    process.env.DSH_MODELS_DEV_PATH = writeCatalog(directory)
    const { planRouteModels: plan } = await freshIndex()
    const deleted = manualRow(['contextWindow'], { contextWindow: undefined })
    const planned = plan({
      route: ROUTE,
      configured: [deleted],
      live: LIVE,
      catalogRoute: false,
      endpointFresh: true,
      catalogFresh: true,
      now: 1_000,
    })
    // The reset let the provider's real value through instead of keeping a
    // stale number from the record that no longer states it.
    expect(planned.models.find(model => model.id === MODEL_ID)?.contextWindow).toBe(64_000)

    const silent = plan({
      route: ROUTE,
      configured: [deleted],
      live: [{ id: MODEL_ID }],
      catalogRoute: false,
      endpointFresh: true,
      catalogFresh: true,
      now: 1_000,
    })
    expect(silent.models.find(model => model.id === MODEL_ID)).not.toHaveProperty('contextWindow')
  })

  it('legacy manual rows keep the frozen seven and do not freeze the newer fields', async () => {
    const directory = tempDir()
    process.env.DSH_MODELS_DEV_PATH = writeCatalog(directory)
    const { planRouteModels: plan } = await freshIndex()
    const legacy = manualRow(['ignored'])
    delete legacy.manualFields
    const planned = plan({
      route: ROUTE,
      configured: [legacy],
      live: LIVE,
      catalogRoute: false,
      endpointFresh: true,
      catalogFresh: true,
      now: 1_000,
    })
    const kept = planned.models.find(model => model.id === MODEL_ID)
    // The seven historical fields stay the operator's.
    expect(kept).toMatchObject({
      name: 'Operator Name',
      contextWindow: 1_000_000,
      maxInputTokens: 900_000,
      maxTokens: 50_000,
      reasoning: true,
      reasoningEfforts: { high: 'high' },
    })
    // The newer metadata follows the disclosure; nothing auto-migrates a
    // legacy row to an explicit list.
    expect(kept).toMatchObject({
      tools: true,
      cost: { input: 9, output: 19, cache_read: 0.9, cache_write: 1.9 },
      costTiers: [{ inputTokensAbove: 200_000, input: 7, output: 17 }],
      releaseDate: '2024-01-01',
    })
    expect(kept).not.toHaveProperty('manualFields')
  })
})

describe('stored configuration validation', () => {
  it('fails loud on a stored manualFields list naming an unknown field', async () => {
    const { planRouteModels: plan } = await freshIndex()
    expect(() => plan({
      route: ROUTE,
      configured: [{ id: MODEL_ID, source: 'manual', manualFields: ['bogus'] }],
      live: [{ id: MODEL_ID }],
      catalogRoute: false,
      endpointFresh: true,
      catalogFresh: true,
      now: 1_000,
    })).toThrow(/manualFields names unknown field "bogus"/)
    expect(() => plan({
      route: ROUTE,
      configured: [{ id: MODEL_ID, source: 'manual', manualFields: 'name' }],
      live: [{ id: MODEL_ID }],
      catalogRoute: false,
      endpointFresh: true,
      catalogFresh: true,
      now: 1_000,
    })).toThrow(/manualFields must be a list/)
  })

  it('keeps absent and explicit-empty freeze lists distinct through the real settings projection', async () => {
    const directory = tempDir()
    process.env.DSH_MODELS_DEV_PATH = join(directory, 'models.dev.json')
    writeFileSync(process.env.DSH_MODELS_DEV_PATH, '{}')
    const legacyRaw = [{
      id: MODEL_ID,
      source: 'manual',
      name: 'Operator Name',
      contextWindow: 1_000_000,
    }]
    const explicitRaw = [{
      id: MODEL_ID,
      source: 'manual',
      manualFields: [],
      name: 'Operator Name',
      contextWindow: 1_000_000,
    }]
    const [legacy] = describeStoredModels(legacyRaw)
    const [explicit] = describeStoredModels(explicitRaw)
    // The schema must not turn absence into `manualFields: []`, `cost: {}`,
    // `costTiers: []`, or `output: []` on the way to the Models page.
    expect(legacy).not.toHaveProperty('manualFields')
    expect(legacy).not.toHaveProperty('cost')
    expect(legacy).not.toHaveProperty('costTiers')
    expect(legacy).not.toHaveProperty('output')
    expect(explicit?.manualFields).toEqual([])
    expect(explicit).not.toHaveProperty('cost')
    expect(explicit).not.toHaveProperty('costTiers')
    expect(explicit).not.toHaveProperty('output')

    const { planRouteModels: plan } = await freshIndex()
    const input = {
      route: ROUTE,
      live: [{ id: MODEL_ID, name: 'Listed Name', contextWindow: 64_000 }],
      catalogRoute: false,
      endpointFresh: true,
      catalogFresh: true,
      now: 1_000,
    }
    // Absent stays the legacy seven: the old 1M window survives.
    const legacyPlan = plan({ ...input, configured: [legacy!] })
    expect(legacyPlan.models.find(model => model.id === MODEL_ID)).toMatchObject({
      name: 'Operator Name',
      contextWindow: 1_000_000,
      source: 'manual',
    })
    expect(legacyPlan.models.find(model => model.id === MODEL_ID)).not.toHaveProperty('manualFields')
    // An explicit empty list freezes none: the provider's real values win.
    const explicitPlan = plan({ ...input, configured: [explicit!] })
    expect(explicitPlan.models.find(model => model.id === MODEL_ID)).toMatchObject({
      name: 'Listed Name',
      contextWindow: 64_000,
      manualFields: [],
      source: 'manual',
    })
    // Neither flow may persist the synthetic empties.
    for (const model of [...legacyPlan.models, ...explicitPlan.models]) {
      expect(model).not.toHaveProperty('cost')
      expect(model).not.toHaveProperty('costTiers')
      expect(model).not.toHaveProperty('output')
    }
  })
})

describe('manual marker identity and membership', () => {
  it('only the manual source label grants membership protection; missing or empty stays configured', async () => {
    const directory = tempDir()
    process.env.DSH_MODELS_DEV_PATH = writeCatalog(directory)
    const { planRouteModels: plan } = await freshIndex()
    const planned = plan({
      route: ROUTE,
      configured: [
        { id: 'manual-id', source: 'manual', manualFields: ['name'], name: 'Hand' },
        { id: 'missing-source', manualFields: ['name'], name: 'Missing' },
        { id: 'empty-source', source: '', manualFields: ['name'], name: 'Empty' },
      ],
      live: [{ id: 'manual-id' }, { id: 'kept-a' }, { id: 'kept-b' }, { id: 'kept-c' }],
      catalogRoute: false,
      endpointFresh: true,
      catalogFresh: true,
      force: true,
      now: 1_000,
    })
    expect(planned.models.map(model => model.id)).toEqual(['manual-id', 'kept-a', 'kept-b', 'kept-c'])
    expect(planned.report.removed).toEqual(['missing-source', 'empty-source'])
  })

  it('a degraded pass never wipes rows, whatever their source label', async () => {
    const { planRouteModels: plan } = await freshIndex()
    const planned = plan({
      route: ROUTE,
      configured: [
        { id: 'missing-source', manualFields: ['name'], name: 'Missing' },
        { id: 'empty-source', source: '', name: 'Empty' },
      ],
      live: undefined,
      catalogRoute: false,
      endpointFresh: false,
      catalogFresh: false,
      now: 1_000,
    })
    expect(planned.report.degraded).toBe(true)
    expect(planned.models.map(model => model.id)).toEqual(['missing-source', 'empty-source'])
  })
})

describe('manual marker persistence', () => {
  it('writes a manualFields-only change through the settings comparison', async () => {
    const listed = await listingServer({ object: 'list', data: [{ id: MODEL_ID }] })
    const directory = tempDir()
    process.env.DSH_DISCOVERED_MODELS = join(directory, 'discovered-models.json')
    process.env.DSH_MODELS_DEV_PATH = join(directory, 'models.dev.json')
    writeFileSync(process.env.DSH_MODELS_DEV_PATH, '{}')
    stubModelsDevOffline()
    const mutations: CapturedMutation[] = []
    const mount = async (models: Array<Record<string, unknown>>, overlay?: unknown) => {
      if (overlay === undefined) Reflect.deleteProperty(process.env, 'DSH_CATALOG_OVERLAYS')
      else {
        process.env.DSH_CATALOG_OVERLAYS = join(directory, 'catalog-overlays.json')
        writeFileSync(process.env.DSH_CATALOG_OVERLAYS, JSON.stringify(overlay))
      }
      return await mountSync({
        providers: { [ROUTE]: { baseURL: listed, api: 'openai-completions', models } },
        mutate: async (ns, ops) => { mutations.push({ ns, ops: ops as CapturedMutation['ops'] }) },
      })
    }

    // First pass: let the sync converge the route to its own record.
    const first = await mount([])
    await (first as unknown as { providerSync: { refreshRoutes(routes?: readonly string[]): Promise<unknown> } })
      .providerSync.refreshRoutes([ROUTE])
    expect(mutations).toHaveLength(1)
    const converged = mutations[0]!.ops[0]!.value
    expect(converged[0]).not.toHaveProperty('manualFields')

    // Second pass: the only edit is an overlay that adds the freeze list, so
    // the settings comparison must notice the marker and persist it.
    mutations.length = 0
    const second = await mount(converged, {
      routes: { [ROUTE]: { upsert: [{ id: MODEL_ID, manualFields: ['cost'] }] } },
    })
    await (second as unknown as { providerSync: { refreshRoutes(routes?: readonly string[]): Promise<unknown> } })
      .providerSync.refreshRoutes([ROUTE])
    expect(mutations).toHaveLength(1)
    const marked = mutations[0]!.ops[0]!.value
    expect(marked.find(model => model.id === MODEL_ID)?.manualFields).toEqual(['cost'])

    // Third pass: the only edit is the reserved output modality list, which
    // the persistence comparison must also notice and write.
    mutations.length = 0
    const third = await mount(marked, {
      routes: { [ROUTE]: { upsert: [{ id: MODEL_ID, output: ['text', 'image'] }] } },
    })
    await (third as unknown as { providerSync: { refreshRoutes(routes?: readonly string[]): Promise<unknown> } })
      .providerSync.refreshRoutes([ROUTE])
    expect(mutations).toHaveLength(1)
    const persisted = mutations[0]!.ops[0]!.value.find(model => model.id === MODEL_ID)
    expect(persisted?.output).toEqual(['text', 'image'])
    expect(persisted?.manualFields).toEqual(['cost'])
  })
})
