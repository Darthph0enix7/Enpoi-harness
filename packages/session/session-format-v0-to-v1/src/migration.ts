import {
  SessionFormatError,
  SessionFormatUnsupportedMigrationError,
  defineSessionFormatMigration,
  sessionFormatCount,
} from '@deepseek-ai/dsh-session-format'
import type {
  SessionFormatEvent,
  SessionFormatEventRun,
  SessionFormatHeader,
  SessionFormatJsonObject,
  SessionFormatJsonValue,
  SessionFormatMigrationContext,
  SessionFormatMigrationStage,
  SessionFormatMigrationStageInput,
} from '@deepseek-ai/dsh-session-format'
import { isReleasedAssistantChunkRun } from './codec.ts'
import { OPAQUE_FORK_V0_EVENT_TYPES } from './dispositions.ts'
import {
  assertReleasedEventPayload,
  assertReleasedV1Header,
} from './validation.ts'
import { assertReleasedV0Keys, releasedV0Record } from './validation-helpers.ts'

const LEGACY_ASSISTANT_SOURCE_KEY = ['pro', 'venance'].join('')

/** Identity format edge that promotes released v0 into released v1. */
export const sessionFormatV0ToV1 = defineSessionFormatMigration({
  name: '@deepseek-ai/dsh-session-format-v0-to-v1',
  fromVersion: 0,
  toVersion: 1,
  migrateHeader(header) {
    assertHeaderVersion(header, 0)
    return { ...header, version: 1 }
  },
  createStage(input) {
    return new ReleasedV0ToV1Stage(input)
  },
  validateTargetHeader: assertReleasedV1Header,
})

class ReleasedV0ToV1Stage implements SessionFormatMigrationStage {
  readonly headerInheritedEventCount: number
  private readonly state: LegacyNormalizationState = { messageIds: new Map(), retryIds: new Map() }

  constructor(private readonly input: SessionFormatMigrationStageInput) {
    assertHeaderVersion(input.sourceHeader, 0)
    this.headerInheritedEventCount = sessionFormatCount(input.sourceInheritedEventCount, 'format v0 inherited event count')
  }

  transformEvent(
    event: SessionFormatEvent,
    context: SessionFormatMigrationContext,
  ): void {
    const normalized = normalizeReleasedV0Event(event, this.input.sourceHeader.id, this.state)
    assertSourceDeliveryMarker(normalized, this.input)
    context.emitEvent(normalized)
  }

  transformRun(
    run: SessionFormatEventRun,
    context: SessionFormatMigrationContext,
  ): void {
    if (isReleasedAssistantChunkRun(run)) {
      context.emitRun(run)
      return
    }
    for (const event of run.expand()) this.transformEvent(event, context)
  }

  finish(_context: SessionFormatMigrationContext): number {
    return this.headerInheritedEventCount
  }
}

function assertHeaderVersion(header: SessionFormatHeader, version: 0 | 1): void {
  if (header.version !== version) throw new SessionFormatError(`expected format v${version} header`)
}

interface LegacyNormalizationState {
  readonly messageIds: Map<number, string>
  readonly retryIds: Map<string, string>
  compactionId?: string
}

function normalizeReleasedV0Event(
  event: SessionFormatEvent,
  sessionId: string,
  state: LegacyNormalizationState,
): SessionFormatEvent {
  const named = normalizeLegacyCompactionType(event)
  assertSupportedLegacyType(named, sessionId)
  const start = normalizeLegacyTurnStart(named, sessionId)
  const end = normalizeLegacyTurnEnd(start, sessionId)
  const header = normalizeLegacyRequestHeader(end, sessionId)
  const steering = normalizeLegacySteering(header, sessionId)
  const retry = normalizeLegacyRetry(steering, sessionId, state.retryIds)
  const compaction = normalizeLegacyCompaction(retry, sessionId, state)
  const message = normalizeLegacyMessage(compaction, sessionId, state.messageIds)
  const spliced = normalizeLegacyInboxSplice(message, sessionId)
  const marked = markOpaqueForkEvent(spliced)
  if (marked.type !== 'assistant/chunk') assertReleasedEventPayload(marked, 0)
  const messageId = eventMessageId(marked)
  if (messageId !== undefined) state.messageIds.set(marked.seq, messageId)
  return marked
}

