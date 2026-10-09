// @vitest-environment jsdom
/**
 * Cross-client live settings sync for the hidden-models store: a pushed server
 * map change reaches the local store, a provider with a local write in flight
 * is never clobbered by a refresh, and a conflicted whole-map write re-reads
 * and re-applies onto the fresh map.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/** The persisted map shape: provider → hidden model ids. */
type HiddenMap = Record<string, string[]>

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
})

beforeEach(() => {
  localStorage.clear()
})

/** One `settings.describe` envelope carrying the enpoi-orchestration namespace. */
function describeResponse(hiddenModels: HiddenMap, revision: number): Response {
  return new Response(JSON.stringify({
    result: {
      ok: true,
      value: { namespaces: [{ ns: 'enpoi-orchestration', revision, value: { uiPreferences: { hiddenModels } } }] },
    },
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
  payload: { args: { expectedRevision?: number; ops: Array<{ path: string[]; value?: HiddenMap }> } }
}

/** The parsed `settings.mutate` request bodies, in call order. */
function mutateBodies(fetchMock: ReturnType<typeof vi.fn>): MutateBody[] {
  return fetchMock.mock.calls
    .map(call => JSON.parse(String((call as [string, RequestInit])[1].body)) as MutateBody)
    .filter(body => body.method === 'settings.mutate')
}

describe('hidden-models live sync', () => {
  it('merges a pushed server map change into the local store', async () => {
    let serverMap: HiddenMap = { alpha: ['m1'] }
    let revision = 1
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      const method = (JSON.parse(String(init.body)) as { method: string }).method
      return method === 'settings.describe' ? describeResponse(serverMap, revision) : mutateOk()
    }))
    const store = await import('../src/client/hidden-models.ts')
    await vi.waitFor(() => {
      expect(store.isModelHidden('alpha', 'm1')).toBe(true)
    })

    // Another client hides one more model → pushed event → refresh merges it.
    serverMap = { alpha: ['m1', 'm2'] }
    revision = 2
    await store.refreshFromServer()
    expect(store.isModelHidden('alpha', 'm2')).toBe(true)
  })

  it('keeps a pending provider over a refresh and applies other providers', async () => {
    const serverMap: HiddenMap = { alpha: ['m1'] }
    let releaseMutate: ((res: Response) => void) | undefined
    const mutateGate = new Promise<Response>((resolve) => { releaseMutate = resolve })
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const method = (JSON.parse(String(init.body)) as { method: string }).method
      if (method === 'settings.describe') return describeResponse({ ...serverMap }, 1)
      return mutateGate
    })
    vi.stubGlobal('fetch', fetchMock)
    const store = await import('../src/client/hidden-models.ts')

    store.toggleModelHidden('alpha', 'm2')
    expect(store.isModelHidden('alpha', 'm2')).toBe(true)

    // A remote commit touches another provider while the alpha write is in flight.
    serverMap.beta = ['b1']
    await store.refreshFromServer()
    expect(store.isModelHidden('alpha', 'm2')).toBe(true)
    expect(store.isModelHidden('beta', 'b1')).toBe(true)

    releaseMutate?.(mutateOk())
    await vi.waitFor(() => {
      expect(mutateBodies(fetchMock)).toHaveLength(1)
    })
  })
})

describe('hidden-models fenced whole-map writes', () => {
  it('re-reads after a conflict and re-applies the toggle onto the fresh map', async () => {
    let mutates = 0
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const method = (JSON.parse(String(init.body)) as { method: string }).method
      if (method === 'settings.describe') {
        // Until the conflicting write happened, the host still reports the old
        // revision; afterwards it reports the other client's committed value.
        return mutates === 0
          ? describeResponse({ alpha: ['m1'] }, 1)
          : describeResponse({ alpha: ['m1'], beta: ['b1'] }, 2)
      }
      mutates += 1
      return mutates === 1 ? mutateConflict() : mutateOk()
    })
    vi.stubGlobal('fetch', fetchMock)
    const store = await import('../src/client/hidden-models.ts')

    store.toggleModelHidden('alpha', 'm2')
    await vi.waitFor(() => {
      expect(mutateBodies(fetchMock)).toHaveLength(2)
    })
    const mutations = mutateBodies(fetchMock)
    expect(mutations[0]?.payload.args.expectedRevision).toBe(1)
    expect(mutations[0]?.payload.args.ops[0]?.value).toEqual({ alpha: ['m1', 'm2'] })
    // The retry carries the NEW revision and keeps the remote beta change.
    expect(mutations[1]?.payload.args.expectedRevision).toBe(2)
    expect(mutations[1]?.payload.args.ops[0]?.value).toEqual({ alpha: ['m1', 'm2'], beta: ['b1'] })
  })
})

describe('forgetHiddenProvider', () => {
  it('drops the provider from the local mirror without a server write', async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const method = (JSON.parse(String(init.body)) as { method: string }).method
      return method === 'settings.describe' ? describeResponse({ alpha: ['m1'], beta: ['b1'] }, 1) : mutateOk()
    })
    vi.stubGlobal('fetch', fetchMock)
    const store = await import('../src/client/hidden-models.ts')
    await vi.waitFor(() => {
      expect(store.isModelHidden('alpha', 'm1')).toBe(true)
    })
    const mutationsBefore = mutateBodies(fetchMock).length

    store.forgetHiddenProvider('alpha')
    expect(store.isModelHidden('alpha', 'm1')).toBe(false)
    expect(store.isModelHidden('beta', 'b1')).toBe(true)
    // A local-only prune never touches the server map.
    expect(mutateBodies(fetchMock)).toHaveLength(mutationsBefore)
  })

  it('is a no-op for a provider the mirror does not carry', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => describeResponse({ beta: ['b1'] }, 1)))
    const store = await import('../src/client/hidden-models.ts')
    await vi.waitFor(() => {
      expect(store.isModelHidden('beta', 'b1')).toBe(true)
    })
    store.forgetHiddenProvider('alpha')
    expect(store.isModelHidden('beta', 'b1')).toBe(true)
  })
})
