import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { existsSync, readFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Config } from '../src/index.ts'
import {
  apply,
  commandCodeCatalogPath,
  describeSyncFailure,
  discoveredCachePath,
  fetchModels,
  isCatalogRoute,
  loadCommandCodeCatalog,
  mergeConfiguredModels,
  mergeDiscoveredModels,
  mergeDiscoveredRoute,
  modelListingRequest,
  modelsDevCachePath,
  modelsDevCostTiers,
  modelsDevReleaseDate,
  normalizeListingEntry,
  osCacheDir,
  refreshModelsDevOnline,
  resolveDshHome,
  writeDiscoveredRoute,
} from '../src/index.ts'

const servers: Server[] = []
const directories: string[] = []

afterEach(async () => {
  vi.unstubAllGlobals()
  Reflect.deleteProperty(process.env, 'DSH_DISCOVERED_MODELS')
  Reflect.deleteProperty(process.env, 'DSH_COMMANDCODE_CATALOG')
  await Promise.all(servers.splice(0).map(server => new Promise(resolve => server.close(resolve))))
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

/** Serve one scripted listing reply and record each request's path and headers. */
async function listingServer(
  status: number,
  body: string,
): Promise<{ url: string; paths: string[]; headers: Array<Record<string, string | string[] | undefined>> }> {
  const paths: string[] = []
  const headers: Array<Record<string, string | string[] | undefined>> = []
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    paths.push(request.url ?? '')
    headers.push({ ...request.headers })
    response.writeHead(status, { 'content-type': 'application/json' })
    response.end(body)
  })
  servers.push(server)
  await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no port')
  return { url: `http://127.0.0.1:${String(address.port)}`, paths, headers }
}

/** One Kilo-shaped `:free` model, fully disclosed. */
const DISCLOSED = {
  id: 'vendor/model:free',
  name: 'Vendor Model (Free)',
  context_length: 131_072,
  top_provider: { context_length: 131_072, max_completion_tokens: 8192 },
  architecture: { input_modalities: ['text', 'image'] },
  supported_parameters: ['tools', 'reasoning'],
  pricing: { prompt: '0', completion: '0' },
  isFree: true,
}

/** A row that discloses nothing but its id. */
const UNDISCLOSED = { id: 'zzz-mystery-endpoint-model-77' }

describe('listing normalization', () => {
  it('reads capacities, modalities, tools, pricing, and free-ness, and dedupes ids', async () => {
    const { url, paths } = await listingServer(200, JSON.stringify({ data: [DISCLOSED, DISCLOSED, UNDISCLOSED, { not: 'a model' }] }))
    const live = await fetchModels(url, undefined)
    expect(paths).toEqual(['/models'])
    expect(live.map(model => model.id)).toEqual(['vendor/model:free', 'zzz-mystery-endpoint-model-77'])
    expect(live[0]).toEqual({
      id: 'vendor/model:free',
      name: 'Vendor Model (Free)',
      contextWindow: 131_072,
      maxTokens: 8192,
      input: ['text', 'image'],
      tools: true,
      reasoning: true,
      pricing: { prompt: '0', completion: '0' },
      isFree: true,
    })
    // An id-only row stays id-only: nothing is invented for it.
    expect(live[1]).toEqual({ id: 'zzz-mystery-endpoint-model-77' })
    expect(normalizeListingEntry({ id: 'x', supported_parameters: ['temperature'] }))
      .toMatchObject({ id: 'x', tools: false, reasoning: false })
  })

  it('maps the full modality vocabulary from a listing and drops unknown tokens', () => {
    expect(normalizeListingEntry({
      id: 'omni',
      architecture: { input_modalities: ['text', 'image', 'audio', 'video', 'pdf', 'file'] },
    })?.input).toEqual(['text', 'image', 'audio', 'video', 'pdf'])
    // `vision` is the one alias mapped; an unrecognized token is not guessed at.
    expect(normalizeListingEntry({ id: 'v', input_modalities: ['vision'] })?.input).toEqual(['image'])
    expect(normalizeListingEntry({ id: 'u', input_modalities: ['file'] })).toEqual({ id: 'u' })
  })

  it('marks a listing-marked non-free model gated with the sign-in reason', () => {
    // The Kilo listing carries `isFree` per row: 18 free, 376 sign-in/paid-only.
    const paid = normalizeListingEntry({ id: 'kilo-auto/efficient', isFree: false })
    expect(paid).toMatchObject({ id: 'kilo-auto/efficient', isFree: false, gated: true, gateReason: 'sign-in required' })
    // A free model is not gated; an undisclosed price is not a gate either.
    expect(normalizeListingEntry({ id: 'kilo-auto/free', isFree: true })).toEqual({ id: 'kilo-auto/free', isFree: true })
    expect(normalizeListingEntry({ id: 'mystery' })).toEqual({ id: 'mystery' })
  })
})

