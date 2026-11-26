/**
 * Bounded, persisted idempotency receipts for `peer.selectModel`.
 *
 * A receipt maps one `(session, requestId)` to the canonical payload hash and
 * the value the host returned, so a caller retry replays the original answer
 * instead of appending a second selection. The document is machine-written
 * (`~/.dsh/peer-receipts.json`, 0600, atomic replacement) and bounded by an
 * LRU order, so an old host restart keeps exactly the receipts that still fit
 * the deployment limit.
 *
 * @module @deepseek-ai/dsh-api-peer/receipts
 */

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { brandString } from '@deepseek-ai/dsh-brand'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {
  PeerAlias,
  PeerCreateRequest,
  PeerInputReceiptKind,
  PeerInputReceiptPhase,
  PeerProfileSummary,
  PeerPromptContentPart,
  PeerRequestId,
  PeerSelectModelValue,
} from './types.ts'
import { canonicalCreateJobTuple } from './job-bindings.ts'
import { PeerConfigError } from './pairings.ts'

/** Default machine-written idempotency receipt document for `peer.selectModel`. */
export const DEFAULT_RECEIPTS_PATH = dshHomePath('peer-receipts.json')

/** Default machine-written write-ahead receipt document for `peer.create` and `peer.prompt`. */
export const DEFAULT_INPUT_RECEIPTS_PATH = dshHomePath('peer-input-receipts.json')

const PRIVATE_MODE = 0o600
const DETERMINISTIC_SESSION_HEX_CHARS = 32

/** One stored receipt: the request hash and the value the host returned. */
export interface PeerReceipt {
  /** Session id and caller request id, joined by {@link receiptKey}. */
  readonly key: string
  /** SHA-256 of the canonical request payload. */
  readonly hash: string
  /** The original successful `peer.selectModel` value. */
  readonly value: PeerSelectModelValue
  /** Epoch milliseconds the receipt was written. */
  readonly at: number
}

/**
 * Join a session id and request id into one receipt key.
 * @param sessionId - target session.
 * @param requestId - caller-minted request identity.
 * @returns the composite key the store persists.
 */
export function receiptKey(sessionId: string, requestId: string): string {
  return `${sessionId}\u0000${requestId}`
}

/**
 * Read-and-replay store for `peer.selectModel`, bounded and restart-safe.
 * Reads are in-memory; every write replaces the document atomically.
 */
export class PeerReceiptStore {
  private readonly entries = new Map<string, PeerReceipt>()
  private readonly unpersisted = new Set<string>()
  private loaded = false
  private writeChain: Promise<void> = Promise.resolve()

  /**
   * @param path - receipt document path; defaults to `~/.dsh/peer-receipts.json`.
   * @param limit - maximum retained receipts; the oldest entry is evicted first.
   */
  constructor(
    readonly path: string = DEFAULT_RECEIPTS_PATH,
    private readonly limit: number = 512,
  ) {}

  /**
   * Read one receipt and mark it most recently used.
   * @param key - composite key from {@link receiptKey}.
   * @returns the stored receipt, or `undefined` when this id was never seen.
   */
  get(key: string): PeerReceipt | undefined {
    this.ensureLoaded()
    const entry = this.entries.get(key)
    if (entry === undefined) return undefined
    this.entries.delete(key)
    this.entries.set(key, entry)
    return entry
  }

  /**
   * Whether a retained receipt has been durably flushed to disk.
   * @param key - composite key from {@link receiptKey}.
   * @returns true when the receipt is present and its atomic disk write succeeded.
   */
  isPersisted(key: string): boolean {
    this.ensureLoaded()
    return this.entries.has(key) && !this.unpersisted.has(key)
  }

