/** Native V5 header, vocabulary, source, cut, and delivery validation. */

import { describe, expect, it } from 'vitest'
import {
  SessionFormatUnsupportedMigrationError,
} from '@deepseek-ai/dsh-session-format'
import type {
  SessionFormatArtifact,
  SessionFormatEvent,
  SessionFormatHeader,
  SessionFormatJsonObject,
} from '@deepseek-ai/dsh-session-format'
import {
  assertReleasedV5Header,
  assertReleasedV5Relationships,
  restoreReleasedV5Artifact,
} from '../src/index.ts'

const KNOWN = new Set([
  'turn/start', 'step/start', 'assistant/message', 'tool/call', 'tool/result',
  'step/end', 'turn/end', 'user/message', 'session/end-seed', 'approval/decided',
  'session-log-deepseek/delivery-accepted', 'feedback/record',
])

function header(overrides: Partial<Record<string, unknown>> = {}): SessionFormatHeader {
  return {
    version: 5,
    id: 'v5-session',
    createdAt: 1,
    isSeeded: false,
    delegationDepth: 0,
    ...overrides,
  }
}

function artifact(
  events: readonly SessionFormatEvent[],
  h: SessionFormatHeader = header(),
  inherited = 0,
): SessionFormatArtifact {
  return {
    header: h,
    inheritedEventCount: inherited,
    events,
  }
}

function message(id: string, role: string, source: SessionFormatJsonObject, text = 'kept'): SessionFormatJsonObject {
  return { id, role, source, content: [{ type: 'text', text }] }
}

/** One canonical turn using the legacy producer and approval vocabulary. */
function conversation(): SessionFormatEvent[] {
  return [
    { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
    { type: 'step/start', seq: 1, time: 2, data: { turn: 1, step: 1 } },
    {
      type: 'user/message', seq: 2, time: 3, surfaceOp: 'append',
      data: message('user-1', 'user', { kind: 'user-approval', approvalId: 'approval' }),
    },
    { type: 'approval/decided', seq: 3, time: 4, data: { id: 'approval', outcome: 'allowed-always-broad' } },
    {
      type: 'assistant/message', seq: 4, time: 5, surfaceOp: 'append',
      data: {
        turn: 1, step: 1,
        message: message('assistant-1', 'assistant', { kind: 'model', provider: 'mock', model: 'mock' }),
        stream: [],
      },
    },
    { type: 'step/end', seq: 5, time: 6, data: { turn: 1, step: 1 } },
    { type: 'turn/end', seq: 6, time: 7, data: { turn: 1, reason: { kind: 'completed' } } },
  ]
}

describe('assertReleasedV5Header', () => {
  it('accepts minimal and complete headers', () => {
    expect(() => { assertReleasedV5Header(header()) }).not.toThrow()
    expect(() => { assertReleasedV5Header(header({
      cwd: '/work', parentSession: 'parent', origin: 'subagent', agentPreset: 'headless', isSeeded: true,
    })) }).not.toThrow()
  })

  it.each<[string, Record<string, unknown>, RegExp]>([
    ['wrong version', { ...header(), version: 4 }, /expected format v5/],
    ['non-string id', { ...header(), id: 3 }, /id must be a string/],
    ['non-count createdAt', { ...header(), createdAt: 'x' }, /createdAt/],
    ['negative delegationDepth', { ...header(), delegationDepth: -1 }, /delegationDepth/],
    ['non-boolean isSeeded', { ...header(), isSeeded: 1 }, /isSeeded must be boolean/],
    ['relative cwd', { ...header(), cwd: 'work' }, /cwd must be absolute/],
    ['non-string parentSession', { ...header(), parentSession: 3 }, /parentSession must be a string/],
    ['non-string agentPreset', { ...header(), agentPreset: 3 }, /agentPreset must be a string/],
    ['invalid origin', { ...header(), origin: 'other' }, /origin must be "subagent"/],
    ['unexpected field', { ...header(), extra: true }, /unexpected field extra/],
  ])('refuses %s', (_name, value, message) => {
    expect(() => { assertReleasedV5Header(value) }).toThrow(message)
  })
})

describe('restoreReleasedV5Artifact', () => {
  it('validates native sources, legacy outcomes, and dense envelopes', () => {
    const valid = artifact(conversation())
    expect(restoreReleasedV5Artifact(valid, KNOWN)).toBe(valid)
  })

  it('refuses malformed cuts and inherited markers', () => {
    expect(() => restoreReleasedV5Artifact(artifact(conversation(), header({ isSeeded: true }), 20), KNOWN))
      .toThrow(/inherited event count exceeds its events/)
    expect(() => restoreReleasedV5Artifact(artifact([
      { type: 'session/end-seed', seq: 0, time: 1, data: { inherited: true } },
    ], header(), 0), KNOWN)).toThrow(/format v5 unseeded Session contains an inherited end-seed marker/)
    expect(() => restoreReleasedV5Artifact(artifact(conversation(), header(), 1), KNOWN))
      .toThrow(/unseeded format v5 Session has inherited events/)
    const nonDense = conversation().map((event, index) => index === 2 ? { ...event, seq: 9 } : event)
    expect(() => restoreReleasedV5Artifact(artifact(nonDense), KNOWN)).toThrow(/is not dense/)
  })

  it('refuses unknown required events and preserves unknown ignorable events', () => {
    const required = { type: 'ordinary/external', seq: 0, time: 1, data: null }
    expect(() => restoreReleasedV5Artifact(artifact([required]), KNOWN))
      .toThrow(SessionFormatUnsupportedMigrationError)
    expect(() => restoreReleasedV5Artifact(artifact([required]), KNOWN)).toThrow(/unknown event type "ordinary\/external"/)
    const ignorable = { ...required, ignorable: true }
    expect(restoreReleasedV5Artifact(artifact([ignorable]), KNOWN).events).toEqual([ignorable])
  })

  it('validates only the current V5 delivery generation', () => {
    const fact = { type: 'feedback/record', seq: 0, time: 1, data: { text: 'owned' } }
    const delivery = (sessionFormatVersion: number, sessionId = 'v5-session') => ({
      type: 'session-log-deepseek/delivery-accepted', seq: 1, time: 2,
      data: { sessionId, throughSeq: 0, sessionFormatVersion },
    })
    expect(restoreReleasedV5Artifact(artifact([fact, delivery(5)]), KNOWN).events).toHaveLength(2)
    expect(restoreReleasedV5Artifact(artifact([fact, delivery(4, 'other-session')]), KNOWN).events).toHaveLength(2)
    expect(() => restoreReleasedV5Artifact(artifact([fact, delivery(5, 'other-session')]), KNOWN))
      .toThrow(/current-generation delivery marker names the wrong Session/)
  })
})

describe('assertReleasedV5Relationships', () => {
  it('applies V5 ownership to an already decoded artifact', () => {
    const valid = artifact(conversation())
    expect(() => { assertReleasedV5Relationships(valid, KNOWN) }).not.toThrow()
    expect(() => {
      assertReleasedV5Relationships(artifact([
        { type: 'turn/start', seq: 0, time: 1, data: { turn: 2 } },
      ]), KNOWN)
    }).toThrow(/turn\/start does not open the expected turn/)
  })
})
