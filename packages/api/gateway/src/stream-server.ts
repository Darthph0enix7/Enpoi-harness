/** Host WebSocket owner for multiplexed Typert Remote streams. */

import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { Deque } from '@deepseek-ai/dsh-deque'
import { RemoteError, remoteErrorOf, type PeerScope } from '@deepseek-ai/dsh-typert-protocol'
import WebSocket, { WebSocketServer, type RawData } from 'ws'
import {
  parseRemoteStreamClientMessage,
  REMOTE_STREAM_HEARTBEAT_TEXT,
  type RemoteStreamClientMessage,
  type RemoteStreamFailure,
  type RemoteStreamServerMessage,
} from './stream-protocol.ts'

/**
 * Open one validated Remote stream for a decoded wire request on behalf of one
 * Peer. `uplink` carries the Client's items; `control` cancels the logical
 * stream, and aborting it with a Remote failure as the reason delivers that
 * failure to the Client.
 */
export type RemoteStreamOpener = (
  endpoint: string,
  payload: unknown,
  uplink: AsyncIterable<unknown>,
  peer: PeerScope,
  control: AbortController,
) => Promise<AsyncIterable<unknown>>

/** The opener one socket uses: its Peer is fixed at upgrade time. */
type BoundStreamOpener = (
  endpoint: string,
  payload: unknown,
  uplink: AsyncIterable<unknown>,
  control: AbortController,
) => Promise<AsyncIterable<unknown>>

/** Convert an invocation or carrier failure to a stable wire value. */
export type RemoteStreamFailureMapper = (error: unknown) => RemoteStreamFailure

/** Own the no-server WebSocket acceptor and every active logical stream. */
export class RemoteStreamMuxServer {
  private readonly server = new WebSocketServer({ noServer: true })
  private readonly connections = new Set<Promise<void>>()
  private readonly lastPongAt = new WeakMap<WebSocket, number>()
  private readonly applicationHeartbeat = new WeakSet<WebSocket>()
  private heartbeatTimer: NodeJS.Timeout | undefined

  private readonly heartbeatTimeoutMs: number

  /**
   * @param open - Gateway stream dispatcher.
   * @param failure - Gateway error-to-wire mapper.
   * @param heartbeatIntervalMs - interval between WebSocket Ping control frames
   * (and application heartbeat frames for capable Clients); 0 disables both.
   * @param streamInboxBytes - buffered uplink frame bytes one logical stream may hold before it fails.
   * @param heartbeatTimeoutMs - time since the last Pong or message after which a socket is terminated.
   * @param maxBufferedBytes - per-socket backlog above which the carrier closes instead of growing memory.
   */
  constructor(
    private readonly open: RemoteStreamOpener,
    private readonly failure: RemoteStreamFailureMapper,
    private readonly heartbeatIntervalMs: number,
    private readonly streamInboxBytes: number,
    heartbeatTimeoutMs: number,
    private readonly maxBufferedBytes: number,
  ) {
    // A liveness deadline shorter than two Ping intervals would terminate
    // healthy sockets before the first response cycle can complete.
    this.heartbeatTimeoutMs = this.heartbeatIntervalMs > 0
      ? Math.max(heartbeatTimeoutMs, this.heartbeatIntervalMs * 2)
      : heartbeatTimeoutMs
  }

