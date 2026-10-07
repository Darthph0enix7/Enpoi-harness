/**
 * Detected-instance add: detection probes the recorded port, then the
 * declared endpoint, then the default port; the route is written at the
 * address that answered, the key is stored only when one was supplied, and
 * the probe is fail-soft — a down service is reported, never used to block.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { manifestById } from '../src/manifests.js'
import {
  PLACEHOLDER_CREDENTIAL,
  commitRoute,
  discoverModels,
  discoverServiceModels,
  instanceBaseURLFromInput,
  modelListingUrl,
  routeProfile,
  useDetectedInstance,
  type CredentialsSeam,
  type FetchLike,
  type HeavyDeps,
  type ModelDiscoverySeam,
  type SettingsSeam,
} from '../src/planner.js'

const scratch: string[] = []
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** A deps bundle with recording settings/credentials and an injectable fetch. */
function depsWith(options: { fetch: FetchLike; withSettings?: boolean; withCredentials?: boolean }): {
  deps: HeavyDeps
  mutations: Array<{ ns: string; ops: readonly Record<string, unknown>[] }>
  credentialSets: Array<{ ref: string; value: string }>
} {
  const mutations: Array<{ ns: string; ops: readonly Record<string, unknown>[] }> = []
  const credentialSets: Array<{ ref: string; value: string }> = []
  const scratchDir = mkdtempSync(join(tmpdir(), 'heavy-reuse-'))
  scratch.push(scratchDir)
  const settings: SettingsSeam = {
    describe: () => [
      { ns: 'llm-pi-ai', revision: 7, value: { providers: {} } },
      // The commandcode route namespace is mounted in the running profile, so
      // a direct-route write passes the pending-restart guard.
      { ns: 'commandcode-provider', revision: 3, value: { providers: {} } },
    ],
    mutate: async (ns, ops) => { mutations.push({ ns, ops }) },
  }
  const credentials: CredentialsSeam = {
    resolve: async () => undefined,
    set: async (ref, value) => { credentialSets.push({ ref, value }) },
    unset: async () => {},
  }
  const deps: HeavyDeps = {
    home: scratchDir,
    dshHome: join(scratchDir, '.dsh'),
    ...options.withSettings === false ? {} : { settings },
    ...options.withCredentials === false ? {} : { credentials },
    fetchImpl: options.fetch,
    runStep: async () => ({ exitCode: 0, output: '' }),
  }
  return { deps, mutations, credentialSets }
}

it('detection probes loopback, discovers models, writes the route, and stores the key', async () => {
  const calls: string[] = []
  const fetch: FetchLike = vi.fn(async (url) => {
    calls.push(url)
    if (url.endsWith('/api/ping')) return { ok: true, status: 200, text: async () => '{"status":"ok"}' }
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ data: [{ id: 'auto' }, { id: 'glm-5.2', name: 'GLM 5.2' }] }),
    }
  })
  const { deps, mutations, credentialSets } = depsWith({ fetch })
  const manifest = manifestById('freellmapi')!
  const outcome = await useDetectedInstance(deps, manifest, 'sk-unified')

  expect(calls[0]).toBe('http://127.0.0.1:3002/api/ping')
  expect(calls[1]).toBe('http://127.0.0.1:3002/v1/models')
  expect(outcome.health.ok).toBe(true)
  expect(outcome.port).toBe(3002)
  expect(outcome.endpoint).toBe('http://127.0.0.1:3002/v1')
  expect(outcome.models.map(model => model.id)).toEqual(['auto', 'glm-5.2'])
  expect(mutations).toHaveLength(1)
  const written = mutations[0]!.ops[0] as { op: string; path: string[]; value: Record<string, unknown> }
  expect(written.op).toBe('set')
  expect(written.path).toEqual(['providers', 'freellmapi'])
  expect(written.value.baseURL).toBe('http://127.0.0.1:3002/v1')
  expect(written.value.api).toBe('openai-completions')
  expect(written.value.displayName).toBe('FreeLLMAPI (detected)')
  expect(written.value.models).toEqual([{ id: 'auto' }, { id: 'glm-5.2', name: 'GLM 5.2' }])
  expect(credentialSets).toEqual([{ ref: 'FREELLMAPI_API_KEY', value: 'sk-unified' }])
})

