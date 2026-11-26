/** Admission, bounded buffering, and lifecycle for one peer follow generation. */
import { brandNumber } from '@deepseek-ai/dsh-brand'
import type { SessionSeq } from '@deepseek-ai/dsh-session/types'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { PeerAlias, PeerFollowAck, PeerFollowFrame, PeerFollowGapFrame } from './types.ts'

/** Default host follow policy, shared by the schema and direct construction. */
export const followDefaults = {
  followQueueMaxItems: 16_384,
  followQueueMaxBytes: 8_388_608,
  followOpenMs: 10_000,
  followIdleMs: 30_000,
  followLifetimeMs: 900_000,
  followMaxPerAlias: 2,
  followMaxPerHost: 16,
  followOpensPerWindow: 12,
  followOpenWindowMs: 30_000,
}

/** Effective follow limits configured by the peer host. */
export type FollowLimits = Readonly<typeof followDefaults>

/** One host-wide admission table, shared by direct and carrier invocations. */
export class FollowAdmission {
  private total = 0
  private readonly active = new Map<PeerAlias, number>()
  private readonly opens = new Map<PeerAlias, number[]>()

  /** @param config - effective concurrency and open-rate limits. */
  constructor(private readonly config: FollowLimits) {}

  /**
   * Reserve one follow slot for an alias, or refuse when a host or alias cap is reached.
   * @param alias - authenticated alias.
   * @returns disposer releasing the active reservation; the rate charge stays.
   */
  admit(alias: PeerAlias): () => void {
    const count = this.active.get(alias) ?? 0
    if (this.total >= this.config.followMaxPerHost || count >= this.config.followMaxPerAlias) throw atCapacity()
    const now = performance.now()
    const cutoff = now - this.config.followOpenWindowMs
    for (const [key, times] of this.opens) {
      if ((times.at(-1) ?? -Infinity) <= cutoff) this.opens.delete(key)
    }
    const recent = (this.opens.get(alias) ?? []).filter(time => time > cutoff)
    if (recent.length >= this.config.followOpensPerWindow) throw atCapacity()
    recent.push(now)
    this.opens.set(alias, recent)
    this.active.set(alias, count + 1)
    this.total += 1
    return () => {
      const remaining = (this.active.get(alias) ?? 1) - 1
      if (remaining === 0) this.active.delete(alias)
      else this.active.set(alias, remaining)
      this.total -= 1
    }
  }
}

function atCapacity(): RemoteError<'peer/unavailable'> {
  return new RemoteError('peer/unavailable', 'follow concurrency or open rate exceeded; back off', { reason: 'follow-capacity' })
}

/**
 * Create the terminal failure paired with a gap item, never a normal stream end.
 * @param gap - cause and range of the loss.
 * @returns a resynchronization error for the logical stream.
 */
export function followGapError(gap: PeerFollowGapFrame): RemoteError<'peer/gap'> {
  return new RemoteError('peer/gap', 'follow lost continuity; re-follow and repair with peer.page', { gap })
}

/**
 * Read the durable session position a downlink frame carries.
 * @param frame - downlink frame.
 * @returns the frame's cursor, or undefined for frames without one.
 */
export function followCursor(frame: PeerFollowFrame): SessionSeq | undefined {
  if (frame.type === 'event' || frame.type === 'state' || frame.type === 'snapshot') return frame.cursor
  return undefined
}

type Queued = { readonly frame: PeerFollowFrame; readonly bytes: number }

/** A producer can run ahead of precisely one consumer within item and byte limits. */
export class BoundedFollow {
  private readonly control = new AbortController()
  private readonly queue = new Map<number, Queued>()
  private bytes = 0
  private first = 1
  private next = 1
  private consumed: SessionSeq | undefined
  private produced: SessionSeq | undefined
  private gap: PeerFollowGapFrame | undefined
  private failure: { readonly error: unknown } | undefined
  private finished = false
  private opened = false
  private wake: (() => void) | undefined
  private openTimer: NodeJS.Timeout | undefined
  private idleTimer: NodeJS.Timeout | undefined
  private lifetimeTimer: NodeJS.Timeout | undefined
  private released = false

  /**
   * @param config - effective queue and timer limits.
   * @param signal - parent cancellation.
   * @param source - opens the bounded generation's producer.
   * @param ack - Remote uplink; a direct iterator pull implicitly acknowledges the prior frame.
   * @param release - releases admission once the producer cleans up.
   */
  constructor(
    private readonly config: FollowLimits,
    private readonly signal: AbortSignal,
    private readonly source: (signal: AbortSignal) => AsyncIterable<PeerFollowFrame>,
    private readonly ack: AsyncIterator<PeerFollowAck> | undefined,
    private readonly release: () => void,
  ) {}

