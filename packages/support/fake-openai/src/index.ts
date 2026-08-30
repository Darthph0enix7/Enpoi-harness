/**
 * Synthetic OpenAI-compatible fake provider proxy for keypool matrix tests.
 *
 * Zero-dependency Node http server with per-key quota windows, real
 * rate-limit headers, and programmatic scenario overrides for 429 / 500 /
 * mid-stream failures. Intended for vitest in-process use: `createFakeOpenAI`
 * binds an OS-chosen loopback port, serves `GET /v1/models` and
 * `POST /v1/chat/completions`, and exposes `setScenario` / `resetKey` so
 * matrix tests can exhaust one identity, rotate, and verify repromotion
 * without hitting a real gateway.
 *
 * @module @deepseek-ai/dsh-fake-openai
 */

import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { isIP, type AddressInfo } from 'node:net'

/** Limits for one fake key. `requests` per `windowMs` window. */
export interface FakeKeyLimits {
  /** Maximum requests allowed per window; omission means no limit. */
  requests?: number
  /** Window duration in milliseconds; defaults to 60_000 when requests is set. */
  windowMs?: number
  /** Optional header name hint for reset; unused but kept for spec parity. */
  resetHeader?: string
}

/** One key known to the fake proxy. */
export interface FakeKeyConfig {
  /** Stable identity used by `setScenario` / `resetKey`. */
  id: string
  /** Bearer token value expected at `Authorization: Bearer <key>`. */
  key: string
  /** Quota window for this key. */
  limits?: FakeKeyLimits
}

/** Scenario override for a single key. Persists until `resetKey` / `resetAll`. */
export interface FakeScenario {
  /** Remaining requests before quota (0 forces next request to 429). */
  remaining?: number
  /** Milliseconds until the quota window resets. */
  resetAfterMs?: number
  /** Failure mode to inject on the next matching request(s). */
  failMode?: '429' | '500' | '503' | '529' | 'mid-stream'
  /** JSON body to return for error modes; defaults to a provider-faithful shape. */
  errorBody?: unknown
}

/** Options for {@link createFakeOpenAI}. */
export interface FakeOpenAIOptions {
  /** Loopback host; defaults to 127.0.0.1. */
  host?: string
  /** TCP port; 0 selects an OS-assigned port. */
  port?: number
  /** Keys the proxy recognises. */
  keys: FakeKeyConfig[]
  /** Models returned by `GET /v1/models`; defaults to a small OpenAI + DeepSeek set. */
  models?: string[]
}

/** Captured request for test assertions. */
export interface FakeRequestRecord {
  /** One-based index among POST /v1/chat/completions requests. */
  readonly attempt: number
  /** Request path. */
  readonly path: string
  /** Detached request headers. */
  readonly headers: Readonly<Record<string, string | string[] | undefined>>
  /** Parsed JSON body, or undefined when the body was empty or not JSON. */
  readonly body: unknown
  /** Matched key id, or undefined for 401s. */
  readonly keyId?: string
  /** Response HTTP status sent. */
  status: number
  /** Whether this request was served as SSE streaming. */
  streaming: boolean
}

/** Live fake proxy handle returned by {@link createFakeOpenAI}. */
export interface FakeOpenAIHandle {
  /** Base URL without trailing slash, e.g. `http://127.0.0.1:3456`. */
  readonly url: string
  /** Same as {@link url}; alias for ergonomics. */
  readonly baseURL: string
  /** Bound port. */
  readonly port: number
  /** Live request records in arrival order (only POST chat/completions). */
  readonly requests: readonly FakeRequestRecord[]
  /** Override behaviour for one key. */
  setScenario(keyId: string, scenario: FakeScenario): void
  /** Clear per-key count, window, and scenario. `keyId` undefined resets all. */
  resetKey(keyId?: string): void
  /** Alias for `resetKey()` with no argument. */
  resetAll(): void
  /** Stop accepting requests and force-close open connections. */
  close(): Promise<void>
}

interface KeyState {
  config: FakeKeyConfig
  count: number
  windowStart: number
  scenario: FakeScenario | undefined
}

const DEFAULT_MODELS = ['gpt-4.1', 'gpt-4o', 'deepseek-v4-flash', 'deepseek-chat']
const DEFAULT_WINDOW_MS = 60_000

function pickHost(host: string | undefined): string {
  const h = host ?? '127.0.0.1'
  if (h.length === 0) throw new Error('fake-openai: host must not be empty')
  return h
}

function pickPort(port: number | undefined): number {
  const p = port ?? 0
  if (!Number.isInteger(p) || p < 0 || p > 65535) throw new Error('fake-openai: port must be an integer 0..65535')
  return p
}

