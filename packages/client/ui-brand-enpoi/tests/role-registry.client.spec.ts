// @vitest-environment jsdom
/**
 * Role-registry store and pure helpers: the settings-backed `roles` map
 * overlays the shipped code defaults, a null server entry deletes a role, and
 * the store primes from `settings.describe` and re-reads pushed changes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/** One `settings.describe` envelope carrying the enpoi-orchestration namespace. */
function describeResponse(value: unknown, revision = 1): Response {
  return new Response(JSON.stringify({
    result: { ok: true, value: { namespaces: [{ ns: 'enpoi-orchestration', revision, value }] } },
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

  it('hides seat:false roles, groups registry council roles, and ungroups unknown persona ids', async () => {
    const { buildFleetCategories, fleetSeatState, mergeRoleRegistry } = await import('../src/client/role-registry.ts')
    const registry = mergeRoleRegistry({
      ghost: { label: 'Ghost', seat: false },
      muse: { label: 'The Muse', group: 'council' },
    })
    const categories = buildFleetCategories(registry, ['keeper', 'unknown-role'], [])
    const seats = categories.flatMap(category => category.seats.map(seat => seat.id))

    expect(seats).not.toContain('ghost')
    expect(seats).toContain('muse')
    expect(seats).toContain('keeper')
    expect(seats).toContain('unknown-role')
    const keeper = categories.find(category => category.key === 'supervision')?.seats.find(seat => seat.id === 'keeper')
    expect(keeper?.name).toBe('Context Keeper')
    // The keeper cannot inherit a conversation model: its label names the route.
    expect(keeper?.defaultLabel).toBe('built-in default: freellmapi/auto')
    expect(keeper?.defaultKind).toBe('builtin-default')
    expect(fleetSeatState(null, keeper!)).toBe('builtin-default')
    expect(fleetSeatState(undefined, keeper!)).toBe('builtin-default')
    // An explicit model is the only thing that counts as assigned.
    expect(fleetSeatState({ provider: 'freellmapi', model: 'auto' }, keeper!)).toBe('assigned')
    expect(fleetSeatState({ provider: 'freellmapi', model: '' }, keeper!)).toBe('builtin-default')
    // A registry role declared with group `council` keeps the shared group;
    // a persona-only id no registry claims lands in Ungrouped.
    expect(categories.find(category => category.key === 'council')?.seats.map(seat => seat.id)).toEqual(['muse'])
    expect(categories.find(category => category.key === 'ungrouped')?.seats.map(seat => seat.id)).toEqual(['unknown-role'])
  })

  it('renders the designated compaction seat before any assignment', async () => {
    const { buildFleetCategories, fleetSeatState, mergeRoleRegistry } = await import('../src/client/role-registry.ts')
    const categories = buildFleetCategories(mergeRoleRegistry(undefined), [], [])
    const compaction = categories.find(category => category.key === 'supervision')
      ?.seats.find(seat => seat.id === 'compaction')

    expect(compaction?.name).toBe('Compaction Summariser')
    expect(compaction?.defaultLabel).toBe('Inherit')
    expect(compaction?.defaultKind).toBe('inherit')
    expect(compaction?.defaultHint).toContain('prefix cache')
    expect(fleetSeatState(null, compaction!)).toBe('inherit')
    // A cleared assignment keeps its fleet row.
    expect(buildFleetCategories(mergeRoleRegistry(undefined), ['compaction'], [])
      .flatMap(category => category.seats.map(seat => seat.id))).toContain('compaction')
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
    const seats = buildFleetCategories(registry, [], []).flatMap(category => category.seats.map(seat => seat.id))
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

describe('fleet council grouping', () => {
  /** The live two-council shape: distinct seats, both served by the same arbiters. */
  const LIVE_COUNCILS = [
    {
      id: 'roundtable',
      label: 'Architecture Roundtable',
      seats: [
        { id: 'skeptic', label: 'Skeptic' },
        { id: 'architect', label: 'Architect' },
        { id: 'pragmatist', label: 'Pragmatist' },
      ],
      arbiters: ['referee', 'chair'],
    },
    {
      id: 'chorus',
      label: 'Idea Chorus',
      seats: [
        { id: 'visionary', label: 'Visionary' },
        { id: 'experiencer', label: 'Experiencer' },
        { id: 'integrator', label: 'Integrator' },
      ],
      arbiters: ['referee', 'chair'],
    },
  ]

  it('renders one group per council and one shared arbiter group, in registry order', async () => {
    const { buildFleetCategories, mergeRoleRegistry } = await import('../src/client/role-registry.ts')
    const categories = buildFleetCategories(
      mergeRoleRegistry(undefined),
      ['skeptic', 'architect', 'pragmatist', 'visionary', 'experiencer', 'integrator', 'referee', 'chair'],
      LIVE_COUNCILS,
    )

    expect(categories.map(category => category.title)).toEqual([
      'BACKGROUND & SUPERVISION',
      'SPECIALIST WORKERS',
      'Architecture Roundtable',
      'Idea Chorus',
      'COUNCIL',
    ])
    expect(categories.map(category => category.key)).toEqual([
      'supervision',
      'specialists',
      'council:roundtable',
      'council:chorus',
      'council',
    ])
    expect(categories.find(category => category.key === 'council:roundtable')?.seats.map(seat => seat.id))
      .toEqual(['skeptic', 'architect', 'pragmatist'])
    expect(categories.find(category => category.key === 'council:chorus')?.seats.map(seat => seat.id))
      .toEqual(['visionary', 'experiencer', 'integrator'])
    // Both councils share the same arbiters; each renders once, in the shared
    // group, in the declaration's order.
    expect(categories.find(category => category.key === 'council')?.seats.map(seat => seat.id))
      .toEqual(['referee', 'chair'])
  })

  it('keeps a legacy council persona row in the shared group with no council registry', async () => {
    const { buildFleetCategories, mergeRoleRegistry } = await import('../src/client/role-registry.ts')
    const categories = buildFleetCategories(mergeRoleRegistry(undefined), ['chair'], [])

    // A leftover arbiter row survives on its persona key alone.
    expect(categories.find(category => category.key === 'council')?.seats.map(seat => seat.id)).toEqual(['chair'])
  })

  it('renders declared arbiters from the council registry with no persona row at all', async () => {
    const { buildFleetCategories, fleetSeatState, mergeRoleRegistry } = await import('../src/client/role-registry.ts')
    const categories = buildFleetCategories(mergeRoleRegistry(undefined), [], LIVE_COUNCILS)
    const shared = categories.find(category => category.key === 'council')

    // The declaration itself owns the rows: a clear/refresh can never drop them.
    expect(shared?.seats.map(seat => seat.id)).toEqual(['referee', 'chair'])
    expect(shared?.seats.find(seat => seat.id === 'referee')?.name).toBe('Referee')
    expect(fleetSeatState(null, shared!.seats[0]!)).toBe('inherit')
    // A hidden arbiter stays hidden.
    const hidden = buildFleetCategories(mergeRoleRegistry({ referee: { seat: false } }), [], LIVE_COUNCILS)
    expect(hidden.flatMap(category => category.seats.map(seat => seat.id))).not.toContain('referee')
  })

  it('gives a newly registered council its own group with no code change', async () => {
    const { buildFleetCategories, mergeRoleRegistry } = await import('../src/client/role-registry.ts')
    const categories = buildFleetCategories(mergeRoleRegistry(undefined), ['ops-auditor'], [
      ...LIVE_COUNCILS,
      { id: 'ops-review', label: 'Ops Review', seats: [{ id: 'ops-auditor', label: 'Ops Auditor' }], arbiters: [] },
    ])

    expect(categories.map(category => category.title)).toContain('Ops Review')
    expect(categories.find(category => category.key === 'council:ops-review')?.seats.map(seat => seat.id))
      .toEqual(['ops-auditor'])
    // Council seats render with no persona assignment at all, under their own label.
    expect(categories.find(category => category.key === 'council:roundtable')?.seats.map(seat => seat.id))
      .toEqual(['skeptic', 'architect', 'pragmatist'])
  })

  it('renders a seat two councils list exactly once, under the first council', async () => {
    const { buildFleetCategories, mergeRoleRegistry } = await import('../src/client/role-registry.ts')
    const categories = buildFleetCategories(mergeRoleRegistry(undefined), ['shared-seat'], [
      { id: 'alpha', label: 'Alpha Council', seats: [{ id: 'shared-seat', label: 'Shared Seat' }] },
      { id: 'beta', label: 'Beta Council', seats: [{ id: 'shared-seat', label: 'Shared Seat' }, { id: 'beta-only', label: 'Beta Only' }] },
    ])

    const ids = categories.flatMap(category => category.seats.map(seat => seat.id))
    expect(ids.filter(id => id === 'shared-seat')).toHaveLength(1)
    expect(categories.find(category => category.key === 'council:alpha')?.seats.map(seat => seat.id)).toEqual(['shared-seat'])
    expect(categories.find(category => category.key === 'council:beta')?.seats.map(seat => seat.id)).toEqual(['beta-only'])
  })

  it('renders no group for a council with zero seats', async () => {
    const { buildFleetCategories, mergeRoleRegistry } = await import('../src/client/role-registry.ts')
    const categories = buildFleetCategories(mergeRoleRegistry(undefined), [], [
      { id: 'empty', label: 'Empty Council', seats: [], arbiters: [] },
    ])

    expect(categories.map(category => category.key)).not.toContain('council:empty')
    expect(categories.map(category => category.title)).not.toContain('Empty Council')
  })

  it('groups a persona-only seat its council claims and ungroups one nothing claims', async () => {
    const { buildFleetCategories, mergeRoleRegistry } = await import('../src/client/role-registry.ts')
    const categories = buildFleetCategories(mergeRoleRegistry(undefined), ['ops-auditor', 'stray-seat'], [
      { id: 'ops-review', label: 'Ops Review', seats: [{ id: 'ops-auditor', label: 'Ops Auditor' }] },
    ])

    expect(categories.find(category => category.key === 'council:ops-review')?.seats.map(seat => seat.id))
      .toEqual(['ops-auditor'])
    expect(categories.find(category => category.key === 'ungrouped')?.seats.map(seat => seat.id))
      .toEqual(['stray-seat'])
  })

  it('routes a registry arbiter into the shared group, ungroups no seats, and falls back to the id title', async () => {
    const { buildFleetCategories, mergeRoleRegistry } = await import('../src/client/role-registry.ts')
    const registry = mergeRoleRegistry({ chair: { label: 'Chair' }, scribe: {} })
    const categories = buildFleetCategories(registry, [], [
      // No label and a malformed seat/arbiter: the id titles the group, blanks are dropped.
      { id: 'ops-review', seats: [{ id: 'ops-auditor' }, { id: '' }], arbiters: ['chair', ''] },
      // No seats array and no label: no group, no crash.
      { id: 'silent' },
    ])

    expect(categories.find(category => category.key === 'council')?.seats.map(seat => seat.id)).toEqual(['chair'])
    expect(categories.find(category => category.key === 'custom')?.seats.map(seat => seat.id)).toEqual(['scribe'])
    expect(categories.find(category => category.key === 'council:ops-review')).toEqual({
      key: 'council:ops-review',
      title: 'Ops Review',
      seats: [expect.objectContaining({ id: 'ops-auditor' })],
    })
    expect(categories.map(category => category.key)).not.toContain('council:silent')
  })

  it('hides a seat the operator marked seat:false even when a council lists it', async () => {
    const { buildFleetCategories, mergeRoleRegistry } = await import('../src/client/role-registry.ts')
    const registry = mergeRoleRegistry({ skeptic: { seat: false } })
    const categories = buildFleetCategories(registry, [], LIVE_COUNCILS)

    expect(categories.find(category => category.key === 'council:roundtable')?.seats.map(seat => seat.id))
      .toEqual(['architect', 'pragmatist'])
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
    // The pushed change carries a bumped namespace revision; a same-revision
    // read is the unchanged document and must not notify.
    fetchMock.mockImplementation(async () => describeResponse({ roles: { muse: null, oracle: { label: 'Oracle Prime' } } }, 2))
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
