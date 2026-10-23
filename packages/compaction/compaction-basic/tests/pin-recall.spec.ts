/**
 * L1 context-UX: leading-user-message pinning, prefix-preserving summarizer
 * replay, and recall wording gated on the compacting agent's visible tools.
 */
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import BasicCompactionEngine from '@deepseek-ai/dsh-compaction-basic'
import type { BasicCompactionConfig } from '@deepseek-ai/dsh-compaction-basic'
import { compactCheckpointSource, CompactionId } from '@deepseek-ai/dsh-compaction'
import LlmRuntime, {
  createMessage,
  createSystemMessage,
  createUserMessage,
  LlmAdapter,
} from '@deepseek-ai/dsh-llm'
import type {
  ContentBlock,
  GenerateOptions,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { selectCompactableRange } from '../src/region.ts'
import { summarizeWithLlm } from '../src/summarizer.ts'
import type { SummarizationInput, SummaryResult } from '../src/summarizer.ts'

const SIGNAL = new AbortController().signal
const MODEL = 'pin-model'
const FOOTER = '[recall] Earlier detail is not lost: session_event_search (keywords) then '
  + 'session_event_read (seq) return exact earlier messages and tool output; memory_search returns '
  + 'durable facts saved from this and earlier sessions.'
const RECALL_TOOLS = ['session_event_search', 'session_event_read'] as const

/** Structural tools service: only the named tools resolve, as one scope would see them. */
function provideTools(ctx: Context, names: readonly string[]): void {
  const visible = new Set(names)
  ctx.reflect.provide('tools', {
    get: (name: string) => visible.has(name) ? { name } : undefined,
  })
}

async function createContext(visibleTools: readonly string[] = RECALL_TOOLS): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(TokenMeter)
  provideTools(ctx, visibleTools)
  return ctx
}

let counter = 0

interface ConversationOptions {
  readonly turns?: number
  readonly system?: string
  readonly parent?: SessionId
  readonly text?: string
}

/**
 * Closed turns followed by one open turn. A parent header makes the session a
 * child; a `system` text puts a `system/message` at surface node 0.
 */
function conversation(ctx: Context, options: ConversationOptions = {}): Session {
  const turns = options.turns ?? 4
  const text = options.text ?? 'fixture '.repeat(40).trim()
  counter += 1
  const session = ctx.sessions.create(SessionId(`pin-recall-${counter}`), {
    meta: options.parent === undefined ? {} : { parentSession: options.parent },
  })
  for (let turn = 1; turn <= turns; turn += 1) {
    session.append('turn/start', { turn })
    if (turn === 1 && options.system !== undefined) {
      session.append('system/message', {
        turn,
        step: 1,
        message: createSystemMessage(options.system),
      }, { surfaceOp: 'append' })
    }
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: `${text} user ${turn}` }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('step/start', { turn, step: 1 })
    if (turn === 1) {
      session.append('request/header', {
        header: { config: { provider: MODEL, model: MODEL } },
        reason: 'initial',
      })
    }
    session.append('assistant/message', {
      stream: [],
      turn,
      step: 1,
      message: createMessage({
        role: 'assistant',
        content: [{ type: 'text', text: `${text} assistant ${turn}` }],
        source: { kind: 'model', provider: MODEL, model: MODEL },
      }),
    }, { surfaceOp: 'append' })
    session.append('step/end', { turn, step: 1 })
    session.append('turn/end', { turn, reason: { kind: 'completed' } })
  }
  session.append('turn/start', { turn: turns + 1 })
  return session
}

function agent(session: Session, ctx: Context): Agent {
  return {
    session,
    ctx,
    options: { provider: MODEL, model: MODEL },
    runMaintenance: async <T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> => operation(SIGNAL),
  } as unknown as Agent
}

class RecordingCompactionEngine extends BasicCompactionEngine {
  summary: ContentBlock[] = [{ type: 'text', text: 'small checkpoint' }]
  windowClipped = false
  error: unknown
  calls: SummarizationInput[] = []

