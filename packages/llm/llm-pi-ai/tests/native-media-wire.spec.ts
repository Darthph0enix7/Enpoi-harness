/**
 * Native-media admission through the real `ctx.llm.stream()` dispatch path:
 * captured provider bodies prove which wire part was sent, and every rejected
 * check proves no request reached the network.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { AttachmentId, AttachmentStore } from '@deepseek-ai/dsh-attachment'
import type {
  FileAttachmentRef,
  ImageAttachmentLimits,
  SaveImageAttachment,
  StoredImageAttachment,
  ImageAttachmentRef,
  ImageRequestTarget,
  RequestImageAttachment,
} from '@deepseek-ai/dsh-attachment'
import LlmRuntime, { createMessage, createToolResultMessage, createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import * as LlmPiAi from '@deepseek-ai/dsh-llm-pi-ai'
import { resolveProfiles } from '../src/config.ts'
import { buildNativeMediaPlan, insertNativeMediaSentinels } from '../src/native-media.ts'
import { memoryAuth } from './auth-double.ts'
import { assemble } from './assemble.ts'
import { closeMockServers, mockServer, textEvents } from './mock-server.ts'

afterEach(async () => {
  vi.unstubAllEnvs()
  await closeMockServers()
})

beforeEach(() => {
  vi.stubEnv('PI_TEST_KEY', 'test-key')
})

/** A minimal complete text generation in Anthropic Messages SSE framing. */
const ANTHROPIC_EVENTS: string[] = [
  'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","model":"native-anthropic","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":3,"output_tokens":0}}}\n\n',
  'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hello"}}\n\n',
  'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
  'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":1}}\n\n',
  'event: message_stop\ndata: {"type":"message_stop"}\n\n',
]

const encoder = new TextEncoder()

function ascii(value: string): Uint8Array {
  return encoder.encode(value)
}

function concat(...parts: readonly Uint8Array[]): Uint8Array {
  const length = parts.reduce((sum, part) => sum + part.byteLength, 0)
  const joined = new Uint8Array(length)
  let offset = 0
  for (const part of parts) {
    joined.set(part, offset)
    offset += part.byteLength
  }
  return joined
}

const PDF_BYTES = concat(ascii('%PDF-1.7\n'), ascii('1 0 obj\n<<>>\nendobj\n'))
const WAV_BYTES = concat(ascii('RIFF'), new Uint8Array([0x24, 0x00, 0x00, 0x00]), ascii('WAVE'), ascii('fmt '))
const MP4_BYTES = concat(new Uint8Array([0x00, 0x00, 0x00, 0x18]), ascii('ftypisom'), ascii('mp42'))

function fileRef(name: string, bytes: Uint8Array, digest: string): FileAttachmentRef {
  return { attachmentId: AttachmentId(`sha256:${digest.repeat(64 / digest.length)}`), name, bytes: bytes.byteLength }
}

interface NativeStoreOptions {
  readonly files: ReadonlyMap<string, Uint8Array>
  readonly onRead?: (ref: FileAttachmentRef) => void
  readonly abortOnRead?: AbortController
}

class NativeFileStore extends AttachmentStore {
  readonly imageLimits: ImageAttachmentLimits = {
    maxImageBytes: 1,
    maxImagesPerMessage: 1,
    maxMessageImageBytes: 1,
    maxImagePixels: 1,
    maxImageDimension: 2000,
    mediaTypes: ['image/png'],
  }

  constructor(ctx: Context, private readonly options: NativeStoreOptions) {
    super(ctx)
  }

  validateImage(_input: SaveImageAttachment): Promise<void> {
    return Promise.reject(new Error('native media tests store no images'))
  }

  saveImage(_input: SaveImageAttachment): Promise<ImageAttachmentRef> {
    return Promise.reject(new Error('native media tests store no images'))
  }

  readImage(_ref: ImageAttachmentRef): Promise<StoredImageAttachment> {
    return Promise.reject(new Error('native media tests store no images'))
  }

