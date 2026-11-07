/** Raw Session journal transport and message-aligned pagination coverage. */

import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent, type AssistantStreamFrame } from '@deepseek-ai/dsh-agent'
import SessionStore from '@deepseek-ai/dsh-session'
import { LlmAttemptId, ToolCallId, createMessage, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { MessageSource } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import {
  DEFAULT_SESSION_FOLLOW_BUFFER_LIMITS,
  SessionHistoryController,
} from '@deepseek-ai/dsh-api-session-controller/src/history.ts'
import type { SessionObservation } from '@deepseek-ai/dsh-session-query'
import { SessionLogOffset, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionFollowFrame, SessionPage, SessionWireEvent } from '@deepseek-ai/dsh-api-session-controller/types'
import { createSessionTestRemote, installSessionReadTestServices } from './test-remote.ts'

type CheckpointSource = Extract<MessageSource, { readonly kind: 'compact-checkpoint' }>

/** Build a typed checkpoint source for a journal fixture without owning compaction. */
function checkpointSource(compactionId: string): CheckpointSource {
  return { kind: 'compact-checkpoint', compactionId: compactionId as CheckpointSource['compactionId'] }
}
/** Append a production-shaped human prompt to the session surface. */
function appendUserText(session: Session, text: string): SessionEvent {
  return session.append('user/message', createUserMessage({
    content: [{ type: 'text', text }], source: { kind: 'user' },
  }), { surfaceOp: 'append' })
}

/** Append a production-shaped assistant message to the session surface. */
function appendAssistantText(session: Session, text: string, step: number, turn = 1): SessionEvent {
  return session.append('assistant/message', {
    turn,
    step,
    message: createMessage({
      role: 'assistant',
      content: [{ type: 'text', text }],
      source: { kind: 'model', provider: 'p', model: 'm' },
    }),
    stream: [{ type: 'text-chunks', time0: 1, index: 0, dt: [], texts: [text] }],
  }, { surfaceOp: 'append' })
}

/**
 * Append a plugin-owned log-only event. The host proxy is projection-only, so it
 * declares no compaction vocabulary; the cast writes the real event shape without
 * depending on the owning package.
 */
function appendExtension(session: Session, type: string, data: unknown): SessionEvent {
  return (session.append as unknown as (type: string, data: unknown) => SessionEvent)(type, data)
}

async function harness(): Promise<{ ctx: Context }> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  installSessionReadTestServices(ctx)
  return { ctx }
}

/** Drain one Session follow until `count` event frames arrive. */
async function collect(
  iterable: AsyncIterable<SessionFollowFrame>,
  count: number,
  abort: AbortController,
): Promise<SessionFollowFrame[]> {
  const frames: SessionFollowFrame[] = []
  for await (const frame of iterable) {
    frames.push(frame)
    if (frames.filter(candidate => candidate.type === 'event').length >= count) abort.abort()
  }
  return frames
}

/** Open follow and wait until its cursor is fixed before appending fixtures. */
async function openFollow(
  history: SessionHistoryController,
  sessionId: SessionId,
  signal: AbortSignal,
): Promise<AsyncIterable<SessionFollowFrame>> {
  const iterator = history.follow({
    address: { kind: 'session', sessionId },
  }, signal)[Symbol.asyncIterator]()
  await expect(iterator.next()).resolves.toMatchObject({
    done: false,
    value: { type: 'snapshot' },
  })
  return { [Symbol.asyncIterator]: () => iterator }
}

/** Abort one follow and await both its iterator and owning Context teardown. */
async function disposeFollow(
  ctx: Context,
  iterator: AsyncIterator<SessionFollowFrame>,
  abort: AbortController,
): Promise<void> {
  abort.abort()
  await iterator.return?.()
  await ctx.fiber.dispose()
}

/** Read scalar v2 page records for assertions over the logical journal. */
function pageEvents(page: SessionPage): SessionWireEvent[] {
  return page.records.map(record => record.event)
}

