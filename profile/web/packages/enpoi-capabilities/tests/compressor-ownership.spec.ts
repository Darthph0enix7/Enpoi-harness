/**
 * Compressor locator session-ownership enforcement (C-01).
 *
 * Boots the real `dsh-compressor` plugin alongside `enpoi-capabilities` over
 * `@deepseek-ai/dsh-tools` and `@deepseek-ai/dsh-session` (plus `spill-policy`
 * and `spill-local` for re-spilling coverage) in an isolated temp `$DSH_HOME`.
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import * as SpillPolicy from '@deepseek-ai/dsh-spill-policy'
import LocalSpillStore from '@deepseek-ai/dsh-spill-local'
import * as dshCompressor from 'dsh-compressor'
import * as enpoiCapabilities from '../src/index'
import { createCompressorOwnershipStore } from '../src/compressor-ownership'

const LOCATOR_RE = /<<compressor:([0-9a-fA-F]{64})>>/

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

function makeCompressiblePayload(tag: string, lines = 60): string {
  const rows: string[] = []
  for (let i = 0; i < lines; i += 1) {
    rows.push(
      `item-${i} tag=${tag} alpha_${i * 7} beta_${i * 13} gamma_${i * 19} status=active checkpoint=${i}`,
    )
  }
  return rows.join('\n')
}

function extractText(content: readonly { type: string; text?: string }[]): string {
  return content.map(block => (block.type === 'text' ? (block.text ?? '') : '')).join('')
}

function extractHash(text: string): string {
  const match = text.match(LOCATOR_RE)
  if (!match?.[1]) {
    throw new Error(`Expected <<compressor:hash>> locator in output, got: ${text.slice(0, 200)}`)
  }
  return match[1].toLowerCase()
}

interface MountedStack {
  ctx: Context
  runEmit: (sessionId: string, toolName: string, payload: string) => Promise<{ text: string; hash: string }>
  runTool: (sessionId: string | undefined, toolName: string, args: Record<string, unknown>) => Promise<{
    isError: boolean
    text: string
    errorMessage?: string
  }>
  createSession: (id: string, parentId?: string) => void
  stop: () => Promise<void>
}

async function mountStack(options: {
  dshHome: string
  compressorFirst?: boolean
  maxInlineTokens?: number
} ): Promise<MountedStack> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  ctx.provide('settings', {
    describe: () => [{
      ns: 'enpoi-orchestration',
      value: {
        permissions: {
          tools: { mock_log_tool: 'allow', bash: 'allow' },
        },
      },
    }],
    get: (ns: string) => (ns === 'enpoi-orchestration'
      ? { permissions: { tools: { mock_log_tool: 'allow', bash: 'allow' } } }
      : undefined),
  } as never)
  ctx.provide('timer', {
    setTimeout: () => () => {},
    setInterval: () => () => {},
  } as never)
  // Minimal timer methods on ctx for plugins using ctx.setTimeout / ctx.setInterval directly.
  if (typeof (ctx as { setTimeout?: unknown }).setTimeout !== 'function') {
    Object.assign(ctx, {
      setTimeout: () => () => {},
      setInterval: () => () => {},
    })
  }

  if (options.maxInlineTokens !== undefined) {
    await ctx.plugin(LocalSpillStore, {
      root: join(options.dshHome, 'spill'),
      cleanupPeriodDays: 0,
    })
    await ctx.plugin(SpillPolicy, { maxInlineTokens: options.maxInlineTokens })
  }

  const capsConfig = {
    permissions: {
      tools: { mock_log_tool: 'allow', bash: 'allow' },
    },
  }

  if (options.compressorFirst) {
    await ctx.plugin(dshCompressor as never, {})
    await ctx.plugin(enpoiCapabilities as never, capsConfig as never)
  } else {
    await ctx.plugin(enpoiCapabilities as never, capsConfig as never)
    await ctx.plugin(dshCompressor as never, {})
  }

  let seq = 0
  const nextCallId = () => ToolCallId(`call-${++seq}`)
  const signal = new AbortController().signal

  ctx.tools.register(defineTool({
    name: 'mock_log_tool',
    description: 'Returns supplied text payload.',
    parameters: { text: { type: 'string', required: true } },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(args: { text: string }) {
      return args.text
    },
  }))

  ctx.tools.register(defineTool({
    name: 'read',
    description: 'Excluded read tool returning supplied text.',
    parameters: { text: { type: 'string', required: true } },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(args: { text: string }) {
      return args.text
    },
  }))

  ctx.tools.register(defineTool({
    name: 'bash',
    description: 'Non-excluded bash tool returning supplied text.',
    parameters: { command: { type: 'string', required: true } },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(args: { command: string }) {
      return args.command
    },
  }))

  const agents = new Map<string, { id: string; session: ReturnType<SessionStore['get']> }>()
  ctx.provide('agents', {
    get: (id: string) => agents.get(id),
  } as never)

  const createSession = (id: string, parentId?: string) => {
    const sid = SessionId(id)
    if (!ctx.sessions.get(sid)) {
      const session = ctx.sessions.create(sid, {
        meta: {
          cwd: options.dshHome,
          ...(parentId === undefined ? {} : { parentSession: SessionId(parentId), origin: 'subagent' }),
        },
      })
      agents.set(id, { id, session })
    }
  }

  const runTool = async (
    sessionId: string | undefined,
    toolName: string,
    args: Record<string, unknown>,
  ) => {
    const agent = sessionId === undefined
      ? undefined
      : (agents.get(sessionId) ?? { id: sessionId, session: ctx.sessions.get(SessionId(sessionId)) })
    const result = await ctx.tools.execute({
      callId: nextCallId(),
      rootCallId: nextCallId(),
      name: toolName,
      arguments: args,
      signal,
      ...(agent === undefined ? {} : { agent: agent as never }),
    })
    return {
      isError: result.isError,
      text: extractText(result.content as readonly { type: string; text?: string }[]),
      ...(result.isError && result.error ? { errorMessage: result.error.message } : {}),
    }
  }

  const runEmit = async (sessionId: string, toolName: string, payload: string) => {
    const res = await runTool(sessionId, toolName, { text: payload })
    if (res.isError) {
      throw new Error(`runEmit(${toolName}) failed: ${res.text}`)
    }
    const hash = extractHash(res.text)
    return { text: res.text, hash }
  }

  return {
    ctx,
    runEmit,
    runTool,
    createSession,
    stop: async () => {
      await ctx.fiber.dispose()
    },
  }
}

describe('compressor_retrieve session ownership (C-01)', () => {
  const roots: string[] = []
  const savedDshHome = process.env.DSH_HOME
  const savedHome = process.env.HOME

  function freshHome(): string {
    const root = mkdtempSync(join(tmpdir(), 'dsh-compressor-c01-'))
    roots.push(root)
    const dshHome = join(root, 'dsh')
    process.env.DSH_HOME = dshHome
    process.env.HOME = join(root, 'home')
    return dshHome
  }

  afterEach(() => {
    if (savedDshHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = savedDshHome
    if (savedHome === undefined) delete process.env.HOME
    else process.env.HOME = savedHome
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('allows same session to retrieve its own locator (full locator and bare hash)', async () => {
    const dshHome = freshHome()
    const stack = await mountStack({ dshHome })
    try {
      stack.createSession('sess-a')
      const payload = makeCompressiblePayload('alpha')
      const { hash } = await stack.runEmit('sess-a', 'mock_log_tool', payload)
      expect(hash).toBe(sha256(payload))

      const full = await stack.runTool('sess-a', 'compressor_retrieve', { locator: `<<compressor:${hash}>>` })
      expect(full.isError).toBe(false)
      expect(full.text).toBe(payload)

      const bare = await stack.runTool('sess-a', 'compressor_retrieve', { locator: hash.toUpperCase() })
      expect(bare.isError).toBe(false)
      expect(bare.text).toBe(payload)
    } finally {
      await stack.stop()
    }
  })

  it('refuses unrelated session B from retrieving session A locator with uniform refusal', async () => {
    const dshHome = freshHome()
    const stack = await mountStack({ dshHome })
    try {
      stack.createSession('sess-a')
      stack.createSession('sess-b')
      const payload = makeCompressiblePayload('secret-alpha')
      const { hash } = await stack.runEmit('sess-a', 'mock_log_tool', payload)

      const crossFull = await stack.runTool('sess-b', 'compressor_retrieve', { locator: `<<compressor:${hash}>>` })
      expect(crossFull.isError).toBe(true)
      expect(crossFull.text).not.toContain(payload)
      expect(crossFull.text).not.toContain(hash)

      const crossBare = await stack.runTool('sess-b', 'compressor_retrieve', { locator: hash })
      expect(crossBare.isError).toBe(true)
      expect(crossBare.text).toBe(crossFull.text)

      // Uniform refusal: unknown non-existent 64-hex hash yields the exact same message
      const nonExistentHash = 'f'.repeat(64)
      const unknownFromB = await stack.runTool('sess-b', 'compressor_retrieve', { locator: `<<compressor:${nonExistentHash}>>` })
      expect(unknownFromB.isError).toBe(true)
      expect(unknownFromB.text).toBe(crossFull.text)

      const unknownFromA = await stack.runTool('sess-a', 'compressor_retrieve', { locator: nonExistentHash })
      expect(unknownFromA.isError).toBe(true)
      expect(unknownFromA.text).toBe(crossFull.text)

      const malformed = await stack.runTool('sess-b', 'compressor_retrieve', { locator: 'not-a-valid-locator' })
      expect(malformed.isError).toBe(true)
      expect(malformed.text).toBe(crossFull.text)
    } finally {
      await stack.stop()
    }
  })

  it('allows parent->child and child->parent (and multi-hop lineage) while refusing siblings', async () => {
    const dshHome = freshHome()
    const stack = await mountStack({ dshHome })
    try {
      stack.createSession('root-1')
      stack.createSession('child-1', 'root-1')
      stack.createSession('grandchild-1', 'child-1')
      stack.createSession('sibling-2', 'root-1')

      const parentPayload = makeCompressiblePayload('parent-data')
      const childPayload = makeCompressiblePayload('child-data')
      const grandchildPayload = makeCompressiblePayload('grandchild-data')

      const { hash: parentHash } = await stack.runEmit('root-1', 'mock_log_tool', parentPayload)
      const { hash: childHash } = await stack.runEmit('child-1', 'mock_log_tool', childPayload)
      const { hash: grandchildHash } = await stack.runEmit('grandchild-1', 'mock_log_tool', grandchildPayload)

      // parent -> child and parent -> grandchild
      const cReadsP = await stack.runTool('child-1', 'compressor_retrieve', { locator: `<<compressor:${parentHash}>>` })
      expect(cReadsP.isError).toBe(false)
      expect(cReadsP.text).toBe(parentPayload)

      const gReadsP = await stack.runTool('grandchild-1', 'compressor_retrieve', { locator: parentHash })
      expect(gReadsP.isError).toBe(false)
      expect(gReadsP.text).toBe(parentPayload)

      // child -> parent and grandchild -> parent
      const pReadsC = await stack.runTool('root-1', 'compressor_retrieve', { locator: `<<compressor:${childHash}>>` })
      expect(pReadsC.isError).toBe(false)
      expect(pReadsC.text).toBe(childPayload)

      const pReadsG = await stack.runTool('root-1', 'compressor_retrieve', { locator: grandchildHash })
      expect(pReadsG.isError).toBe(false)
      expect(pReadsG.text).toBe(grandchildPayload)

      // sibling CANNOT read child-1 or grandchild-1
      const sibReadsC = await stack.runTool('sibling-2', 'compressor_retrieve', { locator: childHash })
      expect(sibReadsC.isError).toBe(true)
      expect(sibReadsC.text).not.toContain(childPayload)

      const sibReadsG = await stack.runTool('sibling-2', 'compressor_retrieve', { locator: grandchildHash })
      expect(sibReadsG.isError).toBe(true)
      expect(sibReadsG.text).toBe(sibReadsC.text)
    } finally {
      await stack.stop()
    }
  })

  it('works regardless of whether dsh-compressor loads before enpoi-capabilities', async () => {
    const dshHome = freshHome()
    const stack = await mountStack({ dshHome, compressorFirst: true })
    try {
      stack.createSession('sess-a')
      stack.createSession('sess-b')
      const payload = makeCompressiblePayload('load-order')
      const { hash } = await stack.runEmit('sess-a', 'mock_log_tool', payload)

      const ok = await stack.runTool('sess-a', 'compressor_retrieve', { locator: hash })
      expect(ok.isError).toBe(false)
      expect(ok.text).toBe(payload)

      const denied = await stack.runTool('sess-b', 'compressor_retrieve', { locator: hash })
      expect(denied.isError).toBe(true)
    } finally {
      await stack.stop()
    }
  })

  it('prevents locator spoofing via excluded tools or echoed locator strings', async () => {
    const dshHome = freshHome()
    const stack = await mountStack({ dshHome })
    try {
      stack.createSession('sess-a')
      stack.createSession('sess-b')
      const payload = makeCompressiblePayload('spoof-target')
      const { hash } = await stack.runEmit('sess-a', 'mock_log_tool', payload)

      // Session B runs `read` or short `bash` containing Session A's locator string
      await stack.runTool('sess-b', 'read', { text: `leaked <<compressor:${hash}>>` })
      await stack.runTool('sess-b', 'bash', { command: `<<compressor:${hash}>>` })

      const attempt = await stack.runTool('sess-b', 'compressor_retrieve', { locator: hash })
      expect(attempt.isError).toBe(true)
      expect(attempt.text).not.toContain(payload)
    } finally {
      await stack.stop()
    }
  })

  it('handles content-addressed duplicate emissions across unrelated sessions', async () => {
    const dshHome = freshHome()
    const stack = await mountStack({ dshHome })
    try {
      stack.createSession('sess-a')
      stack.createSession('sess-b')
      stack.createSession('sess-c')
      const shared = makeCompressiblePayload('identical-output')

      const { hash: h1 } = await stack.runEmit('sess-a', 'mock_log_tool', shared)
      const { hash: h2 } = await stack.runEmit('sess-b', 'mock_log_tool', shared)
      expect(h1).toBe(h2)

      expect((await stack.runTool('sess-a', 'compressor_retrieve', { locator: h1 })).text).toBe(shared)
      expect((await stack.runTool('sess-b', 'compressor_retrieve', { locator: h1 })).text).toBe(shared)
      expect((await stack.runTool('sess-c', 'compressor_retrieve', { locator: h1 })).isError).toBe(true)
    } finally {
      await stack.stop()
    }
  })

  it('fails closed when caller has no session context', async () => {
    const dshHome = freshHome()
    const stack = await mountStack({ dshHome })
    try {
      stack.createSession('sess-a')
      const payload = makeCompressiblePayload('no-session')
      const { hash } = await stack.runEmit('sess-a', 'mock_log_tool', payload)

      const noSession = await stack.runTool(undefined, 'compressor_retrieve', { locator: hash })
      expect(noSession.isError).toBe(true)
      expect(noSession.text).not.toContain(payload)
    } finally {
      await stack.stop()
    }
  })

  it('persists ownership and lineage durably across a restart', async () => {
    const dshHome = freshHome()
    const parentPayload = makeCompressiblePayload('restart-parent')
    const childPayload = makeCompressiblePayload('restart-child')
    let parentHash = ''
    let childHash = ''

    const stack1 = await mountStack({ dshHome })
    try {
      stack1.createSession('root-r')
      stack1.createSession('child-r', 'root-r')
      parentHash = (await stack1.runEmit('root-r', 'mock_log_tool', parentPayload)).hash
      childHash = (await stack1.runEmit('child-r', 'mock_log_tool', childPayload)).hash
    } finally {
      await stack1.stop()
    }

    // Fresh Context simulating process restart with the same DSH_HOME
    const stack2 = await mountStack({ dshHome })
    try {
      // Only root-r is resumed; child-r is NOT live in stack2
      stack2.createSession('root-r')
      stack2.createSession('other-r')

      // Root can retrieve its own locator after restart
      const rSelf = await stack2.runTool('root-r', 'compressor_retrieve', { locator: parentHash })
      expect(rSelf.isError).toBe(false)
      expect(rSelf.text).toBe(parentPayload)

      // Root can retrieve child-r's locator after restart even though child-r is not live
      const rChild = await stack2.runTool('root-r', 'compressor_retrieve', { locator: childHash })
      expect(rChild.isError).toBe(false)
      expect(rChild.text).toBe(childPayload)

      // Grandchild of dead child-r can retrieve root-r's locator via persisted parent chain
      stack2.createSession('grandchild-r', 'child-r')
      const gParent = await stack2.runTool('grandchild-r', 'compressor_retrieve', { locator: parentHash })
      expect(gParent.isError).toBe(false)
      expect(gParent.text).toBe(parentPayload)

      // Unrelated session is still refused after restart
      const denied = await stack2.runTool('other-r', 'compressor_retrieve', { locator: parentHash })
      expect(denied.isError).toBe(true)
      expect(denied.text).not.toContain(parentPayload)
    } finally {
      await stack2.stop()
    }
  })

  it('preserves bounded/re-spilled behavior on compression and retrieval', async () => {
    const dshHome = freshHome()
    // Tight maxInlineTokens so spill-policy bounds both large crushed output and large restored output
    const stack = await mountStack({ dshHome, maxInlineTokens: 150 })
    try {
      stack.createSession('sess-spill')
      stack.createSession('sess-other')

      // Unique high-entropy-ish lines so crushed result still exceeds 150 tokens -> spill-policy re-spills
      const lines: string[] = []
      for (let i = 0; i < 60; i += 1) {
        lines.push(`item-${i} alpha_${i * 7} beta_${i * 13} gamma_${i * 19} status=active checkpoint=${i}`)
      }
      const largePayload = lines.join('\n')
      const expectedHash = sha256(largePayload)

      const emitted = await stack.runTool('sess-spill', 'mock_log_tool', { text: largePayload })
      expect(emitted.isError).toBe(false)
      // Spill policy re-spilled the crushed output (contains official spill notice)
      expect(emitted.text).toContain('Full formatted result stored at:')

      // Even though spill-policy re-spilled it, sess-spill owns the compressor hash
      const retrieved = await stack.runTool('sess-spill', 'compressor_retrieve', { locator: expectedHash })
      expect(retrieved.isError).toBe(false)
      // And spill-policy STILL bounds/re-spills the large retrieved output!
      expect(retrieved.text).toContain('Full formatted result stored at:')

      // Unrelated session cannot retrieve it
      const denied = await stack.runTool('sess-other', 'compressor_retrieve', { locator: expectedHash })
      expect(denied.isError).toBe(true)
    } finally {
      await stack.stop()
    }
  })

  it('survives a corrupt or unreadable ownership side file by failing closed', async () => {
    const dshHome = freshHome()
    const stateFile = join(dshHome, 'enpoi-capabilities', 'compressor-ownership.json')
    await (async () => {
      const s = await mountStack({ dshHome })
      s.createSession('sess-a')
      await s.runEmit('sess-a', 'mock_log_tool', makeCompressiblePayload('corrupt-test'))
      await s.stop()
    })()

    // Verify side file exists and corrupt it
    expect(existsSync(stateFile)).toBe(true)
    expect(readFileSync(stateFile, 'utf8').length).toBeGreaterThan(0)
    writeFileSync(stateFile, '{not valid json', 'utf8')

    const stack2 = await mountStack({ dshHome })
    try {
      stack2.createSession('sess-a')
      const payload = makeCompressiblePayload('corrupt-test')
      const res = await stack2.runTool('sess-a', 'compressor_retrieve', { locator: sha256(payload) })
      expect(res.isError).toBe(true)
      expect(res.text).not.toContain(payload)
    } finally {
      await stack2.stop()
    }
  })

  it('enforces ownership monotonically in tools.guard even if a pre-execute listener short-circuits allow', async () => {
    const dshHome = freshHome()
    const stack = await mountStack({ dshHome })
    try {
      stack.createSession('sess-a')
      stack.createSession('sess-b')
      const payload = makeCompressiblePayload('guard-backstop')
      const { hash } = await stack.runEmit('sess-a', 'mock_log_tool', payload)

      // Outer pre-execute listener short-circuits allow without calling next().
      stack.ctx.on('tools/pre-execute', async () => ({ kind: 'allow' }), { prepend: true })

      const denied = await stack.runTool('sess-b', 'compressor_retrieve', { locator: hash })
      expect(denied.isError).toBe(true)
      expect(denied.text).not.toContain(payload)
      expect(denied.text).toContain('unavailable to this session')

      const allowed = await stack.runTool('sess-a', 'compressor_retrieve', { locator: hash })
      expect(allowed.isError).toBe(false)
      expect(allowed.text).toBe(payload)
    } finally {
      await stack.stop()
    }
  })

  it('denies unauthorized compressor_retrieve before approval ask when policy is ask', async () => {
    const dshHome = freshHome()
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    let approvalCalls = 0
    ctx.provide('approval', {
      request: async () => {
        approvalCalls += 1
        return 'allowed-once'
      },
    } as never)
    ctx.provide('settings', { describe: () => [], get: () => undefined } as never)
    ctx.provide('timer', { setTimeout: () => () => {}, setInterval: () => () => {} } as never)
    Object.assign(ctx, {
      setTimeout: () => () => {},
      setInterval: () => () => {},
    })
    await ctx.plugin(enpoiCapabilities as never, {
      permissions: { tools: { compressor_retrieve: 'ask', mock_log_tool: 'allow' } },
    } as never)
    await ctx.plugin(dshCompressor as never, {})
    try {
      const sA = ctx.sessions.create(SessionId('ask-a'), { meta: { cwd: dshHome } })
      const sB = ctx.sessions.create(SessionId('ask-b'), { meta: { cwd: dshHome } })
      ctx.tools.register(defineTool({
        name: 'mock_log_tool',
        description: 'mock',
        parameters: { text: { type: 'string', required: true } },
        output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
        async execute(args: { text: string }) { return args.text },
      }))
      const payload = makeCompressiblePayload('ask-gate')
      const signal = new AbortController().signal
      const emitRes = await ctx.tools.execute({
        callId: ToolCallId('c1'),
        rootCallId: ToolCallId('c1'),
        name: 'mock_log_tool',
        arguments: { text: payload },
        signal,
        agent: { id: 'ask-a', session: sA } as never,
      })
      const hash = extractHash(extractText(emitRes.content as readonly { type: string; text?: string }[]))

      const unauth = await ctx.tools.execute({
        callId: ToolCallId('c2'),
        rootCallId: ToolCallId('c2'),
        name: 'compressor_retrieve',
        arguments: { locator: hash },
        signal,
        agent: { id: 'ask-b', session: sB } as never,
      })
      expect(unauth.isError).toBe(true)
      expect(approvalCalls).toBe(0)

      const auth = await ctx.tools.execute({
        callId: ToolCallId('c3'),
        rootCallId: ToolCallId('c3'),
        name: 'compressor_retrieve',
        arguments: { locator: hash },
        signal,
        agent: { id: 'ask-a', session: sA } as never,
      })
      expect(auth.isError).toBe(false)
      expect(approvalCalls).toBe(1)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('bounds stored hashes, owners per hash, and session parent links on disk', () => {
    const dshHome = freshHome()
    const storePath = join(dshHome, 'enpoi-capabilities', 'bounded.json')
    const store = createCompressorOwnershipStore({
      storePath,
      maxHashes: 2,
      maxOwnersPerHash: 2,
      maxSessionParents: 2,
    })

    const h1 = '1'.repeat(64)
    const h2 = '2'.repeat(64)
    const h3 = '3'.repeat(64)
    expect(store.record(h1, { id: 's1' })).toBe(true)
    expect(store.record(h1, { id: 's2' })).toBe(true)
    expect(store.record(h1, { id: 's3' })).toBe(true)
    // s1 was evicted from h1 by maxOwnersPerHash=2
    expect(store.isAllowed(h1, { id: 's1' })).toBe(false)
    expect(store.isAllowed(h1, { id: 's2' })).toBe(true)
    expect(store.isAllowed(h1, { id: 's3' })).toBe(true)

    expect(store.record(h2, { id: 's1' })).toBe(true)
    expect(store.record(h3, { id: 's1' })).toBe(true)
    // h1 was evicted by maxHashes=2
    expect(store.isAllowed(h1, { id: 's2' })).toBe(false)
    expect(store.isAllowed(h2, { id: 's1' })).toBe(true)
    expect(store.isAllowed(h3, { id: 's1' })).toBe(true)

    store.observeSession({ id: 'c1', header: { id: 'c1', parentSession: 'p1' } })
    store.observeSession({ id: 'c2', header: { id: 'c2', parentSession: 'p2' } })
    store.observeSession({ id: 'c3', header: { id: 'c3', parentSession: 'p3' } })

    const persisted = JSON.parse(readFileSync(storePath, 'utf8')) as {
      entries: Array<{ hash: string; owners: unknown[] }>
      sessionParents: Array<[string, string]>
    }
    expect(persisted.entries).toHaveLength(2)
    expect(persisted.sessionParents).toHaveLength(2)
  })
})