/**
 * Stamp the persistence compatibility marker on installed-fork vocabulary that
 * predates this build's event catalog. The marker lets a reader keep the event
 * as opaque metadata instead of refusing the entire stored Session; the
 * identity edge preserves the payload verbatim either way.
 * @param event - normalized event about to leave the identity edge.
 * @returns the event with `ignorable: true` when it is opaque fork vocabulary
 *   without an explicit marker.
 */
function markOpaqueForkEvent(event: SessionFormatEvent): SessionFormatEvent {
  if (!OPAQUE_FORK_V0_EVENT_TYPES.has(event.type)) return event
  if (event['ignorable'] === true) return event
  return { ...event, ignorable: true }
}

/**
 * Repair the retired fork shape of one `agent/inbox/spliced` payload whose
 * inserted message text was spread into an index-keyed character map. The
 * intended message identity, when present, is retained; text is reassembled in
 * index order and wrapped in the canonical user-message shape the current
 * vocabulary requires.
 * @param event - normalized event about to leave the identity edge.
 * @param sessionId - owning Session, used for synthesized message identity.
 * @returns the event with recoverable inserted entries rebuilt.
 */
function normalizeLegacyInboxSplice(
  event: SessionFormatEvent,
  sessionId: string,
): SessionFormatEvent {
  if (event.type !== 'agent/inbox/spliced') return event
  const data = releasedV0Record(event.data, `${event.type} ${event.seq} data`)
  const inserted = data['inserted']
  if (!Array.isArray(inserted)) return event
  const entries = inserted as readonly SessionFormatJsonValue[]
  const rebuilt = entries.map((entry, index) => {
    const text = legacySplicedText(entry)
    if (text === undefined) return entry
    return recoveredSplicedMessage(entry, sessionId, event.seq, index, text)
  })
  if (rebuilt.every((entry, index) => entry === entries[index])) return event
  return { ...event, data: { ...data, inserted: rebuilt } }
}

/**
 * Recover text from a legacy fork splice entry written as `{0: 'a', 1: 'b'}`.
 * @param entry - one `inserted` member.
 * @returns the reassembled text, or `undefined` when the entry is not that shape.
 */
function legacySplicedText(entry: SessionFormatJsonValue): string | undefined {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return undefined
  const record = entry as Record<string, SessionFormatJsonValue>
  const keys = Object.keys(record)
  const numeric = keys.filter(key => LEGACY_INDEX_KEY.test(key))
  if (numeric.length === 0) return undefined
  const extras = keys.filter(key => !LEGACY_INDEX_KEY.test(key))
  if (extras.some(key => key !== 'id' && key !== 'role' && key !== 'source' && key !== 'content')) return undefined
  const max = numeric.reduce((largest, key) => Math.max(largest, Number(key)), -1)
  if (max !== numeric.length - 1) return undefined
  let text = ''
  for (let index = 0; index <= max; index += 1) {
    const value = record[String(index)]
    // Character maps store one UTF-16 code unit per index, including halves of
    // surrogate pairs; a longer value is not that shape.
    if (typeof value !== 'string' || value.length !== 1) return undefined
    text += value
  }
  return text.length === 0 ? undefined : text
}

/**
 * Rebuild one recovered splice entry as a canonical user message.
 * @param entry - the legacy index-keyed entry.
 * @param sessionId - owning Session.
 * @param seq - splice event sequence.
 * @param index - inserted position, used to keep synthesized identities unique.
 * @param text - reassembled message text.
 * @returns a current-vocabulary user message carrying the recovered text.
 */
