import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  apply as applyKeeper,
  getBriefService,
  PREFETCH_DEBOUNCE_MS,
  resetKeeperRouteHealth,
  type Config,
} from '../src/index'

beforeEach(() => { resetKeeperRouteHealth() })

/**
 * Session mock that honours `snapshotEvents(from)` the way the real Session
 * does (the keeper's structural counter reads only the appended tail).
 */
function makeSession(id: string, events: Array<{ type: string; seq: number; data: unknown }> = []) {
  const log = [...events]
  return {
    id,
    get seq() { return log.length },
    log,
    snapshotEvents: (from: unknown = 0, to?: number) => log.slice(Number(from) || 0, to ?? log.length),
    requestContext: () => undefined,
    surface: { nodes: [] as number[] },
    append: vi.fn((...args: unknown[]) => {
      const [type, data] = args as [string, unknown]
      log.push({ type, seq: log.length, data })
      return { type, seq: log.length - 1, data }
    }),
  }
}

/** Append N turns (2 structural events each) to a mock session. */
function grow(session: ReturnType<typeof makeSession>, turns: number): void {
  for (let i = 0; i < turns; i++) {
    session.log.push({ type: 'user/message', seq: session.log.length, data: { content: `query ${i}`, source: { kind: 'user' } } })
    session.log.push({ type: 'turn/end', seq: session.log.length, data: { reason: { kind: 'stop' }, turn: i + 1 } })
  }
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
  // Isolated: these tests exercise the brief prefetch only — keep the
  // checkpoint gate silent (its own floor would otherwise spend a stream call).
  checkpointStaleEvents: 500,
  checkpointStaleHours: 24,
}

const GOOD_PROSE = '🎯 ACTIVE GOAL: prefetched goal\n- Prefetched bullet'

/** Minimal ctx mock: settings, llm.stream (scriptable), logger, on. */
function makeCtx(streamOverride?: () => AsyncGenerator<unknown>) {
  let calls = 0
  const defaultStream = async function* () {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: GOOD_PROSE }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: GOOD_PROSE } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
  const stream = async function* () {
    calls += 1
    yield* (streamOverride ?? defaultStream)()
  }
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  const ctx = {
    get: (ns: string) => (ns === 'settings' ? { get: () => ({ capabilities: { tools: {} }, personas: {} }) } : undefined),
    llm: { stream: vi.fn(stream) },
    logger: { info: vi.fn(), warn: vi.fn() },
    on: vi.fn((name: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(name, handler)
      return () => handlers.delete(name)
    }),
  }
  return { ctx, handlers, streamCalls: () => calls }
}

/** Append a turn/end to the mock log and dispatch it, like the real runtime. */
function dispatchTurnEnd(handler: (...args: unknown[]) => unknown, session: ReturnType<typeof makeSession>, turn = 1): void {
  const event = { type: 'turn/end', seq: session.seq, data: { reason: { kind: 'stop' }, turn } }
  session.log.push(event)
  handler(session, event)
}