it('detection prefers the port recorded in settings over the default port', async () => {
  const calls: string[] = []
  const fetch: FetchLike = vi.fn(async (url) => {
    calls.push(url)
    if (url.endsWith('/api/ping')) {
      return url.includes(':4555')
        ? { ok: true, status: 200, text: async () => '{"status":"ok"}' }
        : { ok: false, status: 404, text: async () => 'nope' }
    }
    return { ok: true, status: 200, text: async () => '{"data":[]}' }
  })
  const { deps, mutations } = depsWith({ fetch })
  const configured: HeavyDeps = {
    ...deps,
    settings: {
      describe: () => [{
        ns: 'llm-pi-ai',
        revision: 1,
        value: { providers: { freellmapi: { baseURL: 'http://127.0.0.1:4555/v1' } } },
      }],
      mutate: async (ns, ops) => { mutations.push({ ns, ops }) },
    },
  }
  const outcome = await useDetectedInstance(configured, manifestById('freellmapi')!)

  expect(calls[0]).toBe('http://127.0.0.1:4555/api/ping')
  expect(outcome.port).toBe(4555)
  const written = mutations[0]!.ops[0] as { value: { baseURL: string } }
  expect(written.value.baseURL).toBe('http://127.0.0.1:4555/v1')
})

it('detection fails soft when nothing answers: the declared endpoint is written and reported down', async () => {
  const fetch: FetchLike = vi.fn(async (url) => {
    if (url.endsWith('/api/ping')) throw new Error('ECONNREFUSED')
    return { ok: false, status: 401, text: async () => 'unauthorized' }
  })
  const { deps, mutations } = depsWith({ fetch })
  const outcome = await useDetectedInstance(deps, manifestById('freellmapi')!, undefined)

  expect(outcome.health.ok).toBe(false)
  expect(outcome.health.error).toContain('ECONNREFUSED')
  expect(outcome.port).toBeUndefined()
  expect(mutations).toHaveLength(1)
  const value = (mutations[0]!.ops[0] as { value: { models: unknown; baseURL: unknown } }).value
  expect(value.baseURL).toBe('http://127.0.0.1:3002/v1')
  // Discovery was refused (401) → the manifest's fallback model keeps the
  // route resolvable.
  expect(value.models).toEqual([{ id: 'auto' }])
})

it('a typed custom instance URL skips detection and writes the route there, non-loopback accepted', async () => {
  const calls: string[] = []
  const fetch: FetchLike = vi.fn(async (url) => {
    calls.push(url)
    if (url.endsWith('/api/ping')) return { ok: true, status: 200, text: async () => '{"status":"ok"}' }
    return { ok: true, status: 200, text: async () => JSON.stringify({ data: [{ id: 'auto' }] }) }
  })
  const { deps, mutations } = depsWith({ fetch })
  const outcome = await useDetectedInstance(deps, manifestById('freellmapi')!, 'sk-op', {
    // An explicit non-loopback address: the operator typed it; only loopback
    // stays private, and the route is written exactly where they pointed it.
    baseURL: 'http://192.168.1.10:4000/v1',
  })

  // No loopback detection candidate was probed; model discovery and the
  // health probe both follow the typed host (health uses the manifest's
  // declared health path).
  expect(calls).toEqual(['http://192.168.1.10:4000/v1/models', 'http://192.168.1.10:4000/api/ping'])
  expect(outcome.health.status).toBe(200)
  expect(outcome.endpoint).toBe('http://192.168.1.10:4000/v1')
  expect(outcome.port).toBe(4000)
  expect(outcome.health.ok).toBe(true)
  const written = mutations[0]!.ops[0] as { value: { baseURL: string; displayName: string } }
  expect(written.value.baseURL).toBe('http://192.168.1.10:4000/v1')
  expect(written.value.displayName).toBe('FreeLLMAPI (detected)')
})

it('a custom instance URL reaches the antigravity health path on the typed host', async () => {
  const calls: string[] = []
  const fetch: FetchLike = vi.fn(async (url) => {
    calls.push(url)
    return { ok: url.endsWith('/health'), status: url.endsWith('/health') ? 200 : 404, text: async () => '{}' }
  })
  const { deps, mutations } = depsWith({ fetch })
  const outcome = await useDetectedInstance(deps, manifestById('antigravity')!, undefined, {
    baseURL: 'http://10.0.0.9:9090',
  })
  // The proxy lists models at its native Anthropic address, never at
  // `{baseURL}/models`; the refused listing leaves the route with no model,
  // never a fabricated fallback id.
  expect(calls).toEqual(['http://10.0.0.9:9090/v1/models?limit=1000', 'http://10.0.0.9:9090/health'])
  expect(outcome.health.ok).toBe(true)
  expect(outcome.models).toEqual([])
  const written = mutations[0]!.ops[0] as { value: { baseURL: string; models: unknown } }
  expect(written.value.baseURL).toBe('http://10.0.0.9:9090')
  expect(written.value.models).toEqual([])
})

