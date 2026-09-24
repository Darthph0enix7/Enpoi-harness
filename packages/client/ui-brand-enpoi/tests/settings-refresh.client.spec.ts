// @vitest-environment jsdom
/**
 * The shared settings-refresh helper (settings-refresh.ts): one coalesced
 * settings.describe per burst, the reconnect / visibility / mount-stale
 * triggers, the debounce satisfied by a read that lands first, and the
 * stores' same-revision no-op (an unchanged document must not notify).
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

/** The request method of one fetch call body. */
function methodOf(init: RequestInit): string {
  return (JSON.parse(String(init.body)) as { method: string }).method
}

/** How many `settings.describe` calls a mock served. */
function describeCalls(fetchMock: ReturnType<typeof vi.fn>): number {
  return fetchMock.mock.calls.filter(call => methodOf((call as [string, RequestInit])[1]) === 'settings.describe').length
}

/** Resolve after real (or faked) time passes. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms) })
}

/** Drive `document.visibilityState` for the visibility trigger. */
function setVisibility(state: 'visible' | 'hidden'): void {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state })
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  if (typeof document !== 'undefined') setVisibility('visible')
  vi.resetModules()
})

describe('coalesced namespace reads', () => {
  it('shares one in-flight describe with every concurrent caller and answers undefined on failures', async () => {
    const helper = await import('../src/client/settings-refresh.ts')
    // Before the first successful read nothing is fresh, even with a zero window.
    expect(helper.isSettingsCacheFresh(60_000)).toBe(false)

    let release: ((res: Response) => void) | undefined
    const gate = new Promise<Response>((resolve) => { release = resolve })
    const fetchMock = vi.fn(() => gate)
    vi.stubGlobal('fetch', fetchMock)
    const first = helper.readEnpoiNamespace()
    const second = helper.readEnpoiNamespace()
    expect(first).toBe(second)
    expect(describeCalls(fetchMock)).toBe(1)
    release?.(describeResponse({ personas: {} }, 3))
    await expect(first).resolves.toMatchObject({ revision: 3 })
    expect(helper.isSettingsCacheFresh(60_000)).toBe(true)
    expect(helper.isSettingsCacheFresh(0)).toBe(false)

    // HTTP failure and a malformed / namespace-less answer both resolve undefined.
    vi.stubGlobal('fetch', vi.fn(async () => new Response('offline', { status: 500 })))
    await expect(helper.readEnpoiNamespace()).resolves.toBeUndefined()
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ result: { ok: true, value: {} } }), { status: 200 })))
    await expect(helper.readEnpoiNamespace()).resolves.toBeUndefined()
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      result: { ok: true, value: { namespaces: [{ ns: 'other' }] } },
    }), { status: 200 })))
    await expect(helper.readEnpoiNamespace()).resolves.toBeUndefined()
  })

  it('reads three stores re-reading in one tick through a single describe call', async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      if (methodOf(init) === 'settings.describe') {
        return describeResponse({
          personas: { orchestrator: { provider: 'p', model: 'm' } },
          parameters: { keeper: { negativeCacheMs: 111_111 } },
          permissions: { tools: { bash: 'ask' } },
        }, 1)
      }
      return mutateOk()
    })
    vi.stubGlobal('fetch', fetchMock)
    const persona = await import('../src/client/persona-store.ts')
    const params = await import('../src/client/params-store.ts')
    const permissions = await import('../src/client/permissions-model.ts')
    // Boot priming: the three imports share one read (asserted below once settled).
    await vi.waitFor(() => {
      expect(persona.getPersonaAssignments().orchestrator).toBeDefined()
      expect(params.getOrchestrationParams().keeper.negativeCacheMs).toBe(111_111)
    })
    const before = describeCalls(fetchMock)
    await Promise.all([
      persona.refreshFromServer(),
      params.refreshFromServer(),
      permissions.refreshFromServer(),
    ])
    expect(describeCalls(fetchMock) - before).toBe(1)
  })
})