  /**
   * Record one successful selection, evicting the least recently used entry
   * beyond the limit, then atomically rewrite the document.
   * @param key - composite key from {@link receiptKey}.
   * @param hash - canonical request payload hash.
   * @param value - the value the host returned for the original call.
   * @returns completion of the atomic rewrite.
   */
  async put(key: string, hash: string, value: PeerSelectModelValue): Promise<void> {
    this.ensureLoaded()
    this.entries.set(key, { key, hash, value, at: Date.now() })
    this.unpersisted.add(key)
    this.evictBeyondLimit()
    const snapshot: readonly PeerReceipt[] = [...this.entries.values()]
    const snapshotKeys = snapshot.map(entry => entry.key)
    const run = async (): Promise<void> => {
      await writeFileAtomic(
        this.path,
        `${JSON.stringify({ version: 1, receipts: snapshot }, undefined, 2)}\n`,
        { mode: PRIVATE_MODE, dirMode: 0o700 },
      )
      for (const writtenKey of snapshotKeys) this.unpersisted.delete(writtenKey)
    }
    const chained = this.writeChain.then(run, run)
    this.writeChain = chained.catch(() => undefined)
    return chained
  }

  private ensureLoaded(): void {
    if (this.loaded) return
    this.loaded = true
    let raw: string
    try {
      raw = readFileSync(this.path, 'utf8')
    } catch (error) {
      // An absent document is a fresh host: no caller has switched a model yet.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      throw new PeerConfigError(`peer receipts ${this.path} must be JSON`)
    }
    let document: { readonly version?: unknown; readonly receipts?: unknown }
    if (typeof parsed === 'object' && parsed !== null) {
      document = parsed
    } else {
      throw new PeerConfigError(`peer receipts ${this.path} must be {version: 1, receipts: [...]}`)
    }
    if (document.version !== 1 || !Array.isArray(document.receipts)) {
      throw new PeerConfigError(`peer receipts ${this.path} must be {version: 1, receipts: [...]}`)
    }
    for (const [index, entry] of document.receipts.entries()) {
      const receipt = readReceipt(entry, `${this.path}#receipts[${index}]`)
      this.entries.set(receipt.key, receipt)
    }
    // A document written by a higher limit keeps its newest entries only.
    this.evictBeyondLimit()
  }

  /** Drop least-recently-used entries until the document fits the limit. */
  private evictBeyondLimit(): void {
    for (const key of this.entries.keys()) {
      if (this.entries.size <= this.limit) break
      this.entries.delete(key)
      this.unpersisted.delete(key)
    }
  }
}

/** Validate one persisted receipt entry; a malformed entry fails host load. */
function readReceipt(value: unknown, subject: string): PeerReceipt {
  if (typeof value !== 'object' || value === null) {
    throw new PeerConfigError(`${subject} must be an object`)
  }
  const record = value as Record<string, unknown>
  const { key, hash, value: stored, at } = record
  if (typeof key !== 'string' || key.length === 0
    || typeof hash !== 'string' || hash.length === 0
    || typeof at !== 'number' || !Number.isSafeInteger(at)) {
    throw new PeerConfigError(`${subject} must carry key, hash, value, and at`)
  }
  if (typeof stored !== 'object' || stored === null) {
    throw new PeerConfigError(`${subject}.value must be an object`)
  }
  const selection = (stored as Record<string, unknown>).selected
  if (typeof selection !== 'object' || selection === null) {
    throw new PeerConfigError(`${subject}.value.selected must be an object`)
  }
  return { key, hash, value: stored as PeerSelectModelValue, at }
}

/** One persisted write-ahead receipt for `peer.create` or `peer.prompt`. */
export interface PeerInputReceipt {
  /** Composite key from {@link inputReceiptKey}. */
  readonly key: string
  readonly kind: PeerInputReceiptKind
  readonly alias: PeerAlias
  readonly requestId: PeerRequestId
  /** SHA-256 of the canonical JSON of semantically relevant request fields; never carries prompt content. */
  readonly payloadHash: string
  /** Fresh boot identity of the host instance that accepted this request. */
  readonly instanceId: string
  readonly sessionId: SessionId
  readonly phase: PeerInputReceiptPhase
  readonly acceptedAt: number
  readonly finalizedAt?: number
  /** Recorded for `kind: 'create'` once finalized. */
  readonly created?: boolean
  /** Attested when a worker create finalized. */
  readonly profile?: PeerProfileSummary
  /** Recorded for `kind: 'prompt'`. */
  readonly queued?: boolean
  /** Recorded for `kind: 'prompt'`. */
  readonly hopCount?: number
}

