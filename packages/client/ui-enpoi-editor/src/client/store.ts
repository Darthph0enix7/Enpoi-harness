/**
 * The editor's own state, bucketed by tab id.
 *
 * The store outlives the body: a tab switched away from unmounts its body, so
 * the dirty buffer, the disk baseline the next save checks against, and the
 * reader's wrap/mode choices all live here rather than in component state. One
 * bucket is created on its first write and dropped by `forget` for a tab record
 * that is gone for good.
 */
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-store'
import type { FileSnapshot } from './fsops.ts'
import type { SaveBaseline } from './machine.ts'

/** Which surface of a bucket is currently readable. */
export type EditorStatus = 'idle' | 'loading' | 'ready' | 'missing' | 'error'

/** The banner above the body; `null` when nothing demands attention. */
export type EditorBanner = 'external-change' | 'conflict'

/** The save's own progress, rendered in the toolbar. */
export type EditorSaveState = 'idle' | 'saving' | 'saved' | 'failed'

/** The content surface: the source editor or the rendered preview. */
export type EditorMode = 'edit' | 'preview'

/** One tab's editable-file state. */
export interface EditorTabState {
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
  /** Why the last read or save failed, for the toolbar/body line. */
  error: string | null
  /** Whether long lines wrap; on until the operator turns it off. */
  wrap: boolean
  /** The content surface choice. */
  mode: EditorMode
}

/** Every tab's state, keyed by tab id. */
export interface EditorState {
  byTab: Record<string, EditorTabState>
}

/**
 * A tab's state before it reads, edits, or toggles anything.
 * @returns the empty bucket.
 */
export function freshEditorTab(): EditorTabState {
  return {
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
    error: null,
    wrap: true,
    mode: 'edit',
  }
}

/**
 * The bucket for one tab, created on first write.
 * @param state - the store draft.
 * @param tabId - the tab's id.
 * @returns the tab's bucket.
 */
function bucket(state: EditorState, tabId: string): EditorTabState {
  return state.byTab[tabId] ??= freshEditorTab()
}

/** The editor store's write set; every action names the tab it writes. */
type EditorActions = {
  loading: (draft: EditorState, tabId: string) => void
  synced: (draft: EditorState, tabId: string, snapshot: FileSnapshot) => void
  adopted: (draft: EditorState, tabId: string, snapshot: FileSnapshot) => void
  missing: (draft: EditorState, tabId: string) => void
  failed: (draft: EditorState, tabId: string, message: string) => void
  edited: (draft: EditorState, tabId: string, text: string) => void
  changed: (draft: EditorState, tabId: string) => void
  conflicted: (draft: EditorState, tabId: string) => void
  dismissed: (draft: EditorState, tabId: string) => void
  saving: (draft: EditorState, tabId: string) => void
  saved: (draft: EditorState, tabId: string, content: string, baseline: SaveBaseline) => void
  saveFailed: (draft: EditorState, tabId: string, message: string) => void
  toggledWrap: (draft: EditorState, tabId: string) => void
  setMode: (draft: EditorState, tabId: string, mode: EditorMode) => void
  forget: (draft: EditorState, tabId: string) => void
}

/** Install one snapshot as the clean baseline. */
function adoptBaseline(state: EditorTabState, snapshot: FileSnapshot): void {
  state.content = snapshot.content
  state.sha256 = snapshot.sha256
  state.mtimeMs = snapshot.mtimeMs
  state.size = snapshot.size
  state.truncated = snapshot.truncated
}

/**
 * Declare the editor's store.
 * @returns the store handle the body registration declares.
 */
export function createEditorStore(): EngineStoreHandle<EditorState, EditorActions> {
  return defineStore({
    init: (): EditorState => ({ byTab: {} }),
    actions: {
      /** @param d - draft. @param tabId - owning tab. */
      loading: (d, tabId) => {
        const state = bucket(d, tabId)
        state.status = 'loading'
        state.error = null
      },
      /** @param d - draft. @param tabId - owning tab. @param snapshot - the file as just read. */
      synced: (d, tabId, snapshot) => {
        const state = bucket(d, tabId)
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
       * @param d - draft.
       * @param tabId - owning tab.
       * @param snapshot - the file as just read.
       */
      adopted: (d, tabId, snapshot) => {
        const state = bucket(d, tabId)
        adoptBaseline(state, snapshot)
        state.banner = null
        state.error = null
        state.status = 'ready'
      },
      /** @param d - draft. @param tabId - owning tab. */
      missing: (d, tabId) => {
        const state = bucket(d, tabId)
        state.status = 'missing'
        state.banner = null
        state.error = null
      },
      /** @param d - draft. @param tabId - owning tab. @param message - failure line. */
      failed: (d, tabId, message) => {
        const state = bucket(d, tabId)
        state.status = 'error'
        state.error = message
        state.saveState = 'idle'
      },
      /** @param d - draft. @param tabId - owning tab. @param text - the buffer after the keystroke. */
      edited: (d, tabId, text) => {
        const state = bucket(d, tabId)
        state.draft = text
        state.dirty = true
        state.revision += 1
        if (state.saveState === 'saved' || state.saveState === 'failed') state.saveState = 'idle'
        state.error = null
      },
      /** @param d - draft. @param tabId - owning tab. */
      changed: (d, tabId) => {
        bucket(d, tabId).banner = 'external-change'
      },
      /** @param d - draft. @param tabId - owning tab. */
      conflicted: (d, tabId) => {
        const state = bucket(d, tabId)
        state.banner = 'conflict'
        state.saveState = 'idle'
      },
      /** @param d - draft. @param tabId - owning tab. */
      dismissed: (d, tabId) => {
        bucket(d, tabId).banner = null
      },
      /** @param d - draft. @param tabId - owning tab. */
      saving: (d, tabId) => {
        const state = bucket(d, tabId)
        state.saveState = 'saving'
        state.error = null
      },
      /**
       * @param d - draft.
       * @param tabId - owning tab.
       * @param content - the bytes just written.
       * @param baseline - the resolved post-write baseline.
       */
      saved: (d, tabId, content, baseline) => {
        const state = bucket(d, tabId)
        state.content = content
        state.draft = null
        state.dirty = false
        state.sha256 = baseline.sha256 ?? state.sha256
        state.mtimeMs = baseline.mtimeMs ?? state.mtimeMs
        state.size = baseline.size ?? state.size
        state.truncated = false
        state.banner = null
        state.saveState = 'saved'
        state.error = null
        state.status = 'ready'
      },
      /** @param d - draft. @param tabId - owning tab. @param message - the failure line. */
      saveFailed: (d, tabId, message) => {
        const state = bucket(d, tabId)
        state.saveState = 'failed'
        state.error = message
      },
      /** @param d - draft. @param tabId - owning tab. */
      toggledWrap: (d, tabId) => {
        const state = bucket(d, tabId)
        state.wrap = !state.wrap
      },
      /** @param d - draft. @param tabId - owning tab. @param mode - the chosen surface. */
      setMode: (d, tabId, mode) => {
        bucket(d, tabId).mode = mode
      },
      /** @param d - draft. @param tabId - the tab that went away. */
      forget: (d, tabId) => {
        const byTab: EditorState['byTab'] = {}
        for (const [id, state] of Object.entries(d.byTab)) {
          if (id !== tabId) byTab[id] = state
        }
        d.byTab = byTab
      },
    },
  })
}

/** The store handle type the body registration declares. */
export type EditorStore = ReturnType<typeof createEditorStore>
