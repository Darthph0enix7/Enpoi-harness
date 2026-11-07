/**
 * Per-provider cross-process ownership for heavy-provider jobs.
 *
 * Each provider id gets its own lock directory under `<job dir>/locks`. A lock
 * is a numbered generation holding the owner's pid, process start identity
 * (Linux kernel ticks or a macOS `ps` stamp), and a random token. Acquisition creates the next
 * generation with an exclusive hard link, so two processes can never both
 * create the same owner record. A generation whose recorded process is proven
 * gone is bypassed by the next generation; a live or unverifiable record is
 * never removed. Generation numbering makes reclaiming a dead local owner
 * race-free: another contender either wins the next generation or inspects the
 * winner's record, and cleanup only unlinks generations already proven dead.
 *
 * @module dsh-enpoi-heavy-providers/provider-lock
 */

import { spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { linkSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Directory name under the job cache directory that holds provider locks. */
const LOCK_DIRECTORY = 'locks'

/** Serialized lock record version. A different version is never auto-reclaimed. */
const LOCK_VERSION = 1

/** Bounded retries when another process creates the next generation first. */
const MAX_ACQUIRE_ATTEMPTS = 5

/** A lock generation file name. Temporary files are ignored. */
const GENERATION_FILE = /^(\d{12})\.lock$/

/** Highest generation the fixed-width file name can represent. */
const MAX_GENERATION = 999_999_999_999

/** Latest epoch millisecond `Date#toISOString` can represent. */
const MAX_EPOCH_MS = 8_640_000_000_000_000

/** Bound for the macOS `ps` identity probe; a hung probe cannot block a lock. */
const PROCESS_START_TIMEOUT_MS = 5_000

/** The holder identity recorded in one lock generation. */
export interface HeavyProviderLockOwner {
  readonly id: string
  /** Random per-acquisition token; release removes only a file carrying it. */
  readonly token: string
  readonly pid: number
  readonly startedAt: number
  /**
   * Process start identity: the Linux kernel start tick (`/proc/<pid>/stat`
   * field 22) or a `ps:<lstart>` stamp on macOS, or null when neither was
   * available. A mismatch proves pid reuse.
   */
  readonly processStart: string | null
}

/** A live process owns the provider lock. */
export class HeavyProviderLockedError extends Error {
  /**
   * @param path - the highest lock generation that refused acquisition.
   * @param owner - the recorded holder, when the record was readable.
   */
  constructor(readonly path: string, readonly owner?: HeavyProviderLockOwner) {
    super(
      owner === undefined
        ? `heavy-provider lock at ${path} is held`
        : `heavy-provider lock at ${path} is held by pid ${String(owner.pid)} (started ${new Date(owner.startedAt).toISOString()})`,
    )
    this.name = 'HeavyProviderLockedError'
  }
}

/** The lock record cannot be read or its holder's liveness cannot be proven. */
export class HeavyProviderLockUnreadableError extends Error {
  /**
   * @param path - the lock path that failed inspection.
   * @param reason - the concrete inspection failure.
   */
  constructor(readonly path: string, reason: string) {
    super(`heavy-provider lock at ${path} ${reason}; refusing to reclaim it automatically`)
    this.name = 'HeavyProviderLockUnreadableError'
  }
}

/** Tokens held by this process; a same-pid record outside this set is abandoned. */
const liveTokens = new Map<string, HeavyProviderLockOwner>()

/** Liveness of a recorded owner. `ambiguous` must never be reclaimed. */
type Liveness = 'live' | 'dead' | 'ambiguous'

/** One parsed generation record. */
interface ParsedLock {
  readonly owner: HeavyProviderLockOwner
}

/** One generation file and its ownership verdict. */
interface GenerationLock {
  readonly path: string
  readonly generation: number
  readonly status: 'held' | 'dead' | 'unverifiable'
  readonly parsed?: ParsedLock
  readonly reason?: string
}

/** What the highest lock generation says about the provider. */
export type ProviderLockInspection =
  | { readonly kind: 'none' }
  | { readonly kind: 'held'; readonly path: string; readonly owner: HeavyProviderLockOwner }
  | { readonly kind: 'dead'; readonly path: string }
  | { readonly kind: 'unverifiable'; readonly path: string; readonly reason: string }

/** The filesystem error code, when the value carries one. */
function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | null)?.code
}