/** Input fields required to persist a write-ahead `'prepared'` input receipt. */
export interface PreparePeerInputReceipt {
  readonly kind: PeerInputReceiptKind
  readonly alias: PeerAlias
  readonly requestId: PeerRequestId
  readonly payloadHash: string
  readonly instanceId: string
  readonly sessionId: SessionId
  readonly acceptedAt: number
  readonly queued?: boolean
  readonly hopCount?: number
}

/** Input fields required to finalize a persisted input receipt after the side effect succeeds. */
export interface FinalizePeerInputReceipt {
  readonly kind: PeerInputReceiptKind
  readonly alias: PeerAlias
  readonly requestId: PeerRequestId
  readonly payloadHash: string
  readonly instanceId: string
  readonly sessionId: SessionId
  readonly finalizedAt: number
  readonly created?: boolean
  readonly profile?: PeerProfileSummary
  readonly queued?: boolean
  readonly hopCount?: number
}

/**
 * Join kind, pairing alias, and caller request id into one receipt store key.
 * @param kind - `'create'` or `'prompt'`.
 * @param alias - resolved pairing alias.
 * @param requestId - caller-minted request identity.
 * @returns the composite key persisted in `peer-input-receipts.json`.
 */
export function inputReceiptKey(kind: PeerInputReceiptKind, alias: string, requestId: string): string {
  return `${kind}\u0000${alias}\u0000${requestId}`
}

/**
 * Derive a deterministic Session id from `(alias, requestId)` so a `peer.create`
 * retry after a lost reply or crash resolves to the same Session.
 * @param alias - pairing alias owning the created Session.
 * @param requestId - caller-minted request identity.
 * @returns deterministic branded `SessionId` prefixed with `peer-`.
 */
export function deterministicCreateSessionId(alias: string, requestId: string): SessionId {
  const hex = createHash('sha256')
    .update(JSON.stringify([alias, requestId]))
    .digest('hex')
    .slice(0, DETERMINISTIC_SESSION_HEX_CHARS)
  return brandString<SessionId>(`peer-${hex}`)
}

/**
 * Canonical SHA-256 of the semantically relevant `peer.create` request fields.
 * @param alias - resolved pairing alias.
 * @param request - create request payload.
 * @returns lowercase hex SHA-256 digest.
 */
export function createPayloadHash(alias: string, request: PeerCreateRequest): string {
  return createHash('sha256')
    .update(JSON.stringify([
      'create',
      alias,
      request.sessionId ?? null,
      request.workspaceId ?? null,
      request.cwd ?? null,
      request.agentPreset ?? null,
      request.provider ?? null,
      request.model ?? null,
      request.chain ?? null,
      request.reasoningEffort ?? null,
      request.maxTotalTokens ?? null,
      ...(request.job === undefined ? [] : [canonicalCreateJobTuple(request.job)]),
    ]))
    .digest('hex')
}

/**
 * Canonical SHA-256 of a `peer.prompt` target session id and normalized content
 * parts. Never persists the prompt text itself.
 * @param sessionId - resolved target session id.
 * @param content - validated prompt parts.
 * @returns lowercase hex SHA-256 digest.
 */
export function promptPayloadHash(sessionId: string, content: readonly PeerPromptContentPart[]): string {
  return createHash('sha256')
    .update(JSON.stringify([
      'prompt',
      sessionId,
      content.map(part => [part.type, part.text]),
    ]))
    .digest('hex')
}

/**
 * Bounded, restart-safe write-ahead receipt store for `peer.create` and
 * `peer.prompt` (`~/.dsh/peer-input-receipts.json`, 0600, atomic replacement).
 */
export class PeerInputReceiptStore {
  private readonly entries = new Map<string, PeerInputReceipt>()
  private loaded = false
  private available = true
  private openError: Error | undefined
  private writeChain: Promise<void> = Promise.resolve()

  /**
   * @param path - input receipt document path; defaults to `~/.dsh/peer-input-receipts.json`.
   * @param maxCount - maximum retained receipts; oldest entry evicted first.
   * @param maxBytes - maximum serialized UTF-8 document size in bytes; oldest entry evicted first.
   */
  constructor(
    readonly path: string = DEFAULT_INPUT_RECEIPTS_PATH,
    private readonly maxCount: number = 1024,
    private readonly maxBytes: number = 1_048_576,
  ) {}

