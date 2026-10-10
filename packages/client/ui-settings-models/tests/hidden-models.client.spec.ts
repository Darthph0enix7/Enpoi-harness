// @vitest-environment jsdom
/**
 * The hidden/shown visibility store: cross-client live sync (a pushed server
 * map change reaches the local store; a provider with a local write in flight
 * is never clobbered by a refresh), the debounced serialized flush of the
 * operator-intent queue (both maps always written, intents applied onto the
 * fresh server maps in click order), the conflict-retry read-modify-write, a
 * failed flush retaining its queue until a confirmed write, and every
 * storage-disabled fallback.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/** The persisted map shape: provider → model ids (hidden or explicitly shown). */
type HiddenMap = Record<string, string[]>

const HIDDEN_KEY = 'dsh_hidden_models_v1'
const SHOWN_KEY = 'dsh_shown_models_v1'
const EVENT_NAME = 'dsh:hidden-models-changed'

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.resetModules()
  delete (globalThis as { __dshSettingsDescribe?: unknown }).__dshSettingsDescribe
})

beforeEach(() => {
  localStorage.clear()
})

/** One `settings.describe` envelope carrying raw namespaces. */
function describeNamespaces(namespaces: readonly unknown[], status = 200): Response {
  return new Response(JSON.stringify({
    result: { ok: true, value: { namespaces } },
  }), { status })
}