function recoveredSplicedMessage(
  entry: SessionFormatJsonValue,
  sessionId: string,
  seq: number,
  index: number,
  text: string,
): SessionFormatJsonObject {
  const record = (typeof entry === 'object' && entry !== null && !Array.isArray(entry))
    ? entry as Record<string, SessionFormatJsonValue>
    : {}
  const id = typeof record['id'] === 'string' && record['id'].length > 0 ? record['id'] : undefined
  return {
    id: id ?? `${legacyMessageId(sessionId, seq)}:splice:${index}`,
    role: 'user',
    source: { kind: 'user' },
    content: [{ type: 'text', text }],
  }
}

const LEGACY_INDEX_KEY = /^(0|[1-9]\d*)$/u

function normalizeLegacyCompactionType(event: SessionFormatEvent): SessionFormatEvent {
  const type: string = event.type
  switch (type) {
    case 'compact/start':
      return { ...event, type: 'compaction/start' }
    case 'compact/summary':
      return { ...event, type: 'compaction/summary' }
    case 'compact/end':
      return { ...event, type: 'compaction/end' }
    case 'compact/prune':
      return { ...event, type: 'compaction/prune' }
    default:
      return event
  }
}

function assertSourceDeliveryMarker(
  event: SessionFormatEvent,
  input: SessionFormatMigrationStageInput,
): void {
  if (event.type !== 'session-log-deepseek/delivery-accepted') return
  const data = releasedV0Record(event.data, `${event.type} ${event.seq} data`)
  const acceptedVersion = data['sessionFormatVersion'] ?? 0
  const inherited = input.sourceHeader.parentSession !== undefined
    && event.seq < sessionFormatCount(input.sourceInheritedEventCount, 'format v0 inherited event count')
  if (acceptedVersion === 0 && !inherited && data['sessionId'] !== input.sourceHeader.id) {
    throw new SessionFormatError('current-generation delivery marker names the wrong Session')
  }
}

function normalizeLegacyRetry(
  event: SessionFormatEvent,
  sessionId: string,
  retryIds: Map<string, string>,
): SessionFormatEvent {
  if (event.type !== 'llm/retry') return event
  const data = releasedV0Record(event.data, `llm/retry ${event.seq} data`)
  const chain = [data['turn'], data['step'], data['provider'], data['policyKey']]
    .map(value => JSON.stringify(value))
    .join('\0')
  const retryId = data['retryId']
  if (typeof retryId === 'string' && retryId.length > 0) {
    retryIds.set(chain, retryId)
    return event
  }
  if (Object.hasOwn(data, 'retryId')) return event
  const migratedRetryId = retryIds.get(chain) ?? `legacy-retry:${sessionId}:${event.seq}`
  retryIds.set(chain, migratedRetryId)
  return { ...event, data: { ...data, retryId: migratedRetryId } }
}

function normalizeLegacyCompaction(
  event: SessionFormatEvent,
  sessionId: string,
  state: LegacyNormalizationState,
): SessionFormatEvent {
  if (event.type === 'session/end-seed') {
    delete state.compactionId
    return event
  }
  if (event.type === 'compaction/start') {
    const data = releasedV0Record(event.data, `compaction/start ${event.seq} data`)
    const existing = data['compactionId']
    if (typeof existing === 'string' && existing.length > 0) {
      state.compactionId = existing
      return event
    }
    if (Object.hasOwn(data, 'compactionId')) return event
    const id = `legacy-compaction:${sessionId}:${event.seq}`
    state.compactionId = id
    return { ...event, data: { ...data, compactionId: id } }
  }
  const compactionId = state.compactionId
  if (compactionId === undefined) return event
  if (event.type === 'compaction/summary' || event.type === 'compaction/end') {
    const normalized = addLegacyCompactionId(event, compactionId)
    if (event.type === 'compaction/end') delete state.compactionId
    return normalized
  }
  if (event.type !== 'user/message') return event
  const data = releasedV0Record(event.data, `user/message ${event.seq} data`)
  const source = data['source']
  if (!releasedIsRecord(source) || source['kind'] !== 'plugin' || source['plugin'] !== 'compact'
    || Object.hasOwn(source, 'compactionId')) return event
  return {
    ...event,
    data: {
      ...data,
      source: {
        ...source,
        compactionId,
      },
    },
  }
}