it('an unreachable antigravity proxy writes an empty model list — no fabricated fallback', async () => {
  const fetch: FetchLike = vi.fn(async () => { throw new Error('ECONNREFUSED') })
  const { deps, mutations } = depsWith({ fetch })
  const outcome = await useDetectedInstance(deps, manifestById('antigravity')!)
  expect(outcome.health.ok).toBe(false)
  expect(outcome.health.error).toContain('ECONNREFUSED')
  expect(outcome.models).toEqual([])
  expect(outcome.endpoint).toBe('http://127.0.0.1:8082')
  const written = mutations[0]!.ops[0] as { value: { models: unknown } }
  expect(written.value.models).toEqual([])
})

it('writes models: [] for an antigravity route with no discovery; llm-pi-ai treats it as no declared list', () => {
  // The empty list is the accepted route shape: llm-pi-ai resolves an absent
  // and an empty `models` list identically, serving the installed catalog and
  // then the route's discovered-cache record (llm-pi-ai `resolveRouteModels`),
  // so nothing fabricated is ever persisted for a fully-discoverable service.
  const manifest = manifestById('antigravity')!
  expect(manifest.fallbackModel).toBeUndefined()
  expect(routeProfile(manifest, 'reuse', []).models).toEqual([])
  expect(routeProfile(manifest, 'local', []).models).toEqual([])
  // The remaining two fallbacks name models their services actually support:
  // FreeLLMAPI's real `auto` routing id, and Command Code's bundled catalog
  // entry. They stay declarative.
  expect(manifestById('freellmapi')!.fallbackModel).toBe('auto')
  expect(manifestById('commandcode')!.fallbackModel).toBe('deepseek/deepseek-v4.1-flash')
})

it('the listing address follows the protocol, matching llm-pi-ai\'s Anthropic normalization', () => {
  expect(modelListingUrl('http://127.0.0.1:8082', 'anthropic-messages')).toBe('http://127.0.0.1:8082/v1/models?limit=1000')
  expect(modelListingUrl('http://127.0.0.1:8082/', 'anthropic-messages')).toBe('http://127.0.0.1:8082/v1/models?limit=1000')
  expect(modelListingUrl('http://127.0.0.1:8082/v1', 'anthropic-messages')).toBe('http://127.0.0.1:8082/v1/models?limit=1000')
  expect(modelListingUrl('http://127.0.0.1:3002/v1', 'openai-completions')).toBe('http://127.0.0.1:3002/v1/models')
  expect(modelListingUrl('http://127.0.0.1:8082', undefined)).toBe('http://127.0.0.1:8082/models')
})

it('antigravity discovery reads the proxy\'s native /v1/models and names models from description', async () => {
  const calls: Array<{ url: string; headers: Record<string, string> }> = []
  const fetch: FetchLike = vi.fn(async (url, init) => {
    calls.push({ url, headers: { ...init?.headers } })
    if (url.endsWith('/health')) return { ok: true, status: 200, text: async () => '{}' }
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        object: 'list',
        data: [
          { id: 'claude-sonnet-4-6', object: 'model', created: 1, owned_by: 'anthropic', description: 'Claude Sonnet 4.6 (Thinking)' },
          { id: 'gemini-3.1-pro-high', object: 'model', created: 1, owned_by: 'anthropic', description: 'Gemini 3.1 Pro (High)' },
        ],
      }),
    }
  })
  const { deps, mutations } = depsWith({ fetch })
  const outcome = await useDetectedInstance(deps, manifestById('antigravity')!, undefined, {
    baseURL: 'http://10.0.0.9:9090',
  })

  // One listing call, at the Anthropic address, carrying the version header.
  expect(calls[0]!.url).toBe('http://10.0.0.9:9090/v1/models?limit=1000')
  expect(calls[0]!.headers['anthropic-version']).toBe('2023-06-01')
  expect(calls[0]!.headers['x-api-key']).toBeUndefined()
  expect(calls[0]!.headers.authorization).toBeUndefined()
  expect(outcome.models).toEqual([
    { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6 (Thinking)' },
    { id: 'gemini-3.1-pro-high', name: 'Gemini 3.1 Pro (High)' },
  ])
  const written = mutations[0]!.ops[0] as { value: { models: unknown } }
  expect(written.value.models).toEqual(outcome.models)
})

