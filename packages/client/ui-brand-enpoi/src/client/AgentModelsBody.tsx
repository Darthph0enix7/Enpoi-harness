/**
 * Agent Models — the global per-persona model assignment tab body
 * (`sidebar.right.pane.tab` key `enpoi-agent-models`, kind `agent-models`).
 *
 * Restored to where the original Enpoi sidebar hosted it: a first-class right
 * Sidebar tab beside Files/Terminal, not a main-column page. Persona
 * assignments persist to `enpoi-orchestration.personas` in settings.yaml and
 * apply to every session. Seats are built from the settings-backed role
 * registry (`enpoi-orchestration.roles`), the live council registry
 * (`enpoiCouncil.list`, one group per council under its own label), and every
 * persona-assigned id neither claims, so the fleet grows and shrinks with the
 * operator's roles and councils. The keeper seat shows its exact built-in
 * default ("built-in default: kilo/kilo-auto/free") instead of "Inherit" — the
 * keeper has no parent turn to inherit from; the compaction seat is always
 * rendered (a designated seat) and inherits the session model by default,
 * because any other summariser breaks the prompt-prefix cache and pays full
 * input price for the region. Every row has an explicit state — assigned,
 * inherit, or built-in default — and a clear changes only that seat's state,
 * never which rows render.
 *
 * The tab's own `sessionId` addresses the model directory; the injected face
 * carries the persona assignment hook plus the assignment callbacks, and the
 * footer links to the Capabilities tab through the tab's own `openTab` action.
 */
import { useEffect, useMemo } from 'react'
import type { ModelSelection } from '@deepseek-ai/dsh-api-session-controller/types'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import { ModelSelect, type ModelSelectOverride, type ModelDirectoryState } from '@deepseek-ai/dsh-client-ui-model-selection/client'
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { PersonaMap } from './persona-store.ts'
import { buildFleetCategories, fleetSeatState, KEEPER_DEFAULT_ROUTE, type FleetCouncil, type RoleRegistryMap } from './role-registry.ts'
import { ensureSettingsFresh, SETTINGS_MOUNT_STALE_MS } from './settings-refresh.ts'
import { CAPABILITIES_KIND } from './kinds.ts'
import css from './AgentModelsBody.module.css'

/** Micro monochrome icon (10px, stroke currentColor). */
function MicroIcon({ d, size = 10 }: { d: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <path d={d} />
    </svg>
  )
}

/** Monochrome tab glyph for Agent Models (thin stroke, currentColor), also the guide capsule icon. */
export function FleetRoutingIcon({
  size = 16,
  className,
}: {
  size?: number | undefined
  active?: boolean | undefined
  className?: string | undefined
}) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" className={className}>
      <path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <circle cx="5.5" cy="4.5" r="1.4" fill="var(--dsh-sidebar-bg, #0f172a)" stroke="currentColor" strokeWidth="1.1" />
      <circle cx="10.5" cy="8" r="1.4" fill="var(--dsh-sidebar-bg, #0f172a)" stroke="currentColor" strokeWidth="1.1" />
      <circle cx="7.5" cy="11.5" r="1.4" fill="var(--dsh-sidebar-bg, #0f172a)" stroke="currentColor" strokeWidth="1.1" />
    </svg>
  )
}

/** One resolved model picker face: a live directory plus its load trigger. */
export interface AgentModelsDirectoryFace {
  available: boolean
  directory: SnapshotStore<ModelDirectoryState>
  load: () => void
}

/** Injected business face of the Agent Models tab (built in apply from ctx). */
export interface AgentModelsInjected {
  /**
   * The live persona assignment cache as a bound `usePersonaAssignments` hook,
   * the settings-backed role registry as `useRoleRegistry`, and the live
   * council registry (`enpoiCouncil.list`) as `useCouncilRegistry`.
   */
  hooks: {
    personaAssignments: HostObservable<PersonaMap>
    roleRegistry: HostObservable<RoleRegistryMap>
    councilRegistry: HostObservable<readonly FleetCouncil[]>
  }
  /**
   * Resolve the model directory for the tab's session (catalog fallback when
   * the session is an addressed subagent).
   * @param sessionId - the tab's session id.
   * @returns the stable directory face, or null when model data is unavailable.
   */
  resolveDirectory: (sessionId: string | undefined) => AgentModelsDirectoryFace | null
  /** Read the council registry when its cache is missing or older than the mount window. */
  ensureCouncils: () => void
  /** Assign an explicit model to a persona globally. */
  assignPersona: (personaId: string, selection: ModelSelection) => void
  /** Clear an explicit assignment, reverting the persona to its fallback route. */
  clearPersona: (personaId: string) => void
  /** Translator bound to the shared model namespace, for the embedded picker's chrome. */
  modelT: TranslateNS<'model'>
}

