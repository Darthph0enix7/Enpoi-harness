/**
 * Watchtower Whiteboard card.
 *
 * The card's primary surface is THIS session's own board
 * (`splitWhiteboard(...).session`): the quiet state comes from the session
 * board being empty, and project/global entries are never presented as the
 * session's whiteboard. The agent still receives the resolved view the plugin
 * injects — session entries plus the explicitly shared project/global ones —
 * so those shared entries stay visible here under collapsed, labelled
 * disclosures ("Shared with all sessions" / "Shared in this project"), and the
 * copy action copies the agent's full injected block. Reading, writing,
 * pinning, and forgetting stay with the whiteboard tools and the operator;
 * this card only shows the truth.
 */
import { useState } from 'react'
import { MicroIcon } from './MicroIcon.tsx'
import type { BrandT } from './locales.ts'
import {
  WHITEBOARD_BUDGET_TOKENS,
  renderWhiteboardBlock,
  whiteboardTokens,
  type ResolvedWhiteboardEntryView,
  type WhiteboardBoardSplit,
  type WhiteboardEntryKind,
} from './whiteboard-view.ts'
import css from './WatchtowerView.module.css'

/** Settings-read phase of the card. */
export type WhiteboardPhase = 'loading' | 'ready' | 'error'

export interface WhiteboardCardProps {
  /** The session/shared split for this session; null when the settings read did not answer. */
  board: WhiteboardBoardSplit | null
  /** Whether the settings read is still in flight, settled, or failed. */
  phase: WhiteboardPhase
  /** Package copy translate. */
  t: BrandT
}

/** One micro glyph per entry kind (path, rule, fact, task). */
const KIND_ICONS: Record<WhiteboardEntryKind, string> = {
  path: 'M3 3h4l1 2h5v8H3z',
  rule: 'M8 2l5 2v5c0 2.8-2.1 4.4-5 5.5C5.1 13.4 3 11.8 3 9V4z',
  fact: 'M8 2.5a5.5 5.5 0 100 11 5.5 5.5 0 000-11zM8 7.5v3.5M8 5v.01',
  task: 'M3 8.5L6.5 12 13 4.5',
}

/** Local wall-clock label for a board's last write, when it has one. */
function updatedLabel(updatedAt: number): string | undefined {
  return updatedAt > 0 ? new Date(updatedAt).toLocaleTimeString() : undefined
}

/** One entry row, shared by the session list and the shared disclosures. */
function EntryRow({ entry, t }: { entry: ResolvedWhiteboardEntryView; t: BrandT }) {
  return (
    <div className={css.wbEntry} data-stale={entry.stale === true ? 'true' : undefined}>
      <span className={css.wbKind} title={entry.kind}>
        <MicroIcon d={KIND_ICONS[entry.kind]} />
      </span>
      {entry.pinned && (
        <span className={css.wbPin} title={t('wbPinnedTitle')}>
          <MicroIcon d="M9 2l5 5-2.5 1L10 13 8 11l-4.5 3.5L2 13l3.5-4.5L3.5 6.5 8.5 5z" />
        </span>
      )}
      <span className={css.wbText}>{entry.text}</span>
      <span className={css.wbEntryMeta}>
        <span className={css.wbScope} data-scope={entry.scope} title={t('wbAuthoredBy', { scope: entry.scope })}>
          {entry.scope}
        </span>
        {t('wbVersion', { version: entry.version })}
        {entry.stale === true && <span className={css.wbStale} title={t('wbStaleTitle')}>{t('wbStale')}</span>}
      </span>
    </div>
  )
}

/**
 * One collapsed disclosure of the entries this session shares with its peers.
 * Renders nothing when the group is empty.
 */
function SharedEntries({ label, entries, t }: { label: string; entries: readonly ResolvedWhiteboardEntryView[]; t: BrandT }) {
  if (entries.length === 0) return null
  return (
    <details className={css.wbShared}>
      <summary className={css.wbSharedSummary}>
        <MicroIcon d="M3 3h4l1 2h5v8H3z" size={9} />
        {label} · {entries.length}
      </summary>
      <div className={css.wbSharedNote}>{t('wbSharedNote')}</div>
      {entries.map(entry => <EntryRow entry={entry} t={t} key={entry.id} />)}
    </details>
  )
}

