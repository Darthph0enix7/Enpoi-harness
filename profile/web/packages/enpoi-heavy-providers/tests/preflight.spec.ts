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
import { manifestById } from '../src/manifests.js'
import {
  chooseLocalPath,
  detectInstance,
  detectRuntimes,
  instanceCandidates,
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
  const probe = vi.fn(async (_step: { command: string }) => ({ exitCode: 0, output: 'available:docker\navailable:podman\navailable:node\n' }))
  expect(await detectRuntimes(probe)).toEqual({ docker: true, podman: true, node: true })
  const dockerOnly = vi.fn(async (_step: { command: string }) => ({ exitCode: 0, output: 'available:docker\n' }))
  expect(await detectRuntimes(dockerOnly)).toEqual({ docker: true, podman: false, node: false })
  const empty = vi.fn(async (_step: { command: string }) => ({ exitCode: 0, output: '' }))
  expect(await detectRuntimes(empty)).toEqual({ docker: false, podman: false, node: false })
  const failing = vi.fn(async (_step: { command: string }): Promise<never> => { throw new Error('no subprocess seam') })
  expect(await detectRuntimes(failing)).toEqual({ docker: false, podman: false, node: false })
  expect(probe.mock.calls[0]?.[0].command).toContain('command -v docker')
  expect(probe.mock.calls[0]?.[0].command).toContain('command -v node')
})

it('preflight picks the per-platform best path and names what is missing', () => {
  const freellmapi = manifestById('freellmapi')!
  const docker: RuntimeProbe = { docker: true, podman: false, node: true }
  const podman: RuntimeProbe = { docker: false, podman: true, node: true }
  const node: RuntimeProbe = { docker: false, podman: false, node: true }
  const bare: RuntimeProbe = { docker: false, podman: false, node: false }

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

  // Windows local provisioning is refused with the manifest's own reason.
  const win = chooseLocalPath(manifestById('commandcode')!, 'win32', node)
  expect(win.path).toBe('unsupported')
  expect(win.missing.join(' ')).toContain('Windows')

  expect(chooseLocalPath(freellmapi, 'linux', { docker: true, podman: true, node: false }, 3210).path).toBe('detected')
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
  const node: RuntimeProbe = { docker: false, podman: false, node: true }
  expect(chooseLocalPath(commandcode, 'linux', node).path).toBe('node')
  const bare: RuntimeProbe = { docker: false, podman: false, node: false }
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
