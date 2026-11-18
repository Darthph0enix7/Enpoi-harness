import { describe, expect, it } from 'vitest'
import type { PeerRoutingPolicy } from '@deepseek-ai/dsh-api-peer/types'
import {
  PeerRoutingEngine, decodeCursor, encodeCursor, passesFilter, type PeerRoutingLimits,
} from '../src/index.ts'
import { entry, free, harness, paid, unpriced } from './helpers.ts'

/** Provider ids exercise the privacy seed: google trains, groq does not, acme is unknown. */
const CATALOGUE = [
  free('kilo', 'auto/free', { contextWindow: 131_072, input: ['text', 'image'] }),
  free('groq', 'llama', { contextWindow: 32_768 }),
  free('google', 'gemini'),
  free('acme', 'shadow'),
  paid('kilo', 'premium'),
  unpriced('kilo', 'mystery'),
  free('kilo', 'gated', { gated: true }),
  free('kilo', 'other'),
]

const ZERO_PRICE = ['kilo/auto/free', 'groq/llama', 'google/gemini', 'acme/shadow', 'kilo/gated', 'kilo/other']

const EFFORTS = { 'kilo/auto/free': { minimal: 'minimal', medium: 'medium' } }

const FREE_CHAIN = {
  free: {
    label: 'Free',
    selectors: [{ when: { zeroPrice: true }, adopt: true }],
    members: [
      { provider: 'kilo', model: 'auto/free' },
      { provider: 'groq', model: 'llama' },
    ],
  },
}

/** The worker-alias policy: free chain plus free pinned models only. */
const FREE_POLICY: PeerRoutingPolicy = {
  allowChains: ['free'],
  allowModels: ['kilo/*', 'groq/*', 'google/*', 'acme/*'],
  requireZeroPrice: true,
  allowReasoningEfforts: ['minimal', 'medium'],
  allowSwitch: 'idle-only',
}

/** Build the standard harness with overrides. */
function standard(overrides: Parameters<typeof harness>[0] = {}) {
  return harness({ entries: CATALOGUE, zeroPrice: ZERO_PRICE, efforts: EFFORTS, chains: FREE_CHAIN, ...overrides })
}

/** Discover rows under a policy that allows every catalogue route. */
async function allModels(policy: PeerRoutingPolicy = { allowModels: ['*'] }) {
  return (await standard().engine.discover(policy, {})).models
}

