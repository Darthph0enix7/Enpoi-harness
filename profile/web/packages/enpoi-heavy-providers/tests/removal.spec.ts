/**
 * Removal: the owned local teardown plus every named piece of DSH state —
 * route, credentials, pool file, discovered-cache entry, host references, and
 * lifecycle record. Unknown/reused installs never run the static teardown, and
 * a route-unset failure aborts every downstream destructive step.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { HeavyJobManager } from '../src/jobs.js'
import { manifestById, type HeavyProviderManifest } from '../src/manifests.js'
import {
  overlayManifest,
  removeProvider,
  routeSettingsNs,
  type HeavyDeps,
  type SettingsSeam,
  type StepOutcome,
} from '../src/planner.js'
import { lifecycleOf, recordReuseLifecycle, registerInstallOwnership } from '../src/state.js'

const scratch: string[] = []
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/**
 * A scratch world: dsh home with pool + cache, settings with route + chains.
 * @param id - the provider being removed.
 * @param extraRoutes - further routes merged into the same settings namespace,
 *   for shared-credential cases.
 * @param options - lifecycle seed and the removed route's own profile.
 */
function world(id: string, extraRoutes: Record<string, unknown> = {}, options: {
  lifecycle?: 'local' | 'reuse'
  route?: Record<string, unknown>
} = {}): {
  deps: HeavyDeps
  mutations: Array<{ ns: string; ops: readonly Record<string, unknown>[] }>
  credentialUnsets: string[]
  stepped: string[]
  evicted: string[]
} {
  const home = mkdtempSync(join(tmpdir(), 'heavy-remove-'))
  scratch.push(home)
  const dshHome = join(home, '.dsh')
  mkdirSync(join(dshHome, 'pools'), { recursive: true })
  mkdirSync(join(dshHome, 'cache'), { recursive: true })
  writeFileSync(join(dshHome, 'pools', `${id}.json`), '{"version":1,"identities":{}}', 'utf8')
  writeFileSync(join(dshHome, 'cache', 'discovered-models.json'), JSON.stringify({
    version: 1,
    routes: { [id]: { baseURL: 'x', fetchedAt: 1, models: [] }, other: { baseURL: 'y', fetchedAt: 1, models: [] } },
  }), 'utf8')

  const mutations: Array<{ ns: string; ops: readonly Record<string, unknown>[] }> = []
  const credentialUnsets: string[] = []
  const routeNs = routeSettingsNs(manifestById(id)!)
  const document = {
    [routeNs]: {
      providers: {
        [id]: { baseURL: 'x', models: [], ...options.route },
        ...extraRoutes,
      },
    },
    'enpoi-orchestration': {
      chains: {
        stable: { label: 'Stable', links: [{ provider: id, model: 'auto' }, { provider: 'deepseek', model: 'deepseek-v4-flash' }] },
        only: { links: [{ provider: id, model: 'auto' }] },
      },
      personas: {
        seat: { provider: id, model: 'auto' },
        untouched: { provider: 'deepseek', model: 'deepseek-v4-flash' },
      },
      uiPreferences: {
        favorites: [{ provider: id, modelId: 'auto' }, { provider: 'deepseek', modelId: 'chat' }],
        hiddenModels: { [id]: ['auto'], deepseek: ['chat'] },
        providerOrder: [id, 'deepseek'],
      },
    },
  } as Record<string, unknown>
  const settings: SettingsSeam = {
    describe: () => Object.entries(document).map(([ns, value], index) => ({ ns, revision: index + 1, value })),
    mutate: async (ns, ops) => {
      mutations.push({ ns, ops })
      for (const op of ops) {
        const path = op.path as string[]
        const map = document[ns] as Record<string, unknown>
        if (op.op === 'unset' && path.length === 2) delete (map[path[0]!] as Record<string, unknown>)[path[1]!]
        if (op.op === 'unset' && path.length === 1) delete map[path[0]!]
        if (op.op === 'set' && path.length === 1) map[path[0]!] = op.value
        if (op.op === 'set' && path.length === 2) (map[path[0]!] as Record<string, unknown>)[path[1]!] = op.value
      }
    },
  }
  const stepped: string[] = []
  const evicted: string[] = []
  const deps: HeavyDeps = {
    home,
    dshHome,
    settings,
    credentials: { resolve: async () => undefined, set: async () => {}, unset: async ref => { credentialUnsets.push(ref) } },
    jobs: {
      evict: (id) => { evicted.push(id); return true },
      isRunning: () => false,
      withProviderLock: async (_id, operation) => operation(),
    },
    runStep: async step => { stepped.push(step.label); return { exitCode: 0, output: `ran ${step.label}` } satisfies StepOutcome },
  }
  if (options.lifecycle === 'local') registerInstallOwnership(dshHome, id, `receipt:${id}`)
  if (options.lifecycle === 'reuse') recordReuseLifecycle(dshHome, id)
  return { deps, mutations, credentialUnsets, stepped, evicted }
}

