/**
 * Pure readers over `peer.follow` event records.
 *
 * The durable event payloads are the session log's own shapes (doc 69 §9.1):
 * `user/message` carries `source.rpcId` (the request id we minted),
 * `assistant/message` carries `turn`/`message.content`, and `turn/end` carries
 * `turn` plus `reason.kind`/`reason.error`. Keeping the readers here makes the
 * correlation rules unit-testable without a live host.
 *
 * @module dsh-enpoi-peer-bridge/follow
 */

import type { PeerEventRecord } from './peer-client.js'

/** Default quiet window after a terminal before a followed session is accepted as settled. */
export const DEFAULT_SETTLE_QUIET_MS = 2_000

/** Signals deciding whether a followed session is provably quiet. */
export interface PeerSettleSignals {
  /** Latest terminal `turn/end` folded from the follow. */
  readonly terminal?: TurnTerminal
  /** Latch reported by the newest state frame. */
  readonly latch?: string
  /** Live descendants reported by the newest state frame. */
  readonly activeDescendants?: number
  /** Whether the descendant count is exact; false leaves settling to the quiet window. */
  readonly descendantsExact?: boolean
  /** Pending ask count reported by the newest state frame. */
  readonly pendingAskCount?: number
}

/**
 * Whether a followed session is settled: a terminal arrived, no ask or
 * descendant is live, and the latch is not running/waiting. Absent signals
 * leave settling to the quiet window.
 * @param state - latest observed signals.
 * @returns true only when the session is provably quiet.
 */
export function isPeerSessionSettled(state: PeerSettleSignals | undefined): boolean {
  if (state === undefined || state.terminal === undefined) return false
  if ((state.pendingAskCount ?? 0) > 0) return false
  if ((state.activeDescendants ?? 0) > 0) return false
  if (state.descendantsExact === false) return false
  return state.latch === undefined || state.latch === 'unknown' || state.latch === 'idle'
}

/** Structured turn failure carried by `turn/end{reason:'error'}`. */
export interface TurnFailure {
  readonly code?: string
  readonly message?: string
  readonly provider?: string
  readonly model?: string
}

/** One parsed turn terminal. */
export interface TurnTerminal {
  readonly turn: number
  readonly reason: string
  readonly error?: TurnFailure
}

/**
 * Read `data.source.rpcId` from a `user/message` record.
 * @param record - durable event record.
 * @returns the request id, or undefined when the record is not a prompt admission.
 */
export function recordRpcId(record: PeerEventRecord): string | undefined {
  if (record.type !== 'user/message') return undefined
  const source = field(record.data, 'source')
  const rpcId = field(source, 'rpcId')
  return typeof rpcId === 'string' ? rpcId : undefined
}

/** Read `data.source.participant` from a `user/message` record. */
export function recordParticipant(record: PeerEventRecord): { readonly kind?: string; readonly name?: string } | undefined {
  if (record.type !== 'user/message') return undefined
  const participant = field(field(record.data, 'source'), 'participant')
  if (participant === undefined) return undefined
  return {
    ...(typeof field(participant, 'kind') === 'string' ? { kind: field(participant, 'kind') as string } : {}),
    ...(typeof field(participant, 'name') === 'string' ? { name: field(participant, 'name') as string } : {}),
  }
}

/** Read the turn number of an event that belongs to one turn. */
export function recordTurn(record: PeerEventRecord): number | undefined {
  const turn = field(record.data, 'turn')
  return typeof turn === 'number' && Number.isFinite(turn) ? turn : undefined
}

/**
 * Parse one `turn/end` record into a terminal.
 * @param record - durable event record.
 * @returns the terminal, or undefined when the record is not a turn end.
 */
export function recordTerminal(record: PeerEventRecord): TurnTerminal | undefined {
  if (record.type !== 'turn/end') return undefined
  const turn = recordTurn(record)
  if (turn === undefined) return undefined
  const reason = field(record.data, 'reason')
  const kind = field(reason, 'kind')
  const error = field(reason, 'error')
  return {
    turn,
    reason: typeof kind === 'string' ? kind : 'unknown',
    ...(error === undefined ? {} : { error: error as TurnFailure }),
  }
}

/**
 * Extract the plain text of one `assistant/message` record.
 * @param record - durable event record.
 * @returns newline-joined text blocks, or an empty string.
 */
export function recordAssistantText(record: PeerEventRecord): string {
  if (record.type !== 'assistant/message') return ''
  const message = field(record.data, 'message')
  return contentText(field(message, 'content'))
}

/**
 * Join the text blocks of a content array; non-text blocks contribute nothing.
 * @param content - model content blocks.
 * @returns newline-joined text.
 */
export function contentText(content: unknown): string {
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    const text = field(block, 'text')
    if (field(block, 'type') === 'text' && typeof text === 'string') parts.push(text)
  }
  return parts.join('\n')
}

/** Read `data.content` of a `user/message` record as plain text. */
export function recordUserText(record: PeerEventRecord): string {
  if (record.type !== 'user/message') return ''
  return contentText(field(record.data, 'content'))
}

function field(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null) return undefined
  return (value as Record<string, unknown>)[key]
}
