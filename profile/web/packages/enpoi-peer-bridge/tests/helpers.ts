import type { PeerFollowFrame, PeerWebSocket } from '../src/peer-client.ts'

/** Scripted WebSocket: emits `open` once, then runs the generation script on `send`. */
export class FakeSocket implements PeerWebSocket {
  private readonly listeners = new Map<string, Set<(event: unknown) => void>>()
  readonly sent: string[] = []

  constructor(private readonly onOpenEnvelope: (socket: FakeSocket, streamId: string) => void) {}

  addEventListener(type: 'open' | 'message' | 'error' | 'close', listener: (event: unknown) => void): void {
    const set = this.listeners.get(type) ?? new Set()
    set.add(listener)
    this.listeners.set(type, set)
    if (type === 'open') queueMicrotask(() => { this.emit('open', {}) })
  }

  removeEventListener(type: 'open' | 'message' | 'error' | 'close', listener: (event: unknown) => void): void {
    this.listeners.get(type)?.delete(listener)
  }

  send(data: string): void {
    this.sent.push(data)
    const parsed = JSON.parse(data) as { type: string; streamId: string }
    if (parsed.type === 'open') this.onOpenEnvelope(this, parsed.streamId)
  }

  close(): void {
    this.emit('close', {})
  }

  emit(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event)
  }

  frame(streamId: string, frame: PeerFollowFrame): void {
    this.emit('message', { data: JSON.stringify({ streamId, type: 'item', value: frame }) })
  }

  fail(streamId: string, error: { code: string; message: string }): void {
    this.emit('message', { data: JSON.stringify({ streamId, type: 'error', value: error }) })
  }

  end(streamId: string): void {
    this.emit('message', { data: JSON.stringify({ streamId, type: 'end' }) })
  }
}

/** One `server-response` envelope body. */
export function rpcResponse(value: unknown, ok = true): Response {
  return new Response(JSON.stringify({
    type: 'server-response',
    rpcId: 'x',
    result: ok ? { ok: true, value } : { ok: false, error: value },
  }), { status: 200, headers: { 'content-type': 'application/json' } })
}

/** The opening snapshot used by the scripted follow generations. */
export const SNAPSHOT: Extract<PeerFollowFrame, { type: 'snapshot' }> = {
  type: 'snapshot',
  target: { device: 'host', sessionId: 's1', exposure: 'debug' },
  header: { id: 's1', version: 1, createdAt: 0 },
  cursor: 0,
  state: {
    latch: 'idle', since: 0, source: 'host-latch', activeDescendants: 0,
    descendantsExact: true, pendingAsks: [],
  },
  records: [],
  hasMore: false,
}
