/**
 * CLIProxyAPI host producer integration: the route the Add/Install flows write
 * after an external instance or a receipt-owned local helper install.
 *
 * The service is composed for real over the planner, job manager, lifecycle
 * store, settings, and credentials seams. Only the outside world is faked:
 * HTTP, subprocess steps, and the trusted host installer callbacks.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { resolveRouteModels } from '@deepseek-ai/dsh-llm-pi-ai/src/catalog.ts'
import { afterEach, expect, it, vi } from 'vitest'
import { HeavyJobManager } from '../src/jobs.js'
import type { HeavyStep } from '../src/manifests.js'
import type { CredentialsSeam, FetchLike, HeavyDeps, ModelDiscoverySeam, SettingsSeam, StepOutcome } from '../src/planner.js'
import { HeavyProvidersService } from '../src/remote.js'
import { lifecycleOf, registerInstallOwnership } from '../src/state.js'

const scratch: string[] = []
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function scratchDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'heavy-cliproxy-integration-'))
  scratch.push(dir)
  return dir
}

interface HarnessOptions {
  route?: Record<string, unknown>
  stored?: Record<string, string>
  fetch?: FetchLike
  mutate?: (ns: string, ops: readonly Record<string, unknown>[]) => Promise<void>
  readInstallReceipt?: (id: string) => Promise<string | undefined> | string | undefined
  readInstallCredential?: (id: string) => Promise<string | undefined> | string | undefined
  llm?: ModelDiscoverySeam
  events?: string[]
  /** null omits the profile root, exercising the no-launcher refusal. */
  profileDir?: string | null
  /** Seed the lifecycle record before the service is used. */
  lifecycle?: (dshHome: string) => void
  /** Called after each install step is recorded, for mid-job state changes. */
  stepHook?: (step: HeavyStep) => void
}

interface Harness {
  service: HeavyProvidersService
  deps: HeavyDeps
  manager: HeavyJobManager
  providers: Record<string, Record<string, unknown>>
  mutations: Array<{ ns: string; ops: readonly Record<string, unknown>[] }>
  credentialSets: Array<{ ref: string; value: string }>
  credentialUnsets: string[]
  resolvedRefs: string[]
  stored: Record<string, string>
  steps: HeavyStep[]
  events: string[]
  receiptCalls: string[]
  credentialCalls: string[]
  settle: (id: string) => Promise<NonNullable<ReturnType<HeavyJobManager['snapshot']>>>
}

function harness(options: HarnessOptions = {}): Harness {
  const home = scratchDir()
  const dshHome = join(home, '.dsh')
  options.lifecycle?.(dshHome)
  const providers: Record<string, Record<string, unknown>> = options.route === undefined
    ? {}
    : { cliproxyapi: structuredClone(options.route) }
  const mutations: Harness['mutations'] = []
  const credentialSets: Harness['credentialSets'] = []
  const credentialUnsets: string[] = []
  const resolvedRefs: string[] = []
  const steps: HeavyStep[] = []
  const events = options.events ?? []
  const receiptCalls: string[] = []
  const credentialCalls: string[] = []
  const stored: Record<string, string> = { ...options.stored }

  const settings: SettingsSeam = {
    describe: () => [{ ns: 'llm-pi-ai', revision: 1, value: { providers } }],
    mutate: async (ns, ops) => {
      if (options.mutate !== undefined) await options.mutate(ns, ops)
      mutations.push({ ns, ops })
      for (const op of ops) {
        const path = Array.isArray(op.path) ? op.path : []
        if (path[0] !== 'providers') continue
        const id = path[1]
        if (typeof id !== 'string') continue
        if (op.op === 'unset') delete providers[id]
        if (op.op === 'set' && op.value !== null && typeof op.value === 'object') {
          providers[id] = { ...(op.value as Record<string, unknown>) }
        }
      }
    },
  }
  const credentials: CredentialsSeam = {
    resolve: async (ref) => {
      resolvedRefs.push(ref)
      const value = stored[ref]
      return value === undefined ? undefined : { value }
    },
    set: async (ref, value) => {
      credentialSets.push({ ref, value })
      stored[ref] = value
      events.push('credential:set')
    },
    unset: async (ref) => {
      credentialUnsets.push(ref)
      delete stored[ref]
    },
  }
  const runStep = async (step: HeavyStep): Promise<StepOutcome> => {
    steps.push(step)
    options.stepHook?.(step)
    if (step.label === 'Detect local runtimes') {
      return { exitCode: 0, output: 'available:node\nnode-major:22\navailable:systemd-user\n' }
    }
    return { exitCode: 0, output: '' }
  }
  const profileDir = options.profileDir === null
    ? undefined
    : options.profileDir ?? join(home, 'profile')
  const deps: HeavyDeps = {
    home,
    dshHome,
    settings,
    credentials,
    ...profileDir === undefined ? {} : { profileDir },
    ...options.llm === undefined ? {} : { llm: options.llm },
    fetchImpl: options.fetch ?? (async () => ({ ok: false, status: 503, text: async () => 'down' })),
    runStep,
    readInstallReceipt: async (id) => {
      receiptCalls.push(id)
      return options.readInstallReceipt?.(id)
    },
    readInstallCredential: async (id) => {
      credentialCalls.push(id)
      return options.readInstallCredential?.(id)
    },
  }
  const manager = new HeavyJobManager({ dir: join(dshHome, 'cache', 'heavy-jobs'), run: runStep })
  const service = new HeavyProvidersService(new Context(), { deps: () => deps, jobs: manager })
  const settle = async (id: string): Promise<NonNullable<ReturnType<HeavyJobManager['snapshot']>>> => {
    for (let attempt = 0; attempt < 200; attempt++) {
      const job = manager.snapshot(id)
      if (job !== undefined && job.state !== 'running') return job
      await new Promise(resolve => setImmediate(resolve))
    }
    throw new Error('install job did not settle')
  }
  return {
    service,
    deps,
    manager,
    providers,
    mutations,
    credentialSets,
    credentialUnsets,
    resolvedRefs,
    stored,
    steps,
    events,
    receiptCalls,
    credentialCalls,
    settle,
  }
}

