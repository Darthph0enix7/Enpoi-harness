/** Host registry and HTTP adapter for generic Connection RPC channels. */

import { createHash } from 'node:crypto'
import { Context, Service } from '@deepseek-ai/cordis'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type { PeerScope } from '@deepseek-ai/dsh-typert-protocol'
import {
  RpcId,
  type ClientRequest,
  type RpcId as RpcIdType,
} from './rpc.ts'
import { clientRequestSchema } from './rpc-schema.ts'
import { bridge } from './http-bridge.ts'
import { isTrustedApiRequest } from './api-request-trust.ts'
import { API_PATH } from './api-path.ts'
import type { BrowserAuth } from './browser-auth.ts'
import { OperatorPeer } from './operator-peer.ts'
import type {
  PeerAdmission,
  ConnectionIndexRequest,
  ConnectionIndexResponse,
  ConnectionFetchRoute,
  ConnectionFetchHandler,
  HostConnectionFetch,
  ConnectionRpcAttachment,
  ConnectionRpcEndpointMatcher,
  ConnectionRpcFailure,
  ConnectionRpcHandler,
  ConnectionRpcResult,
  ConnectionRequestRejection,
  ConnectionTrustRequest,
  HostConnectionHandle,
  HostConnectionRpc,
} from './rpc.ts'

const INVALID_REQUEST_RPC_ID = RpcId('invalid-request')
const CHANNEL_PATTERN = /^\/[A-Za-z0-9._~-]+$/
const ENDPOINT_SEGMENT_PATTERN = /^[A-Za-z0-9_$.-]+$/
/** Highest number of RPC result validators one process retains for conditional reads. */
const RPC_VALIDATOR_LIMIT = 256

/** Last validator issued per endpoint-and-arguments key, so `Last-Modified` marks the result's last change. */
const rpcResultValidators = new Map<string, { etag: string; lastModified: Date }>()

interface ConnectionRpcInterceptor {
  readonly matches: ConnectionRpcEndpointMatcher
  readonly fetchHandler: ConnectionFetchHandler
}

interface RegisteredFetchRoute {
  readonly methods: ReadonlySet<string>
  readonly requestBody: ConnectionFetchRoute['requestBody']
  readonly fetch: ConnectionFetchRoute['fetch']
}

interface ConnectionServerResponse {
  readonly type: 'server-response'
  readonly rpcId: RpcIdType
  readonly result: ConnectionRpcResult<unknown>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Host Connection transport and RPC registrations. */
    connection: HostConnectionHandle
  }
}

/** Host Connection service whose channel registrations belong to the caller fiber. */
export class HostConnectionService extends Service implements HostConnectionHandle {
  /** The operator Peer every admitted request speaks for. */
  readonly operator: PeerScope
  private readonly interceptors = new Map<string, ConnectionRpcInterceptor>()
  private readonly fetchRoutes = new Map<string, RegisteredFetchRoute>()

  /**
   * Provide the Host half over the active HTTP server.
   * @param ctx - owning Connection plugin context.
   * @param trustedHosts - deployment authorities accepted by the Host/Origin fence.
   * @param browserAuth - process token and persistent browser-session owner.
   */
  constructor(
    ctx: Context,
    private readonly trustedHosts: readonly string[],
    private readonly browserAuth: BrowserAuth,
  ) {
    super(ctx, 'connection')
    this.operator = new OperatorPeer(ctx)
    ctx.effect(() => () => this.operator.dispose(), 'client-connection: operator Peer')
  }

  /** Generic channel registry scoped to the Context reading this service. */
  get rpc(): HostConnectionRpc {
    const owner = this.ctx
    return {
      handle: (channel, handler) => this.register(owner, channel, handler),
      intercept: (channel, matches, handler) =>
        this.registerInterceptor(owner, channel, matches, handler),
    }
  }

  /** Exact Fetch-route registry scoped to the Context reading this service. */
  get fetch(): HostConnectionFetch {
    const owner = this.ctx
    return {
      register: route => this.registerFetchRoute(owner, route),
    }
  }

  /** Apply the configured Host/Origin fence, then browser authentication. */
  requestRejection(request: ConnectionTrustRequest): ConnectionRequestRejection {
    if (!isTrustedApiRequest(request, this.trustedHosts)) return 403
    return this.browserAuth.isAuthenticated(request) ? undefined : 401
  }

