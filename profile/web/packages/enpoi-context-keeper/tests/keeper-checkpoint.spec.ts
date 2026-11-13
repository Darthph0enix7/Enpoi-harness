import Schema from '@deepseek-ai/schemastery'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  buildTemplateCheckpoint,
  checkpointTelemetry,
  createCheckpointService,
  frameInput,
  getCheckpointService,
  KEEPER_COMPACTION_ID_MEMORY,
  latestCheckpoint,
  openToolBatch,
  renderCheckpointBlock,
  resetKeeperRouteHealth,
  apply as applyKeeper,
  type CheckpointData,
  Config as ConfigSchema,
  type Config,
} from '../src/index'

beforeEach(() => { resetKeeperRouteHealth() })

/**
 * Minimal session mock: `snapshotEvents` reflects appended events, `seq` is the
 * next sequence number, and `header.createdAt` grounds the telemetry line.
 */
function makeSession(events: Array<{ type: string; seq: number; data: unknown }> = []) {
  const log = [...events]
  let nextSeq = log.length === 0 ? 0 : Math.max(...log.map((event) => event.seq)) + 1
  return {
    id: 'checkpoint-session',
    header: { createdAt: Date.UTC(2026, 8, 20) },
    get seq() { return nextSeq },
    events: log,
    // Honour branded SessionLogOffset reads like the real Session (the
    // structural counter reads only the appended tail).
    snapshotEvents: (from: unknown = 0, to?: number) => log.slice(Number(from) || 0, to ?? log.length),
    eventAt: (seq: number) => log[Number(seq)],
    requestContext: () => undefined,
    surface: {
      get nodes() {
        return log
          .filter((event) => event.type === 'user/message' || event.type === 'assistant/message' || event.type === 'tool/result')
          .map((event) => event.seq)
      },
    },
    append: vi.fn((...args: unknown[]) => {
      const [type, data] = args as [string, unknown]
      log.push({ type, seq: nextSeq, data })
      nextSeq += 1
      return { type, seq: nextSeq - 1, data }
    }),
  }
}

/**
 * Stub a meter + 1M-token window so token pressure reads BELOW half: the new
 * floor must fire without it (live windows are 1 048 576 tokens, so the old
 * pressure gate was unreachable).
 */
function stubLowPressure(ctx: Record<string, unknown>, session: ReturnType<typeof makeSession> | Record<string, unknown>) {
  const baseGet = (ctx as { get: (ns: string) => unknown }).get
  ;(ctx as { get: (ns: string) => unknown }).get = (ns: string) =>
    ns === 'tokenMeter' ? { measure: () => ({ totalTokens: 1 }) } : baseGet(ns)
  ;(session as { requestContext?: () => unknown }).requestContext = () => ({ contextWindow: 1_048_576 })
}

/** The `state/checkpoint` appends recorded by the mock session. */
function checkpointCalls(session: ReturnType<typeof makeSession>): Array<[string, CheckpointData]> {
  return (session.append.mock.calls as Array<[string, CheckpointData]>).filter((call) => call[0] === 'state/checkpoint')
}

/** A session with N turns of user/assistant/turn-end events. */
function sessionWithTurns(n: number) {
  const events: Array<{ type: string; seq: number; data: unknown }> = []
  let seq = 0
  for (let i = 0; i < n; i++) {
    events.push({ type: 'turn/start', seq: seq++, data: { turn: i + 1 } })
    events.push({ type: 'user/message', seq: seq++, data: { content: `query ${i}`, source: { kind: 'user', participant: { kind: 'human', name: 'operator' } } } })
    events.push({ type: 'assistant/message', seq: seq++, data: { text: `answer ${i}` } })
    events.push({ type: 'turn/end', seq: seq++, data: { reason: { kind: 'stop' }, turn: i + 1 } })
  }
  return makeSession(events)
}

const DRAFT = '{"items":[{"kind":"operator_goal","text":"ship the heart","quote":"query 0","sourceSeq":1}]}'
const draft = (text: string, quote: string, sourceSeq: number): string =>
  JSON.stringify({ items: [{ kind: 'operator_goal', text, quote, sourceSeq }] })

const baseConfig: Config = {
  provider: 'freellmapi',
  model: 'auto',
  fallbackProvider: 'antigravity',
  fallbackModel: 'gemini-3.7-flash-tiered',
  leaseMs: 45_000,
  maxInputEvents: 80,
  maxOutputTokens: 2048,
  structuralDistanceK: 24,
  minRefreshMs: 60_000,
  negativeCacheMs: 120_000,
  claimsBatchSize: 8,
  claimsBatchMinutes: 5,
  checkpointStaleEvents: 12,
  checkpointStaleHours: 24,
}

/** Minimal ctx mock: settings, llm.stream, logger, on/effect. */
function makeCtx(overrides: { stream?: () => AsyncGenerator<unknown>; keeperDisabled?: boolean } = {}) {
  const stream = overrides.stream ?? (async function* () {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: DRAFT }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: DRAFT } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  })
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  const ctx = {
    get: (ns: string) => {
      if (ns === 'settings') {
        return {
          get: () => ({ capabilities: { tools: overrides.keeperDisabled === true ? { keeper: false } : {} } }),
        }
      }
      return undefined
    },
    llm: { stream: vi.fn(stream) },
    logger: { info: vi.fn(), warn: vi.fn() },
    on: vi.fn((name: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(name, handler)
      return () => handlers.delete(name)
    }),
    effect: (factory: () => unknown) => factory(),
    setInterval: vi.fn(() => ({})),
    setTimeout: vi.fn(() => ({})),
  }
  return { ctx, handlers }
}

