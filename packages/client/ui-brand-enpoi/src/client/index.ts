/** Enpoi Harness brand occupants & Watchtower UI slots. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { EnpoiBrandMark, EnpoiBrandName } from './Brand.tsx'
import { WatchtowerView } from './WatchtowerView.tsx'
import { WatchtowerDock } from './WatchtowerDock.tsx'
import { TheMarkTaskCardAdapter } from './TheMarkTaskCardAdapter.tsx'

/** Required service: the UI slot registry. */
export const inject = ['slots']

/**
 * Register brand marks, Watchtower view tab, Ambient Dock strip, and In-Chat Task Cards.
 * @param ctx - Client root context.
 */
export function apply(ctx: Context): void {
  // 1. Brand marks in sidebar & conversation hero
  ctx.slots.inject('sidebar.brand.mark', () =>
    ctx.slots.inject('sidebar.brand.name', () =>
      ctx.slots.inject('conversation.hero.brand.mark', function* () {
        yield ctx.slots.register({ name: 'sidebar.brand.mark' }, EnpoiBrandMark)
        yield ctx.slots.register({ name: 'sidebar.brand.name' }, EnpoiBrandName)
        yield ctx.slots.register({ name: 'conversation.hero.brand.mark' }, EnpoiBrandMark)
      })))

  // 2. Watchtower Full-Canvas View Tab (`[Chat]` `[Trajectory]` `[Watchtower]`)
  ctx.slots.inject('conversation.view', () =>
    ctx.slots.register({
      name: 'conversation.view',
      id: 'watchtower',
      order: 30,
      label: () => 'Watchtower',
    }, WatchtowerView))

  // 3. Ambient Glanceable Cockpit Dock Strip (above composer)
  ctx.slots.inject('conversation.input.dock', () =>
    ctx.slots.register({
      name: 'conversation.input.dock',
      id: 'watchtower-dock',
      order: 15,
    }, WatchtowerDock))

  // 4. In-Chat Task Cards (The Mark) for subagent dispatches, Oracle reviews, and Council debates
  ctx.slots.inject('tool.call.toolview', function* () {
    yield ctx.slots.register({ name: 'tool.call.toolview', key: 'dispatch_task' }, TheMarkTaskCardAdapter)
    yield ctx.slots.register({ name: 'tool.call.toolview', key: 'oracle_review' }, TheMarkTaskCardAdapter)
    yield ctx.slots.register({ name: 'tool.call.toolview', key: 'roundtable' }, TheMarkTaskCardAdapter)
    yield ctx.slots.register({ name: 'tool.call.toolview', key: 'chorus' }, TheMarkTaskCardAdapter)
  })
}
