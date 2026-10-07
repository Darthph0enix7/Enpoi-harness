/**
 * Removal: the manifest teardown plus every named piece of DSH state — route,
 * credential, pool file, discovered-cache entry, chain links. commandcode has
 * no local service to stop.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { manifestById } from '../src/manifests.js'
import { removeProvider, routeSettingsNs, type HeavyDeps, type SettingsSeam, type StepOutcome } from '../src/planner.js'

const scratch: string[] = []
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/**
 * A scratch world: dsh home with pool + cache, settings with route + chains.
 * @param id - the provider being removed.
 * @param extraRoutes - further routes merged into the same settings namespace,
 *   for shared-credential cases.
 */
function world(id: string, extraRoutes: Record<string, unknown> = {}): {
  deps: HeavyDeps
  mutations: Array<{ ns: string; ops: readonly Record<string, unknown>[] }>
  credentialUnsets: string[]
  stepped: string[]
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
    [routeNs]: { providers: { [id]: { baseURL: 'x', models: [] }, ...extraRoutes } },
    'enpoi-orchestration': {
      chains: {
        stable: { label: 'Stable', links: [{ provider: id, model: 'auto' }, { provider: 'deepseek', model: 'deepseek-v4-flash' }] },
        only: { links: [{ provider: id, model: 'auto' }] },
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
        if (op.op === 'set' && path.length === 1) map[path[0]!] = op.value
      }
    },
  }
  const stepped: string[] = []
  const deps: HeavyDeps = {
    home,
    dshHome,
    settings,
    credentials: { resolve: async () => undefined, set: async () => {}, unset: async ref => { credentialUnsets.push(ref) } },
    runStep: async step => { stepped.push(step.label); return { exitCode: 0, output: `ran ${step.label}` } satisfies StepOutcome },
  }
  return { deps, mutations, credentialUnsets, stepped }
}

it('removal runs the teardown and drops route, credential, pool, cache, and chain links', async () => {
  const { deps, mutations, credentialUnsets, stepped } = world('freellmapi')
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
  expect(summary.warnings).toEqual([])
  expect(summary.errors).toEqual([])

  expect(credentialUnsets).toEqual(['FREELLMAPI_API_KEY'])
  const routeOps = mutations.find(entry => entry.ns === 'llm-pi-ai')?.ops ?? []
  expect(routeOps).toEqual([{ op: 'unset', path: ['providers', 'freellmapi'] }])
  const chainOps = mutations.find(entry => entry.ns === 'enpoi-orchestration')?.ops ?? []
  const chains = (chainOps[0] as { value: Record<string, { links?: unknown[] }> }).value
  expect(chains.stable?.links).toEqual([{ provider: 'deepseek', model: 'deepseek-v4-flash' }])
  expect(chains.only).toBeUndefined()

  expect(existsSync(join(deps.dshHome, 'pools', 'freellmapi.json'))).toBe(false)
  const cache = JSON.parse(readFileSync(join(deps.dshHome, 'cache', 'discovered-models.json'), 'utf8')) as { routes: Record<string, unknown> }
  expect(cache.routes.freellmapi).toBeUndefined()
  expect(cache.routes.other).toBeDefined()
})

it('removal without uninstall keeps the local install but still clears DSH state', async () => {
  const { deps, stepped } = world('antigravity')
  const summary = await removeProvider(deps, manifestById('antigravity')!, {})
  expect(summary.teardown.ran).toBe(false)
  expect(stepped).toEqual([])
  expect(summary.routeRemoved).toBe(true)
  expect(summary.poolStateRemoved).toBe(true)
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

it('a failing required teardown step is reported without aborting state cleanup', async () => {
  const { deps, mutations } = world('antigravity')
  deps.runStep = async step => step.optional === true
    ? { exitCode: 0, output: 'skipped' }
    : { exitCode: 1, output: 'rm refused' }
  const summary = await removeProvider(deps, manifestById('antigravity')!, { uninstall: true })
  expect(summary.teardown.ok).toBe(false)
  expect(summary.teardown.failedStep).toBe('Remove the config directory (accounts.json OAuth tokens, usage history, presets)')
  expect(summary.routeRemoved).toBe(true)
  expect(mutations.some(entry => entry.ns === 'llm-pi-ai')).toBe(true)
})

it('antigravity removal sweeps every npm prefix, the launchd logs, the state directory, and npx residue', () => {
  const manifest = manifestById('antigravity')!
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
