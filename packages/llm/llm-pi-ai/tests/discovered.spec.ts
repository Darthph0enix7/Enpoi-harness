import { statSync, utimesSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DISCOVERED_CACHE_VERSION,
  discoveredModelsFor,
  discoveredModelsStamp,
  parseDiscoveredCache,
  resetDiscoveredModelsCache,
} from '../src/discovered.ts'
import { assertServiceable, resolveProfiles, type Options } from '../src/config.ts'
import { resolveRouteModels } from '../src/catalog.ts'

const directories: string[] = []

afterEach(async () => {
  resetDiscoveredModelsCache()
  Reflect.deleteProperty(process.env, 'DSH_DISCOVERED_MODELS')
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

/** Write one cache file and point this process at it. */
async function cacheFile(document: unknown): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-discovered-'))
  directories.push(directory)
  const path = join(directory, 'discovered-models.json')
  await writeFile(path, JSON.stringify(document), 'utf8')
  process.env.DSH_DISCOVERED_MODELS = path
  resetDiscoveredModelsCache()
  return path
}

/** A discovered route document for `acme-gateway`, with the caller's models. */
function cacheWith(models: unknown[]): unknown {
  return {
    version: DISCOVERED_CACHE_VERSION,
    routes: {
      'acme-gateway': {
        baseURL: 'https://acme.test',
        fetchedAt: 1_790_000_000_000,
        models,
      },
    },
  }
}

/** The route a preset would add: an OpenAI-compatible endpoint and no models. */
function discoveredRoute(): Options {
  return { providers: { 'acme-gateway': { api: 'openai-completions', baseURL: 'https://acme.test' } } }
}

describe('discovered-model cache parsing', () => {
  it('deduplicates by id, drops unusable rows, and keeps provenance', async () => {
    const document = cacheWith([
      { id: 'm', name: 'M', contextWindow: 128_000, maxTokens: 4096, input: ['text', 'image'], tools: true, source: 'discovered', discoveredAt: 5 },
      { id: 'm', name: 'shadowed', contextWindow: 1 },
      { id: 'n' },
      { id: '' },
      { id: 'bad', contextWindow: -1, input: ['hologram'], discoveredAt: 'later' },
      'not an object',
    ])
    await cacheFile(document)
    const parsed = parseDiscoveredCache(document)
    const route = parsed.routes['acme-gateway']
    expect(route?.models.map(model => model.id)).toEqual(['m', 'n', 'bad'])
    expect(route?.models[0]).toMatchObject({ name: 'M', contextWindow: 128_000, input: ['text', 'image'], tools: true, source: 'discovered', discoveredAt: 5 })
    // An unusable capacity and modality are dropped, not clamped or renamed;
    // the timestamp falls back to the route's fetch.
    expect(route?.models[2]).toEqual({ id: 'bad', source: 'discovered', discoveredAt: 1_790_000_000_000 })
    expect(discoveredModelsFor('acme-gateway')?.map(model => model.id)).toEqual(['m', 'n', 'bad'])
    expect(discoveredModelsFor('absent')).toBeUndefined()
    expect(discoveredModelsStamp()).not.toBe('')
  })

  it('keeps the sync gate flag with its reason, and drops a reason without the gate', async () => {
    await cacheFile(cacheWith([
      { id: 'kilo-auto/efficient', isFree: false, gated: true, gateReason: 'sign-in required', source: 'discovered', discoveredAt: 3 },
      { id: 'reason-only', gateReason: 'sign-in required', source: 'discovered', discoveredAt: 4 },
    ]))
    const models = discoveredModelsFor('acme-gateway')
    expect(models?.[0]).toMatchObject({ id: 'kilo-auto/efficient', isFree: false, gated: true, gateReason: 'sign-in required' })
    expect(models?.[1]).toMatchObject({ id: 'reason-only' })
    expect(models?.[1]?.gated).toBeUndefined()
    expect(models?.[1]?.gateReason).toBeUndefined()
  })

  it('keeps audio, video, and pdf inputs and the models.dev release and price tags', async () => {
    await cacheFile(cacheWith([
      {
        id: 'tagged',
        input: ['text', 'audio', 'video', 'pdf'],
        releaseDate: '2026-05-21',
        costTiers: [
          { inputTokensAbove: 128_000, input: 3, output: 18 },
          { inputTokensAbove: 200_000, input: 4, output: 24 },
        ],
        source: 'discovered',
        discoveredAt: 9,
      },
      {
        id: 'malformed-tags',
        input: ['nonsense', 'text'],
        releaseDate: 'not-a-date',
        costTiers: [{ inputTokensAbove: 0, input: 1 }, { output: 3 }, 'nope'],
        source: 'discovered',
        discoveredAt: 10,
      },
    ]))
    const models = discoveredModelsFor('acme-gateway')
    expect(models?.[0]).toMatchObject({
      input: ['text', 'audio', 'video', 'pdf'],
      releaseDate: '2026-05-21',
      costTiers: [
        { inputTokensAbove: 128_000, input: 3, output: 18 },
        { inputTokensAbove: 200_000, input: 4, output: 24 },
      ],
    })
    // Unknown tokens and unusable tag data drop instead of failing the read.
    expect(models?.[1]).toMatchObject({ input: ['text'] })
    expect(models?.[1]?.releaseDate).toBeUndefined()
    expect(models?.[1]?.costTiers).toBeUndefined()
  })

  it('round-trips the disclosed reasoning ladder alongside modalities and the deprecation marker', async () => {
    await cacheFile(cacheWith([
      {
        id: 'thinking',
        input: ['text', 'image', 'pdf'],
        reasoningEfforts: { low: 'low', high: 'high', off: 'off' },
        source: 'discovered',
        discoveredAt: 12,
      },
      { id: 'retired', deprecated: true, source: 'discovered', discoveredAt: 13 },
      { id: 'bad-ladder', reasoningEfforts: { low: '', high: 7 }, source: 'discovered', discoveredAt: 14 },
    ]))
    const models = discoveredModelsFor('acme-gateway')
    expect(models?.[0]).toMatchObject({
      input: ['text', 'image', 'pdf'],
      reasoningEfforts: { low: 'low', high: 'high', off: 'off' },
    })
    expect(models?.[1]).toMatchObject({ id: 'retired', deprecated: true })
    // A level with no usable wire value is not a level; the rest of the record
    // still reads instead of failing the cache.
    expect(models?.[2]?.reasoningEfforts).toBeUndefined()
  })

  it('retains a successful empty listing and drops an unstamped empty route', async () => {
    const document = {
      version: DISCOVERED_CACHE_VERSION,
      routes: {
        'acme-gateway': { baseURL: 'https://acme.test', fetchedAt: 1_790_000_000_000, models: [] },
        'unstamped-gateway': { baseURL: 'https://unstamped.test', models: [] },
        'corrupt-gateway': { baseURL: 'https://corrupt.test', fetchedAt: 1_790_000_000_000, models: [{ id: '' }] },
      },
    }
    await cacheFile(document)
    expect(parseDiscoveredCache(document).routes['acme-gateway']).toEqual({
      baseURL: 'https://acme.test',
      fetchedAt: 1_790_000_000_000,
      models: [],
    })
    // An empty array without a successful-fetch stamp is not evidence that the
    // endpoint answered, so it stays absent rather than becoming known-empty.
    expect(parseDiscoveredCache(document).routes['unstamped-gateway']).toBeUndefined()
    // An array of unusable rows is malformed data, not an empty listing.
    expect(parseDiscoveredCache(document).routes['corrupt-gateway']).toBeUndefined()
    expect(discoveredModelsFor('acme-gateway')).toEqual([])
    expect(discoveredModelsFor('unstamped-gateway')).toBeUndefined()
    expect(discoveredModelsFor('corrupt-gateway')).toBeUndefined()
  })

  it('keeps an input-only capacity separate from the combined context window', async () => {
    await cacheFile(cacheWith([
      {
        id: 'sized',
        contextWindow: 200_000,
        maxInputTokens: 128_000,
        maxTokens: 8192,
        source: 'discovered',
        discoveredAt: 15,
      },
      { id: 'bad-cap', contextWindow: 200_000, maxInputTokens: 0, source: 'discovered', discoveredAt: 16 },
    ]))
    const models = discoveredModelsFor('acme-gateway')
    expect(models?.[0]).toMatchObject({
      contextWindow: 200_000,
      maxInputTokens: 128_000,
      maxTokens: 8192,
    })
    // A non-positive cap is undisclosed, not clamped and not copied from the
    // combined window.
    expect(models?.[1]?.maxInputTokens).toBeUndefined()
    expect(models?.[1]?.contextWindow).toBe(200_000)
  })

  it('keeps only canonical effort names and preserves an explicit empty ladder', async () => {
    await cacheFile(cacheWith([
      {
        id: 'mixed',
        reasoning: true,
        reasoningEfforts: { low: 'low', high: 'high', ultra: 'ultra' },
        source: 'discovered',
        discoveredAt: 17,
      },
      {
        id: 'empty',
        reasoning: true,
        reasoningEfforts: {},
        source: 'discovered',
        discoveredAt: 18,
      },
    ]))
    const models = discoveredModelsFor('acme-gateway')
    expect(models?.[0]?.reasoningEfforts).toEqual({ low: 'low', high: 'high' })
    // An unsupported name stays diagnostic metadata; it is never renamed to a
    // canonical level such as max.
    expect(models?.[0]?.unsupportedReasoningEfforts).toEqual(['ultra'])
    expect(models?.[1]?.reasoningEfforts).toEqual({})

    const resolved = resolveProfiles(discoveredRoute().providers).get('acme-gateway')?.piProvider?.getModels()
    expect(resolved?.[0]?.thinkingLevelMap).toMatchObject({
      low: 'low',
      high: 'high',
      max: null,
      xhigh: null,
    })
    // `reasoning: true` never synthesizes a ladder, and the explicit empty
    // ladder disables inferred reasoning instead of becoming undefined.
    expect(resolved?.[1]).toMatchObject({ id: 'empty', reasoning: false })
  })

  it('reads an old-shaped cache file without a ladder or deprecation fields', async () => {
    // Exactly the shape the writer emitted before those fields existed: a
    // version-1 document whose records carry id, capacities, and modalities.
    await cacheFile({
      version: DISCOVERED_CACHE_VERSION,
      routes: {
        'acme-gateway': {
          baseURL: 'https://acme.test',
          fetchedAt: 1_790_000_000_000,
          models: [
            { id: 'legacy', name: 'Legacy', contextWindow: 32_000, maxTokens: 4096, input: ['text', 'image'], reasoning: true, source: 'discovered', discoveredAt: 5 },
          ],
        },
      },
    })
    const model = discoveredModelsFor('acme-gateway')?.[0]
    expect(model).toMatchObject({ id: 'legacy', input: ['text', 'image'] })
    expect(model?.reasoningEfforts).toBeUndefined()
    expect(model?.deprecated).toBeUndefined()
    // The support flag survives without inventing any selectable effort level.
    const resolved = resolveProfiles(discoveredRoute().providers).get('acme-gateway')?.piProvider?.getModels()[0]
    expect(resolved).toMatchObject({ id: 'legacy', reasoning: true, input: ['text', 'image'] })
    expect(resolved?.thinkingLevelMap).toEqual({
      off: null, minimal: null, low: null, medium: null, high: null, xhigh: null, max: null,
    })
  })

  it('reads an unreadable or malformed cache as empty instead of failing resolution', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-discovered-'))
    directories.push(directory)
    const path = join(directory, 'discovered-models.json')
    await writeFile(path, '{ not json', 'utf8')
    process.env.DSH_DISCOVERED_MODELS = path
    resetDiscoveredModelsCache()
    expect(discoveredModelsFor('acme-gateway')).toBeUndefined()
    // A missing file is the same empty answer, not an error.
    process.env.DSH_DISCOVERED_MODELS = join(directory, 'missing.json')
    resetDiscoveredModelsCache()
    expect(discoveredModelsFor('acme-gateway')).toBeUndefined()
  })
})

