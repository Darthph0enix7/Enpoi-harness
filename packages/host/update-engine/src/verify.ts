/**
 * Qualified verification (§2.3 step 4).
 *
 * The staged tree is walked once, then every planned path is checked against
 * its recorded outcome: manifest hash for shipped paths, the recorded
 * merge-keep/merge-output hash for preserved paths, absence for tombstones
 * and deletions, presence with the recorded hash for untracked paths, and
 * every sidecar's recorded hash. Paths present in staging but absent from the
 * new manifest and from the plan's untracked list are reported as unexpected,
 * so nothing appears without a decision.
 */

import { scanTree } from './manifest.ts'
import type { Manifest, ManifestEntry, UpdatePlan, VerificationMismatch, VerificationResult } from './types.ts'

/** Options for {@link verifyStagedTree}. */
export interface VerifyOptions {
  /** Plan whose outcomes are verified. */
  plan: UpdatePlan
  /** Staging directory to verify. */
  stagingRoot: string
  /** Extra ignore patterns for the staging scan. */
  ignore?: readonly string[]
}

/**
 * Verify a staged tree against the new manifest and the plan's recorded
 * preservations.
 * @param options - Plan, staging root, and optional scan ignores.
 * @returns Verification result; `ok` is true when no mismatch was found.
 */
export async function verifyStagedTree(options: VerifyOptions): Promise<VerificationResult> {
  const { plan, stagingRoot } = options
  const scan = await scanTree(stagingRoot, options.ignore === undefined ? {} : { ignore: options.ignore })
  const expected = new Set<string>()
  const mismatches: VerificationMismatch[] = []
  let manifestChecked = 0
  let preservedChecked = 0
  let tombstonesAbsent = 0
  let untrackedPresent = 0
  let sidecarsPresent = 0

  for (const action of plan.actions) {
    expected.add(action.path)
    const actual = scan[action.path]
    switch (action.outcome.disposition) {
      case 'absent': {
        if (actual !== undefined && !(actual.type === 'dir' && hasRetainedDirectoryContent(scan, action.path))) {
          mismatches.push(mismatch(action.path, 'unexpected', 'absent', describe(actual)))
        } else if (action.kind === 'tombstone') {
          tombstonesAbsent++
        }
        break
      }
      case 'shipped': {
        const shipped = action.shipped
        if (shipped === null) {
          mismatches.push(mismatch(action.path, 'missing', 'planned shipped entry', 'no shipped entry'))
          break
        }
        mismatches.push(...checkEntry(action.path, actual, shipped, action.outcome.sha256, shipped.mode))
        manifestChecked++
        break
      }
      case 'merged': {
        const local = action.local
        if (actual === undefined) {
          mismatches.push(mismatch(action.path, 'missing', 'merged output', 'absent'))
          break
        }
        if (actual.type !== 'file') {
          mismatches.push(mismatch(action.path, 'type', 'file', actual.type))
          break
        }
        if (actual.sha256 !== action.outcome.sha256) {
          mismatches.push(mismatch(action.path, 'hash', action.outcome.sha256 ?? 'null', actual.sha256 ?? 'null'))
        }
        if (local !== null && actual.mode !== local.mode) {
          mismatches.push(mismatch(action.path, 'mode', mode(local.mode), mode(actual.mode)))
        }
        preservedChecked++
        break
      }
      case 'local': {
        const local = action.local
        if (local === null) {
          mismatches.push(mismatch(action.path, 'missing', 'preserved local entry', 'no local entry recorded'))
          break
        }
        mismatches.push(...checkEntry(action.path, actual, local, action.outcome.sha256, local.mode))
        if (action.kind === 'keep-untracked') untrackedPresent++
        preservedChecked++
        break
      }
    }
    for (const [sidecar, sha256] of Object.entries(action.outcome.sidecars)) {
      expected.add(sidecar)
      const actualSidecar = scan[sidecar]
      if (actualSidecar === undefined) {
        mismatches.push(mismatch(sidecar, 'sidecar-missing', sha256, 'absent'))
        continue
      }
      if (actualSidecar.sha256 !== sha256) {
        mismatches.push(mismatch(sidecar, 'sidecar-hash', sha256, actualSidecar.sha256 ?? 'null'))
        continue
      }
      sidecarsPresent++
    }
  }

  for (const [path, entry] of Object.entries(scan)) {
    if (expected.has(path)) continue
    mismatches.push(mismatch(path, 'unexpected-untracked', 'listed untracked or sidecar', describe(entry)))
  }

  return {
    ok: mismatches.length === 0,
    manifestChecked,
    preservedChecked,
    tombstonesAbsent,
    untrackedPresent,
    sidecarsPresent,
    mismatches,
  }
}

function checkEntry(
  path: string,
  actual: ManifestEntry | undefined,
  expectedEntry: ManifestEntry,
  expectedSha256: string | null,
  expectedMode: number,
): VerificationMismatch[] {
  if (actual === undefined) return [mismatch(path, 'missing', describe(expectedEntry), 'absent')]
  const result: VerificationMismatch[] = []
  if (actual.type !== expectedEntry.type) {
    result.push(mismatch(path, 'type', expectedEntry.type, actual.type))
    return result
  }
  if (expectedSha256 !== null && actual.sha256 !== expectedSha256) {
    result.push(mismatch(path, 'hash', expectedSha256, actual.sha256 ?? 'null'))
  }
  if (actual.mode !== expectedMode) {
    result.push(mismatch(path, 'mode', mode(expectedMode), mode(actual.mode)))
  }
  if (expectedEntry.type === 'symlink' && actual.target !== expectedEntry.target) {
    result.push(mismatch(path, 'target', expectedEntry.target ?? 'null', actual.target ?? 'null'))
  }
  return result
}

function hasRetainedDirectoryContent(scan: Manifest, path: string): boolean {
  const prefix = path + '/'
  return Object.keys(scan).some(other => other.startsWith(prefix))
}

function mismatch(
  path: string,
  reason: VerificationMismatch['reason'],
  expected: string,
  actual: string,
): VerificationMismatch {
  return { path, reason, expected, actual }
}

function describe(entry: ManifestEntry | undefined): string {
  return entry === undefined ? 'absent' : `${entry.type}${entry.sha256 === null ? '' : `:${entry.sha256.slice(0, 12)}`}`
}

function mode(value: number): string {
  return `0o${value.toString(8).padStart(4, '0')}`
}