describe('enpoi-context-keeper template checkpoint (deterministic fallback)', () => {
  it('folds goal, docs, and the last tool error from the log without a model', () => {
    const session = makeSession([
      { type: 'turn/start', seq: 0, data: { turn: 1 } },
      { type: 'user/message', seq: 1, data: { content: 'ship the keeper checkpoint', source: { kind: 'user', participant: { kind: 'human', name: 'operator' } } } },
      {
        type: 'assistant/message',
        seq: 2,
        data: {
          turn: 1,
          step: 1,
          message: {
            content: [
              { type: 'tool-call', id: 'call-1', name: 'write', arguments: '{"path":"docs/67-heart-implementation-plan.md"}' },
              { type: 'text', text: 'Done.\nMore detail' },
            ],
          },
        },
      },
      { type: 'tool/result', seq: 3, data: { message: { toolCallId: 'call-1', content: [] }, error: { message: 'boom: missing settings' } } },
      { type: 'turn/end', seq: 4, data: { reason: { kind: 'stop' }, turn: 1 } },
    ])
    const text = buildTemplateCheckpoint(session as never)
    expect(text).toContain('🎯 CURRENT OPERATOR REQUEST (quote-verified from the log):')
    expect(text).toContain('ship the keeper checkpoint')
    expect(text).toContain('📚 OBSERVED FILES (from tool requests; not verified execution):')
    expect(text).toContain('docs/67-heart-implementation-plan.md')
    expect(text).toContain('👁 OBSERVED ASSISTANT OUTPUT:')
    expect(text).toContain('⚡ OPEN WORK & NEXT STEP (observed):')
    expect(text).toContain('boom: missing settings')
  })

  it('reads the current durable assistant payload shape ({ turn, step, message })', () => {
    const session = makeSession([
      { type: 'turn/start', seq: 0, data: { turn: 1 } },
      { type: 'user/message', seq: 1, data: { content: 'decide', source: { kind: 'user', participant: { kind: 'human', name: 'operator' } } } },
      { type: 'assistant/message', seq: 2, data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'Decision: replace the checkpoint node in place.' }] } } },
      { type: 'turn/end', seq: 3, data: { reason: { kind: 'stop' }, turn: 1 } },
    ])
    const text = buildTemplateCheckpoint(session as never)
    expect(text).toContain('👁 OBSERVED ASSISTANT OUTPUT:')
    expect(text).toContain('Decision: replace the checkpoint node in place.')
  })

  it('stays valid (no throw, omitted empty sections) for an empty session', () => {
    const session = makeSession([])
    expect(buildTemplateCheckpoint(session as never)).toBe('')
    // The rendered block is still non-empty: the telemetry line is the floor.
    const telemetry = checkpointTelemetry(session as never, { seq: 0, model: 'template', via: 'template' })
    const rendered = renderCheckpointBlock({
      version: 1, basedOnSeq: 0, basedOnStructuralCount: 0, model: 'template', via: 'template',
      text: '', telemetry, createdAt: Date.now(),
    })
    expect(rendered).toContain('### State checkpoint')
    expect(rendered).toContain('session started 2026-09-20')
    expect(rendered).toContain('via template')
  })
})

