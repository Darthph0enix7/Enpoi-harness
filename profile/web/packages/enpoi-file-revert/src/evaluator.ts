/**
 * The 6-state conflict matrix (Doc 44 §4) + revert plan builder.
 * postBlobSha nullability is explicit: null post-state degrades to prompt paths.
 */

import { sha256Of } from './blob-store'
import type { SpanEntry } from './manifest'

export const STATE = {
  CLEAN_RESTORE: 'clean_restore',
  CLEAN_TRASH: 'clean_trash',
  ALREADY_CLEAN: 'already_clean',
  CONFLICT: 'conflict',
  ALREADY_ABSENT: 'already_absent',
  MISSING: 'missing',
  UNAVAILABLE: 'unavailable',
} as const

export type RevertState = typeof STATE[keyof typeof STATE]

export interface EvalResult {
  state: RevertState
  action: 'restore' | 'trash' | 'noop' | 'prompt' | 'skip'
  targetBlobSha: string | null
  expectedDiskSha: string | null
  targetAbsent?: boolean
  reason?: string
}

export interface PlanEntry extends EvalResult {
  entry: SpanEntry
}

export interface TargetState {
  preExisted: boolean
  preStatus: string
  preBlobSha: string | null
  postBlobSha: string | null
}

/**
 * Boundary-based evaluation: the target state is the state AT the revert
 * boundary (initialPre for a new revert, finalPost for restore-all, or the
 * latest mutation ≤ seq for partial restore). Compares current disk against
 * all known mutation states in the span to safely handle intermediate states
 * left by composing reverts or multi-turn edits.
 */
export function evaluateBoundary(
  entry: SpanEntry,
  target: TargetState,
  currentSha: string | null,
): EvalResult {
  const { initialPre, finalPost } = entry
  const postSha = finalPost.postBlobSha
  const targetSha = target.postBlobSha ?? target.preBlobSha
  const targetAbsent = target.postBlobSha === null && target.preBlobSha === null

  // Case 6: pre-state unavailable (too-large / unreadable) -> never auto-revert.
  if (initialPre.preExisted && initialPre.preStatus !== 'ok') {
    return {
      state: STATE.UNAVAILABLE,
      action: 'skip',
      targetBlobSha: null,
      expectedDiskSha: currentSha,
      targetAbsent,
      reason: `pre-agent snapshot unavailable (${initialPre.preStatus})`,
    }
  }

  // Post-state capture failed: we cannot verify the agent's final state.
  if (finalPost.postStatus !== 'ok' || postSha === null) {
    return {
      state: STATE.UNAVAILABLE,
      action: 'skip',
      targetBlobSha: targetSha,
      expectedDiskSha: currentSha,
      targetAbsent,
      reason: `post-agent snapshot unavailable (${finalPost.postStatus})`,
    }
  }

  if (currentSha === null) {
    // Disk absent.
    if (targetAbsent) {
      return { state: STATE.ALREADY_ABSENT, action: 'noop', targetBlobSha: null, expectedDiskSha: null, targetAbsent: true }
    }
    // If the file was created in this session, absence is its initial pre-state.
    // Restoring to a state where the file exists (targetSha) from an absent disk
    // is a clean recreation / restore (cannot clobber user content).
    const isSessionCreated = entry.sessionCreated ?? !initialPre.preExisted
    if (isSessionCreated) {
      return {
        state: STATE.CLEAN_RESTORE,
        action: 'restore',
        targetBlobSha: targetSha,
        expectedDiskSha: null,
        targetAbsent: false,
      }
    }
    // Pre-existing file that unexpectedly vanished from disk -> prompt MISSING.
    return {
      state: STATE.MISSING,
      action: 'prompt',
      targetBlobSha: targetSha,
      expectedDiskSha: null,
      targetAbsent: false,
      reason: 'file is missing on disk but the revert boundary expects it to exist',
    }
  }

  if (currentSha === targetSha) {
    // Disk already at the boundary state -> no-op.
    return { state: STATE.ALREADY_CLEAN, action: 'noop', targetBlobSha: null, expectedDiskSha: currentSha, targetAbsent }
  }

  // Span-wide known-state scan (Oracle R4 + R2):
  // Disk content is safe to transition if it matches ANY agent-authored post-state
  // in the span, or ANY non-interleaved pre-state in the span.
  // Interleaved pre-states are excluded (R2) because they could be user-authored.
  // user-kept records are excluded from BOTH checks: the kept state is the
  // operator's chosen version — a later revert over it must prompt (conflict),
  // never auto-restore over the user's manual edits.
  const isKnownSpanState =
    entry.records.some(r => r.source !== 'user-kept' && r.postBlobSha !== null && r.postBlobSha === currentSha) ||
    entry.records.some(r => r.source !== 'user-kept' && !r.isInterleaved && r.preBlobSha !== null && r.preBlobSha === currentSha)

  if (isKnownSpanState) {
    if (targetAbsent) {
      // Invariant FR2 / Oracle R3: A file is deleted ONLY if it was created in this span.
      // If target.preExisted is true (e.g. pre-existing file with unavailable target), do NOT trash.
      if (target.preExisted) {
        return {
          state: STATE.UNAVAILABLE,
          action: 'skip',
          targetBlobSha: null,
          expectedDiskSha: currentSha,
          targetAbsent: true,
          reason: 'target is absent but file pre-existed before span',
        }
      }
      // Clean trash: report expectedDiskSha as currentSha (Oracle R1) so the
      // executor's TOCTOU guard succeeds from intermediate disk states.
      return {
        state: STATE.CLEAN_TRASH,
        action: 'trash',
        targetBlobSha: null,
        expectedDiskSha: currentSha,
        targetAbsent: true,
      }
    }
    // Clean restore to the boundary target.
    return {
      state: STATE.CLEAN_RESTORE,
      action: 'restore',
      targetBlobSha: targetSha,
      expectedDiskSha: currentSha,
      targetAbsent: false,
    }
  }

  // User edited on top with unknown content -> conflict (zero silent clobber).
  return {
    state: STATE.CONFLICT,
    action: 'prompt',
    targetBlobSha: targetSha,
    expectedDiskSha: currentSha,
    targetAbsent,
    reason: 'current disk content differs from all known agent mutation states in the span',
  }
}