/** One `settings.describe` envelope carrying the enpoi-orchestration namespace. */
function describeResponse(hiddenModels: HiddenMap, revision: number, shownModels?: HiddenMap): Response {
  return describeNamespaces([{
    ns: 'enpoi-orchestration',
    revision,
    value: {
      uiPreferences: {
        hiddenModels,
        ...shownModels === undefined ? {} : { shownModels },
      },
    },
  }])
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

/** One non-conflict write refusal. */
function mutateRejected(): Response {
  return new Response(JSON.stringify({
    result: { ok: false, error: { code: 'settings/denied', message: 'refused', details: {} } },
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

/** The hidden and shown maps carried by each `settings.mutate`, in call order. */
function mutateMaps(fetchMock: ReturnType<typeof vi.fn>): Array<{ hidden: HiddenMap; shown: HiddenMap }> {
  return mutateBodies(fetchMock).map(body => ({
    hidden: (body.payload.args.ops[0]?.value ?? {}) as HiddenMap,
    shown: (body.payload.args.ops[1]?.value ?? {}) as HiddenMap,
  }))
}

/** The live server maps one stub answers describes from. */
interface ServerState {
  hidden: HiddenMap
  shown?: HiddenMap | undefined
  revision?: number | undefined
  describeOk?: boolean | undefined
}

/**
 * A fetch stub answering `settings.describe` from `state` (a fresh copy per
 * call) and `settings.mutate` with `answer(attempt)`, ok by default.
 */
function settingsFetch(
  state: ServerState,
  answer: (attempt: number) => Response | Promise<Response> = () => mutateOk(),
): ReturnType<typeof vi.fn> {
  let mutates = 0
  return vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { method: string }
    if (body.method === 'settings.describe') {
      if (state.describeOk === false) return new Response('unavailable', { status: 503 })
      const ns: Record<string, unknown> = { ns: 'enpoi-orchestration' }
      if (state.revision !== undefined) ns.revision = state.revision
      ns.value = {
        uiPreferences: {
          hiddenModels: { ...state.hidden },
          ...state.shown === undefined ? {} : { shownModels: { ...state.shown } },
        },
      }
      return describeNamespaces([ns])
    }
    mutates += 1
    return answer(mutates)
  })
}

/** Flush pending microtasks under fake timers without advancing the clock. */
async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0)
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

describe('hidden-models persistence maps', () => {
  it('writes both maps on every flush, empty shown included, and pins an unhidden model shown', async () => {
    vi.useFakeTimers()
    const fetchMock = settingsFetch({ hidden: {}, revision: 1 })
    vi.stubGlobal('fetch', fetchMock)
    const store = await import('../src/client/hidden-models.ts')
    await settle()

    // A visible model toggles hidden: the hidden map gains the id, shown stays empty.
    expect(store.toggleModelHidden('alpha', 'm1')).toBe(true)
    expect(store.isModelHidden('alpha', 'm1')).toBe(true)
    expect(store.isModelShown('alpha', 'm1')).toBe(false)
    await vi.advanceTimersByTimeAsync(60)

    let maps = mutateMaps(fetchMock)
    expect(maps).toHaveLength(1)
    expect(maps[0]).toEqual({ hidden: { alpha: ['m1'] }, shown: {} })

    // The same toggle back pins the model shown: hidden loses it, shown gains it.
    expect(store.toggleModelHidden('alpha', 'm1')).toBe(false)
    expect(store.isModelHidden('alpha', 'm1')).toBe(false)
    expect(store.isModelShown('alpha', 'm1')).toBe(true)
    await vi.advanceTimersByTimeAsync(60)

    maps = mutateMaps(fetchMock)
    expect(maps).toHaveLength(2)
    expect(maps[1]).toEqual({ hidden: {}, shown: { alpha: ['m1'] } })
    // Both ops are always sent, each with its own settings path.
    expect(mutateBodies(fetchMock)[1]?.payload.args.ops.map(op => op.path)).toEqual([
      ['uiPreferences', 'hiddenModels'],
      ['uiPreferences', 'shownModels'],
    ])
  })

  it('coalesces two rapid toggles of one model into a single flush, in click order', async () => {
    vi.useFakeTimers()
    const fetchMock = settingsFetch({ hidden: { alpha: ['server-other'] }, shown: { alpha: ['x'] }, revision: 1 })
    vi.stubGlobal('fetch', fetchMock)
    const store = await import('../src/client/hidden-models.ts')
    await settle()

    store.toggleModelHidden('alpha', 'm')
    store.toggleModelHidden('alpha', 'm')
    // Nothing flushes inside the debounce window.
    await vi.advanceTimersByTimeAsync(40)
    expect(mutateBodies(fetchMock)).toHaveLength(0)

    await vi.advanceTimersByTimeAsync(20)
    const maps = mutateMaps(fetchMock)
    expect(maps).toHaveLength(1)
    // hide then show, applied sequentially: the id ends in shown only.
    expect(maps[0]).toEqual({ hidden: { alpha: ['server-other'] }, shown: { alpha: ['x', 'm'] } })
  })

  it('queues a per-model intent and a bulk intent in click order', async () => {
    vi.useFakeTimers()
    const fetchMock = settingsFetch({ hidden: {}, revision: 1 })
    vi.stubGlobal('fetch', fetchMock)
    const store = await import('../src/client/hidden-models.ts')
    await settle()

    store.toggleModelVisibility('alpha', 'm', false)
    store.showAllModels('alpha', ['x'])
    await vi.advanceTimersByTimeAsync(60)

    const maps = mutateMaps(fetchMock)
    expect(maps).toHaveLength(1)
    // The later show-all wins over the earlier hide, as the click order says.
    expect(maps[0]).toEqual({ hidden: {}, shown: { alpha: ['x'] } })
  })

  it('hideAllModels keeps the local union, clears shown, and unions onto the fresh server map', async () => {
    vi.useFakeTimers()
    const state: ServerState = { hidden: { alpha: ['h1'] }, shown: { alpha: ['s1'] }, revision: 1 }
    const fetchMock = settingsFetch(state)
    vi.stubGlobal('fetch', fetchMock)
    const store = await import('../src/client/hidden-models.ts')
    await settle()

    store.hideAllModels('alpha', ['h1', 'h2'])
    expect(store.getHiddenModels('alpha')).toEqual(new Set(['h1', 'h2']))
    expect(store.getShownModels('alpha')).toEqual(new Set())
    await vi.advanceTimersByTimeAsync(60)

    const maps = mutateMaps(fetchMock)
    expect(maps).toHaveLength(1)
    // The server already had h1: the flush unions the ids and clears shown.
    expect(maps[0]).toEqual({ hidden: { alpha: ['h1', 'h2'] }, shown: {} })

    // show-all clears hidden, unions shown onto the fresh server shown.
    store.showAllModels('alpha', ['s1', 's2'])
    expect(store.getHiddenModels('alpha')).toEqual(new Set())
    expect(store.getShownModels('alpha')).toEqual(new Set(['s1', 's2']))
    await vi.advanceTimersByTimeAsync(60)

    expect(mutateMaps(fetchMock)[1]).toEqual({ hidden: {}, shown: { alpha: ['s1', 's2'] } })

    // show-all with no ids clears every pin for the provider.
    state.shown = {}
    store.showAllModels('alpha')
    expect(store.getShownModels('alpha')).toEqual(new Set())
    await vi.advanceTimersByTimeAsync(60)

    expect(mutateMaps(fetchMock)[2]).toEqual({ hidden: {}, shown: {} })
  })

  it('applies per-model intents onto the fresh server maps, each into exactly one map', async () => {
    vi.useFakeTimers()
    const state: ServerState = { hidden: { alpha: ['h1'] }, shown: { alpha: ['m'] }, revision: 1 }
    const fetchMock = settingsFetch(state)
    vi.stubGlobal('fetch', fetchMock)
    const store = await import('../src/client/hidden-models.ts')
    await settle()

    // set-hidden removes the id from the fresh server shown map.
    store.toggleModelVisibility('alpha', 'm', false)
    await vi.advanceTimersByTimeAsync(60)
    expect(mutateMaps(fetchMock)[0]).toEqual({ hidden: { alpha: ['h1', 'm'] }, shown: {} })

    // set-shown removes the id from the fresh server hidden map.
    state.hidden = { alpha: ['h1', 'm2'] }
    state.shown = { alpha: ['s'] }
    store.toggleModelVisibility('alpha', 'm2', true)
    await vi.advanceTimersByTimeAsync(60)
    expect(mutateMaps(fetchMock)[1]).toEqual({ hidden: { alpha: ['h1'] }, shown: { alpha: ['s', 'm2'] } })
  })

  it('omits the revision fence when the fresh describe carries no revision', async () => {
    vi.useFakeTimers()
    const fetchMock = settingsFetch({ hidden: {} })
    vi.stubGlobal('fetch', fetchMock)
    const store = await import('../src/client/hidden-models.ts')
    await settle()

    store.toggleModelVisibility('alpha', 'm', false)
    await vi.advanceTimersByTimeAsync(60)

    const [body] = mutateBodies(fetchMock)
    expect(body).toBeDefined()
    expect('expectedRevision' in (body?.payload.args ?? {})).toBe(false)
  })

  it('applies intents onto user-scoped maps, and onto empty maps when the namespace carries none', async () => {
    vi.useFakeTimers()
    let shape: 'user' | 'bare' = 'user'
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { method: string }
      if (body.method !== 'settings.describe') return mutateOk()
      return shape === 'user'
        ? describeNamespaces([{
          ns: 'enpoi-orchestration',
          revision: 1,
          user: { uiPreferences: { hiddenModels: { alpha: ['u-h'] }, shownModels: { alpha: ['u-s'] } } },
        }])
        : describeNamespaces([{ ns: 'enpoi-orchestration', revision: 1 }])
    })
    vi.stubGlobal('fetch', fetchMock)
    const store = await import('../src/client/hidden-models.ts')
    await settle()

    store.toggleModelVisibility('alpha', 'm2', false)
    await vi.advanceTimersByTimeAsync(60)
    expect(mutateMaps(fetchMock)[0]).toEqual({ hidden: { alpha: ['u-h', 'm2'] }, shown: { alpha: ['u-s'] } })

    shape = 'bare'
    store.toggleModelVisibility('alpha', 'm3', false)
    await vi.advanceTimersByTimeAsync(60)
    expect(mutateMaps(fetchMock)[1]).toEqual({ hidden: { alpha: ['m3'] }, shown: {} })
  })

  it('sends no mutate when the describe answer is unavailable at flush time', async () => {
    vi.useFakeTimers()
    let describes = 0
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { method: string }
      if (body.method !== 'settings.describe') return mutateOk()
      describes += 1
      return describes === 1 ? describeResponse({}, 1) : new Response('unavailable', { status: 503 })
    })
    vi.stubGlobal('fetch', fetchMock)
    const store = await import('../src/client/hidden-models.ts')
    await settle()
    expect(describes).toBe(1)

    store.toggleModelVisibility('alpha', 'm1', false)
    await vi.advanceTimersByTimeAsync(60)

    expect(describes).toBe(2)
    expect(mutateBodies(fetchMock)).toHaveLength(0)
    // The optimistic local state stays.
    expect(store.isModelHidden('alpha', 'm1')).toBe(true)
  })
})

