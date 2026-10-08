/**
 * Fleet-registry pairing generation (`profile/web/scripts/generate-pairings.mjs`):
 * the alias convention that makes one alias string resolve on both devices, the
 * strict registry validation, and the fail-soft write safety — idempotence,
 * atomic 0600 writes, a backup of the replaced document, the operator opt-out,
 * and keeping the previous file when the peer parser rejects the render.
 *
 * The generator's own collaborator seams are injected: the real peer parser
 * (`../src/pairings.ts`) validates every render, tailnet facts are fixtures,
 * and `run` never touches a real Tailscale.
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parsePairingsDocument } from '../src/pairings.ts'
import {
  generatePairings,
  identifyLocalMember,
  renderPairingsDocument,
  resolveMemberIp,
  validateRegistry,
  type GeneratePairingsOptions,
} from '../../../../profile/web/scripts/generate-pairings.mjs'

const roots: string[] = []

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'peer-generate-'))
  roots.push(root)
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const REGISTRY = {
  version: 1,
  hub: 'serverlocal',
  members: [
    { name: 'serverlocal', exposure: 'debug', create: 'orchestrator', hostnames: ['serverlocal'], ip: '100.122.163.25' },
    { name: 'pc', exposure: 'debug', create: 'orchestrator', hostnames: ['mainpc'], ip: '100.98.71.68' },
    { name: 'macbook', exposure: 'answer-only', create: 'orchestrator', hostnames: ['Dartphoenixs-MacBook-Air*'], ip: '100.97.227.64' },
  ],
}

const FACTS = {
  selfNames: [],
  ips: new Map([['pc', '100.0.0.2'], ['macbook', '100.0.0.3']]),
}

/** A `run` seam that never reaches a real Tailscale. */
function noTailscale() {
  return { status: 1, stdout: '' }
}

function generate(root: string, overrides: Partial<GeneratePairingsOptions> = {}) {
  return generatePairings({
    registryPath: join(root, 'fleet.yaml'),
    pairingsPath: join(root, 'pairings.yaml'),
    registry: REGISTRY,
    parsePairings: parsePairingsDocument,
    facts: FACTS,
    run: noTailscale,
    logger: { log: () => undefined, warn: () => undefined },
    ...overrides,
  })
}

