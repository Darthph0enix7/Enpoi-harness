// capability-overrides.spec.ts — the session override store: projection fold,
// per-kind edits, and the effective defaults ⊕ overrides computation.

import { describe, it, expect } from 'vitest'
import {
  applyCapabilityOverridesProjection, effectiveCapability, effectiveCapabilitiesState,
  withCapabilityOverride, EMPTY_CAPABILITY_OVERRIDES, type CapabilityOverrideRecord,
} from '../src/capability-overrides'
import type { CapabilitiesState } from '../src/types'

const DEFAULTS: CapabilitiesState = {
  tools: { bash: true, edit: false, oracle_review: true },
  skills: { 'tier1-workflow': true, 'ue-mcp': false },
  mcp: { 'plane-mcp': true },
}

describe('capabilityOverrides projection', () => {
  it('folds the complete post-change record', () => {
    const next = applyCapabilityOverridesProjection(EMPTY_CAPABILITY_OVERRIDES, {
      type: 'capabilities/overrides',
      data: { skills: { a: false }, tools: { bash: false }, mcp: { x: true } },
    } as never)
    expect(next).toEqual({ skills: { a: false }, tools: { bash: false }, mcp: { x: true } })
  })

  it('ignores other events and keeps the same reference', () => {
    const state: CapabilityOverrideRecord = { skills: {}, tools: {}, mcp: {} }
    expect(applyCapabilityOverridesProjection(state, { type: 'mcp/mounts', data: { mounted: [] } } as never)).toBe(state)
  })
})

describe('withCapabilityOverride', () => {
  it('sets and unsets one key without touching the other families', () => {
    const base: CapabilityOverrideRecord = { skills: { a: false }, tools: { bash: false }, mcp: {} }
    const set = withCapabilityOverride(base, 'skills', 'b', true)
    expect(set).toEqual({ skills: { a: false, b: true }, tools: { bash: false }, mcp: {} })
    const reset = withCapabilityOverride(set, 'skills', 'a', null)
    expect(reset).toEqual({ skills: { b: true }, tools: { bash: false }, mcp: {} })
    // The base record is untouched (fresh objects).
    expect(base.skills).toEqual({ a: false })
  })

  it('edits the mcp family too', () => {
    const next = withCapabilityOverride(EMPTY_CAPABILITY_OVERRIDES, 'mcp', 'plane-mcp', false)
    expect(next.mcp).toEqual({ 'plane-mcp': false })
  })
})

describe('effectiveCapability', () => {
  it('prefers the override and falls back to the default', () => {
    const overrides = withCapabilityOverride(EMPTY_CAPABILITY_OVERRIDES, 'skills', 'ue-mcp', true)
    expect(effectiveCapability('skills', 'ue-mcp', DEFAULTS.skills, overrides)).toBe(true)
    expect(effectiveCapability('skills', 'tier1-workflow', DEFAULTS.skills, overrides)).toBe(true)
    expect(effectiveCapability('tools', 'edit', DEFAULTS.tools, overrides)).toBe(false)
    expect(effectiveCapability('tools', 'missing', DEFAULTS.tools, overrides)).toBeUndefined()
  })
})

describe('effectiveCapabilitiesState', () => {
  it('merges every family over the defaults', () => {
    const overrides: CapabilityOverrideRecord = {
      skills: { 'ue-mcp': true },
      tools: { edit: true, bash: false },
      mcp: { 'plane-mcp': false },
    }
    const effective = effectiveCapabilitiesState(DEFAULTS, overrides)
    expect(effective.skills).toEqual({ 'tier1-workflow': true, 'ue-mcp': true })
    expect(effective.tools).toEqual({ bash: false, edit: true, oracle_review: true })
    expect(effective.mcp).toEqual({ 'plane-mcp': false })
    // The defaults are untouched.
    expect(DEFAULTS.tools.bash).toBe(true)
    expect(DEFAULTS.skills['ue-mcp']).toBe(false)
  })
})
