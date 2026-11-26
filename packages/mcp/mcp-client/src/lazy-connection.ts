/** Static tool registration and credential-bound Streamable HTTP connections. @module */

import { createHash } from 'node:crypto'
import { addAbortListener } from 'node:events'
import { Client, type Transport } from '@modelcontextprotocol/client'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { isJsonValue, type JsonValue } from '@deepseek-ai/dsh-util-values'
import type { Config, StreamableHttpConfig } from './index.ts'
import { SecretRedactor } from './redact.ts'
import { createMcpToolDefinition, publicToolName } from './tools.ts'
import { createTransport, resolveDynamicHeaders, resolveHeaderPolicy, staticHttpRedactor, type HeaderPolicy } from './transport.ts'

/** One release-owned tool definition; annotations are not used for authorization or prompting. */
export interface StaticMcpTool {
  /** Raw MCP tool name. */
  name: string
  /** Model-facing description supplied by the profile. */
  description: string
  /** JSON Schema for the tool's object arguments. */
  inputSchema: {
    /** JSON Schema root type; MCP tool arguments are always an object. */
    type: 'object'
    [key: string]: JsonValue
  }
  /** Optional MCP annotations. */
  annotations?: Record<string, JsonValue>
}

/** Default connection count and idle lifetime for the lazy session cache. */
export const LAZY_SESSION_CACHE_DEFAULTS = { max: 16, idleTtlMs: 300_000 } as const

interface LazyTools {
  config: StreamableHttpConfig
  tools: readonly StaticMcpTool[]
  max: number
  idleTtlMs: number
  headers: HeaderPolicy
  redactor: SecretRedactor
}

function isJsonObject(value: unknown): value is Record<string, JsonValue> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && isJsonValue(value)
}

/**
 * Validate lazy-only settings before acquiring the plugin's tool namespace.
 * @param config - Loader or programmatic plugin settings.
 * @returns Resolved lazy settings, or none for eager discovery.
 */
export function resolveLazyTools(config: Config): LazyTools | undefined {
  if (config.transport === 'stdio') {
    if (['staticTools', 'lazyConnect', 'lazySessionCacheMax', 'lazySessionIdleTtlMs', 'requireDynamicHeaders', 'secretHeaderNames', 'secretHeaderMinLength']
      .some(key => Object.hasOwn(config, key))) throw new Error('Lazy and credential header options require streamable-http')
    return undefined
  }
  if (config.lazyConnect !== undefined && typeof config.lazyConnect !== 'boolean') throw new Error('MCP lazyConnect must be a boolean')
  if (config.requireDynamicHeaders !== undefined && typeof config.requireDynamicHeaders !== 'boolean') {
    throw new Error('MCP requireDynamicHeaders must be a boolean')
  }
  if (config.lazyConnect !== true) {
    if (config.staticTools !== undefined) throw new Error('MCP staticTools requires lazyConnect')
    return undefined
  }
  if (config.failOnStartupError) throw new Error('MCP lazyConnect is incompatible with failOnStartupError')
  const rawTools: unknown = config.staticTools
  if (!Array.isArray(rawTools) || rawTools.length === 0) throw new Error('MCP lazyConnect requires non-empty staticTools')
  const tools: StaticMcpTool[] = []
  const names = new Set<string>()
  const entries: readonly unknown[] = rawTools
  for (const raw of entries) {
    if (!isJsonObject(raw) || typeof raw.name !== 'string' || raw.name.length === 0 || typeof raw.description !== 'string'
      || !isJsonObject(raw.inputSchema) || raw.inputSchema.type !== 'object'
      || (raw.annotations !== undefined && !isJsonObject(raw.annotations))) throw new Error('Invalid MCP staticTools entry')
    const tool: StaticMcpTool = { name: raw.name, description: raw.description, inputSchema: { ...raw.inputSchema, type: 'object' },
      ...(raw.annotations === undefined ? {} : { annotations: raw.annotations }) }
    if (names.has(tool.name)) throw new Error('MCP staticTools contains duplicate names')
    names.add(tool.name)
    tools.push(tool)
  }
  if (config.allowedTools?.length !== names.size || config.allowedTools.some(name => !names.has(name))) {
    throw new Error('MCP allowedTools must match staticTools names exactly')
  }
  const max = config.lazySessionCacheMax ?? LAZY_SESSION_CACHE_DEFAULTS.max
  const idleTtlMs = config.lazySessionIdleTtlMs ?? LAZY_SESSION_CACHE_DEFAULTS.idleTtlMs
  if (!Number.isSafeInteger(max) || max < 1) throw new Error('MCP lazySessionCacheMax must be a positive integer')
  if (!Number.isInteger(idleTtlMs) || idleTtlMs < 1 || idleTtlMs > MAX_TIMER_DELAY_MS) {
    throw new Error('MCP lazySessionIdleTtlMs must be a positive integer within the timer range')
  }
  const headers = resolveHeaderPolicy(config)
  const redactor = staticHttpRedactor(config, headers)
  new URL(config.url)
  if (new Headers(config.headers).has('mcp-session-id')) throw new Error('MCP session header is transport-owned')
  return { config, tools: structuredClone(tools), max, idleTtlMs, headers, redactor }
}