describe('enpoi-context-keeper checkpoint surface recovery', () => {
  async function appendStateCheckpoint(session: { append: unknown }, text: string): Promise<void> {
    const append = session.append as unknown as (type: string, data: unknown, opts?: { ignorable?: true }) => unknown
    append.call(session, 'state/checkpoint', {
      version: 7,
      basedOnSeq: 0,
      basedOnStructuralCount: 0,
      model: 'freellmapi/auto',
      via: 'llm',
      text,
      telemetry: 'session started 2026-11-13 · today 2026-11-13 · refreshed at seq 0 · by freellmapi/auto · via llm',
      createdAt: Date.now(),
    }, { ignorable: true })
  }

  it('restores an old checkpoint with no active surface exactly once and warm/cold identically', async () => {
    const { Session } = await import('@deepseek-ai/dsh-session')
    const { createUserMessage } = await import('@deepseek-ai/dsh-llm')
    const session = Session.create('restore-old-checkpoint' as never)
    session.append('turn/start', { turn: 1 })
    session.append(
      'user/message',
      createUserMessage({ content: [{ type: 'text', text: 'restore this checkpoint' }], source: { kind: 'user', participant: { kind: 'human', name: 'operator' } } }),
      { surfaceOp: 'append' },
    )
    session.append('turn/end', { turn: 1, reason: { kind: 'stop' } })
    await appendStateCheckpoint(session, '🛰 RESTORED OPERATOR GOAL\n- exact prior text')

    const { ctx } = makeCtx()
    const service = createCheckpointService(ctx as never, baseConfig)
    const cold = await service.ensureCheckpoint(session as never)
    expect(cold.ok).toBe(true)
    expect(cold.reason).toBe('cache-hit')
    expect(ctx.llm.stream).not.toHaveBeenCalled()
    expect(session.snapshotEvents().filter((event) => event.type === 'state/checkpoint')).toHaveLength(1)
    expect(latestCheckpoint(session as never)!.version).toBe(7)
    const keeperNodes = () => session.surface.nodes.filter((seq) => {
      const event = session.eventAt(seq) as { data?: { source?: { kind?: string } } } | undefined
      return event?.data?.source?.kind === 'enpoi-keeper'
    })
    expect(keeperNodes()).toHaveLength(1)
    const block = (session.eventAt(keeperNodes()[0]!) as { data: { content: Array<{ text?: string }> } }).data.content[0]!.text!
    expect(block).toContain('### State checkpoint')
    expect(block).toContain('RESTORED OPERATOR GOAL')
    expect(block).toContain('Derived state snapshot')

    const warm = await service.ensureCheckpoint(session as never)
    expect(warm.reason).toBe('cache-hit')
    expect(warm.text).toBe(cold.text)
    expect(keeperNodes()).toHaveLength(1)
    expect(session.snapshotEvents().filter((event) => event.type === 'state/checkpoint')).toHaveLength(1)
  })

  it('keeps an API-repaired active keeper line as prior and never resurrects the stale raw checkpoint', async () => {
    const { Session } = await import('@deepseek-ai/dsh-session')
    const { createUserMessage } = await import('@deepseek-ai/dsh-llm')
    const session = Session.create('repair-continuity' as never)
    session.append('turn/start', { turn: 1 })
    session.append(
      'user/message',
      createUserMessage({ content: [{ type: 'text', text: 'repair continuity' }], source: { kind: 'user', participant: { kind: 'human', name: 'operator' } } }),
      { surfaceOp: 'append' },
    )
    session.append('turn/end', { turn: 1, reason: { kind: 'stop' } })
    const append = session.append as unknown as (type: string, data: unknown, opts?: unknown) => { seq: number }
    append.call(session, 'state/checkpoint', {
      version: 3,
      basedOnSeq: 0,
      basedOnStructuralCount: 0,
      model: 'llm',
      via: 'llm',
      text: 'OLD STALE LINE',
      telemetry: 'session started 2026-11-13 · today 2026-11-13 · refreshed at seq 0 · by llm · via llm',
      createdAt: Date.now(),
    }, { ignorable: true })
    const oldKeeper = session.append(
      'user/message',
      createUserMessage({
        content: [{ type: 'text', text: '### State checkpoint\n\nOLD STALE LINE\n\ntelemetry' }],
        source: {
          kind: 'enpoi-keeper',
          form: 'snapshot',
          sections: [{ name: 'state-checkpoint', text: 'OLD STALE LINE' }],
        },
      }),
      { surfaceOp: 'append' },
    ).seq
    // API repair: replace only the active generated keeper surface, no fake state event.
    session.append(
      'user/message',
      createUserMessage({
        content: [{ type: 'text', text: 'CORRECTED KEEPER LINE' }],
        source: {
          kind: 'enpoi-keeper',
          form: 'snapshot',
          sections: [{ name: 'state-checkpoint', text: 'OLD STALE LINE' }],
        },
      }),
      { surfaceOp: { op: 'replace', startSeq: oldKeeper, endSeq: oldKeeper }, sourceEventSeqs: [oldKeeper] },
    )

    let calls = 0
    let captured = ''
    const stream = async function* (options: { messages: Array<{ content: Array<{ text?: string }> }> }) {
      calls += 1
      captured = options.messages[0]?.content[0]?.text ?? ''
      const text = 'not json'
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text }
      yield { type: 'block-end', index: 0, block: { type: 'text', text } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
    const { ctx } = makeCtx({ stream })
    const service = createCheckpointService(ctx as never, baseConfig)

    const hit = await service.ensureCheckpoint(session as never)
    expect(hit.reason).toBe('cache-hit')
    expect(hit.text).toContain('CORRECTED KEEPER LINE')
    expect(hit.text).not.toContain('OLD STALE LINE')
    expect(calls).toBe(0)
    expect(session.snapshotEvents().filter((event) => event.type === 'state/checkpoint')).toHaveLength(1)
    const activeText = () => {
      const seq = session.surface.nodes.find((candidate) => {
        const event = session.eventAt(candidate) as { data?: { source?: { kind?: string } } } | undefined
        return event?.data?.source?.kind === 'enpoi-keeper'
      })!
      return (session.eventAt(seq) as { data: { content: Array<{ text?: string }> } }).data.content[0]!.text!
    }
    expect(activeText()).toBe('CORRECTED KEEPER LINE')

    // A genuine refresh sees the corrected active prior, not the raw stale event.
    const forced = await service.ensureCheckpoint(session as never, { force: true })
    expect(forced.ok).toBe(true)
    expect(calls).toBe(1)
    expect(captured).toContain('CORRECTED KEEPER LINE')
    expect(captured).not.toContain('OLD STALE LINE')
    expect(forced.text).toContain('CORRECTED KEEPER LINE')
    expect(forced.text).not.toContain('OLD STALE LINE')
  })

  it('defers recovery behind an open tool batch and commits after the result', async () => {
    const { Session } = await import('@deepseek-ai/dsh-session')
    const { createAssistantMessage, createToolResultMessage, createUserMessage } = await import('@deepseek-ai/dsh-llm')
    const session = Session.create('restore-open-batch' as never)
    session.append('turn/start', { turn: 1 })
    session.append(
      'user/message',
      createUserMessage({ content: [{ type: 'text', text: 'restore with an open batch' }], source: { kind: 'user', participant: { kind: 'human', name: 'operator' } } }),
      { surfaceOp: 'append' },
    )
    session.append('assistant/message', createAssistantMessage({
      content: [{ type: 'tool-call', id: 'call-open' as never, name: 'bash', arguments: '{}' }],
      source: { provider: 'p1', model: 'm1' },
    }), { surfaceOp: 'append' })
    session.append('tool/call', { turn: 1, step: 1, callId: 'call-open' as never, name: 'bash', arguments: '{}' })
    await appendStateCheckpoint(session, 'PENDING RECOVERY TEXT')

    const { ctx } = makeCtx()
    const service = createCheckpointService(ctx as never, baseConfig)
    const result = await service.ensureCheckpoint(session as never)
    expect(result.ok).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(openToolBatch(session as never)).toBe(true)
    expect(session.surface.nodes.filter((seq) => {
      const event = session.eventAt(seq) as { data?: { source?: { kind?: string } } } | undefined
      return event?.data?.source?.kind === 'enpoi-keeper'
    })).toHaveLength(0)

    const callSeq = session.snapshotEvents().find((event) => event.type === 'tool/call')!.seq
    session.append('tool/result', {
      turn: 1,
      step: 1,
      message: createToolResultMessage({ callId: 'call-open' as never, content: [{ type: 'text', text: 'ok' }], isError: false }),
    }, { surfaceOp: 'append', sourceEventSeqs: [callSeq] })
    expect(service.flushPendingCheckpoint(session as never)).toBe(true)
    expect(session.surface.nodes.filter((seq) => {
      const event = session.eventAt(seq) as { data?: { source?: { kind?: string } } } | undefined
      return event?.data?.source?.kind === 'enpoi-keeper'
    })).toHaveLength(1)
  })

  it('rehydrates an open compaction bracket after HMR and does not commit mid-compaction', async () => {
    const { Session } = await import('@deepseek-ai/dsh-session')
    const { createUserMessage } = await import('@deepseek-ai/dsh-llm')
    const session = Session.create('hmr-open-compaction' as never)
    session.append('turn/start', { turn: 1 })
    session.append(
      'user/message',
      createUserMessage({ content: [{ type: 'text', text: 'query 0' }], source: { kind: 'user', participant: { kind: 'human', name: 'operator' } } }),
      { surfaceOp: 'append' },
    )
    session.append('turn/end', { turn: 1, reason: { kind: 'stop' } })
    const append = session.append as unknown as (type: string, data: unknown, opts?: unknown) => { seq: number }
    append.call(session, 'compaction/start', { compactionId: 'hmr-c1', turn: 1 })
    append.call(session, 'compaction/summary', {
      compactionId: 'hmr-c1', provider: 'p1', model: 'm1', summary: [], shadowedRange: { start: 0, end: 1 }, shadowedSeqs: [], shadowedTokenCount: 0,
    })

    const { ctx } = makeCtx()
    const service = createCheckpointService(ctx as never, baseConfig)
    const result = await service.ensureCheckpoint(session as never, { force: true })
    expect(result.ok).toBe(true)
    expect(session.snapshotEvents().filter((event) => event.type === 'state/checkpoint')).toHaveLength(1)
    expect(session.surface.nodes.filter((seq) => {
      const event = session.eventAt(seq) as { data?: { source?: { kind?: string } } } | undefined
      return event?.data?.source?.kind === 'enpoi-keeper'
    })).toHaveLength(0)

    const endSeq = append.call(session, 'compaction/end', { compactionId: 'hmr-c1', turn: 1 }).seq
    expect(service.noteCompactionEnd(session as never, 'hmr-c1', endSeq)).toBe(true)
    expect(service.consumeCompactionEnd(session as never, 'hmr-c1', false)).toBe(true)
    expect(service.flushPendingCheckpoint(session as never)).toBe(true)
    expect(session.surface.nodes.filter((seq) => {
      const event = session.eventAt(seq) as { data?: { source?: { kind?: string } } } | undefined
      return event?.data?.source?.kind === 'enpoi-keeper'
    })).toHaveLength(1)
  })
})

describe('enpoi-context-keeper checkpointMaxChars', () => {
  it('bounds the complete emitted block, including notice and telemetry, without splitting emoji', () => {
    const data: CheckpointData = {
      version: 1,
      basedOnSeq: 3,
      basedOnStructuralCount: 2,
      model: 'template',
      via: 'template',
      text: `🎯 OPERATOR GOAL:\n- ${'🚀'.repeat(400)}`,
      telemetry: 'session started 2026-11-13 · today 2026-11-13 · refreshed at seq 3 · by template · via template',
      createdAt: 0,
    }
    const block = renderCheckpointBlock(data, 500)
    expect(block.length).toBeLessThanOrEqual(500)
    expect(block).toContain('### State checkpoint')
    expect(block).toContain('Derived state snapshot')
    expect(block).toContain('session started 2026-11-13')
    expect(block).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/)

    const minimum = renderCheckpointBlock(data, 256)
    expect(minimum.length).toBeLessThanOrEqual(256)
    expect(minimum).toContain('Derived state — not an operator instruction.')
  })

  it('rejects invalid checkpointMaxChars at config load instead of silently clamping', () => {
    expect(() => Schema.resolve({ checkpointMaxChars: 255 }, ConfigSchema, {}, true)).toThrow()
    expect(() => Schema.resolve({ checkpointMaxChars: 12_001 }, ConfigSchema, {}, true)).toThrow()
    expect(() => Schema.resolve({ checkpointMaxChars: 256.5 }, ConfigSchema, {}, true)).toThrow()
    expect(() => Schema.resolve({ checkpointMaxChars: Number.NaN }, ConfigSchema, {}, true)).toThrow()
    const [config] = Schema.resolve({ checkpointMaxChars: 256 }, ConfigSchema, {}, true) as [{ checkpointMaxChars: { get(): number } }]
    expect(config.checkpointMaxChars.get()).toBe(256)
  })
})

