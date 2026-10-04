import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  buildTemplateCheckpoint,
  checkpointTelemetry,
  createCheckpointService,
  latestCheckpoint,
  renderCheckpointBlock,
  resetKeeperRouteHealth,
  apply as applyKeeper,
  type CheckpointData,
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
    requestContext: () => undefined,
    surface: { nodes: [] as number[] },
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
    events.push({ type: 'user/message', seq: seq++, data: { content: `query ${i}`, source: { kind: 'user' } } })
    events.push({ type: 'assistant/message', seq: seq++, data: { text: `answer ${i}` } })
    events.push({ type: 'turn/end', seq: seq++, data: { reason: { kind: 'stop' }, turn: i + 1 } })
  }
  return makeSession(events)
}

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
    yield { type: 'text-delta', index: 0, text: '🎯 ACTIVE GOAL: ship the heart\n- Whiteboard + keeper checkpoints' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: '🎯 ACTIVE GOAL: ship the heart\n- Whiteboard + keeper checkpoints' } }
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
      { type: 'user/message', seq: 1, data: { content: 'ship the keeper checkpoint', source: { kind: 'user' } } },
      { type: 'tool/call', seq: 2, data: { name: 'write', arguments: '{"path":"docs/67-heart-implementation-plan.md"}' } },
      { type: 'assistant/message', seq: 3, data: { text: 'Done.\nMore detail' } },
      { type: 'tool/result', seq: 4, data: { error: { message: 'boom: missing settings' } } },
      { type: 'turn/end', seq: 5, data: { reason: { kind: 'stop' }, turn: 1 } },
    ])
    const text = buildTemplateCheckpoint(session as never)
    expect(text).toContain('🎯 ACTIVE GOAL & CORE TRAJECTORY:')
    expect(text).toContain('ship the keeper checkpoint')
    expect(text).toContain('📚 DOCUMENTATION & SPECIFICATIONS INVENTORY:')
    expect(text).toContain('docs/67-heart-implementation-plan.md')
    expect(text).toContain('🏛️ ARCHITECTURAL INVARIANTS & CONCRETE DECISIONS:')
    expect(text).toContain('⚡ ACTIVE BLOCKERS & OPEN QUESTIONS:')
    expect(text).toContain('boom: missing settings')
  })

  it('reads the current durable assistant payload shape ({ turn, step, message })', () => {
    const session = makeSession([
      { type: 'turn/start', seq: 0, data: { turn: 1 } },
      { type: 'user/message', seq: 1, data: { content: 'decide', source: { kind: 'user' } } },
      { type: 'assistant/message', seq: 2, data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'Decision: replace the checkpoint node in place.' }] } } },
      { type: 'turn/end', seq: 3, data: { reason: { kind: 'stop' }, turn: 1 } },
    ])
    const text = buildTemplateCheckpoint(session as never)
    expect(text).toContain('🏛️ ARCHITECTURAL INVARIANTS & CONCRETE DECISIONS:')
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
    // A publishable brief needs at least one content line: the empty-landing
    // failover (live defect 2026-09-26) now treats header-only output as a
    // route failure, so a bare header would legitimately fail over.
    const brief = '🎯 ACTIVE GOAL: gated goal\n- gated bullet'
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
  })
})

describe('enpoi-context-keeper triggers (apply listener)', () => {
  it('refreshes on compaction/end and reads the newest checkpoint back', async () => {
    const { ctx, handlers } = makeCtx()
    applyKeeper(ctx as never, baseConfig)
    const handler = handlers.get('session/event')!
    const session = sessionWithTurns(2)

    handler(session, { type: 'compaction/end', seq: 0, data: { compactionId: 'c1', turn: 1 } })
    await vi.waitFor(() => expect(checkpointCalls(session)).toHaveLength(1))

    const latest = latestCheckpoint(session as never)
    expect(latest).not.toBeNull()
    expect(latest!.version).toBe(1)
    expect(renderCheckpointBlock(latest!)).toContain('### State checkpoint')

    // A second cut inside the same window refreshes again, never duplicating at
    // the same version.
    handler(session, { type: 'compaction/end', seq: 1, data: { compactionId: 'c2', turn: 1 } })
    await vi.waitFor(() => expect(checkpointCalls(session)).toHaveLength(2))
    expect(checkpointCalls(session).map((call) => call[1].version)).toEqual([1, 2])
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
        createUserMessage({ content: [{ type: 'text', text: `query ${i}` }], source: { kind: 'user' } }),
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
      createUserMessage({ content: [{ type: 'text', text: 'do the heart work' }], source: { kind: 'user' } }),
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
