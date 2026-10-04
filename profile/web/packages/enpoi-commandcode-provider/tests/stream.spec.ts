/**
 * SSE parsing: event mapping, disjoint usage counts, finish-reason mapping,
 * in-band error classification, and the STREAM_CLOSED guard.
 */
import { expect, it } from 'vitest'
import { mapUsage, parseCommandCodeStream } from '../src/stream.js'

async function * sse(...lines: string[]): AsyncGenerator<Uint8Array> {
  for (const line of lines) yield new TextEncoder().encode(line)
}

async function collect(lines: string[]): Promise<unknown[]> {
  const chunks: unknown[] = []
  for await (const chunk of parseCommandCodeStream(sse(...lines))) chunks.push(chunk)
  return chunks
}

function frame(event: Record<string, unknown>): string {
  return `data: ${JSON.stringify(event)}\n\n`
}

it('maps text, reasoning and tool deltas to block chunks in order', async () => {
  const chunks = await collect([
    frame({ type: 'start' }),
    frame({ type: 'text-start', id: 't1' }),
    frame({ type: 'text-delta', id: 't1', text: 'Hel' }),
    frame({ type: 'text-delta', id: 't1', delta: 'lo' }),
    frame({ type: 'text-end', id: 't1' }),
    frame({ type: 'reasoning-start', id: 'r1' }),
    frame({ type: 'reasoning-delta', id: 'r1', text: 'think' }),
    frame({ type: 'reasoning-end', id: 'r1' }),
    frame({ type: 'tool-input-start', id: 'c1', toolName: 'get_weather' }),
    frame({ type: 'tool-input-delta', id: 'c1', delta: '{"city":' }),
    frame({ type: 'tool-input-delta', id: 'c1', delta: '"Berlin"}' }),
    frame({ type: 'tool-input-end', id: 'c1' }),
    frame({ type: 'tool-call', toolCallId: 'c1', toolName: 'get_weather', input: { city: 'Berlin' } }),
    frame({ type: 'finish-step', finishReason: 'tool_calls', usage: { inputTokens: 10, outputTokens: 5 } }),
  ]) as Array<Record<string, unknown>>

  expect(chunks[0]).toEqual({ type: 'block-start', index: 0, blockType: 'text' })
  expect(chunks[1]).toEqual({ type: 'text-delta', index: 0, text: 'Hel' })
  expect(chunks[2]).toEqual({ type: 'text-delta', index: 0, text: 'lo' })
  expect(chunks[3]).toEqual({ type: 'block-end', index: 0, block: { type: 'text', text: 'Hello' } })
  expect(chunks.some(chunk => chunk.type === 'reasoning-delta' && chunk.text === 'think')).toBe(true)
  const deltas = chunks.filter(chunk => chunk.type === 'tool-call-delta')
  expect(deltas.map(delta => delta.argumentsDelta).join('')).toBe('{"city":"Berlin"}')
  const toolEnd = chunks.find(chunk => chunk.type === 'block-end' && (chunk.block as { type: string }).type === 'tool-call')
  expect(toolEnd?.block).toEqual({ type: 'tool-call', id: 'c1', name: 'get_weather', arguments: '{"city":"Berlin"}' })
  const finish = chunks.at(-1) as { type: string; reason: { kind: string } }
  expect(finish.type).toBe('finish')
  expect(finish.reason.kind).toBe('tool-calls')
})

it('maps a complete tool-call event with no deltas to a tool block', async () => {
  const chunks = await collect([
    frame({ type: 'tool-call', toolCallId: 'cc', toolName: 'lookup', input: '{"q":"x"}' }),
    frame({ type: 'finish-step', finishReason: 'stop', usage: {} }),
  ]) as Array<Record<string, unknown>>
  expect(chunks[0]).toEqual({ type: 'block-start', index: 0, blockType: 'tool-call' })
  expect(chunks[1]).toEqual({
    type: 'block-end',
    index: 0,
    block: { type: 'tool-call', id: 'cc', name: 'lookup', arguments: '{"q":"x"}' },
  })
})

it('reports disjoint usage counts and cache details', async () => {
  const chunks = await collect([
    frame({
      type: 'finish-step',
      finishReason: 'stop',
      usage: {
        inputTokens: 1000,
        outputTokens: 40,
        inputTokenDetails: { cacheReadTokens: 900, cacheWriteTokens: 50 },
        outputTokenDetails: { reasoningTokens: 12 },
      },
    }),
  ]) as Array<Record<string, unknown>>
  const usage = chunks.find(chunk => chunk.type === 'usage')?.usage as Record<string, number>
  expect(usage.inputTokens).toBe(50)
  expect(usage.cacheReadTokens).toBe(900)
  expect(usage.cacheWriteTokens).toBe(50)
  expect(usage.outputTokens).toBe(40)
  expect(usage.reasoningTokens).toBe(12)
  expect(usage.totalTokens).toBe(1040)
})

it('maps finish reasons: stop/end_turn, length family, unknown to stop', () => {
  expect(mapUsage({ inputTokens: 2, outputTokens: 1 }).inputTokens).toBe(2)
  return collect([
    frame({ type: 'finish-step', finishReason: 'end_turn', usage: {} }),
  ]).then(async (first) => {
    expect((first.at(-1) as { reason: { kind: string } }).reason.kind).toBe('stop')
    const length = await collect([frame({ type: 'finish-step', finishReason: 'max_output_tokens', usage: {} })])
    expect((length.at(-1) as { reason: { kind: string } }).reason.kind).toBe('max-tokens')
    const unknown = await collect([frame({ type: 'finish-step', finishReason: 'weird', usage: {} })])
    expect((unknown.at(-1) as { reason: { kind: string } }).reason.kind).toBe('stop')
  })
})

it('throws classified in-band errors and STREAM_CLOSED on truncation', async () => {
  await expect(collect([
    frame({ type: 'error', error: 'You have reached your weekly usage limit. Resets in 3h 25m.' }),
  ])).rejects.toMatchObject({ code: 'QUOTA' })
  await expect(collect([frame({ type: 'text-delta', id: 't', text: 'cut' })])).rejects.toMatchObject({ code: 'STREAM_CLOSED' })
})

it('tolerates CRLF, comments and [DONE]', async () => {
  const chunks = await collect([
    ': keep-alive\r\n',
    'data: {"type":"text-delta","id":"t","text":"ok"}\r\n\r\n',
    '[DONE]\r\n',
    'data: {"type":"finish-step","finishReason":"stop","usage":{}}\r\n',
  ]) as Array<Record<string, unknown>>
  expect(chunks[1]).toEqual({ type: 'text-delta', index: 0, text: 'ok' })
  expect(chunks.at(-1)?.type).toBe('finish')
})