function addLegacyCompactionId(
  event: SessionFormatEvent,
  compactionId: string,
): SessionFormatEvent {
  const data = releasedV0Record(event.data, `${event.type} ${event.seq} data`)
  if (Object.hasOwn(data, 'compactionId')) return event
  return { ...event, data: { ...data, compactionId } }
}

function normalizeLegacyRequestHeader(event: SessionFormatEvent, sessionId: string): SessionFormatEvent {
  if (event.type !== 'request/header') return event
  const data = releasedV0Record(event.data, `request/header ${event.seq} data`)
  const header = releasedV0Record(data['header'], `request/header ${event.seq} header`)
  const reason = legacyRequestHeaderReason(data['reason'])
  const hasMessagePrefix = Object.hasOwn(header, 'messagePrefix')
  if (!hasMessagePrefix && reason === undefined) return event
  let currentHeader = header
  if (hasMessagePrefix) {
    if (!Array.isArray(header['messagePrefix'])) {
      throw new SessionFormatError(
        `session ${JSON.stringify(sessionId)} contains malformed request/header messagePrefix at seq ${event.seq}`,
      )
    }
    const { messagePrefix: _messagePrefix, ...rest } = header
    currentHeader = rest
  }
  return {
    ...event,
    data: {
      ...data,
      header: currentHeader,
      ...reason === undefined ? {} : { reason },
    },
  }
}

/**
 * Map the fork's retired request/header reason vocabulary to the current union.
 * @param reason - released-v0 reason value.
 * @returns the current reason when the retired value is recognized, else `undefined`.
 */
function legacyRequestHeaderReason(reason: SessionFormatJsonValue | undefined): string | undefined {
  return reason === 'custom' ? 'change' : undefined
}

function assertSupportedLegacyType(event: SessionFormatEvent, sessionId: string): void {
  if (event.type === 'request/header-delta' || event.type === 'mode/set') {
    throw new SessionFormatUnsupportedMigrationError(
      `session ${JSON.stringify(sessionId)} contains unsupported legacy ${event.type} event at seq ${event.seq}`,
    )
  }
  if (event.type === 'request/header') {
    const data = releasedV0Record(event.data, `request/header ${event.seq} data`)
    if (data['reason'] === 'fallback') {
      throw new SessionFormatUnsupportedMigrationError(
        `session ${JSON.stringify(sessionId)} contains unsupported request/header reason "fallback" at seq ${event.seq}`,
      )
    }
  }
}

function normalizeLegacySteering(event: SessionFormatEvent, sessionId: string): SessionFormatEvent {
  if (event.type !== 'steering/message') return event
  const data = releasedV0Record(event.data, `steering/message ${event.seq} data`)
  const wrapped = data['message']
  if (wrapped !== undefined) {
    assertReleasedV0Keys(data, ['turn', 'message'], [], `steering/message ${event.seq} data`)
    sessionFormatCount(data['turn'], `steering/message ${event.seq} turn`)
    return { ...event, type: 'user/message', data: wrapped }
  }
  assertReleasedV0Keys(data, ['turn', 'content', 'source'], [], `steering/message ${event.seq} data`)
  sessionFormatCount(data['turn'], `steering/message ${event.seq} turn`)
  const { turn: _turn, ...message } = data
  return {
    ...event,
    type: 'user/message',
    data: {
      ...message,
      id: legacyMessageId(sessionId, event.seq),
      role: 'user',
    },
  }
}

