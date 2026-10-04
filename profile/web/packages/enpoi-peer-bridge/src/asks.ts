/**
 * Remote-ask surfacing: how a pending ask on the far side reaches the local
 * operator, and how the local decision maps back onto `peer.answer`.
 *
 * The primary channel is the local approval service (`ctx.approval.request`),
 * raised from inside the `peer_ask` turn that is following the remote turn;
 * the answer maps one-to-one onto the peer vocabulary. When the local service
 * cannot be used (no `approval` service, no agent, no open turn, or a question
 * ask that the approval vocabulary cannot represent), the bridge records a
 * durable notice under `$DSH_HOME/peer-bridge/asks.jsonl` and leaves the ask
 * answerable through `peer_answer` / `ds peer answer` — never silently
 * auto-answered.
 *
 * @module dsh-enpoi-peer-bridge/asks
 */

import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { PeerPendingAsk, PeerQuestionAnswer, PeerQuestionAnswerItem, PeerQuestionItem } from './peer-client.js'

/** What the local approval service decided about a remote ask. */
export type LocalAskDecision = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable' | 'unsurfaced'

/** One ask's lifecycle as the bridge reports it to the local model/operator. */
export interface AskRecord {
  readonly askId: string
  readonly kind: 'approval' | 'question'
  readonly toolName?: string
  readonly reason?: string
  /** Filled in as the ask is surfaced (approval card / local question) or noticed (durable file). */
  surfaced: 'approval' | 'question' | 'notice'
  /** Local decision when one was made; absent while the ask is still pending. */
  decision?: LocalAskDecision
  /** Labels the local question answerer selected, when one answered. */
  selected?: readonly string[]
  /** Peer answer relay outcome: settled, conflict, not-found, or relay-failed. */
  relay?: 'settled' | 'conflict' | 'not-found' | 'failed'
  note?: string
}

/** Human label for one remote ask, used on the local approval card and in tool output. */
export function askLabel(alias: string, sessionId: string, ask: Pick<PeerPendingAsk, 'kind' | 'toolName' | 'reason' | 'questions'>): string {
  const what = ask.kind === 'approval'
    ? `approval for tool "${ask.toolName ?? 'unknown'}"`
    : `a user question${ask.questions?.[0] === undefined ? '' : ` ("${ask.questions[0].question}")`}`
  const why = ask.reason === undefined || ask.reason === '' ? '' : ` — ${ask.reason}`
  return `remote ask on ${alias} (${sessionId}): ${what}${why}`
}

/**
 * Map one local approval outcome onto the peer answer vocabulary.
 * `allowed-always` and the fail-closed outcomes never convert: a peer may
 * grant `allowed-once` or `rejected` only (doc 70 §5.5), and an unanswered
 * ask stays answerable rather than being auto-rejected.
 * @param decision - local service outcome.
 * @returns the peer outcome when relayable, plus the operator-facing note.
 */
export function localDecisionToPeerAnswer(decision: LocalAskDecision): { readonly outcome?: 'allowed-once' | 'rejected'; readonly note: string } {
  switch (decision) {
    case 'allowed-once':
      return { outcome: 'allowed-once', note: 'local operator approved once → relayed as allowed-once' }
    case 'rejected':
      return { outcome: 'rejected', note: 'local operator rejected → relayed as rejected' }
    case 'cancelled':
      return { note: 'local approval was withdrawn/cancelled — remote ask left unanswered' }
    case 'unavailable':
      return { note: 'local approval channel unavailable (no answerer/timeout) — remote ask left unanswered' }
    case 'unsurfaced':
      return { note: 'local approval service unavailable — ask recorded as a durable notice and left answerable via peer_answer' }
  }
}

/** One-line summary of a pending ask for tool output and notices. */
export function askSummary(ask: PeerPendingAsk): string {
  if (ask.kind === 'approval') {
    const reason = ask.reason === undefined || ask.reason === '' ? '' : ` (${ask.reason})`
    return `approval ${ask.askId} tool=${ask.toolName ?? 'unknown'}${reason}`
  }
  const questions = ask.questions ?? []
  const rendered = questions.map(renderQuestion).join('; ')
  return `question ${ask.askId} (${String(questions.length)} item${questions.length === 1 ? '' : 's'})${rendered === '' ? '' : `: ${rendered}`}`
}

