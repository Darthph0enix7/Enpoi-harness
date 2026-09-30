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
import { installDocumentBrand } from './document-brand.ts'
import { WatchtowerView } from './WatchtowerView.tsx'
import {
  AgentModelsBody,
  FleetRoutingIcon,
  type AgentModelsDirectoryFace,
  type AgentModelsInjected,
} from './AgentModelsBody.tsx'
import { CapabilitiesBody, CapabilitiesIcon, ensureCouncilsFresh, getCouncilRegistry, refreshCapabilities, refreshCouncils, setOpenSettingsHandler, subscribeCouncilRegistry } from './CapabilitiesBody.tsx'
import { setOpenSettingsSection } from './settings-nav.ts'
import {
  SubagentSessionsBody,
  SubagentSessionsIcon,
  type SubagentSessionsInjected,
} from './SubagentSessionsBody.tsx'
import { GitBody, GitIcon } from './GitBody.tsx'
import { TheMarkTaskCardAdapter } from './TheMarkTaskCardAdapter.tsx'
import { OrchestrationSettings, type OrchestrationSettingsInjected } from './OrchestrationSettings.tsx'
import {
  getCompactionPolicy,
  refreshCompactionPolicy,
  subscribeCompactionPolicy,
} from './compaction-policy.ts'
import { PermissionsSettings } from './PermissionsSettings.tsx'
import { SkillsSettings } from './skills/SkillsSettings.tsx'
import { en as skillsEn, zh as skillsZh, type SkillsSettingsKey } from './skills/locales.ts'
import { DynamicSettings } from './dynamic/DynamicSettings.tsx'
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
  refreshFromServer as refreshPersonaAssignments,
  type PersonaMap,
} from './persona-store.ts'
import { refreshFromServer as refreshOrchestrationParams, getOrchestrationParams, subscribeOrchestrationParams } from './params-store.ts'
import { refreshFromServer as refreshPermissionsView } from './permissions-model.ts'
import { refreshEffectiveRoles } from './role-effective.ts'
import {
  handleSettingsReconnect,
  installSettingsVisibilityListener,
  registerSettingsRefresh,
  requestSettingsRefresh,
  SETTINGS_MOUNT_STALE_MS,
} from './settings-refresh.ts'
import {
  getRoleRegistry,
  refreshFromServer as refreshRoleRegistry,
  subscribeRoleRegistry,
  type FleetCouncil,
  type RoleRegistryMap,
} from './role-registry.ts'

/** Required services: the UI slot registry, right-sidebar tab registry, model directory, sessions, locale, and Remote push. */
export const inject = ['slots', 'sidebarRightTabs', 'modelDirectories', 'sessions', 'locale', 'remote']

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Skills management section copy. */
    'settings.skills': SkillsSettingsKey
  }
}

/**
 * Cell priority for The Mark's keyed `tool.call.toolview` entries. Lower than
 * the default 0 so the fork card shadows upstream ui-tool's DetailsRow on keys
 * both claim (`subagent`), without a same-priority registration clash.
 */
