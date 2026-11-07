import { describe, expect, it, vi } from 'vitest'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { FileAttachmentRef } from '@deepseek-ai/dsh-attachment'
import {
  applyNativeMediaPayload,
  buildNativeMediaPlan,
  createNativeMediaPayloadPatcher,
  encodeNativeMediaPart,
  insertNativeMediaSentinels,
  NativeMediaError,
} from '../src/native-media.ts'
import type {
  NativeMediaCapability,
  NativeMediaFilePlan,
  NativeMediaLimits,
  NativeMediaMimeType,
  NativeMediaOccurrence,
  NativeMediaPlan,
  NativeMediaProtocol,
  NativeMediaReader,
} from '../src/native-media.ts'

const textEncoder = new TextEncoder()

const ALL_MIME: readonly NativeMediaMimeType[] = [
  'application/pdf',
  'audio/wav',
  'audio/mpeg',
  'audio/ogg',
  'audio/flac',
  'video/mp4',
  'video/webm',
]

function ascii(value: string): Uint8Array {
  return textEncoder.encode(value)
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

function ref(name: string, bytes: Uint8Array, digest = 'a'.repeat(64)): FileAttachmentRef {
  return {
    attachmentId: AttachmentId(`sha256:${digest}`),
    name,
    bytes: bytes.byteLength,
  }
}

function capability(
  protocol: NativeMediaProtocol = 'openai-completions',
  mimeTypes: readonly NativeMediaMimeType[] = ALL_MIME,
): NativeMediaCapability {
  return { protocol, mimeTypes }
}

function limits(overrides: Partial<NativeMediaLimits> = {}): NativeMediaLimits {
  return {
    maxFileBytes: 1024,
    maxTotalBytes: 4096,
    maxEncodedFileBytes: 4096,
    maxEncodedTotalBytes: 8192,
    ...overrides,
  }
}

function readerOf(...chunks: readonly Uint8Array[]): NativeMediaReader {
  return () => (async function* () {
    for (const chunk of chunks) yield chunk
  })()
}

function occurrence(
  attachment: FileAttachmentRef,
  messageIndex = 0,
  blockIndex = 0,
): NativeMediaOccurrence {
  return { attachment, messageIndex, blockIndex }
}

function jsonBytes(value: unknown): number {
  return textEncoder.encode(JSON.stringify(value)).length
}

function openaiPdfPart(name: string, bytes: Uint8Array) {
  return {
    type: 'file' as const,
    file: {
      filename: name,
      file_data: `data:application/pdf;base64,${Buffer.from(bytes).toString('base64')}`,
    },
  }
}

function expectNativeCode(run: () => unknown, code: string): void {
  try {
    run()
  } catch (error) {
    expect(error).toMatchObject({ code })
    return
  }
  throw new Error(`expected native-media error ${code}`)
}

async function planFor(
  name: string,
  bytes: Uint8Array,
  overrides: {
    protocol?: NativeMediaProtocol
    messageIndex?: number
    blockIndex?: number
    digest?: string
    limits?: NativeMediaLimits
  } = {},
): Promise<NativeMediaPlan> {
  return buildNativeMediaPlan({
    capability: capability(overrides.protocol),
    occurrences: [occurrence(ref(name, bytes, overrides.digest), overrides.messageIndex, overrides.blockIndex)],
    readFile: readerOf(bytes),
    limits: overrides.limits ?? limits(),
  })
}

const PDF = ascii('%PDF-1.7')
const WAV = concat(ascii('RIFF'), Uint8Array.of(0, 0, 0, 0), ascii('WAVE'))
const MP3_ID3 = ascii('ID3')
const MP3_FRAME = Uint8Array.of(0xff, 0xfb, 0x90, 0x64)
const FLAC = ascii('fLaC')
const OGG = ascii('OggS')
const MP4 = concat(Uint8Array.of(0, 0, 0, 24), ascii('ftyp'), ascii('isom'))
const WEBM = Uint8Array.of(0x1a, 0x45, 0xdf, 0xa3)

describe('buildNativeMediaPlan', () => {
  it('reads a real PDF and builds a deterministic openai-completions part', async () => {
    const attachment = ref('REPORT.PDF', PDF)
    const plan = await buildNativeMediaPlan({
      capability: capability(),
      occurrences: [occurrence(attachment, 2, 1)],
      readFile: readerOf(PDF),
      limits: limits(),
    })
    const base64 = Buffer.from(PDF).toString('base64')

    expect(plan).toEqual({
      protocol: 'openai-completions',
      rawBytes: PDF.byteLength,
      encodedBytes: jsonBytes(openaiPdfPart(attachment.name, PDF)),
      files: [{
        attachment,
        messageIndex: 2,
        blockIndex: 1,
        token: `[[dsh-native-media:sha256:${'a'.repeat(64)}:2:1]]`,
        kind: 'pdf',
        mimeType: 'application/pdf',
        format: 'pdf',
        filename: 'REPORT.PDF',
        bytes: PDF.byteLength,
        base64,
        encodedBytes: jsonBytes(openaiPdfPart(attachment.name, PDF)),
      }],
    })
    expect(encodeNativeMediaPart('openai-completions', plan.files[0] as NativeMediaFilePlan)).toEqual({
      type: 'file',
      file: {
        filename: 'REPORT.PDF',
        file_data: `data:application/pdf;base64,${base64}`,
      },
    })
  })

  it('encodes the exact Anthropic document source for a PDF', async () => {
    const plan = await planFor('report.pdf', PDF, { protocol: 'anthropic-messages' })
    const base64 = Buffer.from(PDF).toString('base64')

    const part = {
      type: 'document' as const,
      source: { type: 'base64' as const, media_type: 'application/pdf' as const, data: base64 },
    }
    expect(encodeNativeMediaPart('anthropic-messages', plan.files[0] as NativeMediaFilePlan)).toEqual(part)
    expect(plan.files[0]?.encodedBytes).toBe(jsonBytes(part))
  })

  it('builds every accepted audio and video format only after magic verification', async () => {
    const cases = [
      { name: 'voice.wav', bytes: WAV, mimeType: 'audio/wav', format: 'wav' },
      { name: 'voice.mp3', bytes: MP3_ID3, mimeType: 'audio/mpeg', format: 'mp3' },
      { name: 'frame.mp3', bytes: MP3_FRAME, mimeType: 'audio/mpeg', format: 'mp3' },
      { name: 'lossless.flac', bytes: FLAC, mimeType: 'audio/flac', format: 'flac' },
      { name: 'voice.ogg', bytes: OGG, mimeType: 'audio/ogg', format: 'ogg' },
      { name: 'clip.mp4', bytes: MP4, mimeType: 'video/mp4', format: 'mp4' },
      { name: 'clip.webm', bytes: WEBM, mimeType: 'video/webm', format: 'webm' },
    ] as const

    for (const entry of cases) {
      const plan = await planFor(entry.name, entry.bytes)
      const file = plan.files[0] as NativeMediaFilePlan
      const base64 = Buffer.from(entry.bytes).toString('base64')
      expect(file.mimeType).toBe(entry.mimeType)
      expect(file.kind).toBe(entry.mimeType.startsWith('audio/') ? 'audio' : 'video')
      expect(file.format).toBe(entry.format)
      const expectedPart = entry.mimeType.startsWith('audio/')
        ? { type: 'input_audio', input_audio: { data: base64, format: entry.format } }
        : { type: 'video_url', video_url: { url: `data:${entry.mimeType};base64,${base64}` } }
      expect(file.encodedBytes).toBe(jsonBytes(expectedPart))
      if (entry.mimeType.startsWith('audio/')) {
        expect(encodeNativeMediaPart('openai-completions', file)).toEqual({
          type: 'input_audio',
          input_audio: { data: base64, format: entry.format },
        })
      } else {
        expect(encodeNativeMediaPart('openai-completions', file)).toEqual({
          type: 'video_url',
          video_url: { url: `data:${entry.mimeType};base64,${base64}` },
        })
      }
    }
  })

  it('returns an empty plan without touching the reader', async () => {
    const readFile = vi.fn(readerOf(PDF))
    const plan = await buildNativeMediaPlan({
      capability: capability(),
      occurrences: [],
      readFile,
      limits: limits(),
    })

    expect(plan).toEqual({ protocol: 'openai-completions', files: [], rawBytes: 0, encodedBytes: 0 })
    expect(readFile).not.toHaveBeenCalled()
  })

  it('defers openai-responses and rejects Anthropic audio/video before reading', async () => {
    const readFile = vi.fn((_attachment: FileAttachmentRef, _signal?: AbortSignal) => {
      throw new Error('reader must not run')
    })

    await expect(buildNativeMediaPlan({
      capability: capability('openai-responses'),
      occurrences: [occurrence(ref('report.pdf', PDF))],
      readFile,
      limits: limits(),
    })).rejects.toMatchObject({ code: 'UNSUPPORTED_PROTOCOL' })

    for (const [name, bytes] of [['voice.wav', WAV], ['clip.mp4', MP4]] as const) {
      await expect(buildNativeMediaPlan({
        capability: capability('anthropic-messages'),
        occurrences: [occurrence(ref(name, bytes))],
        readFile,
        limits: limits(),
      })).rejects.toMatchObject({ code: 'UNSUPPORTED_MEDIA' })
    }
    expect(readFile).not.toHaveBeenCalled()
  })

  it.each([
    ['notes.bin', PDF],
    ['README', PDF],
    ['report.', PDF],
    ['.pdf', PDF],
  ])('rejects unsupported filename %s before reading', async (name, bytes) => {
    const readFile = vi.fn((_attachment: FileAttachmentRef, _signal?: AbortSignal) => {
      throw new Error('reader must not run')
    })

    await expect(buildNativeMediaPlan({
      capability: capability(),
      occurrences: [occurrence(ref(name, bytes))],
      readFile,
      limits: limits(),
    })).rejects.toMatchObject({ code: 'UNSUPPORTED_MEDIA' })
    expect(readFile).not.toHaveBeenCalled()
  })

  it('rejects a MIME type the model did not explicitly accept before reading', async () => {
    const readFile = vi.fn((_attachment: FileAttachmentRef, _signal?: AbortSignal) => {
      throw new Error('reader must not run')
    })

    await expect(buildNativeMediaPlan({
      capability: capability('openai-completions', ['audio/wav']),
      occurrences: [occurrence(ref('report.pdf', PDF))],
      readFile,
      limits: limits(),
    })).rejects.toMatchObject({ code: 'UNSUPPORTED_MEDIA' })
    expect(readFile).not.toHaveBeenCalled()
  })

  it.each([
    ['report.pdf', ascii('not a pdf')],
    ['voice.mp3', Uint8Array.of(0xff)],
  ])('rejects %s when its bytes do not match the claimed magic', async (name, bytes) => {
    await expect(buildNativeMediaPlan({
      capability: capability(),
      occurrences: [occurrence(ref(name, bytes))],
      readFile: readerOf(bytes),
      limits: limits(),
    })).rejects.toMatchObject({ code: 'MEDIA_TYPE_MISMATCH' })
  })

  it('accepts the exact raw per-file bound and rejects one byte over before reading', async () => {
    const attachment = ref('report.pdf', PDF)
    const exact = await buildNativeMediaPlan({
      capability: capability(),
      occurrences: [occurrence(attachment)],
      readFile: readerOf(PDF),
      limits: limits({ maxFileBytes: PDF.byteLength }),
    })
    expect(exact.rawBytes).toBe(PDF.byteLength)

    const readFile = vi.fn((_attachment: FileAttachmentRef, _signal?: AbortSignal) => {
      throw new Error('reader must not run')
    })
    await expect(buildNativeMediaPlan({
      capability: capability(),
      occurrences: [occurrence(attachment)],
      readFile,
      limits: limits({ maxFileBytes: PDF.byteLength - 1 }),
    })).rejects.toMatchObject({ code: 'FILE_TOO_LARGE' })
    expect(readFile).not.toHaveBeenCalled()
  })

  it('accepts the exact raw aggregate bound and rejects one byte over before reading', async () => {
    const first = ref('first.pdf', PDF, '1'.repeat(64))
    const second = ref('second.pdf', PDF, '2'.repeat(64))
    const occurrences = [occurrence(first, 0, 0), occurrence(second, 0, 1)]
    const plan = await buildNativeMediaPlan({
      capability: capability(),
      occurrences,
      readFile: readerOf(PDF),
      limits: limits({ maxFileBytes: PDF.byteLength, maxTotalBytes: PDF.byteLength * 2 }),
    })
    expect(plan.rawBytes).toBe(PDF.byteLength * 2)

    const readFile = vi.fn((_attachment: FileAttachmentRef, _signal?: AbortSignal) => {
      throw new Error('reader must not run')
    })
    await expect(buildNativeMediaPlan({
      capability: capability(),
      occurrences,
      readFile,
      limits: limits({ maxFileBytes: PDF.byteLength, maxTotalBytes: PDF.byteLength * 2 - 1 }),
    })).rejects.toMatchObject({ code: 'AGGREGATE_TOO_LARGE' })
    expect(readFile).not.toHaveBeenCalled()
  })

  it('counts the exact JSON-serialized part size for a multibyte filename', async () => {
    const name = 'résumé.pdf'
    const footprint = jsonBytes(openaiPdfPart(name, PDF))
    const exact = await buildNativeMediaPlan({
      capability: capability(),
      occurrences: [occurrence(ref(name, PDF))],
      readFile: readerOf(PDF),
      limits: limits({ maxEncodedFileBytes: footprint }),
    })
    expect(exact.files[0]?.encodedBytes).toBe(footprint)

    await expect(buildNativeMediaPlan({
      capability: capability(),
      occurrences: [occurrence(ref(name, PDF))],
      readFile: readerOf(PDF),
      limits: limits({ maxEncodedFileBytes: footprint - 1 }),
    })).rejects.toMatchObject({ code: 'ENCODED_FILE_TOO_LARGE' })
  })

  it('counts JSON quote and backslash escaping in the encoded per-file bound', async () => {
    const name = 'rés"um\\é.pdf'
    const part = openaiPdfPart(name, PDF)
    const footprint = jsonBytes(part)
    const exact = await buildNativeMediaPlan({
      capability: capability(),
      occurrences: [occurrence(ref(name, PDF))],
      readFile: readerOf(PDF),
      limits: limits({ maxEncodedFileBytes: footprint }),
    })

    expect(JSON.stringify(part)).toContain('\\"')
    expect(JSON.stringify(part)).toContain('\\\\')
    expect(exact.files[0]?.encodedBytes).toBe(footprint)
    expect(footprint).toBeGreaterThan(
      Buffer.from(PDF).toString('base64').length + textEncoder.encode(name).length,
    )

    await expect(buildNativeMediaPlan({
      capability: capability(),
      occurrences: [occurrence(ref(name, PDF))],
      readFile: readerOf(PDF),
      limits: limits({ maxEncodedFileBytes: footprint - 1 }),
    })).rejects.toMatchObject({ code: 'ENCODED_FILE_TOO_LARGE' })
  })

  it('accepts the exact encoded aggregate bound and rejects one byte over', async () => {
    const first = ref('first.pdf', PDF, '1'.repeat(64))
    const second = ref('second.pdf', PDF, '2'.repeat(64))
    const occurrences = [occurrence(first, 0, 0), occurrence(second, 0, 1)]
    const total = jsonBytes(openaiPdfPart(first.name, PDF)) + jsonBytes(openaiPdfPart(second.name, PDF))
    const plan = await buildNativeMediaPlan({
      capability: capability(),
      occurrences,
      readFile: readerOf(PDF),
      limits: limits({ maxEncodedTotalBytes: total }),
    })
    expect(plan.encodedBytes).toBe(total)

    await expect(buildNativeMediaPlan({
      capability: capability(),
      occurrences,
      readFile: readerOf(PDF),
      limits: limits({ maxEncodedTotalBytes: total - 1 }),
    })).rejects.toMatchObject({ code: 'ENCODED_AGGREGATE_TOO_LARGE' })
  })

  it.each([
    { maxFileBytes: -1 },
    { maxTotalBytes: 1.5 },
    { maxEncodedFileBytes: Number.NaN },
    { maxEncodedTotalBytes: Number.POSITIVE_INFINITY },
  ])('rejects invalid limits %o', async (overrides) => {
    await expect(buildNativeMediaPlan({
      capability: capability(),
      occurrences: [],
      readFile: readerOf(),
      limits: limits(overrides),
    })).rejects.toMatchObject({ code: 'INVALID_LIMIT' })
  })

  it('rejects invalid occurrence indices, duplicate positions, and negative reference bytes', async () => {
    const attachment = ref('report.pdf', PDF)

    await expect(buildNativeMediaPlan({
      capability: capability(),
      occurrences: [occurrence(attachment, -1, 0)],
      readFile: readerOf(PDF),
      limits: limits(),
    })).rejects.toMatchObject({ code: 'INVALID_OCCURRENCE' })

    await expect(buildNativeMediaPlan({
      capability: capability(),
      occurrences: [occurrence(attachment, 0, 0.5)],
      readFile: readerOf(PDF),
      limits: limits(),
    })).rejects.toMatchObject({ code: 'INVALID_OCCURRENCE' })

    await expect(buildNativeMediaPlan({
      capability: capability(),
      occurrences: [occurrence(attachment, 1, 1), occurrence(attachment, 1, 1)],
      readFile: readerOf(PDF),
      limits: limits(),
    })).rejects.toMatchObject({ code: 'DUPLICATE_OCCURRENCE' })

    await expect(buildNativeMediaPlan({
      capability: capability(),
      occurrences: [occurrence({ ...attachment, bytes: -1 })],
      readFile: readerOf(PDF),
      limits: limits(),
    })).rejects.toMatchObject({ code: 'INVALID_LIMIT' })
  })

  it('rejects more or fewer source bytes than the durable reference records', async () => {
    await expect(buildNativeMediaPlan({
      capability: capability(),
      occurrences: [occurrence({ ...ref('report.pdf', PDF), bytes: PDF.byteLength - 1 })],
      readFile: readerOf(PDF),
      limits: limits(),
    })).rejects.toMatchObject({ code: 'BYTE_LENGTH_MISMATCH' })

    await expect(buildNativeMediaPlan({
      capability: capability(),
      occurrences: [occurrence({ ...ref('report.pdf', PDF), bytes: PDF.byteLength + 1 })],
      readFile: readerOf(PDF),
      limits: limits(),
    })).rejects.toMatchObject({ code: 'BYTE_LENGTH_MISMATCH' })

    await expect(buildNativeMediaPlan({
      capability: capability(),
      occurrences: [occurrence(ref('report.pdf', PDF))],
      readFile: readerOf(),
      limits: limits(),
    })).rejects.toMatchObject({ code: 'BYTE_LENGTH_MISMATCH' })
  })

  it('rejects an already-aborted signal before reading', async () => {
    const controller = new AbortController()
    controller.abort()
    const readFile = vi.fn(readerOf(PDF))

    await expect(buildNativeMediaPlan({
      capability: capability(),
      occurrences: [occurrence(ref('report.pdf', PDF))],
      readFile,
      limits: limits(),
      signal: controller.signal,
    })).rejects.toMatchObject({ name: 'AbortError' })
    expect(readFile).not.toHaveBeenCalled()
  })

  it('aborts mid-read, returns the reader iterator, and never assembles a plan', async () => {
    const controller = new AbortController()
    let cleaned = false
    const bytes = PDF
    const iterable: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]() {
        let step = 0
        return {
          async next() {
            if (step === 0) {
              step += 1
              return { done: false, value: bytes.subarray(0, 4) }
            }
            controller.abort()
            return { done: false, value: bytes.subarray(4) }
          },
          async return() {
            cleaned = true
            return { done: true, value: undefined }
          },
        }
      },
    }

    await expect(buildNativeMediaPlan({
      capability: capability(),
      occurrences: [occurrence(ref('report.pdf', bytes))],
      readFile: () => iterable,
      limits: limits(),
      signal: controller.signal,
    })).rejects.toMatchObject({ name: 'AbortError' })
    expect(cleaned).toBe(true)
  })

  it('aborts cleanly when the reader exposes no return method', async () => {
    const controller = new AbortController()
    const bytes = PDF
    const iterator: AsyncIterator<Uint8Array> = {
      async next() {
        controller.abort()
        return { done: false, value: bytes }
      },
    }

    await expect(buildNativeMediaPlan({
      capability: capability(),
      occurrences: [occurrence(ref('report.pdf', bytes))],
      readFile: () => ({ [Symbol.asyncIterator]: () => iterator }),
      limits: limits(),
      signal: controller.signal,
    })).rejects.toMatchObject({ name: 'AbortError' })
  })
})