  /**
   * Upgrade one admitted request and begin serving its logical streams. Every
   * stream the socket opens speaks for the Peer admitted at upgrade, and the
   * socket closes when that Peer's scope is disposed.
   * @param req - authenticated HTTP upgrade request.
   * @param socket - carrier socket transferred to the WebSocket server.
   * @param head - bytes already read after the HTTP upgrade headers.
   * @param peer - Peer the upgrade was admitted as.
   */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, peer: PeerScope): void {
    this.server.handleUpgrade(req, socket, head, (websocket) => {
      const release = bindPeer(websocket, peer)
      if (release === undefined) return
      this.lastPongAt.set(websocket, Date.now())
      websocket.on('pong', () => { this.lastPongAt.set(websocket, Date.now()) })
      websocket.on('message', () => { this.lastPongAt.set(websocket, Date.now()) })
      if (requestsApplicationHeartbeat(req.url)) this.applicationHeartbeat.add(websocket)
      this.startHeartbeat()
      const bound: BoundStreamOpener = (endpoint, payload, uplink, control) =>
        this.open(endpoint, payload, uplink, peer, control)
      const connection = new RemoteStreamMuxConnection(
        websocket,
        bound,
        this.failure,
        this.streamInboxBytes,
        this.maxBufferedBytes,
      )
      const done = connection.run()
      this.connections.add(done)
      void done.then(() => {
        this.connections.delete(done)
        void release()
      })
    })
  }

  /** Terminate all sockets and wait until every iterator has returned. */
  async close(): Promise<void> {
    clearInterval(this.heartbeatTimer)
    this.heartbeatTimer = undefined
    for (const socket of this.server.clients) socket.terminate()
    const closed = Promise.withResolvers<void>()
    this.server.close((error) => {
      if (error === undefined) closed.resolve()
      else closed.reject(error)
    })
    await closed.promise
    await Promise.all(this.connections)
  }

  /** Start one `unref()` timer after the first upgrade; it spans empty-client periods until close(). */
  private startHeartbeat(): void {
    if (this.heartbeatTimer !== undefined || this.heartbeatIntervalMs <= 0) return
    this.heartbeatTimer = setInterval(() => {
      const now = Date.now()
      for (const socket of this.server.clients) {
        if (socket.readyState !== WebSocket.OPEN) continue
        const lastPongAt = this.lastPongAt.get(socket) ?? now
        if (now - lastPongAt >= this.heartbeatTimeoutMs) {
          // Re-check after the current macrotask: a Pong or message that landed
          // in this tick proves the peer alive, so only an unchanged timestamp
          // terminates the socket.
          setImmediate(() => {
            if ((this.lastPongAt.get(socket) ?? 0) <= lastPongAt) socket.terminate()
          })
          continue
        }
        if (this.applicationHeartbeat.has(socket)) {
          // Browser script cannot observe the Ping control frame; the
          // capability-negotiated application heartbeat keeps an idle modern
          // Client's liveness window fresh. Its write result only mirrors the
          // socket error/close events that end the connection.
          socket.send(REMOTE_STREAM_HEARTBEAT_TEXT, () => {})
        }
        socket.ping()
      }
    }, this.heartbeatIntervalMs)
    this.heartbeatTimer.unref()
  }
}

interface ActiveStream {
  readonly abort: AbortController
  readonly inbox: UplinkInbox
  /** Cancel the logical stream and end any Host read still waiting on its uplink. */
  readonly stop: (reason: Error) => void
  done: Promise<void>
}

class RemoteStreamMuxConnection {
  private readonly streams = new Map<string, ActiveStream>()
  private writes = Promise.resolve()

  constructor(
    private readonly socket: WebSocket,
    private readonly open: BoundStreamOpener,
    private readonly failure: RemoteStreamFailureMapper,
    private readonly streamInboxBytes: number,
    private readonly maxBufferedBytes: number,
  ) {}

  async run(): Promise<void> {
    const closed = new Promise<void>((resolve) => {
      this.socket.once('close', resolve)
      this.socket.once('error', () => { this.socket.terminate() })
      this.socket.on('message', (data, isBinary) => {
        if (isBinary) {
          this.socket.close(1003, 'text messages required')
          return
        }
        try {
          this.receive(rawText(data))
        } catch {
          this.socket.close(1008, 'invalid Remote stream request')
        }
      })
    })
    await closed
    const active = [...this.streams.values()]
    for (const stream of active) stream.stop(new Error('Remote stream socket closed'))
    await Promise.all(active.map(stream => stream.done))
  }

  /**
   * Dispatch one frame. `item`, `end`, and `cancel` for a stream this connection
   * no longer owns are dropped: a finished stream leaves the table while the
   * Client's in-flight frames are still arriving. A duplicate `open` is the one
   * protocol violation that closes the socket.
   */
  private receive(text: string): void {
    const message = parseRemoteStreamClientMessage(text)
    switch (message.type) {
      case 'open': {
        this.openStream(message)
        return
      }
      case 'item': {
        this.streams.get(message.streamId)?.inbox.push(message.value, Buffer.byteLength(text, 'utf8'))
        return
      }
      case 'end': {
        this.streams.get(message.streamId)?.inbox.end()
        return
      }
      case 'cancel': {
        this.streams.get(message.streamId)?.stop(new Error('Remote stream cancelled'))
        return
      }
      /* v8 ignore next 4 -- parseRemoteStreamClientMessage admits only the four frame types above. */
      default: {
        const unknown: never = message
        throw new Error(`api gateway: unknown Remote stream client message ${JSON.stringify(unknown)}`)
      }
    }
  }

