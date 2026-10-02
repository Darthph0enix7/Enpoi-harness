/** Browser caller for generic Connection unary RPC channels. */

import {
  RpcId,
  type ClientRequest,
  type RpcId as RpcIdType,
} from '../rpc.ts'
import type { ClientConnectionRpc, ConnectionRpcResult } from '../rpc.ts'
import { randomUuid } from './random-uuid.ts'
import { installSettingsDescribe } from './settings-describe.ts'

const CHANNEL_PATTERN = /^\/[A-Za-z0-9._~-]+$/
const ENDPOINT_SEGMENT_PATTERN = /^[A-Za-z0-9_$.-]+$/
/** Highest number of result validators the browser keeps for conditional reads. */
const CALL_VALIDATOR_LIMIT = 128
/** Endpoint spellings the server normalizes to the settings describe route. */
const SETTINGS_DESCRIBE_ENDPOINTS = new Set(['settings/describe', 'settings.describe'])

/**
 * Transport this caller posts through; same signature as the global `fetch`.
 * Receives the document-relative route so a carrier resolves it against its own base.
 */
export type RpcFetch = (input: string | URL, init: RequestInit) => Promise<Response>

/** Worker-local opener for decoded Gateway Remote streams; `uplink` carries the Client's items for the stream. */
export type RpcStreamOpen = (
  endpoint: string,
  payload: unknown,
  signal: AbortSignal,
  uplink?: AsyncIterable<unknown>,
) => AsyncIterable<unknown>

/**
 * Create the browser-backed generic RPC caller.
 * @param doFetch - transport override; defaults to the page's global fetch.
 * @param openStream - optional worker-local Gateway stream carrier.
 * @returns caller that owns request correlation and response-envelope validation.
 */
export function createWebConnectionRpc(doFetch?: RpcFetch, openStream?: RpcStreamOpen): ClientConnectionRpc {
  const send: RpcFetch = doFetch ?? ((input, init) => globalThis.fetch(input, init))
  // The served page installs one coalesced describe every settings store shares;
  // a carrier-surfaced caller (or a test mock) keeps its own transport.
  const sharedDescribe = doFetch === undefined ? installSettingsDescribe(send) : undefined
  const validators = new Map<string, { readonly etag: string; readonly result: ConnectionRpcResult<unknown> }>()
  return {
    async call(channel, endpoint, payload, signal) {
      assertTarget(channel, endpoint)
      // Only the argument-less read shares the page cache; a caller passing
      // options (e.g. redaction) keeps its own transport.
      const args = (payload as { args?: unknown } | null | undefined)?.args
      const argumentless = args === undefined
        || (typeof args === 'object' && args !== null && !Array.isArray(args) && Object.keys(args).length === 0)
      if (sharedDescribe !== undefined && argumentless
        && channel === '/api' && SETTINGS_DESCRIBE_ENDPOINTS.has(endpoint)) {
        const value = await sharedDescribe()
        signal?.throwIfAborted()
        if (value === undefined) {
          return { ok: false, error: { code: 'gateway/internal', message: 'settings describe failed', details: {} } }
        }
        return { ok: true, value }
      }
      const rpcId = RpcId(randomUuid())
      const message: ClientRequest = {
        type: 'client-request',
        rpcId,
        method: endpoint,
        payload,
      }
      // The channel key is absolute; a page posts the document-relative form, and
      // a carrier that resolves against the Host root accepts the same form.
      const route = `${channel}/${endpoint}`.slice(1)
      const validatorKey = `${channel}\0${endpoint}\0${JSON.stringify(payload) ?? ''}`
      const validator = validators.get(validatorKey)
      const sendCall = (conditional: boolean): Promise<Response> => send(
        route,
        {
          method: 'POST',
          // Keep every HTTP cache out of the conditional-read protocol: only
          // this caller's own validator may turn a call into a bodiless 304.
          cache: 'no-store',
          headers: {
            'content-type': 'application/json',
            ...!conditional || validator === undefined ? {} : { 'if-none-match': validator.etag },
          },
          body: JSON.stringify(message),
          ...signal === undefined ? {} : { signal },
        },
      )
      let response = await sendCall(true)
      // A Host that still holds the last result answers without a body: reuse it.
      if (response.status === 304 && validator !== undefined) {
        signal?.throwIfAborted()
        return validator.result
      }
      // A conditional layer outside this caller (intermediary, stale cache)
      // answered for a request this caller did not make conditional; retry
      // once without a validator instead of failing on the bodyless answer.
      if (response.status === 304) {
        signal?.throwIfAborted()
        response = await sendCall(false)
      }
      if (!response.ok) {
        throw new Error(`transport failure for ${channel}/${endpoint}: HTTP ${response.status}`)
      }
      const mediaType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
      const full = mediaType === 'multipart/form-data'
        ? await parseBinaryResponse(response)
        : parseConnectionResponse(await response.json())
      signal?.throwIfAborted()
      if (full.rpcId !== rpcId) {
        throw new Error(`rpcId mismatch for ${endpoint}: sent ${rpcId}, got ${full.rpcId}`)
      }
      const etag = response.headers.get('etag')
      if (etag !== null) {
        validators.set(validatorKey, { etag, result: full.result })
        if (validators.size > CALL_VALIDATOR_LIMIT) {
          const oldest = validators.keys().next().value
          /* v8 ignore next -- the insertion above guarantees a first key */
          if (oldest !== undefined) validators.delete(oldest)
        }
      }
      return full.result
    },
    ...openStream === undefined ? {} : {
      open(channel, endpoint, payload, signal, uplink) {
        assertTarget(channel, endpoint)
        if (channel !== '/api') {
          throw new Error(`connection: worker-local streams require the /api channel, got ${JSON.stringify(channel)}`)
        }
        return openStream(endpoint, payload, signal, uplink)
      },
    },
  }
}

