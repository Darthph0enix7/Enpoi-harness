/**
 * enpoi-update-check — the dismissed-version record.
 *
 * One small JSON document under `$DSH_HOME/update-check/dismissed.json`
 * (`{ version, at }`). Writes are atomic (tmp file + rename) and every read or
 * write failure degrades to "nothing dismissed" so the check never fails on
 * storage.
 *
 * @module dsh-enpoi-update-check/store
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** The persisted skip record. */
export interface DismissedRecord {
  /** Dismissed release version (`0.1.7-enpoi.2.84`). */
  version: string
  /** When the skip was recorded, ISO 8601. */
  at: string
}

/**
 * Read the dismissed version, or null when absent or unreadable.
 *
 * @param file - dismissed.json path.
 * @returns the dismissed version string, or null.
 */
export function readDismissedVersion(file: string): string | null {
  try {
    const record = JSON.parse(readFileSync(file, 'utf8')) as { version?: unknown }
    return typeof record.version === 'string' && record.version !== '' ? record.version : null
  } catch {
    return null
  }
}

/**
 * Persist the dismissed version atomically; a write failure is silent.
 *
 * @param file - dismissed.json path.
 * @param version - dismissed release version.
 * @param now - clock for the `at` timestamp.
 * @returns true when the record was written.
 */
export function writeDismissedVersion(file: string, version: string, now: () => Date = () => new Date()): boolean {
  try {
    mkdirSync(dirname(file), { recursive: true })
    const temporary = `${file}.tmp.${process.pid}`
    writeFileSync(temporary, `${JSON.stringify({ version, at: now().toISOString() }, null, 2)}\n`)
    renameSync(temporary, file)
    return true
  } catch {
    return false
  }
}
