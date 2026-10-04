import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest'
import {
  keeperAttempts,
  keeperRouteQuarantineRemaining,
  keeperRouteRequestLevelFailure,
  resetKeeperRouteHealth,
  resolveKeeperRoute,
  splitClaims,
  summarize,
  type Config,
} from '../src/index.ts'

/**
 * Keeper chain-link specs (doc 60): the keeper's existing validator
 * (`validateKeeperOutput` inside summarize) stays the cut detector, and a
 * failure/cut advances to the chain's NEXT link from the run-start snapshot.
 * Dependency-light: the ctx seam is a two-method fake.
 */

const CHAIN = {
  id: 'stable',
  label: 'Stable',
  links: [
    { provider: 'p1', model: 'm1' },
    { provider: 'p2', model: 'm2', effort: 'high' },
  ],
  attempts: 2,
  onCut: 'failover' as const,
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

const GOOD_PROSE = '🎯 ACTIVE GOAL: test goal\n- Test goal bullet'

function goodStream() {
  return async function* () {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: GOOD_PROSE }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: GOOD_PROSE } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

function makeCtx(overrides: {
  personas?: Record<string, unknown>
  chain?: unknown
  stream?: (options: { provider: string; model: string }) => AsyncGenerator<unknown>
}) {
  const streamSpy = vi.fn(overrides.stream ?? goodStream())
  return {
    get: (ns: string) => {
      if (ns === 'settings') return { get: () => ({ personas: overrides.personas ?? {} }) }
      if (ns === 'modelChains') {
        return { resolve: (id: string) => (id === CHAIN.id ? overrides.chain ?? CHAIN : undefined) }
      }
      return undefined
    },
    llm: { stream: streamSpy },
    logger: { info: vi.fn(), warn: vi.fn() },
    streamSpy,
  }
}

function makeSession() {
  return { id: 'chain-session', seq: 3, append: vi.fn() }
}

afterEach(() => {
  vi.restoreAllMocks()
})

// Route health is process-local; each spec starts from a clean slate so the
// quarantine window of one test never leaks into another.
beforeEach(() => {
  resetKeeperRouteHealth()
})

describe('keeper chain route resolution', () => {
  it('resolves a chain assignment into a frozen link snapshot (link 1 active)', () => {
    const ctx = makeCtx({ personas: { keeper: { chain: 'stable' } } })
    const route = resolveKeeperRoute(ctx as never, baseConfig)
    expect(route.chainId).toBe('stable')
    expect(route.provider).toBe('p1')
    expect(route.model).toBe('m1')
    expect(route.chainLinks).toEqual([
      { provider: 'p1', model: 'm1' },
      { provider: 'p2', model: 'm2', effort: 'high' },
    ])
  })

  it('keeps persona provider/model as the active link and de-duplicates it', () => {
    const ctx = makeCtx({
      personas: { keeper: { chain: 'stable', provider: 'p1', model: 'm1', reasoningEffort: 'low' } },
    })
    const route = resolveKeeperRoute(ctx as never, baseConfig)
    expect(route.provider).toBe('p1')
    expect(route.reasoningEffort).toBe('low')
    expect(route.chainLinks).toEqual([
      { provider: 'p1', model: 'm1', effort: 'low' },
      { provider: 'p2', model: 'm2', effort: 'high' },
    ])
  })

  it('fails open to the config route for a dangling/disabled chain id', () => {
    const ctx = makeCtx({ personas: { keeper: { chain: 'ghost' } } })
    const route = resolveKeeperRoute(ctx as never, baseConfig)
    expect(route.chainId).toBeUndefined()
    expect(route.provider).toBe('freellmapi')
    expect(route.model).toBe('auto')
    expect(keeperAttempts(route)).toHaveLength(2)   // legacy primary → fallback
  })

  it('builds one attempt per chain link, else the legacy pair', () => {
    const chained = keeperAttempts({
      provider: 'p1', model: 'm1', fallbackProvider: 'f', fallbackModel: 'fm',
      chainId: 'stable', chainLinks: CHAIN.links,
    })
    expect(chained).toEqual([
      { provider: 'p1', model: 'm1' },
      { provider: 'p2', model: 'm2', reasoningEffort: 'high' },
    ])
    const legacy = keeperAttempts({ provider: 'a', model: 'b', fallbackProvider: 'c', fallbackModel: 'd' })
    expect(legacy).toEqual([
      { provider: 'a', model: 'b' },
      { provider: 'c', model: 'd' },
    ])
  })
})

describe('keeper chain link iteration (summarize)', () => {
  it('advances to link 2 when link 1 errors, keeping the validator as the shield', async () => {
    const calls: Array<{ provider: string; model: string }> = []
    const stream = async function* (options: { provider: string; model: string }) {
      calls.push({ provider: options.provider, model: options.model })
      if (options.provider === 'p1') {
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'finish', reason: { kind: 'error', failure: { message: 'upstream down', code: 'UPSTREAM' } } }
        return
      }
      yield* goodStream()()
    }
    const ctx = makeCtx({ stream })
    const written: string[] = []
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => { written.push(String(chunk)); return true })

    const result = await summarize(
      ctx as never,
      baseConfig,
      makeSession() as never,
      'recent events',
      new AbortController().signal,
      {
        provider: 'p1', model: 'm1', fallbackProvider: 'f', fallbackModel: 'fm',
        chainId: 'stable', chainLinks: CHAIN.links,
      },
      'system',
      false,
    )

    expect(calls).toEqual([{ provider: 'p1', model: 'm1' }, { provider: 'p2', model: 'm2' }])
    expect(result.route).toBe('p2/m2')
    expect(result.text).toContain('test goal')
    expect(written.some(line => line.includes('[model-chain] stable: link 1 (p1/m1)'))).toBe(true)
  })

  it('retries a cut link at the escalated cap, then advances when it cuts again', async () => {
    const calls: Array<{ provider: string; model: string; maxTokens?: number }> = []
    const stream = async function* (options: { provider: string; model: string; maxTokens?: number }) {
      calls.push({ provider: options.provider, model: options.model, maxTokens: options.maxTokens })
      if (options.provider === 'p1') {
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text: 'truncated mid-thought' }
        yield { type: 'finish', reason: { kind: 'max-tokens' } }
        return
      }
      yield* goodStream()()
    }
    const ctx = makeCtx({ stream })
    const result = await summarize(
      ctx as never,
      baseConfig,
      makeSession() as never,
      'recent events',
      new AbortController().signal,
      {
        provider: 'p1', model: 'm1', fallbackProvider: 'f', fallbackModel: 'fm',
        chainId: 'stable', chainLinks: CHAIN.links,
      },
      'system',
      false,
    )
    expect(calls).toEqual([
      { provider: 'p1', model: 'm1', maxTokens: 2048 },
      { provider: 'p1', model: 'm1', maxTokens: 4096 },
      { provider: 'p2', model: 'm2', maxTokens: 2048 },
    ])
    expect(result.route).toBe('p2/m2')
  })

  it('recovers a long-brief summary on the same link when the escalated cap completes it', async () => {
    const longBrief = `--- PREVIOUS SESSION BRIEF ---\n${'🎯 ACTIVE GOAL: long brief line\n'.repeat(200)}`
    const caps: number[] = []
    const stream = async function* (options: { provider: string; model: string; maxTokens?: number }) {
      caps.push(options.maxTokens ?? 0)
      yield { type: 'block-start', index: 0, blockType: 'text' }
      if ((options.maxTokens ?? 0) <= 2048) {
        yield { type: 'text-delta', index: 0, text: '🎯 ACTIVE GOAL: truncated mid-brief' }
        yield { type: 'finish', reason: { kind: 'max-tokens' } }
        return
      }
      yield { type: 'text-delta', index: 0, text: GOOD_PROSE }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: GOOD_PROSE } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
    const ctx = makeCtx({ stream })
    const result = await summarize(
      ctx as never,
      baseConfig,
      makeSession() as never,
      longBrief,
      new AbortController().signal,
      {
        provider: 'p1', model: 'm1', fallbackProvider: 'f', fallbackModel: 'fm',
        chainId: 'stable', chainLinks: CHAIN.links,
      },
      'system',
      false,
    )
    expect(caps).toEqual([2048, 4096])
    expect(result.route).toBe('p1/m1')
    expect(result.text).toContain('test goal')
  })

  it('keeps the primary → fallback behaviour when no chain is assigned', async () => {
    const calls: string[] = []
    const stream = async function* (options: { provider: string; model: string }) {
      calls.push(`${options.provider}/${options.model}`)
      if (calls.length === 1) {
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'finish', reason: { kind: 'error', failure: { message: 'down', code: 'X' } } }
        return
      }
      yield* goodStream()()
    }
    const ctx = makeCtx({ stream })
    const result = await summarize(
      ctx as never,
      baseConfig,
      makeSession() as never,
      'recent events',
      new AbortController().signal,
      { provider: 'freellmapi', model: 'auto', fallbackProvider: 'antigravity', fallbackModel: 'gemini-3.7-flash-tiered' },
      'system',
      false,
    )
    expect(calls).toEqual(['freellmapi/auto', 'antigravity/gemini-3.7-flash-tiered'])
    expect(result.route).toBe('antigravity/gemini-3.7-flash-tiered')
  })

  it('throws after every chain link is exhausted', async () => {
    const stream = async function* () {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'finish', reason: { kind: 'error', failure: { message: 'down', code: 'X' } } }
    }
    const ctx = makeCtx({ stream })
    await expect(summarize(
      ctx as never,
      baseConfig,
      makeSession() as never,
      'recent events',
      new AbortController().signal,
      {
        provider: 'p1', model: 'm1', fallbackProvider: 'f', fallbackModel: 'fm',
        chainId: 'stable', chainLinks: CHAIN.links,
      },
      'system',
      false,
    )).rejects.toThrow(/all summary routes failed \(2 attempt\(s\)\)/)
  })
})

