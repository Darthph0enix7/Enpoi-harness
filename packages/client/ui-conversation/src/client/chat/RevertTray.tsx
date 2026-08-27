// RevertTray: the expandable "Reverted (N)" strip above the input card.
// Lists each reverted user query (one line) with per-item Restore and Fork
// actions plus a Redo (restore-all) button. Rendered only while a revert
// boundary is active; the tray disappears once a new query commits the revert.

import { memo, useMemo, useState } from 'react'
import type { ContentBlock } from '@deepseek-ai/dsh-llm/types'
import type { ConversationSnapshot } from '@deepseek-ai/dsh-client-runtime/client'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import type { ComposerBarProps } from '../contract/slots.ts'
import css from './RevertTray.module.css'

export interface RevertTrayProps {
  useSession: SnapshotSelectorHook<ConversationSnapshot>
  t: ComposerBarProps['t']
  /** Restore reverted messages: omitted restores everything; a seq restores that message and everything after. */
  revertRestore: (restoreSeq?: number) => void
  /** Fork the session at a reverted message. */
  forkAt: (seq: number) => void
}

/** Injected action face for the composer-dock registration. */
export interface RevertTrayInjected {
  revertRestore: (restoreSeq?: number) => void
  forkAt: (seq: number) => void
}

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

export const RevertTray = memo(function RevertTray({ useSession, t, revertRestore, forkAt }: RevertTrayProps) {
  const [expanded, setExpanded] = useState(false)
  const revertFromSeq = useSession(s => s.revertFromSeq)
  const nodes = useSession(s => s.chat.nodes)

  const reverted = useMemo(() => {
    if (revertFromSeq === null) return []
    const list: { seq: number; text: string }[] = []
    for (const node of nodes.values()) {
      if (node.kind !== 'user') continue
      if (node.anchorSeq <= revertFromSeq) continue
      const text = nodeText((node.data as { content?: readonly ContentBlock[] }).content ?? [])
      if (text.length > 0) list.push({ seq: node.anchorSeq, text })
    }
    // Render order is not guaranteed by the store; sort so the index math
    // (restore item i → boundary = item i-1) is exact.
    return list.sort((left, right) => left.seq - right.seq)
  }, [revertFromSeq, nodes])

  if (revertFromSeq === null) return null

  return (
    <div className={css.tray} data-revert-tray>
      <div className={css.trayHeader}>
        <button
          type="button"
          className={css.trayToggle}
          onClick={() => setExpanded(!expanded)}
          aria-expanded={expanded}
        >
          <span className={css.trayIcon}>⮌</span>
          <span>{t('revert.trayLabel', { count: reverted.length })}</span>
          <span className={css.trayChevron}>{expanded ? '▲' : '▼'}</span>
        </button>
        <button type="button" className={css.trayRedo} onClick={() => { revertRestore() }}>
          {t('revert.redo')}
        </button>
      </div>
      {expanded && (
        <ul className={css.trayList}>
          {reverted.map((item, index) => (
            <li key={item.seq} className={css.trayItem}>
              <span className={css.trayItemText} title={item.text}>
                {item.text.slice(0, 80)}
              </span>
              <span className={css.trayItemActions}>
                <button
                  type="button"
                  className={css.trayItemBtn}
                  onClick={() => { revertRestore(index === 0 ? undefined : reverted[index - 1]?.seq) }}
                >
                  {t('revert.restore')}
                </button>
                <button
                  type="button"
                  className={css.trayItemBtn}
                  onClick={() => { forkAt(item.seq) }}
                >
                  {t('revert.fork')}
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
})