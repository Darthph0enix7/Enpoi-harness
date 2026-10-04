import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  callerPairings,
  defaultPairingsPath,
  loadCallerPairing,
  PairingDocumentError,
  parsePairingDocument,
  readPairingDocument,
  resolveCallerPairing,
} from '../src/pairings.ts'

const DOCUMENT = [
  '# shared pairing document',
  'version: 1',
  'device: serverlocal',
  'watchdogMs: 900000',
  'pairings:',
  '  - alias: co-dev          # caller + host role in one entry',
  '    peer: laptop',
  '    exposure: debug',
  '    sessionId: sess-abc',
  '    remoteSessionId: sess-xyz',
  '    endpoint: "https://laptop.pike-acrux.ts.net:8443"',
  '    token: null',
  '    runawayCeiling: null',
  '    allowModelChange: false',
  '    create:',
  '      cwd: /home/user/projects/thing',
  '      agentPreset: standard',
  '  - alias: caller-only',
  '    peer: macbook',
  '    exposure: answer-only',
  '    endpoint: https://macbook.tail:8443',
  '  - alias: host-only',
  '    peer: desktop',
  '    exposure: debug',
  '    sessionId: sess-host',
  '',
].join('\n')

describe('pairing document parser', () => {
  it('parses entries, nested create defaults, comments, and quoted URLs', () => {
    const parsed = parsePairingDocument(DOCUMENT, 'test.yaml')
    expect(parsed.device).toBe('serverlocal')
    expect(parsed.pairings).toHaveLength(3)
    const coDev = parsed.pairings[0]!
    expect(coDev.alias).toBe('co-dev')
    expect(coDev.endpoint).toBe('https://laptop.pike-acrux.ts.net:8443')
    expect(coDev.remoteSessionId).toBe('sess-xyz')
    expect(coDev.token).toBeUndefined()
    expect(coDev.runawayCeiling).toBeUndefined()
    expect(coDev.create).toMatchObject({ cwd: '/home/user/projects/thing', agentPreset: 'standard' })
  })

  it('resolves only dialable caller-role entries', () => {
    const parsed = parsePairingDocument(DOCUMENT, 'test.yaml')
    expect(callerPairings(parsed).map(entry => entry.alias)).toEqual(['co-dev', 'caller-only'])
    expect(resolveCallerPairing(parsed, 'caller-only').endpoint).toBe('https://macbook.tail:8443')
    expect(resolveCallerPairing(parsed, 'co-dev').create).toMatchObject({ agentPreset: 'standard' })
  })

  it('fails loud when the alias is not dialable and names the available aliases', () => {
    const parsed = parsePairingDocument(DOCUMENT, 'test.yaml')
    expect(() => resolveCallerPairing(parsed, 'host-only')).toThrowError(/available: co-dev, caller-only/u)
    expect(() => resolveCallerPairing(parsed, 'missing')).toThrowError(PairingDocumentError)
  })

  it('rejects bad version, aliases, endpoints, and trailing content', () => {
    expect(() => parsePairingDocument('version: 2\ndevice: x\npairings: []\n', 't')).toThrowError(/version: 1/u)
    expect(() => parsePairingDocument('version: 1\ndevice: x\npairings:\n  - alias: "bad:alias"\n    peer: p\n', 't')).toThrowError(/alias must match/u)
    expect(() => parsePairingDocument('version: 1\ndevice: x\npairings:\n  - alias: a\n    peer: p\n    endpoint: ftp://x\n', 't')).toThrowError(/http\(s\) URL/u)
    expect(parsePairingDocument('version: 1\ndevice: x\npairings: []\n', 't').pairings).toEqual([])
    expect(() => parsePairingDocument('version: 1\ndevice: x\npairings: []\n  stray: 1\n', 't')).toThrowError(/trailing content/u)
    expect(() => parsePairingDocument('', 't')).toThrowError(/is empty/u)
  })

  it('reads from disk and defaults the path under DSH_HOME', () => {
    const dir = mkdtempSync(join(tmpdir(), 'peer-bridge-pairings-'))
    const path = join(dir, 'pairings.yaml')
    writeFileSync(path, DOCUMENT)
    expect(loadCallerPairing(path, 'co-dev').pairing.peer).toBe('laptop')
    expect(readPairingDocument(path).pairings).toHaveLength(3)
    expect(defaultPairingsPath({ DSH_HOME: '/x/.dsh' })).toBe('/x/.dsh/pairings.yaml')
    expect(() => readPairingDocument(join(dir, 'missing.yaml'))).toThrowError(/could not be read/u)
  })
})