/**
 * The Watchtower's Whiteboard card.
 * @param props - this session's board split and the read phase.
 * @returns the card, or its quiet empty state plus the shared disclosures.
 */
export function WhiteboardCard({ board, phase, t }: WhiteboardCardProps) {
  const [copied, setCopied] = useState(false)
  const sessionBlock = board !== null ? renderWhiteboardBlock(board.session) : ''
  const agentBlock = board !== null ? renderWhiteboardBlock(board.agent) : ''
  const agentTokens = whiteboardTokens(agentBlock)
  const shared = board?.shared.entries ?? []
  const sharedGlobal = shared.filter(entry => entry.scope === 'global')
  const sharedProject = shared.filter(entry => entry.scope === 'project')

  const copyBlock = (): void => {
    if (agentBlock === '') return
    const clipboard = (navigator as { clipboard?: { writeText?: (text: string) => Promise<void> } }).clipboard
    if (clipboard?.writeText === undefined) return
    void clipboard.writeText(agentBlock).then(
      () => {
        setCopied(true)
        window.setTimeout(() => { setCopied(false) }, 1200)
      },
      () => { /* write denied — the block stays selectable */ },
    )
  }

  const emptyCopy = phase === 'loading'
    ? { text: t('wbLoading'), hint: undefined }
    : phase === 'error'
      ? { text: t('wbUnavailable'), hint: t('wbUnavailableHint') }
      : { text: t('wbEmpty'), hint: t('wbEmptyHint') }

  return (
    <section className={css.card}>
      <div className={css.cardHead}>
        <MicroIcon d="M2 3h12v8H2zM6 13h4M8 11v2" />
        <span>{t('wbTitle')}</span>
      </div>
      {board !== null && sessionBlock !== '' ? (
        <>
          <div className={css.wbMetaRow}>
            <span className={css.wbChip}>{t('wbVersion', { version: board.session.version })}</span>
            <span className={css.wbChip} title={t('wbSessionTitle')}>{t('wbSession')}</span>
            {updatedLabel(board.session.updatedAt) !== undefined && (
              <span className={css.wbMeta} title={t('wbUpdatedTitle', { time: new Date(board.session.updatedAt).toISOString() })}>
                {t('wbUpdated', { time: updatedLabel(board.session.updatedAt) ?? '' })}
              </span>
            )}
            <span
              className={css.wbMeta}
              title={t('wbTokensTitle', { used: agentTokens, total: WHITEBOARD_BUDGET_TOKENS })}
            >
              {t('wbTokens', { used: agentTokens, total: WHITEBOARD_BUDGET_TOKENS })}
            </span>
            <button
              type="button"
              className={css.wbCopyBtn}
              onClick={copyBlock}
              title={t('wbCopyTitle')}
            >
              <MicroIcon d="M5 5V3h8v8h-2M3 5h8v8H3z" size={9} />
              {copied ? t('wbCopied') : t('wbCopy')}
            </button>
          </div>
          <pre className={css.wbBlock}>{sessionBlock}</pre>
          <div className={css.wbEntries}>
            <div className={css.sectionHead}>
              <MicroIcon d="M3 4h10M3 8h10M3 12h6" />
              <span>{t('wbEntries', { count: board.session.entries.length })}</span>
            </div>
            {board.session.entries.map(entry => <EntryRow entry={entry} t={t} key={entry.id} />)}
          </div>
        </>
      ) : (
        <div className={css.empty}>
          <span>{emptyCopy.text}</span>
          {emptyCopy.hint !== undefined && <span className={css.emptyHint}>{emptyCopy.hint}</span>}
        </div>
      )}
      <SharedEntries label={t('wbSharedAll')} entries={sharedGlobal} t={t} />
      <SharedEntries label={t('wbSharedProject')} entries={sharedProject} t={t} />
    </section>
  )
}
