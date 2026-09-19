/** Per-session Conversation store shared by the shell body and header. */
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-store'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { bindDraftSync, clearDraftSync } from './draft-sync.ts'
import type { ConversationStoreState } from './contract/views.ts'

const CONVERSATION_STORE_KEY = 'dsh.conversation'

/** Declared write set for the Conversation shell. */
type ConversationActions = {
  setDraft: (draft: ConversationStoreState, text: string) => void
  setView: (draft: ConversationStoreState, view: string) => void
  openView: (draft: ConversationStoreState, view: string, focus: string) => void
  completeViewRequest: (draft: ConversationStoreState) => void
}

/**
 * Declare per-session draft persistence and View selection.
 *
 * enpoi: each session-scoped instance also mirrors its draft to the server
 * (`enpoiUiState`), so the unsent prompt follows the operator across devices.
 * The store's own localStorage persistence stays the synchronous render source.
 * @returns the store handle.
 */
export function createConversationStore(): EngineStoreHandle<ConversationStoreState, ConversationActions> {
  const handle = defineStore({
    init: (): ConversationStoreState => ({ draft: '', view: null, viewRequest: null }),
    persist: CONVERSATION_STORE_KEY,
    actions: {
      setDraft: (d, text: string) => { d.draft = text },
      setView: (d, view: string) => { d.view = view },
      openView: (d, view: string, focus: string) => {
        d.view = view
        d.viewRequest = { view, focus }
      },
      completeViewRequest: (d) => { d.viewRequest = null },
    },
  })
  return {
    ...handle,
    create(scopeKey?: string) {
      const instance = handle.create(scopeKey)
      if (scopeKey === undefined) return instance
      const stopSync = bindDraftSync(instance, scopeKey)
      return {
        ...instance,
        // A pruned session's server draft is not explicitly deleted here: the
        // namespace has no delete and the record dies with the session.
        clearPersisted: () => {
          instance.clearPersisted()
          clearDraftSync(scopeKey)
          stopSync()
        },
      }
    },
  }
}

/**
 * Read the persisted View preference before the Slot store is materialized.
 * @param sessionId - Session-scoped persistence suffix.
 * @returns the preferred View id, or null when storage has no usable value.
 */
export function readConversationViewPreference(sessionId: SessionId): string | null {
  if (typeof localStorage === 'undefined') return null
  try {
    const raw = localStorage.getItem(`${CONVERSATION_STORE_KEY}.${sessionId}`)
    if (raw === null) return null
    const stored: unknown = JSON.parse(raw)
    if (typeof stored !== 'object' || stored === null || !('view' in stored)) return null
    return typeof stored.view === 'string' ? stored.view : null
  } catch {
    return null
  }
}