interface FetchCall {
  url: string
  headers: Record<string, string>
}

/** The manifest's health and OpenAI-compatible listing endpoints, with call recording. */
function lobby(options: {
  models?: unknown
  requiredKey?: string
  healthOk?: boolean
  events?: string[]
} = {}): { fetch: FetchLike; calls: FetchCall[] } {
  const calls: FetchCall[] = []
  const fetch: FetchLike = async (url, init) => {
    const headers = { ...init?.headers }
    calls.push({ url, headers })
    if (url.endsWith('/healthz')) {
      return { ok: options.healthOk !== false, status: options.healthOk === false ? 503 : 200, text: async () => '{"status":"ok"}' }
    }
    if (url.endsWith('/v1/models')) {
      options.events?.push(`listing:${headers.authorization ?? 'anonymous'}`)
      if (options.requiredKey !== undefined && headers.authorization !== `Bearer ${options.requiredKey}`) {
        return { ok: false, status: 401, text: async () => 'unauthorized' }
      }
      return { ok: true, status: 200, text: async () => JSON.stringify(options.models ?? { data: [{ id: 'gemini-2.5-pro' }] }) }
    }
    return { ok: false, status: 404, text: async () => 'not found' }
  }
  return { fetch, calls }
}

it('an external keyless instance writes the anonymous endpoint-authority route without calling the helper', async () => {
  const remote = lobby()
  const env = harness({ fetch: remote.fetch })
  const result = await env.service.reuse({ id: 'cliproxyapi' })

  expect(result.ok).toBe(true)
  expect(result.catalog?.state).toBe('fresh')
  expect(result.catalog?.source).toBe('endpoint')
  expect(result.health!.ok).toBe(true)
  expect(result.port).toBe(8317)
  expect(result.route).toMatchObject({
    api: 'openai-completions',
    baseURL: 'http://127.0.0.1:8317/v1',
    sessionHeader: 'x-session-id',
    catalogAuthority: 'endpoint',
    keyless: true,
    models: [{ id: 'gemini-2.5-pro' }],
  })
  expect(result.route!.apiKeyEnv).toBeUndefined()
  expect(remote.calls.find(call => call.url.endsWith('/v1/models'))?.headers.authorization).toBeUndefined()
  expect(env.credentialSets).toEqual([])
  expect(env.steps).toEqual([])
  expect(env.receiptCalls).toEqual([])
  expect(env.credentialCalls).toEqual([])
})

