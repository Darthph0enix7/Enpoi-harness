/**
 * Pure host-side derivation of an accepted peer prompt's durable disposition
 * from raw Session events (unfiltered by peer exposure).
 *
 * Replays `agent/inbox/spliced`, `turn/start`, `user/message`, and `turn/end`
 * in log order so queue-edits, steers, and `keepInbox: true` stops remain
 * accurate without trusting caller-side exposure filters.
 *
 * @module @deepseek-ai/dsh-api-peer/disposition
 */

import { PEER_BUDGET_STOP_REASON, type PeerFoldEvent } from './latch.ts'
import type {
  PeerPromptDisposition,
  PeerTerminalOutcome,
  PeerTurnError,
  PeerTurnTerminal,
} from './types.ts'

/** Host-derived disposition of one accepted peer prompt from its Session log. */
export interface PeerPromptDispositionResult {
  readonly disposition: PeerPromptDisposition
  readonly terminalState?: PeerTerminalOutcome
  readonly terminal?: PeerTurnTerminal
}

interface InboxItem {
  readonly id: string | undefined
  readonly rpcId: string | undefined
}

interface OpenTurnState {
  readonly turn: number
  readonly claimedRpcIds: Set<string>
  readonly claimedMsgIds: Set<string>
}

/**
 * Derive the current durable disposition of a prompt `requestId` from raw Session
 * events. Returns `'unknown'` when the log has no evidence for `requestId` or
 * carries corrupt inbox splice coordinates.
 * @param events - ordered raw Session events from seq 0.
 * @param requestId - durable Session prompt identity (`source.rpcId`).
 * @returns the derived disposition and, when terminal, the turn outcome.
 */
export function derivePromptDisposition(
  events: readonly PeerFoldEvent[],
  requestId: string,
): PeerPromptDispositionResult {
  const inbox: Record<'next-turn' | 'next-step', InboxItem[]> = {
    'next-turn': [],
    'next-step': [],
  }
  let openTurn: OpenTurnState | undefined
  let disposition: PeerPromptDisposition = 'unknown'
  let claimedTurn: number | undefined
  let terminalState: PeerTerminalOutcome | undefined
  let terminal: PeerTurnTerminal | undefined

  for (const event of events) {
    switch (event.type) {
      case 'agent/inbox/spliced': {
        if (!isRecord(event.data)) return { disposition: 'unknown' }
        const target = event.data.target
        if (target !== 'next-turn' && target !== 'next-step') return { disposition: 'unknown' }
        const start = event.data.start
        const rawRemoved = event.data.removedCount
        const removedCount = rawRemoved === undefined ? 0 : rawRemoved
        const insertedRaw = event.data.inserted
        const list = inbox[target]
        if (typeof start !== 'number' || !Number.isSafeInteger(start) || start < 0 || start > list.length) {
          return { disposition: 'unknown' }
        }
        if (typeof removedCount !== 'number' || !Number.isSafeInteger(removedCount)
          || removedCount < 0 || start + removedCount > list.length) {
          return { disposition: 'unknown' }
        }
        if (!Array.isArray(insertedRaw)) return { disposition: 'unknown' }
        const insertedItems: InboxItem[] = insertedRaw.map(entry => ({
          id: stringField(entry, 'id'),
          rpcId: rpcIdOfMessage(entry),
        }))
        const removed = list.splice(start, removedCount, ...insertedItems)
        if (removed.some(item => item.rpcId === requestId)) {
          if (event.data.outcome === 'canceled') {
            disposition = 'cancelled_before_dispatch'
            claimedTurn = undefined
            terminalState = undefined
            terminal = undefined
          } else {
            disposition = 'claimed'
            claimedTurn = openTurn?.turn
            if (openTurn !== undefined) {
              openTurn.claimedRpcIds.add(requestId)
              for (const item of removed) {
                if (item.rpcId === requestId && item.id !== undefined) {
                  openTurn.claimedMsgIds.add(item.id)
                }
              }
            }
          }
        }
        if (insertedItems.some(item => item.rpcId === requestId)) {
          disposition = 'queued'
          claimedTurn = undefined
          terminalState = undefined
          terminal = undefined
        }
        break
      }
      case 'turn/start': {
        const turn = numberField(event.data, 'turn')
        if (turn !== undefined) {
          openTurn = { turn, claimedRpcIds: new Set(), claimedMsgIds: new Set() }
        }
        break
      }
      case 'user/message': {
        const rpcId = rpcIdOfMessage(event.data)
        const msgId = stringField(event.data, 'id')
        const matchesMsg = msgId !== undefined && openTurn?.claimedMsgIds.has(msgId) === true
        if (rpcId === requestId || matchesMsg) {
          if (disposition === 'unknown' || disposition === 'queued') {
            disposition = 'claimed'
          }
          if (openTurn !== undefined) {
            claimedTurn = openTurn.turn
            openTurn.claimedRpcIds.add(requestId)
          }
        }
        break
      }
      case 'turn/end': {
        const turn = numberField(event.data, 'turn')
        const reason = recordField(event.data, 'reason')
        const consumedByThisTurn = turn !== undefined && reason !== undefined
          && (claimedTurn === turn || (openTurn?.turn === turn && openTurn.claimedRpcIds.has(requestId)))
        if (consumedByThisTurn) {
          const mapped = mapTurnEnd(turn, event.time, reason)
          if (mapped !== undefined) {
            disposition = 'terminal'
            terminalState = mapped.terminalState
            terminal = mapped.terminal
          }
        }
        openTurn = undefined
        break
      }
      default:
        break
    }
  }

  return {
    disposition,
    ...(terminalState === undefined ? {} : { terminalState }),
    ...(terminal === undefined ? {} : { terminal }),
  }
}

