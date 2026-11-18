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

import { readFileSync } from 'node:fs'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import type { PeerSelectModelValue } from './types.ts'
import { PeerConfigError } from './pairings.ts'

/** Default machine-written idempotency receipt document. */
export const DEFAULT_RECEIPTS_PATH = dshHomePath('peer-receipts.json')

const PRIVATE_MODE = 0o600

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
    this.evictBeyondLimit()
    const snapshot: readonly PeerReceipt[] = [...this.entries.values()]
    const run = (): Promise<void> => writeFileAtomic(
      this.path,
      `${JSON.stringify({ version: 1, receipts: snapshot }, undefined, 2)}\n`,
      { mode: PRIVATE_MODE, dirMode: 0o700 },
    )
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
    const document = parsed as { readonly version?: unknown; readonly receipts?: unknown }
    if (typeof document !== 'object' || document === null
      || document.version !== 1 || !Array.isArray(document.receipts)) {
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
