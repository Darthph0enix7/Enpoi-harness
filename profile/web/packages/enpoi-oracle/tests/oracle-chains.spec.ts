import { describe, expect, it } from 'vitest'
import { apply, resolveOracleChainAttempts } from '../src/index.ts'
import { createOracleHarness, waitFor } from './harness.ts'

/**
 * Oracle chain-route specs (doc 60): the persistent child is spawned on the
 * ACTIVE link of the resolved chain snapshot and is never respawned when it
 * merely fails a turn — one route owns one child until the route itself
 * changes.
 */

const STABLE_CHAIN = {
  id: 'stable',
  label: 'Stable',
  links: [
    { provider: 'p1', model: 'm1' },
    { provider: 'p2', model: 'm2' },
  ],
  attempts: 2,
  onCut: 'failover',
}

const VERDICT = 'Reviewed thoroughly.\n{"approved":true,"concerns":["minor"],"unverified":[],"blockers":[]}'

describe('oracle chain attempt resolution', () => {
  it('resolves a chain assignment into the ordered attempts (active link first)', () => {
    const ctx = {
      get: (ns: string) => ns === 'settings'
        ? { get: () => ({ personas: { oracle: { chain: 'stable' } } }) }
        : ns === 'modelChains'
          ? { resolve: () => STABLE_CHAIN }
          : undefined,
    }
    const resolved = resolveOracleChainAttempts(ctx as never, 'oracle')
    expect(resolved.chainId).toBe('stable')
    expect(resolved.carryId).toBe(true)
    expect(resolved.attempts).toEqual([
      { provider: 'p1', model: 'm1' },
      { provider: 'p2', model: 'm2' },
    ])
  })

  it('keeps the persona link active when it differs from the chain head, without carrying the chain id', () => {
    const ctx = {
      get: (ns: string) => ns === 'settings'
        ? { get: () => ({ personas: { oracle: { provider: 'p9', model: 'm9', chain: 'stable' } } }) }
        : ns === 'modelChains'
          ? { resolve: () => STABLE_CHAIN }
          : undefined,
    }
    const resolved = resolveOracleChainAttempts(ctx as never, 'oracle')
    expect(resolved.chainId).toBe('stable')
    expect(resolved.carryId).toBe(false)
    expect(resolved.attempts).toEqual([
      { provider: 'p9', model: 'm9' },
      { provider: 'p1', model: 'm1' },
      { provider: 'p2', model: 'm2' },
    ])
  })

  it('fails open to the legacy persona/default route without a chain', () => {
    const ctx = {
      get: (ns: string) => ns === 'settings'
        ? { get: () => ({ personas: { oracle: { provider: 'solo', model: 'only', reasoningEffort: 'high' } } }) }
        : undefined,
    }
    const resolved = resolveOracleChainAttempts(ctx as never, 'oracle')
    expect(resolved.chainId).toBeUndefined()
    expect(resolved.carryId).toBe(false)
    expect(resolved.attempts).toEqual([{ provider: 'solo', model: 'only', reasoningEffort: 'high' }])
    const none = resolveOracleChainAttempts({ get: () => undefined } as never, 'oracle')
    expect(none.attempts).toEqual([{}])
  })
})

describe('oracle child route on spawn', () => {
  it('spawns on the active chain link and carries the chain id', async () => {
    const harness = createOracleHarness({
      humanText: 'review the plan',
      settings: {
        personas: { oracle: { chain: 'stable' } },
        parameters: { oracle: { timeoutMs: 120_000 } },
      },
    })
    ;(harness.ctx as { modelChains?: unknown }).modelChains = { resolve: () => STABLE_CHAIN }
    apply(harness.ctx as never, { childPollMs: 100 })
    const running = harness.tool().execute(
      { request: 'review this plan' },
      { agent: harness.parent, signal: new AbortController().signal },
    )
    await waitFor(() => harness.spawns.length === 1)
    expect(harness.spawns).toHaveLength(1)
    expect(harness.spawns[0]!.agentOptions).toEqual({ provider: 'p1', model: 'm1', chain: 'stable' })
    harness.settleLastSpawn(VERDICT)
    const result = await running
    expect(result.approved).toBe(true)
  })

  it('reports a failed child turn without respawning the child', async () => {
    const harness = createOracleHarness({
      humanText: 'review the plan',
      settings: {
        personas: { oracle: { chain: 'stable' } },
        parameters: { oracle: { timeoutMs: 120_000 } },
      },
    })
    ;(harness.ctx as { modelChains?: unknown }).modelChains = { resolve: () => STABLE_CHAIN }
    apply(harness.ctx as never, { childPollMs: 100 })
    const oracle = harness.tool()

    const first = oracle.execute({ request: 'review this plan' }, { agent: harness.parent, signal: new AbortController().signal })
    await waitFor(() => harness.spawns.length === 1)
    expect(harness.spawns).toHaveLength(1)
    harness.settleLastSpawn('provider exploded', 'error')
    const result = await first
    expect(result.rejected).toBe(true)
    expect(String(result.blockers)).toContain('ORACLE_MODEL_ERROR')
    expect(harness.spawns).toHaveLength(1)

    const second = oracle.execute({ request: 'try again' }, { agent: harness.parent, signal: new AbortController().signal })
    await waitFor(() => harness.prompts.length === 1)
    expect(harness.spawns).toHaveLength(1)
    expect(harness.prompts).toHaveLength(1)
    harness.settle(harness.prompts[0]!.childId, harness.prompts[0]!.messageId, VERDICT)
    const retried = await second
    expect(retried.approved).toBe(true)
  })

  it('keeps the legacy single-route behaviour without a chain', async () => {
    const harness = createOracleHarness({
      humanText: 'review the plan',
      settings: {
        personas: { oracle: { provider: 'solo', model: 'only' } },
        parameters: { oracle: { timeoutMs: 120_000 } },
      },
    })
    apply(harness.ctx as never, { childPollMs: 100 })
    const running = harness.tool().execute(
      { request: 'review this plan' },
      { agent: harness.parent, signal: new AbortController().signal },
    )
    await waitFor(() => harness.spawns.length === 1)
    expect(harness.spawns[0]!.agentOptions).toEqual({ provider: 'solo', model: 'only' })
    harness.settleLastSpawn('provider exploded', 'error')
    const result = await running
    expect(result.rejected).toBe(true)
    expect(String(result.blockers)).toContain('ORACLE_MODEL_ERROR')
  })
})
