import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { z } from 'zod'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMcpHandler, McpServer, type CallToolResult } from '@modelcontextprotocol/server'
import { toNodeHandler, type NodeIncomingMessageLike } from '@modelcontextprotocol/node'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { createScope } from '@deepseek-ai/dsh-scope'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt, { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as mcpClientPlugin from '../src/index.ts'
import { Config as ConfigSchema, apply, type StreamableHttpConfig, type StaticMcpTool } from '../src/index.ts'
import { startConnection, resolveReconnectPolicy } from '../src/connection.ts'
import { SecretRedactor, boundText, formatBoundedError, sanitizeError } from '../src/redact.ts'
import { syncTools } from '../src/tools.ts'
import { createTransport } from '../src/transport.ts'

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()!()
  }
})

const searchTool: StaticMcpTool = {
  name: 'knowledge_search',
  description: 'Search the release roster',
  inputSchema: { type: 'object', properties: { q: { type: 'string', description: 'Example 1' } }, required: ['q'] },
}
const factsTool: StaticMcpTool = { ...searchTool, name: 'knowledge_facts', description: 'Read facts' }

async function startBoundHub() {
  const requests: Array<{ method: string; job: string | undefined; mcpSession: string | undefined }> = []
  const credential = (job: string) => `canary-job-${job}-worker`
  let ordinaryRoster = true
  let failMethod = ''
  let stalledJob = ''
  let factsMode: 'drift' | 'missing' | 'duplicate' | 'task' = 'drift'
  let sequence = 0
  const sessions = new Map<string, string>()
  const server = createServer((req, res) => {
    void (async () => {
      const job = req.headers['x-jarvis-job-id']?.toString()
      const mcpSession = req.headers['mcp-session-id']?.toString()
      if (req.method !== 'POST') {
        requests.push({ method: req.method ?? '', job, mcpSession })
        res.writeHead(405).end()
        return
      }
      req.setEncoding('utf8')
      let body = ''
      for await (const chunk of req) body += String(chunk)
      const message = JSON.parse(body) as { method: string; id?: number; params?: { name?: string } }
      requests.push({ method: message.method, job, mcpSession })
      if (job === undefined || req.headers.authorization !== `Bearer ${credential(job)}`
        || req.headers['x-jarvis-job-fence'] !== '1'
        || (message.method !== 'initialize' && (mcpSession === undefined || sessions.get(mcpSession) !== job))) {
        res.writeHead(401).end('authorization required')
        return
      }
      if (message.method === failMethod) {
        res.writeHead(500).end(`opaque failure ${job} ${credential(job)}`)
        return
      }
      if (message.method === 'initialize' && job === stalledJob) return
      if (message.id === undefined) {
        res.writeHead(202).end()
        return
      }
      let result: object
      switch (message.method) {
        case 'initialize': {
          const id = `protocol-${++sequence}`
          sessions.set(id, job)
          res.setHeader('mcp-session-id', id)
          result = { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'hub', version: '1' },
            instructions: `UNTRUSTED instructions ${credential(job)}` }
          break
        }
        case 'tools/list': {
          const reorderedSearch = { ...searchTool, description: `UNTRUSTED description ${credential(job)}`,
            inputSchema: { required: ['q'], properties: { q: { description: 'Example 1', type: 'string' } }, type: 'object' },
            annotations: { readOnlyHint: true } }
          const facts = { ...factsTool, inputSchema: { ...factsTool.inputSchema,
            ...(factsMode === 'drift' ? { description: `UNTRUSTED schema ${credential(job)}` } : {}) },
          ...(factsMode === 'task' ? { execution: { taskSupport: 'required' } } : {}) }
          result = { tools: [...(ordinaryRoster ? [reorderedSearch] : []),
            ...Array.from({ length: factsMode === 'missing' ? 0 : factsMode === 'duplicate' ? 2 : 1 }, () => facts),
            { ...searchTool, name: 'forbidden_admin' }] }
          break
        }
        case 'tools/call':
          result = { content: [{ type: 'text', text: `Result 1 from ${job}: ${credential(job)}` }] }
          break
        default:
          res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
            jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'unsupported' },
          }))
          return
      }
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }))
    })().catch(() => { res.destroy() })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('expected loopback listener')
  cleanups.push(async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
  })
  return { url: `http://127.0.0.1:${address.port}/mcp`, credential, requests,
    setFacts: (mode: typeof factsMode) => { factsMode = mode },
    dropSearch: () => { ordinaryRoster = false },
    fail: (method: string) => { failMethod = method },
    stall: (job: string) => { stalledJob = job },
  }
}

const lazyConfig: StreamableHttpConfig = {
  transport: 'streamable-http', serverName: 'bound', url: 'http://127.0.0.1:1/mcp', headers: {},
  lazyConnect: true, allowedTools: [factsTool.name, searchTool.name],
  staticTools: [searchTool, { ...factsTool, annotations: { readOnlyHint: true } }],
  toolCallTimeoutMs: 5_000, failOnStartupError: false,
}

