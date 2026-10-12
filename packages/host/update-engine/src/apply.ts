/**
 * Staged apply (§2.3): seeds a staging directory from the current tree by
 * hardlinks, executes the plan against staging with copy-on-write semantics
 * (temp file + rename after unlinking the target, so no write can mutate the
 * running tree through a shared inode), keeps deletions last, writes an
 * interruption journal after every action, and verifies the result with the
 * qualified contract from `verify.ts`.
 *
 * Merge outputs and sidecar contents are recomputed from the tree roots and
 * checked against the hashes recorded in the plan before any write; a runtime
 * code conflict aborts before staging is touched and writes `.new-<version>`
 * sidecars next to the conflicted live files for inspection.
 */

import { chmod, copyFile, link, lstat, mkdir, readlink, rm, rmdir, symlink, unlink } from 'node:fs/promises'
import { basename, join, relative } from 'node:path'
import { writeBufferAtomic, writeBufferUnlinked, writeSymlinkUnlinked } from './atomic.ts'
import { createBackup } from './backup.ts'
import { hashBytes, hashFile, manifestPaths, readTreeBytes, resolveTreePath, walkTree } from './manifest.ts'
import { merge3 } from './diff3.ts'
import { appendJournalProgress, journalPlanPath, journalProgressPath, readJournalState, removeJournal, writeJournalHead, writeJournalPlan } from './journal.ts'
import type { JournalHead } from './journal.ts'
import { planFingerprint } from './plan.ts'
import { buildUpdateReport } from './report.ts'
import { verifyStagedTree } from './verify.ts'
import { SCAN_INDEX_NAME, writeScanIndex } from './scan-index.ts'
import { defaultParallelism, mapLimit } from './pool.ts'
import type { ScanIndexEntry } from './scan-index.ts'
import type { VerifyOptions } from './verify.ts'
import type {
  ApplyResult,
  Manifest,
  ManifestEntry,
  ApplyStatus,
  BackupResult,
  JournalPhase,
  PlanAction,
  PlanConflict,
  UpdatePlan,
  VerificationResult,
} from './types.ts'

/**
 * Coarse apply progress. Emitted only when {@link ApplyOptions.progress} is
 * provided; the default (no callback) keeps apply behavior byte-identical.
 */
export interface ApplyProgressUpdate {
  /** Pass phase the update describes. */
  phase: 'starting' | 'snapshot' | 'seeding' | 'applying' | 'verifying'
  /**
   * Work units completed in this phase: actions for `applying`, snapshot paths
   * for `snapshot`, seeded entries for `seeding`, and files re-read for
   * `verifying` (0 marks the phase start).
   */
  processed: number
  /** Total for `processed` where known (planned action count otherwise). */
  total: number
  /** Bytes read (snapshot), linked (seeding), or written (applying/verifying). */
  bytesWritten: number
}

/** Options for {@link applyPlan}. */
export interface ApplyOptions {
  /** Plan to execute. */
  plan: UpdatePlan
  /** Current installed tree root (seed source). */
  localRoot: string
  /** Previous version directory (pristine base bytes). */
  baseRoot: string
  /** New release tree (shipped bytes). */
  releaseRoot: string
  /** Staging directory to build. */
  stagingRoot: string
  /**
   * Journal path. Defaults to `<stagingRoot>.journal.json`, outside the staged
   * tree so a staging scan never meets the journal.
   */
  journalPath?: string
  /** ISO timestamp recorded in the journal and backup directory names. */
  timestamp?: string
  /**
   * Deterministic interruption point: stop after this many actions and return
   * `interrupted`, leaving a mid-state journal. Used to exercise resume and
   * crash recovery; production callers omit it.
   */
  stopAfterActions?: number
  /** When set, copy modified and untracked files here before apply (§3.5). */
  backupDir?: string
  /** Opt-in coarse progress callback; nothing is emitted when omitted. */
  progress?: (update: ApplyProgressUpdate) => void
  /**
   * The plan's local manifest (from this run's scan). Lets the staging seed
   * skip its own walk and lets verification carry hashes across hardlink
   * seeds instead of re-reading the tree.
   */
  localManifest?: Manifest
  /** Completion time (epoch ms) of the local scan the manifest came from. */
  localScanCompletedAt?: number
  /** Interval between stage progress ticks, in entries. Default 2000. */
  progressEverySteps?: number
  /** Wall-clock cap between stage progress ticks, in ms. Default 3000. */
  progressEveryMs?: number
  /**
   * Consume/seed the scan index (default true): the staged tree gets a fresh
   * `.dsh-scan-index` on successful verification, before the directory rename.
   */
  useIndex?: boolean
  /**
   * Hardlink primitive override (tests simulate no-hardlink filesystems that
   * force the copy fallback).
   */
  linkFile?: (source: string, destination: string) => Promise<void>
  /**
   * Progress-batch journal cadence in actions (default 2000). The journal is
   * never written per action: phase boundaries + this cadence + T seconds,
   * whichever comes first (see `journalEveryMs`).
   */
  journalEveryActions?: number
  /** Wall-clock journal cadence in ms (default 5000). */
  journalEveryMs?: number
  /**
   * Worker count for the seeding and hash phases. Default: 1 for small trees,
   * a bounded pool above ~20K files; `DSH_WALK_JOBS` overrides.
   */
  parallelism?: number
  /** The local scan's stat identities (avoids a live lstat per verified file). */
  localStats?: Map<string, ScanIndexEntry>
  /**
   * 'applying' callback interval in actions; the final action always reports.
   * Default 200. Ignored without {@link progress}.
   */
  progressEveryActions?: number
  /**
   * 'applying' callback interval in written bytes. Default 64 MiB. Ignored
   * without {@link progress}.
   */
  progressEveryBytes?: number
}

