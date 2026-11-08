/** Unary RPC deadlines keep a half-open HTTP exchange from wedging a shared reader. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

beforeEach(() => {
  vi.resetModules()
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('unary RPC deadline', () => {
  it('times out a fetch that never settles and issues a new request for the next call', async () => {
    vi.useFakeTimers()
    const { createWebConnectionRpc } = await import('../src/client/rpc.ts')
    let calls = 0
    const send = vi.fn(async (_input: string | URL, init: RequestInit): Promise<Response> => {
      calls += 1
      if (calls === 1) return await new Promise<Response>(() => {})
      const body: unknown = init.body
      if (typeof body !== 'string') throw new TypeError('fixture expected a JSON string body')
      const request = JSON.parse(body) as { rpcId: string }
      return new Response(JSON.stringify({
        type: 'server-response',
        rpcId: request.rpcId,
        result: { ok: true, value: 7 },
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    })
    const rpc = createWebConnectionRpc(send, undefined, 25)

    const first = rpc.call('/api', 'probe/call', { args: {} }, undefined)
    const timedOut = expect(first).rejects.toThrow('connection: RPC timed out after 25ms')
    await vi.advanceTimersByTimeAsync(25)
    await timedOut

    const second = rpc.call('/api', 'probe/call', { args: {} }, undefined)
    await vi.advanceTimersByTimeAsync(0)
    await expect(second).resolves.toEqual({ ok: true, value: 7 })
    expect(send).toHaveBeenCalledTimes(2)
  })

  it('clears the shared settings describe in-flight read after its deadline', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn(() => new Promise<Response>(() => {}))
    vi.stubGlobal('fetch', fetchMock)
    const { createWebConnectionRpc } = await import('../src/client/rpc.ts')
    const rpc = createWebConnectionRpc(undefined, undefined, 20)

    const first = rpc.call('/api', 'settings.describe', { args: {} })
    // The shared reader debounces the burst (25 ms) and then its HTTP exchange
    // has the 20 ms deadline; the timeout path resolves callers and clears the
    // in-flight promise instead of wedging every later settings read.
    await vi.advanceTimersByTimeAsync(45)
    await expect(first).resolves.toMatchObject({
      ok: false,
      error: { code: 'gateway/internal' },
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)

    const second = rpc.call('/api', 'settings.describe', { args: {} })
    await vi.advanceTimersByTimeAsync(45)
    await expect(second).resolves.toMatchObject({
      ok: false,
      error: { code: 'gateway/internal' },
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('times out when response headers arrive but the response body stalls', async () => {
    vi.useFakeTimers()
    const { createWebConnectionRpc } = await import('../src/client/rpc.ts')
    let calls = 0
    const hangingBody = new ReadableStream<Uint8Array>({
      start() {
        // Body never enqueues or closes
      },
    })
    const send = vi.fn(async (_input: string | URL, init: RequestInit): Promise<Response> => {
      calls += 1
      if (calls === 1) {
        return new Response(hangingBody, {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      const request = JSON.parse(init.body as string) as { rpcId: string }
      return new Response(JSON.stringify({
        type: 'server-response',
        rpcId: request.rpcId,
        result: { ok: true, value: 42 },
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })

    const rpc = createWebConnectionRpc(send, undefined, 30)
    const first = rpc.call('/api', 'probe/call', { args: {} }, undefined)
    const timedOut = expect(first).rejects.toThrow('connection: RPC timed out after 30ms')
    await vi.advanceTimersByTimeAsync(30)
    await timedOut

    const second = rpc.call('/api', 'probe/call', { args: {} }, undefined)
    await vi.advanceTimersByTimeAsync(0)
    await expect(second).resolves.toEqual({ ok: true, value: 42 })
    expect(send).toHaveBeenCalledTimes(2)
  })

  it('preserves native branded receiver when reading response properties', async () => {
    const { createWebConnectionRpc } = await import('../src/client/rpc.ts')
    let brandChecked = false
    const send = vi.fn(async (_input: string | URL, init: RequestInit): Promise<Response> => {
      const request = JSON.parse(init.body as string) as { rpcId: string }
      const raw = new Response(JSON.stringify({
        type: 'server-response',
        rpcId: request.rpcId,
        result: { ok: true, value: 'test' },
      }), { status: 200, headers: { 'content-type': 'application/json' } })

      Object.defineProperty(raw, 'headers', {
        get() {
          if (this !== raw) throw new TypeError('Illegal invocation')
          brandChecked = true
          return new Headers({ 'content-type': 'application/json' })
        },
      })
      Object.defineProperty(raw, 'status', {
        get() {
          if (this !== raw) throw new TypeError('Illegal invocation')
          return 200
        },
      })
      return raw
    })

    const rpc = createWebConnectionRpc(send, undefined, 1000)
    const res = await rpc.call('/api', 'probe/call', { args: {} })
    expect(res).toEqual({ ok: true, value: 'test' })
    expect(brandChecked).toBe(true)
  })
})
