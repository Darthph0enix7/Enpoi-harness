// @vitest-environment jsdom
/**
 * The body's render surfaces that do not mount CodeMirror's editing state:
 * the File-not-found state (with the kept dirty buffer), the conflict flow's
 * three actions and their confirmations, the auto-save toggle, and the save
 * state line.
 */
import { describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { sessionFileAddress } from '@deepseek-ai/dsh-util-workspace-path'
import type { FileSnapshot } from '../src/client/fsops.ts'
import type { EditorFsOps } from '../src/client/fsops.ts'
import { createEditorStore } from '../src/client/store.ts'
import type { EditorBodyProps } from '../src/client/EditorBody.tsx'
import { EditorBody } from '../src/client/EditorBody.tsx'

const TAB = 'tab-1'
const ADDRESS = sessionFileAddress('session-1', 'notes.md')

/** A snapshot fixture. */
function snapshot(content: string, sha256 = 'sha-1', mtimeMs = 1000): FileSnapshot {
  return { content, sha256, mtimeMs, size: content.length, truncated: false }
}

/** The fsops stub: no test here performs I/O. */
const fs: EditorFsOps = {
  read: () => Promise.reject(new Error('unused')),
  write: () => Promise.reject(new Error('unused')),
  stat: () => Promise.reject(new Error('unused')),
}

/**
 * Compose the body props around one store instance, as the framework would:
 * the store instance is the selector hook's source and the injected face is
 * plain data.
 * @param store - the live store instance.
 * @returns the cast props under test.
 */
function propsFor(store: ReturnType<ReturnType<typeof createEditorStore>['create']>): EditorBodyProps {
  const abort = new AbortController()
  return {
    useStore: (selector: (state: ReturnType<typeof store.getSnapshot>) => unknown) => selector(store.getSnapshot()),
    actions: store.actions,
    fs,
    t: (key: string) => key,
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
  } as unknown as EditorBodyProps
}

describe('editor body surfaces', () => {
  it('shows the File-not-found state and says the dirty buffer is kept', () => {
    const store = createEditorStore().create()
    store.actions.attach(ADDRESS, TAB)
    store.actions.synced(ADDRESS, snapshot('hello'))
    store.actions.edited(ADDRESS, 'my buffer')
    store.actions.missing(ADDRESS)
    const { container } = render(<EditorBody {...propsFor(store)} />)
    expect(container.querySelector('[data-enpoi-editor-missing]')).not.toBeNull()
    expect(container.querySelector('[data-enpoi-editor-buffer-kept]')).not.toBeNull()
    expect(container.querySelector('[data-enpoi-editor-cm]')).toBeNull()
    cleanup()
  })

  it('offers exactly the three conflict actions on the conflict banner', () => {
    const store = createEditorStore().create()
    store.actions.attach(ADDRESS, TAB)
    store.actions.synced(ADDRESS, snapshot('hello'))
    store.actions.edited(ADDRESS, 'my buffer')
    store.actions.conflicted(ADDRESS)
    const { container } = render(<EditorBody {...propsFor(store)} />)
    expect(container.querySelector('[data-enpoi-editor-banner="conflict"]')).not.toBeNull()
    expect(container.querySelector('[data-enpoi-editor-overwrite-ask]')).not.toBeNull()
    expect(container.querySelector('[data-enpoi-editor-discard-ask]')).not.toBeNull()
    expect(container.querySelector('[data-enpoi-editor-beside]')).not.toBeNull()
    expect(container.querySelector('[data-enpoi-editor-dismiss]')).toBeNull()
    cleanup()
  })

  it('confirms the Overwrite with the file-history promise before forcing', () => {
    const store = createEditorStore().create()
    store.actions.attach(ADDRESS, TAB)
    store.actions.synced(ADDRESS, snapshot('hello'))
    store.actions.edited(ADDRESS, 'my buffer')
    store.actions.conflicted(ADDRESS)
    const view = render(<EditorBody {...propsFor(store)} />)
    fireEvent.click(view.container.querySelector('[data-enpoi-editor-overwrite-ask]')!)
    expect(view.container.querySelector('[data-enpoi-editor-confirm="overwrite"]')).not.toBeNull()
    // The confirmation names the file-history promise (keyed copy under test).
    expect(view.container.textContent).toContain('overwriteConfirm')
    expect(view.container.querySelector('[data-enpoi-editor-banner="conflict"]')).toBeNull()
    cleanup()
  })

  it('makes Save a copy beside the prominent exit of the Discard confirmation', () => {
    const store = createEditorStore().create()
    store.actions.attach(ADDRESS, TAB)
    store.actions.synced(ADDRESS, snapshot('hello'))
    store.actions.edited(ADDRESS, 'my buffer')
    store.actions.conflicted(ADDRESS)
    const view = render(<EditorBody {...propsFor(store)} />)
    fireEvent.click(view.container.querySelector('[data-enpoi-editor-discard-ask]')!)
    expect(view.container.querySelector('[data-enpoi-editor-confirm="discard"]')).not.toBeNull()
    const copy = view.container.querySelector('[data-enpoi-editor-save-copy-beside]')!
    expect(copy.className).toContain('primary')
    expect(view.container.querySelector('[data-enpoi-editor-discard]')).not.toBeNull()
    cleanup()
  })

  it('carries a dirty buffer around a clean display-type switch through the store', async () => {
    const store = createEditorStore().create()
    store.actions.attach(ADDRESS, TAB)
    store.actions.synced(ADDRESS, snapshot('hello'))
    store.actions.edited(ADDRESS, 'my buffer')
    const first = render(<EditorBody {...propsFor(store)} />)
    first.unmount()
    // The bucket is keyed by the address, not the tab id, and survives the body.
    expect(store.getSnapshot().byAddress[ADDRESS]?.draft).toBe('my buffer')
    const second = render(<EditorBody {...propsFor(store)} />)
    // The editor engine arrives as a deferred chunk, so the mount is asynchronous.
    await waitFor(() => { expect(second.container.querySelector('[data-enpoi-editor-cm]')).not.toBeNull() })
    cleanup()
  })

  it('shares one bucket between two tabs of the same file and drops it with the last', () => {
    const store = createEditorStore().create()
    store.actions.attach(ADDRESS, TAB)
    store.actions.attach(ADDRESS, 'tab-2')
    store.actions.synced(ADDRESS, snapshot('hello'))
    store.actions.edited(ADDRESS, 'shared buffer')
    // The first tab's record ends; the second keeps editing the same buffer.
    store.actions.detach(ADDRESS, TAB)
    expect(store.getSnapshot().byAddress[ADDRESS]?.draft).toBe('shared buffer')
    store.actions.detach(ADDRESS, 'tab-2')
    expect(store.getSnapshot().byAddress[ADDRESS]).toBeUndefined()
  })

})
