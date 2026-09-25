// @vitest-environment jsdom
/**
 * The four auto-save invariants, driven through the real body over a scripted
 * fsops transport:
 * a. the external poll is suppressed while a save is in flight;
 * b. keystrokes that land during a save's round-trip keep the buffer dirty;
 * c. a 409 halts auto-save with no retry; one I/O failure retries after the
 *    pause, a second suspends auto-save until the reader edits;
 * d. a successful save reports the written digest to the host's content
 *    channel.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import { useSyncExternalStore } from 'react'
import { sessionFileAddress } from '@deepseek-ai/dsh-util-workspace-path'
import type { DocumentContent } from '@deepseek-ai/dsh-client-ui-sidebar-documentpreview/client'
import { createFsOps } from '../src/client/fsops.ts'
import type { EditorFsOps } from '../src/client/fsops.ts'
import { AUTOSAVE_DEBOUNCE_MS, AUTOSAVE_RETRY_MS, EditorBody } from '../src/client/EditorBody.tsx'
import type { EditorBodyProps } from '../src/client/EditorBody.tsx'
import { createEditorStore } from '../src/client/store.ts'
import { AUTOSAVE_KEY, readAutosavePref, writeAutosavePref } from '../src/client/prefs.ts'
import { errorValue, fakeFsOpsServer, readValue, statValue } from './fixtures.client.ts'

const TAB = 'tab-1'
const ADDRESS = sessionFileAddress('session-1', 'notes.md')

afterEach(() => { cleanup(); localStorage.clear() })
afterAll(() => { vi.restoreAllMocks() })

// jsdom lays nothing out and implements no DOM Range geometry: give elements an
// on-screen box so the poll's visibility gate runs, and ranges empty geometry so
// CodeMirror's measuring no-ops instead of crashing.
beforeAll(() => {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    width: 300, height: 200, top: 0, left: 0, bottom: 200, right: 300, x: 0, y: 0, toJSON: () => ({}),
  })
  const rangeProto = Range.prototype as unknown as {
    getClientRects?: () => unknown
    getBoundingClientRect?: () => unknown
  }
  const emptyRect = { width: 0, height: 0, top: 0, left: 0, bottom: 0, right: 0, x: 0, y: 0, toJSON: () => ({}) }
  rangeProto.getClientRects = () => [] as unknown as DOMRectList
  rangeProto.getBoundingClientRect = () => emptyRect as DOMRect
})

/** A write reply the routes table reads live, so a spec can change its mind. */
let writeReply: (call: number) => { status: number; body: unknown }
let statReply: () => { status: number; body: unknown }

/** The scripted fsops transport whose write and stat answers each test owns. */
function scriptedFs(): { fs: EditorFsOps; writes: number; stats: number } {
  let writeCalls = 0
  let statCalls = 0
  const server = fakeFsOpsServer({
    'fs.read': () => ({ status: 200, body: readValue('hello', 'sha-1', 1000, 5) }),
    'fs.write': () => writeReply(writeCalls),
    'fs.stat': () => statReply(),
  })
  const base = createFsOps(server.fetch)
  const fs: EditorFsOps = {
    read: base.read,
    stat: (session, path, signal) => {
      statCalls += 1
      return base.stat(session, path, signal)
    },
    write: (session, path, content, expectedSha, force, signal) => {
      writeCalls += 1
      return base.write(session, path, content, expectedSha, force, signal)
    },
  }
  return {
    fs,
    get writes() { return writeCalls },
    get stats() { return statCalls },
  }
}

/**
 * The body props over one store instance: the tab is visible, its address is
 * the canonical one, and the host content channel is the spec's to inspect.
 */
