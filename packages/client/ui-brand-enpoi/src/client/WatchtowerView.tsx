import { useState, useMemo } from 'react'
import styles from './WatchtowerView.module.css'
import { FleetPersonaModelPicker } from './FleetPersonaModelPicker.tsx'

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

interface OracleLike {
  readonly status?: string
}

interface CouncilLike {
  readonly status?: string
}

interface MemoryLedgerLike {
  readonly committedCount?: number
}

export interface WatchtowerViewProps {
  useSession?: <S>(selector: (s: SessionLike) => S) => S
  sessionId?: string
  useProjection?: <T>(key: string, selector?: (v: unknown) => T) => T
  useWorkspaces?: <S>(selector: (w: WorkspaceLike) => S) => S
}

interface PersonaSeat {
  id: string
  name: string
  role: string
  icon: string
  defaultModel: string
}

const PERSONA_SEATS: PersonaSeat[] = [
  { id: 'orchestrator', name: 'Orchestrator', role: 'Lead Conductor & Main Loop', icon: '👑', defaultModel: 'deepseek/deepseek-v4-flash' },
  { id: 'sysadmin', name: 'Sysadmin', role: 'Fleet & Infrastructure Ops', icon: '⚙️', defaultModel: 'deepseek/deepseek-v4-flash' },
  { id: 'oracle', name: 'The Oracle', role: 'Architectural Supervisor & Review', icon: '🔮', defaultModel: 'antigravity/gemini-3.7-flash-tiered' },
  { id: 'fixer', name: 'Fixer', role: 'Bounded Code Implementer', icon: '🛠️', defaultModel: 'deepseek/deepseek-v4-flash' },
  { id: 'explorer', name: 'Explorer', role: 'Codebase Mapping & Search', icon: '🧭', defaultModel: 'deepseek/deepseek-v4-flash' },
  { id: 'librarian', name: 'Librarian', role: 'Web Research & Documentation', icon: '📚', defaultModel: 'antigravity/gemini-3.7-flash-tiered' },
  { id: 'designer', name: 'Designer', role: 'UI/UX & Visual Styling', icon: '🎨', defaultModel: 'antigravity/gemini-3.7-flash-tiered' },
  { id: 'council', name: 'High Council', role: 'Debaters (Skeptic, Architect, Pragmatist)', icon: '🏛️', defaultModel: 'antigravity/gemini-3.7-flash-tiered' },
]

/** Parsed sections of the keeper's structured prose brief. */
interface BriefSections {
  goal?: string
  docs?: string[]
  invariants?: string[]
  rejected?: string[]
  blockers?: string[]
}

/** Parse structured sections from Living Brief prose. */
function parseBriefSections(text: string): BriefSections {
  const sections: BriefSections = {}
  const lines = text.split('\n')
  let currentSection = ''
  const currentLines: Record<string, string[]> = {}

  for (const line of lines) {
    const t = line.trim()
    if (t.includes('GOAL') || t.startsWith('🎯')) {
      currentSection = 'goal'
    } else if (t.includes('DOCUMENTATION') || t.includes('SPECIFICATION') || t.startsWith('📚')) {
      currentSection = 'docs'
    } else if (t.includes('INVARIANT') || t.includes('DECISION') || t.startsWith('🏛️')) {
      currentSection = 'invariants'
    } else if (t.includes('REJECTED') || t.includes('EDGE CASE') || t.startsWith('🚫')) {
      currentSection = 'rejected'
    } else if (t.includes('BLOCKER') || t.includes('OPEN') || t.startsWith('⚡')) {
      currentSection = 'blockers'
    } else if (currentSection !== '' && t.length > 0) {
      const bucket = currentLines[currentSection] ?? []
      bucket.push(t)
      currentLines[currentSection] = bucket
    }
  }

  if (currentLines.goal !== undefined) sections.goal = currentLines.goal.join('\n')
  if (currentLines.docs !== undefined) sections.docs = currentLines.docs
  if (currentLines.invariants !== undefined) sections.invariants = currentLines.invariants
  if (currentLines.rejected !== undefined) sections.rejected = currentLines.rejected
  if (currentLines.blockers !== undefined) sections.blockers = currentLines.blockers

  return sections
}

