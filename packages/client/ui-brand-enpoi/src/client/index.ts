/** Enpoi Harness brand occupants, Watchtower UI slots, and operator tabs. */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ModelDirectoryState } from '@deepseek-ai/dsh-client-ui-model-selection/client'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { EnpoiBrandMark, EnpoiBrandName } from './Brand.tsx'
import { WatchtowerView } from './WatchtowerView.tsx'
import {
  AgentModelsBody,
  FleetRoutingIcon,
  type AgentModelsDirectoryFace,
  type AgentModelsInjected,
} from './AgentModelsBody.tsx'
import { CapabilitiesBody, CapabilitiesIcon } from './CapabilitiesBody.tsx'
import {
  SubagentSessionsBody,
  SubagentSessionsIcon,
  type SubagentSessionsInjected,
} from './SubagentSessionsBody.tsx'
import { GitBody, GitIcon } from './GitBody.tsx'
import { TheMarkTaskCardAdapter } from './TheMarkTaskCardAdapter.tsx'
import { OrchestrationSettings } from './OrchestrationSettings.tsx'
import { PermissionsSettings } from './PermissionsSettings.tsx'
import { TerminalRegistry } from './terminal/registry.ts'
import type { TerminalInjected } from './terminal/contract.ts'
import type { TerminalRegistryState } from './terminal/registry.ts'
import { TerminalPanel } from './terminal/TerminalPanel.tsx'
import { BottomTerminalDock } from './terminal/BottomTerminalDock.tsx'
import { TerminalIcon } from './terminal/icons.tsx'
import { installTerminalStyles } from './terminal/styles.ts'
import {
  AGENT_MODELS_ID,
  AGENT_MODELS_KIND,
  CAPABILITIES_ID,
  CAPABILITIES_KIND,
  GIT_ID,
  GIT_KIND,
  SUBAGENT_SESSIONS_ID,
  SUBAGENT_SESSIONS_KIND,
  TERMINAL_ID,
  TERMINAL_KIND,
} from './kinds.ts'
import {
  getPersonaAssignments,
  subscribePersonaAssignments,
  setPersonaAssignment,
  clearPersonaAssignment,
  type PersonaMap,
} from './persona-store.ts'

/** Required services: the UI slot registry, right-sidebar tab registry, model directory, sessions, and locale. */
export const inject = ['slots', 'sidebarRightTabs', 'modelDirectories', 'sessions', 'locale']

/** Session-less model directory: the global catalog mapped to the directory state shape. */
type CatalogDirectoryFace = Omit<AgentModelsDirectoryFace, 'available'> & { available: true }