describe('flush failure handling', () => {
  it('retains intents on a non-ok mutate answer, and the next toggle flushes the queue together', async () => {
    vi.useFakeTimers()
    const fetchMock = settingsFetch({ hidden: {}, revision: 1 }, attempt =>
      (attempt === 1 ? new Response('refused', { status: 503 }) : mutateOk()))
    vi.stubGlobal('fetch', fetchMock)
    const store = await import('../src/client/hidden-models.ts')
    await settle()

    store.toggleModelVisibility('alpha', 'm1', false)
    await vi.advanceTimersByTimeAsync(60)
    expect(mutateBodies(fetchMock)).toHaveLength(1)
    // The refused write keeps its intent: the optimistic state survives.
    expect(store.isModelHidden('alpha', 'm1')).toBe(true)

    store.toggleModelVisibility('alpha', 'm2', false)
    await vi.advanceTimersByTimeAsync(60)

    const maps = mutateMaps(fetchMock)
    expect(maps).toHaveLength(2)
    // The retry applies the retained intent before the new one, in click order.
    expect(maps[1]).toEqual({ hidden: { alpha: ['m1', 'm2'] }, shown: {} })
  })

  it('retains intents when the mutate request itself rejects, and the next toggle flushes them together', async () => {
    vi.useFakeTimers()
    const fetchMock = settingsFetch({ hidden: {}, revision: 1 }, (attempt) => {
      if (attempt === 1) throw new Error('network down')
      return mutateOk()
    })
    vi.stubGlobal('fetch', fetchMock)
    const store = await import('../src/client/hidden-models.ts')
    await settle()

    store.toggleModelVisibility('alpha', 'm1', false)
    await vi.advanceTimersByTimeAsync(60)
    store.toggleModelVisibility('alpha', 'm2', false)
    await vi.advanceTimersByTimeAsync(60)

    const maps = mutateMaps(fetchMock)
    expect(maps).toHaveLength(2)
    expect(maps[1]).toEqual({ hidden: { alpha: ['m1', 'm2'] }, shown: {} })
  })

  it('retains the intents queued during an in-flight write and flushes them on the queued chain', async () => {
    vi.useFakeTimers()
    let releaseFirst: ((response: Response) => void) | undefined
    let releaseSecond: ((response: Response) => void) | undefined
    const firstGate = new Promise<Response>((resolve) => { releaseFirst = resolve })
    const secondGate = new Promise<Response>((resolve) => { releaseSecond = resolve })
    const fetchMock = settingsFetch({ hidden: { alpha: ['server'] }, revision: 1 }, (attempt) => {
      if (attempt === 1) return firstGate
      if (attempt === 2) return secondGate
      return mutateOk()
    })
    vi.stubGlobal('fetch', fetchMock)
    const store = await import('../src/client/hidden-models.ts')
    await settle()

    store.toggleModelVisibility('alpha', 'm1', false)
    await vi.advanceTimersByTimeAsync(60)
    expect(mutateBodies(fetchMock)).toHaveLength(1)

    // The next click arms a second flush timer while the first write is parked.
    store.toggleModelVisibility('alpha', 'm2', false)
    await vi.advanceTimersByTimeAsync(60)
    expect(mutateBodies(fetchMock)).toHaveLength(1)

    // The first write succeeds; its queued intent stays in the map and the
    // queued chain flushes it.
    releaseFirst?.(mutateOk())
    await settle()
    await settle()
    await settle()
    expect(mutateBodies(fetchMock)).toHaveLength(2)

    // A third toggle re-arms the timer while the second write is parked, so the
    // second chain settles with a timer still armed; its own retained intent
    // then flushes on the timer's chain.
    store.toggleModelVisibility('alpha', 'm3', false)
    releaseSecond?.(mutateOk())
    await settle()
    await settle()
    await settle()
    await vi.advanceTimersByTimeAsync(60)

    const maps = mutateMaps(fetchMock)
    expect(maps).toHaveLength(3)
    expect(maps[1]).toEqual({ hidden: { alpha: ['server', 'm2'] }, shown: {} })
    expect(maps[2]).toEqual({ hidden: { alpha: ['server', 'm3'] }, shown: {} })
  })

  it('survives a describe rejection at flush time and keeps the optimistic state', async () => {
    vi.useFakeTimers()
    let describes = 0
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { method: string }
      if (body.method !== 'settings.describe') return mutateOk()
      describes += 1
      if (describes === 1) return describeResponse({}, 1)
      throw new Error('offline')
    })
    vi.stubGlobal('fetch', fetchMock)
    const store = await import('../src/client/hidden-models.ts')
    await settle()

    store.toggleModelVisibility('alpha', 'm1', false)
    await vi.advanceTimersByTimeAsync(60)

    expect(store.isModelHidden('alpha', 'm1')).toBe(true)
    expect(mutateBodies(fetchMock)).toHaveLength(0)
  })

  it('retries the refused queue on the queued flush and keeps later clicks on their own write', async () => {
    vi.useFakeTimers()
    let releaseMutate: ((response: Response) => void) | undefined
    const mutateGate = new Promise<Response>((resolve) => { releaseMutate = resolve })
    const fetchMock = settingsFetch({ hidden: { alpha: ['server'] }, revision: 1 }, attempt =>
      (attempt === 1 ? mutateGate : mutateOk()))
    vi.stubGlobal('fetch', fetchMock)
    const store = await import('../src/client/hidden-models.ts')
    await settle()

    store.toggleModelVisibility('alpha', 'm1', false)
    await vi.advanceTimersByTimeAsync(60)
    // The first flush is parked on its mutate answer.
    expect(mutateBodies(fetchMock)).toHaveLength(1)

    // A second click during the in-flight write queues behind it.
    store.toggleModelVisibility('alpha', 'm2', false)
    releaseMutate?.(mutateRejected())
    await settle()

    // The refused write kept its intent; the queued flush retries the whole
    // queue — the retained click first, the mid-flight click after it.
    await vi.advanceTimersByTimeAsync(60)
    expect(mutateBodies(fetchMock)).toHaveLength(2)
    const maps = mutateMaps(fetchMock)
    expect(maps[1]).toEqual({ hidden: { alpha: ['server', 'm1', 'm2'] }, shown: {} })

    // A later operator action flushes its own intent after the settled queue.
    store.toggleModelVisibility('alpha', 'm3', false)
    expect(store.isModelHidden('alpha', 'm3')).toBe(true)
    await vi.advanceTimersByTimeAsync(60)

    const all = mutateMaps(fetchMock)
    expect(all).toHaveLength(3)
    expect(all[2]).toEqual({ hidden: { alpha: ['server', 'm3'] }, shown: {} })
  })
})

