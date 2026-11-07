/**
 * LISTING OUTCOME: discovery keeps a valid empty endpoint listing distinct
 * from an invalid body, an unauthorized reply, and an unreachable endpoint.
 * An endpoint-authoritative route never refills those answers from another
 * provider's namespace discovery, and an implicit add refuses to write a
 * loopback route when no instance answered. An explicit custom route stays
 * saveable while its catalog reports the honest failed outcome.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { manifestById } from '../src/manifests.js'
import {
  discoverModelListing,
  discoverModels,
  discoverServiceCatalog,
  discoverServiceModels,
  routeProfile,
  useDetectedInstance,
  type FetchLike,
  type HeavyDeps,
  type ModelDiscoverySeam,
  type SettingsSeam,
} from '../src/planner.js'

const scratch: string[] = []
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** One service manifest marked endpoint-authoritative before the field is table data. */
function endpointManifest(id: 'freellmapi' | 'meridian' = 'freellmapi') {
  return { ...manifestById(id)!, catalogAuthority: 'endpoint' as const }
}

/** A deps bundle with recording settings/credentials and an optional discovery seam. */
function depsWith(fetch: FetchLike, llm?: ModelDiscoverySeam): {
  deps: HeavyDeps
  mutations: Array<{ ns: string; ops: readonly Record<string, unknown>[] }>
  credentialSets: Array<{ ref: string; value: string }>
  runStep: ReturnType<typeof vi.fn>
} {
  const root = mkdtempSync(join(tmpdir(), 'heavy-listing-'))
  scratch.push(root)
  const mutations: Array<{ ns: string; ops: readonly Record<string, unknown>[] }> = []
  const credentialSets: Array<{ ref: string; value: string }> = []
  const settings: SettingsSeam = {
    describe: () => [
      { ns: 'llm-pi-ai', revision: 3, value: { providers: {} } },
      { ns: 'commandcode-provider', revision: 3, value: { providers: {} } },
    ],
    mutate: async (ns, ops) => { mutations.push({ ns, ops }) },
  }
  const runStep = vi.fn(async () => ({ exitCode: 0, output: '' }))
  return {
    deps: {
      home: root,
      dshHome: join(root, '.dsh'),
      settings,
      credentials: {
        resolve: async () => undefined,
        set: async (ref, value) => { credentialSets.push({ ref, value }) },
        unset: async () => {},
      },
      fetchImpl: fetch,
      ...llm === undefined ? {} : { llm },
      runStep,
    },
    mutations,
    credentialSets,
    runStep,
  }
}

it('a valid empty endpoint listing stays empty and never crosses to namespace discovery', async () => {
  const fetch: FetchLike = vi.fn(async () => ({ ok: true, status: 200, text: async () => '{"models":{}}' }))
  const discoverModelsSpy = vi.fn(async () => [{ id: 'wrong-provider-model' }])
  const { deps } = depsWith(fetch, { discoverModels: discoverModelsSpy })
  const manifest = endpointManifest()

  const listing = await discoverModelListing('http://127.0.0.1:3002/v1', undefined, fetch, 'openai-completions')
  expect(listing).toEqual({ state: 'empty', models: [], status: 200 })

  const catalog = await discoverServiceCatalog(deps, manifest, 'http://127.0.0.1:3002/v1')
  expect(catalog).toEqual({ state: 'empty', models: [], status: 200, source: 'endpoint' })
  expect(discoverModelsSpy).not.toHaveBeenCalled()
  await expect(discoverServiceModels(deps, manifest, 'http://127.0.0.1:3002/v1')).resolves.toEqual([])

  // The endpoint is authoritative: the manifest fallback model must not turn a
  // real empty answer back into a guessed catalog.
  const profile = routeProfile(manifest, 'reuse', catalog.models, { catalogAuthority: 'endpoint' })
  expect(profile.catalogAuthority).toBe('endpoint')
  expect(profile.models).toEqual([])
})

it('an invalid listing is failed, not empty, and an authoritative route never refills it', async () => {
  const fetch: FetchLike = vi.fn(async () => ({ ok: true, status: 200, text: async () => '{"not":"a listing"}' }))
  const discoverModelsSpy = vi.fn(async () => [{ id: 'wrong-provider-model' }])
  const { deps } = depsWith(fetch, { discoverModels: discoverModelsSpy })
  const manifest = endpointManifest()

  const listing = await discoverModelListing('http://127.0.0.1:3002/v1', undefined, fetch, 'openai-completions')
  expect(listing.state).toBe('failed')
  expect(listing.models).toEqual([])
  expect(listing.error).toContain('not a model listing')
  await expect(discoverModels('http://127.0.0.1:3002/v1', undefined, fetch, 'openai-completions')).resolves.toEqual([])

  const catalog = await discoverServiceCatalog(deps, manifest, 'http://127.0.0.1:3002/v1')
  expect(catalog.state).toBe('failed')
  expect(catalog.source).toBe('endpoint')
  expect(discoverModelsSpy).not.toHaveBeenCalled()
})