async function composeBoundHub(options: Partial<StreamableHttpConfig> = {}) {
  const hub = await startBoundHub()
  const ctx = await mountBaseContext()
  await ctx.plugin(Loader)
  const warn = vi.spyOn(ctx.logger, 'warn')
  cleanups.push(() => { warn.mockRestore(); return Promise.resolve() })
  ctx.loader.builtins['lazy-worker-mcp'] = mcpClientPlugin
  const entry = await ctx.loader.root.create({ name: 'cordis:lazy-worker-mcp',
    config: { ...lazyConfig, includeInstructions: true, ...options, url: hub.url } })
  await ctx.loader.await()
  function agentFor(id: string) {
    const session = ctx.sessions.create(SessionId(id))
    return { id: session.id, session }
  }
  const headersFor = (sessionId: string) => ({ Authorization: `Bearer ${hub.credential(sessionId)}`,
    'X-Jarvis-Job-ID': sessionId, 'X-Jarvis-Job-Fence': '1' })
  function call(agent?: ReturnType<typeof agentFor>, raw = searchTool.name, signal = new AbortController().signal) {
    return ctx.tools.execute({ name: `mcp__bound__${raw}`, arguments: { q: 'try' }, callId: ToolCallId('worker-call'), signal,
      ...(agent === undefined ? {} : { agent: agent as never }) })
  }
  return { ctx, hub, agentFor, headersFor, call, warn, entry }
}

