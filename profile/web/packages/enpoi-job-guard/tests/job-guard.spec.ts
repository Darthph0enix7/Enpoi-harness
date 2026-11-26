import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { lstatSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { boot, type ProfileContext } from '@deepseek-ai/dsh-app-boot'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { LlmAdapter, LlmError, LlmRuntime, ToolCallId, createUserMessage, type GenerateOptions, type LlmResolvedModelInfo, type StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as McpClient from '@deepseek-ai/dsh-mcp-client'
import * as JobGuard from '../src/index.ts'
import type { PeerProfileIdentityService, RuntimePeerJobBinding } from '../src/types.ts'

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  vi.unstubAllGlobals()
  while (cleanups.length > 0) {
    await cleanups.pop()!()
  }
})

type FakeBinding = RuntimePeerJobBinding

interface HubServerHandle {
  url: string
  requests: Array<{ headers: Record<string, string | string[] | undefined>; body: unknown }>
  setHandler: (fn: (body: Record<string, unknown>, req: IncomingMessage, res: ServerResponse) => Promise<void> | void) => void
}

async function startFakeHubServer(): Promise<HubServerHandle> {
  const requests: Array<{ headers: Record<string, string | string[] | undefined>; body: unknown }> = []
  let customHandler: (body: Record<string, unknown>, req: IncomingMessage, res: ServerResponse) => Promise<void> | void =
    (_body, _req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ allowed: true }))
    }

  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      let parsed: unknown = raw
      try {
        parsed = JSON.parse(raw)
      } catch {
        // leave raw
      }
      requests.push({ headers: req.headers, body: parsed })
      Promise.resolve(customHandler((typeof parsed === 'object' && parsed !== null ? parsed : {}) as Record<string, unknown>, req, res))
        .catch((err: unknown) => {
          if (!res.headersSent) res.writeHead(500).end(String(err))
        })
    })
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const addr = server.address()
  if (addr === null || typeof addr === 'string') throw new Error('expected TCP address')
  cleanups.push(() => new Promise<void>((resolve, reject) => {
    server.closeAllConnections()
    server.close((err) => { if (err === undefined) resolve(); else reject(err) })
  }))
  return {
    url: `http://127.0.0.1:${addr.port}/admit`,
    requests,
    setHandler(fn) { customHandler = fn },
  }
}

class MockLlmAdapter extends LlmAdapter {
  public calls: GenerateOptions[] = []
  public behavior: (options: GenerateOptions, index: number) => AsyncIterable<StreamChunk> = async function* () {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'done' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'done' } }
    yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      inputModalities: ['text'],
      tools: true,
    })
  }

  stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.calls.push(options)
    return this.behavior(options, this.calls.length)
  }
}

