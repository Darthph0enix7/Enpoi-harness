import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  apply as applyKeeper,
  createBriefService,
  createCheckpointService,
  getBriefService,
  getCheckpointService,
  getKeeperBookkeeping,
  BoundedSessionCache,
  KEEPER_CACHE_CAP,
  resetKeeperRouteHealth,
  type Config,
} from '../src/index'

beforeEach(() => { resetKeeperRouteHealth() })

/**
 * Session mock that serves both paths: `snapshotEvents` reflects appends (the
 * structural counter reads only the tail) and `seq` is the next log position.
 */
function makeSession(id: string, events: Array<{ type: string; seq: number; data: unknown }> = []) {
  const log = [...events]
  let nextSeq = log.length === 0 ? 0 : Math.max(...log.map((event) => event.seq)) + 1
  return {
    id,
    header: { createdAt: Date.UTC(2026, 8, 20) },
    get seq() { return nextSeq },
    events: log,
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

/** Append N turns (structural events) to a mock session. */
function withTurns(session: ReturnType<typeof makeSession>, turns: number): void {
  for (let i = 0; i < turns; i++) {
    session.events.push({ type: 'user/message', seq: session.seq, data: { content: `query ${i}`, source: { kind: 'user' } } })
    session.events.push({ type: 'assistant/message', seq: session.seq, data: { text: `answer ${i}` } })
    session.events.push({ type: 'turn/end', seq: session.seq, data: { reason: { kind: 'stop' }, turn: i + 1 } })
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
  // Isolated: these tests exercise eviction only — keep the staleness trigger
  // silent so a turn/end cannot spend a checkpoint stream call.
  checkpointStaleEvents: 500,
  checkpointStaleHours: 24,
}

const GOOD_PROSE = '🎯 ACTIVE GOAL: eviction goal\n- Eviction bullet'

/** Minimal ctx mock: settings, llm.stream, logger, on (handlers captured). */
function makeCtx() {
  let calls = 0
  const stream = async function* () {
    calls += 1
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: GOOD_PROSE }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: GOOD_PROSE } }
    yield { type: 'finish', reason: { kind: 'stop' } }
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

/** Reach the private (compile-time only) cache map of a service. */
function cacheOf(service: object): BoundedSessionCache<unknown> {
  return (service as unknown as { cache: BoundedSessionCache<unknown> }).cache
}

describe('enpoi-context-keeper session eviction', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('clears all three per-session caches on session/disposed, scoped to that session', async () => {
    const { ctx, handlers } = makeCtx()
    applyKeeper(ctx as never, baseConfig)
    const brief = getBriefService()!
    const checkpoint = getCheckpointService()!
    const sessionA = makeSession('evict-a')
    const sessionB = makeSession('evict-b')
    withTurns(sessionA, 1)
    withTurns(sessionB, 1)

    await brief.ensureFreshBrief(sessionA as never)
    await checkpoint.ensureCheckpoint(sessionA as never, { force: true })
    await brief.ensureFreshBrief(sessionB as never)
    await checkpoint.ensureCheckpoint(sessionB as never, { force: true })

    const onEvent = handlers.get('session/event')!
    for (const session of [sessionA, sessionB]) {
      onEvent(session, { type: 'turn/end', seq: session.seq, data: { reason: { kind: 'stop' }, turn: 1 } })
    }

    expect(brief.cacheSize).toBe(2)
    expect(checkpoint.cacheSize).toBe(2)
    expect(getKeeperBookkeeping()!.claimCounters()).toBe(2)

    // The canonical harness disposal edge.
    handlers.get('session/disposed')!(sessionA)

    expect(brief.cacheSize).toBe(1)
    expect(checkpoint.cacheSize).toBe(1)
    expect(getKeeperBookkeeping()!.claimCounters()).toBe(1)

    // B survived; A recomputes identically (a miss is behavior-neutral).
    const again = await brief.ensureFreshBrief(sessionA as never)
    expect(again.ok).toBe(true)
    expect(again.prose).toBe(GOOD_PROSE)
    expect(again.reason).toBe('distilled')
    expect(brief.cacheSize).toBe(2)
  })

  it('cancels the disposed session\'s claim-batch timer', () => {
    const { ctx, handlers } = makeCtx()
    applyKeeper(ctx as never, baseConfig)
    const onEvent = handlers.get('session/event')!
    const session = makeSession('evict-timer')
    withTurns(session, 1)

    onEvent(session, { type: 'turn/end', seq: session.seq, data: { reason: { kind: 'stop' }, turn: 1 } })
    expect(getKeeperBookkeeping()!.claimCounters()).toBe(1)

    handlers.get('session/disposed')!(session)
    expect(getKeeperBookkeeping()!.claimCounters()).toBe(0)
    // The 5-minute batch timer was cleared with the entry — advancing past it
    // must not run a claims pass for the disposed session.
    vi.advanceTimersByTime(6 * 60_000)
    expect(ctx.llm.stream).not.toHaveBeenCalled()
  })

  it('bounds each service cache at KEEPER_CACHE_CAP (oldest gone, newest present)', () => {
    const { ctx } = makeCtx()
    const brief = createBriefService(ctx as never, baseConfig)
    const checkpoint = createCheckpointService(ctx as never, baseConfig)
    const briefCache = cacheOf(brief)
    const checkpointCache = cacheOf(checkpoint)

    for (let i = 0; i <= KEEPER_CACHE_CAP; i++) {
      briefCache.set(`brief-${i}`, { marker: i })
      checkpointCache.set(`cp-${i}`, { marker: i })
    }

    expect(briefCache.size).toBe(KEEPER_CACHE_CAP)
    expect(checkpointCache.size).toBe(KEEPER_CACHE_CAP)
    expect(briefCache.has('brief-0')).toBe(false)
    expect(briefCache.has(`brief-${KEEPER_CACHE_CAP}`)).toBe(true)
    expect(checkpointCache.has('cp-0')).toBe(false)
    expect(checkpointCache.has(`cp-${KEEPER_CACHE_CAP}`)).toBe(true)
  })

  it('refreshes recency on read (LRU, not FIFO)', () => {
    const cache = new BoundedSessionCache<number>(3)
    cache.set('a', 1)
    cache.set('b', 2)
    cache.set('c', 3)
    expect(cache.get('a')).toBe(1) // 'a' becomes the newest
    cache.set('d', 4) // evicts 'b', the least-recently-used
    expect(cache.size).toBe(3)
    expect(cache.has('a')).toBe(true)
    expect(cache.has('b')).toBe(false)
    expect(cache.has('c')).toBe(true)
    expect(cache.has('d')).toBe(true)
  })

  it('bounds the claim counters and cancels an LRU-evicted counter\'s timer', () => {
    const { ctx, handlers } = makeCtx()
    applyKeeper(ctx as never, baseConfig)
    const onEvent = handlers.get('session/event')!

    const dispatch = (i: number): void => {
      const session = makeSession(`counter-${i}`)
      withTurns(session, 1)
      onEvent(session, { type: 'turn/end', seq: session.seq, data: { reason: { kind: 'stop' }, turn: 1 } })
    }
    for (let i = 0; i < KEEPER_CACHE_CAP; i++) dispatch(i)
    expect(getKeeperBookkeeping()!.claimCounters()).toBe(KEEPER_CACHE_CAP)
    const timersAtCap = vi.getTimerCount()

    dispatch(KEEPER_CACHE_CAP) // one more entry → the oldest counter is evicted
    expect(getKeeperBookkeeping()!.claimCounters()).toBe(KEEPER_CACHE_CAP)
    // One timer created, the evicted counter's timer cancelled — net zero.
    expect(vi.getTimerCount()).toBe(timersAtCap)
  })

  it('recomputes the same brief after an explicit forget', async () => {
    const { ctx, streamCalls } = makeCtx()
    const brief = createBriefService(ctx as never, baseConfig)
    const session = makeSession('recompute-brief')
    withTurns(session, 1)

    const first = await brief.ensureFreshBrief(session as never)
    expect(first.ok).toBe(true)
    expect(streamCalls()).toBe(1)

    brief.forget(session.id)
    expect(brief.cacheSize).toBe(0)

    const second = await brief.ensureFreshBrief(session as never)
    expect(second.ok).toBe(true)
    expect(second.prose).toBe(first.prose)
    expect(second.reason).toBe('distilled')
    expect(streamCalls()).toBe(2)
  })

  it('recomputes the same checkpoint text after an explicit forget', async () => {
    const { ctx } = makeCtx()
    const checkpoint = createCheckpointService(ctx as never, baseConfig)
    const session = makeSession('recompute-checkpoint')
    withTurns(session, 1)

    const first = await checkpoint.ensureCheckpoint(session as never, { force: true })
    expect(first.ok).toBe(true)

    checkpoint.forget(session.id)
    expect(checkpoint.cacheSize).toBe(0)

    const second = await checkpoint.ensureCheckpoint(session as never, { force: true })
    expect(second.ok).toBe(true)
    expect(second.text).toBe(first.text)
    expect(second.reason).toBe('refreshed')
  })
})