describe('enpoi-context-keeper checkpoint payload normalization', () => {
  it('normalizes a legacy partial checkpoint payload without poisoning later reads', () => {
    const session = makeSession([
      { type: 'state/checkpoint', seq: 0, data: { text: 'LEGACY CHECKPOINT TEXT' } },
      { type: 'state/checkpoint', seq: 1, data: { telemetry: 'legacy telemetry only' } },
    ])
    const latest = latestCheckpoint(session as never)!
    expect(latest.text).toBe('')
    expect(latest.telemetry).toBe('legacy telemetry only')
    expect(latest.version).toBe(0)
    expect(latest.model).toBe('unknown')
    expect(latest.via).toBe('template')
    expect(latest.createdAt).toBe(0)
  })
})

describe('enpoi-context-keeper stale multi-mount checkpoint', () => {
  it('never assigns a newer version to an older basedOnSeq after another mount committed', async () => {
    let releaseOld!: () => void
    const oldGate = new Promise<void>((resolve) => { releaseOld = resolve })
    let calls = 0
    const stream = async function* () {
      calls += 1
      const text = calls === 1 ? 'old work' : 'new work'
      if (calls === 1) await oldGate
      const draft = JSON.stringify({ items: [{ kind: 'operator_goal', text, quote: 'query 0', sourceSeq: 1 }] })
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: draft }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: draft } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
    const { ctx } = makeCtx({ stream })
    const oldService = createCheckpointService(ctx as never, baseConfig)
    const newService = createCheckpointService(ctx as never, baseConfig)
    const session = sessionWithTurns(1)

    const oldPass = oldService.ensureCheckpoint(session as never, { force: true })
    await vi.waitFor(() => expect(calls).toBe(1))
    // Grow the log so the second mount has a newer causal snapshot.
    session.append('turn/start', { turn: 2 })
    session.append('user/message', { content: 'newer query', source: { kind: 'user', participant: { kind: 'human', name: 'operator' } } })
    session.append('assistant/message', { turn: 2, step: 1, message: { content: [{ type: 'text', text: 'newer answer' }] } })
    session.append('turn/end', { turn: 2, reason: { kind: 'stop' } })

    const newPass = await newService.ensureCheckpoint(session as never, { force: true })
    expect(newPass.ok).toBe(true)
    expect(newPass.text).toContain('new work')
    releaseOld()
    const oldResult = await oldPass
    expect(oldResult.ok).toBe(false)

    const checkpoints = checkpointCalls(session)
    expect(checkpoints).toHaveLength(1)
    expect(checkpoints[0]![1].text).toContain('new work')
    expect(checkpoints[0]![1].text).not.toContain('old work')
  })
})

describe('enpoi-context-keeper frameInput active-surface scope', () => {
  it('reads only active surface events and ignores abandoned raw-log turns', () => {
    const log = [
      { type: 'user/message', seq: 0, data: { content: 'ABANDONED GOAL', source: { kind: 'user', participant: { kind: 'human', name: 'operator' } } } },
      { type: 'assistant/message', seq: 1, data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'ABANDONED ANSWER' }] } } },
      { type: 'user/message', seq: 2, data: { content: 'ACTIVE GOAL', source: { kind: 'user', participant: { kind: 'human', name: 'operator' } } } },
      { type: 'assistant/message', seq: 3, data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'ACTIVE ANSWER' }] } } },
    ]
    const session = {
      id: 'active-surface-only',
      header: { createdAt: 0 },
      seq: 4,
      surface: { nodes: [2, 3] },
      snapshotEvents: (from = 0, to = 4) => log.filter((event) => event.seq >= Number(from) && event.seq < Number(to)),
      eventAt: (seq: number) => log.find((event) => event.seq === Number(seq)),
      append: () => undefined,
    }
    const framed = frameInput(session as never, 80, session.seq)
    expect(framed.text).toContain('ACTIVE GOAL')
    expect(framed.text).toContain('ACTIVE ANSWER')
    expect(framed.text).not.toContain('ABANDONED')
    const template = buildTemplateCheckpoint(session as never)
    expect(template).toContain('ACTIVE GOAL')
    expect(template).not.toContain('ABANDONED')
  })
})

