// @vitest-environment jsdom
/**
 * Cross-client live settings sync for the ui-brand-enpoi stores: a pushed
 * server value change reaches the in-memory snapshots, a path with a local
 * write in flight is never clobbered by a refresh, and a conflicted
 * whole-array write re-reads and re-applies onto the fresh value.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

/** One `settings.describe` envelope carrying the enpoi-orchestration namespace. */
function describeResponse(value: unknown, revision: number): Response {
  return new Response(JSON.stringify({
    result: { ok: true, value: { namespaces: [{ ns: 'enpoi-orchestration', revision, value }] } },
  }), { status: 200 })
}

/** One successful `settings.mutate` envelope. */
function mutateOk(): Response {
  return new Response(JSON.stringify({ result: { ok: true, value: { revision: 99 } } }), { status: 200 })
}

/** One stale-revision rejection. */
function mutateConflict(): Response {
  return new Response(JSON.stringify({
    result: { ok: false, error: { code: 'settings/conflict', message: 'stale', details: {} } },
  }), { status: 200 })
}

/** One parsed request body. */
interface MutateBody {
  method: string
  payload: { args: { ns: string; expectedRevision?: number; ops: Array<{ op: string; path: string[]; value?: unknown }> } }
}

/** The parsed `settings.mutate` request bodies, in call order. */
function mutateBodies(fetchMock: ReturnType<typeof vi.fn>): MutateBody[] {
  return fetchMock.mock.calls
    .map(call => JSON.parse(String((call as [string, RequestInit])[1].body)) as MutateBody)
    .filter(body => body.method === 'settings.mutate')
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
})