const MARKS_SHADOW_PRIORITY = -1

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
          pending: null,
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
  // enpoi: cross-client live settings sync. A commit in the
  // enpoi-orchestration namespace by ANY open client, a transport reconnect,
  // or the tab becoming visible schedules one debounced fan-out; the stores
  // share a single coalesced settings.describe per burst, and each store
  // ignores server values for paths with a local write still in flight, so
  // optimistic edits are never clobbered.
  ctx.effect(() => {
    const unregister = [
      registerSettingsRefresh('persona', refreshPersonaAssignments),
      registerSettingsRefresh('params', refreshOrchestrationParams),
      registerSettingsRefresh('permissions', refreshPermissionsView),
      registerSettingsRefresh('roles', refreshRoleRegistry),
      registerSettingsRefresh('capabilities', refreshCapabilities),
      registerSettingsRefresh('councils', refreshCouncils),
      registerSettingsRefresh('effective-roles', refreshEffectiveRoles),
    ]
    // A push can be missed while the socket is down (a reconnected page keeps
    // its stale snapshot otherwise) or while the tab is backgrounded.
    const disposeReset = ctx.on('connection/reset', () => { handleSettingsReconnect() })
    const disposeVisibility = installSettingsVisibilityListener()
    const disposeUpdates = ctx.remote.$on('settings/document-updated', (ns) => {
      if (ns === 'enpoi-orchestration') requestSettingsRefresh()
    })
    return () => {
      for (const dispose of unregister) dispose()
      disposeReset()
      disposeVisibility()
      disposeUpdates()
    }
  }, 'enpoi: settings refresh triggers')

  // 1. Tab identity: the merged shell owns the title and icon links now, so
  // keep the fork product title and monogram applied through later writes.
  ctx.effect(() => installDocumentBrand(), 'enpoi: document title and favicon')

  // 1b. Brand marks in sidebar & conversation hero
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

  // 2b. Orchestration parameters settings section (doc 38). The effective
  // compaction-policy readout mirrors the backend derivation for the selected
  // summariser route, refreshed from the params/persona stores and the model
  // catalog (its context window is the derivation's input).
  ctx.effect(() => {
    const catalogStore = ctx.get('modelDirectories')?.catalog.store
    const recompute = (): void => {
      const catalog = catalogStore?.getSnapshot().value ?? undefined
      refreshCompactionPolicy(
        getOrchestrationParams().compaction,
        getPersonaAssignments()['compaction'] ?? null,
        catalog?.default ?? null,
        catalog,
      )
    }
    recompute()
    const disposers = [
      subscribeOrchestrationParams(recompute),
      subscribePersonaAssignments(recompute),
      catalogStore?.subscribe(recompute) ?? (() => {}),
    ]
    return () => {
      for (const dispose of disposers) dispose()
    }
  }, 'enpoi: compaction policy readout')
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'orchestration',
    order: 20,
    label: () => 'Orchestration',
    inject: (): OrchestrationSettingsInjected => ({
      hooks: {
        compactionPolicy: {
          getSnapshot: getCompactionPolicy,
          subscribe: subscribeCompactionPolicy,
        },
      },
      loadPolicyModels: () => {
        ctx.get('modelDirectories')?.catalog.load().catch(() => { /* surfaced on the catalog store */ })
      },
    }),
  }, OrchestrationSettings))

  // 2d. Dynamic entities settings section (doc 59): roles, councils, MCPs,
  // skills/tools, and the prompts behind them.
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'dynamic',
    order: 22,
    label: () => 'Dynamic',
  }, DynamicSettings))

  // 2e. Skills management settings section: list the live catalog and create,
  // edit, and delete skill definitions through the profile's fenced
  // /sidebar/fsops skills.* routes. Sits beside Dynamic, which only toggles
  // already-installed skills.
  ctx.effect(() => ctx.locale.register('settings.skills', { zh: skillsZh, en: skillsEn }), 'enpoi: skills section dictionaries')
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'skills',
    order: 23,
    label: () => ctx.locale.bind('settings.skills')('nav'),
    locale: 'settings.skills',
  }, SkillsSettings))

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

  // The drawer's Settings links resolve the shell's service lazily (the click
  // happens long after both plugins are up; either load order is fine).
  ctx.effect(() => {
    const openSection = (id: string): void => {
      const settingsUi = ctx.get('settingsUi') as { openSection?: (id: string) => void } | undefined
      settingsUi?.openSection?.(id)
    }
    setOpenSettingsHandler(openSection)
    setOpenSettingsSection(openSection)
    return () => {
      setOpenSettingsHandler(null)
      setOpenSettingsSection(null)
    }
  }, 'enpoi: settings-ui opener')

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
          roleRegistry: {
            getSnapshot: getRoleRegistry,
            subscribe: subscribeRoleRegistry,
          } satisfies HostObservable<RoleRegistryMap>,
          councilRegistry: {
            getSnapshot: getCouncilRegistry,
            subscribe: subscribeCouncilRegistry,
          } satisfies HostObservable<readonly FleetCouncil[]>,
        },
        resolveDirectory: sessionId => resolveAgentModelsDirectory(ctx, fallbackDirectory, sessionId),
        ensureCouncils: () => { ensureCouncilsFresh(SETTINGS_MOUNT_STALE_MS) },
        assignPersona: (personaId, selection) => { void setPersonaAssignment(personaId, selection) },
        clearPersona: (personaId) => { void clearPersonaAssignment(personaId) },
        // The embedded picker renders in the shared `model` namespace, so its
        // Groups title and "n models" rows resolve instead of echoing raw keys.
        t: ctx.locale.bind('model'),
      }),
    }, AgentModelsBody)
    yield ctx.slots.register({
      name: 'sidebar.right.pane.tab',
      key: SUBAGENT_SESSIONS_ID,
      inject: (): SubagentSessionsInjected => {
        const uiWorkspace = ctx.get('uiWorkspace')
        const sessions = ctx.get('sessions')
        return {
          hooks: {
            roleRegistry: {
              getSnapshot: getRoleRegistry,
              subscribe: subscribeRoleRegistry,
            } satisfies HostObservable<RoleRegistryMap>,
          },
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

  // 4. In-Chat Task Cards (The Mark) for subagent dispatches, Oracle reviews, and Council debates.
  // Keyed toolview entries shadow at a lower priority (ui-slots register: the
  // lowest live entry renders; a second entry at the same priority throws at
  // load). Upstream ui-tool claims `subagent` with its DetailsRow at priority 0,
  // so the fork card registers at MARKS_SHADOW_PRIORITY to deterministically win
  // that key — and never collides if upstream later claims any of the others.
  ctx.slots.inject('tool.call.toolview', function* () {
    const uiWorkspace = ctx.get('uiWorkspace')
    const openSession = (id: SessionId) => {
      uiWorkspace?.openSession(id)
    }
    for (const key of ['subagent', 'dispatch_task', 'task', 'oracle_review', 'roundtable', 'chorus']) {
      yield ctx.slots.register({
        name: 'tool.call.toolview',
        key,
        priority: MARKS_SHADOW_PRIORITY,
        inject: () => ({ openSession }),
      }, TheMarkTaskCardAdapter)
    }
  })
}
