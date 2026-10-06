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
  discoverModels,
  routeProfile,
  useDetectedInstance,
  type CredentialsSeam,
  type FetchLike,
  type HeavyDeps,
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

it('antigravity detection writes a placeholder anthropic route with no pool and never keyless', () => {
  const profile = routeProfile(manifestById('antigravity')!, 'reuse', [])
  expect(profile.api).toBe('anthropic-messages')
  expect(profile.apiKeyEnv).toBe('ANTIGRAVITY_API_KEY')
  expect(profile.keyless).toBeUndefined()
  expect(profile).not.toHaveProperty('pool')
  expect(profile.baseURL).toBe('http://127.0.0.1:8082')
  expect(profile.displayName).toBe('Antigravity Proxy (detected)')
  expect(profile.models).toEqual([{ id: 'gemini-2.5-flash' }])
})

it('a direct-vendor route writes at the vendor endpoint without probing or discovering', async () => {
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
