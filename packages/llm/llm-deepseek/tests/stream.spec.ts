/** Protocol invariants at JSON/SSE boundaries, including partial and failed responses. */
import { describe, expect, it } from 'vitest'
import { POLICY_REFUSAL_CODE } from '@deepseek-ai/dsh-llm'
import { translate } from '../src/translate.ts'
import { parseSse } from '../src/sse.ts'
import { providerError } from '../src/transport.ts'
import { assemble, chunks, end, events, MODEL, sse, start, textEvents } from './helpers.ts'

describe('Messages stream', () => {
  it('streams text already present in the starting block', async () => {
    const result = await chunks(translate(events([start, { ...textEvents[1], content_block: { type: 'text', text: 'initial' } }, textEvents[3]!, ...end()]), MODEL))
    expect(result).toContainEqual({ type: 'text-delta', index: 0, text: 'initial' })
    expect(providerError({ error: { code: 'insufficient_balance' } }, 400)).toMatchObject({ code: 'QUOTA' })
  })

  it('emits first-seen blocks, raw tool JSON and cumulative disjoint usage before finish', async () => {
    const values = [
      { ...start, message: { usage: { input_tokens: 12, output_tokens: 1, cache_read_input_tokens: 30, cache_creation_input_tokens: 7 } } },
      { type: 'content_block_start', index: 4, content_block: { type: 'thinking', thinking: 'first', signature: '' } },
      { type: 'content_block_delta', index: 4, delta: { type: 'thinking_delta', thinking: ' thought' } },
      { type: 'content_block_delta', index: 4, delta: { type: 'signature_delta', signature: 'sig' } },
      { type: 'content_block_delta', index: 4, delta: { type: 'signature_delta', signature: 'nature' } },
      { type: 'content_block_stop', index: 4 },
      { type: 'content_block_start', index: 9, content_block: { type: 'tool_use', id: 'call_1', name: 'read', input: {} } },
      { type: 'content_block_delta', index: 9, delta: { type: 'input_json_delta', partial_json: '{"path":' } },
      { type: 'content_block_delta', index: 9, delta: { type: 'input_json_delta', partial_json: ' "a"}' } },
      { type: 'content_block_stop', index: 9 },
      { type: 'message_delta', delta: {}, usage: { output_tokens: 3 } },
      ...end('tool_use'),
    ]
    const result = await assemble(translate(events(values), MODEL))
    expect(result.message.content).toEqual([{ type: 'reasoning', text: 'first thought' }, { type: 'tool-call', id: 'call_1', name: 'read', arguments: '{"path": "a"}' }])
    expect(result.output.at(-2)).toEqual({ type: 'usage', usage: { inputTokens: 12, outputTokens: 5, cacheReadTokens: 30, cacheWriteTokens: 7, totalTokens: 54 } })
    expect(result.output.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'tool-calls' }, replayState: { blocks: [{ type: 'reasoning', signature: 'signature' }, { type: 'tool-call' }] } })
    expect(result.output.filter(chunk => chunk.type === 'block-start').map(chunk => chunk.index)).toEqual([0, 1])
  })

  it.each(['end_turn', 'stop_sequence'])('maps %s and ignores forward-compatible envelope events', async (reason) => {
    const result = await chunks(translate(events([start, { type: 'future_event' }, ...textEvents.slice(1, 4), ...end(reason)]), MODEL))
    expect(result.at(-1)).toMatchObject({ reason: { kind: 'stop' } })
  })

  it.each([{}, { key: 'initial' }])('preserves initial tool input %j without JSON deltas', async (input) => {
    const result = await assemble(translate(events([start,
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'a', name: 'read', input } },
      { type: 'content_block_stop', index: 0 }, ...end('tool_use')]), MODEL))
    expect(result.message.content[0]).toMatchObject({ arguments: JSON.stringify(input) })
  })

  it('preserves signature-only thinking and prunes truncated tools with their replay entries', async () => {
    const result = await assemble(translate(events([start,
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'opaque' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'a', name: 'read', input: {} } },
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{' } },
      { type: 'content_block_stop', index: 1 }, ...end('max_tokens')]), MODEL))
    expect(result.message.content).toEqual([{ type: 'reasoning', text: '' }])
    expect(result.message.source.replayState).toMatchObject({ blocks: [{ type: 'reasoning', signature: 'opaque' }] })
  })

  it.each([
    [start, start],
    [textEvents[1]],
    [start, { ...textEvents[1], index: -1 }],
    [start, textEvents[1], textEvents[1]],
    [start, { type: 'content_block_stop', index: 0 }],
    [start, textEvents[1], textEvents[3], textEvents[3]],
    [start, { ...textEvents[1], content_block: { type: 'text', text: 2 } }],
    [start, textEvents[1], { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'bad' } }],
    [start, { type: 'message_delta', delta: { stop_reason: 'mystery' } }],
    [start, { type: 'message_stop' }],
    [start, textEvents[1], ...end()],
    [start, { type: 'message_delta', delta: {}, usage: { input_tokens: -1 } }],
    [start, { type: 'message_delta', delta: { stop_reason: 'end_turn' } }, textEvents[1]],
    [start, { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: '', name: 'read', input: {} } }],
    [start, { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'x', name: 'read', input: [] } }],
  ])('rejects malformed event ordering or fields %#', async (...values) => {
    await expect(chunks(translate(events(values as Record<string, unknown>[]), MODEL))).rejects.toMatchObject({ code: 'MALFORMED_RESPONSE' })
  })

  it.each(['{', '[]'])('refuses completed non-object tool JSON %s without repairing it', async (partial_json) => {
    await expect(chunks(translate(events([start,
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'a', name: 'read', input: {} } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json } },
      { type: 'content_block_stop', index: 0 }, ...end('tool_use')]), MODEL))).rejects.toMatchObject({ code: 'MALFORMED_RESPONSE' })
  })

  it('refuses unsupported response content, empty responses and premature EOF', async () => {
    await expect(chunks(translate(events([start, { type: 'content_block_start', index: 0, content_block: { type: 'redacted_thinking', data: 'x' } }]), MODEL))).rejects.toMatchObject({ code: 'UNSUPPORTED_CONTENT' })
    await expect(chunks(translate(events([start, ...end()]), MODEL))).rejects.toMatchObject({ code: 'EMPTY_RESPONSE' })
    await expect(chunks(translate(events([start, { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }, { type: 'content_block_stop', index: 0 }, ...end()]), MODEL))).rejects.toMatchObject({ code: 'EMPTY_RESPONSE' })
    await expect(chunks(translate(events([start, { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }, { type: 'content_block_stop', index: 0 }, ...end()]), MODEL))).rejects.toMatchObject({ code: 'EMPTY_RESPONSE' })
    await expect(chunks(translate(events(textEvents.slice(0, -1)), MODEL))).rejects.toMatchObject({ code: 'STREAM_CLOSED' })
  })

  it('does not infer a refusal from assistant text that discusses refusal vocabulary', async () => {
    const result = await assemble(translate(events([start,
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'This answer may discuss refusal, content_filter, quota, and authentication.' } },
      { type: 'content_block_stop', index: 0 }, ...end()]), MODEL))
    expect(result.assembler.finish).toEqual({ kind: 'stop' })
  })

  it.each([
    [{ stop_reason: 'content_filter', content_filter: { reason: 'provider policy' } }, 'provider policy'],
    [{ stop_reason: 'refusal', refusal: 'provider safety block' }, 'provider safety block'],
    [{ finish_reason: 'content_filter', message: 'structured finish explanation' }, 'structured finish explanation'],
    [{ finish_reason: 'incomplete.content_filter', message: 'incomplete refusal' }, 'incomplete refusal'],
  ])('terminates a structured policy stop with usage and its explanation %#', async (delta, explanation) => {
    const result = await chunks(translate(events([start,
      { type: 'message_delta', delta, usage: { output_tokens: 5 } },
      { type: 'message_stop' }]), MODEL))
    expect(result.at(-2)).toEqual({
      type: 'usage',
      usage: { inputTokens: 12, outputTokens: 5, totalTokens: 17 },
    })
    expect(result.at(-1)).toEqual({
      type: 'finish',
      reason: { kind: 'error', failure: { message: explanation, code: POLICY_REFUSAL_CODE } },
    })
  })

  it('terminates a structured in-band refusal event with accumulated usage', async () => {
    const result = await chunks(translate(events([start,
      { type: 'error', error: { code: 'content_filter', message: 'provider explanation', usage: { output_tokens: 2 } } }]), MODEL))
    expect(result.at(-2)).toEqual({
      type: 'usage',
      usage: { inputTokens: 12, outputTokens: 2, totalTokens: 14 },
    })
    expect(result.at(-1)).toEqual({
      type: 'finish',
      reason: { kind: 'error', failure: { message: 'provider explanation', code: POLICY_REFUSAL_CODE } },
    })
  })
})

