import { useEffect, useRef } from 'react'
import type { RestoredDraftAttachment } from '../contract/input.ts'
import type { ConversationSessionSlotProps } from '../contract/slots.ts'
import { conversationPhase } from '../contract/snapshot.ts'
import { resolveActiveView } from '../view-selection.ts'
import css from './ConversationRoot.module.css'

function sameRestoredAttachments(
  left: readonly RestoredDraftAttachment[],
  right: readonly RestoredDraftAttachment[],
): boolean {
  if (left.length !== right.length) return false
  return left.every((entry, index) => {
    const other = right[index]
    return other !== undefined
      && other.kind === entry.kind
      && String(other.attachment.attachmentId) === String(entry.attachment.attachmentId)
  })
}

/**
 * Renders the active Session view inside the resident scrollport and keeps
 * the input draft mirrored while blank Hero chrome is visible.
 * @param props - Strict Session input/store, view ledger, and render shares.
 * @returns the active view area, or null while the Session remains blank.
 */
export function DefaultConversationViews({
  view, useSession, useConversation, useConversationViews, useInput, inputActions, useStore, actions,
  renderSlot, bindDraftMirror, openView, useInspectCall,
}: ConversationSessionSlotProps) {
  const tabs = useConversationViews(value => value)
  const inspectCall = useInspectCall(value => value)
  const selectedId = useStore(s => s.view)
  const active = resolveActiveView(tabs, selectedId)
  const session = useSession(s => s)
  const conversation = useConversation(s => s)
  const inputState = useInput(s => s)
  const storedDraft = useStore(s => s.draft)
  const storedAttachments = useStore(s => s.draftAttachments ?? [])
  const storedIncomplete = useStore(s => s.draftAttachmentsIncomplete === true)
  const viewRequest = useStore(s => s.viewRequest ?? null)
  const lastSeeded = useRef<{
    draft: string
    attachments: readonly RestoredDraftAttachment[]
    incomplete: boolean
  } | null>(null)

  // The mount seed and a later server-side adoption (a draft synced from
  // another device) both fill an empty or unedited seeded composer — text,
  // durable restored attachments, and sync-incompleteness flag — so a
  // reverted message's media survives reload. User-edited drafts are never
  // overwritten, so in-progress work always wins.
  useEffect(() => {
    if (lastSeeded.current !== null && inputState.draft !== lastSeeded.current.draft) {
      lastSeeded.current = null
    }
    const emptyComposer = inputState.draft === ''
      && inputState.attachmentIds.length === 0
      && (storedDraft !== '' || storedAttachments.length > 0 || (storedIncomplete && inputState.incompleteDraftAttachments !== true))
    const uneditedSeedUpdate = lastSeeded.current !== null
      && inputState.draft === lastSeeded.current.draft
      && (storedDraft !== lastSeeded.current.draft
        || !sameRestoredAttachments(storedAttachments, lastSeeded.current.attachments)
        || storedIncomplete !== lastSeeded.current.incomplete)
    if (emptyComposer || uneditedSeedUpdate) {
      lastSeeded.current = {
        draft: storedDraft,
        attachments: storedAttachments,
        incomplete: storedIncomplete,
      }
      inputActions.restoreDraft(
        storedDraft,
        storedAttachments,
        storedIncomplete ? { incompleteAttachments: true } : undefined,
      )
    }
  }, [
    storedDraft,
    storedAttachments,
    storedIncomplete,
    inputState.draft,
    inputState.attachmentIds.length,
    inputState.incompleteDraftAttachments,
    inputActions,
  ])

  useEffect(() => {
    const unmirror = bindDraftMirror(actions.setDraft)
    return () => { unmirror() }
    // The machine mirror pushes editor changes into the store; store-to-editor
    // adoption is the seed effect above.
  }, [actions])

  if (session.blank && conversationPhase(session, conversation) === 'blank') return null
  const viewId = view ?? active?.id
  // The active View identity rides the DOM so the skeleton's CSS can react to
  // who owns the scrollport (the composer seat hides on non-Chat Views).
  return (
    <div className={css.viewArea} data-active-view={viewId}>
      {viewId !== undefined && renderSlot('conversation.view', {
        inspectCall,
        viewRequest,
        openView,
        completeViewRequest: actions.completeViewRequest,
      }, { only: viewId })}
    </div>
  )
}