  override readImageRequest(
    _ref: ImageAttachmentRef,
    _target: ImageRequestTarget,
    _signal?: AbortSignal,
  ): Promise<RequestImageAttachment> {
    return Promise.reject(new Error('native media tests store no images'))
  }

  override async * readFileStream(ref: FileAttachmentRef, signal?: AbortSignal): AsyncIterable<Uint8Array> {
    this.options.onRead?.(ref)
    const bytes = this.options.files.get(String(ref.attachmentId))
    if (bytes === undefined) throw new Error(`no fixture bytes for ${ref.name}`)
    const split = Math.max(1, Math.floor(bytes.byteLength / 2))
    yield bytes.slice(0, split)
    this.options.abortOnRead?.abort('native media test aborted the read')
    signal?.throwIfAborted()
    yield bytes.slice(split)
    signal?.throwIfAborted()
  }
}

interface NativeRouteOptions {
  readonly api: 'anthropic-messages' | 'openai-completions' | 'openai-responses'
  readonly model: string
  readonly baseURL: string
  readonly nativeFileInputs?: LlmPiAi.PiAiNativeFileInputs
}

function providerConfig(route: NativeRouteOptions): LlmPiAi.Options {
  return {
    providers: {
      'native-gw': {
        apiKeyEnv: 'PI_TEST_KEY',
        api: route.api,
        baseURL: route.baseURL,
        models: [{
          id: route.model,
          name: route.model,
          contextWindow: 128_000,
          maxTokens: 8192,
          ...route.nativeFileInputs === undefined ? {} : { nativeFileInputs: route.nativeFileInputs },
        }],
      },
    },
  }
}

async function nativeContext(
  route: NativeRouteOptions,
  files: ReadonlyMap<string, Uint8Array> = new Map(),
  hooks: Omit<NativeStoreOptions, 'files'> = {},
): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(LlmPiAi, providerConfig(route))
  await ctx.plugin(NativeFileStore, { files, ...hooks })
  return ctx
}

function openaiRoute(
  baseURL: string,
  model: string,
  nativeFileInputs?: LlmPiAi.PiAiNativeFileInputs,
): NativeRouteOptions {
  return { api: 'openai-completions', model, baseURL: `${baseURL}/v1`, ...nativeFileInputs === undefined ? {} : { nativeFileInputs } }
}

function nativeInputs(
  encoderValue: LlmPiAi.PiAiNativeFileInputs['encoder'],
  mime: LlmPiAi.PiAiNativeFileInputs['mime'],
  overrides: Partial<LlmPiAi.PiAiNativeFileInputs> = {},
): LlmPiAi.PiAiNativeFileInputs {
  return {
    version: 1,
    encoder: encoderValue,
    mime,
    perFileBytes: 1_000_000,
    totalBytes: 2_000_000,
    maxPayloadBytes: 8_000_000,
    tokenReserve: { perFile: 100, perByte: 0.01 },
    ...overrides,
  }
}

/** The terminal failure message, failing the assertion on a non-error finish. */
function failureMessage(finish: { kind: string; failure?: { message: string } }): string {
  if (finish.kind !== 'error' || finish.failure === undefined) throw new Error(`expected an error finish, got ${finish.kind}`)
  return finish.failure.message
}

/** Every content part of the first captured request's first user message. */
function firstUserParts(server: { requests: unknown[] }): readonly Record<string, unknown>[] {
  const body = server.requests[0] as { messages?: { role?: string; content?: unknown }[] } | undefined
  for (const message of body?.messages ?? []) {
    if (message.role !== 'user') continue
    if (Array.isArray(message.content)) return message.content as Record<string, unknown>[]
    if (typeof message.content === 'string') return [{ type: 'text', text: message.content }]
  }
  throw new Error('captured request has no user message')
}

function documentParts(server: { requests: unknown[] }): readonly Record<string, unknown>[] {
  return firstUserParts(server).filter(part => part['type'] === 'document')
}

