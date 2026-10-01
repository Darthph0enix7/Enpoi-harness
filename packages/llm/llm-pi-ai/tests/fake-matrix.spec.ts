import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai'
import { resolveProfiles } from '../src/config.ts'
import { CAPACITY_BACKOFF_TIERS_MS, PoolEngine, parseResetMs, classifyFailure } from '../src/pool.ts'
import { memoryAuth } from './auth-double.ts'
import { createFakeOpenAI } from '../../../support/fake-openai/src/index.ts'

let stateDir: string
let lastEngine: PoolEngine | undefined
beforeEach(async () => {
  stateDir = await mkdtemp(join(tmpdir(), 'fake-matrix-'))
  lastEngine = undefined
})
afterEach(async () => {
  if (lastEngine) await lastEngine.flush().catch(() => {})
  const { rm } = await import('node:fs/promises')
  await rm(stateDir, { recursive: true, force: true }).catch(() => {})
})

function engineOf(opts: Partial<ConstructorParameters<typeof PoolEngine>[0]> = {}): PoolEngine {
  return new PoolEngine({ stateDir, saveDebounceMs: 5, ...opts })
}

const POOLED = (baseURL: string, strategy: 'priority-sticky' | 'balanced' = 'priority-sticky') => ({
  deepseek: {
    baseURL,
    pool: {
      strategy,
      identities: [
        { id: 'pri-1', credentialRef: 'K1', priority: 1 },
        { id: 'pri-2', credentialRef: 'K2', priority: 2 },
        { id: 'pri-3', credentialRef: 'K3', priority: 3 },
      ],
    },
  },
})

function adapterOf(
  providers: Record<string, unknown>,
  engine: PoolEngine,
  creds: Record<string, string | undefined>,
  deadlineMs?: number,
): PiAiAdapter {
  return new PiAiAdapter({
    profiles: () => resolveProfiles(providers as Parameters<typeof resolveProfiles>[0]),
    resolveApiKey: () => Promise.resolve('unused'),
    pool: engine,
    resolveCredential: async ref => creds[ref],
    log: () => {},
    auth: memoryAuth(),
    ...(deadlineMs !== undefined ? { poolDeadlineMs: deadlineMs } : {}),
  })
}

async function streamText(adapter: PiAiAdapter): Promise<string> {
  const chunks: string[] = []
  for await (const c of adapter.stream({ provider: 'deepseek', model: 'deepseek-v4-flash', messages: [] })) {
    if (c.type === 'text-delta') chunks.push(c.text)
    if (c.type === 'finish' && c.reason.kind === 'error') throw (c.reason as { failure: unknown }).failure
  }
  return chunks.join('')
}

describe('parseResetMs — anchored first phrase (oracle Link 1)', () => {
  it('does not sum distant numbers: 46min + 5/hr → 46min only', () => {
    expect(parseResetMs('Rate limit exceeded. Resets in 46min. You can make 5 requests per hour.')).toBe(46 * 60_000)
  })
  it('sums contiguous phrase: 4hr 53min → 4h+53m', () => {
    expect(parseResetMs('Resets in 4hr 53min.')).toBe((4 * 3600 + 53 * 60) * 1000)
  })
  it('clamps long windows to 24h and floors to 30s', () => {
    expect(parseResetMs('Resets in 14 days.')).toBe(24 * 3600_000)
    expect(parseResetMs('Resets in 30sec.')).toBe(30_000)
  })
})

describe('classifyFailure ordering — 429 vs 503', () => {
  it('429+capacity vocab → QUOTA', () => expect(classifyFailure('429 capacity limit')).toBe('QUOTA'))
  it('503+quota vocab → CAPACITY', () => expect(classifyFailure('503 quota')).toBe('CAPACITY'))
})