describe('endpoint-authoritative serving', () => {
  /** The route a preset would add, but with the endpoint as catalog authority. */
  function endpointRoute(): Options {
    return {
      providers: {
        'acme-gateway': { api: 'openai-completions', baseURL: 'https://acme.test', catalogAuthority: 'endpoint' },
      },
    }
  }

  it('serves an empty catalog from a retained successful empty listing', async () => {
    await cacheFile(cacheWith([]))
    expect(() => { assertServiceable(endpointRoute()) }).not.toThrow()
    const resolved = resolveProfiles(endpointRoute().providers).get('acme-gateway')
    expect(resolved?.piProvider?.getModels()).toEqual([])
    expect(resolved?.catalogError).toBeUndefined()

    const catalog = resolveRouteModels({
      provider: 'acme-gateway',
      api: 'openai-completions',
      baseURL: 'https://acme.test',
      discoveredModels: [],
      catalogAuthority: 'endpoint',
      defaultContextWindow: 262_144,
      defaultMaxTokens: 32_768,
      defaultInput: ['text'],
    })
    expect(catalog).toMatchObject({ models: [], knownEmpty: true })
  })

  it('does not treat a missing discovered record as an empty listing', async () => {
    process.env.DSH_DISCOVERED_MODELS = join(tmpdir(), `missing-${String(Date.now())}.json`)
    resetDiscoveredModelsCache()
    expect(() => resolveProfiles(endpointRoute().providers)).toThrow(/resolves no models/)
  })

  it('excludes deprecated records from endpoint authority but keeps them for inspection', async () => {
    await cacheFile(cacheWith([
      { id: 'current', source: 'discovered', discoveredAt: 1 },
      { id: 'retired', deprecated: true, source: 'discovered', discoveredAt: 2 },
    ]))
    // The read layer keeps the retained record so a diagnostics surface can
    // still inspect the facts the endpoint last disclosed.
    expect(discoveredModelsFor('acme-gateway')?.map(model => model.id)).toEqual(['current', 'retired'])

    const endpoint = resolveProfiles(endpointRoute().providers).get('acme-gateway')?.piProvider?.getModels()
    expect(endpoint?.map(model => model.id)).toEqual(['current'])
    // Existing catalog-authority behavior is untouched: a retained record in
    // use is not blanket-hidden.
    const catalog = resolveProfiles(discoveredRoute().providers).get('acme-gateway')?.piProvider?.getModels()
    expect(catalog?.map(model => model.id)).toEqual(['current', 'retired'])
  })

  it('serves a retained record again when a later listing clears its deprecation', async () => {
    const path = await cacheFile(cacheWith([
      { id: 'retired', deprecated: true, source: 'discovered', discoveredAt: 1 },
    ]))
    const ids = (): readonly string[] | undefined =>
      resolveProfiles(endpointRoute().providers).get('acme-gateway')?.piProvider?.getModels().map(model => model.id)
    expect(ids()).toEqual([])
    await writeFile(path, JSON.stringify(cacheWith([
      { id: 'retired', source: 'discovered', discoveredAt: 2 },
    ])), 'utf8')
    resetDiscoveredModelsCache()
    expect(ids()).toEqual(['retired'])
  })

  it('returns input-cap facts distinct from the combined window', () => {
    const catalog = resolveRouteModels({
      provider: 'acme-gateway',
      api: 'openai-completions',
      baseURL: 'https://acme.test',
      catalogAuthority: 'endpoint',
      discoveredModels: [{
        id: 'sized',
        contextWindow: 200_000,
        maxInputTokens: 128_000,
        maxTokens: 8192,
        input: ['text', 'image'],
        source: 'discovered',
        discoveredAt: 1,
      }],
      defaultContextWindow: 262_144,
      defaultMaxTokens: 32_768,
      defaultInput: ['text'],
    })
    expect(catalog.models[0]).toMatchObject({ contextWindow: 200_000, maxTokens: 8192 })
    expect(catalog.facts.get('sized')).toEqual({
      contextWindow: 'discovered',
      maxTokens: 'discovered',
      input: 'discovered',
      inputModalities: ['text', 'image'],
      maxInputTokens: 128_000,
      maxInputTokensSource: 'discovered',
    })
    // A disclosed output capability sizes the model; it never becomes the
    // per-request cap a deployment chose to send.
    expect(catalog.configuredMaxTokens.size).toBe(0)
  })
})

