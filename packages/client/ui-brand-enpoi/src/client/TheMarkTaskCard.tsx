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

/** Minimalist monochrome icon — thin stroke, currentColor, matches FleetRouting. */
function MicroIcon({ d, size = 11 }: { d: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={d} />
    </svg>
  )
}

function personaIconD(persona: string): string {
  const p = persona.toLowerCase()
  if (p.includes('librarian')) return 'M3 4h4v9H3zM8 4h5v9H8zM3 13h10'
  if (p.includes('fixer')) return 'M10.5 2.5l3 3L6 13H3v-3z'
  if (p.includes('explorer')) return 'M3 3h4v4H3zM9 9h4v4H9zM9 3h4M11 3v4M3 9h4M5 9v4'
  if (p.includes('designer')) return 'M8 3l1.8 3.6L13.5 8l-3.7 1.4L8 13l-1.8-3.6L2.5 8l3.7-1.4z'
  if (p.includes('oracle')) return 'M8 3a5 5 0 100 10A5 5 0 008 3zm0 2v2m0 3v2'
  if (p.includes('roundtable')) return 'M3 3h10v2H3zM3 7h10v2H3zM3 11h10v2H3z'
  if (p.includes('chorus')) return 'M8 2l2 4 4 1-3 3 1 4-4-2-4 2 1-4-3-3 4-1z'
  if (p.includes('visionary')) return 'M8 2l2 4 4 1-3 3 1 4-4-2-4 2 1-4-3-3 4-1z'
  if (p.includes('experiencer')) return 'M3 8a5 5 0 0110 0c0 3-5 6-5 6s-5-3-5-6z'
  if (p.includes('integrator')) return 'M4 4h4v4H4zM8 8h4v4H8z'
  if (p.includes('curator')) return 'M8 3v10M3 8h10'
  if (p.includes('skeptic')) return 'M12 4l-8 8m0-8l8 8'
  if (p.includes('architect')) return 'M3 13V8m3 5V5m3 8V3m3 10V7'
  if (p.includes('pragmatist')) return 'M3 8h10M10 4l3 4-3 4'
  if (p.includes('critic')) return 'M8 2a6 6 0 100 12A6 6 0 008 2zm0 3v4l3 2'
  return 'M8 3l3 3-3 3M5 8h6'
}

function toolIconD(name: string): string {
  const n = name.toLowerCase()
  if (n.includes('web') || n.includes('fetch') || n.includes('search_exa')) return 'M8 2a6 6 0 100 12A6 6 0 008 2zM8 5v3l2 2'
  if (n.includes('read')) return 'M3 4h10v9H3zM3 7h10'
  if (n.includes('edit') || n.includes('write')) return 'M10.5 2.5l3 3L6 13H3v-3z'
  if (n.includes('bash') || n.includes('terminal')) return 'M3 5l3 3-3 3M9 11h4'
  if (n.includes('grep') || n.includes('glob') || n.includes('search')) return 'M11 11l2 2M9.5 5a4.5 4.5 0 100 9A4.5 4.5 0 009.5 5z'
  if (n.includes('ast_grep')) return 'M4 4h4v4H4zM8 8h4v4H8z'
  if (n.includes('todo') || n.includes('plan')) return 'M3 4h10M3 8h10M3 12h10M3 4v8'
  if (n.includes('oracle')) return 'M8 3a5 5 0 100 10A5 5 0 008 3zm0 2v2m0 3v2'
  if (n.includes('subagent')) return 'M8 3l3 3-3 3M5 8h6'
  return 'M8 3v10M3 8h10'
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

  // Strip emoji prefix from legacy persona labels — icon now rendered separately as SVG
  const personaLabel = persona.replace(/^[\p{Emoji_Presentation}\p{Emoji}\uFE0F\s]+/u, '').trim() || persona

  return (
    <div className={styles.markTaskCard}>
      {/* Zoom 1: Collapsed Header Badge Row (a real button: the whole card
          head is the tap target and keyboard toggles the drawer too). */}
      <button
        type="button"
        className={styles.markBadgeRow}
        aria-expanded={expanded}
        data-mark-task-head
        onClick={() => setExpanded(!expanded)}
      >
        <div className={styles.markBadgeLeft}>
          <span className={`${styles.statusIndicator} ${statusClass}`} title={statusLabel} />
          <span className={styles.personaBadge}>
            <span className={styles.personaIcon}>
              <MicroIcon d={personaIconD(persona)} size={11} />
            </span>
            {personaLabel}
          </span>
          <span className={styles.taskTitle} title={title}>
            {title}
          </span>
          {displayModel && <span className={styles.modelPill}>{displayModel}</span>}
        </div>

        <div className={styles.markBadgeRight}>
          {durationStr && <span className={styles.durationPill}>⏱️ {durationStr}</span>}
          <span className={styles.chevronToggle}>{expanded ? '▲' : '▼'}</span>
        </div>
      </button>

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
                    <span className={styles.toolActivityIcon}><MicroIcon d={toolIconD(t)} size={10} /></span>
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