it('an external instance with a stored key lists with exactly that key and writes a keyed route', async () => {
  const env = harness({
    stored: { CLIPROXYAPI_API_KEY: 'sk-operator' },
    fetch: lobby({ requiredKey: 'sk-operator' }).fetch,
  })
  const result = await env.service.reuse({ id: 'cliproxyapi' })

  expect(result.ok).toBe(true)
  expect(result.catalog?.state).toBe('fresh')
  expect(result.route!.keyless).toBe(false)
  expect(result.route!.apiKeyEnv).toBe('CLIPROXYAPI_API_KEY')
  expect(result.route!.models).toEqual([{ id: 'gemini-2.5-pro' }])
  // One resolution serves both discovery and the route decision; the stored
  // value is never re-written by an add that did not supply a key.
  expect(env.resolvedRefs.filter(ref => ref === 'CLIPROXYAPI_API_KEY')).toHaveLength(1)
  expect(env.credentialSets).toEqual([])
  expect(env.receiptCalls).toEqual([])
  expect(env.credentialCalls).toEqual([])
  expect(JSON.stringify(result)).not.toContain('sk-operator')
})

it('an external add with a typed key stores it and writes a keyed route', async () => {
  const env = harness({ fetch: lobby({ requiredKey: 'sk-typed' }).fetch })
  const result = await env.service.reuse({ id: 'cliproxyapi', key: 'sk-typed' })

  expect(result.ok).toBe(true)
  expect(result.catalog?.state).toBe('fresh')
  expect(result.route!.keyless).toBe(false)
  expect(result.route!.apiKeyEnv).toBe('CLIPROXYAPI_API_KEY')
  expect(env.credentialSets).toEqual([{ ref: 'CLIPROXYAPI_API_KEY', value: 'sk-typed' }])
  expect(env.credentialUnsets).toEqual([])
  expect(JSON.stringify(result)).not.toContain('sk-typed')
})

it('a verified local install stores the generated key before discovery and writes the keyed route', async () => {
  const events: string[] = []
  const env = harness({
    fetch: lobby({ requiredKey: 'generated-secret-key', events }).fetch,
    events,
    readInstallReceipt: id => id === 'cliproxyapi' ? 'install-proof-1' : undefined,
    readInstallCredential: id => id === 'cliproxyapi' ? 'generated-secret-key' : undefined,
  })

  const started = await env.service.install({ id: 'cliproxyapi', key: 'operator-supplied-key' })
  expect(started.ok).toBe(true)
  const job = await env.settle('cliproxyapi')

  expect(job.state).toBe('succeeded')
  expect(env.steps.some(step => step.command.includes('$DSH_HEAVY_HELPER') && step.command.includes(' install '))).toBe(true)
  // The installer's seeded key is authoritative for a local install: it is
  // stored first, discovery presents it, and the operator-typed key is not.
  expect(env.credentialSets).toEqual([{ ref: 'CLIPROXYAPI_API_KEY', value: 'generated-secret-key' }])
  expect(env.stored.CLIPROXYAPI_API_KEY).toBe('generated-secret-key')
  expect(events).toEqual([
    'credential:set',
    'listing:Bearer generated-secret-key',
  ])
  expect(env.providers.cliproxyapi).toMatchObject({
    api: 'openai-completions',
    baseURL: 'http://127.0.0.1:8317/v1',
    apiKeyEnv: 'CLIPROXYAPI_API_KEY',
    keyless: false,
    sessionHeader: 'x-session-id',
    catalogAuthority: 'endpoint',
    models: [{ id: 'gemini-2.5-pro' }],
  })
  expect(lifecycleOf(env.deps.dshHome, 'cliproxyapi')).toMatchObject({
    mode: 'local',
    installedByHarness: true,
    receipt: 'install-proof-1',
  })
  // The generated credential never reaches a snapshot or a route value.
  expect(JSON.stringify(job)).not.toContain('generated-secret-key')
  expect(JSON.stringify(env.providers)).not.toContain('generated-secret-key')
  expect(job.logTail).not.toContain('generated-secret-key')

  const removed = await env.service.remove({ id: 'cliproxyapi', uninstall: true })
  expect(removed.summary?.teardown.ran).toBe(true)
  expect(removed.summary?.teardown.ok).toBe(true)
  expect(env.steps.some(step => step.command.includes('$DSH_HEAVY_HELPER') && step.command.includes(' remove '))).toBe(true)
  expect(lifecycleOf(env.deps.dshHome, 'cliproxyapi')).toBeUndefined()
})

