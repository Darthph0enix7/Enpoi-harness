/**
 * Shipped free-tier gate — data, not a provider rule.
 *
 * OpenCode's console gates its `-free` models to OpenCode's own clients
 * (server-side policy; a harness call gets `403 FreeTierError`), so a free
 * model group must never adopt one. The gate is carried by the shipped
 * catalogue records themselves: every `-free` record the repository ships is
 * upserted with `gated: true` plus a reason, and the built-in `free` group's
 * `gated: false` clause excludes it structurally. No code branch names a
 * provider — this spec proves the data path only: overlay record → catalogue
 * entry → the shipped selector's predicate.
 */
import { describe, expect, it } from 'vitest'
import {
  expandSelector, parseGroupSelector, readCatalogue, type CatalogEntry,
} from '../packages/enpoi-catalog-rules/src/index.ts'
import { SHIPPED_FREE_CHAIN } from '../packages/enpoi-model-chains/src/index.ts'
import { applyCatalogOverlay, loadCatalogOverlays } from '../packages/enpoi-provider-sync/src/index.ts'

/** Reason the shipped free-tier records carry. */
const FREE_TIER_GATE = 'free tier is limited to OpenCode clients'

/** The route whose shipped overlay carries OpenCode's free tier today. */
const ROUTE = 'opencode-go'

/** The shipped records for that route, as the sync writes them to settings. */
function shippedModels(): Array<Record<string, unknown>> {
  const overlay = loadCatalogOverlays().routes?.[ROUTE]
  if (overlay === undefined) throw new Error(`the shipped catalog overlays name no "${ROUTE}" route`)
  // An overlay applied to a route whose endpoint said nothing is exactly the
  // model list the sync persists: the upserts are the maintained records.
  return applyCatalogOverlay([], overlay)
}

/** The same records as the picker and the rules engine read them. */
function shippedEntries(): CatalogEntry[] {
  const entries = readCatalogue({ get: ns => ns === 'llm-pi-ai' ? { providers: { [ROUTE]: { models: shippedModels() } } } : undefined })
  if (entries.length === 0) throw new Error(`the shipped "${ROUTE}" overlay produced no catalogue entries`)
  return entries
}

/** The built-in free group's single selector, parsed the way the resolver parses it. */
function freeSelector() {
  const selector = parseGroupSelector(SHIPPED_FREE_CHAIN.selectors?.[0], () => {})
  if (selector === undefined) throw new Error('the shipped free group has no parsable selector')
  return selector
}

describe('shipped OpenCode free tier', () => {
  it('marks every shipped free-tier record gated with a reason', () => {
    const free = shippedModels().filter(entry => String(entry.id).endsWith('-free'))
    expect(free.map(entry => entry.id).sort()).toEqual([
      'longcat-2.5-preview-free',
      'space-bunny-free',
      'step-5-preview-free',
    ])
    for (const entry of free) {
      expect(entry.gated, String(entry.id)).toBe(true)
      expect(entry.gateReason, String(entry.id)).toBe(FREE_TIER_GATE)
    }
    // The catalogue projection keeps the marker: this is what the picker dims
    // and what a `gated` predicate clause reads.
    for (const entry of shippedEntries().filter(candidate => candidate.id.endsWith('-free'))) {
      expect(entry).toMatchObject({ gated: true, gateReason: FREE_TIER_GATE })
    }
    // A paid record on the same route is not gated by this data.
    expect(shippedModels().find(entry => entry.id === 'deepseek-v4.1-flash')?.gated).toBeUndefined()
  })

  it('is excluded by the built-in free selector, not by a code branch', () => {
    const selector = freeSelector()
    const visible = (): boolean => true
    // Each record would otherwise satisfy the selector (zero price, tools,
    // 1M context, visible); only the gate clause rejects it.
    for (const entry of shippedEntries().filter(candidate => candidate.id.endsWith('-free'))) {
      expect(expandSelector(selector, [entry], undefined, visible).links, entry.id).toEqual([])
    }
    // Control: the same shape without a gate is adopted, so the gate is what
    // excludes the OpenCode records rather than an accidental clause mismatch.
    const ungated: CatalogEntry = {
      provider: 'kilo',
      id: 'free-control',
      tools: true,
      contextWindow: 262_144,
      input: ['text'],
      cost: { input: 0, output: 0 },
    }
    expect(expandSelector(selector, [ungated], undefined, visible).links).toEqual([
      { provider: 'kilo', model: 'free-control' },
    ])
    // And the whole shipped route contributes nothing to the free group.
    expect(expandSelector(selector, shippedEntries(), undefined, visible).links).toEqual([])
  })
})