describe('enpoi-context-keeper CheckpointService', () => {
  it('writes a state/checkpoint v1 via the model route, then the surface message', async () => {
    const { ctx } = makeCtx()
    const service = createCheckpointService(ctx as never, baseConfig)
    const session = sessionWithTurns(1)

    const result = await service.ensureCheckpoint(session as never)

    expect(result.ok).toBe(true)
    expect(result.reason).toBe('refreshed')
    // One refresh = the durable log event + the surface message that carries it.
    expect(session.append).toHaveBeenCalledTimes(2)
    const [type, payload, opts] = session.append.mock.calls[0] as [string, CheckpointData, { ignorable?: true }]
    expect(type).toBe('state/checkpoint')
    expect(opts).toEqual({ ignorable: true })
    expect(payload.version).toBe(1)
    expect(payload.via).toBe('llm')
    expect(payload.model).toBe('freellmapi/auto')
    expect(payload.basedOnSeq).toBe(session.seq - 2)
    expect(payload.telemetry).toContain('refreshed at seq')
    expect(payload.telemetry).toContain('by freellmapi/auto')
    expect(payload.telemetry).toContain('via llm')
    expect(payload.text).toContain('ship the heart')
    const [messageType, , messageIntent] = session.append.mock.calls[1] as [string, unknown, { surfaceOp?: unknown }]
    expect(messageType).toBe('user/message')
    expect(messageIntent).toEqual({ surfaceOp: 'append' })
  })

  it('falls back to the deterministic template when every model route fails', async () => {
    const failing = async function* () {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'finish', reason: { kind: 'error', failure: { message: 'upstream down', code: 'UPSTREAM' } } }
    }
    const { ctx } = makeCtx({ stream: failing })
    const service = createCheckpointService(ctx as never, baseConfig)
    const session = sessionWithTurns(2)

    const result = await service.ensureCheckpoint(session as never)

    expect(result.ok).toBe(true)
    expect(result.model).toBe('template')
    const [, payload] = checkpointCalls(session)[0] as [string, CheckpointData]
    expect(payload.via).toBe('template')
    expect(payload.text).toContain('query 0') // deterministic fold, not an LLM call
    expect(payload.telemetry).toContain('via template')
  })

  it('cache-hits inside the freshness window and bumps the version after a forced cut', async () => {
    const { ctx } = makeCtx()
    const service = createCheckpointService(ctx as never, baseConfig)
    const session = sessionWithTurns(1)

    await service.ensureCheckpoint(session as never)
    const hit = await service.ensureCheckpoint(session as never)
    expect(hit.reason).toBe('cache-hit')
    expect(session.append).toHaveBeenCalledTimes(2)

    // A segment cut forces a refresh even inside the window; the prior
    // checkpoint is superseded by a higher version (never mutated in place).
    const forced = await service.ensureCheckpoint(session as never, { force: true })
    expect(forced.reason).toBe('refreshed')
    const versions = checkpointCalls(session).map((call) => call[1].version)
    expect(versions).toEqual([1, 2])
  })

  it('single-flights concurrent triggers (no duplicate checkpoint per cut)', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    let calls = 0
    // A valid checkpoint draft carries an operator-anchored item; prose or a
    // header-only landing is not a draft and would fall back to the template.
    const brief = draft('gated goal', 'query 0', 1)
    const stream = async function* () {
      calls += 1
      await gate
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: brief }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: brief } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
    const { ctx } = makeCtx({ stream })
    const service = createCheckpointService(ctx as never, baseConfig)
    const session = sessionWithTurns(1)

    const first = service.ensureCheckpoint(session as never, { force: true })
    const second = service.ensureCheckpoint(session as never, { force: true })
    release()
    const [a, b] = await Promise.all([first, second])

    expect(a.reason).toBe('refreshed')
    expect(b.reason).toBe('refreshed')
    expect(calls).toBe(1)
    expect(checkpointCalls(session)).toHaveLength(1)
  })

  it('does not write when the keeper is disabled by capabilities', async () => {
    const { ctx } = makeCtx({ keeperDisabled: true })
    const service = createCheckpointService(ctx as never, baseConfig)
    const session = sessionWithTurns(1)
    const result = await service.ensureCheckpoint(session as never)
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('keeper-disabled')
    expect(session.append).not.toHaveBeenCalled()
    expect(ctx.llm.stream).not.toHaveBeenCalled()
  })
})

