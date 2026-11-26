import { describe, expect, it } from 'vitest'
import { PeerBridgeError, PeerClient, type PeerFollowFrame, type PeerWebSocket } from '../src/peer-client.ts'
import { FakeSocket, rpcResponse, SNAPSHOT } from './helpers.ts'

describe('PeerClient envelope', () => {
  it('compares both digests without refusing the host and preserves its instance identity', async () => {
    const warnings: string[] = []
    const client = new PeerClient({
      endpoint: 'https://host', device: 'caller', schemaDigest: 'local-shape', harnessVersion: '1.0.0',
      onCompatibilityWarning: (message) => { warnings.push(message) },
      fetch: async (_input, init) => {
        expect(init?.body).toEqual(expect.stringContaining('local-shape'))
        return rpcResponse({ instanceId: 'boot-1', capabilities: ['shape-digest'], schemaDigest: 'remote-shape', methodsDigest: 'remote-methods' })
      },
    })
    expect(await client.handshake()).toMatchObject({ instanceId: 'boot-1' })
    expect(warnings).toEqual([expect.stringContaining('schemaDigest'), expect.stringContaining('methodsDigest')])
  })

  it('sends receipt, ready, job update, and export calls with their exact request fields', async () => {
    const sent: unknown[] = []
    const client = new PeerClient({
      endpoint: 'https://host', device: 'caller',
      fetch: async (_input, init) => {
        if (typeof init?.body !== 'string') throw new Error('missing request body')
        const body = JSON.parse(init.body) as { method: string; payload: { args: { request: Record<string, unknown> } } }
        sent.push([body.method, body.payload.args.request])
        return rpcResponse({})
      },
    })
    const target = { alias: 'scratch' }
    await client.receipt({ ...target, requestId: 'req-1', kind: 'create' })
    await client.ready(target)
    await client.jobUpdate({ ...target, requestId: 'req-2', jobId: 'job-1', fence: 2 })
    await client.exportList(target)
    await client.exportFetch({ ...target, path: 'note', maxBytes: 64 })
    expect(sent).toEqual([
      ['peer/receipt', { alias: 'scratch', requestId: 'req-1', kind: 'create' }],
      ['peer/ready', target],
      ['peer/jobUpdate', { alias: 'scratch', requestId: 'req-2', jobId: 'job-1', fence: 2 }],
      ['peer/exportList', target],
      ['peer/exportFetch', { alias: 'scratch', path: 'note', maxBytes: 64 }],
    ])
  })

  it('wraps unary calls in the SRC request envelope and decodes values', async () => {
    const bodies: Array<{ url: string; body: Record<string, unknown> }> = []
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push({ url: String(input), body: JSON.parse(String(init?.body)) as Record<string, unknown> })
      return rpcResponse({ target: { device: 'host', sessionId: 's1', exposure: 'debug' }, state: { latch: 'idle' }, cursor: 3 })
    }) as typeof fetch
    const client = new PeerClient({ endpoint: 'https://host:8443/', device: 'caller', fetch: fetchImpl })
    const value = await client.state({ kind: 'alias', alias: 'co-dev' })
    expect(value.cursor).toBe(3)
    expect(bodies[0]!.url).toBe('https://host:8443/api/peer/state')
    expect(bodies[0]!.body).toMatchObject({
      type: 'client-request',
      method: 'peer/state',
      payload: { args: { request: { target: { kind: 'alias', alias: 'co-dev' } } } },
    })
  })

  it('decodes structured peer failures and HTTP failures as target-unreachable', async () => {
    const failing = (async () => rpcResponse({ code: 'peer/not-paired', message: 'no pairing' }, false)) as typeof fetch
    const client = new PeerClient({ endpoint: 'https://host:8443', device: 'caller', fetch: failing })
    await expect(client.state({ kind: 'alias', alias: 'x' })).rejects.toMatchObject({ code: 'peer/not-paired' })

    const http500 = (async () => new Response('nope', { status: 500 })) as typeof fetch
    const dead = new PeerClient({ endpoint: 'https://host:8443', device: 'caller', fetch: http500 })
    await expect(dead.handshake()).rejects.toMatchObject({ code: 'peer/target-unreachable' })

    const network = (async () => { throw new Error('econnrefused') }) as typeof fetch
    const offline = new PeerClient({ endpoint: 'https://host:8443', device: 'caller', fetch: network })
    await expect(offline.handshake()).rejects.toMatchObject({ code: 'peer/target-unreachable' })
  })

  it('sends models and selectModel in the same envelope', async () => {
    const bodies: Array<{ url: string; body: Record<string, unknown> }> = []
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push({ url: String(input), body: JSON.parse(String(init?.body)) as Record<string, unknown> })
      return rpcResponse({ chains: [], models: [], selectableByThisAlias: { chains: [], models: [], requireZeroPrice: false, requireNoTraining: false, requireTools: false, allowSwitch: 'never' } })
    }) as typeof fetch
    const client = new PeerClient({ endpoint: 'https://host:8443', device: 'caller', fetch: fetchImpl })
    await client.models({ alias: 'co-dev', participant: { kind: 'peer', name: 'caller' }, filter: { zeroPrice: true }, cursor: 'c1', limit: 7 })
    await client.selectModel({
      target: { kind: 'alias', alias: 'co-dev' },
      participant: { kind: 'peer', name: 'caller' },
      requestId: 'sw-1',
      provider: 'antigravity',
      model: 'a',
      reasoningEffort: 'high',
    })
    expect(bodies.map(entry => entry.url)).toEqual([
      'https://host:8443/api/peer/models',
      'https://host:8443/api/peer/selectModel',
    ])
    expect(bodies[0]!.body).toMatchObject({
      method: 'peer/models',
      payload: { args: { request: { alias: 'co-dev', filter: { zeroPrice: true }, cursor: 'c1', limit: 7 } } },
    })
    expect(bodies[1]!.body).toMatchObject({
      method: 'peer/selectModel',
      payload: { args: { request: { requestId: 'sw-1', provider: 'antigravity', model: 'a', reasoningEffort: 'high' } } },
    })
  })

  it('reports the configured caller version and never a drifting literal', async () => {
    const requests: Record<string, unknown>[] = []
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { payload: { args: { request: Record<string, unknown> } } }
      requests.push(body.payload.args.request)
      return rpcResponse({ protocolVersion: 1, harnessVersion: 'host', schemaDigest: '', hostDevice: 'h', capabilities: [], pairings: [] })
    }) as typeof fetch
    const explicit = new PeerClient({ endpoint: 'https://host', device: 'caller', fetch: fetchImpl, harnessVersion: '9.9.9-caller' })
    await explicit.handshake()
    expect(requests[0]!.harnessVersion).toBe('9.9.9-caller')
    // The default comes from the installed identity, so it is a real version,
    // not the retired hardcoded '0.1.6-alpha.2' literal.
    const resolved = new PeerClient({ endpoint: 'https://host', device: 'caller', fetch: fetchImpl })
    await resolved.handshake()
    expect(requests[1]!.harnessVersion).not.toBe('0.1.6-alpha.2')
    expect(String(requests[1]!.harnessVersion)).toMatch(/^\d+\.\d+\.\d+/u)
  })

  it('sends Authorization when a token is configured', async () => {
    const headers: Array<Record<string, string>> = []
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      headers.push(init?.headers as Record<string, string>)
      return rpcResponse({ protocolVersion: 1, harnessVersion: 'x', schemaDigest: '', hostDevice: 'h', capabilities: [], pairings: [] })
    }) as typeof fetch
    const client = new PeerClient({ endpoint: 'https://host', device: 'caller', headers: { authorization: 'Bearer t' }, fetch: fetchImpl })
    await client.handshake()
    expect(headers[0]).toMatchObject({ authorization: 'Bearer t' })
  })
})

