/**
 * Request conversion: full envelope, media-type detection order, image
 * hoisting out of tool results, the converter's single image budget, and the
 * conversion-seam text sanitizer (scrub + 200k cap) the pooled route opts
 * into.
 */
import { expect, it } from 'vitest'
import { buildRequest, detectMediaType } from '../src/convert.js'
import type { CcInputMessage, CcInputPart } from '../src/convert.js'
import { MAX_INLINE_TOOL_TEXT_CHARS } from '../src/sanitize.js'

const PNG = 'A'.repeat(2048)

function user(parts: CcInputPart[]): CcInputMessage {
  return { role: 'user', content: parts }
}

it('always sends the validated envelope: config object + memory string + CLI stubs', () => {
  const envelope = buildRequest({
    model: 'deepseek/deepseek-v4.1-flash',
    messages: [user([{ type: 'text', text: 'hi' }])],
    now: new Date('2026-09-28T12:00:00Z'),
  })
  expect(typeof envelope.config).toBe('object')
  expect(typeof envelope.memory).toBe('string')
  expect(typeof envelope.taste).toBe('string')
  expect(envelope.skills).toBeNull()
  expect(envelope.permissionMode).toBe('standard')
  expect(envelope.config.date).toBe('2026-09-28')
  expect(envelope.params.stream).toBe(true)
  expect(envelope.params.messages).toEqual([{ role: 'user', content: 'hi' }])
})

it('detects media type in order: mediaType, mimeType, media_type, data: header', () => {
  expect(detectMediaType({ type: 'file', mediaType: 'image/png' })).toBe('image/png')
  expect(detectMediaType({ type: 'file', mimeType: 'image/jpeg' })).toBe('image/jpeg')
  expect(detectMediaType({ type: 'file', media_type: 'image/webp' })).toBe('image/webp')
  expect(detectMediaType({ type: 'file', data: 'data:image/gif;base64,AAAA' })).toBe('image/gif')
  expect(detectMediaType({ type: 'file', data: 'AAAA' })).toBe('application/octet-stream')
  // mediaType wins over the data: header (the regression that inlined base64).
  expect(detectMediaType({ type: 'file', mediaType: 'image/png', data: 'data:image/gif;base64,AAAA' })).toBe('image/png')
})

it('converts an image to the vendor wire shape and never inlines its base64 as text', () => {
  const envelope = buildRequest({
    model: 'm',
    messages: [user([{ type: 'text', text: 'look' }, { type: 'file', data: PNG, mediaType: 'image/png' }])],
  })
  const content = envelope.params.messages[0]!.content as Array<Record<string, unknown>>
  expect(content).toEqual([
    { type: 'text', text: 'look' },
    { type: 'image', image: `data:image/png;base64,${PNG}`, mimeType: 'image/png' },
  ])
  const serialized = JSON.stringify(content)
  expect(serialized.split('base64,').length - 1).toBe(1)
  expect(serialized).not.toMatch(/"text":"[^"]*AAAAAAAA/)
})

it('hoists tool-result images into a synthetic user message right after the tool message', () => {
  const envelope = buildRequest({
    model: 'm',
    messages: [
      { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'c1', toolName: 'read', arguments: '{}' }] },
      { role: 'tool', content: [{ type: 'file', data: PNG, mediaType: 'image/png' }], toolCallId: 'c1' },
    ],
  })
  const [assistant, tool, hoisted] = envelope.params.messages as Array<Record<string, unknown>>
  expect(assistant!.role).toBe('assistant')
  expect(tool!.role).toBe('tool')
  const output = (tool!.content as Array<{ output: { value: string } }>)[0]!.output.value
  expect(output).toContain('[image/png image')
  expect(output).toContain('attached as a user message below')
  expect(output).not.toContain(PNG)
  expect(hoisted!.role).toBe('user')
  const parts = hoisted!.content as Array<Record<string, unknown>>
  expect(parts[0]).toEqual({ type: 'text', text: 'Images returned by the tool call(s) above:' })
  expect(parts[1]).toEqual({ type: 'image', image: `data:image/png;base64,${PNG}`, mimeType: 'image/png' })
})

