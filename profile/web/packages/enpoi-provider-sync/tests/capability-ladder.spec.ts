/**
 * The endpoint's own capability claim survives a sync refresh.
 *
 * A listing carries its effort ladder and input modalities in the
 * provider-neutral `capabilities` block. `normalizeListingEntry` reads that
 * block through the shared llm-pi-ai listing parser — the same reader the Add
 * flow and llm-pi-ai's own discovery use — so a refresh writes the ladder back
 * instead of replacing it with catalog inference, which for ids no catalog
 * knows means no ladder at all.
 *
 * Precedence: an advertised ladder beats inference; a listing that advertises
 * nothing keeps today's inference result (a configured ladder is then replaced,
 * exactly as before), and a `source: 'manual'` entry keeps the ladder the
 * operator declared.
 */
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, it } from 'vitest'
import { listingCapabilities } from '@deepseek-ai/dsh-llm-pi-ai'
import { mergeConfiguredModels, normalizeListingEntry, planRouteModels } from '../src/index.ts'

// A missing models.dev cache keeps inference deterministic: no catalog entry
// exists for the fabricated ids below, so nothing can invent a ladder.
const modelsDevPath = process.env.DSH_MODELS_DEV_PATH
process.env.DSH_MODELS_DEV_PATH = join(tmpdir(), 'dsh-sync-no-models-dev.json')
afterAll(() => {
  if (modelsDevPath === undefined) Reflect.deleteProperty(process.env, 'DSH_MODELS_DEV_PATH')
  else process.env.DSH_MODELS_DEV_PATH = modelsDevPath
})

/** One listing row shaped like the verified Meridian catalog entry. */
const ROW = {
  id: 'probe-ladder-model-77',
  object: 'model',
  display_name: 'Probe Ladder Model 77',
  context_window: 1_000_000,
  capabilities: {
    image_input: { supported: true },
    pdf_input: { supported: true },
    effort: {
      low: { supported: true },
      medium: { supported: true },
      high: { supported: true },
      xhigh: { supported: true },
      max: { supported: true },
      // Advertised as unavailable: the ladder must not offer it.
      minimal: { supported: false },
      // The block's own marker is not a level.
      supported: true,
    },
    thinking: { supported: true, types: { adaptive: { supported: true } } },
  },
}

const ROUTE = 'probe-gateway'

it('carries the advertised ladder through the shared parser with no second mapping', () => {
  const advertised = listingCapabilities(ROW)
  expect(advertised.reasoningEfforts).toEqual({
    low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max',
  })
  expect(advertised.inputModalities).toEqual(['text', 'image', 'pdf'])

  const entry = normalizeListingEntry(ROW)!
  // The sync reads the block through the shared identifier: a local
  // reimplementation would have to reproduce this mapping key for key.
  expect(entry.reasoningEfforts).toEqual(advertised.reasoningEfforts)
  expect(entry.input).toEqual(advertised.inputModalities)
})