describe('SSE framing and provider failures', () => {
  async function read(text: string, bytewise = false) {
    const bytes = new TextEncoder().encode(text)
    let offset = 0
    const body = new ReadableStream<Uint8Array<ArrayBuffer>>({ pull(controller) {
      if (offset === bytes.length) { controller.close(); return }
      const end = bytewise ? offset + 1 : bytes.length
      controller.enqueue(bytes.slice(offset, end)); offset = end
    } })
    let activity = 0
    const result = await chunks(translate(parseSse(body, () => { activity++ }), MODEL))
    return { result, activity }
  }
  it('frames UTF-8 split at every byte and counts comments and ping as transport activity', async () => {
    const result = await read(`\uFEFF: heartbeat\r\n\r\n${sse([{ type: 'ping' }, ...textEvents]).replaceAll('\n', '\r\n')}`, true)
    expect(result.result).toContainEqual({ type: 'text-delta', index: 0, text: 'Hello 世界' })
    expect(result.activity).toBe(textEvents.length + 2)
  })
  it.each(['data: not-json\n\n', 'data: []\n\n', 'event: ping\ndata: {"type":"other"}\n\n', 'data: {}\n\n'])('rejects malformed SSE %#', async (text) => {
    await expect(read(text)).rejects.toMatchObject({ code: 'MALFORMED_RESPONSE' })
  })
  it('does not flush an unterminated terminal event', async () => {
    await expect(read(sse(textEvents).trimEnd())).rejects.toMatchObject({ code: 'STREAM_CLOSED' })
  })
  it('normalizes in-band overloads', async () => {
    await expect(read(sse([{ type: 'error', error: { type: 'overloaded_error', message: 'busy' } }]))).rejects.toMatchObject({ code: 'SERVER' })
  })
  it.each([
    [401, {}, 'AUTH'], [403, {}, 'AUTH'], [402, {}, 'QUOTA'], [429, {}, 'RATE_LIMIT'],
    [400, {}, 'INVALID_REQUEST'], [413, {}, 'INVALID_REQUEST'], [503, {}, 'SERVER'], [404, {}, 'HTTP_404'],
    [undefined, { type: 'authentication_error' }, 'AUTH'], [undefined, { type: 'rate_limit_error' }, 'RATE_LIMIT'],
    [undefined, { type: 'invalid_request_error' }, 'INVALID_REQUEST'], [undefined, {}, 'SERVER'],
    [400, { message: 'maximum context length exceeded' }, 'CONTEXT_WINDOW_EXCEEDED'],
    [400, { message: 'insufficient balance' }, 'QUOTA'],
  ])('classifies status %s and error %j', (status, error, code) => {
    expect(providerError({ error }, status)).toMatchObject({ code })
  })
  it('retains request identity and valid Retry-After without inventing missing counters', () => {
    expect(providerError(null, 429, new Headers({ 'retry-after': '2', 'request-id': 'r1' })).failure).toMatchObject({ requestId: 'r1', providerRetryAfterMs: 2000 })
    expect(providerError({}, 503, new Headers({ 'retry-after': new Date(Date.now() + 60_000).toUTCString(), 'x-request-id': 'r2' })).failure.providerRetryAfterMs).toBeGreaterThan(0)
    expect(providerError({}, 500, new Headers({ 'retry-after': 'invalid', 'x-deepseek-request-id': 'r3' })).failure).toMatchObject({ requestId: 'r3' })
  })
  it('retains a reset hint carried only in the body envelope', () => {
    expect(providerError({ error: { message: 'slow down', retry_after_ms: 2_500 } }, 429).failure)
      .toMatchObject({ code: 'RATE_LIMIT', providerRetryAfterMs: 2_500 })
    expect(providerError({ error: { message: 'slow down', retry_after: 90 } }, 429).failure)
      .toMatchObject({ code: 'RATE_LIMIT', providerRetryAfterMs: 90_000 })
    // A gateway that answers non-JSON still carries an envelope in its text.
    expect(providerError({}, 429, undefined, '429: {"retry_after_ms":1200}').failure)
      .toMatchObject({ code: 'RATE_LIMIT', providerRetryAfterMs: 1_200 })
  })

  it('carries accumulated usage through an in-band structured refusal', async () => {
    const result = await read(sse([start,
      { type: 'error', error: { code: 'content_filter', message: 'quota wording must not win' }, usage: { output_tokens: 2 } }]))
    expect(result.result.at(-2)).toEqual({
      type: 'usage',
      usage: { inputTokens: 12, outputTokens: 2, totalTokens: 14 },
    })
    expect(result.result.at(-1)).toEqual({
      type: 'finish',
      reason: { kind: 'error', failure: { message: 'quota wording must not win', code: POLICY_REFUSAL_CODE } },
    })
  })

  it('maps structured refusal evidence before status, auth, and quota wording', () => {
    expect(providerError({ error: { code: 'content_filter', message: 'quota exceeded and authentication failed' } }, 500))
      .toMatchObject({ code: POLICY_REFUSAL_CODE, message: 'quota exceeded and authentication failed', failure: { status: 500 } })
    expect(providerError({ error: { type: 'refusal', message: 'safety stop' } }, 401))
      .toMatchObject({ code: POLICY_REFUSAL_CODE, message: 'safety stop' })
    expect(providerError({ error: { finish_reason: 'content_filter', message: 'blocked' } }, 429))
      .toMatchObject({ code: POLICY_REFUSAL_CODE, message: 'blocked' })
    expect(providerError({ error: { content_filter: { reason: 'violence' } } }, 500))
      .toMatchObject({ code: POLICY_REFUSAL_CODE, message: 'violence' })
    expect(providerError({ error: { refusal: 'provider explanation' } }, 500))
      .toMatchObject({ code: POLICY_REFUSAL_CODE, message: 'provider explanation' })
  })

  it('keeps ordinary prose and non-positive content_filter fields out of the refusal class', () => {
    expect(providerError({ error: { message: 'The model refused because of content_filter and quota wording' } }, 500).code).toBe('SERVER')
    expect(providerError({ error: { content_filter: false, message: 'ordinary server failure' } }, 500).code).toBe('SERVER')
    expect(providerError({ error: { content_filter: { filtered: false }, message: 'ordinary server failure' } }, 500).code).toBe('SERVER')
  })
})