/** Wait for a job to settle across event-loop turns. */
async function settled(manager: HeavyJobManager, id: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const job = manager.snapshot(id)
    if (job !== undefined && job.state !== 'running') return
    await new Promise(resolve => setImmediate(resolve))
  }
  throw new Error('job did not settle')
}

/** A promise resolved explicitly by the test, so ordering never depends on sleeps. */
function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((settle) => { resolve = settle })
  return { promise, resolve }
}

it('removal runs the owned teardown and drops route, credentials, pool, cache, references, state, and job snapshot', async () => {
  const { deps, mutations, credentialUnsets, stepped, evicted } = world('freellmapi', {}, { lifecycle: 'local' })
  const summary = await removeProvider(deps, manifestById('freellmapi')!, { uninstall: true })

  expect(summary.teardown.ran).toBe(true)
  expect(summary.teardown.ok).toBe(true)
  // The platform-guarded desktop-app steps run too; the host platform's guard
  // makes them no-ops where they do not apply.
  expect(stepped).toEqual([
    'Stop the stack and drop its volume',
    'Remove the container image',
    'Remove the clone directory',
    'Remove the macOS desktop app and its data',
    'Remove the Windows desktop app and its data',
  ])
  expect(summary.routeRemoved).toBe(true)
  expect(summary.credentialRemoved).toBe(true)
  expect(summary.poolStateRemoved).toBe(true)
  expect(summary.cacheEntryRemoved).toBe(true)
  expect(summary.chainLinksRemoved).toBe(2)
  expect(summary.referencesRemoved).toEqual(expect.arrayContaining([
    'chains.stable: dropped 1 link(s)',
    'personas.seat: reset to inherit',
    'uiPreferences.favorites: pruned',
    'uiPreferences.hiddenModels: pruned',
    'uiPreferences.providerOrder: pruned',
  ]))
  expect(summary.warnings).toEqual([])
  expect(summary.errors).toEqual([])

  expect(credentialUnsets).toEqual(['FREELLMAPI_API_KEY'])
  expect(evicted).toEqual(['freellmapi'])
  expect(lifecycleOf(deps.dshHome, 'freellmapi')).toBeUndefined()
  const routeOps = mutations.find(entry => entry.ns === 'llm-pi-ai')?.ops ?? []
  expect(routeOps).toEqual([{ op: 'unset', path: ['providers', 'freellmapi'] }])
  const chainOps = mutations.find(entry => entry.ns === 'enpoi-orchestration' && entry.ops.some(op => pathOf(op)[0] === 'chains'))?.ops ?? []
  expect(chainOps).toContainEqual({ op: 'unset', path: ['chains', 'only'] })
  expect(chainOps).toContainEqual({ op: 'set', path: ['chains', 'stable'], value: { label: 'Stable', links: [{ provider: 'deepseek', model: 'deepseek-v4-flash' }] } })

  expect(existsSync(join(deps.dshHome, 'pools', 'freellmapi.json'))).toBe(false)
  const cache = JSON.parse(readFileSync(join(deps.dshHome, 'cache', 'discovered-models.json'), 'utf8')) as { routes: Record<string, unknown> }
  expect(cache.routes.freellmapi).toBeUndefined()
  expect(cache.routes.other).toBeDefined()
})

it('removal without uninstall keeps the local install but still clears DSH state', async () => {
  const { deps, stepped, credentialUnsets, evicted } = world('antigravity')
  const summary = await removeProvider(deps, manifestById('antigravity')!, {})
  expect(summary.teardown.ran).toBe(false)
  expect(stepped).toEqual([])
  expect(summary.routeRemoved).toBe(true)
  expect(summary.poolStateRemoved).toBe(true)
  expect(evicted).toEqual(['antigravity'])
  // The keyless manifest names no credential reference: a placeholder (or a
  // real operator key) left under ANTIGRAVITY_API_KEY is never unset.
  expect(credentialUnsets).toEqual([])
})

