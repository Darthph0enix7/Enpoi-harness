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
 * - A batch with any genuinely missing result is left exactly as logged;
 *   {@link completeToolBatches} is the separate repair path that synthesizes a
 *   result for each unresolved call. No message is ever invented, dropped, or
 *   mutated: the same frozen references are returned in a new array.
 * - The walk is single-pass: the cursor advances past each batch it rewrites,
 *   so the result is idempotent.
 *
 * @module dsh-agent-loop/request-order
 */

import { brandString } from '@deepseek-ai/dsh-brand'
import type { Message, MessageId, ToolCallBlock, ToolCallId, ToolResultMessage } from '@deepseek-ai/dsh-llm'
import { interruptedToolRecovery } from '@deepseek-ai/dsh-session'
import { deepFreeze } from '@deepseek-ai/dsh-util-values'

const NO_TOOL_CALLS: readonly ToolCallBlock[] = []

/** Message-id prefix of a recovery result synthesized only for one request. */
const REQUEST_TOOL_RESULT_PREFIX = 'request-tool-result'

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

/**
 * Synthesize transient recovery results for assistant tool calls no `tool`
 * message answers, so a request never carries an orphan call. This is the
 * request-boundary backstop for logs that still hold an unanswered call —
 * history written before the live turn close existed, a resumed interior turn,
 * or a future path that bypasses both.
 *
 * Each batch collects the `tool` messages answering its calls until the next
 * assistant message carrying tool calls begins. A call without an answer gets
 * a frozen synthetic error message in call order; the message-level view
 * cannot prove the call never started, so it states the shared
 * `TOOL_OUTCOME_UNKNOWN` wording rather than the not-started text.
 *
 * Nothing here touches the session log: the returned array belongs to one
 * request, and {@link orderToolBatches} normalizes adjacency afterwards. The
 * input elements are returned by reference and never mutated. A second pass
 * over the result adds nothing because every call is already answered.
 *
 * @param messages - the derived conversation, in durable order.
 * @returns a new array holding the same messages plus one frozen recovery
 *   result per unanswered call.
 */
export function completeToolBatches(messages: readonly Message[]): Message[] {
  const recovered: Message[] = []
  let syntheticIndex = 0
  const outcome = interruptedToolRecovery(true)

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]
    // The loop condition bounds the cursor; this guard keeps the read total.
    if (message === undefined) break
    recovered.push(message)

    const calls = toolCallsOf(message)
    if (calls.length === 0) continue

    // Duplicate call ids consume their answers in encounter order, exactly as
    // the adjacency pass pairs them.
    const remaining = new Map<ToolCallId, number>()
    for (const call of calls) remaining.set(call.id, (remaining.get(call.id) ?? 0) + 1)
    for (let scan = index + 1; scan < messages.length; scan += 1) {
      const candidate = messages[scan]
      if (candidate === undefined) break
      // A following batch owns everything from here on.
      if (hasToolCalls(candidate)) break
      if (candidate.role !== 'tool') continue
      const needed = remaining.get(candidate.toolCallId) ?? 0
      if (needed > 0) remaining.set(candidate.toolCallId, needed - 1)
    }

    for (const call of calls) {
      const needed = remaining.get(call.id) ?? 0
      if (needed === 0) continue
      remaining.set(call.id, needed - 1)
      recovered.push(deepFreeze({
        id: brandString<MessageId>(`${REQUEST_TOOL_RESULT_PREFIX}-${call.id}-${syntheticIndex++}`),
        role: 'tool',
        toolCallId: call.id,
        isError: true,
        source: { kind: 'tool', callId: call.id },
        content: [{ type: 'text', text: outcome.text }],
      }))
    }
  }

  return recovered
}
