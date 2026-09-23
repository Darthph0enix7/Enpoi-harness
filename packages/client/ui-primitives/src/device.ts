import { useSyncExternalStore } from 'react'

/**
 * Device and pointer classification for the adaptive UI. Classification is
 * capability-first: a touch pointer at phone width is a phone, touch between
 * the phone and tablet ceilings is a tablet, everything else is desktop — a
 * narrow desktop window is not a phone. The runtime publishes immutable
 * snapshots and projects them onto `<html>` as `data-device`, `data-pointer`,
 * `data-keyboard`, and the `--dsh-keyboard-inset` / `--dsh-visual-viewport-height`
 * variables the mobile stylesheets consume.
 *
 * The keyboard has two browser shapes, and the runtime publishes them apart:
 * where the browser resizes the layout viewport for the keyboard (Android
 * Chrome under `interactive-widget=resizes-content`) the frame shrinks on its
 * own and `keyboardInset` stays 0; where the keyboard only occludes the visual
 * viewport (iOS) the layout keeps its height and `keyboardInset` is the lift
 * the shell must apply. Detecting open uses both signals, but only the
 * occlusion is ever a lift — applying the layout shrink as a lift as well
 * displaces the composer by the keyboard height twice.
 *
 * The singleton lives in this package's platform-module entry, so every client
 * bundle shares one instance; use `startDeviceRuntime()` to install listeners
 * and `getDeviceSnapshot()` for an unsolicited read.
 * @module @deepseek-ai/dsh-client-ui-primitives/device
 */

/** Classified device family. */
export type DeviceKind = 'phone' | 'tablet' | 'desktop'

/** Input-precision family of the primary pointer. */
export type PointerKind = 'coarse' | 'fine'

/** Largest viewport width classified as a phone when the primary pointer is coarse. */
export const PHONE_MAX_WIDTH = 768

/** Largest viewport width classified as a tablet when the primary pointer is coarse. */
export const TABLET_MAX_WIDTH = 1024

/** Visual-viewport occlusion (px) above which the soft keyboard counts as open. */
export const KEYBOARD_MIN_INSET = 120

/** Milliseconds the keyboard inset must persist before the state flips open (iOS lag guard). */
export const KEYBOARD_SETTLE_MS = 120

/**
 * Milliseconds a display rotation is given to settle. The display swap itself
 * changes the viewport height, so the layout-shrink signal is held this long
 * before it is trusted again; misreading the swap as a keyboard would strand
 * the pre-rotation state.
 */
export const KEYBOARD_ROTATION_GUARD_MS = 400

/** One classification reading: viewport width plus the pointer capabilities. */
export interface DeviceReading {
  /** Layout viewport width in px. */
  readonly width: number
  /** Whether the device reports any touch points. */
  readonly hasTouch: boolean
  /** Whether `(pointer: coarse)` matches. */
  readonly coarsePointer: boolean
}

/** The classifier's stable output: device family and pointer kind. */
export interface DeviceClassification {
  /** Classified device family. */
  readonly device: DeviceKind
  /** Classified pointer kind. */
  readonly pointer: PointerKind
}

/**
 * Classify one reading. Touch is required for the phone and tablet families;
 * a coarse pointer without touch support (a stylus-only device) classifies the
 * same way because both drive the same touch affordances.
 * @param reading - viewport width and pointer capabilities.
 * @returns the device family and pointer kind for that reading.
 */
export function classifyDevice(reading: DeviceReading): DeviceClassification {
  const pointer: PointerKind = reading.hasTouch || reading.coarsePointer ? 'coarse' : 'fine'
  if (pointer === 'coarse' && reading.width <= PHONE_MAX_WIDTH) return { device: 'phone', pointer }
  if (pointer === 'coarse' && reading.width <= TABLET_MAX_WIDTH) return { device: 'tablet', pointer }
  return { device: 'desktop', pointer }
}

