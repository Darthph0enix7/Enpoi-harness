// @vitest-environment jsdom
/**
 * The served comparison as a document body: the unified and split drawings of
 * one file's Host-computed hunks, the word-level marks, the copy/plain
 * actions, the width-gated split opt-in, and the states that stand in for a
 * read that never settles.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WorkspaceFileDiff } from '@deepseek-ai/dsh-workspace-changes/types'
import { changesDiffUrl } from '../src/changes.ts'
import { DiffPreview, newSideText, type DiffPreviewProps } from '../src/client/diff-preview.tsx'
import { en } from '../src/client/locales.ts'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const SESSION = SessionId('s-view')
const CONTENT_ID = 'dsh-resource://file/session/s-view/src/a.ts'

/** The Host's comparison of one edited line, with one context line on each side. */
const DIFF: Extract<WorkspaceFileDiff, { kind: 'text' }> = {
  kind: 'text',
  path: 'src/a.ts',
  display: 'src/a.ts',
  before: true,
  after: true,
  coarse: false,
  hunks: [{
    oldStart: 3,
    oldLines: 3,
    newStart: 3,
    newLines: 3,
    lines: [' const a = 1', '-const b = 2', '+const b = 3', ' const c = 4'],
  }],
}

interface Harness {
  props: DiffPreviewProps
  openResource: ReturnType<typeof vi.fn>
  loaded: ReturnType<typeof vi.fn>
  loadChangesDiff: ReturnType<typeof vi.fn>
  setState: (state: unknown) => void
}

/**
 * Compose the body's props around one navigation request and one comparison
 * state, with the tab actions the actions call.
 * @param options - the navigation request and the initial comparison state.
 * @returns the props plus the spies the specs assert on.
 */
function harness(options: {
  params?: unknown
  state?: unknown
  revision?: number
} = {}): Harness {
  const store: Record<string, unknown> = {}
  const url = changesDiffUrl(SESSION, 7, 2)
  if (options.state !== undefined) store[url] = options.state
  const openResource = vi.fn()
  const loaded = vi.fn()
  const loadChangesDiff = vi.fn((_sessionId: unknown, _seq: number, _index: number) => {})
  const tab = {
    id: 'tab-1',
    title: 'src/a.ts',
    contentId: CONTENT_ID,
    navigation: {
      revision: options.revision ?? 1,
      params: options.params ?? { diff: { seq: 7, index: 2, turn: 3 } },
    },
    actions: { openResource },
  }
  const props = {
    useTabInfo: () => ({ tab }),
    useChangesDiff: <T,>(select: (state: Record<string, unknown>) => T): T => select(store),
    loadChangesDiff,
    content: { kind: 'renderer', revision: options.revision ?? 1, loaded, reload: vi.fn() },
    t: makeTranslate(en),
  } as unknown as DiffPreviewProps
  return {
    props, openResource, loaded, loadChangesDiff,
    setState: (state) => { store[url] = state },
  }
}

