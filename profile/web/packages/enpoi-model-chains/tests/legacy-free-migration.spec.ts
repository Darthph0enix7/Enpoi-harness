import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  apply, builtinChainsOf, isRetiredFreeRow, LEGACY_FREE_MIGRATION,
  ModelChainsResolver, type SelectorExpander,
} from '../src/index.ts'

/**
 * Legacy free-row migration specs: the retired static `chains.free` row
 * (six `opencode/*-free` links, `disabled: true`) shadows the shipped built-in,
 * so an untouched copy is ignored for resolution and the built-in answers
 * marked `migratedFrom: 'legacy-free'`. Nothing is written: the document keeps
 * the row, every deviation restores the operator's row, and Customize writes a
 * real row that wins outright.
 */

/** What the shipped free selector answers in these specs. */
const SHIPPED_MEMBERS = [
  { provider: 'groq', model: 'free-tool' },
  { provider: 'google', model: 'gemini-free' },
]

/** The retired row's links, as the fork shipped them. */
const RETIRED_LINKS = [
  { provider: 'opencode', model: 'ling-3.0-flash-fin-free' },
  { provider: 'opencode', model: 'kimi-k2-free' },
  { provider: 'opencode', model: 'qwen3-coder-free' },
  { provider: 'opencode', model: 'glm-4.6-free' },
  { provider: 'opencode', model: 'minimax-m2-free' },
  { provider: 'opencode', model: 'deepseek-v4-flash-free' },
]

/** The retired row exactly as the retired install carries it. */
const RETIRED_ROW = {
  label: 'Free',
  links: RETIRED_LINKS,
  attempts: 2,
  onCut: 'failover',
  disabled: true,
}

/** One resolver over a mutable document and a scripted selector expansion. */
function makeResolver(initial: Record<string, unknown>) {
  const doc: { chains: Record<string, unknown> } = { chains: { ...initial } }
  const expander: SelectorExpander = () => ({ links: SHIPPED_MEMBERS })
  const resolver = new ModelChainsResolver(() => doc.chains, {
    expandSelector: expander,
    builtinChains: builtinChainsOf(undefined),
    warn: () => {},
  })
  return { doc, resolver }
}

/** Mount the plugin over a fake settings channel that records every write attempt. */
function mount(initial: Record<string, unknown>) {
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  const doc: { chains: Record<string, unknown> } = { chains: structuredClone(initial) }
  const artifacts: Array<{ key: string; value: unknown }> = []
  const writes = {
    mutate: vi.fn(),
    update: vi.fn(),
    replace: vi.fn(),
  }
  const settings = {
    get: (ns: string) => ns === 'enpoi-orchestration' ? doc : undefined,
    mutate: writes.mutate,
    update: writes.update,
    replace: writes.replace,
    publishArtifact: (key: string, value: unknown) => {
      artifacts.push({ key, value })
      return artifacts.length
    },
  }
  const ctx = {
    get: (ns: string) => ns === 'settings'
      ? settings
      : ns === 'catalogRules'
        ? { expandRawSelector: () => ({ links: SHIPPED_MEMBERS }) }
        : undefined,
    provide: () => () => undefined,
    on: () => () => undefined,
  }
  apply(ctx as never)
  return { artifacts, doc, writes }
}