function normalizeLegacyTurnStart(event: SessionFormatEvent, sessionId: string): SessionFormatEvent {
  if (event.type !== 'turn/start') return event
  const data = releasedV0Record(event.data, `turn/start ${event.seq} data`)
  if (!Object.hasOwn(data, 'trigger')) return event
  assertReleasedV0Keys(data, ['turn', 'trigger'], [], `turn/start ${event.seq} data`)
  const turn = sessionFormatCount(data['turn'], `turn/start ${event.seq} turn`)
  const trigger = releasedV0Record(data['trigger'], `turn/start ${event.seq} trigger`)
  if (turn < 1 || typeof trigger['kind'] !== 'string' || trigger['kind'].length === 0) {
    throw malformedLegacy(sessionId, 'turn/start', event.seq)
  }
  return { ...event, data: { turn } }
}

function normalizeLegacyTurnEnd(event: SessionFormatEvent, sessionId: string): SessionFormatEvent {
  if (event.type !== 'turn/end') return event
  const data = releasedV0Record(event.data, `turn/end ${event.seq} data`)
  assertReleasedV0Keys(data, ['turn', 'reason'], [], `turn/end ${event.seq} data`)
  const turn = sessionFormatCount(data['turn'], `turn/end ${event.seq} turn`)
  if (turn < 1) throw malformedLegacy(sessionId, 'turn/end', event.seq)
  const reason = releasedV0Record(data['reason'], `turn/end ${event.seq} reason`)
  if (typeof reason['kind'] !== 'string') throw malformedLegacy(sessionId, 'turn/end', event.seq)

  let current: SessionFormatJsonObject
  switch (reason['kind']) {
    case 'completed':
    case 'blocked':
    case 'max-tokens':
    case 'interrupted':
      assertReleasedV0Keys(reason, ['kind'], [], `turn/end ${event.seq} reason`)
      return event
    case 'aborted':
      if (Object.hasOwn(reason, 'reason')) return event
      assertReleasedV0Keys(reason, ['kind'], [], `turn/end ${event.seq} reason`)
      current = { kind: 'aborted', reason: { kind: 'legacy' } }
      break
    case 'disposed':
      assertReleasedV0Keys(reason, ['kind'], [], `turn/end ${event.seq} reason`)
      current = { kind: 'aborted', reason: { kind: 'disposed' } }
      break
    case 'error':
      if (Object.hasOwn(reason, 'error')) return event
      current = normalizeLegacyErrorReason(reason, event.seq, sessionId)
      break
    default:
      return event
  }
  return { ...event, data: { ...data, reason: current } }
}

function normalizeLegacyErrorReason(
  reason: Record<string, SessionFormatJsonValue>,
  seq: number,
  sessionId: string,
): SessionFormatJsonObject {
  sessionFormatCount(reason['step'], `turn/end ${seq} error step`)
  const failure = reason['failure']
  if (failure !== undefined) {
    assertReleasedV0Keys(reason, ['kind', 'step', 'failure'], [], `turn/end ${seq} reason`)
    const record = releasedV0Record(failure, `turn/end ${seq} failure`)
    assertReleasedV0Keys(
      record,
      ['message', 'code'],
      ['status', 'providerRetryAfterMs', 'requestId'],
      `turn/end ${seq} failure`,
    )
    if (typeof record['message'] !== 'string' || typeof record['code'] !== 'string') {
      throw malformedLegacy(sessionId, 'turn/end', seq)
    }
    return { kind: 'error', error: record }
  }
  assertReleasedV0Keys(reason, ['kind', 'step', 'message'], ['code'], `turn/end ${seq} reason`)
  if (typeof reason['message'] !== 'string'
    || (reason['code'] !== undefined && typeof reason['code'] !== 'string')) {
    throw malformedLegacy(sessionId, 'turn/end', seq)
  }
  return {
    kind: 'error',
    error: {
      message: reason['message'],
      code: typeof reason['code'] === 'string' ? reason['code'] : 'UNKNOWN',
    },
  }
}

