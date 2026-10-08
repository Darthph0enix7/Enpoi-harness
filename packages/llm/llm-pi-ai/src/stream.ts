/**
 * pi-ai assistant event translation into the Harness streaming protocol.
 *
 * pi-ai tool-call arguments are parsed objects while the Harness keeps their
 * raw JSON representation. pi-ai also reports failures as terminal stream
 * events, which this module maps into Harness finish chunks.
 *
 * @module dsh-llm-pi-ai/stream
 */

import { brandString } from '@deepseek-ai/dsh-brand'
import {
  STREAM_CLOSED_CODE, CONTEXT_WINDOW_EXCEEDED_CODE, EMPTY_RESPONSE_CODE, ENTITLEMENT_GATED_CODE,
  ENTITLEMENT_GATED_EXPLANATION, FREE_TIER_GATED_CODE, FREE_TIER_GATED_EXPLANATION,
  isContextWindowExceededError, isEntitlementGatedError, isFreeTierGatedError, isQuotaExceededError,
  LlmError, QUOTA_EXCEEDED_CODE,
} from '@deepseek-ai/dsh-llm'
import type { FinishReason, StreamChunk, TokenUsage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { isContextOverflow } from '@earendil-works/pi-ai/utils/overflow'
import type { AssistantMessage, AssistantMessageEvent, Usage as PiUsage } from '@earendil-works/pi-ai'
import { toPiReplayState } from './replay.ts'

/**
 * Map pi-ai usage (reasoning folded into output by pi-ai).
 * @param usage - cumulative usage from the terminal pi-ai event.
 * @returns harness counts with pi-ai's exact total; cache fields appear only
 *   when non-zero (pi-ai reports zeros, not absence).
 */
export function mapUsage(usage: PiUsage): TokenUsage {
  return {
    inputTokens: usage.input,
    outputTokens: usage.output,
    totalTokens: usage.totalTokens,
    ...usage.cacheRead > 0 ? { cacheReadTokens: usage.cacheRead } : {},
    ...usage.cacheWrite > 0 ? { cacheWriteTokens: usage.cacheWrite } : {},
  }
}

// XXX(pi-ai upstream): pi-ai flattens the caught error to `error.message`
// (api/anthropic-messages.js: `errorMessage = error instanceof Error ?
// error.message : JSON.stringify(error)`), discarding the original Error and its
// `cause` chain before it reaches us. undici carries the actionable transport
// detail on `cause` (e.g. `SocketError: other side closed`) but hands the fetch
// wrapper a bare `terminated`, so we are left pattern-matching terse words here.
// If pi-ai ever forwards the original Error (or a fetch/dispatcher hook that lets
// us capture the cause ourselves), classify on `code`/`cause` instead of text.
function classifyPiAiError(message: string): string {
  // OpenCode's `-free` models answer 403 FreeTierError to non-OpenCode
  // clients; the team states the rule directly ("You cannot use the free tier
  // in other harnesses", anomalyco/opencode#49621). Policy, not auth: the code
  // stays terminal so the chain neither retries nor rotates keys over it.
  if (isFreeTierGatedError(message)) return FREE_TIER_GATED_CODE
  // A per-account entitlement gate (OpenCode Go: "An active OpenCode Go
  // subscription is required to use Go models.") is identity-specific: live
  // pool state showed sibling identities serving the same model while one
  // account was gated. A route with a credential pool rotates and cools the
  // gated identity for a long period; this single-credential layer reports the
  // terminal code so the caller can fail over to another route or provider.
  if (isEntitlementGatedError(message)) return ENTITLEMENT_GATED_CODE
  if (/\b(?:401|403)\b/.test(message)) return 'AUTH'
  if (isQuotaExceededError(message)) return QUOTA_EXCEEDED_CODE
  if (/\b429\b|rate.?limit/i.test(message)) return 'RATE_LIMIT'
  // A gateway reporting a degenerate upstream completion in prose (Kilo's
  // `Provider returned an empty response`) is the same provider-side failure as
  // a terminal stop with no content blocks below: transient, and recoverable
  // through the EMPTY_RESPONSE code llm-retry already retries.
  if (/returned an empty response/i.test(message)) return EMPTY_RESPONSE_CODE
  // A rejected request body (gateway or provider size cap): resending the
  // same request cannot succeed, so it is invalid, not transient.
  if (/\b413\b|failed to buffer the request body:\s*length limit exceeded|payload too large|request body too large/i.test(message)) return 'INVALID_REQUEST'
  if (/\b400\b|invalid.?request/i.test(message)) return 'INVALID_REQUEST'
  if (/\b5\d\d\b/.test(message)) return 'SERVER'
  // A provider or gateway reporting a capacity rejection in prose ("Upstream
  // error from Nvidia: Service temporarily overloaded") is the same transient
  // overload the credential pool classifies as CAPACITY and rotates over.
  // Without a pool there is nothing to rotate, so the failure must carry the
  // retryable SERVER family; the catch-all PI_AI_ERROR below is accepted by no
  // retry policy, and the live Mac/PC routes lost ~20 turns to exactly this
  // wording arriving without a status code.
  if (/\boverloaded\b|temporarily\s+unavailable\b|\bserver\s+is\s+busy\b|model_capacity/i.test(message)) return 'SERVER'
  if (/\btime(?:d)?\s*out\b|timeout/i.test(message)) return 'TIMEOUT'
  // A stream truncated before the provider's terminal event: each pi-ai provider
  // throws its own wording when the wire closes mid-response without a terminal
  // event (`… stream ended before message_stop`, `… before a terminal response
  // event`, `… ended without a terminal event`, `Stream ended without
  // finish_reason`). The connection dropped mid-response, so this is a transport
  // truncation, not a model-level error.
  if (/stream ended (?:before|without)\b/i.test(message)) return 'TRANSPORT'
  if (/\b(?:network|connection|socket|fetch)\b|\bECONN[A-Z]+\b/i.test(message)
    || /\b(?:other side closed|HTTP2 request did not get a response|WebSocket closed unexpectedly)\b/i.test(message)
    // undici renders a mid-stream socket drop as a bare `terminated` (its
    // `cause` — the real SocketError — was flattened away upstream); Node's
    // stream layer says `Premature close`.
    || /\bterminated\b|premature close/i.test(message)) {
    return 'TRANSPORT'
  }
  return 'PI_AI_ERROR'
}

/**
 * Recover the provider's own `code: message` from the JSON error envelope pi-ai
 * flattens into its error text. pi-ai composes a non-2xx body as
 * `<status>: <json body>` (upstream `utils/error-body.ts`) and discards the
 * structured error, so a gateway's machine code (Kilo's
 * `PAID_MODEL_AUTH_REQUIRED`, `INVALID_TOKEN`) would otherwise be unreadable.
 * Only the semantic pair is returned; the raw envelope (and any credential
 * fragment it might echo) is not carried into the failure.
 * @param text - the flattened pi-ai error message.
 * @returns `CODE: message`, a lone `message`, or undefined when no JSON envelope is present.
 */
export function providerErrorDetail(text: string): string | undefined {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return undefined
  let body: unknown
  try {
    body = JSON.parse(text.slice(start, end + 1))
  } catch {
    return undefined
  }
  if (typeof body !== 'object' || body === null) return undefined
  const outer = body as { error?: unknown }
  const record = typeof outer.error === 'object' && outer.error !== null
    ? outer.error as Record<string, unknown>
    : outer as Record<string, unknown>
  // OpenAI-shaped envelopes carry `code`; Anthropic Messages carries the same
  // idea as `type` (`authentication_error`).
  const code = typeof record.code === 'string' && record.code.length > 0
    ? record.code
    : typeof record.type === 'string' && record.type.length > 0 ? record.type : undefined
  const detail = typeof record.message === 'string' && record.message.length > 0 ? record.message : undefined
  if (code !== undefined && detail !== undefined) return `${code}: ${detail}`
  return detail ?? code
}

/**
 * Map a terminal pi-ai event to the harness finish reason.
 * @param message - the assistant message carried by the `done` or `error` event.
 * @param contextWindow - resolved catalog capacity for usage-based overflow detection.
 * @returns the mapped harness reason. Recognized error text, `stop` usage above
 *   `contextWindow`, and zero-output `length` usage that fills the window map
 *   to `CONTEXT_WINDOW_EXCEEDED`; a `stop` with no content blocks maps to an
 *   `EMPTY_RESPONSE` error, while terminal `pending` and `deferred` states map
 *   to non-retryable `PI_AI_ERROR` failures.
 */
export function mapStopReason(message: AssistantMessage, contextWindow?: number): FinishReason {
  const piAiOverflow = isContextOverflow(message, contextWindow)
  const harnessOverflow = message.stopReason === 'error'
    && message.errorMessage !== undefined
    && isContextWindowExceededError(message.errorMessage)
  if (piAiOverflow || harnessOverflow) {
    return {
      kind: 'error',
      failure: {
        message: message.errorMessage ?? `pi-ai detected context overflow for model "${message.model}"`,
        code: CONTEXT_WINDOW_EXCEEDED_CODE,
      },
    }
  }

  switch (message.stopReason) {
    case 'stop':
      // A terminal stop that produced no content blocks is a degenerate
      // provider completion, not a successful (empty) assistant message.
      if (message.content.length === 0) {
        return {
          kind: 'error',
          failure: {
            message: `model "${message.model}" returned a completed response with no content`,
            code: EMPTY_RESPONSE_CODE,
          },
        }
      }
      return { kind: 'stop' }
    case 'length': return { kind: 'max-tokens' }
    case 'toolUse': return { kind: 'tool-calls' }
    case 'pending': return {
      kind: 'error',
      failure: { message: `pi-ai stream for model "${message.model}" ended pending`, code: 'PI_AI_ERROR' },
    }
    case 'deferred': return {
      kind: 'error',
      failure: { message: `pi-ai deferred response for model "${message.model}" is not supported`, code: 'PI_AI_ERROR' },
    }
    case 'aborted': return {
      kind: 'aborted',
      failure: { message: message.errorMessage ?? 'pi-ai stream aborted', code: 'ABORTED' },
    }
    case 'error': {
      const text = message.errorMessage ?? 'pi-ai stream error'
      const code = classifyPiAiError(text)
      // An auth failure carries the provider's own code and message (e.g.
      // `PAID_MODEL_AUTH_REQUIRED: You need to sign in to use this model.`)
      // so the UI can headline its localized copy and append the actionable
      // detail, instead of collapsing to the generic key message. The raw
      // envelope stays in the log's message when it has no readable pair.
      const detail = code === 'AUTH' ? providerErrorDetail(text) : undefined
      // A gated free-tier or entitlement route fails identically on every
      // attempt at this layer, so the user-facing failure carries the policy
      // explanation, not just the provider's raw envelope.
      const explained = code === FREE_TIER_GATED_CODE
        ? `${text} — ${FREE_TIER_GATED_EXPLANATION}`
        : code === ENTITLEMENT_GATED_CODE
          ? `${text} — ${ENTITLEMENT_GATED_EXPLANATION}`
          : detail ?? text
      return { kind: 'error', failure: { message: explained, code } }
    }
  }
}

/**
 * Translate the pi-ai event stream into StreamChunks. pi-ai never throws
 * mid-stream — failures arrive as `error` events, which become error/aborted
 * `finish` chunks (the harness protocol's other error-delivery style).
 * @param events - one assistant turn's pi-ai event stream.
 * @param contextWindow - resolved catalog capacity for usage-based overflow detection.
 * @param callerSignal - caller cancellation state; an aborted caller makes any
 *   in-band terminal error an aborted finish.
 * @param requestedModel - request model identity recorded for durable replay.
 * @returns the harness chunks, ending with `usage` then `finish`; throws
 *   `LlmError` (`STREAM_CLOSED`) if the source ends without a terminal event.
 */
export async function* toStreamChunks(
  events: AsyncIterable<AssistantMessageEvent>,
  contextWindow?: number,
  callerSignal?: AbortSignal,
  requestedModel?: string,
): AsyncGenerator<StreamChunk> {
  // pi-ai contentIndex ↔ our block index map 1:1 (both count blocks from 0
  // in stream order), but we track ids per index for tool calls.
  const toolIds = new Map<number, { id: string; name: string }>()

  for await (const event of events) {
    switch (event.type) {
      case 'start':
        break
      case 'text_start':
        yield { type: 'block-start', index: event.contentIndex, blockType: 'text' }
        break
      case 'text_delta':
        yield { type: 'text-delta', index: event.contentIndex, text: event.delta }
        break
      case 'text_end':
        yield { type: 'block-end', index: event.contentIndex, block: { type: 'text', text: event.content } }
        break
      case 'thinking_start':
        yield { type: 'block-start', index: event.contentIndex, blockType: 'reasoning' }
        break
      case 'thinking_delta':
        yield { type: 'reasoning-delta', index: event.contentIndex, text: event.delta }
        break
      case 'thinking_end':
        yield { type: 'block-end', index: event.contentIndex, block: { type: 'reasoning', text: event.content } }
        break
      case 'toolcall_start': {
        // The id/name live on the partial's content at this index.
        const partial = event.partial.content[event.contentIndex]
        const id = partial?.type === 'toolCall' ? partial.id : ''
        const name = partial?.type === 'toolCall' ? partial.name : ''
        toolIds.set(event.contentIndex, { id, name })
        yield { type: 'block-start', index: event.contentIndex, blockType: 'tool-call' }
        break
      }
      case 'toolcall_delta': {
        const known = toolIds.get(event.contentIndex)
        yield {
          type: 'tool-call-delta',
          index: event.contentIndex,
          id: brandString<ToolCallId>(known?.id ?? ''),
          ...known?.name !== undefined && known.name.length > 0 ? { name: known.name } : {},
          argumentsDelta: event.delta,
        }
        break
      }
      case 'toolcall_end':
        yield {
          type: 'block-end',
          index: event.contentIndex,
          block: {
            type: 'tool-call',
            id: brandString<ToolCallId>(event.toolCall.id),
            name: event.toolCall.name,
            // pi-ai hands back the PARSED arguments; the harness vocabulary
            // keeps the raw string.
            arguments: JSON.stringify(event.toolCall.arguments),
          },
        }
        break
      case 'done':
        yield { type: 'usage', usage: mapUsage(event.message.usage) }
        yield {
          type: 'finish',
          reason: mapStopReason(event.message, contextWindow),
          replayState: toPiReplayState(event.message, requestedModel),
        }
        return
      case 'error':
        // In-stream error delivery (pi-ai's style) → error finish chunk
        // (the harness's other sanctioned error path besides throwing).
        yield { type: 'usage', usage: mapUsage(event.error.usage) }
        yield {
          type: 'finish',
          reason: mapStopReason(
            callerSignal?.aborted ? { ...event.error, stopReason: 'aborted' } : event.error,
            contextWindow,
          ),
        }
        return
      // no default: AssistantMessageEvent is pi-ai's closed union; a new
      // event type should fail compilation here via tsc's exhaustiveness
      // when one is added (switch covers all current variants).
    }
  }
  throw new LlmError('pi-ai event stream ended without done/error', STREAM_CLOSED_CODE)
}