/**
 * Execute a plan against a staging directory.
 * @param options - Plan, tree roots, staging root, journal, and interruption controls.
 * @returns Apply result with the structured report and qualified verification.
 */
export async function applyPlan(options: ApplyOptions): Promise<ApplyResult> {
  const { plan } = options
  const timestamp = options.timestamp ?? new Date().toISOString()
  const journalPath = options.journalPath ?? `${options.stagingRoot}.journal.json`
  const results: ApplyResult['results'] = []
  const completed: string[] = []
  let bytesWritten = 0
  let wroteActions = 0

  const computedFingerprint = planFingerprint(plan)
  if (computedFingerprint !== plan.fingerprint) {
    return makeResult(options, journalPath, false, 'failed', {
      detail: `plan fingerprint mismatch: field=${plan.fingerprint} computed=${computedFingerprint}`,
      results,
    })
  }

  const journalState = await readJournalState(journalPath)
  if (journalState !== null && journalState.head.fingerprint !== plan.fingerprint) {
    return makeResult(options, journalPath, false, 'rollback-required', {
      detail: `staging journal belongs to a different plan (${journalState.head.fingerprint}); discard staging before retrying`,
      results,
    })
  }
  const resumed = journalState !== null && journalState.head.phase !== 'complete'
  // v2 journal: immutable plan written once; the head is rewritten only at
  // phase boundaries and the bounded cadence below (never per action).
  const journalEveryActions = options.journalEveryActions ?? 2000
  const journalEveryMs = options.journalEveryMs ?? 5000
  let journalBatches = journalState?.head.batches ?? 0
  const writeHead = async (phase: JournalPhase, detail: string | null): Promise<void> => {
    const head: JournalHead = {
      schema: 2,
      toVersion: plan.toVersion,
      fingerprint: plan.fingerprint,
      createdAt: timestamp,
      phase,
      detail,
      planFile: basename(journalPlanPath(journalPath)),
      progressFile: basename(journalProgressPath(journalPath)),
      batches: journalBatches,
      completedCount: completed.length,
      updatedAt: new Date().toISOString(),
    }
    await writeJournalHead(journalPath, head)
  }
  if (journalState === null) {
    try {
      await writeJournalPlan(journalPath, plan, timestamp)
      await writeHead('planned', null)
    } catch (error) {
      return makeResult(options, journalPath, false, 'failed', { detail: `journal write failed: ${message(error)}`, results })
    }
  }
  if (journalState !== null && journalState.head.phase === 'aborted') {
    // A matching abort journal means inspection sidecars are already in place.
    return makeResult(options, journalPath, true, 'aborted', {
      detail: journalState.head.detail ?? 'runtime-code merge conflict; current version stays active',
      results,
    })
  }
  if (journalState !== null && journalState.head.phase === 'complete') {
    const stagedStats = options.useIndex === false ? undefined : new Map<string, ScanIndexEntry>()
    const verification = await verifyStagedTree(verifyOptions(options, stagedStats))
    if (verification.ok) {
      if (stagedStats !== undefined && !(await hasScanIndex(options.stagingRoot))) {
        await seedScanIndex(options, stagedStats)
      }
      return makeResult(options, journalPath, false, 'noop', { verification, results })
    }
    return makeResult(options, journalPath, false, 'failed', {
      detail: 'completed staging no longer verifies; staging must be discarded and rebuilt',
      verification,
      results,
    })
  }

  // First line of work: emitted before ANY filesystem walk (the previous
  // order hashed the whole tree inside snapshotHostPaths and the staging seed
  // before this point, which is what left the terminal silent for minutes).
  const progressEverySteps = options.progressEverySteps ?? 2000
  const progressEveryMs = options.progressEveryMs ?? 3000
  let lastStageTickAt = Date.now()
  const stageTick = (phase: ApplyProgressUpdate['phase'], processed: number, total: number, bytes: number, force: boolean): void => {
    if (options.progress === undefined) return
    const now = Date.now()
    if (!force && processed !== total && processed % progressEverySteps !== 0 && now - lastStageTickAt < progressEveryMs) return
    lastStageTickAt = now
    options.progress({ phase, processed, total, bytesWritten: bytes })
  }
  options.progress?.({ phase: 'starting', processed: 0, total: plan.actions.length, bytesWritten: 0 })

  let preflight: Preflight
  try {
    preflight = await preflightPlan(options)
  } catch (error) {
    await writeHead('failed', message(error))
    return makeResult(options, journalPath, resumed, 'failed', { detail: message(error), results })
  }

  if (plan.switchDecision === 'abort') {
    const conflicts = await writeAbortSidecars(plan, options, preflight)
    await writeHead('aborted', 'runtime-code conflict; switch aborted')
    return makeResult(options, journalPath, resumed, 'aborted', {
      conflicts,
      detail: 'runtime-code merge conflict; current version stays active',
      results,
    })
  }

  // Only paths this plan can actually change are guarded: `skip` and
  // `keep-untracked` actions write nothing, and snapshotting them meant
  // hashing the entire live tree (108K files) before the first workspace
  // write — and before any progress line.
  const touched = mutationTouchedPaths(plan)
  const before = await snapshotHostPaths(options.localRoot, touched, (processed, total, bytes) => {
    stageTick('snapshot', processed, total, bytes, processed === total)
  })

  stageTick('seeding', 0, plan.actions.length, 0, true)
  try {
    await seedStaging(options.localRoot, options.stagingRoot, options.localManifest, (processed, total, bytes) => {
      stageTick('seeding', processed, total, bytes, processed === total)
    }, options.linkFile, { resume: resumed, ...(options.parallelism === undefined ? {} : { parallelism: options.parallelism }) })
  } catch (error) {
    await writeHead('failed', `staging seed failed: ${message(error)}`)
    return makeResult(options, journalPath, resumed, 'failed', { detail: `staging seed failed: ${message(error)}`, results })
  }
  // The live tree's index is refreshed at the END of the update by the
  // installer (after staging discard/prune, whose unlink storms bump shared
  // inode ctimes); refreshing here would be invalidated by those steps.
  await writeHead('seeded', null)

  let backup: BackupResult | null = null
  if (options.backupDir !== undefined) {
    try {
      backup = await createBackup({ localRoot: options.localRoot, plan, backupDir: options.backupDir })
    } catch (error) {
      return makeResult(options, journalPath, resumed, 'failed', {
        detail: `backup failed: ${message(error)}`,
        results,
      })
    }
  }

  const context: ApplyContext = { stagingRoot: options.stagingRoot, releaseRoot: options.releaseRoot, preflight }
  let processed = 0
  let lastProgressActions = 0
  let lastProgressBytes = 0
  let batchStart = 0
  let lastJournalAt = Date.now()
  const flushJournalBatch = async (phase: JournalPhase, detail: string | null): Promise<void> => {
    if (processed > batchStart) {
      await appendJournalProgress(journalPath, journalBatches, completed.slice(batchStart, processed))
      journalBatches += 1
      batchStart = processed
    }
    lastJournalAt = Date.now()
    await writeHead(phase, detail)
  }
  for (const action of plan.actions) {
    try {
      const outcome = await executeAction(action, context)
      results.push(outcome.result)
      if (outcome.bytes > 0) {
        bytesWritten += outcome.bytes
        wroteActions++
      }
      completed.push(action.path)
    } catch (error) {
      await flushJournalBatch('failed', message(error))
      return makeResult(options, journalPath, resumed, 'failed', {
        detail: `action failed at ${action.path}: ${message(error)}`,
        bytesWritten,
        wroteActions,
        backup,
        results,
      })
    }
    processed++
    if (options.progress !== undefined
      && (processed === plan.actions.length
        || processed - lastProgressActions >= (options.progressEveryActions ?? 200)
        || bytesWritten - lastProgressBytes >= (options.progressEveryBytes ?? 64 * 1024 * 1024))) {
      lastProgressActions = processed
      lastProgressBytes = bytesWritten
      options.progress({ phase: 'applying', processed, total: plan.actions.length, bytesWritten })
    }
    // Bounded journal cadence: every N actions or T seconds, whichever first.
    if (processed - batchStart >= journalEveryActions || Date.now() - lastJournalAt >= journalEveryMs) {
      await flushJournalBatch('applying', null)
    }
    if (options.stopAfterActions !== undefined && processed >= options.stopAfterActions) {
      await flushJournalBatch('applying', `interrupted after ${processed} actions`)
      const liveTreeIntact = sameSnapshot(before, await snapshotHostPaths(options.localRoot, touched))
      return makeResult(options, journalPath, resumed, 'interrupted', {
        detail: `stopped after ${processed} actions`,
        bytesWritten,
        wroteActions,
        liveTreeIntact,
        backup,
        results,
      })
    }
  }

  await flushJournalBatch('verifying', null)
  options.progress?.({ phase: 'verifying', processed: 0, total: plan.actions.length, bytesWritten })
  const stagedStats = options.useIndex === false ? undefined : new Map<string, ScanIndexEntry>()
  const verification = await verifyStagedTree(verifyOptions(options, stagedStats))
  // Seed the new tree's scan index from the verification walk (AMD-05): it is
  // written into the staging directory before the rename, so the index commits
  // atomically with the tree and an aborted run leaves none.
  if (verification.ok && stagedStats !== undefined) {
    await seedScanIndex(options, stagedStats)
  }
  const liveTreeIntact = sameSnapshot(before, await snapshotHostPaths(options.localRoot, touched))
  const status: ApplyStatus = verification.ok && liveTreeIntact ? 'applied' : 'failed'
  const detail = verification.ok
    ? liveTreeIntact ? null : 'live tree changed during staging pass; rollback required'
    : `${verification.mismatches.length} verification mismatch(es); staging must not be switched`
  await flushJournalBatch(status === 'applied' ? 'complete' : 'failed', detail)
  return makeResult(options, journalPath, resumed, status, {
    detail,
    bytesWritten,
    wroteActions,
    liveTreeIntact,
    verification,
    backup,
    results,
  })
}

