/** Catalog wiring for the V4-to-V5 edge: classification, migration, and refusal. */

import { describe, expect, it } from 'vitest'
import { sessionFormatCatalog } from '@deepseek-ai/dsh-session-format-catalog'
import { SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import type { SessionFormatEvent } from '@deepseek-ai/dsh-session-format'

const header = { type: 'session', version: 4, id: 'catalog', createdAt: 1, isSeeded: false, delegationDepth: 0 }

function rows(): SessionFormatEvent[] {
  return [
    { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
    { type: 'step/start', seq: 1, time: 2, data: { turn: 1, step: 1 } },
    {
      type: 'user/message', seq: 2, time: 3, surfaceOp: 'append',
      data: {
        id: 'user', role: 'user', source: { kind: 'model-selection', selection: 'legacy' },
        content: [{ type: 'text', text: 'hello' }],
      },
    },
    { type: 'step/end', seq: 3, time: 4, data: { turn: 1, step: 1 } },
    { type: 'turn/end', seq: 4, time: 5, data: { turn: 1, reason: { kind: 'completed' } } },
  ]
}

describe('V5 catalog wiring', () => {
  it('reaches the checkout writer through exactly one adjacent edge', () => {
    expect(SESSION_FORMAT_VERSION).toBe(5)
    expect(sessionFormatCatalog.currentVersion).toBe(5)
    expect(sessionFormatCatalog.readHeader(header)).toMatchObject({
      status: 'migration-required', storedVersion: 4, targetVersion: 5, header: { version: 5 },
    })
  })

  it('refuses a future generation without fallback', () => {
    expect(sessionFormatCatalog.readHeader({ ...header, version: 6 })).toMatchObject({
      status: 'unsupported', storedVersion: 6, targetVersion: 5,
    })
    expect(() => sessionFormatCatalog.createRestore({ ...header, version: 6 }, {
      recovery: 'strict', validation: 'current',
    })).toThrow(/newer format v6/)
  })

  it('restores a canonical V4 log as V5 with byte-identical events', () => {
    const source = rows()
    const restore = sessionFormatCatalog.createRestore(header, { recovery: 'strict', validation: 'current' })
    for (const row of source) restore.decodeRow(row)
    const artifact = restore.finish()
    expect(artifact.header).toEqual({ version: 5, id: 'catalog', createdAt: 1, isSeeded: false, delegationDepth: 0 })
    expect(artifact.events).toEqual(source)
    expect(artifact.inheritedEventCount).toBe(0)
  })
})
