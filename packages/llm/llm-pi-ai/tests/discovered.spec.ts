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
      { id: 'bad', contextWindow: -1, input: ['audio'], discoveredAt: 'later' },
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
      reasoning: false,
    }])
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
})
