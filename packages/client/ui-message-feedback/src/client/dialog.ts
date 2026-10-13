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

/**
 * The background record pipeline's phase, rendered by the bottom-right
 * indicator: idle shows nothing, running an indeterminate progress chip,
 * sent a success chip the view retires after its pause, and failed a chip
 * with the failure copy that stays until dismissed.
 */
export type FeedbackPipeline = 'idle' | 'running' | 'sent' | 'failed'

/** Dialog, toast, and background-pipeline state the overlay view renders from. */
export interface FeedbackDialogState {
  /** Target the dialog is open for; null while closed. */
  readonly target: FeedbackDialogTarget | null
  readonly category: FeedbackCategory | null
  readonly text: string
  /** What the Session submission shares; every open resets it to all-on. */
  readonly share: FeedbackShareFlags
  /** A message-target submission is in flight; the form ignores edits until it settles. */
  readonly submitting: boolean
  /** Failure code of the last submission; the failure toast (open dialog) or the failed pipeline chip. */
  readonly failure: string | null
  /** Sequence of the acknowledgement toast on screen; 0 while none. */
  readonly toast: number
  /** Background record pipeline phase; survives open, dismiss, and toast changes. */
  readonly pipeline: FeedbackPipeline
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

const CLOSED: Omit<FeedbackDialogState, 'toast' | 'pipeline'> = {
  target: null, category: null, text: '', share: ALL_SHARED, submitting: false, failure: null,
}

/** Per-session dialog controller; one instance backs the overlay entry and every message control. */
export class FeedbackDialogController {
  /** Dialog, toast, and pipeline state store (the overlay entry subscribes here). */
  readonly state: SnapshotStore<FeedbackDialogState> = createSnapshotStore<FeedbackDialogState>({
    ...CLOSED, toast: 0, pipeline: 'idle',
  })
  /** Bumped by every open, dismiss, and dispose so a late settlement can tell its draft is gone. */
  private generation = 0
  private toastSeq = 0
  /** Set by {@link dispose}: a background settlement no longer publishes. */
  private disposed = false

  /**
   * @param submit - records one submission; the owner routes it by target.
   */
  constructor(private readonly submit: FeedbackSubmit) {}

  /** The members that survive a close or replace: the toast and the background pipeline. */
  private preserved(): Pick<FeedbackDialogState, 'toast' | 'pipeline' | 'failure'> {
    const s = this.state.getSnapshot()
    return {
      toast: s.toast,
      pipeline: s.pipeline,
      // A failed pipeline chip outlives the draft; every other failure belongs
      // to the open-dialog failure toast and clears with the draft.
      failure: s.pipeline === 'failed' ? s.failure : null,
    }
  }

  /**
   * Open the dialog with an empty draft, replacing any open draft.
   * @param target - what the submission records against.
   */
  open(target: FeedbackDialogTarget): void {
    this.generation += 1
    this.state.set({ ...CLOSED, ...this.preserved(), target })
  }

  /** Close the dialog and discard the draft; a toast or pipeline chip on screen stays. */
  dismiss(): void {
    this.generation += 1
    this.state.set({ ...CLOSED, ...this.preserved() })
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
   * Submit the draft; an empty draft is a valid submission. A message target
   * awaits its rating write: success closes the dialog and acknowledges, and a
   * failure keeps the draft open with its code. A Session target dispatches
   * without awaiting: the dialog closes and acknowledges now, and the record's
   * settlement drives the background pipeline indicator instead.
   * @returns after the submission is dispatched.
   */
  async submitDraft(): Promise<void> {
    const s = this.state.getSnapshot()
    if (s.target === null || s.submitting) return
    const text = s.text.trim()
    const entry: FeedbackDialogEntry = {
      ...(text.length === 0 ? {} : { text }),
      ...(s.category === null ? {} : { category: s.category }),
      share: s.share,
      submit: true,
    }
    if (s.target.kind === 'message') {
      await this.submitMessage(s.target, entry)
      return
    }
    this.submitSession(s.target, entry)
  }

  /** Await a message rating: success closes the draft, failure keeps it with its code. */
  private async submitMessage(target: Extract<FeedbackDialogTarget, { kind: 'message' }>, entry: FeedbackDialogEntry): Promise<void> {
    const generation = this.generation
    this.state.set({ ...this.state.getSnapshot(), submitting: true, failure: null })
    const result = await this.submit(target, entry)
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

  /**
   * Dispatch a Session record and close the draft now: the acknowledgement
   * toast is raised immediately, and the settle flips the pipeline indicator.
   */
  private submitSession(target: Extract<FeedbackDialogTarget, { kind: 'session' }>, entry: FeedbackDialogEntry): void {
    this.generation += 1
    this.toastSeq += 1
    this.state.set({ ...CLOSED, toast: this.toastSeq, pipeline: 'running', failure: null })
    void this.submit(target, entry).then(
      (result) => { this.settlePipeline(result) },
      (error: unknown) => {
        this.settlePipeline({
          ok: false,
          error: { code: 'internal', message: error instanceof Error ? error.message : String(error) },
        })
      },
    )
  }

  /**
   * Land one background record's outcome on the pipeline indicator; the last
   * settlement of a burst wins, and a disposed controller publishes nothing.
   * @param result - the settled record result.
   */
  private settlePipeline(result: MessageFeedbackActionResult): void {
    if (this.disposed) return
    const s = this.state.getSnapshot()
    this.state.set(result.ok
      ? { ...s, pipeline: 'sent', failure: null }
      : { ...s, pipeline: 'failed', failure: result.error.code })
  }

  /**
   * Retire the settled success indicator after its pause; a failed indicator
   * waits for {@link dismissFailure}.
   */
  dismissPipeline(): void {
    const s = this.state.getSnapshot()
    if (s.pipeline === 'sent') this.state.set({ ...s, pipeline: 'idle' })
  }

  /** Clear the current failure; also retires a failed pipeline indicator. */
  dismissFailure(): void {
    const s = this.state.getSnapshot()
    this.state.set({
      ...s,
      failure: null,
      ...s.pipeline === 'failed' ? { pipeline: 'idle' as const } : {},
    })
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

  /** Scope-teardown disposer: drop the draft, the toast, and the pipeline, orphan in-flight work. */
  dispose(): void {
    this.disposed = true
    this.generation += 1
    this.state.set({ ...CLOSED, toast: 0, pipeline: 'idle' })
  }
}
