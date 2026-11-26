/** Drive the same worker composition with an owned loopback hub and a fake model. */
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { FiberState, type Context } from '@deepseek-ai/cordis'
import type { PeerAlias, PeerCapability, PeerCreateRequest, PeerCreateValue, PeerDeviceName, PeerRequestId } from '@deepseek-ai/dsh-api-peer'
import type { GenerateOptions, StreamChunk, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { brandString } from '@deepseek-ai/dsh-brand'
import { expect, vi } from 'vitest'
import { seedWorkerProfile, workerManifest } from '../worker-profile.mjs'
import fixture from './expected-jarvis-worker.json'

const repo = fileURLToPath(new URL('../..', import.meta.url))
const alias = brandString<PeerAlias>('jarvis')
const device: PeerDeviceName = 'jarvis-hub'
const participant = { kind: 'peer', name: device } as const
const route = { provider: 'jarvis-worker', model: 'fake-knowledge' }
const manifest = workerManifest(repo)
const boundaryOnly = /^(?:bash|read|edit|write|run_code|.*subagent.*|memory_.*|compressor_retrieve|web_.*|skill.*|goal.*|peer_.*)$/u
const digest = (data: Buffer | string) => createHash('sha256').update(data).digest('hex')
const requestId = (value: string) => brandString<PeerRequestId>(value)

interface DrillRow { step: number; name: string; status: 'pass' | 'fail' | 'skipped' | 'declared-limit'; reason: string }
interface Capture {
  rows: DrillRow[]
  tools?: string[]
  profileHash?: string
  version?: string
  schemaDigest?: string
  capabilities?: readonly PeerCapability[]
  missingCapabilities?: readonly PeerCapability[]
}

async function built<T>(path: string): Promise<T> {
  const url = pathToFileURL(join(repo, path)).href
  return import(/* @vite-ignore */ url) as Promise<T>
}

const sourceImports = {
  llm: () => import('@deepseek-ai/dsh-llm'),
  session: () => import('@deepseek-ai/dsh-session'),
  'system-prompt': () => import('@deepseek-ai/dsh-system-prompt'),
  tools: () => import('@deepseek-ai/dsh-tools'),
  agent: () => import('@deepseek-ai/dsh-agent'),
  'agent-loop': () => import('@deepseek-ai/dsh-agent-loop'),
  'agent-default-model': () => import('@deepseek-ai/dsh-agent-default-model'),
  'session-persistence-jsonl': () => import('@deepseek-ai/dsh-session-persistence-jsonl'),
  'session-projection': () => import('@deepseek-ai/dsh-session-projection'),
  'session-query-sqlite': () => import('@deepseek-ai/dsh-session-query-sqlite'),
  'session-checkpoint-policy': () => import('@deepseek-ai/dsh-session-checkpoint-policy'),
  'token-meter': () => import('@deepseek-ai/dsh-token-meter'),
  storage: () => import('@deepseek-ai/dsh-storage'),
  'storage-json': () => import('@deepseek-ai/dsh-storage-json'),
  'storage-domain': () => import('@deepseek-ai/dsh-storage-domain'),
  workspace: () => import('@deepseek-ai/dsh-workspace'),
  approval: () => import('@deepseek-ai/dsh-user-approval'),
  'user-questions': () => import('@deepseek-ai/dsh-user-questions'),
  'sandbox-policy': () => import('@deepseek-ai/dsh-sandbox-policy'),
  'fs-sandbox': () => import('@deepseek-ai/dsh-fs-sandbox'),
  commands: () => import('@deepseek-ai/dsh-commands'),
  'attachment-local': () => import('@deepseek-ai/dsh-attachment-local'),
  credentials: () => import('@deepseek-ai/dsh-credentials-local'),
  connection: () => import('@deepseek-ai/dsh-client-connection'),
  'file-upload': () => import('@deepseek-ai/dsh-client-file-upload'),
  typert: () => import('@deepseek-ai/dsh-typert-registry'),
  'typert-loader': () => import('@deepseek-ai/dsh-typert-loader'),
  'typert-gateway': () => import('@deepseek-ai/dsh-api-gateway'),
  'session-controller': () => import('@deepseek-ai/dsh-api-session-controller'),
  'api-remotes': () => import('@deepseek-ai/dsh-api-remotes'),
  'peer-api': () => import('@deepseek-ai/dsh-api-peer'),
  'agent-preset-registry': () => import('@deepseek-ai/dsh-agent-preset-registry'),
  'worker-runtime': () => import('../../profile/web/packages/enpoi-jarvis-worker/src/index.ts'),
  'worker-credentials': () => import('../../profile/web/packages/enpoi-worker-credentials/src/index.ts'),
  'worker-mcp': () => import('@deepseek-ai/dsh-mcp-client'),
  'worker-job-guard': () => import('../../profile/web/packages/enpoi-job-guard/src/index.ts'),
  'preset-jarvis-worker': () => import('@deepseek-ai/dsh-agent-preset'),
  'restrict-knowledge-tools': () => import('../../profile/web/packages/enpoi-jarvis-worker/restrict.mjs'),
}

/** @param artifact - resolve actual built worker packages instead of Vitest source modules. @returns Recorded acceptance steps. */
export async function captureWorker(artifact = false): Promise<Capture> {
  if (Object.keys(process.env).some(key => key.startsWith('DSH_WIRE_'))) throw new Error('Worker drill requires DSH_WIRE_* unset')
  const rows: DrillRow[] = []
  const capture: Capture = { rows }
  const root = await mkdtemp(join(tmpdir(), 'dsh-worker-drill-'))
  const home = join(root, 'attempt')
  const secrets = join(home, 'worker-secrets')
  const credentials = randomUUID()
  const bearer = `fixture-canary-${randomUUID()}`
  let expectedJob = 'job-one'
  let expectedFence = '1'
  let hubRevoked = false
  let hubExpired = false
  let holdTool = false
  let heldTool = false
  const hubMethods: string[] = []
  const diagnostics: unknown[] = []
  const hub = createServer((req, res) => {
    const authorized = req.headers.authorization === `Bearer ${bearer}` && req.headers['x-jarvis-job-id'] === expectedJob
      && req.headers['x-jarvis-job-fence'] === expectedFence && !hubRevoked && !hubExpired
    if (req.method !== 'POST') { res.writeHead(405).end(); return }
    if (!authorized) { req.resume(); res.writeHead(401).end('refused'); return }
    const parts: Buffer[] = []
    req.on('data', (chunk: Buffer) => parts.push(chunk))
    req.on('end', () => {
      const call = JSON.parse(Buffer.concat(parts).toString('utf8')) as { id?: number; method: string; params?: { name?: string } }
      hubMethods.push(call.params?.name ?? call.method)
      if (call.id === undefined) { res.writeHead(202).end(); return }
      let result: Record<string, unknown>
      if (call.method === 'initialize') {
        result = { protocolVersion: '2025-03-26', serverInfo: { name: 'fixture', version: '1' }, capabilities: { tools: {} }, instructions: 'REMOTE_INSTRUCTIONS_CANARY' }
      } else if (call.method === 'tools/list') {
        result = { tools: manifest.tools.map(tool => ({ ...tool, description: 'REMOTE_DESCRIPTION_CANARY' })) }
      } else {
        if (holdTool) { heldTool = true; return }
        result = { content: [{ type: 'text', text: 'fabricated knowledge' }] }
      }
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: call.id, result }))
    })
  })
  let context: Context | undefined
  const env = { ...process.env }
  const names = ['DSH_HOME', 'DSH_WORKER_MODEL', 'DSH_WORKER_MCP_URL', 'DSH_WORKER_PEER_PORT', 'DSH_WORKER_MODEL_URL'] as const
  let failedPrerequisite = false
  const step = async (
    number: number,
    name: string,
    run: () => Promise<void | { declaredLimit: string }> | void,
    external?: string,
  ): Promise<void> => {
    if (external !== undefined || (failedPrerequisite && number !== 14)) { rows.push({ step: number, name, status: 'skipped', reason: external ?? 'prerequisite failed' }); return }
    try {
      const result = await run()
      rows.push(result === undefined
        ? { step: number, name, status: 'pass', reason: 'observed' }
        : { step: number, name, status: 'declared-limit', reason: result.declaredLimit })
    } catch (error) {
      failedPrerequisite ||= number <= 2
      const text = error instanceof Error ? `${error.message} ${JSON.stringify({ code: Reflect.get(error, 'code'), details: Reflect.get(error, 'details') })}` : String(error)
      rows.push({ step: number, name, status: 'fail', reason: text.replaceAll(bearer, '[redacted]').replaceAll(credentials, '[redacted]') })
    }
  }
  try {
    await mkdir(home, { mode: 0o700 })
    await mkdir(secrets, { mode: 0o700 })
    const workspace = join(home, 'workspace')
    await mkdir(workspace)
    await mkdir(join(home, 'peer-exports'), { mode: 0o700 })
    await writeFile(join(secrets, 'attempt'), bearer, { mode: 0o600 })
    await new Promise<void>((resolve, reject) => { hub.once('error', reject); hub.listen(0, '127.0.0.1', resolve) })
    const address = hub.address()
    if (address === null || typeof address === 'string') throw new Error('no hub fixture port')
    Object.assign(process.env, { DSH_HOME: home, DSH_WORKER_MODEL: route.model, DSH_WORKER_PEER_PORT: '0',
      DSH_WORKER_MCP_URL: `http://127.0.0.1:${address.port}/mcp`, DSH_WORKER_MODEL_URL: `http://127.0.0.1:${address.port}/never-model` })
    const { PeerClient, PEER_SCHEMA_DIGEST } = artifact
      ? await built<typeof import('@deepseek-ai/dsh-api-peer')>('packages/api/peer/lib/index.js')
      : await import('@deepseek-ai/dsh-api-peer')
    const pairing = { version: 1, device: 'worker-host', pairings: [{ alias, peer: device, exposure: 'debug',
      tokenHash: `sha256$${digest(credentials)}`, create: { cwd: workspace, agentPreset: 'jarvis-worker', allowAgentPresets: ['jarvis-worker'], freshOnly: true },
      routing: { allowModels: [`${route.provider}/${route.model}`], allowChains: [], requireTools: true, allowSwitch: 'never' },
      worker: { allowedCapabilities: ['knowledge.search', 'knowledge.facts'], allowedMcpEndpoints: ['jarvis'], allowedToolNames: fixture.tools,
        maxLimits: { maxSteps: 8, maxToolCalls: 8, maxWallMs: 120000, maxTotalTokens: 32000 } } }] }
    await writeFile(join(home, 'pairings.yaml'), JSON.stringify(pairing), { mode: 0o600 })
    const { boot, loadProfile, createRuntimeResolution, PluginPackages } = artifact
      ? await built<typeof import('@deepseek-ai/dsh-app-boot')>('packages/boot/app-boot/lib/index.js')
      : await import('@deepseek-ai/dsh-app-boot')
    const { LlmAdapter } = artifact
      ? await built<typeof import('@deepseek-ai/dsh-llm')>('packages/llm/llm/lib/index.js')
      : await import('@deepseek-ai/dsh-llm')
    const profileRoot = seedWorkerProfile(repo, home)
    const anchor = join(repo, 'apps/cli/package.json')
    const profile = loadProfile('dsh', 'jarvis-worker', anchor, home)
    expect(profile.skippedBundles).toEqual([])
    const patches = profile.layers.flatMap(layer => layer.patches)
    const requests: GenerateOptions[] = []
    let stallGeneration = false
    let generationStarted = false
    let requestTool = false
    class Fake extends LlmAdapter {
      override listModels(provider: string) { return this.resolveModel(provider, route.model).then(model => [model]) }
      override resolveModel(provider: string, model: string) { return Promise.resolve({ provider, id: model, name: model, contextWindow: 32768, tools: true }) }
      override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
        requests.push(options)
        generationStarted = true
        if (stallGeneration) await delay(10000, undefined, { signal: options.signal })
        if (requestTool) {
          requestTool = false
          const id = brandString<ToolCallId>(randomUUID())
          const name = 'mcp__jarvis__knowledge_facts'
          const args = '{"query":"fixture"}'
          yield { type: 'block-start', index: 0, blockType: 'tool-call' }
          yield { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: args }
          yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: args } }
          yield { type: 'usage', usage: { inputTokens: 8, outputTokens: 2 } }
          yield { type: 'finish', reason: { kind: 'tool-calls' } }
          return
        }
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text: 'OK' }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: 'OK' } }
        yield { type: 'usage', usage: { inputTokens: 8, outputTokens: 2 } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }
    const rowsForBoot = patches.flatMap(patch => patch.insert ?? [])
    const productionRoute = rowsForBoot.find(row => row.id === 'llm-pi-ai')
    if (productionRoute === undefined) throw new Error('worker profile has no pinned adapter row')
    // Only the adapter is replaced. The source test binds unchanged plugin
    // implementations under Cordis builtins; the artifact path uses production resolution.
    productionRoute.disabled = true
    const peerRow = rowsForBoot.find(row => row.id === 'peer-api')
    if (peerRow !== undefined) Object.assign(peerRow.config as object, { followIdleMs: 250, followQueueMaxItems: 8 })
    const preset = rowsForBoot.find(row => row.id === 'preset-jarvis-worker')
    const plugins = (preset?.config as { plugins?: { id: string; name: string }[] } | undefined)?.plugins
    if (!artifact) {
      for (const row of rowsForBoot) if (row.disabled !== true) row.name = `cordis:${row.id}`
      for (const row of plugins ?? []) row.name = `cordis:${row.id}`
    }
    const start = () => boot('jarvis-worker-drill', join(profileRoot, 'cordis.yml'), patches, async ctx => {
        ctx.logger.exporter({ levels: { default: 10 }, export: ({ args }) => { diagnostics.push(args) } })
        if (artifact) {
          await ctx.plugin(PluginPackages, { resolution: await createRuntimeResolution({ installAnchor: anchor, profile, home }) })
        } else {
          for (const [id, load] of Object.entries(sourceImports)) {
            const module = await load()
            ctx.loader.builtins[id] = ('default' in module ? module.default : module) as never
          }
        }
        ctx.inject(['llm'], (child) => { child.effect(() => child.llm.registerAdapter([route.provider], new Fake())) })
      })
    await step(0, 'Version, capabilities, models', async () => {
      context = await start()
      const loadedIds = [...context.loader.entries()].filter(row => row.fiber?.state === FiberState.ACTIVE).map(row => row.options.id)
      const wantedIds = ['include', ...rowsForBoot.filter(row => row.disabled !== true).map(row => row.id)]
      const missingIds = wantedIds.filter(id => !loadedIds.includes(id))
      const extraIds = loadedIds.filter(id => !wantedIds.includes(id))
      if (missingIds.length > 0 || extraIds.length > 0) {
        throw new Error(`worker rows not loaded: [${missingIds.join(', ')}]; loaded but undeclared: [${extraIds.join(', ')}]`)
      }
      const hello = await client().handshake()
      expect(hello.schemaDigest).toBe(PEER_SCHEMA_DIGEST)
      capture.schemaDigest = hello.schemaDigest
      capture.version = hello.harnessVersion
      capture.capabilities = hello.capabilities
      const required: PeerCapability[] = ['shape-digest', 'ready', 'job-binding', 'fresh-only-create', 'profile-identity',
        'token-ceiling', 'model-discovery', 'model-routing-at-create', 'create-receipts', 'prompt-receipts', 'input-disposition',
        'export-root', 'durable-asks', 'ask-idempotent-answer', 'bounded-follow', 'follow-gap-frames', 'stop-intent', 'wait-quiescent']
      capture.missingCapabilities = required.filter(capability => !hello.capabilities.includes(capability))
      expect(hello.harnessVersion).toBeTruthy()
      expect((await client().models({ alias, participant })).models.map(row => `${row.provider}/${row.model}`)).toEqual([`${route.provider}/${route.model}`])
    })
    function client(token: string | undefined = credentials) {
      const port = context?.get('jarvisWorkerPort') as number | undefined
      if (port === undefined) throw new Error('worker did not publish a loopback listener')
      return new PeerClient({ endpoint: `http://127.0.0.1:${String(port)}`, device, outboundToken: token, maxReconnects: 0,
        webSocket: (url, headers) => Reflect.construct(WebSocket, [url, { headers }]),
        fetch: (input, init) => fetch(input, { ...init, redirect: 'error', signal: AbortSignal.timeout(6000) }) })
    }
    const job = { jobId: 'job-one', fence: 1, expiresAt: Date.now() + 600000, capabilities: ['knowledge.search', 'knowledge.facts'],
      allowedToolNames: fixture.tools, limits: { maxSteps: 8, maxToolCalls: 8, maxWallMs: 120000, maxTotalTokens: 32000 }, mcpEndpointId: 'jarvis', credentialRef: 'attempt' }
    const create: PeerCreateRequest = { alias, participant, agentPreset: 'jarvis-worker', requestId: requestId('create-1'), ...route, job }
    let created: PeerCreateValue
    const target = { kind: 'alias', alias } as const
    const prompt = { target, participant, requestId: requestId('prompt-1'), content: [{ type: 'text', text: 'Reply OK.' }] } as const
    const agent = () => {
      const found = context?.agents.get(created.target.sessionId)
      if (found === undefined) throw new Error('worker agent is missing')
      return found
    }
    const execute = (name: string, signal: AbortSignal = AbortSignal.timeout(2500)) => agent().ctx.tools.execute({
      name, arguments: { query: 'fixture' }, callId: brandString<ToolCallId>(randomUUID()), agent: agent(), signal,
    })
    const ok = (value: Awaited<ReturnType<typeof execute>>) => !('error' in value)
    const until = async (predicate: () => boolean): Promise<void> => {
      for (let i = 0; i < 200; i++) { if (predicate()) return; await delay(10) }
      throw new Error('fixture operation did not reach the expected dispatch point')
    }

    await step(1, 'Authentication', async () => {
      await expect(client('').create(create)).rejects.toMatchObject({ code: 'peer/target-unreachable' })
      await expect(client('wrong').create(create)).rejects.toMatchObject({ code: 'peer/forbidden' })
    })
    await step(2, 'Composition and direct refusals', async () => {
      await expect(client().create({ ...create, sessionId: brandString<SessionId>('human-session') })).rejects.toMatchObject({
        code: 'peer/forbidden', details: { reason: 'fresh-only-create' },
      })
      expect(hubMethods).toEqual([])
      created = await client().create(create)
      const ready = await client().ready({ alias })
      expect(ready.ready).toBe(true)
      expect(ready.profile).toEqual(created.profile)
      if (ready.profile === undefined) throw new Error('bound worker did not report profile identity')
      expect(ready.profile.hash).toMatch(/^[0-9a-f]{64}$/u)
      capture.profileHash = ready.profile.hash
      await client().prompt(prompt)
      await agent().whenIdle()
      capture.tools = (requests[0]?.tools ?? []).map(tool => tool.name).sort()
      expect(capture.tools).toEqual(fixture.tools)
      expect(capture.tools.some(tool => boundaryOnly.test(tool))).toBe(false)
      expect(JSON.stringify(requests)).not.toMatch(/REMOTE_(?:DESCRIPTION|INSTRUCTIONS)_CANARY/u)
      for (const name of fixture.directRefusals) expect(ok(await execute(name)), name).toBe(false)
      expect(hubMethods).toEqual([])
    })
    await step(3, 'Confinement', () => {}, 'external: see worker-evidence')
    await step(4, 'Scoped hub tools', async () => {
      for (const tool of fixture.tools) expect(ok(await execute(tool)), tool).toBe(true)
      expect(hubMethods).toContain('knowledge_facts')
      expect(hubMethods).toContain('knowledge_search')
      expectedJob = 'wrong'; expect(ok(await execute(fixture.tools[0]!))).toBe(false); expectedJob = 'job-one'
      expectedFence = '2'; expect(ok(await execute(fixture.tools[0]!))).toBe(false); expectedFence = '1'
      hubExpired = true; expect(ok(await execute(fixture.tools[0]!))).toBe(false); hubExpired = false
      hubRevoked = true; expect(ok(await execute(fixture.tools[0]!))).toBe(false); hubRevoked = false
    })
    if (!artifact) {
    await step(5, 'Create receipt and payload conflict', async () => {
      expect((await client().receipt({ alias, requestId: create.requestId!, kind: 'create' })).sessionId).toBe(created.target.sessionId)
      expect(await client().create(create)).toEqual({ ...created, replayed: true })
      await expect(client().create({ ...create, job: { ...job, expiresAt: job.expiresAt + 1000 } })).rejects.toMatchObject({ code: 'peer/conflict' })
    })
    await step(6, 'Prompt receipt and payload conflict', async () => {
      expect((await client().receipt({ alias, requestId: prompt.requestId, kind: 'prompt' })).disposition).toBe('terminal')
      expect((await client().prompt(prompt)).replayed).toBe(true)
      await expect(client().prompt({ ...prompt, content: [{ type: 'text', text: 'Changed' }] })).rejects.toMatchObject({ code: 'peer/conflict' })
    })
    await step(8, 'Bounded transport', async () => {
      const signal = AbortSignal.timeout(3000)
      const slow = client().follow({ target, maxMessages: 4 }, signal)
      try {
        expect((await slow.next()).value).toMatchObject({ type: 'snapshot' })
        await delay(500)
        expect((await slow.next()).value).toMatchObject({ type: 'gap', resync: 'refollow-and-page' })
      } finally { await slow.return(undefined) }
      const reconnect = client().follow({ target, maxMessages: 4 }, signal)
      try { expect((await reconnect.next()).value).toMatchObject({ type: 'snapshot' }) }
      finally { await reconnect.return(undefined) }
    }, capture.capabilities?.includes('bounded-follow') === true ? undefined : 'bounded-follow capability unavailable')
    await step(9, 'Cancel and settlement', async () => {
      stallGeneration = true; generationStarted = false
      const activePrompt = { ...prompt, requestId: requestId('prompt-stop') }
      await client().prompt(activePrompt)
      await until(() => generationStarted)
      const queued = { ...prompt, requestId: requestId('queued-stop') }
      await client().prompt(queued)
      await client().cancel({ target, participant })
      await agent().whenIdle()
      expect((await client().receipt({ alias, requestId: activePrompt.requestId })).disposition).toBe('terminal')
      const queuedDisposition = (await client().receipt({ alias, requestId: queued.requestId })).disposition
      // Discard the previous subcase's retained input locally so the tool subcase
      // starts with an empty inbox. This is not evidence about peer cancel.
      agent().cancel({ kind: 'hook', reason: 'worker-drill/reset-inbox' }, { keepInbox: false })
      stallGeneration = false
      holdTool = true
      requestTool = true
      const toolPrompt = { ...prompt, requestId: requestId('tool-stop') }
      try {
        await client().prompt(toolPrompt)
        await until(() => heldTool)
        await client().cancel({ target, participant })
        await agent().whenIdle()
        expect((await client().receipt({ alias, requestId: toolPrompt.requestId })).disposition, 'in-flight tool prompt disposition').toBe('terminal')
      } finally { holdTool = false; requestTool = false }
      expect(queuedDisposition, 'peer cancel must explicitly dispose of a not-yet-dispatched prompt').toBe('cancelled_before_dispatch')
    })
    await step(10, 'Step, wall, tool, and token budgets', async () => {
      const before = hubMethods.length
      for (let i = 0; i <= job.limits.maxToolCalls; i++) await execute(fixture.tools[0]!)
      const exhausted = hubMethods.length
      expect(exhausted - before).toBeLessThanOrEqual(job.limits.maxToolCalls)
      expect(ok(await execute(fixture.tools[0]!))).toBe(false)
      expect(hubMethods.length).toBe(exhausted)
      const opts = requests[0]
      if (opts === undefined || context === undefined) throw new Error('no bound model request to replay through the guard')
      const sent = requests.length
      const stream = () => context!.llm.stream({ ...opts, signal: AbortSignal.timeout(2000), maxTokens: job.limits.maxTotalTokens })
      await expect(async () => { for await (const chunk of stream()) void chunk }).rejects.toMatchObject({ code: 'JOB_BUDGET_REFUSED' })
      expect(requests).toHaveLength(sent)
      for (let i = 0; i <= job.limits.maxSteps; i++) {
        await client().prompt({ ...prompt, requestId: requestId(`step-limit-${String(i)}`) })
        await agent().whenIdle()
      }
      const audit = async () => {
        const dir = join(home, 'enpoi-job-guard')
        return (await Promise.all((await readdir(dir)).map(file => readFile(join(dir, file), 'utf8')))).join('\n')
      }
      expect(await audit()).toContain('MAX_STEPS_EXCEEDED')
      expect(await audit()).toContain('TOOL_CALL_LIMIT_EXCEEDED')
      const posted = requests.length
      const time = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 121000)
      try {
        await client().prompt({ ...prompt, requestId: requestId('past-wall-limit') })
        await agent().whenIdle()
        expect(requests).toHaveLength(posted)
        expect(await audit()).toContain('WALL_DEADLINE_EXCEEDED')
      } finally { time.mockRestore() }
    })
    await step(11, 'Unknown route and unavailable meter refused', async () => {
      const before = requests.length
      await expect(client().create({ ...create, requestId: requestId('bad-model'), model: 'unknown' })).rejects.toMatchObject({ code: 'peer/forbidden' })
      const opts = requests[0]
      if (opts === undefined || context === undefined) throw new Error('no bound model request to replay through the guard')
      const snapshot = context.sessionProjections.snapshot.bind(context.sessionProjections)
      const unmetered = vi.spyOn(context.sessionProjections, 'snapshot').mockImplementation((session, keys) => {
        const current = snapshot(session, keys)
        const values = { ...current.values }
        delete values.tokenUsage
        return { ...current, values }
      })
      try {
        expect(() => context!.llm.stream({ ...opts, signal: AbortSignal.timeout(1000) })).toThrow(/tokenUsage projection unavailable/u)
      } finally { unmetered.mockRestore() }
      expect(requests.length).toBe(before)
    })
    await step(12, 'Artifact containment', async () => {
      const dir = join(home, 'peer-exports', created.target.sessionId)
      await mkdir(dir, { recursive: true, mode: 0o700 })
      const bytes = Buffer.from('fabricated artifact\n')
      await writeFile(join(dir, 'example.txt'), bytes)
      await symlink(join(home, 'pairings.yaml'), join(dir, 'linked'))
      const exported = await client().exportFetch({ alias, path: 'example.txt' })
      expect(exported.sha256).toBe(digest(bytes))
      expect(digest(Buffer.from(exported.contentBase64, 'base64'))).toBe(exported.sha256)
      expect(digest(Buffer.from('different bytes'))).not.toBe(exported.sha256)
      for (const [path, maxBytes] of [['../pairings.yaml', 4096], ['linked', 4096], ['example.txt', 1]] as const) {
        await expect(client().exportFetch({ alias, path, maxBytes })).rejects.toMatchObject({ code: expect.stringMatching(/^(peer|gateway)\//u) })
      }
    })
    await step(13, 'False success', () => {}, 'hub-side: independent verification and disposition')
    await step(7, 'Question expiry and answer replay after restart', async () => {
      const oldHost = context
      if (oldHost === undefined) throw new Error('worker host unavailable')
      const askQuestion = (id: string) => oldHost.userQuestions.ask({
        agent: agent(), questions: [{ id, question: 'Pick one.', options: [{ label: 'A' }, { label: 'B' }] }],
      })
      const pendingQuestion = async () => {
        for (let i = 0; i < 100; i++) {
          const ask = (await client().asks({ alias })).asks.find(candidate => candidate.kind === 'question' && candidate.state === 'pending')
          if (ask !== undefined) return ask
          await delay(10)
        }
        throw new Error('structured question was not parked')
      }
      const decision = (id: string) => ({ kind: 'question' as const, answer: { answers: [{ id, selected: ['A'] }] } })
      const deliveries = vi.fn()
      const answered = askQuestion('answered-question').then(deliveries, () => undefined)
      let unresolved: Promise<unknown> | undefined
      try {
        const answeredAsk = await pendingQuestion()
        const win = { target, participant, askId: answeredAsk.askId, requestId: requestId('answer-before-restart'),
          answer: decision('answered-question') }
        const receipt = await client().answer(win)
        expect(receipt).toMatchObject({ accepted: true, settled: true, replayed: false })
        await answered
        expect(deliveries).toHaveBeenCalledExactlyOnceWith(win.answer.answer)

        const lateDeliveries = vi.fn()
        unresolved = askQuestion('pending-question').then(lateDeliveries, () => undefined)
        const pending = await pendingQuestion()
        const askStore = join(home, 'peer-asks.json')
        const beforeRestart = await readFile(askStore)
        await oldHost.fiber.dispose()
        context = undefined
        // Restore the on-disk crash cut (before graceful teardown could settle the ask).
        await writeFile(askStore, beforeRestart, { mode: 0o600 })
        context = await start()
        const after = await client().asks({ alias })
        expect(after.instanceId).not.toBe(pending.instanceId)
        expect(after.asks.find(ask => ask.askId === pending.askId)).toMatchObject({
          ...pending, state: 'expired', settlementReason: 'host-restarted',
        })
        await expect(client().answer({ target, participant, askId: pending.askId,
          requestId: requestId('late-answer'), answer: decision('pending-question'),
        })).rejects.toMatchObject({ code: 'peer/conflict', details: { reason: expect.stringMatching(/^(?:ask-expired|stale-generation)$/u) } })
        await expect(client().answer(win)).resolves.toEqual({ ...receipt, replayed: true })
        await unresolved
        expect(lateDeliveries).not.toHaveBeenCalled()
        expect(deliveries).toHaveBeenCalledTimes(1)
        return { declaredLimit: 'requirement N-ASK-1 restart-survival NOT met: the hub must re-ask after a worker restart' }
      } finally { await oldHost.fiber.dispose(); await answered; await unresolved }
    }, capture.capabilities?.includes('durable-asks') === true ? undefined : 'durable-asks capability unavailable')
    }
    await step(14, 'Teardown and bearer absence', async () => {
      await context?.fiber.dispose()
      context = undefined
      expect(JSON.stringify(requests)).not.toContain(bearer)
      expect(JSON.stringify(diagnostics)).not.toContain(bearer)
      async function scan(dir: string): Promise<void> {
        for (const entry of await readdir(dir, { withFileTypes: true })) {
          const path = join(dir, entry.name)
          if (path === secrets || entry.isSymbolicLink()) continue
          if (entry.isDirectory()) await scan(path)
          else if (entry.isFile() && (await readFile(path)).includes(bearer)) throw new Error('bearer appeared outside credential storage')
        }
      }
      await scan(home)
    })
    rows.sort((a, b) => a.step - b.step)
    return capture
  } finally {
    try {
      await context?.fiber.dispose()
    } finally {
      hub.closeAllConnections()
      await new Promise<void>(resolve => { hub.close(() => { resolve() }) })
      try { await rm(root, { recursive: true, force: true }) }
      finally {
        for (const name of names) {
          if (env[name] === undefined) delete process.env[name]
          else process.env[name] = env[name]
        }
      }
    }
  }
}
