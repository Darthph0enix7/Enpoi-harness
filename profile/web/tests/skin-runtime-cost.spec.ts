/**
 * Skin-center runtime cost guards.
 *
 * The profile owns `patches/@linxin666__dsh-client-ui-skin-center@0.3.21.patch`
 * over the third-party skin center. Those hunks must keep the stock look free
 * of the full-viewport `backdrop-filter` layer, cache the applied blur value,
 * and keep the body observers off the per-mutation frame path.
 *
 * The behavioral cases load the patched *built* bundle (`lib/client.js`) into
 * jsdom. A patched copy is produced from the published 0.3.21 bytes (or from an
 * already-patched install) by applying the committed pnpm patch, so the
 * assertions run against exactly the bytes `pnpm install` would produce.
 *
 * The backdrop-scene (composer frost marker) activation path needs the host
 * catalog fetch and a stylesheet load that jsdom does not resolve here; those
 * two hunks are pinned by static assertions only and are reported as such.
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
const CONVERSATION_ROW_SELECTOR = '[data-chat-anchor-key]'

/**
 * The three absent-value defaults the committed patch flips. Reversing them
 * recovers the published 0.3.21 bytes from an install that predates this
 * patch, which is what the local checkout carries between installs.
 */
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
  const root = mkdtempSync(join(tmpdir(), 'skin-runtime-cost-'))
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
})

interface DomainRuntime {
  document: Document
  layers: () => HTMLElement[]
  runFrames: () => number
  tick: () => Promise<void>
  dispose: () => void
}

interface ScopeSnapshot {
  value: Record<string, unknown>
  revision: number
  writable: boolean
}

interface SettingsScope {
  getSnapshot: () => ScopeSnapshot
  subscribe: (listener: () => void) => () => void
  set: (key: string, value: unknown) => void
}

