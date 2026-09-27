import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  CAPACITY_BACKOFF_TIERS_MS,
  classifyFailure,
  CLASS_COOLDOWN_MS,
  PoolEngine,
  parseQuotaHeaders,
  parseResetMs,
  ROTATING_CLASSES,
} from '../src/pool.ts'

let stateDir: string

beforeEach(async () => {
  stateDir = await mkdtemp(join(tmpdir(), 'pool-spec-'))
})

afterEach(async () => {
  await rm(stateDir, { recursive: true, force: true })
})

function engine(options: Partial<ConstructorParameters<typeof PoolEngine>[0]> = {}): PoolEngine {
  return new PoolEngine({ stateDir, saveDebounceMs: 5, ...options })
}

describe('parseResetMs', () => {
  it('parses the first resets-in phrase anchored, clamped to [30s,24h]', () => {
    // One contiguous phrase after "resets in" → summed within phrase (4hr 53min = one phrase)
    expect(parseResetMs('Monthly usage limit reached. Resets in 4hr 53min.')).toBe(
      (4 * 3600 + 53 * 60) * 1000,
    )
    // Long windows clamped to 24h
    expect(parseResetMs('Resets in 14 days.')).toBe(24 * 3600_000)
    expect(parseResetMs('resets in 1 week 2 days')).toBe(24 * 3600_000)
    // Single hint, distant numbers ignored (no sum across periods)
    expect(parseResetMs('Resets in 46min. You can make 5 requests per hour.')).toBe(46 * 60_000)
    expect(parseResetMs('Resets in 46min.')).toBe(46 * 60_000)
  })

  it('floors sub-minute resets to 30s and rejects absent/zero hints', () => {
    expect(parseResetMs('Resets in 30sec.')).toBe(30_000)
    expect(parseResetMs('quota exhausted')).toBeUndefined()
    expect(parseResetMs('Resets in 0min.')).toBeUndefined()
  })
})

describe('classifyFailure', () => {
  it('maps the failure vocabulary onto pool decisions', () => {
    expect(classifyFailure('401 Unauthorized: invalid api key')).toBe('AUTH')
    expect(classifyFailure('402 payment required: insufficient credits')).toBe('AUTH')
    // The stream mapper replaces the raw envelope with the provider's own
    // `CODE: message` pair on AUTH failures; the pool must still classify it.
    expect(classifyFailure('PAID_MODEL_AUTH_REQUIRED: You need to sign in to use this model.')).toBe('AUTH')
    expect(classifyFailure('INVALID_TOKEN: Your authentication token is invalid. Please sign in again.')).toBe('AUTH')
    expect(classifyFailure('authentication_error: invalid x-api-key')).toBe('AUTH')
    expect(classifyFailure('429 rate limit exceeded, too many requests')).toBe('QUOTA')
    expect(classifyFailure('RESOURCE_EXHAUSTED quota exhausted for project')).toBe('QUOTA')
    expect(classifyFailure('529 model capacity exhausted, server is busy')).toBe('CAPACITY')
    expect(classifyFailure('503 overloaded')).toBe('CAPACITY')
    expect(classifyFailure('400 invalid_request_error: max_tokens above limit')).toBe('INVALID_REQUEST')
    expect(classifyFailure('terminated before headers')).toBe('UPSTREAM')
    // Context-overflow wording without a literal status code is request-level:
    // rotating identities or cooling a healthy key cannot shrink the payload.
    expect(classifyFailure('prompt is too long for this model')).toBe('INVALID_REQUEST')
    expect(classifyFailure("This model's maximum context length is 32768 tokens, however you requested 41000 tokens"))
      .toBe('INVALID_REQUEST')
    expect(ROTATING_CLASSES.has(classifyFailure('prompt is too long for this model'))).toBe(false)
    expect(CLASS_COOLDOWN_MS[classifyFailure('prompt is too long for this model')]).toBe(0)
  })

  it('lets transient gateway model rejections win over everything else', () => {
    expect(classifyFailure(
      '400 The supported API model names are: a, b, but you passed  deepseek-v4-flash.',
    )).toBe('GATEWAY_OUTAGE')
    expect(classifyFailure('model is unavailable right now')).toBe('GATEWAY_OUTAGE')
    // Even quota-flavoured text naming an unavailable model must not rotate keys.
    expect(ROTATING_CLASSES.has(classifyFailure('model is unavailable after 429'))).toBe(false)
  })

  it('classifies the OpenCode free-tier client gate as a non-rotating POLICY failure', () => {
    const body = '403 {"type":"FreeTierError","message":"OpenCode\'s free tier can only be used from within OpenCode"}'
    expect(classifyFailure(body)).toBe('POLICY')
    // Policy, not credential: no rotation and no cooldown on a healthy key.
    expect(ROTATING_CLASSES.has('POLICY')).toBe(false)
    expect(CLASS_COOLDOWN_MS.POLICY).toBe(0)
    expect(classifyFailure('free tier can only be used from within OpenCode')).toBe('POLICY')
    // A generic free-tier mention must not hijack a real auth failure.
    expect(classifyFailure('401 Unauthorized: invalid api key on the free tier route')).toBe('AUTH')
  })
})

