/**
 * Sanitizer parity with the standalone keypool proxy: the embedded base64
 * scrub, the 200k text cap, and the 413 strip-older-images rewrite. The ported
 * bodies keep the proxy fixture sizes so the outcomes are comparable. Image
 * budgeting is not tested here: the converter's forward pass is the request's
 * only image budget, and `convert.spec.ts` owns it.
 */
import { expect, it } from 'vitest'
import type { SanitizableEnvelope, SanitizableMessage } from '../src/sanitize.js'
import {
  MAX_INLINE_TOOL_TEXT_CHARS,
  sanitizeText,
  stripOlderImagesKeepingNewest,
} from '../src/sanitize.js'

function envelope(messages: unknown[]): SanitizableEnvelope {
  return { params: { messages } }
}

function messagesOf(env: SanitizableEnvelope): SanitizableMessage[] {
  return env.params.messages as SanitizableMessage[]
}

function partsOf(message: SanitizableMessage): Array<Record<string, unknown>> {
  return message.content as Array<Record<string, unknown>>
}

it('scrubs an embedded base64 payload from text content', () => {
  const uri = `data:image/png;base64,${'A'.repeat(600)}`
  const content = sanitizeText(`look at this ${uri} please`)

  expect(content).toContain('look at this [embedded base64 payload omitted: ~')
  expect(content).toContain('] please')
  expect(content).not.toContain('AAAA')
})

it('scrubs a large embedded base64 payload and reports its size', () => {
  const uri = `data:image/jpeg;base64,${'B'.repeat(1024)}`
  const content = sanitizeText(`see ${uri}`)

  expect(content).toContain('[embedded base64 payload omitted: ~1 KB]')
  expect(content).not.toContain('BBBB')
})

it('caps oversized text at 200,000 characters with the proxy note', () => {
  const long = 'x'.repeat(MAX_INLINE_TOOL_TEXT_CHARS + 1)
  const content = sanitizeText(long)

  expect(content.length).toBe(MAX_INLINE_TOOL_TEXT_CHARS
    + `\n... [output truncated: ${MAX_INLINE_TOOL_TEXT_CHARS + 1} chars exceed ${MAX_INLINE_TOOL_TEXT_CHARS} limit]`.length)
  expect(content).toContain(`[output truncated: ${MAX_INLINE_TOOL_TEXT_CHARS + 1} chars exceed ${MAX_INLINE_TOOL_TEXT_CHARS} limit]`)
})

it('strips every image but the newest for the 413 retry, newest kept', () => {
  const env = envelope([{
    role: 'user',
    content: [
      { type: 'image', image: 'data:image/png;base64,AAAA1' },
      { type: 'image', image: 'data:image/png;base64,AAAA2' },
      { type: 'image', image: 'data:image/png;base64,AAAA3' },
    ],
  }])

  expect(stripOlderImagesKeepingNewest(env)).toBe(2)
  const content = partsOf(messagesOf(env)[0] as SanitizableMessage)
  const images = content.filter(part => part.type === 'image')
  expect(images).toHaveLength(1)
  expect(images[0]?.image).toBe('data:image/png;base64,AAAA3')
  const notes = content.filter(part => (
    part.type === 'text' && String(part.text).includes('request exceeded the upstream payload limit')
  ))
  expect(notes).toHaveLength(2)
})

it('keeps the newest image across messages, not just within one', () => {
  const env = envelope([
    { role: 'user', content: [{ type: 'image', image: 'data:image/png;base64,OLDER' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
    { role: 'user', content: [{ type: 'image', image: 'data:image/png;base64,NEWEST' }] },
  ])

  expect(stripOlderImagesKeepingNewest(env)).toBe(1)
  const images = messagesOf(env).flatMap(message => partsOf(message).filter(part => part.type === 'image'))
  expect(images).toHaveLength(1)
  expect(images[0]?.image).toBe('data:image/png;base64,NEWEST')
})

it('reports zero when there is no older image to strip', () => {
  const env = envelope([{ role: 'user', content: [{ type: 'text', text: 'no images here' }] }])
  expect(stripOlderImagesKeepingNewest(env)).toBe(0)
  expect(stripOlderImagesKeepingNewest(envelope([]))).toBe(0)
})
