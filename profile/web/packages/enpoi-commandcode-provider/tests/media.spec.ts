/**
 * User-attached images ride the route's request-sized reader (the route's
 * pixel/byte budget) so a burst of stored 4 MiB images never reaches the wire
 * at stored size; tool-result images keep their stored bytes and the
 * converter's own hoisting budget.
 */
import { expect, it, vi } from 'vitest'
import { createToolResultMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import type { ImageAttachmentRef, ImageRequestTarget } from '@deepseek-ai/dsh-attachment'
import { toCcMessages } from '../src/adapter.js'
import { buildRequest } from '../src/convert.js'

const budget = { maxPixels: 2048 * 2048, maxBytes: 1024 * 1024 }

function attachment(name: string, overrides: Partial<ImageAttachmentRef> = {}): ImageAttachmentRef {
  return {
    attachmentId: `sha256:${name.padEnd(64, '0')}` as never,
    mediaType: 'image/png',
    bytes: 4 * 1024 * 1024,
    width: 4096,
    height: 2048,
    name,
    ...overrides,
  }
}

function options(messages: GenerateOptions['messages']): GenerateOptions {
  return { provider: 'commandcode', model: 'm', messages }
}

it('reads a user-attached image through the route request target', async () => {
  const readImage = vi.fn()
  const readUserImage = vi.fn((_ref: ImageAttachmentRef, _target: ImageRequestTarget) => (
    Promise.resolve({ data: Uint8Array.of(1, 2, 3), mediaType: 'image/jpeg' })
  ))
  const image = attachment('shot')
  const messages = await toCcMessages(
    options([{ role: 'user', content: [{ type: 'image', attachment: image }] } as never]),
    readImage,
    readUserImage,
    budget,
  )

  expect(readImage).not.toHaveBeenCalled()
  expect(readUserImage).toHaveBeenCalledTimes(1)
  const [ref, target] = readUserImage.mock.calls[0]!
  expect(ref).toEqual(image)
  // 4096x2048 under a 2048x2048 total-pixel budget keeps the aspect ratio.
  expect(target).toEqual({ width: 2896, height: 1448, maxBytes: 1024 * 1024 })
  expect(messages).toEqual([{
    role: 'user',
    content: [{ type: 'file', mediaType: 'image/jpeg', data: 'data:image/jpeg;base64,AQID' }],
  }])
})

it('keeps a source already inside the request target unchanged', async () => {
  const readUserImage = vi.fn((_ref: ImageAttachmentRef, _target: ImageRequestTarget) => (
    Promise.resolve({ data: Uint8Array.of(7), mediaType: 'image/png' })
  ))
  await toCcMessages(
    options([{ role: 'user', content: [{ type: 'image', attachment: attachment('small', { width: 1000, height: 1000, bytes: 500_000 }) }] } as never]),
    undefined,
    readUserImage,
    budget,
  )
  expect(readUserImage.mock.calls[0]![1]).toEqual({ width: 1000, height: 1000, maxBytes: 1024 * 1024 })
})

it('keeps the stored reader for tool-result images', async () => {
  const readImage = vi.fn(() => Promise.resolve({ data: Uint8Array.of(1), mediaType: 'image/png' }))
  const readUserImage = vi.fn()
  const callId = ToolCallId('shot')
  const messages = await toCcMessages(
    options([createToolResultMessage({
      callId,
      content: [{ type: 'image', attachment: attachment('tool') }],
      isError: false,
    })]),
    readImage,
    readUserImage,
    budget,
  )

  expect(readUserImage).not.toHaveBeenCalled()
  expect(readImage).toHaveBeenCalledTimes(1)
  expect(messages[0]).toMatchObject({ role: 'tool', toolCallId: 'shot' })
  const content = messages[0]?.content
  expect(Array.isArray(content) && content[0]).toMatchObject({
    type: 'file',
    mediaType: 'image/png',
    data: 'data:image/png;base64,AQ==',
  })
})

it('falls back to the stored reader without a request-sized reader', async () => {
  const readImage = vi.fn(() => Promise.resolve({ data: Uint8Array.of(9), mediaType: 'image/png' }))
  const messages = await toCcMessages(
    options([{ role: 'user', content: [{ type: 'image', attachment: attachment('legacy') }] } as never]),
    readImage,
  )
  expect(readImage).toHaveBeenCalledTimes(1)
  expect(messages[0]?.content).toEqual([
    { type: 'file', mediaType: 'image/png', data: 'data:image/png;base64,CQ==' },
  ])
})

it('keeps the newest user images when request-sized bytes still exceed the wire budget', async () => {
  const readUserImage = vi.fn(() => Promise.resolve({
    data: new Uint8Array(512 * 1024), mediaType: 'image/png',
  }))
  const messages = await toCcMessages(
    options(Array.from({ length: 14 }, (_, index) => ({
      role: 'user',
      content: [{ type: 'image', attachment: attachment(`shot-${String(index)}`) }],
    })) as never),
    undefined,
    readUserImage,
    budget,
  )
  const envelope = buildRequest({ model: 'm', messages, visionEnabled: true })
  const kept = envelope.params.messages.flatMap(message => (
    Array.isArray(message.content) ? message.content.filter(part => part.type === 'image') : []
  ))
  // The 12 newest survive; the two oldest degrade to their omission note.
  expect(kept).toHaveLength(12)
  expect(envelope.params.messages[0]!.content as unknown as string).toContain('per-request image budget reached')
})