  /** A request that passes the fence and authentication speaks for the operator. */
  admit(request: ConnectionTrustRequest): PeerAdmission {
    const rejection = this.requestRejection(request)
    return rejection === undefined ? { peer: this.operator } : { rejection }
  }

  /** Authenticate an index request through the process-token exchange or cookie. */
  authorizeIndex(request: ConnectionIndexRequest, response: ConnectionIndexResponse): boolean {
    return this.browserAuth.authorizeIndex(request, response)
  }

  /** Add this process's launch token to the clean application URL. */
  authenticatedUrl(baseUrl: string): string {
    return this.browserAuth.authenticatedUrl(baseUrl)
  }

  /**
   * Compose one shared-channel Fetch handler from exact routes and its interceptor.
   * @param channel - shared channel mounted by Connection.
   * @returns Fetch handler that selects one owner or returns 404.
   */
  createSharedFetchHandler(
    channel: '/api',
  ): ConnectionFetchHandler {
    return {
      requestBodyMode: ({ method, url }) => {
        const route = this.fetchRoutes.get(url.pathname)
        return route?.methods.has(method) === true ? route.requestBody : 'buffered'
      },
      fetch: (request) => {
        const pathname = new URL(request.url).pathname
        const route = this.fetchRoutes.get(pathname)
        if (route?.methods.has(request.method) === true) return route.fetch(request)
        const endpoint = endpointFromPath(channel, pathname)
        const interceptor = this.interceptors.get(channel)
        if (endpoint === undefined || interceptor === undefined || !interceptor.matches(endpoint)) {
          return Promise.resolve(new Response('not found', { status: 404 }))
        }
        return interceptor.fetchHandler.fetch(request)
      },
    }
  }

  private registerFetchRoute(
    owner: Context,
    route: ConnectionFetchRoute,
  ): () => Promise<void> {
    assertFetchRoute(route)
    const registered: RegisteredFetchRoute = {
      methods: new Set(route.methods),
      requestBody: route.requestBody,
      fetch: route.fetch,
    }
    return owner.effect(() => {
      if (this.fetchRoutes.has(route.path)) {
        throw new Error(`connection: exact Fetch route ${JSON.stringify(route.path)} is already registered`)
      }
      this.fetchRoutes.set(route.path, registered)
      return () => { this.fetchRoutes.delete(route.path) }
    }, `client-connection: ${route.path} Fetch route`)
  }

  private register(
    owner: Context,
    channel: string,
    handler: ConnectionRpcHandler,
  ): () => Promise<void> {
    assertChannel(channel)
    const fetchHandler = rpcFetchHandler(channel, handler, this.operator)
    const route: WebRoute = {
      kind: 'prefix',
      path: channel,
      handler: async (req, res) => {
        const admission = this.admit(req)
        if ('rejection' in admission) {
          res.writeHead(admission.rejection)
          res.end(admission.rejection === 401 ? 'unauthorized' : 'forbidden')
          return
        }
        await bridge(req, res, fetchHandler)
      },
    }
    return owner.effect(
      () => owner.webServer.register(route),
      `client-connection: ${channel} rpc channel`,
    )
  }

  private registerInterceptor(
    owner: Context,
    channel: string,
    matches: ConnectionRpcEndpointMatcher,
    handler: ConnectionRpcHandler,
  ): () => Promise<void> {
    if (channel !== API_PATH) {
      throw new Error(`connection: invalid shared RPC channel ${JSON.stringify(channel)}`)
    }
    const interceptor: ConnectionRpcInterceptor = {
      matches,
      fetchHandler: rpcFetchHandler(channel, handler, this.operator),
    }
    return owner.effect(() => {
      if (this.interceptors.has(channel)) {
        throw new Error(`connection: shared RPC channel ${JSON.stringify(channel)} already has an interceptor`)
      }
      this.interceptors.set(channel, interceptor)
      return () => {
        this.interceptors.delete(channel)
      }
    }, `client-connection: ${channel} rpc interceptor`)
  }
}

