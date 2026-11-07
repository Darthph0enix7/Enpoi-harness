/**
 * Detected-instance add: detection probes the recorded port, then the
 * declared endpoint, then the default port; the route is written at the
 * address that answered, the key is stored only when one was supplied, and
 * the probe is fail-soft — a down service is reported, never used to block.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, expect, it, vi } from 'vitest'
import { HeavyJobManager } from '../src/jobs.js'
import { manifestById } from '../src/manifests.js'
import { HeavyProvidersService } from '../src/remote.js'
import {
  commitRoute,
  detectInstance,
  discoverModels,
  discoverServiceModels,
  instanceBaseURLFromInput,
  modelListingUrl,
  reachable,
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

it('detection fails soft but an implicit add writes no dead loopback route', async () => {
  const fetch: FetchLike = vi.fn(async (url) => {
    if (url.endsWith('/api/ping')) throw new Error('ECONNREFUSED')
    return { ok: false, status: 401, text: async () => 'unauthorized' }
  })
  const { deps, mutations } = depsWith({ fetch })

  await expect(useDetectedInstance(deps, manifestById('freellmapi')!, undefined))
    .rejects.toThrow(/no running FreeLLMAPI instance was detected/)
  expect(mutations).toEqual([])
})

it('shares one reachable predicate: an auth challenge is listening, a connection error is not', () => {
  expect(reachable({ ok: true, status: 200 })).toBe(true)
  expect(reachable({ ok: false, status: 401 })).toBe(true)
  expect(reachable({ ok: false, status: 403 })).toBe(true)
  expect(reachable({ ok: false, status: 404 })).toBe(false)
  expect(reachable({ ok: false, status: 500 })).toBe(false)
  expect(reachable({ ok: false, error: 'connect ECONNREFUSED' })).toBe(false)
})

it('a 401 health challenge is a detected instance and reuse writes a keyed route with the unauthorized catalog', async () => {
  const calls: string[] = []
  const fetch: FetchLike = vi.fn(async (url) => {
    calls.push(url)
    if (url.endsWith('/api/ping')) return { ok: false, status: 401, text: async () => 'unauthorized' }
    return { ok: false, status: 401, text: async () => 'unauthorized' }
  })
  const { deps, mutations } = depsWith({ fetch })

  const outcome = await useDetectedInstance(deps, manifestById('freellmapi')!)

  // Detection accepts the auth challenge instead of reporting no instance.
  expect(calls[0]).toBe('http://127.0.0.1:3002/api/ping')
  expect(outcome.health).toMatchObject({ ok: false, status: 401, reachable: true })
  expect(outcome.catalog.state).toBe('unauthorized')
  expect(outcome.endpoint).toBe('http://127.0.0.1:3002/v1')
  // The route is keyed (never anonymous) and carries the honest failure, not a
  // fallback model the unauthorized listing never answered.
  const written = mutations[0]!.ops[0] as { value: { apiKeyEnv?: string; keyless?: boolean; models: unknown } }
  expect(written.value.apiKeyEnv).toBe('FREELLMAPI_API_KEY')
  expect(written.value.keyless).toBeUndefined()
  expect(written.value.models).toEqual([])
})

it('a keyless instance that answers 401 without a key gives an authorization action, never an anonymous dead route', async () => {
  const fetch: FetchLike = vi.fn(async (url) => (
    url.endsWith('/health')
      ? { ok: false, status: 401, text: async () => 'unauthorized' }
      : { ok: false, status: 401, text: async () => 'unauthorized' }
  ))
  const { deps, mutations } = depsWith({ fetch })

  await expect(useDetectedInstance(deps, manifestById('antigravity')!))
    .rejects.toThrow(/requires authorization/i)
  expect(mutations).toEqual([])
})

it('404 and 500 health replies remain undetected', async () => {
  for (const status of [404, 500]) {
    const fetch: FetchLike = vi.fn(async () => ({ ok: false, status, text: async () => 'nope' }))
    const { deps } = depsWith({ fetch })
    const detection = await detectInstance(deps, manifestById('freellmapi')!)
    expect(detection.ok).toBe(false)
    expect(detection.health.status).toBe(status)
    expect(reachable(detection.health)).toBe(false)
  }
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

it('an unreachable antigravity proxy refuses an implicit add instead of writing a dead route', async () => {
  const fetch: FetchLike = vi.fn(async () => { throw new Error('ECONNREFUSED') })
  const { deps, mutations } = depsWith({ fetch })
  await expect(useDetectedInstance(deps, manifestById('antigravity')!))
    .rejects.toThrow(/no running Antigravity Proxy instance was detected/)
  expect(mutations).toEqual([])
})

it('writes the fallback model only for a valid empty listing, never for a failure or an unknown state', () => {
  const manifest = manifestById('freellmapi')!
  expect(routeProfile(manifest, 'reuse', [], { catalogState: 'failed' }).models).toEqual([])
  expect(routeProfile(manifest, 'reuse', [], { catalogState: 'unauthorized' }).models).toEqual([])
  expect(routeProfile(manifest, 'reuse', []).models).toEqual([])
  expect(routeProfile(manifest, 'reuse', [], { catalogState: 'empty' }).models).toEqual([
    { id: 'auto', name: 'auto (fallback)' },
  ])
})

it('a failed or unauthorized discovery writes no fallback model to the route', async () => {
  for (const failure of [
    { ok: false, status: 500 },
    { ok: false, status: 401 },
  ]) {
    const fetch: FetchLike = vi.fn(async (url) => (
      url.endsWith('/api/ping')
        ? { ok: true, status: 200, text: async () => '{"status":"ok"}' }
        : { ok: failure.ok, status: failure.status, text: async () => 'down' }
    ))
    const { deps, mutations } = depsWith({ fetch })
    const outcome = await useDetectedInstance(deps, manifestById('freellmapi')!)
    expect(outcome.catalog.models).toEqual([])
    const written = mutations[0]!.ops[0] as { value: { models: unknown } }
    expect(written.value.models).toEqual([])
  }
})

it('a valid empty listing writes the clearly labelled fallback model', async () => {
  const fetch: FetchLike = vi.fn(async (url) => (
    url.endsWith('/api/ping')
      ? { ok: true, status: 200, text: async () => '{"status":"ok"}' }
      : { ok: true, status: 200, text: async () => JSON.stringify({ data: [] }) }
  ))
  const { deps, mutations } = depsWith({ fetch })
  const outcome = await useDetectedInstance(deps, manifestById('freellmapi')!)
  expect(outcome.catalog.state).toBe('empty')
  const written = mutations[0]!.ops[0] as { value: { models: unknown } }
  expect(written.value.models).toEqual([{ id: 'auto', name: 'auto (fallback)' }])
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

it('a service route keeps a failed native listing and never asks its namespace', async () => {
  const fetch: FetchLike = vi.fn(async (url) => {
    if (url.endsWith('/health')) return { ok: true, status: 200, text: async () => '{}' }
    return { ok: false, status: 503, text: async () => 'down' }
  })
  const { deps } = depsWith({ fetch })
  const discoverModelsSpy = vi.fn(async () => [{ id: 'wrong-provider-model' }])
  const outcome = await useDetectedInstance({ ...deps, llm: { discoverModels: discoverModelsSpy } }, manifestById('antigravity')!, undefined, {
    baseURL: 'http://10.0.0.9:9090',
  })
  expect(outcome.models).toEqual([])
  expect(outcome.catalog.state).toBe('failed')
  expect(discoverModelsSpy).not.toHaveBeenCalled()
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
  await expect(commitRoute(deps, manifestById('freellmapi')!, 'local', [], 'sk-unified')).rejects.toThrow('credential store refused')
  expect(mutations).toEqual([])
})

it('an antigravity install commit stores no credential and writes the keyless route', async () => {
  const fetch: FetchLike = vi.fn(async () => ({ ok: true, status: 200, text: async () => '{"status":"ok"}' }))
  const { deps, mutations, credentialSets } = depsWith({ fetch })
  const outcome = await commitRoute(deps, manifestById('antigravity')!, 'local', [], 'sk-ag')

  // The proxy needs no client key and llm-pi-ai serves keyless anthropic
  // routes: a typed key is not stored and the route carries no reference.
  expect(outcome.credentialStored).toBe(false)
  expect(credentialSets).toEqual([])
  expect(mutations).toHaveLength(1)
  const written = mutations[0]!.ops[0] as { value: { apiKeyEnv?: string; keyless?: boolean } }
  expect(written.value.keyless).toBe(true)
  expect(written.value.apiKeyEnv).toBeUndefined()
})

it('antigravity detection writes a keyless anthropic route with no pool', () => {
  const profile = routeProfile(manifestById('antigravity')!, 'reuse', [])
  expect(profile.api).toBe('anthropic-messages')
  expect(profile.keyless).toBe(true)
  expect(profile.apiKeyEnv).toBeUndefined()
  expect(profile).not.toHaveProperty('pool')
  expect(profile.baseURL).toBe('http://127.0.0.1:8082')
  expect(profile.displayName).toBe('Antigravity Proxy (detected)')
  // No fallbackModel: the route is written empty rather than carrying a
  // model the proxy never advertised.
  expect(profile.models).toEqual([])
})

it('an antigravity add never resolves, stores, or clears the legacy credential reference', async () => {
  const fetch: FetchLike = vi.fn(async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ data: [{ id: 'gemini-3.1-pro-high', description: 'Gemini 3.1 Pro (High)' }] }),
  }))
  const { deps, mutations, credentialSets } = depsWith({ fetch })
  const resolved: string[] = []
  deps.credentials = {
    resolve: async (ref) => { resolved.push(ref); return { value: 'placeholder' } },
    set: async (ref, value) => { credentialSets.push({ ref, value }) },
    unset: async () => {},
  }
  const outcome = await useDetectedInstance(deps, manifestById('antigravity')!)

  expect(outcome.credentialStored).toBe(false)
  expect(credentialSets).toEqual([])
  // A previously stored placeholder (or a real operator key from the same
  // era) stays untouched: the keyless route never reads it.
  expect(resolved).toEqual([])
  const written = mutations[0]!.ops[0] as { value: { apiKeyEnv?: string; keyless?: boolean } }
  expect(written.value.keyless).toBe(true)
  expect(written.value.apiKeyEnv).toBeUndefined()
})

it('an antigravity add lists models anonymously, even when the legacy reference resolves', async () => {
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
  deps.credentials = {
    resolve: async () => ({ value: 'placeholder' }),
    set: async () => {},
    unset: async () => {},
  }
  const outcome = await discoverServiceModels(deps, manifestById('antigravity')!, 'http://127.0.0.1:8082')

  expect(auths[0]).toBeUndefined()
  expect(outcome).toEqual([{ id: 'gemini-3.1-pro-high', name: 'Gemini 3.1 Pro (High)' }])
})

it('a direct-vendor route writes at the vendor endpoint and no fallback when no discovery is mounted', async () => {
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
  // Namespace discovery failed (no discovery is mounted), so no model id is
  // invented for the route.
  expect(written.value.models).toEqual([])
})

it('a direct-vendor route stores a supplied key under its first pool identity', async () => {
  const fetch: FetchLike = vi.fn(async () => ({ ok: true, status: 200, text: async () => 'ok' }))
  const { deps, credentialSets } = depsWith({ fetch })
  const outcome = await useDetectedInstance(deps, manifestById('commandcode')!, 'sk-cc')
  expect(outcome.credentialStored).toBe(true)
  expect(credentialSets).toEqual([{ ref: 'COMMANDCODE_KEY_1', value: 'sk-cc' }])
})

it('the commandcode route profile carries the manifest pool and labelled fallback for a valid empty listing', () => {
  const profile = routeProfile(manifestById('commandcode')!, 'local', [], { catalogState: 'empty' })
  expect(profile.api).toBe('commandcode/alpha-generate')
  expect(profile.baseURL).toBe('https://api.commandcode.ai')
  expect(profile.apiKeyEnv).toBe('COMMANDCODE_KEY_1')
  expect(profile.keyless).toBeUndefined()
  expect(profile.pool?.identities).toEqual([{ id: 'key-1', credentialRef: 'COMMANDCODE_KEY_1', priority: 1 }])
  expect(profile.models).toEqual([{ id: 'deepseek/deepseek-v4.1-flash', name: 'deepseek/deepseek-v4.1-flash (fallback)' }])
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

it('a direct route writes no fallback model when the discovery refuses', async () => {
  const fetch: FetchLike = vi.fn(async () => ({ ok: true, status: 200, text: async () => '{"status":"ok"}' }))
  const { deps, mutations } = depsWith({ fetch })
  const outcome = await useDetectedInstance(
    { ...deps, llm: { discoverModels: async () => { throw new Error('no model discovery is registered') } } },
    manifestById('commandcode')!,
  )

  expect(outcome.models).toEqual([])
  const written = mutations[0]!.ops[0] as { value: { models: unknown[] } }
  // Namespace discovery failed (no discovery is mounted), so no model id is
  // invented for the route.
  expect(written.value.models).toEqual([])
})


it('duplicate Add is refused before key storage or any probe and leaves the saved profile byte-identical', async () => {
  const fetch = vi.fn(async () => ({ ok: true, status: 200, text: async () => '{"data":[]}' }))
  const base = depsWith({ fetch })
  const saved = {
    baseURL: 'http://127.0.0.1:9999/v1',
    displayName: 'Saved by the operator',
    apiKeyEnv: 'FREELLMAPI_API_KEY',
    sessionHeader: { name: 'x-session', value: 'keep-me' },
    retry: { attempts: 4, backoffMs: 250 },
    keyless: false,
    models: [{ id: 'auto' }],
  }
  const snapshot = JSON.stringify(saved)
  const mutations: Array<{ ns: string; ops: readonly Record<string, unknown>[] }> = []
  const credentialSets: Array<{ ref: string; value: string }> = []
  const settings: SettingsSeam = {
    describe: () => [{ ns: 'llm-pi-ai', revision: 7, value: { providers: { freellmapi: saved } } }],
    mutate: async (ns, ops) => { mutations.push({ ns, ops }) },
  }
  const deps: HeavyDeps = {
    ...base.deps,
    settings,
    credentials: {
      resolve: async () => undefined,
      set: async (ref, value) => { credentialSets.push({ ref, value }) },
      unset: async () => {},
    },
  }
  const manager = new HeavyJobManager({ dir: join(deps.dshHome, 'cache', 'heavy-jobs'), run: deps.runStep })
  const service = new HeavyProvidersService(new Context(), { deps: () => deps, jobs: manager })
  const result = await service.reuse({ id: 'freellmapi', key: 'sk-should-not-store' })
  expect(result.ok).toBe(false)
  expect(result.blocked?.reason).toContain('already has a configured route')
  expect(mutations).toEqual([])
  expect(credentialSets).toEqual([])
  expect(fetch).not.toHaveBeenCalled()
  // The saved row keeps its headers, retry policy, and key reference untouched:
  // duplicate Add never overwrites a whole profile.
  expect(JSON.stringify(saved)).toBe(snapshot)
})

it('duplicate Add with a baseURL is refused before retargeting a saved route that is down', async () => {
  const fetch = vi.fn(async () => ({ ok: false, status: 503, text: async () => 'down' }))
  const base = depsWith({ fetch })
  const saved = { baseURL: 'http://127.0.0.1:3002/v1', displayName: 'Saved', models: [{ id: 'auto' }] }
  const mutations: Array<{ ns: string; ops: readonly Record<string, unknown>[] }> = []
  const deps: HeavyDeps = {
    ...base.deps,
    settings: {
      describe: () => [{ ns: 'llm-pi-ai', revision: 1, value: { providers: { freellmapi: saved } } }],
      mutate: async (ns, ops) => { mutations.push({ ns, ops }) },
    },
  }
  const manager = new HeavyJobManager({ dir: join(deps.dshHome, 'cache', 'heavy-jobs'), run: deps.runStep })
  const service = new HeavyProvidersService(new Context(), { deps: () => deps, jobs: manager })
  const result = await service.reuse({ id: 'freellmapi', key: 'sk-new', baseURL: 'http://192.168.1.10:4000' })
  expect(result.ok).toBe(false)
  expect(mutations).toEqual([])
  expect(JSON.stringify(saved)).toBe(JSON.stringify({ baseURL: 'http://127.0.0.1:3002/v1', displayName: 'Saved', models: [{ id: 'auto' }] }))
})

it('a route commit retries SETTINGS_CONFLICT with a freshly read revision', async () => {
  const calls: Array<{ revision: number | undefined; ops: readonly Record<string, unknown>[] }> = []
  const fetch: FetchLike = vi.fn(async (url) => (
    url.endsWith('/api/ping')
      ? { ok: true, status: 200, text: async () => '{"status":"ok"}' }
      : { ok: true, status: 200, text: async () => JSON.stringify({ data: [{ id: 'auto' }] }) }
  ))
  const base = depsWith({ fetch })
  let revision = 1
  const deps: HeavyDeps = {
    ...base.deps,
    settings: {
      describe: () => [{ ns: 'llm-pi-ai', revision, value: { providers: {} } }],
      mutate: async (_ns, ops, expectedRevision) => {
        calls.push({ revision: expectedRevision, ops })
        if (calls.length === 1) {
          revision += 1
          const error = new Error('settings conflict') as Error & { code?: string }
          error.code = 'SETTINGS_CONFLICT'
          throw error
        }
      },
    },
  }
  const outcome = await useDetectedInstance(deps, manifestById('freellmapi')!)
  expect(outcome.route.models).toEqual([{ id: 'auto' }])
  expect(calls).toHaveLength(2)
  // The retry re-reads the namespace instead of replaying a stale revision.
  expect(calls[1]!.revision).toBe(2)
})

it('commitRoute can refuse a route that appeared before the commit', async () => {
  const fetch: FetchLike = vi.fn(async () => ({ ok: false, status: 503, text: async () => 'down' }))
  const base = depsWith({ fetch })
  const deps: HeavyDeps = {
    ...base.deps,
    settings: {
      describe: () => [{ ns: 'llm-pi-ai', revision: 4, value: { providers: { freellmapi: { baseURL: 'http://foreign/v1', models: [] } } } }],
      mutate: async () => {},
    },
  }
  await expect(commitRoute(deps, manifestById('freellmapi')!, 'reuse', [], undefined, { refuseExisting: true }))
    .rejects.toThrow(/received a route/)
  expect(base.mutations).toEqual([])
})
