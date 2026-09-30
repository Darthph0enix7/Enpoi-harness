/**
 * The editor's search overlay and its controller helpers: match collection for
 * both toggles, the decoration classes the theme styles, the reveal dispatch
 * (selection + scroll), the go-to-line flash, and the invalid-regex path that
 * must stay quiet instead of throwing.
 */
import { describe, expect, it, vi } from 'vitest'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { SearchQuery } from '@codemirror/search'
import {
  collectMatches, gotoFlashField, matchDecorations, revealMatch, searchOverlayField, setGotoFlash, setSearchOverlay,
} from '../src/client/search.ts'
import type { SearchMatchRange } from '../src/client/search.ts'

const DOC = ['alpha needle one', 'NEEDLE two', 'word42 and word7', 'needle three'].join('\n')
/** Offsets of DOC's needles: line starts 0, 17, 28, 45; the match itself 6..12, 17..23, 45..51. */
const NEEDLES_INSENSITIVE: SearchMatchRange[] = [
  { from: 6, to: 12 },
  { from: 17, to: 23 },
  { from: 45, to: 51 },
]

/** Read every marked range out of a decoration set. */
function markedRanges(state: EditorState): Array<{ from: number; to: number; class: string }> {
  const marks: Array<{ from: number; to: number; class: string }> = []
  state.field(searchOverlayField).between(0, state.doc.length, (from, to, value) => {
    marks.push({ from, to, class: String(value.spec.class) })
  })
  return marks
}

/** Read every flash line out of the flash field. */
function flashedLines(state: EditorState): Array<{ from: number; class: string }> {
  const lines: Array<{ from: number; class: string }> = []
  state.field(gotoFlashField).between(0, state.doc.length, (from, _to, value) => {
    lines.push({ from, class: String(value.spec.class) })
  })
  return lines
}

function query(search: string, options: { caseSensitive?: boolean; regexp?: boolean } = {}): SearchQuery {
  return new SearchQuery({
    search,
    literal: true,
    ...options.caseSensitive === undefined ? {} : { caseSensitive: options.caseSensitive },
    ...options.regexp === undefined ? {} : { regexp: options.regexp },
  })
}

describe('collectMatches', () => {
  it('finds every occurrence case-insensitively by default', () => {
    expect(collectMatches(EditorState.create({ doc: DOC }).doc, query('needle'), 100)).toEqual(NEEDLES_INSENSITIVE)
  })

  it('honours the case toggle in both directions', () => {
    const doc = EditorState.create({ doc: DOC }).doc
    expect(collectMatches(doc, query('needle', { caseSensitive: true }), 100))
      .toEqual([NEEDLES_INSENSITIVE[0], NEEDLES_INSENSITIVE[2]])
    expect(collectMatches(doc, query('NEEDLE', { caseSensitive: true }), 100))
      .toEqual([{ from: 17, to: 23 }])
    expect(collectMatches(doc, query('NEEDLE', { caseSensitive: false }), 100)).toEqual(NEEDLES_INSENSITIVE)
  })

  it('honours the regex toggle and its case interaction', () => {
    const doc = EditorState.create({ doc: DOC }).doc
    expect(collectMatches(doc, query('word\\d+', { regexp: true }), 100))
      .toEqual([{ from: 28, to: 34 }, { from: 39, to: 44 }])
    expect(collectMatches(doc, query('WORD\\d+', { regexp: true, caseSensitive: true }), 100)).toEqual([])
    expect(collectMatches(doc, query('WORD\\d+', { regexp: true, caseSensitive: false }), 100))
      .toEqual([{ from: 28, to: 34 }, { from: 39, to: 44 }])
  })

  it('returns no matches for an invalid regular expression, never a throw', () => {
    const doc = EditorState.create({ doc: DOC }).doc
    expect(() => collectMatches(doc, query('(', { regexp: true }), 100)).not.toThrow()
    expect(collectMatches(doc, query('(', { regexp: true }), 100)).toEqual([])
    expect(collectMatches(doc, query('[a-', { regexp: true }), 100)).toEqual([])
  })

  it('saturates at the caller\'s limit', () => {
    const doc = EditorState.create({ doc: DOC }).doc
    expect(collectMatches(doc, query('needle'), 2)).toEqual(NEEDLES_INSENSITIVE.slice(0, 2))
  })
})

