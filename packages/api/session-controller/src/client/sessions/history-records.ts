/** Client range access and type narrowing for aligned Session history records. */

import type {
  SessionHistoryRecord,
} from '../../types.ts'
import type { SessionEventLikeEntry } from '../contract/events.ts'

/**
 * Narrow aligned wire records to their Client event types without allocation.
 * @param records - validated history transport records.
 * @returns the same record array with typed inner events.
 */
export function historyEntries(
  records: readonly SessionHistoryRecord[],
): readonly SessionEventLikeEntry[] {
  return records as unknown as readonly SessionEventLikeEntry[]
}

/**
 * Keep only durable Client window entries as history transport records.
 * @param entries - current Client event-window entries.
 * @returns the contiguous durable records, without transient Assistant rows.
 */
export function durableHistoryRecords(
  entries: readonly SessionEventLikeEntry[],
): readonly SessionHistoryRecord[] {
  return entries.filter(entry => entry.type === 'event') as unknown as readonly SessionHistoryRecord[]
}

/**
 * Read the first logical sequence represented by one wire record.
 * @param record - validated Session event.
 * @returns inclusive first Session sequence.
 */
export function historyRecordFirstSeq(record: SessionHistoryRecord): number {
  return record.event.seq
}

/**
 * Read the final logical sequence represented by one wire record.
 * @param record - validated Session event.
 * @returns inclusive final Session sequence.
 */
export function historyRecordLastSeq(record: SessionHistoryRecord): number {
  return record.event.seq
}