it('separates 401 from an offline endpoint without leaking the key or endpoint URL', async () => {
  const unauthorized: FetchLike = vi.fn(async () => ({
    ok: false,
    status: 401,
    text: async () => 'unauthorized',
  }))
  const rejected = await discoverModelListing('http://127.0.0.1:3002/v1', 'sk-secret', unauthorized, 'openai-completions')
  expect(rejected).toEqual({ state: 'unauthorized', models: [], status: 401, error: 'HTTP 401' })

  const offline: FetchLike = vi.fn(async () => {
    throw new Error('request to http://127.0.0.1:3002/v1?key=sk-secret failed: ECONNREFUSED')
  })
  const unreachable = await discoverModelListing('http://127.0.0.1:3002/v1', 'sk-secret', offline, 'openai-completions')
  expect(unreachable.state).toBe('failed')
  expect(unreachable.status).toBeUndefined()
  expect(unreachable.error).toContain('ECONNREFUSED')
  expect(unreachable.error).not.toContain('sk-secret')
  expect(unreachable.error).not.toContain('http://')
})

it('presents the key exactly once, never in the listing URL', async () => {
  const calls: Array<{ url: string; headers: Record<string, string> }> = []
  const fetch: FetchLike = vi.fn(async (url, init) => {
    calls.push({ url, headers: { ...init?.headers } })
    return { ok: true, status: 200, text: async () => '{"data":[{"id":"m"}]}' }
  })
  await discoverModelListing('http://127.0.0.1:3002/v1', 'sk-secret', fetch, 'openai-completions')

  expect(calls).toHaveLength(1)
  expect(calls[0]!.url).toBe('http://127.0.0.1:3002/v1/models')
  expect(new URL(calls[0]!.url).search).toBe('')
  expect(calls[0]!.headers.authorization).toBe('Bearer sk-secret')
  expect(Object.values(calls[0]!.headers).filter(value => value.includes('sk-secret'))).toHaveLength(1)
})

it('keeps maxInputTokens, tool/reasoning claims, modalities, and the effort ladder', async () => {
  const body = JSON.stringify({
    object: 'list',
    models: {
      mixed: {
        description: 'Mixed Model',
        context_length: 200_000,
        max_input_tokens: 128_000,
        max_output_tokens: 65_536,
        capabilities: {
          image_input: { supported: true },
          tools: { supported: true },
          thinking: { supported: true },
          effort: { low: { supported: true }, high: { supported: true } },
        },
      },
    },
  })
  const fetch: FetchLike = vi.fn(async () => ({ ok: true, status: 200, text: async () => body }))
  const { deps } = depsWith(fetch)
  const manifest = endpointManifest('meridian')

  const catalog = await discoverServiceCatalog(deps, manifest, 'http://127.0.0.1:3456')
  expect(catalog.state).toBe('fresh')
  expect(catalog.models).toEqual([
    {
      id: 'mixed',
      name: 'Mixed Model',
      contextWindow: 200_000,
      maxInputTokens: 128_000,
      maxTokens: 65_536,
      input: ['text', 'image'],
      tools: true,
      reasoning: true,
      reasoningEfforts: { low: 'low', high: 'high' },
    },
  ])

  const profile = routeProfile(manifest, 'reuse', catalog.models, { catalogAuthority: 'endpoint' })
  expect(profile.models).toEqual([
    {
      id: 'mixed',
      name: 'Mixed Model',
      contextWindow: 200_000,
      maxInputTokens: 128_000,
      maxTokens: 65_536,
      input: ['text', 'image'],
      tools: true,
      reasoning: true,
      reasoningEfforts: { low: 'low', high: 'high' },
    },
  ])
})

