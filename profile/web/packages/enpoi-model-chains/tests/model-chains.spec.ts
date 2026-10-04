import { describe, expect, it, vi, afterEach } from 'vitest'
import { ModelChainsResolver, parseChainEntry, readRawChains } from '../src/index.ts'

/**
 * enpoi-model-chains resolver specs — dependency-light: the resolver reads a
 * plain mutable map, so no Cordis context or settings service is needed, and
 * the ctx seam itself is exercised through {@link readRawChains} with a
 * one-method fake.
 */

function makeResolver(initial: Record<string, unknown>) {
  const doc: { chains: Record<string, unknown> } = { chains: { ...initial } }
  const readRaw = () => doc.chains
  return { doc, resolver: new ModelChainsResolver(readRaw) }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('enpoi-model-chains parseChainEntry', () => {
  it('parses a valid chain into a frozen snapshot with trimmed values', () => {
    const chain = parseChainEntry('stable', {
      label: ' Stable ',
      links: [
        { provider: ' antigravity ', model: 'gemini-3.8-flash-tiered' },
        { provider: 'opencode-go', model: 'mimo-v2.5', effort: ' high ' },
      ],
      attempts: 2.7,
      onCut: 'continue',
    }, () => {})
    expect(chain).toBeDefined()
    expect(chain!.id).toBe('stable')
    expect(chain!.label).toBe('Stable')
    expect(chain!.links).toHaveLength(2)
    expect(chain!.links[0]).toEqual({ provider: 'antigravity', model: 'gemini-3.8-flash-tiered' })
    expect(chain!.links[1]).toEqual({ provider: 'opencode-go', model: 'mimo-v2.5', effort: 'high' })
    expect(chain!.attempts).toBe(2)
    expect(chain!.onCut).toBe('continue')
    // Every level is frozen: a consumer snapshot can never be edited in place.
    expect(Object.isFrozen(chain)).toBe(true)
    expect(Object.isFrozen(chain!.links)).toBe(true)
    expect(Object.isFrozen(chain!.links[0])).toBe(true)
  })

  it('treats a non-string or blank effort as absent and keeps the link', () => {
    const chain = parseChainEntry('efforts', {
      links: [
        { provider: 'p1', model: 'm1', effort: 7 },
        { provider: 'p2', model: 'm2', effort: '   ' },
        { provider: 'p3', model: 'm3', effort: 'max' },
      ],
    }, () => {})
    // Absence is the only "no effort" spelling: the link stays usable and the
    // adapter is left to resolve its own default, as if effort were undeclared.
    expect(chain!.links).toEqual([
      { provider: 'p1', model: 'm1' },
      { provider: 'p2', model: 'm2' },
      { provider: 'p3', model: 'm3', effort: 'max' },
    ])
  })

  it('drops malformed links (empty provider/model) and keeps the valid ones', () => {
    const warn = vi.fn()
    const chain = parseChainEntry('mixed', {
      links: [
        { provider: '', model: 'm' },
        { provider: 'p', model: '   ' },
        'not-an-object',
        { provider: 'p2', model: 'm2' },
      ],
    }, warn)
    expect(chain!.links).toEqual([{ provider: 'p2', model: 'm2' }])
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]![0])).toContain('dropped 3 malformed link(s)')
  })

  it('answers undefined for disabled, link-less, and non-object entries', () => {
    const warn = vi.fn()
    expect(parseChainEntry('off', { disabled: true, links: [{ provider: 'p', model: 'm' }] }, warn)).toBeUndefined()
    expect(parseChainEntry('empty', { links: [] }, warn)).toBeUndefined()
    expect(parseChainEntry('shape', { label: 'x' }, warn)).toBeUndefined()
    expect(parseChainEntry('string', 'nope', warn)).toBeUndefined()
    expect(parseChainEntry('missing', undefined, warn)).toBeUndefined()
    // disabled never warns; the others do.
    expect(warn).toHaveBeenCalledTimes(3)
  })

  it('omits attempts/onCut when undeclared and invalid values are ignored', () => {
    const chain = parseChainEntry('plain', { links: [{ provider: 'p', model: 'm' }], attempts: 0, onCut: 'weird' }, () => {})
    expect(chain).toEqual({ id: 'plain', links: [{ provider: 'p', model: 'm' }] })
  })
})