/** A human-readable error message for diagnostics and lock failures. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** The directory holding one provider's lock generations. */
function lockDirectory(jobDir: string, id: string): string {
  return join(jobDir, LOCK_DIRECTORY, encodeURIComponent(id))
}

/** Read a Linux process's state and start tick; undefined when unavailable. */
function readLinuxProcess(pid: number): { state: string; start: string } | undefined {
  if (process.platform !== 'linux') return undefined
  try {
    const stat = readFileSync(`/proc/${String(pid)}/stat`, 'utf8')
    // The comm field may contain spaces and parentheses; fields resume after
    // the last ')'.
    const closing = stat.lastIndexOf(')')
    if (closing < 0) return undefined
    const fields = stat.slice(closing + 1).trim().split(/\s+/)
    const state = fields[0]
    // Field 22 overall is index 19 after the comm field.
    const start = fields[19]
    if (state === undefined || start === undefined || !/^\d+$/.test(start)) return undefined
    return { state, start }
  } catch {
    // The process may have exited between the signal probe and this read.
    return undefined
  }
}

/**
 * Read a process start identity. Linux uses the kernel start tick; macOS uses
 * `ps -o lstart=` because procfs is absent. Other platforms expose neither.
 * @param pid - process id to inspect.
 * @returns the recorded identity, or undefined when unavailable.
 */
function readProcessStart(pid: number): string | undefined {
  if (process.platform === 'linux') return readLinuxProcess(pid)?.start
  if (process.platform !== 'darwin') return undefined
  try {
    const result = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8',
      timeout: PROCESS_START_TIMEOUT_MS,
      windowsHide: true,
    })
    if (result.error !== undefined || result.status !== 0) return undefined
    const stamp = typeof result.stdout === 'string' ? result.stdout.trim() : ''
    return stamp === '' ? undefined : `ps:${stamp}`
  } catch {
    // `ps` may be unavailable; an unknown identity must fail closed.
    return undefined
  }
}

/** This process's start identity, recorded so later readers can detect pid reuse. */
function ownProcessStart(): string | null {
  return readProcessStart(process.pid) ?? null
}

/** Whether a recorded identity is in the form the current platform compares. */
function comparableProcessStart(processStart: string): boolean {
  if (process.platform === 'linux') return /^\d+$/u.test(processStart)
  if (process.platform === 'darwin') return processStart.startsWith('ps:') && processStart.length > 3
  return false
}

/**
 * Prove whether a recorded owner still owns its lock.
 * A same-pid record is live while its token is held by this module instance.
 * An unregistered same-pid token is also live: another module instance (HMR,
 * rebundling) or an orphaned local record must not be reclaimed. Only a
 * recorded start identity that differs from this process's identity proves the
 * pid was reused, so the record is stale. A different pid is probed with signal
 * 0, then its recorded identity is compared when one was recorded. Without
 * either proof the verdict is `ambiguous`; a legacy record with no identity
 * stays live so an unknown live owner is never reclaimed.
 * @param pid - recorded owner pid.
 * @param processStart - recorded kernel start tick, or null.
 * @param tokenLive - whether this process still holds the token.
 * @returns the liveness verdict; only `dead` may be reclaimed.
 */
function processLiveness(pid: number, processStart: string | null, tokenLive: boolean): Liveness {
  if (pid === process.pid) {
    if (tokenLive) return 'live'
    if (processStart !== null && comparableProcessStart(processStart)) {
      const ownStart = readProcessStart(process.pid)
      if (ownStart !== undefined && ownStart !== processStart) return 'dead'
    }
    return 'live'
  }
  let probe: 'alive' | 'gone' | 'unknown'
  try {
    process.kill(pid, 0)
    probe = 'alive'
  } catch (error) {
    const code = errorCode(error)
    probe = code === 'ESRCH' ? 'gone' : code === 'EPERM' ? 'alive' : 'unknown'
  }
  if (probe === 'gone') return 'dead'
  if (probe === 'unknown') return 'ambiguous'
  if (process.platform === 'linux') {
    const stat = readLinuxProcess(pid)
    if (stat === undefined) return processStart === null ? 'live' : 'ambiguous'
    if (stat.state.startsWith('Z') || stat.state === 'X') return 'dead'
    if (processStart !== null && comparableProcessStart(processStart) && stat.start !== processStart) {
      return 'dead'
    }
    return processStart === null || comparableProcessStart(processStart) ? 'live' : 'ambiguous'
  }
  if (process.platform === 'darwin') {
    const start = readProcessStart(pid)
    if (start === undefined) return processStart === null ? 'live' : 'ambiguous'
    // A legacy null-identity record cannot prove reuse; treat it as live.
    if (processStart === null) return 'live'
    if (!comparableProcessStart(processStart)) return 'ambiguous'
    return start === processStart ? 'live' : 'dead'
  }
  return processStart === null ? 'live' : 'ambiguous'
}