it('antigravity discovery presents a typed key as x-api-key, never as a bearer token', async () => {
  const headers: Array<Record<string, string> | undefined> = []
  const fetch: FetchLike = vi.fn(async (_url, init) => {
    headers.push(init?.headers)
    return { ok: true, status: 200, text: async () => JSON.stringify({ data: [{ id: 'gemini-3-flash' }] }) }
  })
  const { deps } = depsWith({ fetch })
  const outcome = await useDetectedInstance(deps, manifestById('antigravity')!, 'sk-typed', {
    baseURL: 'http://10.0.0.9:9090',
  })
  expect(headers[0]?.['x-api-key']).toBe('sk-typed')
  expect(headers[0]?.authorization).toBeUndefined()
  expect(outcome.models).toEqual([{ id: 'gemini-3-flash' }])
})

it('a service route falls back to the registered namespace discovery when the endpoint listing answers nothing', async () => {
  const fetch: FetchLike = vi.fn(async () => ({ ok: false, status: 401, text: async () => 'unauthorized' }))
  const { deps } = depsWith({ fetch })
  const seen: Array<{ ns: string; request: Record<string, unknown> }> = []
  const llm: ModelDiscoverySeam = {
    discoverModels: async (ns, request) => {
      seen.push({ ns, request: { ...request } })
      return [{ id: 'glm-5.2', name: 'GLM 5.2', contextWindow: 200_000 }]
    },
  }
  const outcome = await useDetectedInstance({ ...deps, llm }, manifestById('antigravity')!, undefined, {
    baseURL: 'http://10.0.0.9:9090',
  })
  expect(outcome.models).toEqual([{ id: 'glm-5.2', name: 'GLM 5.2', contextWindow: 200_000 }])
  expect(seen).toHaveLength(1)
  expect(seen[0]!.ns).toBe('llm-pi-ai')
  expect(seen[0]!.request.provider).toBe('antigravity')
  expect(seen[0]!.request.api).toBe('anthropic-messages')
})

it('discovery uses the reference\'s stored credential when the add carries no key', async () => {
  const auths: Array<string | undefined> = []
  const fetch: FetchLike = vi.fn(async (url, init) => {
    auths.push(init?.headers?.authorization)
    if (url.endsWith('/api/ping')) return { ok: true, status: 200, text: async () => '{"status":"ok"}' }
    return { ok: true, status: 200, text: async () => JSON.stringify({ data: [{ id: 'auto' }, { id: 'glm-5.2', name: 'GLM 5.2' }] }) }
  })
  const { deps, mutations } = depsWith({ fetch })
  deps.credentials = {
    resolve: async ref => ref === 'FREELLMAPI_API_KEY' ? { value: 'sk-stored' } : undefined,
    set: async () => {},
    unset: async () => {},
  }
  const outcome = await useDetectedInstance(deps, manifestById('freellmapi')!)

  // The stored unified key reached the wire even though the add typed none.
  expect(auths).toContain('Bearer sk-stored')
  expect(outcome.models.map(model => model.id)).toEqual(['auto', 'glm-5.2'])
  const written = mutations[0]!.ops[0] as { value: { models: unknown } }
  expect(written.value.models).toEqual([{ id: 'auto' }, { id: 'glm-5.2', name: 'GLM 5.2' }])
})

it('an enriched models map is read with the capacities the endpoint discloses', async () => {
  const fetch: FetchLike = vi.fn(async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({
      models: {
        'glm-5.2': { name: 'GLM 5.2', context_length: 200_000, max_output_tokens: 65_536 },
        plain: { description: 'Plain Model' },
      },
    }),
  }))
  const models = await discoverModels('http://127.0.0.1:3002/v1', undefined, fetch, 'openai-completions')
  expect(models).toEqual([
    { id: 'glm-5.2', name: 'GLM 5.2', contextWindow: 200_000, maxTokens: 65_536 },
    { id: 'plain', name: 'Plain Model' },
  ])
})

it('validates a typed instance address: absolute http(s) origin only, no credentials', () => {
  // The typed address is an origin: the manifest owns the service's paths, so
  // any typed path is dropped instead of being silently half-honored by the
  // health probe.
  expect(instanceBaseURLFromInput('http://192.168.1.10:4000')).toBe('http://192.168.1.10:4000')
  expect(instanceBaseURLFromInput('http://192.168.1.10:4000/v1/')).toBe('http://192.168.1.10:4000')
  expect(instanceBaseURLFromInput('http://192.168.1.10:4000/some/path')).toBe('http://192.168.1.10:4000')
  expect(instanceBaseURLFromInput('http://127.0.0.1:3002/v1')).toBe('http://127.0.0.1:3002')
  expect(instanceBaseURLFromInput('https://gateway.example:8443')).toBe('https://gateway.example:8443')
  // Invalid shapes never become a route endpoint.
  expect(instanceBaseURLFromInput('')).toBeUndefined()
  expect(instanceBaseURLFromInput('   ')).toBeUndefined()
  expect(instanceBaseURLFromInput('192.168.1.10:4000')).toBeUndefined()
  expect(instanceBaseURLFromInput('ftp://192.168.1.10:4000')).toBeUndefined()
  expect(instanceBaseURLFromInput('http://user:secret@192.168.1.10:4000')).toBeUndefined()
  expect(instanceBaseURLFromInput('http://192.168.1.10:0')).toBeUndefined()
  // The route writer appends `/models` and health paths, so a query/fragment
  // would corrupt both.
  expect(instanceBaseURLFromInput('http://192.168.1.10:4000/v1?key=1')).toBeUndefined()
  expect(instanceBaseURLFromInput('http://192.168.1.10:4000/v1#frag')).toBeUndefined()
})

