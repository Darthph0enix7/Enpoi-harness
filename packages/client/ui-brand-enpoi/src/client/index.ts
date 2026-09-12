/** Enpoi Harness brand occupants, Watchtower UI slots, and operator pages. */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ModelDirectoryState } from '@deepseek-ai/dsh-client-ui-model-selection/client'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { EnpoiBrandMark, EnpoiBrandName } from './Brand.tsx'
import { WatchtowerView } from './WatchtowerView.tsx'
import {
  AgentModelsPage,
  FleetRoutingIcon,
  type AgentModelsDirectoryFace,
  type AgentModelsInjected,
} from './AgentModelsPage.tsx'
import { CapabilitiesPage, CapabilitiesIcon } from './CapabilitiesPage.tsx'
import { TheMarkTaskCardAdapter } from './TheMarkTaskCardAdapter.tsx'
import { OrchestrationSettings } from './OrchestrationSettings.tsx'
import {
  getPersonaAssignments,
  subscribePersonaAssignments,
  setPersonaAssignment,
  clearPersonaAssignment,
  type PersonaMap,
} from './persona-store.ts'

/** Required services: the UI slot registry, the shared model directory, sessions, and locale. */
export const inject = ['slots', 'modelDirectories', 'sessions', 'locale']

/** Session-less model directory: the global catalog mapped to the directory state shape. */
type CatalogDirectoryFace = Omit<AgentModelsDirectoryFace, 'available'> & { available: true }

/**
 * Build the catalog-backed model-directory face used when no root session is
 * selected. The derived store is read-only: ModelSelect subscribes and reads
 * it, while updates always route to an explicit persona assignment.
 */
function createCatalogDirectoryFace(ctx: Context): CatalogDirectoryFace | null {
  const modelDirectories = ctx.get('modelDirectories')
  if (modelDirectories === undefined) return null
  const catalog = modelDirectories.catalog
  // uSES contract: getSnapshot must return the SAME reference until the fact
  // moves; derive once per catalog snapshot identity instead of per call.
  let derivedFrom: unknown
  let derived: ModelDirectoryState | undefined
  const directory = {
    subscribe: (fn: () => void) => catalog.store.subscribe(fn),
    getSnapshot: (): ModelDirectoryState => {
      const current = catalog.store.getSnapshot()
      if (derived === undefined || derivedFrom !== current) {
        derivedFrom = current
        derived = {
          current: current.value?.default ?? null,
          routable: null,
          groups: current.value?.groups ?? [],
          failures: current.value?.failures ?? [],
          status: current.status === 'ready' ? 'ready' as const : current.status === 'error' ? 'error' as const : 'idle' as const,
          error: current.error,
        }
      }
      return derived
    },
  } as unknown as SnapshotStore<ModelDirectoryState>
  return {
    available: true,
    directory,
    load: () => { catalog.load().catch(() => { /* surfaced on the catalog store */ }) },
  }
}

/**
 * Resolve the Agent Models directory for the addressed session, falling back
 * to the global catalog when the id is empty, unknown, or an addressed
 * subagent (Agent-bound model RPCs stay out of that path).
 */
function resolveAgentModelsDirectory(
  ctx: Context,
  fallback: CatalogDirectoryFace | null,
  sessionId: string | undefined,
): AgentModelsDirectoryFace | null {
  const modelDirectories = ctx.get('modelDirectories')
  if (modelDirectories === undefined) return fallback
  const sessions = ctx.get('sessions')
  if (sessionId !== undefined && sessionId !== '' && sessions !== undefined
    && sessions.subagentAddress(sessionId as SessionId) === undefined) {
    try {
      const directory = modelDirectories.directoryFor(sessionId as SessionId)
      return {
        available: true,
        directory: directory.store,
        load: () => { directory.load().catch(() => { /* surfaced on the store */ }) },
      }
    } catch {
      // Unknown sessions (closed between list and render) use the catalog.
      return fallback
    }
  }
  return fallback
}

/**
 * Register brand marks, the Watchtower view tab, the two global operator
 * pages (Capabilities, Agent Models) with their sidebar rail rows, the
 * Orchestration settings section, and In-Chat Task Cards.
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

  // 3. Global operator pages: `main` keys + matching `sidebar.panellist` rail
  // rows (the rail id must equal the registered main key or selection throws).
  const fallbackDirectory = createCatalogDirectoryFace(ctx)
  ctx.slots.inject('main', function* () {
    yield ctx.slots.register({
      name: 'main',
      key: 'capabilities',
    }, CapabilitiesPage)
    yield ctx.slots.register({
      name: 'main',
      key: 'agent-models',
      inject: (): AgentModelsInjected => ({
        hooks: {
          personaAssignments: {
            getSnapshot: getPersonaAssignments,
            subscribe: subscribePersonaAssignments,
          } satisfies HostObservable<PersonaMap>,
        },
        resolveDirectory: sessionId => resolveAgentModelsDirectory(ctx, fallbackDirectory, sessionId),
        assignPersona: (personaId, selection) => { void setPersonaAssignment(personaId, selection) },
        clearPersona: (personaId) => { void clearPersonaAssignment(personaId) },
      }),
    }, AgentModelsPage)
  })
  ctx.slots.inject('sidebar.panellist', function* () {
    yield ctx.slots.register({
      name: 'sidebar.panellist',
      id: 'capabilities',
      order: 55,
      label: () => 'Capabilities',
    }, CapabilitiesIcon)
    yield ctx.slots.register({
      name: 'sidebar.panellist',
      id: 'agent-models',
      order: 56,
      label: () => 'Agent Models',
    }, FleetRoutingIcon)
  })

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