describe('keeper route health (empty landings + quarantine)', () => {
  const route = {
    provider: 'p1', model: 'm1', fallbackProvider: 'f', fallbackModel: 'fm',
    chainId: 'stable', chainLinks: CHAIN.links,
  }

  it('fails over when a link lands empty output (clean stop, no text)', async () => {
    const calls: string[] = []
    const stream = async function* (options: { provider: string; model: string }) {
      calls.push(`${options.provider}/${options.model}`)
      if (options.provider === 'p1') {
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'finish', reason: { kind: 'stop' } }
        return
      }
      yield* goodStream()()
    }
    const ctx = makeCtx({ stream })
    const result = await summarize(
      ctx as never, baseConfig, makeSession() as never, 'recent events',
      new AbortController().signal, route, 'system', false,
    )
    expect(calls).toEqual(['p1/m1', 'p2/m2'])
    expect(result.route).toBe('p2/m2')
  })

  it('fails over when a link lands only negative-filler sections (cleans to empty)', async () => {
    const filler = '🎯 ACTIVE GOAL: none\n- No blockers remain\n- No open questions'
    const calls: string[] = []
    const stream = async function* (options: { provider: string; model: string }) {
      calls.push(`${options.provider}/${options.model}`)
      if (options.provider === 'p1') {
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text: filler }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: filler } }
        yield { type: 'finish', reason: { kind: 'stop' } }
        return
      }
      yield* goodStream()()
    }
    const ctx = makeCtx({ stream })
    const result = await summarize(
      ctx as never, baseConfig, makeSession() as never, 'recent events',
      new AbortController().signal, route, 'system', false,
    )
    expect(calls).toEqual(['p1/m1', 'p2/m2'])
    expect(result.route).toBe('p2/m2')
  })

  it('quarantines a route after N consecutive failures and skips it on the next run', async () => {
    const calls: string[] = []
    const stream = async function* (options: { provider: string; model: string }) {
      calls.push(`${options.provider}/${options.model}`)
      if (options.provider === 'p1') {
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'finish', reason: { kind: 'stop' } }
        return
      }
      yield* goodStream()()
    }
    const ctx = makeCtx({ stream })
    const written: string[] = []
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => { written.push(String(chunk)); return true })

    for (let run = 0; run < 3; run += 1) {
      const result = await summarize(
        ctx as never, baseConfig, makeSession() as never, 'recent events',
        new AbortController().signal, route, 'system', false,
      )
      expect(result.route).toBe('p2/m2')
    }
    expect(calls).toEqual(['p1/m1', 'p2/m2', 'p1/m1', 'p2/m2', 'p2/m2'])
    expect(keeperRouteQuarantineRemaining('p1', 'm1')).toBeGreaterThan(0)
    expect(written.some(line => line.includes('quarantined until'))).toBe(true)
    expect(written.some(line => line.includes('skipping quarantined link(s): p1/m1'))).toBe(true)
  })

  it('classifies request-shaped failures by code and by context-overflow wording', () => {
    expect(keeperRouteRequestLevelFailure({ code: 'CONTEXT_WINDOW_EXCEEDED', message: 'too big' })).toBe(true)
    expect(keeperRouteRequestLevelFailure({ code: 'HTTP_400', message: "This model's maximum context length is 32768 tokens" })).toBe(true)
    expect(keeperRouteRequestLevelFailure(new Error('prompt is too long for this model'))).toBe(true)
    // OpenCode's free-tier client gate is server-side policy (anomalyco/opencode#49621):
    // recognized by code from the llm seam or by the body an older adapter passed through.
    expect(keeperRouteRequestLevelFailure({ code: 'FREE_TIER_GATED', message: 'gated' })).toBe(true)
    expect(keeperRouteRequestLevelFailure(new Error(
      '403 {"type":"FreeTierError","message":"OpenCode\'s free tier can only be used from within OpenCode"}',
    ))).toBe(true)
    expect(keeperRouteRequestLevelFailure({ code: 'SERVER', message: 'provider outage' })).toBe(false)
    expect(keeperRouteRequestLevelFailure(new Error('Output invalid/truncated on p1/m1'))).toBe(false)
  })

  it('never quarantines a link whose 400 is a context-overflow rejection', async () => {
    const calls: string[] = []
    const overflow = "This model's maximum context length is 32768 tokens, however you requested 41000 tokens."
    const stream = async function* (options: { provider: string; model: string }) {
      calls.push(`${options.provider}/${options.model}`)
      yield {
        type: 'finish',
        reason: {
          kind: 'error',
          failure: { message: overflow, code: 'CONTEXT_WINDOW_EXCEEDED' },
        },
      }
    }
    const ctx = makeCtx({ stream })
    const written: string[] = []
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => { written.push(String(chunk)); return true })

    for (let run = 0; run < 3; run += 1) {
      await expect(summarize(
        ctx as never, baseConfig, makeSession() as never, 'recent events',
        new AbortController().signal, route, 'system', false,
      )).rejects.toThrow(/maximum context length/)
    }

    // The payload, not the link, overflowed: both links stay healthy and the
    // gateway's own explanation reaches the caller instead of a rotation story.
    expect(calls).toEqual(['p1/m1', 'p2/m2', 'p1/m1', 'p2/m2', 'p1/m1', 'p2/m2'])
    expect(keeperRouteQuarantineRemaining('p1', 'm1')).toBe(0)
    expect(keeperRouteQuarantineRemaining('p2', 'm2')).toBe(0)
    expect(written.some(line => line.includes('no route strike'))).toBe(true)
    expect(written.some(line => line.includes('quarantined until'))).toBe(false)
  })

  it('keeps a normal landing on link 1 unchanged (no failover, no health)', async () => {
    const ctx = makeCtx({})
    const result = await summarize(
      ctx as never, baseConfig, makeSession() as never, 'recent events',
      new AbortController().signal, route, 'system', false,
    )
    expect(ctx.streamSpy).toHaveBeenCalledTimes(1)
    expect(result.route).toBe('p1/m1')
    expect(keeperRouteQuarantineRemaining('p1', 'm1')).toBe(0)
  })
})

