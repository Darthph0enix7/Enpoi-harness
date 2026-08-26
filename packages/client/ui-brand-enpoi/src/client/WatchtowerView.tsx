/**
 * The Watchtower: full-canvas session cockpit (`conversation.view` @30).
 * Minimal Liquid-Glass surface — icon+label micro headers, muted palette,
 * every value projected live (zero hardcoded copy): the Living Brief renders
 * only what the keeper actually wrote, personas carry the globally shared
 * compact ModelSelect (same directory, favorites, and visibility rules).
 */
import { useEffect, useMemo, useState } from 'react'
import type { ModelSelection } from '@deepseek-ai/dsh-api-remotes/client'
import { ModelSelect, type ModelSelectOverride } from '@deepseek-ai/dsh-client-ui-model-selection/client'
import css from './WatchtowerView.module.css'

/** Structural subset of the session snapshot the view reads. */
interface SessionLike {
  readonly id?: string
  readonly sessionId?: string
  readonly displayTitle?: string
  readonly title?: string
  readonly cwd?: string
}

interface WorkspaceLike {
  readonly activeWorkspace?: { readonly path?: string } | null
}

/** Structural subset of the living-brief projection the view renders. */
interface BriefLike {
  readonly goal?: string
  readonly freshness?: 'live' | 'cooling' | 'stale'
  readonly asOfSeq?: number
  readonly prose?: { readonly text?: string } | null
  readonly decisions?: readonly { readonly text: string }[]
  readonly blockers?: readonly { readonly text: string }[]
  readonly filesTouched?: readonly string[]
}

interface OracleLike { readonly status?: string }
interface CouncilLike { readonly status?: string }
interface MemoryLedgerLike { readonly committedCount?: number }

/** Injected model face built in apply() (directory + persona persistence). */
export interface WatchtowerModelFace {
  available: boolean
  directory: Parameters<typeof ModelSelect>[0]['directory']
  load: () => void
  assign: (persona: string, selection: ModelSelection) => Promise<boolean>
  readAssignments: () => Promise<Record<string, ModelSelection> | null>
}

export interface WatchtowerViewProps {
  useSession?: <S>(selector: (s: SessionLike) => S) => S
  sessionId?: string
  useProjection?: <T>(key: string, selector?: (v: unknown) => T) => T
  useWorkspaces?: <S>(selector: (w: WorkspaceLike) => S) => S
  models?: WatchtowerModelFace
  t?: (key: string) => string
}

interface PersonaSeat {
  id: string
  name: string
  icon: string
}

interface PersonaCategory {
  title: string
  seats: PersonaSeat[]
}

