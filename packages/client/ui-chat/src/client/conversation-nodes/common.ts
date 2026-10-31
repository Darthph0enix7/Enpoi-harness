import type {
  ConversationLocation, ConversationNodeContext,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {
  ChatNode, ChatNodeDataMap, ChatNodeKind,
} from '../contract/chat-nodes.ts'

/**
 * Relative positions in one durable event's seq neighborhood: interrupted
 * Assistant, its follow-up Nodes, then follow-ups to an ordinary final. The
 * max-tokens notice sits between a closing Assistant and the turn-tail so the
 * tail stays the turn's last node and keeps its branch action enabled.
 */
export const CHAT_SYNTHETIC_SEQ_OFFSETS = {
  interruptedAssistant: -0.9,
  interruptedFollowup: -0.8,
  processControl: -0.1,
  maxTokensNotice: 0.05,
  finalizedFollowup: 0.1,
} as const

/**
 * Resolve one Context's best currently loaded event Location.
 * @param context - assembled business Context.
 * @returns start or first-match Location, otherwise unresolved.
 */
export function contextLocation(context: ConversationNodeContext): ConversationLocation {
  return context.start?.location ?? context.matches[0]?.location ?? { kind: 'unresolved' }
}

/**
 * Build one final Chat target Node with the engine-owned stable key.
 * @param context - assembled business Context.
 * @param kind - Chat renderer dispatch key.
 * @param anchorSeq - sortable render position.
 * @param data - renderer-owned payload.
 * @param options - optional Location and visibility overrides.
 * @returns final Chat view Node.
 */
export function chatNode<Kind extends ChatNodeKind>(
  context: ConversationNodeContext,
  kind: Kind,
  anchorSeq: number,
  data: ChatNodeDataMap[Kind],
  options: {
    readonly location?: ConversationLocation
    readonly visibility?: 'visible' | 'hidden'
  } = {},
): ChatNode<Kind> {
  const location = options.location ?? contextLocation(context)
  // A Turn whose opening message left the active branch keeps its log-only
  // status rows hidden. Every Chat node goes through here, so retry rows,
  // terminal errors, max-tokens notices, and the Turn tail hide together and
  // return when the branch is restored.
  const turnActive = location.kind !== 'turn' && location.kind !== 'step'
    ? true
    : location.turn.active
  return {
    key: context.key,
    kind,
    id: context.id,
    target: 'chat',
    anchorSeq,
    location,
    visibility: turnActive ? options.visibility ?? 'visible' : 'hidden',
    data,
  }
}

/**
 * Read a finite non-negative integer from a structurally narrowed payload.
 * @param value - untrusted payload field.
 * @returns valid coordinate, otherwise undefined.
 */
export function coordinate(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}
