/** Request-header canonicalization, equality, and snapshot folding. */

import { describe, expect, it } from 'vitest'
import { Session, SessionId, SessionSeq, canonicalHeader, foldRequestHeader, headerEquals } from '@deepseek-ai/dsh-session'
import type { EpochHeader, SessionEvent } from '@deepseek-ai/dsh-session'
import { createUserMessage, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { LlmNativeFileInputs, ToolSchema } from '@deepseek-ai/dsh-llm'

const CONFIG = { provider: 'mock', model: 'm' }

function tool(name: string, description = 'd'): ToolSchema {
  return { name, description, parameters: { type: 'object' } }
}

describe('canonicalHeader', () => {
  it('normalizes empty optional fields to absence and preserves populated fields', () => {
    expect(canonicalHeader({
      config: CONFIG,
      adapterDefaults: {},
      tools: [],
    })).toEqual({ config: CONFIG })
    const full = canonicalHeader({
      config: { ...CONFIG, maxTokens: 256_000 },
      adapterDefaults: { maxTokens: true },
      tools: [tool('a')],
    })
    expect(full).toEqual({
      config: { ...CONFIG, maxTokens: 256_000 },
      adapterDefaults: { maxTokens: true },
      tools: [tool('a')],
    })
  })
})

describe('headerEquals', () => {
  const base = canonicalHeader({ config: CONFIG, tools: [tool('a')] })

  it('compares every canonical field and preserves tool order', () => {
    expect(headerEquals(base, structuredClone(base))).toBe(true)
    expect(headerEquals(base, { ...base, config: { provider: 'mock', model: 'other' } })).toBe(false)
    expect(headerEquals(base, {
      ...base,
      config: { ...base.config, reasoningEffort: ReasoningEffortId('high') },
    })).toBe(false)
    expect(headerEquals(
      { ...base, config: { ...base.config, maxTokens: 256_000 } },
      {
        ...base,
        config: { ...base.config, maxTokens: 256_000 },
        adapterDefaults: { maxTokens: true },
      },
    )).toBe(false)
    expect(headerEquals(base, { ...base, tools: [] })).toBe(false)
    expect(headerEquals(base, { ...base, tools: [tool('a', 'changed')] })).toBe(false)
    expect(headerEquals({ config: CONFIG, tools: [tool('a'), tool('b')] }, { config: CONFIG, tools: [tool('b'), tool('a')] })).toBe(false)
  })

  it('treats absent and empty tool arrays as equivalent canonical absence', () => {
    expect(headerEquals({ config: CONFIG }, { config: CONFIG, tools: [] })).toBe(true)
    expect(headerEquals({ config: CONFIG, tools: [] }, { config: CONFIG })).toBe(true)
    expect(headerEquals({ config: CONFIG }, { config: CONFIG })).toBe(true)
  })
})

describe('foldRequestHeader', () => {
  it('returns the supplied baseline when no snapshot follows', () => {
    const from: EpochHeader = { config: CONFIG, tools: [tool('baseline')] }
    const unrelated: SessionEvent[] = [
      { type: 'turn/start', seq: SessionSeq(0), time: 1, data: { turn: 1 } },
    ]
    expect(foldRequestHeader(unrelated)).toBeUndefined()
    expect(foldRequestHeader(unrelated, from)).toBe(from)
  })

  it('takes the latest full snapshot and skips unrelated events', () => {
    const session = Session.create(SessionId('fold'))
    session.append('turn/start', { turn: 1 })
    session.append('request/header', { header: { config: CONFIG, tools: [tool('first')] }, reason: 'initial' })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('request/header', { header: { config: { provider: 'mock', model: 'other' } }, reason: 'change' })
    expect(foldRequestHeader(session.snapshotEvents())).toEqual({ config: { provider: 'mock', model: 'other' } })
  })
})

describe('Session.requestContext', () => {
  const CAPACITY = { provider: 'mock', model: 'm', contextWindow: 128_000 }
  const NATIVE_INPUTS: LlmNativeFileInputs = {
    version: 1,
    encoders: { 'application/pdf': 'anthropic-document' },
    perFileBytes: 1_000,
    totalBytes: 2_000,
    maxPayloadBytes: 3_000,
    tokenReserve: { perFile: 10, perByte: 0.25 },
  }

  /** A turn-enclosed capacity record; the invariant rejects one outside a turn. */
  function seedWith(
    ...records: { provider: string; model: string; contextWindow?: number; nativeFileInputs?: LlmNativeFileInputs }[]
  ): SessionEvent[] {
    const events: SessionEvent[] = [{
      type: 'turn/start', seq: SessionSeq(0), time: 1, data: { turn: 1 },
    }]
    for (const data of records) {
      events.push({ type: 'request/context', seq: SessionSeq(events.length), time: 1, data })
    }
    return events
  }

  it('reads undefined before any record exists', () => {
    expect(Session.create(SessionId('no-capacity')).requestContext()).toBeUndefined()
  })

  it('folds a seeded log on first read, taking the last record', () => {
    // The fold watermark starts at 0 with the seed already in the log, so the
    // first read must consume the whole seed rather than skip it.
    const session = Session.create(SessionId('seeded-capacity'), seedWith(
      CAPACITY,
      { ...CAPACITY, model: 'later', contextWindow: 256_000 },
    ))
    expect(session.requestContext()).toEqual({ provider: 'mock', model: 'later', contextWindow: 256_000 })
  })

  it('advances incrementally across appends and skips unrelated events', () => {
    const session = Session.create(SessionId('incremental-capacity'), seedWith(CAPACITY))
    expect(session.requestContext()).toEqual(CAPACITY)
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'unrelated' }], source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    expect(session.requestContext()).toEqual(CAPACITY)
    session.append('request/context', { ...CAPACITY, model: 'next', contextWindow: 64_000 })
    expect(session.requestContext()).toEqual({ provider: 'mock', model: 'next', contextWindow: 64_000 })
    session.append('request/context', { provider: 'mock', model: 'unknown' })
    expect(session.requestContext()).toEqual({ provider: 'mock', model: 'unknown' })
  })

  it('folds a batch appended between two reads', () => {
    const session = Session.create(SessionId('batched-capacity'), seedWith(CAPACITY))
    expect(session.requestContext()).toEqual(CAPACITY)
    session.append('request/context', { ...CAPACITY, contextWindow: 200_000 })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'unrelated' }], source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('request/context', { ...CAPACITY, contextWindow: 300_000 })
    expect(session.requestContext()?.contextWindow).toBe(300_000)
  })

  it('exposes a frozen record so a reader cannot desync later comparisons', () => {
    const session = Session.create(SessionId('frozen-capacity'), seedWith(CAPACITY))
    const held = session.requestContext()
    if (held === undefined) throw new Error('expected a folded capacity record')
    expect(Object.isFrozen(held)).toBe(true)
    expect(() => { (held as { contextWindow?: number }).contextWindow = 1 }).toThrow()
  })

  it('roundtrips an optional native-file descriptor and accepts records without one', () => {
    const withMedia = Session.create(SessionId('native-capacity'), seedWith({
      ...CAPACITY,
      nativeFileInputs: NATIVE_INPUTS,
    }))
    const folded = withMedia.requestContext()
    expect(folded).toEqual({ ...CAPACITY, nativeFileInputs: NATIVE_INPUTS })
    expect(Object.isFrozen(folded)).toBe(true)
    expect(Object.isFrozen(folded?.nativeFileInputs)).toBe(true)
    expect(Object.isFrozen(folded?.nativeFileInputs?.encoders)).toBe(true)
    expect(Object.isFrozen(folded?.nativeFileInputs?.tokenReserve)).toBe(true)
    expect(Session.create(SessionId('old-capacity'), seedWith(CAPACITY)).requestContext()).toEqual(CAPACITY)
  })

  it('rejects invalid native-file descriptors before appending', () => {
    const session = Session.create(SessionId('invalid-native-capacity'), seedWith(CAPACITY))
    const before = session.snapshotEvents().length
    expect(() => session.append('request/context', {
      ...CAPACITY,
      nativeFileInputs: { ...NATIVE_INPUTS, version: 2 },
    } as never)).toThrow(/nativeFileInputs.*version/)
    expect(() => session.append('request/context', {
      ...CAPACITY,
      nativeFileInputs: { ...NATIVE_INPUTS, encoders: { 'application/pdf': 'openai-chat-input-audio' } },
    } as never)).toThrow(/nativeFileInputs.*incompatible/)
    expect(session.snapshotEvents()).toHaveLength(before)
  })

  it('validates request/context payload fields before appending', () => {
    const session = Session.create(SessionId('invalid-request-context'), seedWith(CAPACITY))
    const before = session.snapshotEvents().length
    const invalid = [
      [null, /data must be an object/],
      [{}, /nonempty provider/],
      [{ provider: '', model: 'mock' }, /nonempty provider/],
      [{ provider: 'mock' }, /nonempty model/],
      [{ provider: 'mock', model: '' }, /nonempty model/],
      [{ provider: 'mock', model: 'mock', contextWindow: 0 }, /contextWindow/],
      [{ provider: 'mock', model: 'mock', contextWindow: 1.5 }, /contextWindow/],
      [{ provider: 'mock', model: 'mock', contextWindow: -1 }, /contextWindow/],
      [{ provider: 'mock', model: 'mock', contextWindow: 'big' }, /contextWindow/],
      [{ provider: 'mock', model: 'mock', systemPromptUpdate: 'latest' }, /systemPromptUpdate/],
    ] as const
    for (const [data, error] of invalid) {
      expect(() => session.append('request/context', data as never)).toThrow(error)
    }
    expect(session.snapshotEvents()).toHaveLength(before)
    expect(() => session.append('request/context', {
      provider: 'mock', model: 'mock', contextWindow: 1, systemPromptUpdate: 'in-history',
    })).not.toThrow()
  })

  it('rejects invalid native-file descriptors on restore', () => {
    expect(() => Session.create(SessionId('invalid-native-restore'), seedWith(
      CAPACITY,
      {
        ...CAPACITY,
        nativeFileInputs: {
          ...NATIVE_INPUTS,
          encoders: { 'application/pdf': 'openai-chat-input-audio' },
        },
      },
    ))).toThrow(/nativeFileInputs.*incompatible/)
  })
})