function assertKeys(keys: FakeKeyConfig[]): void {
  if (!Array.isArray(keys) || keys.length === 0) throw new Error('fake-openai: keys must be a non-empty array')
  const ids = new Set<string>()
  const tokens = new Set<string>()
  for (const k of keys) {
    if (typeof k.id !== 'string' || k.id.length === 0) throw new Error('fake-openai: each key needs a non-empty id')
    if (typeof k.key !== 'string' || k.key.length === 0) throw new Error(`fake-openai: key "${k.id}" needs a non-empty token`)
    if (ids.has(k.id)) throw new Error(`fake-openai: duplicate key id "${k.id}"`)
    if (tokens.has(k.key)) throw new Error('fake-openai: duplicate key token')
    ids.add(k.id)
    tokens.add(k.key)
    if (k.limits?.requests !== undefined) {
      if (!Number.isInteger(k.limits.requests) || k.limits.requests < 0) throw new Error(`fake-openai: key "${k.id}" limits.requests must be an integer >=0`)
    }
    if (k.limits?.windowMs !== undefined) {
      if (!Number.isInteger(k.limits.windowMs) || k.limits.windowMs <= 0) throw new Error(`fake-openai: key "${k.id}" limits.windowMs must be a positive integer`)
    }
  }
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.from(chunk as Uint8Array))
  const body = Buffer.concat(chunks).toString('utf8')
  if (body.length === 0) return undefined
  try {
    return JSON.parse(body)
  } catch {
    return undefined
  }
}

function jsonResponse(response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const payload = JSON.stringify(body)
  response.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), ...headers })
  response.end(payload)
}

function quotaHeadersFor(state: KeyState, resetAfterMs: number, now: number): Record<string, string> {
  const requests = state.config.limits?.requests
  const limitHeader = requests !== undefined ? String(requests) : '100'
  const seconds = Math.max(1, Math.ceil(resetAfterMs / 1000))
  const resetIso = new Date(now + resetAfterMs).toISOString()
  return {
    'x-ratelimit-remaining-requests': '0',
    'x-ratelimit-limit-requests': limitHeader,
    'retry-after': String(seconds),
    'x-ratelimit-reset-requests': resetIso,
    // Also provide OpenAI's generic retry-after header
    'retry-after-ms': String(resetAfterMs),
  }
}

function sseHeaders(response: ServerResponse): void {
  response.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    'connection': 'keep-alive',
  })
  response.flushHeaders()
}

function writeSseEvent(response: ServerResponse, payload: unknown): void {
  response.write(`data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n\n`)
}

/**
 * Create and start a synthetic OpenAI fake provider proxy.
 *
 * ```ts
 * const fake = await createFakeOpenAI({
 *   port: 0,
 *   keys: [
 *     { id: 'pri-1', key: 'sk-pri-1', limits: { requests: 2, windowMs: 60_000 } },
 *     { id: 'pri-2', key: 'sk-pri-2', limits: { requests: 10, windowMs: 60_000 } },
 *   ],
 * })
 * // POST /v1/chat/completions with Authorization: Bearer sk-pri-1 now enforces quota.
 * fake.setScenario('pri-1', { failMode: '429', resetAfterMs: 46_000 })
 * fake.resetKey('pri-1')
 * await fake.close()
 * ```
 *
 * @param options - listener, keys, and model catalog.
 * @returns the listening handle.
 */