describe('native media wire encoding', () => {
  it('sends one Anthropic document block for a PDF and leaves handle text out', async () => {
    const server = await mockServer([{ rawEvents: ANTHROPIC_EVENTS }])
    const pdf = fileRef('report.pdf', PDF_BYTES, 'a')
    const other = fileRef('appendix.pdf', PDF_BYTES, 'b')
    const ctx = await nativeContext({
      api: 'anthropic-messages',
      model: 'native-anthropic',
      baseURL: server.url,
      nativeFileInputs: nativeInputs('anthropic-document', ['application/pdf']),
    }, new Map([[String(pdf.attachmentId), PDF_BYTES], [String(other.attachmentId), PDF_BYTES]]))
    const assistant = createMessage({
      role: 'assistant',
      content: [{ type: 'file', attachment: other }, { type: 'text', text: 'earlier' }],
      source: { kind: 'model', provider: 'native-gw', model: 'native-anthropic' },
    })
    const tool = createToolResultMessage({
      callId: ToolCallId('call-1'),
      content: [{ type: 'file', attachment: other }],
      isError: false,
    })

    const result = await assemble(ctx, {
      provider: 'native-gw',
      model: 'native-anthropic',
      messages: [
        createUserMessage({
          content: [{ type: 'text', text: 'read this' }, { type: 'file', attachment: pdf }],
          source: { kind: 'user' },
        }),
        assistant,
        tool,
      ],
    })

    expect(result.finish.kind).toBe('stop')
    expect(server.paths[0]).toContain('/v1/messages')
    const documents = documentParts(server)
    expect(documents).toEqual([{
      type: 'document',
      source: {
        type: 'base64',
        media_type: 'application/pdf',
        data: Buffer.from(PDF_BYTES).toString('base64'),
      },
    }])
    const body = JSON.stringify(server.requests[0])
    expect(body).not.toContain('verbatim read-only copy')
    expect(body).not.toContain('dsh-native-media')
    // Non-user occurrences stay deterministic handle text.
    expect(body).toContain('sha256:bbbbbbbb')
    await ctx.fiber.dispose()
  })

  it('sends OpenAI Chat file, input_audio, and video_url parts only when each is declared', async () => {
    const pdfServer = await mockServer([{ events: textEvents }])
    const pdf = fileRef('report.pdf', PDF_BYTES, 'a')
    const pdfCtx = await nativeContext(
      openaiRoute(pdfServer.url, 'native-chat', nativeInputs('openai-chat-file', ['application/pdf'])),
      new Map([[String(pdf.attachmentId), PDF_BYTES]]),
    )
    const pdfResult = await assemble(pdfCtx, {
      provider: 'native-gw',
      model: 'native-chat',
      messages: [createUserMessage({ content: [{ type: 'file', attachment: pdf }], source: { kind: 'user' } })],
    })
    expect(pdfResult.finish.kind).toBe('stop')
    expect(firstUserParts(pdfServer)).toEqual([{
      type: 'file',
      file: {
        filename: 'report.pdf',
        file_data: `data:application/pdf;base64,${Buffer.from(PDF_BYTES).toString('base64')}`,
      },
    }])
    await pdfCtx.fiber.dispose()

    const audioServer = await mockServer([{ events: textEvents }])
    const wav = fileRef('memo.wav', WAV_BYTES, 'c')
    const audioCtx = await nativeContext(
      openaiRoute(audioServer.url, 'native-audio', nativeInputs('openai-chat-input-audio', ['audio/wav'])),
      new Map([[String(wav.attachmentId), WAV_BYTES]]),
    )
    const audioResult = await assemble(audioCtx, {
      provider: 'native-gw',
      model: 'native-audio',
      messages: [createUserMessage({ content: [{ type: 'file', attachment: wav }], source: { kind: 'user' } })],
    })
    expect(audioResult.finish.kind).toBe('stop')
    expect(firstUserParts(audioServer)).toEqual([{
      type: 'input_audio',
      input_audio: { data: Buffer.from(WAV_BYTES).toString('base64'), format: 'wav' },
    }])
    await audioCtx.fiber.dispose()

    const videoServer = await mockServer([{ events: textEvents }])
    const mp4 = fileRef('clip.mp4', MP4_BYTES, 'd')
    const videoCtx = await nativeContext(
      openaiRoute(videoServer.url, 'native-video', nativeInputs('openai-chat-video-url', ['video/mp4'])),
      new Map([[String(mp4.attachmentId), MP4_BYTES]]),
    )
    const videoResult = await assemble(videoCtx, {
      provider: 'native-gw',
      model: 'native-video',
      messages: [createUserMessage({ content: [{ type: 'file', attachment: mp4 }], source: { kind: 'user' } })],
    })
    expect(videoResult.finish.kind).toBe('stop')
    expect(firstUserParts(videoServer)).toEqual([{
      type: 'video_url',
      video_url: { url: `data:video/mp4;base64,${Buffer.from(MP4_BYTES).toString('base64')}` },
    }])
    await videoCtx.fiber.dispose()
  })

  it('keeps every file as handle text when the model declares no native inputs', async () => {
    const server = await mockServer([{ events: textEvents }])
    const pdf = fileRef('report.pdf', PDF_BYTES, 'a')
    const read = vi.fn()
    const ctx = await nativeContext(openaiRoute(server.url, 'plain-chat'), new Map([[String(pdf.attachmentId), PDF_BYTES]]), { onRead: read })
    const result = await assemble(ctx, {
      provider: 'native-gw',
      model: 'plain-chat',
      messages: [createUserMessage({ content: [{ type: 'file', attachment: pdf }], source: { kind: 'user' } })],
    })

    expect(result.finish.kind).toBe('stop')
    expect(read).not.toHaveBeenCalled()
    const body = JSON.stringify(server.requests[0])
    expect(body).toContain('File \\"report.pdf\\"')
    expect(body).not.toContain('input_audio')
    expect(body).not.toContain('video_url')
    expect(body).not.toContain('"type\\":\\"file\\"')
    await ctx.fiber.dispose()
  })

  it('carries an opted-in descriptor through resolved and prepared model info', async () => {
    const ctx = await nativeContext(openaiRoute('http://127.0.0.1:1', 'native-chat', nativeInputs('openai-chat-file', ['application/pdf'])))
    const resolved = await ctx.llm.resolveModelInfo('native-gw', 'native-chat')
    expect(resolved.nativeFileInputs).toMatchObject({
      version: 1,
      encoders: { 'application/pdf': 'openai-chat-file' },
      perFileBytes: 1_000_000,
      tokenReserve: { perFile: 100, perByte: 0.01 },
    })
    expect(ctx.llm.nativeFileRequestPricing('native-gw', 'native-chat')).toEqual(resolved.nativeFileInputs)
    expect(ctx.llm.nativeFileRequestPricing('unregistered', 'model')).toBeUndefined()
    await ctx.fiber.dispose()
  })
})