  override async summarize(
    input: SummarizationInput,
    _agent: Agent,
    _signal?: AbortSignal,
  ): Promise<SummaryResult> {
    this.calls.push(input)
    if (this.error !== undefined) throw this.error
    return {
      summary: this.summary,
      provider: 'summary-provider',
      model: 'summary-model',
      ...this.windowClipped ? { windowClipped: true } : {},
    }
  }
}

const BASE_CONFIG: BasicCompactionConfig = { auto: false, headroomTokens: 0, maxTokens: 8192 }

function engine(
  ctx: Context,
  config: BasicCompactionConfig = {},
): RecordingCompactionEngine {
  return new RecordingCompactionEngine(ctx, { ...BASE_CONFIG, ...config })
}

/** Last checkpoint user message appended by the compaction. */
function lastCheckpoint(session: Session) {
  // oxlint-disable-next-line typescript/no-non-null-assertion
  return session.snapshotEvents().findLast(event => event.type === 'user/message'
    && event.data.source?.kind === 'compact-checkpoint')!
}

/** Verbatim text blocks of one checkpoint message. */
function checkpointTexts(session: Session): string[] {
  const event = lastCheckpoint(session)
  return event.type === 'user/message'
    ? event.data.content.map(block => block.type === 'text' ? block.text : '')
    : []
}

