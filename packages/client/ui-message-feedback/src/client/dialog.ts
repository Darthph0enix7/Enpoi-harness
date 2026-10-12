/**
 * Headless state of one Session's feedback dialog and its acknowledgement and
 * failure toasts. One form serves two targets: the Session itself (a bare `/feedback`)
 * and one assistant message (Like or Dislike). The overlay view renders from
 * the store and raises the acknowledgement after a successful submission.
 * @module @deepseek-ai/dsh-client-ui-message-feedback/client/dialog
 */

import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { MessageId } from '@deepseek-ai/dsh-api-remotes/client'
import type {
  FeedbackCategory, FeedbackRecord, FeedbackShareFlags as CollectedShareFlags,
} from '@deepseek-ai/dsh-command-feedback/types'
import type { MessageFeedbackRating } from '@deepseek-ai/dsh-message-feedback/types'
import type { MessageFeedbackActionResult } from './controller.ts'

/** What one open dialog submits to. */
export type FeedbackDialogTarget =
  | { readonly kind: 'session' }
  | { readonly kind: 'message'; readonly messageId: MessageId; readonly rating: MessageFeedbackRating }

/**
 * The data one Session submission is allowed to share: the Host's collected
 * sections (system information, context, and session data) extended with the
 * human's own message. Every flag defaults on; a flag the human unchecked is
 * sent as false so the Host can drop that section from the payload (the
 * frozen `sessionFeedback.record` contract).
 */
export interface FeedbackShareFlags extends CollectedShareFlags {
  /** The human's own typed message. */
  readonly message: boolean
}

/** The all-on sharing defaults: a fresh dialog shares every section. */
export const ALL_SHARED: FeedbackShareFlags = Object.freeze({
  systemInfo: true,
  context: true,
  session: true,
  message: true,
})

/** Dialog and toast state the overlay view renders from. */
export interface FeedbackDialogState {
  /** Target the dialog is open for; null while closed. */
  readonly target: FeedbackDialogTarget | null
  readonly category: FeedbackCategory | null
  readonly text: string
  /** What the Session submission shares; every open resets it to all-on. */
  readonly share: FeedbackShareFlags
  /** A submission is in flight; the form ignores edits and submits until it settles. */
  readonly submitting: boolean
  /** Failure code of the last submission from this open; null when none. */
  readonly failure: string | null
  /** Sequence of the acknowledgement toast on screen; 0 while none. */
  readonly toast: number
}

/**
 * One submission's entry. It carries the record members plus the frozen
 * `share`/`submit` extension of `sessionFeedback.record`; the message target
 * stores only the record members and ignores the extension.
 */
export type FeedbackDialogEntry = FeedbackRecord & {
  readonly share: FeedbackShareFlags
  /** Always true here: the dialog submits, and the settings switch gates it Host-side. */
  readonly submit: true
}

/**
 * Record one submission against its target.
 * @param target - the open target.
 * @param entry - the trimmed text, the category, and the share/submit contract.
 */
export type FeedbackSubmit = (target: FeedbackDialogTarget, entry: FeedbackDialogEntry) => Promise<MessageFeedbackActionResult>

const CLOSED: Omit<FeedbackDialogState, 'toast'> = {
  target: null, category: null, text: '', share: ALL_SHARED, submitting: false, failure: null,
}

/** Per-session dialog controller; one instance backs the overlay entry and every message control. */
export class FeedbackDialogController {
  /** Dialog state store (the overlay entry subscribes here). */
  readonly state: SnapshotStore<FeedbackDialogState> = createSnapshotStore<FeedbackDialogState>({ ...CLOSED, toast: 0 })
  /** Bumped by every open, dismiss, and dispose so a late settlement can tell its draft is gone. */
  private generation = 0
  private toastSeq = 0

  /**
   * @param submit - records one submission; the owner routes it by target.
   */
  constructor(private readonly submit: FeedbackSubmit) {}

  /**
   * Open the dialog with an empty draft, replacing any open draft.
   * @param target - what the submission records against.
   */
  open(target: FeedbackDialogTarget): void {
    this.generation += 1
    this.state.set({ ...CLOSED, target, toast: this.state.getSnapshot().toast })
  }

  /** Close the dialog and discard the draft; a toast on screen stays. */
  dismiss(): void {
    this.generation += 1
    this.state.set({ ...CLOSED, toast: this.state.getSnapshot().toast })
  }

  /**
   * Replace part of the draft while it is editable.
   * @param draft - the category (null clears it), the text as typed, or the share flags.
   */
  edit(draft: Partial<Pick<FeedbackDialogState, 'category' | 'text' | 'share'>>): void {
    const s = this.state.getSnapshot()
    if (s.target === null || s.submitting) return
    this.state.set({ ...s, ...draft })
  }

  /**
   * Submit the draft; an empty draft is a valid submission. Success closes the
   * dialog and raises the acknowledgement toast; a failure keeps the dialog
   * open and publishes its code for the failure toast.
   * @returns after the submission settles.
   */
  async submitDraft(): Promise<void> {
    const s = this.state.getSnapshot()
    if (s.target === null || s.submitting) return
    const generation = this.generation
    this.state.set({ ...s, submitting: true, failure: null })
    const text = s.text.trim()
    const result = await this.submit(s.target, {
      ...(text.length === 0 ? {} : { text }),
      ...(s.category === null ? {} : { category: s.category }),
      share: s.share,
      submit: true,
    })
    if (result.ok) {
      // The remark is recorded whichever draft is on screen now, so the toast
      // always shows; only the draft that produced it closes.
      if (generation === this.generation) this.dismiss()
      this.acknowledge()
      return
    }
    if (generation !== this.generation) return
    this.state.set({ ...this.state.getSnapshot(), submitting: false, failure: result.error.code, toast: 0 })
  }

  /** Clear the current failure toast without closing its draft. */
  dismissFailure(): void {
    const s = this.state.getSnapshot()
    this.state.set({ ...s, failure: null })
  }

  /** Show the acknowledgement toast; a toast already on screen restarts. */
  private acknowledge(): void {
    this.toastSeq += 1
    this.state.set({ ...this.state.getSnapshot(), toast: this.toastSeq })
  }

  /**
   * Retire one toast after its fade; a newer toast is left alone.
   * @param seq - the toast sequence the view finished showing.
   */
  dismissToast(seq: number): void {
    const s = this.state.getSnapshot()
    if (s.toast === seq) this.state.set({ ...s, toast: 0 })
  }

  /** Scope-teardown disposer: drop the draft and the toast, orphan in-flight work. */
  dispose(): void {
    this.generation += 1
    this.state.set({ ...CLOSED, toast: 0 })
  }
}