/** Published runtime state: classification plus soft-keyboard geometry. */
export interface DeviceSnapshot extends DeviceClassification {
  /** Last classified layout viewport width in px. */
  readonly width: number
  /** Whether the soft keyboard currently occludes the layout viewport. */
  readonly keyboardOpen: boolean
  /**
   * Lift in px the keyboard adds beyond the layout viewport (0 when closed).
   * Zero while the browser already resized the layout viewport for the
   * keyboard, so consumers apply it without a second offset.
   */
  readonly keyboardInset: number
}

/** Observable face of the device runtime, structurally the slot framework's host-observable. */
export interface DeviceSource {
  /** @returns the current immutable snapshot (stable reference until it changes). */
  getSnapshot(): DeviceSnapshot
  /**
   * Subscribe to snapshot changes.
   * @param listener - called after every committed snapshot change.
   * @returns the unsubscribe function.
   */
  subscribe(listener: () => void): () => void
}

/** Live classification service over the browser globals. */
export class DeviceRuntime implements DeviceSource {
  private snapshot: DeviceSnapshot
  private readonly listeners = new Set<() => void>()
  private installed = false
  private frame: number | null = null
  private settle: ReturnType<typeof setTimeout> | null = null
  private rotationTimer: ReturnType<typeof setTimeout> | null = null
  private restingViewport = 0
  private displaySignature = ''
  private media: MediaQueryList[] = []
  private cleanups: Array<() => void> = []

  /** @param snapshot - optional initial snapshot override (tests only). */
  constructor(snapshot?: DeviceSnapshot) {
    this.snapshot = snapshot ?? readDeviceSnapshot()
  }

  /** @returns the current immutable snapshot. */
  getSnapshot(): DeviceSnapshot {
    return this.snapshot
  }

  /**
   * Subscribe to snapshot changes.
   * @param listener - called after every committed snapshot change.
   * @returns the unsubscribe function.
   */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /**
   * Re-read the environment and publish any change. Installed listeners keep
   * the snapshot current; this is for readers that must observe a change
   * before the next event-loop turn and for uninstalled test benches.
   * @returns the snapshot after the refresh.
   */
  refresh(): DeviceSnapshot {
    this.commit(this.measure())
    this.sampleKeyboard()
    return this.snapshot
  }

  /**
   * Install environment listeners and project the current snapshot. Idempotent.
   * @returns the disposer removing every listener and the projected root state.
   */
  install(): () => void {
    if (this.installed) return () => { /* already installed: nothing to release */ }
    /* v8 ignore next -- browser capability module: install() is called from a DOM mount (ui-layout's effect). */
    if (typeof window === 'undefined' || typeof document === 'undefined') {
      return () => { /* no DOM: nothing to release */ }
    }
    this.installed = true
    this.restingViewport = readVisualViewportHeight() ?? window.innerHeight
    this.displaySignature = readDisplaySignature()
    const onResize = (): void => { this.scheduleMeasure() }
    const onViewport = (): void => { this.scheduleKeyboard() }
    const onOrientation = (): void => {
      this.adoptRotatedViewport()
      this.scheduleKeyboard()
    }
    window.addEventListener('resize', onResize)
    window.addEventListener('orientationchange', onOrientation)
    const visual = window.visualViewport
    if (visual !== undefined && visual !== null) {
      visual.addEventListener('resize', onViewport)
      visual.addEventListener('scroll', onViewport)
      this.cleanups.push(() => {
        visual.removeEventListener('resize', onViewport)
        visual.removeEventListener('scroll', onViewport)
      })
    }
    const orientation = window.screen.orientation
    if (orientation !== undefined) {
      orientation.addEventListener('change', onOrientation)
      this.cleanups.push(() => { orientation.removeEventListener('change', onOrientation) })
    }
    for (const query of ['(pointer: coarse)', '(max-width: 768px)']) {
      if (typeof window.matchMedia !== 'function') break
      const media = window.matchMedia(query)
      const onChange = (): void => { this.scheduleMeasure() }
      // Safari below 14 exposes the deprecated listener API only.
      if (typeof media.addEventListener === 'function') {
        media.addEventListener('change', onChange)
        this.cleanups.push(() => { media.removeEventListener('change', onChange) })
      } else if (typeof media.addListener === 'function') {
        media.addListener(onChange)
        this.cleanups.push(() => { media.removeListener(onChange) })
      }
      this.media.push(media)
    }
    this.cleanups.push(() => { window.removeEventListener('resize', onResize) })
    this.cleanups.push(() => { window.removeEventListener('orientationchange', onOrientation) })
    this.commit(this.measure())
    this.sampleKeyboard()
    return () => { this.dispose() }
  }

