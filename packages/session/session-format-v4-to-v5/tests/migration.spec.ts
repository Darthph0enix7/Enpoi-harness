/** Identity V4-to-V5 header conversion, body preservation, and refusal. */

import { describe, expect, it } from 'vitest'
import { SessionFormatEventCollector } from '@deepseek-ai/dsh-session-format'
import type {
  SessionFormatEvent,
  SessionFormatEventRun,
  SessionFormatHeader,
  SessionFormatMigrationContext,
} from '@deepseek-ai/dsh-session-format'
import { releasedV4SessionFormatCodec } from '@deepseek-ai/dsh-session-format-v3-to-v4'
import { sessionFormatV4ToV5 } from '../src/index.ts'

const header: SessionFormatHeader = { version: 4, id: 'identity', createdAt: 1, isSeeded: false, delegationDepth: 0 }
const fact: SessionFormatEvent = { type: 'feedback/record', seq: 0, time: 2, data: { text: 'retained' } }
const seedMarker: SessionFormatEvent = { type: 'session/end-seed', seq: 1, time: 3, data: { inherited: true } }

function stage(sourceHeader = header, sourceInheritedEventCount?: number) {
  return sessionFormatV4ToV5.createStage({
    sourceHeader,
    targetHeader: sessionFormatV4ToV5.migrateHeader(sourceHeader),
    sourceInheritedEventCount,
    sourceKind: 'decoded',
  })
}

function migrate(events: readonly SessionFormatEvent[], sourceHeader = header, cut?: number) {
  const current = stage(sourceHeader, cut)
  const output = new SessionFormatEventCollector()
  for (const event of events) current.transformEvent(event, output)
  return { events: output.values, cut: current.finish(output) }
}

describe('V4 to V5 header', () => {
  it('advances only the logical version', () => {
    expect(sessionFormatV4ToV5.migrateHeader(header)).toEqual({ ...header, version: 5 })
    expect(sessionFormatV4ToV5.migrateHeader({
      ...header, cwd: '/work', parentSession: 'parent', origin: 'subagent', agentPreset: 'headless', delegationDepth: 2,
    })).toEqual({
      ...header, version: 5, cwd: '/work', parentSession: 'parent', origin: 'subagent', agentPreset: 'headless', delegationDepth: 2,
    })
  })

  it('refuses a non-V4 source header', () => {
    expect(() => sessionFormatV4ToV5.migrateHeader({ ...header, version: 3 })).toThrow(/expected format v4 header/)
  })
})

describe('V4 to V5 body identity', () => {
  it('emits every event with unchanged coordinates, timestamps, and payloads', () => {
    const rows: SessionFormatEvent[] = [
      fact,
      {
        type: 'user/message', seq: 1, time: 3, surfaceOp: 'append',
        data: { id: 'legacy', role: 'user', source: { kind: 'user-approval', approvalId: 'a' }, content: [{ type: 'text', text: 'kept' }] },
      },
      {
        type: 'approval/decided', seq: 2, time: 4,
        data: { id: 'a', outcome: 'allowed-always-broad' },
      },
      {
        type: 'session-log-deepseek/delivery-accepted', seq: 3, time: 5,
        data: { sessionId: 'identity', throughSeq: 0, sessionFormatVersion: 4 },
      },
    ]
    const before = structuredClone(rows)
    const migrated = migrate(rows)
    expect(migrated).toEqual({ events: rows, cut: 0 })
    expect(migrated.events[0]).toBe(rows[0])
    expect(rows).toEqual(before)
  })

  it('forwards compact runs without expanding them', () => {
    const run: SessionFormatEventRun = {
      runType: 'test/run',
      firstSeq: 0,
      eventCount: 2,
      expand: () => [],
    }
    const runs: SessionFormatEventRun[] = []
    const context: SessionFormatMigrationContext = {
      emitEvent: () => { throw new Error('a compact run must not expand') },
      emitRun: emitted => runs.push(emitted),
    }
    stage().transformRun(run, context)
    expect(runs).toEqual([run])
    expect(runs[0]).toBe(run)
  })

  it('creates independent stages and is deterministic', () => {
    const seeded = { ...header, isSeeded: true }
    const first = stage(seeded)
    const second = stage(seeded)
    const left = new SessionFormatEventCollector()
    const right = new SessionFormatEventCollector()
    first.transformEvent(fact, left)
    first.transformEvent(seedMarker, left)
    second.transformEvent(fact, right)
    expect(migrate([fact, seedMarker], seeded).events).toEqual([fact, seedMarker])
    expect(left.values).toEqual([fact, seedMarker])
    expect(right.values).toEqual([fact])
  })
})

describe('V4 inherited cut', () => {
  it('declares zero for an unseeded source', () => {
    const current = stage()
    expect(current.headerInheritedEventCount).toBe(0)
    const output = new SessionFormatEventCollector()
    current.transformEvent(fact, output)
    expect(current.finish(output)).toBe(0)
  })

  it('takes the seeded cut from the last inherited marker', () => {
    const seeded = { ...header, isSeeded: true }
    const rows = [
      fact,
      { ...seedMarker, seq: 1 },
      { ...fact, seq: 2, time: 4 },
      { ...seedMarker, seq: 3, time: 5 },
    ] as SessionFormatEvent[]
    expect(migrate(rows, seeded)).toEqual({ events: rows, cut: 3 })
  })

  it('verifies a cut declared at construction', () => {
    const seeded = { ...header, isSeeded: true }
    const rows = [fact, seedMarker] as SessionFormatEvent[]
    expect(migrate(rows, seeded, 1).cut).toBe(1)
    expect(() => migrate(rows, seeded, 0)).toThrow(/inherited cut disagrees/)
  })

  it('refuses a seeded source without an inherited marker', () => {
    expect(() => migrate([fact], { ...header, isSeeded: true })).toThrow(/V4 inherited event count/)
  })

  it('refuses an inherited marker in an unseeded source', () => {
    expect(() => migrate([seedMarker])).toThrow(/unseeded format v4 Session contains an inherited end-seed marker/)
  })
})

describe('V4 source framing ownership', () => {
  it('reuses the released V4 source codec', () => {
    expect(sessionFormatV4ToV5.fromVersion).toBe(4)
    expect(sessionFormatV4ToV5.toVersion).toBe(5)
    expect(releasedV4SessionFormatCodec.version).toBe(4)
  })

  it('validates the V5 target header through the declaration', () => {
    expect(() => { sessionFormatV4ToV5.validateTargetHeader({ ...header, version: 5 }) }).not.toThrow()
    expect(() => { sessionFormatV4ToV5.validateTargetHeader(header) }).toThrow(/expected format v5 header/)
  })
})