it('a typed custom-instance path is normalized away; the manifest paths apply on the typed origin', async () => {
  const calls: string[] = []
  const fetch: FetchLike = vi.fn(async (url) => {
    calls.push(url)
    if (url.endsWith('/api/ping')) return { ok: true, status: 200, text: async () => '{"status":"ok"}' }
    return { ok: true, status: 200, text: async () => JSON.stringify({ data: [{ id: 'auto' }] }) }
  })
  const { deps, mutations } = depsWith({ fetch })
  const outcome = await useDetectedInstance(deps, manifestById('freellmapi')!, undefined, {
    baseURL: 'http://192.168.1.10:4000/gateway/prefix',
  })

  // Neither probe follows the typed path: the route is discovered at the
  // manifest's declared /v1 and health-probed at its declared /api/ping, so
  // the badge and the written route describe the same origin.
  expect(calls).toEqual(['http://192.168.1.10:4000/v1/models', 'http://192.168.1.10:4000/api/ping'])
  expect(outcome.endpoint).toBe('http://192.168.1.10:4000/v1')
  expect(outcome.port).toBe(4000)
  expect(outcome.health.ok).toBe(true)
  const written = mutations[0]!.ops[0] as { value: { baseURL: string } }
  expect(written.value.baseURL).toBe('http://192.168.1.10:4000/v1')
})

it('refuses an invalid custom-instance address instead of silently ignoring it', async () => {
  const fetch: FetchLike = vi.fn(async () => ({ ok: true, status: 200, text: async () => '{"status":"ok"}' }))
  const { deps, mutations } = depsWith({ fetch })
  await expect(useDetectedInstance(deps, manifestById('freellmapi')!, undefined, { baseURL: 'ftp://192.168.1.10:4000' }))
    .rejects.toThrow('invalid custom instance base URL')
  expect(mutations).toEqual([])
})

it('a credential-store failure rejects the add and leaves no route', async () => {
  const fetch: FetchLike = vi.fn(async () => ({ ok: true, status: 200, text: async () => '{"status":"ok"}' }))
  const { deps, mutations } = depsWith({ fetch })
  deps.credentials = {
    resolve: async () => undefined,
    set: async () => { throw new Error('credential store refused') },
    unset: async () => {},
  }
  await expect(useDetectedInstance(deps, manifestById('freellmapi')!, 'sk-unified')).rejects.toThrow('credential store refused')
  expect(mutations).toEqual([])
})

it('a route-write failure unsets the credential it had just stored (no dangling credential)', async () => {
  const fetch: FetchLike = vi.fn(async () => ({ ok: true, status: 200, text: async () => '{"status":"ok"}' }))
  const { deps, credentialSets } = depsWith({ fetch })
  const unsets: string[] = []
  deps.credentials = {
    resolve: async () => undefined,
    set: async (ref, value) => { credentialSets.push({ ref, value }) },
    unset: async (ref) => { unsets.push(ref) },
  }
  deps.settings!.mutate = async () => { throw new Error('settings refused') }
  await expect(useDetectedInstance(deps, manifestById('freellmapi')!, 'sk-unified')).rejects.toThrow('settings refused')
  expect(credentialSets).toEqual([{ ref: 'FREELLMAPI_API_KEY', value: 'sk-unified' }])
  expect(unsets).toEqual(['FREELLMAPI_API_KEY'])
})

it('a route-write failure restores a pre-existing credential value', async () => {
  const fetch: FetchLike = vi.fn(async () => ({ ok: true, status: 200, text: async () => '{"status":"ok"}' }))
  const { deps, credentialSets } = depsWith({ fetch })
  const unsets: string[] = []
  deps.credentials = {
    resolve: async () => ({ value: 'sk-previous' }),
    set: async (ref, value) => { credentialSets.push({ ref, value }) },
    unset: async (ref) => { unsets.push(ref) },
  }
  deps.settings!.mutate = async () => { throw new Error('settings refused') }
  await expect(useDetectedInstance(deps, manifestById('freellmapi')!, 'sk-unified')).rejects.toThrow('settings refused')
  expect(credentialSets).toEqual([
    { ref: 'FREELLMAPI_API_KEY', value: 'sk-unified' },
    { ref: 'FREELLMAPI_API_KEY', value: 'sk-previous' },
  ])
  expect(unsets).toEqual([])
})