  /** Remove every listener and the projected root state; the next install() rebuilds it. */
  dispose(): void {
    if (!this.installed) return
    this.installed = false
    if (this.frame !== null) { cancelAnimationFrame(this.frame); this.frame = null }
    if (this.settle !== null) { clearTimeout(this.settle); this.settle = null }
    if (this.rotationTimer !== null) { clearTimeout(this.rotationTimer); this.rotationTimer = null }
    for (const cleanup of this.cleanups.splice(0)) cleanup()
    this.media = []
    // Installed implies the DOM existed when install() succeeded.
    const root = document.documentElement
    root.removeAttribute('data-device')
    root.removeAttribute('data-pointer')
    root.removeAttribute('data-keyboard')
    root.style.removeProperty('--dsh-keyboard-inset')
    root.style.removeProperty('--dsh-visual-viewport-height')
  }

  /** rAF-throttle a full reclassification (resize and media-query changes). */
  private scheduleMeasure(): void {
    if (this.frame !== null) return
    this.frame = requestAnimationFrame(() => {
      this.frame = null
      this.commit(this.measure())
      this.sampleKeyboard()
    })
  }

  /** rAF-throttle a keyboard sample (visual-viewport resize and scroll). */
  private scheduleKeyboard(): void {
    this.scheduleMeasure()
  }

  /** @returns a fresh classification reading carrying the current keyboard state. */
  private measure(): DeviceSnapshot {
    return {
      ...readDeviceSnapshot(),
      keyboardOpen: this.snapshot.keyboardOpen,
      keyboardInset: this.snapshot.keyboardInset,
    }
  }

  /**
   * Read the keyboard candidate and commit it: opening settles for
   * {@link KEYBOARD_SETTLE_MS} so the iOS ~300ms visual-viewport animation
   * cannot flip the state on intermediate frames, closing is immediate so the
   * shell never sticks behind a dismissed keyboard. Samples during a display
   * rotation are dropped: the swap drives the viewport height, and the guard's
   * own sample re-adopts the resting height once it has settled.
   */
  private sampleKeyboard(): void {
    this.adoptRotatedViewport()
    if (this.rotationTimer !== null) return
    const inset = this.readKeyboardCandidate()
    if (inset >= KEYBOARD_MIN_INSET) {
      this.settle ??= setTimeout(() => {
        this.settle = null
        this.commitKeyboard(this.rotationTimer === null && this.readKeyboardCandidate() >= KEYBOARD_MIN_INSET)
      }, KEYBOARD_SETTLE_MS)
      return
    }
    if (this.settle !== null) { clearTimeout(this.settle); this.settle = null }
    this.commitKeyboard(false)
  }

  /**
   * Re-adopt the resting viewport after the display rotated. The keyboard
   * cannot change the screen dimensions, so only a changed display signature
   * is a rotation: the previous orientation's resting height no longer
   * applies, the viewport animates across the swap, and samples are held for
   * {@link KEYBOARD_ROTATION_GUARD_MS} until the guard's own sample re-reads
   * the settled height.
   */
  private adoptRotatedViewport(): void {
    const signature = readDisplaySignature()
    if (signature === '' || signature === this.displaySignature) return
    this.displaySignature = signature
    if (this.rotationTimer !== null) clearTimeout(this.rotationTimer)
    this.rotationTimer = setTimeout(() => {
      this.rotationTimer = null
      this.restingViewport = Math.max(readVisualViewportHeight() ?? 0, readDisplayHeight())
      this.scheduleKeyboard()
    }, KEYBOARD_ROTATION_GUARD_MS)
    this.restingViewport = Math.max(readVisualViewportHeight() ?? 0, readDisplayHeight())
  }

