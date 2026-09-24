/**
 * The editor's find surface: our own themed bar over CodeMirror's search API.
 *
 * The default CodeMirror panel is deliberately not used: this bar draws with
 * the harness tokens and monochrome icons, reports a readable match counter,
 * and keeps the keyboard contract — `Enter` next, `Shift-Enter` previous,
 * `Esc` closes, and `Mod-S` still saves while the field holds focus.
 */
import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import clsx from 'clsx'
import {
  IconChevronDownOutlineRegular, IconChevronUpOutlineRegular, IconCloseOutlineMedium, IconSearchOutlineMedium, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { IconCase16, IconRegex16 } from './icons.tsx'
import type { SearchMatches } from './CodeMirrorEditor.tsx'
import css from './EditorFindBar.module.css'

/** The bar's inputs: the editor's search commands and the toolbar's copy. */
export interface EditorFindBarProps {
  /** Set the query and reveal the first match. */
  readonly onQuery: (text: string, options: { readonly caseSensitive: boolean; readonly regexp: boolean }) => SearchMatches
  /** Reveal the next (`1`) or previous (`-1`) match. */
  readonly onStep: (delta: 1 | -1) => SearchMatches
  /** Close the bar and clear the highlights. */
  readonly onClose: () => void
  /** Save the buffer, so `Mod-S` keeps working from the find field. */
  readonly onSave: () => void
  readonly t: PropsLocale<'enpoiEditor'>['t']
}

/**
 * The themed find bar, rendered above the editing surface.
 * @param props - search commands, close/save callbacks, and copy.
 * @returns the search row.
 */
export function EditorFindBar({ onQuery, onStep, onClose, onSave, t }: EditorFindBarProps): ReactNode {
  const [text, setText] = useState('')
  const [caseSensitive, setCaseSensitive] = useState(false)
  const [regexp, setRegexp] = useState(false)
  const [result, setResult] = useState<SearchMatches>({ matches: 0, index: 0 })
  const inputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => { inputRef.current?.focus() }, [])

  const query = (nextText: string, nextCase: boolean, nextRegexp: boolean): void => {
    setResult(onQuery(nextText, { caseSensitive: nextCase, regexp: nextRegexp }))
  }

  const counter = text === ''
    ? null
    : result.matches === 0
      ? t('find.noMatch')
      : t('find.count', { index: result.index + 1, total: result.matches })

  return (
    <div className={css.bar} data-enpoi-editor-find role="search">
      <IconSearchOutlineMedium size={14} className={css.icon} />
      <input
        ref={inputRef}
        className={css.input}
        value={text}
        placeholder={t('find.placeholder')}
        aria-label={t('find.placeholder')}
        spellCheck={false}
        autoComplete="off"
        onChange={(event) => { setText(event.target.value); query(event.target.value, caseSensitive, regexp) }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') { event.preventDefault(); onClose(); return }
          if (event.key === 'Enter') { event.preventDefault(); setResult(onStep(event.shiftKey ? -1 : 1)); return }
          if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') { event.preventDefault(); onSave() }
        }}
      />
      {counter !== null && (
        <span className={css.count} data-enpoi-editor-find-count>{counter}</span>
      )}
      <Tooltip label={t('find.previous')} side="bottom" delayMs={400}>
        <button
          type="button"
          className={css.button}
          aria-label={t('find.previous')}
          data-enpoi-editor-find-prev
          onClick={() => { setResult(onStep(-1)) }}
        >
          <IconChevronUpOutlineRegular size={14} />
        </button>
      </Tooltip>
      <Tooltip label={t('find.next')} side="bottom" delayMs={400}>
        <button
          type="button"
          className={css.button}
          aria-label={t('find.next')}
          data-enpoi-editor-find-next
          onClick={() => { setResult(onStep(1)) }}
        >
          <IconChevronDownOutlineRegular size={14} />
        </button>
      </Tooltip>
      <Tooltip label={t('find.case')} side="bottom" delayMs={400}>
        <button
          type="button"
          className={clsx(css.button, caseSensitive && css.pressed)}
          aria-pressed={caseSensitive}
          aria-label={t('find.case')}
          data-enpoi-editor-find-case
          onClick={() => { const next = !caseSensitive; setCaseSensitive(next); query(text, next, regexp) }}
        >
          <IconCase16 />
        </button>
      </Tooltip>
      <Tooltip label={t('find.regex')} side="bottom" delayMs={400}>
        <button
          type="button"
          className={clsx(css.button, regexp && css.pressed)}
          aria-pressed={regexp}
          aria-label={t('find.regex')}
          data-enpoi-editor-find-regex
          onClick={() => { const next = !regexp; setRegexp(next); query(text, caseSensitive, next) }}
        >
          <IconRegex16 />
        </button>
      </Tooltip>
      <Tooltip label={t('find.close')} side="bottom" delayMs={400}>
        <button
          type="button"
          className={css.button}
          aria-label={t('find.close')}
          data-enpoi-editor-find-close
          onClick={onClose}
        >
          <IconCloseOutlineMedium size={14} />
        </button>
      </Tooltip>
    </div>
  )
}