describe('discovered-cache records', () => {
  it('marks a model nothing described as unverified and keeps it at the capability floor', () => {
    const [record] = mergeDiscoveredModels('kilo', [{ id: 'zzz-mystery-endpoint-model-77' }], undefined)
    expect(record).toEqual({ id: 'zzz-mystery-endpoint-model-77', name: 'Zzz Mystery Endpoint Model 77', contextWindow: 262_144, maxTokens: 32_768, unverified: true })
    const [known] = mergeDiscoveredModels('kilo', [{ id: 'vendor/model:free', input: ['text', 'image'], tools: true }], undefined)
    expect(known).toMatchObject({ input: ['text', 'image'], tools: true })
    expect(known?.unverified).toBeUndefined()
  })

  it('persists the gate flag and reason through the discovered and configured records', () => {
    const [discovered] = mergeDiscoveredModels('kilo', [{ id: 'kilo-auto/efficient', isFree: false }], undefined)
    expect(discovered).toMatchObject({ id: 'kilo-auto/efficient', isFree: false, gated: true, gateReason: 'sign-in required' })
    expect(discovered?.gated).toBe(true)
    const merge = mergeConfiguredModels(
      'kilo',
      [{ id: 'kilo-auto/efficient', name: 'Auto Efficient', contextWindow: 1_000_000, maxTokens: 65_536 }],
      [{ id: 'kilo-auto/efficient', isFree: false }],
      undefined,
    )
    expect(merge.models[0]).toMatchObject({ id: 'kilo-auto/efficient', gated: true, gateReason: 'sign-in required' })
  })

  it('is idempotent: an unchanged listing keeps every discoveredAt and fetchedAt', () => {
    const models = mergeDiscoveredModels('kilo', [{ id: 'a' }, { id: 'b' }], undefined)
    const first = mergeDiscoveredRoute(undefined, 'https://kilo.test', models, 1000)
    expect(first.models.map(model => model.discoveredAt)).toEqual([1000, 1000])
    const second = mergeDiscoveredRoute(first, 'https://kilo.test', models, 2000)
    expect(second).toEqual(first)
    expect(second.fetchedAt).toBe(1000)
    // A changed entry re-stamps only itself; its siblings keep their stamp.
    const changed = mergeDiscoveredRoute(first, 'https://kilo.test', [{ ...models[0]!, name: 'renamed' }, models[1]!], 2000)
    expect(changed.models.map(model => model.discoveredAt)).toEqual([2000, 1000])
    expect(changed.fetchedAt).toBe(2000)
  })

  it('writes the cache atomically and byte-identically for an unchanged listing', () => {
    const directory = mkdtempSync(join(tmpdir(), 'dsh-sync-'))
    directories.push(directory)
    process.env.DSH_DISCOVERED_MODELS = join(directory, 'discovered-models.json')
    const record = mergeDiscoveredRoute(undefined, 'https://kilo.test', mergeDiscoveredModels('kilo', [{ id: 'a' }], undefined), 1234)
    writeDiscoveredRoute('kilo', record)
    const first = readFileSync(discoveredCachePath(), 'utf8')
    writeDiscoveredRoute('kilo', mergeDiscoveredRoute(record, 'https://kilo.test', mergeDiscoveredModels('kilo', [{ id: 'a' }], undefined), 9999))
    expect(readFileSync(discoveredCachePath(), 'utf8')).toBe(first)
    expect(JSON.parse(first).routes.kilo).toMatchObject({ fetchedAt: 1234, models: [{ id: 'a', source: 'discovered', discoveredAt: 1234 }] })
  })
})

