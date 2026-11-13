import { mkdtemp, rm } from 'node:fs/promises'
import { AttachmentId, ImageVariantId } from '@deepseek-ai/dsh-attachment'
import type { AttachmentStore, ImageAttachmentRef, RequestImageAttachment } from '@deepseek-ai/dsh-attachment'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  BlockAssembler,
  createAssistantMessage,
  createToolResultMessage,
  createUserMessage,
  ToolCallId,
} from '@deepseek-ai/dsh-llm'
import type { Message } from '@deepseek-ai/dsh-llm'
import type { AssistantMessage, Usage } from '@earendil-works/pi-ai'
import { toPiContext } from '../src/context.ts'
import { PiAiAdapter } from '../src/adapter.ts'
import type { PiAiProviderProfile } from '../src/config.ts'
import { resolveProfiles } from '../src/config.ts'
import { toPiReplayState } from '../src/replay.ts'
import { PoolEngine } from '../src/pool.ts'
import { memoryAuth } from './auth-double.ts'
import { closeMockServers, mockServer, textEvents } from './mock-server.ts'
import type { MockServer } from './mock-server.ts'

afterEach(async () => {
  await closeMockServers()
})

const ANTHROPIC_EVENTS: string[] = [
  'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","model":"claude-opus-5","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":3,"output_tokens":0}}}\n\n',
  'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}\n\n',
  'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
  'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":1}}\n\n',
  'event: message_stop\ndata: {"type":"message_stop"}\n\n',
]

const ANTHROPIC_ALIAS_EVENTS: string[] = [
  'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_alias","type":"message","role":"assistant","model":"claude-haiku-4-5-20251001","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":3,"output_tokens":0}}}\n\n',
  'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"alias pooled secret"}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"alias-pooled-signature"}}\n\n',
  'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
  'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"public answer"}}\n\n',
  'event: content_block_stop\ndata: {"type":"content_block_stop","index":1}\n\n',
  'event: content_block_start\ndata: {"type":"content_block_start","index":2,"content_block":{"type":"tool_use","id":"call-1","name":"lookup","input":{}}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"{\\\"q\\\":\\\"x\\\"}"}}\n\n',
  'event: content_block_stop\ndata: {"type":"content_block_stop","index":2}\n\n',
  'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use","stop_sequence":null},"usage":{"output_tokens":5}}\n\n',
  'event: message_stop\ndata: {"type":"message_stop"}\n\n',
]

function emptyUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  }
}

function adapterFor(providers: Record<string, PiAiProviderProfile>): PiAiAdapter {
  return new PiAiAdapter({
    profiles: () => resolveProfiles(providers),
    resolveApiKey: () => Promise.resolve('test-key'),
    auth: memoryAuth(),
  })
}

async function drain(adapter: PiAiAdapter, provider: string, model: string, messages: Message[]): Promise<void> {
  for await (const _chunk of adapter.stream({ provider, model, messages })) { /* drain */ }
}

function bodyOf(server: MockServer): Record<string, unknown> {
  const body = server.requests[0]
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new Error('missing request body')
  return body as Record<string, unknown>
}

function wireMessage(body: Record<string, unknown>, role: 'assistant' | 'tool'): Record<string, unknown> {
  const messages = body['messages']
  if (!Array.isArray(messages)) throw new Error('missing messages')
  const found = (messages as unknown[]).find(message => (
    typeof message === 'object' && message !== null && (message as Record<string, unknown>)['role'] === role
  ))
  if (found === undefined) throw new Error(`missing ${role} message`)
  return found as Record<string, unknown>
}

function assistantWire(body: Record<string, unknown>): Record<string, unknown> {
  return wireMessage(body, 'assistant')
}

function toolWire(body: Record<string, unknown>): Record<string, unknown> {
  return wireMessage(body, 'tool')
}

function nativeAssistant(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    role: 'assistant',
    content: [],
    api: 'openai-completions',
    provider: 'deepseek',
    model: 'deepseek-v4-flash',
    usage: emptyUsage(),
    stopReason: 'stop',
    timestamp: 0,
    ...overrides,
  }
}

