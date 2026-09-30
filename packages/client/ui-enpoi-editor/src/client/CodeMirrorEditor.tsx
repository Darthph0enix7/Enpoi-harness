/**
 * The CodeMirror 6 surface: a controlled-per-sync editor whose document lives
 * in the store.
 *
 * The view is created once per mount and then driven imperatively: programmatic
 * document replacement (external swap, reload) goes through {@link CodeMirrorHandle.setDoc},
 * while user keystrokes flow out through `onChange`. A reentrancy flag keeps a
 * programmatic transaction from being reported as a user edit, and the wrap and
 * read-only choices are compartments so flipping them never rebuilds the
 * document, undo history, or scroll position. An external replacement maps the
 * selection through the change by line and column, so the cursor stays where
 * the reader was instead of clamping to a raw offset; the selection and scroll
 * offsets stream out through `onViewState`, where the body preserves them
 * across a remount.
 */
import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'
import type { ReactNode } from 'react'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { Compartment, EditorState, type Extension } from '@codemirror/state'
import { EditorView, highlightActiveLine, highlightActiveLineGutter, keymap, lineNumbers } from '@codemirror/view'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { SearchQuery, search, setSearchQuery } from '@codemirror/search'
import { tags } from '@lezer/highlight'
import { languageForPath } from './languages.ts'
import {
  collectMatches, revealMatch, searchOverlayExtensions, setGotoFlash, setSearchOverlay,
  type SearchMatches, type SearchOverlay,
} from './search.ts'

export type { SearchMatches } from './search.ts'

/** The imperative surface the body uses to sync the view with the store. */
export interface CodeMirrorHandle {
  /** The current document text. */
  getDoc(): string
  /** Replace the whole document, mapping the selection through the change. */
  setDoc(text: string): void
  /** Flip line wrapping without rebuilding the view. */
  setWrap(wrapped: boolean): void
  /** Flip the read-only state without rebuilding the view. */
  setReadOnly(readOnly: boolean): void
  /** Focus the editing surface, for a find bar that is closing. */
  focusEditor(): void
  /** Move the cursor to a 1-based line, scroll it into view, and flash it briefly. */
  gotoLine(line: number): void
  /** Set the search query, highlight its matches, and reveal the first one. */
  setSearch(text: string, options: { readonly caseSensitive: boolean; readonly regexp: boolean }): SearchMatches
  /** Reveal the next match after the current one, wrapping once. */
  searchNext(): SearchMatches
  /** Reveal the previous match, wrapping once. */
  searchPrevious(): SearchMatches
  /** Clear the query and its match highlights. */
  clearSearch(): void
}

/** Matches above this count are not collected; the counter saturates. */
const MAX_SEARCH_MATCHES = 5000

/** How long the go-to-line target line stays lit after a jump, in ms. */
const GOTO_FLASH_MS = 1400

/** Props of the CodeMirror host. */
export interface CodeMirrorEditorProps {
  /** The addressed file's path, for grammar selection. */
  readonly path: string
  /** The document to open with (the dirty draft when one exists). */
  readonly initialDoc: string
  /** Whether long lines wrap. */
  readonly wrap: boolean
  /** Whether the buffer is read-only (a truncated prefix). */
  readonly readOnly: boolean
  /** The selection to restore on mount; the store kept it across the remount. */
  readonly initialSelection?: { readonly anchor: number; readonly head: number } | undefined
  /** The scroll offset to restore on mount. */
  readonly initialScrollTop?: number | undefined
  /** Called with the selection and scroll offsets whenever either moves. */
  readonly onViewState?: (view: { anchor: number; head: number; scrollTop: number }) => void
  /** Called with the document after every user edit. */
  readonly onChange: (text: string) => void
  /** Called when the editor's Mod-S binding fires. */
  readonly onSave: () => void
  /** Host class names from the mounting body; this chunk owns no stylesheet. */
  readonly className?: string | undefined
}

/** The read-only extensions of the editor's `readOnly` compartment. */
function readOnlyExtensions(readOnly: boolean): Extension[] {
  return [EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)]
}

/** The one document fact the offset mapping needs. */
interface OffsetSource {
  /** The line holding one offset, with the line's number and its start. */
  lineAt(pos: number): { number: number; from: number }
}