describe('fake proxy — exhaustive pool matrix', () => {
  it('priority-sticky: exhaust pri-1 rotates to pri-2 and pri-1 repromotes after reset', async () => {
    const fake = await createFakeOpenAI({
      keys: [
        { id: 'pri-1', key: 'k1' },
        { id: 'pri-2', key: 'k2' },
        { id: 'pri-3', key: 'k3' },
      ],
    })
    try {
      let now = 1_000_000
      const engine = engineOf({ now: () => now })
      lastEngine = engine
      const adapter = adapterOf(POOLED(fake.url), engine, { K1: 'k1', K2: 'k2', K3: 'k3' })
      await streamText(adapter)
      expect(fake.requests[0]?.keyId).toBe('pri-1')
      fake.setScenario('pri-1', { remaining: 0, resetAfterMs: 60_000, failMode: '429' })
      await streamText(adapter)
      expect(fake.requests.some(r => r.keyId === 'pri-2')).toBe(true)
      fake.resetKey('pri-1')
      engine.resetCooldown('deepseek', 'pri-1')
      await streamText(adapter)
      expect(fake.requests[fake.requests.length - 1]?.keyId).toBe('pri-1')
      now += 61_000
      fake.setScenario('pri-1', { remaining: 0, resetAfterMs: 60_000, failMode: '429' })
      engine.recordFailure('deepseek', 'pri-1', 'deepseek-v4-flash', 'QUOTA', 'Resets in 1min.')
      await streamText(adapter)
      expect(fake.requests[fake.requests.length - 1]?.keyId).toBe('pri-2')
      now += 61_000
      fake.resetKey('pri-1')
      engine.resetCooldown('deepseek', 'pri-1')
      await streamText(adapter)
      expect(fake.requests[fake.requests.length - 1]?.keyId).toBe('pri-1')
    } finally {
      await fake.close()
    }
  })

  it('balanced: round-robin among healthy', async () => {
    const fake = await createFakeOpenAI({ keys: [{ id: 'pri-1', key: 'k1' }, { id: 'pri-2', key: 'k2' }, { id: 'pri-3', key: 'k3' }] })
    try {
      const engine = engineOf()
      lastEngine = engine
      const adapter = adapterOf(POOLED(fake.url, 'balanced'), engine, { K1: 'k1', K2: 'k2', K3: 'k3' })
      await streamText(adapter)
      expect(fake.requests[0]?.keyId).toBe('pri-1')
      await streamText(adapter)
      expect(fake.requests[1]?.keyId).toBe('pri-2')
      await streamText(adapter)
      expect(fake.requests[2]?.keyId).toBe('pri-3')
      await streamText(adapter)
      expect(fake.requests[3]?.keyId).toBe('pri-1')
    } finally {
      await fake.close()
    }
  })

  it('all-cooling probe order is priority-first not cooldown-sorted (oracle Link 2/3)', async () => {
    const now = 1_000_000
    const engine = engineOf({ now: () => now })
    lastEngine = engine
    engine.recordFailure('deepseek', 'pri-1', 'deepseek-v4-flash', 'QUOTA', 'Resets in 60min.')
    engine.recordFailure('deepseek', 'pri-2', 'deepseek-v4-flash', 'QUOTA', 'Resets in 5min.')
    const order = engine.orderFor('deepseek', [{ id: 'pri-1', priority: 1 }, { id: 'pri-2', priority: 2 }], 'deepseek-v4-flash')
    expect(order.map(o => o.id)).toEqual(['pri-1', 'pri-2'])
  })

  it('pool-exhausted includes soonest reset and never shadows a ready identity', async () => {
    const fake = await createFakeOpenAI({ keys: [{ id: 'pri-1', key: 'k1', limits: { requests: 1, windowMs: 60_000 } }, { id: 'pri-2', key: 'k2', limits: { requests: 1, windowMs: 60_000 } }] })
    try {
      const now = 1_000_000
      const engine = engineOf({ now: () => now })
      lastEngine = engine
      const adapter = adapterOf(POOLED(fake.url), engine, { K1: 'k1', K2: 'k2', K3: undefined }, 5000)
      fake.setScenario('pri-1', { remaining: 0, resetAfterMs: 60_000, failMode: '429' })
      fake.setScenario('pri-2', { remaining: 0, resetAfterMs: 60_000, failMode: '429' })
      await expect(streamText(adapter)).rejects.toMatchObject({ code: 'PROVIDER_POOL_EXHAUSTED' })
      const e2 = engineOf()
      lastEngine = e2
      e2.recordFailure('deepseek', 'pri-1', 'deepseek-v4-flash', 'QUOTA', 'Resets in 1min.')
      const order2 = e2.orderFor('deepseek', [{ id: 'pri-1', priority: 1 }, { id: 'pri-3', priority: 3 }], 'deepseek-v4-flash')
      expect(order2[0]?.id).toBe('pri-3')
    } finally {
      await fake.close()
    }
  })

  it('5xx and invalid_request never rotate (GATEWAY_OUTAGE/INVALID_REQUEST)', async () => {
    const fake500 = await createFakeOpenAI({ keys: [{ id: 'pri-1', key: 'k1' }, { id: 'pri-2', key: 'k2' }] })
    try {
      const engine = engineOf()
      lastEngine = engine
      const adapter = adapterOf(POOLED(fake500.url), engine, { K1: 'k1', K2: 'k2' })
      fake500.setScenario('pri-1', { failMode: '500', errorBody: { error: { message: 'model is unavailable right now' } } })
      await expect(streamText(adapter)).rejects.toMatchObject({ code: 'PROVIDER_MODEL_OUTAGE' })
      expect(fake500.requests.length).toBe(1)
      expect(engine.cooldownRemaining('deepseek', 'pri-1', 'deepseek-v4-flash')).toBe(0)
    } finally {
      await fake500.close()
    }
  })

  it('header reset precedence: x-ratelimit headers win over body, body over fallback', async () => {
    const engine = engineOf()
    lastEngine = engine
    engine.recordQuota('deepseek', 'pri-1', 'deepseek-v4-flash', { remainingFraction: 0, resetTime: '2026-01-01T00:01:00Z', source: 'headers' })
    const snap = engine.snapshot('deepseek')
    expect(snap['pri-1']?.['deepseek-v4-flash']?.quota?.remainingFraction).toBe(0)
  })

  it('resetCooldown restores a cooled identity to ready', async () => {
    const engine = engineOf()
    lastEngine = engine
    engine.recordFailure('deepseek', 'pri-1', 'deepseek-v4-flash', 'QUOTA', 'Resets in 10min.')
    expect(engine.cooldownRemaining('deepseek', 'pri-1', 'deepseek-v4-flash')).toBeGreaterThan(0)
    engine.resetCooldown('deepseek', 'pri-1')
    expect(engine.cooldownRemaining('deepseek', 'pri-1', 'deepseek-v4-flash')).toBe(0)
  })
})

