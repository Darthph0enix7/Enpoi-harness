/** Enpoi Harness brand occupants & Watchtower UI slots. */
import type { Context } from '@deepseek-ai/cordis'
import type { ModelSelection, SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { EnpoiBrandMark, EnpoiBrandName } from './Brand.tsx'
import { WatchtowerView, type WatchtowerModelFace } from './WatchtowerView.tsx'
import { TheMarkTaskCardAdapter } from './TheMarkTaskCardAdapter.tsx'
import { CapabilitiesSettingsSection } from './CapabilitiesSettingsSection.tsx'

/** Required services: the UI slot registry, the shared model directory, sessions, and locale. */
export const inject = ['slots', 'modelDirectories', 'sessions', 'locale']

/**
 * Register brand marks, the Watchtower view tab, and In-Chat Task Cards.
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
    const models = ctx.get('modelDirectories')
    const sessions = ctx.get('sessions')
    // Waiting on the declaration: contribute nothing until the services exist.
    if (models === undefined || sessions === undefined) return function* () {}
    return ctx.slots.register({
      name: 'conversation.view',
      id: 'watchtower',
      order: 30,
      label: () => 'Watchtower',
      inject: (sessionId: SessionId): { models: WatchtowerModelFace; t: (key: string) => string } => {
        const directory = models.directoryFor(sessionId)
        const available = sessions.subagentAddress(sessionId) === undefined
        return {
          models: {
            available,
            directory: directory.store as SnapshotStore<never>,
            load: () => {
              if (available) directory.load().catch(() => { /* surfaced on the store */ })
            },
            /** Persona assignment persistence: settings ns `enpoi-orchestration`, path personas/<id>. */
            assign: (persona: string, selection: ModelSelection) =>
              fetch('/api/settings.mutate', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  type: 'client-request',
                  method: 'settings.mutate',
                  rpcId: `persona-assign-${persona}`,
                  payload: {
                    ns: 'enpoi-orchestration',
                    ops: [{ op: 'set', path: ['personas', persona], value: selection }],
                  },
                }),
              })
                .then(res => res.ok)
                .catch(() => false),
            /** Read persisted persona assignments (best effort; empty when unset). */
            readAssignments: () =>
              fetch('/api/settings.describe', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  type: 'client-request',
                  method: 'settings.describe',
                  rpcId: 'persona-read',
                  payload: {},
                }),
              })
                .then(async (res) => {
                  if (!res.ok) return null
                  const json: unknown = await res.json()
                  const namespaces = (json as { result?: { value?: { namespaces?: unknown } } })?.result?.value?.namespaces
                  const orchestration = Array.isArray(namespaces)
                    ? (namespaces as Array<{ ns?: string; value?: { personas?: Record<string, ModelSelection> }; user?: { personas?: Record<string, ModelSelection> } }>).find(n => n.ns === 'enpoi-orchestration')
                    : undefined
                  const personas = orchestration?.value?.personas ?? orchestration?.user?.personas
                  return personas ?? null
                })
                .catch(() => null),
          },
          t: (key: string) => (ctx.locale as { bind: (ns: string) => (k: string) => string }).bind('model')(key),
        }
      },
    }, WatchtowerView)
  })

  // 3. In-Chat Task Cards (The Mark) for subagent dispatches, Oracle reviews, and Council debates
  ctx.slots.inject('tool.call.toolview', function* () {
    yield ctx.slots.register({ name: 'tool.call.toolview', key: 'dispatch_task' }, TheMarkTaskCardAdapter)
    yield ctx.slots.register({ name: 'tool.call.toolview', key: 'oracle_review' }, TheMarkTaskCardAdapter)
    yield ctx.slots.register({ name: 'tool.call.toolview', key: 'roundtable' }, TheMarkTaskCardAdapter)
    yield ctx.slots.register({ name: 'tool.call.toolview', key: 'chorus' }, TheMarkTaskCardAdapter)
  })

  // 4. Capabilities Settings Section inside the Settings modal
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'capabilities',
    order: 15,
    label: () => 'Capabilities',
  }, CapabilitiesSettingsSection))
}
