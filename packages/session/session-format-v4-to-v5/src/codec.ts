/** V5 framing with native V4 row admission and released physical rows. */

import { SessionFormatError, isSessionFormatJsonObject } from '@deepseek-ai/dsh-session-format'
import type {
  SessionFormatCodec,
  SessionFormatCurrentEncoder,
  SessionFormatEvent,
  SessionFormatHeader,
  SessionFormatMigrationContext,
} from '@deepseek-ai/dsh-session-format'
import {
  assertV4RowAdmission,
  releasedV4SessionFormatCodec,
} from '@deepseek-ai/dsh-session-format-v3-to-v4'
import { assertReleasedV5Header } from './validation.ts'

function physicalV4(value: unknown): SessionFormatHeader {
  if (!isSessionFormatJsonObject(value) || value['version'] !== 5) {
    throw new SessionFormatError('expected format v5 physical header')
  }
  return { ...value, version: 4 } as SessionFormatHeader
}

/**
 * V5 physical encoder and decoder retain the released row framing and native
 * V4 row admission while stamping the V5 logical version.
 */
export const releasedV5SessionFormatCodec = Object.freeze({
  version: 5,
  decodeHeader(value: unknown) {
    return { ...releasedV4SessionFormatCodec.decodeHeader(physicalV4(value)), version: 5 }
  },
  createDecoder(value: unknown, recovery) {
    const decoder = releasedV4SessionFormatCodec.createDecoder(physicalV4(value), recovery)
    return {
      ...decoder,
      header: { ...decoder.header, version: 5 },
      decodeRow(row: unknown, context: SessionFormatMigrationContext) {
        assertV5RowAdmission(row)
        decoder.decodeRow(row, context)
      },
    }
  },
  encodeHeader(header: SessionFormatHeader, inheritedEventCount: number) {
    assertReleasedV5Header(header)
    return {
      ...releasedV4SessionFormatCodec.encodeHeader({ ...header, version: 4 }, inheritedEventCount),
      version: 5,
    }
  },
  encodeEvent(event: SessionFormatEvent) {
    assertV5RowAdmission(event)
    return releasedV4SessionFormatCodec.encodeEvent(event)
  },
} satisfies SessionFormatCodec & SessionFormatCurrentEncoder)

/**
 * Apply native V4 row admission to one V5 row before framing or tail recovery.
 * @param row - parsed physical row before framing and source-event range decoding.
 * @param knownEventTypes - installed event types, supplied by native readers before tail recovery.
 */
export function assertV5RowAdmission(row: unknown, knownEventTypes?: ReadonlySet<string>): void {
  assertV4RowAdmission(row, knownEventTypes)
}
