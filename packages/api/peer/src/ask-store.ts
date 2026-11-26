/** Owner-private, bounded peer ask journal (separate from Session persistence). */
import { randomUUID } from 'node:crypto'
import { closeSync, constants, fstatSync, mkdirSync, openSync, readSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions/types'
import type { PeerAlias, PeerAskId, PeerAskRecord, PeerRequestId } from './types.ts'

/** Peer-owned journal settings, resolved by the host. */
export interface AskStoreOptions {
  readonly path: string
  readonly maxCount: number
  readonly maxBytes: number
  readonly maxRecordBytes: number
  readonly maxRequestIdLength: number
  readonly instanceId: string
}

/** Keeps the creation device private so a reassigned alias cannot reveal earlier asks. */
export type StoredAsk = PeerAskRecord & { readonly device: string }

/** Synchronous commits keep ask arbitration and publication in the same JS turn. */
export class AskStore {
  private records = new Map<PeerAskId, StoredAsk>()
  /** Whether the journal opened and can serve records; false after a failed open. */
  available = false

  /** @param options - private path, retention bounds, and current host generation. */
  constructor(readonly options: AskStoreOptions) {}

  /** Open and expire records from dead generations before publishing the journal. */
  open(): void {
    const { path, maxBytes, maxCount, instanceId } = this.options
    const entries = new Map<PeerAskId, StoredAsk>()
    let fd: number
    try {
      fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      this.commit(entries)
      this.available = true
      return
    }
    let raw: string
    try {
      const stat = fstatSync(fd)
      if (!stat.isFile() || stat.size > maxBytes || (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)) {
        throw new Error('peer ask journal is not a bounded private regular file')
      }
      const bytes = Buffer.alloc(stat.size + 1)
      let offset = 0
      while (offset < bytes.length) {
        const n = readSync(fd, bytes, offset, bytes.length - offset, null)
        if (n === 0) break
        offset += n
      }
      if (offset !== stat.size) throw new Error('peer ask journal changed during read')
      raw = bytes.toString('utf8', 0, offset)
    } finally {
      closeSync(fd)
    }
    const parsed = object(JSON.parse(raw))
    if (parsed.version !== 1 || !Array.isArray(parsed.asks) || parsed.asks.length > maxCount) throw malformed()
    let changed = false
    const now = Date.now()
    const rawAsks: readonly unknown[] = parsed.asks
    const answeredIds = new Set<string>()
    for (const value of rawAsks) {
      const ask = readAsk(value)
      if (entries.has(ask.askId)) throw malformed()
      if (ask.answeredBy !== undefined) {
        const key = JSON.stringify([ask.alias, ask.device, ask.answeredBy.requestId])
        if (answeredIds.has(key)) throw malformed()
        answeredIds.add(key)
      }
      if (ask.state === 'pending') {
        // No process-local resolver exists yet, including after plugin remount.
        if (ask.instanceId === instanceId) throw malformed()
        entries.set(ask.askId, { ...ask, state: 'expired', settledAt: now, settlementReason: 'host-restarted' })
        changed = true
      } else entries.set(ask.askId, ask)
    }
    if (changed) this.commit(entries)
    else this.records = entries
    this.available = true
  }

  /**
   * Iterate every retained ask record.
   * @returns all retained records in retention order.
   */
  all(): Iterable<StoredAsk> { return this.records.values() }

  /**
   * Read one retained ask record.
   * @param id - stable ask id.
   * @returns the retained record, or undefined when none is retained.
   */
  get(id: PeerAskId): StoredAsk | undefined { return this.records.get(id) }

  /**
   * Persist before replacing the visible record; never evict an open resolver.
   * @param ask - sanitized record to publish.
   */
  set(ask: StoredAsk): void {
    if (!this.available) throw new Error('peer ask journal is unavailable')
    const next = new Map(this.records)
    next.delete(ask.askId)
    next.set(ask.askId, ask)
    this.commit(next, ask.askId)
  }

  private commit(next: Map<PeerAskId, StoredAsk>, protectedId?: PeerAskId): void {
    const { path, maxBytes, maxCount } = this.options
    const entries = [...next.values()].map((ask) => {
      const json = JSON.stringify(ask)
      // Reserve the largest answer receipt before admitting a pending ask.
      // Each UTF-16 unit may take six JSON bytes (e.g. an escaped NUL).
      const reserve = ask.state === 'pending' ? 160 + 6 * this.options.maxRequestIdLength : 0
      return { ask, json, bytes: Buffer.byteLength(json) + reserve }
    })
    const prefix = '{"version":1,"asks":['
    const suffix = ']}\n'
    let bytes = prefix.length + suffix.length + Math.max(0, entries.length - 1)
    for (const entry of entries) bytes += entry.bytes
    for (const entry of entries) {
      const { ask } = entry
      if (next.size <= maxCount && bytes <= maxBytes) break
      if (ask.state === 'pending' || ask.askId === protectedId) continue
      next.delete(ask.askId)
      bytes -= entry.bytes + (next.size > 0 ? 1 : 0)
    }
    if (next.size > maxCount || bytes > maxBytes) throw new Error('peer ask journal capacity exhausted')
    const serialized = prefix + entries.filter(({ ask }) => next.has(ask.askId)).map(({ json }) => json).join(',') + suffix
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    const temp = `${path}.${randomUUID()}.tmp`
    const fd = openSync(temp, 'wx', 0o600)
    try {
      try {
        writeFileSync(fd, serialized, 'utf8')
      } finally {
        closeSync(fd)
      }
      renameSync(temp, path)
    } catch (error) {
      rmSync(temp, { force: true })
      throw error
    }
    this.records = next
  }
}

function malformed(): Error { return new Error('invalid peer ask journal fields') }

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw malformed()
  return value as Record<string, unknown>
}

