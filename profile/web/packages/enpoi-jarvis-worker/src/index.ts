/** Exact model routing and a loopback, peer-only HTTP carrier. */
import { createRequire } from 'node:module'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { Readable, type Duplex } from 'node:stream'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-gateway'
import type {} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-tools'
import { REMOTE_STREAM_MUX_PATH } from '@deepseek-ai/dsh-api-gateway/stream-protocol'
import { PEER_WIRE_DESCRIPTORS, policyAllowsModel, withPeerAuth } from '@deepseek-ai/dsh-api-peer'
import type { PeerModelInfo, PeerRoutingService } from '@deepseek-ai/dsh-api-peer'
import { remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'
import Schema from '@deepseek-ai/schemastery'
/** The `ws` socket members this carrier uses. */
interface WsSocket {
  readonly readyState: number
  readonly bufferedAmount: number
  send(data: string): void
  terminate(): void
  close(): void
  on(event: 'error', listener: () => void): void
  on(event: 'message', listener: (data: { toString(): string }, isBinary: boolean) => void): void
  once(event: 'close', listener: () => void): void
}

/** The `ws` server members this carrier uses. */
interface WsServer {
  readonly clients: Iterable<WsSocket>
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, accept: (ws: WsSocket) => void): void
  close(done: () => void): void
}

// `ws` is CommonJS. Bundling it into this ES module breaks its `require('events')` calls at load,
// so it resolves at runtime through the release link `worker-release-links` creates beside this package.
// The members above are declared here so type checking needs no `ws` package on a clean checkout.
const { WebSocket, WebSocketServer } = createRequire(import.meta.url)('ws') as {
  WebSocket: { readonly OPEN: number }
  WebSocketServer: new (options: { noServer: true; maxPayload: number; perMessageDeflate: false }) => WsServer
}

const provider = 'jarvis-worker'
const maxBody = 256 * 1024
const maxStreamBuffer = 1024 * 1024
const unary = new Set(PEER_WIRE_DESCRIPTORS.filter(row => row.mode === 'unary').map(row => row.method.slice('peer.'.length)))

/** Deployment selects exactly one provider-local model and a loopback port. */
export interface Config { model: string; port: number }

/** Cordis name. */
export const name = 'enpoi-jarvis-worker'
/** Require the peer service before admitting HTTP. */
export const inject = ['llm', 'typertGateway', 'peerService', 'tools', 'mcpHeaderProvider', 'peerProfileIdentity', 'tokenMeter']
/** Reject a missing model or malformed listen port. */
export const Config: Schema<Config> = Schema.object({
  model: Schema.string().required().pattern(/^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/u),
  port: Schema.natural().min(0).max(65535).required(),
})

function routing(ctx: Context, model: string): PeerRoutingService {
  const describe = async (): Promise<PeerModelInfo | undefined> => {
    try {
      const info = await ctx.llm.resolveModelInfo(provider, model, AbortSignal.timeout(1000))
      return { provider, model, tools: info.tools ?? 'unknown', vision: 'unknown', zeroPrice: 'unknown',
        gated: 'unknown', trainsOnData: 'unknown', reasoningEfforts: [],
        ...(info.context === undefined ? {} : { contextWindow: info.context.contextWindow }) }
    } catch {
      return undefined
    }
  }
  const service: PeerRoutingService = {
    async evaluate(policy, selection) {
      if (selection.chain !== undefined) return { allowed: false, reason: 'chain-not-allowed', denied: selection.chain }
      const denied = `${selection.provider}/${selection.model}`
      if (!policyAllowsModel(policy, selection.provider, selection.model)) return { allowed: false, reason: 'model-not-allowed', denied }
      if (selection.provider !== provider || selection.model !== model) return { allowed: false, reason: 'unknown-route', denied }
      if (policy.requireZeroPrice === true) return { allowed: false, reason: 'price-unproven', denied }
      if (policy.requireNoTraining === true) return { allowed: false, reason: 'training-unproven', denied }
      if (selection.reasoningEffort !== undefined) return { allowed: false, reason: 'effort-not-allowed', denied }
      const info = await describe()
      if (info === undefined) return { allowed: false, reason: 'unknown-route', denied }
      if (info.tools !== true) return { allowed: false, reason: 'tools-unproven', denied }
      return { allowed: true, selection }
    },
    async discover(policy, request) {
      if (request.cursor !== undefined || !(await service.evaluate(policy, { provider, model })).allowed) return { models: [], chains: [] }
      const row = await describe()
      const filter = request.filter
      const visible = row !== undefined && filter?.zeroPrice === undefined && filter?.gated === undefined
        && filter?.tools !== false && (filter?.minContextWindow === undefined || (row.contextWindow ?? 0) >= filter.minContextWindow)
      return { models: visible ? [row] : [], chains: [] }
    },
  }
  return service
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function respond(res: ServerResponse, status: number, value: object): void {
  if (res.destroyed) return
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(value))
}

function allowedIngress(req: IncomingMessage): boolean {
  return /^127\.0\.0\.1(?::\d+)?$/u.test(req.headers.host ?? '') && req.headers.origin === undefined
}

function failure(error: unknown) {
  const remote = remoteErrorOf(error)
  return { code: remote?.code ?? 'gateway/internal', message: 'Worker peer request refused', details: remote?.details ?? {} }
}

