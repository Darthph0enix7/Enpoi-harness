import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect, vi, beforeEach, afterEach, afterAll, beforeAll } from 'vitest'
import { openMemoryDb } from 'dsh-enpoi-memory'
import {
  DEFAULT_KEEPER_ROUTE,
  resolveKeeperRoute,
  keeperAttempts,
  cleanKeeperProse,
  resetKeeperRouteHealth,
  splitClaims,
  createBriefService,
  apply,
  type Config,
} from '../src/index'

let memoryDir = ''
let previousMemoryDb: string | undefined

beforeAll(() => {
  memoryDir = mkdtempSync(join(tmpdir(), 'enpoi-keeper-memory-'))
  previousMemoryDb = process.env.DSH_MEMORY_DB
  process.env.DSH_MEMORY_DB = join(memoryDir, 'memory.db')
})

afterAll(() => {
  if (previousMemoryDb === undefined) delete process.env.DSH_MEMORY_DB
  else process.env.DSH_MEMORY_DB = previousMemoryDb
  rmSync(memoryDir, { recursive: true, force: true })
})

beforeEach(() => { resetKeeperRouteHealth() })

/**
 * Minimal session mock satisfying the keeper's reads: `frameInput` walks
 * `snapshotEvents()`, and the distill path reads the log tail for its causal
 * snapshot sequence — both must reflect the appended events.
 */
function makeSession(events: Array<{ type: string; seq: number; data: unknown }> = []) {
  const log = [...events]
  return {
    id: 'test-session',
    // The real Session reports `seq` as the next sequence number (log length).
    get seq() { return log.length },
    events: log,
    snapshotEvents: (from = 0, to = log.length): Array<{ type: string; seq: number; data: unknown }> => log.slice(from, to),
    eventAt: (seq: number) => log[Number(seq)],
    append: vi.fn((event: { type: string; seq: number; data: unknown }) => { log.push(event) }),
  }
}