  /**
   * @returns the current occlusion in px: how far the visual viewport's bottom
   * edge sits above the layout viewport's bottom. This is the only value the
   * shell may apply as a lift — it is 0 while the browser already resized the
   * layout viewport for the keyboard (Android `resizes-content`), and it
   * follows the visual viewport when the platform pans it. Desktop devices
   * report 0 unless the pointer is coarse.
   */
  private readKeyboardOcclusion(): number {
    if (this.snapshot.pointer !== 'coarse') return 0
    const visual = readVisualViewport()
    if (visual === undefined) return 0
    return Math.max(0, Math.round(window.innerHeight - visual.offsetTop - visual.height))
  }

  /**
   * @returns the keyboard candidate in px: the visual occlusion, or the
   * layout viewport's own shrink below the resting height (Android
   * `interactive-widget=resizes-content`, where the occlusion stays 0),
   * whichever is larger.
   */
  private readKeyboardCandidate(): number {
    const occluded = this.readKeyboardOcclusion()
    if (this.snapshot.pointer !== 'coarse') return 0
    const layoutHeight = window.innerHeight
    const height = readVisualViewportHeight() ?? layoutHeight
    return Math.max(occluded, Math.max(0, Math.round(this.restingViewport - height)))
  }

  /**
   * Commit one keyboard reading, adopting the current height as resting while
   * closed. The published inset is the occlusion alone; the layout-shrink
   * candidate only decides whether the keyboard is open.
   */
  private commitKeyboard(open: boolean): void {
    const inset = open ? this.readKeyboardOcclusion() : 0
    if (!open) this.restingViewport = readVisualViewportHeight() ?? window.innerHeight
    if (this.snapshot.keyboardOpen === open && this.snapshot.keyboardInset === inset) return
    this.commit({ ...this.measure(), keyboardOpen: open, keyboardInset: inset })
  }

  /**
   * Publish a snapshot, projecting the root attributes and CSS variables.
   * @param next - the fully composed snapshot to publish.
   */
  private commit(next: DeviceSnapshot): void {
    const snapshot = next
    const previous = this.snapshot
    this.snapshot = snapshot
    projectDeviceState(snapshot)
    if (sameSnapshot(previous, snapshot)) return
    for (const listener of [...this.listeners]) {
      try {
        listener()
      } catch (error) {
        console.error('device runtime subscriber failed:', error)
      }
    }
  }
}

/** Whether two snapshots carry the same published state. */
function sameSnapshot(left: DeviceSnapshot, right: DeviceSnapshot): boolean {
  return left.device === right.device && left.pointer === right.pointer
    && left.width === right.width && left.keyboardOpen === right.keyboardOpen
    && left.keyboardInset === right.keyboardInset
}

/** Read the current browser classification readings. */
function readDeviceSnapshot(): DeviceSnapshot {
  /* v8 ignore next -- browser capability module: every caller runs after install()'s DOM guard. */
  if (typeof window === 'undefined') {
    return { device: 'desktop', pointer: 'fine', width: 0, keyboardOpen: false, keyboardInset: 0 }
  }
  const width = window.innerWidth
  const hasTouch = navigator.maxTouchPoints > 0
  const coarsePointer = typeof window.matchMedia === 'function'
    && window.matchMedia('(pointer: coarse)').matches
  return {
    ...classifyDevice({ width, hasTouch, coarsePointer }),
    width,
    keyboardOpen: false,
    keyboardInset: 0,
  }
}