function bootRuntime(dir: string, options: { skin?: string; background?: Record<string, unknown> } = {}): DomainRuntime {
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', { url: 'http://localhost/' })
  const window = dom.window
  const document = window.document
  Reflect.set(window, 'scrollTo', () => {})
  if (options.skin !== undefined) document.documentElement.setAttribute('data-dsh-skin', options.skin)

  const created: HTMLElement[] = []
  const createElement = document.createElement.bind(document)
  document.createElement = ((tagName: string, elementOptions?: ElementCreationOptions) => {
    const element = createElement(tagName, elementOptions)
    if (tagName.toLowerCase() === 'div') created.push(element)
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
  const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

  class FakeResizeObserver {
    constructor(_callback: () => void) {}
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
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
  // The boot catalog/active fetch never settles: the async runtime then leaves
  // the server-stamped `data-dsh-skin` attribute (and the bundle under test) alone.
  setGlobal('fetch', () => new Promise(() => {}))
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
  vm.runInThisContext(readFileSync(join(dir, 'lib/client.js'), 'utf8'), { filename: 'skin-center-client.js' })
  if (loaded === null) throw new Error('skin-center bundle did not register with the module loader')

  const backgroundConfig = {
    enabled: true,
    backgroundOpacity: 30,
    backgroundBlurEmpty: 4,
    backgroundBlurContent: 10,
    inputCardBlur: 17,
    bubbleOpacity: 50,
    ...options.background,
  }
  const scopes = new Map<string, SettingsScope>()
  const makeScope = (value: Record<string, unknown>): SettingsScope => ({
    getSnapshot: () => ({ value, revision: 0, writable: true }),
    subscribe: () => () => {},
    set: (key, next) => { value[key] = next },
  })
  const binder = {
    bind: ({ namespace }: { namespace: string }) => {
      if (!scopes.has(namespace)) scopes.set(namespace, makeScope(namespace === 'skin-background' ? backgroundConfig : {}))
      return scopes.get(namespace) as SettingsScope
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

  return {
    document,
    layers: () => created.filter((element) => element.isConnected
      && element.style.zIndex === '-1'
      && element.style.backdropFilter !== ''),
    runFrames,
    tick,
    dispose: () => {
      for (const dispose of disposers.reverse()) dispose()
      dom.window.close()
    },
  }
}

/** Count writes to the two backdrop-filter declarations on one element. */
function countStyleWrites(style: CSSStyleDeclaration): () => number {
  let writes = 0
  const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(style) as object, 'backdropFilter')
  if (descriptor?.get !== undefined && descriptor.set !== undefined) {
    const read = descriptor.get.bind(style) as () => string
    const write = descriptor.set.bind(style) as (value: string) => void
    Object.defineProperty(style, 'backdropFilter', {
      configurable: true,
      get: read,
      set: (value: string) => { writes += 1; write(value) },
    })
  }
  const setProperty = style.setProperty.bind(style)
  style.setProperty = (property: string, value: string | null, priority?: string) => {
    if (property === 'backdrop-filter' || property === '-webkit-backdrop-filter') writes += 1
    setProperty(property, value, priority ?? '')
  }
  return () => writes
}

describe('skin center runtime cost', () => {
  it('ships the performance hunks in the committed patch', () => {
    for (const marker of [
      'hasPaintedBackdrop',
      'ensureRootObserver',
      'stopContentObserver',
      'appliedBlur',
      'hasRelevantBlurMutation',
      'findConversationContent',
      'relevantConversationContentMutation',
      'watchComposerParent',
      'BACKGROUND_MAX_EDGE',
      'BACKGROUND_WEBP_QUALITY',
      'backgroundDerivatives',
      'backgroundReleases',
      'shrinkBackgroundImage',
      'encodeBackgroundDerivative',
      'requestIdleCallback',
    ]) expect(PATCH_TEXT).toContain(marker)
    // The paint-time downscale only edits lib/client.js: no dependency, import,
    // or require is added by the patch.
    expect(PATCH_TEXT).not.toMatch(/^\+(?!\+\+)\s*(?:import\b|.*\brequire\s*\()/mu)
    // Keeps the existing defaults-flip guard honest: the added hunks never
    // rewrite a persisted `enabled` value.
    expect(PATCH_TEXT.match(/^\+.*enabled/gmu) ?? []).toHaveLength(3)
    expect(PATCH_TEXT.match(/^-.*enabled/gmu) ?? []).toHaveLength(3)
  })

  it('creates no backdrop layer on the stock look, even with blur configured', async () => {
    if (prepared === null) return
    const runtime = bootRuntime(prepared.dir)
    await runtime.tick()
    expect(runtime.layers()).toHaveLength(0)

    const row = runtime.document.createElement('div')
    row.setAttribute('data-chat-anchor-key', 'stock-row')
    runtime.document.body.appendChild(row)
    await runtime.tick()
    const frames = runtime.runFrames()
    await runtime.tick()

    expect(frames).toBe(0)
    expect(runtime.layers()).toHaveLength(0)
    runtime.dispose()
  })

  it('keeps one backdrop layer for an active skin or custom theme', async () => {
    if (prepared === null) return
    const skin = bootRuntime(prepared.dir, { skin: 'summer-liquid-glass' })
    await skin.tick()
    const layers = skin.layers()
    expect(layers).toHaveLength(1)
    expect(layers[0]?.style.backdropFilter).toBe('blur(4px)')
    expect(layers[0]?.style.position).toBe('fixed')
    expect(layers[0]?.style.inset).toBe('0px')

    // Leaving the skin drops the layer and the body-wide content watch.
    skin.document.documentElement.removeAttribute('data-dsh-skin')
    await skin.tick()
    expect(skin.runFrames()).toBe(1)
    await skin.tick()
    expect(skin.layers()).toHaveLength(0)
    const row = skin.document.createElement('div')
    row.setAttribute('data-chat-anchor-key', 'after-stock')
    skin.document.body.appendChild(row)
    await skin.tick()
    expect(skin.runFrames()).toBe(0)
    skin.dispose()

    const theme = bootRuntime(prepared.dir)
    theme.document.documentElement.setAttribute('data-dsh-custom-theme', 'true')
    await theme.tick()
    expect(theme.runFrames()).toBe(1)
    await theme.tick()
    expect(theme.layers()).toHaveLength(1)
    theme.dispose()
  })

  it('skips identical backdrop style writes and reuses the cached content row', async () => {
    if (prepared === null) return
    const runtime = bootRuntime(prepared.dir, { skin: 'summer-liquid-glass' })
    await runtime.tick()
    const layer = runtime.layers()[0]
    expect(layer).toBeDefined()

    const row = runtime.document.createElement('div')
    row.setAttribute('data-chat-anchor-key', 'content-row')
    runtime.document.body.appendChild(row)
    await runtime.tick()
    expect(runtime.runFrames()).toBe(1)
    await runtime.tick()
    expect(layer?.style.backdropFilter).toBe('blur(10px)')

    let contentQueries = 0
    const querySelector = runtime.document.querySelector.bind(runtime.document)
    runtime.document.querySelector = (selector: string) => {
      if (selector.includes(CONVERSATION_ROW_SELECTOR)) contentQueries += 1
      return querySelector(selector)
    }
    const writes = countStyleWrites(layer!.style)

    let frames = 0
    for (let index = 0; index < 100; index += 1) {
      row.setAttribute('class', `mutation-${index}`)
      await runtime.tick()
      frames += runtime.runFrames()
    }
    await runtime.tick()

    expect(frames).toBe(100)
    expect(writes()).toBe(0)
    expect(contentQueries).toBe(0)
    expect(runtime.layers()).toHaveLength(1)
    expect(layer?.style.backdropFilter).toBe('blur(10px)')

    row.remove()
    await runtime.tick()
    expect(runtime.runFrames()).toBe(1)
    await runtime.tick()
    expect(layer?.style.backdropFilter).toBe('blur(4px)')
    // The counter must observe the real value change, or the zero above is vacuous.
    expect(writes()).toBe(2)
    runtime.dispose()
  })

  it('narrows the shell adapter observer once the composer is found', async () => {
    if (prepared === null) return
    const runtime = bootRuntime(prepared.dir)
    await runtime.tick()

    const container = runtime.document.createElement('div')
    runtime.document.body.appendChild(container)
    let rectReads = 0
    const makeComposer = (height: number) => {
      const composer = runtime.document.createElement('div')
      composer.setAttribute('data-slot', 'conversation.composer')
      composer.getBoundingClientRect = () => {
        rectReads += 1
        return { height } as DOMRect
      }
      return composer
    }

    const first = makeComposer(42)
    container.appendChild(first)
    await runtime.tick()
    expect(runtime.runFrames()).toBe(1)
    await runtime.tick()
    expect(runtime.document.documentElement.style.getPropertyValue('--dsh-composer-height')).toBe('42px')
    expect(rectReads).toBe(1)

    for (let index = 0; index < 100; index += 1) runtime.document.body.appendChild(runtime.document.createElement('div'))
    await runtime.tick()
    expect(runtime.runFrames()).toBe(0)
    expect(rectReads).toBe(1)
    expect(runtime.document.documentElement.style.getPropertyValue('--dsh-composer-height')).toBe('42px')

    const second = makeComposer(50)
    first.remove()
    container.appendChild(second)
    await runtime.tick()
    expect(runtime.runFrames()).toBe(1)
    await runtime.tick()
    expect(runtime.document.documentElement.style.getPropertyValue('--dsh-composer-height')).toBe('50px')
    runtime.dispose()
  })
})
