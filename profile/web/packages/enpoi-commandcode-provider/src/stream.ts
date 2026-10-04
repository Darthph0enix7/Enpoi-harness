/**
 * Command Code SSE → harness `StreamChunk` parsing.
 *
 * The wire is plain server-sent events carrying ONE JSON object per `data:`
 * line (multi-line `data:` fields are not used). Blank lines, `:` comments,
 * and `[DONE]` are ignored. Event vocabulary and finish-reason mapping follow
 * `INTEGRATION.md` §2.3.
 *
 * @module dsh-enpoi-commandcode-provider/stream
 */

import type { FinishReason, StreamChunk, TokenUsage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { LlmError } from '@deepseek-ai/dsh-llm'
import { classifyCommandCodeError } from './errors.js'

interface RawEvent extends Record<string, unknown> {
  type: string
}

interface OpenBlock {
  kind: 'text' | 'reasoning' | 'tool'
  index: number
  id: string
  toolName?: string
  text: string
  args: string
}

/** Parse an SSE byte stream into raw events (one JSON object per `data:` line). */
async function * rawEvents(source: AsyncIterable<Uint8Array>): AsyncGenerator<RawEvent> {
  const decoder = new TextDecoder()
  let buffer = ''
  for await (const chunk of source) {
    buffer += decoder.decode(chunk, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      const event = parseLine(line)
      if (event !== undefined) yield event
    }
  }
  const tail = parseLine(buffer)
  if (tail !== undefined) yield tail
}

function parseLine(rawLine: string): RawEvent | undefined {
  const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
  const trimmed = line.trim()
  if (trimmed === '' || trimmed.startsWith(':') || trimmed === '[DONE]') return undefined
  let json = trimmed
  if (json.startsWith('data: ')) json = json.slice(6)
  else if (json.startsWith('data:')) json = json.slice(5)
  if (json === '' || json === '[DONE]') return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    // A malformed line is skipped, exactly as the reference provider does:
    // one corrupt frame must not kill the whole stream.
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const event = parsed as Record<string, unknown>
  if (typeof event.type !== 'string') return undefined
  return event as RawEvent
}

function mapFinishReason(raw: string): FinishReason {
  switch (raw) {
    case 'stop':
    case 'end_turn':
      return { kind: 'stop' }
    case 'tool_calls':
    case 'tool-calls':
      return { kind: 'tool-calls' }
    case 'length':
    case 'max_tokens':
    case 'max-tokens':
    case 'max_output_tokens':
      return { kind: 'max-tokens' }
    default:
      return { kind: 'stop' }
  }
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * Map one `finish-step` usage object to disjoint harness counts:
 * `inputTokens` is uncached input only; cache reads/writes are separate.
 * @param raw - the `usage` object from the event.
 * @returns harness token accounting.
 */
export function mapUsage(raw: Record<string, unknown>): TokenUsage {
  const inputDetails = (raw.inputTokenDetails ?? raw.input_token_details ?? {}) as Record<string, unknown>
  const outputDetails = (raw.outputTokenDetails ?? raw.output_token_details ?? {}) as Record<string, unknown>
  const totalInput = numberOrUndefined(raw.inputTokens) ?? numberOrUndefined(raw.prompt_tokens)
  const totalOutput = numberOrUndefined(raw.outputTokens) ?? numberOrUndefined(raw.completion_tokens)
  const cacheReadTokens = numberOrUndefined(inputDetails.cacheReadTokens)
    ?? numberOrUndefined(inputDetails.cache_read_tokens)
  const cacheWriteTokens = numberOrUndefined(inputDetails.cacheWriteTokens)
    ?? numberOrUndefined(inputDetails.cache_write_tokens)
  const noCacheInput = numberOrUndefined(inputDetails.noCacheTokens)
    ?? numberOrUndefined(inputDetails.no_cache_tokens)
    ?? (totalInput === undefined
      ? undefined
      : Math.max(0, totalInput - (cacheReadTokens ?? 0) - (cacheWriteTokens ?? 0)))
  const reasoningTokens = numberOrUndefined(outputDetails.reasoningTokens)
    ?? numberOrUndefined(outputDetails.reasoning_tokens)
  return {
    inputTokens: noCacheInput ?? 0,
    outputTokens: totalOutput ?? 0,
    ...totalInput === undefined || totalOutput === undefined
      ? {}
      : { totalTokens: totalInput + totalOutput },
    ...cacheReadTokens === undefined ? {} : { cacheReadTokens },
    ...cacheWriteTokens === undefined ? {} : { cacheWriteTokens },
    ...reasoningTokens === undefined ? {} : { reasoningTokens },
  }
}

/** Normalize `ReadableStream` and async-iterable sources to one async iterator. */
function asAsyncIterable(source: AsyncIterable<Uint8Array> | ReadableStream<Uint8Array>): AsyncIterable<Uint8Array> {
  const candidate = source as AsyncIterable<Uint8Array>
  if (typeof candidate[Symbol.asyncIterator] === 'function') return candidate
  const reader = (source as ReadableStream<Uint8Array>).getReader()
  return {
    [Symbol.asyncIterator]() {
      return {
        async next(): Promise<IteratorResult<Uint8Array>> {
          return reader.read()
        },
        async return(): Promise<IteratorResult<Uint8Array>> {
          await reader.cancel()
          return { done: true, value: undefined }
        },
      }
    },
  }
}

/**
 * Parse one Command Code SSE stream into harness chunks.
 *
 * Emits `block-start`/deltas/`block-end` for text, reasoning, and tool calls;
 * `usage` and a terminal `finish` after the first `finish-step`. A stream that
 * ends without one throws `STREAM_CLOSED`; an in-band `error` event throws its
 * classified failure so the runtime's retry policy sees the right code.
 * @param source - response body bytes.
 * @returns harness stream chunks, in wire order.
 */
export async function * parseCommandCodeStream(
  source: AsyncIterable<Uint8Array> | ReadableStream<Uint8Array>,
): AsyncGenerator<StreamChunk> {
  const blocks = new Map<string, OpenBlock>()
  let nextIndex = 0
  let metadataId: string | undefined
  let metadataModel: string | undefined

  const open = (key: string, kind: OpenBlock['kind'], id: string, toolName?: string): { block: OpenBlock; opened: boolean } => {
    const existing = blocks.get(key)
    if (existing !== undefined) {
      if (toolName !== undefined && existing.toolName === undefined) existing.toolName = toolName
      return { block: existing, opened: false }
    }
    const block: OpenBlock = { kind, index: nextIndex++, id, toolName, text: '', args: '' }
    blocks.set(key, block)
    return { block, opened: true }
  }

  function * closeBlock(block: OpenBlock): Generator<StreamChunk> {
    switch (block.kind) {
      case 'text':
        yield { type: 'block-end', index: block.index, block: { type: 'text', text: block.text } }
        return
      case 'reasoning':
        yield { type: 'block-end', index: block.index, block: { type: 'reasoning', text: block.text } }
        return
      case 'tool':
        yield {
          type: 'block-end',
          index: block.index,
          block: {
            type: 'tool-call',
            id: block.id as ToolCallId,
            name: block.toolName ?? '',
            arguments: block.args,
          },
        }
        return
      /* v8 ignore next 2 -- closed union */
      default:
        return
    }
  }

  for await (const event of rawEvents(asAsyncIterable(source))) {
    switch (event.type) {
      case 'text-start':
      case 'text-delta':
      case 'text-end': {
        const key = typeof event.id === 'string' ? `text:${event.id}` : 'text:__default'
        const { block, opened } = open(key, 'text', key)
        if (opened) yield { type: 'block-start', index: block.index, blockType: 'text' }
        const delta = event.type === 'text-delta' ? String(event.text ?? event.delta ?? '') : ''
        if (delta !== '') {
          block.text += delta
          yield { type: 'text-delta', index: block.index, text: delta }
        }
        if (event.type === 'text-end') {
          blocks.delete(key)
          yield * closeBlock(block)
        }
        continue
      }
      case 'reasoning-start':
      case 'reasoning-delta':
      case 'reasoning-end': {
        const key = typeof event.id === 'string' ? `reasoning:${event.id}` : 'reasoning:__default'
        const { block, opened } = open(key, 'reasoning', key)
        if (opened) yield { type: 'block-start', index: block.index, blockType: 'reasoning' }
        const delta = event.type === 'reasoning-delta' ? String(event.text ?? event.delta ?? '') : ''
        if (delta !== '') {
          block.text += delta
          yield { type: 'reasoning-delta', index: block.index, text: delta }
        }
        if (event.type === 'reasoning-end') {
          blocks.delete(key)
          yield * closeBlock(block)
        }
        continue
      }
      case 'tool-input-start': {
        const callId = typeof event.id === 'string' ? event.id : ''
        const key = `tool:${callId}`
        const { block, opened } = open(key, 'tool', callId, typeof event.toolName === 'string' ? event.toolName : undefined)
        if (opened) yield { type: 'block-start', index: block.index, blockType: 'tool-call' }
        continue
      }
      case 'tool-input-delta': {
        const callId = typeof event.id === 'string' ? event.id : ''
        const key = `tool:${callId}`
        const { block, opened } = open(key, 'tool', callId)
        if (opened) yield { type: 'block-start', index: block.index, blockType: 'tool-call' }
        const delta = String(event.delta ?? '')
        block.args += delta
        yield {
          type: 'tool-call-delta',
          index: block.index,
          id: block.id as ToolCallId,
          ...block.toolName === undefined ? {} : { name: block.toolName },
          argumentsDelta: delta,
        }
        continue
      }
      case 'tool-input-end':
        continue
      case 'tool-call': {
        const callId = String(event.toolCallId ?? event.id ?? '')
        const key = `tool:${callId}`
        const { block, opened } = open(key, 'tool', callId, typeof event.toolName === 'string' ? event.toolName : undefined)
        if (opened) yield { type: 'block-start', index: block.index, blockType: 'tool-call' }
        const input = event.input ?? event.args ?? event.arguments
        block.args = typeof input === 'string' ? input : JSON.stringify(input ?? {})
        blocks.delete(key)
        yield * closeBlock(block)
        continue
      }
      case 'response-metadata': {
        if (typeof event.id === 'string') metadataId = event.id
        if (typeof event.modelId === 'string') metadataModel = event.modelId
        continue
      }
      case 'finish-step': {
        for (const [key, block] of [...blocks.entries()]) {
          blocks.delete(key)
          yield * closeBlock(block)
        }
        const usage = event.usage ?? event.totalUsage
        yield {
          type: 'usage',
          usage: mapUsage(typeof usage === 'object' && usage !== null ? usage as Record<string, unknown> : {}),
        }
        const rawReason = String(event.finishReason ?? event.rawFinishReason ?? 'stop')
        yield {
          type: 'finish',
          reason: rawReason === 'error'
            ? { kind: 'error', failure: { message: 'Command Code reported a step error', code: 'SERVER' } }
            : mapFinishReason(rawReason),
          ...metadataId === undefined && metadataModel === undefined
            ? {}
            : { replayState: { response: { id: metadataId, modelId: metadataModel } } },
        }
        return
      }
      case 'error': {
        const detail = typeof event.error === 'string'
          ? event.error
          : typeof event.message === 'string'
            ? event.message
            : JSON.stringify(event.error ?? event)
        throw new LlmError(`Command Code stream error: ${detail}`, classifyCommandCodeError(0, detail).code)
      }
      default:
        continue
    }
  }

  throw new LlmError('Command Code stream ended without a finish-step event', 'STREAM_CLOSED')
}
