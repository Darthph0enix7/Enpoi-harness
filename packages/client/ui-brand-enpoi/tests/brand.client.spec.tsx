// @vitest-environment jsdom
/**
 * Brand occupants — the fork's brand package renders both shell slots through
 * the shared ui-primitives EnpoiMark/EnpoiWordmark art.
 */
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { EnpoiBrandMark, EnpoiBrandName } from '../src/client/Brand.tsx'
import { brandT } from './brand-i18n.client.ts'

afterEach(cleanup)

describe('EnpoiBrandMark', () => {
  it('renders the primitive monogram at the shell-requested size and class', () => {
    const view = render(<EnpoiBrandMark size={34} className="hero-mark" />)
    const svg = view.container.querySelector('svg')!
    expect(svg.getAttribute('width')).toBe('34')
    expect(svg.getAttribute('height')).toBe('34')
    expect(svg.getAttribute('class')).toBe('hero-mark')
    expect(svg.getAttribute('aria-hidden')).toBe('true')
  })

  it('falls back to the 24px slot default without props', () => {
    const view = render(<EnpoiBrandMark />)
    expect(view.container.querySelector('svg')?.getAttribute('width')).toBe('24')
  })
})

describe('EnpoiBrandName', () => {
  it('renders the Enpoi over Harness wordmark from the dictionary', () => {
    const view = render(<EnpoiBrandName t={brandT} />)
    expect(view.getByText('Enpoi')).toBeTruthy()
    expect(view.getByText('Harness')).toBeTruthy()
  })
})
