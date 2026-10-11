/**
 * Pre-update backup latch (§3.5): every locally modified and every untracked
 * path is copied, byte-for-byte, into `.backup-<ts>/` before apply writes
 * anything, together with a `baseline.json` recording the baseline and local
 * hashes. Copies are independent inodes (never hardlinks), so a later user
 * deletion cannot reduce the backup.
 */

import { chmod, copyFile, mkdir, readlink, symlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { resolveTreePath } from './manifest.ts'
import type { BackupResult, PlanAction, ManifestEntry, UpdatePlan } from './types.ts'

/** Options for {@link createBackup}. */
export interface BackupOptions {
  /** Current installed tree root. */
  localRoot: string
  /** Plan being applied; its actions select the backup set. */
  plan: UpdatePlan
  /** Exact backup directory to create. */
  backupDir: string
}

/**
 * Back up modified and untracked files before apply.
 * @param options - Local root, plan, and backup directory.
 * @returns Backup result with counts and the baseline manifest.
 */
export async function createBackup(options: BackupOptions): Promise<BackupResult> {
  const { localRoot, plan, backupDir } = options
  await mkdir(backupDir, { recursive: true })
  const baseline: BackupResult['baseline'] = {}
  let files = 0
  let bytes = 0

  for (const action of plan.actions) {
    if (action.local === null) continue
    const reason = backupReason(action)
    if (reason === null) continue
    const entry = action.local
    const source = resolveTreePath(localRoot, action.path)
    const destination = join(backupDir, ...action.path.split('/'))
    await mkdir(dirname(destination), { recursive: true })
    if (entry.type === 'file') {
      await copyFile(source, destination)
      await chmod(destination, entry.mode)
      bytes += entry.size
    } else if (entry.type === 'symlink') {
      await symlink(await readlink(source), destination)
    } else {
      await mkdir(destination, { recursive: true, mode: entry.mode })
    }
    files++
    baseline[action.path] = {
      baselineSha256: action.baseline?.sha256 ?? null,
      localSha256: entry.sha256,
      reason,
    }
  }

  const sorted: BackupResult['baseline'] = {}
  for (const path of Object.keys(baseline).sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))) {
    const record = baseline[path]
    if (record !== undefined) sorted[path] = record
  }
  await writeFile(join(backupDir, 'baseline.json'), JSON.stringify(sorted, null, 2) + '\n', 'utf8')
  return { dir: backupDir, files, bytes, baseline: sorted }
}

function backupReason(action: PlanAction): 'modified' | 'untracked' | null {
  const local: ManifestEntry | null = action.local
  if (local === null) return null
  if (action.baseline === null) {
    // A path the release did not previously own: user addition.
    return 'untracked'
  }
  const modified = local.type !== action.baseline.type
    || local.mode !== action.baseline.mode
    || local.sha256 !== action.baseline.sha256
    || local.target !== action.baseline.target
  return modified ? 'modified' : null
}
