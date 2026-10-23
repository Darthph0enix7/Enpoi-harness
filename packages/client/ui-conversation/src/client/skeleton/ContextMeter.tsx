/** Composer context-occupancy meter: a ring and percentage below the card fed by the
 * `contextPressure` projection, with a click-open panel of the heuristic
 * `contextBreakdown` composition (system prompt, tools, conversation).
 * Renders nothing until a provider reports both pressure and a route
 * capacity. */

import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { UseProjection } from '@deepseek-ai/dsh-api-session-controller/client'
// Type-only: the `contextPressure` / `contextBreakdown` / `contextCompactions` projection key merges.
import type { ContextCompactionsProjection } from '@deepseek-ai/dsh-token-meter/client'
import { Tooltip, useAnchoredPosition, useDismissOnOutsidePointer } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ComposerBarProps } from '../contract/slots.ts'
import { contextOccupancy } from '../context-occupancy.ts'
import css from './ContextMeter.module.css'

/** Ring geometry: 14px viewBox, 2px stroke. */
const RADIUS = 5.5
const CIRCUMFERENCE = 2 * Math.PI * RADIUS

/** How long a live compaction notice stays beside the ring. */
const NOTICE_MS = 6_000

/** Distinct live-notice copy for each committed-compaction outcome. */
type CompactionNotice = 'summarized' | 'mechanical' | 'failed'

const NOTICE_KEYS = {
  summarized: 'context.compacted.notice',
  mechanical: 'context.compacted.notice.mechanical',
  failed: 'context.compacted.notice.failed',
} as const

/**
 * Classify a live compaction increment. A mechanical stub commits `count` and
 * `mechanicalCount` together, so it outranks the plain summarized notice;
 * failures are reported even when the same fold also committed something.
 * @param previous - last observed compaction projection.
 * @param next - newly published compaction projection.
 * @returns the notice kind, or undefined when only non-compaction fields moved.
 */
function compactionNotice(
  previous: ContextCompactionsProjection,
  next: ContextCompactionsProjection,
): CompactionNotice | undefined {
  if (next.failedCount > previous.failedCount) return 'failed'
  if (next.mechanicalCount > previous.mechanicalCount) return 'mechanical'
  if (next.count > previous.count) return 'summarized'
  return undefined
}

/**
 * Marker the localized occupancy sentence is split on, so the panel headline
 * keeps the reading in its own tone while each locale still owns the word
 * order (`45% of context used` / `上下文已用 45%`).
 */
const READING_SLOT = '\u0000'

/** Panel legend rows, in bar-segment order; each color class carries the shared swatch/segment tint. */
const ROWS = [
  { key: 'systemTokens', label: 'context.system', color: css.colorSystem },
  { key: 'toolsTokens', label: 'context.tools', color: css.colorTools },
  { key: 'messageTokens', label: 'context.messages', color: css.colorMessages },
] as const

/**
 * Format a token count for the compact context panel.
 * @param value - token count.
 * @param t - Conversation locale seat with shared compact-number templates.
 * @returns Compact localized count using K or M when needed.
 */
function formatTokens(value: number, t: ComposerBarProps['t']): string {
  const scaled = (candidate: number): string => candidate >= 100
    ? String(Math.round(candidate))
    : String(Math.round(candidate * 10) / 10)
  if (value < 1_000) return String(value)
  if (value < 1_000_000) return t('number.thousand', { value: scaled(value / 1_000) })
  return t('number.million', { value: scaled(value / 1_000_000) })
}

export interface ContextMeterProps {
  useProjection: UseProjection
  /** The owning bar's locale seat, passed down as a plain prop. */
  t: ComposerBarProps['t']
}

