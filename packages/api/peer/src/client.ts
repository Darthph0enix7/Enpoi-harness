/**
 * The calling side of the peer API: a thin HTTP/WS bridge over `peer.*`.
 *
 * `TargetUnreachable` failures are raised here (doc 69 §12.4): the caller owns
 * backoff, and `follow` reconnects with exponential backoff, repairs any
 * durable hole through `peer.page`, and re-follows. There is no cross-device
 * queue — fail-fast is the contract.
 *
 * @module @deepseek-ai/dsh-api-peer/client
 */

import { brandNumber } from '@deepseek-ai/dsh-brand'
import type { SessionSeq } from '@deepseek-ai/dsh-session/types'
import { RemoteError, remoteErrorOf, type RemoteErrorCode } from '@deepseek-ai/dsh-typert-protocol'
import type {
  PeerCreateRequest,
  PeerCreateValue,
  PeerDeviceName,
  PeerFollowFrame,
  PeerFollowRequest,
  PeerHandshakeRequest,
  PeerHandshakeValue,
  PeerListRequest,
  PeerListValue,
  PeerPageRequest,
  PeerPageValue,
  PeerPromptRequest,
  PeerPromptValue,
  PeerAnswerRequest,
  PeerAnswerValue,
  PeerCancelRequest,
  PeerCancelValue,
  PeerStateRequest,
  PeerStateValue,
  PeerTarget,
} from './types.ts'

/** Minimal WebSocket surface `follow` needs; injectable for tests and custom carriers. */
export interface PeerWebSocket {
  send(data: string): void
  close(code?: number, reason?: string): void
  addEventListener(type: 'open' | 'message' | 'error' | 'close', listener: (event: unknown) => void): void
  removeEventListener(type: 'open' | 'message' | 'error' | 'close', listener: (event: unknown) => void): void
}

/** Reconnect pacing for `follow`; exponential with a ceiling. */
export interface PeerBackoff {
  readonly initialMs: number
  readonly maxMs: number
  readonly factor: number
}

/** Caller configuration: one target host and its carrier details. */
export interface PeerClientOptions {
  /** Base URL of the target's HTTP surface, e.g. `https://serverlocal.pike-acrux.ts.net:8443`. */
  readonly endpoint: string
  /** Caller device name reported in the handshake. */
  readonly device: PeerDeviceName
  /** Extra HTTP headers (loopback launch-token cookie, or a pairing bearer token). */
  readonly headers?: Readonly<Record<string, string>>
  /** Harness version reported in the handshake. */
  readonly harnessVersion?: string
  /** Schema digest reported in the handshake; defaults to the caller's protocol digest. */
  readonly schemaDigest?: string
  /** `fetch` replacement for tests. */
  readonly fetch?: typeof fetch
  /** WebSocket factory; defaults to `globalThis.WebSocket`. */
  readonly webSocket?: (url: string) => PeerWebSocket
  /** Reconnect pacing; defaults to 250 ms doubling to 4 s. */
  readonly backoff?: PeerBackoff
  /** Maximum consecutive reconnect attempts before `peer/target-unreachable`; omitted retries forever. */
  readonly maxReconnects?: number
  /** Payload cap raised to the server; defaults to the host's own window. */
  readonly pageSize?: number
}

const DEFAULT_BACKOFF: PeerBackoff = { initialMs: 250, maxMs: 4_000, factor: 2 }
const REPAIR_PAGE_LIMIT = 20

/** One peer follow generation's terminal shape. */
interface WireFrame {
  readonly streamId: string
  readonly type: 'item' | 'error' | 'end'
  readonly value?: unknown
}

/**
 * Client bridge one device uses to drive, observe, and answer a peer's Session.
 * One instance is cheap; `follow` owns its socket per generation.
 */
export class PeerClient {
  private readonly endpoint: string
  private readonly headers: Readonly<Record<string, string>>
  private readonly fetchImpl: typeof fetch
  private readonly webSocketFactory: (url: string) => PeerWebSocket
  private readonly backoff: PeerBackoff
  private readonly maxReconnects: number | undefined
  private readonly pageSize: number

  /**
   * @param options - target endpoint, identity, and carrier replacements.
   */
  constructor(private readonly options: PeerClientOptions) {
    this.endpoint = options.endpoint.replace(/\/+$/, '')
    this.headers = options.headers ?? {}
    this.fetchImpl = options.fetch ?? globalThis.fetch
    this.webSocketFactory = options.webSocket ?? defaultWebSocket
    this.backoff = options.backoff ?? DEFAULT_BACKOFF
    this.maxReconnects = options.maxReconnects
    this.pageSize = options.pageSize ?? 50
  }

  /** Negotiate against the target; a protocol mismatch surfaces `peer/version-skew`. */
  async handshake(): Promise<PeerHandshakeValue> {
    const request: PeerHandshakeRequest = {
      protocolVersion: 1,
      harnessVersion: this.options.harnessVersion ?? '0.1.6-alpha.2',
      schemaDigest: this.options.schemaDigest ?? '',
      device: this.options.device,
    }
    return this.rpc('handshake', request)
  }

