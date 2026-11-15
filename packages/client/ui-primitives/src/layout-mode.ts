import { useSyncExternalStore } from 'react'
import { getDeviceRuntime } from './device.ts'
import type { DeviceSource } from './device.ts'

/**
 * Viewport layout mode for the application shell.
 *
 * This is deliberately separate from the device classifier: the layout mode is
 * a function of the available frame box and aspect, while `data-device` and
 * `data-pointer` stay the input-capability facts used for touch targets and
 * hover behavior. A narrow fine-pointer desktop therefore gets the compact
 * shell, and a touch device at a wide desktop-shaped window keeps the desktop
 * shell.
 *
 * The runtime projects `data-layout="desktop|compact"` onto `<html>` while
 * installed. The layout root feeds its measured frame width through
 * {@link LayoutModeRuntime.setFrameWidth}; other consumers read the same
 * snapshot through {@link useLayoutMode}. Height comes from the layout
 * viewport, never the visual viewport, so the soft keyboard cannot flip the
 * shell while the composer is focused.
 * @module @deepseek-ai/dsh-client-ui-primitives/layout-mode
 */

/** Which shell chrome the frame should draw. */
export type LayoutMode = 'desktop' | 'compact'

/**
 * The single breakpoint set behind the layout mode. Do not duplicate these
 * values in feature packages: consume {@link useLayoutMode}.
 */
export const LAYOUT_BREAKPOINTS = {
  /** Below this frame width the compact shell is always used. */
  compactWidth: 900,
  /** A portrait frame below this width uses the compact shell. */
  portraitWidth: 1100,
  /** A coarse-pointer frame below this resting height uses the compact shell. */
  shortHeight: 500,
  /** Extra width/height required to leave compact, preventing resize chatter. */
  hysteresis: 24,
} as const

/** The measurements the resolver consumes. */
export interface LayoutModeReading {
  /** The shell frame's content width in CSS px. */
  readonly frameWidth: number
  /** The resting layout-viewport height in CSS px; not the visual viewport. */
  readonly viewportHeight: number
  /** Whether the primary pointer is coarse, independent of touch support. */
  readonly coarsePointer: boolean
}

/** Published runtime state: the resolved mode plus the reading that produced it. */
export interface LayoutModeSnapshot extends LayoutModeReading {
  /** The shell mode consumers should render. */
  readonly mode: LayoutMode
}

/**
 * Resolve one layout mode reading.
 *
 * Compact is selected when any of these hold:
 * - the frame is narrower than {@link LAYOUT_BREAKPOINTS.compactWidth};
 * - the frame is portrait and narrower than
 *   {@link LAYOUT_BREAKPOINTS.portraitWidth};
 * - the pointer is coarse and the resting height is below
 *   {@link LAYOUT_BREAKPOINTS.shortHeight}.
 *
 * Leaving compact requires crossing the relevant boundary by the hysteresis
 * margin. The previous mode defaults to desktop for a first reading.
 * @param reading - frame width, resting viewport height, and pointer capability.
 * @param previous - the mode currently rendered, used only for hysteresis.
 * @returns the mode for this reading.
 */
export function resolveLayoutMode(reading: LayoutModeReading, previous: LayoutMode = 'desktop'): LayoutMode {
  const margin = previous === 'compact' ? LAYOUT_BREAKPOINTS.hysteresis : 0
  const widthCompact = reading.frameWidth < LAYOUT_BREAKPOINTS.compactWidth + margin
  const portraitCompact = reading.frameWidth < LAYOUT_BREAKPOINTS.portraitWidth + margin
    && reading.viewportHeight > reading.frameWidth
  const shortCompact = reading.coarsePointer
    && reading.viewportHeight < LAYOUT_BREAKPOINTS.shortHeight + margin
  return widthCompact || portraitCompact || shortCompact ? 'compact' : 'desktop'
}

/** @returns the layout viewport width, or 0 without a DOM. */
function readViewportWidth(): number {
  return typeof window === 'undefined' ? 0 : window.innerWidth
}

/** @returns an initial layout-viewport height, or 0 without a DOM. */
function readViewportHeight(): number {
  return typeof window === 'undefined' ? 0 : window.innerHeight
}

/** The first reading a server render may publish. */
const DESKTOP_SNAPSHOT: LayoutModeSnapshot = {
  mode: 'desktop',
  frameWidth: 0,
  viewportHeight: 0,
  coarsePointer: false,
}

/**
 * The shell-wide layout mode runtime.
 *
 * `install()` is reference-counted: the first owner subscribes to the device
 * runtime and projects `data-layout`; the last release removes both. This keeps
 * HMR and a replacement frame from stranding the subscription or the root
 * attribute while a second frame is still mounted. Height and pointer
 * capability come from that device snapshot, whose resting height stays stable
 * through the keyboard's resize-before-marker window.
 */
export class LayoutModeRuntime {
  private snapshot: LayoutModeSnapshot
  private readonly listeners = new Set<() => void>()
  private owners = 0
  private releaseDevice: (() => void) | undefined
  private frameWidth: number
  private restingHeight: number
  private coarsePointer: boolean
  private readonly device: DeviceSource