/**
 * Discard a staging directory and its journal (rollback before switch).
 * @param stagingRoot - Staging directory to remove.
 * @param journalPath - Journal to remove; omitted skips journal removal.
 */
export async function discardStaging(stagingRoot: string, journalPath?: string): Promise<void> {
  await rm(stagingRoot, { recursive: true, force: true })
  if (journalPath !== undefined) await removeJournal(journalPath)
}

interface ApplyContext {
  stagingRoot: string
  releaseRoot: string
  preflight: Preflight
}

interface Preflight {
  /** Action path → bytes for shipped/merged content writes. */
  content: Map<string, Buffer>
  /** Sidecar path → content and mode. */
  sidecars: Map<string, { content: Buffer; mode: number }>
}

interface ResultExtras {
  detail?: string | null
  bytesWritten?: number
  wroteActions?: number
  liveTreeIntact?: boolean
  indexRefresh?: { entries: number; carried: number; rehashed: number } | null
  verification?: VerificationResult | null
  conflicts?: PlanConflict[]
  backup?: BackupResult | null
  results: ApplyResult['results']
}

function makeResult(options: ApplyOptions, journalPath: string, resumed: boolean, status: ApplyStatus, extras: ResultExtras): ApplyResult {
  const bytesWritten = extras.bytesWritten ?? 0
  const backupDir = extras.backup?.dir ?? null
  const report = buildUpdateReport({
    plan: options.plan,
    status,
    bytesWritten,
    verification: extras.verification ?? null,
    backupDir,
    results: extras.results,
  })
  return {
    status,
    planFingerprint: options.plan.fingerprint,
    journalPath,
    stagingRoot: options.stagingRoot,
    resumed,
    wroteActions: extras.wroteActions ?? 0,
    bytesWritten,
    liveTreeIntact: extras.liveTreeIntact ?? true,
    verification: extras.verification ?? null,
    conflicts: extras.conflicts ?? options.plan.conflicts,
    backupDir,
    report,
    detail: extras.detail ?? null,
    results: extras.results,
  }
}

