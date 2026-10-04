// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { MarkdownText } from './markdown-test-components.tsx'

afterEach(cleanup)

function containerFor(text: string): HTMLElement {
  return render(<MarkdownText text={text} />).container
}

describe('single-dollar currency guard', () => {
  it('renders the reported line as bold text, not math', () => {
    const container = containerFor('instant **$4** · fast/auto **$7**')

    expect(container.querySelector('.katex')).toBeNull()
    expect([...container.querySelectorAll('strong')].map(node => node.textContent)).toEqual(['$4', '$7'])
    expect(container.textContent).toBe('instant $4 · fast/auto $7')
  })

  it.each([
    'Prices $4–$7 here',
    'Pay US$4 today',
    'digit2$b$c',
    '$x$5',
    '$ x $',
    '$5 $',
    '$\tx$',
    '$x\t$',
  ])('rejects a currency-shaped span: %s', (text) => {
    const container = containerFor(text)

    expect(container.querySelector('.katex')).toBeNull()
    expect(container.textContent).toBe(text)
  })

  it.each(['$2x$', '$-1$', '$1/2$', '$E = mc^2$', '$5$', '$x$'])('keeps legitimate math: %s', (text) => {
    const container = containerFor(text)

    expect(container.querySelector('.katex')).not.toBeNull()
    expect(container.querySelector('annotation')?.textContent).toBe(text.slice(1, -1))
  })

  it('rejects a span crossing a line ending', () => {
    const container = containerFor('Runaway $a\nb$ across lines')

    expect(container.querySelector('.katex')).toBeNull()
    expect(container.textContent).toBe('Runaway $a\nb$ across lines')
  })

  it('keeps display dollars, escaped dollars, and backslash delimiters', () => {
    const display = containerFor('$$12$$')
    expect(display.querySelector('.katex-display')).not.toBeNull()
    expect(display.querySelector('annotation')?.textContent).toBe('12')

    const escaped = containerFor(String.raw`cost \$4 now`)
    expect(escaped.querySelector('.katex')).toBeNull()
    expect(escaped.textContent).toBe('cost $4 now')

    const backslash = containerFor(String.raw`value \(\frac{1}{2}\) end`)
    expect(backslash.querySelector('.katex')).not.toBeNull()
    expect(backslash.querySelector('annotation')?.textContent).toBe(String.raw`\frac{1}{2}`)
  })

  it('leaves multi-dollar inline spans to upstream, padding included', () => {
    const container = containerFor('a $$ x $$ b')

    expect(container.querySelector('.katex')).not.toBeNull()
    expect(container.querySelector('annotation')?.textContent).toBe('x')
  })
})