it('resolves the tool name from assistant history and parses tool-call input', () => {
  const envelope = buildRequest({
    model: 'm',
    messages: [
      { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'c9', toolName: 'get_weather', arguments: '{"city":"Berlin"}' }] },
      { role: 'tool', content: [{ type: 'text', text: 'sunny' }], toolCallId: 'c9' },
    ],
  })
  const assistant = envelope.params.messages[0] as { content: Array<{ input: unknown }> }
  expect(assistant.content[0]!.input).toEqual({ city: 'Berlin' })
  const tool = envelope.params.messages[1] as { content: Array<{ toolName: string; output: { value: string } }> }
  expect(tool.content[0]!.toolName).toBe('get_weather')
  expect(tool.content[0]!.output.value).toBe('sunny')
})

it('omits images as text when the catalog says the model has no vision', () => {
  const envelope = buildRequest({
    model: 'm',
    visionEnabled: false,
    messages: [user([{ type: 'file', data: PNG, mediaType: 'image/png' }])],
  })
  const content = envelope.params.messages[0]!.content as string
  expect(content).toContain('does not accept image input')
  expect(content).not.toContain(PNG)
})

it('deduplicates an identical forwarded tool image', () => {
  const envelope = buildRequest({
    model: 'm',
    messages: [
      { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'c1', toolName: 'read', arguments: '{}' }] },
      { role: 'tool', content: [{ type: 'file', data: PNG, mediaType: 'image/png' }], toolCallId: 'c1' },
      { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'c2', toolName: 'read', arguments: '{}' }] },
      { role: 'tool', content: [{ type: 'file', data: PNG, mediaType: 'image/png' }], toolCallId: 'c2' },
    ],
  })
  const tools = envelope.params.messages.filter(message => message.role === 'tool') as Array<{ content: Array<{ output: { value: string } }> }>
  expect(tools).toHaveLength(2)
  expect(tools[1]!.content[0]!.output.value).toContain('already attached earlier')
})

it('treats a non-image binary as a size note, never serialized payload', () => {
  const envelope = buildRequest({
    model: 'm',
    messages: [user([{ type: 'file', data: PNG, mimeType: 'application/pdf' }])],
  })
  const text = envelope.params.messages[0]!.content as string
  expect(text).toContain('[attachment omitted: application/pdf')
  expect(text).not.toContain(PNG)
})

it('budgets user images per request: the oldest are omitted and the newest are kept', () => {
  // 14 images of the same size: the 12 newest must survive, oldest 2 omitted.
  const images = Array.from({ length: 14 }, (_, index) => ({
    type: 'file',
    mediaType: 'image/png',
    data: `data:image/png;base64,AAAA${index}`,
  }))
  const envelope = buildRequest({ model: 'm', messages: [user(images)] })
  const content = envelope.params.messages[0]!.content as Array<{ type: string; image?: string; text?: string }>
  expect(content).toHaveLength(14)
  expect(content.slice(0, 2).every(part => part.type === 'text' && part.text?.includes('per-request image budget reached'))).toBe(true)
  const kept = content.slice(2).filter(part => part.type === 'image')
  expect(kept).toHaveLength(12)
  // Newest kept, oldest dropped: the survivors are images 2..13.
  expect(kept[0]!.image).toBe('data:image/png;base64,AAAA2')
  expect(kept[11]!.image).toBe('data:image/png;base64,AAAA13')
})

it('keeps the newest user images within the request byte budget', () => {
  const sixMiB = 6 * 1024 * 1024
  const big = (marker: string) => ({
    type: 'file',
    mediaType: 'image/png',
    data: `data:image/png;base64,${marker.repeat(sixMiB)}`,
  })
  const envelope = buildRequest({
    model: 'm',
    messages: [user([big('a')]), user([big('b')]), user([big('c')])],
  })
  // 3 x 6 MiB exceeds the 16 MiB request budget: oldest (a) is omitted.
  const [oldest, middle, newest] = envelope.params.messages
  expect(oldest!.content as string).toContain('per-request image budget reached')
  expect((middle!.content as Array<{ type: string }>)[0]!.type).toBe('image')
  expect((newest!.content as Array<{ type: string }>)[0]!.type).toBe('image')
  const keptBytes = [middle, newest]
    .map(message => (message!.content as Array<{ image: string }>)[0]!.image.length)
    .reduce((total, length) => total + length, 0)
  expect(keptBytes).toBeLessThanOrEqual(16 * 1024 * 1024)
})

