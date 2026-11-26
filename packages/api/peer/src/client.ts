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
import { HARNESS_VERSION } from './version.ts'
import { PEER_SCHEMA_DIGEST, WIRE_PROTOCOL_VERSION } from './wire-schema.ts'
import { followCursor, followDefaults, followGapError } from './follow.ts'
import type {
  PeerCreateRequest,
  PeerCreateValue,
  PeerDeviceName,
  PeerExportFetchRequest,
  PeerExportFetchValue,
  PeerExportListRequest,
  PeerExportListValue,
  PeerFollowFrame,
  PeerFollowGapFrame,
  PeerFollowRequest,
  PeerHandshakeRequest,
  PeerHandshakeValue,
  PeerJobUpdateRequest,
  PeerJobUpdateValue,
  PeerListRequest,
  PeerListValue,
  PeerModelsRequest,
  PeerModelsValue,
  PeerPageRequest,
  PeerPageValue,
  PeerPromptRequest,
  PeerPromptValue,
  PeerReadyRequest,
  PeerReadyValue,
  PeerReceiptRequest,
  PeerReceiptValue,
  PeerAnswerRequest,
  PeerAnswerValue,
  PeerAsksRequest,
  PeerAsksValue,
  PeerCancelRequest,
  PeerCancelValue,
  PeerSelectModelRequest,
  PeerSelectModelValue,
  PeerStateRequest,
  PeerStateValue,
  PeerTarget,
  PeerWaitQuiescentRequest,
  PeerWaitQuiescentValue,
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
  /** Optional outbound pairing bearer token sent as `Authorization: Bearer <outboundToken>`. */
  readonly outboundToken?: string
  /** Alias for `outboundToken` kept for callers passing `token`. */
  readonly token?: string
  /** Extra HTTP headers (loopback launch-token cookie, or a pairing bearer token). */
  readonly headers?: Readonly<Record<string, string>>
  /** Harness version reported in the handshake; defaults to the running package manifest version. */
  readonly harnessVersion?: string
  /** Schema digest reported in the handshake; defaults to the caller's protocol digest. */
  readonly schemaDigest?: string
  /** `fetch` replacement for tests. */
  readonly fetch?: typeof fetch
  /** WebSocket factory; defaults to `globalThis.WebSocket`. Receives outbound headers as an optional second argument. */
  readonly webSocket?: (url: string, headers?: Readonly<Record<string, string>>) => PeerWebSocket
  /** Reconnect pacing; defaults to 250 ms doubling to 4 s. */
  readonly backoff?: PeerBackoff
  /** Maximum consecutive reconnect attempts before `peer/target-unreachable`; omitted retries forever. */
  readonly maxReconnects?: number
  /** Payload cap raised to the server; defaults to the host's own window. */
  readonly pageSize?: number
  /** Local socket and opening-frame deadline; default 10 s. */
  readonly followOpenMs?: number
  /** Local silence/consumption deadline; default 30 s. */
  readonly followIdleMs?: number
  /** Local socket lifetime; default 15 minutes. */
  readonly followLifetimeMs?: number
  /** Local queued wire envelope item cap; default 16,384. */
  readonly followQueueMaxItems?: number
  /** Local queued wire envelope byte cap; default 8 MiB. */
  readonly followQueueMaxBytes?: number
}

const DEFAULT_BACKOFF: PeerBackoff = { initialMs: 250, maxMs: 4_000, factor: 2 }
const REPAIR_PAGE_LIMIT = 20

/** One peer follow generation's terminal shape. */
type WireFrame = { readonly type: 'item' | 'error' | 'end'; readonly value: unknown; readonly bytes: number }

/**
 * Client bridge one device uses to drive, observe, and answer a peer's Session.
 * One instance is cheap; `follow` owns its socket per generation.
 */
export class PeerClient {
  private readonly endpoint: string
  private readonly headers: Readonly<Record<string, string>>
  private readonly fetchImpl: typeof fetch
  private readonly webSocketFactory: (url: string, headers?: Readonly<Record<string, string>>) => PeerWebSocket
  private readonly backoff: PeerBackoff
  private readonly maxReconnects: number | undefined
  private readonly pageSize: number

