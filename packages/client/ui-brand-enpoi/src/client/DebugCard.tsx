/**
 * Watchtower Live Debug card (doc 69 §9.1 read surface).
 *
 * Renders the digest's latch, descendants, pending asks (with answer buttons
 * only where this client already owns the live answer path — the same
 * PendingApproval/PendingQuestion objects the composer cards settle), model,
 * last turn end with its structured error, the recent tool timeline, the
 * injection index, the subagent tree, plus the request-snapshot and incident
 * tails. Degrades per section: a digest failure renders one clear
 * "debug unavailable" line, never invented data.
 */
import { useState } from 'react'
import { MicroIcon } from './MicroIcon.tsx'
import type { BrandT } from './locales.ts'
import type { DebugDigest, DebugIncidentList, DebugRead, DebugSnapshot } from './debug-view.ts'
import css from './WatchtowerView.module.css'

/** The live pending interaction this client can answer (structural face). */
export interface AnswerableInteraction {
  readonly kind: string
  readonly key?: string
  readonly questions?: readonly {
    readonly id: string
    readonly options?: readonly { readonly label: string }[]
  }[]
  answer?(value: unknown): Promise<void>
}

/** One refresh of the debug reads. */
export interface DebugState {
  readonly phase: 'idle' | 'loading' | 'ready'
  readonly digest: DebugRead<DebugDigest> | null
  readonly snapshot: DebugRead<DebugSnapshot> | null
  readonly incidents: DebugRead<DebugIncidentList> | null
}

export interface DebugCardProps {
  readonly state: DebugState
  readonly sessionId?: string | undefined
  /** Live answer path for the current session, when one is mounted here. */
  readonly pendingInteraction?: AnswerableInteraction | undefined
  /** Build and copy the same markdown `dsh-debug report` writes. */
  readonly onCopyReport?: () => Promise<'copied' | 'failed'>
  /** Package copy translate. */
  readonly t: BrandT
}

function statusState(status: string): string {
  return status === 'ok' ? 'live' : status === 'error' ? 'error' : 'cooling'
}

function shortId(value: string): string {
  return value.length > 24 ? value.slice(-12) : value
}

/** One small action button in the card. */
function ActionButton({ label, title, onClick }: { label: string; title: string; onClick: () => void }) {
  return (
    <button type="button" className={css.debugAction} title={title} onClick={onClick}>{label}</button>
  )
}

