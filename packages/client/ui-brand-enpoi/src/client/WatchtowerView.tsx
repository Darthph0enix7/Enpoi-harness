/**
 * The Watchtower: full-canvas session cockpit (`conversation.view` @30).
 * Minimal Liquid-Glass surface — icon+label micro headers, muted palette,
 * every value projected live (zero hardcoded copy): the Living Brief renders
 * only what the keeper actually wrote. Session observability ONLY — global
 * persona model routing lives in the Fleet Routing rail tab.
 */
import { useEffect, useMemo, useState } from 'react'
import { MicroIcon } from './MicroIcon.tsx'
import { WhiteboardCard, type WhiteboardPhase } from './WhiteboardCard.tsx'
import {
  fetchWhiteboardStore,
  splitWhiteboard,
  type WhiteboardBoardSplit,
  type WhiteboardScopeFacts,
  type WhiteboardStoreView,
} from './whiteboard-view.ts'
import css from './WatchtowerView.module.css'

/** Structural subset of the session snapshot the view reads. */
interface SessionLike {
  readonly id?: string
  readonly sessionId?: string
  readonly displayTitle?: string
  readonly title?: string
  readonly cwd?: string
  /** Durable subagent address; carries the direct-parent session id. */
  readonly subagent?: { readonly address?: { readonly parentSessionId?: string } | null } | null
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

export interface WatchtowerViewProps {
  useSession?: <S>(selector: (s: SessionLike) => S) => S
  sessionId?: string
  useProjection?: <T>(key: string, selector?: (v: unknown) => T) => T
  useWorkspaces?: <S>(selector: (w: WorkspaceLike) => S) => S
}

/** Parsed sections of the keeper's structured prose brief (no invented data). */
interface BriefSections {
  goal?: string[]
  docs?: string[]
  invariants?: string[]
  rejected?: string[]
  blockers?: string[]
}

/** First word of a line after markdown/emoji decoration, uppercased. */
function headerWord(line: string): string {
  const stripped = line
    .replace(/^[\s>#*\-•\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]+/u, '')
    .trim()
  return stripped.split(/\s+/)[0]?.toUpperCase() ?? ''
}

export function parseBriefSections(text: string): BriefSections {
  const sections: BriefSections = {}
  let currentSection = ''
  const currentLines: Record<string, string[]> = {}

  for (const line of text.split('\n')) {
    const t = line.trim()
    if (t.length === 0) continue
    // A section header is judged by the line's FIRST word (after decoration);
    // matching keywords mid-sentence used to re-file ordinary prose.
    const head = headerWord(t)
    if (head.startsWith('GOAL') || t.startsWith('🎯')) currentSection = 'goal'
    else if (head.startsWith('DOCUMENTATION') || head.startsWith('SPECIFICATION') || t.startsWith('📚')) currentSection = 'docs'
    else if (head.startsWith('INVARIANT') || head.startsWith('DECISION') || t.startsWith('🏛')) currentSection = 'invariants'
    else if (head.startsWith('REJECTED') || head.startsWith('EDGE') || t.startsWith('🚫')) currentSection = 'rejected'
    else if (head.startsWith('BLOCKER') || head.startsWith('OPEN') || t.startsWith('⚡')) currentSection = 'blockers'
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

/** Live whiteboard read state; the card owns the degradation copy. */
interface WhiteboardRead {
  phase: WhiteboardPhase
  store: WhiteboardStoreView | null
}

/** Whiteboard re-read cadence while the Watchtower is mounted. */
const WHITEBOARD_REFRESH_MS = 10_000

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

export function WatchtowerView({ useSession, sessionId, useProjection, useWorkspaces }: WatchtowerViewProps) {
  const session = typeof useSession === 'function' ? useSession(s => s) : undefined
  const workspaces = typeof useWorkspaces === 'function' ? useWorkspaces(w => w) : undefined

  const hasProjection = typeof useProjection === 'function'
  const livingBrief = hasProjection ? useProjection<BriefLike>('livingBrief') : undefined
  const oracle = hasProjection ? useProjection<OracleLike>('oracleScorecard') : undefined
  const council = hasProjection ? useProjection<CouncilLike>('councilState') : undefined
  const memory = hasProjection ? useProjection<MemoryLedgerLike>('memoryLedger') : undefined

  const sections = useMemo(
    () => (livingBrief?.prose?.text !== undefined ? parseBriefSections(livingBrief.prose.text) : null),
    [livingBrief?.prose?.text],
  )

  // Whiteboard: the operator-authored store is settings-backed, so the card
  // re-reads settings.describe while mounted (the capabilities panel's polling
  // pattern) and splits the plugin's per-session resolution into this session's
  // own board (primary surface) and the shared project/global rest (collapsed
  // disclosure). The agent's injected view is the union of the two.
  const [whiteboard, setWhiteboard] = useState<WhiteboardRead>({ phase: 'loading', store: null })
  useEffect(() => {
    let cancelled = false
    const read = async (): Promise<void> => {
      const store = await fetchWhiteboardStore()
      if (!cancelled) setWhiteboard({ phase: store === null ? 'error' : 'ready', store })
    }
    void read()
    const timer = window.setInterval(() => { void read() }, WHITEBOARD_REFRESH_MS)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [])

  const projectId = session?.cwd ?? workspaces?.activeWorkspace?.path
  const boardSessionId = sessionId ?? session?.sessionId ?? session?.id
  const parentSessionId = session?.subagent?.address?.parentSessionId
  const boardFacts: WhiteboardScopeFacts = {
    ...(boardSessionId === undefined ? {} : { sessionId: boardSessionId }),
    ...(parentSessionId === undefined ? {} : { parentSessionId }),
    ...(projectId === undefined ? {} : { projectId }),
  }
  const resolvedBoard: WhiteboardBoardSplit | null = whiteboard.store === null
    ? null
    : splitWhiteboard(whiteboard.store, boardFacts)

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
            <div className={css.empty}>
              <span>keeper idle — no brief yet</span>
              <span className={css.emptyHint}>Prose materializes on first Oracle or Council use (demand-driven)</span>
            </div>
          )}
        </section>
        {/* Whiteboard — this session's own board; shared entries behind a disclosure */}
        <WhiteboardCard board={resolvedBoard} phase={whiteboard.phase} />
      </div>
    </div>
  )
}