it('a refresh over a configured entry keeps the ladder the endpoint advertises', () => {
  const ladder = { low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' }
  const configured = [{
    id: 'probe-ladder-model-77',
    name: 'Probe Ladder Model 77',
    contextWindow: 1_000_000,
    input: ['text', 'image', 'pdf'],
    reasoning: true,
    reasoningEfforts: ladder,
  }]
  const merged = mergeConfiguredModels(ROUTE, configured, [normalizeListingEntry(ROW)!], undefined)

  expect(merged.models).toHaveLength(1)
  expect(merged.models[0]!.reasoningEfforts).toEqual(ladder)
  expect(merged.models[0]!.input).toEqual(['text', 'image', 'pdf'])
  expect(merged.models[0]!.reasoning).toBe(true)
  expect(merged.unadvertised).toEqual([])
})

it('a listing without a capability block keeps today\'s inference result, replacing the configured ladder', () => {
  // Intent: the endpoint is authoritative for the route it serves, so silence
  // falls back to the models.dev/catalog inference the sync always used — for
  // an id no catalog knows that inference yields no ladder, so the configured
  // one is replaced (behaviour is unchanged from before this change).
  const configured = [{
    id: 'probe-ladder-model-77',
    reasoning: true,
    reasoningEfforts: { high: 'high', max: 'max' },
  }]
  const plain = normalizeListingEntry({ id: 'probe-ladder-model-77', display_name: 'Probe Ladder Model 77' })!
  expect(plain.reasoningEfforts).toBeUndefined()

  const merged = mergeConfiguredModels(ROUTE, configured, [plain], undefined)
  expect(merged.models[0]!.reasoningEfforts).toBeUndefined()
  expect(merged.models[0]!.reasoning).toBe(false)
})

it('the healthy pass keeps the advertised ladder, and a manual ladder over a different one', () => {
  const advertised = normalizeListingEntry(ROW)!
  const plan = planRouteModels({
    route: ROUTE,
    configured: [
      { id: 'probe-ladder-model-77', reasoning: true },
      { id: 'probe-manual-model-88', source: 'manual', reasoning: true, reasoningEfforts: { high: 'high', max: 'max' } },
    ],
    live: [advertised, normalizeListingEntry({
      id: 'probe-manual-model-88',
      capabilities: { effort: { low: { supported: true } } },
    })!],
    catalogRoute: false,
    endpointFresh: true,
    catalogFresh: true,
    now: 1_000,
  })
  // The endpoint-authority pass refreshes the stored record from the listing,
  // so the advertised ladder is what lands — not a catalog inference.
  expect(plan.models[0]!.reasoningEfforts).toEqual({
    low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max',
  })
  // The manual entry's own ladder is the operator's claim; the listing's
  // single `low` level never replaces it.
  expect(plan.models[1]).toMatchObject({
    id: 'probe-manual-model-88',
    source: 'manual',
    reasoningEfforts: { high: 'high', max: 'max' },
  })
})

it('a manual entry keeps its own ladder whether the listing omits or advertises one', () => {
  const manual = {
    id: 'probe-manual-model-88',
    source: 'manual',
    reasoning: true,
    reasoningEfforts: { high: 'high', max: 'max' },
  }
  // Silent listing: the operator's own ladder survives the refresh.
  const silent = mergeConfiguredModels(ROUTE, [manual], [normalizeListingEntry({ id: 'probe-manual-model-88' })!], undefined)
  expect(silent.models[0]).toMatchObject({
    id: 'probe-manual-model-88',
    source: 'manual',
    reasoningEfforts: { high: 'high', max: 'max' },
  })

  // A different advertised ladder does not overwrite the operator's claim.
  const advertised = normalizeListingEntry({
    id: 'probe-manual-model-88',
    capabilities: { effort: { low: { supported: true }, medium: { supported: true } } },
  })!
  expect(advertised.reasoningEfforts).toEqual({ low: 'low', medium: 'medium' })
  const merged = mergeConfiguredModels(ROUTE, [manual], [advertised], undefined)
  expect(merged.models[0]).toMatchObject({
    id: 'probe-manual-model-88',
    source: 'manual',
    reasoningEfforts: { high: 'high', max: 'max' },
  })
})

it('keeps an exact endpoint ladder subset and an explicit off, dropping unknown ids', () => {
  const planned = planRouteModels({
    route: ROUTE,
    configured: [],
    live: [{
      id: 'probe-ladder-model-77',
      reasoning: true,
      reasoningEfforts: { low: 'low', high: 'high', off: '', custom_level: 'custom' },
    }],
    catalogRoute: false,
    endpointFresh: true,
    catalogFresh: true,
    now: 1_000,
  })
  // The endpoint's own subset is the whole ladder: no medium/xhigh/max row is
  // added, the explicit off is kept as the valueless key, and an identifier a
  // profile does not accept never becomes a settings key.
  expect(planned.models[0]?.reasoningEfforts).toEqual({ off: null, low: 'low', high: 'high' })
})

it('keeps every operator-declared manual field over the listing and an overlay upsert', () => {
  const configured = [{
    id: 'probe-manual-model-99',
    source: 'manual',
    name: 'Operator Name',
    contextWindow: 12_345,
    maxTokens: 2_345,
    input: ['text', 'image'],
    reasoning: true,
    reasoningEfforts: { high: 'high' },
  }]
  const live = [normalizeListingEntry({
    id: 'probe-manual-model-99',
    display_name: 'Listing Name',
    context_window: 999_999,
    max_output_tokens: 888_888,
    input_modalities: ['text'],
  })!]
  const planned = planRouteModels({
    route: ROUTE,
    configured,
    live,
    catalogRoute: false,
    endpointFresh: true,
    catalogFresh: true,
    overlay: {
      upsert: [{
        id: 'probe-manual-model-99',
        name: 'Overlay Name',
        contextWindow: 777,
        maxTokens: 77,
        input: ['text', 'audio'],
        reasoning: false,
        reasoningEfforts: { low: 'low' },
      }],
    },
    now: 1_000,
  })
  expect(planned.models[0]).toMatchObject({
    id: 'probe-manual-model-99',
    source: 'manual',
    name: 'Operator Name',
    contextWindow: 12_345,
    maxTokens: 2_345,
    input: ['text', 'image'],
    reasoning: true,
    reasoningEfforts: { high: 'high' },
  })
})