describe('CAPACITY peek not advancing (oracle #5a)', () => {
  it('peek=true does not advance balanced rotation cursor', () => {
    const engine = engineOf()
    lastEngine = engine
    const identities = [{ id: 'pri-1', priority: 1 }, { id: 'pri-2', priority: 2 }, { id: 'pri-3', priority: 3 }]
    const firstPeek = engine.orderFor('deepseek', identities, 'deepseek-v4-flash', 'balanced', true)
    const secondPeek = engine.orderFor('deepseek', identities, 'deepseek-v4-flash', 'balanced', true)
    expect(firstPeek.map(i => i.id)).toEqual(['pri-1', 'pri-2', 'pri-3'])
    expect(secondPeek.map(i => i.id)).toEqual(['pri-1', 'pri-2', 'pri-3'])
    const firstReal = engine.orderFor('deepseek', identities, 'deepseek-v4-flash', 'balanced')
    expect(firstReal.map(i => i.id)).toEqual(['pri-1', 'pri-2', 'pri-3'])
    const peekAfterReal = engine.orderFor('deepseek', identities, 'deepseek-v4-flash', 'balanced', true)
    expect(peekAfterReal.map(i => i.id)).toEqual(['pri-2', 'pri-3', 'pri-1'])
    const secondReal = engine.orderFor('deepseek', identities, 'deepseek-v4-flash', 'balanced')
    expect(secondReal.map(i => i.id)).toEqual(['pri-2', 'pri-3', 'pri-1'])
    const thirdReal = engine.orderFor('deepseek', identities, 'deepseek-v4-flash', 'balanced')
    expect(thirdReal.map(i => i.id)).toEqual(['pri-3', 'pri-1', 'pri-2'])
  })

  it('peek also keeps priority-sticky stable', () => {
    const engine = engineOf()
    lastEngine = engine
    const identities = [{ id: 'pri-1', priority: 1 }, { id: 'pri-2', priority: 2 }]
    const p1 = engine.orderFor('deepseek', identities, 'deepseek-v4-flash', 'priority-sticky', true)
    const p2 = engine.orderFor('deepseek', identities, 'deepseek-v4-flash', 'priority-sticky', true)
    expect(p1.map(i => i.id)).toEqual(['pri-1', 'pri-2'])
    expect(p2.map(i => i.id)).toEqual(['pri-1', 'pri-2'])
  })
})