describe('encodeNativeMediaPart', () => {
  it('rejects Anthropic audio/video, Responses, and unknown protocols', async () => {
    const audio = await planFor('voice.wav', WAV)
    const video = await planFor('clip.mp4', MP4)
    const pdf = await planFor('report.pdf', PDF)

    expect(() => encodeNativeMediaPart('anthropic-messages', audio.files[0] as NativeMediaFilePlan))
      .toThrow(NativeMediaError)
    await expect(Promise.resolve().then(() => encodeNativeMediaPart('anthropic-messages', video.files[0] as NativeMediaFilePlan)))
      .rejects.toMatchObject({ code: 'UNSUPPORTED_MEDIA' })
    await expect(Promise.resolve().then(() => encodeNativeMediaPart('openai-responses', pdf.files[0] as NativeMediaFilePlan)))
      .rejects.toMatchObject({ code: 'UNSUPPORTED_PROTOCOL' })
    await expect(Promise.resolve().then(() => encodeNativeMediaPart('unknown' as NativeMediaProtocol, pdf.files[0] as NativeMediaFilePlan)))
      .rejects.toMatchObject({ code: 'UNSUPPORTED_PROTOCOL' })
  })

  it('rejects internally inconsistent audio/video plans instead of inventing a format', async () => {
    const audio = await planFor('voice.wav', WAV)
    const video = await planFor('clip.mp4', MP4)

    expect(() => encodeNativeMediaPart('openai-completions', {
      ...(audio.files[0] as NativeMediaFilePlan),
      kind: 'audio',
      format: 'pdf',
    })).toThrow(NativeMediaError)
    expect(() => encodeNativeMediaPart('openai-completions', {
      ...(audio.files[0] as NativeMediaFilePlan),
      kind: 'audio',
      format: 'mp4',
    })).toThrow(NativeMediaError)
    expect(() => encodeNativeMediaPart('openai-completions', {
      ...(video.files[0] as NativeMediaFilePlan),
      kind: 'video',
      format: 'pdf',
    })).toThrow(NativeMediaError)
    expect(() => encodeNativeMediaPart('openai-completions', {
      ...(video.files[0] as NativeMediaFilePlan),
      kind: 'video',
      format: 'wav',
    })).toThrow(NativeMediaError)
  })
})