it('the install commit (local mode) stores the key before the route and leaves no route on a credential failure', async () => {
  const fetch: FetchLike = vi.fn(async () => ({ ok: true, status: 200, text: async () => '{"status":"ok"}' }))
  const { deps, mutations } = depsWith({ fetch })
  deps.credentials = {
    resolve: async () => undefined,
    set: async () => { throw new Error('credential store refused') },
    unset: async () => {},
  }
  await expect(commitRoute(deps, manifestById('antigravity')!, 'local', [], 'sk-ag')).rejects.toThrow('credential store refused')
  expect(mutations).toEqual([])
})

it('antigravity detection writes a placeholder anthropic route with no pool and never keyless', () => {
  const profile = routeProfile(manifestById('antigravity')!, 'reuse', [])
  expect(profile.api).toBe('anthropic-messages')
  expect(profile.apiKeyEnv).toBe('ANTIGRAVITY_API_KEY')
  expect(profile.keyless).toBeUndefined()
  expect(profile).not.toHaveProperty('pool')
  expect(profile.baseURL).toBe('http://127.0.0.1:8082')
  expect(profile.displayName).toBe('Antigravity Proxy (detected)')
  // No fallbackModel: the route is written empty rather than carrying a
  // model the proxy never advertised.
  expect(profile.models).toEqual([])
})

it('an antigravity add with no key stores the placeholder credential under the declared reference', async () => {
  const fetch: FetchLike = vi.fn(async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ data: [{ id: 'gemini-3.1-pro-high', description: 'Gemini 3.1 Pro (High)' }] }),
  }))
  const { deps, mutations, credentialSets } = depsWith({ fetch })
  const outcome = await useDetectedInstance(deps, manifestById('antigravity')!)

  expect(outcome.credentialStored).toBe(true)
  expect(credentialSets).toEqual([{ ref: 'ANTIGRAVITY_API_KEY', value: PLACEHOLDER_CREDENTIAL }])
  expect(mutations).toHaveLength(1)
  const written = mutations[0]!.ops[0] as { value: { apiKeyEnv: string; keyless?: boolean } }
  expect(written.value.apiKeyEnv).toBe('ANTIGRAVITY_API_KEY')
  expect(written.value.keyless).toBeUndefined()
})

it('the placeholder credential is stored once and never overwrites an existing value', async () => {
  const fetch: FetchLike = vi.fn(async () => ({ ok: true, status: 200, text: async () => '{"data":[]}' }))
  const { deps, credentialSets } = depsWith({ fetch })
  const stored = new Map<string, string>()
  const unsets: string[] = []
  deps.credentials = {
    resolve: async ref => stored.has(ref) ? { value: stored.get(ref) } : undefined,
    set: async (ref, value) => { credentialSets.push({ ref, value }); stored.set(ref, value) },
    unset: async (ref) => { unsets.push(ref); stored.delete(ref) },
  }
  const manifest = manifestById('antigravity')!
  const first = await commitRoute(deps, manifest, 'reuse', [], undefined)
  const second = await commitRoute(deps, manifest, 'reuse', [], undefined)

  expect(first.credentialStored).toBe(true)
  expect(second.credentialStored).toBe(false)
  expect(credentialSets).toEqual([{ ref: 'ANTIGRAVITY_API_KEY', value: PLACEHOLDER_CREDENTIAL }])
  expect(unsets).toEqual([])
})

it('an operator value already stored under the reference is never replaced by the placeholder', async () => {
  const fetch: FetchLike = vi.fn(async () => ({ ok: true, status: 200, text: async () => '{"data":[]}' }))
  const { deps, credentialSets } = depsWith({ fetch })
  deps.credentials = {
    resolve: async ref => ref === 'ANTIGRAVITY_API_KEY' ? { value: 'sk-operator' } : undefined,
    set: async (ref, value) => { credentialSets.push({ ref, value }) },
    unset: async () => {},
  }
  const outcome = await commitRoute(deps, manifestById('antigravity')!, 'reuse', [], undefined)

  expect(outcome.credentialStored).toBe(false)
  expect(credentialSets).toEqual([])
})