function normalizeLegacyMessage(
  event: SessionFormatEvent,
  sessionId: string,
  messageIds: ReadonlyMap<number, string>,
): SessionFormatEvent {
  const data = releasedV0Record(event.data, `${event.type} ${event.seq} data`)
  switch (event.type) {
    case 'user/message':
      if (Object.hasOwn(data, 'id') || Object.hasOwn(data, 'role')
        || Object.hasOwn(data, 'message') || !Object.hasOwn(data, 'content')
        || !Object.hasOwn(data, 'source')) return event
      return {
        ...event,
        data: {
          ...data,
          id: legacyMessageId(sessionId, event.seq),
          role: 'user',
        },
      }
    case 'assistant/message': {
      if (Object.hasOwn(data, 'message')
        || !Object.hasOwn(data, 'content') || !Object.hasOwn(data, LEGACY_ASSISTANT_SOURCE_KEY)) return event
      const content = data['content'] as SessionFormatJsonValue
      const eventData = { ...data }
      delete eventData['content']
      const source = releasedV0Record(
        eventData[LEGACY_ASSISTANT_SOURCE_KEY],
        `assistant/message ${event.seq} legacy source`,
      )
      Reflect.deleteProperty(eventData, LEGACY_ASSISTANT_SOURCE_KEY)
      return {
        ...event,
        data: {
          ...eventData,
          message: {
            id: legacyMessageId(sessionId, event.seq),
            role: 'assistant',
            content,
            source: { ...source, kind: 'model' },
          },
        },
      }
    }
    case 'tool/result': {
      if (Object.hasOwn(data, 'message')
        || !Object.hasOwn(data, 'callId') || !Object.hasOwn(data, 'content')
        || !Object.hasOwn(data, 'isError')) return event
      const { callId, content, isError, ...eventData } = data
      if (typeof callId !== 'string' || typeof isError !== 'boolean' || content === undefined) return event
      const inheritedId = replacementStart(event)
      const messageId = inheritedId === undefined
        ? legacyMessageId(sessionId, event.seq)
        : messageIds.get(inheritedId)
      if (messageId === undefined) {
        throw new SessionFormatError(`tool/result ${event.seq} replacement cites a message without identity`)
      }
      return {
        ...event,
        data: {
          ...eventData,
          message: {
            id: messageId,
            role: 'user',
            content: [{ type: 'tool-result', toolCallId: callId, content, isError }],
            source: { kind: 'tool', callId },
          },
        },
      }
    }
    default:
      return event
  }
}

function replacementStart(event: SessionFormatEvent): number | undefined {
  const operation = event['surfaceOp']
  if (operation === undefined || !releasedIsRecord(operation) || operation['op'] !== 'replace') return undefined
  // Source envelope validation admits only non-negative safe replacement endpoints.
  return operation['start'] as number
}

function eventMessageId(event: SessionFormatEvent): string | undefined {
  const data = releasedV0Record(event.data, `${event.type} ${event.seq} data`)
  const message = event.type === 'user/message'
    ? data
    : releasedIsRecord(data['message']) ? data['message'] : undefined
  return typeof message?.['id'] === 'string' ? message['id'] : undefined
}

function releasedIsRecord(value: unknown): value is Record<string, SessionFormatJsonValue> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function legacyMessageId(sessionId: string, seq: number): string {
  return `legacy-message:${sessionId}:${seq}`
}

function malformedLegacy(sessionId: string, type: string, seq: number): SessionFormatError {
  return new SessionFormatError(
    `session ${JSON.stringify(sessionId)} contains malformed pre-react-loop ${type} at seq ${seq}`,
  )
}