describe('configured-model merge', () => {
  it('keeps a configured model the listing omits, marked with its provenance', () => {
    const configured = [
      { id: 'hand-added', name: 'Hand Added Model', contextWindow: 111_111, maxTokens: 222 },
      { id: 'advertised', name: 'Stale Hand Name', contextWindow: 1, maxTokens: 1 },
    ]
    const merge = mergeConfiguredModels('kilo', configured, [{ id: 'advertised', input: ['text'], tools: true }], undefined)
    expect(merge.unadvertised).toEqual(['hand-added'])
    expect(merge.models.map(model => model.id)).toEqual(['hand-added', 'advertised'])
    expect(merge.models[0]).toMatchObject({
      id: 'hand-added', name: 'Hand Added Model', contextWindow: 111_111, maxTokens: 222, source: 'configured',
    })
    // The advertised entry was refreshed from the listing, and lost no provenance it never had.
    expect(merge.models[1]).toMatchObject({ id: 'advertised', tools: true })
    expect(merge.models[1]!.source).toBeUndefined()
  })

  it('appends live entries the configuration does not name, after the configured ones', () => {
    const merge = mergeConfiguredModels('kilo', [{ id: 'kept' }], [{ id: 'kept' }, { id: 'new-one' }], undefined)
    expect(merge.unadvertised).toEqual([])
    expect(merge.models.map(model => model.id)).toEqual(['kept', 'new-one'])
  })

  it('keeps malformed configured rows and dedupes repeated ids', () => {
    const merge = mergeConfiguredModels('kilo', [{ name: 'No id' }, { id: 'dup' }, { id: 'dup' }], [], undefined)
    expect(merge.models).toHaveLength(2)
    expect(merge.models[0]).toEqual({ name: 'No id' })
    expect(merge.models[1]).toMatchObject({ id: 'dup', source: 'configured' })
    expect(merge.unadvertised).toEqual(['dup'])
  })
})

describe('honest fallbacks', () => {
  it('reports a failed fetch with the manual affordance, and never writes a record', async () => {
    const { url } = await listingServer(503, '{"error":"down"}')
    let error: unknown
    try {
      await fetchModels(url, undefined)
    } catch (caught) {
      error = caught
    }
    const advice = describeSyncFailure('kilo', error)
    expect(advice).toContain('sync failed')
    expect(advice).toContain('HTTP 503')
    expect(advice).toContain('add models manually on the Models page')
    expect(advice).toContain('llm-pi-ai.providers["kilo"].models')
  })

  it('knows which routes the installed catalog already describes', () => {
    expect(isCatalogRoute('deepseek')).toBe(true)
    expect(isCatalogRoute('kilo')).toBe(false)
  })
})