  /**
   * @param options - target endpoint, identity, and carrier replacements.
   */
  constructor(private readonly options: PeerClientOptions) {
    this.endpoint = options.endpoint.replace(/\/+$/, '')
    const baseHeaders = options.headers ?? {}
    const hasAuthorization = baseHeaders.authorization !== undefined || baseHeaders.Authorization !== undefined
    const bearer = options.outboundToken ?? options.token
    this.headers = bearer !== undefined && bearer.length > 0 && !hasAuthorization
      ? { ...baseHeaders, authorization: `Bearer ${bearer}` }
      : baseHeaders
    this.fetchImpl = options.fetch ?? globalThis.fetch
    this.webSocketFactory = options.webSocket ?? defaultWebSocket
    this.backoff = options.backoff ?? DEFAULT_BACKOFF
    this.maxReconnects = options.maxReconnects
    this.pageSize = options.pageSize ?? 50
  }

  /** Negotiate against the target; a protocol mismatch surfaces `peer/version-skew`. */
  async handshake(): Promise<PeerHandshakeValue> {
    const request: PeerHandshakeRequest = {
      protocolVersion: WIRE_PROTOCOL_VERSION,
      harnessVersion: this.options.harnessVersion ?? HARNESS_VERSION,
      schemaDigest: this.options.schemaDigest ?? PEER_SCHEMA_DIGEST,
      device: this.options.device,
    }
    return this.rpc('handshake', request)
  }

  /** Read the latch for one target. */
  state(target: PeerTarget): Promise<PeerStateValue> {
    return this.rpc('state', { target } satisfies PeerStateRequest)
  }

  /**
   * List retained ask records for one alias.
   * @param request - authenticated alias and optional Session id.
   * @returns retained ask records.
   */
  asks(request: PeerAsksRequest): Promise<PeerAsksValue> {
    return this.rpc('asks', request)
  }

  /**
   * Poll one session until it looks quiescent or the budget ends.
   * @param request - authenticated alias and polling budget.
   * @returns an observation, not termination proof.
   */
  waitQuiescent(request: PeerWaitQuiescentRequest): Promise<PeerWaitQuiescentValue> {
    return this.rpc('waitQuiescent', request)
  }

  /** List the pairings the host exposes, optionally narrowed to one resolved target. */
  list(request: PeerListRequest = {}): Promise<PeerListValue> {
    return this.rpc('list', request)
  }

  /**
   * Read the policy-filtered chains and models one alias may select.
   * @param request - alias, participant, optional filter, cursor, and page limit.
   * @returns selectable chains/models with the policy echoed for the controller.
   */
  models(request: PeerModelsRequest): Promise<PeerModelsValue> {
    return this.rpc('models', request)
  }

  /** Create or adopt a Session under a pairing alias. */
  create(request: PeerCreateRequest): Promise<PeerCreateValue> {
    return this.rpc('create', request)
  }

  /** Admit a queued peer turn. */
  prompt(request: PeerPromptRequest): Promise<PeerPromptValue> {
    return this.rpc('prompt', request)
  }

  /**
   * Look up a persisted create or prompt receipt and its host-derived disposition.
   * @param request - pairing alias, caller request id, and optional kind filter.
   * @returns receipt metadata, restart indicator, and derived disposition.
   */
  receipt(request: PeerReceiptRequest): Promise<PeerReceiptValue> {
    return this.rpc('receipt', request)
  }

  /**
   * Update a bound worker job's fence, expiration timestamp, or revocation state.
   * @param request - pairing alias, request id, job id, and requested updates.
   * @returns updated binding record and payload-bound receipt metadata.
   */
  jobUpdate(request: PeerJobUpdateRequest): Promise<PeerJobUpdateValue> {
    return this.rpc('jobUpdate', request)
  }

  /**
   * Probe authenticated host and pairing readiness before dispatching work.
   * @param request - pairing alias to check.
   * @returns readiness status, missing capability list, capabilities, optional profile, and runtime identity.
   */
  ready(request: PeerReadyRequest): Promise<PeerReadyValue> {
    return this.rpc('ready', request)
  }

  /**
   * List regular files inside the bound worker session's export root.
   * @param request - pairing alias owning the worker session.
   * @returns bounded relative regular file list and truncation indicator.
   */
  exportList(request: PeerExportListRequest): Promise<PeerExportListValue> {
    return this.rpc('exportList', request)
  }

  /**
   * Fetch one bounded regular file from the bound worker session's export root.
   * @param request - pairing alias, relative path, and optional byte cap.
   * @returns relative path, byte length, SHA-256 over returned bytes, and base64 payload.
   */
  exportFetch(request: PeerExportFetchRequest): Promise<PeerExportFetchValue> {
    return this.rpc('exportFetch', request)
  }