describe('diff-preview', () => {
  it('reassembles the new side of a comparison from the served hunks', () => {
    expect(newSideText(DIFF)).toBe('const a = 1\nconst b = 3\nconst c = 4')
    // A deletion and an unchanged comparison have no new side to copy.
    expect(newSideText({ ...DIFF, after: false })).toBeUndefined()
    expect(newSideText({ ...DIFF, hunks: [] })).toBeUndefined()
    // A creation has no removals, so every served line belongs to the new side.
    expect(newSideText({ ...DIFF, before: false, hunks: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 2, lines: ['+first', '+second'] }] }))
      .toBe('first\nsecond')
  })

  it('draws the served comparison with its header, word marks, and actions', () => {
    const h = harness({ state: DIFF })
    const { container } = render(<DiffPreview {...h.props} />)
    expect(container.querySelector('[data-document-diff]')?.getAttribute('data-document-diff-view')).toBe('unified')
    expect(screen.getByText('src/a.ts')).toBeTruthy()
    expect(screen.getByText('@@ -3,3 +3,3 @@')).toBeTruthy()
    expect([...container.querySelectorAll('[data-diff-line]')].map(row => row.getAttribute('data-diff-line')))
      .toEqual(['context', 'del', 'add', 'context'])
    expect(container.querySelectorAll('[class*="_wordDel_"]').length).toBe(1)
    expect(container.querySelectorAll('[class*="_wordAdd_"]').length).toBe(1)
    expect(screen.getByRole('button', { name: en['diffView.copyNew'] })).toBeTruthy()
    expect(screen.getByRole('button', { name: en['diffView.copyDiff'] })).toBeTruthy()
    expect(screen.getByRole('button', { name: en['diffView.plain'] })).toBeTruthy()
    // The split opt-in needs a wide pane; a narrow one never draws it.
    expect(screen.queryByRole('button', { name: en['review.split'] })).toBeNull()
    // The comparison was served from the shared store: no read is issued.
    expect(h.loadChangesDiff).not.toHaveBeenCalled()
  })

  it('offers the side-by-side opt-in only in a wide pane', () => {
    const width = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth')
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 900 })
    try {
      const h = harness({ state: DIFF })
      const { container } = render(<DiffPreview {...h.props} />)
      expect(container.querySelector('[data-document-diff]')?.getAttribute('data-document-diff-view')).toBe('unified')
      fireEvent.click(screen.getByRole('button', { name: en['review.split'] }))
      expect(container.querySelector('[data-document-diff]')?.getAttribute('data-document-diff-view')).toBe('split')
      expect(container.querySelectorAll('[data-diff-line]')).toHaveLength(3)
      fireEvent.click(screen.getByRole('button', { name: en['review.unified'] }))
      expect(container.querySelector('[data-document-diff]')?.getAttribute('data-document-diff-view')).toBe('unified')
    } finally {
      if (width === undefined) Reflect.deleteProperty(HTMLElement.prototype, 'clientWidth')
      else Object.defineProperty(HTMLElement.prototype, 'clientWidth', width)
    }
  })

  it('copies the new side of the file', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    const h = harness({ state: DIFF })
    render(<DiffPreview {...h.props} />)
    fireEvent.click(screen.getByRole('button', { name: en['diffView.copyNew'] }))
    await waitFor(() => { expect(writeText).toHaveBeenCalledWith('const a = 1\nconst b = 3\nconst c = 4') })
    expect(screen.getByRole('button', { name: en['diffView.copied'] })).toBeTruthy()
  })

  it('leaves the comparison for the plain file view through the navigation parameters', () => {
    const h = harness({ state: DIFF })
    render(<DiffPreview {...h.props} />)
    fireEvent.click(screen.getByRole('button', { name: en['diffView.plain'] }))
    expect(h.openResource).toHaveBeenCalledWith(CONTENT_ID, { params: {} })
  })

  it('keeps the split choice but falls back to unified when the pane narrows', () => {
    let width = 900
    const descriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth')
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => width })
    try {
      const h = harness({ state: DIFF })
      const { container } = render(<DiffPreview {...h.props} />)
      fireEvent.click(screen.getByRole('button', { name: en['review.split'] }))
      expect(container.querySelector('[data-document-diff]')?.getAttribute('data-document-diff-view')).toBe('split')
      width = 600
      fireEvent(window, new Event('resize'))
      expect(container.querySelector('[data-document-diff]')?.getAttribute('data-document-diff-view')).toBe('unified')
    } finally {
      if (descriptor === undefined) Reflect.deleteProperty(HTMLElement.prototype, 'clientWidth')
      else Object.defineProperty(HTMLElement.prototype, 'clientWidth', descriptor)
    }
  })

  it('reports the loaded revision to the document owner once the read settles', async () => {
    const h = harness({ state: DIFF })
    render(<DiffPreview {...h.props} />)
    await waitFor(() => { expect(h.loaded).toHaveBeenCalledWith('1') })
  })

  it('states the missing comparison and does not read again', () => {
    const h = harness({ state: 'missing' })
    render(<DiffPreview {...h.props} />)
    expect(screen.getByText(en['diff.missing'])).toBeTruthy()
    expect(h.loadChangesDiff).not.toHaveBeenCalled()
  })

  it('reads a comparison the store does not hold and offers a retry after a failure', () => {
    const h = harness({ state: 'error' })
    render(<DiffPreview {...h.props} />)
    expect(screen.getByText(en['diff.error'])).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en['presented.retry'] }))
    expect(h.loadChangesDiff).toHaveBeenCalledWith(SESSION, 7, 2)
  })

  it('carries no comparison without the navigation request', () => {
    const h = harness({ params: {} })
    render(<DiffPreview {...h.props} />)
    expect(screen.getByText(en['diffView.noRequest'])).toBeTruthy()
  })
})