async function preflightPlan(options: ApplyOptions): Promise<Preflight> {
  const content = new Map<string, Buffer>()
  const sidecars = new Map<string, { content: Buffer; mode: number }>()
  for (const action of options.plan.actions) {
    if (action.kind === 'replace' || action.kind === 'add' || action.kind === 'restore') {
      const shipped = action.shipped
      if (shipped === null || shipped.type !== 'file') continue
      const bytes = await readTreeBytes(options.releaseRoot, action.path)
      if (hashBytes(bytes) !== shipped.sha256) throw new Error(`release tree hash mismatch for ${action.path}`)
      content.set(action.path, bytes)
    } else if (action.kind === 'merge') {
      const bytes = await recomputeMergedBytes(action, options)
      if (hashBytes(bytes) !== action.outcome.sha256) throw new Error(`merge output mismatch for ${action.path}`)
      content.set(action.path, bytes)
    }
    for (const [sidecar, record] of Object.entries(action.outcome.sidecars)) {
      const built = await sidecarContent(action, sidecar, options)
      if (hashBytes(built.content) !== record) throw new Error(`sidecar content mismatch for ${sidecar}`)
      sidecars.set(sidecar, built)
    }
  }
  return { content, sidecars }
}

async function sidecarContent(
  action: PlanAction,
  sidecar: string,
  options: ApplyOptions,
): Promise<{ content: Buffer; mode: number }> {
  if (action.merge?.status === 'conflict' && action.merge.conflicts > 0) {
    return { content: await recomputeMergedBytes(action, options), mode: action.shipped?.mode ?? 0o644 }
  }
  const shipped = action.shipped
  if (shipped === null) throw new Error(`sidecar without shipped entry: ${sidecar}`)
  if (shipped.type === 'symlink') {
    return { content: Buffer.from(`${shipped.target ?? ''}\n`, 'utf8'), mode: 0o644 }
  }
  return { content: await readTreeBytes(options.releaseRoot, action.path), mode: shipped.mode }
}

