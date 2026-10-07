// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import * as primitives from '@deepseek-ai/dsh-client-ui-primitives'

afterEach(cleanup)

describe('EnpoiMark', () => {
  it('renders the monogram tile with the fork gradients at the square default size', () => {
    const view = render(<primitives.EnpoiMark />)
    const svg = view.container.querySelector('svg')!
    expect(svg.getAttribute('width')).toBe('24')
    expect(svg.getAttribute('height')).toBe('24')
    expect(svg.getAttribute('viewBox')).toBe('0 0 32 32')
    expect(svg.getAttribute('aria-hidden')).toBe('true')
    expect(view.container.querySelector('#enpoi-grad-border')).not.toBeNull()
    expect(view.container.querySelector('#enpoi-grad-fill')).not.toBeNull()
    expect(view.container.querySelector('path')?.getAttribute('fill')).toBe('url(#enpoi-grad-fill)')
  })

  it('honors an explicit size and forwards the layout class', () => {
    const view = render(<primitives.EnpoiMark size={34} className="hero-mark" />)
    const svg = view.container.querySelector('svg')!
    expect(svg.getAttribute('width')).toBe('34')
    expect(svg.getAttribute('height')).toBe('34')
    expect(svg.getAttribute('class')).toBe('hero-mark')
  })
})

describe('EnpoiWordmark', () => {
  it('renders the gradient brand word over the secondary suffix', () => {
    const view = render(<primitives.EnpoiWordmark />)
    expect(view.getByText('Enpoi')).toBeTruthy()
    expect(view.getByText('Harness')).toBeTruthy()
  })
})
