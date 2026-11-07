/**
 * enpoi: mount a heavy tab or settings body only when its surface first
 * renders. The wrapper keeps the registration point (and therefore the slot
 * order) unchanged while the body module ships as a package-local
 * `require.async` chunk. A failed chunk fetch keeps the retry affordance in
 * product copy and retries with a fresh `lazy` instance, so React's cached
 * rejection never becomes permanent.
 */
import {
  Component as ReactComponent,
  Suspense,
  lazy,
  useMemo,
  useState,
  type ComponentType,
  type LazyExoticComponent,
  type ReactNode,
} from 'react'

/** Props shared by every deferred surface: one loader and its boundary copy. */
export interface LazySurfaceProps<P extends object> {
  /** Module loader for the deferred body; keep it module-stable. */
  readonly load: () => Promise<{ default: ComponentType<P> }>
  /** Render the resolved component; the caller owns its concrete props spread. */
  readonly render: (component: LazyExoticComponent<ComponentType<P>>) => ReactNode
  /** Shown while the chunk arrives. */
  readonly fallback: ReactNode
  /** Localized message for a rejected chunk fetch. */
  readonly failed: string
  /** Localized retry control label. */
  readonly retry: string
}

interface LazyErrorBoundaryProps {
  readonly failed: string
  readonly retry: string
  readonly onRetry: () => void
  readonly children: ReactNode
}

interface LazyErrorBoundaryState {
  readonly failed: boolean
}

/** Catch one rejected dynamic import and offer a fresh attempt. */
class LazyErrorBoundary extends ReactComponent<LazyErrorBoundaryProps, LazyErrorBoundaryState> {
  override state: LazyErrorBoundaryState = { failed: false }

  static getDerivedStateFromError(): LazyErrorBoundaryState {
    return { failed: true }
  }

  override render(): ReactNode {
    if (this.state.failed) {
      return (
        <div role="alert" data-enpoi-lazy-error>
          <span>{this.props.failed}</span>
          <button type="button" data-enpoi-lazy-retry onClick={this.props.onRetry}>
            {this.props.retry}
          </button>
        </div>
      )
    }
    return this.props.children
  }
}

/**
 * Suspend while a deferred body chunk arrives, then render it.
 * @param props - loader, forwarded props, fallback, and the localized failure copy.
 * @returns the boundary around the resolved body.
 */
export function LazySurface<P extends object>({
  load, render, fallback, failed, retry,
}: LazySurfaceProps<P>): ReactNode {
  const [generation, setGeneration] = useState(0)
  // A new generation builds a new lazy component, so a rejected import is
  // re-attempted instead of replaying React.lazy's cached rejection.
  const Loaded = useMemo(() => lazy(load), [load, generation])
  return (
    <LazyErrorBoundary
      key={generation}
      failed={failed}
      retry={retry}
      onRetry={() => { setGeneration(value => value + 1) }}
    >
      <Suspense fallback={fallback}>
        {render(Loaded)}
      </Suspense>
    </LazyErrorBoundary>
  )
}