describe('enpoi-context-keeper background brief prefetch', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('fires on structural staleness and makes the follow-up ensureFreshBrief a cache hit (no LLM call)', async () => {
    const { ctx, handlers, streamCalls } = makeCtx()
    applyKeeper(ctx as never, baseConfig)
    const handler = handlers.get('session/event')!
    const session = makeSession('prefetch-hit')
    grow(session, 14) // 28 structural events — past structuralDistanceK (24)

    dispatchTurnEnd(handler, session)
    expect(streamCalls()).toBe(0) // debounced: the turn itself pays nothing
    await vi.advanceTimersByTimeAsync(PREFETCH_DEBOUNCE_MS)
    await vi.advanceTimersByTimeAsync(0)
    expect(streamCalls()).toBe(1)

    const service = getBriefService()!
    const result = await service.ensureFreshBrief(session as never)
    expect(result.ok).toBe(true)
    expect(result.reason).toBe('cache-hit')
    expect(result.prose).toContain('prefetched goal')
    expect(streamCalls()).toBe(1) // target: no LLM call for the consumer
  })

  it('coalesces a turn/end burst into one prefetch', async () => {
    const { ctx, handlers, streamCalls } = makeCtx()
    applyKeeper(ctx as never, baseConfig)
    const handler = handlers.get('session/event')!
    const session = makeSession('prefetch-coalesce')
    grow(session, 14)

    dispatchTurnEnd(handler, session)
    dispatchTurnEnd(handler, session)
    dispatchTurnEnd(handler, session)
    await vi.advanceTimersByTimeAsync(PREFETCH_DEBOUNCE_MS)
    await vi.advanceTimersByTimeAsync(0)

    expect(streamCalls()).toBe(1)
  })

  it('lets a consumer join the in-flight prefetch (single-flight, one stream call)', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    let calls = 0
    const gated = async function* () {
      calls += 1
      await gate
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: GOOD_PROSE }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: GOOD_PROSE } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
    const { ctx, handlers } = makeCtx(gated)
    applyKeeper(ctx as never, baseConfig)
    const handler = handlers.get('session/event')!
    const session = makeSession('prefetch-join')
    grow(session, 14)

    dispatchTurnEnd(handler, session)
    await vi.advanceTimersByTimeAsync(PREFETCH_DEBOUNCE_MS) // prefetch starts, gated
    const consumer = getBriefService()!.ensureFreshBrief(session as never)
    release()
    const result = await consumer

    expect(result.ok).toBe(true)
    expect(calls).toBe(1) // consumer joined, no second distillation
    expect(session.append).toHaveBeenCalledTimes(1)
  })

  it('suppresses within minRefreshMs, then fires once the anti-thrash floor elapses', async () => {
    const { ctx, handlers, streamCalls } = makeCtx()
    applyKeeper(ctx as never, baseConfig)
    const handler = handlers.get('session/event')!
    const session = makeSession('prefetch-throttle')
    grow(session, 14)

    dispatchTurnEnd(handler, session)
    await vi.advanceTimersByTimeAsync(PREFETCH_DEBOUNCE_MS)
    await vi.advanceTimersByTimeAsync(0)
    expect(streamCalls()).toBe(1)

    // Structurally stale again, but only 5 s old — the floor wins.
    // (A grown session object: the runtime delivers new events, it does not
    // mutate a stale one behind the counter's back.)
    grow(session, 20)
    const grown = makeSession('prefetch-throttle', session.log)
    const now = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(now + 5_000)
    dispatchTurnEnd(handler, grown)
    await vi.advanceTimersByTimeAsync(PREFETCH_DEBOUNCE_MS)
    await vi.advanceTimersByTimeAsync(0)
    expect(streamCalls()).toBe(1)

    // Past minRefreshMs — prefetch fires again.
    vi.spyOn(Date, 'now').mockReturnValue(now + 65_000)
    dispatchTurnEnd(handler, grown)
    await vi.advanceTimersByTimeAsync(PREFETCH_DEBOUNCE_MS)
    await vi.advanceTimersByTimeAsync(0)
    expect(streamCalls()).toBe(2)
    vi.restoreAllMocks()
  })

  it('honours the negative cache (no prefetch retry storm), then retries after it expires', async () => {
    let calls = 0
    const failing = async function* () {
      calls += 1
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'finish', reason: { kind: 'error', failure: { message: 'upstream down', code: 'UPSTREAM' } } }
    }
    const { ctx, handlers, streamCalls } = makeCtx(failing)
    applyKeeper(ctx as never, baseConfig)
    const handler = handlers.get('session/event')!
    const session = makeSession('prefetch-negative')
    grow(session, 14)

    dispatchTurnEnd(handler, session)
    await vi.advanceTimersByTimeAsync(PREFETCH_DEBOUNCE_MS)
    await vi.advanceTimersByTimeAsync(0)
    expect(streamCalls()).toBe(2) // primary + fallback, then negative-cached

    grow(session, 20)
    const grown = makeSession('prefetch-negative', session.log)
    dispatchTurnEnd(handler, grown)
    await vi.advanceTimersByTimeAsync(PREFETCH_DEBOUNCE_MS)
    await vi.advanceTimersByTimeAsync(0)
    expect(streamCalls()).toBe(2) // still negative-cached

    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 121_000)
    dispatchTurnEnd(handler, grown)
    await vi.advanceTimersByTimeAsync(PREFETCH_DEBOUNCE_MS)
    await vi.advanceTimersByTimeAsync(0)
    expect(streamCalls()).toBe(4) // cache expired — one more attempt
    vi.restoreAllMocks()
  })

  it('writes a prefetch telemetry line when a prefetch lands', async () => {
    const home = mkdtempSync(join(tmpdir(), 'keeper-prefetch-'))
    const previous = process.env.DSH_HOME
    process.env.DSH_HOME = home
    try {
      const { ctx, handlers } = makeCtx()
      applyKeeper(ctx as never, baseConfig)
      const handler = handlers.get('session/event')!
      const session = makeSession('prefetch-telemetry')
      grow(session, 14)

      dispatchTurnEnd(handler, session)
      await vi.advanceTimersByTimeAsync(PREFETCH_DEBOUNCE_MS)
      await vi.advanceTimersByTimeAsync(0)

      const log = readFileSync(join(home, '.dsh', 'logs', 'enpoi-keeper.log'), 'utf8')
      expect(log).toContain('prefetch: session=prefetch-telemetry')
      expect(log).toContain('landed (distilled')
      expect(log).toContain('model freellmapi/auto')
    } finally {
      if (previous === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previous
      rmSync(home, { recursive: true, force: true })
    }
  })
})
