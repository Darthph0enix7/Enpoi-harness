import { afterEach, describe, expect, it, vi } from 'vitest'
import { idleWatchdog } from '@deepseek-ai/dsh-timeout'
import { captureResponse } from '../src/response-capture.ts'

afterEach(() => {
  vi.useRealTimers()
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

describe('captureResponse stream activity', () => {
  it('returns the same native Response and reports each body chunk once', async () => {
    const encoder = new TextEncoder()
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(': keepalive\n\n'))
        controller.enqueue(encoder.encode('data: {}\n\n'))
        controller.close()
      },
    }), { status: 200, headers: { 'x-test': 'body' } })
    vi.stubGlobal('fetch', vi.fn(async () => response))
    const activity = vi.fn()
    const capture = captureResponse('openai-completions', { onStreamActivity: activity })
    if (capture.fetch === undefined) throw new Error('expected a capturing fetch')

    const observed = await capture.fetch('https://provider.test/stream')

    // Native identity and fields survive: only the body accessor observes.
    expect(observed).toBe(response)
    expect(observed).toBeInstanceOf(Response)
    expect(observed.status).toBe(200)
    expect(observed.ok).toBe(true)
    expect(observed.headers.get('x-test')).toBe('body')
    expect(observed.body).toBeInstanceOf(ReadableStream)
    const bytes: number[] = []
    for await (const chunk of observed.body as ReadableStream<Uint8Array>) {
      bytes.push(...chunk)
    }
    expect(new TextDecoder().decode(new Uint8Array(bytes))).toBe(': keepalive\n\ndata: {}\n\n')
    expect(activity).toHaveBeenCalledTimes(2)
  })

  it('leaves a successful body unread for native text and json fallbacks', async () => {
    const response = new Response('{"ok":true}', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
    vi.stubGlobal('fetch', vi.fn(async () => response))
    const activity = vi.fn()
    const capture = captureResponse('openai-completions', { onStreamActivity: activity })
    if (capture.fetch === undefined) throw new Error('expected a capturing fetch')

    const observed = await capture.fetch('https://provider.test/stream')

    // Merely returning the wrapped response must not lock or disturb the body:
    // an SDK success path that reads JSON or text still works natively.
    expect(observed).toBe(response)
    expect(observed.bodyUsed).toBe(false)
    await expect(observed.json()).resolves.toEqual({ ok: true })
    expect(observed.bodyUsed).toBe(true)
    expect(activity).not.toHaveBeenCalled()
  })

  it('keeps a successful response cloneable before the SDK reads its body', async () => {
    const response = new Response('payload', { status: 200 })
    vi.stubGlobal('fetch', vi.fn(async () => response))
    const activity = vi.fn()
    const capture = captureResponse('openai-completions', { onStreamActivity: activity })
    if (capture.fetch === undefined) throw new Error('expected a capturing fetch')

    const observed = await capture.fetch('https://provider.test/stream')
    const clone = observed.clone()

    await expect(clone.text()).resolves.toBe('payload')
    await expect(observed.text()).resolves.toBe('payload')
    expect(activity).not.toHaveBeenCalled()
  })

  it('leaves a successful response with no body untouched', async () => {
    const response = new Response(null, { status: 204 })
    vi.stubGlobal('fetch', vi.fn(async () => response))
    const activity = vi.fn()
    const capture = captureResponse('openai-completions', { onStreamActivity: activity })
    if (capture.fetch === undefined) throw new Error('expected a capturing fetch')

    await expect(capture.fetch('https://provider.test/stream')).resolves.toBe(response)

    expect(response.body).toBeNull()
    expect(activity).not.toHaveBeenCalled()
  })

  it('surfaces a body read failure to the consumer', async () => {
    const failure = new Error('socket dropped')
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.error(failure) },
    }), { status: 200 })
    vi.stubGlobal('fetch', vi.fn(async () => response))
    const capture = captureResponse('openai-completions', { onStreamActivity: () => {} })
    if (capture.fetch === undefined) throw new Error('expected a capturing fetch')

    const observed = await capture.fetch('https://provider.test/stream')
    const reader = observed.body?.getReader()
    if (reader === undefined) throw new Error('expected an observed body')

    await expect(reader.read()).rejects.toBe(failure)
  })

  it('keeps every native Response accessor usable', async () => {
    const response = new Response('payload', {
      status: 201,
      statusText: 'Created',
      headers: { 'x-test': 'present' },
    })
    vi.stubGlobal('fetch', vi.fn(async () => response))
    const capture = captureResponse('openai-completions', { onStreamActivity: () => {} })
    if (capture.fetch === undefined) throw new Error('expected a capturing fetch')

    const observed = await capture.fetch('https://provider.test/stream')

    expect(observed).toBe(response)
    expect(observed.status).toBe(201)
    expect(observed.statusText).toBe('Created')
    expect(observed.ok).toBe(true)
    expect(observed.type).toBe('default')
    expect(observed.redirected).toBe(false)
    expect(observed.url).toBe('')
    expect([...observed.headers.entries()]).toContainEqual(['x-test', 'present'])
    expect(observed.bodyUsed).toBe(false)
  })

  it('cancels a pending read without an unhandled failure', async () => {
    const response = new Response(new ReadableStream<Uint8Array>({
      pull() { /* leaves the read pending until the consumer cancels */ },
    }), { status: 200 })
    vi.stubGlobal('fetch', vi.fn(async () => response))
    const capture = captureResponse('openai-completions', { onStreamActivity: () => {} })
    if (capture.fetch === undefined) throw new Error('expected a capturing fetch')

    const observed = await capture.fetch('https://provider.test/stream')
    const reader = observed.body?.getReader()
    if (reader === undefined) throw new Error('expected an observed body')
    const pending = reader.read()
    await reader.cancel('consumer stopped')

    await expect(pending).resolves.toEqual({ done: true, value: undefined })
  })

  it('does not observe or replace a non-2xx body', async () => {
    const response = new Response('{"error":"limited"}', { status: 429 })
    vi.stubGlobal('fetch', vi.fn(async () => response))
    const activity = vi.fn()
    const capture = captureResponse('openai-completions', { onStreamActivity: activity })
    if (capture.fetch === undefined) throw new Error('expected a capturing fetch')

    await expect(capture.fetch('https://provider.test/stream')).resolves.toBe(response)

    expect(activity).not.toHaveBeenCalled()
    expect(capture.facts()).toEqual({ status: 429 })
  })

  it('propagates body cancellation to the original response', async () => {
    const cancelled: unknown[] = []
    const response = new Response(new ReadableStream<Uint8Array>({
      pull() { /* stays open until the consumer cancels */ },
      cancel(reason) { cancelled.push(reason) },
    }))
    vi.stubGlobal('fetch', vi.fn(async () => response))
    const capture = captureResponse('openai-completions', { onStreamActivity: () => {} })
    if (capture.fetch === undefined) throw new Error('expected a capturing fetch')

    const observed = await capture.fetch('https://provider.test/stream')
    await observed.body?.cancel('consumer stopped')

    expect(cancelled).toEqual(['consumer stopped'])
  })

  it('does not let a torn-down attempt\'s late bytes reset the current watchdog', async () => {
    vi.useFakeTimers()
    const encoder = new TextEncoder()
    let push: ((chunk: Uint8Array) => void) | undefined
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        push = (chunk) => { controller.enqueue(chunk) }
      },
    }), { status: 200, headers: { 'content-type': 'text/event-stream' } })
    vi.stubGlobal('fetch', vi.fn(async () => response))
    const watchdog = idleWatchdog(undefined, 100, 'LLM_STREAM_IDLE_TIMEOUT')
    const owningAttempt = new AbortController()
    const activity = vi.fn(() => { watchdog.pulse() })
    const capture = captureResponse('openai-completions', {
      onStreamActivity: activity,
      activitySignal: owningAttempt.signal,
    })
    if (capture.fetch === undefined) throw new Error('expected a capturing fetch')

    const observed = await capture.fetch('https://provider.test/stream')
    const bodyReader = observed.body?.getReader()
    if (bodyReader === undefined) throw new Error('expected an observed body')

    const first = bodyReader.read()
    push?.(encoder.encode(': live keepalive\n\n'))
    await expect(first).resolves.toBeDefined()
    expect(activity).toHaveBeenCalledTimes(1)

    // The attempt is torn down; its remaining bytes arrive while the next
    // attempt's semantic read is outstanding and must not count as activity.
    const demand = Promise.withResolvers<IteratorResult<string>>()
    const next = watchdog.next({ next: () => demand.promise })
    owningAttempt.abort('attempt rotated away')
    const stale = bodyReader.read()
    push?.(encoder.encode(': stale keepalive\n\n'))
    await expect(stale).resolves.toBeDefined()
    expect(activity).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(100)
    expect(watchdog.signal.aborted).toBe(true)
    demand.reject(watchdog.signal.reason)
    await expect(next).rejects.toBe(watchdog.signal.reason)
    await bodyReader.cancel('done')
    watchdog[Symbol.dispose]()
  })

  it('keeps an outstanding semantic read alive with body bytes and clears its timer on dispose', async () => {
    vi.useFakeTimers()
    const encoder = new TextEncoder()
    let push: ((chunk: Uint8Array) => void) | undefined
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        push = (chunk) => { controller.enqueue(chunk) }
      },
    }), { status: 200, headers: { 'content-type': 'text/event-stream' } })
    vi.stubGlobal('fetch', vi.fn(async () => response))
    const watchdog = idleWatchdog(undefined, 100, 'LLM_STREAM_IDLE_TIMEOUT')
    const capture = captureResponse('openai-completions', {
      onStreamActivity: () => { watchdog.pulse() },
    })
    if (capture.fetch === undefined) throw new Error('expected a capturing fetch')

    const observed = await capture.fetch('https://provider.test/stream')
    if (observed.body === null) throw new Error('expected an observed body')
    // The SDK drains the body while the adapter's semantic demand stays
    // outstanding: no iterator value is produced by these bytes.
    const bodyReader = observed.body.getReader()
    const pump = (async () => {
      for (;;) {
        const { done } = await bodyReader.read()
        if (done) return
      }
    })()
    const demand = Promise.withResolvers<IteratorResult<string>>()
    const next = watchdog.next({ next: () => demand.promise })

    await vi.advanceTimersByTimeAsync(80)
    push?.(encoder.encode('data: {"choices":[{"delta":{"reasoning_content":""}}]}\n\n'))
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(80)
    expect(watchdog.signal.aborted).toBe(false)
    push?.(encoder.encode(': keepalive\n\n'))
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(99)
    expect(watchdog.signal.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(watchdog.signal.aborted).toBe(true)
    demand.reject(watchdog.signal.reason)
    await expect(next).rejects.toBe(watchdog.signal.reason)

    // The settled read cleared its arm: no watchdog timer remains to leak.
    expect(vi.getTimerCount()).toBe(0)
    watchdog[Symbol.dispose]()
    await bodyReader.cancel('done')
    await pump
  })
})