  /**
   * Create a runtime.
   * @param device - the device runtime's observable state; defaults to the
   *   shared singleton whose resting height already excludes a keyboard shrink.
   */
  constructor(device: DeviceSource = getDeviceRuntime()) {
    this.device = device
    const reading = device.getSnapshot()
    this.coarsePointer = reading.pointer === 'coarse'
    this.restingHeight = reading.restingHeight > 0 ? reading.restingHeight : readViewportHeight()
    this.snapshot = typeof window === 'undefined' ? DESKTOP_SNAPSHOT : {
      mode: 'desktop',
      frameWidth: readViewportWidth(),
      viewportHeight: this.restingHeight,
      coarsePointer: this.coarsePointer,
    }
    this.frameWidth = this.snapshot.frameWidth
    this.commit()
  }

  /** @returns the stable snapshot for the current reading. */
  getSnapshot(): LayoutModeSnapshot {
    return this.snapshot
  }

  /**
   * Subscribe to snapshot changes.
   * @param listener - called after each committed reading.
   * @returns the unsubscribe function.
   */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /**
   * Install the root projection and environment listeners. Idempotent per
   * owner; the returned disposer removes only this owner's interest.
   * @returns the release function for this installation.
   */
  install(): () => void {
    this.owners += 1
    if (this.owners === 1) this.attach()
    let released = false
    return () => {
      if (released) return
      released = true
      this.owners -= 1
      if (this.owners === 0) this.detach()
    }
  }

  /**
   * Feed the measured frame width from the shell's ResizeObserver.
   * @param width - frame content width in CSS px; non-positive values are ignored.
   */
  setFrameWidth(width: number): void {
    if (!Number.isFinite(width) || width <= 0) return
    this.frameWidth = Math.round(width)
    this.commit()
  }

  /** Attach to the device reading and project the first snapshot. */
  private attach(): void {
    /* v8 ignore next -- install runs from the client frame effect, which implies a DOM. */
    if (typeof window === 'undefined' || typeof document === 'undefined') return
    const root = document.documentElement
    this.frameWidth = readViewportWidth()
    // The device runtime owns the resting height and pointer capability. Its
    // resting height is stable across the keyboard settle window, so a resize
    // that arrives before `data-keyboard` is published cannot flip the shell.
    this.releaseDevice = this.device.subscribe(this.onDevice)
    this.onDevice()
    root.dataset.layout = this.snapshot.mode
  }

  /** Adopt the device runtime's resting height and pointer capability. */
  private onDevice = (): void => {
    const reading = this.device.getSnapshot()
    this.coarsePointer = reading.pointer === 'coarse'
    if (reading.restingHeight > 0) this.restingHeight = reading.restingHeight
    this.commit()
  }

  /** Remove the device subscription and the root projection. */
  private detach(): void {
    this.releaseDevice?.()
    this.releaseDevice = undefined
    /* v8 ignore next -- detach follows an attach that ran in the DOM. */
    if (typeof document !== 'undefined') document.documentElement.removeAttribute('data-layout')
  }

  /**
   * Recompute and publish the current reading, notifying only on a changed
   * snapshot. The root attribute is owned by the installed projection.
   */
  private commit(): void {
    const reading: LayoutModeReading = {
      frameWidth: this.frameWidth,
      viewportHeight: this.restingHeight,
      coarsePointer: this.coarsePointer,
    }
    const next: LayoutModeSnapshot = {
      ...reading,
      mode: resolveLayoutMode(reading, this.snapshot.mode),
    }
    const previous = this.snapshot
    this.snapshot = next
    if (this.owners > 0 && typeof document !== 'undefined') {
      document.documentElement.dataset.layout = next.mode
    }
    if (previous.mode === next.mode && previous.frameWidth === next.frameWidth
      && previous.viewportHeight === next.viewportHeight
      && previous.coarsePointer === next.coarsePointer) return
    for (const listener of [...this.listeners]) {
      try {
        listener()
      } catch (error) {
        console.error('layout mode subscriber failed:', error)
      }
    }
  }
}

let runtime: LayoutModeRuntime | undefined

/**
 * Read the shell-wide layout mode runtime, creating it on first access.
 * @returns the shared runtime.
 */
export function getLayoutModeRuntime(): LayoutModeRuntime {
  runtime ??= new LayoutModeRuntime()
  return runtime
}

/**
 * Install the root projection and listeners for the shared runtime.
 * @returns the release function; the last release removes `data-layout`.
 */
export function startLayoutModeRuntime(): () => void {
  return getLayoutModeRuntime().install()
}

/** @returns the current framework-facing snapshot, for diagnostics and tests. */
export function getLayoutModeSnapshot(): LayoutModeSnapshot {
  return getLayoutModeRuntime().getSnapshot()
}

/** Stable subscription against the shared runtime. */
const subscribeLayoutMode = (listener: () => void): (() => void) =>
  getLayoutModeRuntime().subscribe(listener)

/** Stable snapshot selector: React re-renders only when the mode string changes. */
const readLayoutMode = (): LayoutMode => getLayoutModeRuntime().getSnapshot().mode

/** The server snapshot is the desktop shell; the client re-reads on hydration. */
const readServerLayoutMode = (): LayoutMode => 'desktop'

/**
 * Subscribe to the shell layout mode.
 * @returns `desktop` or `compact` for the current frame and input capabilities.
 */
export function useLayoutMode(): LayoutMode {
  return useSyncExternalStore(subscribeLayoutMode, readLayoutMode, readServerLayoutMode)
}
