/** Host-only, per-request credentials for a single bound worker MCP endpoint. */
import { constants } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'

/** Local view of the non-secret peer binding used for request credentials. */
export interface WorkerBinding {
  readonly jobId: string
  readonly fence: number
  readonly expiresAt: number
  readonly revoked?: boolean
  readonly mcpEndpointId?: string
  readonly credentialRef?: string
}

/** Worker-owned secret directory and the only configured destination. */
export interface Config {
  /** Configured MCP server name, also required on the binding. */
  serverId: string
  /** Absolute directory path; defaults to `$DSH_HOME/worker-secrets`. */
  secretDir?: string
}

interface HeaderProvider {
  headersFor(sessionId: string | undefined, serverId: string): Promise<Record<string, string> | undefined>
}

type BindingLookup = (sessionId: string) => WorkerBinding | undefined

/** Cordis plugin name. */
export const name = 'enpoi-worker-credentials'

/** Schemastery validator for {@link Config}. */
export const Config: Schema<Config> = Schema.object({
  serverId: Schema.string().required().pattern(/^[A-Za-z0-9_-]{1,32}$/u),
  secretDir: Schema.string().min(1),
})

const MAX_BEARER_BYTES = 8192
const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u
const BEARER = /^[A-Za-z0-9._~+/-]+=*$/u

function unavailable(): Error {
  return new Error('Worker MCP credential unavailable')
}

async function readBearer(dir: string, uid: number, ref: string): Promise<string | undefined> {
  try {
    const parent = await lstat(dir)
    if (!parent.isDirectory() || parent.uid !== uid || (parent.mode & 0o7777) !== 0o700) throw unavailable()
    const handle = await open(join(dir, ref), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const metadata = await handle.stat()
      if (!metadata.isFile() || metadata.nlink !== 1 || metadata.uid !== uid
        || (metadata.mode & 0o7777) !== 0o600 || metadata.size > MAX_BEARER_BYTES) throw unavailable()
      const still = await lstat(dir)
      if (still.dev !== parent.dev || still.ino !== parent.ino || (still.mode & 0o7777) !== 0o700) throw unavailable()
      const buffer = Buffer.alloc(MAX_BEARER_BYTES + 1)
      let offset = 0
      while (offset < buffer.byteLength) {
        const { bytesRead } = await handle.read(buffer, offset, buffer.byteLength - offset, null)
        if (bytesRead === 0) break
        offset += bytesRead
      }
      if (offset > MAX_BEARER_BYTES) throw unavailable()
      const bearer = buffer.toString('utf8', 0, offset).replace(/\r?\n$/u, '')
      if (!BEARER.test(bearer)) throw unavailable()
      return bearer
    } finally {
      await handle.close()
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw unavailable()
  }
}

/**
 * Resolve live, destination-bound headers from worker-owned files; never cache a bearer.
 * @param config - trusted worker filesystem and MCP destination settings.
 * @param get - read the current peer job binding for a session.
 * @returns the host-only MCP header provider.
 */
export function createHeaderProvider(config: Config, get: BindingLookup): HeaderProvider {
  const uid = process.getuid?.()
  if (uid === undefined) throw new Error('Worker MCP credentials require POSIX file ownership')
  const dir = config.secretDir ?? dshHomePath('worker-secrets')
  const selectedServer = config.serverId
  if (!isAbsolute(dir) || !/^[A-Za-z0-9_-]{1,32}$/u.test(selectedServer)) {
    throw new Error('Worker MCP credentials require an absolute secretDir and a valid serverId')
  }
  return {
    async headersFor(sessionId, serverId) {
      if (sessionId === undefined || serverId !== selectedServer) return undefined
      const before = get(sessionId)
      if (before === undefined || before.revoked === true || before.expiresAt <= Date.now()
        || before.mcpEndpointId !== selectedServer || before.credentialRef === undefined) return undefined
      const { credentialRef, jobId, fence } = before
      if (!FILE_NAME.test(credentialRef) || !/^[!-~]+$/u.test(jobId) || !Number.isSafeInteger(fence) || fence <= 0) throw unavailable()
      const bearer = await readBearer(dir, uid, credentialRef)
      if (bearer === undefined) return undefined
      const current = get(sessionId)
      if (current === undefined || current.revoked === true || current.expiresAt <= Date.now()
        || current.jobId !== jobId || current.fence !== fence
        || current.credentialRef !== credentialRef || current.mcpEndpointId !== selectedServer) return undefined
      return { Authorization: `Bearer ${bearer}`, 'X-Jarvis-Job-ID': jobId, 'X-Jarvis-Job-Fence': String(fence) }
    },
  }
}

/**
 * Publish the header provider; look up peer authority only when a request needs it.
 * @param ctx - worker host context.
 * @param config - secret directory and permitted endpoint.
 */
export function apply(ctx: Context, config: Config): void {
  ctx.provide('mcpHeaderProvider', createHeaderProvider(config, sessionId => {
    const bindings = ctx.get('peerJobBindings') as { get: BindingLookup } | undefined
    return bindings?.get(sessionId)
  }))
}
