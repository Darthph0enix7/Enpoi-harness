/** Ordered virtual-item projection for the chat transcript. */

import type { InboxState } from '@deepseek-ai/dsh-agent/types'
import type { PendingSubmission } from '@deepseek-ai/dsh-api-session-controller/client'
import type { RenderEntry } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { chatRenderKey } from './render-entry.ts'

/** Minimal tail-node facts the virtual item ordering reads. */
export interface ChatVirtualTailNode {
  readonly kind: string
  readonly location: {
    readonly kind: string
    readonly turn?: { readonly status: string; readonly turn: number } | undefined
  }
}

/** One transient input bubble that is not part of the durable render order. */
export type ChatPendingInput = PendingSubmission | InboxState['next-step'][number]

/** Entry count above which the transcript renders through the virtual window. */
export const CHAT_VIRTUALIZATION_THRESHOLD = 80

/** Rows rendered beyond each viewport edge. */
export const CHAT_VIRTUAL_OVERSCAN = 8

/** Initial viewport height used before the scroll element is measured, in pixels. */
export const CHAT_VIRTUAL_INITIAL_VIEWPORT_HEIGHT = 600

const ESTIMATED_NODE_HEIGHT = 96
const ESTIMATED_GROUP_HEIGHT = 240

/** One ordered transcript item: a durable render entry or a transient bubble. */
export type ChatVirtualItem =
  | { readonly kind: 'entry'; readonly key: string; readonly entry: RenderEntry }
  | { readonly kind: 'pending'; readonly key: string; readonly input: ChatPendingInput }

/**
 * Stable identity for one pending bubble.
 * @param input - local submission or Host inbox steering item.
 * @returns a collision-free React and virtualizer key.
 */
export function chatPendingInputKey(input: ChatPendingInput): string {
  return 'requestId' in input ? `pending\u0000${input.requestId}` : `steering\u0000${input.id}`
}

/**
 * Stable identity for one transcript item.
 * @param item - ordered virtual item.
 * @returns its React and virtualizer key.
 */
export function chatVirtualItemKey(item: ChatVirtualItem): string {
  return item.kind === 'entry' ? chatRenderKey(item.entry) : item.key
}

/**
 * Estimate an unmeasured item's height.
 * @param item - item about to enter the render window.
 * @returns a pixel estimate replaced by measurement on first render.
 */
export function estimateChatVirtualHeight(item: ChatVirtualItem | undefined): number {
  if (item === undefined) return ESTIMATED_NODE_HEIGHT
  return item.kind === 'entry' && item.entry.kind === 'group'
    ? ESTIMATED_GROUP_HEIGHT
    : ESTIMATED_NODE_HEIGHT
}

/** Whether the tail entry is an open Turn process the pending echo inserts before. */
export function openTurnProcessTail(
  entries: readonly RenderEntry[],
  nodeStore: { get(key: string): ChatVirtualTailNode | undefined },
  lastInputTurn: number | undefined,
): boolean {
  const tail = entries.at(-1)
  const node = tail?.kind === 'node' ? nodeStore.get(tail.key) : undefined
  if (node?.kind !== 'turn-process' || node.location.kind !== 'turn') return false
  const turn = node.location.turn
  return turn?.status === 'open' && turn.turn !== lastInputTurn
}

/**
 * Build the transcript's ordered virtual items.
 * The first transcript-placement submission precedes an open Turn-process tail
 * exactly as the plain list inserts it; every other pending bubble trails.
 * @param entries - durable render entries in committed order.
 * @param pendingInputs - transient local and Host-pending input bubbles.
 * @param insertTranscriptEchoBeforeTail - whether an open process tail accepts the echo.
 * @returns the ordered item list.
 */
export function buildChatVirtualItems(
  entries: readonly RenderEntry[],
  pendingInputs: readonly ChatPendingInput[],
  insertTranscriptEchoBeforeTail: boolean,
): readonly ChatVirtualItem[] {
  const items: ChatVirtualItem[] = entries.map(entry => ({
    kind: 'entry', key: chatRenderKey(entry), entry,
  }))
  const pending: ChatVirtualItem[] = pendingInputs.map(input => ({
    kind: 'pending', key: chatPendingInputKey(input), input,
  }))
  if (insertTranscriptEchoBeforeTail) {
    const position = pending.findIndex(item => item.kind === 'pending'
      && 'requestId' in item.input && item.input.placement === 'transcript')
    if (position !== -1) {
      const [echo] = pending.splice(position, 1)
      items.splice(items.length - 1, 0, echo as ChatVirtualItem)
    }
  }
  return [...items, ...pending]
}