/**
 * Standard span evaluation for full-span reverts.
 * Delegates to evaluateBoundary with initialPre as the target.
 */
export function evaluateFile(entry: SpanEntry, currentDisk: Buffer | null): EvalResult {
  const target: TargetState = {
    preExisted: entry.initialPre.preExisted,
    preStatus: entry.initialPre.preStatus,
    preBlobSha: entry.initialPre.preBlobSha,
    postBlobSha: null,
  }
  const currentSha = currentDisk === null ? null : sha256Of(currentDisk)
  return evaluateBoundary(entry, target, currentSha)
}

export async function buildRevertPlan(
  manifest: { aggregateSpan(fromSeq: number): Map<string, SpanEntry> },
  fromSeq: number,
  readDisk: (targetKey: string) => Promise<Buffer | null>,
): Promise<{ plan: Map<string, PlanEntry>; conflicts: Array<PlanEntry & { displayPath: string }>; clean: Array<PlanEntry & { displayPath: string }> }> {
  const aggregated = manifest.aggregateSpan(fromSeq)
  const plan = new Map<string, PlanEntry>()
  const conflicts: Array<PlanEntry & { displayPath: string }> = []
  const clean: Array<PlanEntry & { displayPath: string }> = []
  for (const [targetKey, entry] of aggregated) {
    const currentDisk = await readDisk(targetKey)
    const evalResult = evaluateFile(entry, currentDisk)
    const planEntry: PlanEntry = { entry, ...evalResult }
    plan.set(targetKey, planEntry)
    if (evalResult.state === STATE.CONFLICT || evalResult.state === STATE.MISSING || evalResult.state === STATE.UNAVAILABLE) {
      conflicts.push({ ...planEntry, displayPath: entry.finalPost.displayPath })
    } else {
      clean.push({ ...planEntry, displayPath: entry.finalPost.displayPath })
    }
  }
  return { plan, conflicts, clean }
}
