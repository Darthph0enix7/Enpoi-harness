import { describe, expect, it } from 'vitest'
import { SessionFormatEventCollector } from '@deepseek-ai/dsh-session-format'
import type { SessionFormatArtifact, SessionFormatEvent, SessionFormatHeader } from '@deepseek-ai/dsh-session-format'
import { KNOWN_SESSION_EVENT_TYPES } from '@deepseek-ai/dsh-session'
import {
  OPAQUE_FORK_V3_EVENT_TYPES,
  createSessionFormatV3ToV4,
  namespaceV3OpaqueEvent,
  restoreReleasedV4Artifact,
  sessionFormatV3ToV4,
} from '../src/index.ts'

const header: SessionFormatHeader = { version: 3, id: 'fork-vocabulary', createdAt: 1, isSeeded: false, delegationDepth: 0 }

function migrate(events: readonly SessionFormatEvent[]) {
  const stage = createSessionFormatV3ToV4([]).createStage({
    sourceHeader: header,
    targetHeader: sessionFormatV3ToV4.migrateHeader(header),
    sourceInheritedEventCount: undefined,
    sourceKind: 'decoded',
  })
  const output = new SessionFormatEventCollector()
  for (const event of events) stage.transformEvent(event, output)
  return { events: output.values, cut: stage.finish(output) }
}

describe('installed fork vocabulary on the V3 to V4 edge', () => {
  it('keeps every fork name exact instead of namespacing it to plugin:', () => {
    for (const type of OPAQUE_FORK_V3_EVENT_TYPES) {
      expect(namespaceV3OpaqueEvent({ type, seq: 0, time: 1, data: {} })).toEqual({ type, seq: 0, time: 1, data: {} })
      expect(namespaceV3OpaqueEvent({ type, seq: 0, time: 1, data: {}, ignorable: true }))
        .toEqual({ type, seq: 0, time: 1, data: {}, ignorable: true })
    }
    expect(namespaceV3OpaqueEvent({ type: 'external/future', seq: 0, time: 1, data: {}, ignorable: true }))
      .toEqual({ type: 'plugin:external/future', seq: 0, time: 1, data: {}, ignorable: true })
  })

  it('admits fork events whose V3-era writer omitted ignorable, with owner-opaque payloads', () => {
    const rows: SessionFormatEvent[] = [
      { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
      { type: 'revert/state', seq: 1, time: 2, data: { fromSeq: 4, cause: 'revert' } },
      { type: 'brief/prose-updated', seq: 2, time: 3, data: { vendor: { nested: true } } },
      { type: 'llm/attempt-failed', seq: 3, time: 4, data: { provider: 'p', model: 'm', code: 'ECONNRESET', message: 'reset' } },
      { type: 'state/checkpoint', seq: 4, time: 5, data: { keys: ['a'] } },
      { type: 'verify/unmet', seq: 5, time: 6, data: { items: [1, 2] }, ignorable: true },
      { type: 'turn/end', seq: 6, time: 7, data: { turn: 1, reason: { kind: 'completed' } } },
    ]
    const before = structuredClone(rows)
    const { events } = migrate(rows)
    expect(events.map(event => event.type)).toEqual(rows.map(event => event.type))
    for (const [index, row] of rows.entries()) {
      if (OPAQUE_FORK_V3_EVENT_TYPES.has(row.type)) {
        expect(events[index]).toEqual({ ...row, ignorable: true })
      }
    }
    expect(rows).toEqual(before)
  })

  it('still refuses a genuinely unknown required V3 event', () => {
    expect(() => migrate([{ type: 'external/required', seq: 0, time: 1, data: {} }]))
      .toThrow('format v3 contains unknown event type "external/required" at seq 0')
  })

  it('restores migrated fork vocabulary under the installed event vocabulary', () => {
    const { events } = migrate([
      { type: 'revert/state', seq: 0, time: 1, data: { fromSeq: null } },
      { type: 'council/round', seq: 1, time: 2, data: { round: 1 } },
      { type: 'llm/attempt-failed', seq: 2, time: 3, data: { provider: 'p', model: 'm', code: 'E', message: 'm' } },
      { type: 'verify/unmet', seq: 3, time: 4, data: {}, ignorable: true },
    ])
    const artifact: SessionFormatArtifact = {
      header: { version: 4, id: header.id, createdAt: 1, isSeeded: false, delegationDepth: 0 },
      inheritedEventCount: 0,
      events,
    }
    expect(() => restoreReleasedV4Artifact(artifact, KNOWN_SESSION_EVENT_TYPES)).not.toThrow()
    expect(artifact.events.map(event => event.type))
      .toEqual(['revert/state', 'council/round', 'llm/attempt-failed', 'verify/unmet'])
  })
})
