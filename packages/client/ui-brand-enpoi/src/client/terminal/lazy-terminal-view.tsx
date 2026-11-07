/**
 * enpoi: the terminal emulator loads only when a terminal tab first renders.
 * The module-level loader keeps the same chunk request on every component
 * identity; the shared surface owns the Suspense fallback and retry.
 */
import type { ReactNode } from 'react'
import { LazySurface } from '../lazy-surface.tsx'
import type { BrandT } from '../locales.ts'
import css from './TerminalPanel.module.css'
import type { TerminalViewProps } from './TerminalView.tsx'

const loadTerminalView = async (): Promise<{ default: (props: TerminalViewProps) => ReactNode }> =>
  ({ default: (await import('./TerminalView.tsx')).TerminalView })

/** Props of the deferred terminal emulator: the view contract plus the copy seat. */
export type LazyTerminalViewProps = TerminalViewProps & { readonly t: BrandT }

/**
 * Render the terminal emulator from its deferred chunk.
 * @param props - the view's transport contract and the package copy seat.
 * @returns the pending marker, the emulator, or a retryable failure.
 */
export function LazyTerminalView(props: LazyTerminalViewProps): ReactNode {
  const { t, ...view } = props
  return (
    <LazySurface
      load={loadTerminalView}
      render={Component => <Component {...view} />}
      failed={t('terminalLoadFailed')}
      retry={t('commonRetry')}
      fallback={<div className={css.lazyPending} role="status" data-enpoi-terminal-pending>{t('terminalLoading')}</div>}
    />
  )
}