  /**
   * Attempt to open and validate the receipt document without throwing.
   * Used at host startup so a corrupt or unreadable store withholds the
   * dependent capabilities instead of crashing unrelated surfaces.
   * @returns `{ ok: true }` on success or `{ ok: false, error }` on failure.
   */
  tryOpen(): { readonly ok: true } | { readonly ok: false; readonly error: unknown } {
    try {
      this.ensureLoaded()
      this.available = true
      this.openError = undefined
      return { ok: true }
    } catch (error) {
      this.available = false
      this.openError = error instanceof Error ? error : new Error(String(error))
      return { ok: false, error }
    }
  }

  /**
   * Whether the store opened cleanly at host startup.
   * @returns true when the receipt store can serve and persist receipts.
   */
  isAvailable(): boolean {
    return this.available
  }

  /**
   * Read one receipt by `(kind, alias, requestId)` and promote it in LRU order.
   * @param kind - `'create'` or `'prompt'`.
   * @param alias - pairing alias.
   * @param requestId - caller-minted request identity.
   * @returns the retained receipt, or `undefined` when absent.
   */
  get(kind: PeerInputReceiptKind, alias: string, requestId: string): PeerInputReceipt | undefined {
    this.ensureLoaded()
    const key = inputReceiptKey(kind, alias, requestId)
    const entry = this.entries.get(key)
    if (entry === undefined) return undefined
    this.entries.delete(key)
    this.entries.set(key, entry)
    return entry
  }

  /**
   * Look up one receipt by `(alias, requestId)` with an optional `kind` filter.
   * @param alias - pairing alias.
   * @param requestId - caller-minted request identity.
   * @param kind - optional `'create' | 'prompt'` disambiguator.
   * @returns `{ receipt, ambiguous }` where `ambiguous` is true when both kinds exist and `kind` was omitted.
   */
  find(
    alias: string,
    requestId: string,
    kind?: PeerInputReceiptKind,
  ): { readonly receipt?: PeerInputReceipt; readonly ambiguous: boolean } {
    this.ensureLoaded()
    if (kind !== undefined) {
      const receipt = this.get(kind, alias, requestId)
      return { ...(receipt === undefined ? {} : { receipt }), ambiguous: false }
    }
    const promptEntry = this.entries.get(inputReceiptKey('prompt', alias, requestId))
    const createEntry = this.entries.get(inputReceiptKey('create', alias, requestId))
    if (promptEntry !== undefined && createEntry !== undefined) {
      return { ambiguous: true }
    }
    const matched = promptEntry ?? createEntry
    if (matched === undefined) return { ambiguous: false }
    this.entries.delete(matched.key)
    this.entries.set(matched.key, matched)
    return { receipt: matched, ambiguous: false }
  }

  /**
   * Persist a `'prepared'` write-ahead receipt before executing the side effect.
   * Rolls back in-memory state on byte-limit overflow or disk write failure so
   * no phantom receipt survives a refused call.
   * @param input - write-ahead receipt fields.
   * @returns the persisted `'prepared'` receipt.
   */
  async prepare(input: PreparePeerInputReceipt): Promise<PeerInputReceipt> {
    return this.enqueueWrite(async () => {
      this.ensureLoaded()
      const key = inputReceiptKey(input.kind, input.alias, input.requestId)
      const entry: PeerInputReceipt = {
        key,
        kind: input.kind,
        alias: input.alias,
        requestId: input.requestId,
        payloadHash: input.payloadHash,
        instanceId: input.instanceId,
        sessionId: input.sessionId,
        phase: 'prepared',
        acceptedAt: input.acceptedAt,
        ...(input.queued === undefined ? {} : { queued: input.queued }),
        ...(input.hopCount === undefined ? {} : { hopCount: input.hopCount }),
      }
      const snapshotOrder = [...this.entries.entries()]
      this.entries.delete(key)
      this.entries.set(key, entry)
      try {
        const serialized = this.serializeBounded(key)
        await writeFileAtomic(this.path, serialized, { mode: PRIVATE_MODE, dirMode: 0o700 })
        return entry
      } catch (error) {
        this.restoreEntries(snapshotOrder)
        throw error
      }
    })
  }