/**
 * Map one offset of `oldDoc` onto a document with `newLines`' shape, holding
 * the line and column: a line the new document lost clamps to its nearest
 * surviving end, and a column past a shortened line clamps to the line's end.
 * @param doc - the document the offset belongs to.
 * @param offset - the offset to move.
 * @param newLines - the replacement document's lines.
 * @returns the offset's counterpart in the new document.
 */
function mapOffsetThroughReplacement(doc: OffsetSource, offset: number, newLines: readonly string[]): number {
  const line = doc.lineAt(offset)
  const lineNumber = Math.min(line.number, newLines.length)
  const column = line.number === lineNumber ? offset - line.from : 0
  let mapped = 0
  for (let index = 0; index < lineNumber - 1; index++) mapped += (newLines[index]?.length ?? 0) + 1
  return mapped + Math.min(column, newLines[lineNumber - 1]?.length ?? 0)
}

/**
 * The editor's chrome, colored through the theme's shared tokens so it follows
 * the active light/dark scheme like every other surface.
 */
const editorTheme = EditorView.theme({
  '&': { color: 'var(--shiki-foreground)', backgroundColor: 'transparent', height: '100%' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': {
    fontFamily: 'var(--dsw-font-mono)',
    fontSize: '12px',
    lineHeight: '1.55',
  },
  '.cm-content': { caretColor: 'var(--shiki-foreground)', padding: '6px 0' },
  '.cm-gutters': {
    backgroundColor: 'transparent',
    color: 'var(--dsw-alias-label-tertiary)',
    border: 'none',
    borderRight: '1px solid var(--dsw-alias-border-l2)',
  },
  '.cm-activeLine': { backgroundColor: 'var(--dsw-alias-bg-layer-3)' },
  '.cm-activeLineGutter': { backgroundColor: 'var(--dsw-alias-bg-layer-3)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
    backgroundColor: 'var(--dsw-alias-interactive-bg-hover)',
  },
  // Search overlay: @codemirror/search's own highlighter only decorates while
  // its built-in panel is open, so these are the classes the search field's
  // marks carry; both schemes read them through the warn accent at two
  // strengths, the revealed match the stronger one.
  '.cm-searchMatch': {
    backgroundColor: 'color-mix(in srgb, var(--dsw-alias-state-warn-primary) 30%, transparent)',
    borderRadius: '2px',
  },
  '.cm-searchMatch.cm-searchMatch-selected': {
    backgroundColor: 'color-mix(in srgb, var(--dsw-alias-state-warn-primary) 60%, transparent)',
    outline: '1px solid color-mix(in srgb, var(--dsw-alias-state-warn-primary) 80%, transparent)',
  },
  // The go-to-line target: one line lit, fading out; the state field removes
  // the decoration after GOTO_FLASH_MS so a repeat jump flashes again.
  '.cm-gotoFlash': {
    animation: 'dsw-goto-line-flash 1.4s ease-out',
  },
  '@keyframes dsw-goto-line-flash': {
    from: { backgroundColor: 'color-mix(in srgb, var(--dsw-alias-state-warn-primary) 45%, transparent)' },
    to: { backgroundColor: 'transparent' },
  },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--shiki-foreground)' },
})

/** Token colors reuse the highlight palette the code preview already follows. */
const highlightStyle = HighlightStyle.define([
  { tag: [tags.comment, tags.lineComment, tags.blockComment, tags.docComment], color: 'var(--shiki-token-comment)' },
  { tag: [tags.keyword, tags.controlKeyword, tags.operatorKeyword, tags.modifier, tags.definitionKeyword], color: 'var(--shiki-token-keyword)' },
  { tag: [tags.string, tags.special(tags.string), tags.regexp], color: 'var(--shiki-token-string)' },
  { tag: [tags.number, tags.bool, tags.null, tags.atom], color: 'var(--shiki-token-constant)' },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName), tags.macroName], color: 'var(--shiki-token-function)' },
  { tag: [tags.variableName, tags.propertyName, tags.attributeName], color: 'var(--shiki-token-parameter)' },
  { tag: [tags.punctuation, tags.bracket, tags.separator], color: 'var(--shiki-token-punctuation)' },
  { tag: [tags.link, tags.url], color: 'var(--shiki-token-link)' },
  { tag: [tags.heading], color: 'var(--shiki-foreground)', fontWeight: '600' },
  { tag: [tags.emphasis], fontStyle: 'italic' },
  { tag: [tags.strong], fontWeight: '600' },
])

