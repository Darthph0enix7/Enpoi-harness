/** Source-line helpers shared by the plain renderer and the document scroller. */
import type { DocumentTextPage } from '../document/contract.ts'
import type { TextPage } from '../store.ts'

/**
 * Split a loaded page into its source lines.
 * @param page - source page.
 * @returns its lines, preserving one empty line but excluding a zero-line page.
 */
export function linesOf(page: TextPage): string[] {
  return page.lines === 0 ? [] : page.text.split('\n')
}

/** Loaded source page with its 1-based start position. */
export type LoadedPage = DocumentTextPage

/**
 * Order loaded pages by source position.
 * @param pages - stored page table.
 * @returns pages in source order.
 */
export function loadedPages(pages: Readonly<Record<number, TextPage>>): LoadedPage[] {
  return Object.entries(pages)
    .map(([offset, page]) => ({ offset: Number(offset), ...page }))
    .sort((left, right) => left.offset - right.offset)
}

/**
 * Find the end of the loaded source prefix.
 * @param pages - ordered pages.
 * @returns the last loaded source line, or zero.
 */
export function lastLineLoaded(pages: readonly LoadedPage[]): number {
  const last = pages.at(-1)
  return last === undefined ? 0 : last.offset + last.lines - 1
}

/**
 * Reveal a plain-text or highlighted source line.
 * @param body - scrolling document body or code-content viewport.
 * @param line - 1-based source line to reveal.
 * @returns Whether the current renderer exposes that line.
 */
export function scrollToLine(body: HTMLElement, line: number): boolean {
  const innerCode = body.hasAttribute('data-code-block-content')
  const plain = body.querySelector(`[data-textpreview-line="${line}"]`)
  const code = innerCode ? body.querySelectorAll('pre .line').item(line - 1) : null
  const row = plain ?? code
  if (!(row instanceof HTMLElement)) return false
  body.scrollTop = Math.max(0, row.offsetTop)
  return true
}

/**
 * Every loaded source line holding a term, in source order; matching ignores
 * case, like an editor's smart search.
 * @param pages - ordered loaded pages.
 * @param term - the text to find, compared lowercased.
 * @returns the 1-based lines holding a match.
 */
export function findLinesOf(pages: readonly LoadedPage[], term: string): readonly number[] {
  const needle = term.toLowerCase()
  if (needle === '') return []
  const matches: number[] = []
  for (const page of pages) {
    const lines = linesOf(page)
    for (let index = 0; index < lines.length; index++) {
      if ((lines[index] ?? '').toLowerCase().includes(needle)) matches.push(page.offset + index)
    }
  }
  return matches
}
