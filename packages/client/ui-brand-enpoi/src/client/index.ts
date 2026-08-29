/** Enpoi Harness brand occupants & Watchtower UI slots. */
import { createElement } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { EnpoiBrandMark, EnpoiBrandName } from './Brand.tsx'
import { WatchtowerView } from './WatchtowerView.tsx'
import { FleetRoutingView, FleetRoutingIcon } from './FleetRoutingView.tsx'
import { TheMarkTaskCardAdapter } from './TheMarkTaskCardAdapter.tsx'
import { OrchestrationSettings } from './OrchestrationSettings.tsx'

/** Required services: the UI slot registry, the shared model directory, sessions, and locale. */
export const inject = ['slots', 'modelDirectories', 'sessions', 'locale']

/**
 * Register the Fleet Routing tab on the right activity rail (peer to
 * Capabilities & Tools). The betterSidebar service may activate before or
 * after this plugin — register immediately when present, otherwise wait for
 * the `internal/service` binding event.
 */
function registerFleetRoutingTab(ctx: Context, betterSidebar: unknown): void {
  const service = betterSidebar as {
    registerTab: (descriptor: {
      id: string
      title: string
      icon: (size: number) => React.ReactNode
      order: number
      single: boolean
      component: (props: { ctx: Context; scope: { sessionId: string; cwd?: string }; visible: boolean }) => React.ReactNode
    }) => () => void
  }
  const dispose = service.registerTab({
    id: 'routing',
    title: 'Agent Models',
    icon: (size: number) => createElement(FleetRoutingIcon, { size }),
    order: 60,
    single: true,
    component: props => createElement(FleetRoutingView, {
      ctx: props.ctx,
      scope: props.scope,
      visible: props.visible,
    }),
  })
  ctx.effect(() => dispose, 'enpoi: fleet routing tab')
}

/**
 * Register brand marks, the Watchtower view tab, the Fleet Routing rail tab,
 * and In-Chat Task Cards.
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
  ctx.slots.inject('conversation.view', () => {
    const sessions = ctx.get('sessions')
    // Waiting on the declaration: contribute nothing until the services exist.
    if (sessions === undefined) return function* () {}
    return ctx.slots.register({
      name: 'conversation.view',
      id: 'watchtower',
      order: 30,
      label: () => 'Watchtower',
    }, WatchtowerView)
  })

  // 2b. Orchestration parameters settings section (doc 38)
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'orchestration',
    order: 20,
    label: () => 'Orchestration',
  }, OrchestrationSettings))

  // 3. Fleet Routing rail tab (global persona model assignment)
  const betterSidebar = ctx.get('betterSidebar')
  if (betterSidebar !== undefined) {
    registerFleetRoutingTab(ctx, betterSidebar)
  } else {
    ctx.on('internal/service', (name: string, value: unknown) => {
      if (name === 'betterSidebar' && value !== undefined) {
        registerFleetRoutingTab(ctx, value)
      }
    })
  }

  // 4. In-Chat Task Cards (The Mark) for subagent dispatches, Oracle reviews, and Council debates
  ctx.slots.inject('tool.call.toolview', function* () {
    const sessions = ctx.get('sessions')
    const openSession = (id: SessionId) => {
      sessions?.open(id)
    }
    yield ctx.slots.register({
      name: 'tool.call.toolview',
      key: 'subagent',
      inject: () => ({ openSession }),
    }, TheMarkTaskCardAdapter)
    yield ctx.slots.register({
      name: 'tool.call.toolview',
      key: 'dispatch_task',
      inject: () => ({ openSession }),
    }, TheMarkTaskCardAdapter)
    yield ctx.slots.register({
      name: 'tool.call.toolview',
      key: 'task',
      inject: () => ({ openSession }),
    }, TheMarkTaskCardAdapter)
    yield ctx.slots.register({
      name: 'tool.call.toolview',
      key: 'oracle_review',
      inject: () => ({ openSession }),
    }, TheMarkTaskCardAdapter)
    yield ctx.slots.register({
      name: 'tool.call.toolview',
      key: 'roundtable',
      inject: () => ({ openSession }),
    }, TheMarkTaskCardAdapter)
    yield ctx.slots.register({
      name: 'tool.call.toolview',
      key: 'chorus',
      inject: () => ({ openSession }),
    }, TheMarkTaskCardAdapter)
  })
}