function canonicalJson(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort()
      .map(key => `${JSON.stringify(key)}:${canonicalJson(value[key] as JsonValue)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function hash(value: JsonValue): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex')
}

interface Entry {
  client: Client
  transport: Transport
  ready: Promise<void>
  credentialHash: string
  active: number
  timer?: NodeJS.Timeout
}

/**
 * Register the release-owned tool definitions and own all lazy connection lifetimes.
 * @param ctx - Plugin context providing tool registration and lifecycle events.
 * @param settings - Validated lazy mode settings.
 */
export function mountLazyTools(ctx: Context, settings: LazyTools): void {
  const { config, tools, max, idleTtlMs, headers: policy, redactor } = settings
  const cache = new Map<string, Entry>()
  const closing = new Set<Promise<void>>()
  const disposedHandles = new WeakSet<object>()
  type Session = NonNullable<ToolExecution['agent']>['session']
  const revocations = new WeakMap<Session, object>()
  let disposed = false

  function drop(id: string, entry = cache.get(id)): void {
    if (entry === undefined || cache.get(id) !== entry) return
    cache.delete(id)
    clearTimeout(entry.timer)
    const close = Promise.allSettled([entry.transport.close(), entry.ready]).then(() => { closing.delete(close) })
    closing.add(close)
  }

  function acquire(id: string, headers: Headers): Entry {
    const credentialHash = hash([...headers])
    let entry = cache.get(id)
    if (entry !== undefined && entry.credentialHash !== credentialHash) {
      drop(id, entry)
      entry = undefined
    }
    if (entry === undefined) {
      if (cache.size >= max) {
        for (const oldest of cache.keys()) {
          drop(oldest)
          break
        }
      }
      // Use the initialize protocol. The SDK's modern discovery logs invalid
      // tool declarations verbatim and can derive HTTP headers from schemas.
      const client = new Client({ name: 'dsh-mcp-client', version: '0.0.1' }, { versionNegotiation: { mode: 'legacy' } })
      const transport = createTransport(config, { boundHeaders: headers, headerPolicy: policy })
      const fresh = { client, transport, credentialHash, active: 0,
        ready: client.connect(transport, { timeout: config.toolCallTimeoutMs }) }
      client.onclose = () => { drop(id, fresh) }
      entry = fresh
    }
    clearTimeout(entry.timer)
    cache.delete(id)
    cache.set(id, entry)
    entry.active++
    return entry
  }

  async function authorizedEntry(exec: ToolExecution): Promise<{ id: string; entry: Entry }> {
    const agent = exec.agent
    if (agent === undefined) throw new Error('MCP request headers unavailable')
    const session = agent.session
    const epoch = revocations.get(session)
    let headers: Headers | undefined
    try {
      headers = await resolveDynamicHeaders(config, ctx.get('mcpHeaderProvider'), session.id, policy,
        new SecretRedactor(redactor))
    } catch (_error) {
      // Provider exceptions are equivalent to a refusal and contain no safe diagnostics.
    }
    if (disposed || disposedHandles.has(agent) || disposedHandles.has(session) || revocations.get(session) !== epoch) {
      throw new Error('MCP request headers unavailable')
    }
    if (headers === undefined) {
      revocations.set(session, {})
      drop(session.id)
      throw new Error('MCP request headers unavailable')
    }
    exec.signal.throwIfAborted()
    return { id: session.id, entry: acquire(session.id, headers) }
  }

  ctx.on('session/disposed', (session) => {
    disposedHandles.add(session)
    drop(session.id)
  })
  ctx.on('agent/disposed', ({ agent }) => {
    disposedHandles.add(agent)
    drop(agent.session.id)
  })
  ctx.effect(() => {
    const unregister: Array<() => void> = []
    try {
      for (const tool of tools) {
        const name = publicToolName(config.serverName, tool.name)
        const expected = hash({ name: tool.name, inputSchema: tool.inputSchema })
        if (redactor.hasSecret(JSON.stringify([name, tool]))) throw new Error('MCP static tool metadata contains a credential')
        unregister.push(ctx.tools.register(createMcpToolDefinition(ctx, {
          name, rawName: tool.name, description: tool.description, inputSchema: tool.inputSchema, redactor,
          call: async (args, exec) => {
            const { id, entry } = await authorizedEntry(exec)
            const { client } = entry
            const options = { signal: exec.signal, timeout: config.toolCallTimeoutMs }
            // The transport must close even if cancellation arrives during initialize.
            const abort = addAbortListener(exec.signal, () => { drop(id, entry) })
            try {
              await entry.ready
              const { tools: remote } = await client.listTools(undefined, { ...options, cacheMode: 'refresh' })
              const matches = remote.filter(candidate => candidate.name === tool.name)
              const match = matches.length === 1 ? matches[0] : undefined
              if (match === undefined || !isJsonObject(match.inputSchema)
                || hash({ name: match.name, inputSchema: match.inputSchema }) !== expected) {
                ctx.logger.warn(`mcp-client(${config.serverName}): static tool manifest does not match the server roster`)
                throw new Error('MCP tool unavailable')
              }
              if (cache.get(id) !== entry || match.execution?.taskSupport === 'required') throw new Error('MCP tool unavailable')
              return await client.callTool({ name: tool.name, arguments: args }, { ...options, toolDefinition: tool })
            } catch (error) {
              drop(id, entry)
              throw error
            } finally {
              abort[Symbol.dispose]()
              if (--entry.active === 0 && cache.get(id) === entry) {
                entry.timer = setTimeout(() => { drop(id, entry) }, idleTtlMs)
                entry.timer.unref()
              }
            }
          },
        })))
      }
    } catch (error) {
      for (const dispose of unregister) dispose()
      throw error
    }
    return async () => {
      disposed = true
      for (const dispose of unregister) dispose()
      for (const [id, entry] of cache) drop(id, entry)
      await Promise.all(closing)
    }
  }, 'mcp-client.lazy-tools')
}
