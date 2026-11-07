/**
 * Background derivative (paint-time downscale) guards.
 *
 * The committed skin-center patch shrinks an oversized manifest
 * `backgroundMedia` image once, after it loads, into a cached WebP blob URL
 * (JPEG fallback) capped at 1920 px on the long edge. This spec boots the
 * patched built bundle in jsdom with a fake image/canvas/encoder and pins the
 * behavior: oversized images are swapped, every unsupported case fails open,
 * the per-URL cache avoids a second draw, and a removed node never receives a
 * stale blob.
 */
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

import { JSDOM } from 'jsdom'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

const PROFILE = join(dirname(fileURLToPath(import.meta.url)), '..')
const PATCH_REL = 'patches/@linxin666__dsh-client-ui-skin-center@0.3.21.patch'
const PATCH_TEXT = readFileSync(join(PROFILE, PATCH_REL), 'utf8')
const PACKAGE_DIR = join(PROFILE, 'node_modules/@linxin666/dsh-client-ui-skin-center')

/** The three absent-value defaults the committed patch flips. */
const DEFAULT_FLIPS: readonly (readonly [string, string])[] = [
  ['\t\t\tenabledValue = false;', '\t\t\tenabledValue = true;'],
  ['\t\t\t\tthis.enabledValue = typeof value.enabled === "boolean" ? value.enabled : false;', '\t\t\t\tthis.enabledValue = typeof value.enabled === "boolean" ? value.enabled : true;'],
  ['\tenabled: z.boolean().default(false),', '\tenabled: z.boolean().default(true),'],
]

interface PreparedPackage {
  root: string
  dir: string
}

function patchBinary(): string | undefined {
  const probe = spawnSync('patch', ['--version'], { encoding: 'utf8' })
  return probe.status === 0 ? 'patch' : undefined
}

function reconstructPublishedDefaults(dir: string): void {
  for (const [patched, published] of DEFAULT_FLIPS) {
    for (const rel of ['lib/client.js', 'lib/index.js']) {
      const file = join(dir, rel)
      if (!existsSync(file)) continue
      const text = readFileSync(file, 'utf8')
      if (text.includes(patched)) writeFileSync(file, text.split(patched).join(published))
    }
  }
}

function preparePatchedPackage(): PreparedPackage | null {
  if (!existsSync(PACKAGE_DIR)) return null
  const binary = patchBinary()
  if (binary === undefined) return null
  const root = mkdtempSync(join(tmpdir(), 'skin-background-compression-'))
  const dir = join(root, 'pkg')
  cpSync(PACKAGE_DIR, dir, { recursive: true, dereference: true })
  const run = (extra: readonly string[]) => spawnSync(binary, ['-p1', '--batch', '--forward', '--silent', ...extra], {
    cwd: dir, input: PATCH_TEXT, encoding: 'utf8',
  })
  if (run(['--dry-run', '-R']).status === 0) return { root, dir }
  reconstructPublishedDefaults(dir)
  const dry = run(['--dry-run'])
  expect(dry.status, dry.stderr).toBe(0)
  const applied = run([])
  expect(applied.status, applied.stderr).toBe(0)
  return { root, dir }
}

let prepared: PreparedPackage | null = null

beforeAll(() => {
  prepared = preparePatchedPackage()
})

afterAll(() => {
  if (prepared !== null) rmSync(prepared.root, { recursive: true, force: true })
})

const GLOBAL_NAMES = [
  'window', 'document', 'MutationObserver', 'ResizeObserver', 'requestAnimationFrame',
  'cancelAnimationFrame', 'HTMLElement', 'HTMLIFrameElement', 'Element', 'Node', 'localStorage', 'fetch',
] as const
const savedGlobals = new Map<string, PropertyDescriptor | undefined>()
const originalCreateObjectURL = URL.createObjectURL
const originalRevokeObjectURL = URL.revokeObjectURL

function setGlobal(name: string, value: unknown): void {
  if (!savedGlobals.has(name)) savedGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true, enumerable: false })
}

