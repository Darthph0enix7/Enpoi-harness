/**
 * Append-only WAL, atomic writes, trash staging, conflict resolution
 * application, crash recovery. Never seals on unexpected error.
 */

import { mkdir, readFile, appendFile, writeFile, rename } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { sha256Of } from './blob-store'
import type { BlobStore } from './blob-store'

export interface WalIntent {
  kind: 'intent'
  sessionId: string
  revertSeq: number
  plan: Record<string, { action: string; targetBlobSha: string | null; expectedDiskSha: string | null }>
  ts: number
}

export interface WalResult {
  kind: 'result'
  sessionId: string
  revertSeq: number
  outcomes: Record<string, { status: string; fromSha?: string | null; toSha?: string | null; dest?: string; reason?: string }>
  ts: number
}

export type WalEntry = WalIntent | WalResult

export type OutcomeMap = Record<string, { status: string; fromSha?: string | null; toSha?: string | null; dest?: string; reason?: string } | { status: string; _error?: string }>

export interface ExecuteOptions {
  sessionId: string
  revertSeq: number
  plan: Map<string, { action: string; targetBlobSha: string | null; expectedDiskSha: string | null }>
  resolvePath: (targetKey: string) => Promise<string>
  readDisk: (targetKey: string) => Promise<Buffer | null>
  writeDisk: (path: string, bytes: Buffer) => Promise<void>
  trashFile: (path: string) => Promise<string>
}

export class RevertExecutor {
  wal: WalEntry[] = []
  private ready: Promise<void>

  constructor(
    private readonly opts: { blobStore: BlobStore; trashRoot: string; walFile: string },
  ) {
    // Serialize init vs writeWal (same race protection as MutationManifest).
    this.ready = this.init()
  }

