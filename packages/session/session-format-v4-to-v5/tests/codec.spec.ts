/** V5 physical framing, header stamping, and native row admission. */

import { describe, expect, it } from 'vitest'
import { SessionFormatEventCollector } from '@deepseek-ai/dsh-session-format'
import type { SessionFormatEvent, SessionFormatHeader } from '@deepseek-ai/dsh-session-format'
import { assertV5RowAdmission, releasedV5SessionFormatCodec } from '../src/index.ts'

function physical(version = 5, extra: Record<string, unknown> = {}) {
  return {
    type: 'session',
    version,
    id: 'codec',
    createdAt: 1,
    isSeeded: false,
    delegationDepth: 0,
    ...extra,
  }
}

describe('releasedV5SessionFormatCodec', () => {
  it('decodes and encodes the V5 physical header', () => {
    expect(releasedV5SessionFormatCodec.decodeHeader(physical())).toEqual({
      version: 5, id: 'codec', createdAt: 1, isSeeded: false, delegationDepth: 0,
    })
    expect(releasedV5SessionFormatCodec.encodeHeader({
      version: 5, id: 'codec', createdAt: 1, isSeeded: false, delegationDepth: 0,
    }, 0)).toEqual(physical())
  })

  it('refuses a non-V5 physical header', () => {
    expect(() => releasedV5SessionFormatCodec.decodeHeader(physical(4))).toThrow(/expected format v5 physical header/)
  })

  it('refuses to encode a non-V5 logical header', () => {
    const header: SessionFormatHeader = { version: 4, id: 'codec', createdAt: 1, isSeeded: false, delegationDepth: 0 }
    expect(() => releasedV5SessionFormatCodec.encodeHeader(header, 0)).toThrow(/expected format v5 header/)
  })

  it('decodes rows with the V5 logical header and native admission', () => {
    const decoder = releasedV5SessionFormatCodec.createDecoder(physical(), 'strict')
    expect(decoder.header.version).toBe(5)
    const collector = new SessionFormatEventCollector()
    decoder.decodeRow({ type: 'feedback/record', seq: 0, time: 2, data: { text: 'kept' } }, collector)
    expect(decoder.finish(collector)).toBe(0)
    expect(collector.values).toEqual([{ type: 'feedback/record', seq: 0, time: 2, data: { text: 'kept' } }])
  })

  it('rejects a retired plugin source before decoding', () => {
    const decoder = releasedV5SessionFormatCodec.createDecoder(physical(), 'strict')
    expect(() => {
      decoder.decodeRow({
        type: 'user/message', seq: 0, time: 2, surfaceOp: 'append',
        data: { id: 'message', role: 'user', source: { kind: 'plugin', plugin: 'x' }, content: [] },
      }, new SessionFormatEventCollector())
    }).toThrow(/producer-owned source kind/)
  })

  it('encodes current events through the released V4 encoder', () => {
    const event: SessionFormatEvent = { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } }
    expect(releasedV5SessionFormatCodec.encodeEvent(event)).toEqual(event)
  })
})

describe('assertV5RowAdmission', () => {
  it('delegates to native V4 row admission', () => {
    expect(() => { assertV5RowAdmission({ type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } }) }).not.toThrow()
    expect(() => {
      assertV5RowAdmission({
        type: 'user/message', seq: 0, time: 1, surfaceOp: 'append',
        data: { id: 'message', role: 'user', source: { kind: 'plugin', plugin: 'x' }, content: [] },
      })
    }).toThrow(/producer-owned source kind/)
    expect(() => {
      assertV5RowAdmission(
        { type: 'developer/message', seq: 0, time: 1, surfaceOp: 'append', ignorable: true, data: {} },
        new Set(),
      )
    }).not.toThrow()
  })
})
