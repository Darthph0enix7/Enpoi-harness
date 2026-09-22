import { useEffect, useRef } from 'react'
import { getDeviceSnapshot } from './device.ts'

/**
 * Centralized dismissal stack for browser history. Every dismissible surface
 * registers a handler under a stable id; registration pushes one synthetic
 * history record carrying that surface's depth, and the single `popstate`
 * listener pops the top of the stack in LIFO order (sub-sheet → picker/modal →
 * fullscreen panel → slide-over → child session). When the stack is empty the
 * listener does nothing, so native browser navigation keeps working and the
 * user is never trapped.
 *
 * Record depth, not record identity, pairs a navigation with a surface: a back
 * press delivers the state of the record it lands on, so the arriving depth
 * says whether the user moved back (one surface closes), forward (nothing
 * closes), or stepped across a record this stack already released (also
 * nothing). A surface closed programmatically steps its own record off with
 * `history.back()`; that echo carries the current depth and is ignored.
 *
 * The singleton lives in this package's platform-module entry, so every client
 * bundle shares one stack.
 * @module @deepseek-ai/dsh-client-ui-primitives/back-stack
 */

/** History-state key carrying the synthetic surface id (readable by e2e probes). */
export const BACK_SURFACE_STATE_KEY = 'dsh_surface_id'

/** History-state key carrying the per-registration token that pairs an entry with its record. */
export const BACK_SURFACE_TOKEN_KEY = 'dsh_surface_token'

/** History-state key carrying the synthetic record's depth (0 is the application's own history). */
export const BACK_SURFACE_DEPTH_KEY = 'dsh_surface_depth'

/** One open surface: a stable id, a unique token, and its dismissal handler. */
interface BackEntry {
  readonly id: string
  readonly token: number
  readonly depth: number
  readonly dismiss: () => void
}

/** Dismissal coordinator over one shared history stack. */
export class BackStack {
  private entries: BackEntry[] = []
  private currentDepth = 0
  private sequence = 0
  private listening = false

  /**
   * Open a surface: push its history record and register its dismissal.
   * @param id - stable surface id (e.g. `ui-primitives:modal`), for diagnostics and probes.
   * @param dismiss - closes the surface; runs when the entry is popped by back navigation.
   * @returns the deregister function closing the surface programmatically.
   */
  register(id: string, dismiss: () => void): () => void {
    const entry: BackEntry = { id, token: ++this.sequence, depth: ++this.currentDepth, dismiss }
    this.entries.push(entry)
    this.attach()
    window.history.pushState({
      [BACK_SURFACE_STATE_KEY]: id,
      [BACK_SURFACE_TOKEN_KEY]: entry.token,
      [BACK_SURFACE_DEPTH_KEY]: entry.depth,
    }, '')
    return () => { this.unregister(entry) }
  }

  /**
   * Read the number of registered surfaces.
   * @returns the stack depth.
   */
  depth(): number {
    return this.entries.length
  }

  /**
   * Dismiss the top surface through the same history step the back gesture
   * takes. A header back affordance renders while {@link depth} is positive and
   * calls this; the popstate it causes runs the registered handler.
   * @returns whether a surface was dismissed; false means the stack is empty
   *   and native browser navigation owns the press.
   */
  dismissTop(): boolean {
    if (this.entries.length === 0) return false
    window.history.back()
    return true
  }

  /**
   * Drop every entry and detach the listener without dismissing anything. For
   * teardown paths where the surfaces are already unmounting.
   */
  clear(): void {
    this.entries = []
    this.currentDepth = 0
    this.detach()
  }

  /** Close one registered surface without a back navigation. */
  private unregister(entry: BackEntry): void {
    const index = this.entries.indexOf(entry)
    if (index === -1) return
    this.entries.splice(index, 1)
    // A middle entry leaves its record as an ignorable step; only the top one
    // steps off the current history position.
    if (index !== this.entries.length) return
    this.currentDepth -= 1
    window.history.back()
  }

  /** The single popstate listener: pop the top entry, or leave native history alone. */
  private onPopState = (event: PopStateEvent): void => {
    const state: unknown = event.state
    const record = typeof state === 'object' && state !== null ? state as Record<string, unknown> : undefined
    const rawDepth = record?.[BACK_SURFACE_DEPTH_KEY]
    const nextDepth = typeof rawDepth === 'number' ? rawDepth : 0
    if (nextDepth === this.currentDepth) return // echo of this stack's own history.back()
    if (nextDepth > this.currentDepth) {
      this.currentDepth = nextDepth // forward: the surface the record belonged to stays closed
      return
    }
    this.currentDepth = nextDepth
    const top = this.entries[this.entries.length - 1]
    if (top === undefined) return // empty stack: native browser navigation owns this press
    this.entries.pop()
    try {
      top.dismiss()
    } catch (error) {
      console.error(`back stack: dismiss handler "${top.id}" failed:`, error)
    }
  }

  /** Attach the shared popstate listener on first registration. */
  private attach(): void {
    if (this.listening) return
    this.listening = true
    window.addEventListener('popstate', this.onPopState)
  }

  /** Detach the popstate listener once the stack is empty. */
  private detach(): void {
    if (!this.listening) return
    this.listening = false
    window.removeEventListener('popstate', this.onPopState)
  }
}

/** Browser-wide dismissal coordinator shared through the platform module table. */
export const backStack = new BackStack()

/**
 * Open a surface on the shared dismissal stack.
 * @param id - stable surface id, for diagnostics and entry pairing.
 * @param dismiss - closes the surface when back navigation pops its entry.
 * @returns the deregister function closing the surface programmatically.
 */
export function registerBackSurface(id: string, dismiss: () => void): () => void {
  return backStack.register(id, dismiss)
}

/**
 * Register a dismissal handler for as long as `active` holds, on touch devices
 * only — desktop keeps its own Escape/close affordances and normal browser
 * history, exactly as before the mobile foundation.
 * @param id - stable surface id, for diagnostics and entry pairing.
 * @param dismiss - closes the surface; the latest closure is always invoked.
 * @param active - whether the surface is currently open (default true).
 */
export function useBackHandler(id: string, dismiss: () => void, active = true): void {
  const latest = useRef(dismiss)
  latest.current = dismiss
  useEffect(() => {
    if (!active) return undefined
    if (getDeviceSnapshot().device === 'desktop') return undefined
    return backStack.register(id, () => { latest.current() })
  }, [active, id])
}
