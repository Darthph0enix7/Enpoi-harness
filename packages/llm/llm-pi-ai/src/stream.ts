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
  LlmError, parseProviderRetryAfterMs, QUOTA_EXCEEDED_CODE,
} from '@deepseek-ai/dsh-llm'
import type { FinishReason, StreamChunk, TokenUsage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { isContextOverflow } from '@earendil-works/pi-ai/utils/overflow'
import type { AssistantMessage, AssistantMessageEvent, Usage as PiUsage } from '@earendil-works/pi-ai'
import { toPiReplayState } from './replay.ts'
import type { HttpResponseFacts } from './response-capture.ts'

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
  // in other harnesses", anomalyco/opencode#49621). Policy, not auth: the
  // provider's other models repeat it, so a model group skips the provider
  // while the pool still never rotates keys over it.
  if (isFreeTierGatedError(message)) return FREE_TIER_GATED_CODE
  // A paid-model / sign-in wall is route-level, not payload-level: Kilo answers
  // `400 {"code":"PAID_MODEL_AUTH_REQUIRED", ...}` (and sibling gateways spell
  // the same idea `AUTH_REQUIRED`/`SIGN_IN_REQUIRED`/`SUBSCRIPTION_REQUIRED`).
  // The machine code decides before prose entitlement: without this check the
  // bare `400` below classifies it INVALID_REQUEST, which is fatal and never
  // fails over to a provider that can serve the request.
  if (/\b(?:PAID_MODEL_AUTH_REQUIRED|AUTH_REQUIRED|SIGN_?IN_REQUIRED|LOGIN_REQUIRED|SUBSCRIPTION_REQUIRED)\b/i.test(message)) {
    return 'AUTH'
  }
  // A per-account entitlement gate (OpenCode Go: "An active OpenCode Go
  // subscription is required to use Go models.") is identity-specific: live
  // pool state showed sibling identities serving the same model while one
  // account was gated. A route with a credential pool rotates and cools the
  // gated identity for a long period; this single-credential layer reports the
  // terminal code so the caller can fail over to another route or provider.
  if (isEntitlementGatedError(message)) return ENTITLEMENT_GATED_CODE
  // Prose sign-in wording without a machine code gets the same route-level
  // class; a bare `400` must not turn it into a fatal payload rejection.
  if (/\b(?:need|must|have)\s+to\s+sign[\s-]?in\b/i.test(message)
    || /\bsign[\s-]?in\s+(?:is\s+)?required\b/i.test(message)) {
    return 'AUTH'
  }
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
 * Parse the JSON error envelope carried inside a flattened pi-ai error text.
 * @param text - the flattened pi-ai error message.
 * @returns the outer object and, when present, its nested `error` object.
 */
function providerErrorEnvelope(
  text: string,
): { outer: Record<string, unknown>; inner?: Record<string, unknown> } | undefined {
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
  const outer = body as Record<string, unknown>
  return {
    outer,
    ...typeof outer.error === 'object' && outer.error !== null
      ? { inner: outer.error as Record<string, unknown> }
      : {},
  }
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
  const envelope = providerErrorEnvelope(text)
  if (envelope === undefined) return undefined
  // OpenAI-shaped envelopes carry `code`; Anthropic Messages carries the same
  // idea as `type` (`authentication_error`). The nested record answers each
  // field first and the outer envelope fills a gap it leaves, because gateways
  // nest only the machine code while repeating the human message beside it (or
  // the reverse).
  const code = textField(envelope.inner, 'code') ?? textField(envelope.inner, 'type')
    ?? textField(envelope.outer, 'code') ?? textField(envelope.outer, 'type')
  const detail = textField(envelope.inner, 'message') ?? textField(envelope.outer, 'message')
  if (code !== undefined && detail !== undefined) return `${code}: ${detail}`
  return detail ?? code
}

/** Read one non-empty string field out of an envelope record. */
function textField(record: Record<string, unknown> | undefined, field: string): string | undefined {
  const value = record?.[field]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * Resolve the provider reset hint for one terminal error.
 *
 * The body envelope wins when both sources carry a hint: it belongs to the
 * exact failed attempt and gateways put their own queue delay in
 * `retry_after_ms`, while `Retry-After` may be stamped by an intermediary that
 * is not the principal enforcing the limit. The captured header is the
 * fallback for a hint the body does not repeat; the core parser interprets both.
 */
function providerResetMs(text: string, facts: HttpResponseFacts | undefined): number | undefined {
  return parseProviderRetryAfterMs({ message: text })
    ?? parseProviderRetryAfterMs({ retryAfterHeader: facts?.retryAfterHeader })
}

/**
 * Map a terminal pi-ai event to the harness finish reason.
 * @param message - the assistant message carried by the `done` or `error` event.
 * @param contextWindow - resolved catalog capacity for usage-based overflow detection.
 * @param responseFacts - HTTP facts captured before pi-ai flattened a pre-stream
 *   failure into error text; absent for in-stream errors and stream protocols
 *   that cannot accept a custom fetch.
 * @returns the mapped harness reason. Recognized error text, `stop` usage above
 *   `contextWindow`, and zero-output `length` usage that fills the window map
 *   to `CONTEXT_WINDOW_EXCEEDED`; a completed `stop` with no non-empty text
 *   block and no tool call maps to an `EMPTY_RESPONSE` error, while terminal
 *   `pending` and `deferred` states map to non-retryable `PI_AI_ERROR` failures.
 */
export function mapStopReason(
  message: AssistantMessage,
  contextWindow?: number,
  responseFacts?: HttpResponseFacts,
): FinishReason {
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

  // A completed response is successful only when it carries something a
  // consumer can retain: non-empty text or a tool call. Reasoning and usage
  // do not count, so a gateway that answers 200 with an empty text block (the
  // Kilo free route) or reasoning only is an EMPTY_RESPONSE, not a silent
  // successful turn. Tool-call-only and text-only steps stay successful.
  const hasAnswer = message.content.some(block =>
    block.type === 'toolCall' || (block.type === 'text' && block.text.length > 0))
  const emptyResponse = (): FinishReason => ({
    kind: 'error',
    failure: {
      message: `model "${message.model}" returned a completed response with no content`,
      code: EMPTY_RESPONSE_CODE,
    },
  })

  switch (message.stopReason) {
    case 'stop':
      if (!hasAnswer) return emptyResponse()
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
      // pi-ai flattens a pre-stream HTTP failure to text, so the response body
      // becomes the message envelope here; the captured header is the only
      // remaining source for a `Retry-After` the SDK consumed.
      const retryAfterMs = providerResetMs(text, responseFacts)
      const status = responseFacts?.status
      return {
        kind: 'error',
        failure: {
          message: explained,
          code,
          ...status === undefined ? {} : { status },
          ...retryAfterMs === undefined ? {} : { providerRetryAfterMs: retryAfterMs },
        },
      }
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
 * @param responseFacts - reads the HTTP facts captured for this attempt; called
 *   at the terminal event so a pre-stream failure carries its response status
 *   and header hint that pi-ai flattened away.
 * @returns the harness chunks, ending with `usage` then `finish`; throws
 *   `LlmError` (`STREAM_CLOSED`) if the source ends without a terminal event.
 */
export async function* toStreamChunks(
  events: AsyncIterable<AssistantMessageEvent>,
  contextWindow?: number,
  callerSignal?: AbortSignal,
  requestedModel?: string,
  responseFacts?: () => HttpResponseFacts | undefined,
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
          reason: mapStopReason(event.message, contextWindow, responseFacts?.()),
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
            responseFacts?.(),
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
