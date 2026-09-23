// @vitest-environment jsdom
/**
 * The hidden-view preference for the conversation tab roster.
 *
 * The roster filter and the active-view fallback both read the synchronous
 * getter/predicate, so these cases pin the shipped default, the device cache's
 * first paint, the namespace read that supersedes it, and the subscription the
 * view roster re-derives from.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const STORAGE_KEY = 'dsh_hidden_surfaces_views_v1'

/** One describe envelope carrying the given namespaces list. */
function envelope(namespaces: unknown): Response {
  return new Response(JSON.stringify({ result: { ok: true, value: { namespaces } } }), { status: 200 })
}

/** One describe envelope carrying one namespace value. */
function namespace(value: unknown, ns = 'enpoi-orchestration'): Response {
  return envelope([{ ns, value }])
}

/** One namespace value whose `views` list is the given list. */
function withList(list: unknown): unknown {
  return { uiPreferences: { hiddenSurfaces: { views: list } } }
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

/** Load the module freshly, so no test inherits another test's resolved list. */
async function load() {
  return await import('../src/client/hidden-surfaces.ts')
}

beforeEach(() => {
  localStorage.clear()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.resetModules()
})

describe('hidden conversation views', () => {
  it('keeps the shipped default until a namespace value lands', async () => {
    pendingDescribe()
    const mod = await load()
    expect([...mod.getHiddenConversationViews()]).toEqual(['context-lens'])
    expect(mod.isConversationViewHidden('context-lens')).toBe(true)
    expect(mod.isConversationViewHidden('chat')).toBe(false)
    // A second read reuses the published set.
    expect(mod.getHiddenConversationViews()).toBe(mod.getHiddenConversationViews())
  })

  it('serves the cached list before the describe resolves, then adopts the described list', async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(['cached-view']))
    let release!: (response: Response) => void
    const gate = new Promise<Response>((resolve) => { release = resolve })
    const fetchMock = stubDescribe(() => gate)
    const mod = await load()
    expect([...mod.getHiddenConversationViews()]).toEqual(['cached-view'])
    expect(mod.isConversationViewHidden('cached-view')).toBe(true)
    expect(mod.isConversationViewHidden('context-lens')).toBe(false)

    release(namespace(withList(['server-view'])))
    await vi.waitFor(() => { expect(mod.isConversationViewHidden('server-view')).toBe(true) })
    expect(mod.isConversationViewHidden('cached-view')).toBe(false)
    expect(fetchMock).toHaveBeenCalledWith('/api/settings.describe', expect.objectContaining({ method: 'POST' }))
  })

  it('adopts the described list when the cache is empty, skipping other namespaces', async () => {
    stubDescribe(() => envelope([
      { ns: 'some-other', value: withList(['other-view']) },
      { ns: 'enpoi-orchestration', value: withList(['server-view']) },
    ]))
    const mod = await load()
    await vi.waitFor(() => { expect(mod.isConversationViewHidden('server-view')).toBe(true) })
    expect(mod.isConversationViewHidden('other-view')).toBe(false)
    expect(mod.isConversationViewHidden('context-lens')).toBe(false)
  })

  it('treats an explicit empty hiddenSurfaces value as nothing hidden', async () => {
    let value: unknown = { uiPreferences: { hiddenSurfaces: {} } }
    stubDescribe(() => namespace(value))
    const mod = await load()
    await vi.waitFor(() => { expect(mod.getHiddenConversationViews().size).toBe(0) })
    expect(mod.isConversationViewHidden('context-lens')).toBe(false)

    value = withList([])
    await mod.refreshHiddenSurfaces()
    expect(mod.getHiddenConversationViews().size).toBe(0)

    value = withList('not-a-list')
    await mod.refreshHiddenSurfaces()
    expect(mod.getHiddenConversationViews().size).toBe(0)
  })

  it('re-reads the namespace on the document-update path and notifies subscribers per change', async () => {
    let list: string[] = ['first-view']
    stubDescribe(() => namespace(withList(list)))
    const mod = await load()
    await vi.waitFor(() => { expect(mod.isConversationViewHidden('first-view')).toBe(true) })

    const listener = vi.fn()
    const unsubscribe = mod.subscribeHiddenSurfaces(listener)
    list = ['second-view']
    await mod.refreshHiddenSurfaces()
    expect(listener).toHaveBeenCalledTimes(1)
    expect(mod.isConversationViewHidden('second-view')).toBe(true)
    expect(mod.isConversationViewHidden('first-view')).toBe(false)

    // An unchanged re-read publishes nothing.
    await mod.refreshHiddenSurfaces()
    expect(listener).toHaveBeenCalledTimes(1)

    unsubscribe()
    list = ['third-view']
    await mod.refreshHiddenSurfaces()
    expect(listener).toHaveBeenCalledTimes(1)
    expect(mod.isConversationViewHidden('third-view')).toBe(true)
  })

  it('reads the user half when the value half carries no preferences', async () => {
    stubDescribe(() => envelope([
      { ns: 'enpoi-orchestration', value: {}, user: { uiPreferences: { hiddenSurfaces: { views: ['user-view'] } } } },
    ]))
    const mod = await load()
    await vi.waitFor(() => { expect(mod.isConversationViewHidden('user-view')).toBe(true) })
  })

  it('ignores answers without the namespace, without preferences, and with a non-object preference', async () => {
    pendingDescribe()
    const mod = await load()
    const answers: Array<() => Response | Promise<Response>> = [
      () => new Response('null', { status: 200 }),
      () => new Response('{}', { status: 200 }),
      () => new Response(JSON.stringify({ result: {} }), { status: 200 }),
      () => new Response(JSON.stringify({ result: { value: {} } }), { status: 200 }),
      () => new Response(JSON.stringify({ result: { value: { namespaces: 'x' } } }), { status: 200 }),
      () => envelope([{ ns: 'other', value: withList(['other-view']) }]),
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
      await mod.refreshHiddenSurfaces()
      expect([...mod.getHiddenConversationViews()]).toEqual(['context-lens'])
    }
  })

  it('skips the boot read outside a browser realm', async () => {
    const fetchMock = stubDescribe(() => namespace(withList(['server-view'])))
    vi.stubGlobal('window', undefined)
    vi.resetModules()
    const mod = await load()
    expect(fetchMock).not.toHaveBeenCalled()
    expect([...mod.getHiddenConversationViews()]).toEqual(['context-lens'])
  })

  it('falls back to the default when the device store rejects the read', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied') })
    pendingDescribe()
    const mod = await load()
    expect([...mod.getHiddenConversationViews()]).toEqual(['context-lens'])
  })

  it('keeps the live list when the device store rejects the write', async () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('full') })
    stubDescribe(() => namespace(withList(['server-view'])))
    const mod = await load()
    await vi.waitFor(() => { expect(mod.isConversationViewHidden('server-view')).toBe(true) })
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull()
  })

  it('discards a foreign cache payload and keeps only the parsed non-empty strings', async () => {
    for (const payload of ['{', '{}', '"text"', 'null']) {
      localStorage.setItem(STORAGE_KEY, payload)
      pendingDescribe()
      vi.resetModules()
      const mod = await load()
      expect([...mod.getHiddenConversationViews()]).toEqual(['context-lens'])
    }

    localStorage.setItem(STORAGE_KEY, JSON.stringify([3, '', 'kept']))
    pendingDescribe()
    vi.resetModules()
    const mod = await load()
    expect([...mod.getHiddenConversationViews()]).toEqual(['kept'])
    expect(mod.isConversationViewHidden('kept')).toBe(true)
    expect(mod.isConversationViewHidden('context-lens')).toBe(false)
  })
})