afterEach(() => {
  for (const [name, descriptor] of savedGlobals) {
    if (descriptor === undefined) Reflect.deleteProperty(globalThis, name)
    else Object.defineProperty(globalThis, name, descriptor)
  }
  savedGlobals.clear()
  if (originalCreateObjectURL === undefined) Reflect.deleteProperty(URL, 'createObjectURL')
  else URL.createObjectURL = originalCreateObjectURL
  if (originalRevokeObjectURL === undefined) Reflect.deleteProperty(URL, 'revokeObjectURL')
  else URL.revokeObjectURL = originalRevokeObjectURL
})

interface CatalogSkin {
  id: string
  media?: Record<string, unknown>
}

interface EncodeControl {
  mode: 'webp' | 'jpeg' | 'none' | 'defer'
  deferred: BlobCallback | null
  context: boolean
}

interface SkinStore {
  controller: {
    tryOn: (id: string | null, entry: unknown) => Promise<string | null>
    switchTo: (id: string | null, entry: unknown) => Promise<string | null>
  }
  find: (id: string) => unknown
}

interface DomainRuntime {
  window: JSDOM['window']
  document: Document
  canvases: HTMLCanvasElement[]
  draws: unknown[][]
  toBlobCalls: Array<[string | undefined, number | undefined]>
  createdUrls: string[]
  revokedUrls: string[]
  encode: EncodeControl
  store: SkinStore
  settle: (rounds?: number) => Promise<void>
  waitFor: (predicate: () => boolean) => Promise<void>
  dispose: () => void
}