  /**
   * Transition an existing `'prepared'` receipt (or insert a reconciled one) to `'finalized'`.
   * Preserves original `acceptedAt` when a `'prepared'` record already exists.
   * @param input - finalization fields after the side effect succeeded.
   * @returns the persisted `'finalized'` receipt.
   */
  async finalize(input: FinalizePeerInputReceipt): Promise<PeerInputReceipt> {
    return this.enqueueWrite(async () => {
      this.ensureLoaded()
      const key = inputReceiptKey(input.kind, input.alias, input.requestId)
      const previous = this.entries.get(key)
      const entry: PeerInputReceipt = {
        key,
        kind: input.kind,
        alias: input.alias,
        requestId: input.requestId,
        payloadHash: input.payloadHash,
        instanceId: input.instanceId,
        sessionId: input.sessionId,
        phase: 'finalized',
        acceptedAt: previous?.acceptedAt ?? input.finalizedAt,
        finalizedAt: input.finalizedAt,
        ...(input.created === undefined ? {} : { created: input.created }),
        ...(input.profile === undefined ? {} : { profile: input.profile }),
        ...(input.queued === undefined ? {} : { queued: input.queued }),
        ...(input.hopCount === undefined ? {} : { hopCount: input.hopCount }),
      }
      const snapshotOrder = [...this.entries.entries()]
      this.entries.delete(key)
      this.entries.set(key, entry)
      try {
        const serialized = this.serializeBounded(key)
        await writeFileAtomic(this.path, serialized, { mode: PRIVATE_MODE, dirMode: 0o700 })
        return entry
      } catch (error) {
        this.restoreEntries(snapshotOrder)
        throw error
      }
    })
  }

  /**
   * Remove a `'prepared'` receipt when the side effect cleanly rejected before
   * creating a Session or queueing a prompt.
   * @param kind - `'create'` or `'prompt'`.
   * @param alias - pairing alias.
   * @param requestId - caller-minted request identity.
   */
  async abortPrepared(kind: PeerInputReceiptKind, alias: string, requestId: string): Promise<void> {
    return this.enqueueWrite(async () => {
      this.ensureLoaded()
      const key = inputReceiptKey(kind, alias, requestId)
      const existing = this.entries.get(key)
      if (existing?.phase !== 'prepared') return
      const snapshotOrder = [...this.entries.entries()]
      this.entries.delete(key)
      try {
        const serialized = this.serializeBounded()
        await writeFileAtomic(this.path, serialized, { mode: PRIVATE_MODE, dirMode: 0o700 })
      } catch (error) {
        this.restoreEntries(snapshotOrder)
        throw error
      }
    })
  }

  private enqueueWrite<T>(task: () => Promise<T>): Promise<T> {
    const run = (): Promise<T> => task()
    const chained = this.writeChain.then(run, run)
    this.writeChain = chained.then(() => undefined, () => undefined)
    return chained
  }

  private ensureLoaded(): void {
    if (this.openError !== undefined) throw this.openError
    if (this.loaded) return
    let raw: string
    try {
      raw = readFileSync(this.path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.loaded = true
        return
      }
      throw error
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      throw new PeerConfigError(`peer input receipts ${this.path} must be JSON`)
    }
    if (typeof parsed !== 'object' || parsed === null) {
      throw new PeerConfigError(`peer input receipts ${this.path} must be {version: 1, receipts: [...]}`)
    }
    const document = parsed as { readonly version?: unknown; readonly receipts?: unknown }
    if (document.version !== 1 || !Array.isArray(document.receipts)) {
      throw new PeerConfigError(`peer input receipts ${this.path} must be {version: 1, receipts: [...]}`)
    }
    for (const [index, entry] of document.receipts.entries()) {
      const receipt = readInputReceipt(entry, `${this.path}#receipts[${index}]`)
      this.entries.set(receipt.key, receipt)
    }
    this.loaded = true
    this.trimToBounds()
  }