export type AgentModelsBodyProps =
  & PropsRuntime<'sidebar.right.pane.tab'>
  & PropsLocale<'brandEnpoi'>
  & InjectFace<AgentModelsInjected>

export function AgentModelsBody({
  sessionId,
  useTabInfo,
  usePersonaAssignments,
  useRoleRegistry,
  useCouncilRegistry,
  resolveDirectory,
  ensureCouncils,
  assignPersona,
  clearPersona,
  modelT,
  t,
}: AgentModelsBodyProps) {
  const { tab } = useTabInfo()
  const assignments = usePersonaAssignments(snapshot => snapshot)
  const registry = useRoleRegistry(snapshot => snapshot)
  const councils = useCouncilRegistry(snapshot => snapshot)

  // Seats come from the role registry plus the live council registry: each
  // council renders its own seats under its own label, arbiters share their
  // group, and persona-assigned ids neither registry claims keep rows.
  const categories = useMemo(
    () => buildFleetCategories(registry, Object.keys(assignments), councils, t),
    [registry, assignments, councils, t],
  )
  const totalSeats = useMemo(
    () => categories.reduce((count, category) => count + category.seats.length, 0),
    [categories],
  )

  const face = useMemo(
    () => resolveDirectory(typeof sessionId === 'string' ? sessionId : undefined),
    [resolveDirectory, sessionId],
  )

  // Prime the model directory once per resolved face.
  useEffect(() => {
    if (face !== null && face.available) face.load()
  }, [face])

  // A mount can be the first look after a missed push (reconnect, backgrounded
  // tab): re-read the shared settings cache when it aged past the window, and
  // the council registry under the same mount-staleness rule (it has its own
  // RPC and is re-read on the same pushes/reconnects through the store path).
  useEffect(() => {
    ensureSettingsFresh(SETTINGS_MOUNT_STALE_MS)
    ensureCouncils()
  }, [ensureCouncils])

  return (
    <div className={css.container}>
      <header className={css.head}>
        <span className={css.headTitle}>{t('agentFleetRouting')}</span>
        <span className={css.headCount}>{t('agentSeatCount', { count: totalSeats })}</span>
      </header>
      <div className={css.groups}>
        {categories.map(category => (
          <div key={category.key} className={css.group}>
            <div className={css.groupTitle}>{category.title}</div>
            <div className={css.rows}>
              {category.seats.map((seat) => {
                const assigned = assignments[seat.id] ?? null
                const state = fleetSeatState(assigned, seat)
                const isExplicitlyAssigned = state === 'assigned' && assigned !== null
                const stateLabel = isExplicitlyAssigned
                  ? `${assigned.provider}/${assigned.model}`
                  : seat.defaultLabel ?? t('agentInherit')
                const stateHint = isExplicitlyAssigned
                  ? t('agentAssigned', { name: stateLabel })
                  : seat.defaultHint !== undefined
                    ? t('agentStateWithHint', { state: stateLabel, hint: seat.defaultHint })
                    : stateLabel
                const override: ModelSelectOverride = {
                  current: isExplicitlyAssigned ? assigned : null,
                  placeholder: seat.defaultLabel ?? t('agentInherit'),
                  select: (selection) => {
                    assignPersona(seat.id, selection)
                    return Promise.resolve(true)
                  },
                }
                return (
                  <div key={seat.id} className={css.row} title={`${seat.name} — ${stateHint}`}>
                    <span className={css.icon}><MicroIcon d={seat.icon} size={11} /></span>
                    <span className={css.name}>{seat.name}</span>
                    <div className={css.controls}>
                      {isExplicitlyAssigned && (
                        <button
                          type="button"
                          className={css.unassignBtn}
                          onClick={() => { clearPersona(seat.id) }}
                          title={t('agentResetTitle', { name: seat.name, label: seat.defaultLabel ?? t('agentInherit') })}
                        >
                          <MicroIcon d="M4 8a4 4 0 118 0A4 4 0 014 8zm1 0h6" size={10} />
                        </button>
                      )}
                      {face !== null ? (
                        <ModelSelect
                          locked={false}
                          available={face.available}
                          directory={face.directory}
                          load={() => {}}
                          select={() => Promise.resolve(true)}
                          compact
                          override={override}
                          t={modelT}
                        />
                      ) : (
                        <span className={css.noDir}>{t('agentNoSession')}</span>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        ))}
      </div>
      <footer className={css.foot}>
        <span>{t('agentFootHint', { route: KEEPER_DEFAULT_ROUTE })}</span>
        <button
          type="button"
          className={css.footLink}
          onClick={() => { tab.actions.openTab(CAPABILITIES_KIND) }}
        >
          {t('agentCapabilities')}
        </button>
      </footer>
    </div>
  )
}
