// @vitest-environment jsdom
/**
 * Parity for the shared hidden-surface preference: one factory drives the
 * conversation view partition and the right-sidebar kind partition, which may
 * differ only in cache key, shipped default, and namespace field. The feature
 * packages' own specs pin the wiring; these cases pin the factory contract for
 * every configuration.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createHiddenSurfaces, type HiddenSurfacesConfig,
} from '../src/hidden-surfaces.ts'

const VIEWS: HiddenSurfacesConfig = {
  storageKey: 'dsh_hidden_surfaces_views_v1',
  defaultList: ['context-lens'],
  pick: 'views',
}
const KINDS: HiddenSurfacesConfig = {
  storageKey: 'dsh_hidden_surfaces_sidebar_right_v1',
  defaultList: ['dsh-context'],
  pick: 'sidebarRight',
}
const PARTITIONS = [['views', VIEWS], ['sidebarRight', KINDS]] as const

/** One describe envelope carrying the given namespaces list. */
function envelope(namespaces: unknown): Response {
  return new Response(JSON.stringify({ result: { ok: true, value: { namespaces } } }), { status: 200 })
}

/** One describe envelope carrying one namespace value. */
function namespace(value: unknown, ns = 'enpoi-orchestration'): Response {
  return envelope([{ ns, value }])
}

/** One namespace value whose partition list is the given list. */
function withList(config: HiddenSurfacesConfig, list: unknown): unknown {
  return { uiPreferences: { hiddenSurfaces: { [config.pick]: list } } }
}

/** Serve one response per describe call from `responder`; a promise gates the answer. */
function stubDescribe(responder: () => Response | Promise<Response>): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(() => Promise.resolve(responder()))
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

/** A describe answer that never arrives, so the cache or the default stays in force. */
function pendingDescribe(): void {
  stubDescribe(() => new Promise<Response>(() => {}))
}

