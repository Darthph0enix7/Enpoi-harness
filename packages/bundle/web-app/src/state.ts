/**
 * Attach state for the Web surface (fork): the serving instance records its
 * authenticated loopback URL at readiness, and a later `dsh web` reads it
 * before booting to attach to the running instance instead of starting a
 * second server that would fail on the occupied port. The file is written
 * atomically with mode 0600 and removed on clean exit only by the process
 * that recorded itself.
 * @module @deepseek-ai/dsh-web-app/state
 */

import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { readFileSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'

/** One serving instance's record, as stored in {@link webStatePath}. */
export interface WebInstanceState {
  /** Authenticated loopback URL (`?token=` included). */
  url: string
  /** Host the instance listens on, as probed by attach. */
  host: string
  /** Bound port; an OS-assigned port when `--port 0` was used. */
  port: number
  /** Serving process id, for staleness detection. */
  pid: number
  /** ISO timestamp of readiness. */
  startedAt: string
}

/** State directory and file name, relative to `$DSH_HOME`. */
const STATE_DIR = 'state'
const STATE_FILE = 'web-url.json'

/**
 * Absolute path of the attach state file.
 * @param home - DSH home override for tests; defaults to the resolved home.
 * @returns the state file path.
 */
export function webStatePath(home?: string): string {
  return join(home ?? resolveDshHome(), STATE_DIR, STATE_FILE)
}

/**
 * Record a serving instance's attach state atomically.
 * @param state - the record to write.
 * @param home - DSH home override for tests.
 * @returns a promise that settles when the record is in place.
 */
export async function writeWebState(state: WebInstanceState, home?: string): Promise<void> {
  const path = webStatePath(home)
  const temporary = `${path}.tmp.${String(process.pid)}`
  await mkdir(dirname(path), { recursive: true })
  await writeFile(temporary, `${JSON.stringify(state)}\n`, { mode: 0o600 })
  await rename(temporary, path)
}

/**
 * Remove the attach state when it belongs to `pid`; any other record, or an
 * absent or unreadable file, is left untouched.
 * @param pid - the caller's process id.
 * @param home - DSH home override for tests.
 * @returns a promise that settles after the best-effort removal.
 */
export async function removeWebState(pid: number, home?: string): Promise<void> {
  const path = webStatePath(home)
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as Partial<WebInstanceState>
    if (parsed.pid !== pid) return
    await unlink(path)
  } catch {
    // Absent, unreadable, or already removed: nothing to clean up.
  }
}

/**
 * Synchronous counterpart of {@link removeWebState} for `process.on('exit')`,
 * where only synchronous work can run.
 * @param pid - the caller's process id.
 * @param home - DSH home override for tests.
 */
export function removeWebStateSync(pid: number, home?: string): void {
  const path = webStatePath(home)
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<WebInstanceState>
    if (parsed.pid !== pid) return
    unlinkSync(path)
  } catch {
    // Absent, unreadable, or already removed: nothing to clean up.
  }
}