async function recomputeMergedBytes(action: PlanAction, options: ApplyOptions): Promise<Buffer> {
  const [base, ours, theirs] = await Promise.all([
    readTreeBytes(options.baseRoot, action.path),
    readTreeBytes(options.localRoot, action.path),
    readTreeBytes(options.releaseRoot, action.path),
  ])
  const merged = merge3(base.toString('utf8'), ours.toString('utf8'), theirs.toString('utf8'))
  return Buffer.from(merged.text, 'utf8')
}

async function executeAction(action: PlanAction, context: ApplyContext): Promise<{ result: ApplyResult['results'][number]; bytes: number }> {
  const staged = resolveTreePath(context.stagingRoot, action.path)
  switch (action.kind) {
    case 'skip': {
      // The seed already carries the live bytes (hardlink) and classification
      // proved local == shipped at scan time. Skip must be a NO-OP: zero
      // syscalls, zero reads. Re-hashing every skipped file was the dominant
      // per-action cost at 107K actions, and rewriting a mid-update user edit
      // back to the shipped bytes would clobber it (verification now fails
      // safely instead).
      const shipped = action.shipped
      if (shipped === null) {
        const removed = await removeStagedTarget(staged)
        return { result: { path: action.path, kind: action.kind, status: removed, bytesWritten: 0 }, bytes: 0 }
      }
      return { result: { path: action.path, kind: action.kind, status: 'verified', bytesWritten: 0 }, bytes: 0 }
    }
    case 'replace':
    case 'add':
    case 'restore': {
      const shipped = action.shipped
      if (shipped === null) {
        const removed = await removeStagedTarget(staged)
        return { result: { path: action.path, kind: action.kind, status: removed, bytesWritten: 0 }, bytes: 0 }
      }
      const written = await ensureShipped(action, staged, context)
      return {
        result: { path: action.path, kind: action.kind, status: written === 0 ? 'verified' : 'written', bytesWritten: written },
        bytes: written,
      }
    }
    case 'merge': {
      const bytes = context.preflight.content.get(action.path)
      if (bytes === undefined) throw new Error(`missing preflight merge output for ${action.path}`)
      const written = await writeStagedIfChanged(staged, bytes, action.local?.mode ?? 0o644, action.outcome.sha256)
      return {
        result: { path: action.path, kind: action.kind, status: written === 0 ? 'verified' : 'written', bytesWritten: written },
        bytes: written,
      }
    }
    case 'keep-local':
    case 'keep-untracked':
    case 'pin-skip': {
      await assertStagedMatchesLocal(action, staged)
      return { result: { path: action.path, kind: action.kind, status: 'verified', bytesWritten: 0 }, bytes: 0 }
    }
    case 'keep-local-sidecar': {
      await assertStagedMatchesLocal(action, staged)
      let bytes = 0
      for (const [sidecar, sha256] of Object.entries(action.outcome.sidecars)) {
        const built = context.preflight.sidecars.get(sidecar)
        if (built === undefined) throw new Error(`missing preflight sidecar for ${sidecar}`)
        bytes += await writeStagedIfChanged(resolveTreePath(context.stagingRoot, sidecar), built.content, built.mode, sha256)
      }
      return {
        result: { path: action.path, kind: action.kind, status: bytes === 0 ? 'verified' : 'sidecar', bytesWritten: bytes },
        bytes,
      }
    }
    case 'delete':
    case 'tombstone': {
      const removed = await removeStagedTarget(staged)
      return { result: { path: action.path, kind: action.kind, status: removed, bytesWritten: 0 }, bytes: 0 }
    }
  }
}

