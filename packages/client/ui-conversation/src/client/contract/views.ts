/** Conversation view and session-local presentation state. */
import type { RestoredDraftAttachment } from './input.ts'

/**
 * One conversation view tab, projected from a 'conversation.view' slot
 * entry's registration options (label falls back to the entry id).
 */
export interface ViewTab { id: string; label: string }

/** One-shot focus request addressed to a Conversation View. */
export interface ConversationViewRequest {
  /** Target `conversation.view` entry id. */
  readonly view: string
  /** Target-owned opaque focus identity. */
  readonly focus: string
}

/** Per-session state owned by the target-neutral Conversation shell. */
export interface ConversationStoreState {
  /** Composer draft (persisted; survives session switches and reloads). */
  draft: string
  /**
   * Durable attachments restored into the draft (persisted with the draft so
   * a reverted message's media survives reload and reaches another device).
   * Browser-picked attachments stay local and are never persisted here.
   */
  draftAttachments?: readonly RestoredDraftAttachment[]
  /**
   * True when {@link draftAttachments} came from a cross-device sync record
   * truncated at the server cap and awaits operator review or removal.
   */
  draftAttachmentsIncomplete?: boolean
  /** Preferred `conversation.view` entry id; null resolves to Chat when registered. */
  view: string | null
  /** Focus request consumed and acknowledged by the addressed View. */
  viewRequest: ConversationViewRequest | null
}