function bootRuntime(options: { active: string; skins: readonly CatalogSkin[] }): DomainRuntime {
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', { url: 'http://localhost/' })
  const window = dom.window
  const document = window.document
  Reflect.set(window, 'scrollTo', () => {})
  document.documentElement.setAttribute('data-dsh-skin', options.active)

  const canvases: HTMLCanvasElement[] = []
  const draws: unknown[][] = []
  const toBlobCalls: Array<[string | undefined, number | undefined]> = []
  const createdUrls: string[] = []
  const revokedUrls: string[] = []
  const encode: EncodeControl = { mode: 'webp', deferred: null, context: true }
  const context = { drawImage: (...args: unknown[]) => { draws.push(args) } }
  Object.defineProperty(window.HTMLCanvasElement.prototype, 'getContext', {
    configurable: true,
    value: () => (encode.context ? context : null),
  })
  Object.defineProperty(window.HTMLCanvasElement.prototype, 'toBlob', {
    configurable: true,
    value: (callback: BlobCallback, type?: string, quality?: number) => {
      toBlobCalls.push([type, quality])
      if (encode.mode === 'defer') {
        encode.deferred = callback
        return
      }
      if (encode.mode === 'none') {
        callback(null)
        return
      }
      callback(new Blob(['derivative'], { type: encode.mode === 'jpeg' ? 'image/jpeg' : 'image/webp' }))
    },
  })
  let blobSeq = 0
  URL.createObjectURL = () => {
    const url = `blob:mock-${++blobSeq}`
    createdUrls.push(url)
    return url
  }
  URL.revokeObjectURL = (url: string) => {
    revokedUrls.push(url)
  }

  const created: HTMLElement[] = []
  const createElement = document.createElement.bind(document)
  document.createElement = ((tagName: string, elementOptions?: ElementCreationOptions) => {
    const element = createElement(tagName, elementOptions)
    const name = tagName.toLowerCase()
    if (name === 'div') created.push(element)
    if (name === 'canvas') canvases.push(element as HTMLCanvasElement)
    if (name === 'link') setTimeout(() => element.dispatchEvent(new window.Event('load')), 0)
    return element
  }) as typeof document.createElement

  let pendingFrames: Array<[number, () => void]> = []
  let nextFrame = 0
  const requestFrame = (callback: () => void) => {
    const id = ++nextFrame
    pendingFrames.push([id, callback])
    return id
  }
  const cancelFrame = (id: number) => {
    pendingFrames = pendingFrames.filter(([pending]) => pending !== id)
  }
  const runFrames = () => {
    const pending = pendingFrames
    pendingFrames = []
    for (const [, callback] of pending) callback()
    return pending.length
  }

  class FakeResizeObserver {
    constructor(_callback: () => void) {}
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }

  const catalog = options.skins.map((skin) => ({
    origin: 'user',
    warnings: [],
    manifest: {
      id: skin.id,
      contributes: {
        stylesheet: 'skin.css',
        ...(skin.media === undefined ? {} : { backgroundMedia: { light: skin.media } }),
      },
    },
  }))
  const json = (body: unknown) => Promise.resolve({ ok: true, json: async () => body } as Response)
  const fetchImpl = (input: unknown) => {
    const url = String(input)
    if (url.endsWith('/catalog')) return json({ ok: true, skins: catalog })
    if (url.endsWith('/active')) return json({ ok: true, active: options.active })
    return new Promise<Response>(() => {})
  }

  setGlobal('window', window)
  setGlobal('document', document)
  setGlobal('MutationObserver', window.MutationObserver)
  setGlobal('ResizeObserver', FakeResizeObserver)
  setGlobal('requestAnimationFrame', requestFrame)
  setGlobal('cancelAnimationFrame', cancelFrame)
  setGlobal('HTMLElement', window.HTMLElement)
  setGlobal('HTMLIFrameElement', window.HTMLIFrameElement)
  setGlobal('Element', window.Element)
  setGlobal('Node', window.Node)
  setGlobal('localStorage', window.localStorage)
  setGlobal('fetch', fetchImpl)
  Reflect.set(window, 'requestAnimationFrame', requestFrame)
  Reflect.set(window, 'cancelAnimationFrame', cancelFrame)
  Reflect.set(window, 'ResizeObserver', FakeResizeObserver)

  interface LoadedModule {
    apply: (ctx: unknown) => void
  }
  let loaded: LoadedModule | null = null
  Reflect.set(window, '__ModuleLoader__', {
    load: (entry: { factory: (request: (id: string) => Record<string, unknown>) => LoadedModule }) => {
      loaded = entry.factory(() => ({}))
    },
  })
  vm.runInThisContext(readFileSync(join(prepared!.dir, 'lib/client.js'), 'utf8'), { filename: 'skin-center-client.js' })
  if (loaded === null) throw new Error('skin-center bundle did not register with the module loader')

  const backgroundConfig = {
    enabled: true,
    backgroundOpacity: 30,
    backgroundBlurEmpty: 4,
    backgroundBlurContent: 10,
    inputCardBlur: 17,
    bubbleOpacity: 50,
  }
  const scopes = new Map<string, { getSnapshot: () => { value: Record<string, unknown>; revision: number; writable: boolean }; subscribe: () => () => void; set: (key: string, value: unknown) => void }>()
  const makeScope = (value: Record<string, unknown>) => ({
    getSnapshot: () => ({ value, revision: 0, writable: true }),
    subscribe: () => () => {},
    set: (key: string, next: unknown) => { value[key] = next },
  })
  const binder = {
    bind: ({ namespace }: { namespace: string }) => {
      if (!scopes.has(namespace)) scopes.set(namespace, makeScope(namespace === 'skin-background' ? backgroundConfig : {}))
      return scopes.get(namespace)!
    },
  }
  const disposers: Array<() => void> = []
  const ctx = {
    effect: (fn: () => (() => void) | void) => {
      const disposer = fn()
      if (typeof disposer === 'function') disposers.push(disposer)
    },
    locale: { register: () => () => {} },
    get: (key: string) => key === 'theme'
      ? { getTheme: () => 'light', setTheme: () => {} }
      : key === 'webUiSettings' ? binder : undefined,
    settingsScope: binder,
    remote: { directoryPicker: { pick: async () => ({ ok: false, error: { message: 'unavailable' } }) } },
    on: () => () => {},
    slots: { inject: () => {} },
  }
  const bundle = loaded as LoadedModule
  bundle.apply(ctx)

  const store = Reflect.get(window, '__skinRuntime') as SkinStore
  if (store === undefined) throw new Error('skin runtime did not boot')

  const settle = async (rounds = 6) => {
    for (let index = 0; index < rounds; index += 1) await new Promise<void>((resolve) => setTimeout(resolve, 0))
  }
  const waitFor = async (predicate: () => boolean) => {
    for (let index = 0; index < 200; index += 1) {
      if (predicate()) return
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
    }
    throw new Error('timed out waiting for the background layer')
  }

  return {
    window,
    document,
    canvases,
    draws,
    toBlobCalls,
    createdUrls,
    revokedUrls,
    encode,
    store,
    settle,
    waitFor,
    dispose: () => {
      for (const dispose of disposers.reverse()) dispose()
      runFrames()
      dom.window.close()
    },
  }
}