export function ContextMeter({ useProjection, t }: ContextMeterProps) {
  const pressure = useProjection('contextPressure')
  const breakdown = useProjection('contextBreakdown')
  const compactions = useProjection('contextCompactions')
  const [open, setOpen] = useState(false)
  const [notice, setNotice] = useState<CompactionNotice | null>(null)
  const observedCompactions = useRef<ContextCompactionsProjection | undefined>(undefined)
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const rootRef = useRef<HTMLSpanElement | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)
  const context = contextOccupancy(pressure)
  const available = context !== null
  const position = useAnchoredPosition({
    open: open && available,
    anchorRef: rootRef,
    panelRef,
    side: 'top',
    gap: 8,
    margin: 12,
  })
  useDismissOnOutsidePointer(rootRef, open && available, setOpen, panelRef)

  // A model switch can temporarily remove capacity while this component stays
  // mounted. Close the now-unavailable panel instead of preserving stale UI.
  useEffect(() => {
    if (!available && open) setOpen(false)
  }, [available, open])

  useEffect(() => {
    if (!open || !available) return
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('keydown', onKeyDown)
    return () => { document.removeEventListener('keydown', onKeyDown) }
  }, [available, open])

  // The first defined projection is the baseline: a session opened after
  // several compactions must not announce old ones. Only a later increase
  // raises the transient notice.
  useEffect(() => {
    const previous = observedCompactions.current
    observedCompactions.current = compactions
    if (previous === undefined || compactions === undefined) return
    const kind = compactionNotice(previous, compactions)
    if (kind === undefined) return
    setNotice(kind)
    if (noticeTimer.current !== null) clearTimeout(noticeTimer.current)
    noticeTimer.current = setTimeout(() => { setNotice(null) }, NOTICE_MS)
  }, [compactions])

  useEffect(() => () => {
    if (noticeTimer.current !== null) clearTimeout(noticeTimer.current)
  }, [])

  if (context === null) return null
  const percent = context.percent
  const reading = `${percent}%`
  const [headBefore = '', headAfter = ''] = t('context.aria', { percent: READING_SLOT })
    .split(READING_SLOT)
    .map(part => part.trim())
  const compactionSuffix = compactions !== undefined && compactions.count > 0
    ? t('context.compacted.tooltip', { n: compactions.count })
    : ''
  const lastCompaction = compactions?.last

  // The bar's overall length stays the provider-exact percent; the heuristic
  // breakdown only proportions its colored parts. A zero-width part is dropped
  // instead of rendered: `.segment`'s min-width keeps a hairline part visible,
  // which at 0% occupancy would draw a filled bar over an empty context.
  const breakdownTotal = breakdown === undefined
    ? 0
    : breakdown.systemTokens + breakdown.toolsTokens + breakdown.messageTokens
  const parts = breakdown === undefined || breakdownTotal === 0
    ? [{ key: 'total', color: undefined, width: percent }]
    : ROWS.map(row => ({ key: row.key, color: row.color, width: percent * breakdown[row.key] / breakdownTotal }))
  const segments = parts.filter(part => part.width > 0)

  return (
    <span ref={rootRef} className={css.root}>
      <Tooltip label={`${t('context.aria', { percent: reading })}${compactionSuffix}`} side="top" delayMs={200} disabled={open}>
        <button
          type="button"
          className={css.trigger}
          aria-label={t('context.aria', { percent: reading })}
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => { setOpen(!open) }}
        >
          <svg viewBox="0 0 14 14" width="14" height="14" aria-hidden>
            <circle className={css.track} cx="7" cy="7" r={RADIUS} />
            <circle
              className={css.fill}
              cx="7"
              cy="7"
              r={RADIUS}
              strokeDasharray={`${CIRCUMFERENCE * percent / 100} ${CIRCUMFERENCE}`}
              transform="rotate(-90 7 7)"
            />
          </svg>
          <span>{reading}</span>
        </button>
      </Tooltip>
      {notice !== null && (
        <span className={css.notice} role="status" aria-live="polite">
          {t(NOTICE_KEYS[notice])}
        </span>
      )}
      {open && createPortal(
        <div
          ref={panelRef}
          className={css.panel}
          style={position ?? { visibility: 'hidden', left: 0, top: 0 }}
          role="dialog"
          aria-label={t('context.used')}
        >
          <div className={css.header}>
            {/* Empty sides collapse through `.headline:empty` so the locale that
                needs no leading (or trailing) text spends no header gap. */}
            <span className={css.headline}>{headBefore}</span>
            <span className={css.percent}>{reading}</span>
            <span className={css.headline}>{headAfter}</span>
            {/* `~`: usedTokens prefers projectedTokens, whose surface delta is
                heuristically repriced on top of the provider-anchored sample. */}
            <span className={css.figures}>
              {`~${formatTokens(context.usedTokens, t)} / ${formatTokens(context.contextWindow, t)}`}
            </span>
          </div>
          <div className={css.bar}>
            {segments.map(segment => (
              <div
                key={segment.key}
                className={segment.color === undefined ? css.segment : `${css.segment} ${segment.color}`}
                style={{ width: `${segment.width}%` }}
              />
            ))}
          </div>
          {breakdown !== undefined && (
            <dl className={css.rows}>
              {ROWS.map(row => (
                <div key={row.key} className={css.row}>
                  <dt>
                    <span className={`${css.swatch} ${row.color}`} aria-hidden />
                    {t(row.label)}
                  </dt>
                  <dd>{`~${formatTokens(breakdown[row.key], t)}`}</dd>
                </div>
              ))}
            </dl>
          )}
          {compactions !== undefined && compactions.count > 0 && lastCompaction !== undefined && (
            <div className={css.compacted}>
              {t('context.compacted.row', {
                n: compactions.count,
                messages: lastCompaction.shadowedNodes,
                tokens: formatTokens(lastCompaction.shadowedTokens, t),
              })}
            </div>
          )}
        </div>,
        document.body,
      )}
    </span>
  )
}