describe('Session history raw journal', () => {
  it('opens an empty opted-in Assistant baseline before any live attempt exists', async () => {
    const { ctx } = await harness()
    const session = ctx.sessions.create(undefined, { meta: { cwd: '/workspace' } })
    const history = new SessionHistoryController(ctx, (observation) => { observation[Symbol.dispose]() })
    const abort = new AbortController()
    const iterator = history.follow({
      address: { kind: 'session', sessionId: session.id },
      assistantStream: true,
    }, abort.signal)[Symbol.asyncIterator]()

    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: { type: 'snapshot', assistantStream: { revision: 0 } },
    })
    abort.abort()
    await iterator.next()
    await ctx.fiber.dispose()
  })

  it('filters foreign and opening-baseline frames buffered during the source observation', async () => {
    const { ctx } = await harness()
    const session = ctx.sessions.create(undefined, { meta: { cwd: '/workspace' } })
    const agent = { id: session.id, session, status: 'running', ctx } as Agent
    const history = new SessionHistoryController(ctx, (observation) => { observation[Symbol.dispose]() })
    const originalObserve = ctx.sessionQuery.observeSession.bind(ctx.sessionQuery)
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const observe = vi.spyOn(ctx.sessionQuery, 'observeSession').mockImplementation(async (...args) => {
      entered.resolve(undefined)
      await release.promise
      return originalObserve(...args)
    })
    const abort = new AbortController()
    const iterator = history.follow({
      address: { kind: 'session', sessionId: session.id },
      assistantStream: true,
    }, abort.signal)[Symbol.asyncIterator]()
    const opening = iterator.next()
    await entered.promise

    const attemptId = LlmAttemptId('buffered-opening-attempt')
    ctx.emit('agent/assistant-stream', {
      agent,
      frame: { type: 'start', attemptId, revision: 1, turn: 1, step: 1 },
    })
    ctx.emit('agent/assistant-stream', {
      agent,
      frame: {
        type: 'chunk', attemptId, revision: 2, index: 0,
        time: 2, chunk: { type: 'text-delta', index: 0, text: 'buffered' },
      },
    })
    const foreign = ctx.sessions.create(undefined, { meta: { cwd: '/workspace' } })
    ctx.emit('agent/assistant-stream', {
      agent: { id: foreign.id, session: foreign, status: 'running', ctx } as Agent,
      frame: {
        type: 'start', attemptId: LlmAttemptId('foreign-attempt'), revision: 1, turn: 1, step: 1,
      },
    })
    release.resolve(undefined)
    await expect(opening).resolves.toMatchObject({
      done: false,
      value: { type: 'snapshot', assistantStream: { revision: 2 } },
    })

    const next = iterator.next()
    const durable = session.append('turn/start', { turn: 1 })
    await expect(next).resolves.toEqual({ done: false, value: { type: 'event', event: durable } })
    abort.abort()
    await iterator.next()
    observe.mockRestore()
    await ctx.fiber.dispose()
  })

  it('opens an opted-in assistant baseline and preserves mixed live FIFO order', async () => {
    const { ctx } = await harness()
    const session = ctx.sessions.create(undefined, { meta: { cwd: '/workspace' } })
    const agent = { id: session.id, session, status: 'running', ctx } as Agent
    const history = new SessionHistoryController(ctx, (observation) => { observation[Symbol.dispose]() })
    const attemptId = LlmAttemptId('live-follow-attempt')
    const emit = (frame: AssistantStreamFrame): void => {
      ctx.emit('agent/assistant-stream', { agent, frame })
    }
    emit({
      type: 'start', attemptId, revision: 1,
      turn: 1, step: 1,
    })
    const firstChunk = { type: 'text-delta', index: 0, text: 'a' } as const
    emit({
      type: 'chunk', attemptId, revision: 2, index: 0,
      time: 1, chunk: firstChunk,
    })
    const abort = new AbortController()
    const iterator = history.follow({
      address: { kind: 'session', sessionId: session.id },
      assistantStream: true,
    }, abort.signal)[Symbol.asyncIterator]()

    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: {
        type: 'snapshot',
        assistantStream: {
          revision: 2,
          activeAttempt: {
            attemptId,
            startedAfterSeq: -1,
            turn: 1,
            step: 1,
            nextIndex: 1,
            stream: [{ type: 'text-chunks', time0: 1, index: 0, dt: [], texts: ['a'] }],
          },
        },
      },
    })
    const nextFrame: AssistantStreamFrame = {
      type: 'chunk', attemptId, revision: 3, index: 1,
      time: 2, chunk: { type: 'text-delta', index: 0, text: 'b' },
    }
    emit(nextFrame)
    const message = appendAssistantText(session, 'ab', 1)
    const endFrame: AssistantStreamFrame = {
      type: 'end', attemptId, revision: 4, index: 2,
      outcome: { kind: 'committed', eventType: 'assistant/message', seq: message.seq },
    }
    emit(endFrame)

    await expect(iterator.next()).resolves.toEqual({
      done: false, value: { type: 'assistant-stream', frame: nextFrame },
    })
    await expect(iterator.next()).resolves.toEqual({
      done: false, value: { type: 'event', event: message },
    })
    await expect(iterator.next()).resolves.toEqual({
      done: false, value: { type: 'assistant-stream', frame: endFrame },
    })
    abort.abort()
    await iterator.next()
    await ctx.fiber.dispose()
  })

  it('forwards revision one when the attached Agent lifecycle restarts after opening', async () => {
    const { ctx } = await harness()
    const session = ctx.sessions.create(undefined, { meta: { cwd: '/workspace' } })
    const agent = { id: session.id, session, status: 'running', ctx } as Agent
    const history = new SessionHistoryController(ctx, (observation) => { observation[Symbol.dispose]() })
    const attemptId = LlmAttemptId(`${session.id}:1`)
    ctx.emit('agent/assistant-stream', {
      agent,
      frame: {
        type: 'start', attemptId, revision: 1,
        turn: 1, step: 1,
      },
    })
    const oldChunk = { type: 'text-delta', index: 0, text: 'old' } as const
    ctx.emit('agent/assistant-stream', {
      agent,
      frame: {
        type: 'chunk', attemptId, revision: 2, index: 0,
        time: 101, chunk: oldChunk,
      },
    })
    const abort = new AbortController()
    const iterator = history.follow({
      address: { kind: 'session', sessionId: session.id },
      assistantStream: true,
    }, abort.signal)[Symbol.asyncIterator]()

    try {
      await expect(iterator.next()).resolves.toMatchObject({
        done: false,
        value: {
          type: 'snapshot',
          assistantStream: {
            revision: 2,
            activeAttempt: {
              attemptId,
              startedAfterSeq: -1,
              turn: 1,
              step: 1,
              nextIndex: 1,
              stream: [{ type: 'text-chunks', time0: 101, index: 0, dt: [], texts: ['old'] }],
            },
          },
        },
      })

      ctx.emit('agent/disposed', { agent })
      const replacementAgent = { id: session.id, session, status: 'running', ctx } as Agent
      const replacement: AssistantStreamFrame = {
        type: 'start', attemptId, revision: 1,
        turn: 2, step: 1,
      }
      ctx.emit('agent/assistant-stream', { agent: replacementAgent, frame: replacement })
      await expect(iterator.next()).resolves.toEqual({
        done: false,
        value: { type: 'assistant-stream', frame: { ...replacement, startedAfterSeq: -1 } },
      })
    } finally {
      await disposeFollow(ctx, iterator, abort)
    }
  })

  it('publishes an empty replacement baseline after an Agent frame revision gap', async () => {
    const { ctx } = await harness()
    const session = ctx.sessions.create(undefined, { meta: { cwd: '/workspace' } })
    const agent = { id: session.id, session, status: 'running', ctx } as Agent
    const history = new SessionHistoryController(ctx, (observation) => { observation[Symbol.dispose]() })
    const attemptId = LlmAttemptId('revision-gap-attempt')
    ctx.emit('agent/assistant-stream', {
      agent,
      frame: {
        type: 'start', attemptId, revision: 1,
        turn: 1, step: 1,
      },
    })
    const chunk = { type: 'text-delta', index: 0, text: 'after gap' } as const
    ctx.emit('agent/assistant-stream', {
      agent,
      frame: {
        type: 'chunk', attemptId, revision: 3, index: 0,
        time: 101, chunk,
      },
    })
    const abort = new AbortController()
    const iterator = history.follow({
      address: { kind: 'session', sessionId: session.id },
      assistantStream: true,
    }, abort.signal)[Symbol.asyncIterator]()

    try {
      await expect(iterator.next()).resolves.toMatchObject({
        done: false,
        value: {
          type: 'snapshot',
          assistantStream: { revision: 3 },
        },
      })
    } finally {
      await disposeFollow(ctx, iterator, abort)
    }
  })

  it('drops active attempts when an Agent chunk index is not dense', async () => {
    const { ctx } = await harness()
    const session = ctx.sessions.create(undefined, { meta: { cwd: '/workspace' } })
    const agent = { id: session.id, session, status: 'running', ctx } as Agent
    const history = new SessionHistoryController(ctx, (observation) => { observation[Symbol.dispose]() })
    const attemptId = LlmAttemptId('dense-index-attempt')
    ctx.emit('agent/assistant-stream', {
      agent,
      frame: {
        type: 'start', attemptId, revision: 1,
        turn: 1, step: 1,
      },
    })
    const chunk = { type: 'text-delta', index: 0, text: 'out of order' } as const
    ctx.emit('agent/assistant-stream', {
      agent,
      frame: {
        type: 'chunk', attemptId, revision: 2, index: 1,
        time: 101, chunk,
      },
    })
    const abort = new AbortController()
    const iterator = history.follow({
      address: { kind: 'session', sessionId: session.id },
      assistantStream: true,
    }, abort.signal)[Symbol.asyncIterator]()

    try {
      await expect(iterator.next()).resolves.toMatchObject({
        done: false,
        value: {
          type: 'snapshot',
          assistantStream: { revision: 2 },
        },
      })
    } finally {
      await disposeFollow(ctx, iterator, abort)
    }
  })

  it('reuses an unchanged Assistant baseline across follow openings', async () => {
    const { ctx } = await harness()
    const session = ctx.sessions.create(undefined, { meta: { cwd: '/workspace' } })
    const agent = { id: session.id, session, status: 'running', ctx } as Agent
    const history = new SessionHistoryController(ctx, (observation) => { observation[Symbol.dispose]() })
    const attemptId = LlmAttemptId('cached-baseline-attempt')
    ctx.emit('agent/assistant-stream', {
      agent,
      frame: {
        type: 'start', attemptId, revision: 1,
        turn: 1, step: 1,
      },
    })

    const firstAbort = new AbortController()
    const firstIterator = history.follow({
      address: { kind: 'session', sessionId: session.id },
      assistantStream: true,
    }, firstAbort.signal)[Symbol.asyncIterator]()
    const secondAbort = new AbortController()
    const secondIterator = history.follow({
      address: { kind: 'session', sessionId: session.id },
      assistantStream: true,
    }, secondAbort.signal)[Symbol.asyncIterator]()
    try {
      const first = await firstIterator.next()
      if (first.done || first.value.type !== 'snapshot') throw new Error('first follow did not open')
      const baseline = first.value.assistantStream
      expect(baseline).toMatchObject({ revision: 1, activeAttempt: { attemptId } })
      const second = await secondIterator.next()
      if (second.done || second.value.type !== 'snapshot') throw new Error('second follow did not open')
      expect(second.value.assistantStream).toEqual(baseline)
    } finally {
      firstAbort.abort()
      secondAbort.abort()
      await firstIterator.return?.()
      await secondIterator.return?.()
      await ctx.fiber.dispose()
    }
  })

  it('opens an empty Assistant baseline before the target Agent emits frames', async () => {
    const { ctx } = await harness()
    const session = ctx.sessions.create(undefined, { meta: { cwd: '/workspace' } })
    const history = new SessionHistoryController(ctx, (observation) => { observation[Symbol.dispose]() })
    const abort = new AbortController()
    const iterator = history.follow({
      address: { kind: 'session', sessionId: session.id },
      assistantStream: true,
    }, abort.signal)[Symbol.asyncIterator]()

    try {
      await expect(iterator.next()).resolves.toMatchObject({
        done: false,
        value: {
          type: 'snapshot',
          assistantStream: { revision: 0 },
        },
      })
    } finally {
      await disposeFollow(ctx, iterator, abort)
    }
  })

  it('filters Assistant frames from another Session out of the target follow', async () => {
    const { ctx } = await harness()
    const target = ctx.sessions.create(undefined, { meta: { cwd: '/target' } })
    const other = ctx.sessions.create(undefined, { meta: { cwd: '/other' } })
    const otherAgent = { id: other.id, session: other, status: 'running', ctx } as Agent
    const history = new SessionHistoryController(ctx, (observation) => { observation[Symbol.dispose]() })
    const abort = new AbortController()
    const iterator = history.follow({
      address: { kind: 'session', sessionId: target.id },
      assistantStream: true,
    }, abort.signal)[Symbol.asyncIterator]()
    try {
      await expect(iterator.next()).resolves.toMatchObject({
        done: false,
        value: { type: 'snapshot' },
      })

      ctx.emit('agent/assistant-stream', {
        agent: otherAgent,
        frame: {
          type: 'start', attemptId: LlmAttemptId('other-session-attempt'),
          revision: 1, turn: 1, step: 1,
        },
      })
      const targetEvent = target.append('turn/start', { turn: 1 })
      await expect(iterator.next()).resolves.toEqual({
        done: false,
        value: { type: 'event', event: targetEvent },
      })
    } finally {
      await disposeFollow(ctx, iterator, abort)
    }
  })

  it('does not replay a buffered Assistant frame already represented by the opening baseline', async () => {
    const { ctx } = await harness()
    const session = ctx.sessions.create(undefined, { meta: { cwd: '/workspace' } })
    const agent = { id: session.id, session, status: 'running', ctx } as Agent
    const history = new SessionHistoryController(ctx, (observation) => { observation[Symbol.dispose]() })
    const observationStarted = Promise.withResolvers<undefined>()
    const releaseObservation = Promise.withResolvers<undefined>()
    const originalObserve = ctx.sessionQuery.observeSession.bind(ctx.sessionQuery)
    const observe = vi.spyOn(ctx.sessionQuery, 'observeSession').mockImplementation(async (sessionId, options) => {
      observationStarted.resolve(undefined)
      await releaseObservation.promise
      return await originalObserve(sessionId, options)
    })
    const abort = new AbortController()
    const iterator = history.follow({
      address: { kind: 'session', sessionId: session.id },
      assistantStream: true,
    }, abort.signal)[Symbol.asyncIterator]()

    try {
      const opening = iterator.next()
      await observationStarted.promise
      const frame: AssistantStreamFrame = {
        type: 'start', attemptId: LlmAttemptId('opening-cut-attempt'),
        revision: 1, turn: 1, step: 1,
      }
      ctx.emit('agent/assistant-stream', { agent, frame })
      releaseObservation.resolve(undefined)
      await expect(opening).resolves.toMatchObject({
        done: false,
        value: {
          type: 'snapshot',
          assistantStream: { revision: 1, activeAttempt: { attemptId: frame.attemptId } },
        },
      })

      const durable = session.append('turn/start', { turn: 1 })
      await expect(iterator.next()).resolves.toEqual({
        done: false,
        value: { type: 'event', event: durable },
      })
    } finally {
      releaseObservation.resolve(undefined)
      observe.mockRestore()
      abort.abort()
      await iterator.return?.()
      await ctx.fiber.dispose()
    }
  })

  it('does not release an old-lifecycle frame after the opening baseline resets to revision one', async () => {
    const { ctx } = await harness()
    const session = ctx.sessions.create(undefined, { meta: { cwd: '/workspace' } })
    const agent = { id: session.id, session, status: 'running', ctx } as Agent
    const history = new SessionHistoryController(ctx, (observation) => { observation[Symbol.dispose]() })
    const attemptId = LlmAttemptId(`${session.id}:1`)
    ctx.emit('agent/assistant-stream', {
      agent,
      frame: {
        type: 'start', attemptId, revision: 1,
        turn: 1, step: 1,
      },
    })
    const observationStarted = Promise.withResolvers<undefined>()
    const releaseObservation = Promise.withResolvers<undefined>()
    const originalObserve = ctx.sessionQuery.observeSession.bind(ctx.sessionQuery)
    const observe = vi.spyOn(ctx.sessionQuery, 'observeSession').mockImplementation(async (sessionId, options) => {
      observationStarted.resolve(undefined)
      await releaseObservation.promise
      return await originalObserve(sessionId, options)
    })
    const abort = new AbortController()
    const iterator = history.follow({
      address: { kind: 'session', sessionId: session.id },
      assistantStream: true,
    }, abort.signal)[Symbol.asyncIterator]()

    try {
      const opening = iterator.next()
      await observationStarted.promise
      const oldChunk = { type: 'text-delta', index: 0, text: 'old lifecycle' } as const
      ctx.emit('agent/assistant-stream', {
        agent,
        frame: {
          type: 'chunk', attemptId, revision: 2, index: 0,
          time: 101, chunk: oldChunk,
        },
      })
      ctx.emit('agent/assistant-stream', {
        agent,
        frame: {
          type: 'start', attemptId, revision: 1,
          turn: 2, step: 1,
        },
      })
      releaseObservation.resolve(undefined)
      await expect(opening).resolves.toMatchObject({
        done: false,
        value: {
          type: 'snapshot',
          assistantStream: {
            revision: 1,
            activeAttempt: {
              attemptId, startedAfterSeq: -1,
              turn: 2, step: 1, nextIndex: 0, stream: [],
            },
          },
        },
      })

      const durable = session.append('turn/start', { turn: 2 })
      await expect(iterator.next()).resolves.toEqual({
        done: false,
        value: { type: 'event', event: durable },
      })
    } finally {
      releaseObservation.resolve(undefined)
      observe.mockRestore()
      abort.abort()
      await iterator.return?.()
      await ctx.fiber.dispose()
    }
  })

  it('keeps assistant frames out of a durable-only follower', async () => {
    const { ctx } = await harness()
    const session = ctx.sessions.create(undefined, { meta: { cwd: '/workspace' } })
    const agent = { id: session.id, session, status: 'running', ctx } as Agent
    const history = new SessionHistoryController(ctx, (observation) => { observation[Symbol.dispose]() })
    const abort = new AbortController()
    const iterator = history.follow({
      address: { kind: 'session', sessionId: session.id },
    }, abort.signal)[Symbol.asyncIterator]()
    const opening = await iterator.next()
    expect(opening.value).not.toHaveProperty('assistantStream')
    const attemptId = LlmAttemptId('durable-only-attempt')

    ctx.emit('agent/assistant-stream', {
      agent,
      frame: {
        type: 'start', attemptId, revision: 1,
        turn: 1, step: 1,
      },
    })
    const durable = session.append('turn/start', { turn: 1 })
    ctx.emit('agent/assistant-stream', {
      agent,
      frame: {
        type: 'end', attemptId, revision: 2, index: 0, outcome: { kind: 'abandoned' },
      },
    })
    const next = session.append('turn/end', {
      turn: 1, reason: { kind: 'completed' },
    })

    await expect(iterator.next()).resolves.toEqual({
      done: false, value: { type: 'event', event: durable },
    })
    await expect(iterator.next()).resolves.toEqual({
      done: false, value: { type: 'event', event: next },
    })
    abort.abort()
    await iterator.next()
    await ctx.fiber.dispose()
  })


  it('follows raw tool events and preserves result metadata without a Tools service', async () => {
    const { ctx } = await harness()
    const session = ctx.sessions.create(undefined, { meta: { cwd: '/workspace' } })
    const history = new SessionHistoryController(ctx, (observation) => { observation[Symbol.dispose]() })
    const abort = new AbortController()
    const stream = await openFollow(history, session.id, abort.signal)
    const collected = collect(stream, 2, abort)
    const call = session.append('tool/call', {
      turn: 1, step: 1, callId: ToolCallId('raw-call'), name: 'custom', arguments: '{malformed',
    })
    const result = session.append('tool/result', {
      turn: 1, step: 1,
      message: createToolResultMessage({
        callId: ToolCallId('raw-call'),
        content: [{ type: 'text', text: 'raw output' }],
        isError: false,
      }),
      meta: { nested: { count: 2 }, paths: ['a.ts', 'b.ts'] },
    }, { surfaceOp: 'append' })

    const frames = await collected
    expect(frames).toEqual([
      { type: 'event', event: call },
      { type: 'event', event: result },
    ])
    expect((frames[1] as Extract<SessionFollowFrame, { type: 'event' }>).event.data)
      .toMatchObject({ meta: { nested: { count: 2 }, paths: ['a.ts', 'b.ts'] } })
  })

  it('follows live results without rescanning Session history', async () => {
    const { ctx } = await harness()
    const session = ctx.sessions.create(undefined, { meta: { cwd: '/workspace' } })
    const history = new SessionHistoryController(ctx, (observation) => { observation[Symbol.dispose]() })
    const abort = new AbortController()
    const stream = await openFollow(history, session.id, abort.signal)
    const iterator = stream[Symbol.asyncIterator]()

    session.append('tool/call', {
      turn: 1, step: 1, callId: ToolCallId('live-fast'), name: 'term', arguments: '{"cmd":"pwd"}',
    })
    await expect(iterator.next()).resolves.toMatchObject({
      value: { type: 'event', event: { type: 'tool/call', data: { callId: 'live-fast' } } },
    })

    const events = vi.spyOn(session, 'snapshotEvents').mockImplementation(() => {
      throw new Error('live result rescanned Session history')
    })
    try {
      session.append('tool/result', {
        turn: 1, step: 1,
        message: createToolResultMessage({
          callId: ToolCallId('live-fast'),
          content: [{ type: 'text', text: 'ok' }],
          isError: false,
        }),
      }, { surfaceOp: 'append' })
      await expect(iterator.next()).resolves.toMatchObject({
        value: { type: 'event', event: { type: 'tool/result', data: { message: { source: { callId: 'live-fast' } } } } },
      })
    } finally {
      events.mockRestore()
      abort.abort()
      await iterator.next()
      await ctx.fiber.dispose()
    }
  })

  it('serves raw call and result entries without parsing tool arguments', async () => {
    const { ctx } = await harness()
    const remote = createSessionTestRemote(ctx, { defaultModelSelection: () => ({ provider: 'p', model: 'm' }), cwd: '/tmp' })
    const session = ctx.sessions.create(undefined, { meta: { cwd: '/workspace' } })
    const start = session.append('turn/start', { turn: 1 })
    const call = session.append('tool/call', {
      turn: 1, step: 1, callId: ToolCallId('history-call'), name: 'custom', arguments: '{broken',
    })
    const result = session.append('tool/result', {
      turn: 1, step: 1,
      message: createToolResultMessage({
        callId: ToolCallId('history-call'),
        content: [{ type: 'text', text: 'failed raw output' }],
        isError: true,
      }),
      meta: { persisted: true, count: 3 },
    }, { surfaceOp: 'append' })

    const response = await remote.page({
      address: { kind: 'session', sessionId: session.id },
      throughSeq: session.seq - 1,
    })
    expect(response.ok).toBe(true)
    if (!response.ok) throw new Error('unreachable')
    expect(response.value.records).toEqual([
      { type: 'event', event: start },
      { type: 'event', event: call },
      { type: 'event', event: result },
    ])
  })

  it.each([
    { name: 'two long Turns', replies: [9, 39, 39], beforeMessage: undefined, firstTurn: 2, steering: false },
    { name: 'the partial upper Turn and its predecessor', replies: [9, 39, 99], beforeMessage: 20, firstTurn: 2, steering: false },
    { name: 'an upper window beginning at its user message', replies: [9, 59, 59], beforeMessage: 0, firstTurn: 2, steering: false },
    { name: 'short Turns until 50 messages', replies: [9, 9, 9, 9, 9, 9], beforeMessage: undefined, firstTurn: 2, steering: false },
    { name: 'navigation until 200 messages', replies: [9, 49, 49, 49, 49], beforeMessage: undefined, firstTurn: 2, steering: false, minMessages: 200 },
    { name: 'steering within one Turn', replies: [9, 39, 39], beforeMessage: undefined, firstTurn: 2, steering: true },
    { name: 'exhausted history below both minima', replies: [9], beforeMessage: undefined, firstTurn: 1, steering: false },
    { name: 'the 500-message cap inside one Turn', replies: [9, 600], beforeMessage: undefined, firstTurn: undefined, steering: false },
  ])('paginates $name in one contiguous Turn window', async ({ replies, beforeMessage, firstTurn, steering, minMessages = 50 }) => {
    const { ctx } = await harness()
    onTestFinished(() => ctx.fiber.dispose())
    const remote = createSessionTestRemote(ctx, { defaultModelSelection: () => ({ provider: 'p', model: 'm' }), cwd: '/tmp' })
    const session = ctx.sessions.create(undefined, { meta: { cwd: '/workspace' } })
    const starts: SessionEvent[] = []
    const messages: SessionEvent[][] = []
    for (const [index, count] of replies.entries()) {
      const turn = index + 1
      starts.push(session.append('turn/start', { turn }))
      const rows = [appendUserText(session, `prompt ${turn}`)]
      for (let step = 1; step <= count; step++) {
        rows.push(appendAssistantText(session, `reply ${turn}/${step}`, step, turn))
        if (steering && index === replies.length - 1 && step % 3 === 0) {
          rows.push(appendUserText(session, `steering ${step}`))
        }
      }
      messages.push(rows)
      session.append('turn/end', { turn, reason: { kind: 'completed' } })
    }
    const beforeSeq = beforeMessage === undefined ? session.seq : messages.at(-1)![beforeMessage]!.seq
    const response = await remote.page({
      address: { kind: 'session', sessionId: session.id },
      throughSeq: session.seq - 1,
      beforeSeq,
      maxMessages: 500,
      turnWindow: { minMessages, minTurns: 2 },
    })
    if (!response.ok) throw new Error('expected a history page')
    const page = pageEvents(response.value)
    const expectedStart = firstTurn === undefined ? messages.at(-1)!.at(-500)!.seq : starts[firstTurn - 1]!.seq
    expect(page.map(event => event.seq)).toEqual(Array.from({ length: beforeSeq - expectedStart }, (_, index) => expectedStart + index))
    expect(response.value.hasMore).toBe(expectedStart > 0)
    if (firstTurn === undefined) {
      expect(page.filter(event => event.type === 'user/message' || event.type === 'assistant/message')).toHaveLength(500)
      expect(page.some(event => event.type === 'user/message')).toBe(false)
    } else {
      expect(page[0]?.type).toBe('turn/start')
      expect(page.some(event => event.seq === messages[firstTurn - 1]![0]!.seq)).toBe(true)
    }
    if (beforeMessage === undefined) {
      const abort = new AbortController()
      const stream = remote.follow({
        address: { kind: 'session', sessionId: session.id },
        maxMessages: 500,
        turnWindow: { minMessages, minTurns: 2 },
      }, abort.signal)[Symbol.asyncIterator]()
      try {
        await expect(stream.next()).resolves.toMatchObject({
          done: false,
          value: { type: 'snapshot', records: response.value.records, hasMore: response.value.hasMore },
        })
      } finally {
        abort.abort()
        await stream.return?.()
      }
    }
  })

  it('counts only append-origin messages toward maxMessages and keeps each compaction summary with its replacement', async () => {
    const { ctx } = await harness()
    const remote = createSessionTestRemote(ctx, { defaultModelSelection: () => ({ provider: 'p', model: 'm' }), cwd: '/tmp' })
    const session = ctx.sessions.create(undefined, { meta: { cwd: '/workspace' } })
    session.append('turn/start', { turn: 1 })
    const first = appendUserText(session, 'first prompt')
    appendAssistantText(session, 'first reply', 1)
    const third = appendUserText(session, 'second prompt')
    appendAssistantText(session, 'second reply', 2)
    const shadowed = [...session.surface.nodes]
    const shadowedStart = shadowed[0]
    const shadowedEnd = shadowed.at(-1)
    if (shadowedStart === undefined || shadowedEnd === undefined) {
      throw new Error('expected a non-empty surface')
    }
    // A compaction transaction: a log-only summary record immediately followed by the
    // replacement that shadows the range.
    const summary = appendExtension(session, 'compaction/summary', {
      summary: [{ type: 'text', text: 'summary' }],
      shadowedRange: { start: shadowed[0], end: shadowed.at(-1) },
      shadowedSeqs: shadowed,
      shadowedTokenCount: 0,
      provider: 'p',
      model: 'm',
    })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: '<context_checkpoint>summary</context_checkpoint>' }],
      source: checkpointSource('journal-compaction'),
    }), {
      surfaceOp: { op: 'replace', startSeq: shadowedStart, endSeq: shadowedEnd },
      sourceEventSeqs: [...shadowed, summary.seq],
    })

    const response = await remote.page({
      address: { kind: 'session', sessionId: session.id },
      throughSeq: session.seq - 1,
      maxMessages: 2,
    })
    if (!response.ok) throw new Error('unreachable')
    const page = pageEvents(response.value)
    // Two append-origin messages fill the page even though a replacement copy of
    // the same event type sits in the window: the copy is model-only.
    const messages = page.filter(event => event.type === 'user/message' || event.type === 'assistant/message')
    expect(messages.map(event => event.seq)).toEqual([third.seq, third.seq + 1, third.seq + 3])
    expect(page.some(event => event.seq === first.seq)).toBe(false)
    expect(response.value.hasMore).toBe(true)
    // The range stays contiguous, so the checkpoint's summary record is readable on
    // the same page as the checkpoint itself.
    const summaryIndex = page.findIndex(event => event.seq === summary.seq)
    expect(summaryIndex).toBeGreaterThan(-1)
    expect(page[summaryIndex + 1]?.seq).toBe(summary.seq + 1)
    expect(page.map(event => event.seq)).toEqual(page.map((_event, index) => third.seq + index))
  })

  it('paginates a message with a large embedded stream without expanding physical records', async () => {
    const { ctx } = await harness()
    const remote = createSessionTestRemote(ctx, { defaultModelSelection: () => ({ provider: 'p', model: 'm' }), cwd: '/tmp' })
    const session = ctx.sessions.create(undefined, { meta: { cwd: '/workspace' } })
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    const texts = Array.from({ length: 128 }, () => 'x')
    const message = session.append('assistant/message', {
      turn: 1,
      step: 1,
      message: createMessage({
        role: 'assistant',
        content: [{ type: 'text', text: 'x'.repeat(texts.length) }],
        source: { kind: 'model', provider: 'p', model: 'm' },
      }),
      stream: [{ type: 'text-chunks', time0: 1, index: 0, dt: texts.slice(1).map(() => 0), texts }],
    }, { surfaceOp: 'append' })

    const scalarMin = Math.min
    const min = vi.spyOn(Math, 'min').mockImplementation((...values) => {
      if (values.length > 2) throw new RangeError('variadic minimum rejected by regression harness')
      return scalarMin(...values)
    })
    try {
      const response = await remote.page({
        address: { kind: 'session', sessionId: session.id },
        throughSeq: message.seq,
        maxMessages: 1,
      })
      if (!response.ok) throw new Error('unreachable')
      expect(pageEvents(response.value).map(event => event.seq)).toEqual([message.seq])
      expect(response.value.records).toEqual([{ type: 'event', event: message }])
      expect(response.value.hasMore).toBe(true)
    } finally {
      min.mockRestore()
    }
  })

  it('keeps an earlier declared source on the same message-aligned page', async () => {
    const { ctx } = await harness()
    const remote = createSessionTestRemote(ctx, { defaultModelSelection: () => ({ provider: 'p', model: 'm' }), cwd: '/tmp' })
    const session = ctx.sessions.create(undefined, { meta: { cwd: '/workspace' } })
    const source = session.append('request/context', { provider: 'p', model: 'm' })
    const laterSource = session.append('request/context', { provider: 'p', model: 'm' })
    const message = session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'with source' }], source: { kind: 'user' },
    }), { sourceEventSeqs: [source.seq, laterSource.seq], surfaceOp: 'append' })

    const response = await remote.page({
      address: { kind: 'session', sessionId: session.id },
      throughSeq: message.seq,
      maxMessages: 1,
    })
    if (!response.ok) throw new Error('unreachable')
    expect(pageEvents(response.value).map(event => event.seq)).toEqual([source.seq, laterSource.seq, message.seq])
    expect(response.value.hasMore).toBe(false)
    await ctx.fiber.dispose()
  })

  it('keeps compact reasoning and tool-call runs nested in one attempt event', async () => {
    const { ctx } = await harness()
    const remote = createSessionTestRemote(ctx, { defaultModelSelection: () => ({ provider: 'p', model: 'm' }), cwd: '/tmp' })
    const session = ctx.sessions.create(undefined, { meta: { cwd: '/workspace' } })
    const callId = ToolCallId('packed-call')
    const attempt = session.append('assistant/attempt', {
      turn: 1,
      step: 1,
      stream: [
        { type: 'reasoning-chunks', time0: 1, index: 0, dt: [1, 1], texts: ['r0', 'r1', 'r2'] },
        { type: 'tool-call-chunks', time0: 4, index: 1, id: callId, dt: [1, 1], args: ['a0', 'a1', 'a2'] },
      ],
    })

    const response = await remote.page({
      address: { kind: 'session', sessionId: session.id },
      throughSeq: session.seq - 1,
    })
    if (!response.ok) throw new Error('unreachable')
    expect(response.value.records).toEqual([{ type: 'event', event: attempt }])
    await ctx.fiber.dispose()
  })

  it('follows a result after turn/end without reading the addressed Session log', async () => {
    const { ctx } = await harness()
    const session = ctx.sessions.create(undefined, { meta: { cwd: '/workspace' } })
    const history = new SessionHistoryController(ctx, (observation) => { observation[Symbol.dispose]() })
    const abort = new AbortController()
    const stream = await openFollow(history, session.id, abort.signal)
    const iterator = stream[Symbol.asyncIterator]()

    session.append('turn/start', { turn: 1 })
    await expect(iterator.next()).resolves.toMatchObject({
      value: { type: 'event', event: { type: 'turn/start' } },
    })
    session.append('tool/call', { turn: 1, step: 1, callId: ToolCallId('c-late'), name: 'term', arguments: '{"cmd":"tail"}' })
    await expect(iterator.next()).resolves.toMatchObject({
      value: { type: 'event', event: { type: 'tool/call' } },
    })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await expect(iterator.next()).resolves.toMatchObject({
      value: { type: 'event', event: { type: 'turn/end' } },
    })
    const events = vi.spyOn(session, 'snapshotEvents').mockImplementation(() => {
      throw new Error('live result rescanned Session history')
    })
    try {
      const result = session.append('tool/result', {
        turn: 1, step: 1,
        message: createToolResultMessage({
          callId: ToolCallId('c-late'),
          content: [{ type: 'text', text: 'ok' }],
          isError: false,
        }),
      }, { surfaceOp: 'append' })
      await expect(iterator.next()).resolves.toEqual({
        done: false,
        value: { type: 'event', event: result },
      })
    } finally {
      events.mockRestore()
      abort.abort()
      await iterator.next()
      await ctx.fiber.dispose()
    }
  })

  it('ships the durable revert fold across a page cut between marker and replacement', async () => {
    const { ctx } = await harness()
    onTestFinished(() => ctx.fiber.dispose())
    const remote = createSessionTestRemote(ctx, { defaultModelSelection: () => ({ provider: 'p', model: 'm' }), cwd: '/tmp' })
    const session = ctx.sessions.create(undefined, { meta: { cwd: '/workspace' } })
    const anchor = appendUserText(session, 'first prompt')
    session.append('turn/start', { turn: 1 })
    appendAssistantText(session, 'reply', 1)
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    // Revert while nothing runs, then the cancelled turn settles an
    // interrupted assistant message at a seq past the marker.
    const marker = appendExtension(session, 'revert/state', { fromSeq: anchor.seq, cause: 'revert' })
    const settlement = appendAssistantText(session, 'late interrupted settlement', 1, 2)
    const shadowed = session.surface.nodes.filter(seq => (seq as number) >= anchor.seq)
    const replacement = session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'after the revert' }], source: { kind: 'user' },
    }), {
      surfaceOp: { op: 'replace', startSeq: anchor.seq, endSeq: settlement.seq },
      sourceEventSeqs: [...shadowed],
    })

    // The page cut lands inside (marker, settlement]: records start after the
    // marker and the fold must still know the commit shadowed [anchor, settlement].
    const response = await remote.page({
      address: { kind: 'session', sessionId: session.id },
      throughSeq: replacement.seq,
      beforeSeq: replacement.seq + 1,
      maxMessages: 1,
    })
    if (!response.ok) throw new Error('unreachable')
    expect(pageEvents(response.value).map(event => event.seq)).toEqual([settlement.seq, replacement.seq])
    expect(response.value.revert).toEqual({
      fromSeq: null,
      shadowRanges: [{ start: anchor.seq, end: settlement.seq + 1 }],
      conflicts: [],
      outcomes: {},
      // The replacement's user-origin surfaceOp also derives the durable
      // iteration edge (the pre-marker fallback).
      iterations: [{
        anchorSeq: anchor.seq,
        activeVariantSeq: replacement.seq,
        variants: [
          { seq: anchor.seq, previousSeq: null },
          { seq: replacement.seq, previousSeq: anchor.seq },
        ],
      }],
      asOfSeq: replacement.seq,
    })

    // A request behind the cached cut (never produced by the forward-only
    // journal, but reachable after a log repair) rebuilds from the prefix.
    const earlier = await remote.page({
      address: { kind: 'session', sessionId: session.id },
      throughSeq: marker.seq,
      beforeSeq: marker.seq + 1,
      maxMessages: 1,
    })
    if (!earlier.ok) throw new Error('unreachable')
    expect(earlier.value.revert).toEqual({
      fromSeq: anchor.seq,
      shadowRanges: [],
      conflicts: [],
      outcomes: {},
      iterations: [],
      asOfSeq: marker.seq,
    })
  })

  it('replays a large durable suffix behind a slow opening without retaining it', async () => {
    const { ctx } = await harness()
    const session = ctx.sessions.create(undefined, { meta: { cwd: '/workspace' } })
    const history = new SessionHistoryController(ctx, (observation) => { observation[Symbol.dispose]() })
    const abort = new AbortController()
    const iterator = history.follow({
      address: { kind: 'session', sessionId: session.id },
    }, abort.signal)[Symbol.asyncIterator]()

    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: { type: 'snapshot', cursor: -1 },
    })
    // The Client has not pulled the snapshot's successor yet: this is the
    // window the old unbounded deque retained every event in.
    for (let index = 0; index < 10_000; index += 1) {
      session.append('turn/start', { turn: index + 1 })
    }
    expect(history.followBacklog()).toEqual({ items: 0, bytes: 0 })

    const seqs: number[] = []
    for (let index = 0; index < 10_000; index += 1) {
      const frame = await iterator.next()
      if (frame.done || frame.value.type !== 'event') throw new Error('follow ended before the durable suffix')
      seqs.push(frame.value.event.seq)
      if (index % 997 === 0) expect(history.followBacklog()).toEqual({ items: 0, bytes: 0 })
    }
    expect(seqs).toEqual(Array.from({ length: 10_000 }, (_, index) => index))

    abort.abort()
    await iterator.next()
    await ctx.fiber.dispose()
  })

  it('keeps snapshot-to-live durable seqs contiguous without loss or duplication', async () => {
    const { ctx } = await harness()
    const session = ctx.sessions.create(undefined, { meta: { cwd: '/workspace' } })
    const opening = session.append('turn/start', { turn: 1 })
    const history = new SessionHistoryController(ctx, (observation) => { observation[Symbol.dispose]() })
    const abort = new AbortController()
    const iterator = history.follow({
      address: { kind: 'session', sessionId: session.id },
    }, abort.signal)[Symbol.asyncIterator]()

    const snapshot = await iterator.next()
    if (snapshot.done || snapshot.value.type !== 'snapshot') throw new Error('follow did not open')
    expect(snapshot.value.cursor).toBe(opening.seq)
    expect(snapshot.value.records.at(-1)?.event.seq).toBe(opening.seq)

    // Appended while the snapshot is in flight: replayed from the log.
    const duringTransfer = session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    const alsoDuringTransfer = session.append('turn/start', { turn: 2 })
    const first = await iterator.next()
    // Appended after listeners installed: delivered live.
    const afterSwitch = session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
    const second = await iterator.next()
    const third = await iterator.next()

    const seqs = [first, second, third].map((frame) => {
      if (frame.done || frame.value.type !== 'event') throw new Error('follow emitted a non-event frame')
      return frame.value.event.seq
    })
    expect(seqs).toEqual([duringTransfer.seq, alsoDuringTransfer.seq, afterSwitch.seq])
    expect(new Set(seqs).size).toBe(seqs.length)
    expect(seqs[0]).toBe(snapshot.value.cursor + 1)

    abort.abort()
    await iterator.next()
    await ctx.fiber.dispose()
  })

  it('ends one follow for a clean resync when a slow consumer exhausts the backlog cap', async () => {
    const { ctx } = await harness()
    const session = ctx.sessions.create(undefined, { meta: { cwd: '/workspace' } })
    const agent = { id: session.id, session, status: 'running', ctx } as Agent
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    const limits = { maxItems: 3, maxBytes: 1024 * 1024 }
    const history = new SessionHistoryController(ctx, (observation) => { observation[Symbol.dispose]() }, limits)
    const abort = new AbortController()
    const iterator = history.follow({
      address: { kind: 'session', sessionId: session.id },
      assistantStream: true,
    }, abort.signal)[Symbol.asyncIterator]()

    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: { type: 'snapshot', cursor: -1, assistantStream: { revision: 0 } },
    })
    const attemptId = LlmAttemptId('overflow-attempt')
    ctx.emit('agent/assistant-stream', {
      agent,
      frame: { type: 'start', attemptId, revision: 1, turn: 1, step: 1 },
    })
    for (let index = 0; index < 6; index += 1) {
      ctx.emit('agent/assistant-stream', {
        agent,
        frame: {
          type: 'chunk', attemptId, revision: index + 2, index,
          time: index + 1, chunk: { type: 'text-delta', index: 0, text: 'x'.repeat(64) },
        },
      })
      expect(history.followBacklog().items).toBeLessThanOrEqual(limits.maxItems)
      expect(history.followBacklog().bytes).toBeLessThanOrEqual(limits.maxBytes)
    }
    // The fourth retained item exceeded the cap: every retained frame is gone.
    expect(history.followBacklog()).toEqual({ items: 0, bytes: 0 })
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined })
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined })
    expect(warn).toHaveBeenCalledOnce()
    expect(warn.mock.calls[0]?.[0]).toContain('backlog exceeded')

    abort.abort()
    await ctx.fiber.dispose()
  })

  it('ends one follow for a clean resync when live durable events exceed the backlog cap', async () => {
    const { ctx } = await harness()
    const session = ctx.sessions.create(undefined, { meta: { cwd: '/workspace' } })
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    const history = new SessionHistoryController(ctx, (observation) => { observation[Symbol.dispose]() }, {
      maxItems: 2,
      maxBytes: 1024 * 1024,
    })
    const abort = new AbortController()
    const iterator = history.follow({
      address: { kind: 'session', sessionId: session.id },
    }, abort.signal)[Symbol.asyncIterator]()

    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: { type: 'snapshot', cursor: -1 },
    })
    const firstEvent = session.append('turn/start', { turn: 1 })
    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: { type: 'event', event: firstEvent },
    })
    // The consumer is paused at the yield above; three further appends exceed
    // the two-item cap and discard the retained events.
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    session.append('turn/start', { turn: 2 })
    session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
    expect(history.followBacklog()).toEqual({ items: 0, bytes: 0 })
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined })
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined })
    expect(warn).toHaveBeenCalledOnce()

    abort.abort()
    await ctx.fiber.dispose()
  })
})