describe('PeerClient follow', () => {
  it('bounds explicit gap retries when snapshots repeat without forward progress', async () => {
    let generations = 0
    const client = new PeerClient({ endpoint: 'https://host', device: 'caller', backoff: { initialMs: 1, maxMs: 1, factor: 1 },
      webSocket: () => new FakeSocket((socket, id) => {
        generations += 1
        socket.frame(id, { ...SNAPSHOT, cursor: 1 })
        socket.frame(id, { type: 'gap', fromSeq: 2, toSeq: 2, reason: 'idle-timeout', resync: 'refollow-and-page' })
      }),
    })
    await expect((async () => {
      for await (const frame of client.follow({ target: { kind: 'alias', alias: 'scratch' } }, AbortSignal.timeout(1000))) expect(frame.type).not.toBe('end')
    })()).rejects.toMatchObject({ code: 'peer/gap' })
    expect(generations).toBe(4)
  })
  it('acks each consumed item in order, skips the gap, then repairs on a new generation', async () => {
    const acks: unknown[] = []
    const calls: string[] = []
    let generation = 0
    const client = new PeerClient({
      endpoint: 'https://host', device: 'caller', backoff: { initialMs: 1, maxMs: 1, factor: 1 },
      fetch: async () => { calls.push('page'); return rpcResponse({ records: [{ seq: 2, time: 0, type: 'user/message', data: {} }], hasMore: false }) },
      webSocket: () => {
        const current = ++generation
        return new FakeSocket((socket, id) => {
          calls.push(`open-${current}`)
          socket.frame(id, { ...SNAPSHOT, cursor: current === 1 ? 1 : 3 })
        }, (socket, id, ack) => {
          acks.push(ack)
          if (current === 1 && acks.length === 1) socket.frame(id, { type: 'state', state: SNAPSHOT.state, cursor: 1 })
          else if (current === 1) {
            socket.emit('message', { data: JSON.stringify({ type: 'item', streamId: id, value: { type: 'gap', fromSeq: 2, toSeq: 2, reason: 'queue-overflow', resync: 'refollow-and-page' } }) })
            socket.emit('message', { data: JSON.stringify({ type: 'error', streamId: id, error: { code: 'peer/gap' } }) })
          } else socket.frame(id, { type: 'end', reason: 'target-detached' })
        })
      },
    })
    const frames: string[] = []
    for await (const frame of client.follow({ target: { kind: 'alias', alias: 'scratch' } }, AbortSignal.timeout(150))) {
      frames.push(frame.type)
      if (frame.type === 'end') break
    }
    expect(frames).toEqual(['snapshot', 'state', 'gap', 'event', 'snapshot', 'end'])
    expect(acks).toEqual([{ type: 'ack', frame: 1 }, { type: 'ack', frame: 2 }, { type: 'ack', frame: 1 }])
    expect(calls).toEqual(['open-1', 'open-2', 'page'])
  })

  it('surfaces follow-capacity instead of reopening immediately', async () => {
    let opens = 0
    const client = new PeerClient({ endpoint: 'https://host', device: 'caller', maxReconnects: 0,
      webSocket: () => new FakeSocket((socket, id) => {
        opens += 1
        socket.emit('message', { data: JSON.stringify({ type: 'error', streamId: id, error: { code: 'peer/unavailable', details: { reason: 'follow-capacity' } } }) })
      }),
    })
    await expect(client.follow({ target: { kind: 'alias', alias: 'scratch' } }, AbortSignal.timeout(150)).next()).rejects.toMatchObject({ message: expect.stringContaining('back off') })
    expect(opens).toBe(1)
  })
  it('streams frames and surfaces stream error frames', async () => {
    const sockets: FakeSocket[] = []
    const client = new PeerClient({
      endpoint: 'https://host',
      device: 'caller',
      fetch: (async () => rpcResponse({})) as typeof fetch,
      webSocket: (): PeerWebSocket => {
        const socket = new FakeSocket((self, streamId) => {
          self.frame(streamId, SNAPSHOT)
          self.end(streamId)
        })
        sockets.push(socket)
        return socket
      },
      maxReconnects: 0,
    })
    const controller = new AbortController()
    const frames: PeerFollowFrame[] = []
    for await (const frame of client.followOnce({ target: { kind: 'alias', alias: 'x' } }, controller.signal)) frames.push(frame)
    expect(frames.map(frame => frame.type)).toEqual(['snapshot'])
    expect(sockets[0]!.sent[0]).toContain('peer/follow')
  })

  it('reconnects with backoff after a dead generation', async () => {
    let generation = 0
    const client = new PeerClient({
      endpoint: 'https://host',
      device: 'caller',
      fetch: (async () => rpcResponse({})) as typeof fetch,
      backoff: { initialMs: 1, maxMs: 2, factor: 2 },
      webSocket: (): PeerWebSocket => {
        generation += 1
        const current = generation
        return new FakeSocket((self, streamId) => {
          if (current === 1) self.end(streamId)
          else {
            self.frame(streamId, SNAPSHOT)
            self.end(streamId)
          }
        })
      },
    })
    const controller = new AbortController()
    let snapshots = 0
    for await (const frame of client.follow({ target: { kind: 'alias', alias: 'x' } }, controller.signal)) {
      if (frame.type === 'snapshot') snapshots += 1
      if (snapshots === 1) controller.abort()
    }
    expect(generation).toBe(2)
    expect(snapshots).toBe(1)
  })

  it('repairs a durable hole through peer.page before the new snapshot', async () => {
    let generation = 0
    const pages: unknown[] = []
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { method: string; payload: { args: { request: unknown } } }
      expect(body.method).toBe('peer/page')
      pages.push(body.payload.args.request)
      return rpcResponse({ records: [{ seq: 6, time: 1, type: 'assistant/message', data: {} }], hasMore: false })
    }) as typeof fetch
    const client = new PeerClient({
      endpoint: 'https://host',
      device: 'caller',
      fetch: fetchImpl,
      backoff: { initialMs: 1, maxMs: 2, factor: 2 },
      webSocket: (): PeerWebSocket => {
        generation += 1
        const current = generation
        return new FakeSocket((self, streamId) => {
          if (current === 1) {
            self.frame(streamId, { ...SNAPSHOT, cursor: 5 })
            self.end(streamId)
          } else {
            self.frame(streamId, {
              ...SNAPSHOT,
              cursor: 8,
              records: [{ seq: 8, time: 2, type: 'assistant/message', data: {} }],
            })
            self.end(streamId)
          }
        })
      },
    })
    const controller = new AbortController()
    const seen: string[] = []
    for await (const frame of client.follow({ target: { kind: 'alias', alias: 'x' } }, controller.signal)) {
      if (frame.type === 'event') seen.push(`event:${String(frame.record.seq)}`)
      if (frame.type === 'snapshot') seen.push(`snapshot:${String(frame.cursor)}`)
      if (seen.includes('snapshot:8')) controller.abort()
    }
    expect(seen).toEqual(['snapshot:5', 'event:6', 'snapshot:8'])
    expect(pages).toHaveLength(1)
  })

  it('gives up with target-unreachable after maxReconnects', async () => {
    const client = new PeerClient({
      endpoint: 'https://host:9',
      device: 'caller',
      fetch: (async () => rpcResponse({})) as typeof fetch,
      backoff: { initialMs: 1, maxMs: 2, factor: 2 },
      maxReconnects: 1,
      webSocket: (): PeerWebSocket => new FakeSocket((self, streamId) => { self.end(streamId) }),
    })
    const controller = new AbortController()
    await expect(async () => {
      for await (const _frame of client.follow({ target: { kind: 'alias', alias: 'x' } }, controller.signal)) {
        // drain
      }
    }).rejects.toMatchObject({ code: 'peer/target-unreachable', endpoint: 'https://host:9' })
  })

  it('rethrows version skew instead of retrying', async () => {
    let generation = 0
    const client = new PeerClient({
      endpoint: 'https://host',
      device: 'caller',
      fetch: (async () => rpcResponse({})) as typeof fetch,
      backoff: { initialMs: 1, maxMs: 2, factor: 2 },
      webSocket: (): PeerWebSocket => {
        generation += 1
        return new FakeSocket((self, streamId) => {
          self.fail(streamId, { code: 'peer/version-skew', message: 'skew' })
        })
      },
    })
    const controller = new AbortController()
    await expect(async () => {
      for await (const _frame of client.follow({ target: { kind: 'alias', alias: 'x' } }, controller.signal)) {
        // drain
      }
    }).rejects.toThrowError(PeerBridgeError)
    expect(generation).toBe(1)
  })

  it('rethrows caller-terminal peer errors instead of retrying at backoff cadence', async () => {
    for (const code of ['peer/not-paired', 'peer/not-found', 'peer/forbidden']) {
      let generation = 0
      const client = new PeerClient({
        endpoint: 'https://host',
        device: 'caller',
        fetch: (async () => rpcResponse({})) as typeof fetch,
        backoff: { initialMs: 1, maxMs: 2, factor: 2 },
        webSocket: (): PeerWebSocket => {
          generation += 1
          return new FakeSocket((self, streamId) => {
            self.fail(streamId, { code, message: 'terminal' })
          })
        },
      })
      const controller = new AbortController()
      await expect(async () => {
        for await (const _frame of client.follow({ target: { kind: 'alias', alias: 'x' } }, controller.signal)) {
          // drain
        }
      }).rejects.toMatchObject({ code })
      expect(generation).toBe(1)
    }
  })

  it('warns with the missing range when a repair cannot prove contiguity', async () => {
    const warnings: Array<{ from: number; to: number }> = []
    let generation = 0
    const fetchImpl = (async () => rpcResponse({
      records: [{ seq: 7, time: 1, type: 'assistant/message', data: {} }],
      hasMore: false,
    })) as typeof fetch
    const client = new PeerClient({
      endpoint: 'https://host',
      device: 'caller',
      fetch: fetchImpl,
      backoff: { initialMs: 1, maxMs: 2, factor: 2 },
      onWarning: hole => { warnings.push(hole) },
      webSocket: (): PeerWebSocket => {
        generation += 1
        const current = generation
        return new FakeSocket((self, streamId) => {
          if (current === 1) {
            self.frame(streamId, { ...SNAPSHOT, cursor: 5 })
            self.end(streamId)
          } else {
            self.frame(streamId, {
              ...SNAPSHOT,
              cursor: 8,
              records: [{ seq: 8, time: 2, type: 'assistant/message', data: {} }],
            })
            self.end(streamId)
          }
        })
      },
    })
    const controller = new AbortController()
    const seen: string[] = []
    for await (const frame of client.follow({ target: { kind: 'alias', alias: 'x' } }, controller.signal)) {
      if (frame.type === 'event') seen.push(`event:${String(frame.record.seq)}`)
      if (frame.type === 'snapshot') seen.push(`snapshot:${String(frame.cursor)}`)
      if (seen.includes('snapshot:8')) controller.abort()
    }
    expect(seen).toEqual(['snapshot:5', 'event:7', 'snapshot:8'])
    expect(warnings).toEqual([{ from: 6, to: 7 }])
  })
})