describe('enpoi-model-chains ModelChainsResolver', () => {
  it('resolves a valid id and caches the same frozen snapshot', () => {
    const { resolver } = makeResolver({ stable: { links: [{ provider: 'p', model: 'm' }] } })
    const first = resolver.resolve('stable')
    const second = resolver.resolve('stable')
    expect(first).toBeDefined()
    expect(second).toBe(first)
    expect(Object.isFrozen(first)).toBe(true)
  })

  it('answers undefined for a dangling id without throwing', () => {
    const { resolver } = makeResolver({ stable: { links: [{ provider: 'p', model: 'm' }] } })
    expect(resolver.resolve('does-not-exist')).toBeUndefined()
    expect(resolver.resolve('')).toBeUndefined()
  })

  it('answers undefined for a disabled id (callers fail open)', () => {
    const { resolver } = makeResolver({
      retired: { disabled: true, links: [{ provider: 'p', model: 'm' }] },
    })
    expect(resolver.resolve('retired')).toBeUndefined()
  })

  it('warns once per malformed id across repeated resolves', () => {
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const { resolver } = makeResolver({ broken: { links: [{ provider: '', model: '' }] } })
    resolver.resolve('broken')
    resolver.resolve('broken')
    resolver.resolve('broken')
    const warnings = write.mock.calls.map(call => String(call[0])).filter(line => line.includes('chain "broken"'))
    expect(warnings).toHaveLength(1)
  })

  it('keeps the handed-out snapshot frozen when settings change (no live re-read)', () => {
    const { doc, resolver } = makeResolver({
      stable: { links: [{ provider: 'p1', model: 'm1' }] },
    })
    const snapshot = resolver.resolve('stable')!
    // Operator edits the document while a caller holds the snapshot.
    doc.chains.stable = { links: [{ provider: 'p2', model: 'm2' }] }
    // Without a refresh event the resolver keeps serving the cached snapshot.
    expect(resolver.resolve('stable')).toBe(snapshot)
    expect(snapshot.links[0]).toEqual({ provider: 'p1', model: 'm1' })
    // A settings/document-updated refresh applies to the NEXT resolution only.
    resolver.refresh()
    const fresh = resolver.resolve('stable')!
    expect(fresh).not.toBe(snapshot)
    expect(fresh.links[0]).toEqual({ provider: 'p2', model: 'm2' })
    // The old snapshot is untouched — a mid-turn caller keeps a consistent chain.
    expect(snapshot.links[0]).toEqual({ provider: 'p1', model: 'm1' })
  })

  it('picks up a newly added chain after refresh and drops a removed one', () => {
    const { doc, resolver } = makeResolver({})
    expect(resolver.resolve('stable')).toBeUndefined()
    doc.chains.stable = { links: [{ provider: 'p', model: 'm' }] }
    expect(resolver.resolve('stable')).toBeUndefined()   // no live read
    resolver.refresh()
    expect(resolver.resolve('stable')!.links).toHaveLength(1)
    delete doc.chains.stable
    resolver.refresh()
    expect(resolver.resolve('stable')).toBeUndefined()
  })
})

describe('enpoi-model-chains readRawChains (ctx seam)', () => {
  it('reads chains through settings.get("enpoi-orchestration")', () => {
    const ctx = {
      get: (ns: string) => ns === 'settings'
        ? { get: () => ({ chains: { stable: { links: [{ provider: 'p', model: 'm' }] } } }) }
        : undefined,
    }
    expect(Object.keys(readRawChains(ctx as never))).toEqual(['stable'])
  })

  it('fails open to an empty map for missing/malformed documents', () => {
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    expect(readRawChains({ get: () => undefined } as never)).toEqual({})
    expect(readRawChains({ get: () => ({ get: () => ({ chains: 'nope' }) }) } as never)).toEqual({})
    expect(readRawChains({ get: () => { throw new Error('settings down') } } as never)).toEqual({})
    expect(write).toHaveBeenCalled()
  })
})

describe('enpoi-model-chains mount (apply)', () => {
  it('provides the modelChains facade, refreshes on the namespace event, and logs the mount line', async () => {
    const { apply } = await import('../src/index.ts')
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const listeners = new Map<string, (ns: unknown) => void>()
    let provided: { resolve?: (id: string) => unknown } | undefined
    const doc: { chains: Record<string, unknown> } = { chains: {} }
    const ctx = {
      get: (ns: string) => ns === 'settings' ? { get: () => doc } : undefined,
      provide: (serviceName: string, value: { resolve?: (id: string) => unknown }) => {
        expect(serviceName).toBe('modelChains')
        provided = value
        return () => undefined
      },
      on: (event: string, callback: (ns: unknown) => void) => {
        listeners.set(event, callback)
        return () => undefined
      },
    }
    apply(ctx as never)
    expect(provided).toBeDefined()
    expect(write.mock.calls.map(call => String(call[0]))).toContain('[enpoi-model-chains] mounted\n')

    // Detached-method call must work (no `this` dependence).
    const { resolve } = provided!
    expect(resolve!('stable')).toBeUndefined()

    doc.chains.stable = { links: [{ provider: 'p', model: 'm' }] }
    // The resolver caches until the namespace change event arrives.
    expect(resolve!('stable')).toBeUndefined()
    expect(listeners.has('settings/document-updated')).toBe(true)
    listeners.get('settings/document-updated')!('enpoi-orchestration')
    expect(resolve!('stable')).toMatchObject({ id: 'stable', links: [{ provider: 'p', model: 'm' }] })
    // Other namespaces are ignored.
    doc.chains.stable = { disabled: true }
    listeners.get('settings/document-updated')!('some-other-ns')
    expect(resolve!('stable')).toBeDefined()
    listeners.get('settings/document-updated')!('enpoi-orchestration')
    expect(resolve!('stable')).toBeUndefined()
    vi.restoreAllMocks()
  })
})