describe('keeper claims JSON extraction', () => {
  const route = {
    provider: 'p1', model: 'm1', fallbackProvider: 'f', fallbackModel: 'fm',
    chainId: 'stable', chainLinks: CHAIN.links,
  }

  it('accepts claims whose text contains brackets (no false route failure)', async () => {
    const text = 'CLAIMS: [{"fact":"fixed the [bug] in foo.ts","category":"PROJECT","source":"tool"}]'
    const stream = async function* () {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text }
      yield { type: 'block-end', index: 0, block: { type: 'text', text } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
    const ctx = makeCtx({ stream })
    const result = await summarize(
      ctx as never, baseConfig, makeSession() as never, 'recent events',
      new AbortController().signal, route, 'system', true,
    )
    expect(ctx.streamSpy).toHaveBeenCalledTimes(1)
    expect(result.route).toBe('p1/m1')
    expect(splitClaims(result.text)).toHaveLength(1)
  })

  it('retries a truncated claims block at the escalated cap (cut-shaped)', async () => {
    const caps: number[] = []
    const stream = async function* (options: { provider: string; model: string; maxTokens?: number }) {
      caps.push(options.maxTokens ?? 0)
      yield { type: 'block-start', index: 0, blockType: 'text' }
      if ((options.maxTokens ?? 0) <= 2048) {
        yield { type: 'text-delta', index: 0, text: 'CLAIMS: [{"fact":"cut' }
        yield { type: 'finish', reason: { kind: 'stop' } }
        return
      }
      const text = 'CLAIMS: [{"fact":"done","category":"PROJECT","source":"tool"}]'
      yield { type: 'text-delta', index: 0, text }
      yield { type: 'block-end', index: 0, block: { type: 'text', text } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
    const ctx = makeCtx({ stream })
    const result = await summarize(
      ctx as never, baseConfig, makeSession() as never, 'recent events',
      new AbortController().signal, route, 'system', true,
    )
    expect(caps).toEqual([2048, 4096])
    expect(result.route).toBe('p1/m1')
  })
})
