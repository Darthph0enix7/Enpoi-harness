/**
 * Route-level free-tier gate.
 *
 * A provider that gates its free tier to its own clients cannot express that
 * as a per-model `gated` marking: the listing is rewritten on every sync, so
 * the marking would disappear with the next refresh. The durable declaration
 * is the route profile field (`freeTierGated` + optional reason), and every
 * settings write stamps it onto the route's zero-priced models. No provider
 * name reaches the code — the policy is data.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  applyFreeTierGate,
  DEFAULT_FREE_TIER_GATE_REASON,
  freeTierGateOf,
  planRouteModels,
  type PlanRouteInput,
} from '../src/index.ts'

const directories: string[] = []

/**
 * models.dev fixture for the `acme` route. The sync reads cost from the
 * catalogue, so a zero-priced model must exist there for the plan to carry
 * `cost`; an unpriced row proves "unknown" is never treated as free.
 */
const CATALOGUE = {
  acme: {
    models: {
      'free-one': { cost: { input: 0, output: 0 }, tool_call: true, limit: { context: 262144, output: 65536 } },
      'free-two': { cost: { input: 0, output: 0 }, tool_call: true, limit: { context: 262144, output: 65536 } },
      paid: { cost: { input: 1, output: 2 }, tool_call: true, limit: { context: 262144, output: 65536 } },
      unpriced: { tool_call: true, limit: { context: 262144, output: 65536 } },
    },
  },
}

beforeAll(() => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-free-gate-'))
  directories.push(directory)
  const path = join(directory, 'models.json')
  writeFileSync(path, JSON.stringify(CATALOGUE), 'utf8')
  process.env.DSH_MODELS_DEV_PATH = path
})

afterAll(() => {
  Reflect.deleteProperty(process.env, 'DSH_MODELS_DEV_PATH')
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

/** One route plan over a scripted listing. */
function plan(listing: PlanRouteInput['live'], extra: Partial<PlanRouteInput> = {}): PlanRouteInput {
  return {
    route: 'acme',
    configured: [],
    live: listing,
    catalogRoute: false,
    endpointFresh: true,
    catalogFresh: false,
    now: 1_000,
    source: 'live',
    ...extra,
  }
}

describe('route-level free-tier gate', () => {
  it('stamps every zero-priced model and leaves paid and unpriced models alone', () => {
    const planned = planRouteModels(plan(
      [{ id: 'free-one' }, { id: 'free-two' }, { id: 'paid' }, { id: 'unpriced' }],
      { freeTierGate: { reason: 'free tier is limited to Acme clients' } },
    ))
    const byId = new Map(planned.models.map(model => [model.id, model]))
    expect(byId.get('free-one')).toMatchObject({ gated: true, gateReason: 'free tier is limited to Acme clients' })
    expect(byId.get('free-two')).toMatchObject({ gated: true, gateReason: 'free tier is limited to Acme clients' })
    expect(byId.get('paid')?.gated).toBeUndefined()
    expect(byId.get('paid')?.gateReason).toBeUndefined()
    expect(byId.get('unpriced')?.gated).toBeUndefined()
    expect(byId.get('paid')).toMatchObject({ cost: { input: 1, output: 2 } })
  })

  it('is byte-identical when the route declares no gate', () => {
    const listing = [{ id: 'free-one' }, { id: 'paid' }]
    const withAbsent = planRouteModels(plan(listing))
    const withUndefined = planRouteModels(plan(listing, { freeTierGate: undefined }))
    expect(JSON.stringify(withAbsent.models)).toBe(JSON.stringify(withUndefined.models))
    expect(JSON.stringify(withAbsent.models)).not.toContain('gated')
  })

  it('keeps the gate across a pass that adds new free ids', () => {
    const profile = { freeTierGated: true, freeTierGateReason: 'free tier is limited to Acme clients' }
    const gate = freeTierGateOf(profile)
    const first = planRouteModels(plan([{ id: 'free-one' }], { freeTierGate: gate }))
    expect(first.models.map(model => [model.id, model.gated])).toEqual([['free-one', true]])

    // The next listing adds an id. The profile field was never part of the
    // models write, so the new id is stamped by the same rule.
    const second = planRouteModels(plan(
      [{ id: 'free-one' }, { id: 'free-two' }],
      { configured: first.models, freeTierGate: gate },
    ))
    expect(second.models.map(model => [model.id, model.gated])).toEqual([['free-one', true], ['free-two', true]])
    expect(second.models.every(model => model.gateReason === 'free tier is limited to Acme clients')).toBe(true)
    expect(freeTierGateOf(profile)).toEqual(gate)
  })

  it('resolves the profile field and its default reason without naming a provider', () => {
    expect(freeTierGateOf(undefined)).toBeUndefined()
    expect(freeTierGateOf({})).toBeUndefined()
    expect(freeTierGateOf({ freeTierGated: false })).toBeUndefined()
    expect(freeTierGateOf({ freeTierGated: true })).toEqual({ reason: DEFAULT_FREE_TIER_GATE_REASON })
    expect(freeTierGateOf({ freeTierGated: true, freeTierGateReason: 'gated' })).toEqual({ reason: 'gated' })
    expect(DEFAULT_FREE_TIER_GATE_REASON).toContain("provider's own clients")
  })

  it('stamps only records whose disclosed price is known zero', () => {
    const records: Array<Record<string, unknown>> = [
      { id: 'zero', cost: { input: 0, output: 0 } },
      { id: 'zero-input-only', cost: { input: 0 } },
      { id: 'paid', cost: { input: 0, output: 3 } },
      { id: 'unknown' },
    ]
    const gated = applyFreeTierGate(records, { reason: 'gated' })
    expect(gated.map(model => [model.id, model.gated ?? null])).toEqual([
      ['zero', true],
      ['zero-input-only', true],
      ['paid', null],
      ['unknown', null],
    ])
  })
})