describe('refresh triggers', () => {
  it('fans a debounced trigger out to the registered stores and honors the disposer', async () => {
    const helper = await import('../src/client/settings-refresh.ts')
    const fetchMock = vi.fn(async () => describeResponse({}, 1))
    vi.stubGlobal('fetch', fetchMock)
    // No appliers yet: the fan-out issues no request.
    helper.requestSettingsRefresh()
    await sleep(120)
    expect(describeCalls(fetchMock)).toBe(0)

    const first = vi.fn()
    const second = vi.fn()
    const disposeFirst = helper.registerSettingsRefresh('one', first)
    helper.registerSettingsRefresh('one', second)
    disposeFirst() // does not clear the replacement
    helper.requestSettingsRefresh()
    helper.requestSettingsRefresh() // folds into the same debounce
    await sleep(120)
    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledTimes(1)

    const disposeSecond = helper.registerSettingsRefresh('two', first)
    disposeSecond() // clears its own row
    helper.requestSettingsRefresh()
    await sleep(120)
    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledTimes(2)
  })

  it('a reconnect trigger re-reads the namespace exactly once and applies it', async () => {
    let revision = 1
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      if (methodOf(init) === 'settings.describe') {
        return describeResponse({ personas: { fixer: { provider: 'p', model: revision === 1 ? 'old' : 'new' } } }, revision)
      }
      return mutateOk()
    })
    vi.stubGlobal('fetch', fetchMock)
    const persona = await import('../src/client/persona-store.ts')
    const helper = await import('../src/client/settings-refresh.ts')
    helper.registerSettingsRefresh('persona', persona.refreshFromServer)
    await vi.waitFor(() => {
      expect(persona.getPersonaAssignments().fixer).toEqual({ provider: 'p', model: 'old' })
    })

    const before = describeCalls(fetchMock)
    revision = 2
    helper.handleSettingsReconnect()
    await vi.waitFor(() => {
      expect(persona.getPersonaAssignments().fixer).toEqual({ provider: 'p', model: 'new' })
    })
    // The debounce must not schedule a second read behind the first.
    await sleep(120)
    expect(describeCalls(fetchMock) - before).toBe(1)
  })

  it('another store reading during the debounce does not swallow the trigger', async () => {
    let revision = 1
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      if (methodOf(init) === 'settings.describe') {
        return describeResponse({ personas: { fixer: { provider: 'p', model: revision === 1 ? 'old' : 'new' } } }, revision)
      }
      return mutateOk()
    })
    vi.stubGlobal('fetch', fetchMock)
    const persona = await import('../src/client/persona-store.ts')
    const helper = await import('../src/client/settings-refresh.ts')
    helper.registerSettingsRefresh('persona', persona.refreshFromServer)
    await vi.waitFor(() => {
      expect(persona.getPersonaAssignments().fixer).toBeDefined()
    })

    const before = describeCalls(fetchMock)
    revision = 2
    helper.handleSettingsReconnect()
    // An unrelated store's own read lands inside the debounce window; the
    // trigger must still fan out, or the other stores stay stale.
    await persona.refreshFromServer()
    await sleep(150)
    expect(describeCalls(fetchMock) - before).toBe(2)
    expect(persona.getPersonaAssignments().fixer).toEqual({ provider: 'p', model: 'new' })
  })

  it('becoming visible re-reads at most once per throttle window', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
    const helper = await import('../src/client/settings-refresh.ts')
    let reads = 0
    helper.registerSettingsRefresh('spy', () => { reads += 1 })
    const dispose = helper.installSettingsVisibilityListener()

    setVisibility('hidden')
    document.dispatchEvent(new Event('visibilitychange'))
    await vi.advanceTimersByTimeAsync(60)
    expect(reads).toBe(0)

    setVisibility('visible')
    document.dispatchEvent(new Event('visibilitychange'))
    await vi.advanceTimersByTimeAsync(60)
    expect(reads).toBe(1)

    // Inside the 2s window: ignored.
    document.dispatchEvent(new Event('visibilitychange'))
    await vi.advanceTimersByTimeAsync(60)
    expect(reads).toBe(1)

    // After the window: fires again.
    await vi.advanceTimersByTimeAsync(2_000)
    document.dispatchEvent(new Event('visibilitychange'))
    await vi.advanceTimersByTimeAsync(60)
    expect(reads).toBe(2)

    dispose()
    await vi.advanceTimersByTimeAsync(2_000)
    document.dispatchEvent(new Event('visibilitychange'))
    await vi.advanceTimersByTimeAsync(60)
    expect(reads).toBe(2)
  })

  it('installs nothing and reads no visibility state without a document', async () => {
    const helper = await import('../src/client/settings-refresh.ts')
    vi.stubGlobal('document', undefined)
    const dispose = helper.installSettingsVisibilityListener()
    dispose()
    helper.handleSettingsVisibility()
  })

  it('a mount reuses a fresh cache and re-reads a stale one', async () => {
    const helper = await import('../src/client/settings-refresh.ts')
    const fetchMock = vi.fn(async () => describeResponse({ personas: {} }, 1))
    vi.stubGlobal('fetch', fetchMock)
    helper.registerSettingsRefresh('read', async () => { await helper.readEnpoiNamespace() })

    helper.ensureSettingsFresh(60_000) // nothing read yet: schedules
    await sleep(120)
    expect(describeCalls(fetchMock)).toBe(1)

    helper.ensureSettingsFresh(60_000) // fresh: no request
    await sleep(120)
    expect(describeCalls(fetchMock)).toBe(1)

    helper.ensureSettingsFresh(0) // window closed: schedules
    await sleep(120)
    expect(describeCalls(fetchMock)).toBe(2)
  })

  it('an in-flight optimistic value survives a trigger-driven refresh', async () => {
    let releaseMutate: ((res: Response) => void) | undefined
    const mutateGate = new Promise<Response>((resolve) => { releaseMutate = resolve })
    let revision = 1
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      if (methodOf(init) === 'settings.describe') {
        return describeResponse({ personas: { fixer: { provider: 'p', model: 'old' } } }, revision)
      }
      return mutateGate
    })
    vi.stubGlobal('fetch', fetchMock)
    const persona = await import('../src/client/persona-store.ts')
    const helper = await import('../src/client/settings-refresh.ts')
    helper.registerSettingsRefresh('persona', persona.refreshFromServer)
    await vi.waitFor(() => {
      expect(persona.getPersonaAssignments().fixer).toBeDefined()
    })

    const write = persona.setPersonaAssignment('fixer', { provider: 'p', model: 'optimistic' })
    // The server document still reads the old value when the refresh lands.
    revision = 2
    helper.handleSettingsReconnect()
    await sleep(150)
    expect(persona.getPersonaAssignments().fixer).toEqual({ provider: 'p', model: 'optimistic' })

    releaseMutate?.(mutateOk())
    await expect(write).resolves.toBe(true)
  })
})