/**
 * Step through the collected matches, wrapping at either end.
 * @param view - the editor view, or `null` before it mounts.
 * @param state - the collected matches and the revealed index.
 * @param delta - `1` for the next match, `-1` for the previous.
 * @returns the match count and the newly revealed index.
 */
function stepSearch(
  view: EditorView | null,
  state: { matches: readonly { from: number; to: number }[]; index: number },
  delta: 1 | -1,
): SearchMatches {
  const total = state.matches.length
  if (view === null || total === 0) return { matches: total, index: state.index }
  const index = (state.index + delta + total) % total
  state.index = index
  revealMatch(view, { ranges: state.matches, index })
  return { matches: total, index }
}

/** The CodeMirror host: one view per mount, driven through its ref handle. */
export const CodeMirrorEditor = forwardRef<CodeMirrorHandle, CodeMirrorEditorProps>(
  function CodeMirrorEditor(props, ref): ReactNode {
    const hostRef = useRef<HTMLDivElement | null>(null)
    const viewRef = useRef<EditorView | null>(null)
    const wrapCompartment = useRef(new Compartment())
    const readOnlyCompartment = useRef(new Compartment())
    /** Set while a programmatic transaction runs, so it is not reported as an edit. */
    const applyingRef = useRef(false)
    const onChangeRef = useRef(props.onChange)
    onChangeRef.current = props.onChange
    const onSaveRef = useRef(props.onSave)
    onSaveRef.current = props.onSave
    const onViewStateRef = useRef(props.onViewState)
    onViewStateRef.current = props.onViewState
    /** The current query's matches, in document order, and the revealed index. */
    const searchRef = useRef<{ matches: readonly { from: number; to: number }[]; index: number }>({ matches: [], index: 0 })
    /** The pending go-to-line flash removal, if any. */
    const flashTimerRef = useRef<number | undefined>(undefined)
    // Mount-time inputs: the view is created once and then driven by the
    // effects/handle, so later prop changes must not re-create it.
    const initialRef = useRef({
      doc: props.initialDoc,
      path: props.path,
      wrap: props.wrap,
      readOnly: props.readOnly,
      selection: props.initialSelection,
      scrollTop: props.initialScrollTop,
    })

    useImperativeHandle(ref, () => ({
      getDoc: () => viewRef.current?.state.doc.toString() ?? '',
      setDoc: (text) => {
        const view = viewRef.current
        if (view === null || view.state.doc.toString() === text) return
        const selection = view.state.selection.main
        const newLines = text.split('\n')
        const anchor = mapOffsetThroughReplacement(view.state.doc, selection.anchor, newLines)
        const head = mapOffsetThroughReplacement(view.state.doc, selection.head, newLines)
        // A replaced document invalidates the collected matches: drop the
        // overlay with it instead of leaving marks on unrelated text.
        searchRef.current = { matches: [], index: 0 }
        applyingRef.current = true
        try {
          view.dispatch({
            changes: { from: 0, to: view.state.doc.length, insert: text },
            selection: { anchor, head },
            effects: setSearchOverlay.of(null),
          })
        } finally {
          applyingRef.current = false
        }
      },
      setWrap: (wrapped) => {
        viewRef.current?.dispatch({
          effects: wrapCompartment.current.reconfigure(wrapped ? EditorView.lineWrapping : []),
        })
      },
      setReadOnly: (readOnly) => {
        viewRef.current?.dispatch({
          effects: readOnlyCompartment.current.reconfigure(readOnlyExtensions(readOnly)),
        })
      },
      focusEditor: () => {
        viewRef.current?.focus()
      },
      gotoLine: (line) => {
        const view = viewRef.current
        if (view === null) return
        const target = Math.min(Math.max(Math.trunc(line), 1), view.state.doc.lines)
        const info = view.state.doc.line(target)
        view.dispatch({
          selection: { anchor: info.from },
          effects: [
            EditorView.scrollIntoView(info.from, { y: 'center' }),
            setGotoFlash.of(target),
          ],
        })
        view.focus()
        if (flashTimerRef.current !== undefined) window.clearTimeout(flashTimerRef.current)
        flashTimerRef.current = window.setTimeout(() => {
          flashTimerRef.current = undefined
          const active = viewRef.current
          if (active !== null) active.dispatch({ effects: setGotoFlash.of(null) })
        }, GOTO_FLASH_MS)
      },
      setSearch: (text, options) => {
        const view = viewRef.current
        if (view === null) return { matches: 0, index: 0 }
        const query = new SearchQuery({
          search: text,
          caseSensitive: options.caseSensitive,
          regexp: options.regexp,
          // A search field is literal text: never expand escape sequences.
          literal: true,
        })
        view.dispatch({ effects: setSearchQuery.of(query) })
        if (text === '' || !query.valid) {
          // Empty or syntactically invalid (an unbalanced regex group): the
          // bar's quiet empty state, never a thrown cursor.
          searchRef.current = { matches: [], index: 0 }
          view.dispatch({ effects: setSearchOverlay.of(null) })
          return { matches: 0, index: 0 }
        }
        const matches = collectMatches(view.state.doc, query, MAX_SEARCH_MATCHES)
        if (matches.length === 0) {
          searchRef.current = { matches: [], index: 0 }
          view.dispatch({ effects: setSearchOverlay.of(null) })
          return { matches: 0, index: 0 }
        }
        const anchor = view.state.selection.main.from
        const found = matches.findIndex(match => match.from >= anchor)
        const index = found === -1 ? 0 : found
        searchRef.current = { matches, index }
        const overlay: SearchOverlay = { ranges: matches, index }
        revealMatch(view, overlay)
        return { matches: matches.length, index }
      },
      searchNext: () => stepSearch(viewRef.current, searchRef.current, 1),
      searchPrevious: () => stepSearch(viewRef.current, searchRef.current, -1),
      clearSearch: () => {
        const view = viewRef.current
        searchRef.current = { matches: [], index: 0 }
        if (view === null) return
        view.dispatch({
          effects: [setSearchQuery.of(new SearchQuery({ search: '' })), setSearchOverlay.of(null)],
        })
      },
    }), [])

    useEffect(() => {
      const host = hostRef.current
      if (host === null) return undefined
      const initial = initialRef.current
      const state = EditorState.create({
        doc: initial.doc,
        extensions: [
          lineNumbers(),
          highlightActiveLine(),
          highlightActiveLineGutter(),
          history(),
          search(),
          ...searchOverlayExtensions(),
          EditorState.tabSize.of(2),
          EditorView.contentAttributes.of({ spellcheck: 'false' }),
          wrapCompartment.current.of(initial.wrap ? EditorView.lineWrapping : []),
          readOnlyCompartment.current.of(readOnlyExtensions(initial.readOnly)),
          editorTheme,
          syntaxHighlighting(highlightStyle),
          ...languageForPath(initial.path),
          keymap.of([
            { key: 'Mod-s', preventDefault: true, run: () => { onSaveRef.current(); return true } },
            ...defaultKeymap,
            ...historyKeymap,
          ]),
          EditorView.updateListener.of((update) => {
            if (update.docChanged && !applyingRef.current) onChangeRef.current(update.state.doc.toString())
            if (update.docChanged || update.selectionSet) {
              const selection = update.state.selection.main
              onViewStateRef.current?.({
                anchor: selection.anchor,
                head: selection.head,
                scrollTop: update.view.scrollDOM.scrollTop,
              })
            }
          }),
        ],
      })
      const view = new EditorView({ state, parent: host })
      viewRef.current = view
      const selection = initial.selection
      if (selection !== undefined && (selection.anchor !== 0 || selection.head !== 0)) {
        const length = view.state.doc.length
        view.dispatch({
          selection: {
            anchor: Math.min(selection.anchor, length),
            head: Math.min(selection.head, length),
          },
        })
      }
      const restoreScrollTop = initial.scrollTop
      if (restoreScrollTop !== undefined && restoreScrollTop > 0) {
        // The viewport has no extent until the first paint; restore after it.
        requestAnimationFrame(() => {
          if (viewRef.current === view) view.scrollDOM.scrollTop = restoreScrollTop
        })
      }
      const reportScroll = (): void => {
        const active = viewRef.current
        if (active === null) return
        const selection = active.state.selection.main
        onViewStateRef.current?.({
          anchor: selection.anchor,
          head: selection.head,
          scrollTop: active.scrollDOM.scrollTop,
        })
      }
      view.scrollDOM.addEventListener('scroll', reportScroll, { passive: true })
      return () => {
        view.scrollDOM.removeEventListener('scroll', reportScroll)
        if (flashTimerRef.current !== undefined) window.clearTimeout(flashTimerRef.current)
        view.destroy()
        viewRef.current = null
      }
    }, [])

    return <div ref={hostRef} className={props.className} data-enpoi-editor-cm />
  },
)
