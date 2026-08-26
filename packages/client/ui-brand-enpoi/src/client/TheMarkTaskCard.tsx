import { useState, useEffect } from 'react'
import styles from './TheMarkTaskCard.module.css'

export interface TheMarkTaskCardProps {
  taskId: string
  persona: string
  title: string
  model?: string | undefined
  status: 'running' | 'settled' | 'interrupted' | 'failed'
  currentTool?: string | undefined
  durationMs?: number | undefined
  childSessionId?: string | undefined
  outputSummary?: string | undefined
  onOpenSession?: ((sessionId: string) => void) | undefined
}

export function TheMarkTaskCard({
  persona,
  title,
  model = 'deepseek-v4-flash',
  status,
  currentTool,
  durationMs,
  childSessionId,
  outputSummary,
  onOpenSession,
}: TheMarkTaskCardProps) {
  const [expanded, setExpanded] = useState(false)
  // Latch the last active tool in state so it freezes on interrupt rather than clearing (UI-4)
  const [latchedTool, setLatchedTool] = useState<string | undefined>(currentTool)

  useEffect(() => {
    if (currentTool) {
      setLatchedTool(currentTool)
    }
  }, [currentTool])

  const statusClass =
    status === 'running'
      ? styles.statusRunning
      : status === 'settled'
        ? styles.statusSettled
        : status === 'interrupted'
          ? styles.statusInterrupted
          : styles.statusFailed

  const durationStr = durationMs ? `${(durationMs / 1000).toFixed(1)}s` : ''

  return (
    <div className={styles.markTaskCard}>
      {/* Zoom 1: Collapsed Badge Row */}
      <div className={styles.markBadgeRow} onClick={() => setExpanded(!expanded)}>
        <div className={styles.markBadgeLeft}>
          <span className={`${styles.statusIndicator} ${statusClass}`} />
          <span className={styles.taskTitle}>
            <strong>{persona}:</strong> {title}
          </span>
          <span className={styles.modelPill}>{model.split('/').pop()}</span>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: '#94a3b8', fontSize: 11 }}>
          {durationStr && <span>⏱️ {durationStr}</span>}
          <span>{expanded ? '▲' : '▼'}</span>
        </div>
      </div>

      {/* Zoom 2: Live Action Calligraphy Strip */}
      {(status === 'running' || latchedTool) && (
        <div className={styles.calligraphyStrip}>
          <span>❯</span>
          {status === 'running' ? (
            <span>Running: {currentTool || 'Executing step...'}</span>
          ) : (
            <span className={styles.calligraphyFrozen}>
              [Interrupted at: {latchedTool || 'unknown step'}]
            </span>
          )}
        </div>
      )}

      {/* Zoom 3: Expanded Detail Drawer */}
      {expanded && (
        <div className={styles.detailDrawer}>
          {outputSummary && (
            <div style={{ color: '#cbd5e1', fontSize: 12, lineHeight: 1.5 }}>
              {outputSummary}
            </div>
          )}

          <div className={styles.detailActions}>
            {childSessionId && onOpenSession && (
              <button
                type="button"
                className={styles.detailBtn}
                onClick={() => onOpenSession(childSessionId)}
              >
                Inspect Child Session ↗
              </button>
            )}
            <button
              type="button"
              className={styles.detailBtn}
              onClick={() => {
                navigator.clipboard?.writeText(childSessionId || title)
              }}
            >
              Copy Session Ref
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
