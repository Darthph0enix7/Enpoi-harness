// @vitest-environment jsdom
/**
 * Role-registry store and pure helpers: the settings-backed `roles` map
 * overlays the shipped code defaults, a null server entry deletes a role, and
 * the store primes from `settings.describe` and re-reads pushed changes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/** One `settings.describe` envelope carrying the enpoi-orchestration namespace. */
function describeResponse(value: unknown): Response {
  return new Response(JSON.stringify({
    result: { ok: true, value: { namespaces: [{ ns: 'enpoi-orchestration', revision: 1, value }] } },
  }), { status: 200 })
}

beforeEach(() => {
  vi.resetModules()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
})

describe('role registry helpers', () => {
  it('merges settings roles over the shipped defaults and deletes a null role', async () => {
    const { mergeRoleRegistry, BUILT_IN_ROLES } = await import('../src/client/role-registry.ts')
    const server = {
      muse: { label: 'The Muse', group: 'council' },
      oracle: { label: 'Oracle Prime' },
      fixer: null,
      junk: 'nope',
    } as unknown as Parameters<typeof mergeRoleRegistry>[0]
    const merged = mergeRoleRegistry(server)

    expect(merged.muse?.label).toBe('The Muse')
    expect(merged.oracle?.label).toBe('Oracle Prime')
    expect(merged.fixer).toBeUndefined()
    expect(merged.junk).toBeUndefined()
    expect(merged.librarian).toEqual(BUILT_IN_ROLES.librarian)
    // No server map = the shipped defaults.
    expect(mergeRoleRegistry(undefined)).toEqual({ ...BUILT_IN_ROLES })
  })

  it('coerces a raw wire map, normalizing ids and dropping malformed entries', async () => {
    const { coerceRoleRegistry } = await import('../src/client/role-registry.ts')
    const coerced = coerceRoleRegistry({
      Muse: { label: 'The Muse', group: 'council', seat: false, tools: { available: ['read', 3] }, junk: 1 },
      ' the-scribe ': { persona: 'writes' },
      broken: 'nope',
      list: [],
      gone: null,
    })

    expect(Object.keys(coerced).sort()).toEqual(['muse', 'the-scribe'])
    expect(coerced.muse).toEqual({ label: 'The Muse', group: 'council', seat: false, tools: { available: ['read', '3'] } })
    expect(coerced['the-scribe']).toEqual({ persona: 'writes' })
    expect(coerceRoleRegistry('nope')).toEqual({})
    expect(coerceRoleRegistry(null)).toEqual({})
    expect(coerceRoleRegistry([])).toEqual({})
  })

  it('hides seat:false roles and appends persona-only ids to their shipped group', async () => {
    const { buildFleetCategories, mergeRoleRegistry } = await import('../src/client/role-registry.ts')
    const registry = mergeRoleRegistry({
      ghost: { label: 'Ghost', seat: false },
      muse: { label: 'The Muse', group: 'council' },
    })
    const categories = buildFleetCategories(registry, ['keeper', 'unknown-role'])
    const seats = categories.flatMap(category => category.seats.map(seat => seat.id))

    expect(seats).not.toContain('ghost')
    expect(seats).toContain('muse')
    expect(seats).toContain('keeper')
    expect(seats).toContain('unknown-role')
    const keeper = categories.find(category => category.group === 'supervision')?.seats.find(seat => seat.id === 'keeper')
    expect(keeper?.name).toBe('Context Keeper')
    expect(keeper?.defaultLabel).toBe('Default')
    expect(categories.find(category => category.group === 'custom')?.seats.map(seat => seat.id)).toEqual(['unknown-role'])
  })

  it('retires a role with disabled:true — built-in and user-defined alike', async () => {
    const { buildFleetCategories, mergeRoleRegistry } = await import('../src/client/role-registry.ts')
    const registry = mergeRoleRegistry({
      designer: { disabled: true },
      ghost: { label: 'Ghost', disabled: true },
    })
    expect(registry['designer']).toBeUndefined()
    expect(registry['ghost']).toBeUndefined()
    expect(registry['librarian']).toBeDefined()
    const seats = buildFleetCategories(registry, []).flatMap(category => category.seats.map(seat => seat.id))
    expect(seats).not.toContain('designer')
    expect(seats).not.toContain('ghost')
  })

  it('labels a role with the registry label, else the title-cased id', async () => {
    const { registryRoleLabel, normalizeRoleId, titleCaseRoleId } = await import('../src/client/role-registry.ts')
    const registry = { muse: { label: 'The Muse' }, 'the-scribe': {}, blank: { label: '' } }
    expect(registryRoleLabel(registry, 'muse')).toBe('The Muse')
    expect(registryRoleLabel(registry, 'the-scribe')).toBe('The Scribe')
    expect(registryRoleLabel(registry, 'blank')).toBe('Blank')
    expect(normalizeRoleId('  The Muse ')).toBe('muse')
    expect(titleCaseRoleId('my_role')).toBe('My Role')
  })
})

describe('role registry store', () => {
  it('primes from settings on import and re-reads pushed changes', async () => {
    const fetchMock = vi.fn(async () => describeResponse({
      roles: { muse: { label: 'The Muse', group: 'council', tools: { available: ['read'] } } },
    }))
    vi.stubGlobal('fetch', fetchMock)
    const store = await import('../src/client/role-registry.ts')
    await vi.waitFor(() => {
      expect(store.getRoleRegistry().muse?.label).toBe('The Muse')
    })
    expect(store.getRoleRegistry().oracle?.label).toBe('The Oracle')

    const listener = vi.fn()
    const unsubscribe = store.subscribeRoleRegistry(listener)
    fetchMock.mockImplementation(async () => describeResponse({ roles: { muse: null, oracle: { label: 'Oracle Prime' } } }))
    await store.refreshFromServer()

    expect(store.getRoleRegistry().muse).toBeUndefined()
    expect(store.getRoleRegistry().oracle?.label).toBe('Oracle Prime')
    expect(listener).toHaveBeenCalled()
    unsubscribe()
  })

  it('keeps the shipped defaults when the gateway is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('offline', { status: 500 })))
    const store = await import('../src/client/role-registry.ts')
    await store.refreshFromServer()
    expect(store.getRoleRegistry().librarian).toEqual(store.BUILT_IN_ROLES.librarian)
  })

  it('keeps the last snapshot when the read throws', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('offline') }))
    const store = await import('../src/client/role-registry.ts')
    store.primeRoleRegistry()
    await store.refreshFromServer()
    expect(store.getRoleRegistry().designer).toBeDefined()
  })
})
