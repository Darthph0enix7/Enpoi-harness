import type { HeroBrandMarkOwnerProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SidebarBrandMarkOwnerProps } from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { EnpoiLogo } from './EnpoiLogo.tsx'

type EnpoiBrandMarkProps = Partial<HeroBrandMarkOwnerProps & SidebarBrandMarkOwnerProps>

/**
 * Render the Enpoi logo mark in the requested size.
 */
export function EnpoiBrandMark(props?: EnpoiBrandMarkProps) {
  const size = props?.size ?? 24
  const className = props?.className
  return <EnpoiLogo size={size} className={className} />
}

/**
 * Render the Enpoi Harness wordmark for the sidebar.
 */
export function EnpoiBrandName() {
  return (
    <div
      style={{
        display: 'inline-flex',
        alignItems: 'baseline',
        gap: '6px',
        userSelect: 'none',
        lineHeight: 1,
      }}
    >
      <span
        style={{
          fontSize: '15px',
          fontWeight: 700,
          letterSpacing: '-0.02em',
          background: 'linear-gradient(135deg, #67DCE7 0%, #A78BFA 55%, #F8F3F5 100%)',
          WebkitBackgroundClip: 'text',
          WebkitTextFillColor: 'transparent',
          fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
        }}
      >
        Enpoi
      </span>
      <span
        style={{
          fontSize: '12px',
          fontWeight: 500,
          color: 'var(--dsw-alias-label-secondary, #97ADCA)',
          letterSpacing: '-0.01em',
          fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
        }}
      >
        Harness
      </span>
    </div>
  )
}
