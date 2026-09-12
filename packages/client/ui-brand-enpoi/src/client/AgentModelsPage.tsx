/**
 * Agent Models — the global per-persona model assignment page (main key
 * `agent-models`, ordered 56 in the sidebar rail).
 *
 * Restored from the retired better-sidebar Fleet Routing tab as a native
 * `main` page: global server configuration, not session observability
 * (Oracle verdict: the Watchtower stays session-scoped). Persona assignments
 * persist to `enpoi-orchestration.personas` in settings.yaml and apply to
 * every session. Seats: Background & Supervision (Context Keeper, Oracle),
 * Specialist Workers, Roundtable Debaters, Chorus Brainstormers. The keeper
 * seat shows "Default" (its plugin Config route) instead of "Inherit" — the
 * keeper has no parent turn to inherit from.
 *
 * All live data arrives through the standard root hooks and the injected
 * face (persona assignments as a bound hook, directory resolution and the
 * assignment callbacks); the component never reaches for ctx.
 */
import { useEffect, useMemo } from 'react'
import type { ModelSelection } from '@deepseek-ai/dsh-api-session-controller/types'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import { ModelSelect, type ModelSelectOverride, type ModelDirectoryState } from '@deepseek-ai/dsh-client-ui-model-selection/client'
import type { HostObservable, InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type { PersonaMap } from './persona-store.ts'
import css from './AgentModelsPage.module.css'

/** The keeper's plugin Config route — shown as the "Default" sublabel. */
const KEEPER_DEFAULT_ROUTE = 'freellmapi/auto'

interface PersonaSeat {
  id: string
  name: string
  icon: string
  /** Seats without a parent turn show "Default" instead of "Inherit". */
  defaultLabel?: string
  defaultHint?: string
}

interface PersonaCategory {
  title: string
  seats: PersonaSeat[]
}

const FLEET_CATEGORIES: PersonaCategory[] = [
  {
    title: 'Background & Supervision',
    seats: [
      { id: 'keeper', name: 'Context Keeper', icon: 'M8 2l2 4 4 1-3 3 1 4-4-2-4 2 1-4-3-3 4-1z', defaultLabel: 'Default', defaultHint: KEEPER_DEFAULT_ROUTE },
      { id: 'oracle', name: 'The Oracle', icon: 'M8 3a5 5 0 100 10A5 5 0 008 3zm0 2v2m0 3v2' },
    ],
  },
  {
    title: 'Specialist Workers',
    seats: [
      { id: 'fixer', name: 'Fixer', icon: 'M10.5 2.5l3 3L6 13H3v-3z' },
      { id: 'explorer', name: 'Explorer', icon: 'M3 3h4v4H3zM9 9h4v4H9zM9 3h4M11 3v4M3 9h4M5 9v4' },
      { id: 'librarian', name: 'Librarian', icon: 'M3 4h4v9H3zM8 4h5v9H8zM3 13h10' },
      { id: 'designer', name: 'Designer', icon: 'M8 3l1.8 3.6L13.5 8l-3.7 1.4L8 13l-1.8-3.6L2.5 8l3.7-1.4z' },
    ],
  },
  {
    title: 'Roundtable Debaters',
    seats: [
      { id: 'skeptic', name: 'Skeptic', icon: 'M12 4l-8 8m0-8l8 8' },
      { id: 'architect', name: 'Architect', icon: 'M3 13V8m3 5V5m3 8V3m3 10V7' },
      { id: 'pragmatist', name: 'Pragmatist', icon: 'M3 8h10M10 4l3 4-3 4' },
      { id: 'critic', name: 'Critic', icon: 'M8 2a6 6 0 100 12A6 6 0 008 2zm0 3v4l3 2' },
    ],
  },
  {
    title: 'Chorus Brainstormers',
    seats: [
      { id: 'visionary', name: 'Visionary', icon: 'M8 2l2 4 4 1-3 3 1 4-4-2-4 2 1-4-3-3 4-1z' },
      { id: 'experiencer', name: 'Experiencer', icon: 'M3 8a5 5 0 0110 0c0 3-5 6-5 6s-5-3-5-6z' },
      { id: 'integrator', name: 'Integrator', icon: 'M4 4h4v4H4zM8 8h4v4H8z' },
      { id: 'curator', name: 'Curator', icon: 'M8 3v10M3 8h10' },
    ],
  },
]

const TOTAL_SEATS_COUNT = FLEET_CATEGORIES.reduce((acc, cat) => acc + cat.seats.length, 0)

/** Micro monochrome icon (10px, stroke currentColor). */
function MicroIcon({ d, size = 10 }: { d: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <path d={d} />
    </svg>
  )
}

/** Monochrome rail icon for the Agent Models page (thin stroke, currentColor). */
export function FleetRoutingIcon({ size = 18 }: { size?: number; active?: boolean }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
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

/** Injected business face of the Agent Models page (built in apply from ctx). */
export interface AgentModelsInjected {
  /** The persona assignment cache as a bound `usePersonaAssignments` hook. */
  hooks: { personaAssignments: HostObservable<PersonaMap> }
  /**
   * Resolve the model directory for the page's session (catalog fallback
   * when none is selected or the session is an addressed subagent).
   * @param sessionId - most recent root session id, or undefined.
   * @returns the stable directory face, or null when model data is unavailable.
   */
  resolveDirectory: (sessionId: string | undefined) => AgentModelsDirectoryFace | null
  /** Assign an explicit model to a persona globally. */
  assignPersona: (personaId: string, selection: ModelSelection) => void
  /** Clear an explicit assignment, reverting the persona to its fallback route. */
  clearPersona: (personaId: string) => void
}

export type AgentModelsPageProps = PropsRuntime<'main'> & InjectFace<AgentModelsInjected>

export function AgentModelsPage({
  useSessions,
  usePersonaAssignments,
  resolveDirectory,
  assignPersona,
  clearPersona,
}: AgentModelsPageProps) {
  // The global page has no session scope; the live catalog is addressed by the
  // most recent root session (loaded skills/cwd), falling back to the
  // session-less catalog-backed directory when none is open.
  const sessionId = useSessions(state => state.current ?? state.ids[0])
  const assignments = usePersonaAssignments(snapshot => snapshot)

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
        <span className={css.headCount}>{TOTAL_SEATS_COUNT} seats</span>
      </header>
      <div className={css.groups}>
        {FLEET_CATEGORIES.map(category => (
          <div key={category.title} className={css.group}>
            <div className={css.groupTitle}>{category.title}</div>
            <div className={css.rows}>
              {category.seats.map((seat) => {
                const assigned = assignments[seat.id] ?? null
                const isExplicitlyAssigned = assigned !== null && Boolean(assigned.model)
                const override: ModelSelectOverride = {
                  current: isExplicitlyAssigned ? assigned : null,
                  placeholder: seat.defaultLabel ?? 'Inherit',
                  select: selection => {
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
                          t={(key: string) => (key === 'effort.providerDefault' ? 'Default' : key)}
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
      </footer>
    </div>
  )
}
