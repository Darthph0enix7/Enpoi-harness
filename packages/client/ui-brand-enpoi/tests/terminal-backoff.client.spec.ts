// @vitest-environment jsdom
/** Terminal socket keepalive and reconnect timing. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  TERMINAL_KEEPALIVE_INTERVAL_MS,
  TERMINAL_RECONNECT_BASE_MS,
  TERMINAL_RECONNECT_MAX_MS,
  TERMINAL_STABLE_CONNECTION_MS,
  resolveTerminalSocketTiming,
  terminalReconnectDelay,
} from '../src/client/terminal/backoff.ts'
import { TerminalConnection } from '../src/client/terminal/registry.ts'
import type { TerminalServerFrame } from '@deepseek-ai/dsh-host-enpoi-terminal/shared'

type Handler<T> = ((event: T) => void) | null

/** One scripted browser socket; the registry only touches the event handlers and send. */
class FakeSocket {
  static readonly OPEN = 1
  static readonly CLOSED = 3
  static instances: FakeSocket[] = []

  readyState = FakeSocket.OPEN
  onopen: Handler<Event> = null
  onmessage: Handler<MessageEvent<string>> = null
  onclose: Handler<CloseEvent> = null
  onerror: Handler<Event> = null
  readonly sent: string[] = []

  constructor(readonly url: string) {
    FakeSocket.instances.push(this)
  }

  send(data: string): void {
    this.sent.push(data)
  }

  close(): void {
    this.readyState = FakeSocket.CLOSED
    this.onclose?.({ code: 1000 } as CloseEvent)
  }

  /** Scripted server frame. */
  receive(frame: TerminalServerFrame): void {
    this.onmessage?.({ data: JSON.stringify(frame) } as MessageEvent<string>)
  }

  open(): void {
    this.onopen?.(new Event('open'))
  }

  drop(code = 1006): void {
    this.readyState = FakeSocket.CLOSED
    this.onclose?.({ code } as CloseEvent)
  }
}

const TIMING = {
  reconnectBaseMs: 100,
  reconnectMaxMs: 800,
  stableConnectionMs: 1_000,
  keepaliveIntervalMs: 200,
  random: () => 0,
}

function stubEnvironment(): { updates: string[] } {
  FakeSocket.instances = []
  vi.stubGlobal('WebSocket', FakeSocket)
  vi.stubGlobal('fetch', vi.fn(async () => ({
    json: async () => ({ ok: true, value: { key: 's:t1', pid: 1, cwd: '/', shell: 'bash', spawned: true } }),
  })))
  const updates: string[] = []
  return { updates }
}

async function connect(timing = TIMING, updates: string[] = []): Promise<TerminalConnection> {
  const connection = new TerminalConnection('s:t1', 's', undefined, (update) => { updates.push(update.status) }, resolveTerminalSocketTiming(timing))
  await connection.start()
  return connection
}

function socket(): FakeSocket {
  const last = FakeSocket.instances.at(-1)
  if (last === undefined) throw new Error('no socket opened')
  return last
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('terminal reconnect timing', () => {
  it('resolves the documented defaults', () => {
    expect(resolveTerminalSocketTiming()).toMatchObject({
      reconnectBaseMs: TERMINAL_RECONNECT_BASE_MS,
      reconnectMaxMs: TERMINAL_RECONNECT_MAX_MS,
      stableConnectionMs: TERMINAL_STABLE_CONNECTION_MS,
      keepaliveIntervalMs: TERMINAL_KEEPALIVE_INTERVAL_MS,
    })
  })

  it('rejects timing that could disable the retry ladder', () => {
    expect(() => resolveTerminalSocketTiming({ reconnectBaseMs: 0 })).toThrow(/reconnectMaxMs/)
    expect(() => resolveTerminalSocketTiming({ reconnectMaxMs: 10, reconnectBaseMs: 100 })).toThrow(/reconnectMaxMs/)
    expect(() => resolveTerminalSocketTiming({ stableConnectionMs: Number.NaN })).toThrow(/stableConnectionMs/)
    expect(() => resolveTerminalSocketTiming({ keepaliveIntervalMs: -1 })).toThrow(/keepaliveIntervalMs/)
  })

  it('grows the cap exponentially and applies 50%–100% jitter', () => {
    const timing = resolveTerminalSocketTiming({ reconnectBaseMs: 100, reconnectMaxMs: 800, random: () => 0 })
    expect([1, 2, 3, 4, 5, 6].map(attempt => terminalReconnectDelay(attempt, timing)))
      .toEqual([50, 100, 200, 400, 400, 400])
    const jittered = resolveTerminalSocketTiming({ reconnectBaseMs: 100, reconnectMaxMs: 800, random: () => 1 })
    expect([1, 2, 3, 4].map(attempt => terminalReconnectDelay(attempt, jittered)))
      .toEqual([100, 200, 400, 800])
  })
})

describe('terminal socket keepalive', () => {
  it('pings while open and accepts the pong answer', async () => {
    vi.useFakeTimers()
    const { updates } = stubEnvironment()
    const connection = await connect(TIMING, updates)
    socket().open()
    expect(updates).toEqual(['running'])

    vi.advanceTimersByTime(200)
    expect(socket().sent.map(text => JSON.parse(text) as { t: string })).toContainEqual({ t: 'ping' })
    socket().receive({ t: 'pong' })
    connection.write('x')
    expect(socket().sent.map(text => JSON.parse(text) as { t: string })).toContainEqual({ t: 'input', data: 'x' })
    connection.kill()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('retries with exponential backoff and resets only after the stability window', async () => {
    vi.useFakeTimers()
    stubEnvironment()
    const connection = await connect(TIMING)
    socket().open()

    // First drop before the stability window: retry 1 waits 50 ms.
    socket().drop()
    await vi.advanceTimersByTimeAsync(49)
    expect(FakeSocket.instances).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(FakeSocket.instances).toHaveLength(2)

    // Second immediate drop keeps climbing: retry 2 waits 100 ms.
    socket().drop()
    await vi.advanceTimersByTimeAsync(99)
    expect(FakeSocket.instances).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(FakeSocket.instances).toHaveLength(3)

    // A socket that stayed open for the stability window restarts at retry 1.
    socket().open()
    await vi.advanceTimersByTimeAsync(1_000)
    socket().drop()
    await vi.advanceTimersByTimeAsync(50)
    expect(FakeSocket.instances).toHaveLength(4)
    connection.kill()
  })

  it('stops the retry timer and the keepalive when disposed', async () => {
    vi.useFakeTimers()
    stubEnvironment()
    const connection = await connect(TIMING)
    socket().open()
    socket().drop()
    connection.kill()
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(FakeSocket.instances).toHaveLength(1)
  })
})