describe('portable paths and refresh diagnostics', () => {
  it('derives the OpenCode models cache from the OS cache dir, never a literal home', () => {
    expect(osCacheDir({ XDG_CACHE_HOME: '/xdg/cache', HOME: '/users/jo' }, 'linux')).toBe('/xdg/cache')
    expect(modelsDevCachePath({ XDG_CACHE_HOME: '/xdg/cache', HOME: '/users/jo' }, 'linux')).toBe(join('/xdg/cache', 'opencode', 'models.json'))
    expect(modelsDevCachePath({ HOME: '/users/jo' }, 'linux')).toBe(join('/users/jo', '.cache', 'opencode', 'models.json'))
    expect(modelsDevCachePath({ HOME: '/Users/jo' }, 'darwin')).toBe(join('/Users/jo', 'Library', 'Caches', 'opencode', 'models.json'))
    expect(modelsDevCachePath({ LOCALAPPDATA: 'C:\\Users\\jo\\AppData\\Local' }, 'win32')).toBe(join('C:\\Users\\jo\\AppData\\Local', 'opencode', 'models.json'))
    expect(JSON.stringify(modelsDevCachePath({ HOME: '/users/jo' }, 'linux'))).not.toContain('/home/')
  })

  it('resolves DSH home from DSH_HOME, then the real home, without assuming a user name', () => {
    expect(resolveDshHome({ DSH_HOME: '/srv/dsh', HOME: '/users/jo' }, 'linux')).toBe('/srv/dsh')
    expect(resolveDshHome({ HOME: '/users/jo' }, 'linux')).toBe(join('/users/jo', '.dsh'))
    expect(resolveDshHome({ USERPROFILE: 'C:\\Users\\jo' }, 'win32')).toBe(join('C:\\Users\\jo', '.dsh'))
    expect(discoveredCachePath()).toBe(join(resolveDshHome(), 'cache', 'discovered-models.json'))
  })

  it('reports a coded incident and keeps serving when the online refresh fails', async () => {
    const calls: Array<{ kind: string; message: string }> = []
    vi.stubGlobal('fetch', async () => { throw new Error('network down') })
    await refreshModelsDevOnline((kind, message) => { calls.push({ kind, message }) })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.kind).toBe('provider-sync/models-dev-fetch')
    expect(calls[0]?.message).toContain('network down')
    expect(calls[0]?.message).toContain('local cache kept')
  })

  it('reports a non-OK status instead of swallowing it', async () => {
    const calls: Array<{ kind: string; message: string }> = []
    vi.stubGlobal('fetch', async () => ({ ok: false, status: 503, json: async () => ({}) }))
    await refreshModelsDevOnline((kind, message) => { calls.push({ kind, message }) })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.kind).toBe('provider-sync/models-dev-fetch')
    expect(calls[0]?.message).toContain('HTTP 503')
  })
})