describe('lazy credential-bound MCP', () => {
  it('registers from staticTools and refuses absent, empty, throwing and weak credentials without any I/O', async () => {
    const { ctx, hub, agentFor, call } = await composeBoundHub({ secretHeaderMinLength: 10 })
    const session = agentFor('job-a')
    expect(ctx.tools.schemas().map(tool => tool.name)).toEqual(['mcp__bound__knowledge_search', 'mcp__bound__knowledge_facts'])
    expect((await call()).error?.message).toBe('MCP tool request failed.')
    expect((await call(session)).error?.message).toBe('MCP tool request failed.')
    let value: Record<string, string> | undefined
    ctx.provide('mcpHeaderProvider', { async headersFor() {
      if (value?.['throw'] !== undefined) throw new Error(value['throw'])
      return value
    } })
    for (value of [undefined, {}, { 'x-jarvis-job-id': ' ' }, { throw: 'not for logs' }, { authorization: 'Bearer abcdefghi' },
      { authorization: 'Bearer' }, { authorization: 'short' }, { 'mcp-session-id': 'wrong' }, { 'bad header': 'invalid' }]) {
      expect((await call(session)).error?.message).toBe('MCP tool request failed.')
    }
    expect(hub.requests).toEqual([])
  })

  it('matches canonical schemas, refuses missing, duplicate or drifting tools, and ignores remote metadata', async () => {
    const { ctx, hub, agentFor, headersFor, call, warn } = await composeBoundHub()
    const agent = agentFor('job-a')
    ctx.provide('mcpHeaderProvider', { headersFor: async () => headersFor(agent.id) })
    expect((await call(agent)).content).toEqual([{ type: 'text', text: 'Result 1 from job-a: [REDACTED]' }])
    expect(JSON.stringify(ctx.tools.schemas())).toContain('Example 1')
    expect(JSON.stringify(ctx.tools.schemas())).not.toContain('UNTRUSTED')
    expect(renderPrompt(await ctx.systemPrompt.assemble())).not.toContain('UNTRUSTED')
    expect((await call(agent, 'forbidden_admin')).isError).toBe(true)
    expect((await call(agent, factsTool.name)).error?.message).toBe('MCP tool request failed.')
    for (const mode of ['missing', 'duplicate', 'task'] as const) {
      hub.setFacts(mode)
      expect((await call(agent, factsTool.name)).error?.message).toBe('MCP tool request failed.')
    }
    hub.dropSearch()
    expect((await call(agent)).isError).toBe(true)
    expect(hub.requests.filter(request => request.method === 'tools/call')).toHaveLength(1)
    expect(warn.mock.calls).toHaveLength(4)
    expect(JSON.stringify(warn.mock.calls)).not.toContain(hub.credential(agent.id))
    expect(JSON.stringify(warn.mock.calls)).not.toContain(agent.id)
    expect(JSON.stringify(warn.mock.calls)).not.toContain('UNTRUSTED')
  })

  it('isolates protocol sessions, evicts the least recently used, refreshes on rotation and drops revoked entries', async () => {
    const { ctx, hub, agentFor, headersFor, call } = await composeBoundHub({ lazySessionCacheMax: 2 })
    const [a, b, c] = ['job-a', 'job-b', 'job-c'].map(agentFor)
    if (a === undefined || b === undefined || c === undefined) throw new Error('missing agent fixture')
    let revoked = false
    let rotate = false
    ctx.provide('mcpHeaderProvider', { headersFor: async id => id === undefined || (revoked && id === a.id) ? undefined
      : { ...headersFor(id), ...(rotate && id === a.id ? { 'x-routing-generation': '2' } : {}) } })
    for (const agent of [a, b, a, c, a, b]) expect((await call(agent)).isError).toBe(false)
    const runs = () => hub.requests.filter(request => request.method === 'tools/call').map(request => [request.job, request.mcpSession])
    expect(runs()).toEqual([
      [a.id, 'protocol-1'], [b.id, 'protocol-2'], [a.id, 'protocol-1'], [c.id, 'protocol-3'], [a.id, 'protocol-1'], [b.id, 'protocol-4'],
    ])
    revoked = true
    const count = hub.requests.length
    expect((await call(a)).isError).toBe(true)
    expect(hub.requests).toHaveLength(count)
    revoked = false
    expect((await call(a)).isError).toBe(false)
    rotate = true
    expect((await call(a)).isError).toBe(false)
    expect(runs().slice(-2)).toEqual([[a.id, 'protocol-5'], [a.id, 'protocol-6']])
    hub.fail('tools/call')
    expect((await call(a)).error?.message).toBe('MCP tool request failed.')
    hub.fail('')
    expect((await call(a)).isError).toBe(false)
    expect(runs().slice(-1)).toEqual([[a.id, 'protocol-7']])
  })

  it('closes idle connections, drops disposed session and agent handles, and unregisters on unload', async () => {
    const { ctx, hub, agentFor, headersFor, call, entry } = await composeBoundHub({ lazySessionIdleTtlMs: 25 })
    const first = agentFor('job-a')
    ctx.provide('mcpHeaderProvider', { headersFor: async id => id === undefined ? undefined : headersFor(id) })
    expect((await call(first)).isError).toBe(false)
    await new Promise((resolve) => { setTimeout(resolve, 70) })
    expect((await call(first)).isError).toBe(false)
    expect(hub.requests.filter(request => request.method === 'initialize')).toHaveLength(2)
    expect(ctx.sessions.dispose(first.session.id)).toBe(true)
    const count = hub.requests.length
    expect((await call(first)).isError).toBe(true)
    expect(hub.requests).toHaveLength(count)
    const next = agentFor(first.id)
    expect((await call(next)).isError).toBe(false)
    ctx.emit('agent/disposed', { agent: next as never })
    expect((await call(next)).isError).toBe(true)
    const active = agentFor('job-active-at-unload')
    hub.stall(active.id)
    const midInitialize = call(active)
    await vi.waitFor(() => { expect(hub.requests.some(request => request.job === active.id && request.method === 'initialize')).toBe(true) })
    await ctx.loader.root.tree.store[entry]?.fiber?.dispose()
    expect((await midInitialize).isError).toBe(true)
    expect(ctx.tools.schemas()).toEqual([])
  })

  it('cancels an evicted negotiation and refuses a stale provider response after revocation', async () => {
    const { ctx, hub, agentFor, headersFor, call } = await composeBoundHub({ lazySessionCacheMax: 1 })
    const a = agentFor('job-a')
    const b = agentFor('job-b')
    type Headers = ReturnType<typeof headersFor>
    const held = Promise.withResolvers<Headers>()
    let next: Promise<Headers | undefined> = held.promise
    let pending = false
    ctx.provide('mcpHeaderProvider', { async headersFor(id) {
      if (id === a.id) { pending = true; return next }
      return headersFor(b.id)
    } })
    const before = call(a)
    await vi.waitFor(() => { expect(pending).toBe(true) })
    next = Promise.resolve(undefined)
    expect((await call(a)).isError).toBe(true)
    held.resolve(headersFor(a.id))
    expect((await before).isError).toBe(true)
    expect(hub.requests).toEqual([])

    next = Promise.resolve(headersFor(a.id))
    hub.stall(a.id)
    const negotiating = call(a)
    await vi.waitFor(() => { expect(hub.requests.map(request => request.method)).toEqual(['initialize']) })
    expect((await call(b)).isError).toBe(false)
    expect((await negotiating).isError).toBe(true)
    expect(hub.requests.some(request => request.job === a.id && request.method === 'tools/list')).toBe(false)
    const cancellation = new AbortController()
    const aborted = call(a, searchTool.name, cancellation.signal)
    await vi.waitFor(() => { expect(hub.requests.filter(request => request.job === a.id)).toHaveLength(2) })
    cancellation.abort()
    expect((await aborted).isError).toBe(true)
  })

  it('rolls back a partly registered static roster', async () => {
    const ctx = await mountBaseContext()
    const register = ctx.tools.register.bind(ctx.tools)
    const spy = vi.spyOn(ctx.tools, 'register').mockImplementationOnce(register).mockImplementationOnce(() => {
      throw new Error('registration conflict')
    })
    try {
      await expect(apply(ctx, lazyConfig)).rejects.toThrow('registration conflict')
      expect(ctx.tools.schemas()).toEqual([])
    } finally {
      spy.mockRestore()
    }
  })

  it('rejects configuration errors before registration', async () => {
    const ctx = await mountBaseContext()
    const patches: Array<[Partial<StreamableHttpConfig>, string]> = [
      [{ lazyConnect: false }, 'staticTools requires lazyConnect'],
      [{ lazyConnect: 'yes' as never }, 'lazyConnect must be a boolean'],
      [{ requireDynamicHeaders: 'yes' as never }, 'requireDynamicHeaders must be a boolean'],
      [{ failOnStartupError: true }, 'incompatible with failOnStartupError'],
      [{ staticTools: {} as never }, 'requires non-empty staticTools'],
      [{ staticTools: [] }, 'requires non-empty staticTools'],
      [{ staticTools: [null as never] }, 'Invalid MCP staticTools entry'],
      [{ staticTools: [{ ...searchTool, name: '' }] }, 'Invalid MCP staticTools entry'],
      [{ staticTools: [{ ...searchTool, description: null as never }] }, 'Invalid MCP staticTools entry'],
      [{ staticTools: [{ ...searchTool, inputSchema: null as never }] }, 'Invalid MCP staticTools entry'],
      [{ staticTools: [{ ...searchTool, inputSchema: [] as never }] }, 'Invalid MCP staticTools entry'],
      [{ staticTools: [{ ...searchTool, inputSchema: { type: 'string' } as never }] }, 'Invalid MCP staticTools entry'],
      [{ staticTools: [{ ...searchTool, inputSchema: { type: 'object', '$comment': Infinity } }] }, 'Invalid MCP staticTools entry'],
      [{ staticTools: [{ ...searchTool, annotations: [] as never }] }, 'Invalid MCP staticTools entry'],
      [{ staticTools: [searchTool, searchTool] }, 'contains duplicate names'],
      [{ allowedTools: [] }, 'must match staticTools names exactly'],
      [{ allowedTools: [searchTool.name, 'another'] }, 'must match staticTools names exactly'],
      [{ lazySessionCacheMax: 0 }, 'lazySessionCacheMax must be a positive integer'],
      [{ lazySessionCacheMax: 1.5 }, 'lazySessionCacheMax must be a positive integer'],
      [{ lazySessionIdleTtlMs: 0 }, 'within the timer range'],
      [{ lazySessionIdleTtlMs: 1.5 }, 'within the timer range'],
      [{ lazySessionIdleTtlMs: 2 ** 31 }, 'within the timer range'],
      [{ secretHeaderNames: 'authorization' as never }, 'must be an array of HTTP header names'],
      [{ secretHeaderNames: [7 as never] }, 'must be an array of HTTP header names'],
      [{ secretHeaderNames: ['invalid header'] }, 'must be an array of HTTP header names'],
      [{ secretHeaderMinLength: 0 }, 'secretHeaderMinLength must be a positive integer'],
      [{ secretHeaderMinLength: Infinity }, 'secretHeaderMinLength must be a positive integer'],
      [{ headers: { 'mcp-session-id': 'wrong' } }, 'MCP session header is transport-owned'],
      [{ headers: { Cookie: 'secret' } }, 'MCP request headers unavailable'],
      [{ headers: { 'X-API-Key': 'Search the release roster' } }, 'static tool metadata contains a credential'],
    ]
    for (const [patch, error] of patches) {
      // A fresh registry separates validation from namespace rollback after a registration failure.
      const target = error.includes('metadata') ? await mountBaseContext() : ctx
      await expect(apply(target, { ...lazyConfig, ...patch })).rejects.toThrow(error)
      expect(target.tools.schemas()).toEqual([])
    }
    await expect(apply(ctx, { ...lazyConfig, transport: 'stdio' } as never)).rejects.toThrow('require streamable-http')
  })
})