describe('leading user-message pinning', () => {
  it('pins child sessions only under the default child scope', async () => {
    const ctx = await createContext()
    const parent = conversation(ctx, { turns: 4, system: 'SYSTEM HEAD' })
    const [, parentFirst] = parent.surface.nodes
    const compact = engine(ctx, { pinLeadingUserMessages: 1 })
    const parentResult = await compact.compactIfNeeded(agent(parent, ctx), 'context-overflow', SIGNAL)
    // The default scope is child-only, so a root session keeps today's boundary.
    expect(parentResult?.shadowedSeqs[0]).toBe(parentFirst)

    const child = conversation(ctx, { turns: 4, system: 'SYSTEM HEAD', parent: parent.id })
    const [, firstPrompt, firstAnswer] = child.surface.nodes
    const childResult = await compact.compactIfNeeded(agent(child, ctx), 'context-overflow', SIGNAL)
    expect(childResult).not.toBeNull()
    // The pinned prompt survives; the range starts at the next surface node.
    expect(childResult?.shadowedSeqs).not.toContain(firstPrompt)
    expect(childResult?.shadowedSeqs[0]).toBe(firstAnswer)
  })

  it('pins every session when scope is all', async () => {
    const ctx = await createContext()
    const session = conversation(ctx, { turns: 4, system: 'SYSTEM HEAD' })
    const [system, firstPrompt, firstAnswer] = session.surface.nodes
    const result = await engine(ctx, { pinLeadingUserMessages: 1, pinScope: 'all' })
      .compactIfNeeded(agent(session, ctx), 'context-overflow', SIGNAL)
    expect(result?.shadowedSeqs).not.toContain(firstPrompt)
    expect(result?.shadowedSeqs[0]).toBe(firstAnswer)
    expect(session.surface.nodes[0]).toBe(system)
  })

  it('stops the pin run at the first message priced above the cap', async () => {
    const ctx = await createContext()
    const session = conversation(ctx, { turns: 4, system: 'SYSTEM HEAD' })
    const [, firstPrompt, firstAnswer] = session.surface.nodes
    const measurement = ctx.tokenMeter.measure(session)
    const firstPrice = measurement.nodes[1]!.tokens
    expect(firstPrice).toBeGreaterThan(0)

    const below = selectCompactableRange(session, measurement, 0, {
      count: 1,
      maxTokens: firstPrice - 1,
    })
    expect(below?.start).toBe(firstPrompt)

    const atCap = selectCompactableRange(session, measurement, 0, {
      count: 1,
      maxTokens: firstPrice,
    })
    expect(atCap?.start).toBe(firstAnswer)
  })

  it('never pins a compaction checkpoint or a non-user node', async () => {
    const ctx = await createContext()
    const session = ctx.sessions.create(SessionId('checkpoint-head'))
    session.append('turn/start', { turn: 1 })
    session.append('system/message', {
      turn: 1,
      step: 1,
      message: createSystemMessage('SYSTEM'),
    }, { surfaceOp: 'append' })
    const checkpoint = session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'prior checkpoint' }],
      source: compactCheckpointSource(CompactionId('prior')),
    }), { surfaceOp: 'append' })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'real prompt '.repeat(40) }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('step/start', { turn: 1, step: 1 })
    session.append('assistant/message', {
      stream: [],
      turn: 1,
      step: 1,
      message: createMessage({
        role: 'assistant',
        content: [{ type: 'text', text: 'answer '.repeat(40) }],
        source: { kind: 'model', provider: MODEL, model: MODEL },
      }),
    }, { surfaceOp: 'append' })
    session.append('step/end', { turn: 1, step: 1 })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    session.append('turn/start', { turn: 2 })

    const range = selectCompactableRange(session, ctx.tokenMeter.measure(session), 0, {
      count: 1,
      maxTokens: 100_000,
    })
    expect(range?.start).toBe(checkpoint.seq)
  })

  it('pins from node 0 when the surface has no system head', async () => {
    const ctx = await createContext()
    const session = conversation(ctx, { turns: 4 })
    const [firstPrompt, firstAnswer] = session.surface.nodes
    const result = await engine(ctx, { pinLeadingUserMessages: 1, pinScope: 'all' })
      .compactIfNeeded(agent(session, ctx), 'context-overflow', SIGNAL)
    expect(result?.shadowedSeqs).not.toContain(firstPrompt)
    expect(result?.shadowedSeqs[0]).toBe(firstAnswer)
  })

  it('returns null when the pinned run leaves nothing compactable', async () => {
    const ctx = await createContext()
    const session = conversation(ctx, { turns: 1, system: 'SYSTEM HEAD', parent: SessionId('p') })
    expect(selectCompactableRange(session, ctx.tokenMeter.measure(session), 0, {
      count: 1,
      maxTokens: 100_000,
    })).toBeNull()
    await expect(engine(ctx, { pinLeadingUserMessages: 1 })
      .compactIfNeeded(agent(session, ctx), 'context-overflow', SIGNAL)).resolves.toBeNull()
  })

  it('applies pinning to manual compaction', async () => {
    const ctx = await createContext()
    const session = conversation(ctx, { turns: 4, system: 'SYSTEM HEAD' })
    // Manual compaction refuses an open turn; close the fixture's trailing turn.
    session.append('turn/end', { turn: 5, reason: { kind: 'completed' } })
    const [, firstPrompt, firstAnswer] = session.surface.nodes
    const result = await engine(ctx, { pinLeadingUserMessages: 1, pinScope: 'all' })
      .compactNow(agent(session, ctx), SIGNAL)
    expect(result).not.toBeNull()
    expect(result?.shadowedSeqs).not.toContain(firstPrompt)
    expect(result?.shadowedSeqs[0]).toBe(firstAnswer)
  })
})