async function ensureShipped(action: PlanAction, staged: string, context: ApplyContext): Promise<number> {
  const shipped = action.shipped
  if (shipped === null) throw new Error(`ensureShipped without shipped entry: ${action.path}`)
  if (shipped.type === 'dir') {
    await ensureDirectory(staged, shipped.mode)
    return 0
  }
  if (shipped.type === 'symlink') {
    const existing = await lstat(staged).catch(() => null)
    if (existing?.isSymbolicLink() && await readlink(staged) === shipped.target) return 0
    await writeSymlinkUnlinked(staged, shipped.target ?? '')
    return Buffer.byteLength(shipped.target ?? '')
  }
  const existing = await stagedHash(staged)
  if (existing !== null && existing.sha256 === shipped.sha256 && existing.mode === shipped.mode) return 0
  let bytes = context.preflight.content.get(action.path)
  if (bytes === undefined) bytes = await readTreeBytes(context.releaseRoot, action.path)
  if (hashBytes(bytes) !== shipped.sha256) throw new Error(`release tree hash mismatch for ${action.path}`)
  await writeBufferUnlinked(staged, bytes, shipped.mode)
  return bytes.length
}

async function assertStagedMatchesLocal(action: PlanAction, staged: string): Promise<void> {
  const local = action.local
  if (local === null || local.type === 'dir') return
  const existing = await stagedHash(staged)
  if (existing === null) throw new Error(`staged path missing for preserved local file: ${action.path}`)
  if (existing.sha256 !== action.outcome.sha256) throw new Error(`staged preserved content changed: ${action.path}`)
}

async function ensureDirectory(staged: string, mode: number): Promise<void> {
  const existing = await lstat(staged).catch(() => null)
  if (existing !== null && !existing.isDirectory()) await removeStagedTarget(staged)
  await mkdir(staged, { recursive: true, mode })
  await chmod(staged, mode)
}

async function removeStagedTarget(staged: string): Promise<'absent' | 'retained'> {
  const existing = await lstat(staged).catch(() => null)
  if (existing === null) return 'absent'
  if (existing.isDirectory()) {
    try {
      await rmdir(staged)
      return 'absent'
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOTEMPTY') return 'retained'
      throw error
    }
  }
  await unlink(staged)
  return 'absent'
}

async function writeStagedIfChanged(staged: string, bytes: Buffer, mode: number, expectedSha256: string | null): Promise<number> {
  const existing = await stagedHash(staged)
  if (existing !== null && existing.sha256 === expectedSha256 && existing.mode === mode) return 0
  await writeBufferUnlinked(staged, bytes, mode)
  return bytes.length
}

interface StagedHash {
  sha256: string | null
  mode: number
}

