/**
 * Structured update report (§5): counts, conflicts, preserved lists, sidecars,
 * and bytes, plus a deterministic human rendering. The same object feeds the
 * creator-supervised flow and `ds update --dry-run` output.
 */

import type { ApplyActionResult, PreservedPath, UpdatePlan, UpdateReport, VerificationResult } from './types.ts'

/** Inputs for {@link buildUpdateReport}. */
export interface ReportOptions {
  /** Plan the pass executed. */
  plan: UpdatePlan
  /** Apply status. */
  status: UpdateReport['status']
  /** Bytes written in this pass. */
  bytesWritten: number
  /** Qualified verification result; null when verification did not run. */
  verification: VerificationResult | null
  /** Backup directory; null when none. */
  backupDir: string | null
  /** Per-action results. */
  results: readonly ApplyActionResult[]
}

/**
 * Build the structured update report.
 * @param options - Plan, status, write stats, and verification.
 * @returns Report including the human rendering.
 */
export function buildUpdateReport(options: ReportOptions): UpdateReport {
  const { plan } = options
  const preserved = collectPreserved(plan)
  const deletions = plan.actions.filter(action => action.kind === 'delete').map(action => action.path)
  const pinned = plan.actions.filter(action => action.pinned && action.kind === 'pin-skip').map(action => action.path)
  const sidecars: { path: string; sha256: string }[] = []
  for (const action of plan.actions) {
    for (const [path, sha256] of Object.entries(action.outcome.sidecars)) sidecars.push({ path, sha256 })
  }
  let replaced = 0
  for (const action of plan.actions) {
    if (action.kind === 'replace' || action.kind === 'add' || action.kind === 'restore') {
      replaced += action.shipped?.size ?? 0
    }
  }
  const report: UpdateReport = {
    fromVersion: plan.fromVersion,
    toVersion: plan.toVersion,
    status: options.status,
    switchDecision: plan.switchDecision,
    counts: plan.counts,
    conflicts: plan.conflicts,
    preserved,
    deletions,
    pinned,
    sidecars,
    bytes: { written: options.bytesWritten, replaced },
    verification: options.verification,
    human: '',
  }
  report.human = formatReportHuman(report, options.backupDir, options.results)
  return report
}

function collectPreserved(plan: UpdatePlan): PreservedPath[] {
  const preserved: PreservedPath[] = []
  for (const action of plan.actions) {
    if (action.local?.type === 'dir') continue
    if (
      action.kind === 'merge' ||
      action.kind === 'keep-local' ||
      action.kind === 'keep-local-sidecar' ||
      action.kind === 'keep-untracked' ||
      action.kind === 'pin-skip'
    ) {
      preserved.push({ path: action.path, reason: action.reason, sha256: action.outcome.sha256 })
    }
  }
  return preserved
}

/**
 * Render the report as deterministic human text.
 * @param report - Structured report.
 * @param backupDir - Backup directory when one was created.
 * @param results - Per-action results for retained-directory notes.
 * @returns Multi-line human report.
 */
export function formatReportHuman(
  report: UpdateReport,
  backupDir: string | null = null,
  results: readonly ApplyActionResult[] = [],
): string {
  const lines: string[] = []
  const from = report.fromVersion ?? 'cold'
  lines.push(`dsh update: ${from} -> ${report.toVersion} (${report.status}; switch ${report.switchDecision})`)
  const counts = report.counts
  lines.push(
    `actions: replace ${counts.replace}, add ${counts.add}, merge ${counts.merge}, keep-local ${counts['keep-local']},`
    + ` keep-untracked ${counts['keep-untracked']}, restore ${counts.restore}, delete ${counts.delete},`
    + ` pin-skip ${counts['pin-skip']}, tombstone ${counts.tombstone}, skip ${counts.skip}`,
  )
  lines.push(`conflicts: ${report.conflicts.length}`)
  for (const conflict of report.conflicts) {
    lines.push(`  [${conflict.severity}] ${conflict.path}: ${conflict.detail}${conflict.sidecar === null ? '' : ` (sidecar ${conflict.sidecar})`}`)
  }
  lines.push(`preserved: ${report.preserved.length}`)
  for (const preserved of report.preserved) {
    lines.push(`  ${preserved.path} (${preserved.reason})`)
  }
  lines.push(`deletions: ${report.deletions.length}`)
  for (const path of report.deletions) lines.push(`  ${path}`)
  lines.push(`pins skipped: ${report.pinned.length}`)
  for (const path of report.pinned) lines.push(`  ${path}`)
  lines.push(`sidecars: ${report.sidecars.length}`)
  for (const sidecar of report.sidecars) lines.push(`  ${sidecar.path}`)
  for (const result of results) {
    if (result.status === 'retained') lines.push(`retained non-empty directory (untracked content kept): ${result.path}`)
  }
  if (backupDir !== null) lines.push(`backup: ${backupDir}`)
  lines.push(`bytes: written ${report.bytes.written}, replaced ${report.bytes.replaced}`)
  if (report.verification !== null) {
    const verification = report.verification
    lines.push(
      `verification: ${verification.ok ? 'ok' : 'failed'}`
      + ` (manifest ${verification.manifestChecked}, preserved ${verification.preservedChecked},`
      + ` tombstones ${verification.tombstonesAbsent}, untracked ${verification.untrackedPresent},`
      + ` sidecars ${verification.sidecarsPresent})`,
    )
    for (const mismatch of verification.mismatches) {
      lines.push(`  ${mismatch.path}: ${mismatch.reason} expected=${mismatch.expected} actual=${mismatch.actual}`)
    }
  }
  return lines.join('\n') + '\n'
}