describe('protocol-aware listing', () => {
  it('an Anthropic-Messages route lists at the root /v1/models with the version and key headers', async () => {
    const { url, paths, headers } = await listingServer(200, JSON.stringify({
      data: [{ id: 'claude-sonnet-4-6', description: 'Claude Sonnet 4.6 (Thinking)' }],
    }))
    const live = await fetchModels(`${url}/v1`, 'sk-ant', 'anthropic-messages')
    expect(paths).toEqual(['/v1/models?limit=1000'])
    expect(headers[0]?.['anthropic-version']).toBe('2023-06-01')
    expect(headers[0]?.['x-api-key']).toBe('sk-ant')
    expect(headers[0]?.authorization).toBeUndefined()
    expect(live).toEqual([{ id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6 (Thinking)' }])
  })

  it('an Anthropic-Messages route without a key sends no credential header', async () => {
    const { url, headers } = await listingServer(200, JSON.stringify({ data: [{ id: 'gemini-3-flash' }] }))
    await fetchModels(url, undefined, 'anthropic-messages')
    expect(headers[0]?.['x-api-key']).toBeUndefined()
    expect(headers[0]?.authorization).toBeUndefined()
  })

  it('OpenAI-protocol routes keep {base}/models with a Bearer token', async () => {
    const { url, paths, headers } = await listingServer(200, JSON.stringify({ data: [{ id: 'vendor/model' }] }))
    await fetchModels(`${url}/v1`, 'sk-openai', 'openai-completions')
    expect(paths).toEqual(['/v1/models'])
    expect(headers[0]?.authorization).toBe('Bearer sk-openai')
    expect(headers[0]?.['anthropic-version']).toBeUndefined()
    expect(headers[0]?.['x-api-key']).toBeUndefined()
  })

  it('derives the listing request without a network call, matching the heavy planner normalization', () => {
    expect(modelListingRequest('http://127.0.0.1:8082', 'anthropic-messages', 'k').url).toBe('http://127.0.0.1:8082/v1/models?limit=1000')
    expect(modelListingRequest('http://127.0.0.1:8082/', 'anthropic-messages').url).toBe('http://127.0.0.1:8082/v1/models?limit=1000')
    expect(modelListingRequest('http://127.0.0.1:8082/v1', 'anthropic-messages').url).toBe('http://127.0.0.1:8082/v1/models?limit=1000')
    expect(modelListingRequest('http://127.0.0.1:3002/v1', 'openai-completions').url).toBe('http://127.0.0.1:3002/v1/models')
    expect(modelListingRequest('http://127.0.0.1:8082', undefined).url).toBe('http://127.0.0.1:8082/models')
  })
})

describe('Command Code catalog', () => {
  it('reads the bundled snapshot as a listing with its capability disclosures', () => {
    const directory = mkdtempSync(join(tmpdir(), 'dsh-snapshot-'))
    directories.push(directory)
    const path = join(directory, 'catalog.snapshot.json')
    writeFileSync(path, JSON.stringify([
      {
        id: 'vendor/model-a', name: 'Model A [Go+]', reasoning: false, tool_call: true,
        modalities: { input: ['text'] }, limit: { context: 200_000, output: 8192 },
      },
      { id: 'vendor/model-b', name: 'Model B', attachment: true },
      { not: 'a model' },
    ]))
    const models = loadCommandCodeCatalog(path)
    expect(models.map(model => model.id)).toEqual(['vendor/model-a', 'vendor/model-b'])
    expect(models[0]).toMatchObject({
      id: 'vendor/model-a', name: 'Model A [Go+]', contextWindow: 200_000, maxTokens: 8192,
      input: ['text'], tools: true, reasoning: false,
    })
    // `attachment: true` is the catalog's vision disclosure, like the adapter's own `visionOf`.
    expect(models[1]).toMatchObject({ id: 'vendor/model-b', input: ['text', 'image'] })
  })

  it('resolves the sibling provider package snapshot by default', () => {
    expect(commandCodeCatalogPath()).toMatch(/enpoi-commandcode-provider\/catalog\.snapshot\.json$/)
    expect(loadCommandCodeCatalog().length).toBeGreaterThan(0)
  })

  it('fails loudly on a missing or model-less snapshot so the caller never clobbers a route', () => {
    const directory = mkdtempSync(join(tmpdir(), 'dsh-snapshot-'))
    directories.push(directory)
    const empty = join(directory, 'empty.json')
    writeFileSync(empty, '[]')
    expect(() => loadCommandCodeCatalog(join(directory, 'missing.json'))).toThrow()
    expect(() => loadCommandCodeCatalog(empty)).toThrow(/held no usable models/)
  })
})

/** One route profile the sync harness configures. */
interface HarnessRoute {
  baseURL?: string
  api?: string
  models?: Array<Record<string, unknown>>
}

/** The mutations and logs one mounted sync harness produced. */
interface SyncHarness {
  mutations: Array<{ ns: string; ops: Array<{ op: string; path: string[]; value: Array<Record<string, unknown>> }>; revision: number | undefined }>
  warnings: string[]
  infos: string[]
  dispose: () => void
}

/** Mount `apply` over a stub settings seam with one pass scheduled immediately. */
function syncHarness(
  llm: Record<string, HarnessRoute> | undefined,
  commandcode: Record<string, HarnessRoute> = {},
  options: { conflicts?: number } = {},
): SyncHarness {
  const mutations: SyncHarness['mutations'] = []
  const warnings: string[] = []
  const infos: string[] = []
  let conflicts = options.conflicts ?? 0
  const settings = {
    describe: () => [
      ...(llm === undefined ? [] : [{ ns: 'llm-pi-ai', revision: 7, value: { providers: llm } }]),
      ...(Object.keys(commandcode).length === 0 ? [] : [{ ns: 'commandcode-provider', revision: 3, value: { providers: commandcode } }]),
    ],
    mutate: async (ns: string, ops: SyncHarness['mutations'][number]['ops'], revision: number | undefined) => {
      mutations.push({ ns, ops, revision })
      if (conflicts > 0) {
        conflicts -= 1
        throw Object.assign(new Error('settings conflict'), { code: 'SETTINGS_CONFLICT' })
      }
    },
  }
  let cleanup: (() => void) | undefined
  const ctx = {
    logger: () => ({
      debug: () => {},
      info: (message: string) => { infos.push(message) },
      warn: (message: string) => { warnings.push(message) },
    }),
    get: (service: string) => service === 'settings' ? settings : undefined,
    effect: (callback: () => () => void) => {
      cleanup = callback()
      return () => { cleanup?.() }
    },
  }
  apply(ctx as unknown as Context, {
    intervalMs: { get: () => 3_600_000 },
    syncOnStart: { get: () => true },
    syncDelayMs: { get: () => 0 },
    endpoints: { get: () => ({}) },
    capacityDefaults: { get: () => ({}) },
  })
  return {
    mutations,
    warnings,
    infos,
    dispose: () => { cleanup?.() },
  }
}

/** Stub global fetch: models.dev answers 503, provider URLs reach the test servers. */
function stubProviderNetwork(): { probes: string[] } {
  const probes: string[] = []
  const realFetch = globalThis.fetch
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.startsWith('https://models.dev/')) return { ok: false, status: 503, json: async () => ({}) }
    probes.push(url)
    return await realFetch(input, init)
  })
  return { probes }
}