  /**
   * Request a stop and optionally discard the pairing's pending prompts.
   * @param request - target, participant, and optional queue removal intent.
   * @returns stop acknowledgement and the number of queued prompts actually removed.
   */
  cancel(request: PeerCancelRequest): Promise<PeerCancelValue> {
    return this.rpc('cancel', request)
  }

  /** Settle a pending ask. */
  answer(request: PeerAnswerRequest): Promise<PeerAnswerValue> {
    return this.rpc('answer', request)
  }

  /**
   * Switch one idle Session's routing for its next turn.
   * @param request - alias, participant, request id, target route or chain, and optional effort.
   * @returns the applied selection, any previous one, and whether this was a replay.
   */
  selectModel(request: PeerSelectModelRequest): Promise<PeerSelectModelValue> {
    return this.rpc('selectModel', request)
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
    if (signal.aborted) return
    const socket = this.webSocketFactory(this.muxUrl(), this.headers)
    const streamId = `peer-${randomToken()}`
    const queue: WireFrame[] = []
    let wake: (() => void) | undefined
    let closed = false
    let socketOpen = false
    const isClosed = (): boolean => closed
    const didOpenSocket = (): boolean => socketOpen
    let opened = false
    let frameNumber = 0
    let bytes = 0
    let cursor: SessionSeq | undefined
    let gap: PeerFollowGapFrame | undefined
    let idle: ReturnType<typeof setTimeout> | undefined
    const notify = (): void => {
      wake?.()
      wake = undefined
    }
    const close = (): void => {
      if (closed) return
      closed = true
      notify()
      socket.close()
    }
    const lose = (reason: PeerFollowGapFrame['reason']): void => {
      if (closed) return
      gap = { type: 'gap', fromSeq: cursor === undefined ? null : brandNumber<SessionSeq>(cursor + 1), toSeq: null,
        reason, resync: 'refollow-and-page' }
      queue.length = 0
      close()
    }
    const armIdle = (): void => {
      clearTimeout(idle)
      idle = setTimeout(() => { lose('idle-timeout') }, this.options.followIdleMs ?? followDefaults.followIdleMs)
    }
    const open = setTimeout(() => { lose('open-timeout') }, this.options.followOpenMs ?? followDefaults.followOpenMs)
    const lifetime = setTimeout(() => { lose('lifetime-limit') }, this.options.followLifetimeMs ?? followDefaults.followLifetimeMs)
    const onMessage = (event: unknown): void => {
      if (closed) return
      const text = messageText(event)
      if (text === undefined) return
      const size = new TextEncoder().encode(text).byteLength
      if (size + bytes > (this.options.followQueueMaxBytes ?? followDefaults.followQueueMaxBytes)
        || queue.length >= (this.options.followQueueMaxItems ?? followDefaults.followQueueMaxItems)) {
        lose('queue-overflow')
        return
      }
      let parsed: unknown
      try {
        parsed = JSON.parse(text)
      } catch {
        return
      }
      if (typeof parsed !== 'object' || parsed === null) return
      const frame = parsed as Record<string, unknown>
      if (frame.streamId !== streamId || (frame.type !== 'item' && frame.type !== 'error' && frame.type !== 'end')) return
      queue.push({ type: frame.type, value: frame.type === 'error' ? frame.error ?? frame.value : frame.value, bytes: size })
      bytes += size
      notify()
    }
    const onClose = (): void => {
      closed = true
      notify()
    }
    const onOpen = (): void => {
      if (closed) return
      socketOpen = true
      try {
        socket.send(JSON.stringify({ type: 'open', streamId, endpoint: 'peer/follow', payload: { args: { request } } }))
      } catch (error) {
        void error
        close()
      }
    }
    const onError = (): void => { close() }
    socket.addEventListener('message', onMessage)
    socket.addEventListener('close', onClose)
    socket.addEventListener('open', onOpen)
    socket.addEventListener('error', onError)
    signal.addEventListener('abort', close, { once: true })
    try {
      while (!signal.aborted) {
        const lost = gap
        if (lost !== undefined) {
          yield lost
          throw followGapError(lost)
        }
        const frame = queue.shift()
        if (frame === undefined) {
          if (isClosed()) {
            if (!didOpenSocket()) throw unreachable(this.endpoint)
            const lost: PeerFollowGapFrame = { type: 'gap', reason: 'upstream-closed', resync: 'refollow-and-page',
              fromSeq: cursor === undefined ? null : brandNumber<SessionSeq>(cursor + 1), toSeq: null }
            yield lost
            throw followGapError(lost)
          }
          await new Promise<void>((resolve) => { wake = resolve })
          continue
        }
        bytes -= frame.bytes
        if (frame.type === 'item') {
          if (typeof frame.value !== 'object' || frame.value === null || !('type' in frame.value)) throw unreachable(this.endpoint)
          const value = frame.value as PeerFollowFrame
          if (value.type === 'gap') {
            yield value
            throw followGapError(value)
          }
          if (value.type === 'end') {
            yield value
            return
          }
          if (!opened) {
            opened = true
            clearTimeout(open)
            armIdle()
          }
          cursor = followCursor(value) ?? cursor
          yield value
          if (!isClosed() && !isAborted(signal)) {
            socket.send(JSON.stringify({ type: 'item', streamId, value: { type: 'ack', frame: ++frameNumber } }))
            armIdle()
          }
          continue
        }
        if (frame.type === 'error') {
          throw decodeFailure(frame.value, this.endpoint)
        }
        const missing: PeerFollowGapFrame = { type: 'gap', fromSeq: cursor === undefined ? null : brandNumber<SessionSeq>(cursor + 1),
          toSeq: null, reason: 'upstream-closed', resync: 'refollow-and-page' }
        yield missing
        throw followGapError(missing)
      }
    } finally {
      clearTimeout(open)
      clearTimeout(idle)
      clearTimeout(lifetime)
      signal.removeEventListener('abort', close)
      socket.removeEventListener('message', onMessage)
      socket.removeEventListener('close', onClose)
      socket.removeEventListener('open', onOpen)
      socket.removeEventListener('error', onError)
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
      let reportedGap = false
      try {
        for await (const frame of this.followOnce(request, signal)) {
          if (frame.type === 'snapshot') {
            const oldest = frame.records[0]?.seq ?? frame.cursor + 1
            if (lastCursor !== undefined && oldest > lastCursor + 1) {
              yield* this.repairForward(request.target, lastCursor, oldest, signal)
            }
            lastCursor = Math.max(lastCursor ?? -1, frame.cursor)
          } else if (frame.type === 'event') {
            lastCursor = Math.max(lastCursor ?? -1, frame.record.seq)
          } else if (frame.type === 'state') {
            lastCursor = Math.max(lastCursor ?? -1, frame.cursor)
          } else if (frame.type === 'gap') {
            reportedGap = true
          }
          progressed ||= frame.type === 'snapshot' || frame.type === 'event' || frame.type === 'state'
          yield frame
        }
      } catch (error) {
        if (isAborted(signal)) return
        const failure = remoteErrorOf(error)
        if (failure?.code === 'peer/version-skew') throw error
        if (!reportedGap && error instanceof RemoteError && error.code === 'peer/gap') {
          const gap = (error.details as { readonly gap?: PeerFollowGapFrame }).gap
          if (gap !== undefined) yield gap
        }
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
    let bytes = 0
    let throughSeq = brandNumber<SessionSeq>(toExclusive - 1)
    let complete = throughSeq <= fromExclusive
    const incomplete = (): RemoteError<'peer/gap'> => followGapError({
      type: 'gap', reason: 'sequence-discontinuity', resync: 'refollow-and-page',
      fromSeq: brandNumber<SessionSeq>(fromExclusive + 1), toSeq: brandNumber<SessionSeq>(toExclusive - 1),
    })
    for (let page = 0; page < REPAIR_PAGE_LIMIT; page += 1) {
      if (signal.aborted || complete) break
      const value = await this.page({ target, throughSeq, maxMessages: this.pageSize })
      for (const record of value.records) {
        if (record.seq > fromExclusive && record.seq < toExclusive) {
          const frame: PeerFollowFrame = { type: 'event', record, cursor: record.seq }
          bytes += new TextEncoder().encode(JSON.stringify(frame)).byteLength
          if (collected.length >= (this.options.followQueueMaxItems ?? followDefaults.followQueueMaxItems)
            || bytes > (this.options.followQueueMaxBytes ?? followDefaults.followQueueMaxBytes)) throw incomplete()
          collected.push(frame)
        }
      }
      const oldest = value.records[0]?.seq
      if (!value.hasMore || (oldest !== undefined && oldest <= fromExclusive + 1)) {
        complete = true
        break
      }
      if (oldest === undefined || oldest > throughSeq) throw incomplete()
      throughSeq = brandNumber<SessionSeq>(oldest - 1)
    }
    if (signal.aborted) return
    if (!complete) throw incomplete()
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