describe('peer routing evaluate — chain grants', () => {
  it('picks the first ready member and falls back to the first declared member', async () => {
    const cooling = standard({
      health: [{ provider: 'kilo', model: 'auto/free', coolingUntil: 5_000 }],
    })
    await expect(cooling.engine.evaluate(FREE_POLICY, { provider: '', model: '', chain: 'free' }))
      .resolves.toEqual({ allowed: true, selection: { provider: 'groq', model: 'llama', chain: 'free' } })

    const exhausted = standard({
      health: [
        { provider: 'kilo', model: 'auto/free', coolingUntil: 5_000 },
        { provider: 'groq', model: 'llama', coolingUntil: 6_000 },
      ],
    })
    await expect(exhausted.engine.evaluate(FREE_POLICY, { chain: 'free', provider: '', model: '' }))
      .resolves.toEqual({ allowed: true, selection: { provider: 'kilo', model: 'auto/free', chain: 'free' } })

    // A cooldown that already expired is ready again.
    const expired = standard({ health: [{ provider: 'kilo', model: 'auto/free', coolingUntil: 500 }] })
    await expect(expired.engine.evaluate(FREE_POLICY, { provider: '', model: '', chain: 'free' }))
      .resolves.toEqual({ allowed: true, selection: { provider: 'kilo', model: 'auto/free', chain: 'free' } })
  })

  it('refuses a chain that is not explicitly allowed or does not resolve', async () => {
    const engine = standard().engine
    await expect(engine.evaluate({ ...FREE_POLICY, allowChains: ['stable'] }, { provider: '', model: '', chain: 'free' }))
      .resolves.toEqual({ allowed: false, reason: 'chain-not-allowed', denied: 'free' })
    await expect(engine.evaluate({ allowModels: ['*'] }, { provider: '', model: '', chain: 'free' }))
      .resolves.toEqual({ allowed: false, reason: 'chain-not-allowed', denied: 'free' })
    await expect(engine.evaluate({ allowChains: ['nope'] }, { provider: '', model: '', chain: 'nope' }))
      .resolves.toEqual({ allowed: false, reason: 'unknown-route', denied: 'nope' })
  })

  it('applies the member predicate to every member and names the offender', async () => {
    const memberOnly = (member: { provider: string; model: string }) => ({
      free: { members: [{ provider: 'kilo', model: 'auto/free' }, member] },
    })
    const policy = { allowChains: ['free'], requireZeroPrice: true }
    const engineFor = (member: { provider: string; model: string }) => standard({ chains: memberOnly(member) }).engine

    await expect(engineFor({ provider: 'kilo', model: 'premium' }).evaluate(policy, { provider: '', model: '', chain: 'free' }))
      .resolves.toEqual({ allowed: false, reason: 'price-unproven', denied: 'kilo/premium' })
    await expect(engineFor({ provider: 'kilo', model: 'mystery' }).evaluate(policy, { provider: '', model: '', chain: 'free' }))
      .resolves.toEqual({ allowed: false, reason: 'price-unproven', denied: 'kilo/mystery' })
    await expect(engineFor({ provider: 'kilo', model: 'gated' }).evaluate(policy, { provider: '', model: '', chain: 'free' }))
      .resolves.toEqual({ allowed: false, reason: 'model-not-allowed', denied: 'kilo/gated' })
    await expect(engineFor({ provider: 'kilo', model: 'missing' }).evaluate(policy, { provider: '', model: '', chain: 'free' }))
      .resolves.toEqual({ allowed: false, reason: 'unknown-route', denied: 'kilo/missing' })
    const trainingChain = (member: { provider: string; model: string }) => standard({
      chains: { free: { members: [{ provider: 'groq', model: 'llama' }, member] } },
    }).engine
    await expect(trainingChain({ provider: 'google', model: 'gemini' }).evaluate(
      { allowChains: ['free'], requireNoTraining: true },
      { provider: '', model: '', chain: 'free' },
    )).resolves.toEqual({ allowed: false, reason: 'training-unproven', denied: 'google/gemini' })
    await expect(trainingChain({ provider: 'acme', model: 'shadow' }).evaluate(
      { allowChains: ['free'], requireNoTraining: true },
      { provider: '', model: '', chain: 'free' },
    )).resolves.toEqual({ allowed: false, reason: 'training-unproven', denied: 'acme/shadow' })
    await expect(engineFor({ provider: 'kilo', model: 'premium' }).evaluate(
      { allowChains: ['free'], allowModels: ['groq/*'] },
      { provider: '', model: '', chain: 'free' },
    )).resolves.toEqual({ allowed: false, reason: 'model-not-allowed', denied: 'kilo/auto/free' })
    // A pinned member still needs its own allowModels grant.
    await expect(engineFor({ provider: 'groq', model: 'llama' }).evaluate(
      { allowChains: ['free'] },
      { provider: 'groq', model: 'llama', chain: 'free' },
    )).resolves.toEqual({ allowed: false, reason: 'model-not-allowed', denied: 'groq/llama' })
    // A model-only half pin is malformed too.
    await expect(engineFor({ provider: 'groq', model: 'llama' }).evaluate(
      { allowChains: ['free'], allowModels: ['*'] },
      { provider: '', model: 'llama', chain: 'free' },
    )).resolves.toEqual({ allowed: false, reason: 'unknown-route', denied: '/llama' })
    // An absent allowModels does not narrow a chain grant.
    await expect(engineFor({ provider: 'groq', model: 'llama' }).evaluate(
      { allowChains: ['free'] },
      { provider: '', model: '', chain: 'free' },
    )).resolves.toEqual({ allowed: true, selection: { provider: 'kilo', model: 'auto/free', chain: 'free' } })
  })

  it('validates a caller effort and a chain link effort against policy and the ladder', async () => {
    const engine = standard().engine
    await expect(engine.evaluate(FREE_POLICY, { provider: '', model: '', chain: 'free', reasoningEffort: 'medium' }))
      .resolves.toEqual({ allowed: true, selection: { provider: 'kilo', model: 'auto/free', chain: 'free', reasoningEffort: 'medium' } })
    await expect(engine.evaluate(FREE_POLICY, { provider: '', model: '', chain: 'free', reasoningEffort: 'high' }))
      .resolves.toEqual({ allowed: false, reason: 'effort-not-allowed', denied: 'high' })
    await expect(engine.evaluate({ ...FREE_POLICY, allowReasoningEfforts: undefined }, {
      provider: '', model: '', chain: 'free', reasoningEffort: 'high',
    })).resolves.toEqual({ allowed: false, reason: 'effort-not-allowed', denied: 'high' })
    await expect(engine.evaluate({ ...FREE_POLICY, allowReasoningEfforts: undefined }, {
      provider: '', model: '', chain: 'free', reasoningEffort: 'minimal',
    })).resolves.toEqual({ allowed: true, selection: { provider: 'kilo', model: 'auto/free', chain: 'free', reasoningEffort: 'minimal' } })

    // A chain link's own effort is part of the effective selection.
    const linkEffort = standard({
      chains: { free: { members: [{ provider: 'kilo', model: 'auto/free', effort: 'high' }] } },
      efforts: { 'kilo/auto/free': { high: 'high' } },
    }).engine
    await expect(linkEffort.evaluate({ allowChains: ['free'] }, { provider: '', model: '', chain: 'free' }))
      .resolves.toEqual({ allowed: true, selection: { provider: 'kilo', model: 'auto/free', chain: 'free', reasoningEffort: 'high' } })
    await expect(linkEffort.evaluate(FREE_POLICY, { provider: '', model: '', chain: 'free' }))
      .resolves.toEqual({ allowed: false, reason: 'effort-not-allowed', denied: 'high' })
  })

  it('satisfies both grants when a provider/model hint accompanies a chain', async () => {
    const engine = standard().engine
    await expect(engine.evaluate(FREE_POLICY, { provider: 'groq', model: 'llama', chain: 'free' }))
      .resolves.toEqual({ allowed: true, selection: { provider: 'groq', model: 'llama', chain: 'free' } })
    await expect(engine.evaluate(FREE_POLICY, { provider: 'kilo', model: 'other', chain: 'free' }))
      .resolves.toEqual({ allowed: false, reason: 'model-not-allowed', denied: 'kilo/other' })
    await expect(engine.evaluate(FREE_POLICY, { provider: '', model: '', chain: 'nope' }))
      .resolves.toEqual({ allowed: false, reason: 'chain-not-allowed', denied: 'nope' })
    await expect(engine.evaluate({ allowChains: ['nope'] }, { provider: 'kilo', model: 'auto/free', chain: 'nope' }))
      .resolves.toEqual({ allowed: false, reason: 'unknown-route', denied: 'nope' })
    // A half pin cannot be satisfied by the chain alone.
    await expect(engine.evaluate(FREE_POLICY, { provider: 'kilo', model: '', chain: 'free' }))
      .resolves.toEqual({ allowed: false, reason: 'unknown-route', denied: 'kilo/' })
    // A caller effort rides along with the pinned member.
    await expect(engine.evaluate(FREE_POLICY, { provider: 'kilo', model: 'auto/free', chain: 'free', reasoningEffort: 'minimal' }))
      .resolves.toEqual({ allowed: true, selection: {
        provider: 'kilo', model: 'auto/free', chain: 'free', reasoningEffort: 'minimal',
      } })
  })

  it('denies a dynamic chain that drifts to a paid member after discovery', async () => {
    const h = standard()
    const discovered = await h.engine.discover(FREE_POLICY, {})
    expect(discovered.chains[0]?.id).toBe('free')
    expect(discovered.models.map(model => `${model.provider}/${model.model}`)).not.toContain('kilo/drifted')

    h.state.entries.push(paid('kilo', 'drifted'))
    h.state.chains = {
      free: { ...FREE_CHAIN.free, members: [...FREE_CHAIN.free.members, { provider: 'kilo', model: 'drifted' }] },
    }
    await expect(h.engine.evaluate(FREE_POLICY, { provider: '', model: '', chain: 'free' }))
      .resolves.toEqual({ allowed: false, reason: 'price-unproven', denied: 'kilo/drifted' })
    // Discovery re-reads the catalogue too: the paid row never appears.
    expect((await h.engine.discover(FREE_POLICY, {})).models.map(model => model.model)).not.toContain('drifted')
  })
})

