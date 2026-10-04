import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  describeSyncFailure,
  discoveredCachePath,
  fetchModels,
  isCatalogRoute,
  mergeConfiguredModels,
  mergeDiscoveredModels,
  mergeDiscoveredRoute,
  modelsDevCachePath,
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
  await Promise.all(servers.splice(0).map(server => new Promise(resolve => server.close(resolve))))
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

/** Serve one scripted `GET /models` reply and record that it was asked. */
async function listingServer(status: number, body: string): Promise<{ url: string; paths: string[] }> {
  const paths: string[] = []
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    paths.push(request.url ?? '')
    response.writeHead(status, { 'content-type': 'application/json' })
    response.end(body)
  })
  servers.push(server)
  await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no port')
  return { url: `http://127.0.0.1:${String(address.port)}`, paths }
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