it('route-only deletion of an owned local install keeps its lifecycle record for a later uninstall', async () => {
  const { deps, stepped } = world('antigravity', {}, { lifecycle: 'local' })
  const summary = await removeProvider(deps, manifestById('antigravity')!, {})
  expect(stepped).toEqual([])
  expect(summary.routeRemoved).toBe(true)
  expect(summary.warnings.join('\n')).toContain('local install left in place')
  expect(lifecycleOf(deps.dshHome, 'antigravity')?.receipt).toBe('receipt:antigravity')
})

it('route-only deletion of an owned keyed install keeps the seeded credential for a re-add', async () => {
  const { deps, credentialUnsets } = world('cliproxyapi', {}, { lifecycle: 'local' })
  const summary = await removeProvider(deps, manifestById('cliproxyapi')!, {})
  expect(summary.routeRemoved).toBe(true)
  expect(summary.teardown.ran).toBe(false)
  // The service is still running with the installer-generated key; unsetting
  // it would strand a keyed service that the operator cannot re-add.
  expect(credentialUnsets).toEqual([])
  expect(summary.warnings.join('\n')).toContain('credential CLIPROXYAPI_API_KEY kept')
  expect(summary.warnings.join('\n')).toContain('remove with uninstall')
  expect(lifecycleOf(deps.dshHome, 'cliproxyapi')?.receipt).toBe('receipt:cliproxyapi')
})

it('an unknown local install is not torn down by the static manifest steps', async () => {
  const { deps, stepped } = world('antigravity')
  const summary = await removeProvider(deps, manifestById('antigravity')!, { uninstall: true })
  expect(summary.teardown.ran).toBe(false)
  expect(stepped).toEqual([])
  expect(summary.routeRemoved).toBe(true)
  expect(summary.warnings.join('\n')).toContain('no verified harness ownership receipt')
  expect(summary.warnings.join('\n')).toContain('vendor service was not touched')
})

it('a reused instance is never owned, so uninstall runs no vendor teardown', async () => {
  const { deps, stepped } = world('antigravity', {}, { lifecycle: 'reuse' })
  const summary = await removeProvider(deps, manifestById('antigravity')!, { uninstall: true })
  expect(stepped).toEqual([])
  expect(summary.routeRemoved).toBe(true)
  expect(summary.warnings.join('\n')).toContain('no verified harness ownership receipt')
  expect(lifecycleOf(deps.dshHome, 'antigravity')).toBeUndefined()
})

it('commandcode removal drops DSH state with no local teardown and no keypool script', async () => {
  const { deps, mutations, credentialUnsets, stepped } = world('commandcode')
  const summary = await removeProvider(deps, manifestById('commandcode')!, { uninstall: true })
  // A direct vendor route has nothing local to tear down.
  expect(summary.teardown.ran).toBe(false)
  expect(stepped).toEqual([])
  expect(manifestById('commandcode')!.removal.steps.map(step => step.command).join('\n')).not.toContain('keypool-remove.mjs')
  expect(summary.routeRemoved).toBe(true)
  expect(summary.poolStateRemoved).toBe(true)
  expect(summary.credentialRemoved).toBe(true)
  expect(credentialUnsets).toEqual(['COMMANDCODE_KEY_1'])
  const routeOps = mutations.find(entry => entry.ns === 'commandcode-provider')?.ops ?? []
  expect(routeOps).toEqual([{ op: 'unset', path: ['providers', 'commandcode'] }])
})

it('removal keeps a credential reference another configured route still resolves', async () => {
  const { deps, credentialUnsets } = world('freellmapi', {
    'freellmapi-mirror': { baseURL: 'http://127.0.0.1:3002/v1', apiKeyEnv: 'FREELLMAPI_API_KEY' },
  })
  const summary = await removeProvider(deps, manifestById('freellmapi')!, {})

  // The route is gone but the shared reference stays: unsetting it would break
  // the mirror route.
  expect(summary.routeRemoved).toBe(true)
  expect(summary.credentialRemoved).toBe(false)
  expect(credentialUnsets).toEqual([])
  expect(summary.warnings.join('\n')).toContain('FREELLMAPI_API_KEY kept')
  expect(summary.warnings.join('\n')).toContain('another configured route references it')
  expect(summary.errors).toEqual([])
})

