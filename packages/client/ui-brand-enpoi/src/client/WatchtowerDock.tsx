import { useState } from 'react'
import styles from './WatchtowerDock.module.css'

/** Structural subset of the session snapshot the dock reads. */
interface SessionLike {
  readonly id?: string
  readonly sessionId?: string
  readonly displayTitle?: string
  readonly title?: string
}

/** Structural subset of the living-brief projection the dock reads. */
interface BriefLike {
  readonly goal?: string
  readonly prose?: { readonly text?: string } | null
}

interface OracleLike {
  readonly status?: string
  readonly blockers?: readonly unknown[]
  readonly concerns?: readonly unknown[]
}

interface CouncilLike {
  readonly status?: string
  readonly round?: number
}

export interface WatchtowerDockProps {
  useSession?: <S>(selector: (s: SessionLike) => S) => S
  sessionId?: string
  useProjection?: <T>(key: string, selector?: (v: unknown) => T) => T
}

export function WatchtowerDock({ useSession, sessionId, useProjection }: WatchtowerDockProps) {
  // Observable selector hooks require an explicit selector (no identity default).
  const session = typeof useSession === 'function' ? useSession(s => s) : undefined
  const [halting, setHalting] = useState(false)

  // Read live projections (projectionHook supplies its own identity default).
  const livingBrief = typeof useProjection === 'function' ? useProjection<BriefLike>('livingBrief') : undefined
  const oracleScorecard = typeof useProjection === 'function' ? useProjection<OracleLike>('oracleScorecard') : undefined
  const councilState = typeof useProjection === 'function' ? useProjection<CouncilLike>('councilState') : undefined

  // Extract living brief prose or goal snippet dynamically
  const briefText = livingBrief?.prose?.text ?? livingBrief?.goal ?? session?.displayTitle ?? session?.title ?? 'Session active'
  const firstLine = briefText.split('\n')[0]?.replace(/^[-•*#\s]+/, '').replace(/^(🎯\s*)?Goal:\s*/i, '') ?? ''

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

  const oracleStatus = oracleScorecard?.status
  const isOracleBlocked = oracleStatus === 'blocked' || (oracleScorecard?.blockers !== undefined && oracleScorecard.blockers.length > 0)
  const isOracleConcern = oracleStatus === 'concern' || (oracleScorecard?.concerns !== undefined && oracleScorecard.concerns.length > 0)

  const councilStatus = councilState?.status
  const isCouncilActive = councilStatus === 'debating' || councilStatus === 'started'

  return (
    <div className={styles.watchtowerDock}>
      <div className={styles.dockLeft}>
        <span className={styles.goalPrefix}>🎯 Goal</span>
        <span className={styles.goalText} title={firstLine}>
          {firstLine || 'Working on current task...'}
        </span>
      </div>

      <div className={styles.dockRight}>
        {isOracleBlocked ? (
          <span className={`${styles.chip} ${styles.chipOracleWarn}`} style={{ background: 'rgba(239, 68, 68, 0.2)', color: '#f87171', borderColor: 'rgba(239, 68, 68, 0.4)' }}>
            🔴 Oracle Blocker
          </span>
        ) : isOracleConcern ? (
          <span className={`${styles.chip} ${styles.chipOracleWarn}`}>
            🟡 Oracle Concern
          </span>
        ) : (
          <span className={`${styles.chip} ${styles.chipOracleOk}`}>
            🛡️ Oracle Ready
          </span>
        )}

        {isCouncilActive ? (
          <span className={`${styles.chip} ${styles.chipCouncil}`}>
            🏛️ Council Active ({councilState?.round ?? 1})
          </span>
        ) : (
          <span className={`${styles.chip} ${styles.chipCouncil}`}>
            🏛️ Council Ready
          </span>
        )}

        <button
          type="button"
          className={styles.dockHaltBtn}
          onClick={handleHalt}
          disabled={halting}
          title="Emergency Halt: Abort active generation & stop subagent fibers"
        >
          {halting ? '🛑 Halting...' : '🛑 Halt'}
        </button>
      </div>
    </div>
  )
}