  /**
   * Stream frames to the single consumer and release the reservation at the end.
   * @returns the consumer's frames, or a failure after a gap.
   */
  async *read(): AsyncGenerator<PeerFollowFrame> {
    if (this.signal.aborted) {
      this.release()
      this.signal.throwIfAborted()
    }
    const onAbort = (): void => { this.stop() }
    const cancelled = (): boolean => this.signal.aborted
    const stopped = (): boolean => this.control.signal.aborted
    this.signal.addEventListener('abort', onAbort, { once: true })
    this.openTimer = setTimeout(() => { this.lose('open-timeout') }, this.config.followOpenMs).unref()
    this.lifetimeTimer = setTimeout(() => { this.lose('lifetime-limit') }, this.config.followLifetimeMs).unref()
    void this.pump()
    try {
      while (!cancelled()) {
        if (this.gap !== undefined) {
          const gap = this.gap
          yield gap
          throw followGapError(gap)
        }
        if (this.failure !== undefined) throw this.failure.error
        const entry = this.queue.get(this.first)
        if (entry !== undefined) {
          yield entry.frame
          if (entry.frame.type === 'end') return
          if (this.ack !== undefined && !stopped()) {
            try {
              const result = await untilAborted(this.ack.next(), this.control.signal)
              if (result.done === true || !isAck(result.value, this.first)) {
                throw new RemoteError('gateway/bad-request', 'follow requires an in-order acknowledgement for each frame', {})
              }
            } catch (error) {
              if (!stopped()) throw error
            }
          }
          if (stopped()) continue
          this.queue.delete(this.first++)
          this.bytes -= entry.bytes
          this.consumed = followCursor(entry.frame) ?? this.consumed
          this.armIdle()
          continue
        }
        if (this.finished) return
        await new Promise<void>((resolve) => { this.wake = resolve })
      }
    } finally {
      this.signal.removeEventListener('abort', onAbort)
      this.stop()
    }
  }

  private async pump(): Promise<void> {
    try {
      for await (const frame of this.source(this.control.signal)) {
        if (this.control.signal.aborted) return
        if (frame.type === 'gap') {
          this.lose(frame.reason, frame.toSeq ?? undefined, frame.fromSeq ?? undefined)
          return
        }
        this.produced = followCursor(frame) ?? this.produced
        const bytes = Buffer.byteLength(JSON.stringify(frame))
        if (this.queue.size >= this.config.followQueueMaxItems || this.bytes + bytes > this.config.followQueueMaxBytes) {
          this.lose('queue-overflow')
          return
        }
        if (!this.opened) {
          this.opened = true
          clearTimeout(this.openTimer)
          this.armIdle()
        }
        this.queue.set(this.next++, { frame, bytes })
        this.bytes += bytes
        this.notify()
      }
    } catch (error) {
      if (!this.control.signal.aborted) this.failure = { error }
    } finally {
      this.finished = true
      if (this.control.signal.aborted) this.releaseOnce()
      this.notify()
    }
  }

  private armIdle(): void {
    clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => { this.lose('idle-timeout') }, this.config.followIdleMs).unref()
  }

  private lose(reason: PeerFollowGapFrame['reason'], to = this.produced, from?: SessionSeq): void {
    if (this.control.signal.aborted) return
    const firstLost = this.queue.values().next().value?.frame
    const cursor = firstLost === undefined ? undefined : followCursor(firstLost)
    this.gap = {
      type: 'gap', reason, resync: 'refollow-and-page',
      fromSeq: this.consumed === undefined ? null : cursor === undefined
        ? from ?? brandNumber<SessionSeq>(this.consumed + 1) : brandNumber<SessionSeq>(Math.min(cursor, this.consumed + 1)),
      toSeq: to !== undefined && to > (this.consumed ?? -1) ? to : null,
    }
    this.stop()
  }

  private notify(): void {
    const wake = this.wake
    this.wake = undefined
    wake?.()
  }

  private stop(): void {
    this.control.abort()
    clearTimeout(this.openTimer)
    clearTimeout(this.idleTimer)
    clearTimeout(this.lifetimeTimer)
    this.queue.clear()
    this.bytes = 0
    if (this.finished) this.releaseOnce()
    this.notify()
  }

  private releaseOnce(): void {
    if (this.released) return
    this.released = true
    this.release()
  }
}

function isAck(value: unknown, expected: number): boolean {
  return typeof value === 'object' && value !== null && 'type' in value && value.type === 'ack'
    && 'frame' in value && value.frame === expected
}

/**
 * Bound a read even if its provider ignores cancellation.
 * @param operation - read that receives cancellation independently.
 * @param signal - deadline/parent cancellation.
 * @returns the read result when it wins.
 */
export async function untilAborted<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  const stopped = Promise.withResolvers<never>()
  const abort = (): void => { stopped.reject(signal.reason) }
  signal.addEventListener('abort', abort, { once: true })
  if (signal.aborted) abort()
  try {
    return await Promise.race([operation, stopped.promise])
  } finally {
    signal.removeEventListener('abort', abort)
  }
}