it('a CPA install resolves the helper from the plugin, not from a profile packages/ layout', async () => {
  // The temp profile has no `packages/` directory at all; the helper path is
  // module-relative, and both the dynamic import and the step use it.
  const env = harness({ profileDir: null, fetch: lobby({ models: { data: [] } }).fetch })
  const result = await env.service.install({ id: 'cliproxyapi' })

  expect(result.ok).toBe(true)
  await env.settle('cliproxyapi')
  expect(env.steps.some(step => step.command.includes('$DSH_HEAVY_HELPER'))).toBe(true)
  expect(env.steps.every(step => !step.command.includes('{profileDir}'))).toBe(true)
  expect(env.steps.every(step => !step.command.includes('/packages/enpoi-heavy-providers/'))).toBe(true)
  expect(existsSync(join(env.deps.home, 'profile', 'packages'))).toBe(false)
})

it('a missing receipt fails a CPA install with no route, no credential overwrite, and no ownership', async () => {
  const env = harness({
    stored: { CLIPROXYAPI_API_KEY: 'operator-existing' },
    fetch: lobby().fetch,
  })
  await env.service.install({ id: 'cliproxyapi' })
  const job = await env.settle('cliproxyapi')

  expect(job.state).toBe('failed')
  expect(job.error).toContain('without a verified ownership receipt')
  expect(env.providers.cliproxyapi).toBeUndefined()
  expect(env.credentialSets).toEqual([])
  expect(env.credentialUnsets).toEqual([])
  expect(env.stored.CLIPROXYAPI_API_KEY).toBe('operator-existing')
  expect(lifecycleOf(env.deps.dshHome, 'cliproxyapi')).toBeUndefined()

  const stepsBefore = env.steps.length
  const removed = await env.service.remove({ id: 'cliproxyapi', uninstall: true })
  expect(removed.summary?.teardown.ran).toBe(false)
  expect(removed.summary?.warnings.join('\n')).toContain('no verified harness ownership receipt')
  expect(env.steps.length).toBe(stepsBefore)
  expect(env.steps.some(step => step.command.includes(' remove '))).toBe(false)
})

it('a verified receipt with an unreadable generated key fails without an anonymous or stale-key route', async () => {
  const env = harness({
    stored: { CLIPROXYAPI_API_KEY: 'operator-existing' },
    fetch: lobby().fetch,
    readInstallReceipt: () => 'install-proof-unreadable-key',
  })
  await env.service.install({ id: 'cliproxyapi' })
  const job = await env.settle('cliproxyapi')

  expect(job.state).toBe('failed')
  expect(job.error).toContain('generated inference key is unreadable')
  expect(env.providers.cliproxyapi).toBeUndefined()
  expect(env.credentialSets).toEqual([])
  expect(env.credentialUnsets).toEqual([])
  expect(env.stored.CLIPROXYAPI_API_KEY).toBe('operator-existing')
  expect(lifecycleOf(env.deps.dshHome, 'cliproxyapi')).toMatchObject({
    mode: 'local',
    installedByHarness: true,
    receipt: 'install-proof-unreadable-key',
  })
})

it('a route commit failure keeps the local service receipt and its seeded credential for retry or reuse', async () => {
  const env = harness({
    fetch: lobby().fetch,
    readInstallReceipt: () => 'install-proof-retry',
    readInstallCredential: () => 'seeded-key-retry',
    mutate: async () => { throw new Error('route write refused') },
  })
  await env.service.install({ id: 'cliproxyapi' })
  const job = await env.settle('cliproxyapi')

  expect(job.state).toBe('failed')
  expect(job.error).toContain('route write refused')
  expect(job.error).toContain('is installed; retry the install or add the detected instance')
  expect(lifecycleOf(env.deps.dshHome, 'cliproxyapi')).toMatchObject({
    mode: 'local',
    installedByHarness: true,
    receipt: 'install-proof-retry',
  })
  expect(env.credentialSets).toEqual([{ ref: 'CLIPROXYAPI_API_KEY', value: 'seeded-key-retry' }])
  expect(env.credentialUnsets).toEqual([])
  expect(env.stored.CLIPROXYAPI_API_KEY).toBe('seeded-key-retry')
  expect(env.providers.cliproxyapi).toBeUndefined()
})