describe('enpoi-context-keeper triggers (apply listener)', () => {
  /** Append one compaction event and dispatch it in real log order. */
  function dispatchCompaction(
    handler: (...args: unknown[]) => unknown,
    session: ReturnType<typeof makeSession>,
    type: 'compaction/start' | 'compaction/summary' | 'compaction/end',
    data: Record<string, unknown>,
  ) {
    const event = session.append(type, data)
    handler(session, event)
    return event
  }

  function compactionSummary(
    handler: (...args: unknown[]) => unknown,
    session: ReturnType<typeof makeSession>,
    compactionId: string,
    overrides: Record<string, unknown> = {},
  ) {
    return dispatchCompaction(handler, session, 'compaction/summary', {
      compactionId,
      provider: 'freellmapi',
      model: 'auto',
      summary: [],
      shadowedRange: { start: 0, end: 0 },
      shadowedSeqs: [],
      shadowedTokenCount: 0,
      ...overrides,
    })
  }

  function compactionEnd(
    handler: (...args: unknown[]) => unknown,
    session: ReturnType<typeof makeSession>,
    compactionId: string,
    overrides: Record<string, unknown> = {},
  ) {
    return dispatchCompaction(handler, session, 'compaction/end', { compactionId, turn: 1, ...overrides })
  }

  const settle = (ms = 25) => new Promise<void>((resolve) => setTimeout(resolve, ms))

  it.each([{}, { error: 'summary rejected' }])('holds an in-flight checkpoint surface commit until compaction ends: %j', async (endData) => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const { ctx, handlers } = makeCtx({ stream: async function* () {
      await gate
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: '🎯 ACTIVE GOAL: preserve context\n- Preserve the current implementation decision.' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: '🎯 ACTIVE GOAL: preserve context\n- Preserve the current implementation decision.' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    } })
    applyKeeper(ctx as never, baseConfig)
    const handler = handlers.get('session/event')!
    const session = sessionWithTurns(1)
    const service = getCheckpointService()!
    const refresh = service.ensureCheckpoint(session as never, { force: true })
    await vi.waitFor(() => expect(ctx.llm.stream).toHaveBeenCalledTimes(1))
    dispatchCompaction(handler, session, 'compaction/start', { compactionId: 'open-cut', turn: 1 })
    release()
    await refresh
    const surfaceCommits = () => session.append.mock.calls.filter(call => call[0] === 'user/message')
    expect(checkpointCalls(session)).toHaveLength(1)
    expect(surfaceCommits()).toHaveLength(0)
    expect(service.flushPendingCheckpoint(session as never)).toBe(false)
    compactionEnd(handler, session, 'open-cut', endData)
    // The matching end releases the one parked surface commit; the forced call
    // must not pay a second pass for the same boundary.
    await settle()
    expect(surfaceCommits()).toHaveLength(1)
    expect(checkpointCalls(session)).toHaveLength(1)
    expect(ctx.llm.stream).toHaveBeenCalledTimes(1)
  })

  it('does not publish a refresh that completes after plugin disposal', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const { ctx, handlers } = makeCtx({ stream: async function* () {
      await gate
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: '🎯 ACTIVE GOAL: late result\n- must never publish' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: '🎯 ACTIVE GOAL: late result\n- must never publish' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    } })
    applyKeeper(ctx as never, baseConfig)
    const session = sessionWithTurns(1)
    const service = getCheckpointService()!
    const refresh = service.ensureCheckpoint(session as never, { force: true })
    await vi.waitFor(() => expect(ctx.llm.stream).toHaveBeenCalledTimes(1))

    handlers.get('dispose')!()
    release()
    const result = await refresh
    await settle()

    expect(result.ok).toBe(false)
    expect(checkpointCalls(session)).toHaveLength(0)
    expect(session.append.mock.calls.filter(call => call[0] === 'user/message')).toHaveLength(0)
  })

  it('refreshes once on the summary\'s matching clean end and reads the checkpoint back', async () => {
    const { ctx, handlers } = makeCtx()
    applyKeeper(ctx as never, baseConfig)
    const handler = handlers.get('session/event')!
    const session = sessionWithTurns(2)

    compactionSummary(handler, session, 'c1')
    compactionEnd(handler, session, 'c1')
    await vi.waitFor(() => expect(checkpointCalls(session)).toHaveLength(1))

    const latest = latestCheckpoint(session as never)
    expect(latest).not.toBeNull()
    expect(latest!.version).toBe(1)
    expect(renderCheckpointBlock(latest!)).toContain('### State checkpoint')

    // A second compaction inside the same window refreshes again, never
    // duplicating at the same version.
    compactionSummary(handler, session, 'c2')
    compactionEnd(handler, session, 'c2')
    await vi.waitFor(() => expect(checkpointCalls(session)).toHaveLength(2))
    expect(checkpointCalls(session).map((call) => call[1].version)).toEqual([1, 2])
  })

  it('does not refresh on a summary alone', async () => {
    const { ctx, handlers } = makeCtx()
    applyKeeper(ctx as never, baseConfig)
    const handler = handlers.get('session/event')!
    const session = sessionWithTurns(2)

    compactionSummary(handler, session, 'c1')
    await settle()
    expect(checkpointCalls(session)).toHaveLength(0)
    expect(ctx.llm.stream).not.toHaveBeenCalled()
  })

  it('does not refresh when the matching end carries an error', async () => {
    const { ctx, handlers } = makeCtx()
    applyKeeper(ctx as never, baseConfig)
    const handler = handlers.get('session/event')!
    const session = sessionWithTurns(2)

    compactionSummary(handler, session, 'c1')
    compactionEnd(handler, session, 'c1', { error: 'summarizer failed' })
    await settle()
    expect(checkpointCalls(session)).toHaveLength(0)
    expect(ctx.llm.stream).not.toHaveBeenCalled()
  })

  it('does not refresh on an end without a held summary', async () => {
    const { ctx, handlers } = makeCtx()
    applyKeeper(ctx as never, baseConfig)
    const handler = handlers.get('session/event')!
    const session = sessionWithTurns(2)

    compactionEnd(handler, session, 'c-no-summary')
    await settle()
    expect(checkpointCalls(session)).toHaveLength(0)
    expect(ctx.llm.stream).not.toHaveBeenCalled()
  })

  it('drops a held summary when a mismatched id ends first', async () => {
    const { ctx, handlers } = makeCtx()
    applyKeeper(ctx as never, baseConfig)
    const handler = handlers.get('session/event')!
    const session = sessionWithTurns(2)

    compactionSummary(handler, session, 'c1')
    compactionEnd(handler, session, 'c-other')
    await settle()
    expect(checkpointCalls(session)).toHaveLength(0)

    // The held transaction cannot complete — its late end never refreshes.
    compactionEnd(handler, session, 'c1')
    await settle()
    expect(checkpointCalls(session)).toHaveLength(0)

    // A fresh compaction still works after the dropped hold.
    compactionSummary(handler, session, 'c2')
    compactionEnd(handler, session, 'c2')
    await vi.waitFor(() => expect(checkpointCalls(session)).toHaveLength(1))
  })

  it('collapses duplicate summaries and duplicate ends into one refresh', async () => {
    const { ctx, handlers } = makeCtx()
    applyKeeper(ctx as never, baseConfig)
    const handler = handlers.get('session/event')!
    const session = sessionWithTurns(2)

    compactionSummary(handler, session, 'c1')
    compactionSummary(handler, session, 'c1')
    compactionEnd(handler, session, 'c1')
    compactionEnd(handler, session, 'c1')
    await vi.waitFor(() => expect(checkpointCalls(session)).toHaveLength(1))
    await settle()
    expect(ctx.llm.stream).toHaveBeenCalledTimes(1)
    expect(checkpointCalls(session)).toHaveLength(1)
  })

  it('does not refresh again when a completed summary/end pair replays', async () => {
    const { ctx, handlers } = makeCtx()
    applyKeeper(ctx as never, baseConfig)
    const handler = handlers.get('session/event')!
    const session = sessionWithTurns(2)

    compactionSummary(handler, session, 'c1')
    compactionEnd(handler, session, 'c1')
    await vi.waitFor(() => expect(checkpointCalls(session)).toHaveLength(1))

    // The same id's summary and end replayed AFTER the first refresh landed
    // must stay consumed.
    compactionSummary(handler, session, 'c1')
    compactionEnd(handler, session, 'c1')
    await settle()
    expect(ctx.llm.stream).toHaveBeenCalledTimes(1)
    expect(checkpointCalls(session)).toHaveLength(1)
  })

  it('refreshes once for a clean mechanical or summarizer-failure summary end', async () => {
    const { ctx, handlers } = makeCtx()
    applyKeeper(ctx as never, baseConfig)
    const handler = handlers.get('session/event')!
    const session = sessionWithTurns(2)

    // Mechanical stub: no model wrote the summary, but the clean end still
    // changes the live context and warrants one checkpoint.
    compactionSummary(handler, session, 'c-stub', { provider: '', model: '' })
    compactionEnd(handler, session, 'c-stub')
    await vi.waitFor(() => expect(checkpointCalls(session)).toHaveLength(1))

    // summarizationFailure is a diagnostic, not a failed transaction.
    compactionSummary(handler, session, 'c-failed', {
      provider: '',
      model: '',
      summarizationFailure: { code: 'UNKNOWN', message: 'upstream down' },
    })
    compactionEnd(handler, session, 'c-failed')
    await vi.waitFor(() => expect(checkpointCalls(session)).toHaveLength(2))
    expect(ctx.llm.stream).toHaveBeenCalledTimes(2)
  })

  it('does not refresh for an errored mechanical summary end', async () => {
    const { ctx, handlers } = makeCtx()
    applyKeeper(ctx as never, baseConfig)
    const handler = handlers.get('session/event')!
    const session = sessionWithTurns(2)

    compactionSummary(handler, session, 'c-stub', { provider: '', model: '' })
    compactionEnd(handler, session, 'c-stub', { error: 'compaction failed' })
    await settle()
    expect(checkpointCalls(session)).toHaveLength(0)
    expect(ctx.llm.stream).not.toHaveBeenCalled()
  })

  it('keeps per-session compaction id memory bounded', () => {
    const { ctx } = makeCtx()
    const service = createCheckpointService(ctx as never, baseConfig)
    const session = sessionWithTurns(1)

    for (let i = 0; i < KEEPER_COMPACTION_ID_MEMORY * 3; i++) {
      service.noteCompactionSummary(session as never, `c-${i}`)
      service.consumeCompactionEnd(session as never, `c-${i}`, false)
    }
    const memory = (service as unknown as {
      compactionMemory: { get(key: string): { pending: string[]; handled: string[] } | undefined }
    }).compactionMemory.get(session.id)!
    expect(memory.pending).toHaveLength(0)
    expect(memory.handled.length).toBeLessThanOrEqual(KEEPER_COMPACTION_ID_MEMORY)
  })

  it('awaits an in-flight refresh that predates the end and runs exactly one covering pass', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    let calls = 0
    const brief = '🎯 ACTIVE GOAL: covering pass\n- bullet after the compaction boundary'
    const stream = async function* () {
      calls += 1
      if (calls === 1) await gate
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: brief }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: brief } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
    const { ctx, handlers } = makeCtx({ stream })
    applyKeeper(ctx as never, baseConfig)
    const handler = handlers.get('session/event')!
    const service = getCheckpointService()!
    const session = sessionWithTurns(1)

    // Pass A snapshots BEFORE the compaction boundary and stays in flight.
    const first = service.ensureCheckpoint(session as never, { force: true })
    await vi.waitFor(() => expect(calls).toBe(1))

    // The real order appends the summary and its matching end, then dispatches
    // each event; the end-triggered force lands while A is still running.
    compactionSummary(handler, session, 'c1')
    compactionEnd(handler, session, 'c1')

    release()
    await first
    await vi.waitFor(() => expect(checkpointCalls(session)).toHaveLength(2))
    await settle()
    expect(calls).toBe(2)

    const checkpoints = checkpointCalls(session).map((call) => call[1])
    expect(checkpoints.map((checkpoint) => checkpoint.version)).toEqual([1, 2])
    // The follow-up covers the ended compaction; the joined pass did not.
    expect(checkpoints[1]!.basedOnSeq).toBeGreaterThan(checkpoints[0]!.basedOnSeq)
  })

  it('does not pay for a covering pass when the existing in-flight refresh fails', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const brief = '🎯 ACTIVE GOAL: failing pass\n- bullet that never commits'
    const stream = async function* () {
      await gate
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: brief }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: brief } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
    const { ctx, handlers } = makeCtx({ stream })
    applyKeeper(ctx as never, baseConfig)
    const handler = handlers.get('session/event')!
    const service = getCheckpointService()!
    const session = sessionWithTurns(1)
    const appendImplementation = session.append.getMockImplementation()!
    let failCheckpointWrites = false
    session.append.mockImplementation((...args: unknown[]) => {
      if (failCheckpointWrites && args[0] === 'state/checkpoint') throw new Error('checkpoint write failed')
      return appendImplementation(...args)
    })

    const first = service.ensureCheckpoint(session as never, { force: true })
    compactionSummary(handler, session, 'c1')
    compactionEnd(handler, session, 'c1')
    failCheckpointWrites = true
    release()

    const failed = await first
    expect(failed.ok).toBe(false)
    await settle()
    // Exactly one paid pass: the failed in-flight refresh is not duplicated; the
    // natural staleness floor owns the retry.
    expect(ctx.llm.stream).toHaveBeenCalledTimes(1)
    expect(session.events.filter((event) => event.type === 'state/checkpoint')).toHaveLength(0)
  })

  it('clears held summaries on session/disposed and plugin dispose', async () => {
    const disposed = makeCtx()
    applyKeeper(disposed.ctx as never, baseConfig)
    const disposedSession = sessionWithTurns(2)
    compactionSummary(disposed.handlers.get('session/event')!, disposedSession, 'c1')
    disposed.handlers.get('session/disposed')!(disposedSession)
    compactionEnd(disposed.handlers.get('session/event')!, disposedSession, 'c1')
    await settle()
    expect(checkpointCalls(disposedSession)).toHaveLength(0)

    const torn = makeCtx()
    applyKeeper(torn.ctx as never, baseConfig)
    const tornSession = sessionWithTurns(2)
    compactionSummary(torn.handlers.get('session/event')!, tornSession, 'c2')
    torn.handlers.get('dispose')!()
    compactionEnd(torn.handlers.get('session/event')!, tornSession, 'c2')
    await settle()
    expect(checkpointCalls(tornSession)).toHaveLength(0)
    expect(getCheckpointService()).toBeNull()
  })

  it('refreshes on the staleness floor at turn/end', async () => {
    const { ctx, handlers } = makeCtx()
    applyKeeper(ctx as never, baseConfig)
    const handler = handlers.get('session/event')!
    // 14 structural events — past the default floor of 12.
    const session = sessionWithTurns(7)

    handler(session, { type: 'turn/end', seq: session.seq, data: { reason: { kind: 'stop' }, turn: 7 } })
    await vi.waitFor(() => expect(checkpointCalls(session)).toHaveLength(1))
    expect(checkpointCalls(session)[0]![1].via).toBe('llm')
  })

  it('fires at the structural floor WITHOUT token pressure (doc 67 amendment)', async () => {
    const { ctx, handlers } = makeCtx()
    applyKeeper(ctx as never, baseConfig)
    const handler = handlers.get('session/event')!
    const session = sessionWithTurns(7) // 14 structural events >= 12
    stubLowPressure(ctx, session) // pressure reads far below half the 1M window

    handler(session, { type: 'turn/end', seq: session.seq, data: { reason: { kind: 'stop' }, turn: 7 } })
    await vi.waitFor(() => expect(checkpointCalls(session)).toHaveLength(1))
    expect(checkpointCalls(session)[0]![1].via).toBe('llm')
  })

  it('fires on the 24 h floor without pressure, below the structural floor, and bumps the version', async () => {
    const { ctx, handlers } = makeCtx()
    applyKeeper(ctx as never, baseConfig)
    const handler = handlers.get('session/event')!
    const session = sessionWithTurns(1) // 2 structural events — far below 12
    stubLowPressure(ctx, session)

    const service = createCheckpointService(ctx as never, baseConfig)
    await service.ensureCheckpoint(session as never)
    expect(checkpointCalls(session)).toHaveLength(1)

    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 25 * 3_600_000)
    try {
      handler(session, { type: 'turn/end', seq: session.seq, data: { reason: { kind: 'stop' }, turn: 1 } })
      await vi.waitFor(() => expect(checkpointCalls(session)).toHaveLength(2))
    } finally {
      vi.restoreAllMocks()
    }
    expect(checkpointCalls(session).map((call) => call[1].version)).toEqual([1, 2])
  })

  it('stays silent below the floor under low pressure (pressure cannot create a first checkpoint)', async () => {
    const { ctx, handlers } = makeCtx()
    applyKeeper(ctx as never, baseConfig)
    const handler = handlers.get('session/event')!
    const session = sessionWithTurns(5) // 10 structural events < 12
    stubLowPressure(ctx, session)

    handler(session, { type: 'turn/end', seq: session.seq, data: { reason: { kind: 'stop' }, turn: 5 } })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(checkpointCalls(session)).toHaveLength(0)
    expect(ctx.llm.stream).not.toHaveBeenCalled()
  })

  it('keeps the anti-thrash floor for a fresh checkpoint even with pressure above half', async () => {
    const { ctx, handlers } = makeCtx() // no meter/window stub → pressure reads true
    applyKeeper(ctx as never, baseConfig)
    const handler = handlers.get('session/event')!
    const session = sessionWithTurns(7)
    handler(session, { type: 'turn/end', seq: session.seq, data: { reason: { kind: 'stop' }, turn: 7 } })
    await vi.waitFor(() => expect(checkpointCalls(session)).toHaveLength(1))

    // No new structural events: the pressure extra trigger cannot bypass the
    // freshness window — at most one checkpoint per firing.
    handler(session, { type: 'turn/end', seq: session.seq, data: { reason: { kind: 'stop' }, turn: 8 } })
    handler(session, { type: 'turn/end', seq: session.seq, data: { reason: { kind: 'stop' }, turn: 9 } })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(checkpointCalls(session)).toHaveLength(1)
  })

  it('writes a real state/checkpoint through the floor trigger with a stub meter (live-ish proof)', async () => {
    const { Session } = await import('@deepseek-ai/dsh-session')
    const { createUserMessage } = await import('@deepseek-ai/dsh-llm')
    const session = Session.create('heart-floor-proof' as never)
    for (let i = 0; i < 6; i++) {
      session.append('turn/start', { turn: i + 1 })
      session.append(
        'user/message',
        createUserMessage({ content: [{ type: 'text', text: `query ${i}` }], source: { kind: 'user', participant: { kind: 'human', name: 'operator' } } }),
        { surfaceOp: 'append' },
      )
      session.append('turn/end', { turn: i + 1, reason: { kind: 'stop' } })
    }
    const { ctx, handlers } = makeCtx()
    stubLowPressure(ctx as never, session as never)
    applyKeeper(ctx as never, baseConfig)
    handlers.get('session/event')!(session, { type: 'turn/end', seq: session.seq, data: { reason: { kind: 'stop' }, turn: 7 } })

    await vi.waitFor(() => {
      expect(session.snapshotEvents().filter((event) => event.type === 'state/checkpoint')).toHaveLength(1)
    })
    const checkpoint = session.snapshotEvents().find((event) => event.type === 'state/checkpoint')!
    const data = checkpoint.data as CheckpointData
    expect(data.via).toBe('llm')
    expect(data.basedOnStructuralCount).toBe(12)
    expect(renderCheckpointBlock(data)).toContain('### State checkpoint')
    // The checkpoint surface message is live on the real surface.
    const live = session.surface.nodes.filter((seq) => {
      const event = session.eventAt(seq) as { data?: { source?: { kind?: string } } } | undefined
      return event?.data?.source?.kind === 'enpoi-keeper'
    })
    expect(live).toHaveLength(1)
  })
})