export function DebugCard({ state, sessionId, pendingInteraction, onCopyReport, t }: DebugCardProps) {
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle')

  const digest = state.digest?.phase === 'ready' ? state.digest.value : null
  const error = state.digest?.phase === 'error' ? state.digest : null

  const copy = (): void => {
    if (onCopyReport === undefined) return
    void onCopyReport().then((result) => { setCopyState(result) }).catch(() => { setCopyState('failed') })
  }

  /** Answer through the interaction object this client already owns. */
  const answerApproval = (outcome: 'allowed-once' | 'allowed-always' | 'rejected'): void => {
    if (pendingInteraction?.kind !== 'approval') return
    void pendingInteraction.answer?.(outcome).catch(() => { /* surfaced by the composer path */ })
  }
  const answerQuestion = (questionId: string, label: string): void => {
    if (pendingInteraction?.kind !== 'question') return
    void pendingInteraction.answer?.({ answers: [{ id: questionId, selected: [label] }] })
      .catch(() => { /* surfaced by the composer path */ })
  }

  return (
    <section className={css.card}>
      <div className={css.cardHead}>
        <MicroIcon d="M8 1v4M8 9v2M2 8h2M12 8h2M3.5 3.5l1.5 1.5M11 11l1.5 1.5M3.5 12.5L5 11M11 5l1.5-1.5" />
        <span>{t('debugTitle')}</span>
        <span className={css.debugSpacer} />
        {state.phase === 'loading' && <span className={css.debugMuted}>{t('debugReading')}</span>}
        {onCopyReport !== undefined && (
          <button type="button" className={css.debugCopy} onClick={copy} title={t('debugCopyTitle')}>
            {copyState === 'copied' ? t('debugCopied') : copyState === 'failed' ? t('debugCopyFailed') : t('debugCopyReport')}
          </button>
        )}
      </div>

      {state.phase === 'idle' && <div className={css.empty}>{t('debugNoSession')}</div>}

      {error !== null && (
        <div className={css.debugUnavailable} title={error.message}>
          {t('debugUnavailable', { code: error.code })}
        </div>
      )}

      {digest !== null && (
        <>
          <div className={css.debugRow}>
            <span className={css.debugLatch} data-state={digest.state.latch}>{digest.state.latch}</span>
            <span className={css.debugMuted} title={t('debugLatchTitle')}>
              {digest.state.source}
            </span>
            <span className={css.debugMuted}>{t('debugSince', { time: new Date(digest.state.since).toISOString().slice(11, 19) })}</span>
            <span className={css.debugMuted} title={t('debugDescendantsTitle')}>
              ↓{digest.state.activeDescendants}{digest.state.descendantsExact ? '' : '?'}
            </span>
            {digest.model !== undefined && (
              <span className={css.debugMuted} title={t('debugModelTitle')}>
                {digest.model.provider}/{digest.model.model}
              </span>
            )}
          </div>

          <div className={css.debugRow}>
            <span className={css.debugLabel}>{t('debugTurn')}</span>
            {digest.state.lastTurnEnd === undefined ? (
              <span className={css.debugMuted}>{t('debugNoTurnEnded')}</span>
            ) : (
              <span className={css.debugMuted}>
                #{digest.state.lastTurnEnd.turn} {digest.state.lastTurnEnd.reason}
                {digest.state.lastTurnEnd.error !== undefined && (
                  <span className={css.debugError} title={digest.state.lastTurnEnd.error.message}>
                    {' '}· {digest.state.lastTurnEnd.error.code}
                  </span>
                )}
              </span>
            )}
          </div>

          <div className={css.section}>
            <div className={css.sectionHead}>
              <MicroIcon d="M8 3a5 5 0 100 10A5 5 0 008 3zM8 6v3l2 1" />
              <span>{t('debugAsks', { count: digest.pendingInteractions.length })}</span>
            </div>
            <div className={css.sectionBody}>
              {digest.pendingInteractions.length === 0 && <span className={css.debugMuted}>{t('debugNonePending')}</span>}
              {digest.pendingInteractions.map((ask) => {
                const live = pendingInteraction !== undefined && pendingInteraction.kind === ask.kind
                return (
                  <div key={ask.askId} className={css.debugAsk}>
                    <span className={css.debugAskKind}>{ask.kind}</span>
                    <span className={css.debugAskBody}>
                      {ask.kind === 'approval'
                        ? `${ask.toolName ?? '?'}${ask.reason === undefined ? '' : ` — ${ask.reason}`}`
                        : (ask.questions ?? []).map(question => question.question).join(' | ')}
                    </span>
                    {live && ask.kind === 'approval' && (
                      <span className={css.debugActions}>
                        <ActionButton label={t('debugAllowOnce')}
                          title={t('debugAllowOnceTitle')} onClick={() => { answerApproval('allowed-once') }} />
                        <ActionButton label={t('debugAlways')} title={t('debugAlwaysTitle')} onClick={() => { answerApproval('allowed-always') }} />
                        <ActionButton label={t('debugReject')} title={t('debugRejectTitle')} onClick={() => { answerApproval('rejected') }} />
                      </span>
                    )}
                    {live && ask.kind === 'question' && (pendingInteraction?.questions ?? []).flatMap(question =>
                      (question.options ?? []).slice(0, 6).map(option => (
                        <ActionButton
                          key={`${question.id}:${option.label}`}
                          label={option.label}
                          title={t('debugAnswerTitle', { answer: option.label, id: question.id })}
                          onClick={() => { answerQuestion(question.id, option.label) }}
                        />
                      )))}
                    {!live && <span className={css.debugMuted}
                      title={t('debugElsewhereTitle')}>{t('debugElsewhere')}</span>}
                  </div>
                )
              })}
            </div>
          </div>

          {digest.recentFailures !== undefined && digest.recentFailures.length > 0 && (
            <div className={css.debugRow}>
              <span className={css.debugLabel}>{t('debugFailures')}</span>
              <span className={css.debugMuted}
                title={digest.recentFailures
                  .map(failure => `${failure.provider}/${failure.model} ${failure.code}: ${failure.message}`)
                  .join('\n')}>
                {digest.recentFailures.length}: {digest.recentFailures.slice(0, 2)
                  .map((failure) => {
                    const code = `${failure.provider}/${failure.model} ${failure.code}`
                    return failure.next === undefined ? code : `${code}→${failure.next.provider}`
                  })
                  .join(', ')}
              </span>
            </div>
          )}

          <div className={css.section}>
            <div className={css.sectionHead}>
              <MicroIcon d="M3 3h10v10H3zM6 3v10M3 6h3" />
              <span>{t('debugTools', { count: digest.recentToolCalls.length })}</span>
            </div>
            <div className={css.sectionBody}>
              {digest.recentToolCalls.length === 0 && <span className={css.debugMuted}>{t('debugNoRecentCalls')}</span>}
              {digest.recentToolCalls.map((call, index) => (
                <div key={index} className={css.debugToolRow}
                  title={call.error === undefined
                    ? call.resultPreview
                    : `${call.error.name}:${call.error.code} ${call.error.reason ?? ''}`}>
                  <span className={css.debugDot} data-state={statusState(call.status)} />
                  <span className={css.debugToolName}>{call.tool}</span>
                  <span className={css.debugToolDetail}>
                    {call.status === 'error' && call.error !== undefined
                      ? `${call.error.name}:${call.error.code}`
                      : (call.argumentPreview ?? call.resultPreview ?? '')}
                  </span>
                </div>
              ))}
            </div>
          </div>

          <div className={css.debugRow}>
            <span className={css.debugLabel}>{t('debugInjections')}</span>
            <span
              className={css.debugMuted}
              title={digest.injectionIndex
                .map((entry) => {
                  const label = entry.label === undefined ? '' : ` (${entry.label})`
                  return `[${entry.seq}] ${entry.kind}${label} ${String(entry.chars)}c`
                })
                .join('\n')}
            >
              {digest.injectionIndex.length} · {t('debugChars', { count: digest.injectionIndex.reduce((sum, entry) => sum + entry.chars, 0) })}
              {digest.injectionIndex.slice(0, 3).map(entry => ` · ${entry.kind}`).join('')}
              {digest.injectionIndex.length > 3 ? ' …' : ''}
            </span>
          </div>

          <div className={css.section}>
            <div className={css.sectionHead}>
              <MicroIcon d="M2 11h3V8H2zM6.5 11h3V5h-3zM11 11h3V2h-3z" />
              <span>{t('debugSubagents', { count: digest.subagentTree.length })}</span>
            </div>
            <div className={css.sectionBody}>
              {digest.subagentTree.length === 0 && <span className={css.debugMuted}>{t('debugNone')}</span>}
              {digest.subagentTree.map(child => (
                <div key={child.childSessionId} className={css.debugToolRow} title={child.queryPreview}>
                  <span
                    className={css.debugDot}
                    data-state={child.status === 'running' ? 'live' : child.status === 'idle' ? 'cooling' : 'none'} />
                  <span className={css.debugToolName}>{shortId(child.childSessionId)}</span>
                  <span className={css.debugToolDetail}>{child.mode}{child.quiet ? t('debugQuiet') : ''} · {child.status}</span>
                </div>
              ))}
            </div>
          </div>

          <div className={css.debugRow}>
            <span className={css.debugLabel}>{t('debugRequest')}</span>
            {state.snapshot?.phase === 'ready' ? (
              <span className={css.debugMuted}>
                {state.snapshot.value.provider}/{state.snapshot.value.model} ·{' '}
                {t('debugRequestLine', { tools: state.snapshot.value.tools.length, messages: state.snapshot.value.messages.length })}
              </span>
            ) : state.snapshot?.phase === 'error' ? (
              <span className={css.debugMuted} title={state.snapshot.message}>{t('debugUnavailableCode', { code: state.snapshot.code })}</span>
            ) : (
              <span className={css.debugMuted}>…</span>
            )}
          </div>

          <div className={css.debugRow}>
            <span className={css.debugLabel}>{t('debugIncidents')}</span>
            {state.incidents?.phase === 'ready' ? (
              <span className={css.debugMuted}
                title={state.incidents.value.items.slice(0, 3).map(item => `${item.code} ${item.message}`).join('\n')}>
                {t('debugIncidentCounts', {
                  own: state.incidents.value.items.filter(item => item.sessionId === sessionId).length,
                  total: state.incidents.value.items.length,
                })}
              </span>
            ) : state.incidents?.phase === 'error' ? (
              <span className={css.debugMuted} title={state.incidents.message}>{t('debugUnavailableCode', { code: state.incidents.code })}</span>
            ) : (
              <span className={css.debugMuted}>…</span>
            )}
          </div>
        </>
      )}
    </section>
  )
}