describe('resolution over discovered models', () => {
  it('saves a route whose installed catalog is empty once discovery has seen it', async () => {
    await cacheFile(cacheWith([
      {
        id: 'kilo-auto/efficient',
        name: 'Auto Efficient',
        contextWindow: 1_000_000,
        maxTokens: 65_536,
        input: ['text', 'image'],
        tools: true,
        reasoning: true,
        source: 'discovered',
        discoveredAt: 1_790_000_000_000,
      },
    ]))
    // Strict validation is the settings write path: this must not throw.
    expect(() => { assertServiceable(discoveredRoute()) }).not.toThrow()
    const resolved = resolveProfiles(discoveredRoute().providers).get('acme-gateway')
    expect(resolved?.piProvider?.getModels().map(model => ({
      id: model.id,
      name: model.name,
      api: model.api,
      baseUrl: model.baseUrl,
      input: model.input,
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
      reasoning: model.reasoning,
    }))).toEqual([{
      id: 'kilo-auto/efficient',
      name: 'Auto Efficient',
      api: 'openai-completions',
      baseUrl: 'https://acme.test',
      input: ['text', 'image'],
      contextWindow: 1_000_000,
      maxTokens: 65_536,
      // Disclosed support is kept; no selectable level is invented for it.
      reasoning: true,
    }])
  })

  it('materializes the cached effort ladder instead of losing it at resolution', async () => {
    await cacheFile(cacheWith([
      {
        id: 'thinking',
        contextWindow: 200_000,
        maxTokens: 32_000,
        reasoningEfforts: { low: 'low', medium: 'medium', high: 'high' },
        source: 'discovered',
        discoveredAt: 1,
      },
      // A ladder naming no level pi-ai models is not serviceable; the route
      // resolves without reasoning instead of refusing the whole cache.
      { id: 'foreign-ladder', reasoningEfforts: { thinking: 'thinking' }, source: 'discovered', discoveredAt: 2 },
    ]))
    const models = resolveProfiles(discoveredRoute().providers).get('acme-gateway')?.piProvider?.getModels()
    expect(models?.[0]).toMatchObject({ id: 'thinking', reasoning: true })
    expect(models?.[0]?.thinkingLevelMap).toMatchObject({
      off: null,
      minimal: null,
      low: 'low',
      medium: 'medium',
      high: 'high',
      xhigh: null,
      max: null,
    })
    expect(models?.[1]).toMatchObject({ id: 'foreign-ladder', reasoning: false })
  })

  it('materializes an unverified model conservatively: text only, no reasoning, route capacity', async () => {
    await cacheFile(cacheWith([
      { id: 'mystery-1', source: 'discovered', discoveredAt: 7, unverified: true },
    ]))
    const resolved = resolveProfiles(discoveredRoute().providers).get('acme-gateway')
    const model = resolved?.piProvider?.getModels()[0]
    expect(model).toMatchObject({ id: 'mystery-1', name: 'mystery-1', input: ['text'], reasoning: false })
    expect(model?.contextWindow).toBe(262_144)
    expect(model?.maxTokens).toBe(32_768)
  })

  it('materializes a discovered record declared with disclosure-side modalities as its wire subset', async () => {
    await cacheFile(cacheWith([
      { id: 'wide', input: ['text', 'image', 'audio', 'video', 'pdf'], source: 'discovered', discoveredAt: 11 },
    ]))
    const model = resolveProfiles(discoveredRoute().providers).get('acme-gateway')?.piProvider?.getModels()[0]
    expect(model?.input).toEqual(['text', 'image'])
  })

  it('keeps the clear error, with the manual affordance, when nothing has discovered the route', async () => {
    await cacheFile(cacheWith([]))
    let message = ''
    try {
      resolveProfiles(discoveredRoute().providers)
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }
    expect(message).toContain('resolves no models')
    expect(message).toContain('added manually on the Models page')
    // A discovered route with no baseURL cannot be materialized even from the
    // cache: discovery says what the models are, not where to reach them.
    await cacheFile(cacheWith([{ id: 'm', source: 'discovered', discoveredAt: 1 }]))
    expect(() => resolveProfiles({ 'acme-gateway': { api: 'openai-completions', models: [] } }))
      .toThrow(/needs a baseURL/)
  })

  it('never lets discovery shadow the installed catalog', async () => {
    await cacheFile({
      version: DISCOVERED_CACHE_VERSION,
      routes: { deepseek: { fetchedAt: 1, models: [{ id: 'not-a-deepseek-model', source: 'discovered', discoveredAt: 1 }] } },
    })
    const resolved = resolveProfiles({ deepseek: {} }).get('deepseek')
    expect(resolved?.piProvider?.getModels().some(model => model.id === 'not-a-deepseek-model')).toBe(false)
  })

  it('re-reads the cache when a sync pass rewrites it', async () => {
    const path = await cacheFile(cacheWith([{ id: 'first', source: 'discovered', discoveredAt: 1 }]))
    expect(resolveProfiles(discoveredRoute().providers).get('acme-gateway')?.piProvider?.getModels().map(model => model.id))
      .toEqual(['first'])
    await writeFile(path, JSON.stringify(cacheWith([{ id: 'second', source: 'discovered', discoveredAt: 2 }])), 'utf8')
    resetDiscoveredModelsCache()
    expect(resolveProfiles(discoveredRoute().providers).get('acme-gateway')?.piProvider?.getModels().map(model => model.id))
      .toEqual(['second'])
  })

  it('sees a same-size rewrite inside one mtime tick (content sample beats mtime:size)', async () => {
    const path = await cacheFile(cacheWith([{ id: 'aaaaa', source: 'discovered', discoveredAt: 1 }]))
    const fixed = 1_700_000_000
    utimesSync(path, fixed, fixed)
    resetDiscoveredModelsCache()
    expect(discoveredModelsFor('acme-gateway')?.map(model => model.id)).toEqual(['aaaaa'])
    const stampBefore = discoveredModelsStamp()
    const before = statSync(path)
    // Same byte length, different content, restored to the exact same mtime:
    // only a content check (not mtime:size) can tell the rewrite happened.
    await writeFile(path, JSON.stringify(cacheWith([{ id: 'bbbbb', source: 'discovered', discoveredAt: 1 }])), 'utf8')
    utimesSync(path, fixed, fixed)
    const after = statSync(path)
    expect(after.size).toBe(before.size)
    expect(after.mtimeMs).toBe(before.mtimeMs)
    expect(discoveredModelsStamp()).not.toBe(stampBefore)
    expect(discoveredModelsFor('acme-gateway')?.map(model => model.id)).toEqual(['bbbbb'])
  })
})