const BACKGROUND = '[data-dsh-skin-layer="background"]'

function backgroundImage(runtime: DomainRuntime): HTMLImageElement {
  const image = runtime.document.querySelector(`${BACKGROUND} img`)
  if (image === null) throw new Error('no background image')
  return image as HTMLImageElement
}

/** Give the jsdom image natural dimensions, then fire the `load` it never gets. */
function loadImage(runtime: DomainRuntime, image: HTMLImageElement, width: number, height: number): void {
  Object.defineProperty(image, 'naturalWidth', { configurable: true, value: width })
  Object.defineProperty(image, 'naturalHeight', { configurable: true, value: height })
  image.dispatchEvent(new runtime.window.Event('load'))
}

const ORIGINAL = 'assets/big.jpg'
const TEST_SKIN: CatalogSkin = { id: 'test-skin', media: { type: 'image', src: ORIGINAL } }

describe('background paint-time downscale', () => {
  it('swaps an oversized image for a 1920x1080 WebP blob drawn from the loaded element', async () => {
    if (prepared === null) return
    const runtime = bootRuntime({ active: 'test-skin', skins: [TEST_SKIN] })
    await runtime.waitFor(() => runtime.document.querySelector(`${BACKGROUND} img`) !== null)
    const image = backgroundImage(runtime)
    expect(image.src).toBe(`http://localhost/api/skin-center/v2/skins/test-skin/${ORIGINAL}`)

    loadImage(runtime, image, 3840, 2160)
    await runtime.settle()

    expect(image.src).toMatch(/^blob:mock-/)
    expect(runtime.canvases).toHaveLength(1)
    expect(runtime.canvases[0]!.width).toBe(1920)
    expect(runtime.canvases[0]!.height).toBe(1080)
    expect(runtime.draws).toHaveLength(1)
    expect(runtime.draws[0]).toEqual([image, 0, 0, 1920, 1080])
    expect(runtime.toBlobCalls).toEqual([['image/webp', 0.82]])
    runtime.dispose()
  })

  it('leaves an image at or under the cap untouched', async () => {
    if (prepared === null) return
    const runtime = bootRuntime({ active: 'test-skin', skins: [TEST_SKIN] })
    await runtime.waitFor(() => runtime.document.querySelector(`${BACKGROUND} img`) !== null)
    const image = backgroundImage(runtime)
    const original = image.src

    loadImage(runtime, image, 1600, 900)
    await runtime.settle()

    expect(image.src).toBe(original)
    expect(runtime.canvases).toHaveLength(0)
    expect(runtime.draws).toHaveLength(0)
    expect(runtime.toBlobCalls).toHaveLength(0)
    runtime.dispose()
  })

  it.each([
    ['an animated GIF', 'assets/loop.gif'],
    ['an SVG', 'assets/art.svg'],
  ])('leaves %s untouched', async (_label, src) => {
    if (prepared === null) return
    const runtime = bootRuntime({ active: 'test-skin', skins: [{ id: 'test-skin', media: { type: 'image', src } }] })
    await runtime.waitFor(() => runtime.document.querySelector(`${BACKGROUND} img`) !== null)
    const image = backgroundImage(runtime)
    const original = image.src

    loadImage(runtime, image, 3840, 2160)
    await runtime.settle()

    expect(image.src).toBe(original)
    expect(runtime.canvases).toHaveLength(0)
    expect(runtime.draws).toHaveLength(0)
    runtime.dispose()
  })

  it('never compresses a video background', async () => {
    if (prepared === null) return
    const runtime = bootRuntime({
      active: 'test-skin',
      skins: [{ id: 'test-skin', media: { type: 'video', src: 'assets/movie.mp4' } }],
    })
    await runtime.waitFor(() => runtime.document.querySelector(`${BACKGROUND} video`) !== null)
    expect(runtime.document.querySelector(`${BACKGROUND} img`)).toBeNull()
    await runtime.settle()
    expect(runtime.canvases).toHaveLength(0)
    expect(runtime.draws).toHaveLength(0)
    runtime.dispose()
  })

  it('keeps the original src when the encoder yields no usable blob', async () => {
    if (prepared === null) return
    const runtime = bootRuntime({ active: 'test-skin', skins: [TEST_SKIN] })
    runtime.encode.mode = 'none'
    await runtime.waitFor(() => runtime.document.querySelector(`${BACKGROUND} img`) !== null)
    const image = backgroundImage(runtime)
    const original = image.src

    loadImage(runtime, image, 3840, 2160)
    await runtime.settle()

    expect(image.src).toBe(original)
    expect(runtime.createdUrls).toHaveLength(0)
    runtime.dispose()
  })

  it('keeps the original src when the canvas context is unavailable', async () => {
    if (prepared === null) return
    const runtime = bootRuntime({ active: 'test-skin', skins: [TEST_SKIN] })
    runtime.encode.context = false
    await runtime.waitFor(() => runtime.document.querySelector(`${BACKGROUND} img`) !== null)
    const image = backgroundImage(runtime)
    const original = image.src

    loadImage(runtime, image, 3840, 2160)
    await runtime.settle()

    expect(image.src).toBe(original)
    expect(runtime.toBlobCalls).toHaveLength(0)
    expect(runtime.createdUrls).toHaveLength(0)
    runtime.dispose()
  })

  it('falls back to JPEG when WebP encoding is unsupported', async () => {
    if (prepared === null) return
    const runtime = bootRuntime({ active: 'test-skin', skins: [TEST_SKIN] })
    runtime.encode.mode = 'jpeg'
    await runtime.waitFor(() => runtime.document.querySelector(`${BACKGROUND} img`) !== null)
    const image = backgroundImage(runtime)

    loadImage(runtime, image, 3840, 2160)
    await runtime.settle()

    expect(runtime.toBlobCalls).toEqual([['image/webp', 0.82], ['image/jpeg', 0.82]])
    expect(image.src).toMatch(/^blob:mock-/)
    runtime.dispose()
  })

  it('reuses the cached blob URL for a second build of the same source without redrawing', async () => {
    if (prepared === null) return
    const runtime = bootRuntime({ active: 'test-skin', skins: [TEST_SKIN] })
    await runtime.waitFor(() => runtime.document.querySelector(`${BACKGROUND} img`) !== null)
    const first = backgroundImage(runtime)
    loadImage(runtime, first, 3840, 2160)
    await runtime.settle()
    const cachedUrl = first.src
    expect(cachedUrl).toMatch(/^blob:mock-/)

    // A light/dark flip repaints the same backgroundMedia variant (the same
    // absolute asset URL), which is the second build the session cache serves.
    runtime.document.body.setAttribute('data-ds-dark-theme', '')
    await runtime.waitFor(() => {
      const image = runtime.document.querySelector(`${BACKGROUND} img`)
      return image !== null && image !== first
    })
    const rebuilt = backgroundImage(runtime)
    loadImage(runtime, rebuilt, 3840, 2160)
    await runtime.settle()

    expect(rebuilt.src).toBe(cachedUrl)
    expect(runtime.canvases).toHaveLength(1)
    expect(runtime.draws).toHaveLength(1)
    expect(runtime.toBlobCalls).toHaveLength(1)
    expect(runtime.revokedUrls).toHaveLength(0)
    runtime.dispose()
  })

  it('never applies a stale blob to a removed node and revokes it', async () => {
    if (prepared === null) return
    const runtime = bootRuntime({ active: 'test-skin', skins: [TEST_SKIN] })
    runtime.encode.mode = 'defer'
    await runtime.waitFor(() => runtime.document.querySelector(`${BACKGROUND} img`) !== null)
    const image = backgroundImage(runtime)
    const original = image.src

    loadImage(runtime, image, 3840, 2160)
    await runtime.settle()
    const finish = runtime.encode.deferred
    expect(finish).not.toBeNull()

    image.remove()
    finish!(new Blob(['derivative'], { type: 'image/webp' }))
    await runtime.settle()

    expect(image.src).toBe(original)
    expect(runtime.createdUrls).toHaveLength(1)
    expect(runtime.revokedUrls).toEqual(runtime.createdUrls)
    runtime.dispose()
  })
})