/** Whether a line is the single migration warning for the free group. */
function isMigrationWarning(line: string): boolean {
  return line.includes('retired static free row')
    && line.includes('shipped free group')
    && line.includes('Customize')
    && line.includes('stops the migration')
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('retired free-row fingerprint', () => {
  it('matches only the untouched retired definition', () => {
    expect(isRetiredFreeRow(RETIRED_ROW)).toBe(true)
    // Every operator edit fails the fingerprint.
    expect(isRetiredFreeRow({ ...RETIRED_ROW, disabled: false })).toBe(false)
    expect(isRetiredFreeRow({ ...RETIRED_ROW, disabled: undefined })).toBe(false)
    expect(isRetiredFreeRow({ ...RETIRED_ROW, selectors: [] })).toBe(false)
    expect(isRetiredFreeRow({ ...RETIRED_ROW, label: undefined })).toBe(true)
    expect(isRetiredFreeRow({
      ...RETIRED_ROW,
      links: [...RETIRED_LINKS, { provider: 'groq', model: 'free-tool' }],
    })).toBe(false)
    expect(isRetiredFreeRow({
      ...RETIRED_ROW,
      links: [{ provider: 'opencode', model: 'gpt-6' }],
    })).toBe(false)
    expect(isRetiredFreeRow({ ...RETIRED_ROW, links: [] })).toBe(false)
    // A field the retired row never carried is an operator change.
    expect(isRetiredFreeRow({ ...RETIRED_ROW, note: 'mine' })).toBe(false)
    expect(isRetiredFreeRow({
      ...RETIRED_ROW,
      links: [{ provider: 'opencode', model: 'kimi-k2-free', effort: 'high' }],
    })).toBe(false)
  })
})

describe('legacy free-row migration', () => {
  it('resolves the shipped members and publishes the migration, writing nothing', () => {
    const { artifacts, doc, writes } = mount({ free: RETIRED_ROW })
    const artifact = artifacts[0]!
    expect(artifact.key).toBe('modelChains.resolved')
    const group = (artifact.value as Record<string, Record<string, unknown>>)['free']!
    expect(group.source).toBe('builtin')
    expect(group.migratedFrom).toBe(LEGACY_FREE_MIGRATION)
    expect(group.members).toEqual(SHIPPED_MEMBERS)
    expect(group.disabled).toBe(false)
    expect(group.overridesBuiltin).toBeUndefined()
    const warnings = group.warnings as string[]
    expect(warnings).toHaveLength(1)
    expect(isMigrationWarning(warnings[0]!)).toBe(true)
    // The settings document is untouched: no write of any kind reached it.
    expect(writes.mutate).not.toHaveBeenCalled()
    expect(writes.update).not.toHaveBeenCalled()
    expect(writes.replace).not.toHaveBeenCalled()
    expect(doc.chains.free).toEqual(RETIRED_ROW)
    // Idempotent: a second projection answers the same artifact value.
    expect(artifacts).toHaveLength(1)
  })

  it('resolves the built-in through the service instead of the retired row', () => {
    const { doc, resolver } = makeResolver({ free: RETIRED_ROW })
    expect(resolver.resolve('free')?.links).toEqual(SHIPPED_MEMBERS)
    expect(resolver.preview('free')?.links).toEqual(SHIPPED_MEMBERS)
    expect(doc.chains.free).toEqual(RETIRED_ROW)
    // Repeated resolution is stable (the migration never mutates the row).
    expect(resolver.resolve('free')?.links).toEqual(SHIPPED_MEMBERS)
    expect(doc.chains.free).toEqual(RETIRED_ROW)
  })

  it('leaves an operator row with one extra non-opencode link in charge', () => {
    const row = { ...RETIRED_ROW, links: [...RETIRED_LINKS, { provider: 'groq', model: 'free-tool' }] }
    const { resolver } = makeResolver({ free: row })
    const group = resolver.resolvedGroups()['free']!
    expect(group.source).toBe('settings')
    expect(group.overridesBuiltin).toBe(true)
    expect(group.migratedFrom).toBeUndefined()
    expect(group.warnings).toEqual([])
    expect(group.members).toEqual(row.links)
    // The operator row is disabled, so it never resolves — the built-in does
    // not step in for a row the operator changed.
    expect(group.disabled).toBe(true)
    expect(resolver.resolve('free')).toBeUndefined()
  })

  it('leaves a row with selectors in charge', () => {
    const row = { ...RETIRED_ROW, selectors: [{ when: { zeroPrice: true }, adopt: true }] }
    const { resolver } = makeResolver({ free: row })
    const group = resolver.resolvedGroups()['free']!
    expect(group.source).toBe('settings')
    expect(group.overridesBuiltin).toBe(true)
    expect(group.migratedFrom).toBeUndefined()
    expect(group.links).toEqual(RETIRED_LINKS)
    expect(group.members).toEqual([...RETIRED_LINKS, ...SHIPPED_MEMBERS])
    // The row keeps its retired `disabled: true`, so the operator's row stays
    // retired instead of silently resolving the built-in.
    expect(resolver.resolve('free')).toBeUndefined()
  })

  it('leaves a row with disabled false in charge instead of migrating it', () => {
    const row = { ...RETIRED_ROW, disabled: false }
    const { resolver } = makeResolver({ free: row })
    const group = resolver.resolvedGroups()['free']!
    expect(group.source).toBe('settings')
    expect(group.overridesBuiltin).toBe(true)
    expect(group.migratedFrom).toBeUndefined()
    expect(group.disabled).toBe(false)
    expect(group.members).toEqual(RETIRED_LINKS)
    expect(resolver.resolve('free')?.links).toEqual(RETIRED_LINKS)
  })

  it('stops migrating once a customized row is disabled, and resumes when it is removed', () => {
    const { doc, resolver } = makeResolver({ free: RETIRED_ROW })
    expect(resolver.resolvedGroups()['free']!.migratedFrom).toBe(LEGACY_FREE_MIGRATION)

    // Customize writes a real row; disabling that row must stick.
    doc.chains.free = {
      label: 'Free',
      links: [],
      selectors: [{ when: { zeroPrice: true }, adopt: true }],
      attempts: 2,
      onCut: 'failover',
      disabled: true,
    }
    resolver.refresh()
    const custom = resolver.resolvedGroups()['free']!
    expect(custom.source).toBe('settings')
    expect(custom.overridesBuiltin).toBe(true)
    expect(custom.migratedFrom).toBeUndefined()
    expect(custom.disabled).toBe(true)
    expect(resolver.resolve('free')).toBeUndefined()

    // Deleting the row leaves no row to migrate: the shipped built-in applies
    // plainly (no migration marker), and it resolves.
    delete doc.chains.free
    resolver.refresh()
    expect(resolver.resolvedGroups()['free']).toMatchObject({ source: 'builtin' })
    expect(resolver.resolvedGroups()['free']!.migratedFrom).toBeUndefined()
    expect(resolver.resolve('free')?.links).toEqual(SHIPPED_MEMBERS)

    // Restoring the legacy row migrates again; editing it to disabled false
    // hands control back to the operator immediately.
    doc.chains.free = RETIRED_ROW
    resolver.refresh()
    expect(resolver.resolvedGroups()['free']!.migratedFrom).toBe(LEGACY_FREE_MIGRATION)
    doc.chains.free = { ...RETIRED_ROW, disabled: false }
    resolver.refresh()
    const edited = resolver.resolvedGroups()['free']!
    expect(edited.migratedFrom).toBeUndefined()
    expect(edited.source).toBe('settings')
    expect(resolver.resolve('free')?.links).toEqual(RETIRED_LINKS)
  })
})
