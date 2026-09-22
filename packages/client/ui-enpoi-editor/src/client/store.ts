/**
 * The editor's own state, bucketed by the canonical file address.
 *
 * The store outlives the body: a tab switched away from unmounts its body, so
 * the dirty buffer, the disk baseline the next save checks against, and the
 * reader's place all live here rather than in component state. The bucket key
 * is the tab's `contentId` — the canonical file address — with reference
 * counting over the tab records holding it, so the same file open in two tabs
 * shares one buffer, one disk baseline, and one conflict state instead of
 * split-braining through racing writes and 409s. A bucket is created on its
 * first `attach` and dropped when the last holding tab record ends.
 */
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-store'
import type { FileSnapshot } from './fsops.ts'
import type { SaveBaseline } from './machine.ts'

/** Which surface of a bucket is currently readable. */
export type EditorStatus = 'idle' | 'loading' | 'ready' | 'missing' | 'error'

/** The banner above the body; `null` when nothing demands attention. */
export type EditorBanner = 'conflict'

/** The save's own progress, rendered in the toolbar. */
export type EditorSaveState = 'idle' | 'saving' | 'saved' | 'failed'

/** Where the reader was in the buffer, preserved across a body remount. */
export interface EditorViewState {
  /** Selection anchor offset, in UTF-16 code units. */
  readonly anchor: number
  /** Selection head offset, in UTF-16 code units. */
  readonly head: number
  /** Scroll offset of the editor's viewport, in px. */
  readonly scrollTop: number
}

/** One editable file's state, shared by every tab holding the address. */
export interface EditorTabState {
  /** Which tab records currently hold this bucket; the last detach drops it. */
  holders: readonly string[]
  /** Which surface the body renders. */
  status: EditorStatus
  /** The content last read from disk; the save's `expectedSha` belongs to this. */
  content: string
  /** SHA-256 of `content` as read; `null` before the first successful read. */
  sha256: string | null
  /** Modification time of the last read/stat. */
  mtimeMs: number
  /** Size of `content` as read. */
  size: number
  /** Whether `content` is only the file's prefix; a truncated buffer never saves. */
  truncated: boolean
  /** The edited buffer; `null` while it matches disk. */
  draft: string | null
  /** Whether unsaved edits exist. */
  dirty: boolean
  /** User-edit count; the keystroke-loss guard compares it across an await. */
  revision: number
  /** The banner demanding attention, if any. */
  banner: EditorBanner | null
  /** The last save's progress. */
  saveState: EditorSaveState
  /** When the last successful save finished, in epoch ms; `null` before one. */
  savedAt: number | null
  /** Why the last read or save failed, for the toolbar/body line. */
  error: string | null
  /** Where the reader was, restored on remount. */
  view: EditorViewState
}

/** Every bucket, keyed by the canonical file address. */
export interface EditorState {
  byAddress: Record<string, EditorTabState>
}

/**
 * A bucket before it reads, edits, or toggles anything.
 * @returns the empty bucket.
 */
export function freshEditorTab(): EditorTabState {
  return {
    holders: [],
    status: 'idle',
    content: '',
    sha256: null,
    mtimeMs: 0,
    size: 0,
    truncated: false,
    draft: null,
    dirty: false,
    revision: 0,
    banner: null,
    saveState: 'idle',
    savedAt: null,
    error: null,
    view: { anchor: 0, head: 0, scrollTop: 0 },
  }
}

/**
 * The bucket for one file address, created on first write.
 * @param state - the store draft.
 * @param address - the canonical file address.
 * @returns the bucket.
 */
function bucket(state: EditorState, address: string): EditorTabState {
  return state.byAddress[address] ??= freshEditorTab()
}

/** The editor store's write set; every action names the address it writes. */
type EditorActions = {
  attach: (draft: EditorState, address: string, tabId: string) => void
  detach: (draft: EditorState, address: string, tabId: string) => void
  loading: (draft: EditorState, address: string) => void
  synced: (draft: EditorState, address: string, snapshot: FileSnapshot) => void
  adopted: (draft: EditorState, address: string, snapshot: FileSnapshot) => void
  missing: (draft: EditorState, address: string) => void
  failed: (draft: EditorState, address: string, message: string) => void
  edited: (draft: EditorState, address: string, text: string) => void
  conflicted: (draft: EditorState, address: string) => void
  saving: (draft: EditorState, address: string) => void
  saved: (draft: EditorState, address: string, content: string, baseline: SaveBaseline, liveDoc: string | undefined) => void
  saveFailed: (draft: EditorState, address: string, message: string) => void
  viewChanged: (draft: EditorState, address: string, view: EditorViewState) => void
}

/** Install one snapshot as the clean baseline. */
function adoptBaseline(state: EditorTabState, snapshot: FileSnapshot): void {
  state.content = snapshot.content
  state.sha256 = snapshot.sha256
  state.mtimeMs = snapshot.mtimeMs
  state.size = snapshot.size
  state.truncated = snapshot.truncated
}