describe('prefix-preserving summarizer replay', () => {
  it('replays the pinned leading run before the region and marks its length', async () => {
    const ctx = await createContext()
    const session = conversation(ctx, { turns: 3, system: 'SYSTEM HEAD' })
    const before = session.deriveMessages()
    const compact = engine(ctx, { pinLeadingUserMessages: 1, pinScope: 'all' })
    const result = await compact.compactIfNeeded(agent(session, ctx), 'context-overflow', SIGNAL)
    expect(result).not.toBeNull()

    const input = compact.calls[0]!
    expect(input.leadingCount).toBe(1)
    expect(input.messages.slice(0, 2)).toEqual(before.slice(0, 2))
    expect(input.regionSeqs).toEqual(result?.shadowedSeqs)
    expect(input.messages).toHaveLength(2 + (result?.shadowedSeqs.length ?? 0))
  })

  it('omits leadingCount when nothing is pinned so the replay stays byte-identical', async () => {
    const ctx = await createContext()
    const session = conversation(ctx, { turns: 3, system: 'SYSTEM HEAD' })
    const compact = engine(ctx)
    await compact.compactIfNeeded(agent(session, ctx), 'context-overflow', SIGNAL)
    const input = compact.calls[0]!
    expect(input).not.toHaveProperty('leadingCount')
    expect(input.messages[0]?.role).toBe('system')
  })

  it('clips region messages but keeps the system head and pinned run', async () => {
    const ctx = await createContext()
    class RecordingAdapter extends LlmAdapter {
      lastOptions: GenerateOptions | undefined

      override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
        this.lastOptions = options
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: 'checkpoint' } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }
    const adapter = new RecordingAdapter()
    ctx.llm.registerAdapter([MODEL], adapter)

    const system = createSystemMessage('SYSTEM')
    const pinned = createUserMessage({
      content: [{ type: 'text', text: 'pinned prompt' }],
      source: { kind: 'user' },
    })
    const oldest = createUserMessage({
      content: [{ type: 'text', text: 'a'.repeat(4_000) }],
      source: { kind: 'user' },
    })
    const newest = createUserMessage({
      content: [{ type: 'text', text: 'newest prompt' }],
      source: { kind: 'user' },
    })
    const session = conversation(ctx, { turns: 1 })

    await summarizeWithLlm(ctx, {
      summarizationProvider: MODEL,
      summarizationModel: MODEL,
      maxTokens: 64,
    }, {
      messages: [system, pinned, oldest, newest],
      leadingCount: 1,
      regionSeqs: [],
    }, agent(session, ctx), SIGNAL, { inputBudgetTokens: 800 })

    const sent = adapter.lastOptions?.messages ?? []
    expect(sent.slice(0, -1)).toEqual([system, pinned, newest])
  })
})