/** Persona categories and seats for delegated fleet (Orchestrator/Sysadmin are selected on main input card). */
const FLEET_CATEGORIES: PersonaCategory[] = [
  {
    title: 'Architecture & Supervision',
    seats: [
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

/** Parsed sections of the keeper's structured prose brief (no invented data). */
interface BriefSections {
  goal?: string[]
  docs?: string[]
  invariants?: string[]
  rejected?: string[]
  blockers?: string[]
}

function parseBriefSections(text: string): BriefSections {
  const sections: BriefSections = {}
  let currentSection = ''
  const currentLines: Record<string, string[]> = {}

  for (const line of text.split('\n')) {
    const t = line.trim()
    if (t.length === 0) continue
    if (t.includes('GOAL') || t.startsWith('🎯')) currentSection = 'goal'
    else if (t.includes('DOCUMENTATION') || t.includes('SPECIFICATION') || t.startsWith('📚')) currentSection = 'docs'
    else if (t.includes('INVARIANT') || t.includes('DECISION') || t.startsWith('🏛')) currentSection = 'invariants'
    else if (t.includes('REJECTED') || t.includes('EDGE CASE') || t.startsWith('🚫')) currentSection = 'rejected'
    else if (t.includes('BLOCKER') || t.includes('OPEN') || t.startsWith('⚡')) currentSection = 'blockers'
    else if (currentSection !== '') {
      const bucket = currentLines[currentSection] ?? []
      bucket.push(t.replace(/^[-•]\s*/, ''))
      currentLines[currentSection] = bucket
    }
  }

  if (currentLines.goal !== undefined) sections.goal = currentLines.goal
  if (currentLines.docs !== undefined) sections.docs = currentLines.docs
  if (currentLines.invariants !== undefined) sections.invariants = currentLines.invariants
  if (currentLines.rejected !== undefined) sections.rejected = currentLines.rejected
  if (currentLines.blockers !== undefined) sections.blockers = currentLines.blockers
  return sections
}

/** Micro monochrome icon (10px, stroke currentColor). */
function MicroIcon({ d, size = 10 }: { d: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <path d={d} />
    </svg>
  )
}

function SectionBlock({ icon, label, lines }: { icon: string; label: string; lines: string[] }) {
  if (lines.length === 0) return null
  return (
    <div className={css.section}>
      <div className={css.sectionHead}>
        <MicroIcon d={icon} />
        <span>{label}</span>
      </div>
      <div className={css.sectionBody}>
        {lines.map((line, i) => <div key={i}>{line}</div>)}
      </div>
    </div>
  )
}

export function WatchtowerView({ useSession, sessionId, useProjection, useWorkspaces, models, t }: WatchtowerViewProps) {
  const session = typeof useSession === 'function' ? useSession(s => s) : undefined
  const workspaces = typeof useWorkspaces === 'function' ? useWorkspaces(w => w) : undefined
  const [assignments, setAssignments] = useState<Record<string, ModelSelection>>({})

  const hasProjection = typeof useProjection === 'function'
  const livingBrief = hasProjection ? useProjection<BriefLike>('livingBrief') : undefined
  const oracle = hasProjection ? useProjection<OracleLike>('oracleScorecard') : undefined
  const council = hasProjection ? useProjection<CouncilLike>('councilState') : undefined
  const memory = hasProjection ? useProjection<MemoryLedgerLike>('memoryLedger') : undefined

  const sections = useMemo(
    () => (livingBrief?.prose?.text !== undefined ? parseBriefSections(livingBrief.prose.text) : null),
    [livingBrief?.prose?.text],
  )

  // Load persisted persona assignments once (best effort; absence = inherit).
  useEffect(() => {
    let cancelled = false
    if (models !== undefined) {
      void models.readAssignments().then((loaded) => {
        if (!cancelled && loaded !== null) setAssignments(loaded)
      })
    }
    return () => { cancelled = true }
  }, [models])

  // Directory current selection is the inherit-default for unassigned personas.
  const directory = models?.directory
  const inheritCurrent = useMemo(() => {
    if (directory === undefined) return null
    return (directory.getSnapshot() as { current?: ModelSelection | null }).current ?? null
  }, [directory])

  const handleHalt = () => {
    const target = sessionId ?? session?.sessionId ?? session?.id
    if (target === undefined) return
    void fetch('/api/session.cancel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', method: 'session.cancel', rpcId: 'wt-halt', payload: { sessionId: target } }),
    }).catch(() => {})
  }

  const freshness = livingBrief?.freshness
  const hasBrief = sections !== null
    && (sections.goal !== undefined || sections.docs !== undefined || sections.invariants !== undefined
      || sections.rejected !== undefined || sections.blockers !== undefined)
      || (livingBrief?.decisions !== undefined && livingBrief.decisions.length > 0)
      || (livingBrief?.blockers !== undefined && livingBrief.blockers.length > 0)

  const title = session?.displayTitle ?? session?.title
  const cwd = session?.cwd ?? workspaces?.activeWorkspace?.path

  return (
    <div className={css.container}>
      <header className={css.head}>
        <div className={css.headLeft}>
          <div
            className={css.freshnessBadge}
            data-state={freshness ?? 'none'}
            title={`Context Keeper: ${freshness === 'live' ? 'Live (synced)' : freshness === 'cooling' ? 'Ready (recent)' : freshness === 'stale' ? 'Stale' : 'Idle'} (as of seq ${livingBrief?.asOfSeq ?? 0})`}
          >
            <span className={css.freshnessDot} data-state={freshness ?? 'none'} />
            <span className={css.freshnessText}>
              Keeper · {freshness === 'live' ? 'Live' : freshness === 'cooling' ? 'Ready' : freshness === 'stale' ? 'Stale' : 'Idle'}
            </span>
          </div>
          <span className={css.headTitle}>{title ?? 'Watchtower'}</span>
          {cwd !== undefined && <span className={css.headPath}>{cwd}</span>}
          {livingBrief?.asOfSeq !== undefined && <span className={css.headSeq}>· seq {livingBrief.asOfSeq}</span>}
        </div>
        <div className={css.headRight}>
          {memory?.committedCount !== undefined && (
            <span className={css.microStat} title="Durable memory facts">
              <MicroIcon d="M3 3h2v2H3zM3 7h2v2H3zM3 11h2v2H3zM7 4h6M7 8h6M7 12h6" />
              {memory.committedCount}
            </span>
          )}
          {oracle?.status !== undefined && (
            <span className={css.microStat} title={`Oracle: ${oracle.status}`}>
              <MicroIcon d="M8 3a5 5 0 100 10A5 5 0 008 3z" />
              {oracle.status}
            </span>
          )}
          {council?.status !== undefined && (
            <span className={css.microStat} title={`Council: ${council.status}`}>
              <MicroIcon d="M3 13V8m3 5V5m3 8V3m3 10V7" />
              {council.status}
            </span>
          )}
          <button type="button" className={css.haltBtn} onClick={handleHalt} title="Emergency Halt">
            <MicroIcon d="M4 4h8v8H4z" size={9} />
          </button>
        </div>
      </header>

      <div className={css.grid}>
        {/* Living Brief — projected only, no fallback copy */}
        <section className={css.card}>
          <div className={css.cardHead}>
            <MicroIcon d="M3 2h8l2 2v10H3zM6 6h4M6 9h4" />
            <span>Brief</span>
          </div>
          {hasBrief ? (
            <>
              <SectionBlock icon="M8 2l1.5 4.5H14l-3.5 2.8L11.8 14 8 11.2 4.2 14l1.3-4.7L2 6.5h4.5z" label="Goal"
                lines={sections?.goal ?? (livingBrief?.goal !== undefined ? [livingBrief.goal] : [])} />
              <SectionBlock icon="M3 3h2v2H3zM3 7h2v2H3zM3 11h2v2H3zM7 4h6M7 8h6M7 12h6" label="Docs"
                lines={sections?.docs ?? []} />
              <SectionBlock icon="M3 13V8m3 5V5m3 8V3m3 10V7" label="Decisions"
                lines={sections?.invariants ?? (livingBrief?.decisions ?? []).map(d => d.text)} />
              <SectionBlock icon="M3 3l10 10M13 3L3 13" label="Rejected"
                lines={sections?.rejected ?? []} />
              <SectionBlock icon="M9 2L3 9h4l-1 5 6-7H8z" label="Blockers"
                lines={sections?.blockers ?? (livingBrief?.blockers ?? []).map(b => b.text)} />
              {livingBrief?.filesTouched !== undefined && livingBrief.filesTouched.length > 0 && (
                <div className={css.section}>
                  <div className={css.sectionHead}>
                    <MicroIcon d="M3 3h4l1 2h5v8H3z" />
                    <span>Files · {livingBrief.filesTouched.length}</span>
                  </div>
                  <div className={css.chipRow}>
                    {livingBrief.filesTouched.slice(0, 12).map((f, i) => (
                      <span key={i} className={css.pathChip} title={f}>{f}</span>
                    ))}
                  </div>
                </div>
              )}
            </>
          ) : (
            <div className={css.empty}>keeper idle — no brief yet</div>
          )}
        </section>

        {/* Fleet — shared compact ModelSelect per persona */}
        <section className={css.card}>
          <div className={css.cardHead}>
            <MicroIcon d="M2 13l6-10 6 10z" />
            <span>Fleet · {TOTAL_SEATS_COUNT}</span>
          </div>
          {models !== undefined && models.available ? (
            <div className={css.fleetGroups}>
              {FLEET_CATEGORIES.map(category => (
                <div key={category.title} className={css.fleetGroup}>
                  <div className={css.fleetGroupTitle}>{category.title}</div>
                  <div className={css.fleetRows}>
                    {category.seats.map((seat) => {
                      const assigned = assignments[seat.id] ?? inheritCurrent
                      const override: ModelSelectOverride = {
                        current: assigned,
                        select: (selection) => {
                          setAssignments(prev => ({ ...prev, [seat.id]: selection }))
                          return models.assign(seat.id, selection)
                        },
                      }
                      return (
                        <div key={seat.id} className={css.fleetRow} title={seat.name}>
                          <span className={css.fleetIcon}><MicroIcon d={seat.icon} size={11} /></span>
                          <span className={css.fleetName}>{seat.name}</span>
                          <ModelSelect
                            locked={false}
                            available={models.available}
                            directory={models.directory}
                            load={models.load}
                            select={() => Promise.resolve(true)}
                            compact
                            override={override}
                            t={t ?? (() => '')}
                          />
                        </div>
                      )
                    })}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className={css.empty}>model directory unavailable</div>
          )}
        </section>
      </div>
    </div>
  )
}