describe('searchOverlayField', () => {
  it('marks every match and the selected one with the theme\'s classes', () => {
    const state = EditorState.create({ doc: DOC, extensions: [searchOverlayField] })
    const next = state.update({
      effects: setSearchOverlay.of({ ranges: NEEDLES_INSENSITIVE, index: 1 }),
    })
    expect(markedRanges(next.state)).toEqual([
      { from: 6, to: 12, class: 'cm-searchMatch' },
      { from: 17, to: 23, class: 'cm-searchMatch cm-searchMatch-selected' },
      { from: 45, to: 51, class: 'cm-searchMatch' },
    ])
  })

  it('clears on null and maps marks through a document change', () => {
    const state = EditorState.create({ doc: DOC, extensions: [searchOverlayField] })
    const marked = state.update({ effects: setSearchOverlay.of({ ranges: NEEDLES_INSENSITIVE, index: 0 }) }).state
    // An insertion at the top pushes every mark by its length.
    const shifted = marked.update({ changes: { from: 0, insert: 'xx' } }).state
    expect(markedRanges(shifted)[0]).toEqual({ from: 8, to: 14, class: 'cm-searchMatch cm-searchMatch-selected' })
    const cleared = shifted.update({ effects: setSearchOverlay.of(null) }).state
    expect(markedRanges(cleared)).toEqual([])
  })

  it('builds the same classes through matchDecorations directly', () => {
    const decorations = matchDecorations({ ranges: NEEDLES_INSENSITIVE, index: 2 })
    const classes: string[] = []
    decorations.between(0, DOC.length, (_from, _to, value) => { classes.push(String(value.spec.class)) })
    expect(classes).toEqual(['cm-searchMatch', 'cm-searchMatch', 'cm-searchMatch cm-searchMatch-selected'])
  })
})

describe('revealMatch', () => {
  it('dispatches the overlay, the match selection, and a centered scroll in one transaction', () => {
    const scroll = vi.spyOn(EditorView, 'scrollIntoView')
    const dispatch = vi.fn()
    const view = { dispatch } as unknown as EditorView
    revealMatch(view, { ranges: NEEDLES_INSENSITIVE, index: 1 })
    expect(scroll).toHaveBeenCalledWith(NEEDLES_INSENSITIVE[1]!.from, { y: 'center' })
    expect(dispatch).toHaveBeenCalledTimes(1)
    const spec = dispatch.mock.calls[0]![0] as { selection: unknown; effects: Array<{ is: (type: unknown) => boolean }> }
    expect(spec.selection).toEqual({ anchor: 17, head: 23 })
    expect(spec.effects.some(effect => effect.is(setSearchOverlay))).toBe(true)
    scroll.mockRestore()
  })

  it('dispatches nothing for an empty overlay', () => {
    const dispatch = vi.fn()
    const view = { dispatch } as unknown as EditorView
    expect(revealMatch(view, { ranges: [], index: 0 })).toBe(false)
    expect(dispatch).not.toHaveBeenCalled()
  })
})

describe('gotoFlashField', () => {
  it('lights the target line and clears it again', () => {
    const state = EditorState.create({ doc: DOC, extensions: [gotoFlashField] })
    const flashed = state.update({ effects: setGotoFlash.of(2) }).state
    expect(flashedLines(flashed)).toEqual([{ from: 17, class: 'cm-gotoFlash' }])
    const cleared = flashed.update({ effects: setGotoFlash.of(null) }).state
    expect(flashedLines(cleared)).toEqual([])
  })

  it('clamps nothing: the field reads the line at dispatch time', () => {
    const state = EditorState.create({ doc: DOC, extensions: [gotoFlashField] })
    const flashed = state.update({ effects: setGotoFlash.of(4) }).state
    expect(flashedLines(flashed)).toEqual([{ from: 45, class: 'cm-gotoFlash' }])
  })
})
