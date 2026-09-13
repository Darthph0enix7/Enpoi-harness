/**
 * A fake `/sidebar/fsops` transport: routes answer JSON envelopes and every
 * call is recorded, so specs can drive the real client over a scripted fs.
 */
import type { FileSnapshot } from '../src/client/fsops.ts'

/** One recorded call, in arrival order. */
export interface FsOpsCall {
  readonly method: string
  readonly payload: Record<string, unknown>
}

/** What one route answers. */
export interface FsOpsReply {
  readonly status: number
  readonly body: unknown
}

/** A route table plus its recorded calls. */
export interface FakeFsOpsServer {
  readonly fetch: typeof fetch
  readonly calls: readonly FsOpsCall[]
}

/** One success envelope for a text read. */
export function readValue(
  content: string,
  sha256 = 'sha-old',
  mtimeMs = 1000,
  size = content.length,
  truncated = false,
): unknown {
  return { ok: true, value: { content, sha256, mtimeMs, size, truncated } satisfies FileSnapshot }
}

/** One success envelope for a stat. */
export function statValue(mtimeMs: number, size: number): unknown {
  return { ok: true, value: { mtimeMs, size } }
}

/** One failure envelope with its wire code. */
export function errorValue(code: string, message = code): unknown {
  return { ok: false, error: { code, message } }
}

/** A minimal `Response`-shaped object the fsops client can parse. */
function jsonResponse(body: unknown, status: number): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response
}

/**
 * Build a fake fsops server from per-method routes.
 * @param routes - method name (the URL's last segment) to reply factory.
 * @returns the fetch to hand to `createFsOps` and the recorded calls.
 */
export function fakeFsOpsServer(
  routes: Record<string, (payload: Record<string, unknown>) => FsOpsReply>,
): FakeFsOpsServer {
  const calls: FsOpsCall[] = []
  const impl: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const method = url.slice(url.lastIndexOf('/') + 1)
    const body = typeof init?.body === 'string' ? init.body : ''
    const payload = JSON.parse(body) as Record<string, unknown>
    calls.push({ method, payload })
    const route = routes[method]
    if (route === undefined) {
      return jsonResponse(errorValue('not-found', `unknown method ${method}`), 404)
    }
    const { status, body: answer } = route(payload)
    return jsonResponse(answer, status)
  }
  return { fetch: impl, calls }
}