it('a route-only removed owned install re-adds with the installer key and keeps its uninstall proof', async () => {
  const env = harness({
    fetch: lobby({ requiredKey: 'seeded-owned-key' }).fetch,
    lifecycle: dshHome => registerInstallOwnership(dshHome, 'cliproxyapi', 'owned-receipt-readd'),
    readInstallCredential: id => id === 'cliproxyapi' ? 'seeded-owned-key' : undefined,
  })

  const result = await env.service.reuse({ id: 'cliproxyapi' })
  expect(result.ok).toBe(true)
  expect(result.catalog?.state).toBe('fresh')
  // The verified lifecycle let Add read the installer's key again instead of
  // failing the anonymous 401 guard, and the route is keyed.
  expect(result.route!.keyless).toBe(false)
  expect(result.route!.apiKeyEnv).toBe('CLIPROXYAPI_API_KEY')
  expect(env.credentialSets).toEqual([{ ref: 'CLIPROXYAPI_API_KEY', value: 'seeded-owned-key' }])
  expect(JSON.stringify(result)).not.toContain('seeded-owned-key')
  // A detected-instance add never downgrades the owned local lifecycle: the
  // uninstall path stays available.
  expect(lifecycleOf(env.deps.dshHome, 'cliproxyapi')).toMatchObject({
    mode: 'local',
    installedByHarness: true,
    receipt: 'owned-receipt-readd',
  })
})

it('an empty first-install listing writes the known-empty cache record the resolver reads', async () => {
  const env = harness({
    fetch: lobby({ models: { data: [] } }).fetch,
    readInstallReceipt: () => 'install-proof-empty',
    readInstallCredential: () => 'seeded-empty-key',
  })
  await env.service.install({ id: 'cliproxyapi' })
  const job = await env.settle('cliproxyapi')
  expect(job.state).toBe('succeeded')
  expect(env.providers.cliproxyapi?.models).toEqual([])

  const cachePath = join(env.deps.dshHome, 'cache', 'discovered-models.json')
  const cache = JSON.parse(readFileSync(cachePath, 'utf8')) as {
    version: number
    routes: Record<string, { baseURL?: string; fetchedAt: number; models: Array<{ id: string }> }>
  }
  expect(cache.version).toBe(1)
  expect(cache.routes.cliproxyapi).toMatchObject({ baseURL: 'http://127.0.0.1:8317/v1', models: [] })
  expect(cache.routes.cliproxyapi!.fetchedAt).toBeGreaterThan(0)

  // The resolver reads that record as a known-empty endpoint authority, not a
  // missing-catalog failure.
  const resolved = resolveRouteModels({
    provider: 'cliproxyapi',
    models: [],
    catalogAuthority: 'endpoint',
    // The cache's models array (empty here) is the reader's shape; the test
    // only needs the retained record, and the resolver returns before reading
    // individual model fields.
    discoveredModels: cache.routes.cliproxyapi!.models as unknown as [],
    defaultContextWindow: 200_000,
    defaultMaxTokens: 8192,
    defaultInput: ['text'],
  })
  expect(resolved.knownEmpty).toBe(true)
})

it('a failed first-install listing writes no route and no authoritative empty catalog', async () => {
  const fetch: FetchLike = async (url) => url.endsWith('/healthz')
    ? { ok: true, status: 200, text: async () => '{"status":"ok"}' }
    : { ok: false, status: 503, text: async () => 'listing unavailable' }
  const env = harness({
    fetch,
    readInstallReceipt: () => 'install-proof-failed-listing',
    readInstallCredential: () => 'seeded-failed-key',
  })
  await env.service.install({ id: 'cliproxyapi' })
  const job = await env.settle('cliproxyapi')
  expect(job.state).toBe('failed')
  expect(job.error).toContain('model listing was failed')
  expect(job.error).toContain('no route was written')
  expect(env.providers.cliproxyapi).toBeUndefined()
  expect(existsSync(join(env.deps.dshHome, 'cache', 'discovered-models.json'))).toBe(false)
  // The installed service and its receipt survive for a retry or detected add.
  expect(lifecycleOf(env.deps.dshHome, 'cliproxyapi')).toMatchObject({ mode: 'local', receipt: 'install-proof-failed-listing' })
})

it('an install finalizer refuses to overwrite a route that appeared during the job', async () => {
  const foreign = { baseURL: 'http://127.0.0.1:9317/v1', displayName: 'Foreign route', models: [] }
  let injected = false
  let env!: Harness
  env = harness({
    fetch: lobby().fetch,
    readInstallReceipt: () => 'install-proof-foreign',
    readInstallCredential: () => 'seeded-foreign-key',
    stepHook: () => {
      if (injected) return
      injected = true
      env.providers.cliproxyapi = structuredClone(foreign)
    },
  })
  await env.service.install({ id: 'cliproxyapi' })
  const job = await env.settle('cliproxyapi')
  expect(job.state).toBe('failed')
  expect(job.error).toContain('received a route while the install was running')
  expect(job.error).toContain('refused to overwrite')
  // The foreign row is untouched (no install-shaped route replace).
  expect(env.providers.cliproxyapi).toEqual(foreign)
})