describe('native media fails closed before network I/O', () => {
  async function failed(
    route: NativeRouteOptions,
    ref: FileAttachmentRef,
    bytes: Uint8Array,
    hooks: Omit<NativeStoreOptions, 'files'> = {},
  ) {
    const server = await mockServer([{ events: textEvents }])
    const ctx = await nativeContext({ ...route, baseURL: route.api === 'anthropic-messages' ? server.url : `${server.url}/v1` }, new Map([[String(ref.attachmentId), bytes]]), hooks)
    const result = await assemble(ctx, {
      provider: 'native-gw',
      model: route.model,
      messages: [createUserMessage({ content: [{ type: 'file', attachment: ref }], source: { kind: 'user' } })],
    })
    expect(server.requests).toHaveLength(0)
    await ctx.fiber.dispose()
    return result
  }

  it('refuses an oversize declared file before reading bytes', async () => {
    const pdf = fileRef('report.pdf', PDF_BYTES, 'a')
    const result = await failed(
      openaiRoute('', 'native-chat', nativeInputs('openai-chat-file', ['application/pdf'], { perFileBytes: 4 })),
      pdf,
      PDF_BYTES,
    )
    expect(failureMessage(result.finish)).toContain('per-file limit')
  })

  it('refuses bytes whose magic does not match the filename MIME', async () => {
    const fake = ascii('not a pdf')
    const pdf = fileRef('report.pdf', fake, 'a')
    const result = await failed(
      openaiRoute('', 'native-chat', nativeInputs('openai-chat-file', ['application/pdf'])),
      pdf,
      fake,
    )
    expect(failureMessage(result.finish)).toContain('does not carry the bytes')
  })

  it('refuses a user-typed exact sentinel before dispatch', async () => {
    const server = await mockServer([{ events: textEvents }])
    const route = openaiRoute(server.url, 'native-chat', nativeInputs('openai-chat-file', ['application/pdf']))
    const pdf = fileRef('report.pdf', PDF_BYTES, 'a')
    const ctx = await nativeContext(route, new Map([[String(pdf.attachmentId), PDF_BYTES]]))
    const token = `[[dsh-native-media:${String(pdf.attachmentId)}:1:0]]`
    const result = await assemble(ctx, {
      provider: 'native-gw',
      model: 'native-chat',
      messages: [
        createUserMessage({ content: [{ type: 'text', text: token }], source: { kind: 'user' } }),
        createUserMessage({ content: [{ type: 'file', attachment: pdf }], source: { kind: 'user' } }),
      ],
    })
    expect(failureMessage(result.finish)).toContain('sentinel already exists')
    expect(server.requests).toHaveLength(0)
    await ctx.fiber.dispose()
  })

  it('refuses an aborted read before dispatch', async () => {
    const server = await mockServer([{ events: textEvents }])
    const route = openaiRoute(server.url, 'native-chat', nativeInputs('openai-chat-file', ['application/pdf']))
    const pdf = fileRef('report.pdf', PDF_BYTES, 'a')
    const abort = new AbortController()
    const ctx = await nativeContext(route, new Map([[String(pdf.attachmentId), PDF_BYTES]]), { abortOnRead: abort })
    const result = await assemble(ctx, {
      provider: 'native-gw',
      model: 'native-chat',
      signal: abort.signal,
      messages: [createUserMessage({ content: [{ type: 'file', attachment: pdf }], source: { kind: 'user' } })],
    })
    expect(result.finish.kind).not.toBe('stop')
    expect(server.requests).toHaveLength(0)
    await ctx.fiber.dispose()
  })

  it('refuses a file block the current model did not declare, even through a direct adapter call', async () => {
    const server = await mockServer([{ events: textEvents }])
    const pdf = fileRef('report.pdf', PDF_BYTES, 'a')
    const adapter = new LlmPiAi.PiAiAdapter({
      profiles: () => resolveProfiles({
        'native-gw': {
          keyless: true,
          api: 'openai-completions',
          baseURL: `${server.url}/v1`,
          models: [{
            id: 'native-audio',
            contextWindow: 128_000,
            maxTokens: 8192,
            nativeFileInputs: nativeInputs('openai-chat-input-audio', ['audio/wav']),
          }],
        },
      }),
      resolveApiKey: () => Promise.resolve(undefined),
      auth: memoryAuth(),
    })
    const run = async (): Promise<void> => {
      for await (const _chunk of adapter.stream({
        provider: 'native-gw',
        model: 'native-audio',
        messages: [createUserMessage({ content: [{ type: 'file', attachment: pdf }], source: { kind: 'user' } })],
      })) { /* drain */ }
    }
    await expect(run()).rejects.toMatchObject({ code: 'UNSUPPORTED_CONTENT' })
    expect(server.requests).toHaveLength(0)
  })
})