describe('persona-store live sync', () => {
  it('merges a server persona change pushed after boot', async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const method = (JSON.parse(String(init.body)) as { method: string }).method
      if (method === 'settings.describe') {
        return describeResponse({ personas: { orchestrator: { provider: 'deepseek-official', model: 'deepseek-v3' } } }, 1)
      }
      return mutateOk()
    })
    vi.stubGlobal('fetch', fetchMock)
    const store = await import('../src/client/persona-store.ts')
    await vi.waitFor(() => {
      expect(store.getPersonaAssignments().orchestrator).toEqual({ provider: 'deepseek-official', model: 'deepseek-v3' })
    })

    // Another client commits → the host pushes the event → refresh re-reads.
    fetchMock.mockImplementation(async (_url: string, init: RequestInit) => {
      const method = (JSON.parse(String(init.body)) as { method: string }).method
      if (method === 'settings.describe') {
        return describeResponse({ personas: { orchestrator: { provider: 'deepseek-official', model: 'deepseek-v4' } } }, 2)
      }
      return mutateOk()
    })
    await store.refreshFromServer()
    expect(store.getPersonaAssignments().orchestrator).toEqual({ provider: 'deepseek-official', model: 'deepseek-v4' })
  })

  it('keeps a pending local assignment over a refresh that still reads the old value', async () => {
    let releaseMutate: ((res: Response) => void) | undefined
    const mutateGate = new Promise<Response>((resolve) => { releaseMutate = resolve })
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const method = (JSON.parse(String(init.body)) as { method: string }).method
      if (method === 'settings.describe') {
        return describeResponse({ personas: { fixer: { provider: 'deepseek-official', model: 'old' } } }, 1)
      }
      return mutateGate
    })
    vi.stubGlobal('fetch', fetchMock)
    const store = await import('../src/client/persona-store.ts')
    await vi.waitFor(() => {
      expect(store.getPersonaAssignments().fixer).toEqual({ provider: 'deepseek-official', model: 'old' })
    })

    const write = store.setPersonaAssignment('fixer', { provider: 'deepseek-official', model: 'optimistic' })
    await store.refreshFromServer()
    expect(store.getPersonaAssignments().fixer).toEqual({ provider: 'deepseek-official', model: 'optimistic' })

    releaseMutate?.(mutateOk())
    await expect(write).resolves.toBe(true)
  })

  it('clears a registry seat to an explicit null and keeps every other row state', async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const method = (JSON.parse(String(init.body)) as { method: string }).method
      if (method === 'settings.describe') {
        return describeResponse({ personas: { oracle: null, fixer: { provider: 'deepseek-official', model: 'old' } } }, 1)
      }
      return mutateOk()
    })
    vi.stubGlobal('fetch', fetchMock)
    const store = await import('../src/client/persona-store.ts')
    await vi.waitFor(() => {
      expect(store.getPersonaAssignments().fixer).toBeDefined()
    })

    await expect(store.clearPersonaAssignment('Fixer')).resolves.toBe(true)

    // The cleared key stays as the explicit inherit state; the other seat's
    // explicit null is untouched — clearing one seat drops no rows.
    expect(store.getPersonaAssignments().fixer).toBeNull()
    expect(store.getPersonaAssignments().oracle).toBeNull()
    expect(Object.keys(store.getPersonaAssignments()).sort()).toEqual(['fixer', 'oracle'])
    expect(mutateBodies(fetchMock).at(-1)?.payload.args.ops).toEqual([
      { op: 'set', path: ['personas', 'fixer'], value: null },
    ])
  })

  it('keeps a legacy persona-only seat as an explicit null so its fleet row survives', async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const method = (JSON.parse(String(init.body)) as { method: string }).method
      if (method === 'settings.describe') {
        return describeResponse({ personas: { keeper: { provider: 'freellmapi', model: 'auto' } } }, 1)
      }
      return mutateOk()
    })
    vi.stubGlobal('fetch', fetchMock)
    const store = await import('../src/client/persona-store.ts')
    await vi.waitFor(() => {
      expect(store.getPersonaAssignments().keeper).toBeDefined()
    })

    await expect(store.clearPersonaAssignment('Keeper')).resolves.toBe(true)

    expect(store.getPersonaAssignments().keeper).toBeNull()
    expect(mutateBodies(fetchMock).at(-1)?.payload.args.ops).toEqual([
      { op: 'set', path: ['personas', 'keeper'], value: null },
    ])
  })

  it('keeps a cleared stray persona key as an explicit null too — no row is ever dropped', async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const method = (JSON.parse(String(init.body)) as { method: string }).method
      if (method === 'settings.describe') {
        return describeResponse({ personas: { critic: { provider: 'opencode-go', model: 'deepseek-v4.1-flash' } } }, 1)
      }
      return mutateOk()
    })
    vi.stubGlobal('fetch', fetchMock)
    const store = await import('../src/client/persona-store.ts')
    await vi.waitFor(() => {
      expect(store.getPersonaAssignments().critic).toBeDefined()
    })

    await expect(store.clearPersonaAssignment('critic')).resolves.toBe(true)

    expect(store.getPersonaAssignments().critic).toBeNull()
    expect(mutateBodies(fetchMock).at(-1)?.payload.args.ops).toEqual([
      { op: 'set', path: ['personas', 'critic'], value: null },
    ])
  })

  it('keeps a pending clear over a refresh that still reads the old value', async () => {
    let releaseMutate: ((res: Response) => void) | undefined
    const mutateGate = new Promise<Response>((resolve) => { releaseMutate = resolve })
    let revision = 1
    const personas: Record<string, unknown> = { fixer: { provider: 'deepseek-official', model: 'old' } }
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const method = (JSON.parse(String(init.body)) as { method: string }).method
      if (method === 'settings.describe') return describeResponse({ personas }, revision)
      return mutateGate
    })
    vi.stubGlobal('fetch', fetchMock)
    const store = await import('../src/client/persona-store.ts')
    await vi.waitFor(() => {
      expect(store.getPersonaAssignments().fixer).toEqual({ provider: 'deepseek-official', model: 'old' })
    })

    const write = store.clearPersonaAssignment('fixer')
    // The echo still carries the pre-clear row: the local explicit null holds.
    revision = 2
    await store.refreshFromServer()
    expect(store.getPersonaAssignments().fixer).toBeNull()

    releaseMutate?.(mutateOk())
    await expect(write).resolves.toBe(true)
  })

  it('releases a pending key when its write fails, so the server value can win again', async () => {
    let revision = 1
    const personas: Record<string, unknown> = { fixer: { provider: 'deepseek-official', model: 'old' } }
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const method = (JSON.parse(String(init.body)) as { method: string }).method
      if (method === 'settings.describe') return describeResponse({ personas }, revision)
      throw new Error('offline')
    })
    vi.stubGlobal('fetch', fetchMock)
    const store = await import('../src/client/persona-store.ts')
    await vi.waitFor(() => {
      expect(store.getPersonaAssignments().fixer).toEqual({ provider: 'deepseek-official', model: 'old' })
    })

    await expect(store.setPersonaAssignment('fixer', { provider: 'deepseek-official', model: 'new' })).resolves.toBe(false)
    await expect(store.clearPersonaAssignment('fixer')).resolves.toBe(false)

    // Failed writes hold no pending key: the next read's server value applies.
    revision = 2
    personas.fixer = { provider: 'deepseek-official', model: 'remote' }
    await store.refreshFromServer()
    expect(store.getPersonaAssignments().fixer).toEqual({ provider: 'deepseek-official', model: 'remote' })
  })

  it('does not republish when a new revision carries the snapshot already held', async () => {
    let personas = { fixer: { provider: 'deepseek-official', model: 'old' } }
    let revision = 1
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const method = (JSON.parse(String(init.body)) as { method: string }).method
      if (method === 'settings.describe') return describeResponse({ personas }, revision)
      return mutateOk()
    })
    vi.stubGlobal('fetch', fetchMock)
    const store = await import('../src/client/persona-store.ts')
    await vi.waitFor(() => {
      expect(store.getPersonaAssignments().fixer).toBeDefined()
    })

    const listener = vi.fn()
    const unsubscribe = store.subscribePersonaAssignments(listener)
    // A push after another namespace write echoes the same personas under a new
    // revision: no snapshot replacement, no subscriber wake, no row re-render.
    revision = 2
    await store.refreshFromServer()
    expect(listener).not.toHaveBeenCalled()
    unsubscribe()
  })

  it('keeps a pending optimistic key the echoed document does not carry yet', async () => {
    let releaseMutate: ((res: Response) => void) | undefined
    const mutateGate = new Promise<Response>((resolve) => { releaseMutate = resolve })
    let revision = 1
    const personas: Record<string, unknown> = {}
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const method = (JSON.parse(String(init.body)) as { method: string }).method
      if (method === 'settings.describe') return describeResponse({ personas }, revision)
      return mutateGate
    })
    vi.stubGlobal('fetch', fetchMock)
    const store = await import('../src/client/persona-store.ts')

    const write = store.setPersonaAssignment('keeper', { provider: 'freellmapi', model: 'auto' })
    // The echo arrives before the server document carries the new row: the
    // optimistic value (and its row) must survive the refresh.
    revision = 2
    await store.refreshFromServer()
    expect(store.getPersonaAssignments().keeper).toEqual({ provider: 'freellmapi', model: 'auto' })

    releaseMutate?.(mutateOk())
    await expect(write).resolves.toBe(true)
  })
})

