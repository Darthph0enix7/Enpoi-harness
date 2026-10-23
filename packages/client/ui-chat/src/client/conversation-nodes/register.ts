import type { Context } from '@deepseek-ai/cordis'
import { registerAssistantConversationNode } from './assistant.ts'
import { registerChatConversationView } from './chat-snapshot-builder.ts'
import { registerCommandConversationNode } from './command.ts'
import { registerCompactionConversationNode } from './compaction.ts'
import { registerUnknownConversationFallback } from './fallback.ts'
import { registerInboxConversationNodes } from './inbox.ts'
import { registerMaxTokensContinuationConversationNode } from './max-tokens-continuation.ts'
import { registerMessageConversationNode } from './message.ts'
import { registerRequestPromptConversationNode } from './request-prompt.ts'
import { registerRetryConversationNode } from './retry.ts'
import { registerToolConversationNode } from './tool.ts'
import { registerTurnErrorConversationNode } from './turn-error.ts'
import { registerTurnMaxTokensConversationNode } from './turn-max-tokens.ts'
import { registerTurnProcess } from './turn-process.ts'
import { registerTurnTailConversationNode } from './turn-tail.ts'
import { processGroupDefinition } from './process-groups.ts'

/**
 * Register the Chat business Definitions and target builder contributed by this package.
 * @param ctx - owning UI Conversation context.
 */
export function registerConversationNodes(ctx: Context): void {
  registerInboxConversationNodes(ctx)
  registerMessageConversationNode(ctx)
  registerRequestPromptConversationNode(ctx)
  registerAssistantConversationNode(ctx)
  registerTurnProcess(ctx)
  registerToolConversationNode(ctx)
  registerCommandConversationNode(ctx)
  registerCompactionConversationNode(ctx)
  registerRetryConversationNode(ctx)
  registerTurnErrorConversationNode(ctx)
  registerTurnMaxTokensConversationNode(ctx)
  registerMaxTokensContinuationConversationNode(ctx)
  registerTurnTailConversationNode(ctx)
  registerUnknownConversationFallback(ctx)
  registerChatConversationView(ctx)
  ctx.uiConversation.groups.register(processGroupDefinition)
}