function text(value: unknown): string {
  if (typeof value !== 'string') throw malformed()
  return value
}

function timestamp(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw malformed()
  return value
}

/**
 * Copy only fields the peer may see under either exposure; bound before serialization.
 * @param value - question list from a live request or the private journal.
 * @param maxUnits - combined field code-unit and item budget.
 * @returns whitelisted question records.
 */
export function copyAskQuestions(value: unknown, maxUnits: number): readonly AskUserQuestionItem[] {
  let remaining = maxUnits
  const budget = (count: number): void => {
    remaining -= count
    if (remaining < 0) throw new Error('peer question exceeds the ask detail limit')
  }
  const field = (value: unknown): string => {
    const result = text(value)
    budget(result.length + 1)
    return result
  }
  if (!Array.isArray(value)) throw malformed()
  budget(value.length)
  const questions: readonly unknown[] = value
  return questions.map((value) => {
    const { id, question, detail, header, multiSelect, options, intent } = object(value)
    const review = intent === undefined ? undefined : object(intent)
    if (review !== undefined && review.kind !== 'plan-review') throw malformed()
    if (options !== undefined && !Array.isArray(options)) throw malformed()
    budget(options?.length ?? 0)
    const rawOptions: readonly unknown[] | undefined = options
    return {
      id: field(id), question: field(question),
      ...(detail === undefined ? {} : { detail: field(detail) }),
      ...(header === undefined ? {} : { header: field(header) }),
      ...(typeof multiSelect === 'boolean' ? { multiSelect } : {}),
      ...(rawOptions === undefined ? {} : { options: rawOptions.map((value) => {
        const { label, description } = object(value)
        return { label: field(label), ...(description === undefined ? {} : { description: field(description) }) }
      }) }),
      ...(review === undefined ? {} : { intent: {
        kind: 'plan-review', approve: field(review.approve),
        ...(review.callId === undefined ? {} : { callId: brandString<ToolCallId>(field(review.callId)) }),
      } as const }),
    }
  })
}

function readAsk(value: unknown): StoredAsk {
  const r = object(value)
  const { state, kind, settlementReason } = r
  if (state !== 'pending' && state !== 'answered' && state !== 'expired' && state !== 'cancelled') throw malformed()
  if (settlementReason !== undefined && settlementReason !== 'host-restarted'
    && settlementReason !== 'local-answer' && settlementReason !== 'local-cancelled') throw malformed()
  const answered = r.answeredBy === undefined ? undefined : object(r.answeredBy)
  if (answered !== undefined && (state !== 'answered' || !/^[a-f0-9]{64}$/u.test(text(answered.payloadHash)))) throw malformed()
  if (state === 'pending' ? r.settledAt !== undefined || settlementReason !== undefined : r.settledAt === undefined) throw malformed()
  if ((state === 'expired' && settlementReason !== 'host-restarted')
    || (state === 'cancelled' && settlementReason !== 'local-cancelled')
    || (state === 'answered' && (answered === undefined ? settlementReason !== 'local-answer' : settlementReason !== undefined))) {
    throw malformed()
  }
  const createdAt = timestamp(r.createdAt)
  const base: Omit<StoredAsk, 'kind'> = {
    askId: brandString<PeerAskId>(text(r.askId)), sessionId: brandString<SessionId>(text(r.sessionId)),
    alias: brandString<PeerAlias>(text(r.alias)), device: text(r.device), instanceId: text(r.instanceId),
    createdAt, since: createdAt, state,
    ...(r.settledAt === undefined ? {} : { settledAt: timestamp(r.settledAt) }),
    ...(settlementReason === undefined ? {} : { settlementReason }),
    ...(answered === undefined ? {} : { answeredBy: {
      requestId: brandString<PeerRequestId>(text(answered.requestId)), payloadHash: text(answered.payloadHash),
    } }),
  }
  if (kind === 'question') return { ...base, kind, questions: copyAskQuestions(r.questions, Infinity) }
  if (kind !== 'approval') throw malformed()
  return { ...base, kind, toolName: text(r.toolName),
    ...(r.callId === undefined ? {} : { callId: text(r.callId) }),
    ...(r.reason === undefined ? {} : { reason: text(r.reason) }),
  }
}