  private trimToBounds(protectedKey?: string): string {
    for (const key of this.entries.keys()) {
      if (this.entries.size <= this.maxCount) break
      if (key === protectedKey) continue
      this.entries.delete(key)
    }
    let serialized = encodeInputReceipts([...this.entries.values()])
    while (Buffer.byteLength(serialized, 'utf8') > this.maxBytes) {
      let evictKey: string | undefined
      for (const candidate of this.entries.keys()) {
        if (candidate !== protectedKey) {
          evictKey = candidate
          break
        }
      }
      if (evictKey === undefined) break
      this.entries.delete(evictKey)
      serialized = encodeInputReceipts([...this.entries.values()])
    }
    return serialized
  }

  private serializeBounded(protectedKey?: string): string {
    const serialized = this.trimToBounds(protectedKey)
    if (Buffer.byteLength(serialized, 'utf8') > this.maxBytes) {
      throw new Error(`peer input receipt exceeds maxBytes (${String(this.maxBytes)})`)
    }
    return serialized
  }

  private restoreEntries(snapshotOrder: readonly [string, PeerInputReceipt][]): void {
    this.entries.clear()
    for (const [k, v] of snapshotOrder) this.entries.set(k, v)
  }
}

function encodeInputReceipts(receipts: readonly PeerInputReceipt[]): string {
  return `${JSON.stringify({ version: 1, receipts })}\n`
}

function readInputReceipt(value: unknown, subject: string): PeerInputReceipt {
  if (typeof value !== 'object' || value === null) {
    throw new PeerConfigError(`${subject} must be an object`)
  }
  const r = value as Record<string, unknown>
  const {
    key,
    kind,
    alias,
    requestId,
    payloadHash,
    instanceId,
    sessionId,
    phase,
    acceptedAt,
    finalizedAt,
    created,
    profile,
    queued,
    hopCount,
  } = r
  if (typeof key !== 'string' || key.length === 0
    || (kind !== 'create' && kind !== 'prompt')
    || typeof alias !== 'string' || alias.length === 0
    || typeof requestId !== 'string' || requestId.length === 0
    || typeof payloadHash !== 'string' || payloadHash.length === 0
    || typeof instanceId !== 'string' || instanceId.length === 0
    || typeof sessionId !== 'string' || sessionId.length === 0
    || (phase !== 'prepared' && phase !== 'finalized')
    || typeof acceptedAt !== 'number' || !Number.isSafeInteger(acceptedAt)) {
    throw new PeerConfigError(`${subject} must carry valid input receipt fields`)
  }
  if (finalizedAt !== undefined && (typeof finalizedAt !== 'number' || !Number.isSafeInteger(finalizedAt))) {
    throw new PeerConfigError(`${subject}.finalizedAt must be a safe integer`)
  }
  if (created !== undefined && typeof created !== 'boolean') {
    throw new PeerConfigError(`${subject}.created must be a boolean`)
  }
  const profileFields = readProfileSummary(profile)
  if (profile !== undefined && profileFields === undefined) {
    throw new PeerConfigError(`${subject}.profile must carry hash and presetId`)
  }
  if (queued !== undefined && typeof queued !== 'boolean') {
    throw new PeerConfigError(`${subject}.queued must be a boolean`)
  }
  if (hopCount !== undefined && (typeof hopCount !== 'number' || !Number.isSafeInteger(hopCount))) {
    throw new PeerConfigError(`${subject}.hopCount must be a safe integer`)
  }
  return {
    key,
    kind,
    alias: brandString<PeerAlias>(alias),
    requestId: brandString<PeerRequestId>(requestId),
    payloadHash,
    instanceId,
    sessionId: brandString<SessionId>(sessionId),
    phase,
    acceptedAt,
    ...(finalizedAt === undefined ? {} : { finalizedAt }),
    ...(created === undefined ? {} : { created }),
    ...(profileFields === undefined ? {} : { profile: profileFields }),
    ...(queued === undefined ? {} : { queued }),
    ...(hopCount === undefined ? {} : { hopCount }),
  }
}

function readProfileSummary(value: unknown): PeerProfileSummary | undefined {
  if (typeof value !== 'object' || value === null || !('hash' in value) || !('presetId' in value)
    || typeof value.hash !== 'string' || typeof value.presetId !== 'string') return undefined
  return { hash: value.hash, presetId: value.presetId }
}
