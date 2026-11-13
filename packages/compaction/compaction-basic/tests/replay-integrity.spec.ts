import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import BasicCompactionEngine from '@deepseek-ai/dsh-compaction-basic'
import { CompactionId, compactCheckpointSource } from '@deepseek-ai/dsh-compaction'
import {
  createAssistantMessage,
  createDeveloperMessage,
  createMessage,
  createSystemMessage,
  createToolResultMessage,
  createUserMessage,
  LlmAdapter,
  LlmRuntime,
  ToolCallId,
} from '@deepseek-ai/dsh-llm'
import type {
  ContentBlock,
  ContextFormed,
  GenerateOptions,
  LlmResolvedModelInfo,
  Message,
  RequestMessage,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { Session, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { projectSummarizationReplay } from '../src/replay.ts'
import { SUMMARIZER_PRIVATE_REASONING_CODE, summarizeWithLlm } from '../src/summarizer.ts'
import type { SummarizationInput, SummaryResult } from '../src/summarizer.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'test-context': { kind: 'test-context' } & ContextFormed
    'test-context-plain': { kind: 'test-context-plain' } & ContextFormed
    'test-context-with-a-very-long-source-kind-name-that-exceeds-the-bound': {
      kind: 'test-context-with-a-very-long-source-kind-name-that-exceeds-the-bound'
    } & ContextFormed
  }
  interface ContentBlockMap {
    'test-opaque': { type: 'test-opaque'; text: string }
    'test-nested': { type: 'test-nested'; content: readonly ContentBlock[] }
  }
}

const MODEL = 'integrity-model'
const SIGNAL = new AbortController().signal

class RecordingAdapter extends LlmAdapter {
  calls = 0
  messages: readonly RequestMessage[] = []
  summary = 'public checkpoint'

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      context: { contextWindow: 200_000 },
    })
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.calls += 1
    this.messages = [...options.messages]
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: this.summary } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

class FailingAdapter extends RecordingAdapter {
  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.calls += 1
    this.messages = [...options.messages]
    throw new Error('summarizer offline')
  }
}

class RecordingCustomEngine extends BasicCompactionEngine {
  calls = 0
  inputs: SummarizationInput[] = []

  override async summarize(
    input: SummarizationInput,
    _agent: Agent,
    _signal?: AbortSignal,
  ): Promise<SummaryResult> {
    this.calls += 1
    this.inputs.push(input)
    return {
      summary: [{ type: 'text', text: 'custom public checkpoint' }],
      provider: 'custom-provider',
      model: 'custom-model',
      maxTokens: 64,
    }
  }
}

function createContext(adapter: LlmAdapter): Context {
  const ctx = new Context()
  void new LlmRuntime(ctx)
  new SessionProjectionRegistry(ctx)
  void new TokenMeter(ctx)
  const visible = new Set(['session_event_search', 'session_event_read'])
  ctx.reflect.provide('tools', {
    get: (name: string) => visible.has(name) ? { name } : undefined,
  })
  ctx.llm.registerAdapter([MODEL], adapter)
  return ctx
}

function agent(session: Session): Agent {
  return { session, options: { provider: MODEL, model: MODEL } } as Agent
}

function engine(ctx: Context): BasicCompactionEngine {
  return new BasicCompactionEngine(ctx, {
    auto: false,
    headroomTokens: 0,
    maxTokens: 1_024,
  })
}

/** One closed reasoning + tool batch followed by an open compaction turn. */
function reasoningToolSession(text = 'alpha '.repeat(120).trim()): {
  session: Session
  system: SessionSeq
  user: SessionSeq
  assistant: SessionSeq
  result: SessionSeq
} {
  const session = Session.create(SessionId('replay-integrity-tools'))
  session.append('turn/start', { turn: 1 })
  const system = session.append('system/message', {
    turn: 1,
    step: 1,
    message: createSystemMessage('SYSTEM HEAD'),
  }, { surfaceOp: 'append' }).seq
  const user = session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: `${text} human request` }],
    source: { kind: 'user', participant: { kind: 'human', name: 'adam' } },
  }), { surfaceOp: 'append' }).seq
  session.append('step/start', { turn: 1, step: 1 })
  const callId = ToolCallId('call-integrity')
  const assistant = session.append('assistant/message', {
    stream: [],
    turn: 1,
    step: 1,
    message: createAssistantMessage({
      content: [
        { type: 'reasoning', text: 'SECRET REASONING TEXT' },
        { type: 'text', text: `${text} public answer` },
        { type: 'tool-call', id: callId, name: 'read', arguments: '{"path":"a.txt"}' },
      ],
      source: { provider: MODEL, model: MODEL },
    }),
  }, { surfaceOp: 'append' }).seq
  session.append('tool/call', {
    turn: 1,
    step: 1,
    callId,
    name: 'read',
    arguments: '{"path":"a.txt"}',
  })
  const result = session.append('tool/result', {
    turn: 1,
    step: 1,
    message: createToolResultMessage({
      callId,
      content: [{ type: 'text', text: `${text} tool output` }],
      isError: false,
    }),
  }, { surfaceOp: 'append' }).seq
  session.append('step/end', { turn: 1, step: 1 })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  session.append('turn/start', { turn: 2 })
  return { session, system, user, assistant, result }
}

