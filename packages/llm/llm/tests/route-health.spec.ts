import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, {
  createUserMessage,
  DEFAULT_ROUTE_HEALTH_POLICY,
  EMPTY_RESPONSE_CODE,
  LlmAdapter,
  resolveRouteHealthPolicy,
  RouteHealthLedger,
  type GenerateOptions,
  type ResolvedModelChain,
  type RouteHealthPolicy,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'

/** A completed `stop` carrying one empty text block: answers nothing. */
const EMPTY_SCRIPT: StreamChunk[] = [
  { type: 'block-start', index: 0, blockType: 'text' },
  { type: 'block-end', index: 0, block: { type: 'text', text: '' } },
  { type: 'finish', reason: { kind: 'stop' } },
]

/** A completed `stop` carrying a real answer. */
const ANSWER_SCRIPT: StreamChunk[] = [
  { type: 'block-start', index: 0, blockType: 'text' },
  { type: 'text-delta', index: 0, text: 'answered' },
  { type: 'block-end', index: 0, block: { type: 'text', text: 'answered' } },
  { type: 'finish', reason: { kind: 'stop' } },
]

/** One adapter that plays a swappable script and records every call. */
class ScriptedAdapter extends LlmAdapter {
  readonly calls: GenerateOptions[] = []
  private script: StreamChunk[]

  constructor(script: StreamChunk[]) {
    super()
    this.script = script
  }

  /** Replace what every later call plays (a route recovering or breaking). */
  setScript(script: StreamChunk[]): void {
    this.script = script
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.calls.push(options)
    yield* this.script
  }
}

/** A fast policy so tests state their own windows. */
const POLICY: RouteHealthPolicy = {
  emptyResponseCooldownMs: 600_000,
  authCooldownMs: 21_600_000,
  rateLimitCooldownMs: 60_000,
  serverCooldownMs: 180_000,
}

function ledger(now: () => number = Date.now): RouteHealthLedger {
  return new RouteHealthLedger(POLICY, now)
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('RouteHealthLedger', () => {
  it('counts consecutive failures of one class and demotes the route', () => {
    let now = 1_000
    const health = ledger(() => now)
    expect(health.recordFailure('p', 'm', EMPTY_RESPONSE_CODE)).toBe(true)
    now += 1_000
    expect(health.recordFailure('p', 'm', EMPTY_RESPONSE_CODE)).toBe(true)
    const [entry] = health.snapshot()
    expect(entry).toMatchObject({ provider: 'p', model: 'm', class: 'empty', failures: 2, code: EMPTY_RESPONSE_CODE })
    expect(health.isCooling({ provider: 'p', model: 'm' })).toBe(true)
    const order = health.order([{ provider: 'p', model: 'm' }, { provider: 'q', model: 'n' }], link => link)
    expect(order.map(link => link.provider)).toEqual(['q', 'p'])
  })

  it('restarts the run when the failure class changes', () => {
    const health = ledger(() => 0)
    health.recordFailure('p', 'm', EMPTY_RESPONSE_CODE)
    health.recordFailure('p', 'm', 'SERVER')
    expect(health.snapshot()[0]).toMatchObject({ class: 'server', failures: 1 })
  })

  it('clears the run and the cooldown on success', () => {
    const health = ledger(() => 0)
    health.recordFailure('p', 'm', EMPTY_RESPONSE_CODE)
    expect(health.recordSuccess('p', 'm')).toBe(true)
    expect(health.snapshot()).toEqual([])
    expect(health.isCooling({ provider: 'p', model: 'm' })).toBe(false)
    expect(health.recordSuccess('p', 'm')).toBe(false)
  })

  it('keeps a fully cooling order as declared and attempts it anyway', () => {
    const health = ledger(() => 0)
    health.recordFailure('a', 'm', EMPTY_RESPONSE_CODE)
    health.recordFailure('b', 'm', 'TIMEOUT')
    const links = [{ provider: 'a', model: 'm' }, { provider: 'b', model: 'm' }]
    expect(health.order(links, link => link)).toBe(links)
  })

  it('honors the provider reset hint for a rate limit and falls back to its default', () => {
    const health = ledger(() => 0)
    health.recordFailure('p', 'm', 'RATE_LIMIT', 5_000)
    expect(health.snapshot()[0]!.coolingUntil).toBe(5_000)
    health.recordFailure('q', 'm', 'RATE_LIMIT', 0)
    expect(health.snapshot().find(entry => entry.provider === 'q')!.coolingUntil)
      .toBe(POLICY.rateLimitCooldownMs)
  })

  it('ignores failure codes that carry no cooldown', () => {
    const health = ledger(() => 0)
    expect(health.recordFailure('p', 'm', 'BAD_REQUEST')).toBe(false)
    expect(health.snapshot()).toEqual([])
  })

  it('cools a provider gate like auth instead of retrying it every step', () => {
    const health = ledger(() => 0)
    expect(health.recordFailure('p', 'm', 'FREE_TIER_GATED')).toBe(true)
    expect(health.snapshot()[0]!.class).toBe('auth')
    expect(health.snapshot()[0]!.coolingUntil).toBe(POLICY.authCooldownMs)
    expect(health.recordFailure('q', 'm', 'ENTITLEMENT_GATED')).toBe(true)
    expect(health.snapshot().find(entry => entry.provider === 'q')!.coolingUntil)
      .toBe(POLICY.authCooldownMs)
  })

  it('drops an expired cooldown and restores the declared order', () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const health = ledger()
    health.recordFailure('p', 'm', EMPTY_RESPONSE_CODE)
    const links = [{ provider: 'p', model: 'm' }, { provider: 'q', model: 'n' }]
    expect(health.order(links, link => link).map(link => link.provider)).toEqual(['q', 'p'])
    vi.setSystemTime(POLICY.emptyResponseCooldownMs)
    expect(health.snapshot()).toEqual([])
    expect(health.order(links, link => link)).toBe(links)
    // The expired run does not count toward the next one.
    health.recordFailure('p', 'm', EMPTY_RESPONSE_CODE)
    expect(health.snapshot()[0]!.failures).toBe(1)
  })

  it('resolves a partial policy over the shipped defaults', () => {
    expect(resolveRouteHealthPolicy({})).toEqual(DEFAULT_ROUTE_HEALTH_POLICY)
    expect(resolveRouteHealthPolicy({ authCooldownMs: 0, serverCooldownMs: -1 }).authCooldownMs).toBe(0)
    expect(resolveRouteHealthPolicy({ serverCooldownMs: -1 }).serverCooldownMs)
      .toBe(DEFAULT_ROUTE_HEALTH_POLICY.serverCooldownMs)
  })
})

describe('route health in the model-group runtime', () => {
  /** A runtime with one mutable group over two routes; every route has its own adapter. */
  async function mount(scripts: { a: StreamChunk[]; b: StreamChunk[] }): Promise<{
    ctx: Context
    a: ScriptedAdapter
    b: ScriptedAdapter
    setLinks: (links: Array<[string, string]>) => void
    request: () => GenerateOptions
    writes: string[]
  }> {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    const a = new ScriptedAdapter(scripts.a)
    const b = new ScriptedAdapter(scripts.b)
    ctx.llm.registerAdapter(['chain-a'], a)
    ctx.llm.registerAdapter(['chain-b'], b)
    let links: Array<[string, string]> = [['chain-a', 'm-a'], ['chain-b', 'm-b']]
    ctx.provide('modelChains', {
      resolve: (id: string): ResolvedModelChain | undefined => id === 'stable'
        ? { id, links: links.map(([provider, model]) => ({ provider, model })) }
        : undefined,
    })
    // A settings service that records every call: the ledger must never need it.
    const writes: string[] = []
    ctx.provide('settings', {
      mutate: (...args: unknown[]) => { writes.push(`mutate ${String(args[0])}`); return Promise.resolve() },
      publishArtifact: (key: string) => { writes.push(`publish ${key}`); return 0 },
    })
    return {
      ctx,
      a,
      b,
      writes,
      setLinks: (next) => { links = next },
      request: (): GenerateOptions => ({
        provider: 'chain-a',
        model: 'm-a',
        chain: 'stable',
        messages: [createUserMessage({ content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } })],
      }),
    }
  }

  async function drain(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
    const chunks: StreamChunk[] = []
    for await (const chunk of stream) chunks.push(chunk)
    return chunks
  }

  it('demotes a link after two consecutive empty answers below a healthy member', async () => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const mounted = await mount({ a: EMPTY_SCRIPT, b: ANSWER_SCRIPT })
    // A single-member group keeps attempting its only member, so the primary
    // collects two consecutive empty answers.
    mounted.setLinks([['chain-a', 'm-a']])
    await drain(mounted.ctx.llm.stream(mounted.request()))
    await drain(mounted.ctx.llm.stream(mounted.request()))
    expect(mounted.a.calls).toHaveLength(2)
    expect(mounted.ctx.llm.routeHealth()).toMatchObject([{
      provider: 'chain-a', model: 'm-a', class: 'empty', failures: 2,
    }])

    // With a healthy member present, the cooling primary no longer runs first.
    mounted.setLinks([['chain-a', 'm-a'], ['chain-b', 'm-b']])
    const chunks = await drain(mounted.ctx.llm.stream(mounted.request()))
    expect(mounted.a.calls).toHaveLength(2)
    expect(mounted.b.calls).toHaveLength(1)
    expect(chunks.at(-1)).toEqual({
      type: 'finish',
      reason: { kind: 'stop' },
      answeringLink: { provider: 'chain-b', model: 'm-b' },
    })
    expect(mounted.writes).toEqual([])
  })

  it('clears the route on a successful answer', async () => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const mounted = await mount({ a: EMPTY_SCRIPT, b: ANSWER_SCRIPT })
    await drain(mounted.ctx.llm.stream(mounted.request()))
    expect(mounted.ctx.llm.routeHealth()).toHaveLength(1)

    // The primary recovers: a request whose every member is cooling still
    // attempts it, and the answer clears the cooldown.
    mounted.setLinks([['chain-a', 'm-a']])
    mounted.a.setScript(ANSWER_SCRIPT)
    await drain(mounted.ctx.llm.stream(mounted.request()))
    expect(mounted.a.calls).toHaveLength(2)
    expect(mounted.ctx.llm.routeHealth()).toEqual([])
  })

  it('tries every member in declared order while all are cooling', async () => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const mounted = await mount({ a: EMPTY_SCRIPT, b: EMPTY_SCRIPT })
    await drain(mounted.ctx.llm.stream(mounted.request()))
    // The first request cooled both members, so the next is fully cooling; it
    // still attempts them in the group's declared order.
    expect(mounted.ctx.llm.routeHealth().map(entry => entry.provider)).toEqual(['chain-a', 'chain-b'])
    await drain(mounted.ctx.llm.stream(mounted.request()))
    expect(mounted.a.calls).toHaveLength(2)
    expect(mounted.b.calls).toHaveLength(2)
  })

  it('restores the declared order once a cooldown expires', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const mounted = await mount({ a: EMPTY_SCRIPT, b: ANSWER_SCRIPT })

    await drain(mounted.ctx.llm.stream(mounted.request()))
    expect(mounted.ctx.llm.routeHealth()).toHaveLength(1)
    // Cooling primary demoted: the next request goes straight to the fallback.
    await drain(mounted.ctx.llm.stream(mounted.request()))
    expect(mounted.a.calls).toHaveLength(1)
    expect(mounted.b.calls).toHaveLength(2)

    // A restart-equivalent clock move expires the cooldown; the primary leads again.
    vi.setSystemTime(DEFAULT_ROUTE_HEALTH_POLICY.emptyResponseCooldownMs + 1)
    expect(mounted.ctx.llm.routeHealth()).toEqual([])
    await drain(mounted.ctx.llm.stream(mounted.request()))
    expect(mounted.a.calls).toHaveLength(2)
    expect(mounted.b.calls).toHaveLength(3)
  })

  it('announces a health change to status observers', async () => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const mounted = await mount({ a: EMPTY_SCRIPT, b: ANSWER_SCRIPT })
    const events: string[] = []
    mounted.ctx.on('llm/route-health-updated', () => { events.push('llm/route-health-updated') })
    await drain(mounted.ctx.llm.stream(mounted.request()))
    expect(events).toEqual(['llm/route-health-updated'])
  })
})
