/**
 * The calling side of the peer API, shadowed locally.
 *
 * `@deepseek-ai/dsh-api-peer/client` is not resolvable from this profile (the
 * harness package is not a profile dependency), so this module re-implements
 * the same wire semantics: the `{type:'client-request', payload:{args:{request}}}`
 * unary envelope, the `/api/remote.mux` follow stream, exponential backoff with
 * `peer.page` durable-hole repair, and the caller-owned
 * `peer/target-unreachable` failure. Ported from the harness client at
 * `packages/api/peer/src/client.ts` (same frame contract); keep the two in
 * step when the contract changes.
 *
 * @module dsh-enpoi-peer-bridge/peer-client
 */

/** One structured peer failure, mirroring the harness `RemoteError` surface. */
export class PeerBridgeError extends Error {
  /** Stable peer error code (`peer/*`, `gateway/*`). */
  readonly code: string
  /** Structured details from the host envelope. */
  readonly details: Readonly<Record<string, unknown>>
  /** Endpoint the failing call targeted. */
  readonly endpoint: string

  /**
   * @param code - stable error code.
   * @param message - human-readable failure.
   * @param endpoint - target base URL.
   * @param details - structured details.
   */
  constructor(code: string, message: string, endpoint: string, details: Readonly<Record<string, unknown>> = {}) {
    super(message)
    this.name = 'PeerBridgeError'
    this.code = code
    this.details = details
    this.endpoint = endpoint
  }
}

/** Address of a peer call; resolves through the serving host's pairing file. */
export type PeerTarget = { readonly kind: 'alias'; readonly alias: string } | { readonly kind: 'session'; readonly sessionId: string }

/** Minimal WebSocket surface `follow` needs. */
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

/**
 * A durable-history hole `peer.page` could not fill. The replay continues past
 * it; the caller decides whether to warn, retry, or stop.
 */
export interface PeerRepairHole {
  /** First missing durable seq (inclusive). */
  readonly from: number
  /** First seq after the missing range (exclusive). */
  readonly to: number
}

/** Caller configuration: one target host and its carrier details. */
export interface PeerClientOptions {
  readonly endpoint: string
  readonly device: string
  readonly headers?: Readonly<Record<string, string>>
  readonly harnessVersion?: string
  readonly schemaDigest?: string
  readonly fetch?: typeof fetch
  readonly webSocket?: (url: string) => PeerWebSocket
  readonly backoff?: PeerBackoff
  readonly maxReconnects?: number
  readonly pageSize?: number
  /** Receives a repair hole when `peer.page` cannot prove durable contiguity. */
  readonly onWarning?: (hole: PeerRepairHole) => void
}

/** One selectable option on a remote question. */
export interface PeerQuestionOption {
  /** User-facing label; the value `peer.answer` echoes back. */
  readonly label: string
  /** Optional extra context rendered by capable UIs. */
  readonly description?: string
}

/**
 * One question on a remote question ask. Mirrors the host's
 * `AskUserQuestionItem` wire fields; presentation-only fields the caller
 * cannot act on are not modelled.
 */
export interface PeerQuestionItem {
  /** Stable question id, echoed in the answer. */
  readonly id: string
  /** The question to display. */
  readonly question: string
  /** Optional supporting detail. */
  readonly detail?: string
  /** Optional short heading. */
  readonly header?: string
  /** Choices the caller can select; absent means a free-form answer. */
  readonly options?: readonly PeerQuestionOption[]
  /** Whether more than one option may be selected. Defaults to single-select. */
  readonly multiSelect?: boolean
}

/** One answered question; the host validates `selected` against its options. */
export interface PeerQuestionAnswerItem {
  readonly id: string
  readonly selected: readonly string[]
  readonly custom?: string
}

/** The structured answer `peer.answer` carries for `kind:'question'`. */
export interface PeerQuestionAnswer {
  readonly answers: readonly PeerQuestionAnswerItem[]
}

