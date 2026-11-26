import { createServer } from 'node:http'
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { LlmAdapter, LlmRuntime, ToolCallId, createUserMessage, type GenerateOptions, type LlmResolvedModelInfo, type StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import {
  apply as applyJobGuard,
  canonicalJson,
  encodeAuditSegment,
  resolveJobGuardConfig,
  type PeerProfileIdentityService,
} from '../src/index.ts'
import type { RuntimePeerJobBinding as PeerJobBinding } from '../src/types.ts'

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  while (cleanups.length > 0) {
    await cleanups.pop()!()
  }
})

function binding(sessionId: SessionId, overrides: Partial<PeerJobBinding> = {}): PeerJobBinding {
  const now = Date.now()
  return {
    sessionId,
    jobId: 'job-b',
    fence: 'fence-b',
    expiresAt: now + 60_000,
    capabilities: ['tool_a'],
    limits: {},
    alias: 'worker',
    instanceId: 'inst-1',
    createdAt: now,
    allowedToolNames: ['tool_a'],
    ...overrides,
  }
}

class SimpleAdapter extends LlmAdapter {
  calls: GenerateOptions[] = []
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model, inputModalities: ['text'], tools: true })
  }
  stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.calls.push(options)
    return (async function* () {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'ok' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'ok' } }
      yield { type: 'usage', usage: { inputTokens: 20, outputTokens: 10 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })()
  }
}

async function createCtx(guardConfig: Record<string, unknown> = {}, opts: {
  mountBindings?: boolean
  mountTokenMeter?: boolean
  mountProjections?: boolean
  bindingsMap?: Map<string, PeerJobBinding>
  preRegisterTools?: string[]
  beforeApply?: (ctx: Context) => void
} = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'job-guard-cov-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  const warns: string[] = []
  ctx.logger.warn = ((m: unknown) => { warns.push(String(m)) }) as typeof ctx.logger.warn
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(SessionStore)
  if (opts.mountProjections !== false) await ctx.plugin(SessionProjectionRegistry)
  if (opts.mountTokenMeter !== false && opts.mountProjections !== false) await ctx.plugin(TokenMeter)
  const adapter = new SimpleAdapter()
  await ctx.plugin(LlmRuntime)
  ctx.llm.registerAdapter(['mock'], adapter)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop)

  for (const name of opts.preRegisterTools ?? []) {
    ctx.tools.register({
      name,
      description: name,
      parameters: { type: 'object' },
      output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: String(v) }] },
      execute: async () => `ran:${name}`,
    })
  }

  const bindings = opts.bindingsMap ?? new Map<string, PeerJobBinding>()
  if (opts.mountBindings !== false) {
    ctx.provide('peerJobBindings' as never, {
      get: (id: SessionId) => bindings.get(id),
    } as never)
  }
  opts.beforeApply?.(ctx)

  const auditDir = (guardConfig.auditDir as string | undefined) ?? join(dir, 'audit')
  const fiber = await ctx.plugin({
    name: 'enpoi-job-guard',
    inject: ['tools'],
    apply: applyJobGuard,
  }, { auditDir, ...guardConfig })

  return { ctx, dir, auditDir, bindings, adapter, warns, fiber }
}

