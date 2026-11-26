import { describe, expect, it } from 'vitest'
import { BoundedFollow, FollowAdmission, followDefaults } from '../src/follow.ts'
import type { PeerFollowAck, PeerFollowFrame } from '../src/types.ts'

describe('peer follow limits', () => {
  it('stops pulling at the byte limit, even with multibyte payloads and no reads', async () => {
    const stopped = Promise.withResolvers<undefined>()
    let produced = 0
    async function* source(): AsyncGenerator<PeerFollowFrame> {
      await Promise.resolve()
      for (;;) {
        produced += 1
        yield { type: 'assistant-stream', frame: '雪'.repeat(100) }
      }
    }
    const config = { ...followDefaults, followQueueMaxBytes: 700 }
    const frames = new BoundedFollow(config, new AbortController().signal, source, undefined, () => { stopped.resolve(undefined) }).read()
    expect((await frames.next()).value).toMatchObject({ type: 'assistant-stream' })
    await stopped.promise
    expect(produced).toBe(3)
    expect((await frames.next()).value).toMatchObject({ type: 'gap', reason: 'queue-overflow', fromSeq: null, toSeq: null })
    await expect(frames.next()).rejects.toMatchObject({ code: 'peer/gap' })
  })

  it('terminates a carrier generation that never acknowledges one received frame', async () => {
    const never = new Promise<IteratorResult<PeerFollowAck>>(() => { /* client never acknowledges */ })
    const released = Promise.withResolvers<undefined>()
    const config = { ...followDefaults, followIdleMs: 25, followOpenMs: 100 }
    const frames = new BoundedFollow(config, new AbortController().signal, async function* (signal) {
      await Promise.resolve()
      yield { type: 'assistant-stream', frame: 'one' }
      await new Promise<void>((resolve) => { signal.addEventListener('abort', () => { resolve() }, { once: true }) })
    }, { next: () => never }, () => { released.resolve(undefined) }).read()
    expect((await frames.next()).value).toMatchObject({ type: 'assistant-stream' })
    expect((await frames.next()).value).toMatchObject({ type: 'gap', reason: 'idle-timeout' })
    await expect(frames.next()).rejects.toMatchObject({ code: 'peer/gap' })
    await released.promise
  })

  it('enforces host capacity and charges rate across normal reconnects', () => {
    const admission = new FollowAdmission({ ...followDefaults, followMaxPerHost: 1, followOpensPerWindow: 2 })
    const first = admission.admit('one' as never)
    const refusal = { code: 'peer/unavailable', details: { reason: 'follow-capacity' } }
    expect(() => admission.admit('two' as never)).toThrow(expect.objectContaining(refusal))
    first()
    admission.admit('one' as never)()
    expect(() => admission.admit('one' as never)).toThrow(expect.objectContaining(refusal))
    admission.admit('two' as never)()
  })

  it('times out opening and keeps the reservation until the upstream actually exits', async () => {
    const unblock = Promise.withResolvers<undefined>()
    let released = false
    const frames = new BoundedFollow({ ...followDefaults, followOpenMs: 25 }, new AbortController().signal, async function* () {
      await unblock.promise
      yield { type: 'assistant-stream', frame: 'late' }
    }, undefined, () => { released = true }).read()
    expect((await frames.next()).value).toMatchObject({ type: 'gap', reason: 'open-timeout' })
    await expect(frames.next()).rejects.toMatchObject({ code: 'peer/gap' })
    expect(released).toBe(false)
    unblock.resolve(undefined)
    await new Promise(resolve => setImmediate(resolve))
    expect(released).toBe(true)
  })

  it('expires the generation even when its idle budget is longer', async () => {
    const frames = new BoundedFollow({ ...followDefaults, followLifetimeMs: 30, followIdleMs: 500 },
      new AbortController().signal, async function* (signal) {
        await Promise.resolve()
        yield { type: 'assistant-stream', frame: 'one' }
        if (!signal.aborted) {
          await new Promise<void>((resolve) => { signal.addEventListener('abort', () => { resolve() }, { once: true }) })
        }
      }, undefined, () => { /* reservation released */ }).read()
    expect((await frames.next()).value).toMatchObject({ type: 'assistant-stream' })
    expect((await frames.next()).value).toMatchObject({ type: 'gap', reason: 'lifetime-limit' })
    await expect(frames.next()).rejects.toMatchObject({ code: 'peer/gap' })
  })
})