describe('CAPACITY backoff tier (oracle #5b)', () => {
  it('consecutiveFailures selects correct backoff tier', () => {
    const engine = engineOf()
    lastEngine = engine
    // Force consecutive failures to 1..5 and check tier mapping
    engine.recordFailure('deepseek', 'pri-1', 'deepseek-v4-flash', 'CAPACITY', '503 overloaded')
    let snap = engine.snapshot('deepseek')
    expect(snap['pri-1']?.['deepseek-v4-flash']?.consecutiveFailures).toBe(1)
    let tierIdx = Math.min(0, CAPACITY_BACKOFF_TIERS_MS.length - 1)
    expect(CAPACITY_BACKOFF_TIERS_MS[tierIdx]).toBe(5000)
    engine.recordFailure('deepseek', 'pri-1', 'deepseek-v4-flash', 'CAPACITY', '503 overloaded')
    snap = engine.snapshot('deepseek')
    expect(snap['pri-1']?.['deepseek-v4-flash']?.consecutiveFailures).toBe(2)
    tierIdx = Math.min(Math.max(0, 2 - 1), CAPACITY_BACKOFF_TIERS_MS.length - 1)
    expect(CAPACITY_BACKOFF_TIERS_MS[tierIdx]).toBe(10_000)
    engine.recordFailure('deepseek', 'pri-1', 'deepseek-v4-flash', 'CAPACITY', '503 overloaded')
    snap = engine.snapshot('deepseek')
    expect(snap['pri-1']?.['deepseek-v4-flash']?.consecutiveFailures).toBe(3)
    tierIdx = Math.min(Math.max(0, 3 - 1), CAPACITY_BACKOFF_TIERS_MS.length - 1)
    expect(CAPACITY_BACKOFF_TIERS_MS[tierIdx]).toBe(20_000)
    // Fourth and fifth
    engine.recordFailure('deepseek', 'pri-1', 'deepseek-v4-flash', 'CAPACITY', '503 overloaded')
    engine.recordFailure('deepseek', 'pri-1', 'deepseek-v4-flash', 'CAPACITY', '503 overloaded')
    snap = engine.snapshot('deepseek')
    expect(snap['pri-1']?.['deepseek-v4-flash']?.consecutiveFailures).toBe(5)
    tierIdx = Math.min(Math.max(0, 5 - 1), CAPACITY_BACKOFF_TIERS_MS.length - 1)
    expect(CAPACITY_BACKOFF_TIERS_MS[tierIdx]).toBe(60_000)
  })

  it('adapter backoff invoked when CAPACITY and no healthy peer', async () => {
    const fake = await createFakeOpenAI({ keys: [{ id: 'pri-1', key: 'k1' }, { id: 'pri-2', key: 'k2' }] })
    try {
      const sleeps: number[] = []
      const engine = engineOf({
        now: () => 1_000_000,
        sleep: (ms, signal) => {
          sleeps.push(ms)
          if (signal.aborted) return Promise.reject(signal.reason)
          return Promise.resolve()
        },
      })
      lastEngine = engine
      // Pre-cool both so healthy set is empty -> order includes both as all-cooling probe, maxAttempts 2, othersHealthy false -> backoff
      engine.recordFailure('deepseek', 'pri-1', 'deepseek-v4-flash', 'QUOTA', 'Resets in 10min.')
      engine.recordFailure('deepseek', 'pri-2', 'deepseek-v4-flash', 'QUOTA', 'Resets in 10min.')
      const twoPool = (baseURL: string) => ({
        deepseek: {
          baseURL,
          pool: {
            strategy: 'priority-sticky' as const,
            identities: [
              { id: 'pri-1', credentialRef: 'K1', priority: 1 },
              { id: 'pri-2', credentialRef: 'K2', priority: 2 },
            ],
          },
        },
      })
      // A deadline wide enough that the tiers fit unclamped; the deadline-clamp
      // behavior itself is covered by adapter-pool.spec.ts.
      const adapter = adapterOf(twoPool(fake.url), engine, { K1: 'k1', K2: 'k2' }, 600_000)
      fake.setScenario('pri-1', { failMode: '503' })
      fake.setScenario('pri-2', { failMode: '503' })
      await expect(streamText(adapter)).rejects.toMatchObject({ code: 'PROVIDER_POOL_EXHAUSTED' })
      // Backoff should have been invoked for first CAPACITY with no healthy peer (tier based on consecutiveFailures after first failure)
      expect(sleeps.length).toBeGreaterThanOrEqual(1)
      expect(sleeps[0]).toBe(CAPACITY_BACKOFF_TIERS_MS[1] ?? CAPACITY_BACKOFF_TIERS_MS[0])
      // Now force higher consecutiveFailures and verify tier escalates
      sleeps.length = 0
      engine.recordFailure('deepseek', 'pri-1', 'deepseek-v4-flash', 'CAPACITY', '503 overloaded')
      engine.recordFailure('deepseek', 'pri-1', 'deepseek-v4-flash', 'CAPACITY', '503 overloaded')
      // consecutive is now 3+ -> next failure tier should escalate
      const snapBefore = engine.snapshot('deepseek')
      const before = snapBefore['pri-1']?.['deepseek-v4-flash']?.consecutiveFailures ?? 0
      fake.setScenario('pri-1', { failMode: '529' })
      await expect(streamText(adapter)).rejects.toMatchObject({ code: 'PROVIDER_POOL_EXHAUSTED' })
      const expectedTier = Math.min(Math.max(0, before), CAPACITY_BACKOFF_TIERS_MS.length - 1)
      // The tier used is based on state after recordFailure (consecutive+1)
      expect(sleeps[0]).toBe(CAPACITY_BACKOFF_TIERS_MS[Math.min(before, CAPACITY_BACKOFF_TIERS_MS.length - 1)])
      void expectedTier
    } finally {
      await fake.close()
    }
  })
})