describe('applyNativeMediaPayload', () => {
  it('replaces a standalone string sentinel through the pure onPayload callback', async () => {
    const plan = await planFor('report.pdf', PDF)
    const token = plan.files[0]?.token as string
    const payload = {
      model: 'test',
      tools: [{ name: 'f' }],
      messages: [{ role: 'user', content: token }],
      reasoning: { encrypted: 'kept' },
    }
    const before = structuredClone(payload)
    const patcher = createNativeMediaPayloadPatcher(plan)
    const output = patcher(payload) as typeof payload & { messages: [{ content: unknown[] }] }

    expect(payload).toEqual(before)
    expect(output).not.toBe(payload)
    expect(output.tools).toBe(payload.tools)
    expect(output.reasoning).toBe(payload.reasoning)
    expect(output.messages[0].content).toEqual([{
      type: 'file',
      file: {
        filename: 'report.pdf',
        file_data: `data:application/pdf;base64,${Buffer.from(PDF).toString('base64')}`,
      },
    }])
  })

  it('replaces only exact user text blocks and preserves cache metadata and every other block', async () => {
    const plan = await planFor('report.pdf', PDF)
    const token = plan.files[0]?.token as string
    const nestedToolResult = { type: 'tool_result', content: [{ type: 'text', text: token }] }
    const containingToken = { type: 'text', text: `literal prefix ${token}` }
    const foreignSentinel = { type: 'text', text: '[[dsh-native-media:sha256:ffff:0:9]]' }
    const untouched = { type: 'text', text: 'before' }
    const sentinel = { type: 'text', text: token, cache_control: { type: 'ephemeral' } }
    const payload = {
      tools: [{ name: 'f' }],
      messages: [
        { role: 'user', content: [untouched, nestedToolResult, containingToken, foreignSentinel, sentinel] },
        { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
      ],
    }
    const before = structuredClone(payload)
    const output = applyNativeMediaPayload(plan, payload) as typeof payload & {
      messages: [{ content: unknown[] }, { content: unknown[] }]
    }

    expect(payload).toEqual(before)
    expect(output.tools).toBe(payload.tools)
    expect(output.messages[1]).toBe(payload.messages[1])
    expect(output.messages[0].content[0]).toBe(untouched)
    expect(output.messages[0].content[1]).toBe(nestedToolResult)
    expect(output.messages[0].content[2]).toBe(containingToken)
    expect(output.messages[0].content[3]).toBe(foreignSentinel)
    expect(output.messages[0].content[4]).toEqual({
      cache_control: { type: 'ephemeral' },
      type: 'file',
      file: {
        filename: 'report.pdf',
        file_data: `data:application/pdf;base64,${Buffer.from(PDF).toString('base64')}`,
      },
    })
  })

  it('gives duplicate occurrences of one attachment distinct sentinels and replaces both', async () => {
    const attachment = ref('report.pdf', PDF)
    const plan = await buildNativeMediaPlan({
      capability: capability(),
      occurrences: [occurrence(attachment, 0, 1), occurrence(attachment, 0, 2)],
      readFile: readerOf(PDF),
      limits: limits(),
    })
    const [first, second] = plan.files
    expect(first?.token).not.toBe(second?.token)

    const payload = {
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: first?.token },
          { type: 'text', text: second?.token },
        ],
      }],
    }
    const output = applyNativeMediaPayload(plan, payload) as { messages: [{ content: unknown[] }] }

    expect(output.messages[0].content).toHaveLength(2)
    expect(output.messages[0].content[0]).toMatchObject({ type: 'file' })
    expect(output.messages[0].content[1]).toMatchObject({ type: 'file' })
  })

  it('fails when any sentinel is missing', async () => {
    const first = ref('first.pdf', PDF, '1'.repeat(64))
    const second = ref('second.pdf', PDF, '2'.repeat(64))
    const plan = await buildNativeMediaPlan({
      capability: capability(),
      occurrences: [occurrence(first, 0, 0), occurrence(second, 0, 1)],
      readFile: readerOf(PDF),
      limits: limits(),
    })
    const payload = {
      messages: [{ role: 'user', content: [{ type: 'text', text: plan.files[0]?.token }] }],
    }

    expect(() => applyNativeMediaPayload(plan, payload)).toThrow(NativeMediaError)
    try {
      applyNativeMediaPayload(plan, payload)
    } catch (error) {
      expect(error).toMatchObject({ code: 'PLACEHOLDER_MISSING' })
    }
  })

  it('fails a duplicated sentinel rather than splitting a message', async () => {
    const plan = await planFor('report.pdf', PDF)
    const token = plan.files[0]?.token as string
    const payload = {
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: token },
          { type: 'text', text: token },
        ],
      }],
    }

    expect(() => applyNativeMediaPayload(plan, payload)).toThrow(NativeMediaError)
    try {
      applyNativeMediaPayload(plan, payload)
    } catch (error) {
      expect(error).toMatchObject({ code: 'PLACEHOLDER_DUPLICATED' })
    }
  })

  it('rejects a sentinel in tool content instead of letting tool output bypass the type gate', async () => {
    const plan = await planFor('report.pdf', PDF)
    const token = plan.files[0]?.token as string
    const payload = {
      messages: [{ role: 'tool', content: [{ type: 'text', text: token }] }],
    }

    expect(() => applyNativeMediaPayload(plan, payload)).toThrow(NativeMediaError)
    try {
      applyNativeMediaPayload(plan, payload)
    } catch (error) {
      expect(error).toMatchObject({ code: 'PLACEHOLDER_UNCONSUMED' })
    }
  })

  it('fails safely on malformed payloads and leaves non-plan text alone', async () => {
    const plan = await planFor('report.pdf', PDF)
    const token = plan.files[0]?.token as string
    const foreign = { type: 'text', text: '[[dsh-native-media:sha256:eeee:3:4]]' }

    expect(() => applyNativeMediaPayload(plan, null)).toThrow(NativeMediaError)
    expect(() => applyNativeMediaPayload(plan, { messages: {} })).toThrow(NativeMediaError)
    expect(() => applyNativeMediaPayload(plan, {
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: `prefix ${token}` },
          foreign,
        ],
      }],
    })).toThrow(NativeMediaError)

    const payload = {
      messages: [
        null,
        { role: 'user', content: 42 },
        { role: 'user', content: 'plain text' },
        {
          role: 'user',
          content: [
            null,
            { type: 'image' },
            { type: 'text', text: 123 },
            foreign,
            { type: 'text', text: token },
          ],
        },
      ],
    }
    const output = applyNativeMediaPayload(plan, payload) as {
      messages: [null, { content: number }, { content: string }, { content: unknown[] }]
    }

    expect(output.messages[0]).toBeNull()
    expect(output.messages[1]).toBe(payload.messages[1])
    expect(output.messages[2]).toBe(payload.messages[2])
    expect(output.messages[3].content[0]).toBeNull()
    expect(output.messages[3].content[1]).toEqual({ type: 'image' })
    expect(output.messages[3].content[2]).toEqual({ type: 'text', text: 123 })
    expect(output.messages[3].content[3]).toBe(foreign)
    expect(output.messages[3].content[4]).toMatchObject({ type: 'file' })
  })

  it('returns an empty plan unchanged and rejects a plan with duplicate sentinels', async () => {
    const empty: NativeMediaPlan = { protocol: 'openai-completions', files: [], rawBytes: 0, encodedBytes: 0 }
    const payload = { messages: [] }
    expect(applyNativeMediaPayload(empty, payload)).toBe(payload)

    const plan = await planFor('report.pdf', PDF)
    const file = plan.files[0] as NativeMediaFilePlan
    expect(() => applyNativeMediaPayload({ ...plan, files: [file, file] }, payload))
      .toThrow(NativeMediaError)
  })

  it('enforces an explicit complete-body payload byte cap and defaults to none', async () => {
    const plan = await planFor('report.pdf', PDF)
    const token = plan.files[0]?.token as string
    const payload = {
      model: 'test',
      tools: [{ name: 'big', description: 'x'.repeat(200) }],
      messages: [
        { role: 'system', content: 'system instructions' },
        {
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
            { type: 'text', text: token },
          ],
        },
        { role: 'assistant', content: [{ type: 'text', text: 'history' }] },
      ],
    }
    const patched = applyNativeMediaPayload(plan, payload)
    const exact = jsonBytes(patched)

    expect(createNativeMediaPayloadPatcher(plan, { maxPayloadBytes: exact })(payload)).toEqual(patched)
    expectNativeCode(
      () => createNativeMediaPayloadPatcher(plan, { maxPayloadBytes: exact - 1 })(payload),
      'PAYLOAD_TOO_LARGE',
    )
    expectNativeCode(
      () => applyNativeMediaPayload(plan, payload, { maxPayloadBytes: -1 }),
      'INVALID_LIMIT',
    )

    const oversized = {
      ...payload,
      messages: [...payload.messages, { role: 'assistant', content: 'x'.repeat(5000) }],
    }
    expect(applyNativeMediaPayload(plan, oversized)).toBeTruthy()
    expectNativeCode(
      () => applyNativeMediaPayload(plan, oversized, { maxPayloadBytes: exact }),
      'PAYLOAD_TOO_LARGE',
    )
  })

  it('applies an explicit cap even when the plan has no files', () => {
    const empty: NativeMediaPlan = { protocol: 'openai-completions', files: [], rawBytes: 0, encodedBytes: 0 }
    const payload = { messages: [] }
    const exact = jsonBytes(payload)
    expect(applyNativeMediaPayload(empty, payload, { maxPayloadBytes: exact })).toEqual(payload)
    expectNativeCode(
      () => applyNativeMediaPayload(empty, payload, { maxPayloadBytes: exact - 1 }),
      'PAYLOAD_TOO_LARGE',
    )
  })
})

