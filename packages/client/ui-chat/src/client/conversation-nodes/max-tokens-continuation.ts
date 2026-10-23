import type { Context } from '@deepseek-ai/cordis'
import type { SessionEventLike } from '@deepseek-ai/dsh-api-session-controller/client'
import type {
  ConversationNodeContext, ConversationNodeDefinition, MaxTokensContinuationNode,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { chatNode } from './common.ts'

declare module '../contract/chat-nodes.ts' {
  interface ChatNodeDataMap {
    /** Durable seed of an automatic continuation after an output-token truncation. */
    'max-tokens-continuation': MaxTokensContinuationNode
  }
}

/** Durable source kind carried by the loop's automatic continuation seed. */
export const MAX_TOKENS_CONTINUATION_SOURCE = 'max-tokens-continuation'

function continuationSource(event: SessionEventLike): boolean {
  // MessageSourceMap is merge-extensible and this client does not mount the
  // host loop's declaration, so read the durable producer structurally.
  return event.type === 'user/message'
    && (event.data.source as { readonly kind?: unknown }).kind === MAX_TOKENS_CONTINUATION_SOURCE
}

/**
 * Quiet inline note for the user message that seeds an automatic continuation
 * after a `max-tokens` turn ending. It is producer context, never operator
 * input, so it must not render as a user bubble.
 */
export const maxTokensContinuationDefinition: ConversationNodeDefinition<MaxTokensContinuationNode> = {
  kind: 'max-tokens-continuation',
  target: 'chat',
  match: event => continuationSource(event) && event.type === 'user/message'
    ? { id: String(event.data.id), role: 'start' }
    : null,
  start: (_context, match) => {
    const event = match.event
    if (event.type !== 'user/message') {
      throw new Error('max-tokens-continuation start requires user/message')
    }
    const location = match.location
    return {
      kind: 'max-tokens-continuation',
      seq: event.seq,
      time: event.time,
      turn: location.kind === 'turn' || location.kind === 'step' ? location.turn.turn : 0,
      step: location.kind === 'step' ? location.step.step : 0,
      messageId: event.data.id,
    }
  },
  update: context => context.state,
  buildViewNode: (context: ConversationNodeContext<MaxTokensContinuationNode>) => {
    const state = context.state
    if (state === undefined) return null
    return chatNode(context, 'max-tokens-continuation', state.seq, state)
  },
}

/**
 * Register the automatic continuation Seed Definition.
 * @param ctx - owning UI Conversation context.
 */
export function registerMaxTokensContinuationConversationNode(ctx: Context): void {
  ctx.uiConversation.events.register(maxTokensContinuationDefinition)
}
