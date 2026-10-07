/**
 * Automatic heavy-route population: the trigger fires only for a configured,
 * healthy route with no real model, once per status snapshot — a legacy
 * fabricated fallback counts as "no real model" so an already-written route
 * heals without a re-add.
 */
import { expect, it } from 'vitest'
import {
  LEGACY_FALLBACK_MODEL_IDS,
  autoPopulateDue,
  needsAutoPopulate,
  type AutoPopulateInput,
} from '../src/client/heavy-auto-populate.ts'

/** A due-check input for a healthy, configured route with no real models. */
function input(overrides: Partial<AutoPopulateInput> = {}): AutoPopulateInput {
  return {
    providerId: 'antigravity',
    configured: true,
    healthOk: true,
    checking: false,
    checkedAt: 1,
    modelIds: [],
    ...overrides,
  }
}

it('a route with no model, or only a fabricated legacy fallback, needs population', () => {
  expect(needsAutoPopulate('antigravity', [])).toBe(true)
  expect(needsAutoPopulate('antigravity', ['gemini-2.5-flash'])).toBe(true)
  expect(needsAutoPopulate('antigravity', [...LEGACY_FALLBACK_MODEL_IDS.antigravity!])).toBe(true)
  // A discovered model — even beside a legacy row — is a real catalog.
  expect(needsAutoPopulate('antigravity', ['gemini-3.1-pro-high'])).toBe(false)
  expect(needsAutoPopulate('antigravity', ['gemini-2.5-flash', 'gemini-3.1-pro-high'])).toBe(false)
  // A provider with no recorded fabricated fallback is populated only when empty.
  expect(needsAutoPopulate('freellmapi', [])).toBe(true)
  expect(needsAutoPopulate('freellmapi', ['auto'])).toBe(false)
  expect(needsAutoPopulate('mystery', ['anything'])).toBe(false)
})

it('the first healthy status check with an empty route is due', () => {
  expect(autoPopulateDue(undefined, input())).toBe(true)
})

it('a re-render, a cached snapshot, or an in-flight read never attempts twice', () => {
  const attempt = { providerId: 'antigravity', checkedAt: 7 }
  expect(autoPopulateDue(attempt, input({ checkedAt: 7 }))).toBe(false)
  expect(autoPopulateDue(attempt, input({ checkedAt: 7, checking: true }))).toBe(false)
})

it('a new status snapshot (a new health success) may attempt again while still empty', () => {
  const attempt = { providerId: 'antigravity', checkedAt: 7 }
  expect(autoPopulateDue(attempt, input({ checkedAt: 8 }))).toBe(true)
  // A different provider's snapshot is never mistaken for the recorded one.
  expect(autoPopulateDue(attempt, input({ providerId: 'freellmapi', checkedAt: 7 }))).toBe(true)
})

it('an unhealthy, unconfigured, busy, or populated route is never due', () => {
  expect(autoPopulateDue(undefined, input({ healthOk: false }))).toBe(false)
  expect(autoPopulateDue(undefined, input({ configured: false }))).toBe(false)
  expect(autoPopulateDue(undefined, input({ checking: true }))).toBe(false)
  expect(autoPopulateDue(undefined, input({ modelIds: ['gemini-3.1-pro-high'] }))).toBe(false)
})
