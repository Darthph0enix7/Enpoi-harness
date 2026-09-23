/**
 * Watchtower Whiteboard card — a read-only projection of the pinned board the
 * profile plugin injects for the current session: the resolved view (global →
 * project → session, by entry id), the exact rendered block, its token cost
 * against the hard budget, and the entry list with each entry's authoring
 * scope. Reading, writing, pinning, and pruning stay with the whiteboard tools
 * and the operator; this card only shows the truth.
 */
import { useState } from 'react'
import { MicroIcon } from './MicroIcon.tsx'
import {
  WHITEBOARD_BUDGET_TOKENS,
  renderWhiteboardBlock,
  whiteboardTokens,
  type ResolvedWhiteboardView,
  type WhiteboardEntryKind,
} from './whiteboard-view.ts'
import css from './WatchtowerView.module.css'

/** Settings-read phase of the card. */
export type WhiteboardPhase = 'loading' | 'ready' | 'error'

export interface WhiteboardCardProps {
  /** The board resolved for this session; null when the settings read did not answer. */
  doc: ResolvedWhiteboardView | null
  /** Whether the settings read is still in flight, settled, or failed. */
  phase: WhiteboardPhase
}

/** One micro glyph per entry kind (path, rule, fact, task). */
const KIND_ICONS: Record<WhiteboardEntryKind, string> = {
  path: 'M3 3h4l1 2h5v8H3z',
  rule: 'M8 2l5 2v5c0 2.8-2.1 4.4-5 5.5C5.1 13.4 3 11.8 3 9V4z',
  fact: 'M8 2.5a5.5 5.5 0 100 11 5.5 5.5 0 000-11zM8 7.5v3.5M8 5v.01',
  task: 'M3 8.5L6.5 12 13 4.5',
}

/** Local wall-clock label for the board's last write, when it has one. */
function updatedLabel(updatedAt: number): string | undefined {
  return updatedAt > 0 ? new Date(updatedAt).toLocaleTimeString() : undefined
}

/**
 * The Watchtower's Whiteboard card.
 * @param props - the resolved board and the read phase.
 * @returns the card, or its quiet empty state.
 */
export function WhiteboardCard({ doc, phase }: WhiteboardCardProps) {
  const [copied, setCopied] = useState(false)
  const rendered = doc !== null ? renderWhiteboardBlock(doc) : ''
  const tokens = whiteboardTokens(rendered)

  const copyBlock = (): void => {
    if (rendered === '') return
    const clipboard = (navigator as { clipboard?: { writeText?: (text: string) => Promise<void> } }).clipboard
    if (clipboard?.writeText === undefined) return
    void clipboard.writeText(rendered).then(
      () => {
        setCopied(true)
        window.setTimeout(() => { setCopied(false) }, 1200)
      },
      () => { /* write denied — the block stays selectable */ },
    )
  }

  const emptyCopy = phase === 'loading'
    ? { text: 'reading the board…', hint: undefined }
    : phase === 'error'
      ? { text: 'board unavailable', hint: 'settings.describe did not answer' }
      : { text: 'no whiteboard entries', hint: 'nothing resolves for this session — whiteboard_write authors here by default' }

  return (
    <section className={css.card}>
      <div className={css.cardHead}>
        <MicroIcon d="M2 3h12v8H2zM6 13h4M8 11v2" />
        <span>Whiteboard</span>
      </div>
      {doc !== null && rendered !== '' ? (
        <>
          <div className={css.wbMetaRow}>
            <span className={css.wbChip}>v{doc.version}</span>
            <span className={css.wbChip} title="most specific scope this session resolves">{doc.scope}</span>
            {updatedLabel(doc.updatedAt) !== undefined && (
              <span className={css.wbMeta} title={`updated ${new Date(doc.updatedAt).toISOString()}`}>
                updated {updatedLabel(doc.updatedAt)}
              </span>
            )}
            <span className={css.wbMeta} title={`${tokens} of ${WHITEBOARD_BUDGET_TOKENS} rendered tokens (4 chars/token)`}>
              {tokens}/{WHITEBOARD_BUDGET_TOKENS} tok
            </span>
            <button type="button" className={css.wbCopyBtn} onClick={copyBlock} title="Copy the injected block">
              <MicroIcon d="M5 5V3h8v8h-2M3 5h8v8H3z" size={9} />
              {copied ? 'copied' : 'copy'}
            </button>
          </div>
          <pre className={css.wbBlock}>{rendered}</pre>
          <div className={css.wbEntries}>
            <div className={css.sectionHead}>
              <MicroIcon d="M3 4h10M3 8h10M3 12h6" />
              <span>Entries · {doc.entries.length}</span>
            </div>
            {doc.entries.map(entry => (
              <div className={css.wbEntry} key={entry.id} data-stale={entry.stale === true ? 'true' : undefined}>
                <span className={css.wbKind} title={entry.kind}>
                  <MicroIcon d={KIND_ICONS[entry.kind]} />
                </span>
                {entry.pinned && (
                  <span className={css.wbPin} title="pinned">
                    <MicroIcon d="M9 2l5 5-2.5 1L10 13 8 11l-4.5 3.5L2 13l3.5-4.5L3.5 6.5 8.5 5z" />
                  </span>
                )}
                <span className={css.wbText}>{entry.text}</span>
                <span className={css.wbEntryMeta}>
                  <span className={css.wbScope} data-scope={entry.scope} title={`authored by the ${entry.scope} board`}>
                    {entry.scope}
                  </span>
                  v{entry.version}
                  {entry.stale === true && <span className={css.wbStale} title="path no longer resolves (stale)">stale</span>}
                </span>
              </div>
            ))}
          </div>
        </>
      ) : (
        <div className={css.empty}>
          <span>{emptyCopy.text}</span>
          {emptyCopy.hint !== undefined && <span className={css.emptyHint}>{emptyCopy.hint}</span>}
        </div>
      )}
    </section>
  )
}