describe('PoolEngine ordering', () => {
  it('serves healthy identities in priority order', () => {
    const e = engine()
    const order = e.orderFor('p', [
      { id: 'c', priority: 3 },
      { id: 'a', priority: 1 },
      { id: 'b', priority: 2 },
    ], 'm')
    expect(order.map(identity => identity.id)).toEqual(['a', 'b', 'c'])
  })

  it('rotates round-robin among healthy identities under balanced without touching cooling order', () => {
    const e = engine()
    const identities = [
      { id: 'a', priority: 1 },
      { id: 'b', priority: 2 },
      { id: 'c', priority: 3 },
    ]
    // Each call advances the per-model cursor; the healthy set stays priority-sorted underneath.
    expect(e.orderFor('p', identities, 'm', 'balanced').map(identity => identity.id)).toEqual(['a', 'b', 'c'])
    expect(e.orderFor('p', identities, 'm', 'balanced').map(identity => identity.id)).toEqual(['b', 'c', 'a'])
    expect(e.orderFor('p', identities, 'm', 'balanced').map(identity => identity.id)).toEqual(['c', 'a', 'b'])
    expect(e.orderFor('p', identities, 'm', 'balanced').map(identity => identity.id)).toEqual(['a', 'b', 'c'])
    // Cursors are per model.
    expect(e.orderFor('p', identities, 'other', 'balanced').map(identity => identity.id)).toEqual(['a', 'b', 'c'])
    // Sticky ordering is unaffected by the balanced calls above.
    expect(e.orderFor('p', identities, 'm').map(identity => identity.id)).toEqual(['a', 'b', 'c'])
    // A cooling identity drops out of rotation and re-enters when it recovers.
    e.recordFailure('p', 'b', 'm', 'QUOTA', 'Resets in 10min.')
    expect(e.orderFor('p', identities, 'm', 'balanced').map(identity => identity.id)).toEqual(['c', 'a'])
  })

  it('skips disabled and cooling identities, then probes soonest-expiry first when all cool', () => {
    let now = 1_000_000
    const e = engine({ now: () => now })
    const identities = [
      { id: 'a', priority: 1 },
      { id: 'b', priority: 2 },
      { id: 'dead', priority: 0, enabled: false },
    ]
    e.recordFailure('p', 'a', 'm', 'QUOTA', 'Resets in 10min.')
    e.recordFailure('p', 'b', 'm', 'AUTH', '401 invalid api key')
    // Everything cooling → optimistic probe order by soonest expiry
    // ('a' resets in 10min, ahead of 'b''s 15min auth cooldown).
    expect(e.orderFor('p', identities, 'm').map(identity => identity.id)).toEqual(['a', 'b'])
    now += 11 * 60_000
    // 'a' recovered; sticky priority resumes.
    expect(e.orderFor('p', identities, 'm').map(identity => identity.id)).toEqual(['a'])
  })

  it('applies class cooldowns and lets a parsed reset extend QUOTA', () => {
    const now = 5_000_000
    const e = engine({ now: () => now })
    e.recordFailure('p', 'k', 'm', 'CAPACITY', '503 overloaded')
    expect(e.cooldownRemaining('p', 'k', 'm')).toBe(CLASS_COOLDOWN_MS.CAPACITY)
    e.recordSuccess('p', 'k', 'm')
    expect(e.cooldownRemaining('p', 'k', 'm')).toBe(0)

    e.recordFailure('p', 'k', 'm', 'QUOTA', 'limit reached. Resets in 90min.')
    expect(e.cooldownRemaining('p', 'k', 'm')).toBe(90 * 60_000)
    e.recordFailure('p', 'k', 'm', 'QUOTA', 'plain quota body without hint')
    expect(e.cooldownRemaining('p', 'k', 'm')).toBe(CLASS_COOLDOWN_MS.QUOTA)

    // Non-rotating classes never cool down.
    e.recordFailure('p', 'k', 'm', 'GATEWAY_OUTAGE', 'supported api model names are...')
    expect(e.cooldownRemaining('p', 'k', 'm')).toBe(0)
  })

  it('tracks consecutive failures across records until a success clears them', () => {
    const e = engine()
    e.recordFailure('p', 'k', 'm', 'UPSTREAM', 'terminated')
    e.recordFailure('p', 'k', 'm', 'UPSTREAM', 'terminated')
    expect(e.snapshot('p').k?.m?.consecutiveFailures).toBe(2)
    e.recordSuccess('p', 'k', 'm')
    expect(e.snapshot('p').k?.m?.consecutiveFailures).toBe(0)
  })
})