function history(options: {
  provider: string
  model: string
  content: ReturnType<typeof createAssistantMessage>['content']
  replayState?: unknown
}): Message[] {
  return [
    createUserMessage({
      content: [{ type: 'text', text: 'question' }],
      source: { kind: 'model', provider: options.provider, model: options.model },
    }),
    createAssistantMessage({
      content: options.content,
      source: {
        provider: options.provider,
        model: options.model,
        ...options.replayState === undefined ? {} : { replayState: options.replayState },
      },
    }),
    createToolResultMessage({
      callId: ToolCallId('call-1'),
      content: [{ type: 'text', text: 'tool output' }],
      isError: false,
    }),
  ]
}

describe('reasoning-safe replay projection', () => {
  it('keeps a compatible same-target Anthropic replay including signed, empty signed, and redacted thinking', async () => {
    const server = await mockServer([{ rawEvents: ANTHROPIC_EVENTS }])
    const adapter = adapterFor({ anthropic: { apiKeyEnv: 'PI_TEST_KEY', baseURL: server.url } })
    const native = nativeAssistant({
      api: 'anthropic-messages',
      provider: 'anthropic',
      model: 'claude-opus-5',
      stopReason: 'toolUse',
      content: [
        { type: 'thinking', thinking: 'signed secret', thinkingSignature: 'sig-signed' },
        { type: 'thinking', thinking: '', thinkingSignature: 'sig-empty' },
        { type: 'thinking', thinking: '[Reasoning redacted]', thinkingSignature: 'opaque-redacted', redacted: true },
        { type: 'text', text: 'public answer' },
        { type: 'toolCall', id: 'call-1', name: 'lookup', arguments: { q: 'x' } },
      ],
    })
    const messages = history({
      provider: 'anthropic',
      model: 'claude-opus-5',
      replayState: toPiReplayState(native),
      content: [
        { type: 'reasoning', text: 'signed secret' },
        { type: 'reasoning', text: '' },
        { type: 'reasoning', text: '[Reasoning redacted]' },
        { type: 'text', text: 'public answer' },
        { type: 'tool-call', id: ToolCallId('call-1'), name: 'lookup', arguments: '{"q":"x"}' },
      ],
    })

    await drain(adapter, 'anthropic', 'claude-opus-5', messages)

    const assistant = assistantWire(bodyOf(server))
    const content = assistant['content']
    if (!Array.isArray(content)) throw new Error('missing assistant content')
    expect(content).toContainEqual({ type: 'thinking', thinking: 'signed secret', signature: 'sig-signed' })
    expect(content).toContainEqual({ type: 'thinking', thinking: '', signature: 'sig-empty' })
    expect(content).toContainEqual({ type: 'redacted_thinking', data: 'opaque-redacted' })
    expect(content).toContainEqual({ type: 'text', text: 'public answer' })
    expect(content).toContainEqual({ type: 'tool_use', id: 'call-1', name: 'lookup', input: { q: 'x' } })
  })

  it('drops foreign-model reasoning from the wire while preserving public text and the tool pair', async () => {
    const server = await mockServer([{ events: textEvents }])
    const adapter = adapterFor({ deepseek: { apiKeyEnv: 'PI_TEST_KEY', baseURL: server.url } })
    const native = nativeAssistant({
      model: 'deepseek-v4-flash',
      stopReason: 'toolUse',
      content: [
        { type: 'thinking', thinking: 'flash secret', thinkingSignature: 'reasoning_content' },
        { type: 'text', text: 'public answer' },
        { type: 'toolCall', id: 'call-1', name: 'lookup', arguments: { q: 'x' } },
      ],
    })
    const messages = history({
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
      replayState: toPiReplayState(native),
      content: [
        { type: 'reasoning', text: 'flash secret' },
        { type: 'text', text: 'public answer' },
        { type: 'tool-call', id: ToolCallId('call-1'), name: 'lookup', arguments: '{"q":"x"}' },
      ],
    })

    await drain(adapter, 'deepseek', 'deepseek-v4-pro', messages)

    const body = bodyOf(server)
    expect(JSON.stringify(body)).not.toContain('flash secret')
    const assistant = assistantWire(body)
    expect(assistant['content']).toBe('public answer')
    const toolCalls = assistant['tool_calls']
    if (!Array.isArray(toolCalls)) throw new Error('missing tool calls')
    expect(toolCalls[0]).toMatchObject({ id: 'call-1', function: { name: 'lookup' } })
    expect(toolWire(body)).toMatchObject({ role: 'tool', tool_call_id: 'call-1', content: 'tool output' })
  })

  it('drops foreign reasoning on the image conversion path while keeping the image and public answer', async () => {
    const server = await mockServer([{ events: textEvents }])
    const attachment: ImageAttachmentRef = {
      attachmentId: AttachmentId(`sha256:${'d'.repeat(64)}`),
      mediaType: 'image/png',
      bytes: 1,
      width: 1,
      height: 1,
    }
    const store = {
      readImageRequest: (ref: ImageAttachmentRef): Promise<RequestImageAttachment> => Promise.resolve({
        variantId: ImageVariantId(`sha256:${'e'.repeat(64)}`),
        attachment: ref,
        data: Uint8Array.of(1),
        mediaType: ref.mediaType,
        bytes: 1,
        width: ref.width,
        height: ref.height,
        depth: 'uchar',
        space: 'srgb',
        hasAlpha: true,
      }),
    } as unknown as AttachmentStore
    const adapter = new PiAiAdapter({
      profiles: () => resolveProfiles({ deepseek: { apiKeyEnv: 'PI_TEST_KEY', baseURL: server.url } }),
      resolveApiKey: () => Promise.resolve('test-key'),
      resolveAttachments: () => store,
      resolveImageAccess: () => undefined,
      auth: memoryAuth(),
    })
    const native = nativeAssistant({
      model: 'deepseek-v4-flash',
      content: [
        { type: 'thinking', thinking: 'image secret', thinkingSignature: 'reasoning_content' },
        { type: 'text', text: 'public answer' },
      ],
    })
    const messages: Message[] = [
      createUserMessage({
        content: [{ type: 'text', text: 'describe' }, { type: 'image', attachment }],
        source: { kind: 'model', provider: 'deepseek', model: 'deepseek-v4-flash' },
      }),
      createAssistantMessage({
        content: [
          { type: 'reasoning', text: 'image secret' },
          { type: 'text', text: 'public answer' },
        ],
        source: { provider: 'deepseek', model: 'deepseek-v4-flash', replayState: toPiReplayState(native) },
      }),
    ]

    await drain(adapter, 'deepseek', 'deepseek-v4-flash-vision-exp', messages)

    const body = bodyOf(server)
    expect(JSON.stringify(body)).not.toContain('image secret')
    expect(JSON.stringify(body)).toContain('image_url')
    expect(assistantWire(body)['content']).toBe('public answer')
  })

  it('drops same-model reasoning when the target provider differs', async () => {
    const server = await mockServer([{ events: textEvents }])
    const adapter = adapterFor({
      first: {
        apiKeyEnv: 'PI_TEST_KEY',
        api: 'openai-completions',
        baseURL: `${server.url}/first`,
        models: [{ id: 'shared-model', contextWindow: 65_536, maxTokens: 4096 }],
      },
      second: {
        apiKeyEnv: 'PI_TEST_KEY',
        api: 'openai-completions',
        baseURL: `${server.url}/second`,
        models: [{ id: 'shared-model', contextWindow: 65_536, maxTokens: 4096 }],
      },
    })
    const native = nativeAssistant({
      provider: 'first',
      model: 'shared-model',
      stopReason: 'toolUse',
      content: [
        { type: 'thinking', thinking: 'provider secret', thinkingSignature: 'reasoning_content' },
        { type: 'text', text: 'public answer' },
        { type: 'toolCall', id: 'call-1', name: 'lookup', arguments: { q: 'x' } },
      ],
    })
    const messages = history({
      provider: 'first',
      model: 'shared-model',
      replayState: toPiReplayState(native),
      content: [
        { type: 'reasoning', text: 'provider secret' },
        { type: 'text', text: 'public answer' },
        { type: 'tool-call', id: ToolCallId('call-1'), name: 'lookup', arguments: '{"q":"x"}' },
      ],
    })

    await drain(adapter, 'second', 'shared-model', messages)

    expect(JSON.stringify(bodyOf(server))).not.toContain('provider secret')
  })

  it('drops same-model reasoning when the target API differs', async () => {
    const server = await mockServer([{ events: textEvents }])
    const adapter = adapterFor({ deepseek: { apiKeyEnv: 'PI_TEST_KEY', baseURL: server.url } })
    const native = nativeAssistant({
      api: 'openai-responses',
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
      content: [
        { type: 'thinking', thinking: 'api secret', thinkingSignature: 'reasoning_content' },
        { type: 'text', text: 'public answer' },
      ],
    })
    const messages = history({
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
      replayState: toPiReplayState(native),
      content: [
        { type: 'reasoning', text: 'api secret' },
        { type: 'text', text: 'public answer' },
      ],
    })

    await drain(adapter, 'deepseek', 'deepseek-v4-flash', messages)

    expect(JSON.stringify(bodyOf(server))).not.toContain('api secret')
  })

  it('uses an explicit exact target for a route the installed catalog cannot describe', () => {
    const native = nativeAssistant({
      provider: 'custom',
      model: 'custom-model',
      content: [
        { type: 'thinking', thinking: 'custom secret', thinkingSignature: 'reasoning_content' },
        { type: 'text', text: 'public answer' },
      ],
    })
    const context = toPiContext({
      provider: 'custom',
      model: 'custom-model',
      messages: history({
        provider: 'custom',
        model: 'custom-model',
        replayState: toPiReplayState(native),
        content: [
          { type: 'reasoning', text: 'custom secret' },
          { type: 'text', text: 'public answer' },
        ],
      }),
    }, {
      provider: 'custom',
      api: 'openai-completions',
      model: 'custom-model',
    })
    expect((context.messages[1] as AssistantMessage).content).toEqual([
      { type: 'thinking', thinking: 'custom secret', thinkingSignature: 'reasoning_content' },
      { type: 'text', text: 'public answer' },
    ])
  })

  it('keeps same-target reasoning through a catalog route API override', async () => {
    const server = await mockServer([{ events: textEvents }])
    const adapter = adapterFor({
      anthropic: {
        apiKeyEnv: 'PI_TEST_KEY',
        api: 'openai-completions',
        baseURL: server.url,
      },
    })
    const native = nativeAssistant({
      api: 'openai-completions',
      provider: 'anthropic',
      model: 'claude-opus-5',
      stopReason: 'toolUse',
      content: [
        { type: 'thinking', thinking: 'override secret', thinkingSignature: 'reasoning_content' },
        { type: 'text', text: 'public answer' },
        { type: 'toolCall', id: 'call-1', name: 'lookup', arguments: { q: 'x' } },
      ],
    })
    const messages = history({
      provider: 'anthropic',
      model: 'claude-opus-5',
      replayState: toPiReplayState(native),
      content: [
        { type: 'reasoning', text: 'override secret' },
        { type: 'text', text: 'public answer' },
        { type: 'tool-call', id: ToolCallId('call-1'), name: 'lookup', arguments: '{"q":"x"}' },
      ],
    })

    await drain(adapter, 'anthropic', 'claude-opus-5', messages)

    const body = bodyOf(server)
    const assistant = assistantWire(body)
    expect(assistant['content']).toBe('public answer')
    expect(assistant['reasoning_content']).toBe('override secret')
    expect(toolWire(body)).toMatchObject({ role: 'tool', tool_call_id: 'call-1', content: 'tool output' })
  })

  it('keeps same-target reasoning on a configured route the installed catalog does not describe', async () => {
    const server = await mockServer([{ events: textEvents }])
    const adapter = adapterFor({
      custom: {
        apiKeyEnv: 'PI_TEST_KEY',
        api: 'openai-completions',
        baseURL: server.url,
        models: [{ id: 'custom-model', contextWindow: 65_536, maxTokens: 4096 }],
      },
    })
    const native = nativeAssistant({
      provider: 'custom',
      model: 'custom-model',
      stopReason: 'toolUse',
      content: [
        { type: 'thinking', thinking: 'custom secret', thinkingSignature: 'reasoning_content' },
        { type: 'text', text: 'public answer' },
        { type: 'toolCall', id: 'call-1', name: 'lookup', arguments: { q: 'x' } },
      ],
    })
    const messages = history({
      provider: 'custom',
      model: 'custom-model',
      replayState: toPiReplayState(native),
      content: [
        { type: 'reasoning', text: 'custom secret' },
        { type: 'text', text: 'public answer' },
        { type: 'tool-call', id: ToolCallId('call-1'), name: 'lookup', arguments: '{"q":"x"}' },
      ],
    })

    await drain(adapter, 'custom', 'custom-model', messages)

    const body = bodyOf(server)
    const assistant = assistantWire(body)
    expect(assistant['content']).toBe('public answer')
    expect(assistant['reasoning_content']).toBe('custom secret')
    expect(toolWire(body)).toMatchObject({ role: 'tool', tool_call_id: 'call-1', content: 'tool output' })
  })

  it('drops reasoning after the route API changes under the same provider and model', async () => {
    const server = await mockServer([{ events: textEvents }])
    const adapter = adapterFor({
      anthropic: {
        apiKeyEnv: 'PI_TEST_KEY',
        api: 'openai-completions',
        baseURL: server.url,
      },
    })
    const native = nativeAssistant({
      api: 'anthropic-messages',
      provider: 'anthropic',
      model: 'claude-opus-5',
      stopReason: 'toolUse',
      content: [
        { type: 'thinking', thinking: 'old api secret', thinkingSignature: 'old-signature' },
        { type: 'text', text: 'public answer' },
        { type: 'toolCall', id: 'call-1', name: 'lookup', arguments: { q: 'x' } },
      ],
    })
    const messages = history({
      provider: 'anthropic',
      model: 'claude-opus-5',
      replayState: toPiReplayState(native),
      content: [
        { type: 'reasoning', text: 'old api secret' },
        { type: 'text', text: 'public answer' },
        { type: 'tool-call', id: ToolCallId('call-1'), name: 'lookup', arguments: '{"q":"x"}' },
      ],
    })

    await drain(adapter, 'anthropic', 'claude-opus-5', messages)

    const body = bodyOf(server)
    expect(JSON.stringify(body)).not.toContain('old api secret')
    const assistant = assistantWire(body)
    expect(assistant['content']).toBe('public answer')
    expect(toolWire(body)).toMatchObject({ role: 'tool', tool_call_id: 'call-1', content: 'tool output' })
  })

  it('keeps an Anthropic alias replay native for the requested target model', async () => {
    const server = await mockServer([{ rawEvents: ANTHROPIC_EVENTS }])
    const adapter = adapterFor({ anthropic: { apiKeyEnv: 'PI_TEST_KEY', baseURL: server.url } })
    const native = nativeAssistant({
      api: 'anthropic-messages',
      provider: 'anthropic',
      model: 'claude-haiku-4-5-20251001',
      content: [
        { type: 'thinking', thinking: 'alias secret', thinkingSignature: 'alias-signature' },
        { type: 'text', text: 'public answer' },
      ],
    })
    const messages = history({
      provider: 'anthropic',
      model: 'claude-haiku-4-5',
      replayState: toPiReplayState(native, 'claude-haiku-4-5'),
      content: [
        { type: 'reasoning', text: 'alias secret' },
        { type: 'text', text: 'public answer' },
      ],
    })

    await drain(adapter, 'anthropic', 'claude-haiku-4-5', messages)

    const content = assistantWire(bodyOf(server))['content']
    if (!Array.isArray(content)) throw new Error('missing assistant content')
    expect(content).toContainEqual({ type: 'thinking', thinking: 'alias secret', signature: 'alias-signature' })
    expect(content).toContainEqual({ type: 'text', text: 'public answer' })
    expect(content).not.toContainEqual({ type: 'text', text: 'alias secret' })
  })

  it('does not treat a native response alias as proof for a different target model', async () => {
    const server = await mockServer([{ rawEvents: ANTHROPIC_EVENTS }])
    const adapter = adapterFor({ anthropic: { apiKeyEnv: 'PI_TEST_KEY', baseURL: server.url } })
    const native = nativeAssistant({
      api: 'anthropic-messages',
      provider: 'anthropic',
      model: 'claude-opus-5',
      content: [
        { type: 'thinking', thinking: 'alias trap secret', thinkingSignature: 'alias-trap-signature' },
        { type: 'text', text: 'public answer' },
      ],
    })
    const messages = history({
      provider: 'anthropic',
      model: 'claude-haiku-4-5',
      replayState: toPiReplayState(native, 'claude-haiku-4-5'),
      content: [
        { type: 'reasoning', text: 'alias trap secret' },
        { type: 'text', text: 'public answer' },
      ],
    })

    await drain(adapter, 'anthropic', 'claude-opus-5', messages)

    const content = assistantWire(bodyOf(server))['content']
    if (!Array.isArray(content)) throw new Error('missing assistant content')
    expect(content).toContainEqual({ type: 'text', text: 'public answer' })
    expect(JSON.stringify(content)).not.toContain('alias trap secret')
  })

  it('keeps exact-target reasoning and the tool pair on both prepared pooled attempts', async () => {
    const server = await mockServer([
      { status: 429, body: JSON.stringify({ error: { message: 'rate limit exceeded' } }) },
      { events: textEvents },
    ])
    const stateDir = await mkdtemp(join(tmpdir(), 'reasoning-replay-pool-'))
    const engine = new PoolEngine({ stateDir, saveDebounceMs: 5 })
    try {
      const adapter = new PiAiAdapter({
        profiles: () => resolveProfiles({
          pooled: {
            api: 'openai-completions',
            apiKeyEnv: 'PI_TEST_KEY',
            baseURL: server.url,
            models: [{ id: 'pooled-model', contextWindow: 65_536, maxTokens: 4096 }],
            pool: {
              identities: [
                { id: 'first', credentialRef: 'KEY_A', priority: 1 },
                { id: 'second', credentialRef: 'KEY_B', priority: 2 },
              ],
            },
          },
        }),
        resolveApiKey: () => Promise.resolve('unused'),
        resolveCredential: reference => Promise.resolve(reference === 'KEY_A' ? 'key-a' : 'key-b'),
        pool: engine,
        log: () => {},
        auth: memoryAuth(),
      })
      const native = nativeAssistant({
        provider: 'pooled',
        model: 'pooled-model',
        stopReason: 'toolUse',
        content: [
          { type: 'thinking', thinking: 'pool secret', thinkingSignature: 'reasoning_content' },
          { type: 'text', text: 'public answer' },
          { type: 'toolCall', id: 'call-1', name: 'lookup', arguments: { q: 'x' } },
        ],
      })
      const messages = history({
        provider: 'pooled',
        model: 'pooled-model',
        replayState: toPiReplayState(native),
        content: [
          { type: 'reasoning', text: 'pool secret' },
          { type: 'text', text: 'public answer' },
          { type: 'tool-call', id: ToolCallId('call-1'), name: 'lookup', arguments: '{"q":"x"}' },
        ],
      })
      const prepared = await adapter.prepareCall('pooled', 'pooled-model')
      for await (const _chunk of prepared.stream({ provider: 'pooled', model: 'pooled-model', messages })) {
        // drain
      }

      expect(server.requests).toHaveLength(2)
      for (const request of server.requests) {
        if (typeof request !== 'object' || request === null || Array.isArray(request)) throw new Error('missing request body')
        const body = request as Record<string, unknown>
        const assistant = assistantWire(body)
        expect(assistant['content']).toBe('public answer')
        expect(assistant['reasoning_content']).toBe('pool secret')
        expect(toolWire(body)).toMatchObject({ role: 'tool', tool_call_id: 'call-1', content: 'tool output' })
      }
    } finally {
      await engine.flush().catch(() => {})
      await rm(stateDir, { recursive: true, force: true })
    }
  })

  it('writes requested model identity on a pooled Anthropic alias and replays its thinking and tool pair', async () => {
    const server = await mockServer([
      { status: 429, body: JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'rate limited' } }) },
      { rawEvents: ANTHROPIC_ALIAS_EVENTS },
      { rawEvents: ANTHROPIC_EVENTS },
    ])
    const stateDir = await mkdtemp(join(tmpdir(), 'reasoning-replay-alias-pool-'))
    const engine = new PoolEngine({ stateDir, saveDebounceMs: 5 })
    try {
      const adapter = new PiAiAdapter({
        profiles: () => resolveProfiles({
          anthropic: {
            apiKeyEnv: 'PI_TEST_KEY',
            baseURL: server.url,
            pool: {
              identities: [
                { id: 'first', credentialRef: 'KEY_A', priority: 1 },
                { id: 'second', credentialRef: 'KEY_B', priority: 2 },
              ],
            },
          },
        }),
        resolveApiKey: () => Promise.resolve('unused'),
        resolveCredential: reference => Promise.resolve(reference === 'KEY_A' ? 'key-a' : 'key-b'),
        pool: engine,
        log: () => {},
        auth: memoryAuth(),
      })
      const question = createUserMessage({
        content: [{ type: 'text', text: 'question' }],
        source: { kind: 'model', provider: 'anthropic', model: 'claude-haiku-4-5' },
      })
      const assembler = new BlockAssembler()
      for await (const chunk of adapter.stream({
        provider: 'anthropic',
        model: 'claude-haiku-4-5',
        messages: [question],
      })) assembler.push(chunk)
      const assistant = assembler.message({
        provider: 'anthropic',
        model: 'claude-haiku-4-5',
        ...assembler.replayState === undefined ? {} : { replayState: assembler.replayState },
      })
      expect(assistant).toMatchObject({ role: 'assistant' })
      expect(assistant.source).toMatchObject({
        provider: 'anthropic',
        model: 'claude-haiku-4-5',
        replayState: {
          response: {
            model: 'claude-haiku-4-5',
            responseModel: 'claude-haiku-4-5-20251001',
          },
        },
      })

      const toolResult = createToolResultMessage({
        callId: ToolCallId('call-1'),
        content: [{ type: 'text', text: 'tool output' }],
        isError: false,
      })
      for await (const _chunk of adapter.stream({
        provider: 'anthropic',
        model: 'claude-haiku-4-5',
        messages: [question, assistant, toolResult],
      })) {
        // drain
      }

      expect(server.requests).toHaveLength(3)
      const replayBody = server.requests[2]
      if (typeof replayBody !== 'object' || replayBody === null || Array.isArray(replayBody)) {
        throw new Error('missing replay request body')
      }
      const content = assistantWire(replayBody as Record<string, unknown>)['content']
      if (!Array.isArray(content)) throw new Error('missing assistant content')
      expect(content).toContainEqual({
        type: 'thinking',
        thinking: 'alias pooled secret',
        signature: 'alias-pooled-signature',
      })
      expect(content).toContainEqual({ type: 'text', text: 'public answer' })
      expect(content).toContainEqual({ type: 'tool_use', id: 'call-1', name: 'lookup', input: { q: 'x' } })
      expect(content).not.toContainEqual({ type: 'text', text: 'alias pooled secret' })
    } finally {
      await engine.flush().catch(() => {})
      await rm(stateDir, { recursive: true, force: true })
    }
  })

  it('skips an empty assistant turn after foreign reasoning is dropped', async () => {
    const server = await mockServer([{ events: textEvents }])
    const adapter = adapterFor({ deepseek: { apiKeyEnv: 'PI_TEST_KEY', baseURL: server.url } })
    const native = nativeAssistant({
      model: 'deepseek-v4-flash',
      content: [{ type: 'thinking', thinking: 'empty-only secret', thinkingSignature: 'reasoning_content' }],
    })
    const messages: Message[] = [
      createUserMessage({
        content: [{ type: 'text', text: 'question' }],
        source: { kind: 'model', provider: 'deepseek', model: 'deepseek-v4-flash' },
      }),
      createAssistantMessage({
        content: [{ type: 'reasoning', text: 'empty-only secret' }],
        source: { provider: 'deepseek', model: 'deepseek-v4-flash', replayState: toPiReplayState(native) },
      }),
    ]

    await drain(adapter, 'deepseek', 'deepseek-v4-pro', messages)

    const body = bodyOf(server)
    expect(JSON.stringify(body)).not.toContain('empty-only secret')
    const wireMessages = body['messages']
    if (!Array.isArray(wireMessages)) throw new Error('missing messages')
    expect(wireMessages.some(message => (
      typeof message === 'object' && message !== null && (message as Record<string, unknown>)['role'] === 'assistant'
    ))).toBe(false)
  })

  it('drops reasoning when replay state is absent even for the nominal same model', async () => {
    const server = await mockServer([{ events: textEvents }])
    const adapter = adapterFor({ deepseek: { apiKeyEnv: 'PI_TEST_KEY', baseURL: server.url } })
    const messages = history({
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
      content: [
        { type: 'reasoning', text: 'unreplayed secret' },
        { type: 'text', text: 'public answer' },
      ],
    })

    await drain(adapter, 'deepseek', 'deepseek-v4-flash', messages)

    const body = bodyOf(server)
    expect(JSON.stringify(body)).not.toContain('unreplayed secret')
    expect(assistantWire(body)['content']).toBe('public answer')
  })
})