describe('insertNativeMediaSentinels', () => {
  it('inserts each sentinel as a standalone text block without flattening content', async () => {
    const plan = await planFor('report.pdf', PDF, { messageIndex: 0, blockIndex: 1 })
    const file = plan.files[0] as NativeMediaFilePlan
    const image = { type: 'image', attachment: { attachmentId: 'sha256:image', bytes: 1 } }
    const messages = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'read this' },
          { type: 'file', attachment: file.attachment },
          image,
        ],
      },
      { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
    ]
    const output = insertNativeMediaSentinels(messages, plan) as [{ content: unknown[] }, unknown]

    expect(output).not.toBe(messages)
    expect(output[0]).not.toBe(messages[0])
    expect(output[1]).toBe(messages[1])
    expect(messages[0]?.content[1]).toEqual({ type: 'file', attachment: file.attachment })
    expect(Array.isArray(output[0].content)).toBe(true)
    expect(output[0].content[0]).toBe(messages[0]?.content[0])
    expect(output[0].content[1]).toEqual({ type: 'text', text: file.token })
    expect(output[0].content[2]).toBe(image)
  })

  it('clones an empty plan message array without changing entries', () => {
    const messages = [{ role: 'user', content: 'hi' }]
    const empty: NativeMediaPlan = { protocol: 'openai-completions', files: [], rawBytes: 0, encodedBytes: 0 }
    const output = insertNativeMediaSentinels(messages, empty)

    expect(output).not.toBe(messages)
    expect(output).toEqual(messages)
  })

  it('rejects moved positions and every attachment identity mismatch before insertion', async () => {
    const plan = await planFor('report.pdf', PDF, { messageIndex: 0, blockIndex: 1 })
    const file = plan.files[0] as NativeMediaFilePlan
    const expected = file.attachment

    expectNativeCode(() => insertNativeMediaSentinels([{
      role: 'user',
      content: [
        { type: 'file', attachment: expected },
        { type: 'text', text: 'file moved to block 0' },
      ],
    }], plan), 'INVALID_OCCURRENCE')

    for (const attachment of [
      { ...expected, attachmentId: AttachmentId(`sha256:${'b'.repeat(64)}`) },
      { ...expected, bytes: expected.bytes + 1 },
      { ...expected, name: 'other.pdf' },
    ]) {
      expectNativeCode(() => insertNativeMediaSentinels([{
        role: 'user',
        content: [
          { type: 'text', text: 'read' },
          { type: 'file', attachment },
        ],
      }], plan), 'INVALID_OCCURRENCE')
    }

    expectNativeCode(() => insertNativeMediaSentinels([], plan), 'INVALID_OCCURRENCE')
    expectNativeCode(() => insertNativeMediaSentinels([{ role: 'user', content: 'flat' }], plan), 'INVALID_OCCURRENCE')
  })

  it('rejects a user-typed sentinel anywhere before a missing file can be replaced', async () => {
    const plan = await planFor('report.pdf', PDF, { messageIndex: 0, blockIndex: 1 })
    const token = plan.files[0]?.token as string

    expectNativeCode(() => insertNativeMediaSentinels([{
      role: 'user',
      content: [
        { type: 'text', text: 'read' },
        { type: 'text', text: token },
      ],
    }], plan), 'SENTINEL_COLLISION')

    const file = plan.files[0] as NativeMediaFilePlan
    expectNativeCode(() => insertNativeMediaSentinels([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'read' },
          { type: 'file', attachment: file.attachment },
        ],
      },
      { role: 'tool', content: [{ type: 'text', text: token }] },
    ], plan), 'SENTINEL_COLLISION')
  })

  it('rejects duplicate planned positions and survives cyclic history objects', async () => {
    const plan = await planFor('report.pdf', PDF, { messageIndex: 0, blockIndex: 0 })
    const file = plan.files[0] as NativeMediaFilePlan
    expectNativeCode(() => insertNativeMediaSentinels([{
      role: 'user',
      content: [{ type: 'file', attachment: file.attachment }],
    }], { ...plan, files: [file, { ...file, token: `${file.token}:duplicate-position` }] }), 'DUPLICATE_OCCURRENCE')

    const cyclic: Record<string, unknown> = { role: 'user', content: [] }
    cyclic.self = cyclic
    expectNativeCode(() => insertNativeMediaSentinels([cyclic], plan), 'INVALID_OCCURRENCE')
  })

  it('preserves unplanned tool file blocks and rejects a planned tool position', async () => {
    const plan = await planFor('report.pdf', PDF, { messageIndex: 0, blockIndex: 1 })
    const file = plan.files[0] as NativeMediaFilePlan
    const toolFile = { type: 'file', attachment: ref('evidence.pdf', PDF, 'f'.repeat(64)) }
    const messages = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'read' },
          { type: 'file', attachment: file.attachment },
        ],
      },
      { role: 'tool', content: [toolFile, { type: 'text', text: 'tool output' }] },
    ]
    const output = insertNativeMediaSentinels(messages, plan) as [{ content: unknown[] }, { content: unknown[] }]

    expect(output[1]).toBe(messages[1])
    expect(output[1].content[0]).toBe(toolFile)
    expect(output[0].content[1]).toEqual({ type: 'text', text: file.token })
    expect(messages[1]?.content[0]).toBe(toolFile)

    expectNativeCode(() => insertNativeMediaSentinels([{
      role: 'tool',
      content: [
        { type: 'text', text: 'tool' },
        { type: 'file', attachment: file.attachment },
      ],
    }], plan), 'INVALID_OCCURRENCE')
  })
})
