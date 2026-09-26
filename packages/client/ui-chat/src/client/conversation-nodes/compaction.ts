import type { Context } from '@deepseek-ai/cordis'
import type {
  CompactionSummaryNode, ConversationNodeDefinition,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-compaction/types'

declare module '../contract/chat-nodes.ts' {
  interface ChatNodeDataMap {
    /**
     * Legacy automatic-compaction marker. Automatic compaction no longer emits
     * a Chat node (see {@link compactionDefinition}); the data type remains for
     * the keyed renderer so historical fixtures and the manual `/compact` card
     * keep their existing presentation contract.
     */
    compaction: CompactionSummaryNode
  }
}

/**
 * Automatic compaction owns no Chat row.
 *
 * Product rule: compaction is a model-context operation. The viewer must keep
 * rendering every message it already showed — no card, no hidden span, no
 * ordering or scroll change. The definition stays registered as the explicit
 * owner of that rule; it matches nothing, so no Context, State, or node is ever
 * produced. Manual `/compact` remains the command Definition's own card.
 */
export const compactionDefinition: ConversationNodeDefinition<Record<string, never>> = {
  kind: 'compaction',
  target: 'chat',
  match: () => null,
  start: () => ({}),
  update: context => context.state,
  buildViewNode: () => null,
}

/**
 * Register the inert automatic-compaction policy contribution.
 * @param ctx - owning UI Conversation context.
 */
export function registerCompactionConversationNode(ctx: Context): void {
  ctx.uiConversation.events.register(compactionDefinition)
}
