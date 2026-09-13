/**
 * enpoi: fork-only host half of the browser terminal surfaces. It registers
 * the fenced JSON API (open/close/list) and the one WebSocket upgrade that
 * streams PTY output and accepts input, resize, and kill frames. The trust
 * fence is the composition's `connection` service, the same one every other
 * browser-facing route uses, so the routes are reachable only from a trusted
 * same-host page.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { WebSocketServer } from 'ws'
import { TerminalHostError, TerminalRegistry, ensureSpawnHelper } from './pty.ts'
import {
  ENPOI_TERMINAL_API_PATH,
  ENPOI_TERMINAL_WS_PATH,
  TERMINAL_WS_UNKNOWN_KEY,
} from './shared.ts'
import type {
  TerminalApiMethod,
  TerminalApiResponse,
  TerminalClientFrame,
  TerminalClosePayload,
  TerminalListValue,
  TerminalOpenPayload,
  TerminalOpenValue,
} from './shared.ts'

/** Cordis function-plugin name. */
export const name = 'enpoi-terminal'

/** Required host services: the route carrier and the browser trust fence. */
export const inject = ['webServer', 'connection']

/** Trust surface consumed here; the browser-side connection package owns the full type. */
interface FencedConnection {
  requestRejection(request: IncomingMessage): 401 | 403 | undefined
}

/** The composition's connection service (typed locally: its package is browser-side). */
function connectionOf(ctx: Context): FencedConnection {
  return Reflect.get(ctx, 'connection') as FencedConnection
}

/** API request bodies are tiny JSON objects; anything larger is hostile. */
const MAX_BODY_BYTES = 64 * 1024

/** JSON response (no-store: terminal facts are live). */
function sendJson(res: ServerResponse, status: number, payload: TerminalApiResponse<unknown>): void {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(payload))
}

/** Collect a bounded request body as UTF-8 text; null past the ceiling (stream drained). */
async function readBoundedBody(req: IncomingMessage): Promise<string | null> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.byteLength
    if (size > MAX_BODY_BYTES) {
      req.resume()
      return null
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks, size).toString('utf8')
}

/** Refuse an upgrade before the handshake, so the browser sees the status. */
function rejectUpgrade(socket: Duplex, status: 401 | 403): void {
  const reason = status === 401 ? 'Unauthorized' : 'Forbidden'
  socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
  socket.destroy()
}

/** Narrow one socket message into a client frame; malformed frames are dropped. */
function parseClientFrame(raw: unknown): TerminalClientFrame | undefined {
  let value: unknown
  try {
    value = JSON.parse(typeof raw === 'string' ? raw : Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw))
  } catch {
    // A non-JSON frame is a client defect, not a server error: drop it.
    return undefined
  }
  if (typeof value !== 'object' || value === null) return undefined
  const frame = value as Record<string, unknown>
  if (frame['t'] === 'input' && typeof frame['data'] === 'string') return { t: 'input', data: frame['data'] }
  if (frame['t'] === 'resize' && typeof frame['cols'] === 'number' && typeof frame['rows'] === 'number') {
    return { t: 'resize', cols: frame['cols'], rows: frame['rows'] }
  }
  if (frame['t'] === 'kill') return { t: 'kill' }
  return undefined
}

/** One string field of an unvalidated payload. */
function stringField(payload: Record<string, unknown>, field: string, max = 512): string | undefined {
  const value = payload[field]
  return typeof value === 'string' && value.length > 0 && value.length <= max ? value : undefined
}

