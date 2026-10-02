/**
 * Shared inset-list geometry contract: ui-theme's base.css owns the one rule
 * that keeps a scrolling `[role='listbox']` concentric with the rounded surface
 * that hosts it; the shared surfaces publish the radius/inset values and mark
 * themselves `data-dsh-list-surface`. A skin can then decorate surfaces without
 * painting a square band inside one. This spec pins the single owner and the
 * shared adopters so a new surface cannot reintroduce a per-component radius.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { packageStylesheets, parseRules, varReferences } from './stylesheet-scan.ts'

const root = fileURLToPath(new URL('../../../../', import.meta.url))

const base = parseRules(readFileSync(fileURLToPath(new URL('../src/styles/base.css', import.meta.url)), 'utf8'))
const rule = base.find(candidate => candidate.selectors.includes("[data-dsh-list-surface] [role='listbox']"))
const radius = rule?.declarations.find(([property]) => property === 'border-radius')?.[1] ?? ''

/** Shared surfaces that must carry the contract marker and publish its tokens. */
const adopters = [
  ['ui-primitives/src/MenuSurface.tsx', 'ui-primitives/src/MenuSurface.module.css'],
  ['ui-primitives/src/Sheet.tsx', 'ui-primitives/src/Sheet.module.css'],
  ['ui-primitives/src/Modal.tsx', 'ui-primitives/src/Modal.module.css'],
  ['ui-schedule/src/client/PickerPopover.tsx', 'ui-schedule/src/client/PickerPopover.module.css'],
] as const

const read = (relative: string): string => readFileSync(`${root}packages/client/${relative}`, 'utf8')

describe('shared inset-list geometry', () => {
  it('derives the nested list radius from the surface values in one theme rule', () => {
    expect(radius).toContain('max(0px, calc(')
    expect(radius).toContain('--dsh-surface-radius')
    expect(radius).toContain('--dsh-surface-inset')
    // The single owner reads both values through the standard fallbacks; a
    // missing surface radius falls back to the shared large tier, a missing
    // inset to zero.
    expect(varReferences(radius)).toContain('--dsw-radius-lg')
  })

  it('has every shared surface publish the marker and both values', () => {
    const failures = adopters.flatMap(([tsx, css]) => [
      ...read(tsx).includes('data-dsh-list-surface') ? [] : [`${tsx}: marker`],
      ...read(css).includes('--dsh-surface-radius') ? [] : [`${css}: --dsh-surface-radius`],
      ...read(css).includes('--dsh-surface-inset') ? [] : [`${css}: --dsh-surface-inset`],
    ])
    expect(failures).toEqual([])
  })

  it('keeps feature stylesheets from restating a nested listbox radius', () => {
    // ui-theme/src/styles owns the contract rule; component sheets consume the
    // tokens and never paint a list radius of their own.
    const failures = packageStylesheets().flatMap(file => file.includes('/src/styles/') ? [] : parseRules(readFileSync(file, 'utf8'))
      .filter(candidate => candidate.declarations.some(([property]) => property === 'border-radius')
        && candidate.selectors.some(selector => selector.includes("[role='listbox']")))
      .map(candidate => `${file.slice(file.indexOf('/packages/client/') + 17)}: ${candidate.selectors.join(', ')}`))
    expect(failures).toEqual([])
  })
})
