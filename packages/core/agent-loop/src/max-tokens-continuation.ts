/**
 * Interactive output-budget continuation policy.
 *
 * An output-token ceiling truncates one model response, not the request. When
 * an owner session's turn stops on `max-tokens` without tool work, the loop
 * grants a bounded number of ordinary follow-up turns seeded by a logged
 * message with a producer-distinct source. Subagent children are excluded
 * because their drivers/activation manager own the same policy.
 *
 * @module @deepseek-ai/dsh-agent-loop/max-tokens-continuation
 */

import { createUserMessage } from '@deepseek-ai/dsh-llm'

/** Durable source attribution for one automatic continuation seed. */
export interface MaxTokensContinuationSource {
  readonly kind: 'max-tokens-continuation'
  /** A runtime account shown without expanding the row (`notice` context form). */
  readonly form: 'notice'
  /** One-line account of why the model was asked to continue. */
  readonly summary: string
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'max-tokens-continuation': MaxTokensContinuationSource
  }
}

/** Source kind carried by every automatic continuation seed. */
export const MAX_TOKENS_CONTINUATION_SOURCE = 'max-tokens-continuation'

/** Exact model-facing continuation order appended after a truncated turn. */
export const MAX_TOKENS_CONTINUATION = 'Your previous message was cut off by the output token limit before it finished. '
  + 'Continue from exactly where it stopped: do not restart the task, do not repeat what you already wrote, '
  + 'and do not re-plan. If the remaining work cannot fit in one response, finish with what matters most '
  + 'and state what is still missing.'

/** One-line UI account of the automatic continuation. */
export const MAX_TOKENS_CONTINUATION_SUMMARY
  = 'Output token limit reached; continuing the response automatically.'

/**
 * Build the durable seed for one automatic continuation turn. The loop appends
 * it to the pending queue before recording the truncated turn ending, so the
 * intent is logged ahead of the `turn/end` it explains; the seeded
 * `user/message` itself is admitted by the follow-up turn's first step.
 * @returns a fresh immutable user message with the continuation source.
 */
export function createMaxTokensContinuationMessage(): ReturnType<typeof createUserMessage> {
  return createUserMessage({
    content: [{ type: 'text', text: MAX_TOKENS_CONTINUATION }],
    source: {
      kind: MAX_TOKENS_CONTINUATION_SOURCE,
      form: 'notice',
      summary: MAX_TOKENS_CONTINUATION_SUMMARY,
    },
  })
}