/** Minimal ctx mock: settings + llm.stream + logger + on (claims listener). */
function makeCtx(overrides: {
  personas?: Record<string, { provider?: string; model?: string; reasoningEffort?: string }>
  stream?: (opts: { provider: string; model: string }) => AsyncGenerator<unknown>
} = {}) {
  const stream = overrides.stream ?? (async function* () {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: '🎯 ACTIVE GOAL: test goal\n- Test goal bullet' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: '🎯 ACTIVE GOAL: test goal\n- Test goal bullet' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  })
  const streamSpy = vi.fn(stream)
  return {
    get: (ns: string) => {
      if (ns === 'settings') {
        return {
          get: () => ({ personas: overrides.personas ?? {} }),
        }
      }
      return undefined
    },
    llm: { stream: streamSpy },
    logger: { info: vi.fn(), warn: vi.fn() },
    on: vi.fn(),
    provide: vi.fn(),
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
}

/** A session with N structural events (user/message + turn/end pairs). */
function sessionWithTurns(n: number) {
  const events: Array<{ type: string; seq: number; data: unknown }> = []
  // Zero-based sequence numbers, matching the runtime Session (event i has
  // seq i; `session.seq` is the next number, i.e. the log length).
  let seq = 0
  for (let i = 0; i < n; i++) {
    events.push({ type: 'user/message', seq: seq++, data: { content: `query ${i}`, source: { kind: 'user', participant: { kind: 'human', name: 'operator' } } } })
    events.push({ type: 'assistant/message', seq: seq++, data: { text: `answer ${i}` } })
    events.push({ type: 'turn/end', seq: seq++, data: { reason: { kind: 'stop' }, turn: i + 1 } })
  }
  return makeSession(events)
}

describe('enpoi-context-keeper route resolution', () => {
  it('uses plugin Config primary when no keeper persona is assigned', () => {
    const ctx = makeCtx({ personas: {} })
    const route = resolveKeeperRoute(ctx as never, baseConfig)
    expect(route.provider).toBe('freellmapi')
    expect(route.model).toBe('auto')
    expect(route.fallbackProvider).toBe('antigravity')
    expect(route.fallbackModel).toBe('gemini-3.7-flash-tiered')
    expect(route.reasoningEffort).toBeUndefined()
  })

  it('defaults to the keyless kilo seed with no fallback link when no Config route is supplied', () => {
    const ctx = makeCtx({ personas: {} })
    const route = resolveKeeperRoute(ctx as never, {} as Config)
    expect(route.provider).toBe(DEFAULT_KEEPER_ROUTE.provider)
    expect(route.model).toBe(DEFAULT_KEEPER_ROUTE.model)
    expect(route.fallbackProvider).toBeUndefined()
    expect(route.fallbackModel).toBeUndefined()
    expect(keeperAttempts(route)).toEqual([DEFAULT_KEEPER_ROUTE])
  })

  it('uses the assigned keeper persona as primary, keeping the config fallback', () => {
    const ctx = makeCtx({
      personas: { keeper: { provider: 'antigravity', model: 'gemini-3.7-flash-tiered' } },
    })
    const route = resolveKeeperRoute(ctx as never, baseConfig)
    expect(route.provider).toBe('antigravity')
    expect(route.model).toBe('gemini-3.7-flash-tiered')
    expect(route.fallbackProvider).toBe('antigravity')
    expect(route.fallbackModel).toBe('gemini-3.7-flash-tiered')
  })

  it('forwards reasoningEffort when the assignment carries one', () => {
    const ctx = makeCtx({
      personas: { keeper: { provider: 'deepseek', model: 'deepseek-v4-flash', reasoningEffort: 'high' } },
    })
    const route = resolveKeeperRoute(ctx as never, baseConfig)
    expect(route.provider).toBe('deepseek')
    expect(route.model).toBe('deepseek-v4-flash')
    expect(route.reasoningEffort).toBe('high')
  })

  it('ignores partial entries (provider without model) and falls back to config', () => {
    const ctx = makeCtx({
      personas: { keeper: { provider: 'deepseek' } },
    })
    const route = resolveKeeperRoute(ctx as never, baseConfig)
    expect(route.provider).toBe('freellmapi')
    expect(route.model).toBe('auto')
  })

  it('falls back to config when settings are unavailable', () => {
    const ctx = { get: () => undefined, llm: {}, logger: {} }
    const route = resolveKeeperRoute(ctx as never, baseConfig)
    expect(route.provider).toBe('freellmapi')
    expect(route.model).toBe('auto')
  })
})

describe('enpoi-context-keeper cleanKeeperProse (zero-filler)', () => {
  it('strips sections whose only content is negative filler', () => {
    const text = [
      '🎯 ACTIVE GOAL: build the thing',
      '- Ship the revert system',
      '',
      '📚 DOCUMENTATION & SPECIFICATIONS INVENTORY:',
      '- No documentation was created or referenced.',
      '',
      '🚫 REJECTED APPROACHES & EDGE CASES:',
      '- No alternative approaches were debated.',
    ].join('\n')
    const cleaned = cleanKeeperProse(text)
    expect(cleaned).toContain('build the thing')
    expect(cleaned).not.toContain('DOCUMENTATION')
    expect(cleaned).not.toContain('REJECTED')
  })

  it('keeps sections with genuine content', () => {
    const text = [
      '🎯 ACTIVE GOAL: build the thing',
      '- Ship the revert system',
      '',
      '📚 DOCUMENTATION & SPECIFICATIONS INVENTORY:',
      '- docs/42-revert-system-design.md — the revert plan',
    ].join('\n')
    const cleaned = cleanKeeperProse(text)
    expect(cleaned).toContain('docs/42-revert-system-design.md')
  })

  it('returns empty for empty input', () => {
    expect(cleanKeeperProse('')).toBe('')
    expect(cleanKeeperProse('   ')).toBe('')
  })
})

describe('enpoi-context-keeper splitClaims (trust labels)', () => {
  it('parses claims with source tags', () => {
    const text = 'CLAIMS: [{"fact":"backup runs at 3am","category":"CONFIG_VALUES","source":"chat"},{"fact":"tunnel id is 9db9e1f7","category":"CONFIG_VALUES","source":"tool"}]'
    const claims = splitClaims(text)
    expect(claims).toHaveLength(2)
    expect(claims[0]!.source).toBe('chat')
    expect(claims[1]!.source).toBe('tool')
  })

  it('defaults missing source to chat (conservative)', () => {
    const claims = splitClaims('CLAIMS: [{"fact":"x","category":"PROJECT"}]')
    expect(claims[0]!.source).toBe('chat')
  })

  it('returns [] for no CLAIMS block or malformed JSON', () => {
    expect(splitClaims('just prose')).toEqual([])
    expect(splitClaims('CLAIMS: [{"fact":')).toEqual([])
  })

  it('parses claims whose text contains JSON brackets (live defect 2026-09-26)', () => {
    const claims = splitClaims('CLAIMS: [{"fact":"fixed the [bug] in foo.ts","category":"PROJECT","source":"tool"}]')
    expect(claims).toHaveLength(1)
    expect(claims[0]!.fact).toBe('fixed the [bug] in foo.ts')
  })
})

describe('enpoi-context-keeper BriefService (demand-driven)', () => {
  it('distills on first call and appends brief/prose-updated with structural metadata', async () => {
    const ctx = makeCtx()
    const service = createBriefService(ctx as never, baseConfig)
    const session = sessionWithTurns(1)

    const result = await service.ensureFreshBrief(session as never)

    expect(result.ok).toBe(true)
    expect(result.reason).toBe('distilled')
    expect(result.prose).toContain('test goal')
    expect(session.append).toHaveBeenCalledTimes(1)
    const [type, payload] = session.append.mock.calls[0] as [string, Record<string, unknown>]
    expect(type).toBe('brief/prose-updated')
    expect(payload.origin).toBe('context-keeper')
    expect(payload.basedOnSeq).toBe(3) // snapshot seq = last event seq
    expect(payload.basedOnStructuralCount).toBe(2) // user/message + turn/end
    expect(payload.structuralDistanceK).toBe(24)
    expect(payload.model).toBe('freellmapi/auto')
  })

  it('cache-hits when structural distance is within K (silence never invalidates)', async () => {
    const ctx = makeCtx()
    const service = createBriefService(ctx as never, baseConfig)
    const session = sessionWithTurns(1)

    await service.ensureFreshBrief(session as never)
    // No new structural events — the cache must hit even after the anti-thrash floor.
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 10 * 60_000)
    const result = await service.ensureFreshBrief(session as never)

    expect(result.reason).toBe('cache-hit')
    expect(session.append).toHaveBeenCalledTimes(1)
    vi.restoreAllMocks()
  })

  it('re-distills when structural distance exceeds K (past the anti-thrash floor)', async () => {
    const ctx = makeCtx()
    const service = createBriefService(ctx as never, baseConfig)
    const session = sessionWithTurns(1)

    await service.ensureFreshBrief(session as never)
    // 14 turns later: 28 structural events total, 26 after the cached
    // basedOnSeq (3) — past K=24. Also past the 60s anti-thrash floor.
    const grown = sessionWithTurns(14)
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 2 * 60_000)
    const result = await service.ensureFreshBrief(grown as never)
    vi.restoreAllMocks()

    expect(result.reason).toBe('distilled')
    expect(grown.append).toHaveBeenCalledTimes(1)
  })

  it('respects the anti-thrash floor (minRefreshMs)', async () => {
    const ctx = makeCtx()
    const service = createBriefService(ctx as never, baseConfig)
    const session = sessionWithTurns(1)

    await service.ensureFreshBrief(session as never)
    // 30 structural events but only 5s elapsed — the floor wins.
    const grown = sessionWithTurns(11)
    const result = await service.ensureFreshBrief(grown as never)

    expect(result.reason).toBe('cache-hit')
    expect(grown.append).toHaveBeenCalledTimes(0)
  })

  it('negative-caches failures for negativeCacheMs', async () => {
    let call = 0
    const stream = async function* () {
      call += 1
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'finish', reason: { kind: 'error', failure: { message: 'upstream down', code: 'UPSTREAM' } } }
    }
    const ctx = makeCtx({ stream })
    const service = createBriefService(ctx as never, baseConfig)
    const session = sessionWithTurns(1)

    const first = await service.ensureFreshBrief(session as never)
    expect(first.ok).toBe(false)
    expect(first.reason).toBe('failed')

    // Second call within the negative window — no retry, no fallback chain.
    const second = await service.ensureFreshBrief(session as never)
    expect(second.reason).toBe('negative-cached')
    expect(call).toBe(2) // primary + fallback both failed once; no third attempt
  })

  it('falls back to the fallback route when the primary fails and records the served route', async () => {
    let call = 0
    const stream = async function* () {
      call += 1
      if (call === 1) {
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'finish', reason: { kind: 'error', failure: { message: 'upstream down', code: 'UPSTREAM' } } }
        return
      }
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: '🎯 ACTIVE GOAL: fallback goal\n- Fallback bullet' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: '🎯 ACTIVE GOAL: fallback goal\n- Fallback bullet' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
    const ctx = makeCtx({ stream })
    const service = createBriefService(ctx as never, baseConfig)
    const session = sessionWithTurns(1)

    const result = await service.ensureFreshBrief(session as never)
    expect(result.ok).toBe(true)
    expect(result.model).toBe('antigravity/gemini-3.7-flash-tiered')
    const [type, payload] = session.append.mock.calls[0] as [string, { model: string }]
    expect(type).toBe('brief/prose-updated')
    expect(payload.model).toBe('antigravity/gemini-3.7-flash-tiered')
  })

  it('single-flights concurrent calls for the same window', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    let streamCalls = 0
    const stream = async function* () {
      streamCalls += 1
      await gate
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: '🎯 ACTIVE GOAL: test goal\n- Test goal bullet' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: '🎯 ACTIVE GOAL: test goal\n- Test goal bullet' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
    const ctx = makeCtx({ stream })
    const service = createBriefService(ctx as never, baseConfig)
    const session = sessionWithTurns(1)

    const p1 = service.ensureFreshBrief(session as never)
    const p2 = service.ensureFreshBrief(session as never)
    release()
    const [r1, r2] = await Promise.all([p1, p2])

    expect(streamCalls).toBe(1) // one distillation, two consumers
    expect(r1.reason).toBe('distilled')
    expect(r2.reason).toBe('distilled')
    expect(session.append).toHaveBeenCalledTimes(1)
  })

  it('lets the newer basedOnSeq pass win and abandons the older out-of-order result (Oracle defect 1)', async () => {
    let releaseFirst!: () => void
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve })
    let streamCalls = 0
    const stream = async function* () {
      streamCalls += 1
      if (streamCalls === 1) await firstGate // block the FIRST pass
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: '🎯 ACTIVE GOAL: test goal\n- Test goal bullet' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: '🎯 ACTIVE GOAL: test goal\n- Test goal bullet' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
    const ctx = makeCtx({ stream })
    const service = createBriefService(ctx as never, baseConfig)
    const session = sessionWithTurns(1)

    // Pass A starts (blocked on the gate).
    const pA = service.ensureFreshBrief(session as never)
    await new Promise(r => setTimeout(r, 0)) // flush microtasks so A registers

    // A far-future session (structural distance >> K) supersedes A's window.
    const grown = sessionWithTurns(14)
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 2 * 60_000)
    const pB = service.ensureFreshBrief(grown as never)
    vi.restoreAllMocks()

    // B (newer basedOnSeq) completes first. Release A afterwards: its older
    // result must not overwrite B or append a late prose event.
    const rB = await pB
    expect(rB.reason).toBe('distilled')
    releaseFirst()
    const rA = await pA
    expect(rA.reason).toBe('failed')
    expect(session.append).not.toHaveBeenCalled()
    expect(streamCalls).toBe(2) // exactly two distillations
    expect(grown.append).toHaveBeenCalledTimes(1)
  })

  it('cannot publish after forget during an in-flight pass', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const stream = async function* () {
      await gate
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: '🎯 ACTIVE GOAL: late\n- forgotten' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: '🎯 ACTIVE GOAL: late\n- forgotten' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
    const ctx = makeCtx({ stream })
    const service = createBriefService(ctx as never, baseConfig)
    const session = sessionWithTurns(1)
    const pending = service.ensureFreshBrief(session as never)
    await vi.waitFor(() => expect(ctx.llm.stream).toHaveBeenCalledTimes(1))
    service.forget(session.id)
    release()
    const result = await pending
    expect(result.reason).toBe('failed')
    expect(session.append).not.toHaveBeenCalled()
    expect(service.cacheSize).toBe(0)
  })

  it('cannot publish after service disposal during an in-flight pass', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const stream = async function* () {
      await gate
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: '🎯 ACTIVE GOAL: late\n- disposed' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: '🎯 ACTIVE GOAL: late\n- disposed' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
    const ctx = makeCtx({ stream })
    const service = createBriefService(ctx as never, baseConfig)
    const session = sessionWithTurns(1)
    const pending = service.ensureFreshBrief(session as never)
    await vi.waitFor(() => expect(ctx.llm.stream).toHaveBeenCalledTimes(1))
    service.dispose()
    release()
    const result = await pending
    expect(result.reason).toBe('failed')
    expect(session.append).not.toHaveBeenCalled()
    expect(service.cacheSize).toBe(0)
  })

  it('does not negative-cache an older failure after a newer pass succeeded', async () => {
    let releaseA!: () => void
    const gateA = new Promise<void>((resolve) => { releaseA = resolve })
    let calls = 0
    const stream = async function* () {
      calls += 1
      if (calls === 1) {
        await gateA
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'finish', reason: { kind: 'error', failure: { message: 'older failure', code: 'UPSTREAM' } } }
        return
      }
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: '🎯 ACTIVE GOAL: newer\n- newer bullet with enough text to pass the keeper brief floor' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: '🎯 ACTIVE GOAL: newer\n- newer bullet with enough text to pass the keeper brief floor' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
    const ctx = makeCtx({ stream })
    const service = createBriefService(ctx as never, baseConfig)
    const older = sessionWithTurns(1)
    const newer = sessionWithTurns(14)
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 2 * 60_000)
    const pA = service.ensureFreshBrief(older as never)
    await vi.waitFor(() => expect(calls).toBe(1))
    const pB = service.ensureFreshBrief(newer as never)
    const rB = await pB
    expect(rB.reason).toBe('distilled')
    releaseA()
    const rA = await pA
    vi.restoreAllMocks()
    expect(rA.reason).toBe('failed')
    expect(older.append).not.toHaveBeenCalled()
    const again = await service.ensureFreshBrief(newer as never)
    expect(again.reason).toBe('cache-hit')
    expect(again.prose).toContain('newer')
  })

  it('isolates a joiner from the originator\'s abort rejection (Oracle defect 2)', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const stream = async function* () {
      await gate
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
    const ctx = makeCtx({ stream })
    const service = createBriefService(ctx as never, baseConfig)
    const session = sessionWithTurns(1)

    const abortA = new AbortController()
    const pA = service.ensureFreshBrief(session as never, abortA.signal)
    await new Promise(r => setTimeout(r, 0)) // flush microtasks so A registers

    // B joins A's in-flight pass with a LIVE signal.
    const pB = service.ensureFreshBrief(session as never)

    // A's caller cancels — the distillation aborts and A's promise rejects.
    abortA.abort()
    release()
    await expect(pA).rejects.toThrow()

    // B must NOT inherit the abort — it gets a soft failure instead.
    const rB = await pB
    expect(rB.ok).toBe(false)
    expect(rB.reason).toBe('failed')
  })
})

