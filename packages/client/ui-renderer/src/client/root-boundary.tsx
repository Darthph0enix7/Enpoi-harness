/**
 * Last-resort error boundary above the assembled application. The per-entry
 * boundaries in the slot renderer contain registrant failures, but nothing sits
 * above the shell itself: a render error on the root path (or any error a slot
 * boundary rethrows as an assembly failure) would otherwise unmount the React
 * tree into a blank page. This boundary keeps a visible fallback mounted and
 * reports the crash to the web kernel's page-health surface, which performs the
 * guarded automatic reload.
 */
import { Component, type ReactNode } from 'react'

/** Page-global recovery face installed by the web kernel before mount. */
interface ClientHealthFace {
  fatal?(reason: unknown): void
}

/**
 * Report one fatal render error to the page-health surface.
 * @param error - the error that escaped every slot boundary.
 */
function reportFatal(error: unknown): void {
  try {
    (globalThis as { __DSH_CLIENT_HEALTH__?: ClientHealthFace }).__DSH_CLIENT_HEALTH__?.fatal?.(error)
  } catch {
    // The recovery surface must never replace the original failure.
  }
}

/**
 * Root boundary properties: rendered children plus the fallback shown after a
 * fatal error. The fallback is an owner-supplied node so this module owns no
 * product copy and the mount path decides what visibility survives a crash.
 */
export interface RootErrorBoundaryProps {
  /** Rendered only while no error has been caught. */
  children?: ReactNode
  /** Mounted in place of the application after a fatal render error. */
  fallback: ReactNode
}

/** Fatal-crash containment for the one React tree the application mounts. */
export class RootErrorBoundary extends Component<RootErrorBoundaryProps, { failed: boolean }> {
  override state = { failed: false }

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true }
  }

  override componentDidCatch(error: unknown): void {
    console.error('ui-renderer: fatal application render error:', error)
    reportFatal(error)
  }

  override render(): ReactNode {
    return this.state.failed ? this.props.fallback : this.props.children
  }
}