interface CanaryHttpFixture {
  url: string
  seenAuthHeaders: Array<string | undefined>
  calls: string[]
  setBehavior: (next: { failStatus?: number; failBody?: string; echoHeaderInResult?: boolean; errorResult?: string }) => void
}

async function startCanaryHttpMcpFixture(options: {
  instructions?: string
  tools?: Array<{ name: string; description?: string }>
} = {}): Promise<CanaryHttpFixture> {
  const seenAuthHeaders: Array<string | undefined> = []
  const calls: string[] = []
  let lastAuth = ''
  let behavior: { failStatus?: number; failBody?: string; echoHeaderInResult?: boolean; errorResult?: string } = {}
  const toolList = options.tools ?? [
    { name: 'knowledge_search', description: 'Search knowledge' },
    { name: 'knowledge_facts', description: 'Read facts' },
    { name: 'forbidden_admin', description: 'Admin action' },
  ]

  const handler = createMcpHandler(() => {
    const mcp = new McpServer(
      { name: 'canary-http', version: '1.0.0' },
      {
        capabilities: { tools: {} },
        ...(options.instructions === undefined ? {} : { instructions: options.instructions }),
      },
    )
    for (const def of toolList) {
      mcp.registerTool(
        def.name,
        { description: def.description ?? def.name, inputSchema: z.object({ q: z.string().optional() }) },
        async (args): Promise<CallToolResult> => {
          calls.push(def.name)
          if (behavior.errorResult !== undefined) {
            return {
              content: [{ type: 'text', text: behavior.errorResult.replace('{{AUTH}}', lastAuth) }],
              isError: true,
            }
          }
          if (behavior.echoHeaderInResult) {
            return {
              content: [{ type: 'text', text: `ok:${def.name}:${args.q ?? ''}:${lastAuth}` }],
              structuredContent: { echoed: lastAuth },
            }
          }
          return { content: [{ type: 'text', text: `ok:${def.name}:${args.q ?? ''}` }] }
        },
      )
    }
    return mcp
  })

  const handle = toNodeHandler(handler)
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const auth = typeof req.headers.authorization === 'string' ? req.headers.authorization : undefined
    seenAuthHeaders.push(auth)
    lastAuth = auth ?? ''
    if (behavior.failStatus !== undefined) {
      res.writeHead(behavior.failStatus, { 'content-type': 'text/plain' })
      res.end((behavior.failBody ?? 'upstream error').replace('{{AUTH}}', lastAuth))
      return
    }
    handle(req as NodeIncomingMessageLike, res).catch((err: unknown) => {
      res.writeHead(500).end(String(err))
    })
  })

  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const addr = server.address()
  if (addr === null || typeof addr === 'string') throw new Error('expected TCP address')
  cleanups.push(async () => {
    await handler.close()
    await new Promise<void>((resolve, reject) => {
      server.close((err) => { if (err === undefined) resolve(); else reject(err) })
    })
  })
  return {
    url: `http://127.0.0.1:${addr.port}/mcp`,
    seenAuthHeaders,
    calls,
    setBehavior(next) { behavior = next },
  }
}

async function mountBaseContext(): Promise<Context> {
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(SessionStore)
  return ctx
}

