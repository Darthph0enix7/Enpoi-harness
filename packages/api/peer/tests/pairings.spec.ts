import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
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
    inboundToken: test-secret-token
    outboundToken: test-outbound-token
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
    expect('inboundToken' in pairing).toBe(false)
    expect(pairing.tokenHash).toMatch(/^scrypt\$/u)
    expect(pairing.outboundToken).toBe('test-outbound-token')
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
    ['a repeated alias across peers', 'version: 1\ndevice: a\npairings:\n  - alias: x\n    peer: b\n    exposure: debug\n    sessionId: s\n  - alias: x\n    peer: c\n    exposure: debug\n    sessionId: t'],
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
    insecure: true
    create:
      cwd: ${root}
  - alias: fixed
    peer: desktop
    exposure: debug
    insecure: true
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

  it('resolves a caller-pinned remoteSessionId to the pairing session it names', async () => {
    const root = tempRoot()
    const pairingsPath = join(root, 'pairings.yaml')
    write(pairingsPath, `
version: 1
device: serverlocal
pairings:
  - alias: pinned
    peer: laptop
    exposure: debug
    insecure: true
    sessionId: sess-local
    remoteSessionId: sess-pin
  - alias: created
    peer: desktop
    exposure: debug
    insecure: true
    remoteSessionId: sess-bound-pin
    create:
      cwd: ${root}
`)
    const store = new PeerPairingsStore(pairingsPath, join(root, 'peer-state.json'))
    const resolved = store.resolve({ kind: 'session', sessionId: 'sess-pin' as never })
    expect(resolved?.pairing.alias).toBe('pinned')
    expect(resolved?.sessionId).toBe('sess-local')
    // A pin with no own session resolves through the created binding.
    await store.bind('created' as never, 'desktop', 'sess-created' as never)
    expect(store.resolve({ kind: 'session', sessionId: 'sess-bound-pin' as never })?.sessionId).toBe('sess-created')
    // An undeclared pin grants nothing.
    expect(store.resolve({ kind: 'session', sessionId: 'sess-unknown' as never })).toBeUndefined()
  })

  it('keeps a rebound alias previous session page-able by explicit id', async () => {
    const root = tempRoot()
    const pairingsPath = join(root, 'pairings.yaml')
    const bindingsPath = join(root, 'peer-state.json')
    write(pairingsPath, `
version: 1
device: serverlocal
pairings:
  - alias: bound
    peer: laptop
    exposure: debug
    insecure: true
    create:
      cwd: ${root}
`)
    const store = new PeerPairingsStore(pairingsPath, bindingsPath)
    await store.bind('bound' as never, 'laptop', 'sess-first' as never)
    await store.bind('bound' as never, 'laptop', 'sess-second' as never)

    // The alias resolves to the newest session; the replaced one stays
    // addressable by explicit id through the same pairing.
    expect(store.resolve({ kind: 'alias', alias: 'bound' as never })?.sessionId).toBe('sess-second')
    const retired = store.resolve({ kind: 'session', sessionId: 'sess-first' as never })
    expect(retired?.pairing.alias).toBe('bound')
    expect(retired?.sessionId).toBe('sess-first')

    // History survives a restart: the bindings document is the only memory.
    const restarted = new PeerPairingsStore(pairingsPath, bindingsPath)
    expect(restarted.resolve({ kind: 'session', sessionId: 'sess-first' as never })?.pairing.alias).toBe('bound')
    expect(restarted.resolve({ kind: 'session', sessionId: 'sess-second' as never })?.pairing.alias).toBe('bound')

    // Re-adopting the same session is not a rebind: the history does not grow.
    await store.bind('bound' as never, 'laptop', 'sess-second' as never)
    const file = JSON.parse(readFileSync(bindingsPath, 'utf8')) as {
      bindings: Record<string, { retired?: unknown[] }>
    }
    expect(file.bindings.bound?.retired).toHaveLength(1)
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

  it('parses a routing policy and round-trips it through load', () => {
    const root = tempRoot()
    const pairingsPath = join(root, 'pairings.yaml')
    write(pairingsPath, `
version: 1
device: serverlocal
pairings:
  - alias: routed
    peer: laptop
    exposure: answer-only
    insecure: true
    create:
      cwd: ${root}
    routing:
      allowChains: [free]
      allowModels: ["kilo/*:free", "openrouter/*:free"]
      requireZeroPrice: true
      requireNoTraining: true
      requireTools: true
      allowReasoningEfforts: [minimal, medium]
      allowSwitch: idle-only
      maxTotalTokens: 5000
`)
    const store = new PeerPairingsStore(pairingsPath, join(root, 'peer-state.json'))
    const routing = store.load().pairings[0]?.routing
    expect(routing).toEqual({
      allowChains: ['free'],
      allowModels: ['kilo/*:free', 'openrouter/*:free'],
      requireZeroPrice: true,
      requireNoTraining: true,
      requireTools: true,
      allowReasoningEfforts: ['minimal', 'medium'],
      allowSwitch: 'idle-only',
      maxTotalTokens: 5000,
    })
    // An absent policy stays absent: no silent default.
    write(pairingsPath, 'version: 1\ndevice: serverlocal\npairings:\n  - alias: plain\n    peer: laptop\n    exposure: debug\n    insecure: true\n    sessionId: s')
    expect(new PeerPairingsStore(pairingsPath, join(root, 'peer-state.json')).load().pairings[0]?.routing)
      .toBeUndefined()
  })

  it.each([
    ['a non-mapping routing policy', 'routing: 42'],
    ['an unknown routing key', 'routing:\n      allowChain: [free]'],
    ['a non-list allowModels', 'routing:\n      allowModels: scripted/*'],
    ['an empty pattern', 'routing:\n      allowModels: [""]'],
    ['a pattern outside the routing charset', 'routing:\n      allowModels: ["kilo free"]'],
    ['a non-list reasoning effort list', 'routing:\n      allowReasoningEfforts: minimal'],
    ['an unknown allowSwitch value', 'routing:\n      allowSwitch: always'],
    ['a zero token ceiling', 'routing:\n      maxTotalTokens: 0'],
    ['a fractional token ceiling', 'routing:\n      maxTotalTokens: 1.5'],
    ['a non-boolean price guard', 'routing:\n      requireZeroPrice: "yes"'],
    ['a non-boolean tools guard', 'routing:\n      requireTools: "yes"'],
  ])('rejects a routing policy with %s', (_label, block) => {
    const root = tempRoot()
    const pairingsPath = join(root, 'pairings.yaml')
    write(pairingsPath, `
version: 1
device: serverlocal
pairings:
  - alias: routed
    peer: laptop
    exposure: debug
    insecure: true
    create:
      cwd: ${root}
    ${block.replace(/\n/gu, '\n    ')}
`)
    expect(() => parsePairingsDocument(readFileSync(pairingsPath, 'utf8'), pairingsPath)).toThrow(PeerConfigError)
  })

  it.each([
    ['a mistyped routing key at the pairing level', 'routng:\n      allowChains: [free]'],
    ['an unknown pairing key', 'exposur: debug'],
    ['an unknown create key', 'create:\n      cwd: /tmp\n      agentPrset: x'],
  ])('rejects %s instead of silently dropping it', (_label, block) => {
    const root = tempRoot()
    const pairingsPath = join(root, 'pairings.yaml')
    write(pairingsPath, `
version: 1
device: serverlocal
pairings:
  - alias: typo
    peer: laptop
    exposure: debug
    insecure: true
    sessionId: sess-typo
    ${block.replace(/\n/gu, '\n    ')}
`)
    expect(() => parsePairingsDocument(readFileSync(pairingsPath, 'utf8'), pairingsPath)).toThrow(/unknown key/u)
  })

  it('serves the cached snapshot without re-reading the pairing file', async () => {
    const root = tempRoot()
    const pairingsPath = join(root, 'pairings.yaml')
    const bindingsPath = join(root, 'peer-state.json')
    write(pairingsPath, 'version: 1\ndevice: a\npairings: []')
    const store = new PeerPairingsStore(pairingsPath, bindingsPath)
    // Before the first load the accessor pays for one load, then the cached
    // snapshot is stable until a bind republishes it.
    const first = store.current()
    expect(store.current()).toBe(first)
    await store.bind('bound' as never, 'laptop', 'sess-current' as never, { maxTotalTokens: 25 })
    const next = store.current()
    expect(next).not.toBe(first)
    expect(next.bindings.bound?.maxTotalTokens).toBe(25)
    expect(store.current()).toBe(next)
  })

  it('reads and writes a per-binding token ceiling without breaking older documents', async () => {
    const root = tempRoot()
    const pairingsPath = join(root, 'pairings.yaml')
    const bindingsPath = join(root, 'peer-state.json')
    write(pairingsPath, 'version: 1\ndevice: a\npairings: []')
    // A document written before the ceiling field loads unchanged.
    write(bindingsPath, JSON.stringify({
      version: 1,
      bindings: { old: { sessionId: 'sess-old', device: 'laptop', createdAt: 1 } },
    }))
    const store = new PeerPairingsStore(pairingsPath, bindingsPath)
    expect(store.ceilingOf('sess-old' as never)).toBeUndefined()
    await store.bind('bound' as never, 'laptop', 'sess-first' as never, { maxTotalTokens: 900 })
    expect(store.ceilingOf('sess-first' as never)).toBe(900)
    // Re-adopting the same session without a value keeps the recorded ceiling.
    await store.bind('bound' as never, 'laptop', 'sess-first' as never)
    expect(store.ceilingOf('sess-first' as never)).toBe(900)
    // A rebind retires the session with its ceiling still readable.
    await store.bind('bound' as never, 'laptop', 'sess-second' as never, { maxTotalTokens: 100 })
    expect(store.ceilingOf('sess-second' as never)).toBe(100)
    expect(store.ceilingOf('sess-first' as never)).toBe(900)
    expect(store.ceilingOf('sess-unknown' as never)).toBeUndefined()
    const restarted = new PeerPairingsStore(pairingsPath, bindingsPath)
    expect(restarted.ceilingOf('sess-first' as never)).toBe(900)
    const file = JSON.parse(readFileSync(bindingsPath, 'utf8')) as {
      bindings: Record<string, { maxTotalTokens?: number; retired?: { sessionId: string; maxTotalTokens?: number }[] }>
    }
    expect(file.bindings.bound?.maxTotalTokens).toBe(100)
    expect(file.bindings.bound?.retired?.[0]).toMatchObject({ sessionId: 'sess-first', maxTotalTokens: 900 })
    // A malformed ceiling is a configuration error, not a silently dropped guard.
    write(bindingsPath, JSON.stringify({
      version: 1,
      bindings: { bound: { sessionId: 's', device: 'laptop', createdAt: 1, maxTotalTokens: -1 } },
    }))
    expect(() => new PeerPairingsStore(pairingsPath, bindingsPath).load()).toThrow(PeerConfigError)
  })

  it('rejects a malformed retired-binding entry', () => {
    const root = tempRoot()
    const pairingsPath = join(root, 'pairings.yaml')
    write(pairingsPath, 'version: 1\ndevice: a\npairings: []')
    write(join(root, 'peer-state.json'), JSON.stringify({
      version: 1,
      bindings: {
        bound: {
          sessionId: 'sess-current',
          device: 'laptop',
          createdAt: 1,
          retired: [{ sessionId: 'sess-old' }],
        },
      },
    }))
    const store = new PeerPairingsStore(pairingsPath, join(root, 'peer-state.json'))
    expect(() => store.load()).toThrow(PeerConfigError)
  })
})

