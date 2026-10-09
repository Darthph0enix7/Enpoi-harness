// RevertTray: Contained Liquid Glass card above the composer input.
// 1. Conflict Banner: surfaces unresolved file conflicts with state-dependent actions (Keep, Force Revert, Save Beside).
// 2. Reverted Messages: chronological scrollable list of reverted queries with Restore and Fork actions.
// 3. Affected Files: compact clickable file chips that open in the sidebar editor with outcome badges (Restored, Trashed, Conflict).

import { memo, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Sheet, useSheetPresentation } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ContentBlock } from '@deepseek-ai/dsh-llm/types'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { RevertFileConflict, RevertFileOutcome } from '@deepseek-ai/dsh-api-session-controller/client'
import css from './RevertTray.module.css'

/** Injected action face for the input-dock registration. */
import type { RevertDockInjected } from '@deepseek-ai/dsh-client-ui-conversation/client'

/** Full props of the revert dock entry: InputZone owner share + session standard kit + global seat + injected actions + locale seat. */
export type RevertTrayProps = PropsRuntime<'conversation.input.dock'> & RevertDockInjected & PropsLocale<'conversation'>

/** Best-effort text extraction from a user node's content blocks. */
function nodeText(content: readonly ContentBlock[]): string {
  const parts: string[] = []
  for (const block of content) {
    if (typeof block === 'string') {
      parts.push(block)
    } else if (block !== null && typeof block === 'object' && 'text' in block && typeof block.text === 'string') {
      parts.push(block.text)
    }
  }
  return parts.join(' ').trim()
}

/** Extract clean basename from full or relative path. */
function basenameOf(path: string): string {
  const normalized = path.replace(/\\/g, '/')
  const idx = normalized.lastIndexOf('/')
  return idx >= 0 ? normalized.slice(idx + 1) : normalized
}