/** One pending ask as the host reports it. */
export interface PeerPendingAsk {
  readonly kind: 'approval' | 'question'
  readonly askId: string
  readonly toolName?: string
  readonly callId?: string
  readonly reason?: string
  readonly questions?: readonly PeerQuestionItem[]
  readonly since: number
}

/** Aggregate execution state; the latch is the authoritative wait signal. */
export interface PeerExecutionState {
  readonly latch: 'running' | 'waiting_approval' | 'waiting_subagents' | 'idle'
  readonly since: number
  readonly source: 'host-latch' | 'derived'
  readonly activeDescendants: number
  readonly descendantsExact: boolean
  readonly pendingAsks: readonly PeerPendingAsk[]
  readonly lastTurnEnd?: { readonly turn: number; readonly reason: string; readonly at: number; readonly error?: Record<string, unknown> }
  readonly model?: { readonly provider: string; readonly model: string; readonly chain?: string }
}

/** One durable event record on the peer wire. */
export interface PeerEventRecord {
  readonly seq: number
  readonly time: number
  readonly type: string
  readonly data: unknown
}

/** Every frame `peer/follow` carries. */
export type PeerFollowFrame =
  | {
    readonly type: 'snapshot'
    readonly target: { readonly device: string; readonly sessionId: string; readonly exposure: string; readonly alias?: string }
    readonly header: { readonly id: string; readonly version: number; readonly createdAt: number; readonly cwd?: string }
    readonly cursor: number
    readonly state: PeerExecutionState
    readonly records: readonly PeerEventRecord[]
    readonly hasMore: boolean
  }
  | { readonly type: 'event'; readonly record: PeerEventRecord; readonly cursor: number }
  | { readonly type: 'state'; readonly state: PeerExecutionState; readonly cursor: number }
  | { readonly type: 'assistant-stream'; readonly frame: unknown }
  | { readonly type: 'end'; readonly reason: 'closed' | 'target-detached' }

/** `peer.handshake` value. */
export interface PeerHandshakeValue {
  readonly protocolVersion: number
  readonly harnessVersion: string
  readonly schemaDigest: string
  readonly hostDevice: string
  readonly capabilities: readonly string[]
  readonly pairings: readonly {
    readonly alias: string
    readonly peer: string
    readonly exposure: string
    readonly tokenRequired: boolean
    readonly target?: { readonly sessionId: string }
  }[]
}

/** `peer.state` value. */
export interface PeerStateValue {
  readonly target: { readonly device: string; readonly sessionId: string; readonly exposure: string; readonly alias?: string }
  readonly state: PeerExecutionState
  readonly cursor: number
}

/** One pairing row `peer.list` reports. */
export interface PeerListEntry {
  readonly alias: string
  readonly peer: string
  readonly exposure: string
  readonly bound: boolean
  /** Session the host exposes; the caller's `remoteSessionId`. */
  readonly sessionId?: string
  /** Caller-role pin echoed from a shared pairing document, when declared. */
  readonly remoteSessionId?: string
  readonly latch?: string
  readonly lastActivity?: number
  readonly summary: string
}

/** `peer.list` value. */
export interface PeerListValue {
  readonly hostDevice: string
  readonly pairings: readonly PeerListEntry[]
}

/** `peer.create` value. */
export interface PeerCreateValue {
  readonly target: { readonly device: string; readonly sessionId: string; readonly exposure: string; readonly alias?: string }
  readonly created: boolean
}

/** Peer participant attribution sent on every peer-originated call. */
export interface PeerParticipant {
  readonly kind: 'peer'
  readonly name: string
  readonly device?: string
}

const DEFAULT_BACKOFF: PeerBackoff = { initialMs: 250, maxMs: 4_000, factor: 2 }
const REPAIR_PAGE_LIMIT = 20

/**
 * Error frames that cannot be fixed by retrying the same follow: the pairing,
 * session, or exposure is gone or refused. A healthy reconnect cannot change
 * them, so `follow` surfaces them instead of reconnecting at backoff cadence.
 */