async function bootWorkerHarness(options: {
  guardConfig?: Record<string, unknown>
  mountTokenMeter?: boolean
  mountBindings?: boolean
  mountHeaderProvider?: (sessionId: string | undefined, serverId: string) => Promise<Record<string, string> | undefined>
  downstreamPreExecute?: (exec: { name: string }, next: () => Promise<{ kind: string; reason?: string }>) => Promise<{ kind: string; reason?: string }>
  extraPlugin?: { name: string; apply: (ctx: Context) => void }
  mcpUrl?: string
} = {}) {
  const root = await mkdtemp(join(tmpdir(), 'enpoi-job-guard-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const auditDir = join(root, 'audit')
  const configPath = join(root, 'cordis.yml')
  const guardCfg = {
    auditDir,
    defaultCapability: 'knowledge:read',
    ...options.guardConfig,
  }
  await writeFile(configPath, [
    '- id: job-guard',
    '  name: cordis:enpoi-job-guard',
    `  config: ${JSON.stringify(guardCfg)}`,
    ...(options.mcpUrl === undefined ? [] : ['- id: mcp-hub', '  name: cordis:mcp-client',
      `  config: ${JSON.stringify({ transport: 'streamable-http', serverName: 'hub', url: options.mcpUrl,
        allowedTools: ['knowledge_search'], includeInstructions: false, failOnStartupError: true })}`]),
    '',
  ].join('\n'))

  const bindings = new Map<string, FakeBinding>()
  const adapter = new MockLlmAdapter()
  const logs: string[] = []

  const profile: ProfileContext = {
    name: 'worker-test',
    dir: root,
    patchPath: join(root, 'cordis.patch.yml'),
    installAnchor: root,
    cwd: root,
    home: join(root, '.dsh'),
    startedBundles: [],
    overlays: [],
    telemetryDisabledEnv: undefined,
  }

  const ctx = await boot('worker-test', configPath, [], async (host) => {
    host.logger.warn = ((m: unknown) => { logs.push(String(m)) }) as typeof host.logger.warn
    host.logger.error = ((m: unknown) => { logs.push(String(m)) }) as typeof host.logger.error
    host.provide('profileContext', profile)
    await host.plugin(SystemPrompt)
    await host.plugin(ToolRuntime)
    await host.plugin(SessionStore)
    await host.plugin(SessionProjectionRegistry)
    if (options.mountTokenMeter !== false) {
      await host.plugin(TokenMeter)
    }
    await host.plugin(LlmRuntime)
    host.llm.registerAdapter(['mock'], adapter)
    await host.plugin(AgentRegistry)
    await host.plugin(AgentLoop)
    if (options.mountBindings !== false) {
      host.provide('peerJobBindings' as never, {
        get: (sessionId: SessionId) => bindings.get(sessionId),
      } as never)
    }
    if (options.mountHeaderProvider !== undefined) {
      host.provide('mcpHeaderProvider' as never, {
        headersFor: options.mountHeaderProvider,
      } as never)
    }
    if (options.downstreamPreExecute !== undefined) {
      host.on('tools/pre-execute' as never, options.downstreamPreExecute as never)
    }
    if (options.extraPlugin !== undefined) {
      await host.plugin(options.extraPlugin)
    }
    host.loader.builtins['enpoi-job-guard'] = JobGuard
    host.loader.builtins['mcp-client'] = McpClient
  })
  cleanups.push(() => ctx.fiber.dispose())

  return { ctx, root, auditDir, bindings, adapter, logs }
}

function makeBinding(sessionId: SessionId, overrides: Partial<FakeBinding> = {}): FakeBinding {
  const now = Date.now()
  return {
    sessionId,
    jobId: 'job-1',
    fence: 'fence-1',
    expiresAt: now + 60_000,
    capabilities: ['knowledge:read'],
    limits: {
      maxSteps: 5,
      maxToolCalls: 10,
      maxWallMs: 60_000,
      maxTotalTokens: 10_000,
    },
    mcpEndpointId: 'hub',
    allowedToolNames: ['mcp__hub__knowledge_search', 'mcp__hub__knowledge_facts'],
    alias: 'worker',
    instanceId: 'inst-1',
    createdAt: now,
    ...overrides,
  }
}

describe('enpoi-job-guard (B1-B6)', () => {
  it('delivers a guarded MCP result to the model and session log without the job bearer', async () => {
    const canary = 'CANARY_LOOP_MCP_bf2a913a'
    const mcp = await startFakeHubServer()
    const admission = await startFakeHubServer()
    const called: string[] = []
    mcp.setHandler((body, req, res) => {
      if (req.method === 'GET') { res.writeHead(405).end(); return }
      const { id, method } = body
      const result = method === 'initialize' ? {
        protocolVersion: '2025-03-26',
        capabilities: { tools: {} },
        serverInfo: { name: 'loopback', version: '1' },
        instructions: `not part of the prompt: ${canary}`,
      } : method === 'tools/list' ? {
        tools: ['knowledge_search', 'unlisted'].map(name => ({ name, inputSchema: { type: 'object' } })),
      } : method === 'tools/call' ? (() => {
        called.push(req.headers.authorization ?? '')
        return { content: [{ type: 'text', text: `evidence ${req.headers.authorization ?? ''}` }] }
      })() : undefined
      if (id === undefined) { res.writeHead(202).end(); return }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(result === undefined ? {
        jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' },
      } : { jsonrpc: '2.0', id, result }))
    })
    const sid = SessionId('mcp-worker')
    const { ctx, bindings, adapter, auditDir, logs } = await bootWorkerHarness({
      mcpUrl: mcp.url,
      guardConfig: { allowedTools: ['mcp__hub__knowledge_search'], admissionUrl: admission.url },
      mountHeaderProvider: (sessionId, serverId) => {
        if (sessionId === undefined) return Promise.resolve(undefined)
        if (sessionId !== sid || !['hub', 'job-guard-admission'].includes(serverId)) return Promise.reject(new Error('wrong test scope'))
        return Promise.resolve({ Authorization: `Bearer ${canary}` })
      },
    })
    expect(ctx.tools.schemas().map(tool => tool.name)).toEqual(['mcp__hub__knowledge_search'])
    bindings.set(sid, makeBinding(sid, { fence: 182, credentialRef: 'job-canary-ref' }))
    adapter.behavior = async function* (_options, index) {
      const block = index === 1
        ? { type: 'tool-call' as const, id: ToolCallId('loop-tool-call'), name: 'mcp__hub__knowledge_search', arguments: '{}' }
        : { type: 'text' as const, text: 'done' }
      yield { type: 'block-start', index: 0, blockType: block.type }
      yield { type: 'block-end', index: 0, block }
      yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } }
      yield { type: 'finish', reason: { kind: index === 1 ? 'tool-calls' : 'stop' } }
    }
    const handle = await ctx.agents.create({ sessionId: sid, agentOptions: { provider: 'mock', model: 'test-model' } })
    cleanups.push(() => handle.dispose())
    handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'read' }], source: { kind: 'user' } }))
    await handle.agent.whenIdle()
    expect(called).toEqual([`Bearer ${canary}`])
    expect(admission.requests[0]?.body).toMatchObject({ fence: 182, toolName: 'mcp__hub__knowledge_search' })
    expect(adapter.calls).toHaveLength(2)
    const modelRequests = JSON.stringify(adapter.calls)
    const sessionEvents = JSON.stringify(handle.agent.session.snapshotEvents())
    const audit = readFileSync(join(auditDir, `${sid}.jsonl`), 'utf8')
    // The redactor replaces the whole credential header value ("Bearer <token>"), not only the token.
    expect(modelRequests).toContain('evidence [REDACTED]')
    expect(sessionEvents).toContain('evidence [REDACTED]')
    expect(audit).toContain('HUB_ADMITTED')
    for (const surface of [modelRequests, sessionEvents, audit, logs.join('\n')]) expect(surface).not.toContain(canary)
  })

  it('B1: fails loud on misconfiguration at load', async () => {
    expect(() => JobGuard.resolveJobGuardConfig({ admissionUrl: 'ftp://bad-scheme.example/admit' })).toThrow()
    expect(() => JobGuard.resolveJobGuardConfig({ admissionTimeoutMs: 0 })).toThrow()
    expect(() => JobGuard.resolveJobGuardConfig({ maxSteps: 0 })).toThrow()
    expect(() => JobGuard.resolveJobGuardConfig({ maxToolCalls: -1 })).toThrow()
    expect(() => JobGuard.resolveJobGuardConfig({ maxTotalTokens: 0 })).toThrow()
    expect(() => JobGuard.resolveJobGuardConfig({ auditMaxBytes: 10 })).toThrow()
    expect(() => JobGuard.Config({ admissionUrl: '' })).toThrow()

    const badBoot = await bootWorkerHarness({
      guardConfig: { admissionUrl: 'ftp://bad-scheme.example/admit' },
    })
    expect(badBoot.ctx.get('peerProfileIdentity' as never)).toBeUndefined()
  })

  it('B1+B6: denies unbound sessions, forbidden tools, nested PTC-style dispatches, and converts ask to deny', async () => {
    const hub = await startFakeHubServer()
    const canary = 'CANARY_HUB_BEARER_SECRET_1122'
    const ran: string[] = []

    const { ctx, auditDir, bindings, logs } = await bootWorkerHarness({
      guardConfig: {
        allowedTools: ['mcp__hub__knowledge_search', 'mcp__hub__ask_tool'],
        toolCapabilities: {
          mcp__hub__knowledge_search: 'knowledge:read',
          mcp__hub__ask_tool: 'knowledge:read',
        },
        admissionUrl: hub.url,
        admissionTimeoutMs: 2_000,
      },
      mountHeaderProvider: async (_sessionId, serverId) => serverId === 'job-guard-admission'
        ? { Authorization: `Bearer ${canary}` }
        : undefined,
      downstreamPreExecute: async (exec, next) => {
        if (exec.name === 'mcp__hub__ask_tool') return { kind: 'ask', reason: 'needs user' }
        return next()
      },
    })

    for (const toolName of ['mcp__hub__knowledge_search', 'mcp__hub__knowledge_facts', 'mcp__hub__ask_tool', 'bash']) {
      ctx.tools.register({
        name: toolName,
        description: toolName,
        parameters: { type: 'object', properties: { q: { type: 'string' } } },
        output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: String(v) }] },
        execute: async () => {
          ran.push(toolName)
          return `ran:${toolName}`
        },
      })
    }

    // 1) Unbound session -> DENY
    const unbound = await ctx.tools.execute({
      name: 'mcp__hub__knowledge_search',
      arguments: { q: 'secret-arg' },
      callId: ToolCallId('unbound-1'),
      signal: new AbortController().signal,
    })
    expect(unbound.isError).toBe(true)
    expect(ran).toEqual([])

    const sid = SessionId('worker-sess-1')
    const session = ctx.sessions.create(sid)
    bindings.set(sid, makeBinding(sid, {
      credentialRef: 'job-credential-ref',
      allowedToolNames: ['mcp__hub__knowledge_search', 'mcp__hub__knowledge_facts', 'mcp__hub__ask_tool'],
    }))

    // 2) Forbidden tool (even though registered!) -> DENY
    const forbidden = await ctx.tools.execute({
      name: 'bash',
      arguments: { cmd: 'id' },
      callId: ToolCallId('forbidden-bash'),
      signal: new AbortController().signal,
      agent: { id: sid, session, options: { provider: 'mock', model: 'm' } } as never,
    })
    expect(forbidden.isError).toBe(true)
    expect(ran).toEqual([])

    // 3) Nested PTC-style dispatch (with parent token) of unlisted tool -> DENY
    const ptcToken = Symbol('ptc-parent') as never
    const nestedForbidden = await ctx.tools.execute({
      name: 'mcp__hub__knowledge_facts', // in binding, NOT in config.allowedTools -> intersection denies!
      arguments: {},
      callId: ToolCallId('nested-1'),
      parent: ptcToken,
      signal: new AbortController().signal,
      agent: { id: sid, session, options: { provider: 'mock', model: 'm' } } as never,
    })
    expect(nestedForbidden.isError).toBe(true)
    expect(ran).toEqual([])

    // 4) Allowed tool in intersection with hub OK -> ADMITTED
    const ok = await ctx.tools.execute({
      name: 'mcp__hub__knowledge_search',
      arguments: { q: 'SENSITIVE_QUERY_DATA' },
      callId: ToolCallId('ok-1'),
      signal: new AbortController().signal,
      agent: { id: sid, session, options: { provider: 'mock', model: 'm' } } as never,
    })
    expect(ok.isError).toBe(false)
    expect(ran).toEqual(['mcp__hub__knowledge_search'])
    expect(hub.requests).toHaveLength(1)
    expect(hub.requests[0]!.headers.authorization).toBe(`Bearer ${canary}`)
    expect(hub.requests[0]!.body).toMatchObject({
      jobId: 'job-1',
      fence: 'fence-1',
      capability: 'knowledge:read',
      toolName: 'mcp__hub__knowledge_search',
      callId: 'ok-1',
    })
    expect((hub.requests[0]!.body as Record<string, unknown>).arguments).toBeUndefined()

    // 5) Downstream 'ask' -> converted to DENY
    const askConverted = await ctx.tools.execute({
      name: 'mcp__hub__ask_tool',
      arguments: {},
      callId: ToolCallId('ask-1'),
      signal: new AbortController().signal,
      agent: { id: sid, session, options: { provider: 'mock', model: 'm' } } as never,
    })
    expect(askConverted.isError).toBe(true)
    expect(ran).toEqual(['mcp__hub__knowledge_search'])

    // Verify 0600 audit file exists and contains sanitized records without raw args or canary
    const auditFiles = lstatSync(auditDir)
    expect(auditFiles.mode & 0o777).toBe(0o700)
    const auditFilePath = join(auditDir, `${sid}.jsonl`)
    expect(statSync(auditFilePath).mode & 0o777).toBe(0o600)
    const auditContent = readFileSync(auditFilePath, 'utf8')
    expect(auditContent).not.toContain(canary)
    expect(auditContent).not.toContain('SENSITIVE_QUERY_DATA')
    const records = auditContent.trim().split('\n').map(l => JSON.parse(l) as Record<string, unknown>)
    expect(records.length).toBeGreaterThanOrEqual(4)
    expect(records.some(r => r.decision === 'allow' && r.toolName === 'mcp__hub__knowledge_search')).toBe(true)
    expect(records.some(r => r.decision === 'deny' && r.toolName === 'bash')).toBe(true)
    expect(logs.join('\n')).not.toContain(canary)
    expect(session.snapshotEvents().map(e => JSON.stringify(e)).join('\n')).not.toContain(canary)
    expect(session.snapshotEvents().map(e => JSON.stringify(e)).join('\n')).not.toContain('SENSITIVE_QUERY_DATA')
  })

  it('B1: denies on revoked, expired, fence mismatch, and hub 500/timeout/malformed/denied without running tool body', async () => {
    const hub = await startFakeHubServer()
    const canary = 'CANARY_ADMISSION_ERR_3344'
    let bodyCount = 0
    const { ctx, bindings, auditDir } = await bootWorkerHarness({
      guardConfig: {
        allowedTools: ['mcp__hub__knowledge_search'],
        admissionUrl: hub.url,
        admissionTimeoutMs: 80,
      },
      mountHeaderProvider: async () => ({ Authorization: `Bearer ${canary}` }),
    })
    ctx.tools.register({
      name: 'mcp__hub__knowledge_search',
      description: 'search',
      parameters: { type: 'object' },
      output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: String(v) }] },
      execute: async () => { bodyCount += 1; return 'ok' },
    })

    const sid = SessionId('sess-deny-cases')
    const session = ctx.sessions.create(sid)
    const agent = { id: sid, session, options: { provider: 'mock', model: 'm' } }

    // Revoked
    bindings.set(sid, makeBinding(sid, { revoked: true }))
    let res = await ctx.tools.execute({ name: 'mcp__hub__knowledge_search', arguments: {}, callId: ToolCallId('c1'), signal: new AbortController().signal, agent: agent as never })
    expect(res.isError).toBe(true)

    // Expired
    bindings.set(sid, makeBinding(sid, { expiresAt: Date.now() - 10 }))
    res = await ctx.tools.execute({ name: 'mcp__hub__knowledge_search', arguments: {}, callId: ToolCallId('c2'), signal: new AbortController().signal, agent: agent as never })
    expect(res.isError).toBe(true)

    // Missing after valid (fence pin + revocation via undefined)
    bindings.set(sid, makeBinding(sid, { fence: 'fence-A' }))
    res = await ctx.tools.execute({ name: 'mcp__hub__knowledge_search', arguments: {}, callId: ToolCallId('c3'), signal: new AbortController().signal, agent: agent as never })
    expect(res.isError).toBe(false)
    expect(bodyCount).toBe(1)

    // Fence mismatch
    bindings.set(sid, makeBinding(sid, { fence: 'fence-B' }))
    res = await ctx.tools.execute({ name: 'mcp__hub__knowledge_search', arguments: {}, callId: ToolCallId('c4'), signal: new AbortController().signal, agent: agent as never })
    expect(res.isError).toBe(true)

    // Restore valid fence, test hub 500 leaking canary -> denied with generic reason (no canary)
    bindings.set(sid, makeBinding(sid, { fence: 'fence-A' }))
    hub.setHandler((_b, _req, r) => { r.writeHead(500); r.end(`server error ${canary}`) })
    res = await ctx.tools.execute({ name: 'mcp__hub__knowledge_search', arguments: {}, callId: ToolCallId('c5'), signal: new AbortController().signal, agent: agent as never })
    expect(res.isError).toBe(true)
    expect(JSON.stringify(res)).not.toContain(canary)

    // Hub malformed JSON
    hub.setHandler((_b, _req, r) => { r.writeHead(200); r.end('not-json') })
    res = await ctx.tools.execute({ name: 'mcp__hub__knowledge_search', arguments: {}, callId: ToolCallId('c6'), signal: new AbortController().signal, agent: agent as never })
    expect(res.isError).toBe(true)

    // Hub explicit deny
    hub.setHandler((_b, _req, r) => { r.writeHead(200); r.end(JSON.stringify({ allowed: false, reasonCode: canary })) })
    res = await ctx.tools.execute({ name: 'mcp__hub__knowledge_search', arguments: {}, callId: ToolCallId('c7'), signal: new AbortController().signal, agent: agent as never })
    expect(res.isError).toBe(true)

    // Hub timeout
    hub.setHandler(async () => { await new Promise(r => setTimeout(r, 400)) })
    res = await ctx.tools.execute({ name: 'mcp__hub__knowledge_search', arguments: {}, callId: ToolCallId('c8'), signal: new AbortController().signal, agent: agent as never })
    expect(res.isError).toBe(true)
    expect(bodyCount).toBe(1)
    expect(readFileSync(join(auditDir, `${sid}.jsonl`), 'utf8')).not.toContain(canary)
  })

  it('B1: atomically reserves tool-call count under concurrent batch', async () => {
    const hub = await startFakeHubServer()
    hub.setHandler(async (_b, _req, res) => {
      await new Promise(r => setTimeout(r, 30))
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ allowed: true }))
    })
    let bodyRuns = 0
    const { ctx, bindings } = await bootWorkerHarness({
      guardConfig: {
        allowedTools: ['mcp__hub__knowledge_search'],
        admissionUrl: hub.url,
        admissionTimeoutMs: 2_000,
      },
    })
    ctx.tools.register({
      name: 'mcp__hub__knowledge_search',
      description: 'search',
      parameters: { type: 'object' },
      output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: String(v) }] },
      execute: async () => { bodyRuns += 1; return 'ok' },
    })

    const sid = SessionId('sess-concurrent')
    const session = ctx.sessions.create(sid)
    bindings.set(sid, makeBinding(sid, { limits: { maxToolCalls: 2 } }))

    const results = await Promise.all(
      [1, 2, 3, 4, 5].map(i => ctx.tools.execute({
        name: 'mcp__hub__knowledge_search',
        arguments: { i },
        callId: ToolCallId(`batch-${i}`),
        signal: new AbortController().signal,
        agent: { id: sid, session, options: { provider: 'mock', model: 'm' } } as never,
      })),
    )

    expect(results.filter(r => !r.isError)).toHaveLength(2)
    expect(results.filter(r => r.isError)).toHaveLength(3)
    expect(bodyRuns).toBe(2)
  })

  it('B2: agent/pre-step enforces maxSteps and wall deadline before model request', async () => {
    const { ctx, bindings, adapter, auditDir } = await bootWorkerHarness({
      guardConfig: {
        allowedTools: ['mcp__hub__knowledge_search'],
        requirePinnedRoute: true,
      },
    })
    ctx.tools.register({
      name: 'mcp__hub__knowledge_search',
      description: 'search',
      parameters: { type: 'object' },
      output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: String(v) }] },
      execute: async () => 'result',
    })
    adapter.behavior = async function* (_opts, index) {
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield {
        type: 'block-end',
        index: 0,
        block: { type: 'tool-call', id: ToolCallId(`tc-${index}`), name: 'mcp__hub__knowledge_search', arguments: '{}' },
      }
      yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    }

    const sid = SessionId('sess-steps')
    bindings.set(sid, makeBinding(sid, { limits: { maxSteps: 2, maxToolCalls: 10, maxTotalTokens: 50_000 } }))
    const handle = await ctx.agents.create({
      sessionId: sid,
      agentOptions: { provider: 'mock', model: 'test-model' },
    })
    cleanups.push(() => handle.dispose())

    handle.agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'go' }],
      source: { kind: 'user' },
    }))
    await handle.agent.whenIdle()

    // Exactly 2 model steps ran; step 3 was blocked before dispatch
    expect(adapter.calls).toHaveLength(2)
    const events = handle.agent.session.snapshotEvents()
    expect(events.find(e => e.type === 'turn/end')).toMatchObject({ data: { reason: { kind: 'aborted' } } })
    expect(JSON.stringify(events)).toContain('peer/budget')
    const auditText = readFileSync(join(auditDir, `${sid}.jsonl`), 'utf8')
    expect(auditText).toContain('MAX_STEPS_EXCEEDED')
  })

  it('B3: llm/stream enforces tokenMeter presence, token budget reservation with JOB_BUDGET_REFUSED, and requirePinnedRoute', async () => {
    // Missing tokenMeter fails closed
    const noMeter = await bootWorkerHarness({ mountTokenMeter: false })
    const sid0 = SessionId('sess-no-meter')
    noMeter.bindings.set(sid0, makeBinding(sid0))
    noMeter.ctx.sessions.create(sid0)
    expect(() => noMeter.ctx.llm.stream({
      provider: 'mock',
      model: 'm',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
      maxTokens: 100,
      sessionId: sid0,
    })).toThrowError(expect.objectContaining({ code: 'JOB_BUDGET_REFUSED' }))

    // With tokenMeter: enforce budget and pinned route
    const { ctx, bindings } = await bootWorkerHarness({
      guardConfig: { requirePinnedRoute: true },
    })
    const sid = SessionId('sess-budget')
    bindings.set(sid, makeBinding(sid, { limits: { maxTotalTokens: 200 } }))
    ctx.sessions.create(sid)

    // Chain disallowed under requirePinnedRoute
    expect(() => ctx.llm.stream({
      provider: 'mock',
      model: 'm',
      chain: 'free',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
      maxTokens: 50,
      sessionId: sid,
    })).toThrowError(expect.objectContaining({ code: 'JOB_BUDGET_REFUSED' }))

    // Over budget (estimated input + maxTokens > 200) -> refused with LlmError JOB_BUDGET_REFUSED
    try {
      ctx.llm.stream({
        provider: 'mock',
        model: 'm',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
        maxTokens: 250,
        sessionId: sid,
      })
      expect.unreachable('expected JOB_BUDGET_REFUSED')
    } catch (error) {
      expect(error).toBeInstanceOf(LlmError)
      expect((error as LlmError).code).toBe('JOB_BUDGET_REFUSED')
    }
  })

  it('B4: fails closed when 0600 audit write fails or exceeds auditMaxBytes', async () => {
    const { ctx, bindings, auditDir } = await bootWorkerHarness({
      guardConfig: {
        allowedTools: ['mcp__hub__knowledge_search'],
        auditMaxBytes: 300,
      },
    })
    let ran = 0
    ctx.tools.register({
      name: 'mcp__hub__knowledge_search',
      description: 'search',
      parameters: { type: 'object' },
      output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: String(v) }] },
      execute: async () => { ran += 1; return 'ok' },
    })

    const sid = SessionId('sess-audit-cap')
    const session = ctx.sessions.create(sid)
    bindings.set(sid, makeBinding(sid))

    // First call succeeds (under 220 bytes), second call would exceed 220 bytes -> DENY
    const first = await ctx.tools.execute({
      name: 'mcp__hub__knowledge_search',
      arguments: {},
      callId: ToolCallId('a1'),
      signal: new AbortController().signal,
      agent: { id: sid, session, options: { provider: 'mock', model: 'm' } } as never,
    })
    expect(first.isError).toBe(false)
    const second = await ctx.tools.execute({
      name: 'mcp__hub__knowledge_search',
      arguments: {},
      callId: ToolCallId('a2'),
      signal: new AbortController().signal,
      agent: { id: sid, session, options: { provider: 'mock', model: 'm' } } as never,
    })
    expect(second.isError).toBe(true)
    expect(ran).toBe(1)

    // Symlink at audit target refuses write
    const sidSym = SessionId('sess-symlink')
    const sessionSym = ctx.sessions.create(sidSym)
    bindings.set(sidSym, makeBinding(sidSym))
    mkdirSync(auditDir, { recursive: true })
    const targetFile = join(auditDir, 'real-target.txt')
    writeFileSync(targetFile, '')
    symlinkSync(targetFile, join(auditDir, `${sidSym}.jsonl`))
    const symRes = await ctx.tools.execute({
      name: 'mcp__hub__knowledge_search',
      arguments: {},
      callId: ToolCallId('a-sym'),
      signal: new AbortController().signal,
      agent: { id: sidSym, session: sessionSym, options: { provider: 'mock', model: 'm' } } as never,
    })
    expect(symRes.isError).toBe(true)
    expect(ran).toBe(1)
  })

  it('B5: peerProfileIdentity reflects real effective tool set and schemas without leaking secrets', async () => {
    const { ctx, bindings } = await bootWorkerHarness({
      guardConfig: {
        allowedTools: ['mcp__hub__knowledge_search'],
        presetId: 'worker-readonly',
        admissionUrl: 'https://hub.example/admit',
      },
    })
    const sid = SessionId('sess-identity')
    bindings.set(sid, makeBinding(sid))
    const handle = await ctx.agents.create({
      sessionId: sid,
      meta: { agentPreset: 'worker-readonly' },
      agentOptions: { provider: 'mock', model: 'm' },
    })
    cleanups.push(() => handle.dispose())

    const identity = ctx.get('peerProfileIdentity') as PeerProfileIdentityService | undefined
    if (identity === undefined) throw new Error('profile identity missing')
    expect(identity).toBeDefined()
    const d1 = identity.describe(sid)
    expect(d1).toBeDefined()
    expect(d1?.presetId).toBe('worker-readonly')
    expect(d1?.toolNames).toEqual([])
    expect(JSON.stringify(d1)).not.toContain('SECRET_SHOULD_NOT_BE_IN_DIGEST')

    const disposeTool = ctx.tools.register({
      name: 'mcp__hub__knowledge_search',
      description: 'search',
      parameters: { type: 'object', properties: { q: { type: 'string' } } },
      output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: String(v) }] },
      execute: async () => 'ok',
    })
    const d2 = identity.describe(sid)
    expect(d2?.toolNames).toEqual(['mcp__hub__knowledge_search'])
    expect(d2?.hash).not.toBe(d1?.hash)

    disposeTool()
    expect(identity.describe(sid)?.hash).toBe(d1?.hash)
    const disposeChanged = ctx.tools.register({
      name: 'mcp__hub__knowledge_search',
      description: 'search',
      parameters: { type: 'object', properties: { q: { type: 'integer' } } },
      output: { schema: { type: 'string' }, render: () => [{ type: 'text', text: 'ok' }] },
      execute: async () => 'ok',
    })
    expect(identity.describe(sid)?.toolNames).toEqual(d2?.toolNames)
    expect(identity.describe(sid)?.hash).not.toBe(d2?.hash)
    disposeChanged()
    expect(identity.describe(SessionId('nonexistent'))).toBeUndefined()
  })
})