describe('recall wording gated on visible tools', () => {
  it('appends the configured footer after the close tag when every tool resolves', async () => {
    const ctx = await createContext([...RECALL_TOOLS, 'memory_search'])
    const session = conversation(ctx, { turns: 3, system: 'SYSTEM HEAD' })
    await engine(ctx, {
      recallFooter: FOOTER,
      recallFooterTools: [...RECALL_TOOLS, 'memory_search'],
    }).compactIfNeeded(agent(session, ctx), 'context-overflow', SIGNAL)

    const texts = checkpointTexts(session)
    expect(texts.at(-1)).toBe(FOOTER)
    expect(texts.at(-2)).toBe('</compacted-summary>')
  })

  it('omits the footer when any configured tool is not visible', async () => {
    const ctx = await createContext([...RECALL_TOOLS])
    const session = conversation(ctx, { turns: 3, system: 'SYSTEM HEAD' })
    await engine(ctx, {
      recallFooter: FOOTER,
      recallFooterTools: [...RECALL_TOOLS, 'memory_search'],
    }).compactIfNeeded(agent(session, ctx), 'context-overflow', SIGNAL)

    const texts = checkpointTexts(session)
    expect(texts.at(-1)).toBe('</compacted-summary>')
    expect(texts).not.toContain(FOOTER)
  })

  it('keeps the mechanical stub recovery sentence only when both recall tools resolve', async () => {
    const withTools = await createContext([...RECALL_TOOLS])
    const resolved = conversation(withTools, { turns: 3, system: 'SYSTEM HEAD' })
    const online = engine(withTools)
    online.error = new Error('offline')
    await online.compactIfNeeded(agent(resolved, withTools), 'context-overflow', SIGNAL)
    expect(checkpointTexts(resolved).join('\n')).toContain('session_event_search')

    const withoutTools = await createContext([])
    const gated = conversation(withoutTools, { turns: 3, system: 'SYSTEM HEAD' })
    const offline = engine(withoutTools)
    offline.error = new Error('offline')
    await offline.compactIfNeeded(agent(gated, withoutTools), 'context-overflow', SIGNAL)
    const text = checkpointTexts(gated).join('\n')
    expect(text).toContain('The complete transcript is preserved in the session log.')
    expect(text).not.toContain('session_event_search')
  })

  it('gates the window-clipped coverage recall clause on the recall tools', async () => {
    const withTools = await createContext([...RECALL_TOOLS])
    const resolved = conversation(withTools, { turns: 3, system: 'SYSTEM HEAD' })
    const clipped = engine(withTools)
    clipped.windowClipped = true
    await clipped.compactIfNeeded(agent(resolved, withTools), 'context-overflow', SIGNAL)
    expect(checkpointTexts(resolved).join('\n')).toContain('session_event_search')

    const withoutTools = await createContext([])
    const gated = conversation(withoutTools, { turns: 3, system: 'SYSTEM HEAD' })
    const gatedEngine = engine(withoutTools)
    gatedEngine.windowClipped = true
    await gatedEngine.compactIfNeeded(agent(gated, withoutTools), 'context-overflow', SIGNAL)
    const text = checkpointTexts(gated).join('\n')
    expect(text).toContain('[compaction coverage]')
    expect(text).toContain('The complete transcript is preserved in the session log.')
    expect(text).not.toContain('session_event_search')
  })

  it('measures the framed checkpoint including the footer in the shrink guard', async () => {
    const footer = '[recall] ' + 'x'.repeat(20_000)
    const config: BasicCompactionConfig = {
      recallFooter: footer,
      recallFooterTools: [...RECALL_TOOLS, 'memory_search'],
    }
    // One engine per context: the service registers on the root fiber.
    const plainCtx = await createContext([...RECALL_TOOLS, 'memory_search'])
    const plain = conversation(plainCtx, { turns: 4 })
    const plainResult = await engine(plainCtx).compactIfNeeded(agent(plain, plainCtx), 'context-overflow', SIGNAL)
    expect(plainResult).not.toBeNull()
    expect(plain.snapshotEvents().findLast(event => event.type === 'compaction/summary')?.data.provider)
      .toBe('summary-provider')

    const footerCtx = await createContext([...RECALL_TOOLS, 'memory_search'])
    const withFooter = conversation(footerCtx, { turns: 4 })
    await engine(footerCtx, config).compactIfNeeded(agent(withFooter, footerCtx), 'context-overflow', SIGNAL)
    // The summary alone would shrink the span, but the framed checkpoint with
    // the footer would not: the guard selects the mechanical omission instead.
    expect(withFooter.snapshotEvents().findLast(event => event.type === 'compaction/summary')?.data.provider)
      .toBe('')
  })
})

describe('durable facts in the summarization instruction', () => {
  it('pins the frozen section, bullet, and rule verbatim', async () => {
    const ctx = await createContext()
    class InstructionAdapter extends LlmAdapter {
      text = ''
      override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
        const last = options.messages.at(-1)?.content[0]
        this.text = last?.type === 'text' ? last.text : ''
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: 'checkpoint' } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }
    const adapter = new InstructionAdapter()
    ctx.llm.registerAdapter([MODEL], adapter)
    const session = conversation(ctx, { turns: 1 })
    await summarizeWithLlm(ctx, {
      summarizationProvider: MODEL,
      summarizationModel: MODEL,
      maxTokens: 64,
    }, { messages: [] }, agent(session, ctx), SIGNAL)

    expect(adapter.text).toContain('## Durable Facts')
    expect(adapter.text).toContain(
      '- [decision|constraint|requirement|fact] [one self-contained sentence a future session in this workspace needs: a decision with its reason, a constraint, an explicit user requirement or preference, or an exact path / identifier / command / config value. At most 12 items, each under 300 characters. Write "(none)" when nothing qualifies.]',
    )
    expect(adapter.text).toContain(
      '- [open questions, in-flight rationale, and transient data needed to continue; durable items belong in Durable Facts]',
    )
    expect(adapter.text).toContain(
      '- Durable Facts must stay true beyond the current task and make sense without this conversation (no "this", "above", "the current file"). Never include credentials, tokens, keys, passwords, or personal data.',
    )
  })
})
