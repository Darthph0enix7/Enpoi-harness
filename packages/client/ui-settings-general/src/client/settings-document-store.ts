/** State owner for the optional local settings-document action. */

import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SettingsDescribeFace } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** Browser state of the Host-owned settings document. */
export interface SettingsDocumentState {
  /** Metadata-loading phase; unavailable means the provider has no local document or the read failed. */
  status: 'idle' | 'loading' | 'ready' | 'unavailable'
  /** Whether one open request is in flight. */
  opening: boolean
  /** Last metadata/open diagnostic; UI exposes only localized copy. */
  error: string | null
}

/** The operator document the Host grants the harness preview, and its directory. */
export interface SettingsDocumentLocation {
  /** Absolute path of the settings document. */
  readonly path: string
  /** Absolute directory holding the document; the tree roots here. */
  readonly root: string
}

/**
 * The registrant-owned door the store opens the document through.
 *
 * The action never touches the Session or Sidebar services itself: this face
 * carries the one gesture sequence (locate → close Settings → reveal), so the
 * store stays testable and the wiring lives with the plugin's `apply`.
 */
export interface SettingsDocumentView {
  /** Close the Settings panel; called once the document is located. */
  close(): void
  /** The Session the preview opens in, or `undefined` when none is on screen. */
  sessionId(): SessionId | undefined
  /**
   * Ask the Host for the operator document location over the fenced settings
   * route.
   * @returns the document path and its containing directory.
   * @throws when no document exists or the route refuses.
   */
  locate(): Promise<SettingsDocumentLocation>
  /**
   * Reveal the document in the right Sidebar: the files page rooted at its
   * containing folder, and the document itself in the preview/editor pane.
   * @param sessionId - the Session the preview opens in.
   * @param document - the located document.
   */
  reveal(sessionId: SessionId, document: SettingsDocumentLocation): void
}

/** Derives local-document availability from the shared mirror and opens the document in the harness. */
export class SettingsDocumentStore {
  /** uSES-safe state source shared by the registered header action. */
  readonly store: SnapshotStore<SettingsDocumentState> = createSnapshotStore({
    status: 'idle', opening: false, error: null,
  })

  private following: (() => void) | undefined

  /**
   * @param describeFace - the shared mirror's describe face (`hasDocument` source).
   * @param view - the registrant-owned locate/close/reveal door.
   */
  constructor(
    private readonly describeFace: SettingsDescribeFace,
    private readonly view: SettingsDocumentView,
  ) {}

  /**
   * Begin following the mirror (idempotent) and reflect whether the current
   * provider owns a local document.
   * @returns settlement once the snapshot reflects the mirror.
   */
  async load(): Promise<void> {
    this.following ??= this.describeFace.subscribe(() => { this.derive() })
    this.store.update((state) => {
      state.status = 'loading'
      state.error = null
    })
    await this.describeFace.ensure()
    this.derive()
  }

  /**
   * Locate the document, close Settings, and reveal it in the harness preview
   * with its containing folder; concurrent gestures collapse behind the
   * in-flight action.
   *
   * A failure at any step (no session, no document, the route refusing) leaves
   * the snapshotted error for the action's line and keeps Settings open — the
   * button never dies silently.
   * @returns after the gesture settles, or immediately when unavailable/already opening.
   */
  async open(): Promise<void> {
    const current = this.store.getSnapshot()
    if (current.status !== 'ready' || current.opening) return
    this.store.update((state) => {
      state.opening = true
      state.error = null
    })
    try {
      const sessionId = this.view.sessionId()
      if (sessionId === undefined) throw new Error('no session is mounted for the document preview')
      const document = await this.view.locate()
      this.view.close()
      this.view.reveal(sessionId, document)
    } catch (error: unknown) {
      this.store.update((state) => {
        state.error = error instanceof Error ? error.message : String(error)
      })
    } finally {
      this.store.update((state) => { state.opening = false })
    }
  }

  /** Stop following the mirror. */
  dispose(): void {
    this.following?.()
    this.following = undefined
  }

  private derive(): void {
    const mirrored = this.describeFace.getSnapshot()
    if (mirrored.view === undefined) {
      // A held failure with no answer means the document cannot be located;
      // without one the read is still in flight and loading stands.
      if (mirrored.error !== null) {
        this.store.update((state) => {
          state.status = 'unavailable'
          state.error = mirrored.error
        })
      }
      return
    }
    const { hasDocument } = mirrored.view
    this.store.update((state) => {
      state.status = hasDocument ? 'ready' : 'unavailable'
      state.error = null
    })
  }
}