describe('pairing store reload diagnostics', () => {
  const GOOD = 'version: 1\ndevice: a\npairings: []'

  it('warns once per distinct rejected reload without echoing file contents', async () => {
    const root = tempRoot()
    const pairingsPath = join(root, 'pairings.yaml')
    write(pairingsPath, GOOD)
    const warnings: string[] = []
    const store = new PeerPairingsStore(pairingsPath, join(root, 'peer-state.json'), {
      onConfigError: (message) => { warnings.push(message) },
    })
    expect(store.load().device).toBe('a')
    // A YAML syntax error can carry a parser code frame; only the first line,
    // which names the fault and position, may reach the sink.
    write(pairingsPath, 'version: 1\ndevice: a\npairings:\n  - alias: [unclosed\n    peer: secret-value')
    expect(store.load().device).toBe('a')
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatch(/^peer pairings .* is not valid YAML:/u)
    expect(warnings[0]).not.toContain('secret-value')
    expect(warnings[0]).not.toContain('\n')
    // The same bad document growing in size retries the reload; the repeated
    // diagnostic is suppressed rather than logged again.
    write(pairingsPath, `version: 1\ndevice: a\npairings:\n  - alias: [unclosed\n    peer: secret-value\n# ${'x'.repeat(64)}`)
    expect(store.load().device).toBe('a')
    expect(warnings).toHaveLength(1)
    // A distinct rejection is worth one warning of its own.
    write(pairingsPath, 'version: 1\ndevice: a\npairings:\n  - alias: "bad alias"\n    peer: b\n    exposure: debug\n    sessionId: s')
    expect(store.load().device).toBe('a')
    expect(warnings).toHaveLength(2)
    expect(warnings[1]).toMatch(/alias must match/u)
  })

  it('reports at most sixteen distinct diagnostics for the store lifetime', async () => {
    const root = tempRoot()
    const pairingsPath = join(root, 'pairings.yaml')
    write(pairingsPath, GOOD)
    const warnings: string[] = []
    const store = new PeerPairingsStore(pairingsPath, join(root, 'peer-state.json'), {
      onConfigError: (message) => { warnings.push(message) },
    })
    store.load()
    for (let index = 0; index < 20; index += 1) {
      write(pairingsPath, `version: 1\ndevice: a\npairings:\n  - alias: "bad ${String(index)}"\n    peer: b\n    exposure: debug\n    sessionId: s`)
      expect(store.load().device).toBe('a')
    }
    expect(warnings).toHaveLength(16)
    expect(new Set(warnings).size).toBe(16)
  })

  it('still fails loud on the first load and tolerates a store without a sink', async () => {
    const root = tempRoot()
    const pairingsPath = join(root, 'pairings.yaml')
    const warnings: string[] = []
    write(pairingsPath, 'version: 2\ndevice: a\npairings: []')
    expect(() => new PeerPairingsStore(pairingsPath, join(root, 'peer-state.json'), {
      onConfigError: (message) => { warnings.push(message) },
    }).load()).toThrow(PeerConfigError)
    expect(warnings).toEqual([])
    // A subsequent reload without a sink keeps the snapshot and stays silent.
    write(pairingsPath, GOOD)
    const silent = new PeerPairingsStore(pairingsPath, join(root, 'peer-state.json'))
    silent.load()
    write(pairingsPath, 'version: 2\ndevice: a\npairings: []')
    expect(silent.load().device).toBe('a')
  })
})