describe('unchanged revisions', () => {
  it('a same-revision read does not notify the persona store subscribers', async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      if (methodOf(init) === 'settings.describe') {
        return describeResponse({ personas: { fixer: { provider: 'p', model: 'm' } } }, 1)
      }
      return mutateOk()
    })
    vi.stubGlobal('fetch', fetchMock)
    const persona = await import('../src/client/persona-store.ts')
    await vi.waitFor(() => {
      expect(persona.getPersonaAssignments().fixer).toBeDefined()
    })
    const listener = vi.fn()
    const unsubscribe = persona.subscribePersonaAssignments(listener)

    await persona.refreshFromServer() // same revision: nothing changed
    expect(listener).not.toHaveBeenCalled()

    fetchMock.mockImplementation(async (_url: string, init: RequestInit) => {
      if (methodOf(init) === 'settings.describe') {
        return describeResponse({ personas: { fixer: { provider: 'p', model: 'm2' } } }, 2)
      }
      return mutateOk()
    })
    await persona.refreshFromServer()
    expect(listener).toHaveBeenCalledTimes(1)
    unsubscribe()
  })

  it('a same-revision read does not notify the permissions view subscribers', async () => {
    const fetchMock = vi.fn(async () => describeResponse({ permissions: { tools: { bash: 'ask' } } }, 1))
    vi.stubGlobal('fetch', fetchMock)
    const permissions = await import('../src/client/permissions-model.ts')
    const listener = vi.fn()
    const unsubscribe = permissions.subscribePermissionsView(listener)

    await permissions.refreshFromServer()
    expect(listener).toHaveBeenCalledTimes(1)
    listener.mockClear()

    await permissions.refreshFromServer() // same revision: nothing changed
    expect(listener).not.toHaveBeenCalled()
    unsubscribe()
  })
})