it('duplicate Add refuses before any probe, helper callback, job, or overwrite', async () => {
  const saved = {
    baseURL: 'http://127.0.0.1:8317/v1',
    displayName: 'Saved route',
    apiKeyEnv: 'CLIPROXYAPI_API_KEY',
    keyless: false,
    models: [{ id: 'saved-model' }],
  }
  const remote = lobby()
  const env = harness({ route: saved, fetch: remote.fetch })
  const snapshot = JSON.stringify(saved)

  const reused = await env.service.reuse({ id: 'cliproxyapi' })
  const installed = await env.service.install({ id: 'cliproxyapi' })

  expect(reused.ok).toBe(false)
  expect(installed.ok).toBe(false)
  expect(reused.blocked?.reason).toContain('already has a configured route')
  expect(installed.blocked?.reason).toContain('already has a configured route')
  expect(remote.calls).toEqual([])
  expect(env.steps).toEqual([])
  expect(env.mutations).toEqual([])
  expect(env.receiptCalls).toEqual([])
  expect(env.credentialCalls).toEqual([])
  expect(JSON.stringify(saved)).toBe(snapshot)
})

it('an explicit remote URL is preserved for the route, listing, and health probe', async () => {
  const remote = lobby()
  const env = harness({ fetch: remote.fetch })
  const result = await env.service.reuse({ id: 'cliproxyapi', baseURL: 'http://192.168.1.20:9000/some/path' })

  expect(result.ok).toBe(true)
  expect(result.endpoint).toBe('http://192.168.1.20:9000/v1')
  expect(result.route!.baseURL).toBe('http://192.168.1.20:9000/v1')
  expect(result.route!.keyless).toBe(true)
  expect(remote.calls.map(call => call.url)).toEqual([
    'http://192.168.1.20:9000/v1/models',
    'http://192.168.1.20:9000/healthz',
  ])
  expect(env.receiptCalls).toEqual([])
  expect(env.credentialCalls).toEqual([])
})

it('an empty endpoint listing is the authoritative catalog and is never backfilled', async () => {
  const discoverModels = vi.fn(async () => [{ id: 'namespace-model' }])
  const env = harness({
    fetch: lobby({ models: { data: [] } }).fetch,
    llm: { discoverModels },
  })
  const result = await env.service.reuse({ id: 'cliproxyapi' })

  expect(result.ok).toBe(true)
  expect(result.catalog?.state).toBe('empty')
  expect(result.catalog?.source).toBe('endpoint')
  expect(result.route!.catalogAuthority).toBe('endpoint')
  expect(result.route!.models).toEqual([])
  expect(discoverModels).not.toHaveBeenCalled()
})

it('an alive endpoint with a rejected key reports unauthorized without claiming a fresh catalog', async () => {
  const env = harness({
    stored: { CLIPROXYAPI_API_KEY: 'sk-wrong' },
    fetch: lobby({ requiredKey: 'sk-right' }).fetch,
  })
  const result = await env.service.reuse({ id: 'cliproxyapi' })

  expect(result.ok).toBe(true)
  expect(result.health!.ok).toBe(true)
  expect(result.catalog?.state).toBe('unauthorized')
  expect(result.catalog?.status).toBe(401)
  expect(result.route!.keyless).toBe(false)
  expect(result.route!.apiKeyEnv).toBe('CLIPROXYAPI_API_KEY')
  expect(result.route!.models).toEqual([])
  expect(JSON.stringify(result)).not.toContain('sk-wrong')
})

it('an implicit add refuses when no instance answers health', async () => {
  const remote = lobby({ healthOk: false })
  const env = harness({ fetch: remote.fetch })

  await expect(env.service.reuse({ id: 'cliproxyapi' })).rejects.toThrow(/no running CLIProxyAPI instance was detected/)
  expect(remote.calls.every(call => call.url.endsWith('/healthz'))).toBe(true)
  expect(env.mutations).toEqual([])
  expect(env.credentialSets).toEqual([])
  expect(env.receiptCalls).toEqual([])
  expect(env.credentialCalls).toEqual([])
})
