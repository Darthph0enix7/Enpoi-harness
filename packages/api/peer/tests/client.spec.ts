import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { afterEach, describe, expect, it } from 'vitest'
import WebSocket, { WebSocketServer } from 'ws'
import { PeerClient } from '../src/client.ts'
import type { PeerFollowFrame } from '../src/types.ts'

const servers: Server[] = []
const sockets: WebSocketServer[] = []

afterEach(async () => {
  await Promise.all(sockets.splice(0).map(server => new Promise<void>((resolve) => {
    for (const client of server.clients) client.terminate()
    server.close(() => { resolve() })
  })))
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve) => {
    server.close(() => { resolve() })
  })))
})

function envelope(value: unknown): string {
  return JSON.stringify({ result: { ok: true, value } })
}

function failure(code: string, message: string): string {
  return JSON.stringify({ result: { ok: false, error: { code, message, details: {} } } })
}

async function listen(server: Server): Promise<string> {
  servers.push(server)
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address() as AddressInfo
  return `http://127.0.0.1:${String(address.port)}`
}

describe('peer client', () => {
  it('speaks the unary envelope and maps target failures', async () => {
    const seen: string[] = []
    const origin = await listen(createServer((request, response) => {
      const chunks: Buffer[] = []
      request.on('data', chunk => chunks.push(chunk as Buffer))
      request.on('end', () => {
        seen.push(`${request.method ?? ''} ${request.url ?? ''}`)
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
          type: string
          rpcId: string
          method: string
          payload: { args: unknown }
        }
        expect(body.type).toBe('client-request')
        expect(body.method).toBe('peer/handshake')
        response.setHeader('content-type', 'application/json')
        response.end(envelope({
          protocolVersion: 1,
          harnessVersion: '0.1.6-alpha.2',
          schemaDigest: 'digest',
          hostDevice: 'serverlocal',
          capabilities: ['derived-latch'],
          pairings: [],
        }))
      })
    }))
    const client = new PeerClient({ endpoint: origin, device: 'laptop' })
    const handshake = await client.handshake()
    expect(handshake.hostDevice).toBe('serverlocal')
    expect(seen).toEqual(['POST /api/peer/handshake'])
  })

  it('restores structured peer failures from the wire', async () => {
    const origin = await listen(createServer((_request, response) => {
      response.setHeader('content-type', 'application/json')
      response.end(failure('peer/not-paired', 'alias "x" is not paired'))
    }))
    const client = new PeerClient({ endpoint: origin, device: 'laptop' })
    await expect(client.state({ kind: 'alias', alias: 'x' as never })).rejects.toThrow(RemoteError)
    try {
      await client.state({ kind: 'alias', alias: 'x' as never })
    } catch (error) {
      expect((error as RemoteError).code).toBe('peer/not-paired')
    }
    await expect(client.prompt({
      target: { kind: 'alias', alias: 'x' as never },
      participant: { kind: 'peer', name: 'laptop' },
      requestId: 'r1' as never,
      content: [{ type: 'text', text: 'hi' }],
    })).rejects.toThrow(/not paired/u)
  })

  it('reports target-unreachable when the host cannot be reached', async () => {
    const origin = await listen(createServer())
    // The listener closes before the call, so the connection is refused.
    await new Promise<void>((resolve) => {
      const server = servers.pop()
      server?.close(() => { resolve() })
    })
    const client = new PeerClient({
      endpoint: origin,
      device: 'laptop',
      backoff: { initialMs: 10, maxMs: 20, factor: 2 },
      maxReconnects: 1,
    })
    try {
      await client.state({ kind: 'alias', alias: 'x' as never })
      throw new Error('expected target-unreachable')
    } catch (error) {
      expect((error as RemoteError).code).toBe('peer/target-unreachable')
    }
  })

  it('streams one follow generation and repairs a hole through page', async () => {
    const frames: PeerFollowFrame[] = [
      {
        type: 'snapshot',
        target: { device: 'serverlocal', sessionId: 's1' as never, exposure: 'debug', alias: 'x' as never },
        header: { id: 's1' as never, version: 3, createdAt: 1 },
        cursor: 10 as never,
        state: {
          latch: 'idle',
          since: 1,
          source: 'derived',
          activeDescendants: 0,
          descendantsExact: true,
          pendingAsks: [],
        },
        records: [],
        hasMore: false,
      },
      {
        type: 'event',
        record: { seq: 11 as never, time: 2, type: 'turn/start', data: { turn: 1 } },
        cursor: 11 as never,
      },
      { type: 'end', reason: 'closed' },
    ]
    const server = createServer()
    const wss = new WebSocketServer({ server })
    sockets.push(wss)
    const streamIds: string[] = []
    wss.on('connection', (socket) => {
      socket.on('message', (raw) => {
        const text = Array.isArray(raw)
          ? Buffer.concat(raw).toString('utf8')
          : Buffer.isBuffer(raw)
            ? raw.toString('utf8')
            : Buffer.from(raw as ArrayBuffer).toString('utf8')
        const open = JSON.parse(text) as { type: string; streamId: string; endpoint: string }
        expect(open.type).toBe('open')
        expect(open.endpoint).toBe('peer/follow')
        streamIds.push(open.streamId)
        for (const frame of frames) {
          socket.send(JSON.stringify({ streamId: open.streamId, type: 'item', value: frame }))
        }
        socket.close()
      })
    })
    const origin = await listen(server)
    const client = new PeerClient({
      endpoint: origin,
      device: 'laptop',
      webSocket: (url: string) => new WebSocket(url),
    })
    const collected: PeerFollowFrame[] = []
    for await (const frame of client.followOnce({ target: { kind: 'alias', alias: 'x' as never } }, new AbortController().signal)) {
      collected.push(frame)
    }
    expect(collected.map(frame => frame.type)).toEqual(['snapshot', 'event', 'end'])
    expect(streamIds).toHaveLength(1)
  })

  it('fills a durable hole by paging backwards from the newer cut', async () => {
    const pages = [
      { records: [{ seq: 12, time: 1, type: 'turn/start', data: {} }], hasMore: true },
      { records: [{ seq: 11, time: 1, type: 'user/message', data: {} }], hasMore: false },
    ]
    let call = 0
    const origin = await listen(createServer((request, response) => {
      const chunks: Buffer[] = []
      request.on('data', chunk => chunks.push(chunk as Buffer))
      request.on('end', () => {
        expect(request.url).toBe('/api/peer/page')
        response.setHeader('content-type', 'application/json')
        response.end(envelope(pages[call++]))
      })
    }))
    const client = new PeerClient({ endpoint: origin, device: 'laptop' })
    const repaired: number[] = []
    for await (const frame of client.repairForward(
      { kind: 'alias', alias: 'x' as never },
      10,
      13,
      new AbortController().signal,
    )) {
      if (frame.type === 'event') repaired.push(frame.record.seq)
    }
    expect(repaired).toEqual([11, 12])
    expect(call).toBe(2)
  })
})