describe('PoolEngine persistence', () => {
  it('writes atomic per-provider state and restores cooldowns in a new engine', async () => {
    const first = engine()
    first.recordFailure('myroute', 'key-1', 'model-a', 'QUOTA', 'Resets in 2hr.')
    await first.flush()
    const raw = JSON.parse(await readFile(join(stateDir, 'myroute.json'), 'utf8'))
    expect(raw.version).toBe(1)
    expect(raw.identities['key-1']['model-a'].cooldownUntil).toBeGreaterThan(0)

    const second = engine()
    await second.hydrate('myroute')
    expect(second.cooldownRemaining('myroute', 'key-1', 'model-a')).toBeGreaterThan(119 * 60_000)
  })

  it('starts clean from corrupt or unknown-shaped files', async () => {
    await writeFile(join(stateDir, 'broken.json'), '{not json', 'utf8')
    const e = engine()
    await e.hydrate('broken')
    expect(e.snapshot('broken')).toEqual({})
    await writeFile(join(stateDir, 'weird.json'), JSON.stringify({ version: 9, identities: {} }), 'utf8')
    const e2 = engine()
    await e2.hydrate('weird')
    expect(e2.snapshot('weird')).toEqual({})
  })

  it('sanitizes hand-edited entries instead of trusting them', async () => {
    await writeFile(join(stateDir, 'hand.json'), JSON.stringify({
      version: 1,
      identities: {
        k: { m: { cooldownUntil: 'soon', consecutiveFailures: -5, lastError: 42, extra: true } },
        __proto__: { pollute: {} },
      },
    }), 'utf8')
    const e = engine()
    await e.hydrate('hand')
    const snapshot = e.snapshot('hand')
    expect(snapshot.k?.m?.cooldownUntil).toBe(0)
    expect(snapshot.k?.m?.consecutiveFailures).toBe(0)
    expect(snapshot.k?.m?.lastError).toBeUndefined()
  })
})

describe('parseQuotaHeaders', () => {
  it('extracts remainingFraction and resetTime from rate limit headers', () => {
    const headers = {
      'x-ratelimit-remaining-requests': '25',
      'x-ratelimit-limit-requests': '100',
      'x-ratelimit-reset-requests': '46s',
    }
    const quota = parseQuotaHeaders(headers)
    expect(quota).toEqual({
      remainingFraction: 0.25,
      resetTime: '46s',
      source: 'headers',
    })
  })

  it('handles Anthropic rate limit headers', () => {
    const headers = {
      'anthropic-ratelimit-tokens-remaining': '8000',
      'anthropic-ratelimit-tokens-limit': '10000',
      'anthropic-ratelimit-tokens-reset': '2026-08-23T12:00:00Z',
    }
    const quota = parseQuotaHeaders(headers)
    expect(quota?.remainingFraction).toBe(0.8)
    expect(quota?.resetTime).toBe('2026-08-23T12:00:00Z')
  })

  it('returns undefined when no quota headers are present', () => {
    expect(parseQuotaHeaders({})).toBeUndefined()
  })
})

describe('PoolEngine identitiesStatus & resetCooldown', () => {
  it('reports identity status across all models and resets cooldowns cleanly', () => {
    const now = 10_000_000
    const e = engine({ now: () => now })
    e.recordFailure('myroute', 'id-1', 'm1', 'QUOTA', 'Resets in 30min.')
    e.recordQuota('myroute', 'id-1', 'm1', { remainingFraction: 0.1, resetTime: '30m' })

    const status = e.identitiesStatus('myroute', [
      { id: 'id-1', credentialRef: 'KEY_1', priority: 1, enabled: true },
      { id: 'id-2', credentialRef: 'KEY_2', priority: 2, enabled: true },
    ])

    expect(status[0]?.id).toBe('id-1')
    expect(status[0]?.cooldownUntil).toBeGreaterThan(now)
    expect(status[0]?.consecutiveFailures).toBe(1)
    expect(status[0]?.quota?.remainingFraction).toBe(0.1)
    expect(status[1]?.id).toBe('id-2')
    expect(status[1]?.cooldownUntil).toBe(0)

    // Reset cooldown
    e.resetCooldown('myroute', 'id-1')
    const postReset = e.identitiesStatus('myroute', [
      { id: 'id-1', credentialRef: 'KEY_1' },
    ])
    expect(postReset[0]?.cooldownUntil).toBe(0)
    expect(postReset[0]?.consecutiveFailures).toBe(0)
  })
})

describe('capacity backoff tiers', () => {
  it('expose progressive delays and honour abort during backoff', async () => {
    expect(CAPACITY_BACKOFF_TIERS_MS.length).toBeGreaterThanOrEqual(3)
    const e = engine()
    const controller = new AbortController()
    const pending = e.backoff(60_000, controller.signal)
    controller.abort(new Error('caller went away'))
    await expect(pending).rejects.toThrow('caller went away')
  })
})