  private async init(): Promise<void> {
    await mkdir(this.opts.trashRoot, { recursive: true })
    try {
      const raw = await readFile(this.opts.walFile, 'utf8')
      const lines = raw.split('\n')
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]
        if (line.length === 0) continue
        try {
          this.wal.push(JSON.parse(line) as WalEntry)
        } catch {
          // Torn trailing line from a crash mid-append: drop it.
          if (i !== lines.length - 1) throw new Error(`corrupt WAL line ${i + 1}`)
        }
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    }
  }

  /** Append-only WAL write (never full-file rewrite). */
  async writeWal(entry: WalEntry): Promise<void> {
    await this.ready
    this.wal.push(entry)
    await mkdir(dirname(this.opts.walFile), { recursive: true })
    await appendFile(this.opts.walFile, JSON.stringify(entry) + '\n', 'utf8')
  }

  /** Atomic write: temp file in same dir + rename (crash-safe, same-filesystem). */
  async atomicWrite(targetPath: string, bytes: Buffer): Promise<void> {
    const dir = dirname(targetPath)
    await mkdir(dir, { recursive: true })
    const tmp = join(dir, `.fr-tmp-${randomUUID()}`)
    await writeFile(tmp, bytes)
    await rename(tmp, targetPath)
  }

  /** Move a file to the trash staging area; unique dest (uuid) prevents collisions. */
  async trash(targetPath: string, sessionId: string): Promise<string> {
    const destDir = join(this.opts.trashRoot, sessionId, String(Date.now()))
    await mkdir(destDir, { recursive: true })
    const dest = join(destDir, `${randomUUID()}-${targetPath.split('/').pop() ?? 'file'}`)
    await rename(targetPath, dest)
    return dest
  }

  /**
   * Execute a revert plan with WAL protection.
   * On unexpected exception: DO NOT seal — leave the intent unsealed so
   * startup recovery re-runs it (idempotent by hash).
   */
  async execute(opts: ExecuteOptions): Promise<{ outcomes: OutcomeMap; interrupted: boolean; sealed: boolean }> {
    const intent: WalIntent = {
      kind: 'intent',
      sessionId: opts.sessionId,
      revertSeq: opts.revertSeq,
      plan: Object.fromEntries([...opts.plan].map(([key, p]) => [key, { action: p.action, targetBlobSha: p.targetBlobSha, expectedDiskSha: p.expectedDiskSha }])),
      ts: Date.now(),
    }
    await this.writeWal(intent)

    const outcomes: OutcomeMap = {}
    let interrupted = false
    try {
      for (const [targetKey, p] of opts.plan) {
        // Normalize resolution intents (resolve:restore → restore, resolve:keep → noop) so crash
        // recovery replays them through the same execution path.
        let action = p.action.startsWith('resolve:') ? p.action.slice('resolve:'.length) : p.action
        if (action === 'keep') action = 'noop'
        if (action === 'noop') {
          outcomes[targetKey] = { status: 'no_op' }
          continue
        }
        // Beside resolutions cannot be replayed: the timestamped beside path
        // is not recorded in the WAL, and replaying to the ORIGINAL path
        // would clobber the user's version. Escalate explicitly — the
        // conflict card stays actionable (Oracle fix-soon #6).
        if (action === 'recreate') {
          outcomes[targetKey] = { status: 'conflict_escalated', reason: 'beside resolution cannot be replayed after a crash — resolve the conflict again' }
          continue
        }
        if (action === 'prompt' || action === 'skip') {
          outcomes[targetKey] = { status: 'pending_conflict' }
          continue
        }
        // TOCTOU guard: re-check disk right before writing.
        const current = await opts.readDisk(targetKey)
        const currentSha = current === null ? null : sha256Of(current)
        if (currentSha !== p.expectedDiskSha) {
          outcomes[targetKey] = { status: 'conflict_escalated', reason: 'disk changed between evaluation and write' }
          continue
        }
        // Pre-clobber backup (Zero Data Loss): stage current content to blob store
        // before overwriting or trashing so uncommitted user edits are never destroyed.
        // A failed backup destroys the only copy of those edits, so it escalates
        // this file exactly like a missing target blob (Oracle B2); the batch continues.
        if (current !== null) {
          try {
            await this.opts.blobStore.put(current)
          } catch (err) {
            outcomes[targetKey] = { status: 'conflict_escalated', reason: `pre-clobber backup failed: ${String(err)}` }
            continue
          }
        }
        const path = await opts.resolvePath(targetKey)
        if (action === 'restore') {
          let bytes: Buffer | null
          try {
            bytes = await this.opts.blobStore.get(p.targetBlobSha)
          } catch {
            // Blob missing (GC race / manual deletion): degrade per-file, continue batch.
            outcomes[targetKey] = { status: 'conflict_escalated', reason: 'pre-agent blob missing from store' }
            continue
          }
          if (bytes === null) {
            outcomes[targetKey] = { status: 'conflict_escalated', reason: 'pre-agent blob missing from store' }
            continue
          }
          await opts.writeDisk(path, bytes)
          // Post-write verification: re-read and confirm hash == target.
          const verify = await opts.readDisk(targetKey)
          if (verify === null || sha256Of(verify) !== p.targetBlobSha) {
            outcomes[targetKey] = { status: 'conflict_escalated', reason: 'post-write verification failed' }
            continue
          }
          outcomes[targetKey] = { status: 'restored', fromSha: p.expectedDiskSha, toSha: p.targetBlobSha }
        } else if (action === 'trash') {
          const dest = await opts.trashFile(path)
          // fromSha = the pre-trash disk state (expectedDiskSha); toSha = null
          // (the file is gone) — recordOutcomes needs both to keep the
          // mutation chain consistent (a null/null record corrupts it).
          outcomes[targetKey] = { status: 'trashed', dest, fromSha: p.expectedDiskSha, toSha: null }
        }
      }
    } catch (err) {
      // Unexpected error: leave the intent UNSEALED so recovery re-runs it.
      interrupted = true
      outcomes._error = { status: 'error', _error: String(err) }
      return { outcomes, interrupted, sealed: false }
    }

    await this.writeWal({ kind: 'result', sessionId: opts.sessionId, revertSeq: opts.revertSeq, outcomes, ts: Date.now() })
    return { outcomes, interrupted, sealed: true }
  }

  /**
   * Apply a user conflict resolution for one file, with the same WAL + TOCTOU
   * discipline as auto-revert.
   */
  async applyResolution(opts: {
    sessionId: string
    targetKey: string
    resolution: 'keep' | 'restore' | 'recreate' | 'trash'
    targetBlobSha: string | null
    expectedDiskSha: string | null
    /** True when the caller redirected the write to a NEW beside path
     *  (Save Beside): the post-write verification targets the resolved
     *  path and the outcome is `saved_beside`. */
    beside?: boolean
    resolvePath: (targetKey: string) => Promise<string>
    readDisk: (targetKey: string) => Promise<Buffer | null>
    writeDisk: (path: string, bytes: Buffer) => Promise<void>
    trashFile: (path: string) => Promise<string>
  }): Promise<{ status: string; fromSha?: string | null; toSha?: string | null; dest?: string; reason?: string }> {
    // Unique WAL seq per resolution: reusing the batch revertSeq would let a
    // resolution result falsely seal an interrupted batch intent in
    // findUnsealedIntents (Oracle B3).
    const walSeq = -Date.now()
    await this.writeWal({
      kind: 'intent',
      sessionId: opts.sessionId,
      revertSeq: walSeq,
      plan: { [opts.targetKey]: { action: `resolve:${opts.resolution}`, targetBlobSha: opts.targetBlobSha, expectedDiskSha: opts.expectedDiskSha } },
      ts: Date.now(),
    })

    try {
      if (opts.resolution === 'keep') {
        const outcome: { status: string } = { status: 'kept' }
        await this.writeWal({ kind: 'result', sessionId: opts.sessionId, revertSeq: walSeq, outcomes: { [opts.targetKey]: outcome }, ts: Date.now() })
        return outcome
      }

      const current = await opts.readDisk(opts.targetKey)
      const currentSha = current === null ? null : sha256Of(current)
      // Strict TOCTOU (Oracle B1): expectedDiskSha === null means the file was
      // absent at conflict time — if it reappeared with user content, never
      // silently overwrite or trash it.
      if (currentSha !== opts.expectedDiskSha) {
        const outcome = { status: 'conflict_escalated', reason: 'disk changed since the conflict was presented' }
        await this.writeWal({ kind: 'result', sessionId: opts.sessionId, revertSeq: walSeq, outcomes: { [opts.targetKey]: outcome }, ts: Date.now() })
        return outcome
      }

      // Pre-clobber backup (Zero Data Loss): stage current content to blob store
      // before write/trash. In the resolution path the current content is by
      // definition unknown (that is why it is a conflict) — it may be the only
      // copy in existence, so a failed backup MUST escalate, never proceed
      // (Oracle B2).
      if (current !== null) {
        try {
          await this.opts.blobStore.put(current)
        } catch (err) {
          const outcome = { status: 'conflict_escalated', reason: `pre-clobber backup failed: ${String(err)}` }
          await this.writeWal({ kind: 'result', sessionId: opts.sessionId, revertSeq: walSeq, outcomes: { [opts.targetKey]: outcome }, ts: Date.now() })
          return outcome
        }
      }

      const path = await opts.resolvePath(opts.targetKey)
      // A beside write (Save Beside) must verify against the RESOLVED path,
      // never the original key (Oracle G: verifying the original would
      // falsely escalate after a successful beside write).
      const beside = opts.beside === true
      const verifyPath = beside ? path : opts.targetKey
      let outcome: { status: string; fromSha?: string | null; toSha?: string | null; dest?: string; reason?: string }
      if (opts.resolution === 'restore' || opts.resolution === 'recreate') {
        let bytes: Buffer | null
        try {
          bytes = await this.opts.blobStore.get(opts.targetBlobSha)
        } catch {
          outcome = { status: 'conflict_escalated', reason: 'pre-agent blob missing from store' }
          await this.writeWal({ kind: 'result', sessionId: opts.sessionId, revertSeq: walSeq, outcomes: { [opts.targetKey]: outcome }, ts: Date.now() })
          return outcome
        }
        if (bytes === null) {
          outcome = { status: 'conflict_escalated', reason: 'pre-agent blob missing from store' }
          await this.writeWal({ kind: 'result', sessionId: opts.sessionId, revertSeq: walSeq, outcomes: { [opts.targetKey]: outcome }, ts: Date.now() })
          return outcome
        }
        await opts.writeDisk(path, bytes)
        const verify = await opts.readDisk(verifyPath)
        if (verify === null || sha256Of(verify) !== opts.targetBlobSha) {
          outcome = { status: 'conflict_escalated', reason: 'post-write verification failed' }
        } else if (beside) {
          // Save Beside: the user's version stays untouched at the original
          // path; the pre-agent snapshot is written beside it.
          outcome = { status: 'saved_beside', dest: path, toSha: opts.targetBlobSha }
        } else {
          outcome = { status: 'restored', toSha: opts.targetBlobSha }
        }
      } else if (opts.resolution === 'trash') {
        const dest = await opts.trashFile(path)
        // fromSha = the pre-trash disk state (expectedDiskSha); toSha = null.
        outcome = { status: 'trashed', dest, fromSha: opts.expectedDiskSha, toSha: null }
      } else {
        outcome = { status: 'invalid_resolution' }
      }
      await this.writeWal({ kind: 'result', sessionId: opts.sessionId, revertSeq: walSeq, outcomes: { [opts.targetKey]: outcome }, ts: Date.now() })
      return outcome
    } catch (err) {
      const outcome = { status: 'error', reason: String(err) }
      await this.writeWal({ kind: 'result', sessionId: opts.sessionId, revertSeq: walSeq, outcomes: { [opts.targetKey]: outcome }, ts: Date.now() })
      return outcome
    }
  }

  /**
   * Crash recovery: find intents without matching results. Recovery REPLAYS the
   * recorded intent plan verbatim (never re-derives from a grown manifest).
   */
  async findUnsealedIntents(): Promise<WalIntent[]> {
    await this.ready
    const sealed = new Set<number>()
    for (const entry of this.wal) {
      if (entry.kind === 'result') sealed.add(entry.revertSeq)
    }
    return this.wal.filter((e): e is WalIntent => e.kind === 'intent' && !sealed.has(e.revertSeq))
  }

  /** All SHAs referenced by WAL intents (for reachability GC). */
  liveShas(): Set<string> {
    const shas = new Set<string>()
    for (const entry of this.wal) {
      if (entry.kind !== 'intent') continue
      for (const p of Object.values(entry.plan ?? {})) {
        if (p.targetBlobSha !== null && p.targetBlobSha !== undefined) shas.add(p.targetBlobSha)
      }
    }
    return shas
  }
}