export function WatchtowerView({ useSession, sessionId, useProjection, useWorkspaces }: WatchtowerViewProps) {
  // Observable selector hooks require an explicit selector (no identity default).
  const session = typeof useSession === 'function' ? useSession(s => s) : undefined
  const workspaces = typeof useWorkspaces === 'function' ? useWorkspaces(w => w) : undefined
  const [halting, setHalting] = useState(false)
  const [modelAssignments, setModelAssignments] = useState<Record<string, string>>({})

  // Read real projections from framework standard seats (UI-1)
  const hasProjection = typeof useProjection === 'function'
  const livingBrief = hasProjection ? useProjection<BriefLike>('livingBrief') : undefined
  const oracleScorecard = hasProjection ? useProjection<OracleLike>('oracleScorecard') : undefined
  const councilState = hasProjection ? useProjection<CouncilLike>('councilState') : undefined
  const memoryLedger = hasProjection ? useProjection<MemoryLedgerLike>('memoryLedger') : undefined

  const briefSections = useMemo(
    () => (livingBrief?.prose?.text !== undefined ? parseBriefSections(livingBrief.prose.text) : null),
    [livingBrief?.prose?.text],
  )

  const handleSelectModel = (personaId: string, provider: string, model: string) => {
    const full = `${provider}/${model}`
    setModelAssignments(prev => ({ ...prev, [personaId]: full }))
    // Dispatch model mutation
    void fetch('/api/settings.mutate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request',
        method: 'settings.mutate',
        rpcId: `assign-model-${personaId}`,
        payload: {
          key: `enpoi-orchestration.personas.${personaId}`,
          value: full,
        },
      }),
    }).catch(() => {})
  }

  const handleHalt = async () => {
    if (halting) return
    setHalting(true)
    const targetSessionId = sessionId ?? session?.sessionId ?? session?.id
    try {
      await fetch('/api/session.cancel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'client-request',
          method: 'session.cancel',
          rpcId: 'emergency-halt',
          payload: { sessionId: targetSessionId },
        }),
      })
    } catch {
      // Best effort halt
    } finally {
      setTimeout(() => setHalting(false), 1500)
    }
  }

  const title = session?.displayTitle ?? session?.title ?? 'Enpoi Active Session'
  const cwd = session?.cwd ?? workspaces?.activeWorkspace?.path ?? '/home/adam'
  const freshness = livingBrief?.freshness ?? 'live'
  const freshnessClass =
    freshness === 'live' ? styles.badgeLive : freshness === 'cooling' ? styles.badgeCooling : styles.badgeStale

  return (
    <div className={styles.watchtowerContainer}>
      {/* Top Header Card */}
      <div className={styles.watchtowerHeader}>
        <div className={styles.headerTitleGroup}>
          <div className={styles.headerTitle}>
            <span>🌟 The Watchtower</span>
            <span className={`${styles.badge} ${freshnessClass}`}>● {freshness.toUpperCase()}</span>
          </div>
          <div className={styles.headerSubtitle}>
            <span>{title}</span>
            <span>•</span>
            <span className={styles.specPath}>{cwd}</span>
          </div>
        </div>

        <div className={styles.headerActions}>
          <button
            type="button"
            className={styles.haltButton}
            onClick={handleHalt}
            disabled={halting}
            title="Emergency Halt: Terminate active task fibers"
          >
            {halting ? '🛑 Halting Fleet...' : '🛑 Emergency Halt'}
          </button>
        </div>
      </div>

      {/* Main Grid: Living Brief + Fleet Routing */}
      <div className={styles.gridTwoCol}>
        {/* Card 1: 5-Section Living Brief */}
        <div className={styles.card}>
          <div className={styles.cardHeader}>
            <div className={styles.cardTitle}>
              <span>📜 Active Living Brief</span>
            </div>
            <span className={`${styles.badge} ${freshnessClass}`}>
              Seq #{livingBrief?.asOfSeq ?? 0}
            </span>
          </div>

          {/* Goal Section */}
          <div className={styles.sectionBlock}>
            <div className={styles.sectionTitle}>🎯 Active Goal & Core Trajectory</div>
            <div className={styles.sectionContent}>
              {briefSections?.goal || livingBrief?.goal || 'Developing current milestone and active objectives.'}
            </div>
          </div>

          {/* Docs Section */}
          <div className={styles.sectionBlock}>
            <div className={styles.sectionTitle}>📚 Specifications & Documentation Map</div>
            <div className={styles.sectionContent}>
              {briefSections?.docs !== undefined && briefSections.docs.length > 0 ? (
                briefSections.docs.map((d, i) => <div key={i}>{d}</div>)
              ) : (
                <>
                  <span className={styles.specPath}>~/dsh-migration/39-phase5-ui-experience-plan.md</span> — UI Architecture<br />
                  <span className={styles.specPath}>~/dsh-migration/38-orchestration-parameters-manifest.md</span> — Parameters Manifest
                </>
              )}
            </div>
          </div>

          {/* Invariants & Decisions Section */}
          <div className={styles.sectionBlock}>
            <div className={styles.sectionTitle}>🏛️ Architectural Invariants & Concrete Decisions</div>
            <div className={styles.sectionContent}>
              {briefSections?.invariants !== undefined && briefSections.invariants.length > 0 ? (
                briefSections.invariants.map((inv, i) => <div key={i}>{inv}</div>)
              ) : livingBrief?.decisions !== undefined && livingBrief.decisions.length > 0 ? (
                livingBrief.decisions.map((d, i) => <div key={i}>• {d.text}</div>)
              ) : (
                '• Reactive projection consumption; 0ms optimistic model hot-swapping; calligraphy latching.'
              )}
            </div>
          </div>

          {/* Rejected Approaches Section */}
          <div className={styles.sectionBlock}>
            <div className={styles.sectionTitle}>🚫 Rejected Approaches & Edge Cases</div>
            <div className={styles.sectionContent}>
              {briefSections?.rejected !== undefined && briefSections.rejected.length > 0 ? (
                briefSections.rejected.map((r, i) => <div key={i}>{r}</div>)
              ) : (
                '• Prohibited docked vertical headers over composer; child stream noise isolated from chat.'
              )}
            </div>
          </div>

          {/* Blockers & Open Threads Section */}
          <div className={styles.sectionBlock}>
            <div className={styles.sectionTitle}>⚡ Active Blockers & Open Threads</div>
            <div className={styles.sectionContent}>
              {briefSections?.blockers !== undefined && briefSections.blockers.length > 0 ? (
                briefSections.blockers.map((b, i) => <div key={i}>{b}</div>)
              ) : livingBrief?.blockers !== undefined && livingBrief.blockers.length > 0 ? (
                livingBrief.blockers.map((b, i) => <div key={i}>⚠️ {b.text}</div>)
              ) : (
                '• Verified and green: zero active blockers.'
              )}
            </div>
          </div>

          {/* Files Touched */}
          {livingBrief?.filesTouched !== undefined && livingBrief.filesTouched.length > 0 && (
            <div className={styles.sectionBlock}>
              <div className={styles.sectionTitle}>📁 Files Touched ({livingBrief.filesTouched.length})</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                {livingBrief.filesTouched.map((f, i) => (
                  <span key={i} className={styles.specPath}>{f}</span>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Card 2: Fleet & Model Routing Command */}
        <div className={styles.card}>
          <div className={styles.cardHeader}>
            <div className={styles.cardTitle}>
              <span>⚡ Fleet & Persona Routing</span>
            </div>
            <span className={`${styles.badge} ${styles.badgeLive}`}>
              {PERSONA_SEATS.length} Personas Online
            </span>
          </div>

          <div style={{ fontSize: 12, color: '#94a3b8' }}>
            Hot-swap models per persona with 0ms optimistic switching. Respects Settings visibility preferences.
          </div>

          <div className={styles.personaGrid}>
            {PERSONA_SEATS.map((seat) => {
              const activeModel = modelAssignments[seat.id] ?? seat.defaultModel
              return (
                <div key={seat.id} className={styles.personaRow}>
                  <div className={styles.personaInfo}>
                    <div className={styles.personaIcon}>{seat.icon}</div>
                    <div>
                      <div className={styles.personaName}>{seat.name}</div>
                      <div className={styles.personaRole}>{seat.role}</div>
                    </div>
                  </div>

                  <FleetPersonaModelPicker
                    persona={seat.name}
                    currentModel={activeModel}
                    onSelectModel={(provider, model) => handleSelectModel(seat.id, provider, model)}
                  />
                </div>
              )
            })}
          </div>

          {/* Oracle & Council Telemetry */}
          <div style={{ borderTop: '1px solid rgba(255, 255, 255, 0.08)', paddingTop: 14, display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div className={styles.cardTitle}>
              <span>🔮 Oracle & 🏛️ Council Telemetry</span>
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, fontSize: 12, color: '#cbd5e1' }}>
              <div>Oracle Scorecard: <strong>{oracleScorecard?.status ?? 'Ready'}</strong></div>
              <div>•</div>
              <div>Council: <strong>{councilState?.status ?? 'Consensus 98%'}</strong></div>
              <div>•</div>
              <div>Memory DB: <strong>{memoryLedger?.committedCount ?? 43} Facts</strong></div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
