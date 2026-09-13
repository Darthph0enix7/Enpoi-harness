// @vitest-environment jsdom
/**
 * The body's render surfaces that do not mount CodeMirror: the File-not-found
 * state (with the kept dirty buffer) and the read-only preview, plus the
 * toolbar's dirty dot and banners. CodeMirror itself is intentionally never
 * rendered here.
 */
import { describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import type { FileSnapshot } from '../src/client/fsops.ts'
import type { EditorFsOps } from '../src/client/fsops.ts'
import { createEditorStore } from '../src/client/store.ts'
import type { EditorBodyProps } from '../src/client/EditorBody.tsx'
import { EditorBody } from '../src/client/EditorBody.tsx'
import { sessionFileAddress } from '@deepseek-ai/dsh-util-workspace-path'

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
        kind: 'enpoi-editor',
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
    store.actions.synced(TAB, snapshot('hello'))
    store.actions.edited(TAB, 'my buffer')
    store.actions.missing(TAB)
    const { container } = render(<EditorBody {...propsFor(store)} />)
    expect(container.querySelector('[data-enpoi-editor-missing]')).not.toBeNull()
    expect(container.querySelector('[data-enpoi-editor-buffer-kept]')).not.toBeNull()
    expect(container.querySelector('[data-enpoi-editor-cm]')).toBeNull()
    cleanup()
  })

  it('renders the read-only Markdown preview with the dirty dot and the change banner', () => {
    const store = createEditorStore().create()
    store.actions.synced(TAB, snapshot('# Title'))
    store.actions.edited(TAB, '# Title\n\nedited')
    store.actions.changed(TAB)
    store.actions.setMode(TAB, 'preview')
    const { container } = render(<EditorBody {...propsFor(store)} />)
    expect(container.querySelector('[data-enpoi-editor-dirty]')).not.toBeNull()
    expect(container.querySelector('[data-enpoi-editor-banner="external-change"]')).not.toBeNull()
    expect(container.querySelector('[data-enpoi-editor-reload-now]')).not.toBeNull()
    expect(container.querySelector('[data-enpoi-editor-dismiss]')).not.toBeNull()
    expect(container.querySelector('[data-enpoi-editor-preview]')?.textContent).toContain('edited')
    expect(container.querySelector('[data-enpoi-editor-cm]')).toBeNull()
    cleanup()
  })

  it('offers Overwrite and Reload on the conflict banner', () => {
    const store = createEditorStore().create()
    store.actions.synced(TAB, snapshot('hello'))
    store.actions.edited(TAB, 'my buffer')
    store.actions.conflicted(TAB)
    store.actions.setMode(TAB, 'preview')
    const { container } = render(<EditorBody {...propsFor(store)} />)
    expect(container.querySelector('[data-enpoi-editor-banner="conflict"]')).not.toBeNull()
    expect(container.querySelector('[data-enpoi-editor-overwrite]')).not.toBeNull()
    expect(container.querySelector('[data-enpoi-editor-reload-now]')).not.toBeNull()
    cleanup()
  })
})