describe('params-store live sync', () => {
  it('merges a server parameter change and keeps a pending local key', async () => {
    let releaseMutate: ((res: Response) => void) | undefined
    const mutateGate = new Promise<Response>((resolve) => { releaseMutate = resolve })
    let hanging = false
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const method = (JSON.parse(String(init.body)) as { method: string }).method
      if (method === 'settings.describe') {
        return describeResponse({ parameters: { keeper: { leaseMs: 45_000, claimsBatchSize: 8, negativeCacheMs: 111_111 } } }, 1)
      }
      return hanging ? mutateGate : mutateOk()
    })
    vi.stubGlobal('fetch', fetchMock)
    const store = await import('../src/client/params-store.ts')
    // A boot value distinct from the 120s default proves the first read applied
    // before the refresh below, so the two reads are not coalesced.
    await vi.waitFor(() => {
      expect(store.getOrchestrationParams().keeper.negativeCacheMs).toBe(111_111)
    })

    hanging = true
    store.setOrchestrationParam('keeper', 'claimsBatchSize', 12)
    // A remote commit moves another key of the same group while the local write is in flight.
    fetchMock.mockImplementation(async (_url: string, init: RequestInit) => {
      const method = (JSON.parse(String(init.body)) as { method: string }).method
      if (method === 'settings.describe') {
        return describeResponse({ parameters: { keeper: { leaseMs: 45_000, claimsBatchSize: 8, minRefreshMs: 30_000 } } }, 2)
      }
      return mutateGate
    })
    await store.refreshFromServer()
    expect(store.getOrchestrationParams().keeper.claimsBatchSize).toBe(12)
    expect(store.getOrchestrationParams().keeper.minRefreshMs).toBe(30_000)

    releaseMutate?.(mutateOk())
  })
})

