import type { HeroBrandMarkOwnerProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SidebarBrandMarkOwnerProps } from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { EnpoiMark, EnpoiWordmark } from '@deepseek-ai/dsh-client-ui-primitives'

type EnpoiBrandMarkProps = Partial<HeroBrandMarkOwnerProps & SidebarBrandMarkOwnerProps>

/**
 * Render the Enpoi logo mark in the requested size.
 */
export function EnpoiBrandMark(props?: EnpoiBrandMarkProps) {
  const size = props?.size ?? 24
  const className = props?.className
  return <EnpoiMark size={size} className={className} />
}

/**
 * Render the Enpoi Harness wordmark for the sidebar.
 */
export function EnpoiBrandName() {
  return <EnpoiWordmark />
}