  /** Read the latch for one target. */
  state(target: PeerTarget): Promise<PeerStateValue> {
    return this.rpc('state', { target } satisfies PeerStateRequest)
  }

  /** List the pairings the host exposes, optionally narrowed to one resolved target. */
  list(request: PeerListRequest = {}): Promise<PeerListValue> {
    return this.rpc('list', request)
  }

  /** Create or adopt a Session under a pairing alias. */
  create(request: PeerCreateRequest): Promise<PeerCreateValue> {
    return this.rpc('create', request)
  }

  /** Admit a queued peer turn. */
  prompt(request: PeerPromptRequest): Promise<PeerPromptValue> {
    return this.rpc('prompt', request)
  }

  /** Cancel the target's active turn. */
  cancel(request: PeerCancelRequest): Promise<PeerCancelValue> {
    return this.rpc('cancel', request)
  }

  /** Settle a pending ask. */
  answer(request: PeerAnswerRequest): Promise<PeerAnswerValue> {
    return this.rpc('answer', request)
  }

  /** Read one backwards history window for repair. */
  page(request: PeerPageRequest): Promise<PeerPageValue> {
    return this.rpc('page', request)
  }

  /**
   * Open one follow generation without reconnect handling.
   * @param request - target and window/stream options.
   * @param signal - caller cancellation closing the socket.
   * @returns frames exactly as the host sends them.
   */
  async *followOnce(request: PeerFollowRequest, signal: AbortSignal): AsyncGenerator<PeerFollowFrame> {
    const socket = this.webSocketFactory(this.muxUrl())
    const streamId = `peer-${randomToken()}`
    const queue: WireFrame[] = []
    let wake: (() => void) | undefined
    let closed = false
    const notify = (): void => {
      wake?.()
      wake = undefined
    }
    const onMessage = (event: unknown): void => {
      const text = messageText(event)
      if (text === undefined) return
      let parsed: unknown
      try {
        parsed = JSON.parse(text)
      } catch {
        return
      }
      if (typeof parsed !== 'object' || parsed === null) return
      const frame = parsed as Record<string, unknown>
      if (frame.streamId !== streamId || typeof frame.type !== 'string') return
      queue.push(frame as unknown as WireFrame)
      notify()
    }
    const onClose = (): void => {
      closed = true
      notify()
    }
    // Read through a call: an open socket can close between a check and a read,
    // which flow analysis of the captured flag cannot express.
    const isClosed = (): boolean => closed
    const onAbort = (): void => {
      closed = true
      notify()
      socket.close()
    }
    socket.addEventListener('message', onMessage)
    socket.addEventListener('close', onClose)
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      await new Promise<void>((resolve, reject) => {
        const onOpen = (): void => {
          socket.removeEventListener('open', onOpen)
          socket.send(JSON.stringify({
            type: 'open',
            streamId,
            endpoint: 'peer/follow',
            payload: { args: { request } },
          }))
          resolve()
        }
        const onOpenError = (): void => {
          socket.removeEventListener('error', onOpenError)
          reject(unreachable(this.endpoint))
        }
        socket.addEventListener('open', onOpen)
        socket.addEventListener('error', onOpenError)
      })
      while (true) {
        const frame = queue.shift()
        if (frame === undefined) {
          if (isClosed()) return
          await new Promise<void>((resolve) => { wake = resolve })
          continue
        }
        if (frame.type === 'item') {
          yield frame.value as PeerFollowFrame
          continue
        }
        if (frame.type === 'error') {
          throw decodeFailure(frame.value, this.endpoint)
        }
        return
      }
    } finally {
      signal.removeEventListener('abort', onAbort)
      socket.removeEventListener('message', onMessage)
      socket.removeEventListener('close', onClose)
      socket.close()
      if (queue.length > 0) queue.length = 0
    }
  }

  /**
   * Stream frames with automatic reconnect and durable-hole repair.
   * @param request - target and stream options.
   * @param signal - caller cancellation; the only way to stop a healthy stream.
   * @returns follow frames across reconnects; replayed repair records precede the new snapshot.
   */
  async *follow(request: PeerFollowRequest, signal: AbortSignal): AsyncGenerator<PeerFollowFrame> {
    let lastCursor: number | undefined
    let attempt = 0
    while (!signal.aborted) {
      let progressed = false
      try {
        for await (const frame of this.followOnce(request, signal)) {
          progressed = true
          if (frame.type === 'snapshot') {
            if (lastCursor !== undefined && frame.records.length > 0) {
              const oldest = frame.records[0]?.seq
              if (oldest !== undefined && oldest > lastCursor + 1) {
                yield* this.repairForward(request.target, lastCursor, oldest, signal)
              }
            }
            lastCursor = frame.cursor
          } else if (frame.type === 'event') {
            lastCursor = Math.max(lastCursor ?? -1, frame.record.seq)
          } else if (frame.type === 'state') {
            lastCursor = Math.max(lastCursor ?? -1, frame.cursor)
          }
          yield frame
        }
      } catch (error) {
        if (isAborted(signal)) return
        if (remoteErrorOf(error)?.code === 'peer/version-skew') throw error
      }
      if (isAborted(signal)) return
      attempt = progressed ? 1 : attempt + 1
      if (this.maxReconnects !== undefined && attempt > this.maxReconnects) {
        throw unreachable(this.endpoint)
      }
      await delay(backoffDelay(this.backoff, attempt), signal)
    }
  }

  /**
   * Fill a durable hole between two cursors by paging backwards from the newer cut.
   * @param target - resolved peer target.
   * @param fromExclusive - last durable seq the caller already folded.
   * @param toExclusive - first durable seq the caller is about to receive.
   * @param signal - caller cancellation.
   * @returns the missing records in ascending seq order.
   */
  async *repairForward(
    target: PeerTarget,
    fromExclusive: number,
    toExclusive: number,
    signal: AbortSignal,
  ): AsyncGenerator<PeerFollowFrame> {
    const collected: PeerFollowFrame[] = []
    let throughSeq = brandNumber<SessionSeq>(toExclusive - 1)
    for (let page = 0; page < REPAIR_PAGE_LIMIT; page += 1) {
      if (signal.aborted || throughSeq <= fromExclusive) break
      const value = await this.page({ target, throughSeq, maxMessages: this.pageSize })
      if (value.records.length === 0) break
      for (const record of value.records) {
        if (record.seq > fromExclusive && record.seq < toExclusive) {
          collected.push({ type: 'event', record, cursor: record.seq })
        }
      }
      const oldest = value.records[0]?.seq
      if (oldest === undefined || oldest <= fromExclusive || !value.hasMore) break
      throughSeq = brandNumber<SessionSeq>(oldest - 1)
    }
    collected.sort((left, right) => {
      const a = left.type === 'event' ? left.record.seq : 0
      const b = right.type === 'event' ? right.record.seq : 0
      return a - b
    })
    for (const frame of collected) yield frame
  }

  private async rpc<T>(method: string, args: unknown): Promise<T> {
    const endpoint = `${this.endpoint}/api/peer/${method}`
    let response: Response
    try {
      response = await this.fetchImpl(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...this.headers },
        body: JSON.stringify({
          type: 'client-request',
          rpcId: `peer-${randomToken()}`,
          method: `peer/${method}`,
          // SRC-derived descriptors name the business parameter `request`, so
          // the wire args object wraps the payload under that name.
          payload: { args: { request: args } },
        }),
      })
    } catch (error) {
      throw unreachable(this.endpoint, error)
    }
    if (!response.ok) {
      throw new RemoteError('peer/target-unreachable', `peer ${method} failed over HTTP ${String(response.status)}`, {
        endpoint: this.endpoint,
      })
    }
    const body = await response.json() as {
      readonly result?: { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown }
    }
    const result = body.result
    if (result === undefined) {
      throw new RemoteError('gateway/internal', `peer ${method} returned no result envelope`, {})
    }
    if (result.ok) return result.value
    throw decodeFailure(result.error, this.endpoint)
  }

  private muxUrl(): string {
    const url = new URL(this.endpoint)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    url.pathname = '/api/remote.mux'
    url.search = ''
    return url.toString()
  }
}