describe('Session history follow resume', () => {
  /** Ordinary Session with `count` appended user messages, returning the controller. */
  async function resumeHarness(
    count: number,
    options: { readonly resume?: { enabled: boolean; maxEvents: number }; readonly limits?: { maxItems: number; maxBytes: number } } = {},
  ): Promise<{ ctx: Context; session: Session; history: SessionHistoryController }> {
    const { ctx } = await harness()
    const session = ctx.sessions.create(undefined, { meta: { cwd: '/workspace' } })
    for (let index = 0; index < count; index++) appendUserText(session, `message-${String(index)}`)
    const history = new SessionHistoryController(
      ctx,
      (observation) => { observation[Symbol.dispose]() },
      options.limits ?? DEFAULT_SESSION_FOLLOW_BUFFER_LIMITS,
      options.resume ?? { enabled: true, maxEvents: 2048 },
    )
    return { ctx, session, history }
  }

  it('answers a follow without afterSeq with the full opening window (older Client)', async () => {
    const { ctx, session, history } = await resumeHarness(3)
    const abort = new AbortController()
    const iterator = history.follow({
      address: { kind: 'session', sessionId: session.id },
    }, abort.signal)[Symbol.asyncIterator]()

    const opening = await iterator.next()
    expect(opening).toMatchObject({
      done: false,
      value: { type: 'snapshot', cursor: 2, hasMore: false },
    })
    if (opening.done === true || opening.value.type !== 'snapshot') throw new Error('expected a snapshot')
    expect('resumedFromSeq' in opening.value).toBe(false)
    expect(opening.value.records.map(record => record.event.seq)).toEqual([0, 1, 2])

    abort.abort()
    await expect(iterator.next()).resolves.toMatchObject({ done: true })
    await ctx.fiber.dispose()
  })

  it('resumes a short drop with zero records from the observed tail', async () => {
    const { ctx, session, history } = await resumeHarness(3)
    const abort = new AbortController()
    const iterator = history.follow({
      address: { kind: 'session', sessionId: session.id },
      afterSeq: SessionSeq(2),
    }, abort.signal)[Symbol.asyncIterator]()

    const opening = await iterator.next()
    expect(opening).toMatchObject({
      done: false,
      value: {
        type: 'snapshot', cursor: 2, records: [], hasMore: false, resumedFromSeq: 2,
      },
    })
    if (opening.done === true || opening.value.type !== 'snapshot') throw new Error('expected a snapshot')
    expect(opening.value.revert.asOfSeq).toBe(2)

    // The resumed generation still follows later appends.
    const waiting = iterator.next()
    const live = appendUserText(session, 'after-drop')
    await expect(waiting).resolves.toEqual({
      done: false,
      value: { type: 'event', event: live },
    })

    abort.abort()
    await expect(iterator.next()).resolves.toMatchObject({ done: true })
    await ctx.fiber.dispose()
  })

  it('resumes with exactly the contiguous suffix after afterSeq', async () => {
    const { ctx, session, history } = await resumeHarness(6)
    const abort = new AbortController()
    const iterator = history.follow({
      address: { kind: 'session', sessionId: session.id },
      assistantStream: true,
      maxMessages: 2,
      afterSeq: SessionSeq(3),
    }, abort.signal)[Symbol.asyncIterator]()

    const opening = await iterator.next()
    if (opening.done === true || opening.value.type !== 'snapshot') throw new Error('expected a snapshot')
    expect(opening.value).toMatchObject({
      cursor: 5, hasMore: false, resumedFromSeq: 3,
    })
    expect(opening.value.records.map(record => record.event.seq)).toEqual([4, 5])
    expect(opening.value.assistantStream).toEqual({ revision: 0 })
    expect(opening.value.revert.asOfSeq).toBe(5)

    abort.abort()
    await expect(iterator.next()).resolves.toMatchObject({ done: true })
    await ctx.fiber.dispose()
  })

  it('falls back to a full snapshot when afterSeq is beyond the tail', async () => {
    const { ctx, session, history } = await resumeHarness(3)
    const abort = new AbortController()
    const iterator = history.follow({
      address: { kind: 'session', sessionId: session.id },
      afterSeq: SessionSeq(9),
    }, abort.signal)[Symbol.asyncIterator]()

    const opening = await iterator.next()
    if (opening.done === true || opening.value.type !== 'snapshot') throw new Error('expected a snapshot')
    expect(opening.value.cursor).toBe(2)
    expect('resumedFromSeq' in opening.value).toBe(false)
    expect(opening.value.records.map(record => record.event.seq)).toEqual([0, 1, 2])

    abort.abort()
    await expect(iterator.next()).resolves.toMatchObject({ done: true })
    await ctx.fiber.dispose()
  })

  it('falls back to a full snapshot when the dense index does not match afterSeq', async () => {
    const { ctx } = await harness()
    const session = ctx.sessions.create(undefined, { meta: { cwd: '/workspace' } })
    const first = appendUserText(session, 'first')
    const second = appendUserText(session, 'second')
    // A retained prefix that no longer occupies its own dense position.
    const mismatched = { ...second, seq: SessionSeq(0) }
    const observe = vi.spyOn(ctx.sessionQuery, 'observeSession').mockResolvedValue({
      source: 'live',
      header: session.header,
      inheritedEventCount: SessionLogOffset(0),
      events: [first, mismatched],
      cursor: 1,
      projections: { asOfSeq: 1, values: {} },
      retain: vi.fn(),
      [Symbol.dispose]: vi.fn(),
    } as unknown as SessionObservation)
    const history = new SessionHistoryController(ctx, (observation) => { observation[Symbol.dispose]() })
    const abort = new AbortController()
    const iterator = history.follow({
      address: { kind: 'session', sessionId: session.id },
      afterSeq: SessionSeq(1),
    }, abort.signal)[Symbol.asyncIterator]()

    const opening = await iterator.next()
    if (opening.done === true || opening.value.type !== 'snapshot') throw new Error('expected a snapshot')
    expect('resumedFromSeq' in opening.value).toBe(false)
    expect(opening.value.records).toHaveLength(2)

    abort.abort()
    await expect(iterator.next()).resolves.toMatchObject({ done: true })
    observe.mockRestore()
    await ctx.fiber.dispose()
  })

  it('bounds a resumed suffix by maxEvents and honors the disabled escape hatch', async () => {
    const bounded = await resumeHarness(6, { resume: { enabled: true, maxEvents: 2 } })
    const abort = new AbortController()
    const atCap = bounded.history.follow({
      address: { kind: 'session', sessionId: bounded.session.id },
      afterSeq: SessionSeq(3),
    }, abort.signal)[Symbol.asyncIterator]()
    const capped = await atCap.next()
    if (capped.done === true || capped.value.type !== 'snapshot') throw new Error('expected a snapshot')
    expect(capped.value.resumedFromSeq).toBe(3)
    expect(capped.value.records.map(record => record.event.seq)).toEqual([4, 5])

    const overCap = bounded.history.follow({
      address: { kind: 'session', sessionId: bounded.session.id },
      afterSeq: SessionSeq(2),
    }, new AbortController().signal)[Symbol.asyncIterator]()
    const full = await overCap.next()
    if (full.done === true || full.value.type !== 'snapshot') throw new Error('expected a snapshot')
    expect('resumedFromSeq' in full.value).toBe(false)
    abort.abort()
    await expect(atCap.next()).resolves.toMatchObject({ done: true })
    await bounded.ctx.fiber.dispose()

    const disabled = await resumeHarness(3, { resume: { enabled: false, maxEvents: 2048 } })
    const disabledAbort = new AbortController()
    const disabledIterator = disabled.history.follow({
      address: { kind: 'session', sessionId: disabled.session.id },
      afterSeq: SessionSeq(2),
    }, disabledAbort.signal)[Symbol.asyncIterator]()
    const opaque = await disabledIterator.next()
    if (opaque.done === true || opaque.value.type !== 'snapshot') throw new Error('expected a snapshot')
    expect('resumedFromSeq' in opaque.value).toBe(false)
    disabledAbort.abort()
    await expect(disabledIterator.next()).resolves.toMatchObject({ done: true })
    await disabled.ctx.fiber.dispose()
  })

  it('rejects malformed afterSeq as a bad request', async () => {
    const { ctx, session, history } = await resumeHarness(2)
    for (const afterSeq of [-2, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const abort = new AbortController()
      const iterator = history.follow({
        address: { kind: 'session', sessionId: session.id },
        afterSeq: afterSeq as never,
      }, abort.signal)[Symbol.asyncIterator]()
      await expect(iterator.next()).rejects.toMatchObject({ code: 'gateway/bad-request' })
      abort.abort()
    }
    await ctx.fiber.dispose()
  })

  it('delivers revert, compaction, and surface replacement events as ordinary suffix records', async () => {
    const { ctx } = await harness()
    const session = ctx.sessions.create(undefined, { meta: { cwd: '/workspace' } })
    session.append('turn/start', { turn: 1 })
    const anchor = appendUserText(session, 'rewrite me')
    const answer = appendAssistantText(session, 'first answer', 0)
    const beforeDrop = SessionSeq(session.seq - 1)

    const revert = session.append('revert/state', { fromSeq: anchor.seq, cause: 'revert' })
    const summary = appendExtension(session, 'compaction/summary', {
      summary: [{ type: 'text', text: 'compacted' }],
      shadowedRange: { start: anchor.seq, end: answer.seq },
      shadowedSeqs: [anchor.seq, answer.seq],
      shadowedTokenCount: 3,
      provider: 'fixture',
      model: 'fixture',
    })
    const replacement = session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'replacement' }],
      source: { kind: 'user' },
    }), {
      surfaceOp: { op: 'replace', startSeq: anchor.seq, endSeq: answer.seq },
      sourceEventSeqs: [revert.seq, summary.seq, anchor.seq, answer.seq],
    })
    const tail = SessionSeq(session.seq - 1)

    const history = new SessionHistoryController(ctx, (observation) => { observation[Symbol.dispose]() })
    const abort = new AbortController()
    const iterator = history.follow({
      address: { kind: 'session', sessionId: session.id },
      afterSeq: beforeDrop,
    }, abort.signal)[Symbol.asyncIterator]()

    const opening = await iterator.next()
    if (opening.done === true || opening.value.type !== 'snapshot') throw new Error('expected a snapshot')
    expect(opening.value.resumedFromSeq).toBe(beforeDrop)
    expect(opening.value.cursor).toBe(tail)
    expect(opening.value.records.map(record => record.event.type))
      .toEqual(['revert/state', 'compaction/summary', 'user/message'])
    expect(opening.value.records.map(record => record.event.seq))
      .toEqual([revert.seq, summary.seq, replacement.seq])
    // The durable fold is taken at the resume cursor, so it already covers the
    // suffix and the Client folds none of it again: the user-origin replacement
    // both closed the boundary and recorded its shadow range in the baseline.
    expect(opening.value.revert.asOfSeq).toBe(tail)
    expect(opening.value.revert.fromSeq).toBeNull()
    expect(opening.value.revert.shadowRanges).toEqual([
      { start: anchor.seq, end: answer.seq + 1 },
    ])

    abort.abort()
    await expect(iterator.next()).resolves.toMatchObject({ done: true })
    await ctx.fiber.dispose()
  })

  it('replays events appended during the resume observation exactly once in order', async () => {
    const { ctx, session, history } = await resumeHarness(2)
    const original = ctx.sessionQuery.observeSession.bind(ctx.sessionQuery)
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const observe = vi.spyOn(ctx.sessionQuery, 'observeSession').mockImplementation(async (...args) => {
      const observation = await original(...args)
      entered.resolve(undefined)
      await release.promise
      return observation
    })
    const abort = new AbortController()
    const iterator = history.follow({
      address: { kind: 'session', sessionId: session.id },
      afterSeq: SessionSeq(1),
    }, abort.signal)[Symbol.asyncIterator]()
    const opening = iterator.next()
    await entered.promise
    session.append('turn/start', { turn: 2 })
    const later = session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
    release.resolve(undefined)

    await expect(opening).resolves.toMatchObject({
      value: { type: 'snapshot', resumedFromSeq: 1, cursor: 1, records: [] },
    })
    // The observation cut stayed at seq 1; both later appends replay from the
    // log in seq order, exactly once.
    await expect(iterator.next()).resolves.toMatchObject({
      value: { type: 'event', event: { type: 'turn/start', seq: 2 } },
    })
    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: { type: 'event', event: later },
    })
    const extra = Promise.resolve(iterator.next())
    abort.abort()
    await expect(extra).resolves.toMatchObject({ done: true })
    observe.mockRestore()
    await ctx.fiber.dispose()
  })

  it('carries the Assistant baseline at the resume cut and only post-cut frames after it', async () => {
    const { ctx, session, history } = await resumeHarness(2)
    const agent = { id: session.id, session, status: 'running', ctx } as Agent
    const attemptId = LlmAttemptId('resume-attempt')
    ctx.emit('agent/assistant-stream', {
      agent,
      frame: { type: 'start', attemptId, revision: 1, turn: 1, step: 1 },
    })
    const abort = new AbortController()
    const iterator = history.follow({
      address: { kind: 'session', sessionId: session.id },
      assistantStream: true,
      afterSeq: SessionSeq(1),
    }, abort.signal)[Symbol.asyncIterator]()

    const opening = await iterator.next()
    if (opening.done === true || opening.value.type !== 'snapshot') throw new Error('expected a snapshot')
    expect(opening.value.resumedFromSeq).toBe(1)
    expect(opening.value.assistantStream?.activeAttempt?.attemptId).toBe(attemptId)

    const waiting = iterator.next()
    ctx.emit('agent/assistant-stream', {
      agent,
      frame: {
        type: 'chunk', attemptId, revision: 2, index: 0,
        time: 5, chunk: { type: 'text-delta', index: 0, text: 'live' },
      },
    })
    const frame = await waiting
    expect(frame).toMatchObject({
      done: false,
      value: { type: 'assistant-stream', frame: { type: 'chunk', revision: 2, index: 0 } },
    })

    abort.abort()
    await expect(iterator.next()).resolves.toMatchObject({ done: true })
    await ctx.fiber.dispose()
  })

  it('ends a resumed generation for a clean resync when live events exceed the backlog cap', async () => {
    const { ctx, session, history } = await resumeHarness(4, {
      limits: { maxItems: 2, maxBytes: 1024 * 1024 },
    })
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    const abort = new AbortController()
    const iterator = history.follow({
      address: { kind: 'session', sessionId: session.id },
      afterSeq: SessionSeq(3),
    }, abort.signal)[Symbol.asyncIterator]()

    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: { type: 'snapshot', resumedFromSeq: 3, records: [] },
    })
    // Pull one replayed event so the durable listeners are installed and the
    // follower is paused at a yield before the overflow appends.
    session.append('turn/start', { turn: 2 })
    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: { type: 'event', event: { type: 'turn/start', seq: 4 } },
    })
    session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
    session.append('turn/start', { turn: 3 })
    session.append('turn/end', { turn: 3, reason: { kind: 'completed' } })
    expect(history.followBacklog()).toEqual({ items: 0, bytes: 0 })
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined })
    expect(warn).toHaveBeenCalledOnce()

    abort.abort()
    await ctx.fiber.dispose()
  })
})
