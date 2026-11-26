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
  '    tokenHash: sha256$0000000000000000000000000000000000000000000000000000000000000000',
  '    outboundToken: outbound-secret-co-dev',
  '    runawayCeiling: null',
  '    allowModelChange: false',
  '    create:',
  '      cwd: /home/user/projects/thing',
  '      agentPreset: standard',
  '      allowAgentPresets: [standard, sysadmin]',
  '      provider: antigravity',
  '      model: gemini-3.8-flash-tiered',
  '      chain: loopback',
  '      reasoningEffort: high',
  '  - alias: caller-only',
  '    peer: macbook',
  '    exposure: answer-only',
  '    endpoint: https://macbook.tail:8443',
  '    inboundToken: inbound-secret-caller-only',
  '    create:',
  '      agentPreset: standard',
  '      allowAgentPresets:',
  '        - standard',
  '        - orchestrator',
  '  - alias: host-only',
  '    peer: desktop',
  '    exposure: debug',
  '    insecure: true',
  '    sessionId: sess-host',
  '',
].join('\n')

describe('pairing document parser', () => {
  it('parses entries, outboundToken, nested create defaults, comments, and ignores host credential fields', () => {
    const parsed = parsePairingDocument(DOCUMENT, 'test.yaml')
    expect(parsed.device).toBe('serverlocal')
    expect(parsed.pairings).toHaveLength(3)
    const coDev = parsed.pairings[0]!
    expect(coDev.alias).toBe('co-dev')
    expect(coDev.endpoint).toBe('https://laptop.pike-acrux.ts.net:8443')
    expect(coDev.remoteSessionId).toBe('sess-xyz')
    expect(coDev.outboundToken).toBe('outbound-secret-co-dev')
    expect('tokenHash' in coDev).toBe(false)
    expect('inboundToken' in coDev).toBe(false)
    expect('insecure' in coDev).toBe(false)
    expect(coDev.runawayCeiling).toBeUndefined()
    expect(coDev.create).toMatchObject({ cwd: '/home/user/projects/thing', agentPreset: 'standard' })
    expect(coDev.createRouting).toEqual({
      provider: 'antigravity',
      model: 'gemini-3.8-flash-tiered',
      chain: 'loopback',
      reasoningEffort: 'high',
    })
    const callerOnly = parsed.pairings[1]!
    expect(callerOnly.outboundToken).toBeUndefined()
    expect('inboundToken' in callerOnly).toBe(false)
    expect(callerOnly.create?.allowAgentPresets).toEqual(['standard', 'orchestrator'])
    const hostOnly = parsed.pairings[2]!
    expect('insecure' in hostOnly).toBe(false)
  })

  it('rejects the legacy token key naming outboundToken and never echoes its secret', () => {
    const secret = 'legacy-secret-must-not-leak'
    for (const raw of [
      `version: 1\ndevice: x\npairings:\n  - alias: pc\n    peer: serverlocal\n    endpoint: https://x\n    token: ${secret}\n`,
      'version: 1\ndevice: x\npairings:\n  - alias: pc\n    peer: serverlocal\n    endpoint: https://x\n    token: null\n',
    ]) {
      let caught: unknown
      try {
        parsePairingDocument(raw, 't')
      } catch (error) {
        caught = error
      }
      expect(caught).toBeInstanceOf(PairingDocumentError)
      expect((caught as Error).message).toContain('outboundToken')
      expect((caught as Error).message).toContain('ambiguous key "token"')
      expect((caught as Error).message).not.toContain(secret)
    }
  })

  it('rejects malformed outboundToken without echoing its value', () => {
    const raw = 'version: 1\ndevice: x\npairings:\n  - alias: pc\n    peer: serverlocal\n    endpoint: https://x\n    outboundToken: ""\n'
    expect(() => parsePairingDocument(raw, 't')).toThrowError(/outboundToken must be a non-empty string/u)
  })

  it('rejects a create routing half-pair as a malformed pairing', () => {
    const partial = 'version: 1\ndevice: x\npairings:\n  - alias: pc\n    peer: serverlocal\n    endpoint: https://x\n    create:\n      provider: antigravity\n'
    expect(() => parsePairingDocument(partial, 't'))
      .toThrowError(/create\.provider and create\.model must be provided together/u)
    const flipped = 'version: 1\ndevice: x\npairings:\n  - alias: pc\n    peer: serverlocal\n    endpoint: https://x\n    create:\n      model: gemini-3.8-flash-tiered\n'
    expect(() => parsePairingDocument(flipped, 't'))
      .toThrowError(/create\.provider and create\.model must be provided together/u)
  })

  it('leaves createRouting absent without a provider/model pair and ignores lone qualifiers', () => {
    const parsed = parsePairingDocument(DOCUMENT, 'test.yaml')
    // caller-only has no create block at all.
    expect(parsed.pairings[1]!.createRouting).toBeUndefined()
    const qualifiersOnly = 'version: 1\ndevice: x\npairings:\n  - alias: pc\n    peer: serverlocal\n    endpoint: https://x\n    create:\n      chain: loopback\n      reasoningEffort: high\n'
    expect(parsePairingDocument(qualifiersOnly, 't').pairings[0]!.createRouting).toBeUndefined()
  })

  it('rejects a non-string create routing field when the pair is present', () => {
    const wrongType = 'version: 1\ndevice: x\npairings:\n  - alias: pc\n    peer: serverlocal\n    endpoint: https://x\n    create:\n      provider: antigravity\n      model: 42\n'
    expect(() => parsePairingDocument(wrongType, 't'))
      .toThrowError(/create\.model must be a non-empty string when present/u)
  })

  it('resolves only dialable caller-role entries', () => {
    const parsed = parsePairingDocument(DOCUMENT, 'test.yaml')
    expect(callerPairings(parsed).map(entry => entry.alias)).toEqual(['co-dev', 'caller-only'])
    expect(resolveCallerPairing(parsed, 'caller-only').endpoint).toBe('https://macbook.tail:8443')
    expect(resolveCallerPairing(parsed, 'co-dev').create).toMatchObject({ agentPreset: 'standard' })
  })

  it('fails loud on an unknown alias, naming each available alias and its target device', () => {
    const parsed = parsePairingDocument(DOCUMENT, 'test.yaml')
    // The alias names the pairing, not the target host: the caller-role alias
    // is the same string on both devices, so each entry reports its peer.
    expect(() => resolveCallerPairing(parsed, 'host-only'))
      .toThrowError('no caller-role pairing with alias "host-only"; available: co-dev → laptop, caller-only → macbook')
    expect(() => resolveCallerPairing(parsed, 'missing'))
      .toThrowError('no caller-role pairing with alias "missing"; available: co-dev → laptop, caller-only → macbook')
    expect(() => resolveCallerPairing(parsed, 'missing')).toThrowError(PairingDocumentError)
  })

  it('names the missing-entry reason when no caller-role entry is dialable', () => {
    const parsed = parsePairingDocument('version: 1\ndevice: x\npairings:\n  - alias: host-only\n    peer: desktop\n', 't')
    expect(() => resolveCallerPairing(parsed, 'pc'))
      .toThrowError('no caller-role pairing with alias "pc"; no caller-role entries (an entry needs `endpoint` and `peer`)')
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
