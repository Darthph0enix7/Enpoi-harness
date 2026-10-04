// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MarkdownText } from './markdown-test-components.tsx'
import { markdownLabels } from './labels.client.ts'
import {
  expandRangeToWholeMath, rangeInsideOneCodeBlock, serializeSelectionToCleanHtml, serializeSelectionToMarkdown,
} from '../src/markdown/copy.ts'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

/** A document fragment from an HTML string, as `Range.cloneContents()` produces. */
function fragmentFromHtml(html: string): DocumentFragment {
  const template = document.createElement('template')
  template.innerHTML = html
  return template.content
}

/** Select `node`'s contents in the live document selection. */
function selectNodeContents(node: Node): void {
  const range = document.createRange()
  range.selectNodeContents(node)
  const selection = window.getSelection()
  selection?.removeAllRanges()
  selection?.addRange(range)
}

/** A bubbling `copy` event carrying a mocked clipboard. */
function copyEvent(clipboardData: { setData: (type: string, value: string) => void } | null): Event {
  const event = new Event('copy', { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'clipboardData', { value: clipboardData })
  return event
}

function plainOf(setData: ReturnType<typeof vi.fn>): string | undefined {
  return setData.mock.calls.find(call => call[0] === 'text/plain')?.[1] as string | undefined
}

function htmlOf(setData: ReturnType<typeof vi.fn>): string | undefined {
  return setData.mock.calls.find(call => call[0] === 'text/html')?.[1] as string | undefined
}

/** Labels selecting the CodeToolbar variant, whose language lives only in the DOM hook. */
const toolbarMarkdownLabels = {
  ...markdownLabels,
  code: {
    ...markdownLabels.code,
    toolbarLabels: { codeLabel: 'Code block', wrapLabel: 'Wrap lines', unwrapLabel: 'Do not wrap lines' },
  },
}

describe('serializeSelectionToMarkdown', () => {
  it('serializes inline marks, code, links, images, and hard breaks', () => {
    const fragment = fragmentFromHtml(
      '<p>plain <strong>bold</strong> <em>em</em> <del>gone</del> <code>inline</code>'
      + ' <a href="https://x.test/a">link</a> <img alt="alt" src="https://x.test/i.png"> tail<br>\nafter</p>',
    )

    expect(serializeSelectionToMarkdown(fragment)).toBe(
      'plain **bold** *em* ~~gone~~ `inline` [link](https://x.test/a)'
      + ' ![alt](https://x.test/i.png) tail\\\nafter',
    )
  })

  it('escapes inline code that contains backticks', () => {
    const fragment = fragmentFromHtml('<p><code>a`b</code> and <code>plain</code></p>')

    expect(serializeSelectionToMarkdown(fragment)).toBe('``a`b`` and `plain`')
  })

  it('unwraps file-mention and file-link buttons, keeping image buttons', () => {
    const mention = fragmentFromHtml(
      '<p><code><button type="button" title="index.html"><svg><path d="M0 0"></path></svg>index.html</button></code></p>',
    )
    expect(serializeSelectionToMarkdown(mention)).toBe('`index.html`')

    const fileLink = fragmentFromHtml('<p><button type="button"><svg></svg>out/a.ts</button></p>')
    expect(serializeSelectionToMarkdown(fileLink)).toBe('`out/a.ts`')

    const imageButton = fragmentFromHtml('<p><button type="button"><img alt="pic" src="p.png"></button></p>')
    expect(serializeSelectionToMarkdown(imageButton)).toBe('![pic](p.png)')
  })

  it('serializes headings, hr, and blockquotes', () => {
    const fragment = fragmentFromHtml(
      '<h1>Title</h1><h3>Sub</h3><hr><blockquote><p>quote one</p><p>quote two</p></blockquote>',
    )

    expect(serializeSelectionToMarkdown(fragment)).toBe('# Title\n\n### Sub\n\n---\n\n> quote one\n>\n> quote two')
  })

  it('serializes nested, ordered, and task lists', () => {
    const nested = fragmentFromHtml('<ul><li>one</li><li>two<ul><li>child</li></ul></li></ul>')
    expect(serializeSelectionToMarkdown(nested)).toBe('- one\n- two\n  - child')

    const ordered = fragmentFromHtml('<ol start="3"><li>three</li><li>four</li></ol>')
    expect(serializeSelectionToMarkdown(ordered)).toBe('3. three\n4. four')

    const orderedDefault = fragmentFromHtml('<ol><li>solo</li></ol>')
    expect(serializeSelectionToMarkdown(orderedDefault)).toBe('1. solo')

    const tasks = fragmentFromHtml(
      '<ul><li class="task-list-item"><input type="checkbox" checked disabled> tight</li>'
      + '<li class="task-list-item"><p><input type="checkbox" disabled> loose</p></li></ul>',
    )
    expect(serializeSelectionToMarkdown(tasks)).toBe('- [x]  tight\n- [ ]  loose')
  })

  it('indents loose item paragraphs and handles empty or list-only items', () => {
    const loose = fragmentFromHtml('<ul><li><p>first</p><p>second</p></li></ul>')
    expect(serializeSelectionToMarkdown(loose)).toBe('- first\n\n  second')

    const withMarkup = fragmentFromHtml('<ul><li><p><em>a</em> text</p></li></ul>')
    expect(serializeSelectionToMarkdown(withMarkup)).toBe('- *a* text')

    const spaced = fragmentFromHtml('<ul><li>\n<p>para</p>\n</li></ul>')
    expect(serializeSelectionToMarkdown(spaced)).toBe('- para')

    const listOnly = fragmentFromHtml('<ul><li><ul><li>only</li></ul></li></ul>')
    expect(serializeSelectionToMarkdown(listOnly)).toBe('-\n  - only')

    const empty = fragmentFromHtml('<ul><li></li></ul>')
    expect(serializeSelectionToMarkdown(empty)).toBe('-')
  })

  it('serializes GFM tables with alignment markers and escaped pipes', () => {
    const fragment = fragmentFromHtml(
      '<table><thead><tr>'
      + '<th style="text-align: left">Left</th><th style="text-align: center">Center</th>'
      + '<th style="text-align: right">Right</th><th>None</th></tr></thead>'
      + '<tbody><tr><td>a</td><td>b</td><td>c</td><td>d|e</td></tr></tbody></table>',
    )

    expect(serializeSelectionToMarkdown(fragment)).toBe(
      '| Left | Center | Right | None |\n| :--- | :---: | ---: | --- |\n| a | b | c | d\\|e |',
    )
  })

  it('handles tables without rows and cells that are neither th nor td', () => {
    expect(serializeSelectionToMarkdown(fragmentFromHtml('<table></table>'))).toBe('')

    const table = document.createElement('table')
    table.innerHTML = '<tr><td>a\nb</td></tr><tr><td>c</td></tr>'
    table.querySelector('tr')?.append(document.createElement('span'))
    const fragment = document.createDocumentFragment()
    fragment.append(table)
    expect(serializeSelectionToMarkdown(fragment)).toBe('| a b |\n| --- |\n| c |')
  })

  it('serializes code fences with their language and skips card chrome', () => {
    const card = fragmentFromHtml(
      '<div class="md-code-block"><div class="bannerWrap"><div class="infostring">ts</div>'
      + '<div class="action"><button>复制</button></div></div><div data-code-block-content>'
      + '<pre><code>const a = 1</code></pre></div></div>',
    )
    expect(serializeSelectionToMarkdown(card)).toBe('```ts\nconst a = 1\n```')

    const fromClass = fragmentFromHtml(
      '<div class="md-code-block"><div class="infostring"></div><pre><code class="language-js">let x = 1</code></pre></div>',
    )
    expect(serializeSelectionToMarkdown(fromClass)).toBe('```js\nlet x = 1\n```')

    const bare = fragmentFromHtml('<pre><code>plain</code></pre>')
    expect(serializeSelectionToMarkdown(bare)).toBe('```\nplain\n```')

    const trailing = fragmentFromHtml('<pre><code>a\n</code></pre>')
    expect(serializeSelectionToMarkdown(trailing)).toBe('```\na\n```')

    const noPre = fragmentFromHtml('<div class="md-code-block"></div>')
    expect(serializeSelectionToMarkdown(noPre)).toBe('')

    const noCode = fragmentFromHtml('<pre>raw text</pre>')
    expect(serializeSelectionToMarkdown(noCode)).toBe('```\nraw text\n```')
  })

  it('returns raw text for a selection wholly inside one code block', () => {
    const fragment = fragmentFromHtml('<pre><code>const a = 1\nconst b = 2</code></pre>')

    expect(serializeSelectionToMarkdown(fragment, { rawCode: true })).toBe('const a = 1\nconst b = 2')
    expect(serializeSelectionToMarkdown(fragment, {})).toBe('```\nconst a = 1\nconst b = 2\n```')
  })

  it('serializes footnote references and the footnote section', () => {
    const section = fragmentFromHtml(
      '<section data-footnotes><h2 class="sr-only">Footnotes</h2><ol><li>'
      + '<p>note body</p><p>second ↩ <sup>2</sup></p></li></ol></section>',
    )
    expect(serializeSelectionToMarkdown(section)).toBe('[^1]: note body\n    \n    second ↩')

    const noList = fragmentFromHtml('<section><h2>Footnotes</h2></section>')
    expect(serializeSelectionToMarkdown(noList)).toBe('')

    const reference = fragmentFromHtml('<p>first<sup>1</sup> and again<sup>1</sup></p>')
    expect(serializeSelectionToMarkdown(reference)).toBe('first[^1] and again[^1]')

    const standalone = fragmentFromHtml('<sup>7</sup>')
    expect(serializeSelectionToMarkdown(standalone)).toBe('[^7]')
  })

  it('serializes KaTeX annotations and error spans, never glyph trees', () => {
    const inline = fragmentFromHtml(
      '<p>a <span class="katex"><span class="katex-mathml">'
      + '<annotation encoding="application/x-tex">x^2</annotation></span>'
      + '<span class="katex-html">x2</span></span> b</p>',
    )
    expect(serializeSelectionToMarkdown(inline)).toBe('a $x^2$ b')

    const display = fragmentFromHtml(
      '<div><span class="katex-display"><span class="katex"><span class="katex-mathml">'
      + '<annotation encoding="application/x-tex">12</annotation></span></span></span></div>',
    )
    expect(serializeSelectionToMarkdown(display)).toBe('$$12$$')

    const error = fragmentFromHtml('<p><span class="katex-error" style="color: #cc0000">\\frac{</span></p>')
    expect(serializeSelectionToMarkdown(error)).toBe('$\\frac{$')

    const noAnnotation = fragmentFromHtml('<p><span class="katex">raw</span></p>')
    expect(serializeSelectionToMarkdown(noAnnotation)).toBe('$raw$')
  })

  it('renders unknown elements, SVGs, comments, and checkboxes as text', () => {
    const unknown = fragmentFromHtml('<p><mark>marked</mark> <u>under</u> and <b>b</b></p>')
    expect(serializeSelectionToMarkdown(unknown)).toBe('marked under and **b**')

    const svg = fragmentFromHtml('<p>a<svg><path d="M0 0"></path></svg>b<!-- c --></p>')
    expect(serializeSelectionToMarkdown(svg)).toBe('ab')

    const checkboxes = fragmentFromHtml('<p><input type="checkbox" checked> <input type="checkbox"></p>')
    expect(serializeSelectionToMarkdown(checkboxes)).toBe('')

    const missing = fragmentFromHtml('<p><a>text</a> <img></p>')
    expect(serializeSelectionToMarkdown(missing)).toBe('[text]() ![]()')
  })

  it('keeps whitespace text runs inside inline content but drops block separators', () => {
    const separated = fragmentFromHtml('<p>a</p>\n<p>b</p>')
    expect(serializeSelectionToMarkdown(separated)).toBe('a\n\nb')

    const inlineWhitespace = fragmentFromHtml('<p>a <!----> b</p>')
    expect(serializeSelectionToMarkdown(inlineWhitespace)).toBe('a  b')

    const topLevel = fragmentFromHtml('a <!----> ')
    expect(serializeSelectionToMarkdown(topLevel)).toBe('a')

    const introThenBlock = fragmentFromHtml('intro<p>para</p>')
    expect(serializeSelectionToMarkdown(introThenBlock)).toBe('intro\n\npara')
  })
})

describe('serializeSelectionToCleanHtml', () => {
  it('replaces every KaTeX tree with its TeX delimiters', () => {
    const fragment = fragmentFromHtml(
      '<p>a <span class="katex"><annotation encoding="application/x-tex">x</annotation>glyphs</span>'
      + ' <span class="katex-display"><span class="katex">'
      + '<annotation encoding="application/x-tex">12</annotation>glyphs</span></span></p>',
    )

    const html = serializeSelectionToCleanHtml(fragment)

    expect(html).toContain('$x$')
    expect(html).toContain('$$12$$')
    expect(html).not.toContain('katex')
    expect(html).not.toContain('glyphs')
  })

  it('replaces error math with its TeX-delimited source so both targets agree', () => {
    const source = '<p><span class="katex-error" style="color: #cc0000">\\frac{</span></p>'
    const html = serializeSelectionToCleanHtml(fragmentFromHtml(source))

    expect(html).toContain('$\\frac{$')
    expect(html).not.toContain('katex-error')
    expect(serializeSelectionToMarkdown(fragmentFromHtml(source))).toBe('$\\frac{$')
  })
})

describe('expandRangeToWholeMath', () => {
  it('expands a boundary sitting inside an inline formula', () => {
    const host = document.createElement('div')
    host.innerHTML = '<p>before <span class="katex"><span class="katex-mathml">'
      + '<annotation encoding="application/x-tex">x</annotation></span></span> after</p>'
    document.body.append(host)
    const paragraph = host.querySelector('p') as HTMLParagraphElement
    const before = paragraph.firstChild as Text
    const after = paragraph.lastChild as Text
    const annotation = host.querySelector('annotation')?.firstChild as Text

    const startInside = document.createRange()
    startInside.setStart(annotation, 0)
    startInside.setEnd(after, 6)
    expandRangeToWholeMath(startInside)
    expect(startInside.startContainer).toBe(paragraph)
    expect(startInside.startOffset).toBe(1)
    expect(startInside.endContainer).toBe(after)
    expect(startInside.endOffset).toBe(6)
    expect(serializeSelectionToMarkdown(startInside.cloneContents())).toBe('$x$ after')

    const endInside = document.createRange()
    endInside.setStart(before, 2)
    endInside.setEnd(annotation, 1)
    expandRangeToWholeMath(endInside)
    expect(endInside.startContainer).toBe(before)
    expect(endInside.startOffset).toBe(2)
    expect(endInside.endContainer).toBe(paragraph)
    expect(endInside.endOffset).toBe(2)
    expect(serializeSelectionToMarkdown(endInside.cloneContents())).toBe('fore $x$')
    host.remove()
  })

  it('expands a boundary inside display math to the whole wrapper', () => {
    const host = document.createElement('div')
    host.innerHTML = '<p><span class="katex-display"><span class="katex">'
      + '<annotation encoding="application/x-tex">y</annotation></span></span></p>'
    document.body.append(host)
    const paragraph = host.querySelector('p') as HTMLParagraphElement
    const annotation = host.querySelector('annotation')?.firstChild as Text

    const range = document.createRange()
    range.setStart(annotation, 0)
    range.setEnd(annotation, 1)
    expandRangeToWholeMath(range)

    expect(range.startContainer).toBe(paragraph)
    expect(range.startOffset).toBe(0)
    expect(range.endContainer).toBe(paragraph)
    expect(range.endOffset).toBe(1)
    expect(serializeSelectionToMarkdown(range.cloneContents())).toBe('$$y$$')
    host.remove()
  })

  it('leaves ranges with detached boundaries untouched', () => {
    const detached = document.createTextNode('x')
    const range = document.createRange()
    range.setStart(detached, 0)
    range.setEnd(detached, 1)

    expandRangeToWholeMath(range)

    expect(range.startContainer).toBe(detached)
    expect(range.endContainer).toBe(detached)
  })
})

describe('rangeInsideOneCodeBlock', () => {
  it('detects a selection wholly inside one code block', () => {
    const host = document.createElement('div')
    host.innerHTML = '<div class="md-code-block"><div><pre><code>const a = 1</code></pre></div></div>'
    document.body.append(host)
    const code = host.querySelector('code') as HTMLElement
    const range = document.createRange()
    range.selectNodeContents(code)

    expect(rangeInsideOneCodeBlock(range)).toBe(true)
    host.remove()
  })

  it('rejects selections reaching outside or spanning two code blocks', () => {
    const host = document.createElement('div')
    host.innerHTML = '<p>out</p><pre><code>a</code></pre><pre><code>b</code></pre>'
    document.body.append(host)
    const outside = host.querySelector('p')?.firstChild as Text
    const first = host.querySelector('code') as HTMLElement
    const second = host.querySelectorAll('code')[1] as HTMLElement

    const reaching = document.createRange()
    reaching.setStart(outside, 0)
    reaching.setEnd(first.firstChild as Text, 1)
    expect(rangeInsideOneCodeBlock(reaching)).toBe(false)

    const spanning = document.createRange()
    spanning.setStart(first.firstChild as Text, 0)
    spanning.setEnd(second.firstChild as Text, 1)
    expect(rangeInsideOneCodeBlock(spanning)).toBe(false)

    const detached = document.createTextNode('x')
    const detachedRange = document.createRange()
    detachedRange.setStart(detached, 0)
    detachedRange.setEnd(detached, 1)
    expect(rangeInsideOneCodeBlock(detachedRange)).toBe(false)
    host.remove()
  })
})

describe('MarkdownText copy handling', () => {
  it('writes markdown and KaTeX-free html for a selection in the container', () => {
    const view = render(<MarkdownText text={'instant **$4** · first\n\nmath $E = mc^2$ end'} />)
    const markdown = view.container.firstElementChild as HTMLElement
    selectNodeContents(markdown)
    const setData = vi.fn()
    const event = copyEvent({ setData })

    markdown.dispatchEvent(event)

    expect(event.defaultPrevented).toBe(true)
    expect(plainOf(setData)).toBe('instant **$4** · first\n\nmath $E = mc^2$ end')
    expect(htmlOf(setData)).toContain('$E = mc^2$')
    expect(htmlOf(setData)).not.toContain('katex')
  })

  it('expands a selection boundary inside a formula before serializing', () => {
    const view = render(<MarkdownText text={'before $x^2$ after'} />)
    const markdown = view.container.firstElementChild as HTMLElement
    const annotation = markdown.querySelector('annotation')?.firstChild as Text
    const range = document.createRange()
    range.setStart(annotation, 1)
    range.setEnd(annotation, 3)
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
    const setData = vi.fn()
    const event = copyEvent({ setData })

    markdown.dispatchEvent(event)

    expect(plainOf(setData)).toBe('$x^2$')
  })

  it('copies a selection wholly inside a fence as raw code', () => {
    const view = render(<MarkdownText text={'```ts\nconst a = 1\nconst b = 2\n```'} />)
    const markdown = view.container.firstElementChild as HTMLElement
    selectNodeContents(markdown.querySelector('pre code') as HTMLElement)
    const setData = vi.fn()
    const event = copyEvent({ setData })

    markdown.dispatchEvent(event)

    expect(plainOf(setData)).toBe('const a = 1\nconst b = 2')
  })

  it('leaves the native path alone without a clipboard, a selection, or an intersection', () => {
    const view = render(<MarkdownText text={'plain **text**'} />)
    const markdown = view.container.firstElementChild as HTMLElement
    selectNodeContents(markdown)

    const noClipboard = copyEvent(null)
    markdown.dispatchEvent(noClipboard)
    expect(noClipboard.defaultPrevented).toBe(false)

    const other = document.createElement('p')
    other.textContent = 'outside'
    document.body.append(other)
    selectNodeContents(other)
    const setData = vi.fn()
    const outside = copyEvent({ setData })
    markdown.dispatchEvent(outside)
    expect(outside.defaultPrevented).toBe(false)
    expect(setData).not.toHaveBeenCalled()
    other.remove()

    window.getSelection()?.removeAllRanges()
    const collapsed = copyEvent({ setData })
    markdown.dispatchEvent(collapsed)
    expect(collapsed.defaultPrevented).toBe(false)
    expect(setData).not.toHaveBeenCalled()
  })

  it('falls back to the native path when serialization throws', () => {
    const view = render(<MarkdownText text={'plain **text**'} />)
    const markdown = view.container.firstElementChild as HTMLElement
    selectNodeContents(markdown)
    vi.spyOn(Range.prototype, 'cloneContents').mockImplementation(() => { throw new Error('boom') })
    const setData = vi.fn()
    const event = copyEvent({ setData })

    markdown.dispatchEvent(event)

    expect(event.defaultPrevented).toBe(false)
    expect(setData).not.toHaveBeenCalled()
  })

  it('copies a toolbar-variant fence with its language hook', () => {
    const view = render(<MarkdownText labels={toolbarMarkdownLabels} text={'```ts\nconst a = 1\n```'} />)
    const markdown = view.container.firstElementChild as HTMLElement
    expect(markdown.querySelector('[data-code-block-content]')?.getAttribute('data-language')).toBe('ts')
    selectNodeContents(markdown)
    const setData = vi.fn()
    const event = copyEvent({ setData })

    markdown.dispatchEvent(event)

    expect(plainOf(setData)).toBe('```ts\nconst a = 1\n```')
  })

  it('falls back to a bare fence when the toolbar variant has no language', () => {
    const view = render(<MarkdownText labels={toolbarMarkdownLabels} text={'```\nno language here\n```'} />)
    const markdown = view.container.firstElementChild as HTMLElement
    expect(markdown.querySelector('[data-code-block-content]')?.getAttribute('data-language')).toBe('')
    selectNodeContents(markdown)
    const setData = vi.fn()
    const event = copyEvent({ setData })

    markdown.dispatchEvent(event)

    expect(plainOf(setData)).toBe('```\nno language here\n```')
  })
})