  private openStream(message: Extract<RemoteStreamClientMessage, { readonly type: 'open' }>): void {
    if (this.streams.has(message.streamId)) {
      throw new Error(`api gateway: duplicate Remote stream id ${JSON.stringify(message.streamId)}`)
    }
    const abort = new AbortController()
    // Created before the opener resolves so items the Client sends right
    // after `open` wait in the inbox instead of being lost.
    const inbox = new UplinkInbox(this.streamInboxBytes, message.endpoint, (error) => { abort.abort(error) })
    const active: ActiveStream = {
      abort,
      inbox,
      stop: (reason) => {
        abort.abort(reason)
        inbox.fail(reason)
      },
      done: Promise.resolve(),
    }
    this.streams.set(message.streamId, active)
    const done = this.pump(message.streamId, message.endpoint, message.payload, active)
    active.done = done
    const remove = (): void => { this.streams.delete(message.streamId) }
    void done.then(remove, remove)
  }

  private async pump(
    streamId: string,
    endpoint: string,
    payload: unknown,
    active: ActiveStream,
  ): Promise<void> {
    let outcome: { readonly failed: false } | { readonly failed: true; readonly error: unknown }
    try {
      const source = await this.open(endpoint, payload, active.inbox, active.abort)
      for await (const value of source) {
        await this.send({ type: 'item', streamId, value })
      }
      outcome = { failed: false }
    } catch (error) {
      outcome = { failed: true, error }
    }
    // The downlink has settled; later uplink frames cannot change the outcome.
    active.inbox.fail(new Error('Remote stream ended'))
    if (active.abort.signal.aborted) {
      // A Remote failure as the abort reason is the Gateway or this mux failing
      // the stream (a rejected or overflowing uplink item, or an item after
      // end); the Client is still waiting for that terminal frame. Any other
      // abort is a cancellation.
      const reason: unknown = active.abort.signal.reason
      if (remoteErrorOf(reason) !== undefined) await this.sendFailure(streamId, reason)
      return
    }
    if (outcome.failed) {
      await this.sendFailure(streamId, outcome.error)
      return
    }
    try {
      await this.send({ type: 'end', streamId })
    } catch (error) {
      await this.sendFailure(streamId, error)
    }
  }

  private async sendFailure(streamId: string, error: unknown): Promise<void> {
    if (this.socket.readyState !== WebSocket.OPEN) return
    try {
      await this.send({ type: 'error', streamId, error: this.failure(error) })
    } catch {
      // A terminal frame that cannot be encoded or written leaves the
      // logical stream ambiguous, so fail the physical generation.
      this.socket.close(1011, 'Remote stream failure could not be delivered')
    }
  }

  private send(message: RemoteStreamServerMessage): Promise<void> {
    let text: string
    try {
      text = JSON.stringify(message)
    } catch (cause) {
      return Promise.reject(new Error('api gateway: Remote stream item is not JSON serializable', { cause }))
    }
    const frameBytes = Buffer.byteLength(text, 'utf8')
    const delivery = this.writes.then(() => new Promise<void>((resolve, reject) => {
      if (this.socket.readyState !== WebSocket.OPEN) {
        reject(new Error('api gateway: Remote stream socket is closed'))
        return
      }
      if (frameBytes > this.maxBufferedBytes) {
        // No backlog can fit a single frame larger than the whole ceiling.
        // Reject the frame so its pump can deliver a failure for the logical
        // stream instead of discarding the physical generation.
        reject(new Error(
          `api gateway: Remote stream frame exceeded ${String(this.maxBufferedBytes)} buffered bytes`,
        ))
        return
      }
      if (this.socket.bufferedAmount + frameBytes > this.maxBufferedBytes) {
        // A Client that cannot drain the downlink would otherwise grow Host
        // memory without bound. Close with an existing carrier-failure code so
        // the ordinary reconnect policy (with its climbing backoff) applies.
        this.socket.close(1011, 'Remote stream backpressure exceeded')
        reject(new Error('api gateway: Remote stream backpressure exceeded'))
        return
      }
      this.socket.send(text, (error) => {
        if (error) reject(error)
        else resolve()
      })
    }))
    this.writes = delivery.catch(() => undefined)
    return delivery
  }
}

interface UplinkEntry {
  readonly value: unknown
  readonly bytes: number
}

const UPLINK_DONE: IteratorReturnResult<undefined> = { value: undefined, done: true }

/**
 * Bounded single-consumer uplink queue of one logical stream, the source the
 * Host method reads through `invocation.uplink()`. Buffered frame bytes are
 * capped: overflow, and an item after the Client's `end`, fail the queue and
 * report a Remote failure that the connection uses to fail the logical stream.
 */
class UplinkInbox implements AsyncIterable<unknown>, AsyncIterator<unknown> {
  private readonly queue = new Deque<UplinkEntry>()
  private bytes = 0
  private ended = false
  private closed = false
  private taken = false
  private failure: Error | undefined
  private wake: (() => void) | undefined