async function stagedHash(staged: string): Promise<StagedHash | null> {
  const stats = await lstat(staged).catch(() => null)
  if (stats === null) return null
  if (stats.isSymbolicLink()) return { sha256: hashBytes(await readlink(staged)), mode: stats.mode & 0o7777 }
  if (stats.isFile()) return { sha256: (await hashFile(staged)).sha256, mode: stats.mode & 0o7777 }
  return { sha256: null, mode: stats.mode & 0o7777 }
}

async function seedStaging(
  localRoot: string,
  stagingRoot: string,
  manifest?: Manifest,
  onTick?: (processed: number, total: number, bytes: number) => void,
  linkFile?: (source: string, destination: string) => Promise<void>,
  options: { resume?: boolean; parallelism?: number } = {},
): Promise<void> {
  // The caller's scanned manifest is exact and free; without it an lstat-only
  // walk suffices (seeding only needs kind/mode/target, never content), so
  // this pass never reads file bytes.
  const local = manifest ?? await walkTree(localRoot)
  const existed = await lstat(stagingRoot).catch(() => null)
  await mkdir(stagingRoot, { recursive: true })
  const paths = manifestPaths(local)
  const resume = options.resume === true || existed !== null
  let processed = 0
  let bytes = 0
  const tick = (entrySize: number): void => {
    processed += 1
    bytes += entrySize
    onTick?.(processed, paths.length, bytes)
  }
  // Directories first: every parent exists before any file lands, so the file
  // phase needs no per-path mkdir (the dominant syscall cost at 100K files).
  for (const path of paths) {
    const entry = local[path]
    if (entry === undefined || entry.type !== 'dir') continue
    const destination = resolveTreePath(stagingRoot, path)
    if (resume) {
      const existing = await lstat(destination).catch(() => null)
      if (existing !== null && !existing.isDirectory()) await removeStagedTarget(destination)
    }
    await mkdir(destination, { recursive: true })
    await chmod(destination, entry.mode)
  }
  for (const path of paths) {
    const entry = local[path]
    if (entry === undefined || entry.type !== 'symlink') continue
    const destination = resolveTreePath(stagingRoot, path)
    const existing = await lstat(destination).catch(() => null)
    if (existing?.isSymbolicLink()) {
      if (await readlink(destination) === entry.target) continue
      await rm(destination, { force: true })
    } else if (existing !== null) {
      await removeStagedTarget(destination)
    }
    await symlink(entry.target ?? '', destination)
  }
  const filePaths = paths.filter(path => local[path]?.type === 'file')
  const limit = options.parallelism ?? defaultParallelism(filePaths.length)
  await mapLimit(filePaths, limit, async (path) => {
    const entry = local[path] as ManifestEntry
    const source = resolveTreePath(localRoot, path)
    const destination = resolveTreePath(stagingRoot, path)
    if (resume) {
      const existing = await lstat(destination).catch(() => null)
      if (existing?.isFile()) {
        const sourceStats = await lstat(source)
        if (existing.dev === sourceStats.dev && existing.ino === sourceStats.ino) {
          tick(entry.size)
          return
        }
        await rm(destination, { force: true })
      } else if (existing !== null) {
        await removeStagedTarget(destination)
      }
    }
    try {
      await (linkFile ?? link)(source, destination)
    } catch (error) {
      // No-hardlink filesystems (FAT/exFAT targets, restricted mounts) fall
      // back to a copy (AMD-06); verify then hashes instead of trusting the
      // inode.
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOTSUP' && code !== 'EOPNOTSUPP' && code !== 'EACCES' && code !== 'EPERM' && code !== 'EXDEV' && code !== 'EMLINK') throw error
      await copyFile(source, destination)
      await chmod(destination, entry.mode)
    }
    tick(entry.size)
  })
  // Completion tick with the full manifest count (dirs/symlinks included) so
  // the progress writer can close the phase (start + completion are permanent
  // lines; in-flight ticks rewrite).
  onTick?.(paths.length, paths.length, bytes)
}

/**
 * Paths an apply pass can actually mutate in the live tree. `skip` and
 * `keep-untracked` write nothing (the staged file keeps the live inode), so
 * they are excluded from the integrity snapshot — snapshotting every planned
 * path was a full-tree hash before the first progress line.
 * @param plan - Plan to derive the guarded set from.
 * @returns Deduplicated, order-preserving mutated paths.
 */
