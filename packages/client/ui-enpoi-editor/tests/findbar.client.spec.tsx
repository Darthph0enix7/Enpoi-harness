// @vitest-environment jsdom
/**
 * The themed find bar over CodeMirror's search API: the match counter, the
 * stepping buttons, the case/regex toggles, and the keyboard contract
 * (`Enter`/`Shift-Enter`, `Esc`, `Mod-S` that must not be stolen).
 */
import { describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { EditorFindBar } from '../src/client/EditorFindBar.tsx'
import type { EditorFindBarProps } from '../src/client/EditorFindBar.tsx'

/** Props whose callbacks answer like the editor's search commands. */
function propsFor(overrides: Partial<EditorFindBarProps> = {}): {
  props: EditorFindBarProps
  onQuery: ReturnType<typeof vi.fn>
  onStep: ReturnType<typeof vi.fn>
  onClose: ReturnType<typeof vi.fn>
  onSave: ReturnType<typeof vi.fn>
} {
  const onQuery = vi.fn(() => ({ matches: 3, index: 0 }))
  const onStep = vi.fn(() => ({ matches: 3, index: 1 }))
  const onClose = vi.fn()
  const onSave = vi.fn()
  return {
    props: {
      onQuery: onQuery as unknown as EditorFindBarProps['onQuery'],
      onStep: onStep as unknown as EditorFindBarProps['onStep'],
      onClose,
      onSave,
      t: (key: string, params?: Record<string, unknown>) => (params === undefined
        ? key
        : `${key}(${Object.entries(params).map(([name, value]) => `${name}=${String(value)}`).join(',')})`),
      ...overrides,
    },
    onQuery,
    onStep,
    onClose,
    onSave,
  }
}

describe('editor find bar', () => {
  it('queries as the reader types, reports the count, and never prompts', () => {
    const { props, onQuery } = propsFor()
    const view = render(<EditorFindBar {...props} />)
    const field = view.container.querySelector<HTMLInputElement>('input')!
    fireEvent.change(field, { target: { value: 'one' } })
    expect(onQuery).toHaveBeenCalledWith('one', { caseSensitive: false, regexp: false })
    expect(view.container.querySelector('[data-enpoi-editor-find-count]')?.textContent).toBe('find.count(index=1,total=3)')
    cleanup()
  })

  it('says so when nothing matches', () => {
    const { props } = propsFor({ onQuery: (() => ({ matches: 0, index: 0 })) as unknown as EditorFindBarProps['onQuery'] })
    const view = render(<EditorFindBar {...props} />)
    fireEvent.change(view.container.querySelector<HTMLInputElement>('input')!, { target: { value: 'zzz' } })
    expect(view.container.querySelector('[data-enpoi-editor-find-count]')?.textContent).toBe('find.noMatch')
    cleanup()
  })

  it('steps next and previous through the matches', () => {
    const { props, onStep } = propsFor()
    const view = render(<EditorFindBar {...props} />)
    fireEvent.change(view.container.querySelector<HTMLInputElement>('input')!, { target: { value: 'one' } })
    fireEvent.click(view.container.querySelector('[data-enpoi-editor-find-next]')!)
    expect(onStep).toHaveBeenLastCalledWith(1)
    fireEvent.click(view.container.querySelector('[data-enpoi-editor-find-prev]')!)
    expect(onStep).toHaveBeenLastCalledWith(-1)
    expect(view.container.querySelector('[data-enpoi-editor-find-count]')?.textContent).toBe('find.count(index=2,total=3)')
    cleanup()
  })

  it('re-queries with the case and regex toggles pressed', () => {
    const { props, onQuery } = propsFor()
    const view = render(<EditorFindBar {...props} />)
    fireEvent.change(view.container.querySelector<HTMLInputElement>('input')!, { target: { value: 'One' } })
    const caseToggle = view.container.querySelector('[data-enpoi-editor-find-case]')!
    fireEvent.click(caseToggle)
    expect(caseToggle.getAttribute('aria-pressed')).toBe('true')
    expect(onQuery).toHaveBeenLastCalledWith('One', { caseSensitive: true, regexp: false })
    const regexToggle = view.container.querySelector('[data-enpoi-editor-find-regex]')!
    fireEvent.click(regexToggle)
    expect(regexToggle.getAttribute('aria-pressed')).toBe('true')
    expect(onQuery).toHaveBeenLastCalledWith('One', { caseSensitive: true, regexp: true })
    cleanup()
  })

  it('keeps the keyboard contract: Enter next, Shift-Enter previous, Esc close, Mod-S save', () => {
    const { props, onStep, onClose, onSave } = propsFor()
    const view = render(<EditorFindBar {...props} />)
    const field = view.container.querySelector<HTMLInputElement>('input')!
    fireEvent.keyDown(field, { key: 'Enter' })
    expect(onStep).toHaveBeenLastCalledWith(1)
    fireEvent.keyDown(field, { key: 'Enter', shiftKey: true })
    expect(onStep).toHaveBeenLastCalledWith(-1)
    fireEvent.keyDown(field, { key: 's', metaKey: true })
    expect(onSave).toHaveBeenCalledTimes(1)
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.keyDown(field, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
    cleanup()
  })
})