/** Raise the caller-side unreachable failure with its transport cause. */
function unreachable(endpoint: string, cause?: unknown): RemoteError<'peer/target-unreachable'> {
  return new RemoteError('peer/target-unreachable', `peer target ${endpoint} is unreachable`, { endpoint }, { cause })
}

/** Restore one structured peer failure from the wire envelope. */
function decodeFailure(value: unknown, endpoint: string): RemoteError {
  if (typeof value !== 'object' || value === null) return unreachable(endpoint)
  const record = value as Record<string, unknown>
  const code = typeof record.code === 'string' ? record.code : 'gateway/internal'
  const message = typeof record.message === 'string' ? record.message : 'peer call failed'
  const details = typeof record.details === 'object' && record.details !== null
    ? record.details as Readonly<Record<string, unknown>>
    : {}
  return new RemoteError(code as RemoteErrorCode, message, details)
}

function defaultWebSocket(url: string): PeerWebSocket {
  const ctor = Reflect.get(globalThis, 'WebSocket') as (new (url: string) => PeerWebSocket) | undefined
  if (ctor === undefined) throw new Error('peer client: no global WebSocket; inject one through PeerClientOptions.webSocket')
  return new ctor(url)
}

function messageText(event: unknown): string | undefined {
  if (typeof event === 'string') return event
  if (typeof event !== 'object' || event === null) return undefined
  const data = Reflect.get(event, 'data') as unknown
  if (typeof data === 'string') return data
  if (data instanceof Uint8Array) return new TextDecoder().decode(data)
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(data))
  return undefined
}

function randomToken(): string {
  return globalThis.crypto.randomUUID()
}

function isAborted(signal: AbortSignal): boolean {
  return signal.aborted
}

function backoffDelay(backoff: PeerBackoff, attempt: number): number {
  const scaled = backoff.initialMs * backoff.factor ** Math.max(0, attempt - 1)
  return Math.min(backoff.maxMs, Math.round(scaled))
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve()
      return
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      resolve()
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}