/** @returns the document's visual viewport, or undefined where the API is absent. */
function readVisualViewport(): VisualViewport | undefined {
  /* v8 ignore next -- browser capability module: every caller runs after install()'s DOM guard. */
  if (typeof window === 'undefined') return undefined
  return window.visualViewport ?? undefined
}

/** @returns the visual viewport height in px, or null where the API is absent. */
function readVisualViewportHeight(): number | null {
  const visual = readVisualViewport()
  return visual === undefined ? null : visual.height
}

/**
 * @returns the display's `widthxheight` signature, or '' where the Screen API
 * is unavailable. The keyboard never changes it; a rotation always does.
 */
function readDisplaySignature(): string {
  /* v8 ignore next -- browser capability module: every caller runs after install()'s DOM guard. */
  if (typeof window === 'undefined' || window.screen === undefined) return ''
  return `${String(window.screen.width)}x${String(window.screen.height)}`
}

/** @returns the display height in px, or 0 where the Screen API is unavailable. */
function readDisplayHeight(): number {
  /* v8 ignore next -- browser capability module: every caller runs after install()'s DOM guard. */
  if (typeof window === 'undefined' || window.screen === undefined) return 0
  return window.screen.height
}

/**
 * Project a snapshot onto `<html>`: the classifier attributes, the keyboard
 * attribute, and the two geometry variables.
 * @param snapshot - the snapshot to project.
 */
function projectDeviceState(snapshot: DeviceSnapshot): void {
  /* v8 ignore next -- browser capability module: every caller runs after install()'s DOM guard. */
  if (typeof document === 'undefined') return
  const root = document.documentElement
  const hasKeyboard = snapshot.keyboardOpen ? 'open' : undefined
  if (root.dataset.device !== snapshot.device) root.dataset.device = snapshot.device
  if (root.dataset.pointer !== snapshot.pointer) root.dataset.pointer = snapshot.pointer
  if (root.dataset.keyboard !== hasKeyboard) {
    if (hasKeyboard === undefined) root.removeAttribute('data-keyboard')
    else root.dataset.keyboard = hasKeyboard
  }
  root.style.setProperty('--dsh-keyboard-inset', `${String(snapshot.keyboardInset)}px`)
  const visualHeight = readVisualViewportHeight()
  if (visualHeight !== null) root.style.setProperty('--dsh-visual-viewport-height', `${String(Math.round(visualHeight))}px`)
}

let runtime: DeviceRuntime | undefined

/**
 * Read the browser-wide device runtime, creating it on first access.
 * @returns the shared runtime.
 */
export function getDeviceRuntime(): DeviceRuntime {
  runtime ??= new DeviceRuntime()
  return runtime
}

/**
 * Install the browser-wide device runtime. While an installation is live
 * (before its disposer ran) further calls return a no-op disposer, so a
 * double mount cannot strand a second listener set.
 * @returns the disposer removing listeners and root state.
 */
export function startDeviceRuntime(): () => void {
  return getDeviceRuntime().install()
}

/**
 * Read the environment and publish any change, for non-React readers.
 * @returns the fresh snapshot.
 */
export function getDeviceSnapshot(): DeviceSnapshot {
  return getDeviceRuntime().refresh()
}

/** Stable subscription for the shared runtime (module-level so the hook never resubscribes). */
const subscribeDevice = (listener: () => void): (() => void) => getDeviceRuntime().subscribe(listener)

/** Stable snapshot read: the render path never refreshes, the runtime's listeners commit. */
const readDevice = (): DeviceSnapshot => getDeviceRuntime().getSnapshot()

/**
 * Subscribe a component to the shared device snapshot. The runtime instance is
 * the platform-module singleton, so every client bundle observes one classifier.
 * @returns the current device, pointer, and soft-keyboard snapshot.
 */
export function useDevice(): DeviceSnapshot {
  return useSyncExternalStore(subscribeDevice, readDevice, readDevice)
}
