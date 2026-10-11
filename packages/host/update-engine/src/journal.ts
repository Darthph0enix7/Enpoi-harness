/**
 * Interruption-recovery journal for staged apply (§2.3): binds a staging
 * directory to exactly one plan fingerprint, records the last completed
 * phase, and is written after every action so a crash leaves a readable
 * mid-state. Re-entry detection lives in `apply.ts`: a matching fingerprint
 * resumes idempotently, a mismatching fingerprint requires rollback because
 * the staging directory belongs to a different plan.
 */

import { readFile } from 'node:fs/promises'
import { writeBufferAtomic } from './atomic.ts'
import type { ApplyJournal, JournalPhase, UpdatePlan } from './types.ts'

/**
 * Build a journal document for a plan.
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
 * Read a journal; a missing file returns null.
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
 * Write a journal atomically.
 * @param path - Journal path.
 * @param journal - Journal document.
 */
export async function writeJournal(path: string, journal: ApplyJournal): Promise<void> {
  await writeBufferAtomic(path, Buffer.from(JSON.stringify(journal, null, 2) + '\n', 'utf8'), 0o644)
}
