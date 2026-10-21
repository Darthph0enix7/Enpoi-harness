/**
 * One truncation-continuation policy for every in-process subagent shape.
 *
 * An output-token limit truncates one model response, not the task: the child
 * keeps its own durable log, so the next turn continues from what it already
 * wrote. The one-shot driver and the continuable activation settlement loop
 * both apply this policy, so the ceiling and the order a child receives can
 * never drift apart.
 *
 * @module @deepseek-ai/dsh-subagent/truncation
 */

/**
 * Extra child turns granted after the model's output budget cut a turn off.
 * Two is the ceiling because a third truncation means the requested answer does
 * not fit the route's budget at all, and the parent must decide what to drop.
 */
export const TRUNCATION_CONTINUATIONS = 2

/** The continuation order appended after a truncated turn. */
export const TRUNCATION_CONTINUATION = 'Your previous message was cut off by the output token limit before it finished. '
  + 'Continue from exactly where it stopped: do not restart the task and do not repeat what you already wrote. '
  + 'If the remaining work cannot fit in one response, finish with what matters most and state what is still missing.'
