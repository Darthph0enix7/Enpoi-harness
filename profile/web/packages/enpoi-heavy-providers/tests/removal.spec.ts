/**
 * Removal: the manifest teardown plus every named piece of DSH state — route,
 * credential, pool file, discovered-cache entry, chain links. commandcode
 * removal never touches the shared keypool service.
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

/** A scratch world: dsh home with pool + cache, settings with route + chains. */
function world(id: string): {
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
    [routeNs]: { providers: { [id]: { baseURL: 'x', models: [] } } },
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
  expect(stepped).toEqual(['Stop the stack and drop its volume', 'Remove the container image', 'Remove the clone directory'])
  expect(summary.routeRemoved).toBe(true)
  expect(summary.credentialRemoved).toBe(true)
  expect(summary.poolStateRemoved).toBe(true)
  expect(summary.cacheEntryRemoved).toBe(true)
  expect(summary.chainLinksRemoved).toBe(2)
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

it('commandcode removal drops only the commandcode pool and never touches the keypool service', async () => {
  const { deps, mutations, stepped } = world('commandcode')
  const summary = await removeProvider(deps, manifestById('commandcode')!, { uninstall: true })
  expect(summary.teardown.ran).toBe(true)
  expect(summary.teardown.ok).toBe(true)
  expect(stepped).toEqual(['Drop only pools.commandcode (keypool and other pools stay)'])
  const script = manifestById('commandcode')!.removal.steps[0]!.command
  expect(script).toContain('keypool-remove.mjs')
  expect(script).not.toContain('systemctl')
  expect(summary.routeRemoved).toBe(true)
  expect(summary.poolStateRemoved).toBe(true)
  expect(summary.credentialRemoved).toBe(true)
  const routeOps = mutations.find(entry => entry.ns === 'commandcode-provider')?.ops ?? []
  expect(routeOps).toEqual([{ op: 'unset', path: ['providers', 'commandcode'] }])
})

it('a failing required teardown step is reported without aborting state cleanup', async () => {
  const { deps, mutations } = world('antigravity')
  deps.runStep = async step => step.optional === true
    ? { exitCode: 0, output: 'skipped' }
    : { exitCode: 1, output: 'rm refused' }
  const summary = await removeProvider(deps, manifestById('antigravity')!, { uninstall: true })
  expect(summary.teardown.ok).toBe(false)
  expect(summary.teardown.failedStep).toBe('Remove the config directory (OAuth tokens, presets, usage history)')
  expect(summary.routeRemoved).toBe(true)
  expect(mutations.some(entry => entry.ns === 'llm-pi-ai')).toBe(true)
})
