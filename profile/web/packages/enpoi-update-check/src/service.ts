/**
 * enpoi-update-check — the status machine and the check schedule.
 *
 * Decorator-free so the profile vitest pipeline exercises every transition:
 * `unknown` (never checked / fetch failed / malformed catalog) → `current` →
 * `available` → `dismissed(version)`, where a newer catalog version re-arms
 * `available`. A failed check preserves the last successful comparison and
 * records `error`; it never throws through a caller.
 *
 * @module dsh-enpoi-update-check/service
 */

import type { CatalogEntry, InstallIdentity } from './catalog.js'
import { commitsMatch, compareVersions } from './catalog.js'

/** The four indicator states. */
export type UpdateCheckState = 'unknown' | 'current' | 'available' | 'dismissed'

/** The latest-release summary carried to clients. */
export interface UpdateCheckLatest {
  readonly version: string
  readonly commit: string
  readonly releasedAt: string
  readonly notes: string[]
}

/** The full pollable status. */
export interface UpdateCheckStatus {
  readonly state: UpdateCheckState
  readonly current: {
    readonly version: string
    readonly commit: string
    readonly channel: string
  }
  readonly latest?: UpdateCheckLatest
  /** When the last check attempt finished, ISO 8601. */
  readonly checkedAt?: string
  /** Short failure reason for the last attempt; absent on success. */
  readonly error?: string
}

/** Construction inputs for {@link UpdateCheckCore}. */
export interface UpdateCheckCoreOptions {
  /** This install's identity, read from install-state.json. */
  readonly identity: InstallIdentity
  /** Fetch the catalog entries for the install's channel. */
  readonly fetchCatalog: (channel: string) => Promise<CatalogEntry[]>
  /** Read the persisted dismissed version, or null. */
  readonly readDismissed: () => string | null
  /** Persist the dismissed version (failure is silent). */
  readonly writeDismissed: (version: string) => void
  /** Clock for `checkedAt` and the `at` timestamp. */
  readonly now?: () => Date
  /**
   * Called once per failed attempt (transport, malformed document, empty
   * catalog, uncomparable versions). The plugin routes this to one debug log
   * line; tests use it to observe failure counts.
   */
  readonly onFailure?: (message: string) => void
}

