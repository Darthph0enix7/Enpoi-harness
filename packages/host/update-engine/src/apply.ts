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

import { chmod, link, lstat, mkdir, readlink, rm, rmdir, symlink, unlink } from 'node:fs/promises'
import { dirname, relative } from 'node:path'
import { writeBufferAtomic, writeBufferUnlinked, writeSymlinkUnlinked } from './atomic.ts'
import { createBackup } from './backup.ts'
import { hashBytes, hashFile, manifestPaths, readTreeBytes, resolveTreePath, scanTree } from './manifest.ts'
import { merge3 } from './diff3.ts'
import { journalFor, readJournal, writeJournal } from './journal.ts'
import { planFingerprint } from './plan.ts'
import { buildUpdateReport } from './report.ts'
import { verifyStagedTree } from './verify.ts'
import type {
  ApplyJournal,
  ApplyResult,
  ApplyStatus,
  BackupResult,
  JournalPhase,
  PlanAction,
  PlanConflict,
  UpdatePlan,
  VerificationResult,
} from './types.ts'

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

  let journal: ApplyJournal | null
  try {
    journal = await readJournal(journalPath)
  } catch (error) {
    return makeResult(options, journalPath, false, 'failed', { detail: message(error), results })
  }
  if (journal !== null && journal.fingerprint !== plan.fingerprint) {
    return makeResult(options, journalPath, false, 'rollback-required', {
      detail: `staging journal belongs to a different plan (${journal.fingerprint}); discard staging before retrying`,
      results,
    })
  }
  const resumed = journal !== null && journal.phase !== 'complete'
  if (journal !== null && journal.phase === 'aborted') {
    // A matching abort journal means inspection sidecars are already in place.
    return makeResult(options, journalPath, true, 'aborted', {
      detail: journal.detail ?? 'runtime-code merge conflict; current version stays active',
      results,
    })
  }
  if (journal !== null && journal.phase === 'complete') {
    const verification = await verifyStagedTree({ plan, stagingRoot: options.stagingRoot })
    if (verification.ok) return makeResult(options, journalPath, false, 'noop', { verification, results })
    return makeResult(options, journalPath, false, 'failed', {
      detail: 'completed staging no longer verifies; staging must be discarded and rebuilt',
      verification,
      results,
    })
  }

  let preflight: Preflight
  try {
    preflight = await preflightPlan(options)
  } catch (error) {
    return makeResult(options, journalPath, resumed, 'failed', { detail: message(error), results })
  }

  if (plan.switchDecision === 'abort') {
    const conflicts = await writeAbortSidecars(plan, options, preflight)
    await persist(journalPath, plan, timestamp, 'aborted', completed, 'runtime-code conflict; switch aborted')
    return makeResult(options, journalPath, resumed, 'aborted', {
      conflicts,
      detail: 'runtime-code merge conflict; current version stays active',
      results,
    })
  }

  const touched = [...new Set(plan.actions.map(action => action.path))]
  const before = await snapshotHostPaths(options.localRoot, touched)

  try {
    await seedStaging(options.localRoot, options.stagingRoot)
  } catch (error) {
    return makeResult(options, journalPath, resumed, 'failed', { detail: `staging seed failed: ${message(error)}`, results })
  }
  await persist(journalPath, plan, timestamp, 'seeded', completed, null)

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
      await persist(journalPath, plan, timestamp, 'failed', completed, message(error))
      return makeResult(options, journalPath, resumed, 'failed', {
        detail: `action failed at ${action.path}: ${message(error)}`,
        bytesWritten,
        wroteActions,
        backup,
        results,
      })
    }
    await persist(journalPath, plan, timestamp, 'applying', completed, null)
    processed++
    if (options.stopAfterActions !== undefined && processed >= options.stopAfterActions) {
      await persist(journalPath, plan, timestamp, 'applying', completed, `interrupted after ${processed} actions`)
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

  await persist(journalPath, plan, timestamp, 'verifying', completed, null)
  const verification = await verifyStagedTree({ plan, stagingRoot: options.stagingRoot })
  const liveTreeIntact = sameSnapshot(before, await snapshotHostPaths(options.localRoot, touched))
  const status: ApplyStatus = verification.ok && liveTreeIntact ? 'applied' : 'failed'
  const detail = verification.ok
    ? liveTreeIntact ? null : 'live tree changed during staging pass; rollback required'
    : `${verification.mismatches.length} verification mismatch(es); staging must not be switched`
  await persist(journalPath, plan, timestamp, status === 'applied' ? 'complete' : 'failed', completed, detail)
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
  if (journalPath !== undefined) await rm(journalPath, { force: true })
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
    case 'replace':
    case 'add':
    case 'restore':
    case 'skip': {
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

async function seedStaging(localRoot: string, stagingRoot: string): Promise<void> {
  const local = await scanTree(localRoot)
  await mkdir(stagingRoot, { recursive: true })
  for (const path of manifestPaths(local)) {
    const entry = local[path]
    if (entry === undefined) continue
    const source = resolveTreePath(localRoot, path)
    const destination = resolveTreePath(stagingRoot, path)
    if (entry.type === 'dir') {
      const existing = await lstat(destination).catch(() => null)
      if (existing !== null && !existing.isDirectory()) await removeStagedTarget(destination)
      await mkdir(destination, { recursive: true })
      await chmod(destination, entry.mode)
      continue
    }
    if (entry.type === 'symlink') {
      const existing = await lstat(destination).catch(() => null)
      if (existing?.isSymbolicLink()) {
        if (await readlink(destination) === entry.target) continue
        await rm(destination, { force: true })
      } else if (existing !== null) {
        await removeStagedTarget(destination)
      }
      await mkdir(dirname(destination), { recursive: true })
      await symlink(entry.target ?? '', destination)
      continue
    }
    const existing = await lstat(destination).catch(() => null)
    if (existing?.isFile()) {
      const sourceStats = await lstat(source)
      if (existing.dev === sourceStats.dev && existing.ino === sourceStats.ino) continue
      await rm(destination, { force: true })
    } else if (existing !== null) {
      await removeStagedTarget(destination)
    }
    await mkdir(dirname(destination), { recursive: true })
    await link(source, destination)
  }
}

/** Snapshot the live tree state of touched paths to prove no in-place write occurred. */
async function snapshotHostPaths(root: string, paths: readonly string[]): Promise<Map<string, string>> {
  const snapshot = new Map<string, string>()
  for (const path of paths) {
    const absolute = resolveTreePath(root, path)
    const stats = await lstat(absolute).catch(() => null)
    if (stats === null) {
      snapshot.set(path, 'absent')
      continue
    }
    if (stats.isFile()) {
      const hashed = await hashFile(absolute)
      snapshot.set(path, `file:${stats.ino}:${stats.mode & 0o7777}:${hashed.sha256}`)
    } else if (stats.isSymbolicLink()) {
      snapshot.set(path, `symlink:${stats.ino}:${await readlink(absolute)}`)
    } else {
      snapshot.set(path, `dir:${stats.ino}:${stats.mode & 0o7777}`)
    }
  }
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

async function persist(
  journalPath: string,
  plan: UpdatePlan,
  timestamp: string,
  phase: JournalPhase,
  completed: readonly string[],
  detail: string | null,
): Promise<void> {
  await writeJournal(journalPath, journalFor(plan, timestamp, phase, completed, detail))
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
