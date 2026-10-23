/**
 * Composer Tab gesture contract: the agent-preset owner registers one handler
 * the composer consults after its own menu arbitration passes a Tab. The
 * handler decides whether the gesture is a preset cycle (consumed) or an
 * ordinary browser focus traversal (not consumed).
 */
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** Direction of one composer preset cycle. */
export type ComposerTabDirection = 'next' | 'previous'

/** The one live Tab owner registered through `ctx.conversation.registerComposerTab`. */
export interface ComposerTabHandler {
  /**
   * Handle one Tab gesture that no open completion menu claimed.
   * @param sessionId - the composer's Session; absent on a session-less surface.
   * @param direction - next (Tab) or previous (Shift+Tab) in roster order.
   * @returns true = consumed (cycled or deliberate no-op); false = browser keeps focus traversal.
   */
  handle(sessionId: SessionId | undefined, direction: ComposerTabDirection): boolean
}