export function mutationTouchedPaths(plan: UpdatePlan): string[] {
  const paths: string[] = []
  const seen = new Set<string>()
  for (const action of plan.actions) {
    if (action.kind === 'skip' || action.kind === 'keep-untracked') continue
    if (seen.has(action.path)) continue
    seen.add(action.path)
    paths.push(action.path)
  }
  return paths
}

/** Verification options carrying the local scan for hardlink hash reuse. */
function verifyOptions(options: ApplyOptions, collectStats?: Map<string, ScanIndexEntry>): VerifyOptions {
  return {
    plan: options.plan,
    stagingRoot: options.stagingRoot,
    ...(collectStats === undefined ? {} : { collectStats }),
    localRoot: options.localRoot,
    ...(options.localManifest === undefined ? {} : { localManifest: options.localManifest }),
    ...(options.localScanCompletedAt === undefined ? {} : { localScanCompletedAt: options.localScanCompletedAt }),
    ...(options.localStats === undefined ? {} : { localStats: options.localStats }),
    ...(options.progress === undefined ? {} : {
      onProgress: (progress) => {
        options.progress?.({ phase: 'verifying', processed: progress.filesHashed, total: options.plan.actions.length, bytesWritten: progress.bytesHashed })
      },
    }),
  }
}

async function hasScanIndex(root: string): Promise<boolean> {
  return await lstat(join(root, SCAN_INDEX_NAME)).then(() => true).catch(() => false)
}

/** Best-effort index seed: an optional optimization must never fail an apply. */
async function seedScanIndex(options: ApplyOptions, stats: Map<string, ScanIndexEntry>): Promise<void> {
  try {
    await writeScanIndex(options.stagingRoot, stats)
  } catch (error) {
    options.progress?.({ phase: 'verifying', processed: 0, total: options.plan.actions.length, bytesWritten: 0 })
    void error
  }
}

/** Snapshot the live tree state of touched paths to prove no in-place write occurred. */
async function snapshotHostPaths(
  root: string,
  paths: readonly string[],
  onTick?: (processed: number, total: number, bytes: number) => void,
): Promise<Map<string, string>> {
  const snapshot = new Map<string, string>()
  let processed = 0
  let bytes = 0
  for (const path of paths) {
    const absolute = resolveTreePath(root, path)
    const stats = await lstat(absolute).catch(() => null)
    if (stats === null) {
      snapshot.set(path, 'absent')
    } else if (stats.isFile()) {
      const hashed = await hashFile(absolute)
      bytes += hashed.size
      snapshot.set(path, `file:${stats.ino}:${stats.mode & 0o7777}:${hashed.sha256}`)
    } else if (stats.isSymbolicLink()) {
      snapshot.set(path, `symlink:${stats.ino}:${await readlink(absolute)}`)
    } else {
      snapshot.set(path, `dir:${stats.ino}:${stats.mode & 0o7777}`)
    }
    processed += 1
    onTick?.(processed, paths.length, bytes)
  }
  if (paths.length === 0) onTick?.(0, 0, 0)
  return snapshot
}

function sameSnapshot(before: Map<string, string>, after: Map<string, string>): boolean {
  if (before.size !== after.size) return false
  for (const [path, state] of before) {
    if (after.get(path) !== state) return false
  }
  return true
}

async function writeAbortSidecars(plan: UpdatePlan, options: ApplyOptions, preflight: Preflight): Promise<PlanConflict[]> {
  const conflicts: PlanConflict[] = []
  for (const conflict of plan.conflicts) {
    let adjusted = conflict
    if (conflict.severity === 'runtime-code' && conflict.sidecar !== null) {
      const built = preflight.sidecars.get(conflict.sidecar)
      if (built !== undefined) {
        const liveTarget = resolveTreePath(options.localRoot, `${conflict.path}.new-${plan.toVersion}`)
        const destination = await uniqueSidecarPath(liveTarget)
        await writeBufferAtomic(destination, built.content, 0o644)
        adjusted = { ...conflict, sidecar: relative(options.localRoot, destination).split('\\').join('/') }
      }
    }
    conflicts.push(adjusted)
  }
  return conflicts
}

async function uniqueSidecarPath(target: string): Promise<string> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const candidate = attempt === 0 ? target : `${target}.${attempt}`
    if (await lstat(candidate).catch(() => null) === null) return candidate
  }
  throw new Error(`cannot find a free sidecar path for ${target}`)
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
