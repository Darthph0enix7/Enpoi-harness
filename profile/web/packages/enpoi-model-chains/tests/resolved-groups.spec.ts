import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ModelChainsResolver, RESOLVED_GROUPS_ARTIFACT, type SelectorExpander,
} from '../src/index.ts'

/**
 * Resolved-group artifact specs: the projection every client surface renders
 * from. It must carry the explicit links, the selector expansion, the resolved
 * members, held-back candidates, warnings, and the retire switch, and it must
 * be a pure projection — publishing it never changes what `resolve()` answers.
 */

/** One resolver over a mutable chain document plus a mutable catalogue. */
function makeResolver(
  initial: Record<string, unknown>,
  links: Array<{ provider: string; model: string }>,
) {
  const doc: { chains: Record<string, unknown> } = { chains: { ...initial } }
  const catalogue = { links }
  const expander: SelectorExpander = () => ({ links: catalogue.links })
  const resolver = new ModelChainsResolver(() => doc.chains, { expandSelector: expander, warn: () => {} })
  return { doc, catalogue, resolver }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('resolvedGroups projection', () => {
  it('carries explicit links, selector matches, candidates, and warnings', () => {
    const { resolver } = makeResolver({
      mixed: {
        label: 'Mixed',
        links: [{ provider: 'p', model: 'explicit' }],
        selectors: [
          { when: { kind: 'free' }, adopt: false, label: 'free' },
        ],
        attempts: 3,
        onCut: 'continue',
      },
    }, [{ provider: 'groq', model: 'free-tool' }])

    const groups = resolver.resolvedGroups()
    expect(Object.keys(groups)).toEqual(['mixed'])
    expect(groups['mixed']).toEqual({
      id: 'mixed',
      label: 'Mixed',
      links: [{ provider: 'p', model: 'explicit' }],
      selectors: [{ when: { kind: 'free' }, adopt: false, label: 'free' }],
      selectorMatches: [{
        index: 0,
        when: { kind: 'free' },
        adopt: false,
        label: 'free',
        links: [{ provider: 'groq', model: 'free-tool' }],
        warnings: [],
      }],
      members: [
        { provider: 'p', model: 'explicit' },
        { provider: 'groq', model: 'free-tool' },
      ],
      candidates: [],
      warnings: [],
      attempts: 3,
      onCut: 'continue',
      disabled: false,
      source: 'settings',
    })
  })

  it('resolves a selector-only group without any explicit link', () => {
    const { resolver } = makeResolver(
      { free: { label: 'Free', selectors: [{ when: { zeroPrice: true } }] } },
      [{ provider: 'groq', model: 'free-tool' }],
    )
    const group = resolver.resolvedGroups()['free']!
    expect(group.links).toEqual([])
    expect(group.members).toEqual([{ provider: 'groq', model: 'free-tool' }])
    expect(group.source).toBe('settings')
    // The runtime resolves the same group, so a picker assignment works.
    expect(resolver.resolve('free')!.links).toEqual([{ provider: 'groq', model: 'free-tool' }])
  })

  it('keeps a held-back match as a candidate once adoption is baselined', () => {
    const { resolver, catalogue } = makeResolver(
      { free: { selectors: [{ when: { zeroPrice: true }, adopt: false }] } },
      [{ provider: 'groq', model: 'one' }],
    )
    // The projection is evaluated before any resolve: it adopts everything it
    // sees but records no baseline, so the first resolve still baselines.
    expect(resolver.resolvedGroups()['free']!.members).toHaveLength(1)
    expect(resolver.resolvedGroups()['free']!.candidates).toEqual([])
    resolver.resolve('free')

    catalogue.links.push({ provider: 'groq', model: 'two' })
    resolver.invalidateResolvedGroups()
    const group = resolver.resolvedGroups()['free']!
    expect(group.members.map(link => link.model)).toEqual(['one'])
    expect(group.candidates.map(link => link.model)).toEqual(['two'])
    expect(group.warnings.some(line => line.includes('awaiting adoption'))).toBe(true)
    // Preview agrees with the artifact.
    expect(resolver.preview('free')!.candidates.map(link => link.model)).toEqual(['two'])
  })

  it('includes disabled groups and keeps them unresolvable', () => {
    const { resolver } = makeResolver({
      retired: { label: 'Retired', disabled: true, links: [{ provider: 'p', model: 'm' }] },
    }, [])
    const group = resolver.resolvedGroups()['retired']!
    expect(group.disabled).toBe(true)
    expect(group.members).toEqual([{ provider: 'p', model: 'm' }])
    expect(resolver.resolve('retired')).toBeUndefined()
  })

  it('drops unusable entries from the projection', () => {
    const { resolver } = makeResolver({
      broken: { links: 'nope' },
      empty: { links: [], selectors: [] },
      stable: { links: [{ provider: 'p', model: 'm' }] },
    }, [])
    expect(Object.keys(resolver.resolvedGroups())).toEqual(['stable'])
  })

  it('surfaces a selector warning instead of silently emptying the group', () => {
    const { resolver } = makeResolver({
      free: { links: [{ provider: 'p', model: 'm' }], selectors: [{ when: { ghost: true } }] },
    }, [])
    const group = resolver.resolvedGroups()['free']!
    expect(group.selectorMatches[0]!.links).toEqual([])
    expect(group.members).toEqual([{ provider: 'p', model: 'm' }])
  })
})

describe('resolvedGroups publication (apply)', () => {
  /** Mount the plugin with a mutable document and a scripted catalogue. */
  async function mount() {
    const { apply } = await import('../src/index.ts')
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const listeners = new Map<string, (ns: unknown) => void>()
    const doc: { chains: Record<string, unknown> } = {
      chains: {
        free: {
          label: 'Free',
          selectors: [{ when: { zeroPrice: true }, adopt: false }],
          attempts: 2,
        },
      },
    }
    const catalogue = { links: [{ provider: 'groq', model: 'free-tool' }] }
    const artifacts: Array<{ key: string; value: unknown }> = []
    let provided: { resolve?: (id: string) => unknown; preview?: (id: string) => unknown } | undefined
    const settings = {
      get: (ns: string) => ns === 'enpoi-orchestration' ? doc : undefined,
      publishArtifact: (key: string, value: unknown) => {
        artifacts.push({ key, value })
        return artifacts.length
      },
    }
    const ctx = {
      get: (ns: string) => ns === 'settings'
        ? settings
        : ns === 'catalogRules'
          ? { expandRawSelector: () => ({ links: catalogue.links }) }
          : undefined,
      provide: (name: string, value: { resolve?: (id: string) => unknown; preview?: (id: string) => unknown }) => {
        expect(name).toBe('modelChains')
        provided = value
        return () => undefined
      },
      on: (event: string, callback: (ns: unknown) => void) => {
        listeners.set(event, callback)
        return () => undefined
      },
    }
    apply(ctx as never)
    return { artifacts, catalogue, doc, listeners, provided: provided! }
  }

  it('publishes the projection on mount, on settings change, and on resolve', async () => {
    const { artifacts, catalogue, doc, listeners, provided } = await mount()
    expect(artifacts).toHaveLength(1)
    expect(artifacts[0]!.key).toBe(RESOLVED_GROUPS_ARTIFACT)
    const first = artifacts[0]!.value as Record<string, Record<string, unknown>>
    expect(first['free']).toMatchObject({
      id: 'free',
      links: [],
      members: [{ provider: 'groq', model: 'free-tool' }],
      disabled: false,
      source: 'settings',
    })

    // A resolve republishes the memoized projection (the host dedupes by value).
    provided.resolve!('free')
    expect(artifacts).toHaveLength(2)
    expect(artifacts[1]!.key).toBe(RESOLVED_GROUPS_ARTIFACT)
    expect(artifacts[1]!.value).toEqual(artifacts[0]!.value)

    // A catalogue change (no document write) republishes the held-back match
    // as a candidate: the projection never re-baselines on its own.
    catalogue.links = [{ provider: 'groq', model: 'free-tool' }, { provider: 'groq', model: 'free-tools-pro' }]
    listeners.get('settings/document-updated')!('llm-pi-ai')
    await Promise.resolve()
    expect(artifacts).toHaveLength(3)
    const second = artifacts[2]!.value as Record<string, Record<string, unknown>>
    expect((second['free']!.members as unknown[])).toHaveLength(1)
    expect((second['free']!.candidates as unknown[])).toHaveLength(1)

    // A settings edit (rename) reaches the artifact on the namespace event.
    doc.chains.free = { ...(doc.chains.free as object), label: 'Free forever' }
    listeners.get('settings/document-updated')!('enpoi-orchestration')
    expect(artifacts).toHaveLength(4)
    const third = artifacts[3]!.value as Record<string, Record<string, unknown>>
    expect(third['free']!.label).toBe('Free forever')
  })
})