async function parseBinaryResponse(response: Response): Promise<ReturnType<typeof parseConnectionResponse>> {
  const body = await response.formData()
  const fields = new Map<string, string | Blob>()
  for (const [name, value] of body) {
    if (fields.has(name)) throw new TypeError('connection: invalid binary response fields')
    fields.set(name, value)
  }
  const metadata = fields.get('metadata')
  fields.delete('metadata')
  if (typeof metadata !== 'string') {
    throw new TypeError('connection: invalid binary response fields')
  }
  const envelope: unknown = JSON.parse(metadata)
  const full = parseConnectionResponse(envelope)
  if (!full.result.ok || !isRecord(envelope) || !Array.isArray(envelope.attachments) || envelope.attachments.length === 0) {
    throw new TypeError('connection: invalid binary response result')
  }
  const root = { value: full.result.value }
  for (const attachment of envelope.attachments) {
    if (!isRecord(attachment) || attachment.codec !== 'bytes' || typeof attachment.part !== 'string'
      || !Array.isArray(attachment.path)) {
      throw new TypeError('connection: invalid binary response attachment')
    }
    const data = fields.get(attachment.part)
    fields.delete(attachment.part)
    if (!(data instanceof Blob)) {
      throw new TypeError('connection: invalid binary response fields')
    }
    let parent: object = root
    let key: string | number = 'value'
    for (const segment of attachment.path) {
      const value: unknown = Reflect.get(parent, key)
      if (typeof value !== 'object' || value === null) {
        throw new TypeError('connection: invalid binary response path')
      }
      if (Array.isArray(value)) {
        if (typeof segment !== 'number' || !Number.isSafeInteger(segment) || segment < 0 || segment >= value.length) {
          throw new TypeError('connection: invalid binary response path')
        }
      } else if (typeof segment !== 'string') {
        throw new TypeError('connection: invalid binary response path')
      }
      if (!Object.hasOwn(value, segment)) throw new TypeError('connection: invalid binary response path')
      parent = value
      key = segment
    }
    if (Reflect.get(parent, key) !== null) throw new TypeError('connection: invalid binary response placeholder')
    Object.defineProperty(parent, key, {
      value: new Uint8Array(await data.arrayBuffer()), enumerable: true, writable: true, configurable: true,
    })
  }
  if (fields.size !== 0) throw new TypeError('connection: invalid binary response fields')
  return {
    rpcId: full.rpcId,
    result: { ok: true, value: root.value },
  }
}

function parseConnectionResponse(value: unknown): {
  readonly rpcId: RpcIdType
  readonly result: ConnectionRpcResult<unknown>
} {
  if (!isRecord(value) || value.type !== 'server-response' || typeof value.rpcId !== 'string') {
    throw new TypeError('connection: invalid server-response envelope')
  }
  const result = value.result
  if (!isRecord(result)) throw new TypeError('connection: invalid server-response result')
  if (result.ok === true) {
    return {
      rpcId: RpcId(value.rpcId),
      result: { ok: true, value: result.value },
    }
  }
  if (result.ok !== false || !isRecord(result.error)) {
    throw new TypeError('connection: invalid server-response result')
  }
  const error = result.error
  if (typeof error.code !== 'string' || typeof error.message !== 'string' || !isRecord(error.details)) {
    throw new TypeError('connection: invalid server-response failure')
  }
  return {
    rpcId: RpcId(value.rpcId),
    result: {
      ok: false,
      error: { code: error.code, message: error.message, details: error.details },
    },
  }
}

function isRecord(value: unknown): value is Record<PropertyKey, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function assertTarget(channel: string, endpoint: string): void {
  const segments = endpoint.split('/')
  if (!CHANNEL_PATTERN.test(channel)
    || segments.some(segment =>
      segment === '' || segment === '.' || segment === '..' || !ENDPOINT_SEGMENT_PATTERN.test(segment))) {
    throw new Error(`connection: invalid RPC target ${JSON.stringify(`${channel}/${endpoint}`)}`)
  }
}
