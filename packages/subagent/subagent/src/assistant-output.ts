/**
 * Canonical selection of a child's final assistant output. Backend run results
 * and `subagent/end.lastAssistantMessage` apply the same rule: select the last
 * non-empty assistant message. An empty-content message records usage only
 * when the loop appends it after a max-tokens step with no executable blocks,
 * so it does not replace earlier output. If no non-empty message exists,
 * select the accumulated assistant text. Selection is independent of the
 * run's stop reason.
 *
 * A run the harness CONTINUED after its output budget cut a turn off is the one
 * exception: its answer spans turns, so both surfaces report
 * {@link joinedAssistantText} instead of the last message. Every other run keeps
 * the single-message rule unchanged.
 *
 * @module @deepseek-ai/dsh-subagent/assistant-output
 */

import { joinAssistantStreamText, type ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

/**
 * Incremental fold of the selection rule, for backends that observe a child's
 * output as it streams: session-event backends {@link push} each event, and
 * transports without session events (ACP content chunks) {@link pushText} raw
 * text into the same streamed fallback.
 */
export class AssistantOutputFold {
  private message: readonly ContentBlock[] | undefined
  private partial: string[] = []

  /**
   * Fold one session event: a non-empty assistant message becomes the
   * candidate final answer, while its embedded stream and any log-only attempt
   * extend the streamed fallback; every other event contributes nothing.
   * @param event - the next observed session event.
   */
  push(event: SessionEvent): void {
    if (event.type === 'assistant/message') {
      const content = event.data.message.content
      if (content.length > 0) this.message = content
    }
    if (event.type === 'assistant/message' || event.type === 'assistant/attempt') {
      this.pushText(joinAssistantStreamText(event.data.stream))
    }
  }

  /**
   * Extend the streamed fallback with text observed outside session events.
   * @param text - the next streamed text piece (an empty piece is a no-op).
   */
  pushText(text: string): void {
    if (text.length > 0) this.partial.push(text)
  }

  /**
   * Select the final output folded so far.
   * @returns the last non-empty assistant message, else the accumulated
   *   streamed text, or `undefined` when the child produced neither.
   */
  collect(): readonly ContentBlock[] | undefined {
    if (this.message !== undefined) return this.message
    const text = this.partial.join('')
    return text.length > 0 ? [{ type: 'text', text }] : undefined
  }
}

/**
 * Apply the selection rule to one complete child-owned event suffix.
 * @param events - the child-owned events (after any seed or epoch boundary).
 * @returns the selected output, or `undefined` when the child produced none.
 */
export function finalAssistantOutput(events: readonly SessionEvent[]): readonly ContentBlock[] | undefined {
  // TODO: this folds the complete suffix once per run/epoch settlement. If a
  // long continuable epoch ever profiles hot here, scan backward with early
  // exit for the last non-empty message and fold text deltas only on the
  // no-message fallback.
  const fold = new AssistantOutputFold()
  for (const event of events) fold.push(event)
  return fold.collect()
}

/**
 * Join every assistant message of one child-owned suffix into one answer.
 *
 * {@link finalAssistantOutput} selects the LAST non-empty message, which is the
 * whole answer for a single-turn run. A run the harness continued after its
 * output budget cut it off has the answer split across turns, so reporting only
 * the last message would hand the parent the post-truncation tail.
 * @param events - the child-owned events (after any seed or epoch boundary).
 * @returns the non-text blocks in log order plus one text block joining every
 *   assistant text, or `undefined` when the child produced neither.
 */
export function joinedAssistantText(events: readonly SessionEvent[]): readonly ContentBlock[] | undefined {
  const out: ContentBlock[] = []
  const pending: string[] = []
  const flush = (): void => {
    if (pending.length === 0) return
    out.push({ type: 'text', text: pending.join('\n\n') })
    pending.length = 0
  }
  for (const event of events) {
    if (event.type !== 'assistant/message') continue
    for (const block of event.data.message.content) {
      if (block.type === 'text') {
        const text = block.text.trim()
        if (text.length > 0) pending.push(text)
        continue
      }
      // Keep the log order: text written before a tool call or image stays
      // before it, so the joined answer reads like the run that produced it.
      flush()
      out.push(block)
    }
  }
  flush()
  return out.length === 0 ? undefined : out
}