/** Parse one generation record, rejecting malformed or wrong-provider files. */
function parseLockOwner(raw: string, id: string): HeavyProviderLockOwner | undefined {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  if (record.version !== LOCK_VERSION || record.id !== id) return undefined
  const { token, pid, startedAt, processStart } = record
  if (typeof token !== 'string' || token === '') return undefined
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0 || pid > 0x7fffffff) return undefined
  if (
    typeof startedAt !== 'number'
    || !Number.isFinite(startedAt)
    || startedAt < 0
    || startedAt > MAX_EPOCH_MS
  ) return undefined
  if (processStart !== null && (
    typeof processStart !== 'string'
    || !(/^\d+$/.test(processStart) || (processStart.startsWith('ps:') && processStart.length > 3))
  )) return undefined
  return { id, token, pid, startedAt, processStart }
}

/** Read every generation for one provider, oldest first. */
function readGenerations(providerDir: string, id: string): GenerationLock[] {
  let names: string[]
  try {
    names = readdirSync(providerDir)
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return []
    return [{ path: providerDir, generation: 0, status: 'unverifiable', reason: `cannot be listed (${errorMessage(error)})` }]
  }
  const locks: GenerationLock[] = []
  for (const name of names) {
    const match = GENERATION_FILE.exec(name)
    if (match === null) continue
    const generation = Number(match[1])
    if (!Number.isSafeInteger(generation)) continue
    const path = join(providerDir, name)
    let raw: string
    try {
      raw = readFileSync(path, 'utf8')
    } catch (error) {
      locks.push({ path, generation, status: 'unverifiable', reason: `cannot be read (${errorMessage(error)})` })
      continue
    }
    const owner = parseLockOwner(raw, id)
    if (owner === undefined) {
      locks.push({ path, generation, status: 'unverifiable', reason: 'is malformed or names a different provider' })
      continue
    }
    const liveness = processLiveness(owner.pid, owner.processStart, liveTokens.has(owner.token))
    if (liveness === 'live') {
      locks.push({ path, generation, status: 'held', parsed: { owner } })
    } else if (liveness === 'dead') {
      locks.push({ path, generation, status: 'dead', parsed: { owner } })
    } else {
      locks.push({
        path,
        generation,
        status: 'unverifiable',
        reason: `names pid ${String(owner.pid)}, whose liveness cannot be verified`,
      })
    }
  }
  locks.sort((left, right) => left.generation - right.generation)
  return locks
}

/**
 * Inspect one provider's highest lock generation without creating or removing
 * anything. Lower generations are historical and cannot hold ownership.
 * @param jobDir - the job cache directory shared by every manager.
 * @param id - provider id.
 * @returns the highest generation's verdict.
 */
export function inspectProviderLock(jobDir: string, id: string): ProviderLockInspection {
  const locks = readGenerations(lockDirectory(jobDir, id), id)
  const highest = locks.at(-1)
  if (highest === undefined) return { kind: 'none' }
  if (highest.status === 'held' && highest.parsed !== undefined) {
    return { kind: 'held', path: highest.path, owner: highest.parsed.owner }
  }
  if (highest.status === 'dead') return { kind: 'dead', path: highest.path }
  return { kind: 'unverifiable', path: highest.path, reason: highest.reason ?? 'cannot be verified' }
}

