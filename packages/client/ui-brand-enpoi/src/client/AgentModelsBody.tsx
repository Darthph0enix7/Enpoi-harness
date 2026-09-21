/**
 * Agent Models — the global per-persona model assignment tab body
 * (`sidebar.right.pane.tab` key `enpoi-agent-models`, kind `agent-models`).
 *
 * Restored to where the original Enpoi sidebar hosted it: a first-class right
 * Sidebar tab beside Files/Terminal, not a main-column page. Persona
 * assignments persist to `enpoi-orchestration.personas` in settings.yaml and
 * apply to every session. Seats are built from the settings-backed role
 * registry (`enpoi-orchestration.roles`) plus every persona-assigned id with no
 * registry entry, so the fleet grows and shrinks with the operator's roles. The
 * keeper seat shows "Default" (its plugin Config route) instead of "Inherit" —
 * the keeper has no parent turn to inherit from.
 *
 * The tab's own `sessionId` addresses the model directory; the injected face
 * carries the persona assignment hook plus the assignment callbacks, and the
 * footer links to the Capabilities tab through the tab's own `openTab` action.
 */
import { useEffect, useMemo } from 'react'
import type { ModelSelection } from '@deepseek-ai/dsh-api-session-controller/types'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import { ModelSelect, type ModelSelectOverride, type ModelDirectoryState } from '@deepseek-ai/dsh-client-ui-model-selection/client'
import type { HostObservable, InjectFace, PropsRuntime, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { PersonaMap } from './persona-store.ts'
import { buildFleetCategories, type RoleRegistryMap } from './role-registry.ts'
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
   * plus the settings-backed role registry as `useRoleRegistry`.
   */
  hooks: {
    personaAssignments: HostObservable<PersonaMap>
    roleRegistry: HostObservable<RoleRegistryMap>
  }
  /**
   * Resolve the model directory for the tab's session (catalog fallback when
   * the session is an addressed subagent).
   * @param sessionId - the tab's session id.
   * @returns the stable directory face, or null when model data is unavailable.
   */
  resolveDirectory: (sessionId: string | undefined) => AgentModelsDirectoryFace | null
  /** Assign an explicit model to a persona globally. */
  assignPersona: (personaId: string, selection: ModelSelection) => void
  /** Clear an explicit assignment, reverting the persona to its fallback route. */
  clearPersona: (personaId: string) => void
  /** Translator bound to the shared model namespace, for the embedded picker's chrome. */
  t: TranslateNS<'model'>
}

export type AgentModelsBodyProps = PropsRuntime<'sidebar.right.pane.tab'> & InjectFace<AgentModelsInjected>

export function AgentModelsBody({
  sessionId,
  useTabInfo,
  usePersonaAssignments,
  useRoleRegistry,
  resolveDirectory,
  assignPersona,
  clearPersona,
  t,
}: AgentModelsBodyProps) {
  const { tab } = useTabInfo()
  const assignments = usePersonaAssignments(snapshot => snapshot)
  const registry = useRoleRegistry(snapshot => snapshot)

  // Seats come from the role registry; persona-assigned ids with no registry
  // entry keep their rows (the pre-registry arbiters, keeper, and debaters).
  const categories = useMemo(
    () => buildFleetCategories(registry, Object.keys(assignments)),
    [registry, assignments],
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

  return (
    <div className={css.container}>
      <header className={css.head}>
        <span className={css.headTitle}>Fleet Routing</span>
        <span className={css.headCount}>{totalSeats} seats</span>
      </header>
      <div className={css.groups}>
        {categories.map(category => (
          <div key={category.title} className={css.group}>
            <div className={css.groupTitle}>{category.title}</div>
            <div className={css.rows}>
              {category.seats.map((seat) => {
                const assigned = assignments[seat.id] ?? null
                const isExplicitlyAssigned = assigned !== null && Boolean(assigned.model)
                const override: ModelSelectOverride = {
                  current: isExplicitlyAssigned ? assigned : null,
                  placeholder: seat.defaultLabel ?? 'Inherit',
                  select: (selection) => {
                    assignPersona(seat.id, selection)
                    return Promise.resolve(true)
                  },
                }
                return (
                  <div key={seat.id} className={css.row} title={seat.defaultHint !== undefined && !isExplicitlyAssigned ? `${seat.name} — Default: ${seat.defaultHint}` : seat.name}>
                    <span className={css.icon}><MicroIcon d={seat.icon} size={11} /></span>
                    <span className={css.name}>{seat.name}</span>
                    <div className={css.controls}>
                      {isExplicitlyAssigned && (
                        <button
                          type="button"
                          className={css.unassignBtn}
                          onClick={() => { clearPersona(seat.id) }}
                          title={`Reset ${seat.name} to ${seat.defaultLabel ?? 'Inherit'} (no explicit model)`}
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
                          t={t}
                        />
                      ) : (
                        <span className={css.noDir}>no session</span>
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
        <span>Unassigned seats use the dispatching agent's model · Keeper uses its config route</span>
        <button
          type="button"
          className={css.footLink}
          onClick={() => { tab.actions.openTab(CAPABILITIES_KIND) }}
        >
          Capabilities
        </button>
      </footer>
    </div>
  )
}