/** One question with its selectable labels, for tool output and durable notices. */
export function renderQuestion(question: PeerQuestionItem): string {
  const options = (question.options ?? []).map(option => option.label).join(', ')
  const multi = question.multiSelect === true ? ' multi' : ''
  return `"${question.question}" (id=${question.id}${multi}${options === '' ? '' : `; options: ${options}`})`
}

/** One selected option set the caller asks the host to apply. */
export interface QuestionSelection {
  readonly id: string
  readonly selected: readonly string[]
  readonly custom?: string
}

/** Outcome of validating caller-side question selections against the ask. */
export type QuestionSelectionResult =
  | { readonly ok: true; readonly answer: PeerQuestionAnswer }
  | { readonly ok: false; readonly message: string }

/**
 * Validate selected option labels against the question list the host exposed
 * before sending an answer, so a malformed selection fails with a clear local
 * message instead of a host-side `peer/not-found` (or a silent drop).
 * @param questions - questions from the pending ask.
 * @param selections - caller-provided `{id, selected}` entries.
 * @returns the normalized `AskUserQuestionAnswer`, or the reason it is invalid.
 */
export function normalizeQuestionSelections(
  questions: readonly PeerQuestionItem[],
  selections: readonly QuestionSelection[],
): QuestionSelectionResult {
  if (questions.length === 0) return { ok: false, message: 'the question ask carries no questions' }
  if (selections.length === 0) return { ok: false, message: 'no selected labels were provided (use --select <label> or an answers[] entry)' }
  const byId = new Map(questions.map(question => [question.id, question]))
  const answers: PeerQuestionAnswerItem[] = []
  for (const selection of selections) {
    const question = byId.get(selection.id)
    if (question === undefined) {
      return { ok: false, message: `unknown question id ${JSON.stringify(selection.id)}; the ask has ${questions.map(item => item.id).join(', ')}` }
    }
    if (answers.some(answer => answer.id === selection.id)) {
      return { ok: false, message: `question ${JSON.stringify(selection.id)} was selected twice` }
    }
    if (selection.selected.length === 0) {
      return { ok: false, message: `question ${JSON.stringify(selection.id)} has no selected label` }
    }
    if (question.multiSelect !== true && selection.selected.length > 1) {
      return { ok: false, message: `question ${JSON.stringify(selection.id)} is single-select but got ${String(selection.selected.length)} labels` }
    }
    const labels = (question.options ?? []).map(option => option.label)
    for (const label of selection.selected) {
      if (labels.length > 0 && !labels.includes(label)) {
        return { ok: false, message: `${JSON.stringify(label)} is not an option of question ${JSON.stringify(selection.id)} (options: ${labels.join(', ')})` }
      }
      if (selection.selected.filter(candidate => candidate === label).length > 1) {
        return { ok: false, message: `${JSON.stringify(label)} was selected twice for question ${JSON.stringify(selection.id)}` }
      }
    }
    answers.push({
      id: selection.id,
      selected: [...selection.selected],
      ...(selection.custom === undefined || selection.custom === '' ? {} : { custom: selection.custom }),
    })
  }
  const unanswered = questions.filter(question => !answers.some(answer => answer.id === question.id))
  if (unanswered.length > 0) {
    return { ok: false, message: `question${unanswered.length === 1 ? '' : 's'} ${unanswered.map(question => JSON.stringify(question.id)).join(', ')} not answered` }
  }
  return { ok: true, answer: { answers } }
}

/** One durable notice record; the fallback channel when the local service cannot be used. */
export interface AskNotice {
  readonly at: number
  readonly alias: string
  readonly sessionId: string
  readonly askId: string
  readonly kind: 'approval' | 'question'
  readonly toolName?: string
  readonly reason?: string
  readonly questions?: readonly PeerQuestionItem[]
  readonly note: string
}

/**
 * Append one ask notice to the durable JSONL file (created on first write).
 * @param path - notice file path.
 * @param notice - notice record.
 */
export function appendAskNotice(path: string, notice: AskNotice): void {
  try {
    mkdirSync(dirname(path), { recursive: true })
    appendFileSync(path, `${JSON.stringify(notice)}\n`, { mode: 0o600 })
  } catch {
    // A notice file failure must never take the bridge or the local turn down.
  }
}

/** Default durable notice location beside the pairing document. */
export function defaultNoticesPath(dshHome: string): string {
  return `${dshHome.replace(/\/+$/u, '')}/peer-bridge/asks.jsonl`
}
