/**
 * The one placement rule for content that cannot ride inside a tool result.
 *
 * Every provider requires the results of one assistant tool-call batch to be
 * contiguous and in call order, directly after the assistant message that
 * declared the calls. When an adapter has to move content out of a result —
 * an image for a tool-result slot that only accepts text, or any other side
 * channel — that content must therefore be emitted only after the batch's LAST
 * result. Emitting it between two results produces the wire shape
 *
 *     assistant(tool_calls) → tool → user(extras) → tool
 *
 * which strict providers reject as "Tool result is missing". Adapters build
 * their converted messages and extra content in source order, then hand both
 * here; this module moves each batch's extras behind its last result and never
 * splits a batch.
 *
 * @module @deepseek-ai/dsh-llm/tool-batch
 */

/** One converted message, or content removed from a tool result. */
export type ToolBatchEntry<TMessage, TExtra> =
  | { readonly kind: 'message'; readonly message: TMessage }
  | { readonly kind: 'extra'; readonly extra: TExtra }

/** How to recognize a batch result and how to render its escaped extras. */
export interface ToolBatchOptions<TMessage, TExtra> {
  /** Whether one converted message is a provider tool-result message. */
  isToolResult(message: TMessage): boolean
  /** Render all extras collected for one batch as the single message they become. */
  renderExtras(extras: readonly TExtra[]): TMessage
}

/**
 * Place each contiguous tool batch's extras after its last result.
 *
 * A non-tool message closes the open batch; extras that arrive without a batch
 * keep their source order before the next closing boundary. The result is the
 * adapter's wire order with every batch kept contiguous.
 * @param entries - converted messages and escaped extras in source order.
 * @param options - result recognition and extras rendering.
 * @returns wire messages with each batch's extras moved after its last result.
 */
export function placeToolBatchExtras<TMessage, TExtra>(
  entries: readonly ToolBatchEntry<TMessage, TExtra>[],
  options: ToolBatchOptions<TMessage, TExtra>,
): TMessage[] {
  const messages: TMessage[] = []
  let pending: TExtra[] = []
  const flush = (): void => {
    if (pending.length === 0) return
    const extras = pending
    pending = []
    messages.push(options.renderExtras(extras))
  }
  for (const entry of entries) {
    if (entry.kind === 'extra') {
      pending.push(entry.extra)
      continue
    }
    if (!options.isToolResult(entry.message)) flush()
    messages.push(entry.message)
  }
  flush()
  return messages
}