function allBlocks(messages: readonly Message[]): ContentBlock[] {
  return messages.flatMap(message => [...message.content])
}

function textOf(messages: readonly RequestMessage[]): string {
  return messages.flatMap(message => message.content)
    .flatMap(block => block.type === 'text' ? [block.text] : [])
    .join('\n')
}

describe('public summarizer replay integrity', () => {
  it('never sends private reasoning through the real region transaction and keeps public evidence', async () => {
    const adapter = new RecordingAdapter()
    const ctx = createContext(adapter)
    const { session, system, user, assistant, result } = reasoningToolSession()
    const systemEvent = session.eventAt(system)!
    const userEvent = session.eventAt(user)!
    const assistantEvent = session.eventAt(assistant)!
    const originalAssistantContent = [...assistantEvent.type === 'assistant/message'
      ? assistantEvent.data.message.content
      : []]
    const compact = engine(ctx)

    await compact.compactRegion(user, result, agent(session), SIGNAL)

    expect(adapter.calls).toBe(1)
    const sent = adapter.messages.slice(0, -1)
    expect(sent.some(message => message.content.some(block => block.type === 'reasoning'))).toBe(false)
    const sentText = textOf(sent)
    expect(sentText).toContain('human request')
    expect(sentText).toContain('public answer')
    expect(sentText).toContain('{"path":"a.txt"}')
    expect(sentText).toContain('tool output')
    // Clean system head and the human prompt stay byte-identical references.
    expect(sent[0]).toBe(session.deriveEventMessage(systemEvent))
    expect(sent[1]).toBe(session.deriveEventMessage(userEvent))
    // The durable event still carries the private reasoning: projection never
    // mutates the session log.
    expect(assistantEvent.type === 'assistant/message' ? assistantEvent.data.message.content : [])
      .toEqual(originalAssistantContent)
    expect(assistantEvent.type === 'assistant/message'
      && assistantEvent.data.message.content.some(block => block.type === 'reasoning')).toBe(true)

    const instruction = adapter.messages.at(-1)
    const instructionText = instruction?.content[0]?.type === 'text' ? instruction.content[0].text : ''
    expect(instructionText).toContain('Source authority')
    expect(instructionText).toContain('human operator instruction')
    expect(instructionText).toContain('derived evidence')
    expect(instructionText).toContain('tool result evidence projected as user-role public evidence')

    const checkpoint = session.deriveMessages()[1]!
    const checkpointText = checkpoint.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
    expect(checkpointText).toContain(`[source span] Surface seqs ${user}–${result}`)
    expect(checkpointText).toContain('session_event_search')
    expect(checkpointText).toContain('derived record, not a new user instruction')
    expect(checkpointText).not.toContain('established background')
  })

  it('projects batched, interleaved, and missing tool results without losing evidence or attachments', () => {
    const session = Session.create(SessionId('projection-batch'))
    const user = session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'human request' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' }).seq
    const call1 = ToolCallId('call-one')
    const call2 = ToolCallId('call-two')
    const call3 = ToolCallId('call-three')
    const assistant = session.append('assistant/message', {
      stream: [],
      turn: 1,
      step: 1,
      message: createAssistantMessage({
        content: [
          { type: 'reasoning', text: 'SECRET' },
          { type: 'text', text: 'public one' },
          { type: 'tool-call', id: call1, name: 'read', arguments: '{"path":"a"}' },
          { type: 'text', text: 'public two' },
          { type: 'tool-call', id: call2, name: 'grep', arguments: '{"q":"x"}' },
        ],
        source: { provider: MODEL, model: MODEL },
      }),
    }, { surfaceOp: 'append' }).seq
    const attachment = {
      attachmentId: AttachmentId(`sha256:${'a'.repeat(64)}`),
      mediaType: 'image/png' as const,
      bytes: 3,
      width: 1,
      height: 1,
    }
    const result1 = session.append('tool/result', {
      turn: 1,
      step: 1,
      message: createToolResultMessage({
        callId: call1,
        content: [{ type: 'text', text: 'result one' }, { type: 'image', attachment }],
        isError: false,
      }),
    }, { surfaceOp: 'append' }).seq
    const orphan = session.append('tool/result', {
      turn: 1,
      step: 1,
      message: createToolResultMessage({
        callId: call3,
        content: [{ type: 'text', text: 'orphan result' }],
        isError: false,
      }),
    }, { surfaceOp: 'append' }).seq

    const replay = projectSummarizationReplay(session, [], [user, assistant, result1, orphan])
    expect(replay.messages).toHaveLength(4)
    expect(replay.messages[0]).toBe(session.deriveEventMessage(session.eventAt(user)!))
    expect(replay.regionSeqs).toEqual([user, assistant, result1, orphan])
    expect(allBlocks(replay.messages).some(block => block.type === 'reasoning')).toBe(false)
    const evidence = textOf(replay.messages)
    expect(evidence).toContain('public one')
    expect(evidence).toContain('public two')
    expect(evidence).toContain('[tool call evidence] call-one read({"path":"a"})')
    expect(evidence).toContain('[tool call evidence] call-two grep({"q":"x"})')
    expect(evidence).toContain('[tool result evidence] call-two (no result recorded in this replay)')
    expect(evidence).toContain('[tool result evidence] call-one for read')
    expect(evidence).toContain('result one')
    expect(evidence).toContain('[tool result evidence] call-three (originating call not in this replay)')
    expect(evidence).toContain('orphan result')
    expect(replay.messages[2]?.content.some(block => block.type === 'image')).toBe(true)
    expect(replay.sourceIndex?.some(ref => ref.authority.includes('tool result evidence projected'))).toBe(true)
  })

  it('keeps a clean replay byte-identical and omits the source index', () => {
    const session = Session.create(SessionId('projection-clean'))
    const system = session.append('system/message', {
      turn: 1,
      step: 1,
      message: createSystemMessage('SYSTEM HEAD'),
    }, { surfaceOp: 'append' }).seq
    const user = session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'human request' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' }).seq
    const callId = ToolCallId('clean-call')
    const assistant = session.append('assistant/message', {
      stream: [],
      turn: 1,
      step: 1,
      message: createAssistantMessage({
        content: [
          { type: 'text', text: 'public answer' },
          { type: 'tool-call', id: callId, name: 'read', arguments: '{"path":"a"}' },
        ],
        source: { provider: MODEL, model: MODEL },
      }),
    }, { surfaceOp: 'append' }).seq
    const result = session.append('tool/result', {
      turn: 1,
      step: 1,
      message: createToolResultMessage({
        callId,
        content: [{ type: 'text', text: 'tool output' }],
        isError: false,
      }),
    }, { surfaceOp: 'append' }).seq

    const replay = projectSummarizationReplay(session, [user], [assistant, result])
    expect(replay.messages).toEqual([
      session.deriveEventMessage(session.eventAt(system)!),
      session.deriveEventMessage(session.eventAt(user)!),
      session.deriveEventMessage(session.eventAt(assistant)!),
      session.deriveEventMessage(session.eventAt(result)!),
    ])
    expect(replay.messages[0]).toBe(session.deriveEventMessage(session.eventAt(system)!))
    expect(replay.messages[1]).toBe(session.deriveEventMessage(session.eventAt(user)!))
    expect(replay.messages[2]).toBe(session.deriveEventMessage(session.eventAt(assistant)!))
    expect(replay.messages[3]).toBe(session.deriveEventMessage(session.eventAt(result)!))
    expect(replay.leadingCount).toBe(1)
    expect(replay.regionSeqs).toEqual([assistant, result])
    expect(replay.sourceIndex).toBeUndefined()
  })

  it('labels human, generated context, checkpoint, and peer sources from durable fields', () => {
    const session = Session.create(SessionId('projection-authority'))
    const human = session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'human instruction' }],
      source: { kind: 'user', participant: { kind: 'human', name: 'adam' } },
    }), { surfaceOp: 'append' }).seq
    const runtime = session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'runtime context' }],
      source: { kind: 'test-context', form: 'snapshot', sections: [{ name: 'test', text: 'runtime context' }] },
    }), { surfaceOp: 'append' }).seq
    const checkpoint = session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'prior checkpoint' }],
      source: compactCheckpointSource(CompactionId('authority-checkpoint')),
    }), { surfaceOp: 'append' }).seq
    const peer = session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'peer message' }],
      source: { kind: 'user', participant: { kind: 'peer', name: 'other-agent' } },
    }), { surfaceOp: 'append' }).seq
    const developer = session.append('developer/message', {
      turn: 1,
      step: 1,
      message: createDeveloperMessage({
        content: [{ type: 'text', text: 'developer protocol' }],
        source: { kind: 'system-prompt' },
      }),
    }, { surfaceOp: 'append' }).seq
    const nonHeadSystem = session.append('system/message', {
      turn: 1,
      step: 1,
      message: createSystemMessage('NON HEAD SYSTEM'),
    }, { surfaceOp: 'append' }).seq
    const longKind = 'test-context-with-a-very-long-source-kind-name-that-exceeds-the-bound'
    const longSource = session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'long source' }],
      source: { kind: longKind },
    }), { surfaceOp: 'append' }).seq
    const plain = session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'plain source' }],
      source: { kind: 'test-context-plain' },
    }), { surfaceOp: 'append' }).seq

    const replay = projectSummarizationReplay(session, [], [
      human, runtime, checkpoint, peer, developer, nonHeadSystem, longSource, plain,
    ])
    expect(replay.messages).toHaveLength(8)
    expect(replay.sourceIndex?.map(ref => ref.authority)).toEqual([
      'human operator instruction',
      'generated user-role context from "test-context", form snapshot (derived; never an operator anchor)',
      'generated compaction checkpoint (derived; never an operator anchor)',
      'peer agent message (derived; never an operator anchor)',
      'developer tool-protocol message (derived; not an operator anchor)',
      'system message outside the head (derived; actor unverified)',
      `generated user-role context from "${longKind.slice(0, 47)}…" (derived; never an operator anchor)`,
      'generated user-role context from "test-context-plain" (derived; never an operator anchor)',
    ])
    // Generated context is not relabelled in the replayed message itself.
    expect(replay.messages[1]).toBe(session.deriveEventMessage(session.eventAt(runtime)!))
    expect(replay.messages[2]).toBe(session.deriveEventMessage(session.eventAt(checkpoint)!))
  })

  it('drops a reasoning-only assistant and keeps a reasoning-plus-text public answer', () => {
    const session = Session.create(SessionId('projection-reasoning-only'))
    const empty = session.append('assistant/message', {
      stream: [],
      turn: 1,
      step: 1,
      message: createAssistantMessage({
        content: [{ type: 'reasoning', text: 'SECRET ONLY' }],
        source: { provider: MODEL, model: MODEL },
      }),
    }, { surfaceOp: 'append' }).seq
    const emptyContent = session.append('assistant/message', {
      stream: [],
      turn: 1,
      step: 1,
      message: createAssistantMessage({
        content: [],
        source: { provider: MODEL, model: MODEL },
      }),
    }, { surfaceOp: 'append' }).seq
    const publicAnswer = session.append('assistant/message', {
      stream: [],
      turn: 1,
      step: 1,
      message: createAssistantMessage({
        content: [
          { type: 'reasoning', text: 'SECRET' },
          { type: 'text', text: 'public answer' },
        ],
        source: { provider: MODEL, model: MODEL, chain: 'test-chain' },
      }),
    }, { surfaceOp: 'append' }).seq

    const replay = projectSummarizationReplay(session, [], [empty, emptyContent, publicAnswer])
    expect(replay.messages).toHaveLength(1)
    expect(replay.messages[0]?.role).toBe('assistant')
    expect(replay.regionSeqs).toEqual([publicAnswer])
    expect(textOf(replay.messages)).toContain('public answer')
    expect(replay.messages[0]?.content.some(block => block.type === 'reasoning')).toBe(false)
    expect(replay.sourceIndex?.[0]?.authority)
      .toBe('public assistant output (private reasoning omitted; never an operator anchor)')

    // A dropped leading node keeps leadingCount absent instead of leaving the
    // projected messages and their seqs misaligned.
    const withLeading = projectSummarizationReplay(session, [empty], [publicAnswer])
    expect(withLeading.leadingCount).toBeUndefined()
    expect(withLeading.messages).toHaveLength(1)
    expect(withLeading.regionSeqs).toEqual([publicAnswer])
  })

  it('rejects reasoning in a pass-through user message and unknown blocks in affected content', () => {
    const session = Session.create(SessionId('projection-rejections'))
    const user = session.append('user/message', createUserMessage({
      content: [{ type: 'reasoning', text: 'SECRET' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' }).seq
    expect(() => projectSummarizationReplay(session, [], [user]))
      .toThrow(/user message carries private reasoning/)

    const assistant = session.append('assistant/message', {
      stream: [],
      turn: 1,
      step: 1,
      message: createAssistantMessage({
        content: [
          { type: 'reasoning', text: 'SECRET' },
          { type: 'test-opaque', text: 'opaque' },
        ],
        source: { provider: MODEL, model: MODEL },
      }),
    }, { surfaceOp: 'append' }).seq
    expect(() => projectSummarizationReplay(session, [], [assistant]))
      .toThrow(/assistant message carries unsupported test-opaque content/)

    const callId = ToolCallId('opaque-tool')
    const toolAssistant = session.append('assistant/message', {
      stream: [],
      turn: 1,
      step: 1,
      message: createAssistantMessage({
        content: [
          { type: 'reasoning', text: 'SECRET' },
          { type: 'tool-call', id: callId, name: 'read', arguments: '{}' },
        ],
        source: { provider: MODEL, model: MODEL },
      }),
    }, { surfaceOp: 'append' }).seq
    const toolResult = session.append('tool/result', {
      turn: 1,
      step: 1,
      message: createToolResultMessage({
        callId,
        content: [{ type: 'test-opaque', text: 'opaque tool output' }],
        isError: true,
      }),
    }, { surfaceOp: 'append' }).seq
    expect(() => projectSummarizationReplay(session, [], [toolAssistant, toolResult]))
      .toThrow(/tool result opaque-tool carries unsupported test-opaque content/)
  })

  it('refuses a direct summarizer input that still carries private reasoning', async () => {
    const adapter = new RecordingAdapter()
    const ctx = createContext(adapter)
    const session = Session.create(SessionId('direct-reasoning'))
    const input: SummarizationInput = {
      messages: [createAssistantMessage({
        content: [
          { type: 'reasoning', text: 'SECRET' },
          { type: 'text', text: 'public answer' },
        ],
        source: { provider: MODEL, model: MODEL },
      })],
    }

    await expect(summarizeWithLlm(ctx, {
      summarizationProvider: MODEL,
      summarizationModel: MODEL,
      maxTokens: 64,
    }, input, agent(session), SIGNAL)).rejects.toMatchObject({
      code: SUMMARIZER_PRIVATE_REASONING_CODE,
    })
    expect(adapter.calls).toBe(0)
  })

  it('falls back to the mechanical omission when an affected batch cannot be summarized', async () => {
    const adapter = new FailingAdapter()
    const ctx = createContext(adapter)
    const { session, user, result } = reasoningToolSession()
    const compact = engine(ctx)

    await compact.compactRegion(user, result, agent(session), SIGNAL)

    expect(adapter.calls).toBe(1)
    expect(adapter.messages.some(message => message.content.some(block => block.type === 'reasoning'))).toBe(false)
    const checkpoint = session.deriveMessages().findLast(message =>
      message.role === 'user' && message.source.kind === 'compact-checkpoint')
    expect(checkpoint).toBeDefined()
    const checkpointText = checkpoint?.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n') ?? ''
    expect(checkpointText).toContain('<compacted-omission>')
    expect(checkpointText).toContain('Removed surface seqs')
    const summary = session.snapshotEvents().findLast(event => event.type === 'compaction/summary')
    expect(summary?.type === 'compaction/summary' ? summary.data.summarizationFailure?.code : undefined)
      .toBeTypeOf('string')
  })

  it('uses the mechanical omission when the framed summary would not shrink the span', async () => {
    const adapter = new RecordingAdapter()
    adapter.summary = 'oversized checkpoint '.repeat(2_000)
    const ctx = createContext(adapter)
    const { session, user, result } = reasoningToolSession()
    const compact = engine(ctx)

    await compact.compactRegion(user, result, agent(session), SIGNAL)

    expect(adapter.calls).toBe(1)
    const checkpoint = session.deriveMessages().findLast(message =>
      message.role === 'user' && message.source.kind === 'compact-checkpoint')
    const text = checkpoint?.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n') ?? ''
    expect(text).toContain('<compacted-omission>')
    expect(text).not.toContain('oversized checkpoint')
  })

  it('makes no auxiliary call when pressure is below the threshold', async () => {
    const adapter = new RecordingAdapter()
    const ctx = createContext(adapter)
    const session = Session.create(SessionId('below-threshold'))
    session.append('request/header', {
      header: { config: { provider: MODEL, model: MODEL } },
      reason: 'initial',
    })
    session.append('turn/start', { turn: 1 })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'small request' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    const compact = new BasicCompactionEngine(ctx, {
      auto: false,
      headroomTokens: 0,
      maxTokens: 1_024,
      thresholdRatio: 0.9,
      retainTokens: 1,
    })

    await expect(compact.compactIfNeeded(agent(session), 'pressure', SIGNAL)).resolves.toBeNull()
    expect(adapter.calls).toBe(0)
  })

  it('converts a clipped orphan tool result into user-role evidence', async () => {
    const adapter = new RecordingAdapter()
    const ctx = createContext(adapter)
    const session = Session.create(SessionId('clipped-orphan'))
    const callId = ToolCallId('clipped-call')
    const assistant = createAssistantMessage({
      content: [
        { type: 'text', text: 'assistant evidence '.repeat(200) },
        { type: 'tool-call', id: callId, name: 'read', arguments: '{"path":"a"}' },
      ],
      source: { provider: MODEL, model: MODEL },
    })
    const result = createToolResultMessage({
      callId,
      content: [{ type: 'text', text: 'kept tool output' }],
      isError: true,
    })

    await summarizeWithLlm(ctx, {
      summarizationProvider: MODEL,
      summarizationModel: MODEL,
      maxTokens: 64,
    }, { messages: [assistant, result] }, agent(session), SIGNAL, { inputBudgetTokens: 2_000 })

    const sent = adapter.messages.slice(0, -1)
    expect(sent).toHaveLength(1)
    expect(sent[0]?.role).toBe('user')
    const text = textOf(sent)
    expect(text).toContain('[tool result evidence] clipped-call (originating call not in this replay) [error]')
    expect(text).toContain('kept tool output')
    expect(sent.some(message => message.role === 'tool')).toBe(false)
    const instruction = adapter.messages.at(-1)
    const instructionText = instruction?.content[0]?.type === 'text' ? instruction.content[0].text : ''
    expect(instructionText).toContain('Source authority')
    expect(instructionText).toContain('tool result evidence projected as user-role public evidence')
  })

  it('bounds the source index by entry count and by characters', async () => {
    const adapter = new RecordingAdapter()
    const ctx = createContext(adapter)
    const session = Session.create(SessionId('index-bounds'))
    const messages = Array.from({ length: 33 }, (_, index) => createUserMessage({
      content: [{ type: 'text', text: `message ${index}` }],
      source: { kind: 'user' },
    }))
    const refs = messages.map((_, index) => ({
      seq: SessionSeq(index + 1),
      authority: 'generated user-role context (derived)',
      authorityClass: 'derived' as const,
    }))
    await summarizeWithLlm(ctx, {
      summarizationProvider: MODEL,
      summarizationModel: MODEL,
      maxTokens: 64,
    }, {
      messages,
      regionSeqs: refs.map(ref => ref.seq),
      sourceIndex: refs,
    }, agent(session), SIGNAL)
    const countCapped = adapter.messages.at(-1)
    expect(countCapped?.content[0]?.type === 'text' ? countCapped.content[0].text : '')
      .toContain('... 1 more replayed message')

    const charAdapter = new RecordingAdapter()
    const charCtx = createContext(charAdapter)
    const longMessages = Array.from({ length: 34 }, (_, index) => createUserMessage({
      content: [{ type: 'text', text: `long ${index}` }],
      source: { kind: 'user' },
    }))
    const longRefs = longMessages.map((_, index) => ({
      seq: SessionSeq(index + 1),
      authority: `generated context ${'x'.repeat(100)}`,
      authorityClass: 'derived' as const,
    }))
    await summarizeWithLlm(charCtx, {
      summarizationProvider: MODEL,
      summarizationModel: MODEL,
      maxTokens: 64,
    }, {
      messages: longMessages,
      regionSeqs: longRefs.map(ref => ref.seq),
      sourceIndex: longRefs,
    }, agent(session), SIGNAL)
    const charCapped = charAdapter.messages.at(-1)
    const charText = charCapped?.content[0]?.type === 'text' ? charCapped.content[0].text : ''
    expect(charText).toContain('more replayed messages')
    const sourceIndexText = charText.slice(charText.indexOf('Selected conversation sources'))
    expect(sourceIndexText.length).toBeLessThanOrEqual(4_096)
  })

  it('keeps a clean tool protocol and rejects an unsupported orphan result', async () => {
    const adapter = new RecordingAdapter()
    const ctx = createContext(adapter)
    const session = Session.create(SessionId('clean-tool-protocol'))
    const callId = ToolCallId('clean-protocol-call')
    const assistant = createAssistantMessage({
      content: [
        { type: 'text', text: 'calling' },
        { type: 'tool-call', id: callId, name: 'read', arguments: '{}' },
      ],
      source: { provider: MODEL, model: MODEL },
    })
    const result = createToolResultMessage({
      callId,
      content: [{ type: 'text', text: 'tool output' }],
      isError: false,
    })
    await summarizeWithLlm(ctx, {
      summarizationProvider: MODEL,
      summarizationModel: MODEL,
      maxTokens: 64,
    }, { messages: [assistant, result] }, agent(session), SIGNAL)
    expect(adapter.messages.slice(0, -1).map(message => message.role)).toEqual(['assistant', 'tool'])

    const orphan = createToolResultMessage({
      callId: ToolCallId('unsupported-orphan'),
      content: [{ type: 'test-opaque', text: 'opaque' }],
      isError: false,
    })
    await expect(summarizeWithLlm(ctx, {
      summarizationProvider: MODEL,
      summarizationModel: MODEL,
      maxTokens: 64,
    }, { messages: [orphan] }, agent(session), SIGNAL)).rejects.toMatchObject({
      code: 'UNSUPPORTED_CONTENT',
    })
  })

  it('rejects unsupported affected content and still lands the mechanical omission', async () => {
    const adapter = new RecordingAdapter()
    const ctx = createContext(adapter)
    const session = Session.create(SessionId('unsupported-content'))
    session.append('turn/start', { turn: 1 })
    const user = session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'human request '.repeat(120) }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' }).seq
    session.append('step/start', { turn: 1, step: 1 })
    const callId = ToolCallId('unsupported-call')
    const assistant = session.append('assistant/message', {
      stream: [],
      turn: 1,
      step: 1,
      message: createAssistantMessage({
        content: [
          { type: 'reasoning', text: 'SECRET' },
          { type: 'test-opaque', text: 'opaque public content' },
          { type: 'tool-call', id: callId, name: 'read', arguments: '{}' },
        ],
        source: { provider: MODEL, model: MODEL },
      }),
    }, { surfaceOp: 'append' }).seq
    session.append('tool/result', {
      turn: 1,
      step: 1,
      message: createToolResultMessage({
        callId,
        content: [{ type: 'text', text: 'tool output '.repeat(120) }],
        isError: false,
      }),
    }, { surfaceOp: 'append' })
    session.append('step/end', { turn: 1, step: 1 })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    session.append('turn/start', { turn: 2 })
    const assistantEvent = session.eventAt(assistant)!

    await engine(ctx).compactRegion(user, session.surface.nodes.at(-1)!, agent(session), SIGNAL)

    expect(adapter.calls).toBe(0)
    expect(assistantEvent.type === 'assistant/message'
      && assistantEvent.data.message.content.some(block => block.type === 'test-opaque')).toBe(true)
    const checkpoint = session.deriveMessages().findLast(message =>
      message.role === 'user' && message.source.kind === 'compact-checkpoint')
    expect(checkpoint?.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n'))
      .toContain('<compacted-omission>')
  })
  it('keeps an explicit operator beyond the oldest-32 cap and labels no-actor users unverified', async () => {
    const session = Session.create(SessionId('operator-beyond-cap'))
    const generated: SessionSeq[] = []
    for (let index = 0; index < 32; index += 1) {
      generated.push(session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: `past generated ${index}` }],
        source: { kind: 'test-context' },
      }), { surfaceOp: 'append' }).seq)
    }
    const operator = session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'operator request' }],
      source: { kind: 'user', participant: { kind: 'human', name: 'adam' } },
    }), { surfaceOp: 'append' }).seq
    for (let index = 0; index < 100; index += 1) {
      generated.push(session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: `recent generated ${index}` }],
        source: { kind: 'test-context' },
      }), { surfaceOp: 'append' }).seq)
    }
    const noActor = session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'legacy task request' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' }).seq
    const region = [...generated, operator, noActor]
    const replay = projectSummarizationReplay(session, [], region)
    expect(replay.sourceIndex?.find(ref => ref.seq === operator)?.authority)
      .toBe('human operator instruction')
    expect(replay.sourceIndex?.find(ref => ref.seq === noActor)?.authority)
      .toBe('user-role message, actor unverified (task input, not a standing directive)')

    const adapter = new RecordingAdapter()
    const ctx = createContext(adapter)
    await summarizeWithLlm(ctx, {
      summarizationProvider: MODEL,
      summarizationModel: MODEL,
      maxTokens: 64,
    }, {
      messages: replay.messages,
      regionSeqs: replay.regionSeqs,
      ...(replay.sourceIndex === undefined ? {} : { sourceIndex: replay.sourceIndex }),
    }, agent(session), SIGNAL)
    const instruction = adapter.messages.at(-1)
    const text = instruction?.content[0]?.type === 'text' ? instruction.content[0].text : ''
    expect(text).toContain('human operator instruction')
    expect(text).toContain('user-role message, actor unverified')
    expect(text).toContain('not an exhaustive authority map')
    expect(text).toContain('more replayed messages are not listed')
  })

  it('rejects nested private reasoning at the system-head projection boundary', () => {
    const session = Session.create(SessionId('nested-head-reasoning'))
    session.append('system/message', {
      turn: 1,
      step: 1,
      message: createMessage({
        role: 'system',
        content: [{
          type: 'test-nested',
          content: [{ type: 'reasoning', text: 'SECRET NESTED' }],
        }],
        source: { kind: 'system-prompt' },
      }),
    }, { surfaceOp: 'append' })
    const user = session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'task' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' }).seq

    expect(() => projectSummarizationReplay(session, [], [user]))
      .toThrow(/system message carries private reasoning/)
  })

  it('rejects nested private reasoning in an otherwise clean assistant before custom summarization', () => {
    const session = Session.create(SessionId('nested-assistant-reasoning'))
    const assistant = session.append('assistant/message', {
      stream: [],
      turn: 1,
      step: 1,
      message: createAssistantMessage({
        content: [{
          type: 'test-nested',
          content: [{ type: 'reasoning', text: 'SECRET NESTED' }],
        }],
        source: { provider: MODEL, model: MODEL },
      }),
    }, { surfaceOp: 'append' }).seq

    expect(() => projectSummarizationReplay(session, [], [assistant]))
      .toThrow(/assistant message carries private reasoning/)
  })

  it('gives a custom summarizer only public input and no LLM or mechanical fallback', async () => {
    const adapter = new RecordingAdapter()
    const ctx = createContext(adapter)
    const { session, user, result } = reasoningToolSession()
    const compact = new RecordingCustomEngine(ctx, {
      auto: false,
      headroomTokens: 0,
      maxTokens: 1_024,
    })

    await compact.compactRegion(user, result, agent(session), SIGNAL)

    expect(compact.calls).toBe(1)
    expect(adapter.calls).toBe(0)
    expect(compact.inputs[0]?.messages.some(message =>
      message.content.some(block => block.type === 'reasoning'))).toBe(false)
    const checkpoint = session.deriveMessages().findLast(message =>
      message.role === 'user' && message.source.kind === 'compact-checkpoint')
    const text = checkpoint?.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n') ?? ''
    expect(text).toContain('<compacted-summary>')
    expect(text).not.toContain('<compacted-omission>')
  })

  it('propagates a non-projection programming fault instead of hiding it', async () => {
    const adapter = new RecordingAdapter()
    const ctx = createContext(adapter)
    const { session, user, result } = reasoningToolSession()
    const fault = new Error('programming fault')
    const spy = vi.spyOn(session, 'deriveEventMessage').mockImplementation(() => {
      throw fault
    })

    await expect(engine(ctx).compactRegion(user, result, agent(session), SIGNAL))
      .rejects.toBe(fault)
    expect(session.snapshotEvents().some(event => event.type === 'compaction/summary')).toBe(false)
    spy.mockRestore()
  })

  it('prices a long recent index entry even when clipping keeps only that subset', async () => {
    const adapter = new RecordingAdapter()
    const ctx = createContext(adapter)
    const session = Session.create(SessionId('long-recent-index'))
    const messages = Array.from({ length: 40 }, (_, index) => createUserMessage({
      content: [{ type: 'text', text: `old ${index} ${'x'.repeat(4_000)}` }],
      source: { kind: 'user' },
    }))
    const recent = createUserMessage({
      content: [{ type: 'text', text: 'recent task' }],
      source: { kind: 'user' },
    })
    const refs = messages.map((_, index) => ({
      seq: SessionSeq(index + 1),
      authority: 'short derived context',
      authorityClass: 'derived' as const,
    }))
    refs.push({
      seq: SessionSeq(41),
      authority: `long recent authority ${'y'.repeat(3_000)}`,
      authorityClass: 'derived',
    })

    await summarizeWithLlm(ctx, {
      summarizationProvider: MODEL,
      summarizationModel: MODEL,
      maxTokens: 64,
    }, {
      messages: [...messages, recent],
      regionSeqs: refs.map(ref => ref.seq),
      sourceIndex: refs,
    }, agent(session), SIGNAL, { inputBudgetTokens: 2_000 })

    expect(adapter.calls).toBe(1)
    expect(adapter.messages).toHaveLength(2)
    expect(textOf(adapter.messages.slice(0, -1))).toContain('recent task')
    expect(textOf(adapter.messages.slice(0, -1))).not.toContain('old 0 ')
    const instruction = adapter.messages.at(-1)
    const text = instruction?.content[0]?.type === 'text' ? instruction.content[0].text : ''
    expect(text).toContain('Selected conversation sources')
    const sourceIndexText = text.slice(text.indexOf('Selected conversation sources'))
    expect(sourceIndexText.length).toBeLessThanOrEqual(4_096)
  })

  it('removes provider replay state from a projected assistant message', () => {
    const session = Session.create(SessionId('assistant-replay-state'))
    const assistant = session.append('assistant/message', {
      stream: [],
      turn: 1,
      step: 1,
      message: createAssistantMessage({
        content: [
          { type: 'reasoning', text: 'SECRET' },
          { type: 'text', text: 'public answer' },
        ],
        source: {
          provider: MODEL,
          model: MODEL,
          replayState: { native: true },
        },
      }),
    }, { surfaceOp: 'append' }).seq

    const replay = projectSummarizationReplay(session, [], [assistant])
    expect(replay.messages).toHaveLength(1)
    expect(replay.messages[0]?.source).not.toHaveProperty('replayState')
    expect(textOf(replay.messages)).toContain('public answer')
  })

  it('reconstructs structured source attribution for a clean input repaired after clipping', async () => {
    const adapter = new RecordingAdapter()
    const ctx = createContext(adapter)
    const session = Session.create(SessionId('fallback-source'))
    const orphanLeading = createToolResultMessage({
      callId: ToolCallId('orphan-leading'),
      content: [{ type: 'text', text: 'leading orphan' }],
      isError: false,
    })
    const orphanRegion = createToolResultMessage({
      callId: ToolCallId('orphan-region'),
      content: [{ type: 'text', text: 'region orphan' }],
      isError: true,
    })
    const messages: Message[] = [
      createSystemMessage('SYSTEM'),
      orphanLeading,
      createUserMessage({
        content: [{ type: 'text', text: 'checkpoint' }],
        source: compactCheckpointSource(CompactionId('fallback-checkpoint')),
      }),
      createDeveloperMessage({
        content: [{ type: 'text', text: 'developer' }],
        source: { kind: 'system-prompt' },
      }),
      createSystemMessage('NON HEAD SYSTEM'),
      createUserMessage({
        content: [{ type: 'text', text: 'peer' }],
        source: { kind: 'user', participant: { kind: 'peer', name: 'peer-agent' } },
      }),
      createUserMessage({
        content: [{ type: 'text', text: 'human' }],
        source: { kind: 'user', participant: { kind: 'human', name: 'adam' } },
      }),
      createUserMessage({
        content: [{ type: 'text', text: 'no actor' }],
        source: { kind: 'user' },
      }),
      createUserMessage({
        content: [{ type: 'text', text: 'generated' }],
        source: { kind: 'test-context' },
      }),
      createAssistantMessage({
        content: [{ type: 'text', text: 'assistant' }],
        source: { provider: MODEL, model: MODEL },
      }),
      orphanRegion,
    ]

    await summarizeWithLlm(ctx, {
      summarizationProvider: MODEL,
      summarizationModel: MODEL,
      maxTokens: 64,
    }, {
      messages,
      leadingCount: 1,
    }, agent(session), SIGNAL)

    const instruction = adapter.messages.at(-1)
    const text = instruction?.content[0]?.type === 'text' ? instruction.content[0].text : ''
    expect(text).toContain('system prompt (instruction; not an operator message)')
    expect(text).toContain('developer tool-protocol message (derived; not an operator anchor)')
    expect(text).toContain('system message outside the head (derived; actor unverified)')
    expect(text).toContain('generated compaction checkpoint (derived; never an operator anchor)')
    expect(text).toContain('peer agent message (derived; never an operator anchor)')
    expect(text).toContain('human operator instruction')
    expect(text).toContain('user-role message, actor unverified')
    expect(text).toContain('generated user-role context (derived; never an operator anchor)')
    expect(text).toContain('public assistant output')
    expect(text).toContain('tool result evidence projected as user-role public evidence')
    expect(textOf(adapter.messages.slice(0, -1))).toContain('[error]')
  })

  it('aligns the index and leading run after clipping the oldest region messages', async () => {
    const adapter = new RecordingAdapter()
    const ctx = createContext(adapter)
    const session = Session.create(SessionId('clip-alignment'))
    const system = createSystemMessage('SYSTEM')
    const pinned = createUserMessage({ content: [{ type: 'text', text: 'pinned prompt' }], source: { kind: 'user' } })
    const oldest = createUserMessage({
      content: [{ type: 'text', text: `oldest ${'x'.repeat(4_000)}` }],
      source: { kind: 'user' },
    })
    const recent = createUserMessage({ content: [{ type: 'text', text: 'recent task' }], source: { kind: 'user' } })
    const refs = [system, pinned, oldest, recent].map((_, index) => ({
      seq: SessionSeq(index + 1),
      authority: `entry ${index + 1}`,
      authorityClass: 'derived' as const,
    }))

    await summarizeWithLlm(ctx, {
      summarizationProvider: MODEL,
      summarizationModel: MODEL,
      maxTokens: 64,
    }, {
      messages: [system, pinned, oldest, recent],
      leadingCount: 1,
      regionSeqs: [SessionSeq(3), SessionSeq(4)],
      sourceIndex: refs,
    }, agent(session), SIGNAL, { inputBudgetTokens: 2_000 })

    expect(adapter.messages).toHaveLength(4)
    expect(adapter.messages[0]).toBe(system)
    expect(adapter.messages[1]).toBe(pinned)
    expect(adapter.messages[2]).toBe(recent)
    const instruction = adapter.messages.at(-1)
    const text = instruction?.content[0]?.type === 'text' ? instruction.content[0].text : ''
    expect(text).toContain('1. seq 1: entry 1')
    expect(text).toContain('2. seq 2: entry 2')
    expect(text).toContain('3. seq 4: entry 4')
    expect(text).not.toContain('seq 3:')
  })

})
