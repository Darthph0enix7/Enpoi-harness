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
  subTools?: string[] | undefined
  onOpenSession?: ((sessionId: string) => void) | undefined
}

/** Get a clean emoji icon for a tool name */
function toolIcon(name: string): string {
  const n = name.toLowerCase()
  if (n.includes('web') || n.includes('fetch') || n.includes('search_exa')) return '🌐'
  if (n.includes('read')) return '📖'
  if (n.includes('edit') || n.includes('write')) return '📝'
  if (n.includes('bash') || n.includes('terminal')) return '⚙️'
  if (n.includes('grep') || n.includes('glob') || n.includes('search')) return '🔍'
  if (n.includes('ast_grep')) return '🧩'
  if (n.includes('todo') || n.includes('plan')) return '📋'
  if (n.includes('oracle')) return '🔮'
  if (n.includes('subagent')) return '⚡'
  return '🛠️'
}

export function TheMarkTaskCard({
  persona,
  title,
  model,
  status,
  currentTool,
  durationMs,
  childSessionId,
  outputSummary,
  subTools,
  onOpenSession,
}: TheMarkTaskCardProps) {
  const [expanded, setExpanded] = useState(false)
  const [copied, setCopied] = useState(false)
  // Latch the last active tool in state so it freezes on interrupt rather than clearing
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

  const statusLabel =
    status === 'running'
      ? 'Running'
      : status === 'settled'
        ? 'Completed'
        : status === 'interrupted'
          ? 'Interrupted'
          : 'Failed'

  const durationStr = durationMs ? `${(durationMs / 1000).toFixed(1)}s` : ''
  const displayModel = model ? model.split('/').pop() : undefined

  return (
    <div className={styles.markTaskCard}>
      {/* Zoom 1: Collapsed Header Badge Row */}
      <div className={styles.markBadgeRow} onClick={() => setExpanded(!expanded)}>
        <div className={styles.markBadgeLeft}>
          <span className={`${styles.statusIndicator} ${statusClass}`} title={statusLabel} />
          <span className={styles.personaBadge}>{persona}</span>
          <span className={styles.taskTitle} title={title}>
            {title}
          </span>
          {displayModel && <span className={styles.modelPill}>{displayModel}</span>}
        </div>

        <div className={styles.markBadgeRight}>
          {durationStr && <span className={styles.durationPill}>⏱️ {durationStr}</span>}
          <span className={styles.chevronToggle}>{expanded ? '▲' : '▼'}</span>
        </div>
      </div>

      {/* Zoom 2: Live Action Calligraphy Strip */}
      {(status === 'running' || latchedTool) && (
        <div className={styles.calligraphyStrip}>
          <span className={styles.calligraphyPrompt}>❯</span>
          {status === 'running' ? (
            <span>Executing: {currentTool || 'Running subagent step...'}</span>
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
          {/* Sub-tools Activity Timeline */}
          {subTools && subTools.length > 0 && (
            <div className={styles.toolsActivityContainer}>
              <div className={styles.toolsActivityHeader}>Tools Executed ({subTools.length})</div>
              <div className={styles.toolsActivityPills}>
                {subTools.map((t, idx) => (
                  <span key={`${t}-${idx}`} className={styles.toolActivityPill}>
                    <span className={styles.toolActivityIcon}>{toolIcon(t)}</span>
                    <span>{t}</span>
                  </span>
                ))}
              </div>
            </div>
          )}

          {outputSummary ? (
            <div className={styles.outputContainer}>
              <div className={styles.outputHeader}>
                <span>Output & Findings</span>
                {status === 'settled' && <span className={styles.badgeSuccess}>✓ Settled</span>}
              </div>
              <div className={styles.outputScroll}>
                <pre className={styles.outputText}>{outputSummary}</pre>
              </div>
            </div>
          ) : (
            <div className={styles.emptyOutput}>
              {status === 'running'
                ? 'Subagent is currently executing in its own context...'
                : 'No textual output returned.'}
            </div>
          )}

          <div className={styles.detailActions}>
            {childSessionId && onOpenSession && (
              <button
                type="button"
                className={styles.detailBtnPrimary}
                onClick={(e) => {
                  e.stopPropagation()
                  onOpenSession(childSessionId)
                }}
              >
                <span>Open Subagent Session</span>
                <span>↗</span>
              </button>
            )}
            <button
              type="button"
              className={styles.detailBtn}
              onClick={(e) => {
                e.stopPropagation()
                const textToCopy = outputSummary || childSessionId || title
                if (navigator.clipboard) {
                  void navigator.clipboard.writeText(textToCopy)
                  setCopied(true)
                  setTimeout(() => setCopied(false), 2000)
                }
              }}
            >
              {copied ? '✓ Copied' : 'Copy Output'}
            </button>
            {childSessionId && (
              <span className={styles.sessionIdPill} title={`Subagent Session: ${childSessionId}`}>
                ID: {childSessionId.slice(0, 8)}...
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