/** Drop one holder; an emptied bucket goes with its last holder. */
function dropHolder(state: EditorState, address: string, tabId: string): void {
  const held = state.byAddress[address]
  if (held === undefined) return
  if (!held.holders.includes(tabId)) return
  const holders = held.holders.filter(holder => holder !== tabId)
  if (holders.length === 0) {
    // Rebuild instead of deleting: the released address drops out of the map.
    state.byAddress = Object.fromEntries(
      Object.entries(state.byAddress).filter(([candidate]) => candidate !== address),
    )
  } else held.holders = holders
}

/**
 * Declare the editor's store.
 * @returns the store handle the body registration declares.
 */
export function createEditorStore(): EngineStoreHandle<EditorState, EditorActions> {
  return defineStore({
    init: (): EditorState => ({ byAddress: {} }),
    actions: {
      /**
       * Count one tab record among a bucket's holders, creating the bucket on
       * the first hold. Idempotent per tab.
       * @param d - draft. @param address - the file address. @param tabId - the holding tab.
       */
      attach: (d, address, tabId) => {
        const state = bucket(d, address)
        if (!state.holders.includes(tabId)) state.holders = [...state.holders, tabId]
      },
      /**
       * Release one tab record's hold; the bucket is dropped with its last one.
       * @param d - draft. @param address - the file address. @param tabId - the tab that ended.
       */
      detach: (d, address, tabId) => { dropHolder(d, address, tabId) },
      /** @param d - draft. @param address - the file address. */
      loading: (d, address) => {
        const state = bucket(d, address)
        state.status = 'loading'
        state.error = null
      },
      /** @param d - draft. @param address - the file address. @param snapshot - the file as just read. */
      synced: (d, address, snapshot) => {
        const state = bucket(d, address)
        adoptBaseline(state, snapshot)
        state.draft = null
        state.dirty = false
        state.banner = null
        state.saveState = 'idle'
        state.error = null
        state.status = 'ready'
      },
      /**
       * Adopt a baseline while KEEPING a dirty buffer: the file reappeared (or
       * a reload was requested) under unsaved edits, so the text stays and only
       * the save's comparison point moves.
       * @param d - draft. @param address - the file address. @param snapshot - the file as just read.
       */
      adopted: (d, address, snapshot) => {
        const state = bucket(d, address)
        adoptBaseline(state, snapshot)
        state.banner = null
        state.error = null
        state.status = 'ready'
      },
      /** @param d - draft. @param address - the file address. */
      missing: (d, address) => {
        const state = bucket(d, address)
        state.status = 'missing'
        state.banner = null
        state.error = null
      },
      /** @param d - draft. @param address - the file address. @param message - failure line. */
      failed: (d, address, message) => {
        const state = bucket(d, address)
        state.status = 'error'
        state.error = message
        state.saveState = 'idle'
      },
      /** @param d - draft. @param address - the file address. @param text - the buffer after the keystroke. */
      edited: (d, address, text) => {
        const state = bucket(d, address)
        state.draft = text
        state.dirty = true
        state.revision += 1
        if (state.saveState === 'saved' || state.saveState === 'failed') state.saveState = 'idle'
        state.error = null
      },
      /**
       * Raise the conflict banner; auto-save halts on it until the reader picks
       * one of the three explicit resolutions.
       * @param d - draft. @param address - the file address.
       */
      conflicted: (d, address) => {
        const state = bucket(d, address)
        state.banner = 'conflict'
        state.saveState = 'idle'
      },
      /**
       * Mark a save as in flight.
       * @param d - draft. @param address - the file address.
       */
      saving: (d, address) => {
        const state = bucket(d, address)
        state.saveState = 'saving'
        state.error = null
      },
      /**
       * @param d - draft.
       * @param address - the file address.
       * @param content - the bytes just written.
       * @param baseline - the resolved post-write baseline.
       * @param liveDoc - the buffer as it stands after the write settled;
       * `undefined` when unknown. Text typed during the round-trip keeps the
       * bucket dirty so the next auto-save carries it — the write did not lose
       * it, and clearing the draft here would.
       */
      saved: (d, address, content, baseline, liveDoc) => {
        const state = bucket(d, address)
        state.content = content
        state.sha256 = baseline.sha256 ?? state.sha256
        state.mtimeMs = baseline.mtimeMs ?? state.mtimeMs
        state.size = baseline.size ?? state.size
        state.truncated = false
        state.banner = null
        state.savedAt = Date.now()
        state.saveState = 'saved'
        state.error = null
        state.status = 'ready'
        if (liveDoc !== undefined && liveDoc !== content) {
          state.draft = liveDoc
          state.dirty = true
        } else {
          state.draft = null
          state.dirty = false
        }
      },
      /**
       * Record why a save failed; the failed state suspends auto-save until the
       * reader edits or saves manually.
       * @param d - draft. @param address - the file address. @param message - the failure line.
       */
      saveFailed: (d, address, message) => {
        const state = bucket(d, address)
        state.saveState = 'failed'
        state.error = message
      },
      /**
       * Record where the reader was, so a remount restores the place.
       * @param d - draft. @param address - the file address. @param view - selection and scroll offsets.
       */
      viewChanged: (d, address, view) => {
        bucket(d, address).view = view
      },
    },
  })
}

/** The store handle type the body registration declares. */
export type EditorStore = ReturnType<typeof createEditorStore>