describe('pairing credentials and create limits (P-01 / P-05)', () => {
  it('loads unauthenticated-legacy entries without credentials and warns once per alias', () => {
    const root = tempRoot()
    const pairingsPath = join(root, 'pairings.yaml')
    writeFileSync(pairingsPath, `
version: 1
device: serverlocal
pairings:
  - alias: pc
    peer: pc
    exposure: debug
    endpoint: http://100.98.71.68:3080
    create:
      agentPreset: orchestrator
  - alias: macbook
    peer: macbook
    exposure: answer-only
    endpoint: http://100.97.227.64:3080
    outboundToken: outbound-only-secret
    create:
      agentPreset: orchestrator
`, { mode: 0o600 })
    const warnings: string[] = []
    const store = new PeerPairingsStore(pairingsPath, join(root, 'peer-state.json'), {
      onWarning: (message) => { warnings.push(message) },
    })
    const loaded = store.load()
    expect(loaded.pairings).toHaveLength(2)
    expect(loaded.pairings.find(p => p.alias === 'pc')).toMatchObject({
      alias: 'pc',
      peer: 'pc',
      endpoint: 'http://100.98.71.68:3080',
    })
    expect(loaded.pairings.find(p => p.alias === 'macbook')?.outboundToken).toBe('outbound-only-secret')
    expect(warnings).toHaveLength(2)
    expect(warnings.some(w => w.includes('pc') && w.includes('tokenHash') && w.includes('inboundToken'))).toBe(true)
    expect(warnings.some(w => w.includes('macbook') && w.includes('tokenHash') && w.includes('inboundToken'))).toBe(true)
    // Second load hits cache and does not re-warn; warnings never echo outboundToken.
    store.load()
    expect(warnings).toHaveLength(2)
    expect(warnings.join('\n')).not.toContain('outbound-only-secret')
  })

  it('rejects contradictory, ambiguous, or malformed credential fields without leaking plaintext tokens', () => {
    const secret = 'super-secret-pairing-token-12345'
    expect(() => parsePairingsDocument(`
version: 1
device: serverlocal
pairings:
  - alias: both
    peer: laptop
    exposure: debug
    sessionId: sess-1
    inboundToken: ${secret}
    tokenHash: sha256$0000000000000000000000000000000000000000000000000000000000000000
`, '/tmp/pairings.yaml')).toThrow(PeerConfigError)

    expect(() => parsePairingsDocument(`
version: 1
device: serverlocal
pairings:
  - alias: insecure-with-token
    peer: laptop
    exposure: debug
    sessionId: sess-1
    insecure: true
    inboundToken: ${secret}
`, '/tmp/pairings.yaml')).toThrow(PeerConfigError)

    expect(() => parsePairingsDocument(`
version: 1
device: serverlocal
pairings:
  - alias: ambiguous-token
    peer: laptop
    exposure: debug
    sessionId: sess-1
    token: ${secret}
`, '/tmp/pairings.yaml')).toThrow(PeerConfigError)

    try {
      parsePairingsDocument(`
version: 1
device: serverlocal
pairings:
  - alias: bad-hash
    peer: laptop
    exposure: debug
    sessionId: sess-1
    tokenHash: not-a-valid-hash
`, '/tmp/pairings.yaml')
      expect.unreachable('malformed tokenHash must throw')
    } catch (error) {
      expect(error).toBeInstanceOf(PeerConfigError)
      expect((error as Error).message).not.toContain('not-a-valid-hash')
    }
  })

  it('hashes inboundToken at load, keeps outboundToken, warns on insecure and world-readable mode', () => {
    const root = tempRoot()
    const pairingsPath = join(root, 'pairings.yaml')
    const inboundSecret = 'my-inbound-secret-token'
    const outboundSecret = 'my-outbound-secret-token'
    writeFileSync(pairingsPath, `
version: 1
device: serverlocal
pairings:
  - alias: hashed
    peer: laptop
    exposure: debug
    sessionId: sess-1
    inboundToken: ${inboundSecret}
    outboundToken: ${outboundSecret}
  - alias: opt-out
    peer: desktop
    exposure: answer-only
    sessionId: sess-2
    insecure: true
`, { mode: 0o644 })
    const warnings: string[] = []
    const store = new PeerPairingsStore(pairingsPath, join(root, 'peer-state.json'), {
      onWarning: (message) => { warnings.push(message) },
    })
    const loaded = store.load()
    const hashed = loaded.pairings.find(p => p.alias === 'hashed')
    expect(hashed).toBeDefined()
    expect('inboundToken' in (hashed ?? {})).toBe(false)
    expect('token' in (hashed ?? {})).toBe(false)
    expect(typeof hashed?.tokenHash).toBe('string')
    expect(String(hashed?.tokenHash)).toMatch(/^scrypt\$/u)
    expect(hashed?.outboundToken).toBe(outboundSecret)
    expect(JSON.stringify(loaded)).not.toContain(inboundSecret)
    // Warns once for `insecure: true` and once for group/world-readable file mode with outboundToken.
    expect(warnings).toHaveLength(2)
    expect(warnings.some(w => w.includes('opt-out') && w.includes('insecure'))).toBe(true)
    expect(warnings.some(w => w.includes('0600') && !w.includes(outboundSecret))).toBe(true)
    // Second load hits cache and does not re-warn.
    store.load()
    expect(warnings).toHaveLength(2)
  })

  it('rejects create.agentPreset outside create.allowAgentPresets', () => {
    expect(() => parsePairingsDocument(`
version: 1
device: serverlocal
pairings:
  - alias: limited
    peer: laptop
    exposure: debug
    insecure: true
    create:
      agentPreset: creator
      allowAgentPresets: [orchestrator, sysadmin]
`, '/tmp/pairings.yaml')).toThrow(PeerConfigError)
  })

  it('parses create.freshOnly and worker policy strictly and rejects unknown keys or invalid bounds', () => {
    const doc = parsePairingsDocument(`
version: 1
device: serverlocal
pairings:
  - alias: worker
    peer: hub
    exposure: answer-only
    insecure: true
    create:
      freshOnly: true
      agentPreset: worker-ro
    worker:
      allowedCapabilities: [read, search]
      maxLimits:
        maxSteps: 10
        maxToolCalls: 25
        maxWallMs: 60000
        maxTotalTokens: 40000
      allowedMcpEndpoints: [jarvis-hub]
      allowedToolNames: [read, grep]
`, '/tmp/pairings.yaml')
    expect(doc.pairings[0]?.create?.freshOnly).toBe(true)
    expect(doc.pairings[0]?.worker).toEqual({
      allowedCapabilities: ['read', 'search'],
      maxLimits: { maxSteps: 10, maxToolCalls: 25, maxWallMs: 60_000, maxTotalTokens: 40_000 },
      allowedMcpEndpoints: ['jarvis-hub'],
      allowedToolNames: ['read', 'grep'],
    })

    for (const bad of [
      'create:\n      freshOnly: "yes"',
      'create:\n      fresh_only: true',
      'worker: 42',
      'worker:\n      unknownKey: []',
      'worker:\n      maxLimits:\n        maxSteps: 0',
      'worker:\n      maxLimits:\n        unknownLimit: 10',
      'worker:\n      allowedCapabilities: [""]',
    ]) {
      expect(() => parsePairingsDocument(`
version: 1
device: serverlocal
pairings:
  - alias: worker
    peer: hub
    exposure: answer-only
    insecure: true
    ${bad.includes('create:') ? bad : `create:\n      freshOnly: true\n    ${bad}`}
`, '/tmp/pairings.yaml')).toThrow(PeerConfigError)
    }
  })
})