/**
 * Build the catalog-backed model-directory face used when the tab's session
 * cannot supply one (addressed subagent). The derived store is read-only:
 * ModelSelect subscribes and reads it, while updates always route to an
 * explicit persona assignment.
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
 * Resolve the Agent Models directory for the tab's session, falling back to
 * the global catalog when the id is empty, unknown, or an addressed subagent
 * (Agent-bound model RPCs stay out of that path).
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
 * Register brand marks, the Watchtower view tab, the four global operator
 * pages (Capabilities, Agent Models, Subagent Sessions, Git) with their
 * sidebar rail rows, the Orchestration settings section, and In-Chat Task
 * Cards.
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

  // 2c. Permission policy settings section (doc 55)
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'permissions',
    order: 21,
    label: () => 'Permissions',
  }, PermissionsSettings))

  // 3. Global operator tabs: right-Sidebar tab types (guide-discoverable) with
  // their bodies under the same implementation id.
  ctx.effect(() => ctx.sidebarRightTabs.register({
    id: CAPABILITIES_ID,
    kind: CAPABILITIES_KIND,
    priority: 'extension',
    title: () => 'Capabilities',
    guide: [{
      id: CAPABILITIES_KIND,
      order: 55,
      title: () => 'Capabilities',
      description: () => 'Toggle MCP servers, skills, and subagents',
      icon: CapabilitiesIcon,
    }],
  }), 'enpoi: capabilities tab type')
  ctx.effect(() => ctx.sidebarRightTabs.register({
    id: AGENT_MODELS_ID,
    kind: AGENT_MODELS_KIND,
    priority: 'extension',
    title: () => 'Agent Models',
    guide: [{
      id: AGENT_MODELS_KIND,
      order: 56,
      title: () => 'Agent Models',
      description: () => 'Assign a model to each fleet persona',
      icon: FleetRoutingIcon,
    }],
  }), 'enpoi: agent-models tab type')
  ctx.effect(() => ctx.sidebarRightTabs.register({
    id: SUBAGENT_SESSIONS_ID,
    kind: SUBAGENT_SESSIONS_KIND,
    priority: 'extension',
    title: () => 'Subagent Sessions',
    guide: [{
      id: SUBAGENT_SESSIONS_KIND,
      order: 57,
      title: () => 'Subagent Sessions',
      description: () => 'Watch and open dispatched subagent sessions',
      icon: SubagentSessionsIcon,
    }],
  }), 'enpoi: subagent-sessions tab type')
  ctx.effect(() => ctx.sidebarRightTabs.register({
    id: GIT_ID,
    kind: GIT_KIND,
    priority: 'extension',
    title: () => 'Git',
    guide: [{
      id: GIT_KIND,
      order: 58,
      title: () => 'Git',
      description: () => 'Branches, changes, and diffs for the session workspace',
      icon: GitIcon,
    }],
  }), 'enpoi: git tab type')
  ctx.effect(() => ctx.sidebarRightTabs.register({
    id: TERMINAL_ID,
    kind: TERMINAL_KIND,
    priority: 'extension',
    title: () => 'Terminal',
    guide: [{
      id: TERMINAL_KIND,
      order: 59,
      title: () => 'Terminal',
      description: () => 'Interactive shells in the sidebar and the bottom panel',
      icon: TerminalIcon,
    }],
  }), 'enpoi: terminal tab type')

  // enpoi: the browser terminal registry — one PTY per terminal, shared by the
  // right sidebar's terminal page and the bottom dock (each surface keeps its
  // own tabs; the same registry and transport back both).
  installTerminalStyles(ctx)
  const terminals = new TerminalRegistry()
  ctx.effect(() => () => { terminals.dispose() }, 'enpoi: terminal teardown')
  const terminalInjected = (): TerminalInjected => ({
    hooks: {
      terminals: {
        getSnapshot: (): TerminalRegistryState => terminals.state.getSnapshot(),
        subscribe: (listener: () => void) => terminals.state.subscribe(listener),
      } satisfies HostObservable<TerminalRegistryState>,
    },
    openTerminal: (sessionId, place, cwd) => { terminals.open(sessionId, place, cwd) },
    closeTerminal: (sessionId, id) => { terminals.close(sessionId, id) },
    activateTerminal: (sessionId, place, id) => { terminals.activate(sessionId, place, id) },
    writeTerminal: (sessionId, id, data) => { terminals.write(sessionId, id, data) },
    resizeTerminal: (sessionId, id, cols, rows) => { terminals.resize(sessionId, id, cols, rows) },
    subscribeTerminal: (sessionId, id, listener) => terminals.subscribe(sessionId, id, listener),
    readTerminal: (sessionId, id) => terminals.read(sessionId, id),
    toggleTerminalDock: () => { terminals.toggleDock() },
    setTerminalDockHeight: (px) => { terminals.setDockHeight(px) },
  })

  // enpoi: global toggle listener so the rail button and shortcuts work from anywhere on boot
  if (typeof window !== 'undefined') {
    window.addEventListener('enpoi-toggle-terminal-dock', () => {
      terminals.toggleDock()
    })
  }

  const fallbackDirectory = createCatalogDirectoryFace(ctx)
  ctx.slots.inject('sidebar.right.pane.tab', function* () {
    yield ctx.slots.register({
      name: 'sidebar.right.pane.tab',
      key: CAPABILITIES_ID,
    }, CapabilitiesBody)
    yield ctx.slots.register({
      name: 'sidebar.right.pane.tab',
      key: AGENT_MODELS_ID,
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
    }, AgentModelsBody)
    yield ctx.slots.register({
      name: 'sidebar.right.pane.tab',
      key: SUBAGENT_SESSIONS_ID,
      inject: (): SubagentSessionsInjected => {
        const uiWorkspace = ctx.get('uiWorkspace')
        const sessions = ctx.get('sessions')
        return {
          openSession: (id) => { uiWorkspace?.openSession(id) },
          // Children carry a durable parent address: a plain session address is
          // refused by the host for subagent-origin Sessions, so the panel opens
          // them through the catalog-derived subagent address instead (the
          // workspace navigation accepts either).
          openChild: (address) => { uiWorkspace?.openSession(address) },
          refreshSessions: async () => { await sessions?.refresh() },
        }
      },
    }, SubagentSessionsBody)
    yield ctx.slots.register({
      name: 'sidebar.right.pane.tab',
      key: GIT_ID,
    }, GitBody)
    yield ctx.slots.register({
      name: 'sidebar.right.pane.tab',
      key: TERMINAL_ID,
      inject: terminalInjected,
    }, TerminalPanel)
  })

  // enpoi: the bottom terminal dock (frame overlay). The dock hosts only
  // terminals; its tabs are its own terminals. The rail's bottom-panel control
  // in ui-sidebar-right is the one toggle; the conversation header carries none.
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'enpoi-bottom-terminal',
    order: 10,
    inject: terminalInjected,
  }, BottomTerminalDock))

  // 4. In-Chat Task Cards (The Mark) for subagent dispatches, Oracle reviews, and Council debates
  ctx.slots.inject('tool.call.toolview', function* () {
    const uiWorkspace = ctx.get('uiWorkspace')
    const openSession = (id: SessionId) => {
      uiWorkspace?.openSession(id)
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