/** One numeric field of an unvalidated payload. */
function numberField(payload: Record<string, unknown>, field: string): number | undefined {
  const value = payload[field]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * Client plugin body: one PTY registry behind the fenced API and upgrade.
 * @param ctx - host root context carrying the route carrier and the trust fence.
 */
export function apply(ctx: Context): void {
  ensureSpawnHelper()
  const registry = new TerminalRegistry()
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false })

  const dispatch = (method: string, payload: Record<string, unknown>): unknown => {
    switch (method as TerminalApiMethod) {
      case 'open': {
        const key = stringField(payload, 'key')
        const sessionId = stringField(payload, 'sessionId')
        if (key === undefined || sessionId === undefined) {
          throw new TerminalHostError('bad-request', 'key and sessionId are required')
        }
        const input: TerminalOpenPayload = {
          key,
          sessionId,
          ...stringField(payload, 'cwd') === undefined ? {} : { cwd: stringField(payload, 'cwd') as string },
          ...numberField(payload, 'cols') === undefined ? {} : { cols: numberField(payload, 'cols') as number },
          ...numberField(payload, 'rows') === undefined ? {} : { rows: numberField(payload, 'rows') as number },
        }
        return registry.open(input) satisfies TerminalOpenValue
      }
      case 'close': {
        const key = stringField(payload, 'key')
        if (key === undefined) throw new TerminalHostError('bad-request', 'key is required')
        registry.close(key, 'client-close')
        return { key } satisfies TerminalClosePayload
      }
      case 'list':
        return { keys: registry.list(stringField(payload, 'sessionId')) } satisfies TerminalListValue
      default:
        throw new TerminalHostError('unknown-method', `unknown terminal API method "${method}"`, 404)
    }
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: ENPOI_TERMINAL_API_PATH,
    handler: async (req, res) => {
      const rejection = connectionOf(ctx).requestRejection(req)
      if (rejection !== undefined) {
        sendJson(res, rejection, { ok: false, error: { code: rejection === 401 ? 'unauthorized' : 'forbidden', message: 'refused by the browser trust fence' } })
        return
      }
      if (req.method !== 'POST') {
        res.statusCode = 405
        res.setHeader('allow', 'POST')
        res.end()
        return
      }
      const essence = String(req.headers['content-type']).split(';', 1)[0]?.trim().toLowerCase()
      if (essence !== 'application/json') {
        sendJson(res, 415, { ok: false, error: { code: 'unsupported-media-type', message: 'content-type must be application/json' } })
        return
      }
      const method = new URL(String(req.url), 'http://localhost').pathname
        .slice(ENPOI_TERMINAL_API_PATH.length).replace(/^\//, '')
      const body = await readBoundedBody(req)
      if (body === null) {
        sendJson(res, 413, { ok: false, error: { code: 'too-large', message: `body over ${MAX_BODY_BYTES} bytes` } })
        return
      }
      try {
        const payload = JSON.parse(body) as Record<string, unknown>
        sendJson(res, 200, { ok: true, value: dispatch(method, payload) })
      } catch (error) {
        if (error instanceof TerminalHostError) {
          sendJson(res, error.status, { ok: false, error: { code: error.code, message: error.message } })
          return
        }
        sendJson(res, 500, { ok: false, error: { code: 'internal', message: error instanceof Error ? error.message : String(error) } })
      }
    },
  }), `enpoi-terminal: POST ${ENPOI_TERMINAL_API_PATH}/<method>`)

  ctx.effect(() => ctx.webServer.registerUpgrade({
    path: ENPOI_TERMINAL_WS_PATH,
    handler: (req, socket, head) => {
      const rejection = connectionOf(ctx).requestRejection(req)
      if (rejection !== undefined) {
        rejectUpgrade(socket, rejection)
        return
      }
      const key = new URL(String(req.url), 'http://localhost').searchParams.get('key')
      wss.handleUpgrade(req, socket, head, (ws) => {
        if (key === null || !registry.attach(key, ws)) {
          ws.send(JSON.stringify({ t: 'error', message: `unknown terminal key "${key ?? ''}"` }))
          ws.close(TERMINAL_WS_UNKNOWN_KEY, 'unknown terminal key')
          return
        }
        let open = true
        ws.on('message', (raw: unknown) => {
          const frame = parseClientFrame(raw)
          if (frame !== undefined) registry.frame(key, frame)
        })
        const detach = (): void => {
          if (!open) return
          open = false
          registry.detach(key, ws)
        }
        ws.on('close', detach)
        ws.on('error', detach)
      })
    },
  }), `enpoi-terminal: ${ENPOI_TERMINAL_WS_PATH} WebSocket`)

  // Teardown kills every shell, so no process outlives the plugin.
  ctx.effect(() => () => {
    wss.close()
    registry.dispose()
  }, 'enpoi-terminal: process teardown')
}