it('a failed placeholder commit rolls the sentinel back out (no dangling credential)', async () => {
  const fetch: FetchLike = vi.fn(async () => ({ ok: true, status: 200, text: async () => '{"data":[]}' }))
  const { deps } = depsWith({ fetch })
  const stored = new Map<string, string>()
  deps.credentials = {
    resolve: async ref => stored.has(ref) ? { value: stored.get(ref) } : undefined,
    set: async (ref, value) => { stored.set(ref, value) },
    unset: async (ref) => { stored.delete(ref) },
  }
  deps.settings!.mutate = async () => { throw new Error('settings refused') }
  await expect(commitRoute(deps, manifestById('antigravity')!, 'reuse', [], undefined)).rejects.toThrow('settings refused')
  expect(stored.has('ANTIGRAVITY_API_KEY')).toBe(false)
})

it('a typed key still wins over the placeholder for a placeholder-auth route', async () => {
  const fetch: FetchLike = vi.fn(async () => ({ ok: true, status: 200, text: async () => '{"data":[]}' }))
  const { deps, credentialSets } = depsWith({ fetch })
  const outcome = await useDetectedInstance(deps, manifestById('antigravity')!, 'sk-typed')

  expect(outcome.credentialStored).toBe(true)
  expect(credentialSets).toEqual([{ ref: 'ANTIGRAVITY_API_KEY', value: 'sk-typed' }])
})

it('a placeholder route leaves a resolvable credential for the keyless Refresh discovery', async () => {
  // llm-pi-ai refuses a keyless anthropic route: its discovery resolves the
  // route's apiKeyEnv and fails MISSING_CREDENTIAL when the reference holds no
  // value. The committed sentinel is that value; the proxy ignores the header.
  const auths: Array<string | undefined> = []
  const fetch: FetchLike = vi.fn(async (_url, init) => {
    auths.push(init?.headers?.['x-api-key'])
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ data: [{ id: 'gemini-3.1-pro-high', description: 'Gemini 3.1 Pro (High)' }] }),
    }
  })
  const { deps } = depsWith({ fetch })
  const stored = new Map<string, string>()
  deps.credentials = {
    resolve: async ref => stored.has(ref) ? { value: stored.get(ref) } : undefined,
    set: async (ref, value) => { stored.set(ref, value) },
    unset: async (ref) => { stored.delete(ref) },
  }
  const manifest = manifestById('antigravity')!
  await commitRoute(deps, manifest, 'reuse', [], undefined)

  expect(await deps.credentials!.resolve('ANTIGRAVITY_API_KEY')).toEqual({ value: PLACEHOLDER_CREDENTIAL })
  const models = await discoverServiceModels(deps, manifest, 'http://127.0.0.1:8082')
  expect(auths[0]).toBe(PLACEHOLDER_CREDENTIAL)
  expect(models).toEqual([{ id: 'gemini-3.1-pro-high', name: 'Gemini 3.1 Pro (High)' }])
})

it('a direct-vendor route writes at the vendor endpoint with the fallback model when no discovery is mounted', async () => {
  const calls: string[] = []
  const fetch: FetchLike = vi.fn(async (url) => {
    calls.push(url)
    return { ok: true, status: 200, text: async () => '{"status":"ok"}' }
  })
  const { deps, mutations } = depsWith({ fetch })
  const manifest = manifestById('commandcode')!
  const outcome = await useDetectedInstance(deps, manifest)

  // Only the declared vendor health probe; no loopback detection and no
  // `GET /models` (the bundled catalog is the model source).
  expect(calls).toEqual(['https://api.commandcode.ai/'])
  expect(outcome.endpoint).toBe('https://api.commandcode.ai')
  expect(outcome.health.ok).toBe(true)
  expect(outcome.models).toEqual([])

  const written = mutations[0]!.ops[0] as { op: string; path: string[]; value: Record<string, unknown> }
  expect(written.path).toEqual(['providers', 'commandcode'])
  expect(written.value.displayName).toBe('Command Code (direct)')
  expect(written.value.baseURL).toBe('https://api.commandcode.ai')
  expect(written.value.api).toBe('commandcode/alpha-generate')
  expect(written.value.apiKeyEnv).toBe('COMMANDCODE_KEY_1')
  expect(written.value.keyless).toBeUndefined()
  expect(written.value.pool).toEqual({
    strategy: 'priority-sticky',
    identities: [{ id: 'key-1', credentialRef: 'COMMANDCODE_KEY_1', priority: 1 }],
  })
  expect(written.value.models).toEqual([{ id: 'deepseek/deepseek-v4.1-flash' }])
})