/** Remove generations already proven dead; the caller owns a newer generation. */
function removeDeadGenerations(locks: readonly GenerationLock[], ownedPath: string): void {
  for (const lock of locks) {
    if (lock.status !== 'dead' || lock.path === ownedPath) continue
    try {
      unlinkSync(lock.path)
    } catch {
      // Best effort: a dead generation left behind is bypassed by numbering.
    }
  }
}

/** One held provider lock. Constructed only by {@link acquireProviderLock}. */
export class HeavyProviderLock {
  private released = false

  /**
   * @param path - the owned generation's file.
   * @param owner - the recorded identity.
   * @param content - the exact serialized record release compares against.
   */
  constructor(
    readonly path: string,
    readonly owner: HeavyProviderLockOwner,
    private readonly content: string,
  ) {}

  /**
   * Remove this lock only when the generation still carries this exact
   * record. A replaced record belongs to another owner and is left in place.
   * Idempotent.
   */
  release(): void {
    if (this.released) return
    this.released = true
    try {
      if (readFileSync(this.path, 'utf8') === this.content) unlinkSync(this.path)
    } catch {
      // Missing or unreadable: it is no longer provably this owner's file.
    } finally {
      liveTokens.delete(this.owner.token)
    }
  }
}

/**
 * Acquire the next exclusive lock generation for one provider. A live owner
 * refuses with {@link HeavyProviderLockedError}; a malformed record, an
 * unreadable directory, or a holder whose death cannot be proven refuses with
 * {@link HeavyProviderLockUnreadableError}. One provider's lock never blocks
 * another provider.
 * @param jobDir - the job cache directory shared by every manager.
 * @param id - provider id.
 * @param now - clock seam for the recorded start time.
 * @returns the held lock; call `release` when the operation is finished.
 */
export function acquireProviderLock(jobDir: string, id: string, now: () => number = Date.now): HeavyProviderLock {
  const providerDir = lockDirectory(jobDir, id)
  for (let attempt = 0; attempt < MAX_ACQUIRE_ATTEMPTS; attempt += 1) {
    try {
      mkdirSync(providerDir, { recursive: true, mode: 0o700 })
    } catch (error) {
      throw new HeavyProviderLockUnreadableError(providerDir, `cannot be created (${errorMessage(error)})`)
    }
    const existing = readGenerations(providerDir, id)
    const highest = existing.at(-1)
    let generation = 1
    if (highest !== undefined) {
      if (highest.status === 'held' && highest.parsed !== undefined) {
        throw new HeavyProviderLockedError(highest.path, highest.parsed.owner)
      }
      if (highest.status === 'unverifiable') {
        throw new HeavyProviderLockUnreadableError(highest.path, highest.reason ?? 'cannot be verified')
      }
      if (highest.generation >= MAX_GENERATION) {
        throw new HeavyProviderLockUnreadableError(highest.path, 'exhausted the generation name space')
      }
      generation = highest.generation + 1
    }
    const owner: HeavyProviderLockOwner = {
      id,
      token: randomUUID(),
      pid: process.pid,
      startedAt: now(),
      processStart: ownProcessStart(),
    }
    const content = JSON.stringify({ version: LOCK_VERSION, ...owner })
    const path = join(providerDir, `${String(generation).padStart(12, '0')}.lock`)
    const temporary = `${path}.tmp-${String(process.pid)}-${createHash('sha256').update(owner.token).digest('hex').slice(0, 12)}`
    try {
      writeFileSync(temporary, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
      try {
        // The hard link is the atomic exclusive create: complete content is
        // visible under the generation name or the link fails with EEXIST.
        linkSync(temporary, path)
      } catch (error) {
        if (errorCode(error) === 'EEXIST') continue
        throw new HeavyProviderLockUnreadableError(path, `cannot be created (${errorMessage(error)})`)
      }
    } catch (error) {
      if (error instanceof HeavyProviderLockUnreadableError) throw error
      throw new HeavyProviderLockUnreadableError(path, `cannot be written (${errorMessage(error)})`)
    } finally {
      try {
        unlinkSync(temporary)
      } catch {
        // A leftover temporary file is ignored by generation parsing.
      }
    }
    liveTokens.set(owner.token, owner)
    removeDeadGenerations(existing, path)
    return new HeavyProviderLock(path, owner, content)
  }
  throw new HeavyProviderLockedError(providerDir)
}
