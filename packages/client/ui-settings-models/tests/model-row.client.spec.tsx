// @vitest-environment jsdom
/** The model row's provider-tag markers and the raw tag data it exposes. */
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ModelRow } from '../src/client/ModelRow.tsx'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

/** One collapsed row over the caller's draft, with inert actions. */
function renderRow(model: Record<string, unknown>): HTMLElement {
  const { container } = render(
    <ModelRow
      model={model}
      position={1}
      inputField="input"
      expanded={false}
      disabled={false}
      t={key => en[key]}
      contextWindow={{ value: '', placeholder: '256K', onChange: vi.fn() }}
      maxTokens={{ value: '', placeholder: '32K', onChange: vi.fn() }}
      onFieldChange={vi.fn()}
      onChange={vi.fn()}
      onToggle={vi.fn()}
      onRemove={vi.fn()}
    />,
  )
  return container
}

/** The `YYYY-MM-DD` day `offsetDays` from now. */
function isoDay(offsetDays: number): string {
  return new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10)
}

describe('model row tags', () => {
  it('marks a release inside the new-model window and exposes its date', () => {
    const released = isoDay(-5)
    const container = renderRow({ id: 'm', releaseDate: released })
    expect(container.querySelector('[data-release-date]')?.getAttribute('data-release-date')).toBe(released)
    expect(container.querySelector('[data-model-badge="new"]')?.textContent).toBe(en.modelNewBadge)
  })

  it('does not mark an old, future, or unreadable release date', () => {
    for (const releaseDate of [isoDay(-120), isoDay(3), 'soon']) {
      expect(renderRow({ id: 'm', releaseDate }).querySelector('[data-model-badge="new"]')).toBeNull()
    }
  })

  it('marks a price tier at or above 200K and exposes the tiers', () => {
    const tiers = [{ inputTokensAbove: 200_000, input: 4, output: 24 }]
    const container = renderRow({ id: 'm', costTiers: tiers })
    expect(container.querySelector('[data-cost-tiers]')?.getAttribute('data-cost-tiers')).toBe(JSON.stringify(tiers))
    const badge = container.querySelector('[data-model-badge="usage-tier"]')
    expect(badge?.textContent).toBe(en.modelTieredPricingBadge)
    expect(badge?.getAttribute('title')).toBe(en.modelTieredPricingHint)
  })

  it('does not mark a lower tier or malformed tier data', () => {
    for (const costTiers of [[{ inputTokensAbove: 128_000, input: 3 }], [{ inputTokensAbove: '200000' }], 'nope']) {
      expect(renderRow({ id: 'm', costTiers }).querySelector('[data-model-badge="usage-tier"]')).toBeNull()
    }
  })

  it('marks a model the sync kept only because something references it', () => {
    const container = renderRow({ id: 'm', deprecated: true, source: 'pinned-in-use' })
    const badge = container.querySelector('[data-model-badge="deprecated"]')
    expect(badge?.textContent).toBe(en.modelDeprecatedBadge)
    expect(badge?.getAttribute('title')).toBe(en.modelDeprecatedHint)
    expect(renderRow({ id: 'm', deprecated: false }).querySelector('[data-model-badge="deprecated"]')).toBeNull()
  })

  it('shows both markers together and neither on a plain row', () => {
    const both = renderRow({
      id: 'm',
      releaseDate: isoDay(-1),
      costTiers: [{ inputTokensAbove: 200_000, input: 4 }],
    })
    expect(both.querySelectorAll('[data-model-badge]')).toHaveLength(2)
    expect(renderRow({ id: 'plain' }).querySelectorAll('[data-model-badge]')).toHaveLength(0)
  })
})
