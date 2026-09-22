// @vitest-environment jsdom
/**
 * The editor's segment of the pane's single toolbar row: the save state, the
 * save icon (dirty or auto-save off), and the auto-save icon toggle with its
 * pressed state and persisted choice. The save icon only raises a store
 * request; the editing body consumes it.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { useSyncExternalStore } from 'react'
import { sessionFileAddress } from '@deepseek-ai/dsh-util-workspace-path'
import type { FileSnapshot } from '../src/client/fsops.ts'
import { AUTOSAVE_KEY } from '../src/client/prefs.ts'
import { createEditorStore } from '../src/client/store.ts'
import { EditorToolbar } from '../src/client/EditorToolbar.tsx'
import type { EditorToolbarProps } from '../src/client/EditorToolbar.tsx'

const TAB = 'tab-1'
const ADDRESS = sessionFileAddress('session-1', 'notes.md')

/** A snapshot fixture. */
function snapshot(content: string, sha256 = 'sha-1', mtimeMs = 1000): FileSnapshot {
  return { content, sha256, mtimeMs, size: content.length, truncated: false }
}

afterEach(() => { cleanup(); localStorage.clear() })

/**
 * Compose the toolbar props around one live store instance, as the framework
 * would for the keyed toolbar seat.
 */
function propsFor(
  store: ReturnType<ReturnType<typeof createEditorStore>['create']>,
  compact = false,
): EditorToolbarProps {
  const abort = new AbortController()
  return {
    compact,
    rendererId: 'enpoi-editor',
    useStore: (selector: (state: ReturnType<typeof store.getSnapshot>) => unknown) => selector(
      useSyncExternalStore(store.subscribe, store.getSnapshot),
    ),
    actions: store.actions,
    t: (key: string, params?: Record<string, unknown>) => (params === undefined
      ? key
      : `${key}(${Object.entries(params).map(([name, value]) => `${name}=${String(value)}`).join(',')})`),
    useTabInfo: () => ({
      sidebar: { expanded: true, fullscreen: false },
      panel: { id: 'pane-1' },
      tab: {
        id: TAB,
        kind: 'text',
        title: 'notes.md',
        contentId: ADDRESS,
        visible: true,
        navigation: { address: ADDRESS, params: undefined, revision: 0 },
        signal: abort.signal,
        actions: { openResource: () => {}, openTab: () => {}, close: () => {} },
      },
    }),
  } as unknown as EditorToolbarProps
}

/** A ready, clean bucket with the persisted auto-save choice applied. */
function readyStore(): ReturnType<ReturnType<typeof createEditorStore>['create']> {
  const store = createEditorStore().create()
  store.actions.attach(ADDRESS, TAB)
  store.actions.synced(ADDRESS, snapshot('hello'))
  return store
}

describe('editor toolbar segment', () => {
  it('renders the auto-save icon toggle in its pressed state, icon only', () => {
    const store = readyStore()
    store.actions.autoSaveSet(ADDRESS, true)
    const { container } = render(<EditorToolbar {...propsFor(store)} />)
    const toggle = container.querySelector('[data-enpoi-editor-autosave]')!
    expect(toggle.getAttribute('aria-pressed')).toBe('true')
    expect(toggle.querySelector('svg')).not.toBeNull()
    expect(toggle.textContent).toBe('')
    cleanup()
  })

  it('toggles auto-save and persists the choice under the documented key', () => {
    const store = readyStore()
    store.actions.autoSaveSet(ADDRESS, true)
    const view = render(<EditorToolbar {...propsFor(store)} />)
    fireEvent.click(view.container.querySelector('[data-enpoi-editor-autosave]')!)
    expect(view.container.querySelector('[data-enpoi-editor-autosave]')?.getAttribute('aria-pressed')).toBe('false')
    expect(store.getSnapshot().byAddress[ADDRESS]?.autoSave).toBe(false)
    expect(localStorage.getItem(AUTOSAVE_KEY)).toBe('off')
    cleanup()
  })

  it('offers the save icon only while dirty or with auto-save off', () => {
    const store = readyStore()
    store.actions.autoSaveSet(ADDRESS, true)
    const view = render(<EditorToolbar {...propsFor(store)} />)
    expect(view.container.querySelector('[data-enpoi-editor-save]')).toBeNull()
    act(() => { store.actions.edited(ADDRESS, 'hello!') })
    expect(view.container.querySelector('[data-enpoi-editor-save]')).not.toBeNull()
    act(() => { store.actions.synced(ADDRESS, snapshot('hello!')) })
    act(() => { store.actions.autoSaveSet(ADDRESS, false) })
    expect(view.container.querySelector('[data-enpoi-editor-save]')).not.toBeNull()
    cleanup()
  })

  it('raises a store save request instead of touching the editor directly', () => {
    const store = readyStore()
    store.actions.autoSaveSet(ADDRESS, true)
    store.actions.edited(ADDRESS, 'hello!')
    const view = render(<EditorToolbar {...propsFor(store)} />)
    fireEvent.click(view.container.querySelector('[data-enpoi-editor-save]')!)
    expect(store.getSnapshot().byAddress[ADDRESS]?.saveRequests).toBe(1)
    cleanup()
  })

  it('reports the save state: unsaved, saving, saved, and failed', () => {
    const store = readyStore()
    store.actions.autoSaveSet(ADDRESS, true)
    const view = render(<EditorToolbar {...propsFor(store)} />)
    act(() => { store.actions.edited(ADDRESS, 'hello!') })
    expect(view.container.querySelector('[data-enpoi-editor-dirty]')?.textContent).toBe('unsaved')
    act(() => { store.actions.saving(ADDRESS) })
    expect(view.container.querySelector('[data-enpoi-editor-saving]')?.textContent).toBe('saving')
    act(() => { store.actions.saved(ADDRESS, 'hello!', { sha256: 'sha-2', mtimeMs: 2000, size: 6 }, undefined) })
    expect(view.container.querySelector('[data-enpoi-editor-saved]')?.textContent).toContain('savedAt')
    act(() => { store.actions.saveFailed(ADDRESS, 'EACCES') })
    expect(view.container.querySelector('[data-enpoi-editor-save-failed]')?.textContent).toBe('saveFailed')
    cleanup()
  })

  it('keeps the icons but drops the state text in the compact row', () => {
    const store = readyStore()
    store.actions.autoSaveSet(ADDRESS, true)
    store.actions.edited(ADDRESS, 'hello!')
    const view = render(<EditorToolbar {...propsFor(store, true)} />)
    expect(view.container.querySelector('[data-enpoi-editor-dirty]')).toBeNull()
    expect(view.container.querySelector('[data-enpoi-editor-autosave]')).not.toBeNull()
    expect(view.container.querySelector('[data-enpoi-editor-save]')).not.toBeNull()
    cleanup()
  })

  it('renders nothing before the file is known', () => {
    const store = createEditorStore().create()
    store.actions.attach(ADDRESS, TAB)
    const { container } = render(<EditorToolbar {...propsFor(store)} />)
    expect(container.querySelector('[data-enpoi-editor-controls]')).toBeNull()
    cleanup()
  })
})