it('namespace discovery keeps empty efforts and an explicit false distinct', async () => {
  const llm: ModelDiscoverySeam = {
    discoverModels: async () => [
      {
        id: 'disabled',
        maxInputTokens: 96_000,
        tools: false,
        reasoning: false,
        reasoningEfforts: false,
      },
      { id: 'empty-ladder', reasoningEfforts: {} },
    ],
  }
  const fetch: FetchLike = vi.fn(async () => ({ ok: true, status: 200, text: async () => '{"data":[]}' }))
  const { deps } = depsWith(fetch, llm)
  const manifest = manifestById('commandcode')!

  const catalog = await discoverServiceCatalog(deps, manifest, 'https://api.commandcode.ai')
  expect(catalog.source).toBe('namespace')
  expect(catalog.models).toEqual([
    {
      id: 'disabled',
      maxInputTokens: 96_000,
      tools: false,
      reasoning: false,
      reasoningEfforts: false,
    },
    { id: 'empty-ladder', reasoningEfforts: {} },
  ])

  // The route schema accepts false (disable reasoning) but refuses a
  // declared-but-empty ladder, so the profile keeps one and omits the other.
  const profile = routeProfile(manifest, 'reuse', catalog.models)
  expect(profile.models).toEqual([
    { id: 'disabled', maxInputTokens: 96_000, reasoningEfforts: false },
    { id: 'empty-ladder' },
  ])
  // The direct route's own fallback stays out of a non-empty namespace answer.
  expect(profile.models.some(model => model.id === 'deepseek/deepseek-v4.1-flash')).toBe(false)
})

it('an implicit add refuses to write a loopback route when no instance answered', async () => {
  const fetch: FetchLike = vi.fn(async () => { throw new Error('ECONNREFUSED') })
  const { deps, mutations, credentialSets, runStep } = depsWith(fetch)

  await expect(useDetectedInstance(deps, endpointManifest(), 'sk-should-not-store'))
    .rejects.toThrow(/no running FreeLLMAPI instance was detected/)
  expect(mutations).toEqual([])
  expect(credentialSets).toEqual([])
  expect(runStep).not.toHaveBeenCalled()
})

it('an explicit custom route stays saveable offline with an honest empty catalog and no install', async () => {
  const fetch: FetchLike = vi.fn(async () => { throw new Error('ECONNREFUSED') })
  const { deps, mutations, runStep } = depsWith(fetch)
  const outcome = await useDetectedInstance(deps, endpointManifest(), undefined, {
    baseURL: 'http://192.168.1.10:4000',
  })

  expect(outcome.health.ok).toBe(false)
  expect(outcome.health.error).toContain('ECONNREFUSED')
  expect(outcome.endpoint).toBe('http://192.168.1.10:4000/v1')
  expect(outcome.models).toEqual([])
  expect(runStep).not.toHaveBeenCalled()

  const written = mutations[0]!.ops[0] as { value: { baseURL: string; catalogAuthority: string; models: unknown } }
  expect(written.value.baseURL).toBe('http://192.168.1.10:4000/v1')
  expect(written.value.catalogAuthority).toBe('endpoint')
  // A failed catalog is reported empty, never guessed from the fallback model.
  expect(written.value.models).toEqual([])
})

it('a catalog route also never turns a fresh empty or 401 into another namespace catalog', async () => {
  const discoverModelsSpy = vi.fn(async () => [{ id: 'wrong-provider-model' }])
  const empty: FetchLike = vi.fn(async () => ({ ok: true, status: 200, text: async () => '{"data":[]}' }))
  const emptyCatalog = await discoverServiceCatalog(
    depsWith(empty, { discoverModels: discoverModelsSpy }).deps,
    manifestById('freellmapi')!,
    'http://127.0.0.1:3002/v1',
  )
  expect(emptyCatalog).toEqual({ state: 'empty', models: [], status: 200, source: 'endpoint' })

  const unauthorized: FetchLike = vi.fn(async () => ({ ok: false, status: 401, text: async () => 'unauthorized' }))
  const unauthorizedCatalog = await discoverServiceCatalog(
    depsWith(unauthorized, { discoverModels: discoverModelsSpy }).deps,
    manifestById('freellmapi')!,
    'http://127.0.0.1:3002/v1',
  )
  expect(unauthorizedCatalog).toEqual({ state: 'unauthorized', models: [], status: 401, error: 'HTTP 401', source: 'endpoint' })
  expect(discoverModelsSpy).not.toHaveBeenCalled()
})

it('refuses an oversized listing before parsing it', async () => {
  const fetch: FetchLike = vi.fn(async () => ({
    ok: true,
    status: 200,
    headers: { get: () => String(4 * 1024 * 1024 + 1) },
    text: async () => '{"data":[]}',
  }))
  const outcome = await discoverModelListing('http://127.0.0.1:3002/v1', undefined, fetch, 'openai-completions')
  expect(outcome.state).toBe('failed')
  expect(outcome.models).toEqual([])
  expect(outcome.error).toContain('exceeds')
})