it('a direct-vendor route stores a supplied key under its first pool identity', async () => {
  const fetch: FetchLike = vi.fn(async () => ({ ok: true, status: 200, text: async () => 'ok' }))
  const { deps, credentialSets } = depsWith({ fetch })
  const outcome = await useDetectedInstance(deps, manifestById('commandcode')!, 'sk-cc')
  expect(outcome.credentialStored).toBe(true)
  expect(credentialSets).toEqual([{ ref: 'COMMANDCODE_KEY_1', value: 'sk-cc' }])
})

it('the commandcode route profile carries the manifest pool, auth ref, and fallback model', () => {
  const profile = routeProfile(manifestById('commandcode')!, 'local', [])
  expect(profile.api).toBe('commandcode/alpha-generate')
  expect(profile.baseURL).toBe('https://api.commandcode.ai')
  expect(profile.apiKeyEnv).toBe('COMMANDCODE_KEY_1')
  expect(profile.keyless).toBeUndefined()
  expect(profile.pool?.identities).toEqual([{ id: 'key-1', credentialRef: 'COMMANDCODE_KEY_1', priority: 1 }])
  expect(profile.models).toEqual([{ id: 'deepseek/deepseek-v4.1-flash' }])
})

it('writes nothing (and rejects) when the settings seam is absent', async () => {
  const fetch: FetchLike = vi.fn(async () => ({ ok: true, status: 200, text: async () => '{"data":[]}' }))
  const { deps, mutations } = depsWith({ fetch, withSettings: false })
  await expect(useDetectedInstance(deps, manifestById('freellmapi')!, undefined)).rejects.toThrow('settings seam absent')
  expect(mutations).toHaveLength(0)
})

it('discovery returns [] for an unreachable endpoint instead of throwing', async () => {
  const fetch: FetchLike = vi.fn(async () => { throw new Error('boom') })
  await expect(discoverModels('http://127.0.0.1:1/v1', undefined, fetch)).resolves.toEqual([])
})

it('names a direct route (direct) even when the setup path provisioned it', () => {
  const manifest = manifestById('commandcode')!
  // The Add modal's setup path calls routeProfile(..., 'local', ...): a direct
  // route runs no local service, so its name must never carry "(local)".
  expect(routeProfile(manifest, 'local', []).displayName).toBe('Command Code (direct)')
  expect(routeProfile(manifest, 'reuse', []).displayName).toBe('Command Code (direct)')
})

it('a direct route writes every model its route-namespace discovery answers, enriched', async () => {
  const calls: string[] = []
  const fetch: FetchLike = vi.fn(async (url) => {
    calls.push(url)
    return { ok: true, status: 200, text: async () => '{"status":"ok"}' }
  })
  const { deps, mutations } = depsWith({ fetch })
  const manifest = manifestById('commandcode')!
  const discovered = [
    {
      id: 'deepseek/deepseek-v4-pro',
      name: 'DeepSeek V4 Pro [Go+]',
      contextWindow: 1_000_000,
      maxTokens: 384_000,
      inputModalities: ['text'],
    },
    {
      id: 'xai/grok-4.6',
      name: 'Grok 4.6',
      contextWindow: 2_000_000,
      maxTokens: 128_000,
      inputModalities: ['text', 'image'],
    },
  ] as const
  const outcome = await useDetectedInstance(
    { ...deps, llm: { discoverModels: async () => discovered } },
    manifest,
  )

  // Still only the health probe: a direct vendor route never fetches /models.
  expect(calls).toEqual(['https://api.commandcode.ai/'])
  expect(outcome.models).toEqual([
    {
      id: 'deepseek/deepseek-v4-pro',
      name: 'DeepSeek V4 Pro [Go+]',
      contextWindow: 1_000_000,
      maxTokens: 384_000,
      input: ['text'],
    },
    {
      id: 'xai/grok-4.6',
      name: 'Grok 4.6',
      contextWindow: 2_000_000,
      maxTokens: 128_000,
      input: ['text', 'image'],
    },
  ])
  const written = mutations[0]!.ops[0] as { value: { models: unknown[] } }
  expect(written.value.models).toHaveLength(2)
})

it('a direct route keeps the fallback model when the discovery refuses', async () => {
  const fetch: FetchLike = vi.fn(async () => ({ ok: true, status: 200, text: async () => '{"status":"ok"}' }))
  const { deps, mutations } = depsWith({ fetch })
  const outcome = await useDetectedInstance(
    { ...deps, llm: { discoverModels: async () => { throw new Error('no model discovery is registered') } } },
    manifestById('commandcode')!,
  )

  expect(outcome.models).toEqual([])
  const written = mutations[0]!.ops[0] as { value: { models: unknown[] } }
  expect(written.value.models).toEqual([{ id: 'deepseek/deepseek-v4.1-flash' }])
})
