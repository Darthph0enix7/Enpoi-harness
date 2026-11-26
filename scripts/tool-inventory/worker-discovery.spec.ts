import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inspect } from 'node:util'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { brandString } from '@deepseek-ai/dsh-brand'
import { createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { expect, it, vi } from 'vitest'
import { PeerJobBindingStore } from '../../packages/api/peer/src/job-bindings.ts'
import type { PeerAlias } from '../../packages/api/peer/src/types.ts'
import { MockAdapter, textResponse, toolCallResponse } from '../../packages/core/agent-loop/tests/mock-adapter.ts'
import * as mcpClient from '../../packages/mcp/mcp-client/src/index.ts'
import * as credentials from '../../profile/web/packages/enpoi-worker-credentials/src/index.ts'

it('loads the release roster before peer binds a job and runs it only with live worker credentials', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-worker-discovery-'))
  const secretDir = join(home, 'worker-secrets')
  const canary = 'fabricated.worker-discovery-canary'
  const methods: string[] = []
  const name = 'mcp__jarvis__knowledge_search'
  const inputSchema = { type: 'object', properties: { q: { type: 'string', description: 'At least 1 term' } } }
  const staticTools = [
    { name: 'knowledge_search', description: 'Search trusted knowledge', inputSchema },
    { name: 'knowledge_facts', description: 'Read trusted facts', inputSchema },
  ]
  let requests = 0
  let unauthorized = 0
  async function serve(req: IncomingMessage, res: ServerResponse): Promise<void> {
    requests++
    if (req.headers.authorization !== `Bearer ${canary}` || req.headers['x-jarvis-job-id'] !== 'job-1'
      || req.headers['x-jarvis-job-fence'] !== '1') {
      unauthorized++
      req.resume()
      res.writeHead(401).end('unauthorized')
      return
    }
    if (req.method !== 'POST') {
      res.writeHead(405).end()
      return
    }
    req.setEncoding('utf8')
    let body = ''
    for await (const chunk of req) body += String(chunk)
    const message = JSON.parse(body) as { method: string; id?: number }
    methods.push(message.method)
    if (message.id === undefined) {
      res.writeHead(202).end()
      return
    }
    const results: Record<string, object> = {
      initialize: { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'hub', version: '1' }, instructions: `untrusted instructions ${canary}` },
      'tools/list': {
        tools: [...staticTools.map(tool => ({ ...tool, description: `untrusted description ${canary}` })),
          { name: 'forbidden_admin', inputSchema }],
      },
      'tools/call': { content: [{ type: 'text', text: `Found 1 result: ${canary}` }] },
    }
    const result = results[message.method]
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
      jsonrpc: '2.0', id: message.id,
      ...(result === undefined ? { error: { code: -32601, message: 'unsupported' } } : { result }),
    }))
  }
  const server = createServer((req, res) => { void serve(req, res).catch(() => { res.destroy() }) })
  const ctx = new Context()
  const logs = (['info', 'warn', 'error'] as const).map(level => vi.spyOn(ctx.logger, level))
  try {
    await mkdir(secretDir, { mode: 0o700 })
    await writeFile(join(secretDir, 'attempt-1'), `${canary}\n`, { mode: 0o600 })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject)
        resolve()
      })
    })
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('Expected a loopback TCP listener')
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(Loader)
    const bindings = new PeerJobBindingStore(join(home, 'peer-job-bindings.json'))
    ctx.provide('peerJobBindings', bindings)
    ctx.loader.builtins['worker-credentials'] = credentials
    await ctx.loader.root.create({ name: 'cordis:worker-credentials', config: { serverId: 'jarvis', secretDir } })
    ctx.loader.builtins['worker-mcp'] = mcpClient
    await ctx.loader.root.create({ name: 'cordis:worker-mcp', config: {
      serverName: 'jarvis', transport: 'streamable-http', url: `http://127.0.0.1:${address.port}/mcp`,
      allowedTools: staticTools.map(tool => tool.name), staticTools, lazyConnect: true, toolCallTimeoutMs: 1_000,
    } })
    await ctx.loader.await()
    expect(ctx.tools.schemas().map(tool => tool.name).sort()).toEqual(['mcp__jarvis__knowledge_facts', name])
    expect(requests).toBe(0)

    const agent = await ctx.agentLoop.create(SessionId('worker-job'), { provider: 'mock', model: 'mock' })
    const noBinding = await ctx.tools.execute({ name, arguments: { q: 'example' }, agent,
      callId: ToolCallId('unbound'), signal: new AbortController().signal })
    expect(noBinding.error?.message).toBe('MCP tool request failed.')
    expect(requests).toBe(0)
    await bindings.put({
      sessionId: agent.session.id, alias: brandString<PeerAlias>('jarvis'), instanceId: 'worker', createdAt: Date.now(),
      jobId: 'job-1', fence: 1, expiresAt: Date.now() + 30_000, credentialRef: 'attempt-1', mcpEndpointId: 'jarvis',
      capabilities: [], limits: {},
    })
    const adapter = new MockAdapter([toolCallResponse('bound', name, { q: 'example' }), textResponse('Done.')])
    ctx.llm.registerAdapter(['mock'], adapter)
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Find an example.' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    expect(methods.filter(method => !method.startsWith('notifications/'))).toEqual(['initialize', 'tools/list', 'tools/call'])
    expect(unauthorized).toBe(0)
    expect(ctx.tools.get('mcp__jarvis__forbidden_admin')).toBeUndefined()
    const model = inspect(adapter.requests, { depth: null })
    const journal = JSON.stringify(agent.session.snapshotEvents())
    expect(model).toContain('Search trusted knowledge')
    expect(model).toContain('At least 1 term')
    expect(model).toContain('Found 1 result: [REDACTED]')
    expect(journal).toContain('Found 1 result: [REDACTED]')
    expect(inspect([model, journal, noBinding, logs.map(log => log.mock.calls)], { depth: null })).not.toContain(canary)
    expect(model).not.toContain('untrusted')
    expect(await bindings.revoke(agent.session.id)).toBe(true)
    const before = requests
    const revoked = await ctx.tools.execute({ name, arguments: { q: 'example' }, agent,
      callId: ToolCallId('revoked'), signal: new AbortController().signal })
    expect(revoked.error?.message).toBe('MCP tool request failed.')
    expect(requests).toBe(before)
  } finally {
    try {
      await ctx.fiber.dispose()
    } finally {
      server.closeAllConnections()
      await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
      await rm(home, { recursive: true, force: true })
      for (const log of logs) log.mockRestore()
    }
  }
})
