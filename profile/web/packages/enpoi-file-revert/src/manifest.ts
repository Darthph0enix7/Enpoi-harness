/**
 * Append-only FileMutationRecord JSONL store.
 * Tolerates a torn trailing line (crash mid-append). postBlobSha is nullable
 * when postStatus !== 'ok'.
 */

import { mkdir, readFile, appendFile } from 'node:fs/promises'
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const LOG_DIR = join(process.env.HOME ?? '', '.dsh', 'logs')
/** Best-effort diagnostics (never throws; the plugin context has no logger). */
function diag(line: string): void {
  try {
    mkdirSync(LOG_DIR, { recursive: true })
    appendFileSync(join(LOG_DIR, 'enpoi-file-revert.log'), `[${new Date().toISOString()}] ${line}\n`)
  } catch { /* diagnostics never throw */ }
}

export interface FileMutationRecord {
  sessionId: string
  toolSeq: number
  callId: string
  targetKey: string
  displayPath: string
  operation: 'create' | 'update'
  preExisted: boolean
  preStatus: 'ok' | 'too-large' | 'unreadable'
  preBlobSha: string | null
  postStatus: 'ok' | 'too-large' | 'unreadable'
  postBlobSha: string | null
  isInterleaved: boolean
  timestamp: number
  /** Who authored this disk state: 'agent' (edit/write tool), 'user-kept'
   *  (operator chose Keep My Version), or 'plugin-revert' (the plugin's own
   *  restore/trash/recreate write). Plugin-revert records keep the mutation
   *  chain consistent (no false interleaved flags) but are excluded from the
   *  restore-all target — restoring must return to the agent's/user's state,
   *  not the plugin's intermediate write. */
  source?: 'agent' | 'user-kept' | 'plugin-revert'
}

export interface SpanEntry {
  initialPre: FileMutationRecord
  finalPost: FileMutationRecord
  records: FileMutationRecord[]
  sessionCreated?: boolean
}

export class MutationManifest {
  records: FileMutationRecord[] = []
  private ready: Promise<void>

  constructor(private readonly filePath: string) {
    // Serialize init vs append: append awaits ready so a slow init read can
    // never clobber an in-flight append's in-memory push (the ENOENT catch
    // would otherwise wipe records appended before init settled).
    this.ready = this.init()
  }