describe('route passes', () => {
  it('populates an antigravity route catalog from the stubbed /v1/models', async () => {
    const { url, paths, headers } = await listingServer(200, JSON.stringify({
      object: 'list',
      data: [
        { id: 'claude-sonnet-4-6', object: 'model', description: 'Claude Sonnet 4.6 (Thinking)' },
        { id: 'gemini-3.1-pro-high', object: 'model', description: 'Gemini 3.1 Pro (High)' },
      ],
    }))
    const directory = mkdtempSync(join(tmpdir(), 'dsh-sync-'))
    directories.push(directory)
    process.env.DSH_DISCOVERED_MODELS = join(directory, 'discovered-models.json')
    const { probes } = stubProviderNetwork()
    const harness = syncHarness({ antigravity: { baseURL: url, api: 'anthropic-messages', models: [] } })
    try {
      await vi.waitFor(() => { expect(harness.mutations).toHaveLength(1) })
      expect(paths).toEqual(['/v1/models?limit=1000'])
      expect(headers[0]?.['anthropic-version']).toBe('2023-06-01')
      expect(probes).toEqual([`${url}/v1/models?limit=1000`])
      expect(harness.mutations[0]!.ns).toBe('llm-pi-ai')
      expect(harness.mutations[0]!.ops[0]!.path).toEqual(['providers', 'antigravity', 'models'])
      expect(harness.mutations[0]!.ops[0]!.value.map(model => model.id)).toEqual(['claude-sonnet-4-6', 'gemini-3.1-pro-high'])
      // The discovered cache carries the same listing for the resolution layer.
      const discovered = JSON.parse(readFileSync(join(directory, 'discovered-models.json'), 'utf8')) as {
        routes: Record<string, { models: Array<{ id: string }> }>
      }
      expect(discovered.routes.antigravity?.models.map(model => model.id)).toEqual(['claude-sonnet-4-6', 'gemini-3.1-pro-high'])
    } finally {
      harness.dispose()
    }
  })

  it('keeps a 404 route fail-soft and leaves its configured catalog and cache untouched', async () => {
    const { url } = await listingServer(404, '{"error":"not found"}')
    const directory = mkdtempSync(join(tmpdir(), 'dsh-sync-'))
    directories.push(directory)
    process.env.DSH_DISCOVERED_MODELS = join(directory, 'discovered-models.json')
    stubProviderNetwork()
    const harness = syncHarness({
      antigravity: { baseURL: url, api: 'anthropic-messages', models: [{ id: 'kept-model', name: 'Kept Model' }] },
    })
    try {
      await vi.waitFor(() => {
        expect(harness.warnings.some(message => message.includes('HTTP 404'))).toBe(true)
      })
      expect(harness.mutations).toHaveLength(0)
      expect(existsSync(join(directory, 'discovered-models.json'))).toBe(false)
    } finally {
      harness.dispose()
    }
  })

  it('syncs the Command Code namespace even when llm-pi-ai carries no providers', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'dsh-sync-'))
    directories.push(directory)
    const snapshot = join(directory, 'catalog.snapshot.json')
    writeFileSync(snapshot, JSON.stringify([{ id: 'zzz-commandcode-model-b', name: 'Model B' }]))
    process.env.DSH_COMMANDCODE_CATALOG = snapshot
    stubProviderNetwork()
    const harness = syncHarness(undefined, { commandcode: { baseURL: 'https://api.commandcode.ai', models: [] } })
    try {
      await vi.waitFor(() => { expect(harness.mutations).toHaveLength(1) })
      expect(harness.mutations[0]!.ns).toBe('commandcode-provider')
      expect(harness.mutations[0]!.ops[0]!.value.map(model => model.id)).toEqual(['zzz-commandcode-model-b'])
    } finally {
      harness.dispose()
    }
  })

  it('merges the Command Code route from the bundled snapshot without probing any endpoint', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'dsh-sync-'))
    directories.push(directory)
    const snapshot = join(directory, 'catalog.snapshot.json')
    writeFileSync(snapshot, JSON.stringify([
      {
        id: 'zzz-commandcode-model-a', name: 'Model A [Go+]', reasoning: true, tool_call: true,
        modalities: { input: ['text', 'image'] }, limit: { context: 1_000_000, output: 384_000 },
      },
    ]))
    process.env.DSH_COMMANDCODE_CATALOG = snapshot
    process.env.DSH_DISCOVERED_MODELS = join(directory, 'discovered-models.json')
    const { probes } = stubProviderNetwork()
    const harness = syncHarness({}, {
      commandcode: { baseURL: 'https://api.commandcode.ai', api: 'commandcode/alpha-generate', models: [{ id: 'hand-model' }] },
    })
    try {
      await vi.waitFor(() => { expect(harness.mutations).toHaveLength(1) })
      // No `{baseURL}/models` probe and no `/catalog.json` fetch: the snapshot is the source.
      expect(probes).toEqual([])
      expect(harness.mutations[0]!.ns).toBe('commandcode-provider')
      expect(harness.mutations[0]!.ops[0]!.path).toEqual(['providers', 'commandcode', 'models'])
      const written = harness.mutations[0]!.ops[0]!.value
      expect(written.map(model => model.id)).toEqual(['hand-model', 'zzz-commandcode-model-a'])
      expect(written[0]).toMatchObject({ id: 'hand-model', source: 'configured' })
      expect(written[1]).toMatchObject({
        id: 'zzz-commandcode-model-a', name: 'Model A [Go+]',
        contextWindow: 1_000_000, maxTokens: 384_000, input: ['text', 'image'],
        reasoning: true, tools: true,
      })
      // The discovered cache is llm-pi-ai's; Command Code resolves its own adapter catalog.
      expect(existsSync(join(directory, 'discovered-models.json'))).toBe(false)
    } finally {
      harness.dispose()
    }
  })

  it('retries a SETTINGS_CONFLICT and still lands the merge', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'dsh-sync-'))
    directories.push(directory)
    const snapshot = join(directory, 'catalog.snapshot.json')
    writeFileSync(snapshot, JSON.stringify([{ id: 'zzz-commandcode-model-c', name: 'Model C' }]))
    process.env.DSH_COMMANDCODE_CATALOG = snapshot
    stubProviderNetwork()
    const harness = syncHarness({}, { commandcode: { baseURL: 'https://api.commandcode.ai', models: [] } }, { conflicts: 1 })
    try {
      await vi.waitFor(() => { expect(harness.mutations).toHaveLength(2) })
      expect(harness.mutations.map(mutation => mutation.revision)).toEqual([3, 3])
      expect(harness.mutations[1]!.ops[0]!.value.map(model => model.id)).toEqual(['zzz-commandcode-model-c'])
    } finally {
      harness.dispose()
    }
  })
})