it('removal keeps a reference another route\'s pool identity resolves', async () => {
  const { deps, credentialUnsets } = world('commandcode', {
    'commandcode-mirror': {
      baseURL: 'https://api.commandcode.ai',
      pool: { strategy: 'priority-sticky', identities: [{ id: 'key-9', credentialRef: 'COMMANDCODE_KEY_1', priority: 1 }] },
    },
  })
  const summary = await removeProvider(deps, manifestById('commandcode')!, {})

  expect(summary.credentialRemoved).toBe(false)
  expect(credentialUnsets).toEqual([])
  expect(summary.warnings.join('\n')).toContain('COMMANDCODE_KEY_1 kept')
})

it('removal unsets the overlaid pool identities actually configured, keeping shared ones', async () => {
  const overlayPool = {
    strategy: 'priority-sticky' as const,
    identities: [
      { id: 'key-1', credentialRef: 'OPERATOR_KEY', priority: 1 },
      { id: 'key-2', credentialRef: 'SHARED_KEY', priority: 2 },
    ],
  }
  const { deps, credentialUnsets } = world('commandcode', {
    'commandcode-mirror': { baseURL: 'https://api.commandcode.ai', apiKeyEnv: 'OPERATOR_KEY' },
  }, {
    route: { baseURL: 'https://api.commandcode.ai', pool: overlayPool },
  })
  const effective = overlayManifest(manifestById('commandcode')!, { pool: overlayPool })
  const summary = await removeProvider(deps, effective, {})
  expect(credentialUnsets).toContain('SHARED_KEY')
  expect(credentialUnsets).not.toContain('OPERATOR_KEY')
  expect(summary.warnings.join('\n')).toContain('OPERATOR_KEY kept')
})

it('a failing required teardown step is reported without aborting state cleanup and preserves the lifecycle record', async () => {
  const { deps, mutations } = world('antigravity', {}, { lifecycle: 'local' })
  deps.runStep = async step => step.optional === true
    ? { exitCode: 0, output: 'skipped' }
    : { exitCode: 1, output: 'rm refused' }
  const summary = await removeProvider(deps, manifestById('antigravity')!, { uninstall: true })
  expect(summary.teardown.ok).toBe(false)
  expect(summary.teardown.failedStep).toBe('Remove the config directory (accounts.json OAuth tokens, usage history, presets)')
  expect(summary.routeRemoved).toBe(true)
  expect(mutations.some(entry => entry.ns === 'llm-pi-ai')).toBe(true)
  expect(summary.warnings.join('\n')).toContain('lifecycle record preserved for retry')
  expect(lifecycleOf(deps.dshHome, 'antigravity')?.receipt).toBe('receipt:antigravity')
})

it('a route-unset failure aborts every downstream destructive step, including the teardown', async () => {
  const { deps, mutations, credentialUnsets, stepped, evicted } = world('freellmapi', {}, { lifecycle: 'local' })
  const routeNs = routeSettingsNs(manifestById('freellmapi')!)
  const original = deps.settings!
  deps.settings = {
    describe: () => original.describe!(),
    mutate: async (ns, ops, revision) => {
      mutations.push({ ns, ops })
      if (ns === routeNs) throw new Error('settings namespace is read-only')
      await original.mutate(ns, ops, revision)
    },
  }
  const summary = await removeProvider(deps, manifestById('freellmapi')!, { uninstall: true })

  expect(summary.routeRemoved).toBe(false)
  expect(summary.teardown.ran).toBe(false)
  expect(stepped).toEqual([])
  expect(summary.errors.join('\n')).toContain('route: settings namespace is read-only')
  expect(summary.credentialRemoved).toBe(false)
  expect(credentialUnsets).toEqual([])
  expect(lifecycleOf(deps.dshHome, 'freellmapi')?.receipt).toBe('receipt:freellmapi')
  expect(existsSync(join(deps.dshHome, 'pools', 'freellmapi.json'))).toBe(true)
  const cache = JSON.parse(readFileSync(join(deps.dshHome, 'cache', 'discovered-models.json'), 'utf8')) as { routes: Record<string, unknown> }
  expect(cache.routes.freellmapi).toBeDefined()
  expect(mutations.every(entry => entry.ns === routeNs)).toBe(true)
  expect(evicted).toEqual([])
})