describe('enpoi-context-keeper claims batched listener', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('files every model-extracted claim as tentative/untrusted with settlement proof', async () => {
    const claimsText = 'CLAIMS: ['
      + '{"fact":"operator-stated fact","category":"PROJECT","source":"operator","quote":"query 0","sourceSeq":0},'
      + '{"fact":"tool-observed fact","category":"CONFIG_VALUES","source":"tool"}'
      + ']'
    const claimsStream = async function* () {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: claimsText }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: claimsText } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
    const ctx = makeCtx({ stream: claimsStream })
    apply(ctx as never, baseConfig)

    const handlers = (ctx.on as unknown as ReturnType<typeof vi.fn>).mock.calls
    const handler = handlers.find((c: unknown[]) => c[0] === 'session/event')?.[1] as
      (session: unknown, event: { type: string; data: { reason: { kind: string } } }) => void
    expect(handler).toBeDefined()

    const session = sessionWithTurns(1)
    for (let i = 0; i < 8; i++) {
      handler(session, { type: 'turn/end', data: { reason: { kind: 'stop' } } })
    }
    await vi.waitFor(() => {
      const db = openMemoryDb()
      try {
        const rows = db.prepare('SELECT fact, state, source_trust, origin, provenance FROM claims ORDER BY fact').all() as Array<{
          fact: string; state: string; source_trust: string; origin: string; provenance: string
        }>
        expect(rows.length).toBe(2)
      } finally {
        db.close()
      }
    })

    const db = openMemoryDb()
    try {
      const rows = db.prepare('SELECT fact, state, source_trust, origin, provenance FROM claims ORDER BY fact').all() as Array<{
        fact: string; state: string; source_trust: string; origin: string; provenance: string
      }>
      expect(rows.map((row) => row.fact)).toEqual(['operator-stated fact', 'tool-observed fact'])
      for (const row of rows) {
        expect(row.state).toBe('tentative')
        expect(row.source_trust).toBe('untrusted_external')
        expect(row.origin).toBe('keeper')
        const proof = JSON.parse(row.provenance) as Record<string, unknown>
        expect(proof['source']).toBe('keeper')
        expect(proof['sessionId']).toBe('test-session')
        expect(proof['settled']).toBe(true)
        expect(Number.isInteger(proof['batchBasedOnSeq'])).toBe(true)
        expect(proof['batchBasedOnSeq'] as number).toBeGreaterThanOrEqual(0)
      }
    } finally {
      db.close()
    }
  })

  it('does not open or write the memory DB when claims dispose mid-pass', async () => {
    vi.useRealTimers()
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    let calls = 0
    const claimsStream = async function* () {
      calls += 1
      await gate
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'CLAIMS: [{"fact":"late","category":"PROJECT","source":"tool"}]' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'CLAIMS: [{"fact":"late","category":"PROJECT","source":"tool"}]' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
    const ctx = makeCtx({ stream: claimsStream })
    apply(ctx as never, { ...baseConfig, claimsBatchSize: 1, checkpointStaleEvents: 500 })
    const callsList = (ctx.on as unknown as ReturnType<typeof vi.fn>).mock.calls
    const handler = callsList.find((c: unknown[]) => c[0] === 'session/event')?.[1] as
      (session: unknown, event: { type: string; data: { reason: { kind: string } } }) => void
    const dispose = callsList.find((c: unknown[]) => c[0] === 'dispose')?.[1] as () => void
    const session = sessionWithTurns(1)
    handler(session, { type: 'turn/end', data: { reason: { kind: 'stop' } } })
    await vi.waitFor(() => expect(calls).toBe(1))
    dispose()
    release()
    await new Promise((resolve) => setTimeout(resolve, 25))
    expect(calls).toBe(1)
    const db = openMemoryDb()
    try {
      const row = db.prepare('SELECT COUNT(*) AS n FROM claims WHERE fact = ?').get('late') as { n: number }
      expect(row.n).toBe(0)
    } finally {
      db.close()
    }
  })

  it('skips aborted turns', async () => {
    const ctx = makeCtx()
    apply(ctx as never, baseConfig)
    const handler = (ctx.on as unknown as ReturnType<typeof vi.fn>).mock.calls.find(
      (c: unknown[]) => c[0] === 'session/event',
    )?.[1] as (session: unknown, event: { type: string; data: { reason: { kind: string } } }) => void

    const session = makeSession([])
    for (let i = 0; i < 8; i++) {
      handler(session, { type: 'turn/end', data: { reason: { kind: 'aborted' } } })
    }
    await vi.advanceTimersByTimeAsync(0)

    expect(ctx.llm.stream).not.toHaveBeenCalled()
  })
})