describe('native media replay and configuration validation', () => {
  it('rebuilds the same plan from a descriptor captured before a configuration change', async () => {
    const pdf = fileRef('report.pdf', PDF_BYTES, 'a')
    const messages = [createUserMessage({
      content: [{ type: 'text', text: 'read' }, { type: 'file', attachment: pdf }],
      source: { kind: 'user' },
    })]
    const declared: LlmPiAi.PiAiNativeFileInputs = nativeInputs('anthropic-document', ['application/pdf'])
    const before = resolveProfiles({
      'native-gw': {
        api: 'anthropic-messages',
        baseURL: 'https://example.invalid',
        models: [{ id: 'claude', contextWindow: 128_000, maxTokens: 8192, nativeFileInputs: declared }],
      },
    }).get('native-gw')
    const descriptor = before?.catalogFacts.get('claude')?.nativeFileInputs
    expect(descriptor).toBeDefined()
    const read = () => (async function* () { yield PDF_BYTES })()
    const plan = await buildNativeMediaPlan({
      capability: { protocol: 'anthropic-messages', mimeTypes: ['application/pdf'] },
      occurrences: [{ attachment: pdf, messageIndex: 0, blockIndex: 1 }],
      readFile: read,
      limits: { maxFileBytes: 1_000_000, maxTotalBytes: 2_000_000, maxEncodedFileBytes: 8_000_000, maxEncodedTotalBytes: 8_000_000 },
    })
    const inserted = insertNativeMediaSentinels(messages, plan)
    const logged = (inserted[0] as { content: readonly { type: string; text?: string }[] }).content
    expect(logged[1]).toMatchObject({ type: 'text', text: plan.files[0]?.token })

    // The captured descriptor, not the changed configuration, rebuilds the
    // same plan after the route stops declaring one.
    const replayed = await buildNativeMediaPlan({
      capability: { protocol: 'anthropic-messages', mimeTypes: ['application/pdf'] },
      occurrences: [{ attachment: pdf, messageIndex: 0, blockIndex: 1 }],
      readFile: read,
      limits: { maxFileBytes: 1_000_000, maxTotalBytes: 2_000_000, maxEncodedFileBytes: 8_000_000, maxEncodedTotalBytes: 8_000_000 },
    })
    expect(replayed.files.map(file => file.token)).toEqual(plan.files.map(file => file.token))
    expect(replayed.encodedBytes).toBe(plan.encodedBytes)

    const after = resolveProfiles({
      'native-gw': {
        api: 'anthropic-messages',
        baseURL: 'https://example.invalid',
        models: [{ id: 'claude', contextWindow: 128_000, maxTokens: 8192 }],
      },
    }).get('native-gw')
    expect(after?.catalogFacts.get('claude')?.nativeFileInputs).toBeUndefined()
  })

  it('rejects encoder/transport pairs and partial declarations during profile resolution', () => {
    const route = (nativeFileInputs: LlmPiAi.PiAiNativeFileInputs) => ({
      'native-gw': {
        api: 'openai-completions',
        baseURL: 'https://example.invalid',
        models: [{ id: 'chat', contextWindow: 128_000, maxTokens: 8192, nativeFileInputs }],
      },
    })
    expect(() => resolveProfiles(route(nativeInputs('anthropic-document', ['application/pdf']))))
      .toThrow(/valid only on api anthropic-messages/)
    expect(() => resolveProfiles({
      'native-gw': {
        api: 'openai-responses',
        baseURL: 'https://example.invalid',
        models: [{
          id: 'responses',
          contextWindow: 128_000,
          maxTokens: 8192,
          nativeFileInputs: {
            ...nativeInputs('openai-chat-file', ['application/pdf']),
          },
        }],
      },
    })).toThrow(/valid only on api openai-completions/)
    expect(() => resolveProfiles(route(nativeInputs('openai-chat-input-audio', ['application/pdf']))))
      .toThrow(/cannot carry it/)
    expect(() => resolveProfiles(route({
      ...nativeInputs('openai-chat-file', ['application/pdf']),
      mime: [],
    }))).toThrow(/must list at least one MIME type/)
    expect(() => resolveProfiles(route({
      ...nativeInputs('openai-chat-file', ['application/pdf']),
      perFileBytes: 0,
    }))).toThrow(/positive safe integer/)
  })
})