beforeEach(() => {
  localStorage.clear()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe.each(PARTITIONS)('hidden surfaces partition %s', (_name, config) => {
  const [defaultId] = config.defaultList

  it('keeps the shipped default until a namespace value lands', () => {
    pendingDescribe()
    const surfaces = createHiddenSurfaces(config)
    expect([...surfaces.getHidden()]).toEqual([...config.defaultList])
    expect(surfaces.isHidden(defaultId!)).toBe(true)
    expect(surfaces.isHidden('unrelated')).toBe(false)
    // A second read reuses the published set.
    expect(surfaces.getHidden()).toBe(surfaces.getHidden())
  })

  it('serves the cached list before the describe resolves, then adopts the described list', async () => {
    localStorage.setItem(config.storageKey, JSON.stringify(['cached-entry']))
    let release!: (response: Response) => void
    const gate = new Promise<Response>((resolve) => { release = resolve })
    const fetchMock = stubDescribe(() => gate)
    const surfaces = createHiddenSurfaces(config)
    const refresh = surfaces.refreshHiddenSurfaces()
    expect([...surfaces.getHidden()]).toEqual(['cached-entry'])
    expect(surfaces.isHidden('cached-entry')).toBe(true)
    expect(surfaces.isHidden(defaultId!)).toBe(false)

    release(namespace(withList(config, ['server-entry'])))
    await refresh
    expect(surfaces.isHidden('server-entry')).toBe(true)
    expect(surfaces.isHidden('cached-entry')).toBe(false)
    expect(fetchMock).toHaveBeenCalledWith('/api/settings.describe', expect.objectContaining({ method: 'POST' }))
  })

  it('treats an explicit empty list as nothing hidden and a foreign value as no update', async () => {
    let value: unknown = { uiPreferences: { hiddenSurfaces: {} } }
    stubDescribe(() => namespace(value))
    const surfaces = createHiddenSurfaces(config)
    await surfaces.refreshHiddenSurfaces()
    expect(surfaces.getHidden().size).toBe(0)
    expect(surfaces.isHidden(defaultId!)).toBe(false)

    value = withList(config, ['kept-entry'])
    await surfaces.refreshHiddenSurfaces()
    expect([...surfaces.getHidden()]).toEqual(['kept-entry'])

    // A present-but-foreign value keeps the last snapshot instead of un-hiding.
    value = withList(config, 'not-a-list')
    await surfaces.refreshHiddenSurfaces()
    expect([...surfaces.getHidden()]).toEqual(['kept-entry'])
    value = withList(config, [3, ''])
    await surfaces.refreshHiddenSurfaces()
    expect([...surfaces.getHidden()]).toEqual(['kept-entry'])

    // Only the parsed non-empty strings survive a mixed payload.
    value = withList(config, [3, '', 'parsed-entry'])
    await surfaces.refreshHiddenSurfaces()
    expect([...surfaces.getHidden()]).toEqual(['parsed-entry'])
  })

  it('reads the user half when the value half carries no preferences', async () => {
    stubDescribe(() => envelope([
      { ns: 'enpoi-orchestration', value: {}, user: withList(config, ['user-entry']) },
    ]))
    const surfaces = createHiddenSurfaces(config)
    await surfaces.refreshHiddenSurfaces()
    expect(surfaces.isHidden('user-entry')).toBe(true)
  })

  it('notifies subscribers per change only, across partitions independently', async () => {
    let value: unknown = withList(config, ['first-entry'])
    stubDescribe(() => namespace(value))
    const surfaces = createHiddenSurfaces(config)
    await surfaces.refreshHiddenSurfaces()
    expect(surfaces.isHidden('first-entry')).toBe(true)

    const listener = vi.fn()
    const unsubscribe = surfaces.subscribeHiddenSurfaces(listener)
    value = withList(config, ['second-entry'])
    await surfaces.refreshHiddenSurfaces()
    expect(listener).toHaveBeenCalledTimes(1)
    expect(surfaces.isHidden('second-entry')).toBe(true)

    // An unchanged re-read publishes nothing.
    await surfaces.refreshHiddenSurfaces()
    expect(listener).toHaveBeenCalledTimes(1)

    unsubscribe()
    value = withList(config, ['third-entry'])
    await surfaces.refreshHiddenSurfaces()
    expect(listener).toHaveBeenCalledTimes(1)
    expect(surfaces.isHidden('third-entry')).toBe(true)
  })

  it('keeps only the newest answer when two refreshes overlap', async () => {
    const gates: Array<(response: Response) => void> = []
    stubDescribe(() => new Promise<Response>((resolve) => { gates.push(resolve) }))
    const surfaces = createHiddenSurfaces(config)
    const first = surfaces.refreshHiddenSurfaces()
    const second = surfaces.refreshHiddenSurfaces()
    gates[1]!(namespace(withList(config, ['newer-entry'])))
    await second
    gates[0]!(namespace(withList(config, ['older-entry'])))
    await first
    expect(surfaces.isHidden('newer-entry')).toBe(true)
    expect(surfaces.isHidden('older-entry')).toBe(false)
  })

  it('ignores answers without the namespace, without preferences, and with a non-object preference', async () => {
    const surfaces = createHiddenSurfaces(config)
    const answers: Array<() => Response | Promise<Response>> = [
      () => new Response('null', { status: 200 }),
      () => new Response('{}', { status: 200 }),
      () => new Response(JSON.stringify({ result: {} }), { status: 200 }),
      () => new Response(JSON.stringify({ result: { value: {} } }), { status: 200 }),
      () => new Response(JSON.stringify({ result: { value: { namespaces: 'x' } } }), { status: 200 }),
      () => envelope([{ ns: 'other', value: withList(config, ['other-entry']) }]),
      () => new Response(JSON.stringify({ result: { value: { namespaces: [{ ns: 'enpoi-orchestration' }] } } }), { status: 200 }),
      () => namespace({ uiPreferences: {} }),
      () => namespace({ uiPreferences: { hiddenSurfaces: null } }),
      () => namespace({ uiPreferences: { hiddenSurfaces: 'nope' } }),
      () => new Response('not-json', { status: 200 }),
      () => new Response('gone', { status: 503 }),
      () => Promise.reject<Response>(new Error('offline')),
    ]
    for (const answer of answers) {
      stubDescribe(answer)
      await surfaces.refreshHiddenSurfaces()
      expect([...surfaces.getHidden()]).toEqual([...config.defaultList])
    }
  })

  it('discards a foreign cache payload and keeps only the parsed non-empty strings', () => {
    pendingDescribe()
    for (const payload of ['{', '{}', '"text"', 'null', '[3,""]']) {
      localStorage.setItem(config.storageKey, payload)
      const surfaces = createHiddenSurfaces(config)
      expect([...surfaces.getHidden()]).toEqual([...config.defaultList])
    }

    localStorage.setItem(config.storageKey, JSON.stringify([3, '', 'kept']))
    const surfaces = createHiddenSurfaces(config)
    expect([...surfaces.getHidden()]).toEqual(['kept'])
    expect(surfaces.isHidden('kept')).toBe(true)
    expect(surfaces.isHidden(defaultId!)).toBe(false)
  })

  it('falls back to the default when the device store rejects the read', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied') })
    pendingDescribe()
    const surfaces = createHiddenSurfaces(config)
    expect([...surfaces.getHidden()]).toEqual([...config.defaultList])
  })

  it('keeps the live list when the device store rejects the write', async () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('full') })
    stubDescribe(() => namespace(withList(config, ['server-entry'])))
    const surfaces = createHiddenSurfaces(config)
    await surfaces.refreshHiddenSurfaces()
    expect(surfaces.isHidden('server-entry')).toBe(true)
    expect(localStorage.getItem(config.storageKey)).toBeNull()
  })
})

describe('hidden surfaces shared describe', () => {
  it('reads through the shared coalesced describe without fetching', async () => {
    const shared = vi.fn(async () => ({
      namespaces: [{ ns: 'enpoi-orchestration', value: withList(VIEWS, ['shared-entry']) }],
    }))
    const fetchMock = stubDescribe(() => namespace(withList(VIEWS, ['fetch-entry'])))
    vi.stubGlobal('__dshSettingsDescribe', shared)
    const surfaces = createHiddenSurfaces(VIEWS)
    await surfaces.refreshHiddenSurfaces()
    expect(surfaces.isHidden('shared-entry')).toBe(true)
    expect(shared).toHaveBeenCalledTimes(1)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('keeps the default when the shared describe answers nothing', async () => {
    vi.stubGlobal('__dshSettingsDescribe', vi.fn(async () => undefined))
    const surfaces = createHiddenSurfaces(KINDS)
    await surfaces.refreshHiddenSurfaces()
    expect([...surfaces.getHidden()]).toEqual(['dsh-context'])
  })
})