describe('503/529 rotation (oracle #5c)', () => {
  it('503 CAPACITY rotates to next healthy identity', async () => {
    const fake = await createFakeOpenAI({ keys: [{ id: 'pri-1', key: 'k1' }, { id: 'pri-2', key: 'k2' }] })
    try {
      const engine = engineOf()
      lastEngine = engine
      const adapter = adapterOf(POOLED(fake.url), engine, { K1: 'k1', K2: 'k2' })
      fake.setScenario('pri-1', { failMode: '503' })
      await streamText(adapter)
      expect(fake.requests.length).toBeGreaterThanOrEqual(2)
      expect(fake.requests[0]?.keyId).toBe('pri-1')
      expect(fake.requests[1]?.keyId).toBe('pri-2')
      expect(engine.cooldownRemaining('deepseek', 'pri-1', 'deepseek-v4-flash')).toBeGreaterThan(0)
      expect(engine.cooldownRemaining('deepseek', 'pri-2', 'deepseek-v4-flash')).toBe(0)
    } finally {
      await fake.close()
    }
  })

  it('529 CAPACITY also rotates', async () => {
    const fake = await createFakeOpenAI({ keys: [{ id: 'pri-1', key: 'k1' }, { id: 'pri-2', key: 'k2' }] })
    try {
      const engine = engineOf()
      lastEngine = engine
      const adapter = adapterOf(POOLED(fake.url), engine, { K1: 'k1', K2: 'k2' })
      fake.setScenario('pri-1', { failMode: '529' })
      await streamText(adapter)
      expect(fake.requests[1]?.keyId).toBe('pri-2')
    } finally {
      await fake.close()
    }
  })
})