it('removal while an install job holds the provider lock is refused before any mutation', async () => {
  const { deps, mutations, credentialUnsets, stepped, evicted } = world('freellmapi', {}, { lifecycle: 'local' })
  const entered = deferred()
  const releaseFinalize = deferred()
  const manager = new HeavyJobManager({
    dir: join(deps.dshHome, 'cache', 'heavy-jobs'),
    run: async () => ({ exitCode: 0, output: 'ok' }),
  })
  manager.start('freellmapi', 'install', [{ label: 'Install', command: 'true' }], async () => {
    entered.resolve()
    await releaseFinalize.promise
  })
  await entered.promise
  deps.jobs = manager

  const summary = await removeProvider(deps, manifestById('freellmapi')!, { uninstall: true })
  expect(summary.blocked?.lock).toBe('held')
  expect(summary.routeRemoved).toBe(false)
  expect(summary.teardown.ran).toBe(false)
  expect(mutations).toEqual([])
  expect(credentialUnsets).toEqual([])
  expect(stepped).toEqual([])
  expect(evicted).toEqual([])
  expect(lifecycleOf(deps.dshHome, 'freellmapi')?.receipt).toBe('receipt:freellmapi')

  releaseFinalize.resolve()
  await settled(manager, 'freellmapi')
  expect(manager.evict('freellmapi')).toBe(true)
})

it('a direct planner removal without a job manager still takes the shared provider lock', async () => {
  const { deps, mutations, credentialUnsets, stepped } = world('freellmapi', {}, { lifecycle: 'local' })
  const entered = deferred()
  const releaseFinalize = deferred()
  const manager = new HeavyJobManager({
    dir: join(deps.dshHome, 'cache', 'heavy-jobs'),
    run: async () => ({ exitCode: 0, output: 'ok' }),
  })
  manager.start('freellmapi', 'install', [{ label: 'Install', command: 'true' }], async () => {
    entered.resolve()
    await releaseFinalize.promise
  })
  await entered.promise
  // No deps.jobs: the planner must acquire the same on-disk lock directly
  // rather than running destructive cleanup unlocked.
  delete deps.jobs

  const summary = await removeProvider(deps, manifestById('freellmapi')!, { uninstall: true })
  expect(summary.blocked?.lock).toBe('held')
  expect(summary.routeRemoved).toBe(false)
  expect(mutations).toEqual([])
  expect(credentialUnsets).toEqual([])
  expect(stepped).toEqual([])

  releaseFinalize.resolve()
  await settled(manager, 'freellmapi')
  expect(manager.evict('freellmapi')).toBe(true)
})

it('a direct planner removal evicts the persisted snapshot under its own lock', async () => {
  const { deps } = world('freellmapi')
  const jobDir = join(deps.dshHome, 'cache', 'heavy-jobs')
  mkdirSync(jobDir, { recursive: true })
  writeFileSync(join(jobDir, 'freellmapi.json'), JSON.stringify({ state: 'succeeded' }), 'utf8')
  delete deps.jobs
  const summary = await removeProvider(deps, manifestById('freellmapi')!, {})
  expect(summary.routeRemoved).toBe(true)
  expect(existsSync(join(jobDir, 'freellmapi.json'))).toBe(false)
})

it('an unreadable provider lock refuses removal without guessing', async () => {
  const { deps, mutations, credentialUnsets } = world('freellmapi')
  const lockDir = join(deps.dshHome, 'cache', 'heavy-jobs', 'locks', encodeURIComponent('freellmapi'))
  mkdirSync(lockDir, { recursive: true })
  writeFileSync(join(lockDir, '000000000001.lock'), '{"version":1', 'utf8')
  deps.jobs = new HeavyJobManager({
    dir: join(deps.dshHome, 'cache', 'heavy-jobs'),
    run: async () => ({ exitCode: 0, output: 'ok' }),
  })
  const summary = await removeProvider(deps, manifestById('freellmapi')!, {})
  expect(summary.blocked?.lock).toBe('unreadable')
  expect(summary.routeRemoved).toBe(false)
  expect(mutations).toEqual([])
  expect(credentialUnsets).toEqual([])
})

/** One path op's path, for assertions over the loose settings record type. */
function pathOf(op: Record<string, unknown>): string[] {
  return Array.isArray(op.path) ? op.path as string[] : []
}