export async function createFakeOpenAI(options: FakeOpenAIOptions): Promise<FakeOpenAIHandle> {
  const host = pickHost(options.host)
  const port = pickPort(options.port)
  assertKeys(options.keys)
  const models = options.models ?? DEFAULT_MODELS

  const states = new Map<string, KeyState>()
  const tokenToId = new Map<string, string>()
  for (const k of options.keys) {
    states.set(k.id, { config: k, count: 0, windowStart: 0, scenario: undefined })
    tokenToId.set(k.key, k.id)
  }

  const requests: FakeRequestRecord[] = []
  let completionsAttempt = 0

  const server: Server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://fake.invalid')
    const path = url.pathname

    // GET /v1/models and GET /models
    if (request.method === 'GET' && (path === '/v1/models' || path === '/models' || path.endsWith('/models'))) {
      const nowSec = Math.floor(Date.now() / 1000)
      const data = models.map(id => ({ id, object: 'model', created: nowSec, owned_by: 'fake' }))
      jsonResponse(response, 200, { object: 'list', data })
      return
    }

    // Only POST /v1/chat/completions and /chat/completions are handled as chat completions;
    // other routes/methods get 404/405.
    const isChatCompletions = path.endsWith('/chat/completions')
    if (!isChatCompletions) {
      jsonResponse(response, 404, { error: { code: 'not_found', message: `No route for ${request.method} ${path}` } })
      return
    }
    if (request.method !== 'POST') {
      response.writeHead(405, { allow: 'POST' })
      response.end()
      return
    }

    const headers: Record<string, string | string[] | undefined> = { ...request.headers }
    const auth = request.headers.authorization
    const token = typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice(7) : undefined
    const keyId = token !== undefined ? tokenToId.get(token) : undefined
    const state = keyId !== undefined ? states.get(keyId) : undefined

    const body = await readJsonBody(request)
    const bodyObj = body as Record<string, unknown> | undefined
    const streaming = bodyObj?.stream === true
    const model = typeof bodyObj?.model === 'string' ? bodyObj.model as string : (models[0] ?? 'gpt-4.1')

    completionsAttempt += 1
    const record: FakeRequestRecord = {
      attempt: completionsAttempt,
      path,
      headers,
      body,
      ...keyId === undefined ? {} : { keyId },
      status: 200,
      streaming,
    }
    requests.push(record)

    // Auth check
    if (state === undefined) {
      record.status = 401
      jsonResponse(response, 401, { error: { code: 'invalid_api_key', message: 'Invalid API key' } })
      return
    }

    const now = Date.now()
    // Window reset logic for per-key limits (before scenario override, so scenario can still force 429)
    const limits = state.config.limits
    const windowMs = limits?.windowMs ?? DEFAULT_WINDOW_MS
    const maxRequests = limits?.requests
    if (maxRequests !== undefined) {
      if (state.windowStart === 0) state.windowStart = now
      else if (now - state.windowStart >= windowMs) {
        state.windowStart = now
        state.count = 0
      }
    }

    // Scenario override takes precedence
    const scenario = state.scenario
    if (scenario !== undefined) {
      // remaining === 0 without explicit failMode also triggers 429
      const shouldQuota = scenario.failMode === '429'
        || (scenario.remaining !== undefined && scenario.remaining <= 0)
      if (shouldQuota) {
        const resetAfterMs = scenario.resetAfterMs ?? (state.windowStart ? Math.max(0, state.windowStart + windowMs - now) : 60_000)
        const secs = Math.max(1, Math.ceil(resetAfterMs / 1000))
        const headersOut = quotaHeadersFor(state, resetAfterMs, now)
        record.status = 429
        const bodyOut = scenario.errorBody ?? { error: { code: 'insufficient_quota', message: `Rate limit exceeded. Resets in ${secs}sec` } }
        jsonResponse(response, 429, bodyOut, headersOut)
        return
      }
      if (scenario.failMode === '500') {
        record.status = 500
        const bodyOut = scenario.errorBody ?? { error: { code: 'server_error', message: 'Internal server error' } }
        jsonResponse(response, 500, bodyOut)
        return
      }
      if (scenario.failMode === '503') {
        record.status = 503
        const bodyOut = scenario.errorBody ?? { error: { code: 'model_capacity', message: 'model is overloaded: server is busy, capacity exceeded (503)' } }
        jsonResponse(response, 503, bodyOut)
        return
      }
      if (scenario.failMode === '529') {
        record.status = 529
        const bodyOut = scenario.errorBody ?? { error: { code: 'model_capacity', message: 'model_capacity overloaded: server is busy (529)' } }
        jsonResponse(response, 529, bodyOut)
        return
      }
      if (scenario.failMode === 'mid-stream') {
        // Mid-stream failure: stream a couple of SSE chunks then abort transport.
        // This exercises the harness commit barrier (first non-usage chunk) and
        // ensures success was already recorded before the mid-stream error.
        if (!streaming) {
          // For non-streaming callers, synthesize a truncated JSON then close
          record.status = 200
          record.streaming = true
          sseHeaders(response)
          writeSseEvent(response, { id: `chatcmpl-fake-${Date.now()}`, object: 'chat.completion.chunk', created: Math.floor(now / 1000), model, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] })
          writeSseEvent(response, { id: `chatcmpl-fake-${Date.now()}`, object: 'chat.completion.chunk', created: Math.floor(now / 1000), model, choices: [{ index: 0, delta: { content: 'hello' }, finish_reason: null }] })
          // After a short delay, destroy transport to simulate provider cutoff
          setTimeout(() => {
            try { response.destroy() } catch { /* ignore */ }
          }, 15)
          return
        }
        record.status = 200
        sseHeaders(response)
        writeSseEvent(response, { id: `chatcmpl-fake-${Date.now()}`, object: 'chat.completion.chunk', created: Math.floor(now / 1000), model, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] })
        writeSseEvent(response, { id: `chatcmpl-fake-${Date.now()}`, object: 'chat.completion.chunk', created: Math.floor(now / 1000), model, choices: [{ index: 0, delta: { content: 'hello' }, finish_reason: null }] })
        setTimeout(() => {
          try { response.destroy() } catch { /* ignore */ }
        }, 15)
        return
      }
      // If scenario specifies remaining >0 without failMode, fall through to normal handling but respect remaining as capacity hint
      if (scenario.remaining !== undefined && scenario.remaining > 0) {
        // Allow one successful request and decrement remaining
        // (tests use setScenario to preload quota state, not to enforce sliding window)
      }
    }

    // Per-key quota enforcement (when not overridden by scenario)
    if (maxRequests !== undefined) {
      if (state.count >= maxRequests) {
        const resetAfterMs = Math.max(0, state.windowStart + windowMs - now)
        const secs = Math.max(1, Math.ceil(resetAfterMs / 1000))
        const headersOut = quotaHeadersFor(state, resetAfterMs, now)
        record.status = 429
        jsonResponse(response, 429, { error: { code: 'insufficient_quota', message: `Rate limit exceeded. Resets in ${secs}sec` } }, headersOut)
        return
      }
      // Also respect scenario.remaining when it indicates exhausted quota via window
      if (scenario?.remaining === 0) {
        const resetAfterMs = scenario.resetAfterMs ?? Math.max(0, state.windowStart + windowMs - now)
        const secs = Math.max(1, Math.ceil(resetAfterMs / 1000))
        const headersOut = quotaHeadersFor(state, resetAfterMs, now)
        record.status = 429
        jsonResponse(response, 429, { error: { code: 'insufficient_quota', message: `Rate limit exceeded. Resets in ${secs}sec` } }, headersOut)
        return
      }
    }

    // Success: advance window counter
    if (maxRequests !== undefined) {
      if (state.windowStart === 0) state.windowStart = now
      state.count += 1
    } else if (scenario?.remaining !== undefined) {
      // For scenario-driven remaining, decrement
      scenario.remaining = Math.max(0, (scenario.remaining as number) - 1)
    }

    // Emit success response
    const created = Math.floor(now / 1000)
    const chatId = `chatcmpl-fake-${now}-${Math.random().toString(36).slice(2, 8)}`
    if (streaming) {
      record.status = 200
      sseHeaders(response)
      // role delta
      writeSseEvent(response, { id: chatId, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] })
      // content delta
      writeSseEvent(response, { id: chatId, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: { content: 'hello' }, finish_reason: null }] })
      // finish
      writeSseEvent(response, { id: chatId, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } })
      writeSseEvent(response, '[DONE]')
      response.end()
      return
    }
    record.status = 200
    jsonResponse(response, 200, {
      id: chatId,
      object: 'chat.completion',
      created,
      model,
      choices: [{ index: 0, message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
    })
  })

  let closing: Promise<void> | undefined
  const close = (): Promise<void> => (closing ??= new Promise((resolveClose) => {
    server.close(() => { resolveClose() })
    server.closeAllConnections()
  }))

  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(port, host, () => {
      server.off('error', rejectListen)
      resolveListen()
    })
  })

  const address = server.address() as AddressInfo
  const advertisedHost = isIP(host) === 6 ? `[${host}]` : host
  const boundUrl = `http://${advertisedHost}:${address.port}`

  const handle: FakeOpenAIHandle = {
    url: boundUrl,
    baseURL: boundUrl,
    port: address.port,
    requests,
    setScenario(keyId, scenario) {
      const st = states.get(keyId)
      if (st === undefined) throw new Error(`fake-openai: unknown key id "${keyId}"`)
      st.scenario = { ...scenario }
    },
    resetKey(keyId) {
      if (keyId === undefined) {
        for (const st of states.values()) {
          st.count = 0
          st.windowStart = 0
          st.scenario = undefined
        }
        return
      }
      const st = states.get(keyId)
      if (st === undefined) throw new Error(`fake-openai: unknown key id "${keyId}"`)
      st.count = 0
      st.windowStart = 0
      st.scenario = undefined
    },
    resetAll() {
      for (const st of states.values()) {
        st.count = 0
        st.windowStart = 0
        st.scenario = undefined
      }
    },
    close,
  }

  return handle
}

/** Convenience re-export for tests that import the handle type. */
export type { FakeOpenAIHandle as FakeHandle }