const CALLER_TERMINAL_CODES: ReadonlySet<string> = new Set([
  'peer/version-skew',
  'peer/not-paired',
  'peer/not-found',
  'peer/forbidden',
])

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
    this.endpoint = options.endpoint.replace(/\/+$/u, '')
    this.headers = options.headers ?? {}
    this.fetchImpl = options.fetch ?? globalThis.fetch
    this.webSocketFactory = options.webSocket ?? defaultWebSocket
    this.backoff = options.backoff ?? DEFAULT_BACKOFF
    this.maxReconnects = options.maxReconnects
    this.pageSize = options.pageSize ?? 50
  }

  /** Negotiate against the target; a protocol mismatch surfaces `peer/version-skew`. */
  async handshake(): Promise<PeerHandshakeValue> {
    return this.rpc('handshake', {
      protocolVersion: 1,
      harnessVersion: this.options.harnessVersion ?? '0.1.6-alpha.2',
      schemaDigest: this.options.schemaDigest ?? '',
      device: this.options.device,
    })
  }

  /** Read the latch for one target. */
  state(target: PeerTarget): Promise<PeerStateValue> {
    return this.rpc('state', { target })
  }

  /** List the pairings the host exposes, optionally narrowed to one resolved target. */
  list(request: { readonly target?: PeerTarget } = {}): Promise<PeerListValue> {
    return this.rpc('list', request)
  }

  /** Create or adopt a Session under a pairing alias. */
  create(request: {
    readonly alias: string
    readonly participant: PeerParticipant
    readonly sessionId?: string
    readonly cwd?: string
    readonly agentPreset?: string
    /** Provider route the host pins on the created Session (with `model`). */
    readonly provider?: string
    /** Model id the host pins on the created Session (with `provider`). */
    readonly model?: string
    /** Model-group id the created Session's requests carry. */
    readonly chain?: string
    /** Adapter-owned reasoning effort for the pinned route. */
    readonly reasoningEffort?: string
  }): Promise<PeerCreateValue> {
    return this.rpc('create', request)
  }

  /** Admit a queued peer turn. */
  prompt(request: {
    readonly target: PeerTarget
    readonly participant: PeerParticipant
    readonly requestId: string
    readonly content: readonly { readonly type: 'text'; readonly text: string }[]
    readonly hopCount?: number
  }): Promise<{ readonly accepted: boolean; readonly queued: boolean; readonly hopCount: number }> {
    return this.rpc('prompt', request)
  }

  /** Cancel the target's active turn. */
  cancel(request: { readonly target: PeerTarget; readonly participant: PeerParticipant }): Promise<{ readonly accepted: boolean; readonly cancelled: boolean }> {
    return this.rpc('cancel', request)
  }

  /** Settle a pending ask. */
  answer(request: {
    readonly target: PeerTarget
    readonly participant: PeerParticipant
    readonly askId: string
    readonly answer: { readonly kind: 'approval'; readonly outcome: 'allowed-once' | 'rejected' } | { readonly kind: 'question'; readonly answer: PeerQuestionAnswer }
  }): Promise<{ readonly accepted: boolean; readonly settled: boolean }> {
    return this.rpc('answer', request)
  }

  /** Read one backwards history window for repair. */
  page(request: { readonly target: PeerTarget; readonly throughSeq: number; readonly beforeSeq?: number; readonly maxMessages?: number }): Promise<{ readonly records: readonly PeerEventRecord[]; readonly hasMore: boolean }> {
    return this.rpc('page', request)
  }

  /**
   * Open one follow generation without reconnect handling.
   * @param request - target and window options.
   * @param signal - caller cancellation closing the socket.
   * @returns frames exactly as the host sends them.
   */
  async *followOnce(request: { readonly target: PeerTarget; readonly maxMessages?: number }, signal: AbortSignal): AsyncGenerator<PeerFollowFrame> {
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
   * @param request - target and window options.
   * @param signal - caller cancellation; the only way to stop a healthy stream.
   * @returns follow frames across reconnects; repair records precede the new snapshot.
   */
  async *follow(request: { readonly target: PeerTarget; readonly maxMessages?: number }, signal: AbortSignal): AsyncGenerator<PeerFollowFrame> {
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
        if (signal.aborted) return
        if (error instanceof PeerBridgeError && CALLER_TERMINAL_CODES.has(error.code)) throw error
      }
      if (signal.aborted) return
      attempt = progressed ? 1 : attempt + 1
      if (this.maxReconnects !== undefined && attempt > this.maxReconnects) {
        throw unreachable(this.endpoint)
      }
      await delay(backoffDelay(this.backoff, attempt), signal)
    }
  }

  /**
   * Fill a durable hole between two cursors by paging backwards from the newer cut.
   * A hole the pages cannot prove contiguous emits `onWarning` with the missing range.
   * @param target - resolved peer target.
   * @param fromExclusive - last durable seq the caller already folded.
   * @param toExclusive - first durable seq the caller is about to receive.
   * @param signal - caller cancellation.
   * @returns the missing records in ascending seq order.
   */
  async *repairForward(target: PeerTarget, fromExclusive: number, toExclusive: number, signal: AbortSignal): AsyncGenerator<PeerFollowFrame> {
    const collected: PeerEventRecord[] = []
    let throughSeq = toExclusive - 1
    let hole: PeerRepairHole | undefined
    let pages = 0
    while (pages < REPAIR_PAGE_LIMIT) {
      if (signal.aborted || throughSeq <= fromExclusive) break
      const value = await this.page({ target, throughSeq, maxMessages: this.pageSize })
      pages += 1
      if (value.records.length === 0) {
        hole = { from: fromExclusive + 1, to: throughSeq + 1 }
        break
      }
      for (const record of value.records) {
        if (record.seq > fromExclusive && record.seq < toExclusive) collected.push(record)
      }
      const oldest = value.records[0]?.seq
      if (oldest === undefined || oldest <= fromExclusive + 1 || !value.hasMore) {
        if (oldest !== undefined && oldest > fromExclusive + 1) hole = { from: fromExclusive + 1, to: oldest }
        break
      }
      throughSeq = oldest - 1
    }
    if (hole === undefined && !signal.aborted && throughSeq > fromExclusive) {
      hole = { from: fromExclusive + 1, to: throughSeq + 1 }
    }
    if (hole !== undefined) this.options.onWarning?.(hole)
    collected.sort((left, right) => left.seq - right.seq)
    for (const record of collected) yield { type: 'event', record, cursor: record.seq }
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
          // SRC-derived host descriptors name the business parameter `request`.
          payload: { args: { request: args } },
        }),
      })
    } catch (error) {
      throw unreachable(this.endpoint, error)
    }
    if (!response.ok) {
      throw new PeerBridgeError('peer/target-unreachable', `peer ${method} failed over HTTP ${String(response.status)}`, this.endpoint, { endpoint: this.endpoint })
    }
    const body = await response.json() as {
      readonly result?: { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown }
    }
    const result = body.result
    if (result === undefined) {
      throw new PeerBridgeError('gateway/internal', `peer ${method} returned no result envelope`, this.endpoint, {})
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
export function unreachable(endpoint: string, cause?: unknown): PeerBridgeError {
  const error = new PeerBridgeError('peer/target-unreachable', `peer target ${endpoint} is unreachable`, endpoint, { endpoint })
  if (cause !== undefined) (error as { cause?: unknown }).cause = cause
  return error
}

/** Restore one structured peer failure from the wire envelope. */
function decodeFailure(value: unknown, endpoint: string): PeerBridgeError {
  if (typeof value !== 'object' || value === null) return unreachable(endpoint)
  const record = value as Record<string, unknown>
  const code = typeof record.code === 'string' ? record.code : 'gateway/internal'
  const message = typeof record.message === 'string' ? record.message : 'peer call failed'
  const details = typeof record.details === 'object' && record.details !== null
    ? record.details as Readonly<Record<string, unknown>>
    : {}
  return new PeerBridgeError(code, message, endpoint, details)
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
    const onAbort = (): void => {
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}
