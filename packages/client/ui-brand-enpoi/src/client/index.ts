/** Enpoi Harness brand occupants for the generic browser-brand slots. */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { EnpoiBrandMark, EnpoiBrandName } from './Brand.tsx'

/** Required service: the UI slot registry. */
export const inject = ['slots']

/**
 * Fill every brand slot with the Enpoi Harness mark and wordmark.
 * @param ctx - Client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.slots.inject('sidebar.brand.mark', () =>
    ctx.slots.inject('sidebar.brand.name', () =>
      ctx.slots.inject('conversation.hero.brand.mark', function* () {
        yield ctx.slots.register({ name: 'sidebar.brand.mark' }, EnpoiBrandMark)
        yield ctx.slots.register({ name: 'sidebar.brand.name' }, EnpoiBrandName)
        yield ctx.slots.register({ name: 'conversation.hero.brand.mark' }, EnpoiBrandMark)
      })))
}