describe('hidden-models refresh authority', () => {
  it('treats the server map as authoritative for settled providers, hidden and shown alike', async () => {
    let hidden: HiddenMap = { alpha: ['m1'], beta: ['b1'] }
    let shown: HiddenMap = { alpha: ['s1'], beta: ['s2'] }
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { method: string }
      return body.method === 'settings.describe' ? describeResponse(hidden, 1, shown) : mutateOk()
    })
    vi.stubGlobal('fetch', fetchMock)
    const store = await import('../src/client/hidden-models.ts')
    await vi.waitFor(() => {
      expect(store.isModelHidden('alpha', 'm1')).toBe(true)
    })
    expect(store.isModelShown('alpha', 's1')).toBe(true)

    hidden = { beta: ['b1'] }
    shown = { beta: ['s2'] }
    await store.refreshFromServer()

    expect(store.isModelHidden('alpha', 'm1')).toBe(false)
    expect(store.isModelShown('alpha', 's1')).toBe(false)
    expect(store.isModelHidden('beta', 'b1')).toBe(true)
    expect(store.isModelShown('beta', 's2')).toBe(true)
  })

  it("keeps a pending provider's optimistic keys through a refresh, including its absent-key case", async () => {
    vi.useFakeTimers()
    let describes = 0
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { method: string }
      if (body.method !== 'settings.describe') return mutateOk()
      describes += 1
      if (describes === 1) return describeNamespaces([{ ns: 'enpoi-orchestration', revision: 1 }])
      return describeResponse({ ghost: ['server-h'], alpha: ['a'] }, 1, { ghost: ['server-s'], alpha: ['a-s'] })
    })
    vi.stubGlobal('fetch', fetchMock)
    const store = await import('../src/client/hidden-models.ts')
    await settle()

    // A shown pin is the provider's only local key, and the write is pending.
    store.toggleModelVisibility('ghost', 'g1', true)
    expect(store.isModelShown('ghost', 'g1')).toBe(true)
    expect(store.isModelHidden('ghost', 'g1')).toBe(false)

    await store.refreshFromServer()

    // The pending provider keeps its optimistic shown pin; the server's hidden
    // value for it is not merged, and its absent hidden key stays absent.
    expect(store.isModelHidden('ghost', 'server-h')).toBe(false)
    expect(store.isModelShown('ghost', 'server-s')).toBe(false)
    expect(store.isModelShown('ghost', 'g1')).toBe(true)
    // A settled provider follows the server.
    expect(store.isModelHidden('alpha', 'a')).toBe(true)
    expect(store.isModelShown('alpha', 'a-s')).toBe(true)
  })

  it('reads the user-scoped maps when the namespace carries no value maps', async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { method: string }
      if (body.method !== 'settings.describe') return mutateOk()
      return describeNamespaces([{
        ns: 'enpoi-orchestration',
        revision: 1,
        user: { uiPreferences: { hiddenModels: { alpha: ['u-h'] }, shownModels: { alpha: ['u-s'] } } },
      }])
    })
    vi.stubGlobal('fetch', fetchMock)
    const store = await import('../src/client/hidden-models.ts')
    await vi.waitFor(() => {
      expect(store.isModelHidden('alpha', 'u-h')).toBe(true)
    })
    expect(store.isModelShown('alpha', 'u-s')).toBe(true)
  })

  it('leaves the local maps untouched when the describe answer is unavailable', async () => {
    localStorage.setItem(HIDDEN_KEY, JSON.stringify({ alpha: ['local-h'] }))
    localStorage.setItem(SHOWN_KEY, JSON.stringify({ alpha: ['local-s'] }))
    // The resolved response type keeps the later mockImplementation forms
    // (503 Response, describeNamespaces) assignable.
    const fetchMock = vi.fn(async (): Promise<Response> => { throw new Error('offline') })
    vi.stubGlobal('fetch', fetchMock)
    const store = await import('../src/client/hidden-models.ts')

    // A rejected request, a refused request, an answer without the namespace,
    // and a shared describe with no namespaces list all leave the mirror alone.
    await store.refreshFromServer()
    expect(store.isModelHidden('alpha', 'local-h')).toBe(true)

    fetchMock.mockImplementation(async () => new Response('unavailable', { status: 503 }))
    await store.refreshFromServer()
    expect(store.isModelHidden('alpha', 'local-h')).toBe(true)

    fetchMock.mockImplementation(async () => describeNamespaces([]))
    await store.refreshFromServer()
    expect(store.isModelShown('alpha', 'local-s')).toBe(true)

    fetchMock.mockImplementation(async () => new Response(
      JSON.stringify({ result: { ok: true, value: { namespaces: 'nope' } } }),
      { status: 200 },
    ))
    await store.refreshFromServer()
    expect(store.isModelHidden('alpha', 'local-h')).toBe(true)

    ;(globalThis as { __dshSettingsDescribe?: unknown }).__dshSettingsDescribe = async () => ({})
    await store.refreshFromServer()
    expect(store.isModelHidden('alpha', 'local-h')).toBe(true)
    expect(store.isModelShown('alpha', 'local-s')).toBe(true)
    expect(mutateBodies(fetchMock)).toHaveLength(0)
  })

  it("uses the wire root's shared describe when the page publishes one", async () => {
    ;(globalThis as { __dshSettingsDescribe?: unknown }).__dshSettingsDescribe = vi.fn(async () => ({
      namespaces: [{
        ns: 'enpoi-orchestration',
        revision: 1,
        value: { uiPreferences: { hiddenModels: { alpha: ['shared'] }, shownModels: { alpha: ['shared-s'] } } },
      }],
    }))
    vi.stubGlobal('fetch', vi.fn(async () => new Response('unavailable', { status: 503 })))
    const store = await import('../src/client/hidden-models.ts')
    await vi.waitFor(() => {
      expect(store.isModelHidden('alpha', 'shared')).toBe(true)
    })
    expect(store.isModelShown('alpha', 'shared-s')).toBe(true)

    // A shared answer without a namespaces list reads as no answer.
    ;(globalThis as { __dshSettingsDescribe?: unknown }).__dshSettingsDescribe = vi.fn(async () => ({}))
    await store.refreshFromServer()
    expect(store.isModelHidden('alpha', 'shared')).toBe(true)
  })
})

