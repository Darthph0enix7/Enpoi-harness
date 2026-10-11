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

import { lstat } from 'node:fs/promises'
import { join } from 'node:path'
import { hashFile } from './manifest.ts'
import { walkTree } from './manifest.ts'
import type { Manifest, ManifestEntry, UpdatePlan, VerificationMismatch, VerificationResult } from './types.ts'

/** Options for {@link verifyStagedTree}. */
export interface VerifyOptions {
  /** Plan whose outcomes are verified. */
  plan: UpdatePlan
  /** Staging directory to verify. */
  stagingRoot: string
  /** Extra ignore patterns for the staging walk. */
  ignore?: readonly string[]
  /**
   * Live tree root. With {@link localManifest} and
   * {@link localScanCompletedAt}, staged files that share an inode with the
   * live file (hardlink-seeded, never rewritten) reuse the manifest's content
   * hash instead of re-reading the bytes — the same inode proves the same
   * content, and the scan time bounds when that was verified.
   */
  localRoot?: string
  /** The plan's local manifest (from the run's scan) for hash reuse. */
  localManifest?: Manifest
  /** Completion time (epoch ms) of the local scan the manifest came from. */
  localScanCompletedAt?: number
  /** Opt-in progress over files that actually needed hashing. */
  onProgress?: (progress: { filesHashed: number; bytesHashed: number }) => void
}

/**
 * Verify a staged tree against the new manifest and the plan's recorded
 * preservations.
 * @param options - Plan, staging root, and optional scan ignores.
 * @returns Verification result; `ok` is true when no mismatch was found.
 */
export async function verifyStagedTree(options: VerifyOptions): Promise<VerificationResult> {
  const { plan, stagingRoot } = options
  // A lightweight walk first (lstat only); file contents are hashed lazily,
  // and only when a trusted hash cannot be carried over from the local scan
  // through the hardlink-seeded inodes.
  const scan = await walkTree(stagingRoot, options.ignore === undefined ? {} : { ignore: options.ignore })
  const resolved = new Map<string, ManifestEntry | undefined>()
  let contentReused = 0
  let filesHashed = 0
  let bytesHashed = 0
  let lastHashTickAt = 0
  const resolveActual = async (rel: string): Promise<ManifestEntry | undefined> => {
    if (resolved.has(rel)) return resolved.get(rel)
    const entry = scan[rel]
    let result = entry
    if (entry !== undefined && entry.type === 'file') {
      const stagedPath = join(stagingRoot, ...rel.split('/'))
      const stagedStats = await lstat(stagedPath).catch(() => null)
      if (stagedStats !== null && stagedStats.isFile()) {
        let trusted: string | null = null
        if (options.localRoot !== undefined && options.localManifest !== undefined && options.localScanCompletedAt !== undefined
          && stagedStats.mtimeMs <= options.localScanCompletedAt) {
          const liveStats = await lstat(join(options.localRoot, ...rel.split('/'))).catch(() => null)
          if (liveStats !== null && liveStats.isFile() && liveStats.dev === stagedStats.dev && liveStats.ino === stagedStats.ino) {
            trusted = options.localManifest[rel]?.sha256 ?? null
          }
        }
        if (trusted !== null) {
          result = { ...entry, sha256: trusted, size: stagedStats.size }
          contentReused += 1
        } else {
          const hashed = await hashFile(stagedPath)
          result = { ...entry, sha256: hashed.sha256, size: hashed.size, binary: hashed.binary }
          filesHashed += 1
          bytesHashed += hashed.size
          const now = Date.now()
          if (filesHashed % 50 === 0 || now - lastHashTickAt >= 3000) {
            lastHashTickAt = now
            options.onProgress?.({ filesHashed, bytesHashed })
          }
        }
      }
    }
    resolved.set(rel, result)
    return result
  }
  const expected = new Set<string>()
  const mismatches: VerificationMismatch[] = []
  let manifestChecked = 0
  let preservedChecked = 0
  let tombstonesAbsent = 0
  let untrackedPresent = 0
  let sidecarsPresent = 0

  for (const action of plan.actions) {
    expected.add(action.path)
    const actual = await resolveActual(action.path)
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
      const actualSidecar = await resolveActual(sidecar)
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

  options.onProgress?.({ filesHashed, bytesHashed })
  return {
    ok: mismatches.length === 0,
    manifestChecked,
    preservedChecked,
    tombstonesAbsent,
    untrackedPresent,
    sidecarsPresent,
    contentReused,
    filesHashed,
    bytesHashed,
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
