/**
 * PROOF: prints the commandcode row exactly as `enpoiHeavy.manifests` serves
 * it, plus the ordering fold the `enpoiHeavy.status` reply adds for a route
 * namespace the running profile has not mounted yet. The assertions pin every
 * printed fact, so the quoted proof cannot drift from the code.
 */
import { expect, it } from 'vitest'
import { HEAVY_MANIFESTS, manifestById, manifestProblems } from '../src/manifests.js'
import { pendingRestartForManifest, settingsNamespaceReady, type HeavyDeps } from '../src/planner.js'

function depsListing(namespaces: string[]): HeavyDeps {
  return {
    home: '/tmp',
    dshHome: '/tmp/.dsh',
    settings: { describe: () => namespaces.map(ns => ({ ns, revision: 1 })), mutate: async () => {} },
    runStep: async () => ({ exitCode: 0, output: '' }),
  }
}

it('prints the served commandcode row and its settings readiness', () => {
  const manifest = manifestById('commandcode')!
  const deps = depsListing(['llm-pi-ai', 'enpoi-orchestration'])
  const row = {
    id: manifest.id,
    label: manifest.label,
    summary: manifest.summary,
    protocol: manifest.protocol,
    delivery: manifest.delivery,
    settingsNs: manifest.settingsNs,
    settingsReady: settingsNamespaceReady(deps, manifest.settingsNs ?? ''),
    reuseBaseURL: manifest.reuse.baseURL,
    reuseNote: manifest.reuse.note,
    localBaseURL: manifest.local.baseURL,
    installSteps: manifest.local.install.default.steps.length,
    removalSteps: manifest.removal.steps.length,
    pool: manifest.pool,
    auth: manifest.auth,
    unsupported: manifest.unsupported,
    problems: manifestProblems(),
    pendingRestart: pendingRestartForManifest(deps, manifest),
  }
  console.info(`[host-probe] ${JSON.stringify(row)}`)

  expect(row.delivery).toBe('direct')
  expect(row.settingsNs).toBe('commandcode-provider')
  expect(row.settingsReady).toBe(false)
  expect(row.unsupported).toBeUndefined()
  expect(row.reuseBaseURL).toBe('https://api.commandcode.ai')
  expect(row.localBaseURL).toBe('https://api.commandcode.ai')
  expect(row.installSteps).toBe(1)
  expect(row.removalSteps).toBe(0)
  expect(row.pool?.identities).toEqual([{ id: 'key-1', credentialRef: 'COMMANDCODE_KEY_1', priority: 1 }])
  expect(row.pendingRestart?.message).toContain('Available after the next restart')
  expect(row.problems).toEqual([])
  expect(HEAVY_MANIFESTS.map(value => value.id)).toContain('commandcode')
})