describe('peer routing evaluate — pinned grants', () => {
  it('selects an allowed zero-price route and carries the effort', async () => {
    const engine = standard().engine
    await expect(engine.evaluate(FREE_POLICY, { provider: 'kilo', model: 'auto/free', reasoningEffort: 'medium' }))
      .resolves.toEqual({ allowed: true, selection: { provider: 'kilo', model: 'auto/free', reasoningEffort: 'medium' } })
    // A paid route is allowed when the policy does not require zero price.
    await expect(engine.evaluate({ allowModels: ['kilo/*'] }, { provider: 'kilo', model: 'premium' }))
      .resolves.toEqual({ allowed: true, selection: { provider: 'kilo', model: 'premium' } })
  })

  it('requires an explicit allowModels match', async () => {
    const engine = standard().engine
    await expect(engine.evaluate({ requireZeroPrice: true }, { provider: 'kilo', model: 'auto/free' }))
      .resolves.toEqual({ allowed: false, reason: 'model-not-allowed', denied: 'kilo/auto/free' })
    await expect(engine.evaluate({ allowModels: ['openrouter/*'] }, { provider: 'kilo', model: 'auto/free' }))
      .resolves.toEqual({ allowed: false, reason: 'model-not-allowed', denied: 'kilo/auto/free' })
    await expect(engine.evaluate({ allowModels: ['kilo/*'] }, { provider: 'kilo', model: 'nope' }))
      .resolves.toEqual({ allowed: false, reason: 'unknown-route', denied: 'kilo/nope' })
    await expect(engine.evaluate({ allowModels: ['kilo/*'] }, { provider: '', model: '' }))
      .resolves.toEqual({ allowed: false, reason: 'unknown-route', denied: '/' })
  })

  it('always refuses a gated route', async () => {
    await expect(standard().engine.evaluate({ allowModels: ['kilo/*'] }, { provider: 'kilo', model: 'gated' }))
      .resolves.toEqual({ allowed: false, reason: 'model-not-allowed', denied: 'kilo/gated' })
  })

  it('refuses a deprecated catalogue record and omits it from discovery', async () => {
    const retired = free('kilo', 'retired', { deprecated: true })
    const h = standard({
      entries: [...CATALOGUE, retired],
      zeroPrice: [...ZERO_PRICE, 'kilo/retired'],
      health: [{ provider: 'kilo', model: 'retired', coolingUntil: 9_000 }],
      chains: { free: { members: [{ provider: 'kilo', model: 'auto/free' }, { provider: 'kilo', model: 'retired' }] } },
    })
    // It matches every glob and price proof, but the route is not selectable.
    await expect(h.engine.evaluate({ allowModels: ['kilo/*'], requireZeroPrice: true }, { provider: 'kilo', model: 'retired' }))
      .resolves.toEqual({ allowed: false, reason: 'model-not-allowed', denied: 'kilo/retired' })
    expect((await h.engine.discover({ allowModels: ['kilo/*'] }, {})).models.map(model => model.model))
      .not.toContain('retired')
    // A chain member that became deprecated refuses the whole chain by name.
    await expect(h.engine.evaluate({ allowChains: ['free'] }, { provider: '', model: '', chain: 'free' }))
      .resolves.toEqual({ allowed: false, reason: 'model-not-allowed', denied: 'kilo/retired' })
    // Discovery still resolves the chain, and the member state says why it is
    // unusable; deprecation wins over a simultaneous cooldown.
    expect((await h.engine.discover({ allowChains: ['free'] }, {})).chains).toEqual([{
      id: 'free',
      dynamic: false,
      members: [
        { provider: 'kilo', model: 'auto/free', state: 'ready' },
        { provider: 'kilo', model: 'retired', state: 'deprecated' },
      ],
    }])
  })

  it.each([
    ['proven tools', true, undefined],
    ['no tools', false, 'tools-unproven'],
    ['unknown tools', undefined, 'tools-unproven'],
  ] as const)('honours requireTools when the catalogue reports %s', async (_label, tools, refusal) => {
    const entries = [
      entry('acme', 'proven', { tools: true, cost: { input: 0, output: 0 } }),
      entry('acme', 'no-tools', { tools: false, cost: { input: 0, output: 0 } }),
      entry('acme', 'unknown-tools', { cost: { input: 0, output: 0 } }),
    ]
    const engine = harness({ entries, zeroPrice: ['acme/proven', 'acme/no-tools', 'acme/unknown-tools'] }).engine
    const model = tools === true ? 'proven' : tools === false ? 'no-tools' : 'unknown-tools'
    const verdict = await engine.evaluate({ allowModels: ['acme/*'], requireTools: true }, { provider: 'acme', model })
    expect(verdict).toEqual(refusal === undefined
      ? { allowed: true, selection: { provider: 'acme', model } }
      : { allowed: false, reason: refusal, denied: `acme/${model}` })
    // Without the clause the same row stays selectable: the policy alone demands proof.
    await expect(engine.evaluate({ allowModels: ['acme/*'] }, { provider: 'acme', model }))
      .resolves.toEqual({ allowed: true, selection: { provider: 'acme', model } })
    // Discovery uses the same predicate, so only a proven-tools row is listed.
    const discovered = await engine.discover({ allowModels: ['acme/*'], requireTools: true }, {})
    expect(discovered.models.map(info => info.model)).toEqual(['proven'])
  })

  it('requires proven zero price and no-training', async () => {
    const engine = standard().engine
    const price = { allowModels: ['kilo/*'], requireZeroPrice: true }
    await expect(engine.evaluate(price, { provider: 'kilo', model: 'premium' }))
      .resolves.toEqual({ allowed: false, reason: 'price-unproven', denied: 'kilo/premium' })
    await expect(engine.evaluate(price, { provider: 'kilo', model: 'mystery' }))
      .resolves.toEqual({ allowed: false, reason: 'price-unproven', denied: 'kilo/mystery' })
    const training = { allowModels: ['*'], requireNoTraining: true }
    await expect(engine.evaluate(training, { provider: 'groq', model: 'llama' }))
      .resolves.toEqual({ allowed: true, selection: { provider: 'groq', model: 'llama' } })
    await expect(engine.evaluate(training, { provider: 'google', model: 'gemini' }))
      .resolves.toEqual({ allowed: false, reason: 'training-unproven', denied: 'google/gemini' })
    await expect(engine.evaluate(training, { provider: 'acme', model: 'shadow' }))
      .resolves.toEqual({ allowed: false, reason: 'training-unproven', denied: 'acme/shadow' })
  })

  it('validates the caller effort against the policy allowlist and the model ladder', async () => {
    const engine = standard().engine
    await expect(engine.evaluate({ allowModels: ['groq/*'] }, { provider: 'groq', model: 'llama', reasoningEffort: 'high' }))
      .resolves.toEqual({ allowed: false, reason: 'effort-not-allowed', denied: 'high' })
    await expect(engine.evaluate({ allowModels: ['groq/*'], allowReasoningEfforts: ['high'] }, {
      provider: 'groq', model: 'llama', reasoningEffort: 'high',
    })).resolves.toEqual({ allowed: false, reason: 'effort-not-allowed', denied: 'high' })
  })

  it('trims whitespace before resolving', async () => {
    await expect(standard().engine.evaluate(FREE_POLICY, { provider: ' kilo ', model: ' auto/free ', chain: ' free ' }))
      .resolves.toEqual({ allowed: true, selection: { provider: 'kilo', model: 'auto/free', chain: 'free' } })
  })
})