  private async init(): Promise<void> {
    try {
      const raw = await readFile(this.filePath, 'utf8')
      this.records = []
      const lines = raw.split('\n')
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]
        if (line.length === 0) continue
        try {
          const record = JSON.parse(line) as FileMutationRecord
          // Heal corrupt null/null records (pre-fix trash outcomes wrote
          // pre=null, post=null, which corrupted the chain and flagged every
          // later record interleaved). A null/null record represents no state.
          if (record.preBlobSha === null && record.postBlobSha === null) continue
          this.records.push(record)
        } catch {
          // Torn trailing line from a crash mid-append: drop it.
          // Corruption anywhere else hard-fails.
          if (i !== lines.length - 1) throw new Error(`corrupt manifest line ${i + 1}`)
        }
      }
      // Recompute isInterleaved flags: they were computed against the dropped
      // null records (or pre-recordOutcomes plugin writes), so stale flags
      // would degrade clean targets. The chain itself is the truth: a record
      // is interleaved iff its pre-state differs from the prior record's
      // post-state for the same targetKey.
      const lastPost = new Map<string, string | null>()
      for (const record of this.records) {
        const prior = lastPost.get(record.targetKey)
        record.isInterleaved = prior !== undefined && prior !== record.preBlobSha
        lastPost.set(record.targetKey, record.postBlobSha)
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    }
  }

  async append(record: FileMutationRecord): Promise<FileMutationRecord> {
    await this.ready
    const prior = this.lastFor(record.targetKey)
    if (prior !== undefined && prior.postBlobSha !== record.preBlobSha) {
      record.isInterleaved = true
      diag(`append: interleaved for ${record.targetKey} — prior toolSeq=${prior.toolSeq} post=${String(prior.postBlobSha).slice(0, 10)} vs incoming pre=${String(record.preBlobSha).slice(0, 10)}`)
    }
    this.records.push(record)
    await mkdir(join(this.filePath, '..'), { recursive: true })
    await appendFile(this.filePath, JSON.stringify(record) + '\n', 'utf8')
    return record
  }

  lastFor(targetKey: string): FileMutationRecord | undefined {
    for (let i = this.records.length - 1; i >= 0; i--) {
      if (this.records[i].targetKey === targetKey) return this.records[i]
    }
    return undefined
  }

  inSpan(fromSeq: number): FileMutationRecord[] {
    return this.records.filter(r => r.toolSeq >= fromSeq)
  }

  upTo(seq: number): FileMutationRecord[] {
    return this.records.filter(r => r.toolSeq <= seq)
  }

  isSessionCreated(targetKey: string): boolean {
    const recs = this.records.filter(r => r.targetKey === targetKey)
    if (recs.length === 0) return false
    const earliest = recs.reduce((a, b) => (b.toolSeq < a.toolSeq ? b : a))
    return !earliest.preExisted
  }

  aggregateSpan(fromSeq: number): Map<string, SpanEntry> {
    const span = this.inSpan(fromSeq)
    const byKey = new Map<string, SpanEntry>()
    for (const rec of span) {
      let entry = byKey.get(rec.targetKey)
      if (entry === undefined) {
        entry = {
          initialPre: rec,
          finalPost: rec,
          records: [],
          sessionCreated: this.isSessionCreated(rec.targetKey),
        }
        byKey.set(rec.targetKey, entry)
      }
      entry.records.push(rec)
      if (rec.toolSeq < entry.initialPre.toolSeq) entry.initialPre = rec
    }
    // finalPost must be the LAST AGENT/USER-authored state, never the plugin's
    // own revert write: a trashed plugin record (postBlobSha null) otherwise
    // made the evaluator report "post-agent snapshot unavailable" on a clean
    // restore-all. Plugin records stay in `records` for the known-state scan.
    for (const entry of byKey.values()) {
      const authored = entry.records.filter(r => r.source !== 'plugin-revert')
      const pool = authored.length > 0 ? authored : entry.records
      entry.finalPost = pool.reduce((a, b) => (b.toolSeq > a.toolSeq ? b : a))
    }
    return byKey
  }


  /**
   * Chain-derived interleaving for one record: a record is interleaved iff its
   * pre-state differs from the previous record's post-state for the same key.
   * This recomputes from the chain instead of trusting stored flags — a stale
   * or poisoned `isInterleaved` (e.g. written by an older build during a
   * restart window) must never degrade a clean target into a spurious
   * "Snapshot unavailable" conflict (FR1/FR5 backwards-compat).
   */
  private chainInterleaved(spanRecs: FileMutationRecord[], index: number): boolean {
    if (index <= 0) return false
    const prior = spanRecs[index - 1]
    return prior.postBlobSha !== spanRecs[index].preBlobSha
  }

  /**
   * Resolve the target state for a boundary: latest mutation ≤ seq (post),
   * falling back to the initial pre-state; `null` boundary resolves to the
   * final post-state (restore-all).
   */
  resolveRestoreTarget(targetKey: string, restoreSeq: number | null): {
    preExisted: boolean
    preStatus: string
    preBlobSha: string | null
    postBlobSha: string | null
    isInterleaved: boolean
    sessionCreated: boolean
    /** The source of the record that defines the target state ('agent',
     *  'user-kept', 'plugin-revert', or undefined for legacy records). */
    targetSource?: string
  } {
    const sessionCreated = this.isSessionCreated(targetKey)
    if (restoreSeq === null) {
      // Restore-all: target = final post-state of the whole span, EXCLUDING
      // the plugin's own revert writes (source 'plugin-revert') — restoring
      // must return to the agent's/user's state, not the plugin's
      // intermediate write. A user-kept record IS the user's chosen state and
      // stays the target (restore-all after Keep no-ops).
      const spanRecs = this.records.filter(r => r.targetKey === targetKey)
      if (spanRecs.length === 0) {
        return { preExisted: false, preStatus: 'ok', preBlobSha: null, postBlobSha: null, isInterleaved: false, sessionCreated }
      }
      const earliest = spanRecs.reduce((a, b) => (b.toolSeq < a.toolSeq ? b : a))
      const userRecs = spanRecs.filter(r => r.source !== 'plugin-revert')
      const latest = (userRecs.length > 0 ? userRecs : spanRecs).reduce((a, b) => (b.toolSeq > a.toolSeq ? b : a))
      // The target record (latest non-plugin) and its immediate successor
      // define reliability — a stale interleaved flag elsewhere must not
      // degrade a clean restore-all target.
      const latestIdx = spanRecs.indexOf(latest)
      const successor = spanRecs[latestIdx + 1]
      const targetInterleaved = this.chainInterleaved(spanRecs, latestIdx)
        || (successor !== undefined && this.chainInterleaved(spanRecs, latestIdx + 1))
      return {
        preExisted: earliest.preExisted,
        preStatus: earliest.preStatus,
        preBlobSha: earliest.preBlobSha,
        postBlobSha: latest.postBlobSha,
        isInterleaved: targetInterleaved,
        sessionCreated,
        targetSource: latest.source,
      }
    }
    const recs = this.upTo(restoreSeq).filter(r => r.targetKey === targetKey)
    if (recs.length === 0) {
      const spanRecs = this.records.filter(r => r.targetKey === targetKey)
      if (spanRecs.length === 0) {
        return { preExisted: false, preStatus: 'ok', preBlobSha: null, postBlobSha: null, isInterleaved: false, sessionCreated }
      }
      const earliest = spanRecs.reduce((a, b) => (b.toolSeq < a.toolSeq ? b : a))
      return {
        preExisted: earliest.preExisted,
        preStatus: earliest.preStatus,
        preBlobSha: earliest.preBlobSha,
        postBlobSha: null,
        isInterleaved: false,
        sessionCreated,
      }
    }
    const earliestSpan = this.records.filter(r => r.targetKey === targetKey).reduce((a, b) => (b.toolSeq < a.toolSeq ? b : a))
    const latest = recs.reduce((a, b) => (b.toolSeq > a.toolSeq ? b : a))
    // Interleaving guard: refuse mid-span restore points inside the interleaved
    // region — the TARGET record (whose postBlobSha defines the boundary state)
    // and its immediate successor are unreliable. A stale interleaved flag
    // elsewhere in the chain (e.g. from a pre-recordOutcomes plugin write) must
    // not degrade a clean target.
    const spanAll = this.records
      .filter(r => r.targetKey === targetKey)
      .sort((a, b) => a.toolSeq - b.toolSeq)
    const latestIdx = spanAll.indexOf(latest)
    const successor = spanAll[latestIdx + 1]
    const targetInterleaved = this.chainInterleaved(spanAll, latestIdx)
      || (successor !== undefined && this.chainInterleaved(spanAll, latestIdx + 1))
    return {
      preExisted: earliestSpan.preExisted,
      preStatus: earliestSpan.preStatus,
      preBlobSha: earliestSpan.preBlobSha,
      postBlobSha: latest.postBlobSha,
      isInterleaved: targetInterleaved,
      sessionCreated,
      targetSource: latest.source,
    }
  }

  /** All SHAs referenced by live records (for reachability GC). */
  liveShas(): Set<string> {
    const shas = new Set<string>()
    for (const r of this.records) {
      if (r.preBlobSha !== null) shas.add(r.preBlobSha)
      if (r.postBlobSha !== null) shas.add(r.postBlobSha)
    }
    return shas
  }
}