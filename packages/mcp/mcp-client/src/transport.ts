/**
 * Transport factory: creates the appropriate MCP transport based on the
 * plugin's resolved config. Stdio spawns a child process (with credential
 * scrubbing); Streamable HTTP connects to a URL.
 *
 * @module
 */

import type { Transport } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'
import { currentMcpRedactor, currentMcpSessionId, type McpHeaderProvider } from './header-context.ts'
import { acceptsSecretHeader, DEFAULT_SECRET_HEADER_MIN_LENGTH, DEFAULT_SECRET_HEADER_NAMES, SecretRedactor } from './redact.ts'
import type { Config, StreamableHttpConfig } from './index.ts'

/** Validated credential redaction and admission settings. */
export interface HeaderPolicy {
  names: ReadonlySet<string>
  minimum: number
}

/**
 * Resolve the credential header names and minimum, even for direct plugin mounting.
 * @param config - Config selecting the HTTP transport.
 * @returns Case-insensitive credential redaction policy.
 */
export function resolveHeaderPolicy(config: StreamableHttpConfig): HeaderPolicy {
  const names = config.secretHeaderNames ?? DEFAULT_SECRET_HEADER_NAMES
  const minimum = config.secretHeaderMinLength ?? DEFAULT_SECRET_HEADER_MIN_LENGTH
  if (!Array.isArray(names) || names.some(name => typeof name !== 'string' || !/^[!#$%&'*+.^`|~\w-]+$/.test(name))) {
    throw new Error('MCP secretHeaderNames must be an array of HTTP header names')
  }
  if (!Number.isSafeInteger(minimum) || minimum < 1) throw new Error('MCP secretHeaderMinLength must be a positive integer')
  return { names: new Set(names.map(name => name.toLowerCase())), minimum }
}

/**
 * Validate and track only configured credential headers, never routing metadata.
 * @param config - Config carrying static HTTP headers.
 * @param policy - Validated header policy.
 * @returns Base redactor with all configured HTTP secrets.
 */
export function staticHttpRedactor(config: StreamableHttpConfig, policy: HeaderPolicy): SecretRedactor {
  const redactor = new SecretRedactor()
  try {
    trackHeaders(new Headers(config.headers), policy, redactor, false)
  } catch {
    throw new Error('MCP request headers unavailable')
  }
  return redactor
}

function trackHeaders(headers: Headers, policy: HeaderPolicy, redactor: SecretRedactor, dynamic: boolean): void {
  for (const [name, value] of headers) {
    if (!policy.names.has(name)) continue
    if (!acceptsSecretHeader(value, policy.minimum)) throw new Error('MCP request headers unavailable')
    redactor.addHeader(value, dynamic)
  }
}

/**
 * Resolve and validate dynamic HTTP headers without forwarding provider errors.
 * @param config - HTTP configuration naming the destination.
 * @param provider - Active host service.
 * @param sessionId - Exact executing or discovery session.
 * @param policy - Validated header policy.
 * @param fallbackRedactor - Redactor for discovery outside a tool or resource call.
 * @returns Normalized dynamic headers, or none when not required.
 */
export async function resolveDynamicHeaders(
  config: StreamableHttpConfig,
  provider: McpHeaderProvider | undefined,
  sessionId: string | undefined,
  policy: HeaderPolicy,
  fallbackRedactor: SecretRedactor,
): Promise<Headers | undefined> {
  try {
    const raw = await provider?.headersFor(sessionId, config.serverName)
    if (raw !== undefined) {
      const headers = new Headers(raw)
      if (config.lazyConnect === true && headers.has('mcp-session-id')) throw new Error('MCP session header is transport-owned')
      const redactor = currentMcpRedactor() ?? fallbackRedactor
      trackHeaders(headers, policy, redactor, true)
      if ([...headers.values()].some(value => value.length > 0)) {
        redactor.hasDynamicHeaders = true
        return headers
      }
    }
  } catch {
    throw new Error('MCP request headers unavailable')
  }
  return undefined
}

/** Optional dynamic header resolution and secret tracking for HTTP transports. */
export interface CreateTransportOptions {
  /** Lookup for the optional host-side `mcpHeaderProvider` service. */
  getHeaderProvider?: () => McpHeaderProvider | undefined
  /** Owning agent scope fallback for optional dynamic HTTP headers. */
  scopeSessionId?: string
  /** Redactor updated with dynamically supplied header values. */
  redactor?: SecretRedactor
  /** Validated credential redaction and admission settings. */
  headerPolicy?: HeaderPolicy
  /** Headers authorized for one lazy connection's generation. */
  boundHeaders?: Headers
}

/**
 * The subprocess seam's scrubbed parent env (credential-shaped and stale
 * `DSH_*` names dropped), plus the spec's explicit env. The MCP SDK owns the
 * actual spawn, so this transport shares the scrub definition rather than the
 * spawn path.
 */
function buildChildEnv(extra: Record<string, string>): Record<string, string> {
  return { ...scrubbedParentEnv(), ...extra }
}

/**
 * Create an MCP transport from the resolved plugin config.
 *
 * @param config - Resolved plugin config discriminated on `transport`.
 * @param options - Optional dynamic header provider lookup and secret tracker.
 * @returns A connected-ready MCP Transport (stdio or Streamable HTTP).
 */
export function createTransport(config: Config, options?: CreateTransportOptions): Transport {
  switch (config.transport) {
    case 'stdio':
      return new StdioClientTransport({
        command: config.command,
        args: config.args,
        env: buildChildEnv(config.env),
        cwd: config.cwd,
      })
    case 'streamable-http': {
      const getHeaderProvider = options?.getHeaderProvider
      const boundHeaders = options?.boundHeaders
      const required = config.requireDynamicHeaders === true || config.lazyConnect === true
      if (getHeaderProvider === undefined && boundHeaders === undefined && !required) {
        return new StreamableHTTPClientTransport(
          new URL(config.url),
          { requestInit: { headers: config.headers } },
        )
      }
      const policy = options?.headerPolicy ?? resolveHeaderPolicy(config)
      const fallbackRedactor = options?.redactor ?? new SecretRedactor()
      const dynamicFetch: typeof fetch = async (input, init) => {
        const session = currentMcpSessionId() ?? (required ? undefined : options?.scopeSessionId)
        const dynamicHeaders = boundHeaders ?? (required && session === undefined ? undefined
          : await resolveDynamicHeaders(config, getHeaderProvider?.(), session, policy, fallbackRedactor))
        init?.signal?.throwIfAborted()
        if (dynamicHeaders === undefined) {
          if (required) throw new Error('MCP request headers unavailable')
          return fetch(input, init)
        }
        const merged = new Headers(init?.headers)
        // The legacy SDK opens an unsolicited notification stream after initialize.
        // Lazy registrations never consume it; explicit stream resumptions still work.
        if (boundHeaders !== undefined && init?.method === 'GET' && !merged.has('last-event-id')) {
          return new Response(null, { status: 405 })
        }
        for (const [key, value] of dynamicHeaders) merged.set(key, value)
        return fetch(input, { ...init, headers: merged, redirect: 'error' })
      }
      return new StreamableHTTPClientTransport(
        new URL(config.url),
        {
          requestInit: { headers: config.headers },
          fetch: dynamicFetch,
        },
      )
    }
  }
}
