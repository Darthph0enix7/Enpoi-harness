/**
 * Status: lifecycle state is authoritative for `mode` and ownership — never
 * the route address or display name — and one configured health endpoint is
 * probed once. An authentication challenge is reachable but not `ok`.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, expect, it, vi } from 'vitest'
import { HeavyJobManager } from '../src/jobs.js'
import { manifestById } from '../src/manifests.js'
import type { FetchLike, HeavyDeps, SettingsSeam } from '../src/planner.js'
import { installStatusRejectsOwnership } from '../src/index.js'
import { HeavyProvidersService } from '../src/remote.js'
import {
  clearProviderLifecycle,
  heavyLifecycleDirectory,
  heavyLifecyclePath,
  lifecycleOf,
  providerLifecyclePath,
  readHeavyLifecycle,
  recordReuseLifecycle,
  registerInstallOwnership,
} from '../src/state.js'

const scratch: string[] = []
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function scratchDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'heavy-status-'))
  scratch.push(dir)
  return dir
}

/** One service over a scratch DSH home and a recording fetch seam. */
function serviceWith(options: {
  route?: Record<string, unknown>
  fetch: FetchLike
  lifecycle?: (dshHome: string) => void
}): { service: HeavyProvidersService; deps: HeavyDeps } {
  const home = scratchDir()
  const dshHome = join(home, '.dsh')
  options.lifecycle?.(dshHome)
  const settings: SettingsSeam = {
    describe: () => [{ ns: 'llm-pi-ai', revision: 1, value: { providers: options.route === undefined ? {} : { freellmapi: options.route } } }],
    mutate: async () => {},
  }
  const deps: HeavyDeps = {
    home,
    dshHome,
    settings,
    credentials: { resolve: async () => undefined, set: async () => {}, unset: async () => {} },
    fetchImpl: options.fetch,
    runStep: async () => ({ exitCode: 0, output: '' }),
  }
  const jobs = new HeavyJobManager({ dir: join(dshHome, 'cache', 'heavy-jobs'), run: deps.runStep })
  return { service: new HeavyProvidersService(new Context(), { deps: () => deps, jobs }), deps }
}

it('status reads mode and ownership from the lifecycle record, not the route address', async () => {
  const fetch: FetchLike = vi.fn(async () => ({ ok: true, status: 200, text: async () => '{}' }))
  const { service } = serviceWith({
    route: { baseURL: 'http://127.0.0.1:3002/v1' },
    fetch,
    lifecycle: dshHome => registerInstallOwnership(dshHome, 'freellmapi', 'installer-receipt-1'),
  })
  const value = await service.status({ id: 'freellmapi' })
  expect(value.configured).toBe(true)
  expect(value.mode).toBe('local')
  expect(value.installedByHarness).toBe(true)
})

it('a reuse record stays reuse even when its route address equals a local default', async () => {
  const fetch: FetchLike = vi.fn(async () => ({ ok: true, status: 200, text: async () => '{}' }))
  const { service } = serviceWith({
    route: { baseURL: 'http://127.0.0.1:3002/v1' },
    fetch,
    lifecycle: dshHome => recordReuseLifecycle(dshHome, 'freellmapi', {
      setupKind: 'detected-instance',
      endpoint: 'http://127.0.0.1:3002/v1',
    }),
  })
  const value = await service.status({ id: 'freellmapi' })
  expect(value.mode).toBe('reuse')
  expect(value.installedByHarness).toBe(false)
  expect(value.setupKind).toBe('detected-instance')
  expect(value.endpoint).toBe('http://127.0.0.1:3002/v1')
})

it('status reports setupKind custom-instance for external instances', async () => {
  const fetch: FetchLike = vi.fn(async () => ({ ok: true, status: 200, text: async () => '{}' }))
  const { service } = serviceWith({
    route: { baseURL: 'http://192.168.1.50:4000/v1' },
    fetch,
    lifecycle: dshHome => recordReuseLifecycle(dshHome, 'freellmapi', {
      setupKind: 'custom-instance',
      endpoint: 'http://192.168.1.50:4000/v1',
    }),
  })
  const value = await service.status({ id: 'freellmapi' })
  expect(value.mode).toBe('reuse')
  expect(value.installedByHarness).toBe(false)
  expect(value.setupKind).toBe('custom-instance')
  expect(value.endpoint).toBe('http://192.168.1.50:4000/v1')
})

it('a legacy configured route is unknown, never inferred from the declared reuse address', async () => {
  const fetch: FetchLike = vi.fn(async () => ({ ok: true, status: 200, text: async () => '{}' }))
  const { service } = serviceWith({
    // Equal to the manifest's declared reuse address: old code read this as
    // `mode: 'reuse'`; lifecycle state must instead answer unknown.
    route: { baseURL: manifestById('freellmapi')!.reuse.baseURL },
    fetch,
  })
  const value = await service.status({ id: 'freellmapi' })
  expect(value.configured).toBe(true)
  expect(value.mode).toBe('unknown')
  expect(value.installedByHarness).toBeUndefined()
})

