// @vitest-environment jsdom
/**
 * The Models card's eye must state exactly what the picker shows, derived from
 * the listing's own free/paid markers and the picker's published rule
 * decisions — never from model names or any hardcoded model set.
 */
import { afterEach, expect, it } from 'vitest'
import {
  CATALOG_DECISIONS_MIRROR_KEY, isModelRowGated, modelVisibility, parseCatalogDecisions, readCatalogDecisions,
} from '../src/client/model-visibility.ts'

afterEach(() => {
  localStorage.clear()
})

it('hides rows the listing marked non-free and shows rows it marked free', () => {
  const free = { id: 'vendor/auto-free', isFree: true }
  const priced = { id: 'vendor/auto-efficient', isFree: false, gateReason: 'sign-in required' }
  const rawPaidMarker = { id: 'vendor/raw-paid-marker', isFree: false }
  const gatedStamp = { id: 'vendor/gated-stamp', gated: true, gateReason: 'sign-in required' }
  const manual = new Set<string>()

  expect(modelVisibility(free, manual, undefined)).toEqual({ hidden: false, reason: null, locked: false })
  expect(modelVisibility(priced, manual, undefined)).toEqual({ hidden: true, reason: 'sign-in required', locked: true })
  expect(modelVisibility(rawPaidMarker, manual, undefined)).toEqual({ hidden: true, reason: null, locked: true })
  expect(modelVisibility(gatedStamp, manual, undefined)).toEqual({ hidden: true, reason: 'sign-in required', locked: true })
})

it('an absent free marker is undisclosed, never a paid claim', () => {
  expect(isModelRowGated({ id: 'vendor/mystery' })).toBe(false)
  expect(modelVisibility({ id: 'vendor/mystery' }, new Set(), undefined).hidden).toBe(false)
})

it('derives from markers alone across a generated listing, not from names', () => {
  // Ids that sound paid or free must not influence the verdict; only the
  // disclosed marker does. Half the generated rows are paid.
  const listing = Array.from({ length: 64 }, (_, index) => ({
    id: `arbitrary/model-${String(index)}`,
    isFree: index % 2 === 0,
  }))
  listing.push({ id: 'looks-free/model:free', isFree: false })
  listing.push({ id: 'looks-paid/model-pro-max', isFree: true })

  const hidden = listing.filter(row => modelVisibility(row, new Set(), undefined).hidden).map(row => row.id)
  expect(hidden).toEqual(listing.filter(row => row.isFree === false).map(row => row.id))
  expect(hidden).toContain('looks-free/model:free')
  expect(hidden).not.toContain('looks-paid/model-pro-max')
})

it('a manual local pin wins and stays toggleable', () => {
  expect(modelVisibility({ id: 'm' }, new Set(['m']), undefined))
    .toEqual({ hidden: true, reason: null, locked: false })
  // A published manual-shown pin cannot beat the operator's local hide, but it
  // still means clearing the local pin would show the model again.
  expect(modelVisibility({ id: 'm' }, new Set(['m']), { state: 'visible', reason: null }))
    .toEqual({ hidden: true, reason: null, locked: false })
  // A local pin beside a non-free marker states the marker: off and locked.
  expect(modelVisibility({ id: 'm', gated: true, gateReason: 'sign-in required' }, new Set(['m']), undefined))
    .toEqual({ hidden: true, reason: 'sign-in required', locked: true })
})

it('follows a published hidden decision with its reason, and a shown pin over gating', () => {
  expect(modelVisibility({ id: 'm' }, new Set(), { state: 'hidden', reason: 'sign-in required' }))
    .toEqual({ hidden: true, reason: 'sign-in required', locked: true })
  expect(modelVisibility({ id: 'm', gated: true }, new Set(), { state: 'visible', reason: null }))
    .toEqual({ hidden: false, reason: null, locked: false })
  expect(modelVisibility({ id: 'm', gated: true }, new Set(), { state: 'hidden', reason: 'hidden by rule: x' }))
    .toEqual({ hidden: true, reason: 'hidden by rule: x', locked: true })
})

it('parses the picker decision mirror and drops malformed rows', () => {
  const parsed = parseCatalogDecisions({
    'p/hidden': { state: 'hidden', reason: 'sign-in required', source: 'gated' },
    'p/shown': { state: 'visible', reason: 'pinned visible' },
    'p/empty-reason': { state: 'hidden', reason: '' },
    'p/bad-state': { state: 'maybe', reason: 'x' },
    'p/not-object': 'nope',
    'p/null': null,
  })
  expect([...parsed.entries()]).toEqual([
    ['p/hidden', { state: 'hidden', reason: 'sign-in required' }],
    ['p/shown', { state: 'visible', reason: 'pinned visible' }],
    ['p/empty-reason', { state: 'hidden', reason: null }],
  ])
  expect(parseCatalogDecisions(null).size).toBe(0)
  expect(parseCatalogDecisions(['nope']).size).toBe(0)
})

it('reads the mirror from localStorage, empty on absence or malformed JSON', () => {
  expect(readCatalogDecisions().size).toBe(0)
  localStorage.setItem(CATALOG_DECISIONS_MIRROR_KEY, JSON.stringify({
    'p/hidden': { state: 'hidden', reason: 'sign-in required' },
  }))
  expect(readCatalogDecisions().get('p/hidden')).toEqual({ state: 'hidden', reason: 'sign-in required' })
  localStorage.setItem(CATALOG_DECISIONS_MIRROR_KEY, '{ not json')
  expect(readCatalogDecisions().size).toBe(0)
})
