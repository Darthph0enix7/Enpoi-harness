import { afterEach, describe, expect, it, vi } from 'vitest'
import { captureResponse } from '../src/response-capture.ts'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('captureResponse', () => {
  it('declines protocols that cannot accept a custom fetch', () => {
    const capture = captureResponse('google-generative-ai')

    expect(capture.fetch).toBeUndefined()
    expect(capture.facts()).toBeUndefined()
  })

  it('records the status and Retry-After of a non-2xx response and returns it untouched', async () => {
    const response = new Response('{}', { status: 429, headers: { 'retry-after': '120' } })
    const stub = vi.fn(async () => response)
    vi.stubGlobal('fetch', stub)
    const capture = captureResponse('openai-completions')
    if (capture.fetch === undefined) throw new Error('expected a capturing fetch')

    await expect(capture.fetch('https://provider.test/v1/chat/completions', { method: 'POST' }))
      .resolves.toBe(response)
    expect(stub).toHaveBeenCalledWith('https://provider.test/v1/chat/completions', { method: 'POST' })
    expect(capture.facts()).toEqual({ status: 429, retryAfterHeader: '120' })
  })

  it('records a rejection that carries no Retry-After header', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 503 })))
    const capture = captureResponse('anthropic-messages')
    if (capture.fetch === undefined) throw new Error('expected a capturing fetch')

    await capture.fetch('https://provider.test/v1/messages')

    expect(capture.facts()).toEqual({ status: 503 })
  })

  it('clears an earlier rejection once a later request succeeds', async () => {
    const responses = [
      new Response('', { status: 429, headers: { 'retry-after': '5' } }),
      new Response('{}', { status: 200 }),
    ]
    vi.stubGlobal('fetch', vi.fn(async () => responses.shift() ?? new Response('', { status: 500 })))
    const capture = captureResponse('openai-completions')
    if (capture.fetch === undefined) throw new Error('expected a capturing fetch')

    await capture.fetch('https://provider.test/first')
    expect(capture.facts()).toEqual({ status: 429, retryAfterHeader: '5' })

    await capture.fetch('https://provider.test/second')
    expect(capture.facts()).toBeUndefined()
  })
})
