/**
 * R9: a window-clipped summarization replay must hand the image-offload
 * recovery the seqs of the messages the failed request actually carried, or
 * the retry re-sends the same images and the refusal repeats.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import LlmRuntime, {
  createUserMessage,
  IMAGE_OFFLOAD_REQUIRED_CODE,
  LlmAdapter,
  LlmError,
} from '@deepseek-ai/dsh-llm'
import type { ContentBlock, GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { SESSION_FORMAT_VERSION, Session, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionHeader } from '@deepseek-ai/dsh-session'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import * as imageOffload from '@deepseek-ai/dsh-compaction-image-offload'
import { BasicCompactionEngine } from '../src/index.ts'
import {
  summarizeWithLlm,
  SummarizationReplayError,
  type SummarizationInput,
  type SummaryResult,
} from '../src/summarizer.ts'

const MODEL = 'mock'

/** Throws the route's image-cap refusal on every request. */
class OffloadRequiredAdapter extends LlmAdapter {
  async * stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    throw new LlmError('request images exceed the route budget', IMAGE_OFFLOAD_REQUIRED_CODE, { offloadImages: 1 })
  }
}

/** Throws once, then returns one text checkpoint. */
class OffloadThenSummaryAdapter extends LlmAdapter {
  requests = 0
  readonly messages: ContentBlock[][] = []

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests += 1
    this.messages.push(options.messages.flatMap(message => message.content))
    if (this.requests === 1) {
      throw new LlmError('request images exceed the route budget', IMAGE_OFFLOAD_REQUIRED_CODE, { offloadImages: 1 })
    }
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'checkpoint' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/** The engine replaying through the real summarizer at a forced tight budget. */
class ClippedReplayEngine extends BasicCompactionEngine {
  override async summarize(input: SummarizationInput, agent: Agent, signal?: AbortSignal): Promise<SummaryResult> {
    return summarizeWithLlm(this.ctx, {
      summarizationProvider: MODEL,
      summarizationModel: MODEL,
      maxTokens: 64,
    }, input, agent, signal, { inputBudgetTokens: 800 })
  }
}

function image(name: string): Extract<ContentBlock, { type: 'image' }> {
  return {
    type: 'image',
    attachment: {
      attachmentId: `sha256:${'a'.repeat(64)}` as never,
      name, mediaType: 'image/png', bytes: 1, width: 1, height: 1,
    },
  }
}

const contexts: Context[] = []
afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

describe('window-clipped summarization image-offload ordering', () => {
  it('carries the exact replayed seqs on the image-cap failure', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    new LlmRuntime(ctx)
    ctx.llm.registerAdapter([MODEL], new OffloadRequiredAdapter())
    const session = Session.create(SessionId('replay-unit'), [])
    const agent = { session, options: { provider: MODEL, model: MODEL } } as Agent

    const oldest = createUserMessage({ content: [{ type: 'text', text: 'a'.repeat(4_000) }], source: { kind: 'user' } })
    const oldest2 = createUserMessage({ content: [{ type: 'text', text: 'b'.repeat(4_000) }], source: { kind: 'user' } })
    const newest = createUserMessage({ content: [{ type: 'text', text: 'newest' }, image('third')], source: { kind: 'user' } })

    let caught: unknown
    try {
      await summarizeWithLlm(ctx, { summarizationProvider: MODEL, summarizationModel: MODEL, maxTokens: 64 }, {
        messages: [oldest, oldest2, newest],
        regionSeqs: [SessionSeq(1), SessionSeq(2), SessionSeq(3)],
      }, agent, undefined, { inputBudgetTokens: 800 })
    } catch (error: unknown) {
      caught = error
    }
    expect(caught).toBeInstanceOf(SummarizationReplayError)
    const replay = caught as SummarizationReplayError
    // Only the newest message fit the budget; the clipped oldest messages are
    // not part of the failed request and must not be offered for offload.
    expect(replay.replayedSourceSeqs).toEqual([SessionSeq(3)])
    expect(replay.code).toBe(IMAGE_OFFLOAD_REQUIRED_CODE)
    expect(replay.failure.offloadImages).toBe(1)
  })

  it('offloads from the replayed messages, then the retried replay lands its checkpoint', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(TokenMeter)
    await ctx.plugin(imageOffload)
    const adapter = new OffloadThenSummaryAdapter()
    ctx.llm.registerAdapter([MODEL], adapter)

    const sessionId = SessionId('replay-order')
    const header: SessionHeader = {
      version: SESSION_FORMAT_VERSION, id: sessionId, createdAt: 1, isSeeded: false, cwd: '/workspace',
    }
    const session = ctx.sessions.create(sessionId, { meta: header })
    const engine = new ClippedReplayEngine(ctx, {
      auto: false, summarizationProvider: MODEL, summarizationModel: MODEL,
    })
    const agent = { session, options: { provider: MODEL, model: MODEL } } as Agent

    const oldest = session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'a'.repeat(4_000) }, image('first')],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    const middle = session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'b'.repeat(4_000) }, image('second')],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    const newest = session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'newest' }, image('third')],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('turn/start', { turn: 1 })

    const result = await engine.compactRegion(oldest.seq, newest.seq, agent)

    const decisions = session.snapshotEvents().filter(event => event.type === 'image/offload')
    // The failed request carried only the newest message, so only its image is
    // offloaded; the clipped oldest images stay untouched.
    expect(decisions.map(event => event.data)).toEqual([
      { targets: [{ seq: newest.seq, imageIndexes: [0] }] },
    ])
    expect(adapter.requests).toBe(2)
    expect(result.shadowedSeqs).toEqual([oldest.seq, middle.seq, newest.seq])
  })
})