function rpcFetchHandler(
  channel: string,
  handler: ConnectionRpcHandler,
  peer: PeerScope,
): ConnectionFetchHandler {
  return {
    requestBodyMode: () => 'buffered',
    async fetch(request: Request): Promise<Response> {
      const endpoint = endpointFromPath(channel, new URL(request.url).pathname)
      if (request.method !== 'POST' || endpoint === undefined) {
        return new Response('not found', { status: 404 })
      }

      const mediaType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
      if (mediaType !== 'application/json') {
        return new Response('content type must be application/json', { status: 415 })
      }

      let body: unknown
      try {
        body = await request.json()
      } catch {
        return new Response('body is not JSON', { status: 400 })
      }

      const envelope = clientRequestSchema.safeParse(body)
      if (!envelope.success) {
        return invalidEnvelopeResponse(body, envelope.error.issues)
      }
      const message: ClientRequest = envelope.data
      const normalizedMethod = normalizeEndpoint(message.method)
      if (normalizedMethod !== endpoint) {
        return errorResponse(message.rpcId, {
          code: 'gateway/bad-request',
          message: `method ${JSON.stringify(message.method)} does not match endpoint ${JSON.stringify(endpoint)}`,
          details: { issues: [] },
        })
      }

      try {
        const result = await handler(endpoint, message.payload, request.signal, peer)
        return validatedResponse(request, endpoint, message.rpcId, message.payload, result)
      } catch (error) {
        return new Response(`handler failure: ${String(error)}`, { status: 500 })
      }
    },
  }
}

function invalidEnvelopeResponse(body: unknown, issues: readonly object[]): Response {
  const rawId = (body as { rpcId?: unknown } | null)?.rpcId
  const rpcId = typeof rawId === 'string' ? RpcId(rawId) : INVALID_REQUEST_RPC_ID
  return errorResponse(rpcId, {
    code: 'gateway/bad-request',
    message: 'invalid client-request message',
    details: { issues },
  })
}

function normalizeEndpoint(endpoint: string): string {
  // Legacy dot notation: "namespace.method" -> "namespace/method" (curl tests use dot)
  if (!endpoint.includes('/') && endpoint.includes('.')) {
    const dotSegments = endpoint.split('.')
    if (dotSegments.length === 2
      && dotSegments.every(segment => segment !== '' && segment !== '.' && segment !== '..' && ENDPOINT_SEGMENT_PATTERN.test(segment))) {
      return dotSegments.join('/')
    }
  }
  return endpoint
}

function endpointFromPath(channel: string, pathname: string): string | undefined {
  if (!pathname.startsWith(`${channel}/`)) return undefined
  let endpoint = pathname.slice(channel.length + 1)
  endpoint = normalizeEndpoint(endpoint)
  const segments = endpoint.split('/')
  if (segments.some(segment =>
    segment === '' || segment === '.' || segment === '..' || !ENDPOINT_SEGMENT_PATTERN.test(segment))) {
    return undefined
  }
  return endpoint
}

function errorResponse(rpcId: RpcIdType, error: ConnectionRpcFailure): Response {
  return fullResponse(rpcId, error)
}

/**
 * Build one successful JSON RPC response with a content validator over its
 * business result. A caller that repeats a read with `If-None-Match` (or
 * `If-Modified-Since` against the issued `Last-Modified`) receives `304 Not
 * Modified` with no body and reuses its cached result; the awaited handler has
 * already run, so the conditional answer always reflects the current result.
 * Error and attachment responses stay unvalidated.
 * @param request - the HTTP request carrying any conditional headers.
 * @param endpoint - canonical `<namespace>/<method>` endpoint.
 * @param rpcId - the caller's request id, echoed on a 304 so the unary call can settle.
 * @param payload - the request payload; only its digest is retained as the validator key.
 * @param result - the awaited handler result.
 * @returns a 200 envelope or a bodiless 304.
 */