describe('enpoi-context-keeper surface replace (real Session)', () => {
  it('appends once, then replaces the prior checkpoint node in place on refresh', async () => {
    const { Session } = await import('@deepseek-ai/dsh-session')
    const { createUserMessage } = await import('@deepseek-ai/dsh-llm')

    const session = Session.create('heart-surface-session' as never)
    session.append('turn/start', { turn: 1 })
    session.append(
      'user/message',
      createUserMessage({ content: [{ type: 'text', text: 'do the heart work' }], source: { kind: 'user', participant: { kind: 'human', name: 'operator' } } }),
      { surfaceOp: 'append' },
    )
    session.append('turn/end', { turn: 1, reason: { kind: 'stop' } })

    const { ctx } = makeCtx()
    const service = createCheckpointService(ctx as never, baseConfig)

    const first = await service.ensureCheckpoint(session as never)
    expect(first.ok).toBe(true)
    const firstSeq = session.surface.nodes.at(-1)!
    const firstEvent = session.eventAt(firstSeq) as {
      type: string
      surfaceOp?: unknown
      data: { content: Array<{ text?: string }> }
    }
    expect(firstEvent.type).toBe('user/message')
    expect(firstEvent.surfaceOp).toBe('append')
    expect(firstEvent.data.content[0]!.text).toContain('### State checkpoint')

    const second = await service.ensureCheckpoint(session as never, { force: true })
    expect(second.ok).toBe(true)
    const secondSeq = session.surface.nodes.at(-1)!
    expect(secondSeq).not.toBe(firstSeq)
    // The prior node left the surface; the new one cites it as its replacement.
    expect(session.surface.nodes).not.toContain(firstSeq)
    const secondEvent = session.eventAt(secondSeq) as { surfaceOp?: unknown; sourceEventSeqs?: unknown }
    expect(secondEvent.surfaceOp).toEqual({ op: 'replace', startSeq: firstSeq, endSeq: firstSeq })
    expect(secondEvent.sourceEventSeqs).toEqual([firstSeq])

    // Append-only: both durable events and both messages remain in the log.
    const types = session.snapshotEvents().map((event) => event.type)
    expect(types.filter((type) => type === 'state/checkpoint')).toHaveLength(2)
    expect(types.filter((type) => type === 'user/message')).toHaveLength(3)

    // Exactly one live checkpoint node on the surface.
    const live = session.surface.nodes.filter((seq) => {
      const data = session.eventAt(seq)?.data as { source?: { kind?: string } } | undefined
      return data?.source?.kind === 'enpoi-keeper'
    })
    expect(live).toEqual([secondSeq])
    expect(latestCheckpoint(session as never)!.version).toBe(2)
  })
})