function errorText(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`
  return String(error)
}

function cloneNotes(notes: readonly string[]): string[] {
  return [...notes]
}

/**
 * Collect release notes for all catalog entries strictly newer than
 * `currentVersion`, preserving newest-first order.
 *
 * When `currentVersion` is empty or uncomparable, falls back to the newest
 * entry's notes.
 */
export function collectUpdateNotes(
  entries: readonly CatalogEntry[],
  currentVersion: string,
): string[] {
  if (entries.length === 0) return []
  const newest = entries[0]
  if (newest === undefined) return []
  if (currentVersion === '') return cloneNotes(newest.notes)
  const notes: string[] = []
  for (const entry of entries) {
    if (compareVersions(currentVersion, entry.version) !== -1) {
      break
    }
    notes.push(...entry.notes)
  }
  return notes.length > 0 ? notes : cloneNotes(newest.notes)
}

/**
 * Owns the status snapshot. `checkNow` is single-flight: concurrent callers
 * (the boot timer and an operator's explicit refresh) share one fetch.
 */
export class UpdateCheckCore {
  private readonly options: UpdateCheckCoreOptions
  private readonly now: () => Date
  private status: UpdateCheckStatus
  private inFlight: Promise<UpdateCheckStatus> | null = null

  /**
   * @param options - identity, fetch, dismissal store, and clock.
   */
  constructor(options: UpdateCheckCoreOptions) {
    this.options = options
    this.now = options.now ?? (() => new Date())
    this.status = { state: 'unknown', current: { ...options.identity } }
  }

  /** The current status; a fresh object each call. */
  snapshot(): UpdateCheckStatus {
    return this.copy(this.status)
  }

  /**
   * Run one check. Never rejects: a transport, response, or catalog failure
   * resolves to the preserved state plus `error`.
   *
   * @returns the status after the attempt.
   */
  checkNow(): Promise<UpdateCheckStatus> {
    if (this.inFlight !== null) return this.inFlight
    this.inFlight = this.runCheck().finally(() => { this.inFlight = null })
    return this.inFlight
  }

  /**
   * Persist `version` as dismissed. When that version is the one currently
   * offered, the state becomes `dismissed` immediately.
   *
   * @param version - release version to skip.
   * @returns the status after recording the skip.
   */
  dismiss(version: string): UpdateCheckStatus {
    this.options.writeDismissed(version)
    if (this.status.state === 'available' && this.status.latest?.version === version) {
      this.status = { ...this.status, state: 'dismissed' }
    }
    return this.snapshot()
  }

  private async runCheck(): Promise<UpdateCheckStatus> {
    const checkedAt = this.now().toISOString()
    try {
      const entries = await this.options.fetchCatalog(this.options.identity.channel)
      const newest = entries[0]
      if (newest === undefined) {
        return this.fail(checkedAt, 'catalog carries no releases')
      }
      // Commit identity wins over the version string: a source-built install
      // stamped with the bare base version (`0.1.7-enpoi.2`, or `…+g<sha>`)
      // whose commit is the catalog target's commit is CURRENT, so it can
      // never be offered the same revision forever.
      if (commitsMatch(this.options.identity.commit, newest.commit)) {
        this.status = {
          state: 'current',
          current: { ...this.options.identity },
          latest: {
            version: newest.version,
            commit: newest.commit,
            releasedAt: newest.releasedAt,
            notes: collectUpdateNotes(entries, this.options.identity.version),
          },
          checkedAt,
        }
        return this.snapshot()
      }
      const comparison = compareVersions(this.options.identity.version, newest.version)
      if (comparison === null) {
        return this.fail(
          checkedAt,
          `uncomparable versions: ${JSON.stringify(this.options.identity.version)} vs ${JSON.stringify(newest.version)}`,
        )
      }
      const dismissed = this.options.readDismissed()
      const state: UpdateCheckState = comparison >= 0
        ? 'current'
        : dismissed === newest.version ? 'dismissed' : 'available'
      this.status = {
        state,
        current: { ...this.options.identity },
        latest: {
          version: newest.version,
          commit: newest.commit,
          releasedAt: newest.releasedAt,
          notes: collectUpdateNotes(entries, this.options.identity.version),
        },
        checkedAt,
      }
      return this.snapshot()
    } catch (error) {
      return this.fail(checkedAt, errorText(error))
    }
  }

  /** Record one failed attempt: keep the last comparison, set `error`, notify once. */
  private fail(checkedAt: string, error: string): UpdateCheckStatus {
    this.options.onFailure?.(error)
    this.status = { ...this.status, checkedAt, error }
    return this.snapshot()
  }

  private copy(status: UpdateCheckStatus): UpdateCheckStatus {
    return {
      state: status.state,
      current: { ...status.current },
      ...(status.latest === undefined ? {} : { latest: { ...status.latest, notes: cloneNotes(status.latest.notes) } }),
      ...(status.checkedAt === undefined ? {} : { checkedAt: status.checkedAt }),
      ...(status.error === undefined ? {} : { error: status.error }),
    }
  }
}

/** Timer seam for {@link startUpdateCheckSchedule}. */
export interface UpdateCheckTimers {
  setTimeout: (handler: () => void, delayMs: number) => ReturnType<typeof setTimeout>
  clearTimeout: (handle: ReturnType<typeof setTimeout>) => void
}

/** Scheduling inputs for {@link startUpdateCheckSchedule}. */
export interface UpdateCheckScheduleOptions {
  /** The check to run (errors are the callback's own business). */
  readonly run: () => void | Promise<void>
  /** Interval between checks, milliseconds. */
  readonly intervalMs: number
  /** Jitter bound added to the boot delay and every interval, milliseconds. */
  readonly jitterMs: number
  /** Delay before the first check, milliseconds (default 30 s). */
  readonly firstDelayMs?: number
  /** Random source in [0, 1); injectable for tests. */
  readonly random?: () => number
  /** Timer seam; injectable for tests. */
  readonly timers?: UpdateCheckTimers
}

/** Boot delay: the "~30 s after boot" base of the first check. */
export const FIRST_CHECK_DELAY_MS = 30_000

/** One jittered delay: `baseMs` plus a random fraction of `jitterMs`. */
export function jitteredDelay(baseMs: number, jitterMs: number, random: () => number = Math.random): number {
  return baseMs + Math.floor(random() * Math.max(0, jitterMs))
}

/**
 * Start the check schedule: a jittered boot delay, then the interval (each
 * cycle re-jittered). The returned function cancels the pending timer and
 * stops the chain; a run already in flight is left alone.
 *
 * @param options - run callback, cadence, jitter, and test seams.
 * @returns the disposer.
 */
export function startUpdateCheckSchedule(options: UpdateCheckScheduleOptions): () => void {
  const timers = options.timers ?? {
    setTimeout: (handler: () => void, delayMs: number) => setTimeout(handler, delayMs),
    clearTimeout: (handle: ReturnType<typeof setTimeout>) => clearTimeout(handle),
  }
  const random = options.random ?? Math.random
  let disposed = false
  let handle: ReturnType<typeof setTimeout> | null = null

  const schedule = (delayMs: number): void => {
    if (disposed) return
    handle = timers.setTimeout(() => {
      if (disposed) return
      void options.run()
      schedule(jitteredDelay(options.intervalMs, options.jitterMs, random))
    }, delayMs)
    handle.unref?.()
  }

  schedule(jitteredDelay(options.firstDelayMs ?? FIRST_CHECK_DELAY_MS, options.jitterMs, random))
  return () => {
    disposed = true
    if (handle !== null) timers.clearTimeout(handle)
  }
}