describe('hidden-models read tolerance', () => {
  it('reads malformed stores as empty and non-array lists as absent', async () => {
    localStorage.setItem(HIDDEN_KEY, '{ not json')
    localStorage.setItem(SHOWN_KEY, '{ not json')
    vi.stubGlobal('fetch', vi.fn(async () => new Response('unavailable', { status: 503 })))
    const store = await import('../src/client/hidden-models.ts')

    expect(store.isModelHidden('alpha', 'm')).toBe(false)
    expect(store.isModelShown('alpha', 'm')).toBe(false)

    // The next write heals the document; a non-array entry reads as absent.
    localStorage.setItem(HIDDEN_KEY, JSON.stringify({ alpha: 'not-an-array', beta: ['b1'] }))
    localStorage.setItem(SHOWN_KEY, JSON.stringify({ alpha: 'not-an-array', beta: ['b2'] }))
    expect(store.isModelHidden('alpha', 'b1')).toBe(false)
    expect(store.getHiddenModels('alpha')).toEqual(new Set())
    expect(store.isModelHidden('beta', 'b1')).toBe(true)
    expect(store.getHiddenModels('beta')).toEqual(new Set(['b1']))
    expect(store.isModelShown('alpha', 'b2')).toBe(false)
    expect(store.getShownModels('alpha')).toEqual(new Set())
    expect(store.isModelShown('beta', 'b2')).toBe(true)
    expect(store.getShownModels('beta')).toEqual(new Set(['b2']))
    expect(store.getHiddenModels('missing')).toEqual(new Set())
    expect(store.getShownModels('missing')).toEqual(new Set())
  })

  it('tolerates disabled storage: reads fall back and writes never crash', async () => {
    vi.useFakeTimers()
    const fetchMock = settingsFetch({ hidden: {}, revision: 1 })
    vi.stubGlobal('fetch', fetchMock)
    const writeSpy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota exceeded') })
    const store = await import('../src/client/hidden-models.ts')
    await settle()

    expect(() => { store.toggleModelVisibility('alpha', 'm', false) }).not.toThrow()
    await vi.advanceTimersByTimeAsync(60)
    // Nothing was persisted locally, but the flush still reached the server.
    expect(store.isModelHidden('alpha', 'm')).toBe(false)
    expect(mutateBodies(fetchMock)).toHaveLength(1)
    writeSpy.mockRestore()

    const readSpy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('storage disabled') })
    expect(store.isModelHidden('alpha', 'm')).toBe(false)
    expect(store.isModelShown('alpha', 'm')).toBe(false)
    expect(store.getHiddenModels('alpha')).toEqual(new Set())
    expect(store.getShownModels('alpha')).toEqual(new Set())
    // A refresh with both directions disabled still completes without a write.
    await store.refreshFromServer()
    readSpy.mockRestore()
  })

  it('swallows a dispatch failure and suppresses a no-change publish', async () => {
    vi.useFakeTimers()
    const fetchMock = settingsFetch({ hidden: {}, revision: 1 })
    vi.stubGlobal('fetch', fetchMock)
    const store = await import('../src/client/hidden-models.ts')
    await settle()
    // The import-time refresh already wrote the canonical empty documents.
    localStorage.clear()

    const onChange = vi.fn()
    const unsubscribe = store.subscribeHiddenModels(onChange)

    // The no-op prune still writes the canonical empty documents once.
    store.forgetHiddenProvider('ghost')
    expect(onChange).toHaveBeenCalledTimes(1)
    store.forgetHiddenProvider('ghost')
    expect(onChange).toHaveBeenCalledTimes(1)

    // A toggle that changes the map notifies; the same state again does not.
    store.toggleModelVisibility('beta', 'm', false)
    expect(onChange).toHaveBeenCalledTimes(2)
    store.toggleModelVisibility('beta', 'm', false)
    expect(onChange).toHaveBeenCalledTimes(2)
    unsubscribe()

    // A dispatch that throws is swallowed.
    const dispatchSpy = vi.spyOn(window, 'dispatchEvent').mockImplementation(() => { throw new Error('dispatch blocked') })
    expect(() => { store.toggleModelVisibility('gamma', 'm', false) }).not.toThrow()
    dispatchSpy.mockRestore()
    await vi.advanceTimersByTimeAsync(60)
  })

  it('removes a provider from the shown mirror too, keeping the others', async () => {
    localStorage.setItem(HIDDEN_KEY, JSON.stringify({ alpha: ['h1'] }))
    localStorage.setItem(SHOWN_KEY, JSON.stringify({ alpha: ['s1'], beta: ['b2'] }))
    vi.stubGlobal('fetch', vi.fn(async () => new Response('unavailable', { status: 503 })))
    const store = await import('../src/client/hidden-models.ts')

    store.forgetHiddenProvider('alpha')
    expect(JSON.parse(localStorage.getItem(HIDDEN_KEY) ?? 'null')).toEqual({})
    expect(JSON.parse(localStorage.getItem(SHOWN_KEY) ?? 'null')).toEqual({ beta: ['b2'] })

    // A provider present only in the shown mirror is removed there as well.
    store.forgetHiddenProvider('beta')
    expect(JSON.parse(localStorage.getItem(SHOWN_KEY) ?? 'null')).toEqual({})
  })

  it('notifies subscribers on custom and storage events and stops after unsubscribe', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('unavailable', { status: 503 })))
    const store = await import('../src/client/hidden-models.ts')
    const onChange = vi.fn()
    const unsubscribe = store.subscribeHiddenModels(onChange)

    window.dispatchEvent(new CustomEvent(EVENT_NAME, { detail: { provider: 'alpha' } }))
    expect(onChange).toHaveBeenLastCalledWith('alpha')
    window.dispatchEvent(new CustomEvent(EVENT_NAME))
    expect(onChange).toHaveBeenLastCalledWith(undefined)

    window.dispatchEvent(new StorageEvent('storage', { key: HIDDEN_KEY }))
    expect(onChange).toHaveBeenCalledTimes(3)
    window.dispatchEvent(new StorageEvent('storage', { key: SHOWN_KEY }))
    expect(onChange).toHaveBeenCalledTimes(4)
    window.dispatchEvent(new StorageEvent('storage', { key: 'other' }))
    expect(onChange).toHaveBeenCalledTimes(4)

    unsubscribe()
    window.dispatchEvent(new CustomEvent(EVENT_NAME))
    window.dispatchEvent(new StorageEvent('storage', { key: HIDDEN_KEY }))
    expect(onChange).toHaveBeenCalledTimes(4)
  })
})