  constructor(
    private readonly maxBytes: number,
    private readonly endpoint: string,
    private readonly onViolation: (error: RemoteError<'gateway/protocol' | 'gateway/uplink-overflow'>) => void,
  ) {}

  push(value: unknown, frameBytes: number): void {
    if (this.failure !== undefined || this.closed) return
    if (this.ended) {
      this.violate(new RemoteError(
        'gateway/protocol',
        'api gateway: Remote stream uplink item after end',
        { endpoint: this.endpoint },
      ))
      return
    }
    if (this.bytes + frameBytes > this.maxBytes) {
      this.violate(new RemoteError(
        'gateway/uplink-overflow',
        `api gateway: Remote stream uplink exceeded ${String(this.maxBytes)} buffered bytes`,
        { endpoint: this.endpoint },
      ))
      return
    }
    this.queue.pushBack({ value, bytes: frameBytes })
    this.bytes += frameBytes
    this.signal()
  }

  /** Client half-close; idempotent. */
  end(): void {
    if (this.ended) return
    this.ended = true
    this.signal()
  }

  /** End the consumer's next read with `error`; idempotent, drops buffered items. */
  fail(error: Error): void {
    if (this.failure !== undefined) return
    this.failure = error
    this.queue.clear()
    this.bytes = 0
    this.signal()
  }

  [Symbol.asyncIterator](): AsyncIterator<unknown> {
    if (this.taken) throw new Error('api gateway: Remote stream uplink inbox already has a consumer')
    this.taken = true
    return this
  }

  async next(): Promise<IteratorResult<unknown>> {
    while (true) {
      if (this.closed) return UPLINK_DONE
      const entry = this.queue.popFront()
      if (entry !== undefined) {
        this.bytes -= entry.bytes
        return { value: entry.value, done: false }
      }
      if (this.failure !== undefined) throw this.failure
      if (this.ended) return UPLINK_DONE
      if (this.wake !== undefined) throw new Error('api gateway: Remote stream uplink inbox has one pending read')
      await new Promise<void>((resolve) => { this.wake = resolve })
    }
  }

  /** Consumer stopped reading: later items are dropped, a pending read ends. */
  return(): Promise<IteratorResult<unknown>> {
    this.closed = true
    this.queue.clear()
    this.bytes = 0
    this.signal()
    return Promise.resolve(UPLINK_DONE)
  }

  private violate(error: RemoteError<'gateway/protocol' | 'gateway/uplink-overflow'>): void {
    this.fail(error)
    this.onViolation(error)
  }

  private signal(): void {
    const wake = this.wake
    this.wake = undefined
    wake?.()
  }
}

/**
 * Close the socket when the Peer's scope is disposed. A scope that is already
 * disposed leaves no Peer for the socket to speak for, so the socket closes now.
 * @returns the registration's disposer, or `undefined` when the socket was closed.
 */
function bindPeer(websocket: WebSocket, peer: PeerScope): (() => unknown) | undefined {
  try {
    return peer.ctx.effect(
      () => () => { websocket.close(1001, 'peer left') },
      'api-gateway: Remote stream socket bound to its Peer',
    )
  } catch {
    websocket.close(1001, 'peer left')
    return undefined
  }
}

/**
 * Whether this upgrade asked for the capability-gated application heartbeat.
 * The old bundle never sends the parameter, so it keeps its heartbeat-free
 * frame vocabulary instead of dying on an unknown frame with 4002.
 */
function requestsApplicationHeartbeat(url: string | undefined): boolean {
  if (url === undefined) return false
  try {
    return new URL(url, 'http://localhost').searchParams.get('heartbeat') === '1'
  } catch {
    return false
  }
}

function rawText(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8')
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8')
  return Buffer.from(data).toString('utf8')
}

/**
 * Reject an upgrade without transferring socket ownership to ws.
 * @param socket - carrier socket that receives the HTTP rejection.
 * @param status - authentication or browser-trust rejection status.
 */
export function rejectRemoteStreamUpgrade(socket: Duplex, status: 401 | 403): void {
  const reason = status === 401 ? 'Unauthorized' : 'Forbidden'
  const body = reason.toLowerCase()
  socket.end([
    `HTTP/1.1 ${String(status)} ${reason}`,
    'Connection: close',
    'Content-Type: text/plain; charset=utf-8',
    `Content-Length: ${String(Buffer.byteLength(body))}`,
    '',
    body,
  ].join('\r\n'))
}
