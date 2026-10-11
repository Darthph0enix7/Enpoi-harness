/**
 * Deterministic temp-file + rename writes for the update engine.
 *
 * Every staging write goes through these helpers: content is written to a
 * fixed-name temp sibling and renamed onto the target, so a hardlinked target
 * is never written through its shared inode (§2.3). The temp name is fixed
 * (not random) and cleared before use, keeping apply resumable and
 * deterministic; one updater pass at a time is the caller's contract.
 */

import { mkdir, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/** Suffix of the deterministic temp sibling used by every write. */
export const TEMP_SUFFIX = '.dsh-update.tmp'

/**
 * Write bytes to a temp sibling and rename onto the target (atomic replace).
 * @param target - Absolute target path.
 * @param data - Content to write.
 * @param mode - POSIX permission bits applied to the written file.
 */
export async function writeBufferAtomic(target: string, data: Buffer, mode: number): Promise<void> {
  await mkdir(dirname(target), { recursive: true })
  const temp = target + TEMP_SUFFIX
  await rm(temp, { force: true })
  await writeFile(temp, data, { flag: 'wx', mode })
  await rename(temp, target)
}

/**
 * Unlink the target (when present) before the temp + rename write, so a
 * staging target hardlinked from the live tree can never be mutated in place
 * through the shared inode. Used for staging content writes.
 * @param target - Absolute target path.
 * @param data - Content to write.
 * @param mode - POSIX permission bits applied to the written file.
 */
export async function writeBufferUnlinked(target: string, data: Buffer, mode: number): Promise<void> {
  await mkdir(dirname(target), { recursive: true })
  await rm(target, { force: true })
  await writeBufferAtomic(target, data, mode)
}

/**
 * Replace a path with a symlink via temp symlink + rename, unlinking the
 * target first.
 * @param target - Absolute link path.
 * @param linkTarget - Symlink target string.
 */
export async function writeSymlinkUnlinked(target: string, linkTarget: string): Promise<void> {
  await mkdir(dirname(target), { recursive: true })
  const temp = target + TEMP_SUFFIX
  await rm(temp, { force: true })
  await rm(target, { force: true })
  await symlink(linkTarget, temp)
  await rename(temp, target)
}