describe('models.dev display tags', () => {
  it('accepts published release dates and normalizes the price tiers', () => {
    expect(modelsDevReleaseDate('2026-05-21')).toBe('2026-05-21')
    expect(modelsDevReleaseDate('2026-5-1')).toBeUndefined()
    expect(modelsDevReleaseDate('not-a-date')).toBeUndefined()
    expect(modelsDevReleaseDate(20260521)).toBeUndefined()

    expect(modelsDevCostTiers({
      input: 2,
      output: 12,
      tiers: [
        { input: 3, output: 18, tier: { type: 'context', size: 128_000 } },
        { input: 9, tier: { size: 0 } },
        { input: 5, output: 'free', tier: { size: 64_000 } },
      ],
      context_over_200k: { input: 4, output: 24 },
    })).toEqual([
      { inputTokensAbove: 64_000, input: 5 },
      { inputTokensAbove: 128_000, input: 3, output: 18 },
      { inputTokensAbove: 200_000, input: 4, output: 24 },
    ])
    // The named 200K tier is not duplicated when `tiers` already carries it.
    expect(modelsDevCostTiers({ tiers: [{ input: 4, tier: { size: 200_000 } }], context_over_200k: { input: 4 } }))
      .toEqual([{ inputTokensAbove: 200_000, input: 4 }])
    expect(modelsDevCostTiers({ input: 2 })).toBeUndefined()
    expect(modelsDevCostTiers(undefined)).toBeUndefined()
  })

  it('carries release dates and cost tiers into the settings and discovered entries', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'dsh-models-dev-'))
    directories.push(directory)
    const cache = join(directory, 'opencode', 'models.json')
    mkdirSync(dirname(cache), { recursive: true })
    writeFileSync(cache, JSON.stringify({
      'zzz-provider': {
        id: 'zzz-provider',
        models: {
          'zzz-tagged-model': {
            id: 'zzz-tagged-model',
            name: 'Tagged Model',
            release_date: '2026-05-21',
            modalities: { input: ['text', 'image', 'audio', 'video', 'pdf', 'hologram'] },
            cost: { input: 2, output: 12, context_over_200k: { input: 4, output: 24 } },
          },
        },
      },
    }))
    const previous = process.env.XDG_CACHE_HOME
    process.env.XDG_CACHE_HOME = directory
    try {
      // A fresh module copy, so the memoized models.dev database is the one
      // written above rather than whatever the host machine has cached.
      vi.resetModules()
      const fresh = await import('../src/index.ts')
      const settings = fresh.mergeConfiguredModels('zzz-provider', undefined, [{ id: 'zzz-tagged-model' }], undefined)
      expect(settings.models[0]).toMatchObject({
        id: 'zzz-tagged-model',
        input: ['text', 'image', 'audio', 'video', 'pdf'],
        releaseDate: '2026-05-21',
        costTiers: [{ inputTokensAbove: 200_000, input: 4, output: 24 }],
      })
      const [discovered] = fresh.mergeDiscoveredModels('zzz-provider', [{ id: 'zzz-tagged-model' }], undefined)
      expect(discovered).toMatchObject({
        releaseDate: '2026-05-21',
        costTiers: [{ inputTokensAbove: 200_000, input: 4, output: 24 }],
      })
    } finally {
      if (previous === undefined) Reflect.deleteProperty(process.env, 'XDG_CACHE_HOME')
      else process.env.XDG_CACHE_HOME = previous
    }
  })
})
