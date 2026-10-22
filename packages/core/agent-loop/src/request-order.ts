/**
 * Request-boundary normalization of assistant tool batches.
 *
 * Providers require the result(s) of an assistant message's tool calls to
 * arrive immediately after that message: `assistant(tool_calls) → tool(result)`.
 * A batch that is split by any other message is rejected by strict providers
 * with an error such as `Tool result is missing for tool call <id>`.
 *
 * The durable log can hold exactly that split: a plugin that commits while a
 * tool batch is still executing (a "state checkpoint" plugin is the observed
 * producer) appends its `user` message between the assistant message and the
 * tool result:
 *
 * ```text
 * assistant (content: [tool-call call_A])
 * user      ("### State checkpoint …"   <- committed mid-batch)
 * tool      (toolCallId: call_A)
 * ```
 *
 * Because derivation re-reads the same durable order on every later turn, the
 * session stays poisoned: every request re-sends the invalid prefix. This
 * module heals the *wire* order alone, without touching persisted events:
 *
 * ```text
 * assistant (content: [tool-call call_A])
 * tool      (toolCallId: call_A)
 * user      ("### State checkpoint …")
 * ```
 *
 * Rules:
 * - A batch is the tool-call blocks of one assistant message. Its matching
 *   `tool` messages are those with a `toolCallId` equal to one of those calls,
 *   scanned forward until every call is answered or the next assistant
 *   message carrying tool calls begins.
 * - Matched results are emitted in CALL order, never in log order.
 * - Messages interleaved between the assistant message and its last matched
 *   result are displaced to after the batch, preserving their relative order.
 * - A batch with any genuinely missing result is left exactly as logged; a
 *   separate repair path synthesizes results for unresolved calls. No message
 *   is ever invented, dropped, or mutated: the same frozen references are
 *   returned in a new array.
 * - The walk is single-pass: the cursor advances past each batch it rewrites,
 *   so the result is idempotent.
 *
 * @module dsh-agent-loop/request-order
 */

import type { Message, ToolCallBlock, ToolCallId, ToolResultMessage } from '@deepseek-ai/dsh-llm'

const NO_TOOL_CALLS: readonly ToolCallBlock[] = []

/** Whether a message is an assistant message carrying at least one tool call. */
function hasToolCalls(message: Message): boolean {
  return message.role === 'assistant' && message.content.some(block => block.type === 'tool-call')
}

/** The tool-call blocks of an assistant message, in call order. */
function toolCallsOf(message: Message): readonly ToolCallBlock[] {
  if (message.role !== 'assistant') return NO_TOOL_CALLS
  return message.content.filter(block => block.type === 'tool-call')
}

/**
 * Normalize tool-batch adjacency for a request payload.
 *
 * Returns a new array holding the same message references in wire order, with
 * every complete assistant tool batch immediately followed by its results.
 * Incomplete batches and unchanged messages keep their relative position.
 *
 * @param messages - the derived conversation, in durable order.
 * @returns a new array; no input element is mutated, dropped, or duplicated.
 */
export function orderToolBatches(messages: readonly Message[]): Message[] {
  const ordered: Message[] = []
  let cursor = 0

  while (cursor < messages.length) {
    const message = messages[cursor]
    // The loop condition bounds the cursor; this guard keeps the read total.
    if (message === undefined) break
    ordered.push(message)
    cursor += 1

    const calls = toolCallsOf(message)
    if (calls.length === 0) continue

    // How many results each call id still needs; duplicate ids consume their
    // results in encounter order.
    const remaining = new Map<ToolCallId, number>()
    for (const call of calls) remaining.set(call.id, (remaining.get(call.id) ?? 0) + 1)

    const matched = new Map<ToolCallId, ToolResultMessage[]>()
    const matchedIndexes = new Set<number>()
    let pending = calls.length
    let lastMatch = cursor - 1
    let scan = cursor
    while (scan < messages.length && pending > 0) {
      const candidate = messages[scan]
      if (candidate === undefined) break
      // A following batch owns everything from here on; this batch cannot
      // consume results across it.
      if (hasToolCalls(candidate)) break
      if (candidate.role === 'tool') {
        const needed = remaining.get(candidate.toolCallId) ?? 0
        if (needed > 0) {
          remaining.set(candidate.toolCallId, needed - 1)
          const bucket = matched.get(candidate.toolCallId)
          if (bucket === undefined) matched.set(candidate.toolCallId, [candidate])
          else bucket.push(candidate)
          matchedIndexes.add(scan)
          lastMatch = scan
          pending -= 1
        }
      }
      scan += 1
    }

    // Incomplete batch: leave the logged order untouched. A different repair
    // path owns unresolved calls; inventing results here would hide them.
    if (pending > 0) continue

    // Emit results in CALL order. `pending === 0` guarantees one queued result
    // per call, so every shift yields a message.
    for (const call of calls) {
      const result = matched.get(call.id)?.shift()
      if (result !== undefined) ordered.push(result)
    }
    // Everything interleaved before the last matched result is displaced after
    // the batch, in its original relative order.
    for (let index = cursor; index <= lastMatch; index += 1) {
      if (matchedIndexes.has(index)) continue
      const displaced = messages[index]
      if (displaced !== undefined) ordered.push(displaced)
    }
    cursor = lastMatch + 1
  }

  return ordered
}
