/**
 * Served-Carrier heartbeat wiring end to end: a mux `heartbeat` frame must arm
 * the current Connection generation's autonomous silence watchdog, and a
 * replacement generation starts disarmed until its own first heartbeat.
 */
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import {
  apply as applyConnection,
  type ConnectionHandle,
} from '@deepseek-ai/dsh-client-connection/client'
import {
  DEFAULT_WATCHDOG_INTERVAL_MS,
  DEFAULT_WATCHDOG_STALE_MS,
} from '@deepseek-ai/dsh-client-connection/src/recovery-config.ts'
import { apply as applyGateway, inject as gatewayInject } from '../src/client/index.ts'
import {
  REMOTE_EVENT_STREAM_ENDPOINT,
  REMOTE_STREAM_HEARTBEAT_TEXT,
} from '../src/stream-protocol.ts'

interface WebSocketGlobal {
  WebSocket?: typeof WebSocket
}

/** Minimal browser WebSocket double: the test drives open, frames, and close itself. */
class FakeSocket extends EventTarget {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3
  static readonly sockets: FakeSocket[] = []

  readonly url: string
  readonly sent: string[] = []
  readyState = FakeSocket.CONNECTING

  constructor(url: string | URL) {
    super()
    this.url = String(url)
    FakeSocket.sockets.push(this)
    queueMicrotask(() => { this.open() })
  }

  open(): void {
    if (this.readyState !== FakeSocket.CONNECTING) return
    this.readyState = FakeSocket.OPEN
    this.dispatchEvent(new Event('open'))
  }

  send(data: string): void {
    if (this.readyState !== FakeSocket.OPEN) throw new Error('fixture socket is not open')
    this.sent.push(data)
  }

  close(): void {
    if (this.readyState === FakeSocket.CLOSED) return
    this.readyState = FakeSocket.CLOSED
    this.dispatchEvent(new Event('close'))
  }

  receive(value: unknown): void {
    this.receiveRaw(JSON.stringify(value))
  }

  receiveRaw(data: string): void {
    this.dispatchEvent(new MessageEvent('message', { data }))
  }
}

/** Resolve the `$events` open frame the Gateway client sent on one physical socket. */
function openStreamId(socket: FakeSocket): string {
  const opened = JSON.parse(socket.sent[0]!) as {
    readonly type: string
    readonly endpoint: string
    readonly streamId: string
  }
  expect(opened.type).toBe('open')
  expect(opened.endpoint).toBe(REMOTE_EVENT_STREAM_ENDPOINT)
  return opened.streamId
}

/** Answer one generation's `$events` open frame with the opening ready item. */
function reportReady(socket: FakeSocket, home = '/hosts/primary'): void {
  socket.receive({
    type: 'item',
    streamId: openStreamId(socket),
    value: { type: 'ready', clientId: 'watchdog-client', host: { home } },
  })
}

let context: Context | undefined

async function bootServedCarrier(): Promise<ConnectionHandle> {
  vi.useFakeTimers()
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  vi.stubGlobal('window', Object.assign(new EventTarget(), { navigator: { onLine: true } }))
  vi.stubGlobal('document', Object.assign(new EventTarget(), {
    baseURI: 'https://harness.example/',
    visibilityState: 'visible',
  }))
  vi.stubGlobal('location', { origin: 'https://harness.example', hostname: 'harness.example', search: '' })
  ;(globalThis as WebSocketGlobal).WebSocket = FakeSocket as unknown as typeof WebSocket
  FakeSocket.sockets.length = 0
  context = new Context()
  await context.plugin(TypertRegistry)
  await context.plugin({ inject: [], apply: applyConnection })
  await context.plugin({ inject: gatewayInject, apply: applyGateway })
  return context.get('connection') as ConnectionHandle
}

/** Let the connect/reconnect promise chain and the socket open microtask settle. */
async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0)
}

/** Open the generation on the newest physical socket and wait until Connection publishes connected. */
async function connectGeneration(connection: ConnectionHandle, index: number): Promise<FakeSocket> {
  await settle()
  const socket = FakeSocket.sockets[index]!
  expect(socket).toBeDefined()
  expect(socket.readyState).toBe(FakeSocket.OPEN)
  await settle()
  expect(socket.sent).toHaveLength(1)
  reportReady(socket)
  await settle()
  expect(connection.state.getSnapshot()).toBe('connected')
  return socket
}

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
  FakeSocket.sockets.length = 0
})

describe('served-Carrier heartbeat watchdog wiring', () => {
  it('keeps the watchdog disarmed for a host that never sends application heartbeats', async () => {
    const connection = await bootServedCarrier()
    await connectGeneration(connection, 0)
    expect(FakeSocket.sockets).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(5 * 60_000)

    expect(FakeSocket.sockets).toHaveLength(1)
    expect(connection.state.getSnapshot()).toBe('connected')
  })

  it('reconnects exactly once after a heartbeat-armed generation goes silent', async () => {
    const connection = await bootServedCarrier()
    const socket = await connectGeneration(connection, 0)

    socket.receiveRaw(REMOTE_STREAM_HEARTBEAT_TEXT)
    await vi.advanceTimersByTimeAsync(DEFAULT_WATCHDOG_STALE_MS)
    expect(FakeSocket.sockets).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(DEFAULT_WATCHDOG_INTERVAL_MS)
    await settle()
    expect(FakeSocket.sockets).toHaveLength(2)
  })

  it('starts a replacement generation disarmed until that generation receives its own heartbeat', async () => {
    const connection = await bootServedCarrier()
    const first = await connectGeneration(connection, 0)
    first.receiveRaw(REMOTE_STREAM_HEARTBEAT_TEXT)
    await vi.advanceTimersByTimeAsync(DEFAULT_WATCHDOG_STALE_MS + DEFAULT_WATCHDOG_INTERVAL_MS)
    await settle()
    expect(FakeSocket.sockets).toHaveLength(2)

    const replacement = await connectGeneration(connection, 1)
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    expect(FakeSocket.sockets).toHaveLength(2)

    replacement.receiveRaw(REMOTE_STREAM_HEARTBEAT_TEXT)
    await vi.advanceTimersByTimeAsync(DEFAULT_WATCHDOG_STALE_MS)
    expect(FakeSocket.sockets).toHaveLength(2)

    await vi.advanceTimersByTimeAsync(DEFAULT_WATCHDOG_INTERVAL_MS)
    await settle()
    expect(FakeSocket.sockets).toHaveLength(3)
  })
})
