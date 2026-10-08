/**
 * Detection and runtime preflight: localhost probes are fail-soft and prefer
 * the recorded port, the machine's container runtimes are detected with one
 * shell probe, and chooseLocalPath picks the platform's best path — vendor
 * desktop app, Docker, or Podman — or names the exact missing requirement.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { manifestById, HEAVY_MANIFESTS } from '../src/manifests.js'
import {
  chooseLocalPath,
  detectInstance,
  detectRuntimes,
  effectiveHeavyManifests,
  HEAVY_OVERLAY_GLOBAL,
  instanceCandidates,
  overlayInjectionRow,
  overlayManifest,
  readServerOverlay,
  type FetchLike,
  type HeavyDeps,
  type RuntimeProbe,
} from '../src/planner.js'

const scratch: string[] = []
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function scratchDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'heavy-preflight-'))
  scratch.push(dir)
  return dir
}

function depsWith(fetch: FetchLike): HeavyDeps {
  const dir = scratchDir()
  return {
    home: dir,
    dshHome: join(dir, '.dsh'),
    fetchImpl: fetch,
    runStep: async () => ({ exitCode: 0, output: '' }),
  }
}

const found: FetchLike = vi.fn(async (url) => url.includes(':3002')
  ? { ok: true, status: 200, text: async () => '{"status":"ok"}' }
  : { ok: false, status: 503, text: async () => 'down' })

it('detection returns the answering loopback instance and its port', async () => {
  const detection = await detectInstance(depsWith(found), manifestById('freellmapi')!)
  expect(detection.ok).toBe(true)
  expect(detection.port).toBe(3002)
  expect(detection.baseURL).toBe('http://127.0.0.1:3002/v1')
  expect(detection.url).toBe('http://127.0.0.1:3002/api/ping')
})

it('detection is fail-soft: nothing answers, no throw, the failure is reported', async () => {
  const fetch: FetchLike = vi.fn(async () => { throw new Error('ECONNREFUSED') })
  const detection = await detectInstance(depsWith(fetch), manifestById('antigravity')!)
  expect(detection.ok).toBe(false)
  expect(detection.health.ok).toBe(false)
  expect(detection.health.error).toContain('ECONNREFUSED')
  expect(detection.baseURL).toBe('http://127.0.0.1:8082')
  expect(detection.port).toBe(8082)
})

it('candidate order is recorded port, declared endpoint, then default port, deduplicated', () => {
  const manifest = manifestById('freellmapi')!
  expect(instanceCandidates(manifest).map(candidate => candidate.url)).toEqual(['http://127.0.0.1:3002/api/ping'])
  const recorded = instanceCandidates(manifest, 'http://127.0.0.1:4555/v1')
  expect(recorded.map(candidate => candidate.url)).toEqual([
    'http://127.0.0.1:4555/api/ping',
    'http://127.0.0.1:3002/api/ping',
  ])
})

it('runtime detection reads one combined probe and fails soft when the runner throws', async () => {
  const probe = vi.fn(async (_step: { command: string }) => ({ exitCode: 0, output: 'available:docker\navailable:podman\navailable:node\navailable:systemd-user\n' }))
  expect(await detectRuntimes(probe)).toEqual({ docker: true, podman: true, node: true, systemdUser: true })
  const dockerOnly = vi.fn(async (_step: { command: string }) => ({ exitCode: 0, output: 'available:docker\n' }))
  expect(await detectRuntimes(dockerOnly)).toEqual({ docker: true, podman: false, node: false, systemdUser: false })
  const empty = vi.fn(async (_step: { command: string }) => ({ exitCode: 0, output: '' }))
  expect(await detectRuntimes(empty)).toEqual({ docker: false, podman: false, node: false, systemdUser: false })
  const failing = vi.fn(async (_step: { command: string }): Promise<never> => { throw new Error('no subprocess seam') })
  expect(await detectRuntimes(failing)).toEqual({ docker: false, podman: false, node: false, systemdUser: false })
  expect(probe.mock.calls[0]?.[0].command).toContain('command -v docker')
  expect(probe.mock.calls[0]?.[0].command).toContain('command -v node')
  expect(probe.mock.calls[0]?.[0].command).toContain('systemctl --user show-environment')
  expect(probe.mock.calls[0]?.[0].command).toContain('node -v')
})

it('runtime detection captures the node major, fail-soft', async () => {
  const versioned = vi.fn(async (_step: { command: string }) => ({ exitCode: 0, output: 'available:node\nnode-major:22\n' }))
  expect(await detectRuntimes(versioned)).toEqual({ docker: false, podman: false, node: true, nodeMajor: 22, systemdUser: false })
  const old = vi.fn(async (_step: { command: string }) => ({ exitCode: 0, output: 'node-major:18\n' }))
  expect((await detectRuntimes(old)).nodeMajor).toBe(18)
  // A version manager whose `node -v` answers nothing usable leaves the major
  // absent instead of reporting a bogus one.
  const silent = vi.fn(async (_step: { command: string }) => ({ exitCode: 0, output: 'available:node\nnode-major:' }))
  expect((await detectRuntimes(silent)).nodeMajor).toBeUndefined()
  const garbage = vi.fn(async (_step: { command: string }) => ({ exitCode: 0, output: 'node-major:vNext\n' }))
  expect((await detectRuntimes(garbage)).nodeMajor).toBeUndefined()
})

it('preflight picks the per-platform best path and names what is missing', () => {
  const freellmapi = manifestById('freellmapi')!
  const docker: RuntimeProbe = { docker: true, podman: false, node: true, systemdUser: true }
  const podman: RuntimeProbe = { docker: false, podman: true, node: true, systemdUser: true }
  const node: RuntimeProbe = { docker: false, podman: false, node: true, systemdUser: true }
  const bare: RuntimeProbe = { docker: false, podman: false, node: false, systemdUser: false }

  expect(chooseLocalPath(freellmapi, 'linux', docker).path).toBe('docker')
  expect(chooseLocalPath(freellmapi, 'linux', podman).path).toBe('podman')
  const missing = chooseLocalPath(freellmapi, 'linux', bare)
  expect(missing.path).toBe('unsupported')
  expect(missing.requires).toEqual(['docker'])
  expect(missing.missing).toEqual(['Docker Engine + Compose (or Podman)'])

  expect(chooseLocalPath(freellmapi, 'darwin', bare).path).toBe('vendor-app')
  expect(chooseLocalPath(freellmapi, 'win32', bare).path).toBe('vendor-app')
  expect(chooseLocalPath(manifestById('antigravity')!, 'linux', node).path).toBe('node')

  // No node in the install shell: the exact dependency is the missing item,
  // not a step that dies with `npm: command not found`.
  const noNode = chooseLocalPath(manifestById('antigravity')!, 'linux', bare)
  expect(noNode.path).toBe('unsupported')
  expect(noNode.missing).toEqual(['Node.js >= 18'])

  // A shell with node but no reachable systemd user manager cannot run the
  // systemd unit: the preflight reports the real missing requirement instead
  // of approving a path that dies at the unit step.
  const noSystemd = chooseLocalPath(manifestById('antigravity')!, 'linux', { ...node, systemdUser: false })
  expect(noSystemd.path).toBe('unsupported')
  expect(noSystemd.missing).toEqual(['A reachable systemd user session (`systemctl --user`)'])
  // macOS provisions launchd, not systemd: the same probe stays approved.
  expect(chooseLocalPath(manifestById('antigravity')!, 'darwin', { ...node, systemdUser: false }).path).toBe('node')
  // commandcode has no user unit; node alone keeps its setup path approved.
  expect(chooseLocalPath(manifestById('commandcode')!, 'linux', { ...node, systemdUser: false }).path).toBe('node')

  // Windows local provisioning is refused with the manifest's own reason.
  const win = chooseLocalPath(manifestById('commandcode')!, 'win32', node)
  expect(win.path).toBe('unsupported')
  expect(win.missing.join(' ')).toContain('Windows')

  expect(chooseLocalPath(freellmapi, 'linux', { docker: true, podman: true, node: false, systemdUser: false }, 3210).path).toBe('detected')
})

it('a node path is refused when the reported major is below the declared requirement', () => {
  const commandcode = manifestById('commandcode')!
  const node22: RuntimeProbe = { docker: false, podman: false, node: true, nodeMajor: 22, systemdUser: false }
  expect(chooseLocalPath(commandcode, 'linux', node22).path).toBe('node')

  const node18: RuntimeProbe = { docker: false, podman: false, node: true, nodeMajor: 18, systemdUser: false }
  const old = chooseLocalPath(commandcode, 'linux', node18)
  expect(old.path).toBe('unsupported')
  expect(old.missing).toEqual(['Node.js >= 22'])

  // A probe that cannot report a version cannot prove the requirement unmet.
  const unreported: RuntimeProbe = { docker: false, podman: false, node: true, systemdUser: false }
  expect(chooseLocalPath(commandcode, 'linux', unreported).path).toBe('node')

  // Other manifests keep their own declared floor: Node 18 still runs the
  // antigravity proxy (>= 18), while an older node is refused with its line.
  const antigravity = manifestById('antigravity')!
  expect(chooseLocalPath(antigravity, 'linux', { ...node18, systemdUser: true }).path).toBe('node')
  const node16: RuntimeProbe = { docker: false, podman: false, node: true, nodeMajor: 16, systemdUser: true }
  const oldAntigravity = chooseLocalPath(antigravity, 'linux', node16)
  expect(oldAntigravity.path).toBe('unsupported')
  expect(oldAntigravity.missing).toEqual(['Node.js >= 18'])

  // A Docker path is unaffected by the node probe.
  const freellmapi = manifestById('freellmapi')!
  expect(chooseLocalPath(freellmapi, 'linux', { docker: true, podman: false, node: false, systemdUser: false }).path).toBe('docker')
})

it('a direct-vendor manifest has no instance to detect; preflight gates on the setup runtime', async () => {
  const commandcode = manifestById('commandcode')!
  // Detection has no candidates: the vendor endpoint is not an on-device
  // instance, and probing it from detection would misreport it as one.
  expect(instanceCandidates(commandcode)).toEqual([])
  const detection = await detectInstance(depsWith(async url => ({ ok: true, status: 200, text: async () => url })), commandcode)
  expect(detection.ok).toBe(false)
  expect(detection.health.error).toContain('no local instance')
  expect(detection.baseURL).toBe('https://api.commandcode.ai')

  // The local setup runs install.mjs, so it still needs Node in the install
  // shell; the dependency line names the version that is missing.
  const node: RuntimeProbe = { docker: false, podman: false, node: true, systemdUser: false }
  expect(chooseLocalPath(commandcode, 'linux', node).path).toBe('node')
  const bare: RuntimeProbe = { docker: false, podman: false, node: false, systemdUser: false }
  const missing = chooseLocalPath(commandcode, 'linux', bare)
  expect(missing.path).toBe('unsupported')
  expect(missing.missing).toEqual(['Node.js 22'])
  // Windows has no /bin/bash for the setup step and stays refused.
  expect(chooseLocalPath(commandcode, 'win32', node).path).toBe('unsupported')
})

it('the private overlay retargets reuse endpoints and dashboards; absent or malformed files mean no override', () => {
  const dir = scratchDir()
  const manifest = manifestById('freellmapi')!
  expect(readServerOverlay(dir)).toEqual({})
  expect(overlayManifest(manifest, undefined)).toBe(manifest)

  writeFileSync(join(dir, 'heavy-server-overlay.json'), '{ not json', 'utf8')
  expect(readServerOverlay(dir)).toEqual({})

  writeFileSync(join(dir, 'heavy-server-overlay.json'), JSON.stringify({
    providers: { freellmapi: { reuseBaseURL: 'http://example.internal:9000/v1', reuseHealthURL: 'http://example.internal:9000/ping', dashboardUrl: 'http://example.internal:9000' } },
  }), 'utf8')
  const entry = readServerOverlay(dir)['freellmapi']
  const overlaid = overlayManifest(manifest, entry)
  expect(overlaid.reuse.baseURL).toBe('http://example.internal:9000/v1')
  expect(overlaid.reuse.health.url).toBe('http://example.internal:9000/ping')
  expect(overlaid.dashboardUrl).toBe('http://example.internal:9000')
  // The shipped table is never mutated.
  expect(manifest.reuse.baseURL).toBe('http://127.0.0.1:3002/v1')
})

it('the overlay disables a provider and overrides label, summary, links, steps, fallbackModel, and pool', () => {
  const dir = scratchDir()
  writeFileSync(join(dir, 'heavy-server-overlay.json'), JSON.stringify({
    providers: {
      freellmapi: {
        disabled: true,
        label: 'FreeLLMAPI (operator)',
        summary: 'Operator summary',
        docsUrl: 'https://docs.internal/freellmapi',
        installSteps: [{ label: 'Operator step', command: 'echo operator', weight: 2 }],
        fallbackModel: 'operator/model',
        pool: { strategy: 'balanced', identities: [{ id: 'key-1', credentialRef: 'OPERATOR_KEY', priority: 2 }] },
      },
      commandcode: { fallbackModel: null, pool: null, dashboardUrl: null },
    },
  }), 'utf8')
  const overlay = readServerOverlay(dir)

  const freellmapi = overlayManifest(manifestById('freellmapi')!, overlay['freellmapi'])
  expect(freellmapi.label).toBe('FreeLLMAPI (operator)')
  expect(freellmapi.summary).toBe('Operator summary')
  expect(freellmapi.docsUrl).toBe('https://docs.internal/freellmapi')
  expect(freellmapi.fallbackModel).toBe('operator/model')
  expect(freellmapi.pool).toEqual({
    strategy: 'balanced',
    identities: [{ id: 'key-1', credentialRef: 'OPERATOR_KEY', priority: 2 }],
  })
  // Steps replace every supported platform variant; a refused variant keeps
  // its reason and never runs the operator steps.
  const steps = [{ label: 'Operator step', command: 'echo operator', weight: 2 }]
  expect(freellmapi.local.install.default.steps).toEqual(steps)
  expect(freellmapi.local.install.darwin?.steps).toEqual(steps)
  expect(freellmapi.local.install.win32?.steps).toEqual(steps)
  const antigravity = overlayManifest(manifestById('antigravity')!, {
    installSteps: steps,
  })
  expect(antigravity.local.install.win32?.steps).toEqual([])
  expect(antigravity.local.install.win32?.unsupported).toBeDefined()

  // null removes an optional field the shipped manifest declares.
  const commandcode = overlayManifest(manifestById('commandcode')!, overlay['commandcode'])
  expect(commandcode.fallbackModel).toBeUndefined()
  expect(commandcode.pool).toBeUndefined()
  expect(commandcode.dashboardUrl).toBeUndefined()
  expect(manifestById('commandcode')!.fallbackModel).toBe('deepseek/deepseek-v4.1-flash')

  // The effective host table drops disabled providers and applies the rest.
  const effective = effectiveHeavyManifests(HEAVY_MANIFESTS, overlay)
  expect(effective.map(manifest => manifest.id)).toEqual(['antigravity', 'commandcode'])
  expect(effective[1]?.fallbackModel).toBeUndefined()
})

it('a malformed overlay field is dropped instead of reaching execution', () => {
  const dir = scratchDir()
  writeFileSync(join(dir, 'heavy-server-overlay.json'), JSON.stringify({
    providers: {
      freellmapi: {
        installSteps: [{ label: 'no command' }],
        fallbackModel: 7,
        pool: { identities: [{ id: 'key-1', credentialRef: 'lower-case' }] },
        label: '',
      },
      commandcode: 'not-an-entry',
    },
  }), 'utf8')
  const overlay = readServerOverlay(dir)
  // Every invalid field was dropped; the entry itself carried nothing usable.
  expect(overlay.freellmapi).toBeUndefined()
  expect(overlay.commandcode).toBeUndefined()
  expect(effectiveHeavyManifests(HEAVY_MANIFESTS, overlay)).toEqual([...HEAVY_MANIFESTS])
})

it('publishes the overlay as a page-bootstrap row only when providers are overridden', () => {
  const dir = scratchDir()
  expect(overlayInjectionRow(dir)).toBeUndefined()

  writeFileSync(join(dir, 'heavy-server-overlay.json'), JSON.stringify({
    providers: { freellmapi: { disabled: true }, antigravity: { label: 'Overlaid' } },
  }), 'utf8')
  expect(overlayInjectionRow(dir)).toEqual({
    kind: 'global',
    name: HEAVY_OVERLAY_GLOBAL,
    value: { providers: { freellmapi: { disabled: true }, antigravity: { label: 'Overlaid' } } },
  })
})
