/**
 * Interruption-recovery journal for staged apply (§2.3), schema 2.
 *
 * v1 kept the whole plan plus a growing `completed` list in one document and
 * rewrote it after every action: at 107K actions that is O(n^2) bytes (tens of
 * GB) and hours of serialization. v2 splits the state:
 *
 * - `<journal>.plan.json` — immutable plan document, written once at start;
 * - `<journal>.progress.ndjson` — append-only batches of completed paths
 *   (bounded lines), written on a bounded cadence (every N actions / T
 *   seconds) and at terminal states;
 * - `<journal>` (the path the caller already knows) — a tiny head document
 *   rewritten atomically at phase boundaries: schema, fingerprint, phase,
 *   counters, and the two file names.
 *
 * Resume reads the head, the plan, and the progress batches; the completed
 * list is an observability/resume optimization, never a correctness input
 * (re-seeding and re-executing actions are idempotent). A legacy v1 journal
 * (schema 1 in the head path) fails open to a fresh apply.
 */

import { appendFile, readFile, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { writeBufferAtomic } from './atomic.ts'
import type { ApplyJournal, JournalPhase, UpdatePlan } from './types.ts'

/** Current journal head schema. */
export const JOURNAL_SCHEMA = 2

/** Immutable plan document schema. */
export const JOURNAL_PLAN_SCHEMA = 'dsh-apply-plan/1'

/** Append-only progress batch schema. */
export const JOURNAL_PROGRESS_SCHEMA = 'dsh-apply-progress/1'

/** The tiny head document stored at the caller's journal path. */
export interface JournalHead {
  /** Head schema (2). */
  schema: 2
  /** Target version. */
  toVersion: string
  /** Plan fingerprint binding this staging directory to exactly one plan. */
  fingerprint: string
  /** ISO timestamp supplied by the caller. */
  createdAt: string
  /** Last completed phase. */
  phase: JournalPhase
  /** Optional status detail. */
  detail: string | null
  /** Basename of the immutable plan document (same directory). */
  planFile: string
  /** Basename of the append-only progress log (same directory). */
  progressFile: string
  /** Progress batches appended so far. */
  batches: number
  /** Completed path count (observability). */
  completedCount: number
  /** ISO timestamp of the last head write. */
  updatedAt: string
}

/** Resolved journal state for resume. */
export interface JournalState {
  /** Head document. */
  head: JournalHead
  /** The immutable plan the staging directory belongs to. */
  plan: UpdatePlan
  /** Completed paths from the progress batches (optimization only). */
  completed: string[]
}

/** Path of the immutable plan document for a journal path. */
export function journalPlanPath(journalPath: string): string {
  return `${journalPath}.plan.json`
}

/** Path of the append-only progress log for a journal path. */
export function journalProgressPath(journalPath: string): string {
  return `${journalPath}.progress.ndjson`
}

/**
 * Write the immutable plan document (once per apply).
 * @param journalPath - Head journal path.
 * @param plan - Plan the staging directory belongs to.
 * @param createdAt - Caller-provided ISO timestamp.
 */
export async function writeJournalPlan(journalPath: string, plan: UpdatePlan, createdAt: string): Promise<void> {
  const doc = { schema: JOURNAL_PLAN_SCHEMA, createdAt, plan }
  await writeBufferAtomic(journalPlanPath(journalPath), Buffer.from(`${JSON.stringify(doc)}\n`, 'utf8'), 0o644)
}

/**
 * Append one bounded progress batch of completed paths.
 * @param journalPath - Head journal path.
 * @param batch - Batch index.
 * @param paths - Completed paths in this batch.
 */
export async function appendJournalProgress(journalPath: string, batch: number, paths: readonly string[]): Promise<void> {
  if (paths.length === 0) return
  const line = JSON.stringify({ schema: JOURNAL_PROGRESS_SCHEMA, batch, count: paths.length, paths })
  await appendFile(journalProgressPath(journalPath), `${line}\n`, 'utf8')
}

/**
 * Write the head document atomically.
 * @param journalPath - Head journal path.
 * @param head - Head document.
 */
export async function writeJournalHead(journalPath: string, head: JournalHead): Promise<void> {
  await writeBufferAtomic(journalPath, Buffer.from(`${JSON.stringify(head)}\n`, 'utf8'), 0o644)
}

/**
 * Read and validate the journal state for resume. Returns null when absent,
 * legacy (v1), corrupt, or partially written — the caller then starts a fresh
 * (idempotent) apply. Never throws.
 * @param journalPath - Head journal path.
 * @returns Journal state or null.
 */
export async function readJournalState(journalPath: string): Promise<JournalState | null> {
  try {
    const headText = await readFile(journalPath, 'utf8')
    const headRaw: unknown = JSON.parse(headText)
    if (typeof headRaw !== 'object' || headRaw === null) return null
    const head = headRaw as Partial<JournalHead>
    if (head.schema !== JOURNAL_SCHEMA || typeof head.fingerprint !== 'string') return null
    if (typeof head.planFile !== 'string' || typeof head.progressFile !== 'string') return null
    if (head.planFile.includes('/') || head.progressFile.includes('/')) return null
    const directory = dirname(journalPath)
    const planRaw: unknown = JSON.parse(await readFile(join(directory, head.planFile), 'utf8'))
    if (typeof planRaw !== 'object' || planRaw === null) return null
    const planDoc = planRaw as { schema?: unknown; plan?: unknown }
    if (planDoc.schema !== JOURNAL_PLAN_SCHEMA || typeof planDoc.plan !== 'object' || planDoc.plan === null) return null
    const completed: string[] = []
    try {
      const progress = await readFile(join(directory, head.progressFile), 'utf8')
      for (const line of progress.split('\n')) {
        if (line === '') continue
        const batchRaw: unknown = JSON.parse(line)
        if (typeof batchRaw !== 'object' || batchRaw === null) return null
        const batch = batchRaw as { schema?: unknown; paths?: unknown }
        if (batch.schema !== JOURNAL_PROGRESS_SCHEMA || !Array.isArray(batch.paths)) return null
        for (const path of batch.paths) {
          if (typeof path !== 'string') return null
          completed.push(path)
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return null
    }
    return { head: head as JournalHead, plan: planDoc.plan as UpdatePlan, completed }
  } catch {
    return null
  }
}

/**
 * Remove the head, plan, and progress documents (discard/rollback).
 * @param journalPath - Head journal path.
 */
export async function removeJournal(journalPath: string): Promise<void> {
  await rm(journalPath, { force: true })
  await rm(journalPlanPath(journalPath), { force: true })
  await rm(journalProgressPath(journalPath), { force: true })
}

// ── legacy v1 document (kept for compatibility tests and fail-open) ─────────

/**
 * Build a v1 journal document (legacy format).
 * @param plan - Plan the staging directory belongs to.
 * @param timestamp - Caller-provided ISO timestamp.
 * @param phase - Phase to record.
 * @param completed - Paths completed so far.
 * @param detail - Optional status detail.
 * @returns Journal document.
 */
export function journalFor(
  plan: UpdatePlan,
  timestamp: string,
  phase: JournalPhase,
  completed: readonly string[] = [],
  detail: string | null = null,
): ApplyJournal {
  return {
    schema: 1,
    toVersion: plan.toVersion,
    fingerprint: plan.fingerprint,
    createdAt: timestamp,
    phase,
    completed: [...completed],
    detail,
  }
}

/**
 * Read a legacy v1 journal; a missing file returns null.
 * @param path - Journal path.
 * @returns Journal document or null when absent.
 */
export async function readJournal(path: string): Promise<ApplyJournal | null> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  const parsed: unknown = JSON.parse(text)
  if (
    parsed === null ||
    typeof parsed !== 'object' ||
    (parsed as { schema?: unknown }).schema !== 1 ||
    typeof (parsed as { fingerprint?: unknown }).fingerprint !== 'string'
  ) {
    throw new Error(`invalid apply journal: ${path}`)
  }
  return parsed as ApplyJournal
}

/**
 * Write a legacy v1 journal atomically.
 * @param path - Journal path.
 * @param journal - Journal document.
 */
export async function writeJournal(path: string, journal: ApplyJournal): Promise<void> {
  await writeBufferAtomic(path, Buffer.from(`${JSON.stringify(journal, null, 2)}\n`, 'utf8'), 0o644)
}
