/**
 * The editor's search overlay: match decorations, their reveal, and the
 * go-to-line flash.
 *
 * `@codemirror/search`'s own highlighter only decorates matches while its
 * built-in panel is open; the harness deliberately uses its own find bar, so
 * this module owns the decorations the bar promises: every collected match is
 * marked `cm-searchMatch`, the revealed one `cm-searchMatch-selected`, and the
 * theme (see {@link ../../../CodeMirrorEditor.tsx}) styles both. The overlay
 * state is one `StateField` rebuilt from a {@link setSearchOverlay} effect and
 * mapped through document changes, and revealing a match dispatches the
 * overlay, the selection, and the scroll target in one transaction so the
 * decoration exists before the view scrolls to it.
 */
import { StateEffect, StateField, type Extension, type Range, type Text } from '@codemirror/state'
import { Decoration, EditorView, type DecorationSet } from '@codemirror/view'
import type { SearchQuery } from '@codemirror/search'

/** How many matches a query found, and which of them the view is showing. */
export interface SearchMatches {
  /** Total matches in the document. */
  readonly matches: number
  /** 0-based position of the revealed match within the document's matches. */
  readonly index: number
}

/** One half-open match range, in document offsets. */
export interface SearchMatchRange {
  readonly from: number
  readonly to: number
}

/** The overlay's content: every match and the one the view is showing. */
export interface SearchOverlay {
  readonly ranges: readonly SearchMatchRange[]
  readonly index: number
}

/** Replace the match overlay, or clear it with `null`. */
export const setSearchOverlay = StateEffect.define<SearchOverlay | null>()

/** Light the go-to-line target line, or clear it with `null`. */
export const setGotoFlash = StateEffect.define<number | null>()

/** The revealed match's mark, so both classes are on one element. */
const selectedMatchMark = Decoration.mark({ class: 'cm-searchMatch cm-searchMatch-selected' })

/** A non-revealed match's mark. */
const matchMark = Decoration.mark({ class: 'cm-searchMatch' })

/** The go-to-line flash is a line decoration; the class carries its animation. */
const gotoFlashLine = Decoration.line({ class: 'cm-gotoFlash' })

/**
 * Build the decoration set for one overlay: every range marked, the revealed
 * one with the selected class.
 * @param overlay - the match ranges and the revealed index.
 * @returns the sorted decoration set the field publishes.
 */
export function matchDecorations(overlay: SearchOverlay): DecorationSet {
  const ranges: Range<Decoration>[] = []
  overlay.ranges.forEach((range, index) => {
    ranges.push((index === overlay.index ? selectedMatchMark : matchMark).range(range.from, range.to))
  })
  return Decoration.set(ranges, true)
}

/**
 * The overlay state: rebuilt when {@link setSearchOverlay} is dispatched and
 * mapped through document changes otherwise, so a decoration never outlives
 * the text it marks.
 */
export const searchOverlayField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(decorations, transaction) {
    let next = transaction.docChanged ? decorations.map(transaction.changes) : decorations
    for (const effect of transaction.effects) {
      if (effect.is(setSearchOverlay)) {
        next = effect.value === null ? Decoration.none : matchDecorations(effect.value)
      }
    }
    return next
  },
  provide: field => EditorView.decorations.from(field),
})

/** The go-to-line flash state: one line decoration, mapped or replaced. */
export const gotoFlashField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(flash, transaction) {
    let next = transaction.docChanged ? flash.map(transaction.changes) : flash
    for (const effect of transaction.effects) {
      if (effect.is(setGotoFlash)) {
        next = effect.value === null
          ? Decoration.none
          : Decoration.set([gotoFlashLine.range(transaction.state.doc.line(effect.value).from)])
      }
    }
    return next
  },
  provide: field => EditorView.decorations.from(field),
})

/**
 * Both overlay fields, for the editor's extension list.
 * @returns the search-overlay field and the go-to-line flash field.
 */
export function searchOverlayExtensions(): Extension[] {
  return [searchOverlayField, gotoFlashField]
}

/**
 * Collect one query's matches over a document, bounded by `limit`.
 *
 * A query whose regular expression is syntactically invalid has
 * `query.valid === false` and a cursor that would throw; this returns no
 * matches instead, which is the find bar's quiet empty state.
 * @param doc - the document to search.
 * @param query - the compiled query.
 * @param limit - the most ranges to collect; the counter saturates at it.
 * @returns the matches in document order, at most `limit` of them.
 */
export function collectMatches(doc: Text, query: SearchQuery, limit: number): SearchMatchRange[] {
  if (!query.valid) return []
  const matches: SearchMatchRange[] = []
  try {
    const cursor = query.getCursor(doc)
    for (let step = cursor.next(); !step.done && matches.length < limit; step = cursor.next()) {
      matches.push({ from: step.value.from, to: step.value.to })
    }
  } catch {
    // A malformed pattern the validity probe did not catch: no match, never a crash.
    return []
  }
  return matches
}

/**
 * Reveal one overlay match: decorate every range, select the revealed one, and
 * scroll it to the viewport's center in the same transaction, so the highlight
 * exists before the scroll is measured.
 * @param view - the editor view.
 * @param overlay - the match ranges and the revealed index.
 * @returns whether a match was revealed (an empty overlay dispatches nothing).
 */
export function revealMatch(view: EditorView, overlay: SearchOverlay): boolean {
  const match = overlay.ranges[overlay.index]
  if (match === undefined) return false
  view.dispatch({
    selection: { anchor: match.from, head: match.to },
    effects: [
      setSearchOverlay.of(overlay),
      EditorView.scrollIntoView(match.from, { y: 'center' }),
    ],
  })
  return true
}