it('a route-less owned local install still reports mode, ownership, and secretless key paths', async () => {
  const fetch: FetchLike = vi.fn(async () => ({ ok: false, status: 503, text: async () => 'down' }))
  const { service, deps } = serviceWith({
    fetch,
    lifecycle: dshHome => registerInstallOwnership(dshHome, 'freellmapi', 'installer-receipt-route-less'),
  })
  deps.readInstallPaths = async id => id === 'freellmapi'
    ? { bootstrapPath: '/owned/providers/freellmapi/bootstrap.json', managementKeyPath: '/owned/providers/freellmapi/bootstrap.json' }
    : undefined
  const value = await service.status({ id: 'freellmapi' })
  // No route exists, but the running service and its retained key are still
  // visible so the UI can offer the uninstall path.
  expect(value.configured).toBe(false)
  expect(value.mode).toBe('local')
  expect(value.installedByHarness).toBe(true)
  expect(value.bootstrapPath).toBe('/owned/providers/freellmapi/bootstrap.json')
  expect(value.managementKeyPath).toBe('/owned/providers/freellmapi/bootstrap.json')
  expect(JSON.stringify(value)).not.toContain('secret')
})

it('status probes a configured health endpoint once', async () => {
  const calls: string[] = []
  const fetch: FetchLike = vi.fn(async (url) => {
    calls.push(url)
    return { ok: true, status: 200, text: async () => '{}' }
  })
  const { service } = serviceWith({ route: { baseURL: 'http://127.0.0.1:4555/v1' }, fetch })
  const value = await service.status({ id: 'freellmapi' })
  expect(value.health.ok).toBe(true)
  expect(calls.filter(url => url === 'http://127.0.0.1:4555/api/ping')).toHaveLength(1)
})

it('an authentication challenge is reachable but not ok', async () => {
  const fetch: FetchLike = vi.fn(async () => ({ ok: false, status: 401, text: async () => 'unauthorized' }))
  const { service } = serviceWith({ route: { baseURL: 'http://127.0.0.1:3002/v1' }, fetch })
  const value = await service.status({ id: 'freellmapi' })
  expect(value.health.ok).toBe(false)
  expect(value.health.status).toBe(401)
  expect(value.health.reachable).toBe(true)
})


it('stores each provider in its own encoded lifecycle file and tombstones clears', () => {
  const home = scratchDir()
  const dshHome = join(home, '.dsh')
  const id = 'operator/provider'
  registerInstallOwnership(dshHome, id, 'receipt-one')
  const path = providerLifecyclePath(dshHome, id)
  expect(path).toBe(join(heavyLifecycleDirectory(dshHome), `${encodeURIComponent(id)}.json`))
  expect(existsSync(path)).toBe(true)

  const stored = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
  expect(stored.version).toBe(1)
  expect(stored.id).toBe(id)
  expect(stored.mode).toBe('local')
  expect(stored.receipt).toBe('receipt-one')

  clearProviderLifecycle(dshHome, id)
  expect(lifecycleOf(dshHome, id)).toBeUndefined()
  // The file remains as a tombstone, so an older aggregate entry cannot
  // resurrect ownership after a clear.
  expect(existsSync(path)).toBe(true)
  expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ version: 1, id, cleared: true })
})

it('reads the legacy aggregate only until that provider gets a per-provider record', () => {
  const home = scratchDir()
  const dshHome = join(home, '.dsh')
  mkdirSync(dshHome, { recursive: true })
  writeFileSync(heavyLifecyclePath(dshHome), JSON.stringify({
    version: 1,
    providers: {
      freellmapi: { mode: 'local', installedByHarness: true, receipt: 'legacy-proof', updatedAt: 1 },
      commandcode: { mode: 'reuse', installedByHarness: false, updatedAt: 2 },
    },
  }), 'utf8')

  expect(lifecycleOf(dshHome, 'freellmapi')?.receipt).toBe('legacy-proof')
  expect(readHeavyLifecycle(dshHome).providers.commandcode?.mode).toBe('reuse')

  registerInstallOwnership(dshHome, 'freellmapi', 'new-proof')
  expect(lifecycleOf(dshHome, 'freellmapi')?.receipt).toBe('new-proof')
  // The legacy aggregate is read-only compatibility: its old entry is never
  // rewritten, but the per-provider file takes precedence.
  const aggregate = JSON.parse(readFileSync(heavyLifecyclePath(dshHome), 'utf8')) as {
    providers: Record<string, { receipt?: string }>
  }
  expect(aggregate.providers.freellmapi?.receipt).toBe('legacy-proof')

  clearProviderLifecycle(dshHome, 'freellmapi')
  expect(lifecycleOf(dshHome, 'freellmapi')).toBeUndefined()
  expect(readHeavyLifecycle(dshHome).providers.freellmapi).toBeUndefined()
  // An unrelated legacy entry still falls back normally.
  expect(readHeavyLifecycle(dshHome).providers.commandcode?.mode).toBe('reuse')
})

it('two providers keep independent lifecycle records', () => {
  const home = scratchDir()
  const dshHome = join(home, '.dsh')
  registerInstallOwnership(dshHome, 'freellmapi', 'free-proof')
  recordReuseLifecycle(dshHome, 'commandcode')
  clearProviderLifecycle(dshHome, 'freellmapi')
  expect(lifecycleOf(dshHome, 'freellmapi')).toBeUndefined()
  expect(lifecycleOf(dshHome, 'commandcode')?.mode).toBe('reuse')
})

it('the receipt reader refuses a helper status that disproves the install', () => {
  // An older helper reports neither field: absence is not a refusal.
  expect(installStatusRejectsOwnership({})).toBe(false)
  expect(installStatusRejectsOwnership({ portMismatch: false, credentialsPresent: true })).toBe(false)
  // A config edited to another port, or config/bootstrap files removed, makes
  // the receipt stale even when the receipt-owned files still hash-match.
  expect(installStatusRejectsOwnership({ portMismatch: true })).toBe(true)
  expect(installStatusRejectsOwnership({ credentialsPresent: false })).toBe(true)
})
