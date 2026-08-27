// RevertTray: the compact, minimalist "Reverted messages (N)" bar above the input card.
// Expands to display a scrollable list of reverted queries with per-item Restore and Fork actions.

import { memo, useMemo, useState } from 'react'
import type { ContentBlock } from '@deepseek-ai/dsh-llm/types'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import css from './RevertTray.module.css'

/** Injected action face for the input-dock registration. */
export interface RevertTrayInjected {
  /** Restore reverted messages: omitted restores everything; a seq restores from that boundary. */
  revertRestore: (restoreSeq?: number) => void
  /** Fork the session at a reverted message. */
  forkAt: (seq: number) => void
}

/** Full props of the revert dock entry: InputZone owner share + session standard kit + global seat + injected actions + locale seat. */
export type RevertTrayProps = PropsRuntime<'conversation.input.dock'> & RevertTrayInjected & PropsLocale<'conversation'>

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

export const RevertTray = memo(function RevertTray({ useSession, t, revertRestore, forkAt, inputActions }: RevertTrayProps) {
  const [expanded, setExpanded] = useState(false)
  const revertFromSeq = useSession(s => s.revertFromSeq)
  const nodes = useSession(s => s.chat.nodes)

  const reverted = useMemo(() => {
    if (revertFromSeq === null) return []
    const list: { seq: number; text: string }[] = []
    for (const node of nodes.values()) {
      if (node.kind !== 'user' && node.kind !== 'steering') continue
      // Include all user messages at or after the revert boundary
      if (node.anchorSeq < revertFromSeq) continue
      const text = nodeText((node.data as { content?: readonly ContentBlock[] }).content ?? [])
      if (text.length > 0) list.push({ seq: node.anchorSeq, text })
    }
    return list.sort((left, right) => left.seq - right.seq)
  }, [revertFromSeq, nodes])

  if (revertFromSeq === null || reverted.length === 0) return null

  const handleRestore = (_item: { seq: number; text: string }, index: number) => {
    if (index === reverted.length - 1) {
      // Restoring the latest reverted query -> restore the entire conversation
      revertRestore()
    } else {
      // Restoring up to this query -> move revert boundary to the next query
      const nextItem = reverted[index + 1]
      if (nextItem !== undefined) {
        revertRestore(nextItem.seq)
        inputActions.setDraft(nextItem.text)
      }
    }
  }

  return (
    <div className={css.dock} data-revert-tray>
      <div className={css.panel}>
        <button
          type="button"
          className={css.header}
          onClick={() => setExpanded(!expanded)}
          aria-expanded={expanded}
        >
          <span className={css.title}>
            {t('revert.trayLabel', { count: reverted.length })}
          </span>
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
          <ul className={css.list}>
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
        )}
      </div>
    </div>
  )
})