export const RevertTray = memo(function RevertTray({
  useSession, useChat, t, revertRestore, forkAt, openFile, resolveFileConflict, inputActions,
}: RevertTrayProps) {
  const sheetMode = useSheetPresentation()
  const [expanded, setExpanded] = useState(false)
  const [inFlightConflictId, setInFlightConflictId] = useState<string | null>(null)
  const listRef = useRef<HTMLUListElement>(null)

  const revertFromSeq = useSession(s => s.revertFromSeq)
  const nodes = useChat(s => s.nodes)
  const conflicts = useSession(s => s.revertFileConflicts ?? [])
  const outcomes = useSession(s => s.revertFileOutcomes ?? {})

  const reverted = useMemo(() => {
    if (revertFromSeq === null) return []
    const list: { seq: number; text: string }[] = []
    for (const node of nodes.values()) {
      if (node.kind !== 'user' && node.kind !== 'steering') continue
      if (node.anchorSeq < revertFromSeq) continue
      const text = nodeText((node.data as { content?: readonly ContentBlock[] }).content ?? [])
      if (text.length > 0) list.push({ seq: node.anchorSeq, text })
    }
    return list.sort((left, right) => left.seq - right.seq)
  }, [revertFromSeq, nodes])

  const outcomeEntries = useMemo(() => {
    // Only files the revert/restore actually touched are relevant: restored,
    // trashed, saved_beside, kept, conflicts, errors. A no_op file (disk
    // already at the target) is not affected — with hundreds of edited files
    // in a session the tray must not list every untouched one.
    return Object.entries(outcomes).filter(([_, out]) => {
      if (!out || typeof out.status !== 'string') return false
      return out.status !== 'no_op' && out.status !== 'already_clean'
    })
  }, [outcomes])

  // Auto-scroll to bottom of query list when expanded
  useLayoutEffect(() => {
    if (expanded && listRef.current !== null) {
      listRef.current.scrollTop = listRef.current.scrollHeight
    }
  }, [expanded, reverted.length])

  // The tray renders if there are reverted queries OR active file conflicts
  if ((revertFromSeq === null || reverted.length === 0) && conflicts.length === 0) {
    return null
  }

  const handleRestore = (_item: { seq: number; text: string }, index: number) => {
    if (index === reverted.length - 1) {
      revertRestore()
    } else {
      const nextItem = reverted[index + 1]
      if (nextItem !== undefined) {
        revertRestore(nextItem.seq)
        inputActions.setDraft(nextItem.text)
      }
    }
  }

  const handleResolve = async (conflictId: string, resolution: 'keep' | 'restore' | 'recreate' | 'trash') => {
    if (inFlightConflictId !== null) return
    setInFlightConflictId(conflictId)
    try {
      if (typeof resolveFileConflict === 'function') {
        await resolveFileConflict(conflictId, resolution)
      } else {
      }
    } catch {
    } finally {
      setInFlightConflictId(null)
    }
  }

  const statusBadge = (status: string) => {
    switch (status) {
      case 'restored':
        return <span className={`${css.statusBadge} ${css.badgeRestored}`}>{t('revert.statusRestored')}</span>
      case 'trashed':
        return <span className={`${css.statusBadge} ${css.badgeTrashed}`}>{t('revert.statusTrashed')}</span>
      case 'saved_beside':
        return <span className={`${css.statusBadge} ${css.badgeSavedBeside}`}>{t('revert.statusSavedBeside')}</span>
      case 'no_op':
        return <span className={`${css.statusBadge} ${css.badgeNoOp}`}>{t('revert.statusNoChange')}</span>
      case 'pending_conflict':
      case 'conflict_escalated':
        return <span className={`${css.statusBadge} ${css.badgeConflict}`}>{t('revert.statusConflict')}</span>
      case 'error':
        return <span className={`${css.statusBadge} ${css.badgeError}`}>{t('revert.statusError')}</span>
      default:
        return <span className={`${css.statusBadge} ${css.badgeNoOp}`}>{status}</span>
    }
  }

  const conflictSection = conflicts.length === 0 ? null : (
    <div className={css.conflictSection}>
      <div className={css.conflictHeader}>
        <span className={css.conflictIcon}>
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path
              d="M8 1.5L14.5 13.5H1.5L8 1.5Z"
              stroke="currentColor"
              strokeWidth="1.3"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <path d="M8 6V9" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
            <circle cx="8" cy="11.5" r="0.75" fill="currentColor" />
          </svg>
        </span>
        <span className={css.conflictTitle}>{t('revert.conflictsTitle')}</span>
      </div>
      <div className={css.conflictList}>
        {conflicts.map((c: RevertFileConflict) => {
          const isBusy = inFlightConflictId === c.conflictId
          const desc = c.state === 'missing'
            ? t('revert.missingDesc')
            : c.state === 'unavailable'
              ? t('revert.unavailableDesc')
              : t('revert.conflictDesc')

          return (
            <div key={c.conflictId} className={css.conflictCard}>
              <div className={css.conflictInfo}>
                <button
                  type="button"
                  className={css.fileChip}
                  onClick={() => { void openFile(c.displayPath || c.targetKey) }}
                  title={c.targetKey}
                >
                  <svg width="11" height="11" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <path d="M3 1.5H10L13.5 5V14.5H3V1.5Z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
                    <path d="M10 1.5V5H13.5" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
                  </svg>
                  <span className={css.fileChipName}>{basenameOf(c.displayPath || c.targetKey)}</span>
                </button>
                <span className={css.conflictDesc}>{desc}</span>
              </div>

              <div className={css.conflictActions}>
                {(c.state === 'conflict' || (c.state !== 'missing' && c.state !== 'unavailable')) && (
                  <>
                    <button
                      type="button"
                      className={`${css.actionBtn} ${css.btnPrimary}`}
                      disabled={isBusy}
                      onClick={() => { void handleResolve(c.conflictId, 'keep') }}
                    >
                      {t('revert.btnKeep')}
                    </button>
                    <button
                      type="button"
                      className={`${css.actionBtn} ${css.btnDanger}`}
                      disabled={isBusy}
                      onClick={() => { void handleResolve(c.conflictId, 'restore') }}
                    >
                      {c.mode === 'restore' ? t('revert.btnForceRestore') : t('revert.btnRestore')}
                    </button>
                    <button
                      type="button"
                      className={css.actionBtn}
                      disabled={isBusy}
                      onClick={() => { void handleResolve(c.conflictId, 'recreate') }}
                    >
                      {t('revert.btnRecreate')}
                    </button>
                  </>
                )}
                {c.state === 'missing' && (
                  <>
                    <button
                      type="button"
                      className={`${css.actionBtn} ${css.btnPrimary}`}
                      disabled={isBusy}
                      onClick={() => { void handleResolve(c.conflictId, 'recreate') }}
                    >
                      {t('revert.btnRecreateFile')}
                    </button>
                    <button
                      type="button"
                      className={css.actionBtn}
                      disabled={isBusy}
                      onClick={() => { void handleResolve(c.conflictId, 'keep') }}
                    >
                      {t('revert.btnLeaveDeleted')}
                    </button>
                  </>
                )}
                {c.state === 'unavailable' && (
                  <button
                    type="button"
                    className={css.actionBtn}
                    disabled={isBusy}
                    onClick={() => { void handleResolve(c.conflictId, 'keep') }}
                  >
                    {t('revert.btnDismiss')}
                  </button>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )

  const revertedList = (
    <ul ref={listRef} className={css.list}>
      {reverted.map((item, index) => (
        <li key={item.seq} className={css.item}>
          <span className={css.itemText} title={item.text}>
            {item.text}
          </span>
          <div className={css.itemActions}>
            <button
              type="button"
              className={css.actionBtn}
              onClick={() => handleRestore(item, index)}
            >
              {t('revert.restore')}
            </button>
            <button
              type="button"
              className={css.actionBtn}
              onClick={() => forkAt(item.seq)}
            >
              {t('revert.fork')}
            </button>
          </div>
        </li>
      ))}
    </ul>
  )

  const filesSection = outcomeEntries.length === 0 ? null : (
    <div className={css.filesSection}>
      <div className={css.filesSectionTitle}>
        {t('revert.affectedFiles', { count: outcomeEntries.length })}
      </div>
      <div className={css.filesGrid}>
        {outcomeEntries.map(([path, out]: [string, RevertFileOutcome]) => (
          <div key={path} className={css.fileRow}>
            <button
              type="button"
              className={css.fileChip}
              onClick={() => { void openFile(path) }}
              title={path}
            >
              <svg width="11" height="11" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M3 1.5H10L13.5 5V14.5H3V1.5Z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
                <path d="M10 1.5V5H13.5" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
              </svg>
              <span className={css.fileChipName}>{basenameOf(path)}</span>
            </button>
            {statusBadge(out.status)}
            {out.dest && (
              <span className={css.destNote} title={out.dest}>
                → {basenameOf(out.dest)}
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  )

  const trayTitle = t('revert.trayLabel', { count: reverted.length })
  const trayClosedTitle = reverted.length > 0 ? trayTitle : t('revert.conflictsTitle')

  // Phone presentation: the trigger row stays above the composer and the tray
  // body opens as a bottom sheet, keeping restore/fork and the affected-file
  // chips inside it.
  if (sheetMode) {
    return (
      <>
        <div className={css.dock} data-revert-tray data-revert-tray-sheet>
          <button
            type="button"
            className={css.sheetTrigger}
            aria-haspopup="dialog"
            aria-expanded={expanded}
            data-revert-trigger
            onClick={() => { setExpanded(true) }}
          >
            <span className={css.title}>{trayClosedTitle}</span>
            {reverted.length > 0 && conflicts.length > 0 && (
              <span className={css.filesCountBadge}>
                {t('revert.openConflicts', { count: conflicts.length })}
              </span>
            )}
            <span className={css.chevron}>
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path
                  d="M2.5 7.5L6 4L9.5 7.5"
                  stroke="currentColor"
                  strokeWidth="1.3"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </span>
          </button>
        </div>
        <Sheet
          open={expanded}
          onClose={() => { setExpanded(false) }}
          title={trayClosedTitle}
          closeLabel={t('revert.close')}
          surfaceId="ui-chat:revert-tray"
          contentClassName={css.sheetBody ?? ''}
        >
          {conflictSection}
          {revertedList}
          {filesSection}
        </Sheet>
      </>
    )
  }

  return (
    <div className={css.dock} data-revert-tray>
      <div className={css.panel}>
        {conflictSection}
        {reverted.length > 0 && (
          <>
            <button
              type="button"
              className={css.header}
              onClick={() => setExpanded(!expanded)}
              aria-expanded={expanded}
            >
              <div className={css.headerLeft}>
                <span className={css.title}>
                  {t('revert.trayLabel', { count: reverted.length })}
                </span>
                {outcomeEntries.length > 0 && (
                  <span className={css.filesCountBadge}>
                    {outcomeEntries.length === 1
                      ? t('revert.fileCount', { count: outcomeEntries.length })
                      : t('revert.filesCount', { count: outcomeEntries.length })}
                  </span>
                )}
              </div>
              <span className={css.chevron}>
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <path
                    d={expanded ? 'M2.5 7.5L6 4L9.5 7.5' : 'M2.5 4.5L6 8L9.5 4.5'}
                    stroke="currentColor"
                    strokeWidth="1.3"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </span>
            </button>

            {expanded && (
              <div className={css.expandedBody}>
                {revertedList}
                {filesSection}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
})
