/**
 * Skin-center boot/resource lifecycle guards.
 *
 * The bundle under test is the installed `lib/client.js`, i.e. the artifact
 * `pnpm install` produces from the committed patch. The spec is skipped only
 * when the package is absent (a partial profile checkout).
 *
 * Guards:
 * - transient catalog/stylesheet failures keep the server-stamped DOM and
 *   never persist a boot choice;
 * - one shared stylesheet request per href, with the exact returned node and
 *   reference-counted teardown;
 * - a user choice epoch prevents a late boot `/active` response from
 *   resurrecting a skin after the user picked stock or another skin;
 * - permanent failures stop retrying, transport failures are bounded, and
 *   online/visibility/manual events can re-arm recovery while visible;
 * - catalog refreshes are single-flight with a generation so a late response
 *   cannot replace a newer one;
 * - shutdown removes listeners/timers and late applied events cannot mutate the
 *   document.
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

import { JSDOM } from 'jsdom'
import { afterEach, describe, expect, it, vi } from 'vitest'

const PROFILE = join(dirname(fileURLToPath(import.meta.url)), '..')
const PACKAGE_DIR = join(PROFILE, 'node_modules/@linxin666/dsh-client-ui-skin-center')
const BUNDLE = join(PACKAGE_DIR, 'lib/client.js')
const SKIN_ID = 'summer-liquid-glass'
const OTHER_ID = 'blue-fantasy'
const API = '/api/skin-center/v2'
const href = (id: string, part: 'stylesheet' | 'patches') => `${API}/skins/${id}/${part}`

interface SkinStore {
  readonly active: string | null
  readonly controller: {
    readonly active: string | null
    readonly layers: { background: HTMLElement }
    readonly choiceEpoch: number
    switchTo(id: string | null, entry: unknown): Promise<string | null>
    tryOn(id: string, entry: unknown): Promise<string | null>
    exitTryOn(): Promise<string | null>
  }
  catalog(): Array<{ manifest: { id: string } }> | null
  find(id: string): { manifest: { id: string; facets?: unknown } } | null
  refreshCatalog(force?: boolean): Promise<unknown>
  retryBoot(): boolean
  shutdown(): void
}

interface BundleExports {
  bootSkinRuntime(options: {
    doc: Document
    apiBase: string
    fetchImpl: (url: string, init?: { method?: string; body?: string }) => Promise<unknown>
    loadStylesheet?: (href: string) => Promise<unknown>
    importHooks?: (url: string) => Promise<{ default?: () => { apply(): void; dispose?(): void } }>
  }): SkinStore
}

interface Loaded {
  dom: JSDOM
  exports: BundleExports
}

const savedGlobals = new Map<string, PropertyDescriptor | undefined>()

function setGlobal(name: string, value: unknown): void {
  if (!savedGlobals.has(name)) savedGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true, enumerable: false })
}

function silenceLogs(): void {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
}

function load(options: { sheets?: boolean; stamped?: string | null } = {}): Loaded | null {
  if (!existsSync(BUNDLE)) return null
  const stamped = options.stamped === undefined ? SKIN_ID : options.stamped
  const links = stamped === null
    ? ''
    : `<link rel="stylesheet" href="${href(stamped, 'stylesheet')}" data-dsh-skin-link="stylesheet">
<link rel="stylesheet" href="${href(stamped, 'patches')}" data-dsh-skin-link="patches">`
  const dom = new JSDOM(`<!doctype html><html${stamped === null ? '' : ` data-dsh-skin="${stamped}"`}><head>${links}</head><body><div id="root"></div></body></html>`, {
    url: 'https://example.test/',
    pretendToBeVisual: true,
  })
  const win = dom.window
  class FakeResizeObserver { observe(): void {} unobserve(): void {} disconnect(): void {} }
  for (const name of ['window', 'document', 'MutationObserver', 'HTMLElement', 'Element', 'Node', 'localStorage']) {
    setGlobal(name, win[name as keyof Window] ?? win)
  }
  setGlobal('window', win)
  setGlobal('document', win.document)
  setGlobal('MutationObserver', win.MutationObserver)
  setGlobal('HTMLElement', win.HTMLElement)
  setGlobal('Element', win.Element)
  setGlobal('Node', win.Node)
  setGlobal('ResizeObserver', FakeResizeObserver)
  setGlobal('requestAnimationFrame', (callback: () => void) => setTimeout(callback, 0))
  setGlobal('cancelAnimationFrame', (id: number) => clearTimeout(id))
  Reflect.set(win, 'ResizeObserver', FakeResizeObserver)
  Reflect.set(win, 'scrollTo', () => {})
  Reflect.set(win, 'requestAnimationFrame', globalThis.requestAnimationFrame)
  Reflect.set(win, 'cancelAnimationFrame', globalThis.cancelAnimationFrame)
  if (options.sheets !== false) {
    for (const link of win.document.querySelectorAll('link[data-dsh-skin-link]')) {
      Object.defineProperty(link, 'sheet', { value: {}, configurable: true })
    }
  }
  let loaded: BundleExports | null = null
  Reflect.set(win, '__ModuleLoader__', {
    load: (entry: { factory: (request: (specifier: string) => Record<string, unknown>) => BundleExports }) => {
      loaded = entry.factory(() => ({}))
    },
  })
  vm.runInThisContext(readFileSync(BUNDLE, 'utf8'), { filename: 'skin-center-client.js' })
  if (loaded === null) throw new Error('skin-center bundle did not register with the module loader')
  return { dom, exports: loaded }
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void } {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

function manifest(id: string, hooks = false): unknown {
  return {
    manifest: {
      id,
      contributes: { stylesheet: 'skin.css', patches: 'patches.css' },
      ...(hooks ? { facets: { client: {} } } : {}),
    },
  }
}

function body(ids: string[], hooks: string[] = []): unknown {
  return { ok: true, skins: ids.map(id => manifest(id, hooks.includes(id))), diagnostics: [] }
}

function response(status: number, payload: unknown): unknown {
  return { ok: status >= 200 && status < 300, status, json: async () => payload }
}

function active(id: string | null): unknown {
  return response(200, { ok: true, active: id })
}

function addPreloaded(doc: Document, id: string): void {
  for (const part of ['stylesheet', 'patches'] as const) {
    const link = doc.createElement('link')
    link.rel = 'stylesheet'
    link.href = href(id, part)
    link.setAttribute('data-dsh-skin-link', part)
    Object.defineProperty(link, 'sheet', { value: {}, configurable: true })
    doc.head.append(link)
  }
}

function fastLoader(doc: Document): (value: string) => Promise<Element> {
  return async (value) => {
    const existing = [...doc.head.querySelectorAll('link[rel="stylesheet"]')]
      .find(link => link.getAttribute('href') === value && link.sheet != null)
    if (existing !== undefined) return existing
    const link = doc.createElement('link')
    link.rel = 'stylesheet'
    link.href = value
    doc.head.append(link)
    return link
  }
}

function linkSnapshot(doc: Document): string[] {
  return [...doc.head.querySelectorAll('link[rel="stylesheet"]')]
    .map(link => link.getAttribute('href') ?? '')
    .sort()
}

function cssLinks(doc: Document, value: string): Element[] {
  return [...doc.head.querySelectorAll('link[rel="stylesheet"]')]
    .filter(link => link.getAttribute('href') === value)
}

async function boot(
  loaded: Loaded,
  fetchImpl: (url: string, init?: { method?: string; body?: string }) => Promise<unknown>,
  extra: { loadStylesheet?: (href: string) => Promise<unknown>; importHooks?: (url: string) => Promise<{ default?: () => { apply(): void; dispose?(): void } }> } = {},
): Promise<SkinStore> {
  return loaded.exports.bootSkinRuntime({
    doc: loaded.dom.window.document,
    apiBase: API,
    fetchImpl,
    ...extra,
  })
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  for (const [name, descriptor] of savedGlobals) {
    if (descriptor === undefined) Reflect.deleteProperty(globalThis, name)
    else Object.defineProperty(globalThis, name, descriptor)
  }
  savedGlobals.clear()
})

describe('skin-center boot resilience', () => {
  it('keeps the last skin across a catalog failure, never persists boot, and recovers without reload', async () => {
    const loaded = load()
    if (loaded === null) return
    vi.useFakeTimers()
    silenceLogs()
    const posts: Array<{ active?: unknown }> = []
    let catalogCalls = 0
    const store = await boot(loaded, async (url, init = {}) => {
      if (init.method === 'POST') {
        posts.push(JSON.parse(init.body ?? '{}') as { active?: unknown })
        return active(SKIN_ID)
      }
      if (url.endsWith('/catalog')) {
        catalogCalls += 1
        if (catalogCalls === 1) throw new Error('catalog transport still waking')
        return response(200, body([SKIN_ID]))
      }
      if (url.endsWith('/active')) return active(SKIN_ID)
      throw new Error(`unexpected fetch ${url}`)
    })
    try {
      await vi.advanceTimersByTimeAsync(0)
      expect(loaded.dom.window.document.documentElement.getAttribute('data-dsh-skin')).toBe(SKIN_ID)
      expect(linkSnapshot(loaded.dom.window.document)).toEqual([href(SKIN_ID, 'patches'), href(SKIN_ID, 'stylesheet')].sort())
      expect(posts).toEqual([])

      await vi.advanceTimersByTimeAsync(1_000)
      expect(loaded.dom.window.document.documentElement.getAttribute('data-dsh-skin')).toBe(SKIN_ID)
      expect(linkSnapshot(loaded.dom.window.document)).toEqual([href(SKIN_ID, 'patches'), href(SKIN_ID, 'stylesheet')].sort())
      expect(posts).toEqual([])
      expect(store.controller.active).toBe(SKIN_ID)
    } finally {
      store.shutdown()
      loaded.dom.window.close()
    }
  })

  it.each([
    ['stylesheet', 1],
    ['patches', 2],
  ] as const)('keeps preloaded nodes across a transient %s failure and swaps atomically without persisting', async (label, failAt) => {
    const loaded = load({ sheets: false })
    if (loaded === null) return
    vi.useFakeTimers()
    silenceLogs()
    const doc = loaded.dom.window.document
    const posts: Array<{ active?: unknown }> = []
    let cssCalls = 0
    const store = await boot(loaded, async (url, init = {}) => {
      if (init.method === 'POST') {
        posts.push(JSON.parse(init.body ?? '{}') as { active?: unknown })
        return active(SKIN_ID)
      }
      if (url.endsWith('/catalog')) return response(200, body([SKIN_ID]))
      if (url.endsWith('/active')) return active(SKIN_ID)
      throw new Error(`unexpected fetch ${url}`)
    }, {
      loadStylesheet: async (value) => {
        cssCalls += 1
        if (cssCalls === failAt) throw new Error(`${label} transport still waking`)
        const link = doc.createElement('link')
        link.rel = 'stylesheet'
        link.href = value
        doc.head.append(link)
        return link
      },
    })
    try {
      await vi.advanceTimersByTimeAsync(0)
      expect(doc.documentElement.getAttribute('data-dsh-skin')).toBe(SKIN_ID)
      expect(linkSnapshot(doc)).toEqual([href(SKIN_ID, 'patches'), href(SKIN_ID, 'stylesheet')].sort())
      expect(cssLinks(doc, href(SKIN_ID, 'stylesheet')).every(node => !node.hasAttribute('data-dsh-skin-ready'))).toBe(true)
      expect(posts).toEqual([])

      await vi.advanceTimersByTimeAsync(1_000)
      expect(doc.documentElement.getAttribute('data-dsh-skin')).toBe(SKIN_ID)
      expect(cssLinks(doc, href(SKIN_ID, 'stylesheet'))).toHaveLength(1)
      expect(cssLinks(doc, href(SKIN_ID, 'patches'))).toHaveLength(1)
      expect(cssLinks(doc, href(SKIN_ID, 'stylesheet'))[0]?.hasAttribute('data-dsh-skin-ready')).toBe(true)
      expect(cssLinks(doc, href(SKIN_ID, 'patches'))[0]?.hasAttribute('data-dsh-skin-ready')).toBe(true)
      expect(posts).toEqual([])
    } finally {
      store.shutdown()
      loaded.dom.window.close()
    }
  })

  it('shares one stylesheet flight per href for concurrent activations and keeps the winning node', async () => {
    const loaded = load({ stamped: null })
    if (loaded === null) return
    vi.useFakeTimers()
    silenceLogs()
    const doc = loaded.dom.window.document
    const stylesheet = deferred<unknown>()
    let loads = 0
    let fetchCalls = 0
    const store = await boot(loaded, async (url) => {
      if (url.endsWith('/catalog')) return response(200, body([SKIN_ID]))
      if (url.endsWith('/active')) return active(null)
      fetchCalls += 1
      throw new Error(`unexpected fetch ${url}`)
    }, {
      loadStylesheet: (value) => {
        loads += 1
        if (value.endsWith('/stylesheet')) return stylesheet.promise
        const link = doc.createElement('link')
        link.rel = 'stylesheet'
        link.href = value
        doc.head.append(link)
        return Promise.resolve(link)
      },
    })
    try {
      await vi.advanceTimersByTimeAsync(0)
      const entry = store.find(SKIN_ID)
      expect(entry).not.toBeNull()
      const first = store.controller.switchTo(SKIN_ID, entry)
      const second = store.controller.switchTo(SKIN_ID, entry)
      await vi.advanceTimersByTimeAsync(0)
      expect(loads).toBe(1) // both activations share one stylesheet flight
      const link = doc.createElement('link')
      link.rel = 'stylesheet'
      link.href = href(SKIN_ID, 'stylesheet')
      doc.head.append(link)
      stylesheet.resolve(link)
      await Promise.all([first, second])
      expect(loads).toBe(2) // stylesheet once, then one shared patches load
      expect(doc.documentElement.getAttribute('data-dsh-skin')).toBe(SKIN_ID)
      expect(doc.head.querySelectorAll(`link[href="${href(SKIN_ID, 'stylesheet')}"]`)).toHaveLength(1)
      expect(fetchCalls).toBe(0)
    } finally {
      store.shutdown()
      loaded.dom.window.close()
    }
  })

  it('does not let a late losing activation remove the winning CSS nodes', async () => {
    const loaded = load({ stamped: null })
    if (loaded === null) return
    vi.useFakeTimers()
    silenceLogs()
    const doc = loaded.dom.window.document
    const aLoad = deferred<unknown>()
    const bLoad = deferred<unknown>()
    const store = await boot(loaded, async (url) => {
      if (url.endsWith('/catalog')) return response(200, body([SKIN_ID, OTHER_ID]))
      if (url.endsWith('/active')) return active(null)
      throw new Error(`unexpected fetch ${url}`)
    }, {
      loadStylesheet: (value) => {
        if (value === href(SKIN_ID, 'stylesheet')) return aLoad.promise
        if (value === href(OTHER_ID, 'stylesheet')) return bLoad.promise
        const link = doc.createElement('link')
        link.rel = 'stylesheet'
        link.href = value
        doc.head.append(link)
        return Promise.resolve(link)
      },
    })
    try {
      await vi.advanceTimersByTimeAsync(0)
      const aEntry = store.find(SKIN_ID)
      const bEntry = store.find(OTHER_ID)
      expect(aEntry).not.toBeNull()
      expect(bEntry).not.toBeNull()
      const a = store.controller.switchTo(SKIN_ID, aEntry)
      const b = store.controller.switchTo(OTHER_ID, bEntry)
      await vi.advanceTimersByTimeAsync(0)

      const bLink = doc.createElement('link')
      bLink.rel = 'stylesheet'
      bLink.href = href(OTHER_ID, 'stylesheet')
      doc.head.append(bLink)
      bLoad.resolve(bLink)
      await b
      expect(doc.documentElement.getAttribute('data-dsh-skin')).toBe(OTHER_ID)
      expect(cssLinks(doc, href(OTHER_ID, 'stylesheet'))).toHaveLength(1)

      const aLink = doc.createElement('link')
      aLink.rel = 'stylesheet'
      aLink.href = href(SKIN_ID, 'stylesheet')
      doc.head.append(aLink)
      aLoad.resolve(aLink)
      await a
      expect(doc.documentElement.getAttribute('data-dsh-skin')).toBe(OTHER_ID)
      expect(cssLinks(doc, href(OTHER_ID, 'stylesheet'))).toHaveLength(1)
      expect(cssLinks(doc, href(OTHER_ID, 'patches'))).toHaveLength(1)
      expect(cssLinks(doc, href(SKIN_ID, 'stylesheet'))).toHaveLength(0)
      expect(cssLinks(doc, href(SKIN_ID, 'patches'))).toHaveLength(0)
    } finally {
      store.shutdown()
      loaded.dom.window.close()
    }
  })

  it('keeps the previous skin when a new activation hook throws, with zero orphan links', async () => {
    const loaded = load()
    if (loaded === null) return
    vi.useFakeTimers()
    silenceLogs()
    const doc = loaded.dom.window.document
    const store = await boot(loaded, async (url, init = {}) => {
      if (init.method === 'POST') return active(SKIN_ID)
      if (url.endsWith('/catalog')) return response(200, body([SKIN_ID, OTHER_ID], [OTHER_ID]))
      if (url.endsWith('/active')) return active(SKIN_ID)
      throw new Error(`unexpected fetch ${url}`)
    }, {
      loadStylesheet: async (value) => {
        if (cssLinks(doc, value).some(node => node.sheet != null)) return cssLinks(doc, value).find(node => node.sheet != null)
        const link = doc.createElement('link')
        link.rel = 'stylesheet'
        link.href = value
        doc.head.append(link)
        return link
      },
      importHooks: async () => ({ default: () => ({ apply(): void { throw new Error('hook boom') } }) }),
    })
    try {
      await vi.advanceTimersByTimeAsync(0)
      expect(doc.documentElement.getAttribute('data-dsh-skin')).toBe(SKIN_ID)
      const before = linkSnapshot(doc)
      const entry = store.find(OTHER_ID)
      expect(entry).not.toBeNull()
      await store.controller.switchTo(OTHER_ID, entry)
      expect(doc.documentElement.getAttribute('data-dsh-skin')).toBe(SKIN_ID)
      expect(linkSnapshot(doc)).toEqual(before)
      expect(cssLinks(doc, href(OTHER_ID, 'stylesheet'))).toHaveLength(0)
      expect(cssLinks(doc, href(OTHER_ID, 'patches'))).toHaveLength(0)
    } finally {
      store.shutdown()
      loaded.dom.window.close()
    }
  })

  it('removes stamped preload links after a committed hydration is replaced', async () => {
    const loaded = load()
    if (loaded === null) return
    vi.useFakeTimers()
    silenceLogs()
    const doc = loaded.dom.window.document
    const store = await boot(loaded, async (url) => {
      if (url.endsWith('/catalog')) return response(200, body([SKIN_ID, OTHER_ID]))
      if (url.endsWith('/active')) return active(SKIN_ID)
      throw new Error(`unexpected fetch ${url}`)
    }, { loadStylesheet: fastLoader(doc) })
    try {
      await vi.advanceTimersByTimeAsync(0)
      expect(store.controller.active).toBe(SKIN_ID)
      expect(cssLinks(doc, href(SKIN_ID, 'stylesheet'))).toHaveLength(1)
      const entry = store.find(OTHER_ID)
      expect(entry).not.toBeNull()
      await store.controller.switchTo(OTHER_ID, entry)
      expect(store.controller.active).toBe(OTHER_ID)
      expect(cssLinks(doc, href(SKIN_ID, 'stylesheet'))).toHaveLength(0)
      expect(cssLinks(doc, href(SKIN_ID, 'patches'))).toHaveLength(0)
      expect(cssLinks(doc, href(OTHER_ID, 'stylesheet'))).toHaveLength(1)
      expect(cssLinks(doc, href(OTHER_ID, 'patches'))).toHaveLength(1)
    } finally {
      store.shutdown()
      loaded.dom.window.close()
    }
  })

  it('keeps a borrowed preload when its attempt is abandoned before commit', async () => {
    const loaded = load({ stamped: null })
    if (loaded === null) return
    vi.useFakeTimers()
    silenceLogs()
    const doc = loaded.dom.window.document
    addPreloaded(doc, SKIN_ID)
    const store = await boot(loaded, async (url) => {
      if (url.endsWith('/catalog')) return response(200, body([SKIN_ID]))
      if (url.endsWith('/active')) return active(null)
      throw new Error(`unexpected fetch ${url}`)
    })
    try {
      await vi.advanceTimersByTimeAsync(0)
      const entry = store.find(SKIN_ID)
      expect(entry).not.toBeNull()
      const abandoned = store.controller.tryOn(SKIN_ID, entry)
      await store.controller.switchTo(null, null)
      await abandoned
      expect(store.controller.active).toBeNull()
      expect(cssLinks(doc, href(SKIN_ID, 'stylesheet'))).toHaveLength(1)
      expect(cssLinks(doc, href(SKIN_ID, 'patches'))).toHaveLength(1)
    } finally {
      store.shutdown()
      loaded.dom.window.close()
    }
  })

  it('transfers a shared borrowed preload to the concurrent winner and removes it later', async () => {
    const loaded = load({ stamped: null })
    if (loaded === null) return
    vi.useFakeTimers()
    silenceLogs()
    const doc = loaded.dom.window.document
    addPreloaded(doc, SKIN_ID)
    const store = await boot(loaded, async (url) => {
      if (url.endsWith('/catalog')) return response(200, body([SKIN_ID]))
      if (url.endsWith('/active')) return active(null)
      throw new Error(`unexpected fetch ${url}`)
    })
    try {
      await vi.advanceTimersByTimeAsync(0)
      const entry = store.find(SKIN_ID)
      expect(entry).not.toBeNull()
      const first = store.controller.switchTo(SKIN_ID, entry)
      const second = store.controller.switchTo(SKIN_ID, entry)
      await Promise.all([first, second])
      expect(store.controller.active).toBe(SKIN_ID)
      expect(cssLinks(doc, href(SKIN_ID, 'stylesheet'))).toHaveLength(1)
      expect(cssLinks(doc, href(SKIN_ID, 'patches'))).toHaveLength(1)
      await store.controller.switchTo(null, null)
      expect(cssLinks(doc, href(SKIN_ID, 'stylesheet'))).toHaveLength(0)
      expect(cssLinks(doc, href(SKIN_ID, 'patches'))).toHaveLength(0)
    } finally {
      store.shutdown()
      loaded.dom.window.close()
    }
  })

  it('rolls back a failed activation background without touching the previous skin', async () => {
    const loaded = load()
    if (loaded === null) return
    vi.useFakeTimers()
    silenceLogs()
    const doc = loaded.dom.window.document
    const withBackground = {
      manifest: {
        id: OTHER_ID,
        contributes: {
          stylesheet: 'skin.css',
          patches: 'patches.css',
          backgroundMedia: { light: { type: 'image', src: 'bg.png' } },
        },
        facets: { client: {} },
      },
    }
    const store = await boot(loaded, async (url, init = {}) => {
      if (init.method === 'POST') return active(SKIN_ID)
      if (url.endsWith('/catalog')) return response(200, { ok: true, skins: [manifest(SKIN_ID), withBackground], diagnostics: [] })
      if (url.endsWith('/active')) return active(SKIN_ID)
      throw new Error(`unexpected fetch ${url}`)
    }, {
      loadStylesheet: fastLoader(doc),
      importHooks: async () => ({ default: () => ({ apply(): void { throw new Error('hook boom') } }) }),
    })
    try {
      await vi.advanceTimersByTimeAsync(0)
      expect(store.controller.layers.background.childElementCount).toBe(0)
      const entry = store.find(OTHER_ID)
      expect(entry).not.toBeNull()
      await store.controller.switchTo(OTHER_ID, entry)
      expect(doc.documentElement.getAttribute('data-dsh-skin')).toBe(SKIN_ID)
      expect(store.controller.layers.background.childElementCount).toBe(0)
      expect(doc.body.style.getPropertyValue('background-color')).not.toBe('transparent')
    } finally {
      store.shutdown()
      loaded.dom.window.close()
    }
  })

  it('does not persist a boot hydration value', async () => {
    const loaded = load({ stamped: null })
    if (loaded === null) return
    vi.useFakeTimers()
    silenceLogs()
    const posts: unknown[] = []
    const store = await boot(loaded, async (url, init = {}) => {
      if (init.method === 'POST') {
        posts.push(init.body)
        return active(SKIN_ID)
      }
      if (url.endsWith('/catalog')) return response(200, body([SKIN_ID]))
      if (url.endsWith('/active')) return active(SKIN_ID)
      throw new Error(`unexpected fetch ${url}`)
    }, { loadStylesheet: fastLoader(loaded.dom.window.document) })
    try {
      await vi.advanceTimersByTimeAsync(0)
      expect(loaded.dom.window.document.documentElement.getAttribute('data-dsh-skin')).toBe(SKIN_ID)
      expect(posts).toEqual([])
    } finally {
      store.shutdown()
      loaded.dom.window.close()
    }
  })

  it('ignores a late authoritative active after the user chose stock and another skin', async () => {
    const loaded = load({ stamped: null })
    if (loaded === null) return
    vi.useFakeTimers()
    silenceLogs()
    const doc = loaded.dom.window.document
    const authoritative = deferred<unknown>()
    let activeRequested = false
    const posts: Array<{ active?: unknown }> = []
    const store = await boot(loaded, async (url, init = {}) => {
      if (init.method === 'POST') {
        posts.push(JSON.parse(init.body ?? '{}') as { active?: unknown })
        return active(SKIN_ID)
      }
      if (url.endsWith('/catalog')) return response(200, body([SKIN_ID, OTHER_ID]))
      if (url.endsWith('/active')) {
        activeRequested = true
        return authoritative.promise
      }
      throw new Error(`unexpected fetch ${url}`)
    }, { loadStylesheet: fastLoader(loaded.dom.window.document) })
    try {
      await vi.advanceTimersByTimeAsync(0)
      expect(activeRequested).toBe(true)
      const entry = store.find(OTHER_ID)
      expect(entry).not.toBeNull()

      await store.controller.switchTo(null, null)
      await store.controller.switchTo(OTHER_ID, entry)
      expect(doc.documentElement.getAttribute('data-dsh-skin')).toBe(OTHER_ID)

      authoritative.resolve(active(SKIN_ID))
      await vi.advanceTimersByTimeAsync(0)
      expect(doc.documentElement.getAttribute('data-dsh-skin')).toBe(OTHER_ID)
      expect(store.controller.active).toBe(OTHER_ID)
      expect(posts).toEqual([{ active: null }, { active: OTHER_ID }])
    } finally {
      store.shutdown()
      loaded.dom.window.close()
    }
  })

  it('stops permanently on a catalog 404 and keeps the stamped skin with no retry churn', async () => {
    const loaded = load()
    if (loaded === null) return
    vi.useFakeTimers()
    silenceLogs()
    let catalogCalls = 0
    const store = await boot(loaded, async (url) => {
      if (url.endsWith('/catalog')) {
        catalogCalls += 1
        return response(404, { ok: false })
      }
      throw new Error(`unexpected fetch ${url}`)
    })
    try {
      await vi.advanceTimersByTimeAsync(0)
      expect(catalogCalls).toBe(1)
      expect(loaded.dom.window.document.documentElement.getAttribute('data-dsh-skin')).toBe(SKIN_ID)
      expect(linkSnapshot(loaded.dom.window.document)).toEqual([href(SKIN_ID, 'patches'), href(SKIN_ID, 'stylesheet')].sort())
      await vi.advanceTimersByTimeAsync(60_000)
      expect(catalogCalls).toBe(1)
      expect(store.retryBoot()).toBe(false)
    } finally {
      store.shutdown()
      loaded.dom.window.close()
    }
  })

  it('rejects an active payload without an explicit active field', async () => {
    const loaded = load({ stamped: null })
    if (loaded === null) return
    vi.useFakeTimers()
    silenceLogs()
    let activeCalls = 0
    const store = await boot(loaded, async (url) => {
      if (url.endsWith('/catalog')) return response(200, body([SKIN_ID]))
      if (url.endsWith('/active')) {
        activeCalls += 1
        return response(200, { ok: true })
      }
      throw new Error(`unexpected fetch ${url}`)
    })
    try {
      await vi.advanceTimersByTimeAsync(0)
      expect(activeCalls).toBe(1)
      expect(loaded.dom.window.document.documentElement.hasAttribute('data-dsh-skin')).toBe(false)
      await vi.advanceTimersByTimeAsync(60_000)
      expect(activeCalls).toBe(1)
    } finally {
      store.shutdown()
      loaded.dom.window.close()
    }
  })

  it.each(['', '   '])('rejects a blank authoritative active value %j', async (value) => {
    const loaded = load({ stamped: null })
    if (loaded === null) return
    vi.useFakeTimers()
    silenceLogs()
    let activeCalls = 0
    const store = await boot(loaded, async (url) => {
      if (url.endsWith('/catalog')) return response(200, body([SKIN_ID]))
      if (url.endsWith('/active')) {
        activeCalls += 1
        return response(200, { ok: true, active: value })
      }
      throw new Error(`unexpected fetch ${url}`)
    })
    try {
      await vi.advanceTimersByTimeAsync(0)
      expect(activeCalls).toBe(1)
      expect(loaded.dom.window.document.documentElement.hasAttribute('data-dsh-skin')).toBe(false)
      await vi.advanceTimersByTimeAsync(60_000)
      expect(activeCalls).toBe(1)
    } finally {
      store.shutdown()
      loaded.dom.window.close()
    }
  })

  it('stops permanently when the authoritative skin id is missing from the catalog', async () => {
    const loaded = load()
    if (loaded === null) return
    vi.useFakeTimers()
    silenceLogs()
    let catalogCalls = 0
    let activeCalls = 0
    const posts: unknown[] = []
    const store = await boot(loaded, async (url, init = {}) => {
      if (init.method === 'POST') {
        posts.push(init.body)
        return active(SKIN_ID)
      }
      if (url.endsWith('/catalog')) {
        catalogCalls += 1
        return response(200, body([OTHER_ID]))
      }
      if (url.endsWith('/active')) {
        activeCalls += 1
        return active(SKIN_ID)
      }
      throw new Error(`unexpected fetch ${url}`)
    })
    try {
      await vi.advanceTimersByTimeAsync(0)
      expect(catalogCalls).toBe(1)
      expect(activeCalls).toBe(1)
      expect(loaded.dom.window.document.documentElement.getAttribute('data-dsh-skin')).toBe(SKIN_ID)
      await vi.advanceTimersByTimeAsync(60_000)
      expect(catalogCalls).toBe(1)
      expect(activeCalls).toBe(1)
      expect(posts).toEqual([])
      expect(store.retryBoot()).toBe(false)
    } finally {
      store.shutdown()
      loaded.dom.window.close()
    }
  })

  it('bounds transport retries and re-arms on an online event while visible', async () => {
    const loaded = load()
    if (loaded === null) return
    vi.useFakeTimers()
    silenceLogs()
    let failing = true
    let catalogCalls = 0
    const store = await boot(loaded, async (url) => {
      if (url.endsWith('/catalog')) {
        catalogCalls += 1
        if (failing) return response(503, { ok: false })
        return response(200, body([SKIN_ID]))
      }
      if (url.endsWith('/active')) return active(SKIN_ID)
      throw new Error(`unexpected fetch ${url}`)
    })
    try {
      await vi.advanceTimersByTimeAsync(0)
      expect(catalogCalls).toBe(1)
      await vi.advanceTimersByTimeAsync(60_000)
      expect(catalogCalls).toBe(6) // initial + 5 bounded retries, then stop
      failing = false
      const doc = loaded.dom.window.document
      Object.defineProperty(doc, 'visibilityState', { value: 'hidden', configurable: true })
      loaded.dom.window.dispatchEvent(new loaded.dom.window.Event('online'))
      await vi.advanceTimersByTimeAsync(2_000)
      expect(catalogCalls).toBe(6)
      Object.defineProperty(doc, 'visibilityState', { value: 'visible', configurable: true })
      doc.dispatchEvent(new loaded.dom.window.Event('visibilitychange'))
      await vi.advanceTimersByTimeAsync(1_000 + 1_000)
      expect(catalogCalls).toBe(7)
      expect(loaded.dom.window.document.documentElement.getAttribute('data-dsh-skin')).toBe(SKIN_ID)
    } finally {
      store.shutdown()
      loaded.dom.window.close()
    }
  })

  it('single-flights catalog refreshes and ignores a late older response', async () => {
    const loaded = load()
    if (loaded === null) return
    vi.useFakeTimers()
    silenceLogs()
    let catalogCalls = 0
    const queued: Array<Promise<unknown>> = []
    const store = await boot(loaded, async (url) => {
      if (url.endsWith('/catalog')) {
        const index = catalogCalls++
        if (index === 0) return response(200, body([SKIN_ID]))
        return queued.shift() ?? response(200, body([SKIN_ID]))
      }
      if (url.endsWith('/active')) return active(SKIN_ID)
      throw new Error(`unexpected fetch ${url}`)
    })
    try {
      await vi.advanceTimersByTimeAsync(0)
      const older = deferred<unknown>()
      const newer = deferred<unknown>()
      queued.push(older.promise, newer.promise)
      const first = store.refreshCatalog(true)
      const second = store.refreshCatalog(true)
      expect(catalogCalls).toBe(3)
      newer.resolve(response(200, body([OTHER_ID])))
      await second
      older.resolve(response(200, body([SKIN_ID])))
      await first
      expect(store.find(OTHER_ID)).not.toBeNull()
      expect(store.find(SKIN_ID)).toBeNull()

      const same = deferred<unknown>()
      queued.push(same.promise)
      const before = catalogCalls
      const a = store.refreshCatalog()
      const b = store.refreshCatalog()
      expect(catalogCalls).toBe(before + 1)
      same.resolve(response(200, body([SKIN_ID])))
      await Promise.all([a, b])
      expect(store.find(SKIN_ID)).not.toBeNull()
    } finally {
      store.shutdown()
      loaded.dom.window.close()
    }
  })

  it('removes listeners and ignores late applied events after shutdown', async () => {
    const loaded = load()
    if (loaded === null) return
    vi.useFakeTimers()
    silenceLogs()
    const deferredCatalog = deferred<unknown>()
    let deferCatalog = false
    let catalogCalls = 0
    const store = await boot(loaded, async (url) => {
      if (url.endsWith('/catalog')) {
        catalogCalls += 1
        return deferCatalog ? deferredCatalog.promise : response(200, body([SKIN_ID, OTHER_ID]))
      }
      if (url.endsWith('/active')) return active(SKIN_ID)
      throw new Error(`unexpected fetch ${url}`)
    })
    try {
      await vi.advanceTimersByTimeAsync(0)
      catalogCalls = 0
      deferCatalog = true
      loaded.dom.window.dispatchEvent(new loaded.dom.window.CustomEvent('dsh-skin-applied', { detail: { id: OTHER_ID } }))
      await vi.advanceTimersByTimeAsync(0)
      expect(catalogCalls).toBe(1)
      store.shutdown()
      const afterShutdown = loaded.dom.window.document.documentElement.getAttribute('data-dsh-skin')
      deferredCatalog.resolve(response(200, body([OTHER_ID])))
      await vi.advanceTimersByTimeAsync(0)
      loaded.dom.window.dispatchEvent(new loaded.dom.window.CustomEvent('dsh-skin-applied', { detail: { id: OTHER_ID } }))
      loaded.dom.window.dispatchEvent(new loaded.dom.window.Event('online'))
      await vi.advanceTimersByTimeAsync(60_000)
      expect(catalogCalls).toBe(1)
      expect(loaded.dom.window.document.documentElement.getAttribute('data-dsh-skin')).toBe(afterShutdown)
      expect(loaded.dom.window.document.head.querySelectorAll(`link[href="${href(OTHER_ID, 'stylesheet')}"]`)).toHaveLength(0)
    } finally {
      loaded.dom.window.close()
    }
  })
})
