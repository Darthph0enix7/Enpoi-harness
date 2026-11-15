/**
 * The collapsing sidebar's editor-pane visibility as CSS text. jsdom has no
 * layout, so the seat specs pin the attributes the stylesheet keys on but
 * cannot show which declarations win; these read the declarations the collapse
 * depends on.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const css = readFileSync(
  fileURLToPath(new URL('../src/client/shell/SidebarRight.module.css', import.meta.url)),
  'utf8',
)

/** Declarations of one rule, whitespace-normalized (multi-line values stay one declaration). */
function declarationsFrom(source: string, selector: string): string[] {
  const declarationText = source.replace(/\/\*[\s\S]*?\*\//g, ' ')
  const escaped = selector.replace(/[.[\]():*+^$\\]/g, '\\$&')
  const rule = new RegExp(`(?:^|[{}])\\s*${escaped}\\s*\\{([^{}]*)\\}`).exec(declarationText)
  if (rule === null) throw new Error(`no \`${selector}\` rule`)
  return (rule[1] ?? '')
    .split(';')
    .map(part => part.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
}

describe('collapsed right sidebar', () => {
  it('lets the collapsed panel hide the editor pane instead of the pane pinning itself visible', () => {
    // The pane keeps `[data-sidebar-right-editor-open]` through a collapse so
    // the slide carries it; a `visible` pin in this rule then outlives the
    // panel's own hidden state and leaves the pane lit behind the rail.
    const openEditor = declarationsFrom(css, '.editor[data-sidebar-right-editor-open]')
    expect(openEditor).not.toContain('visibility: visible')
    expect(openEditor).toContain('visibility: inherit')
    // The panel flips hidden only after the slide, and `inherit` makes the
    // pane take that same moment.
    const panel = declarationsFrom(css, '.panel')
    expect(panel).toContain('visibility: hidden')
    // The slide is a consumer of the frame's registered progress value, not a
    // per-element transform transition: a retarget must not diverge from the
    // track. Only the delayed visibility flip stays a transition here.
    expect(panel).toContain('transform: translateX(calc(100% * (1 - var(--dsh-rightbar-progress, 0))))')
    expect(panel).toContain('transition: visibility 0s linear var(--ds-transition-duration-slow)')
  })
})

describe('compact surface bar', () => {
  it('spreads each bar target across the phone and caps only the tablet width', () => {
    const item = declarationsFrom(css, '.barItem')
    expect(item).toContain('flex: 1 1 0')
    expect(item).toContain('box-sizing: border-box')
    expect(item).toContain('min-width: 44px')
    expect(item).toContain('max-width: 88px')
    expect(item).toContain('min-height: 44px')
    expect(declarationsFrom(css, '.surfaceLabel')).toContain('max-width: 100%')
    expect(css).toContain('@media (min-width: 600px)')
    expect(css).toContain('max-width: 72px')
  })

  it('raises rail targets to 44px on coarse pointers', () => {
    const block = /@media \(pointer: coarse\)[\s\S]*?\.railButton\s*\{([^}]*)\}/.exec(css)
    expect(block).not.toBeNull()
    expect(block?.[1]).toContain('width: 44px')
    expect(block?.[1]).toContain('height: 44px')
  })

  it('wraps long surface labels to two full lines at 320px instead of clipping', () => {
    const label = declarationsFrom(css, '.surfaceLabel')
    expect(label).toContain('-webkit-line-clamp: 2')
    expect(label).toContain('line-height: 1.15')
    expect(label).not.toContain('white-space: nowrap')
  })

  it('removes the desktop rail and its centre reservation from the compact shell', () => {
    expect(declarationsFrom(css, ':global([data-mobile-frame]) .rail')).toContain('display: none')
    expect(css).toContain(':global(body[data-sidebar-right-rail-mounted]) :global([data-mobile-frame]) div:has(+ [data-rightbar-col])')
    expect(css).toContain('padding-right: 0')
  })
})
