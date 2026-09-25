/** Shared indeterminate loading feedback for document reads and rendering. */
import type { ReactNode } from 'react'
import clsx from 'clsx'
import { IconLoadingOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './LoadingIndicator.module.css'

/**
 * @param props - localized status label, carried as the accessible name with
 * no visible text, optional compact inline placement, and the caller's
 * placement style.
 * @returns an animated, accessible loading status.
 */
export function LoadingIndicator({ label, inline = false, className }: {
  label: string
  inline?: boolean
  className?: string | undefined
}): ReactNode {
  return <span className={clsx(css.loading, inline && css.inline, className)} role="status" aria-label={label} data-document-loading>
    <span className={css.icon} aria-hidden="true"><IconLoadingOutlineRegular /></span>
  </span>
}
