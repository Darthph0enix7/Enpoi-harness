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
import { modelHopOf } from './latch.ts'
import type { PeerEventRecord, PeerExposure, PeerModelHopData } from './types.ts'

/** Durable event type the synthetic `model-hop` peer record derives from. */
const ATTEMPT_FAILED_EVENT = 'llm/attempt-failed'

/**
 * Synthetic peer record type carrying {@link PeerModelHopData}. It is emitted
 * at every exposure and shares the durable seq of its source
 * `llm/attempt-failed` event.
 */
export const MODEL_HOP_RECORD_TYPE = 'model-hop'

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

/**
 * Project one durable event into the peer wire records when exposure admits
 * it. Every `llm/attempt-failed` additionally yields one synthetic
 * `model-hop` record at the same durable seq in every exposure; `debug`
 * keeps the raw record exactly as before, and `answer-only` never sees it
 * because the raw payload may carry provider prose or request text.
 * @param event - durable event with seq, time, type, and data.
 * @param exposure - resolved pairing exposure.
 * @returns zero records, the synthetic record alone, or the debug raw record followed by it.
 */
export function toPeerRecords(
  event: { readonly seq: number; readonly time: number; readonly type: string; readonly data: unknown },
  exposure: PeerExposure,
): readonly PeerEventRecord[] {
  const records: PeerEventRecord[] = []
  const raw = toPeerRecord(event, exposure)
  if (raw !== undefined) records.push(raw)
  if (event.type !== ATTEMPT_FAILED_EVENT) return records
  const hop = modelHopOf(event)
  if (hop === undefined) return records
  records.push({
    seq: brandNumber<SessionSeq>(event.seq),
    time: event.time,
    type: MODEL_HOP_RECORD_TYPE,
    data: modelHopValue(hop),
  })
  return records
}

/** Rebuild one hop payload as a JSON value with only the allow-listed fields. */
function modelHopValue(hop: PeerModelHopData): JsonValue {
  return {
    from: { provider: hop.from.provider, model: hop.from.model },
    ...(hop.to === undefined ? {} : { to: { provider: hop.to.provider, model: hop.to.model } }),
    reason: hop.reason,
    ...(hop.chain === undefined ? {} : { chain: hop.chain }),
    at: hop.at,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