describe('enpoi-job-guard thorough branch coverage', () => {
  it('validates every resolveJobGuardConfig branch and audit helpers', async () => {
    vi.stubEnv('DSH_HOME', join(tmpdir(), 'dsh-env-test'))
    const envDefaulted = resolveJobGuardConfig({})
    expect(envDefaulted.auditDir).toContain('enpoi-job-guard')

    expect(() => resolveJobGuardConfig({ requireBinding: 'yes' as never })).toThrow()
    expect(() => resolveJobGuardConfig({ requirePinnedRoute: 'no' as never })).toThrow()
    expect(() => resolveJobGuardConfig({ allowedTools: 'bad' as never })).toThrow()
    expect(() => resolveJobGuardConfig({ allowedTools: [''] })).toThrow()
    expect(() => resolveJobGuardConfig({ allowedTools: ['a', 'a'] })).toThrow()
    expect(() => resolveJobGuardConfig({ toolCapabilities: [] as never })).toThrow()
    expect(() => resolveJobGuardConfig({ toolCapabilities: { a: '' } })).toThrow()
    expect(() => resolveJobGuardConfig({ defaultCapability: '' })).toThrow()
    expect(() => resolveJobGuardConfig({ admissionUrl: '' })).toThrow()
    expect(() => resolveJobGuardConfig({ admissionUrl: 'not a url' })).toThrow()
    expect(() => resolveJobGuardConfig({ admissionUrl: 'https://example.test/admit?token=canary' })).toThrow(/must not contain/)
    expect(() => resolveJobGuardConfig({ admissionTimeoutMs: 2 ** 31 })).toThrow(/timer range/)
    expect(() => resolveJobGuardConfig({ admissionIncludeArgs: 1 as never })).toThrow()
    expect(() => resolveJobGuardConfig({ admissionServerId: '' })).toThrow()
    expect(() => resolveJobGuardConfig({ auditDir: '' })).toThrow()
    expect(() => resolveJobGuardConfig({ presetId: 123 as never })).toThrow()
    expect(() => resolveJobGuardConfig({ harnessVersion: '' })).toThrow()

    expect(canonicalJson(undefined)).toBe('null')
    expect(canonicalJson({ b: 1, a: undefined })).toBe('{"b":1}')
    expect(canonicalJson({ 2: ['v'], 11: { b: 2, a: 1 } })).toBe('{"11":{"a":1,"b":2},"2":["v"]}')
    expect(encodeAuditSegment('')).toBe('~empty')
    expect(encodeAuditSegment('.')).toBe('~002E')
    expect(encodeAuditSegment('..')).toBe('~002E~002E')
    expect(encodeAuditSegment('a/b~c')).toBe('a~002Fb~007Ec')
  })

  it('refuses changed authority, policy exceptions, missing credentials, and unrecorded permits', async () => {
    const { ctx, bindings, auditDir } = await createCtx({
      allowedTools: ['tool_a'],
      admissionUrl: 'http://127.0.0.1:1/admit',
      admissionTimeoutMs: 50,
    }, { preRegisterTools: ['tool_a'] })
    const id = SessionId('authority-races')
    const session = ctx.sessions.create(id)
    const good = binding(id, { fence: 12 })
    const execute = (name: string) => ctx.tools.execute({
      name: 'tool_a', arguments: {}, callId: ToolCallId(name), signal: new AbortController().signal,
      agent: { id, session } as never,
    })
    const disposePolicy = ctx.on('tools/pre-execute', async (input, next) => {
      if (input.callId === 'policy-threw') throw new Error('not a public diagnostic')
      if (input.callId === 'revoked') bindings.delete(id)
      if (input.callId === 'scope-changed') bindings.set(id, { ...good, allowedToolNames: [] })
      return next()
    })
    for (const call of ['policy-threw', 'revoked', 'scope-changed']) {
      bindings.set(id, good)
      expect((await execute(call)).isError).toBe(true)
    }
    disposePolicy()
    bindings.set(id, { ...good, credentialRef: 'test_ref' })
    expect((await execute('missing-credential')).isError).toBe(true)

    let headers: Record<string, string> | undefined
    let hang = false
    let brokerCancellation: AbortController | undefined
    ctx.provide('mcpHeaderProvider', { headersFor: () => {
      brokerCancellation?.abort()
      return hang ? new Promise(() => { /* deliberately unresponsive test broker */ }) : Promise.resolve(headers)
    } })
    expect((await execute('empty-authorization')).isError).toBe(true)
    headers = { Authorization: 'Bearer FAKE_JOB_CANARY' }
    hang = true
    expect((await execute('broker-timeout')).isError).toBe(true)
    hang = false
    brokerCancellation = new AbortController()
    expect((await ctx.tools.execute({ name: 'tool_a', arguments: {}, callId: ToolCallId('broker-cancel'),
      signal: brokerCancellation.signal, agent: { id, session } as never })).isError).toBe(true)
    brokerCancellation = undefined
    const reply = vi.fn<typeof fetch>()
    vi.stubGlobal('fetch', reply)
    for (const body of ['{"allowed":"true"}', 'x'.repeat(5000), null]) {
      reply.mockResolvedValueOnce(new Response(body))
      expect((await execute('invalid-reply')).isError).toBe(true)
    }
    const bypass = ctx.on('tools/pre-execute', async () => ({ kind: 'allow' as const }), { prepend: true })
    expect((await execute('without-permit')).error?.message).toContain('not recorded')
    bypass()
    expect(reply).toHaveBeenCalledTimes(3)
    const insecure = SessionId('insecure-audit-mode')
    const insecureSession = ctx.sessions.create(insecure)
    bindings.set(insecure, binding(insecure))
    writeFileSync(join(auditDir, `${insecure}.jsonl`), '', { mode: 0o644 })
    reply.mockResolvedValueOnce(Response.json({ allowed: true }))
    const refused = await ctx.tools.execute({ name: 'tool_a', arguments: {}, callId: ToolCallId('unsafe-mode'),
      signal: new AbortController().signal, agent: { id: insecure, session: insecureSession } as never })
    expect(refused.error?.message).toContain('durable audit write failed')
  })

  it('charges observed stream usage and fails closed on missing, overflowing, or invalid budget inputs', async () => {
    const { ctx, bindings } = await createCtx({ requireBinding: false, maxTotalTokens: 200 })
    const id = SessionId('usage-reservations')
    const session = ctx.sessions.create(id)
    bindings.set(id, binding(id))
    const options = { provider: 'mock', model: 'm', messages: [], sessionId: id }
    const check = (overrides: Partial<GenerateOptions> = {}) => ctx.llm.stream({ ...options, ...overrides })
    expect(() => check()).toThrow('a positive maxTokens is required')
    expect(() => check({ maxTokens: Number.MAX_SAFE_INTEGER, system: 'p' })).toThrow('exceeds job ceiling')
    bindings.set(id, binding(id, { limits: { maxTotalTokens: Number.NaN } }))
    expect(() => check({ maxTokens: 1 })).toThrow('exceeds job ceiling')
    bindings.set(id, binding(id))

    const projectionSnapshot = ctx.sessionProjections.snapshot.bind(ctx.sessionProjections)
    const project = vi.spyOn(ctx.sessionProjections, 'snapshot').mockImplementation((s, keys) => {
      const result = projectionSnapshot(s, keys)
      return { ...result, values: { ...result.values, tokenUsage: {
        uncachedInputTokens: 25, outputTokens: 4, cacheReadTokens: 1, cacheWriteTokens: 0,
      } } }
    })
    expect(() => check({ maxTokens: 171 })).toThrow('exceeds job ceiling')
    project.mockImplementation((s, keys) => ({ ...projectionSnapshot(s, keys), values: { tokenUsage: {
      uncachedInputTokens: Number.NaN, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
    } } }))
    expect(() => check({ maxTokens: 1 })).toThrow('invalid metered token usage')
    project.mockRestore()

    ctx.on('llm/stream', async function* () {
      yield { type: 'usage', usage: { inputTokens: Number.NaN, outputTokens: 0 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })
    for await (const _chunk of check({ maxTokens: 100 })) { /* account for one invalid usage sample */ }
    expect(() => check({ maxTokens: 80 })).toThrow('exceeds job ceiling')

    const pending = check({ maxTokens: 10 })
    ctx.sessions.dispose(session.id)
    bindings.delete(id)
    await expect(pending[Symbol.asyncIterator]().next()).rejects.toThrow('job binding disappeared')
  })

  it('rechecks authority immediately before the tool body and signals the job deadline to a running tool', async () => {
    const { ctx, bindings } = await createCtx({ allowedTools: ['tool_a'] })
    const id = SessionId('late-dispatch')
    const session = ctx.sessions.create(id)
    const valid = binding(id, { limits: { maxWallMs: 600 } })
    let bodyRuns = 0
    ctx.tools.register({
      name: 'tool_a', description: 'test', parameters: { type: 'object' },
      output: { schema: { type: 'string' }, render: () => [] },
      execute: async (_args, exec) => {
        bodyRuns += 1
        await new Promise<void>(resolve => { exec.signal.addEventListener('abort', () => resolve(), { once: true }) })
        return 'stopped'
      },
    })
    ctx.on('tools/execute', (exec, next) => {
      if (exec.callId === 'revoked-late') bindings.delete(id)
      if (exec.callId === 'scope-late') bindings.set(id, { ...valid, capabilities: [] })
      return next()
    }, { prepend: true })
    for (const label of ['revoked-late', 'scope-late']) {
      bindings.set(id, valid)
      const result = await ctx.tools.execute({ name: 'tool_a', arguments: {}, callId: ToolCallId(label),
        signal: new AbortController().signal, agent: { id, session } as never })
      expect(result.error?.info?.code).toBe('JOB_TOOL_REFUSED')
    }
    expect(bodyRuns).toBe(0)
    bindings.set(id, { ...valid, createdAt: Date.now() })
    const result = await ctx.tools.execute({ name: 'tool_a', arguments: {}, callId: ToolCallId('wall-limited'),
      signal: new AbortController().signal, agent: { id, session } as never })
    expect(result.isError).toBe(true)
    expect(bodyRuns).toBe(1)
  })

  it('covers startup extra-tools warning, session disposal cleanup, and fiber disposal', async () => {
    const { ctx, warns, fiber, bindings } = await createCtx(
      { allowedTools: ['tool_a'] },
      { preRegisterTools: ['tool_a', 'extra_tool'] },
    )
    expect(warns.some(w => w.includes('extra_tool'))).toBe(true)

    const sid = SessionId('sess-dispose')
    const session = ctx.sessions.create(sid)
    bindings.set(sid, binding(sid))
    const ok = await ctx.tools.execute({
      name: 'tool_a',
      arguments: {},
      callId: ToolCallId('d1'),
      signal: new AbortController().signal,
      agent: { id: sid, session } as never,
    })
    expect(ok.isError).toBe(false)

    // Disposing session cleans session state
    ctx.sessions.dispose(sid)

    // Disposing fiber removes peerProfileIdentity and listeners
    await fiber.dispose()
    expect(ctx.get('peerProfileIdentity' as never)).toBeUndefined()
  })

  it('covers missing peerJobBindings, revokedAt/status, invalid binding, expectedFence, instanceId, wallMs, and monotonic guard bypass attempt', async () => {
    const noBindings = await createCtx({ allowedTools: ['tool_a'] }, { preRegisterTools: ['tool_a'], mountBindings: false })
    const s0 = noBindings.ctx.sessions.create(SessionId('s0'))
    const r0 = await noBindings.ctx.tools.execute({
      name: 'tool_a', arguments: {}, callId: ToolCallId('c0'), signal: new AbortController().signal,
      agent: { id: s0.id, session: s0 } as never,
    })
    expect(r0.isError).toBe(true)

    // Monotonic tools.guard catches a rogue prepended tools/pre-execute listener that short-circuits allow!
    const rogue = await createCtx(
      { allowedTools: ['tool_a'], expectedFence: 'fence-ok', instanceId: 'inst-ok' },
      {
        preRegisterTools: ['tool_a', 'tool_bad'],
        beforeApply: (c) => {
          c.on('tools/pre-execute', async () => ({ kind: 'allow' as const }), { prepend: true })
        },
      },
    )
    // Re-register a rogue pre-execute AFTER apply with prepend so it wraps job-guard's pre-execute!
    rogue.ctx.on('tools/pre-execute', async () => ({ kind: 'allow' as const }), { prepend: true })
    const sid = SessionId('sess-guard')
    const session = rogue.ctx.sessions.create(sid)
    rogue.bindings.set(sid, binding(sid, { fence: 'fence-ok', instanceId: 'inst-ok' }))
    const guardDenied = await rogue.ctx.tools.execute({
      name: 'tool_bad', arguments: {}, callId: ToolCallId('g1'), signal: new AbortController().signal,
      agent: { id: sid, session } as never,
    })
    expect(guardDenied.isError).toBe(true)
    expect(guardDenied.error?.message).toContain('outside the job allow-list')

    const guardUnboundDenied = await rogue.ctx.tools.execute({
      name: 'tool_a', arguments: {}, callId: ToolCallId('g2'), signal: new AbortController().signal,
    })
    expect(guardUnboundDenied.isError).toBe(true)

    // Check revokedAt, status: 'revoked', invalid binding, expectedFence, instanceId, wallMs
    const { ctx, bindings } = await createCtx(
      { expectedFence: 'f1', instanceId: 'i1', maxWallMs: 500 },
      { preRegisterTools: ['tool_a'] },
    )
    const s1 = ctx.sessions.create(SessionId('s-checks'))
    const cases: Array<Partial<PeerJobBinding>> = [
      { fence: 'f1', instanceId: 'i1', revokedAt: Date.now() },
      { jobId: '', fence: 'f1', instanceId: 'i1' },
      { jobId: 'job-b', fence: '', instanceId: 'i1' },
      { fence: 'wrong', instanceId: 'i1' },
      { fence: 'f1', instanceId: 'wrong-inst' },
      { fence: 'f1', instanceId: 'i1', createdAt: Date.now() - 1000 },
    ]
    for (const [idx, patch] of cases.entries()) {
      bindings.set(s1.id, binding(s1.id, patch))
      const res = await ctx.tools.execute({
        name: 'tool_a', arguments: {}, callId: ToolCallId(`case-${idx}`), signal: new AbortController().signal,
        agent: { id: s1.id, session: s1 } as never,
      })
      expect(res.isError).toBe(true)
    }
  })

  it('covers requireBinding=false, allowlist branches, capability branches, and hub admission edge cases', async () => {
    // requireBinding: false allows unbound session through pre-execute, guard, pre-step, and llm.stream
    const unboundAllowed = await createCtx(
      { requireBinding: false, allowedTools: ['tool_a'] },
      { preRegisterTools: ['tool_a'] },
    )
    const uRes = await unboundAllowed.ctx.tools.execute({
      name: 'tool_a', arguments: {}, callId: ToolCallId('u1'), signal: new AbortController().signal,
    })
    expect(uRes.isError).toBe(false)
    const uChunks: StreamChunk[] = []
    for await (const c of unboundAllowed.ctx.llm.stream({
      provider: 'mock', model: 'm', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    })) {
      uChunks.push(c)
    }
    expect(uChunks.some(c => c.type === 'finish')).toBe(true)

    const handleUnbound = await unboundAllowed.ctx.agents.create({
      sessionId: SessionId('unbound-agent'),
      agentOptions: { provider: 'mock', model: 'm' },
    })
    handleUnbound.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }))
    await handleUnbound.agent.whenIdle()
    expect(unboundAllowed.adapter.calls.length).toBeGreaterThanOrEqual(1)

    // Allowlist: binding-only, neither (deny all), defaultCapability, empty capabilities, tool-named capability
    const unspecifiedAllow = await createCtx({}, { preRegisterTools: ['tool_a'] })
    const unspecifiedSession = unspecifiedAllow.ctx.sessions.create(SessionId('no-profile-allowlist'))
    unspecifiedAllow.bindings.set(unspecifiedSession.id, binding(unspecifiedSession.id))
    expect((await unspecifiedAllow.ctx.tools.execute({ name: 'tool_a', arguments: {}, callId: ToolCallId('unconfigured'),
      signal: new AbortController().signal, agent: { id: unspecifiedSession.id, session: unspecifiedSession } as never })).isError).toBe(true)
    const hub = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (c: Buffer) => chunks.push(c))
      req.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
        if (body.callId === 'malformed-array') {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end('[]')
          return
        }
        if (body.callId === 'deny-no-code') {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ allowed: false }))
          return
        }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ allowed: true, echoArgs: body.arguments }))
      })
    })
    await new Promise<void>(r => hub.listen(0, '127.0.0.1', r))
    const addr = hub.address()
    if (addr === null || typeof addr === 'string') throw new Error('expected TCP')
    cleanups.push(() => new Promise<void>(r => hub.close(() => r())))

    const noCfgAllow = await createCtx(
      {
        admissionUrl: `http://127.0.0.1:${addr.port}/admit`,
        admissionIncludeArgs: true,
        defaultCapability: 'cap:default',
        allowedTools: ['tool_a'],
      },
      {
        preRegisterTools: ['tool_a', 'tool_cap'],
        beforeApply: (c) => {
          c.provide('mcpHeaderProvider' as never, {
            headersFor: async () => undefined,
          } as never)
        },
      },
    )
    const sb = noCfgAllow.ctx.sessions.create(SessionId('sb'))
    // No allowedToolNames and no config.allowedTools -> deny all
    noCfgAllow.bindings.set(sb.id, binding(sb.id, { allowedToolNames: [], capabilities: ['cap:default'] }))
    expect((await noCfgAllow.ctx.tools.execute({
      name: 'tool_a', arguments: {}, callId: ToolCallId('no-allow'), signal: new AbortController().signal,
      agent: { id: sb.id, session: sb } as never,
    })).isError).toBe(true)

    // Missing defaultCapability -> deny
    noCfgAllow.bindings.set(sb.id, binding(sb.id, { allowedToolNames: ['tool_a'], capabilities: ['other'] }))
    expect((await noCfgAllow.ctx.tools.execute({
      name: 'tool_a', arguments: {}, callId: ToolCallId('no-cap'), signal: new AbortController().signal,
      agent: { id: sb.id, session: sb } as never,
    })).isError).toBe(true)

    // Valid defaultCapability + admissionIncludeArgs + malformed array + deny without reasonCode + network error
    noCfgAllow.bindings.set(sb.id, binding(sb.id, { allowedToolNames: ['tool_a'], capabilities: ['cap:default'] }))
    expect((await noCfgAllow.ctx.tools.execute({
      name: 'tool_a', arguments: { x: 1 }, callId: ToolCallId('ok-args'), signal: new AbortController().signal,
      agent: { id: sb.id, session: sb } as never,
    })).isError).toBe(false)
    expect((await noCfgAllow.ctx.tools.execute({
      name: 'tool_a', arguments: {}, callId: ToolCallId('malformed-array'), signal: new AbortController().signal,
      agent: { id: sb.id, session: sb } as never,
    })).isError).toBe(true)
    expect((await noCfgAllow.ctx.tools.execute({
      name: 'tool_a', arguments: {}, callId: ToolCallId('deny-no-code'), signal: new AbortController().signal,
      agent: { id: sb.id, session: sb } as never,
    })).isError).toBe(true)

    // Empty capabilities without defaultCapability -> CAPABILITY_MISSING; tool-name-matched capability -> allow
    // Also cover config.allowedTools set with binding.allowedToolNames undefined
    const noDefCap = await createCtx({ allowedTools: ['tool_a'] }, { preRegisterTools: ['tool_a'] })
    const sc = noDefCap.ctx.sessions.create(SessionId('sc'))
    noDefCap.bindings.set(sc.id, binding(sc.id, { capabilities: [] }))
    expect((await noDefCap.ctx.tools.execute({
      name: 'tool_a', arguments: {}, callId: ToolCallId('empty-caps'), signal: new AbortController().signal,
      agent: { id: sc.id, session: sc } as never,
    })).isError).toBe(true)

    noDefCap.bindings.set(sc.id, binding(sc.id, { capabilities: ['tool_a'] }))
    expect((await noDefCap.ctx.tools.execute({
      name: 'tool_a', arguments: {}, callId: ToolCallId('self-cap'), signal: new AbortController().signal,
      agent: { id: sc.id, session: sc } as never,
    })).isError).toBe(false)

    // Unreachable hub URL -> HUB_UNAVAILABLE
    const deadHub = await createCtx({ allowedTools: ['tool_a'], admissionUrl: 'http://127.0.0.1:1/unreachable', admissionTimeoutMs: 500 }, { preRegisterTools: ['tool_a'] })
    const sd = deadHub.ctx.sessions.create(SessionId('sd'))
    deadHub.bindings.set(sd.id, binding(sd.id))
    expect((await deadHub.ctx.tools.execute({
      name: 'tool_a', arguments: {}, callId: ToolCallId('dead-hub'), signal: new AbortController().signal,
      agent: { id: sd.id, session: sd } as never,
    })).isError).toBe(true)
  })

  it('covers pre-step rejections, llm/stream reservation branches, and audit dir symlink/non-dir failure', async () => {
    const { ctx, bindings, adapter } = await createCtx({}, { preRegisterTools: ['tool_a'] })

    // Pre-step rejects when agent has chain under requirePinnedRoute
    const sidChain = SessionId('s-chain')
    bindings.set(sidChain, binding(sidChain))
    const chainAgent = await ctx.agents.create({
      sessionId: sidChain,
      agentOptions: { provider: 'mock', model: 'm', chain: 'free' },
    })
    chainAgent.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }))
    await chainAgent.agent.whenIdle()
    expect(adapter.calls).toHaveLength(0)

    // Pre-step rejects when session binding is missing
    const sidUnbound = SessionId('s-unbound-step')
    const unboundAgent = await ctx.agents.create({
      sessionId: sidUnbound,
      agentOptions: { provider: 'mock', model: 'm' },
    })
    unboundAgent.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }))
    await unboundAgent.agent.whenIdle()
    expect(adapter.calls).toHaveLength(0)

    // llm/stream: missing session in store, missing tokenUsage projection, concurrent reservation + release, system + tools estimation, and sync throw from next()
    const sidStream = SessionId('s-stream')
    bindings.set(sidStream, binding(sidStream, { limits: { maxTotalTokens: 300 } }))
    expect(() => ctx.llm.stream({
      provider: 'mock', model: 'm', messages: [], sessionId: sidStream,
    })).toThrowError(expect.objectContaining({ code: 'JOB_BUDGET_REFUSED' }))

    ctx.sessions.create(sidStream)
    // Two concurrent streams: each reserves ~150+ tokens (with system & tools), second refuses, after 1st finishes, next succeeds
    const s1 = ctx.llm.stream({
      provider: 'mock',
      model: 'm',
      system: 'system prompt',
      tools: [{ name: 't1', description: 'd', parameters: { type: 'object' } }],
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
      maxTokens: 150,
      sessionId: sidStream,
    })
    const iterator = s1[Symbol.asyncIterator]()
    await iterator.next()
    expect(() => ctx.llm.stream({
      provider: 'mock',
      model: 'm',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
      maxTokens: 150,
      sessionId: sidStream,
    })).toThrowError(expect.objectContaining({ code: 'JOB_BUDGET_REFUSED' }))

    while (!(await iterator.next()).done) { /* drain to release reservation */ }
    // Now reservation released -> fits again!
    const s2 = ctx.llm.stream({
      provider: 'mock',
      model: 'm',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
      maxTokens: 150,
      sessionId: sidStream,
    })
    for await (const _chunk of s2) { /* drain */ }

    // Synchronous throw from next() releases reservation
    ctx.on('llm/stream', () => { throw new Error('downstream boom') })
    const downstreamError = ctx.llm.stream({
      provider: 'mock',
      model: 'm',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
      maxTokens: 100,
      sessionId: sidStream,
    })
    await expect(downstreamError[Symbol.asyncIterator]().next()).rejects.toThrow('downstream boom')

    // Missing tokenUsage projection (SessionProjectionRegistry + fake tokenMeter without TokenMeter projections)
    const noProjMeter = await createCtx({}, {
      mountTokenMeter: false,
      beforeApply: (c) => {
        c.provide('tokenMeter' as never, { estimateMessage: () => 5 } as never)
      },
    })
    const snp = SessionId('s-no-proj')
    noProjMeter.bindings.set(snp, binding(snp))
    noProjMeter.ctx.sessions.create(snp)
    expect(() => noProjMeter.ctx.llm.stream({
      provider: 'mock', model: 'm', messages: [], sessionId: snp,
    })).toThrowError(expect.objectContaining({ code: 'JOB_BUDGET_REFUSED' }))

    // Unbound llm/stream under requireBinding: true -> JOB_BUDGET_REFUSED
    expect(() => ctx.llm.stream({
      provider: 'mock', model: 'm', messages: [],
    })).toThrowError(expect.objectContaining({ code: 'JOB_BUDGET_REFUSED' }))

    // Missing provider/model under requirePinnedRoute: true -> JOB_BUDGET_REFUSED
    expect(() => ctx.llm.stream({
      provider: '', model: 'm', messages: [], sessionId: sidStream,
    })).toThrowError(expect.objectContaining({ code: 'JOB_BUDGET_REFUSED' }))

    // requirePinnedRoute: false allows chain in pre-step and llm/stream
    const unpinnedCtx = await createCtx({ requirePinnedRoute: false })
    const sidUnpinned = SessionId('s-unpinned')
    unpinnedCtx.bindings.set(sidUnpinned, binding(sidUnpinned))
    const unpinnedAgent = await unpinnedCtx.ctx.agents.create({
      sessionId: sidUnpinned,
      agentOptions: { provider: 'mock', model: 'm', chain: 'free' },
    })
    unpinnedAgent.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }))
    await unpinnedAgent.agent.whenIdle()
    expect(unpinnedCtx.adapter.calls).toHaveLength(1)

    // Pre-step rejects when agent has no provider/model under requirePinnedRoute: true
    const callsBeforeNoRoute = adapter.calls.length
    const sidNoRoute = SessionId('s-noroute')
    bindings.set(sidNoRoute, binding(sidNoRoute))
    const noRouteAgent = await ctx.agents.create({
      sessionId: sidNoRoute,
      agentOptions: {},
    })
    noRouteAgent.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }))
    await noRouteAgent.agent.whenIdle()
    expect(adapter.calls).toHaveLength(callsBeforeNoRoute)

    // describeProfileIdentity when tools service absent & binding.allowedToolNames undefined
    const minDir = await mkdtemp(join(tmpdir(), 'min-audit-dir-'))
    cleanups.push(() => rm(minDir, { recursive: true, force: true }))
    const minCtx = new Context()
    cleanups.push(() => minCtx.fiber.dispose())
    await minCtx.plugin(SystemPrompt)
    await minCtx.plugin(ToolRuntime)
    const fakeIdSess = { id: 'min-s', append: vi.fn() }
    minCtx.provide('sessions' as never, {
      get: () => fakeIdSess,
      flush: async () => true,
    } as never)
    const { allowedToolNames: _allowlist, ...withoutAllowlist } = binding(SessionId('min-s'))
    minCtx.provide('peerJobBindings' as never, { get: () => withoutAllowlist } as never)
    await minCtx.plugin({ name: 'enpoi-job-guard', inject: ['tools'], apply: applyJobGuard }, {
      auditDir: minDir,
      allowedTools: ['tool_a'],
    })
    minCtx.tools.register({
      name: 'tool_a', description: 'a', parameters: { type: 'object' },
      output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: String(v) }] },
      execute: async () => 'ok',
    })
    expect((await minCtx.tools.execute({
      name: 'tool_a', arguments: {}, callId: ToolCallId('m1'), signal: new AbortController().signal,
      agent: { id: 'min-s', session: fakeIdSess } as never,
    })).isError).toBe(true)
    const minIdentity = minCtx.get('peerProfileIdentity') as PeerProfileIdentityService | undefined
    expect(minIdentity?.describe(SessionId('min-s'))?.toolNames).toEqual(['tool_a'])
    // Also exercise tools absent branch on describeProfileIdentity
    const origGet = minCtx.get.bind(minCtx)
    vi.spyOn(minCtx, 'get').mockImplementation(((key: string) => (key === 'tools' ? undefined : origGet(key as never))) as never)
    expect(minIdentity?.describe(SessionId('min-s'))).toBeUndefined()

    // Exercise audit when sessions service is absent and when sessions.get returns a different object
    const detachedDir = await mkdtemp(join(tmpdir(), 'detached-audit-'))
    cleanups.push(() => rm(detachedDir, { recursive: true, force: true }))
    const noSessCtx = new Context()
    cleanups.push(() => noSessCtx.fiber.dispose())
    await noSessCtx.plugin(SystemPrompt)
    await noSessCtx.plugin(ToolRuntime)
    noSessCtx.tools.register({
      name: 'tool_a', description: 'a', parameters: { type: 'object' },
      output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: String(v) }] },
      execute: async () => 'ok',
    })
    const fakeDetachedSess = { id: 'det-s', append: vi.fn() }
    noSessCtx.provide('peerJobBindings' as never, {
      get: () => binding(SessionId('det-s')),
    } as never)
    await noSessCtx.plugin({ name: 'enpoi-job-guard', inject: ['tools'], apply: applyJobGuard }, {
      auditDir: detachedDir,
      allowedTools: ['tool_a'],
    })
    expect((await noSessCtx.tools.execute({
      name: 'tool_a', arguments: {}, callId: ToolCallId('det1'), signal: new AbortController().signal,
      agent: { id: 'det-s', session: fakeDetachedSess } as never,
    })).isError).toBe(false)

    // sessions service present, but sessions.get returns undefined (mismatch)
    noSessCtx.provide('sessions' as never, { get: () => undefined, flush: async () => true } as never)
    expect((await noSessCtx.tools.execute({
      name: 'tool_a', arguments: {}, callId: ToolCallId('det2'), signal: new AbortController().signal,
      agent: { id: 'det-s', session: fakeDetachedSess } as never,
    })).isError).toBe(false)

    // Audit dir as file (not dir) -> fail closed; audit dir as symlink -> fail closed
    const badDirRoot = await mkdtemp(join(tmpdir(), 'audit-dir-file-'))
    cleanups.push(() => rm(badDirRoot, { recursive: true, force: true }))
    const fileAsAuditDir = join(badDirRoot, 'not-a-dir')
    writeFileSync(fileAsAuditDir, 'file')
    const badAuditCtx = await createCtx({ auditDir: fileAsAuditDir, allowedTools: ['tool_a'] }, { preRegisterTools: ['tool_a'] })
    const sba = badAuditCtx.ctx.sessions.create(SessionId('sba'))
    badAuditCtx.bindings.set(sba.id, binding(sba.id))
    expect((await badAuditCtx.ctx.tools.execute({
      name: 'tool_a', arguments: {}, callId: ToolCallId('ba1'), signal: new AbortController().signal,
      agent: { id: sba.id, session: sba } as never,
    })).isError).toBe(true)

    const symAuditDir = join(badDirRoot, 'sym-dir')
    mkdirSync(join(badDirRoot, 'real-dir'))
    symlinkSync(join(badDirRoot, 'real-dir'), symAuditDir)
    const symAuditCtx = await createCtx({ auditDir: symAuditDir, allowedTools: ['tool_a'] }, { preRegisterTools: ['tool_a'] })
    const ssa = symAuditCtx.ctx.sessions.create(SessionId('ssa'))
    symAuditCtx.bindings.set(ssa.id, binding(ssa.id))
    expect((await symAuditCtx.ctx.tools.execute({
      name: 'tool_a', arguments: {}, callId: ToolCallId('sa1'), signal: new AbortController().signal,
      agent: { id: ssa.id, session: ssa } as never,
    })).isError).toBe(true)

    // peerProfileIdentity with deferLoading tool and multiple sorted tools
    const idCtx = await createCtx({}, { preRegisterTools: ['z_tool', 'a_tool'] })
    idCtx.ctx.tools.register({
      name: 'm_tool',
      description: 'm',
      deferLoading: true,
      parameters: { type: 'object' },
      output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: String(v) }] },
      execute: async () => 'ok',
    })
    const sidId = SessionId('s-id-multi')
    idCtx.ctx.sessions.create(sidId)
    idCtx.bindings.set(sidId, binding(sidId, { allowedToolNames: ['z_tool', 'a_tool'] }))
    const desc = (idCtx.ctx.get('peerProfileIdentity') as PeerProfileIdentityService | undefined)?.describe(sidId)
    expect(desc?.toolNames).toEqual(['a_tool', 'm_tool', 'z_tool'])

  })
})
