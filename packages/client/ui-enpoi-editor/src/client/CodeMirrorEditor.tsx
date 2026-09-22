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
import { EditorView, keymap, lineNumbers } from '@codemirror/view'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { gotoLine, openSearchPanel, search, searchKeymap } from '@codemirror/search'
import { tags } from '@lezer/highlight'
import { languageForPath } from './languages.ts'
import css from './EditorBody.module.css'

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
  /** Open the search panel, the toolbar's Find in file. */
  find(): void
  /** Prompt for a line and move the cursor there, the toolbar's Go to line. */
  gotoLine(): void
}

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
        applyingRef.current = true
        try {
          view.dispatch({
            changes: { from: 0, to: view.state.doc.length, insert: text },
            selection: { anchor, head },
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
      find: () => {
        const view = viewRef.current
        if (view === null) return
        openSearchPanel(view)
        view.focus()
      },
      gotoLine: () => {
        const view = viewRef.current
        if (view === null) return
        void gotoLine(view)
        view.focus()
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
          history(),
          search(),
          EditorState.tabSize.of(2),
          EditorView.contentAttributes.of({ spellcheck: 'false' }),
          wrapCompartment.current.of(initial.wrap ? EditorView.lineWrapping : []),
          readOnlyCompartment.current.of(readOnlyExtensions(initial.readOnly)),
          editorTheme,
          syntaxHighlighting(highlightStyle),
          ...languageForPath(initial.path),
          keymap.of([
            { key: 'Mod-s', preventDefault: true, run: () => { onSaveRef.current(); return true } },
            ...searchKeymap,
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
        view.destroy()
        viewRef.current = null
      }
    }, [])

    return <div ref={hostRef} className={css.editor} data-enpoi-editor-cm />
  },
)
