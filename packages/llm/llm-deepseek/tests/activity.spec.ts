/** Direct Transport-byte activity wiring to the public attempt signal. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { onAttemptActivity, reportAttemptActivity } from '@deepseek-ai/dsh-llm'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { adapter, options, server, sse, textEvents } from './helpers.ts'

const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => {
  vi.useRealTimers()
  while (cleanup.length > 0) await cleanup.pop()!()
})
async function endpoint(...args: Parameters<typeof server>) {
  const instance = await server(...args)
  cleanup.push(() => instance.close())
  return instance
}

describe('direct Messages attempt activity', () => {
  it('reports SSE keepalive bytes before any semantic chunk', async () => {
    const release = Promise.withResolvers<undefined>()
    const http = await endpoint((response) => {
      response.write(': keepalive\n\n')
      void release.promise.then(() => { response.end(sse(textEvents)) })
    })
    const controller = new AbortController()
    const pulse = Promise.withResolvers<undefined>()
    let pulses = 0
    const dispose = onAttemptActivity(controller.signal, () => { pulses += 1; pulse.resolve(undefined) })
    const stream = adapter({ baseURL: http.url, streamIdleTimeoutMs: 1_000 })
      .stream(options({ signal: controller.signal }))[Symbol.asyncIterator]()
    try {
      const first = stream.next()
      await pulse.promise
      expect(pulses).toBeGreaterThan(0)
      // The server has sent only the comment so far, so no semantic chunk can
      // have settled the first read.
      await expect(Promise.race([first.then(() => 'chunk' as const), Promise.resolve('pending' as const)]))
        .resolves.toBe('pending')
      release.resolve(undefined)
      const firstResult = await first
      if (firstResult.done === true) throw new Error('expected a semantic chunk')
      const output: StreamChunk[] = [firstResult.value]
      while (true) {
        const next = await stream.next()
        if (next.done === true) break
        output.push(next.value)
      }
      expect(output.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
    } finally {
      dispose()
      await stream.return?.()
    }
  })

  it('times out after genuine silence following a keepalive and closes the reader', async () => {
    const closed = Promise.withResolvers<undefined>()
    const http = await endpoint((response) => {
      response.once('close', () => { closed.resolve(undefined) })
      response.write(': keepalive\n\n')
    })
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const controller = new AbortController()
    const pulse = Promise.withResolvers<undefined>()
    let pulses = 0
    const dispose = onAttemptActivity(controller.signal, () => { pulses += 1; pulse.resolve(undefined) })
    const stream = adapter({ baseURL: http.url, streamIdleTimeoutMs: 30 })
      .stream(options({ signal: controller.signal }))[Symbol.asyncIterator]()
    try {
      const next = stream.next()
      await pulse.promise
      expect(pulses).toBeGreaterThan(0)
      const rejected = expect(next).rejects.toMatchObject({ code: 'TIMEOUT' })
      await vi.advanceTimersByTimeAsync(30)
      await rejected
      await closed.promise
    } finally {
      dispose()
      vi.useRealTimers()
      await stream.return?.()
    }
  })

  it('stops reporting a stale attempt after caller abort and closes the reader', async () => {
    const closed = Promise.withResolvers<undefined>()
    const http = await endpoint((response) => {
      response.once('close', () => { closed.resolve(undefined) })
      response.write(': keepalive\n\n')
    })
    const controller = new AbortController()
    const pulse = Promise.withResolvers<undefined>()
    let pulses = 0
    const dispose = onAttemptActivity(controller.signal, () => { pulses += 1; pulse.resolve(undefined) })
    const stream = adapter({ baseURL: http.url, streamIdleTimeoutMs: 1_000 })
      .stream(options({ signal: controller.signal }))[Symbol.asyncIterator]()
    try {
      const pending = stream.next()
      await pulse.promise
      controller.abort(new Error('user cancelled'))
      await expect(pending).rejects.toMatchObject({ code: 'ABORTED' })
      await closed.promise
      const settled = pulses
      reportAttemptActivity(controller.signal)
      expect(pulses).toBe(settled)
    } finally {
      dispose()
      await stream.return?.()
    }
  })
})