async function request(ctx: Context, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = /^\/api\/peer\/([A-Za-z]+)$/u.exec(req.url ?? '')?.[1]
  if (req.method !== 'POST' || method === undefined || !unary.has(method)) { respond(res, 404, {}); return }
  if (typeof req.headers.authorization !== 'string') { respond(res, 401, {}); return }
  if (!allowedIngress(req)) {
    respond(res, 403, {}); return
  }
  const lifetime = new AbortController()
  res.once('close', () => lifetime.abort())
  const buf: Buffer[] = []
  let bytes = 0
  let rpcId: unknown = 'invalid'
  try {
    for await (const chunk of req) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
      bytes += buffer.length
      if (bytes > maxBody) { respond(res, 413, {}); return }
      buf.push(buffer)
    }
    const envelope = record(JSON.parse(Buffer.concat(buf).toString('utf8')))
    const args = record(record(envelope?.payload)?.args)
    if (envelope?.type !== 'client-request' || envelope.method !== `peer/${method}` || args === undefined
      || typeof envelope.rpcId !== 'string' || envelope.rpcId.length > 256) {
      respond(res, 400, {}); return
    }
    rpcId = envelope.rpcId
    const value = await withPeerAuth(req.headers.authorization, () => ctx.typertGateway.invoke({
      namespace: 'peer', method, args, signal: lifetime.signal,
    }))
    respond(res, 200, { type: 'server-response', rpcId, result: { ok: true, value } })
  } catch (error) {
    // Never echo transport/request values, causes, stack traces, or tool errors.
    respond(res, 200, { type: 'server-response', rpcId, result: { ok: false, error: failure(error) } })
  }
}

function follow(ctx: Context, req: IncomingMessage, ws: WsSocket): Promise<void> {
  const lifetime = new AbortController()
  const signal = AbortSignal.any([lifetime.signal, AbortSignal.timeout(180000)])
  let active: Promise<void> | undefined
  let streamId: string | undefined
  const acknowledgements = new Readable({ objectMode: true, highWaterMark: 16, read() {} })
  const opening = setTimeout(() => ws.terminate(), 5000).unref()
  function send(type: string, payload: object = {}): boolean {
    if (ws.readyState !== WebSocket.OPEN) return false
    const frame = JSON.stringify({ type, streamId, ...payload })
    if (Buffer.byteLength(frame) + ws.bufferedAmount > maxStreamBuffer) { ws.terminate(); return false }
    ws.send(frame)
    return true
  }
  ws.on('error', () => ws.terminate())
  signal.addEventListener('abort', () => ws.terminate(), { once: true })
  ws.on('message', (data, isBinary) => {
    let message: Record<string, unknown> | undefined
    try { if (!isBinary) message = record(JSON.parse(data.toString())) } catch { ws.terminate(); return }
    if (message?.type === 'cancel' && streamId !== undefined && message.streamId === streamId) { ws.terminate(); return }
    if (message?.type === 'item' && streamId !== undefined && message.streamId === streamId) {
      const ack = record(message.value)
      if (ack?.type !== 'ack' || !Number.isSafeInteger(ack.frame) || !acknowledgements.push({ type: 'ack', frame: ack.frame })) ws.terminate()
      return
    }
    if (active !== undefined || message?.type !== 'open' || message.endpoint !== 'peer/follow'
      || typeof message.streamId !== 'string' || message.streamId.length > 256) { ws.terminate(); return }
    const args = record(record(message.payload)?.args)
    if (args === undefined) { ws.terminate(); return }
    clearTimeout(opening)
    streamId = message.streamId
    active = withPeerAuth(req.headers.authorization, async () => {
      try {
        const stream = await ctx.typertGateway.stream({ namespace: 'peer', method: 'follow', args, signal, uplink: acknowledgements })
        for await (const value of stream) if (!send('item', { value })) return
        send('end')
      } catch (error) { send('error', { error: failure(error) }) }
      finally { if (ws.readyState === WebSocket.OPEN) ws.close() }
    }).catch(() => { ws.terminate() })
  })
  return new Promise(resolve => {
    ws.once('close', () => {
      clearTimeout(opening)
      lifetime.abort()
      acknowledgements.push(null)
      if (active === undefined) resolve()
      else void active.then(resolve)
    })
  })
}

/** Publish the worker route and bind only the peer namespace, never operator RPCs. */
export async function apply(ctx: Context, config: Config): Promise<void> {
  ctx.provide('peerRouting', routing(ctx, config.model))
  ctx.on('llm/stream', (options, next) => {
    if (options.provider !== provider || options.model !== config.model || options.chain !== undefined) {
      throw new Error('Jarvis worker refused a model route other than its pinned route')
    }
    return next()
  }, { prepend: true })
  const requests = new Set<Promise<void>>()
  const server = createServer({ requestTimeout: 10000, headersTimeout: 5000 }, (req, res) => {
    const pending = request(ctx, req, res).catch(() => { res.destroy() })
    requests.add(pending)
    void pending.then(() => { requests.delete(pending) })
  })
  server.maxConnections = 16
  server.setTimeout(10000, socket => socket.destroy())
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024, perMessageDeflate: false })
  const followers = new Set<Promise<void>>()
  server.on('upgrade', (req, socket, head) => {
    if (req.url !== REMOTE_STREAM_MUX_PATH || !allowedIngress(req) || typeof req.headers.authorization !== 'string' || followers.size >= 4) {
      socket.destroy(); return
    }
    sockets.handleUpgrade(req, socket, head, ws => {
      const done = follow(ctx, req, ws)
      followers.add(done)
      void done.then(() => { followers.delete(done) })
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(config.port, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  const address = server.address()
  if (address !== null && typeof address === 'object') ctx.provide('jarvisWorkerPort', address.port)
  ctx.effect(() => async () => {
    const unlisten = new Promise<void>(resolve => {
      server.close(() => { resolve() })
      server.closeAllConnections()
    })
    for (const ws of sockets.clients) ws.terminate()
    await Promise.all([unlisten, new Promise<void>(resolve => { sockets.close(() => { resolve() }) }), ...followers, ...requests])
  }, 'jarvis worker peer carrier')
}