function mapTurnEnd(
  turn: number,
  at: number,
  reason: Record<string, unknown>,
): { readonly terminalState: PeerTerminalOutcome; readonly terminal: PeerTurnTerminal } | undefined {
  const kind = reason.kind
  if (typeof kind !== 'string') return undefined
  const error = parseTurnError(recordField(reason, 'error'))
  const cancelReason = recordField(reason, 'reason')
  const isBudgetStop = kind === 'aborted'
    && cancelReason?.kind === 'hook'
    && cancelReason.reason === PEER_BUDGET_STOP_REASON

  let terminalState: PeerTerminalOutcome
  switch (kind) {
    case 'completed':
      terminalState = 'completed'
      break
    case 'aborted':
      terminalState = isBudgetStop ? 'budget' : 'aborted'
      break
    case 'error':
      terminalState = 'failed'
      break
    case 'blocked':
      terminalState = 'blocked'
      break
    case 'max-tokens':
      terminalState = 'max-tokens'
      break
    case 'interrupted':
      terminalState = 'interrupted'
      break
    default:
      terminalState = 'failed'
      break
  }

  const terminal: PeerTurnTerminal = {
    turn,
    reason: kind as PeerTurnTerminal['reason'],
    at,
    ...(error === undefined ? {} : { error }),
    ...(isBudgetStop ? { stop: 'budget' as const } : {}),
  }
  return { terminalState, terminal }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function recordField(value: unknown, key: string): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined
  const field = value[key]
  return isRecord(field) ? field : undefined
}

function stringField(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) return undefined
  const field = value[key]
  return typeof field === 'string' ? field : undefined
}

function numberField(value: unknown, key: string): number | undefined {
  if (!isRecord(value)) return undefined
  const field = value[key]
  return typeof field === 'number' && Number.isFinite(field) ? field : undefined
}

function rpcIdOfMessage(value: unknown): string | undefined {
  const source = recordField(value, 'source')
  return source === undefined ? undefined : stringField(source, 'rpcId')
}

function parseTurnError(value: Record<string, unknown> | undefined): PeerTurnError | undefined {
  if (value === undefined) return undefined
  const code = value.code
  const message = value.message
  if (typeof code !== 'string') return undefined
  const provider = value.provider
  const model = value.model
  return {
    code,
    message: typeof message === 'string' ? message : code,
    ...(typeof provider === 'string' ? { provider } : {}),
    ...(typeof model === 'string' ? { model } : {}),
  }
}