describe('permissions-model fenced whole-array writes', () => {
  it('re-reads after a conflict and re-applies the change onto the fresh array', async () => {
    let describes = 0
    let mutates = 0
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const method = (JSON.parse(String(init.body)) as { method: string }).method
      if (method === 'settings.describe') {
        describes += 1
        const bashPatterns = describes === 1
          ? [{ pattern: 'old', policy: 'ask' }]
          : [{ pattern: 'remote', policy: 'allow' }]
        return describeResponse({ permissions: { bashPatterns } }, describes)
      }
      mutates += 1
      return mutates === 1 ? mutateConflict() : mutateOk()
    })
    vi.stubGlobal('fetch', fetchMock)
    const model = await import('../src/client/permissions-model.ts')

    const persisted = await model.persistBashPatterns(fresh => [
      ...fresh,
      { pattern: 'local', policy: 'deny' },
    ])
    expect(persisted).toBe(true)
    const mutations = mutateBodies(fetchMock)
    expect(mutations).toHaveLength(2)
    expect(mutations[0]?.payload.args.expectedRevision).toBe(1)
    expect(mutations[0]?.payload.args.ops[0]?.value).toEqual([
      { pattern: 'old', policy: 'ask' },
      { pattern: 'local', policy: 'deny' },
    ])
    // The retry carries the NEW revision and the operator's change on top of
    // the value the other client wrote in between (no clobber).
    expect(mutations[1]?.payload.args.expectedRevision).toBe(2)
    expect(mutations[1]?.payload.args.ops[0]?.value).toEqual([
      { pattern: 'remote', policy: 'allow' },
      { pattern: 'local', policy: 'deny' },
    ])
  })

  it('keeps a pending path over the server view until its write settles', async () => {
    let releaseMutate: ((res: Response) => void) | undefined
    const mutateGate = new Promise<Response>((resolve) => { releaseMutate = resolve })
    vi.stubGlobal('fetch', vi.fn(() => mutateGate))
    const model = await import('../src/client/permissions-model.ts')

    const write = model.setPermissionPath(['tools', 'bash'], 'deny')
    const pending = model.mergeServerPermissionsWithPending(
      { tools: { bash: 'allow', read: 'deny' } },
      { tools: { bash: 'deny' } },
    )
    expect(pending.tools).toEqual({ bash: 'deny', read: 'deny' })

    releaseMutate?.(mutateOk())
    await expect(write).resolves.toBe(true)
    const settled = model.mergeServerPermissionsWithPending(
      { tools: { bash: 'allow' } },
      { tools: { bash: 'deny' } },
    )
    expect(settled.tools).toEqual({ bash: 'allow' })
  })
})