describe('peer routing discover', () => {
  it('lists only allowed, resolvable chains with live member state', async () => {
    const engine = standard({
      health: [{ provider: 'groq', model: 'llama', coolingUntil: 9_000 }],
    }).engine
    const value = await engine.discover({ allowChains: ['free', 'free', 'missing'] }, {})
    expect(value.chains).toEqual([{
      id: 'free',
      label: 'Free',
      dynamic: true,
      members: [
        { provider: 'kilo', model: 'auto/free', state: 'ready' },
        { provider: 'groq', model: 'llama', state: 'cooldown', cooldownUntil: 9_000 },
      ],
    }])
    expect(value.models).toEqual([])
    expect((await engine.discover({}, {})).chains).toEqual([])
    // A chain without a label and without a selector renders as a static group.
    const unlabeled = standard({
      chains: {
        free: FREE_CHAIN.free,
        plain: { members: [{ provider: 'kilo', model: 'auto/free' }] },
      },
    }).engine
    expect((await unlabeled.discover({ allowChains: ['plain'] }, {})).chains).toEqual([{
      id: 'plain',
      dynamic: false,
      members: [{ provider: 'kilo', model: 'auto/free', state: 'ready' }],
    }])
  })

  it('maps only routes the pinned predicate accepts, sorted and honest', async () => {
    const models = await allModels()
    expect(models.map(model => `${model.provider}/${model.model}`)).toEqual([
      'acme/shadow', 'google/gemini', 'groq/llama', 'kilo/auto/free', 'kilo/mystery', 'kilo/other', 'kilo/premium',
    ])
    expect(models.find(model => model.model === 'auto/free')).toEqual({
      provider: 'kilo',
      model: 'auto/free',
      tools: true,
      vision: true,
      contextWindow: 131_072,
      zeroPrice: true,
      gated: false,
      trainsOnData: 'yes',
      reasoningEfforts: ['medium', 'minimal'],
    })
    expect(models.find(model => model.model === 'mystery')).toMatchObject({ zeroPrice: 'unknown' })
    expect(models.find(model => model.model === 'shadow')).toMatchObject({ trainsOnData: 'unknown' })
  })

  it('never lists gated routes or routes the price/training requirement refuses', async () => {
    const engine = standard().engine
    expect((await engine.discover({ allowModels: ['*'], requireZeroPrice: true }, {})).models.map(model => model.model))
      .toEqual(['shadow', 'gemini', 'llama', 'auto/free', 'other'])
    expect((await engine.discover({ allowModels: ['*'], requireNoTraining: true }, {})).models.map(model => model.model))
      .toEqual(['llama'])
  })

  it('applies caller filters with exact equality and ignores a malformed window', async () => {
    const policy: PeerRoutingPolicy = { allowModels: ['*'] }
    expect((await standard().engine.discover(policy, { filter: { zeroPrice: true } })).models).toHaveLength(5)
    expect((await standard().engine.discover(policy, { filter: { zeroPrice: false } })).models.map(model => model.model))
      .toEqual(['premium'])
    expect((await standard().engine.discover(policy, { filter: { tools: false } })).models).toEqual([])
    expect((await standard().engine.discover(policy, { filter: { gated: true } })).models).toEqual([])
    expect((await standard().engine.discover(policy, { filter: { gated: false } })).models).toHaveLength(7)
    expect((await standard().engine.discover(policy, { filter: { minContextWindow: 100_000 } })).models.map(model => model.model))
      .toEqual(['auto/free'])
    expect((await standard().engine.discover(policy, { filter: { minContextWindow: Number.NaN } })).models).toHaveLength(7)
    expect((await standard().engine.discover(policy, { filter: { minContextWindow: 0 } })).models).toHaveLength(7)
    expect((await standard().engine.discover(policy, { filter: undefined })).models).toHaveLength(7)
  })

  it('paginates deterministically with an opaque cursor', async () => {
    const policy: PeerRoutingPolicy = { allowModels: ['*'] }
    const first = await standard().engine.discover(policy, { limit: 2 })
    expect(first.models.map(model => model.model)).toEqual(['shadow', 'gemini'])
    expect(first.nextCursor).toBeDefined()
    const second = await standard().engine.discover(policy, { limit: 2, cursor: first.nextCursor })
    expect(second.models.map(model => model.model)).toEqual(['llama', 'auto/free'])
    expect(second.nextCursor).toBeDefined()
    const third = await standard().engine.discover(policy, { limit: 2, cursor: second.nextCursor })
    expect(third.models.map(model => model.model)).toEqual(['mystery', 'other'])
    expect(third.nextCursor).toBeDefined()
    const fourth = await standard().engine.discover(policy, { limit: 2, cursor: third.nextCursor })
    expect(fourth.models.map(model => model.model)).toEqual(['premium'])
    expect(fourth.nextCursor).toBeUndefined()
    // The cursor is opaque base64url, never the raw route.
    expect(first.nextCursor).not.toContain('/')
  })

  it('rejects a cursor it did not mint and answers an empty tail beyond the last row', async () => {
    const engine = standard().engine
    await expect(engine.discover({ allowModels: ['*'] }, { cursor: 'not-a-cursor' })).rejects.toThrow('invalid cursor')
    await expect(engine.discover({ allowModels: ['*'] }, { cursor: Buffer.from('[1,2]').toString('base64url') }))
      .rejects.toThrow('invalid cursor')
    await expect(engine.discover({ allowModels: ['*'] }, { cursor: Buffer.from('null').toString('base64url') }))
      .rejects.toThrow('invalid cursor')
    await expect(engine.discover({ allowModels: ['*'] }, { cursor: Buffer.from('[1]').toString('base64url') }))
      .rejects.toThrow('invalid cursor')
    await expect(engine.discover({ allowModels: ['*'] }, { cursor: Buffer.from('["p",""]').toString('base64url') }))
      .rejects.toThrow('invalid cursor')
    const beyond = await engine.discover({ allowModels: ['*'] }, { cursor: encodeCursor({ provider: 'zzz', model: 'zzz' }) })
    expect(beyond.models).toEqual([])
    expect(beyond.nextCursor).toBeUndefined()
    expect(decodeCursor(encodeCursor({ provider: 'p', model: 'm' }))).toEqual({ provider: 'p', model: 'm' })
  })

  it('bounds the page size and falls back on a malformed limit', async () => {
    const policy: PeerRoutingPolicy = { allowModels: ['*'] }
    const bounded = harness({
      entries: CATALOGUE.map((row, index) => ({ ...row, id: `${row.id}-${String(index)}` })),
      zeroPrice: undefined,
      chains: undefined,
      limits: { defaultLimit: 2, maxLimit: 3 },
    }).engine
    expect((await bounded.discover(policy, {})).models).toHaveLength(2)
    expect((await bounded.discover(policy, { limit: 0 })).models).toHaveLength(2)
    expect((await bounded.discover(policy, { limit: 2.5 })).models).toHaveLength(2)
    expect((await bounded.discover(policy, { limit: 10 })).models).toHaveLength(3)
    // A nonsensical configured pair still answers one usable page.
    const degenerate = harness({ entries: CATALOGUE, zeroPrice: undefined, limits: { defaultLimit: 0, maxLimit: 0 } }).engine
    expect((await degenerate.discover(policy, {})).models).toHaveLength(1)
  })

  it('shares the predicate with evaluate: every listed row evaluates allowed', async () => {
    const h = standard()
    const policy: PeerRoutingPolicy = { allowModels: ['kilo/*'], requireZeroPrice: true }
    const listed = await h.engine.discover(policy, {})
    expect(listed.models.length).toBeGreaterThan(0)
    for (const model of listed.models) {
      await expect(h.engine.evaluate(policy, { provider: model.provider, model: model.model }))
        .resolves.toEqual({ allowed: true, selection: { provider: model.provider, model: model.model } })
    }
  })
})

