/**
 * Exposure filtering for peer-visible durable events.
 *
 * `answer-only` carries the durable dialogue, turn boundaries, and ask audit
 * trail; `debug` additionally carries tool/step/subagent/injection traffic
 * (doc 69 §9.1). Filtering happens while producing records on the host, never
 * client-side, so an `answer-only` stream never contains tool internals.
 *
 * @module @deepseek-ai/dsh-api-peer/exposure
 */

import { brandNumber } from '@deepseek-ai/dsh-brand'
import type { SessionSeq } from '@deepseek-ai/dsh-session/types'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { PeerEventRecord, PeerExposure } from './types.ts'

const ANSWER_ONLY_TYPES: ReadonlySet<string> = new Set([
  'assistant/message',
  'turn/start',
  'turn/end',
  'approval/asked',
  'approval/decided',
])

const DIALOGUE_SOURCES: ReadonlySet<string> = new Set([
  'user',
  'user-rpc',
  'webhook',
  'agent-message',
  'subagent-settled',
  'team-message',
])

const DEBUG_EXTRA_TYPES: ReadonlySet<string> = new Set([
  'tool/call',
  'tool/result',
  'step/start',
  'step/end',
  'assistant/attempt',
  'subagent/catalog',
  'subagent/descriptor',
  'goal/change',
  'goal/continuation',
  'compaction/start',
  'compaction/end',
  'revert/commit',
  'revert/restore',
  'model/selection',
  'session/title',
])

/**
 * Whether one durable event is visible at an exposure level.
 * @param type - durable event type name.
 * @param data - event payload used to classify `user/message` provenance.
 * @param exposure - resolved pairing exposure.
 * @returns whether the event may cross the peer boundary.
 */
export function isExposedEvent(type: string, data: unknown, exposure: PeerExposure): boolean {
  if (exposure === 'debug') return true
  if (ANSWER_ONLY_TYPES.has(type)) return true
  if (type !== 'user/message') return false
  const source = isRecord(data) ? data.source : undefined
  if (source === undefined) return true
  const kind = isRecord(source) ? source.kind : undefined
  return typeof kind === 'string' && DIALOGUE_SOURCES.has(kind)
}

/** Whether a type is debug-only, for host tests and diagnostics. */
export function isDebugOnlyType(type: string): boolean {
  return DEBUG_EXTRA_TYPES.has(type) || !ANSWER_ONLY_TYPES.has(type)
}

/**
 * Project one durable event into the peer wire record when exposure admits it.
 * @param event - durable event with seq, time, type, and data.
 * @param exposure - resolved pairing exposure.
 * @returns the peer record, or `undefined` when filtered out.
 */
export function toPeerRecord(
  event: { readonly seq: number; readonly time: number; readonly type: string; readonly data: unknown },
  exposure: PeerExposure,
): PeerEventRecord | undefined {
  if (!isExposedEvent(event.type, event.data, exposure)) return undefined
  return {
    seq: brandNumber<SessionSeq>(event.seq),
    time: event.time,
    type: event.type,
    data: event.data as JsonValue,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