it('omits a lone user image over the per-image forward limit', () => {
  const overLimit = `data:image/png;base64,${'A'.repeat(9 * 1024 * 1024)}`
  const envelope = buildRequest({
    model: 'm',
    messages: [user([{ type: 'file', mediaType: 'image/png', data: overLimit }])],
  })
  const content = envelope.params.messages[0]!.content as string
  expect(content).toContain('per-request image budget reached')
  expect(content).not.toContain('AAAAAAAA')
})

it('scrubs embedded base64 and caps oversized tool text at conversion when the route has no proxy', () => {
  const uri = `data:image/png;base64,${'C'.repeat(600)}`
  const long = 'x'.repeat(MAX_INLINE_TOOL_TEXT_CHARS + 5)
  const envelope = buildRequest({
    model: 'm',
    sanitizeText: true,
    messages: [
      { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'c1', toolName: 'read', arguments: '{}' }] },
      { role: 'tool', content: [{ type: 'text', text: `see ${uri}` }], toolCallId: 'c1' },
      { role: 'tool', content: long, toolCallId: 'c2' },
    ],
  })
  const values = (envelope.params.messages.filter(message => message.role === 'tool') as Array<{
    content: Array<{ output: { value: string } }>
  }>).map(message => message.content[0]!.output.value)

  expect(values[0]).toContain('[embedded base64 payload omitted: ~')
  expect(values[0]).not.toContain('CCCC')
  expect(values[1]).toContain(
    `[output truncated: ${MAX_INLINE_TOOL_TEXT_CHARS + 5} chars exceed ${MAX_INLINE_TOOL_TEXT_CHARS} limit]`,
  )
})

it('caps the joined tool output once, not each fragment in isolation', () => {
  const half = 'z'.repeat(MAX_INLINE_TOOL_TEXT_CHARS - 10)
  const envelope = buildRequest({
    model: 'm',
    sanitizeText: true,
    messages: [{ role: 'tool', content: [{ type: 'text', text: half }, { type: 'text', text: half }], toolCallId: 'c1' }],
  })
  const value = (envelope.params.messages[0] as {
    content: Array<{ output: { value: string } }>
  }).content[0]!.output.value
  const joined = `${half}\n${half}`
  expect(value).toContain(`[output truncated: ${joined.length} chars exceed ${MAX_INLINE_TOOL_TEXT_CHARS} limit]`)
})

it('scrubs embedded base64 in string content at conversion when the route has no proxy', () => {
  const uri = `data:image/png;base64,${'E'.repeat(700)}`
  const envelope = buildRequest({
    model: 'm',
    sanitizeText: true,
    messages: [
      user([{ type: 'text', text: `look ${uri}` }]),
      { role: 'tool', content: `tool saw ${uri}`, toolCallId: 'c1' },
    ],
  })
  const userText = envelope.params.messages[0]!.content as string
  expect(userText).toContain('[embedded base64 payload omitted: ~')
  expect(userText).not.toContain('EEEE')
  const tool = envelope.params.messages[1] as { content: Array<{ output: { value: string } }> }
  expect(tool.content[0]!.output.value).toContain('[embedded base64 payload omitted: ~')
  expect(tool.content[0]!.output.value).not.toContain('EEEE')
})

it('leaves text untouched on the default keypool path, where the proxy sanitizes downstream', () => {
  const uri = `data:image/png;base64,${'F'.repeat(700)}`
  const long = 'y'.repeat(MAX_INLINE_TOOL_TEXT_CHARS + 5)
  const envelope = buildRequest({
    model: 'm',
    messages: [user([{ type: 'text', text: uri }]), { role: 'tool', content: long, toolCallId: 'c1' }],
  })
  expect(envelope.params.messages[0]!.content as string).toBe(uri)
  const tool = envelope.params.messages[1] as { content: Array<{ output: { value: string } }> }
  expect(tool.content[0]!.output.value).toBe(long)
})