describe('peer routing helpers', () => {
  it('validates standalone filters and engine limits', () => {
    const info = {
      provider: 'p', model: 'm', tools: true as const, vision: 'unknown' as const, contextWindow: 10,
      zeroPrice: true as const, gated: false as const, trainsOnData: 'no' as const, reasoningEfforts: [],
    }
    expect(passesFilter(info, undefined)).toBe(true)
    expect(passesFilter(info, { zeroPrice: false })).toBe(false)
    expect(passesFilter(info, { tools: false })).toBe(false)
    expect(passesFilter({ ...info, tools: 'unknown' }, { tools: true })).toBe(false)
    expect(passesFilter(info, { minContextWindow: 11 })).toBe(false)
    expect(passesFilter({ ...info, contextWindow: undefined }, { minContextWindow: 11 })).toBe(false)
    expect(passesFilter(info, { minContextWindow: Number.POSITIVE_INFINITY })).toBe(true)
    // The constructor clamps a default above the cap.
    const limits: PeerRoutingLimits = { defaultLimit: 10, maxLimit: 2 }
    const engine = new PeerRoutingEngine({
      catalogue: () => [free('p', 'm')], zeroPriceKeys: () => new Set(), privacy: () => undefined,
      rawEfforts: () => new Map(), chains: () => undefined, routeHealth: () => [], now: () => 0,
    }, limits)
    expect(engine).toBeInstanceOf(PeerRoutingEngine)
  })
})

describe('peer routing evaluate — catalogue edge cases', () => {
  it('denies every route when the catalogue is empty', async () => {
    const engine = harness().engine
    await expect(engine.evaluate({ allowModels: ['*'] }, { provider: 'p', model: 'm' }))
      .resolves.toEqual({ allowed: false, reason: 'unknown-route', denied: 'p/m' })
    await expect(engine.evaluate({ allowChains: ['any'] }, { provider: '', model: '', chain: 'any' }))
      .resolves.toEqual({ allowed: false, reason: 'unknown-route', denied: 'any' })
  })

  it('treats a blank chain as absent', async () => {
    const h = harness({
      entries: [entry('p', 'm')],
      zeroPrice: ['p/m'],
      efforts: {},
      chains: { ' ': { members: [{ provider: 'p', model: 'm' }] } },
    })
    await expect(h.engine.evaluate({ allowModels: ['*'] }, { provider: 'p', model: 'm', chain: '  ' }))
      .resolves.toEqual({ allowed: true, selection: { provider: 'p', model: 'm' } })
  })
})