function propsFor(
  store: ReturnType<ReturnType<typeof createEditorStore>['create']>,
  fs: EditorFsOps,
  content?: DocumentContent,
): EditorBodyProps {
  const abort = new AbortController()
  // A live selector: the effects that arm auto-save and the poll need the
  // store's writes to reach the component, as the framework's hook does.
  const useStore = (selector: (state: ReturnType<typeof store.getSnapshot>) => unknown): unknown =>
    selector(useSyncExternalStore(store.subscribe, store.getSnapshot))
  return {
    useStore,
    actions: store.actions,
    fs,
    t: (key: string) => key,
    content,
    wrap: true,
    scrollportRef: () => {},
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

/** Seed a clean, edited bucket so auto-save has something to carry. */
function seedDirty(store: ReturnType<ReturnType<typeof createEditorStore>['create']>): void {
  store.actions.attach(ADDRESS, TAB)
  store.actions.synced(ADDRESS, { content: 'hello', sha256: 'sha-1', mtimeMs: 1000, size: 5, truncated: false })
  store.actions.edited(ADDRESS, 'hello!')
}

describe('auto-save invariants', () => {
  it('suppresses the external poll while a save is in flight, and resumes after', async () => {
    vi.useFakeTimers()
    try {
      writeAutosavePref(true)
      // The default is on; the explicit write records the string form.
      expect(readAutosavePref()).toBe(true)
      expect(localStorage.getItem(AUTOSAVE_KEY)).toBe('on')
      let release: (() => void) | undefined
      const pending = new Promise<void>((resolve) => { release = resolve })
      writeReply = () => ({ status: 200, body: pending.then(() => ({ ok: true, value: { sha256: 'sha-2', mtimeMs: 2000, size: 6 } })) })
      statReply = () => ({ status: 200, body: statValue(2000, 6) })
      const io = scriptedFs()
      const store = createEditorStore().create()
      seedDirty(store)
      render(<EditorBody {...propsFor(store, io.fs)} />)
      // The debounced auto-save fires and hangs in flight.
      await act(async () => { await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS + 10) })
      expect(io.writes).toBe(1)
      // Poll ticks during the flight must not stat the file.
      await act(async () => { await vi.advanceTimersByTimeAsync(1500) })
      await act(async () => { await vi.advanceTimersByTimeAsync(1500) })
      expect(io.stats).toBe(0)
      await act(async () => { release?.(); await pending })
      await act(async () => { await vi.advanceTimersByTimeAsync(1500) })
      // The save settled, so the watcher is live again.
      expect(io.stats).toBe(1)
      expect(store.getSnapshot().byAddress[ADDRESS]?.saveState).toBe('saved')
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps the buffer dirty when keystrokes land during the round-trip, and reschedules', async () => {
    vi.useFakeTimers()
    try {
      writeAutosavePref(true)
      writeReply = () => ({ status: 200, body: { ok: true, value: { sha256: 'sha-2', mtimeMs: 2000, size: 6 } } })
      statReply = () => ({ status: 200, body: statValue(1000, 5) })
      const io = scriptedFs()
      const store = createEditorStore().create()
      seedDirty(store)
      render(<EditorBody {...propsFor(store, io.fs)} />)
      await act(async () => { await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS + 10) })
      // A keystroke lands while the write is on the wire.
      await act(async () => { store.actions.edited(ADDRESS, 'hello!!') })
      await act(async () => { await vi.advanceTimersByTimeAsync(200) })
      expect(store.getSnapshot().byAddress[ADDRESS]?.dirty).toBe(true)
      expect(store.getSnapshot().byAddress[ADDRESS]?.draft).toBe('hello!!')
      // The next debounced save carries what the first round-trip missed.
      await act(async () => { await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS + 10) })
      expect(io.writes).toBe(2)
      expect(store.getSnapshot().byAddress[ADDRESS]?.dirty).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('halts auto-save after a 409 without retrying, and raises the conflict', async () => {
    vi.useFakeTimers()
    try {
      writeAutosavePref(true)
      writeReply = () => ({ status: 409, body: errorValue('conflict', 'file changed on disk') })
      statReply = () => ({ status: 200, body: statValue(2000, 11) })
      const io = scriptedFs()
      const store = createEditorStore().create()
      seedDirty(store)
      const view = render(<EditorBody {...propsFor(store, io.fs)} />)
      await act(async () => { await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS + 10) })
      expect(view.container.querySelector('[data-enpoi-editor-banner="conflict"]')).not.toBeNull()
      // Far past any retry window, the write has still happened exactly once.
      await act(async () => { await vi.advanceTimersByTimeAsync(AUTOSAVE_RETRY_MS * 10) })
      expect(io.writes).toBe(1)
      expect(store.getSnapshot().byAddress[ADDRESS]?.banner).toBe('conflict')
    } finally {
      vi.useRealTimers()
    }
  })

  it('retries one I/O failure after the pause and suspends after a second', async () => {
    vi.useFakeTimers()
    try {
      writeAutosavePref(true)
      writeReply = call => (call === 1
        ? { status: 500, body: errorValue('fs-error', 'ENOSPC') }
        : { status: 200, body: { ok: true, value: { sha256: 'sha-2', mtimeMs: 2000, size: 6 } } })
      statReply = () => ({ status: 200, body: statValue(1000, 5) })
      const io = scriptedFs()
      const store = createEditorStore().create()
      seedDirty(store)
      render(<EditorBody {...propsFor(store, io.fs)} />)
      await act(async () => { await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS + 10) })
      expect(io.writes).toBe(1)
      expect(store.getSnapshot().byAddress[ADDRESS]?.saveState).toBe('failed')
      // The single retry fires after the pause and succeeds.
      await act(async () => { await vi.advanceTimersByTimeAsync(AUTOSAVE_RETRY_MS + 10) })
      expect(io.writes).toBe(2)
      expect(store.getSnapshot().byAddress[ADDRESS]?.saveState).toBe('saved')
    } finally {
      vi.useRealTimers()
    }
  })

  it('suspends auto-save after the retry fails too, until the reader edits again', async () => {
    vi.useFakeTimers()
    try {
      writeAutosavePref(true)
      writeReply = () => ({ status: 500, body: errorValue('fs-error', 'EACCES') })
      statReply = () => ({ status: 200, body: statValue(1000, 5) })
      const io = scriptedFs()
      const store = createEditorStore().create()
      seedDirty(store)
      render(<EditorBody {...propsFor(store, io.fs)} />)
      await act(async () => { await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS + AUTOSAVE_RETRY_MS + 10) })
      expect(io.writes).toBe(2)
      expect(store.getSnapshot().byAddress[ADDRESS]?.saveState).toBe('failed')
      // No third attempt, however long the reader waits.
      await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
      expect(io.writes).toBe(2)
      // Editing re-arms the cycle.
      await act(async () => { store.actions.edited(ADDRESS, 'hello!') })
      await act(async () => { await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS + 10) })
      expect(io.writes).toBe(3)
    } finally {
      vi.useRealTimers()
    }
  })

  it('reports the written digest to the host content channel after a successful save', async () => {
    vi.useFakeTimers()
    try {
      writeAutosavePref(true)
      writeReply = () => ({ status: 200, body: { ok: true, value: { sha256: 'sha-written', mtimeMs: 2000, size: 6 } } })
      statReply = () => ({ status: 200, body: statValue(1000, 5) })
      const io = scriptedFs()
      const store = createEditorStore().create()
      seedDirty(store)
      const loaded = vi.fn()
      const content: DocumentContent = { kind: 'renderer', revision: 0, reload: () => {}, failed: () => {}, loaded }
      render(<EditorBody {...propsFor(store, io.fs, content)} />)
      await act(async () => { await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS + 10) })
      expect(loaded).toHaveBeenCalledWith('sha-written')
    } finally {
      vi.useRealTimers()
    }
  })
})