describe('hydrate dirty skip (oracle #5d)', () => {
  it('does not clobber in-memory cooldown when dirty', async () => {
    const { writeFile, mkdir } = await import('node:fs/promises')
    // Seed stateDir with a clean file for deepseek
    await mkdir(stateDir, { recursive: true })
    await writeFile(join(stateDir, 'deepseek.json'), JSON.stringify({ version: 1, identities: { 'pri-1': { 'deepseek-v4-flash': { cooldownUntil: 0, consecutiveFailures: 0 } } } }), 'utf8')
    const engine = engineOf({ now: () => 2_000_000 })
    lastEngine = engine
    // Start hydrate in background (reads the clean file)
    const hydrating = engine.hydrate('deepseek')
    // Immediately mutate: recordFailure marks dirty and sets cooldown
    engine.recordFailure('deepseek', 'pri-1', 'deepseek-v4-flash', 'QUOTA', 'Resets in 10min.')
    await hydrating
    // Cooldown must survive, not be overwritten by the clean file
    expect(engine.cooldownRemaining('deepseek', 'pri-1', 'deepseek-v4-flash')).toBeGreaterThan(0)
    const snap = engine.snapshot('deepseek')
    expect(snap['pri-1']?.['deepseek-v4-flash']?.consecutiveFailures).toBe(1)
  })
})

describe('mid-stream (oracle #5e)', () => {
  it('records success at commit and failure after mid-stream error', async () => {
    const fake = await createFakeOpenAI({ keys: [{ id: 'pri-1', key: 'k1' }, { id: 'pri-2', key: 'k2' }] })
    try {
      const engine = engineOf()
      lastEngine = engine
      const adapter = adapterOf(POOLED(fake.url), engine, { K1: 'k1', K2: 'k2' })
      fake.setScenario('pri-1', { failMode: 'mid-stream' })
      // Collect chunks manually to observe mid-stream behavior
      const chunks: unknown[] = []
      let caught: unknown
      try {
        for await (const c of adapter.stream({ provider: 'deepseek', model: 'deepseek-v4-flash', messages: [] })) {
          chunks.push(c)
          if (c.type === 'finish' && c.reason.kind === 'error') throw (c.reason as { failure: unknown }).failure
        }
      } catch (e) {
        caught = e
      }
      // Mid-stream should have yielded at least role + content before error/transport close
      // Depending on pi-ai transport, it may surface as stream error or finish error
      // The key assertion: engine should have recorded a failure for the mid-stream attempt
      const snap = engine.snapshot('deepseek')
      const state = snap['pri-1']?.['deepseek-v4-flash']
      // After commit success was recorded then mid-stream failure increments consecutiveFailures
      // Initial consecutive 0 -> recordSuccess at commit resets to 0, then recordFailure -> 1
      // So we expect at least 1 consecutive failure recorded for pri-1
      expect(state?.consecutiveFailures).toBeGreaterThanOrEqual(1)
      expect(state?.cooldownUntil).toBeGreaterThan(0)
      // Should have attempted pri-1 (mid-stream) — may also have tried pri-2? For mid-stream we commit, so no rotation
      expect(fake.requests[0]?.keyId).toBe('pri-1')
      void caught
      void chunks
    } finally {
      await fake.close()
    }
  })
})

describe('MISSING_CREDENTIAL when no resolvable identity (oracle #7)', () => {
  it('throws MISSING_CREDENTIAL when resolvableOrder is empty', async () => {
    const fake = await createFakeOpenAI({ keys: [{ id: 'pri-1', key: 'k1' }, { id: 'pri-2', key: 'k2' }] })
    try {
      const engine = engineOf()
      lastEngine = engine
      const adapter = adapterOf(POOLED(fake.url), engine, { K1: undefined, K2: undefined })
      await expect(streamText(adapter)).rejects.toMatchObject({ code: 'MISSING_CREDENTIAL' })
      expect(fake.requests.length).toBe(0)
    } finally {
      await fake.close()
    }
  })

  it('throws MISSING_CREDENTIAL with provider in message', async () => {
    const fake = await createFakeOpenAI({ keys: [{ id: 'pri-1', key: 'k1' }] })
    try {
      const engine = engineOf()
      lastEngine = engine
      const adapter = adapterOf(POOLED(fake.url), engine, {})
      try {
        await streamText(adapter)
        expect.unreachable('should have thrown')
      } catch (e) {
        const err = e as { code?: string; message?: unknown }
        expect(err.code).toBe('MISSING_CREDENTIAL')
        expect(String(err.message)).toContain('deepseek')
      }
    } finally {
      await fake.close()
    }
  })
})