describe('mcp-client worker hardening (A1-A4)', () => {
  it('A1: Config validates allowedTools and includeInstructions', () => {
    const parsed = ConfigSchema({
      transport: 'streamable-http',
      serverName: 'hub',
      url: 'http://127.0.0.1:9000/mcp',
      allowedTools: ['knowledge_search'],
      includeInstructions: false,
    } as never)
    expect(parsed).toMatchObject({ allowedTools: ['knowledge_search'], includeInstructions: false })

    expect(() => ConfigSchema({
      transport: 'stdio',
      serverName: 'hub',
      command: 'echo',
      allowedTools: [''],
    } as never)).toThrow()
  })

  it('A1: filters tools/list before registration and fails loud on unknown allowedTools', async () => {
    const fixture = await startCanaryHttpMcpFixture()
    const ctx = await mountBaseContext()

    await apply(ctx, {
      transport: 'streamable-http',
      serverName: 'hub',
      url: fixture.url,
      headers: {},
      allowedTools: ['knowledge_search', 'knowledge_facts'],
      includeInstructions: true,
      toolCallTimeoutMs: 5_000,
      failOnStartupError: true,
      reconnect: { enabled: false },
    } as never)

    expect(ctx.tools.schemas().map(t => t.name).sort()).toEqual([
      'mcp__hub__knowledge_facts',
      'mcp__hub__knowledge_search',
    ])
    expect(ctx.tools.get('mcp__hub__forbidden_admin')).toBeUndefined()
    const deniedDirect = await ctx.tools.execute({
      name: 'mcp__hub__forbidden_admin',
      arguments: {},
      callId: ToolCallId('direct-unlisted'),
      signal: new AbortController().signal,
    })
    expect(deniedDirect.isError).toBe(true)
    expect(fixture.calls).toEqual([])

    const badCtx = await mountBaseContext()
    await expect(apply(badCtx, {
      transport: 'streamable-http',
      serverName: 'hub2',
      url: fixture.url,
      headers: {},
      allowedTools: ['knowledge_search', 'nonexistent_tool'],
      toolCallTimeoutMs: 5_000,
      failOnStartupError: true,
      reconnect: { enabled: false },
    } as never)).rejects.toThrow()
  })

  it('A1: unknown allowedTools fails loud on refresh while keeping previous generation', async () => {
    const ctx = await mountBaseContext()
    const listTools = vi.fn()
      .mockResolvedValueOnce({ tools: [{ name: 'a', inputSchema: { type: 'object' } }, { name: 'b', inputSchema: { type: 'object' } }] })
      .mockResolvedValueOnce({ tools: [{ name: 'b', inputSchema: { type: 'object' } }] })
    const fakeClient = {
      getServerCapabilities: () => ({ tools: {} }),
      listTools,
      callTool: vi.fn(),
    }
    const first = await syncTools(fakeClient as never, ctx, {
      registrationFailure: 'contain',
      serverName: 'srv',
      toolCallTimeoutMs: 5_000,
      allowedTools: ['a'],
    } as never, new Map())
    expect(first.size).toBe(1)
    expect(ctx.tools.get('mcp__srv__a')).toBeDefined()
    expect(ctx.tools.get('mcp__srv__b')).toBeUndefined()

    await expect(syncTools(fakeClient as never, ctx, {
      registrationFailure: 'contain',
      serverName: 'srv',
      toolCallTimeoutMs: 5_000,
      allowedTools: ['a'],
    } as never, first)).rejects.toThrow(/nonexistent|unknown|not listed.*a|a/i)
    expect(ctx.tools.get('mcp__srv__a')).toBeDefined()
  })

  it('A2: omits server instructions system-prompt section when includeInstructions is false', async () => {
    const fixture = await startCanaryHttpMcpFixture({
      instructions: 'SECRET_PROMPT_SHOULD_NOT_APPEAR',
    })
    const ctx = await mountBaseContext()
    await apply(ctx, {
      transport: 'streamable-http',
      serverName: 'hub',
      url: fixture.url,
      headers: {},
      includeInstructions: false,
      toolCallTimeoutMs: 5_000,
      failOnStartupError: true,
      reconnect: { enabled: false },
    } as never)

    const rendered = renderPrompt(await ctx.systemPrompt.assemble())
    expect(rendered).not.toContain('SECRET_PROMPT_SHOULD_NOT_APPEAR')
    expect(rendered).not.toContain('### MCP server: hub')
  })

  it('A3+A4: injects per-session headers via mcpHeaderProvider and redacts echoed canary from results, errors, and logs', async () => {
    const canaryA = 'CANARY_SECRET_TOKEN_ALPHA_9988'
    const canaryB = 'CANARY_SECRET_TOKEN_BETA_7766'
    const staticCanary = 'CANARY_STATIC_SECRET_5544'
    const fixture = await startCanaryHttpMcpFixture({
      instructions: 'Server ready.',
    })
    const ctx = await mountBaseContext()
    const logs: string[] = []
    ctx.logger.warn = ((msg: unknown) => { logs.push(String(msg)) }) as typeof ctx.logger.warn
    ctx.logger.error = ((msg: unknown) => { logs.push(String(msg)) }) as typeof ctx.logger.error

    ctx.provide('mcpHeaderProvider' as never, {
      headersFor: async (sessionId: string | undefined, serverId: string) => {
        if (serverId !== 'hub') return undefined
        if (sessionId === 'sess-a') return { Authorization: `Bearer ${canaryA}` }
        if (sessionId === 'sess-b') return { Authorization: `Bearer ${canaryB}` }
        return { Authorization: 'Bearer discovery-only-token' }
      },
    } as never)

    await apply(ctx, {
      transport: 'streamable-http',
      serverName: 'hub',
      url: fixture.url,
      headers: { 'X-Static-Secret': staticCanary },
      secretHeaderNames: ['authorization', 'x-static-secret'],
      allowedTools: ['knowledge_search'],
      includeInstructions: false,
      toolCallTimeoutMs: 5_000,
      failOnStartupError: true,
      reconnect: { enabled: false },
    } as never)

    const sessA = ctx.sessions.create(SessionId('sess-a'))
    const sessB = ctx.sessions.create(SessionId('sess-b'))

    // Session A call carries canaryA; echoed in normal result -> must be redacted!
    fixture.setBehavior({ echoHeaderInResult: true })
    const resA = await ctx.tools.execute({
      name: 'mcp__hub__knowledge_search',
      arguments: { q: 'hello' },
      callId: ToolCallId('call-a'),
      signal: new AbortController().signal,
      agent: { id: sessA.id, session: sessA } as never,
    })
    expect(resA.isError).toBe(false)
    expect(fixture.seenAuthHeaders).toContain(`Bearer ${canaryA}`)
    expect(JSON.stringify(resA)).not.toContain(canaryA)
    expect(JSON.stringify(resA)).not.toContain(staticCanary)

    // Session B call carries canaryB; echoed in isError result (plus huge text) -> bounded & redacted!
    fixture.setBehavior({ errorResult: `boom {{AUTH}} ${'x'.repeat(2000)}` })
    const resB = await ctx.tools.execute({
      name: 'mcp__hub__knowledge_search',
      arguments: { q: 'world' },
      callId: ToolCallId('call-b'),
      signal: new AbortController().signal,
      agent: { id: sessB.id, session: sessB } as never,
    })
    expect(resB.isError).toBe(true)
    expect(fixture.seenAuthHeaders).toContain(`Bearer ${canaryB}`)
    expect(JSON.stringify(resB)).not.toContain(canaryB)
    expect(resB.content[0]?.type === 'text' ? resB.content[0].text.length : 0).toBeLessThanOrEqual(700)

    // HTTP error echoing canary -> normalized error & logs must NOT contain canary
    fixture.setBehavior({ failStatus: 500, failBody: 'proxy leaked {{AUTH}}' })
    const resErr = await ctx.tools.execute({
      name: 'mcp__hub__knowledge_search',
      arguments: { q: 'err' },
      callId: ToolCallId('call-err'),
      signal: new AbortController().signal,
      agent: { id: sessA.id, session: sessA } as never,
    })
    expect(resErr.isError).toBe(true)
    expect(JSON.stringify(resErr)).not.toContain(canaryA)

    // Connection failure echoing static header -> logs & startup error must NOT contain staticCanary
    const failCtx = await mountBaseContext()
    const failLogs: string[] = []
    failCtx.logger.warn = ((msg: unknown) => { failLogs.push(String(msg)) }) as typeof failCtx.logger.warn
    failCtx.logger.error = ((msg: unknown) => { failLogs.push(String(msg)) }) as typeof failCtx.logger.error
    fixture.setBehavior({ failStatus: 502, failBody: `echo ${staticCanary}` })
    const conn = startConnection(failCtx, {
      transport: 'streamable-http',
      serverName: 'hub-fail',
      url: fixture.url,
      headers: { Authorization: `Bearer ${staticCanary}` },
      toolCallTimeoutMs: 5_000,
      failOnStartupError: true,
    } as never, resolveReconnectPolicy({ enabled: false }, 'hub-fail'))
    cleanups.push(() => conn.dispose())
    const outcome = await conn.ready
    expect(outcome.error).toBeDefined()
    expect(String(outcome.error)).not.toContain(staticCanary)
    expect(failLogs.join('\n')).not.toContain(staticCanary)
    expect(logs.join('\n')).not.toContain(canaryA)
    expect(logs.join('\n')).not.toContain(canaryB)
    expect(JSON.stringify(ctx.tools.schemas())).not.toContain(canaryA)
    expect(JSON.stringify(ctx.tools.schemas())).not.toContain(canaryB)
    expect(renderPrompt(await ctx.systemPrompt.assemble())).not.toContain(canaryA)
    expect(sessA.snapshotEvents().map(e => JSON.stringify(e)).join('\n')).not.toContain(canaryA)
  })

  it('A4: real Loader composition activates mcp-client with allowedTools and mcpHeaderProvider', async () => {
    const fixture = await startCanaryHttpMcpFixture()
    const ctx = new Context()
    const errors = vi.spyOn(ctx.logger, 'error')
    cleanups.push(() => ctx.fiber.dispose())
    await ctx.plugin(Loader)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(SessionStore)
    ctx.loader.builtins['mcp-client'] = mcpClientPlugin
    ctx.provide('mcpHeaderProvider' as never, {
      headersFor: async (sessionId: string | undefined) => sessionId
        ? { Authorization: `Bearer loader-${sessionId}` }
        : { Authorization: 'Bearer loader-init' },
    } as never)

    await ctx.loader.root.create({
      name: 'cordis:mcp-client',
      config: {
        transport: 'streamable-http',
        serverName: 'hub',
        url: fixture.url,
        allowedTools: ['knowledge_search'],
        includeInstructions: false,
        failOnStartupError: true,
        reconnect: { enabled: false },
      },
    })
    await ctx.loader.await()

    expect(errors.mock.calls).toEqual([])
    expect(ctx.tools.schemas().map(t => t.name)).toEqual(['mcp__hub__knowledge_search'])
    const session = ctx.sessions.create(SessionId('loader-sess'))
    const result = await ctx.tools.execute({
      name: 'mcp__hub__knowledge_search',
      arguments: { q: 'test' },
      callId: ToolCallId('loader-call'),
      signal: new AbortController().signal,
      agent: { id: session.id, session } as never,
    })
    expect(result.isError).toBe(false)
    expect(fixture.seenAuthHeaders).toContain('Bearer loader-loader-sess')
  })

  it('enforces required dynamic headers in eager mode, including for scoped startup discovery', async () => {
    const fixture = await startCanaryHttpMcpFixture({ tools: [{ name: 'knowledge_search', description: 'Example 1' }] })
    const ctx = await mountBaseContext()
    const config: StreamableHttpConfig = {
      transport: 'streamable-http', serverName: 'required', url: fixture.url, headers: {},
      allowedTools: ['knowledge_search'], requireDynamicHeaders: true,
      toolCallTimeoutMs: 5_000, failOnStartupError: true, reconnect: { enabled: false },
    }
    await expect(apply(ctx, config)).rejects.toThrow('initial connection or tool synchronization failed')
    expect(fixture.seenAuthHeaders).toEqual([])

    const session = ctx.sessions.create(SessionId('eager-session'))
    const agent = { id: session.id, session }
    const scope = createScope(ctx, agent)
    cleanups.push(() => scope.dispose())
    let supplied: Record<string, string> | undefined
    const canary = 'eager-provider-canary'
    ctx.provide('mcpHeaderProvider', { headersFor: async id => id === 'eager-session' ? supplied : undefined })
    const beforeProvider = startConnection(scope.ctx, config, resolveReconnectPolicy(config.reconnect, 'required'))
    expect((await beforeProvider.ready).error).toBeDefined()
    await beforeProvider.dispose()
    expect(fixture.seenAuthHeaders).toEqual([])

    supplied = { authorization: `Bearer ${canary}`, 'x-jarvis-job-fence': '1' }
    await scope.ctx.plugin(mcpClientPlugin, config)
    const run = (withSession: boolean) => ctx.tools.execute({
      name: 'mcp__required__knowledge_search', callId: ToolCallId('required'), arguments: { q: '1' },
      signal: new AbortController().signal, ...(withSession ? { agent: agent as never } : {}),
    })
    fixture.setBehavior({ echoHeaderInResult: true })
    expect((await run(true)).content).toEqual([{ type: 'text', text: 'ok:knowledge_search:1:[REDACTED]' }])
    const count = fixture.seenAuthHeaders.length
    supplied = {}
    expect((await run(true)).error?.message).toBe('MCP tool request failed.')
    expect((await run(false)).isError).toBe(true)
    expect(fixture.seenAuthHeaders).toHaveLength(count)

    const warn = vi.spyOn(ctx.logger, 'warn')
    try {
      const routingId = 'not-for-diagnostics-1234'
      supplied = { authorization: `Bearer ${canary}`, 'x-jarvis-job-id': routingId }
      fixture.setBehavior({ failStatus: 500, failBody: `provider returned ${routingId}: {{AUTH}}` })
      const failed = startConnection(scope.ctx, config, resolveReconnectPolicy(config.reconnect, 'required'))
      const outcome = await failed.ready
      await failed.dispose()
      expect(outcome.error).toMatchObject({ message: 'mcp-client(required): connection attempt failed' })
      expect(JSON.stringify(warn.mock.calls)).not.toContain(routingId)
      expect(JSON.stringify(warn.mock.calls)).not.toContain(canary)
    } finally {
      warn.mockRestore()
    }
  })

  it('A1-A4: covers programmatic validation, redact edge cases, stdio env redaction, and transport fallbacks', async () => {
    const ctx = await mountBaseContext()
    await expect(apply(ctx, {
      transport: 'stdio',
      serverName: 'bad1',
      command: 'echo',
      args: [],
      env: {},
      cwd: '',
      toolCallTimeoutMs: 5_000,
      failOnStartupError: false,
      allowedTools: 'not-array' as never,
    })).rejects.toThrow(/must be an array/)

    await expect(apply(ctx, {
      transport: 'stdio',
      serverName: 'bad2',
      command: 'echo',
      args: [],
      env: {},
      cwd: '',
      toolCallTimeoutMs: 5_000,
      failOnStartupError: false,
      allowedTools: [''],
    })).rejects.toThrow(/non-empty strings/)

    await expect(apply(ctx, {
      transport: 'stdio',
      serverName: 'bad3',
      command: 'echo',
      args: [],
      env: {},
      cwd: '',
      toolCallTimeoutMs: 5_000,
      failOnStartupError: false,
      allowedTools: ['dup', 'dup'],
    })).rejects.toThrow(/duplicate entry/)

    await expect(apply(ctx, {
      transport: 'stdio',
      serverName: 'bad4',
      command: 'echo',
      args: [],
      env: {},
      cwd: '',
      toolCallTimeoutMs: 5_000,
      failOnStartupError: false,
      includeInstructions: 'yes' as never,
    })).rejects.toThrow(/must be a boolean/)

    // SecretRedactor branches: env, LRU eviction, duplicate dynamic refresh, JSON, hostile errors
    const redactor = new SecretRedactor()
    redactor.addEnv('API_TOKEN', 'secret-env-val')
    redactor.addEnv('COLOR', 'untouched')
    redactor.addHeader(' ')
    redactor.addHeader('Bearer secret-env-val')
    redactor.addHeader('Bearer dyn-secret-1')
    redactor.addHeader('Bearer dyn-secret-1')
    for (let i = 0; i < 520; i += 1) {
      redactor.addHeader(`dynamic-evict-value-${i}`)
    }
    expect(redactor.redact('secret-env-val')).toBe('[REDACTED]')
    redactor.addHeader('Bearer special:secret!')
    expect(redactor.redact('header Bearer special:secret! / special:secret!')).toBe('header [REDACTED] / [REDACTED]')
    expect(redactor.redactJson(['a', 42, null, { k: 'secret-env-val', n: 1 }])).toEqual([
      'a', 42, null, { k: '[REDACTED]', n: 1 },
    ])
    expect(boundText('abcdef', 3)).toBe('ab…')
    expect(boundText('ab', 0)).toBe('…')

    expect(formatBoundedError({ message: 'secret-env-val' }, redactor, 'fb')).toBe('[REDACTED]')
    expect(formatBoundedError('plain string error')).toBe('plain string error')
    expect(formatBoundedError('   ', redactor, 'empty-fb')).toBe('empty-fb')
    const hostile = { toString() { throw new Error('boom') } }
    expect(formatBoundedError(hostile, redactor, 'hostile-fb')).toBe('hostile-fb')
    expect(sanitizeError(hostile, redactor, 'hostile-san').toString()).toContain('hostile-san')
    expect(sanitizeError('secret-env-val', redactor, 'san-fb')).toBeInstanceOf(Error)
    expect(sanitizeError('   secret-env-val   ', redactor, 'san-fb')).toBeInstanceOf(Error)
    expect(sanitizeError(' ', redactor, 'blank').message).toBe('blank')
    expect(sanitizeError(new Error('clean', { cause: new Error('secret-env-val') }), redactor).cause).toBeUndefined()

    // isError empty after redaction -> fallback message
    const fixture = await startCanaryHttpMcpFixture()
    const client = {
      getServerCapabilities: () => ({ tools: {} }),
      listTools: async () => ({ tools: [{ name: 't', inputSchema: { type: 'object' } }] }),
      callTool: async (): Promise<unknown> => ({ content: [{ type: 'text', text: '   ' }], isError: true }),
    }
    await syncTools(client as never, ctx, {
      registrationFailure: 'contain',
      serverName: 'emptyerr',
      toolCallTimeoutMs: 5_000,
      redactor,
    }, new Map())
    const errRes = await ctx.tools.execute({
      name: 'mcp__emptyerr__t',
      arguments: {},
      callId: ToolCallId('e-empty'),
      signal: new AbortController().signal,
    })
    expect(errRes.isError).toBe(true)
    expect(errRes.error?.message).toBe('MCP server reported a tool error.')

    client.callTool = async () => ({ content: [{ type: 'text', text: 'ok', _meta: { invalid: new Map() } }] })
    expect((await ctx.tools.execute({ name: 'mcp__emptyerr__t', arguments: {}, callId: ToolCallId('lossy-value'),
      signal: new AbortController().signal })).error?.message).toBe('MCP server returned an invalid tool result.')

    client.listTools = async () => ({ tools: [{ name: 't', inputSchema: { type: 'object', description: 'secret-env-val' } }] })
    await expect(syncTools(client as never, ctx, { registrationFailure: 'throw', serverName: 'no-secrets',
      toolCallTimeoutMs: 5_000, redactor }, new Map())).rejects.toThrow('metadata contains a configured header value')

    // An optional dynamic provider can be installed or withdrawn while the plugin runs.
    let activeProvider: { headersFor: () => Promise<Record<string, string> | undefined> } | undefined = {
      headersFor: async () => undefined,
    }
    const transport = createTransport({
      transport: 'streamable-http',
      serverName: 'dyn-undef',
      url: fixture.url,
      headers: {},
      toolCallTimeoutMs: 5_000,
      failOnStartupError: false,
    }, {
      getHeaderProvider: () => activeProvider,
      redactor,
    })
    expect(transport).toBeDefined()
    // Exercise provider returning undefined, then non-string header value, then undefined provider over real HTTP
    const conn = startConnection(Object.assign(ctx.extend({}), {}), {
      transport: 'streamable-http',
      serverName: 'undef-provider',
      url: fixture.url,
      headers: {},
      toolCallTimeoutMs: 5_000,
      failOnStartupError: false,
    }, resolveReconnectPolicy({ enabled: false }, 'undef-provider'))
    cleanups.push(() => conn.dispose())
    ctx.provide('mcpHeaderProvider', { headersFor: async () => activeProvider?.headersFor() })
    await conn.ready
    activeProvider = { headersFor: async () => { throw new Error('provider-echo-canary') } }
    const callRes = await ctx.tools.execute({
      name: 'mcp__undef-provider__knowledge_search',
      arguments: {},
      callId: ToolCallId('non-string-hdr'),
      signal: new AbortController().signal,
    })
    expect(callRes.error?.message).toBe('MCP tool request failed.')
    activeProvider = undefined

    // Scoped agent context (including empty id scope)
    const emptyIdScope = createScope(ctx, { id: '' })
    const emptyScopedConn = startConnection(emptyIdScope.ctx, {
      transport: 'stdio',
      serverName: 'empty-scoped-stdio',
      command: process.execPath,
      args: ['-e', 'process.exit(1)'],
      env: {},
      cwd: '',
      toolCallTimeoutMs: 5_000,
      failOnStartupError: false,
    }, resolveReconnectPolicy({ enabled: false }, 'empty-scoped-stdio'))
    await emptyScopedConn.ready
    await emptyScopedConn.dispose()
    await emptyIdScope.dispose()

    const scoped = createScope(ctx, { id: 'agent-scope-1' })
    const scopedConn = startConnection(scoped.ctx, {
      transport: 'stdio',
      serverName: 'scoped-stdio',
      command: process.execPath,
      args: ['-e', 'process.exit(1)'],
      env: { SECRET_KEY: 'stdio-canary' },
      cwd: '',
      toolCallTimeoutMs: 5_000,
      failOnStartupError: false,
    }, resolveReconnectPolicy({ enabled: false }, 'scoped-stdio'))
    await scopedConn.ready
    await scopedConn.dispose()
    await scoped.dispose()
  })
})