it('reference cleanup leaves unrelated chains, personas, preferences, and default selection untouched', async () => {
  const { deps, mutations } = world('freellmapi')
  await removeProvider(deps, manifestById('freellmapi')!, {})
  const ops = mutations.filter(entry => entry.ns === 'enpoi-orchestration').flatMap(entry => entry.ops)
  // Leaf operations only: the unrelated chain, persona, favorite, hidden
  // entry, and ordering item are never restated.
  expect(ops.some(op => pathOf(op)[0] === 'chains' && pathOf(op)[1] !== 'stable' && pathOf(op)[1] !== 'only')).toBe(false)
  expect(ops.some(op => pathOf(op)[0] === 'personas' && pathOf(op)[1] === 'untouched')).toBe(false)
  expect((ops.find(op => pathOf(op)[1] === 'favorites')?.value as unknown[] | undefined)).toEqual([{ provider: 'deepseek', modelId: 'chat' }])
  expect((ops.find(op => pathOf(op)[1] === 'hiddenModels')?.value as Record<string, string[]> | undefined)).toEqual({ deepseek: ['chat'] })
  expect((ops.find(op => pathOf(op)[1] === 'providerOrder')?.value as string[] | undefined)).toEqual(['deepseek'])
})

it('reference cleanup resets the default and subagent selections only when they name the route', async () => {
  const { deps, mutations } = world('freellmapi')
  const original = deps.settings!
  const extra: Record<string, Record<string, unknown>> = {
    'agent-default-model': { provider: 'freellmapi', model: 'auto', baseline: 'kilo' },
    'subagent-model-selection-settings': {
      enabled: true,
      allowedModels: [{ provider: 'freellmapi', model: 'auto' }, { provider: 'deepseek', model: 'chat' }],
    },
    'subagent-model-selection': {
      enabled: false,
      allowedModels: [{ provider: 'deepseek', model: 'chat' }],
    },
  }
  deps.settings = {
    describe: () => [
      ...original.describe!(),
      ...Object.entries(extra).map(([ns, value], index) => ({ ns, revision: 20 + index, value })),
    ],
    mutate: async (ns, ops, revision) => {
      if (ns in extra) {
        mutations.push({ ns, ops })
        return
      }
      await original.mutate(ns, ops, revision)
    },
  }
  await removeProvider(deps, manifestById('freellmapi')!, {})

  const defaultOps = mutations.find(entry => entry.ns === 'agent-default-model')?.ops ?? []
  expect(defaultOps).toEqual([
    { op: 'set', path: ['provider'], value: 'kilo' },
    { op: 'set', path: ['model'], value: 'poolside/laguna-s-2.1:free' },
  ])
  const subagentOps = mutations.find(entry => entry.ns === 'subagent-model-selection-settings')?.ops ?? []
  expect(subagentOps).toEqual([
    { op: 'set', path: ['allowedModels'], value: [{ provider: 'deepseek', model: 'chat' }] },
  ])
  // The legacy spelling has no route reference, so it is never restated.
  expect(mutations.some(entry => entry.ns === 'subagent-model-selection')).toBe(false)
})

it('antigravity removal sweeps every npm prefix, the launchd logs, the state directory, and npx residue', () => {
  const manifest: HeavyProviderManifest = manifestById('antigravity')!
  expect(manifest.removal.steps.map(step => step.label)).toEqual([
    'Stop and disable the user service',
    'Remove the user service file',
    'Uninstall the package from every npm prefix',
    'Remove the macOS agent logs',
    'Remove the config directory (accounts.json OAuth tokens, usage history, presets)',
    'Remove npm npx cache residue',
  ])
  const commands = manifest.removal.steps.map(step => step.command).join('\n')
  // Every prefix the install or a legacy setup can land in, plus npm's own.
  expect(commands).toContain('{home}/.local')
  expect(commands).toContain('{home}/.npm-global')
  expect(commands).toContain('npm prefix -g')
  expect(commands).toContain('.nvm/versions/node')
  expect(commands).toContain('.local/share/nvm/versions/node')
  expect(commands).toContain('fnm/aliases/default')
  expect(commands).toContain('/usr/local')
  expect(commands).toContain('sudo')
  // Intact install leftovers npm can leave behind, macOS logs, state, npx.
  expect(commands).toContain('lib/node_modules/."$PKG"-*')
  expect(commands).toContain('Library/Logs/antigravity-proxy')
  expect(commands).toContain('rm -rf {config}/antigravity-proxy')
  expect(commands).toContain('.npm/_npx')
  // The linger step's effect is left alone: removal never disables lingering.
  expect(commands).not.toContain('disable-linger')
  const warnings = manifest.removal.warnings.join('\n')
  expect(warnings).toContain('accounts.json')
  expect(warnings).toContain('usage-history.json')
  expect(warnings).toContain('lingering is left enabled')
  expect(warnings).toContain('~/.npm/_cacache')
  expect(warnings).toContain('never touched')
})
