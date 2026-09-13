/**
 * The CodeMirror 6 surface: a controlled-per-sync editor whose document lives
 * in the store.
 *
 * The view is created once per mount and then driven imperatively: programmatic
 * document replacement (external swap, reload) goes through {@link CodeMirrorHandle.setDoc},
 * while user keystrokes flow out through `onChange`. A reentrancy flag keeps a
 * programmatic transaction from being reported as a user edit, and the wrap and
 * read-only choices are compartments so flipping them never rebuilds the
 * document, undo history, or scroll position.
 */
import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'
import type { ReactNode } from 'react'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { Compartment, EditorState, type Extension } from '@codemirror/state'
import { EditorView, keymap, lineNumbers } from '@codemirror/view'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { tags } from '@lezer/highlight'
import { languageForPath } from './languages.ts'
import css from './EditorBody.module.css'

/** The imperative surface the body uses to sync the view with the store. */
export interface CodeMirrorHandle {
  /** The current document text. */
  getDoc(): string
  /** Replace the whole document, keeping the selection clamped inside it. */
  setDoc(text: string): void
  /** Flip line wrapping without rebuilding the view. */
  setWrap(wrapped: boolean): void
  /** Flip the read-only state without rebuilding the view. */
  setReadOnly(readOnly: boolean): void
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
  /** Called with the document after every user edit. */
  readonly onChange: (text: string) => void
  /** Called when the editor's Mod-S binding fires. */
  readonly onSave: () => void
}

/** The read-only extensions of the editor's `readOnly` compartment. */
function readOnlyExtensions(readOnly: boolean): Extension[] {
  return [EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)]
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
    // Mount-time inputs: the view is created once and then driven by the
    // effects/handle, so later prop changes must not re-create it.
    const initialRef = useRef({
      doc: props.initialDoc,
      path: props.path,
      wrap: props.wrap,
      readOnly: props.readOnly,
    })

    useImperativeHandle(ref, () => ({
      getDoc: () => viewRef.current?.state.doc.toString() ?? '',
      setDoc: (text) => {
        const view = viewRef.current
        if (view === null || view.state.doc.toString() === text) return
        const { anchor, head } = view.state.selection.main
        applyingRef.current = true
        try {
          view.dispatch({
            changes: { from: 0, to: view.state.doc.length, insert: text },
            selection: { anchor: Math.min(anchor, text.length), head: Math.min(head, text.length) },
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
          }),
        ],
      })
      const view = new EditorView({ state, parent: host })
      viewRef.current = view
      return () => {
        view.destroy()
        viewRef.current = null
      }
    }, [])

    return <div ref={hostRef} className={css.editor} data-enpoi-editor-cm />
  },
)
