/**
 * enpoi-capabilities — Durable journal for parked forwarded child approvals.
 *
 * The idle-parent failsafe parks an ask when its root session sits between
 * turns (`forwarding.ts`). This module is the durable half: one JSON document
 * under the dsh home that the forwarder loads at boot (expiring records left
 * parked by a dead process, whose waiting child no longer exists) and upserts
 * on every park/resolve/expire/cancel transition. Writes are best-effort — a
 * failing journal never blocks an approval decision; the in-memory queue stays
 * authoritative for the running process.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { PARK_JOURNAL_SETTLED_KEEP, type ParkedAskRecord, type ParkJournal } from './forwarding'

/** Default journal location: `$HOME/.dsh/cache/approval-parks.json`. */
export const DEFAULT_APPROVAL_PARK_JOURNAL_PATH = join(homedir(), '.dsh', 'cache', 'approval-parks.json')

/** The one on-disk document form; `version` gates future migrations. */
interface ApprovalParkDocument {
  version: 1
  records: ParkedAskRecord[]
}

/** Read the document, treating an absent or unreadable file as "no records". */
function readDocument(path: string): ParkedAskRecord[] {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    // Absent on first boot and after an operate clears it; either way, empty.
    return []
  }
  try {
    const parsed = JSON.parse(raw) as Partial<ApprovalParkDocument>
    return Array.isArray(parsed.records) ? parsed.records.filter(isParkedAskRecord) : []
  } catch {
    // A truncated or hand-edited file must not take the forwarder down; the
    // records it carried are lost (already logged by the writer at crash time).
    return []
  }
}

/** Structural guard for records read from disk. */
function isParkedAskRecord(value: unknown): value is ParkedAskRecord {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return typeof record['id'] === 'string' && typeof record['childSessionId'] === 'string'
    && typeof record['rootSessionId'] === 'string' && typeof record['toolName'] === 'string'
    && typeof record['state'] === 'string' && typeof record['seq'] === 'number'
    && typeof record['expiresAt'] === 'number'
}

/** Drop the oldest settled records once the audit tail exceeds its bound. */
function prune(records: ParkedAskRecord[]): void {
  const settled = records.filter(record => record.state !== 'parked')
  const excess = settled.length - PARK_JOURNAL_SETTLED_KEEP
  if (excess <= 0) return
  const dropped = new Set(settled.slice(0, excess).map(record => record.id))
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const id = records[index]?.id
    if (id !== undefined && dropped.has(id)) records.splice(index, 1)
  }
}

/**
 * Open one journal over a JSON file. `load()` caches the parsed records;
 * `append()` upserts and rewrites the document atomically (temp + rename).
 * @param path - the journal file; defaults to {@link DEFAULT_APPROVAL_PARK_JOURNAL_PATH}.
 * @returns the journal seam the forwarder consumes.
 */
export function createApprovalParkJournal(path: string = DEFAULT_APPROVAL_PARK_JOURNAL_PATH): ParkJournal {
  let records: ParkedAskRecord[] | undefined
  const current = (): ParkedAskRecord[] => records ??= readDocument(path)
  return {
    load: () => [...current()],
    append: (record) => {
      const all = current()
      const existing = all.findIndex(entry => entry.id === record.id)
      if (existing >= 0) all[existing] = record
      else all.push(record)
      prune(all)
      try {
        mkdirSync(dirname(path), { recursive: true })
        const temporary = `${path}.tmp`
        writeFileSync(temporary, `${JSON.stringify({ version: 1, records: all }, null, 2)}\n`)
        renameSync(temporary, path)
      } catch {
        // The running process keeps its in-memory queue; only the cross-restart
        // audit record is lost, which must not fail the call being decided.
      }
    },
  }
}
