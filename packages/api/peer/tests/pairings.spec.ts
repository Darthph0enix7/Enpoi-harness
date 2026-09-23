import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  PeerConfigError,
  PeerPairingsStore,
  parsePairingsDocument,
} from '../src/pairings.ts'

const roots: string[] = []

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'peer-pairings-'))
  roots.push(root)
  return root
}

function write(path: string, content: string): void {
  writeFileSync(path, content)
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('pairing document validation', () => {
  it('parses a complete entry and omits null optionals', () => {
    const document = parsePairingsDocument(`
version: 1
device: serverlocal
pairings:
  - alias: co-dev
    peer: laptop
    exposure: debug
    sessionId: sess-abc
    create:
      cwd: /home/adam/work
      agentPreset: sysadmin
    remoteSessionId: sess-xyz
    endpoint: https://laptop.pike-acrux.ts.net:8443
    token: null
    runawayCeiling: null
    allowModelChange: false
`, '/tmp/pairings.yaml')
    expect(document.device).toBe('serverlocal')
    const pairing = document.pairings[0]!
    expect(pairing.alias).toBe('co-dev')
    expect(pairing.exposure).toBe('debug')
    expect(pairing.sessionId).toBe('sess-abc')
    expect(pairing.create).toEqual({ cwd: '/home/adam/work', agentPreset: 'sysadmin' })
    expect(pairing.remoteSessionId).toBe('sess-xyz')
    expect(pairing.token).toBeUndefined()
    expect(pairing.runawayCeiling).toBeUndefined()
    expect(pairing.allowModelChange).toBe(false)
  })

  it.each([
    ['a non-mapping document', '42'],
    ['a wrong version', 'version: 2\ndevice: a\npairings: []'],
    ['a missing exposure', 'version: 1\ndevice: a\npairings:\n  - alias: x\n    peer: b\n    sessionId: s'],
    ['an unknown exposure', 'version: 1\ndevice: a\npairings:\n  - alias: x\n    peer: b\n    exposure: loud\n    sessionId: s'],
    ['an unreachable entry', 'version: 1\ndevice: a\npairings:\n  - alias: x\n    peer: b\n    exposure: debug'],
    ['a bad alias', 'version: 1\ndevice: a\npairings:\n  - alias: "x:y"\n    peer: b\n    exposure: debug\n    sessionId: s'],
    ['a repeated alias and peer', 'version: 1\ndevice: a\npairings:\n  - alias: x\n    peer: b\n    exposure: debug\n    sessionId: s\n  - alias: x\n    peer: b\n    exposure: debug\n    sessionId: t'],
    ['a non-positive ceiling', 'version: 1\ndevice: a\npairings:\n  - alias: x\n    peer: b\n    exposure: debug\n    sessionId: s\n    runawayCeiling: 0'],
  ])('rejects %s', (_label, yaml) => {
    expect(() => parsePairingsDocument(yaml, '/tmp/pairings.yaml')).toThrow(PeerConfigError)
  })
})

describe('pairing store', () => {
  it('treats an absent pairing file as no pairings', () => {
    const root = tempRoot()
    const store = new PeerPairingsStore(join(root, 'pairings.yaml'), join(root, 'peer-state.json'))
    expect(store.load().pairings).toEqual([])
  })

  it('resolves alias and explicit sessions, including persisted bindings', async () => {
    const root = tempRoot()
    const pairingsPath = join(root, 'pairings.yaml')
    const bindingsPath = join(root, 'peer-state.json')
    write(pairingsPath, `
version: 1
device: serverlocal
pairings:
  - alias: bound
    peer: laptop
    exposure: answer-only
    create:
      cwd: ${root}
  - alias: fixed
    peer: desktop
    exposure: debug
    sessionId: sess-fixed
`)
    const store = new PeerPairingsStore(pairingsPath, bindingsPath)
    expect(store.resolve({ kind: 'alias', alias: 'bound' as never })).toBeUndefined()
    await store.bind('bound' as never, 'laptop', 'sess-bound' as never)
    const bound = store.resolve({ kind: 'session', sessionId: 'sess-bound' as never })
    expect(bound?.pairing.alias).toBe('bound')
    expect(bound?.exposure).toBe('answer-only')
    const byAlias = store.resolve({ kind: 'alias', alias: 'bound' as never })
    expect(byAlias?.sessionId).toBe('sess-bound')
    expect(store.exposed('sess-fixed' as never)?.exposure).toBe('debug')
    expect(store.exposed('sess-other' as never)).toBeUndefined()
    expect(statSync(bindingsPath).mode & 0o777).toBe(0o600)
  })

  it('reloads a changed pairing file and keeps the last good snapshot on corruption', async () => {
    const root = tempRoot()
    const pairingsPath = join(root, 'pairings.yaml')
    const store = new PeerPairingsStore(pairingsPath, join(root, 'peer-state.json'))
    write(pairingsPath, 'version: 1\ndevice: a\npairings: []')
    expect(store.device()).toBe('a')
    await new Promise(resolve => setTimeout(resolve, 10))
    write(pairingsPath, 'version: 1\ndevice: b\npairings: []')
    expect(store.device()).toBe('b')
    await new Promise(resolve => setTimeout(resolve, 10))
    write(pairingsPath, 'version: 1\ndevice: c\npairings:\n  - alias: x')
    expect(store.device()).toBe('b')
  })

  it('rejects a corrupt bindings document', async () => {
    const root = tempRoot()
    const pairingsPath = join(root, 'pairings.yaml')
    write(pairingsPath, 'version: 1\ndevice: a\npairings: []')
    write(join(root, 'peer-state.json'), '{"version": 2, "bindings": {}}')
    const store = new PeerPairingsStore(pairingsPath, join(root, 'peer-state.json'))
    expect(() => store.load()).toThrow(PeerConfigError)
  })
})
