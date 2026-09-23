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

  it('clears a registry seat with an explicit null so its fleet row stays', async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const method = (JSON.parse(String(init.body)) as { method: string }).method
      if (method === 'settings.describe') {
        return describeResponse({ personas: { fixer: { provider: 'deepseek-official', model: 'old' } } }, 1)
      }
      return mutateOk()
    })
    vi.stubGlobal('fetch', fetchMock)
    const store = await import('../src/client/persona-store.ts')
    await vi.waitFor(() => {
      expect(store.getPersonaAssignments().fixer).toBeDefined()
    })

    await expect(store.clearPersonaAssignment('Fixer')).resolves.toBe(true)

    expect(store.getPersonaAssignments().fixer).toBeUndefined()
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

    expect(store.getPersonaAssignments().keeper).toBeUndefined()
    expect(mutateBodies(fetchMock).at(-1)?.payload.args.ops).toEqual([
      { op: 'set', path: ['personas', 'keeper'], value: null },
    ])
  })

  it('unsets a stray persona key with no registry row instead of nulling it', async () => {
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

    expect(store.getPersonaAssignments().critic).toBeUndefined()
    expect(mutateBodies(fetchMock).at(-1)?.payload.args.ops).toEqual([
      { op: 'unset', path: ['personas', 'critic'] },
    ])
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
        return describeResponse({ parameters: { keeper: { leaseMs: 45_000, claimsBatchSize: 8 } } }, 1)
      }
      return hanging ? mutateGate : mutateOk()
    })
    vi.stubGlobal('fetch', fetchMock)
    const store = await import('../src/client/params-store.ts')
    await vi.waitFor(() => {
      expect(store.getOrchestrationParams().keeper.claimsBatchSize).toBe(8)
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