describe('fleet pairing generation', () => {
  it('names each pairing by its member on both the hub and the member', () => {
    const registry = validateRegistry(REGISTRY, 'fleet.yaml')
    const hub = identifyLocalMember(registry, { device: 'serverlocal', hostnames: [] })
    const member = identifyLocalMember(registry, { device: 'macbook', hostnames: [] })
    const ips = new Map([['pc', '100.0.0.2'], ['macbook', '100.0.0.3'], ['serverlocal', '100.122.163.25']])

    const hubDocument = parsePairingsDocument(renderPairingsDocument(registry, { local: hub, ips }), 'hub.yaml')
    expect(hubDocument.device).toBe('serverlocal')
    expect(hubDocument.pairings.map(pairing => pairing.alias)).toEqual(['pc', 'macbook'])
    // The member's own record supplies the entry other devices address it by.
    expect(hubDocument.pairings.find(pairing => pairing.alias === 'macbook')).toMatchObject({
      peer: 'macbook',
      exposure: 'answer-only',
      endpoint: 'http://100.0.0.3:3080',
      create: { agentPreset: 'orchestrator' },
    })
    // A malformed port override falls back to the managed 3080.
    expect(renderPairingsDocument(registry, { local: hub, ips, port: Number.NaN })).toContain('http://100.0.0.3:3080')

    const memberDocument = parsePairingsDocument(renderPairingsDocument(registry, { local: member, ips }), 'member.yaml')
    expect(memberDocument.device).toBe('macbook')
    // The hub entry carries the member's OWN alias, so the same wire alias
    // resolves on the hub's table and on this member's table.
    const hubEntry = memberDocument.pairings.find(pairing => pairing.peer === 'serverlocal')
    expect(hubEntry?.alias).toBe('macbook')
    expect(hubEntry?.exposure).toBe('answer-only')
    expect(hubEntry?.endpoint).toBe('http://100.122.163.25:3080')
    expect(memberDocument.pairings.find(pairing => pairing.peer === 'pc')?.alias).toBe('pc')
  })

  it('identifies the local member from hostname wildcards', () => {
    const registry = validateRegistry(REGISTRY, 'fleet.yaml')
    const mac = identifyLocalMember(registry, { hostnames: ['Dartphoenixs-MacBook-Air-6.local'] })
    expect(mac.name).toBe('macbook')
    const pc = identifyLocalMember(registry, { hostnames: ['mainpc.local'] })
    expect(pc.name).toBe('pc')
    expect(() => identifyLocalMember(registry, { hostnames: ['unknown-host'] })).toThrow(/DSH_PEER_DEVICE/u)
  })

  it('prefers the live tailnet IPv4 and falls back to the registry ip', () => {
    const member = { name: 'pc', hostnames: ['mainpc'], ip: '100.98.71.68' }
    expect(resolveMemberIp(member, { ips: new Map([['pc', '100.0.0.9']]) }, noTailscale)).toBe('100.0.0.9')
    expect(resolveMemberIp(member, { ips: new Map([['mainpc', '100.0.0.8']]) }, noTailscale)).toBe('100.0.0.8')
    expect(resolveMemberIp(member, { ips: new Map() }, () => ({ status: 0, stdout: '100.0.0.7\n' }))).toBe('100.0.0.7')
    expect(resolveMemberIp(member, { ips: new Map() }, noTailscale)).toBe('100.98.71.68')
  })

  it('writes 0600, re-runs byte-identical, and backs up a replaced document', async () => {
    const root = tempRoot()
    const pairingsPath = join(root, 'pairings.yaml')
    const handwritten = 'version: 1\ndevice: serverlocal\npairings: []\n'
    writeFileSync(pairingsPath, handwritten, { mode: 0o644 })

    const first = await generate(root, { device: 'serverlocal' })
    expect(first.action).toBe('written')
    expect(statSync(pairingsPath).mode & 0o777).toBe(0o600)
    const rendered = readFileSync(pairingsPath, 'utf8')
    expect(rendered.startsWith('# dsh-managed: true\n')).toBe(true)
    expect(parsePairingsDocument(rendered, pairingsPath).pairings).toHaveLength(2)
    const backups = readdirSync(root).filter(name => name.startsWith('pairings.yaml.backup-'))
    expect(backups).toHaveLength(1)
    expect(readFileSync(join(root, backups[0]!), 'utf8')).toBe(handwritten)
    expect(statSync(join(root, backups[0]!)).mode & 0o777).toBe(0o600)

    const second = await generate(root, { device: 'serverlocal' })
    expect(second.action).toBe('unchanged')
    expect(readFileSync(pairingsPath, 'utf8')).toBe(rendered)
    expect(readdirSync(root).filter(name => name.startsWith('pairings.yaml.backup-'))).toHaveLength(1)
  })

  it('keeps the previous document when the peer parser rejects the render', async () => {
    const root = tempRoot()
    const pairingsPath = join(root, 'pairings.yaml')
    const previous = 'version: 1\ndevice: serverlocal\npairings: []\n'
    writeFileSync(pairingsPath, previous)
    const result = await generate(root, {
      device: 'serverlocal',
      parsePairings: () => { throw new Error('rejected') },
    })
    expect(result.action).toBe('rejected')
    expect(readFileSync(pairingsPath, 'utf8')).toBe(previous)
    expect(readdirSync(root).filter(name => name.startsWith('pairings.yaml.backup-'))).toHaveLength(0)
  })

  it('skips an operator-owned document and a missing registry without touching the file', async () => {
    const root = tempRoot()
    const pairingsPath = join(root, 'pairings.yaml')
    const owned = '# dsh-managed: false\nversion: 1\ndevice: serverlocal\npairings: []\n'
    writeFileSync(pairingsPath, owned)
    const optedOut = await generate(root, { device: 'serverlocal' })
    expect(optedOut).toMatchObject({ action: 'skipped', reason: 'operator-marker' })
    expect(readFileSync(pairingsPath, 'utf8')).toBe(owned)

    const missingRoot = tempRoot()
    const missing = await generatePairings({
      registryPath: join(missingRoot, 'absent.yaml'),
      pairingsPath: join(missingRoot, 'pairings.yaml'),
      parsePairings: parsePairingsDocument,
      facts: FACTS,
      run: noTailscale,
      logger: { log: () => undefined, warn: () => undefined },
    })
    expect(missing).toMatchObject({ action: 'skipped', reason: 'no-registry' })
    expect(readdirSync(missingRoot)).toEqual([])
  })

  it('refuses an unknown local device instead of guessing', async () => {
    const root = tempRoot()
    const result = await generate(root, { device: 'not-a-member' })
    expect(result).toMatchObject({ action: 'skipped', reason: 'unknown-device' })
    expect(readdirSync(root)).toEqual([])
  })

  it('rejects a registry with a duplicate alias or an unknown hub', () => {
    expect(() => validateRegistry({ ...REGISTRY, hub: 'nobody' }, 'fleet.yaml')).toThrow(/hub/u)
    expect(() => validateRegistry({
      ...REGISTRY,
      members: [
        REGISTRY.members[0]!,
        { ...REGISTRY.members[1]!, alias: 'serverlocal' },
      ],
    }, 'fleet.yaml')).toThrow(/repeats alias/u)
    expect(() => validateRegistry({
      ...REGISTRY,
      members: [{ name: 'x', exposure: 'loud', ip: '10.0.0.1' }],
    }, 'fleet.yaml')).toThrow(/exposure/u)
  })
})