function validatedResponse(
  request: Request,
  endpoint: string,
  rpcId: RpcIdType,
  payload: unknown,
  result: Awaited<ReturnType<ConnectionRpcHandler>>,
): Response {
  if (!result.ok) return fullResponse(rpcId, result.error)
  const { attachments = [], ...success } = result
  if (attachments.length > 0) return attachmentResponse(rpcId, success, attachments)
  const resultJson = JSON.stringify(success)
  const etag = `"${createHash('sha1').update(`${endpoint}\0${resultJson}`).digest('base64url')}"`
  const key = createHash('sha1').update(`${endpoint}\0${JSON.stringify(payload)}`).digest('base64url')
  const previous = rpcResultValidators.get(key)
  // HTTP dates carry whole seconds; truncating here makes the emitted header
  // parse back to exactly this instant for the `If-Modified-Since` comparison.
  const lastModified = previous !== undefined && previous.etag === etag
    ? previous.lastModified
    : new Date(Math.floor(Date.now() / 1000) * 1000)
  rpcResultValidators.set(key, { etag, lastModified })
  if (rpcResultValidators.size > RPC_VALIDATOR_LIMIT) {
    const oldest = rpcResultValidators.keys().next().value
    /* v8 ignore next -- the insertion above guarantees a first key */
    if (oldest !== undefined) rpcResultValidators.delete(oldest)
  }
  // no-store, not no-cache: the conditional read is this protocol's own
  // request header, so no browser or intermediary HTTP cache may store the
  // response and revalidate POSTs on its own (a bodyless 304 it did not ask
  // for is unreadable to a caller holding no cached result).
  const headers = {
    'content-type': 'application/json',
    'cache-control': 'no-store',
    etag,
    'last-modified': lastModified.toUTCString(),
  }
  if (isNotModified(request, etag, lastModified, previous)) {
    return new Response(null, {
      status: 304,
      headers: { ...headers, 'x-dsh-rpc-id': rpcId },
    })
  }
  return new Response(`{"type":"server-response","rpcId":${JSON.stringify(rpcId)},"result":${resultJson}}`, {
    status: 200,
    headers,
  })
}

/** Whether the caller's conditional headers already hold this exact result. */
function isNotModified(
  request: Request,
  etag: string,
  lastModified: Date,
  previous: { etag: string; lastModified: Date } | undefined,
): boolean {
  const ifNoneMatch = request.headers.get('if-none-match')
  if (ifNoneMatch !== null) {
    return ifNoneMatch.split(',').some((candidate) => {
      const value = candidate.trim()
      return value === '*' || value === etag || value.replace(/^W\//, '') === etag
    })
  }
  const ifModifiedSince = request.headers.get('if-modified-since')
  if (ifModifiedSince === null || previous === undefined || previous.etag !== etag) return false
  const since = Date.parse(ifModifiedSince)
  return Number.isFinite(since) && lastModified.getTime() <= since
}

function fullResponse(rpcId: RpcIdType, failure: ConnectionRpcFailure): Response {
  const body: ConnectionServerResponse = { type: 'server-response', rpcId, result: { ok: false, error: failure } }
  return Response.json(body)
}

/** Frame one success whose handler projected binary fields beside the JSON envelope. */
function attachmentResponse(
  rpcId: RpcIdType,
  success: { readonly ok: true; readonly value: unknown },
  attachments: readonly ConnectionRpcAttachment[],
): Response {
  const body: ConnectionServerResponse = { type: 'server-response', rpcId, result: success }
  const parts = new FormData()
  const attachmentMetadata = attachments.map((attachment, index) => {
    const part = `bytes-${index}`
    // FileSystem bytes may have SharedArrayBuffer backing, which BlobPart excludes.
    parts.set(part, new Blob([new Uint8Array(attachment.bytes)]))
    return { path: [...attachment.path], codec: 'bytes' as const, part }
  })
  parts.set('metadata', JSON.stringify({ ...body, attachments: attachmentMetadata }))
  return new Response(parts)
}

function assertChannel(channel: string): void {
  if (!CHANNEL_PATTERN.test(channel) || channel === '/api') {
    throw new Error(`connection: invalid or reserved RPC channel ${JSON.stringify(channel)}`)
  }
}

function assertFetchRoute(route: ConnectionFetchRoute): void {
  if (endpointFromPath(API_PATH, route.path) === undefined) {
    throw new Error(`connection: invalid exact Fetch route ${JSON.stringify(route.path)}`)
  }
  if (route.methods.length === 0) {
    throw new Error(`connection: exact Fetch route ${JSON.stringify(route.path)} declares no methods`)
  }
  const methods = new Set(route.methods)
  if (methods.size !== route.methods.length) {
    throw new Error(`connection: exact Fetch route ${JSON.stringify(route.path)} repeats a method`)
  }
}
