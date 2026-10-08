import type { SessionSeq } from '@deepseek-ai/dsh-session/types'
import { brandNumber } from '@deepseek-ai/dsh-brand'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { AttachmentAdmissionPart, AdmittedPromptContentPart, ImageAttachmentLimits } from '@deepseek-ai/dsh-attachment'
import SessionController from '@deepseek-ai/dsh-api-session-controller'
import { SessionId } from '@deepseek-ai/dsh-session'
import SessionQueryEngine from '@deepseek-ai/dsh-session-query'
import { LlmAdapter, ToolCallId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { scopeTarget } from '@deepseek-ai/dsh-scope'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import ApprovalService, { type ApprovalRequest } from '@deepseek-ai/dsh-user-approval'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PeerService, PEER_CAPABILITIES, PEER_CAPABILITY_LEDGER, PLANNED_PEER_CAPABILITIES } from '../src/host.ts'
import { PeerConfigError, PeerPairingsStore } from '../src/pairings.ts'
import type { PeerCapability, PeerFollowFrame, PeerTarget } from '../src/types.ts'

const contexts: Context[] = []
const roots: string[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const NEVER_ABORTED = new AbortController().signal

const IMAGE_LIMITS: ImageAttachmentLimits = Object.freeze({
  maxImageBytes: 5 * 1024 * 1024,
  maxImagesPerMessage: 20,
  maxMessageImageBytes: 100 * 1024 * 1024,
  maxImagePixels: 40_000_000,
  maxImageDimension: 2000,
  mediaTypes: Object.freeze(['image/png'] as const),
})

class TestSessionQuery extends SessionQueryEngine {
  override searchSessions(): Promise<never> {
    return Promise.reject(new Error('session search is not configured in this test'))
  }

  override searchEvents(): Promise<never> {
    return Promise.reject(new Error('event search is not configured in this test'))
  }
}

/** Scripted model that can hold its stream open so a turn stays live. */
class ScriptedAdapter extends LlmAdapter {
  readonly calls: GenerateOptions[] = []
  private hold = false
  private toolCallNext = false
  private releaseStream: (() => undefined) | undefined
  private started: (() => undefined) | undefined

  /** Make the next stream request one unknown probe tool before answering. */
  callToolOnce(): void {
    this.toolCallNext = true
  }

  /** Hold the next stream until `release()` is called. */
  holdNext(): { started: Promise<undefined>; release: () => undefined } {
    this.hold = true
    const started = Promise.withResolvers<undefined>()
    this.started = () => { started.resolve(undefined) }
    return {
      started: started.promise,
      release: () => {
        this.hold = false
        this.releaseStream?.()
      },
    }
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.calls.push(options)
    if (this.hold) {
      const released = Promise.withResolvers<undefined>()
      this.releaseStream = () => { released.resolve(undefined) }
      this.started?.()
      // Bounded hold: an unreleased stream must not keep a failed spec's fibers alive.
      const timer = setTimeout(() => { released.resolve(undefined) }, 2_000)
      await released.promise
      clearTimeout(timer)
      this.releaseStream = undefined
      this.started = undefined
    }
    if (this.toolCallNext && this.calls.length === 1) {
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id: ToolCallId('probe-1'), name: 'peer_probe', argumentsDelta: '{}' }
      yield {
        type: 'block-end',
        index: 0,
        block: { type: 'tool-call', id: ToolCallId('probe-1'), name: 'peer_probe', arguments: '{}' },
      }
      yield { type: 'usage', usage: { inputTokens: 3, outputTokens: 1 } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    const text = `reply-${String(this.calls.length)}`
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'usage', usage: { inputTokens: 3, outputTokens: 2 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

interface Harness {
  readonly ctx: Context
  readonly peer: PeerService
  readonly adapter: ScriptedAdapter
  readonly root: string
  readonly sessionId: SessionId
  readonly target: PeerTarget
  /** Every selection the deployment default was asked to persist. */
  readonly savedDefaults: Array<{ readonly provider: string; readonly model: string }>
}

async function setup(options: {
  readonly watchdogMs?: number
  readonly exposures?: readonly string[]
  readonly extraAliases?: readonly string[]
} = {}): Promise<Harness> {
  const root = mkdtempSync(join(tmpdir(), 'peer-host-'))
  roots.push(root)
  const pairingsPath = join(root, 'pairings.yaml')
  const bindingsPath = join(root, 'peer-state.json')
  const cwd = join(root, 'work')
  const pairingBlocks = [
    ...(options.exposures ?? ['debug']).map(exposure => [
      `  - alias: ${exposure}`,
      '    peer: laptop',
      '    exposure: ' + exposure,
      '    create:',
      `      cwd: ${cwd}`,
    ]),
    ...(options.extraAliases ?? []).map(alias => [
      `  - alias: ${alias}`,
      '    peer: laptop',
      '    exposure: debug',
      '    create:',
      `      cwd: ${cwd}`,
    ]),
  ]
  writeFileSync(pairingsPath, [
    'version: 1',
    'device: serverlocal',
    'pairings:',
    ...pairingBlocks.flat(),
  ].join('\n'))

  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  const savedDefaults: Array<{ readonly provider: string; readonly model: string }> = []
  ctx.provide('agentDefaultModel', {
    currentSelection: () => ({ provider: 'scripted', model: 'mock' }),
    saveSelection: async (selection: { readonly provider: string; readonly model: string }) => { savedDefaults.push(selection) },
  } as never)
  ctx.provide('attachments', {
    imageLimits: IMAGE_LIMITS,
    admitPromptContent: async (content: readonly AttachmentAdmissionPart[]): Promise<AdmittedPromptContentPart[]> => {
      const admitted: AdmittedPromptContentPart[] = []
      for (const part of content) {
        if (part.type === 'image') throw new Error('test does not configure images')
        admitted.push(part)
      }
      return admitted
    },
  } as never)
  ctx.provide('fileUploads', {
    registerAgentResolver: () => () => {},
    resolve: () => undefined,
    bindPrompt: () => ({ commit: () => {}, [Symbol.dispose]: () => {} }),
    retirePrompt: () => {},
  } as never)
  ctx.provide('typert', {
    lookups: { configure: () => () => {} },
    contexts: { configureHost: () => () => {} },
  } as never)
  new TestSessionQuery(ctx)
  new SessionController(ctx, { listPageSize: 50 }, { wireLogRoot: join(root, 'wire') })
  await ctx.plugin(ApprovalService)
  await mountAgentLoopTestHarness(ctx)
  const peer = new PeerService(ctx, {
    pairingsPath,
    bindingsPath,
    watchdogMs: options.watchdogMs ?? 60_000,
  })
  const adapter = new ScriptedAdapter()
  ctx.llm.registerAdapter(['scripted'], adapter)
  const created = await peer.create({
    alias: 'debug' as never,
    participant: { kind: 'peer', name: 'laptop' },
    cwd,
  })
  if ((options.exposures ?? ['debug']).includes('answer-only')) {
    // Bind the second exposure to the same session through explicit adoption.
    await peer.create({
      alias: 'answer-only' as never,
      participant: { kind: 'peer', name: 'laptop' },
      sessionId: created.target.sessionId,
    })
  }
  return {
    ctx,
    peer,
    adapter,
    root,
    sessionId: created.target.sessionId,
    target: { kind: 'alias', alias: ('debug') as never },
    savedDefaults,
  }
}

async function waitFor(assertion: () => Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await assertion()) return
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error(`condition not met within ${String(timeoutMs)}ms`)
}

/**
 * Drives one follow generation from the test side: a pump keeps a `next()`
 * pending so every frame lands in `frames` and can be awaited by predicate.
 */
class FollowReader {
  readonly frames: PeerFollowFrame[] = []
  private readonly waiters = new Set<() => void>()
  private closed = false
  private failure: unknown

  constructor(private readonly iterator: AsyncIterator<PeerFollowFrame>) {
    void this.pump()
  }

  private async pump(): Promise<void> {
    try {
      for (;;) {
        const result = await this.iterator.next()
        if (result.done === true) break
        this.frames.push(result.value)
        for (const wake of [...this.waiters]) wake()
      }
    } catch (error) {
      this.failure = error
    } finally {
      this.closed = true
      for (const wake of [...this.waiters]) wake()
    }
  }

  async waitFor(
    predicate: (frame: PeerFollowFrame) => boolean,
    options: { readonly from?: number; readonly timeoutMs?: number } = {},
  ): Promise<{ readonly frame: PeerFollowFrame; readonly index: number }> {
    const from = options.from ?? 0
    const deadline = Date.now() + (options.timeoutMs ?? 5_000)
    for (;;) {
      for (let index = from; index < this.frames.length; index += 1) {
        const frame = this.frames[index]!
        if (predicate(frame)) return { frame, index }
      }
      if (this.failure !== undefined) throw this.failure
      if (this.closed) throw new Error('follow ended before the expected frame')
      const remaining = deadline - Date.now()
      if (remaining <= 0) {
        throw new Error(`expected follow frame not observed; saw ${this.frames.map(frame => frame.type).join(',')}`)
      }
      await this.wait(remaining)
    }
  }

  async quiet(ms = 200): Promise<void> {
    const before = this.frames.length
    await new Promise(resolve => setTimeout(resolve, ms))
    if (this.frames.length > before) {
      throw new Error(`unexpected follow frames: ${this.frames.slice(before).map(frame => frame.type).join(',')}`)
    }
  }

  /** Wait until no frame arrives for `idleMs`, absorbing a slow event backlog. */
  async drainIdle(idleMs = 300, maxMs = 5_000): Promise<void> {
    const deadline = Date.now() + maxMs
    for (;;) {
      const before = this.frames.length
      await new Promise(resolve => setTimeout(resolve, idleMs))
      if (this.frames.length === before) return
      if (Date.now() > deadline) throw new Error('follow never went quiet')
    }
  }

  async close(): Promise<void> {
    await this.iterator.return?.()
  }

  private wait(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const wake = (): void => {
        clearTimeout(timer)
        this.waiters.delete(wake)
        resolve()
      }
      const timer = setTimeout(wake, ms)
      this.waiters.add(wake)
    })
  }
}

/** Mint a parked question ask through the scoped waterfall the registry owns. */
function mintQuestionAsk(ctx: Context, agent: Agent): void {
  void ctx.waterfall(
    scopeTarget(agent, agent),
    'user-questions/request',
    {
      agent,
      questions: [{ id: 'colour', question: 'Which colour?', options: [{ label: 'red' }, { label: 'blue' }] }],
    },
    () => new Promise<never>(() => { /* the local answerer parks; the peer answers */ }),
  )
}

async function collectFollow(
  peer: PeerService,
  target: PeerTarget,
  stop: (frames: readonly PeerFollowFrame[]) => boolean,
  timeoutMs = 5_000,
): Promise<PeerFollowFrame[]> {
  const frames: PeerFollowFrame[] = []
  const controller = new AbortController()
  const timer = setTimeout(() => { controller.abort() }, timeoutMs)
  try {
    for await (const frame of peer.follow({ target }, controller.signal)) {
      frames.push(frame)
      if (stop(frames)) break
    }
  } catch (error) {
    if (!controller.signal.aborted) throw error
  } finally {
    clearTimeout(timer)
  }
  return frames
}

describe('peer host service', () => {
  it('fails loud when constructed over a malformed pairing document', () => {
    const root = mkdtempSync(join(tmpdir(), 'peer-bad-config-'))
    roots.push(root)
    const pairingsPath = join(root, 'pairings.yaml')
    writeFileSync(pairingsPath, 'version: 1\ndevice: x\npairings:\n  - alias: y\n    peer: z\n    exposure: debug')
    const ctx = new Context()
    contexts.push(ctx)
    expect(() => new PeerService(ctx, { pairingsPath, bindingsPath: join(root, 'peer-state.json') }))
      .toThrow(PeerConfigError)
  })

  it('never exposes tool or step events at answer-only exposure', async () => {
    const { isExposedEvent } = await import('../src/exposure.ts')
    expect(isExposedEvent('tool/call', { name: 'bash' }, 'answer-only')).toBe(false)
    expect(isExposedEvent('tool/result', {}, 'answer-only')).toBe(false)
    expect(isExposedEvent('step/start', {}, 'answer-only')).toBe(false)
    expect(isExposedEvent('assistant/message', {}, 'answer-only')).toBe(true)
    expect(isExposedEvent('turn/end', { reason: { kind: 'completed' } }, 'answer-only')).toBe(true)
    expect(isExposedEvent('user/message', { source: { kind: 'plugin', plugin: 'x' } }, 'answer-only')).toBe(false)
    expect(isExposedEvent('user/message', { source: { kind: 'user-rpc', rpcId: 'r' } }, 'answer-only')).toBe(true)
    expect(isExposedEvent('tool/call', {}, 'debug')).toBe(true)
  })

  it('accepts a matching handshake and rejects protocol skew', async () => {
    const { peer } = await setup()
    const value = peer.handshake({
      protocolVersion: 1,
      harnessVersion: 'test',
      schemaDigest: 'digest',
      device: 'laptop',
    })
    expect(value.hostDevice).toBe('serverlocal')
    expect(value.capabilities).toContain('state-latch')
    expect(value.pairings[0]).toMatchObject({ alias: 'debug', peer: 'laptop', exposure: 'debug' })
    expect(() => peer.handshake({
      protocolVersion: 9,
      harnessVersion: 'test',
      schemaDigest: 'digest',
      device: 'laptop',
    })).toThrow(RemoteError)
    try {
      peer.handshake({ protocolVersion: 9, harnessVersion: 't', schemaDigest: 'd', device: 'laptop' })
    } catch (error) {
      expect((error as RemoteError).code).toBe('peer/version-skew')
    }
  })

  it('rejects an absent handshake request as bad input instead of failing internally', async () => {
    const { peer } = await setup()
    try {
      peer.handshake(undefined as never)
      expect.unreachable('handshake must reject an absent request')
    } catch (error) {
      expect((error as RemoteError).code).toBe('gateway/bad-request')
      expect((error as RemoteError).message).toContain('handshake requires a request object')
    }
  })

  it('advertises only served capabilities and accounts for every contractual capability', async () => {
    const { peer } = await setup()
    const advertised = peer.handshake({
      protocolVersion: 1,
      harnessVersion: 'test',
      schemaDigest: 'digest',
      device: 'laptop',
    }).capabilities
    const ledger = Object.keys(PEER_CAPABILITY_LEDGER) as PeerCapability[]
    // handshake.capabilities ⊆ the contractual union (the ledger keys are
    // exactly the union: its Record type fails the build on drift).
    for (const capability of advertised) expect(ledger).toContain(capability)
    expect(new Set(advertised)).toEqual(new Set(PEER_CAPABILITIES))
    // Every contractual capability is either served or explicitly planned,
    // exactly once across the two lists.
    const served = ledger.filter(capability => PEER_CAPABILITY_LEDGER[capability] === 'served')
    const planned = ledger.filter(capability => PEER_CAPABILITY_LEDGER[capability] === 'planned')
    expect(new Set(served)).toEqual(new Set(PEER_CAPABILITIES))
    expect(new Set(planned)).toEqual(new Set(PLANNED_PEER_CAPABILITIES))
    expect(new Set([...served, ...planned])).toEqual(new Set(ledger))
    expect([...served, ...planned]).toHaveLength(ledger.length)
    // `assistant-stream` is served by follow() under debug exposure; it must
    // stay advertised or a debug caller cannot know the opt-in exists.
    expect(advertised).toContain('assistant-stream')
  })

  it('lists pairings with bound sessions, latch summaries, and unbound rows', async () => {
    const { peer, sessionId, target } = await setup({ exposures: ['debug', 'answer-only'], extraAliases: ['spare'] })
    const value = peer.list({})
    expect(value.hostDevice).toBe('serverlocal')
    expect(value.pairings.map(row => row.alias)).toEqual(['debug', 'answer-only', 'spare'])
    expect(value.pairings[0]).toMatchObject({
      alias: 'debug',
      peer: 'laptop',
      exposure: 'debug',
      bound: true,
      sessionId,
      latch: 'idle',
      summary: 'idle · no asks',
    })
    // Exposure is reported per pairing and never widened by the listing.
    expect(value.pairings[1]).toMatchObject({ alias: 'answer-only', exposure: 'answer-only', bound: true, sessionId })
    expect(value.pairings[2]).toMatchObject({ alias: 'spare', bound: false, summary: 'not bound to a session' })
    // A resolved target narrows the listing to that one pairing.
    const byTarget = peer.list({ target })
    expect(byTarget.pairings).toHaveLength(1)
    expect(byTarget.pairings[0]?.alias).toBe('debug')
    expect(peer.list({ target: { kind: 'session', sessionId } }).pairings[0]?.alias).toBe('debug')
  })

  it('reports a pending ask in the peer.list summary and last activity', async () => {
    const { peer, ctx, sessionId } = await setup()
    const agent = ctx.agents.get(sessionId) as Agent
    mintQuestionAsk(ctx, agent)
    await waitFor(async () => peer.registry.pendingFor(sessionId).length === 1)
    const row = peer.list({}).pairings[0]!
    expect(row.latch).toBe('waiting_approval')
    expect(row.summary).toContain('1 ask')
    expect(typeof row.lastActivity).toBe('number')
  })

  it('refuses an unpaired list target and maps deeper create failures into peer/not-found', async () => {
    const { peer, ctx } = await setup({ extraAliases: ['spare'] })
    try {
      peer.list({ target: { kind: 'session', sessionId: 'ghost' as never } })
      expect.unreachable('an unpaired list target must be refused')
    } catch (error) {
      expect((error as RemoteError).code).toBe('peer/not-paired')
    }
    const presetFailure = new RemoteError('agent-preset/not-found', 'Unknown agent preset: nope', {
      agentPreset: 'nope',
      available: [],
    })
    vi.spyOn(ctx.sessionController, 'create').mockRejectedValueOnce(presetFailure)
    try {
      await peer.create({ alias: 'spare' as never, participant: { kind: 'peer', name: 'laptop' }, agentPreset: 'nope' })
      expect.unreachable('an unknown preset must fail')
    } catch (error) {
      expect(error).toBeInstanceOf(RemoteError)
      expect((error as RemoteError).code).toBe('peer/not-found')
      expect((error as RemoteError).details).toMatchObject({ alias: 'spare', reason: 'agent-preset/not-found' })
      expect((error as Error & { cause?: unknown }).cause).toBe(presetFailure)
    }
  })

  it('creates, prompts, observes a completed turn, and pages history', async () => {
    const { peer, ctx, sessionId, target } = await setup()
    const bound = JSON.parse(readFileSync(join(peer.pairings.bindingsPath), 'utf8')) as {
      bindings: Record<string, { sessionId: string }>
    }
    expect(bound.bindings.debug?.sessionId).toBe(sessionId)

    const idle = await peer.state({ target })
    expect(idle.state).toMatchObject({
      latch: 'idle',
      source: 'host-latch',
      activeDescendants: 0,
      descendantsExact: true,
    })
    expect(idle.state.model).toMatchObject({ provider: 'scripted', model: 'mock' })

    const collected = collectFollow(peer, target, current => current.some(frame => frame.type === 'event' && frame.record.type === 'turn/end'))
    await peer.prompt({
      target,
      participant: { kind: 'peer', name: 'laptop' },
      requestId: 'req-1' as never,
      content: [{ type: 'text', text: 'do the thing' }],
    }, NEVER_ABORTED)
    const frames = await collected
    await waitFor(async () => (await peer.state({ target })).state.latch === 'idle')
    const done = await peer.state({ target })
    expect(done.state.lastTurnEnd).toMatchObject({ turn: 1, reason: 'completed' })
    expect((await peer.state({ target })).state.lastParticipantAction).toMatchObject({ action: 'prompt' })

    // The prompt was admitted; observe it durably through page from the follow cut.
    const cursor = frames.find(frame => frame.type === 'snapshot')
    expect(cursor?.type).toBe('snapshot')
    const snapshotCursor = (cursor as { cursor: number }).cursor
    const lastEventCursor = frames
      .flatMap(frame => frame.type === 'event' ? [frame.cursor] : [])
      .at(-1) ?? snapshotCursor
    const page = await peer.page({
      target,
      throughSeq: brandNumber<SessionSeq>(lastEventCursor),
      maxMessages: 50,
    }, NEVER_ABORTED)
    expect(page.records.some(record => record.type === 'user/message')).toBe(true)
    expect(page.records.some(record => record.type === 'assistant/message')).toBe(true)

    // Adoption is idempotent and does not create a second session.
    const adopted = await peer.create({
      alias: 'debug' as never,
      participant: { kind: 'peer', name: 'laptop' },
      sessionId,
    })
    expect(adopted.created).toBe(false)
    expect(adopted.target.sessionId).toBe(sessionId)
    void ctx
  })

  it('keeps the previous session addressable after a create rebinds the alias', async () => {
    const { peer, sessionId } = await setup()
    const created = await peer.create({
      alias: 'debug' as never,
      participant: { kind: 'peer', name: 'laptop' },
    })
    expect(created.created).toBe(true)
    expect(created.target.sessionId).not.toBe(sessionId)

    // The alias now resolves to the new session...
    const byAlias = await peer.state({ target: { kind: 'alias', alias: 'debug' as never } })
    expect(byAlias.target.sessionId).toBe(created.target.sessionId)
    // ...while the session it replaced stays observable by explicit id.
    const replaced = await peer.state({ target: { kind: 'session', sessionId } })
    expect(replaced.target.sessionId).toBe(sessionId)
  })

  it('applies create-time routing to that Session only and leaves the default model untouched', async () => {
    const { peer, savedDefaults, sessionId } = await setup({ extraAliases: ['routed'] })
    const before = (await peer.state({ target: { kind: 'session', sessionId } })).state.model
    const created = await peer.create({
      alias: 'routed' as never,
      participant: { kind: 'peer', name: 'laptop' },
      provider: 'scripted',
      model: 'routed',
    })
    expect(created.created).toBe(true)
    expect(created.target.sessionId).not.toBe(sessionId)
    expect(savedDefaults).toEqual([])
    const routed = await peer.state({ target: { kind: 'session', sessionId: created.target.sessionId } })
    expect(routed.state.model).toMatchObject({ provider: 'scripted', model: 'routed' })
    const after = (await peer.state({ target: { kind: 'session', sessionId } })).state.model
    expect(after).toEqual(before)
  })

  it('streams latch transitions and filters tool/step internals from answer-only', async () => {
    const { peer, adapter, target } = await setup({ exposures: ['debug', 'answer-only'] })
    adapter.callToolOnce()
    const quietTarget: PeerTarget = { kind: 'alias', alias: 'answer-only' as never }
    const debugTarget: PeerTarget = { kind: 'alias', alias: 'debug' as never }
    const debugFrames: PeerFollowFrame[] = []
    const quietFrames: PeerFollowFrame[] = []
    const controller = new AbortController()
    const collect = async (streamTarget: PeerTarget, sink: PeerFollowFrame[]): Promise<void> => {
      for await (const frame of peer.follow({ target: streamTarget }, controller.signal)) {
        sink.push(frame)
        if (frame.type === 'event' && frame.record.type === 'turn/end') break
      }
    }
    const debugPromise = collect(debugTarget, debugFrames)
    const quietPromise = collect(quietTarget, quietFrames)
    await peer.prompt({
      target,
      participant: { kind: 'peer', name: 'laptop' },
      requestId: 'req-2' as never,
      content: [{ type: 'text', text: 'stream it' }],
    }, NEVER_ABORTED)
    await Promise.all([debugPromise, quietPromise])
    controller.abort()

    const debugTypes = debugFrames.flatMap(frame => frame.type === 'event' ? [frame.record.type] : [])
    const quietTypes = quietFrames.flatMap(frame => frame.type === 'event' ? [frame.record.type] : [])
    expect(debugTypes).toContain('step/start')
    expect(quietTypes).not.toContain('step/start')
    expect(quietTypes.every(type => !type.startsWith('tool/'))).toBe(true)
    expect(debugTypes.some(type => type.startsWith('tool/'))).toBe(true)
    expect(adapter.calls).toHaveLength(2)
    const stateFrames = debugFrames.filter(frame => frame.type === 'state')
    expect(stateFrames.length).toBeGreaterThan(0)
    expect(debugFrames.filter(frame => frame.type === 'snapshot')).toHaveLength(1)
  })

  it('routes an approval ask to the peer, settles it, and reports a raced answer as conflict', async () => {
    const { peer, ctx, adapter, sessionId, target } = await setup()
    const hold = adapter.holdNext()
    await peer.prompt({
      target,
      participant: { kind: 'peer', name: 'laptop' },
      requestId: 'req-3' as never,
      content: [{ type: 'text', text: 'ask me' }],
    }, NEVER_ABORTED)
    await hold.started
    await waitFor(async () => (await peer.state({ target })).state.latch === 'running')
    // The live host latch is authoritative: the peer reads it verbatim instead
    // of deriving the running state from the durable fold.
    const hostLatched = await peer.state({ target })
    expect(hostLatched.state).toMatchObject({
      latch: 'running',
      source: 'host-latch',
      descendantsExact: true,
      activeDescendants: 0,
    })
    // Stand in for the local browser answerer: it parks until a human decides,
    // which is exactly the window the peer may answer in.
    const localDecision = Promise.withResolvers<ApprovalOutcome>()
    let localAsk: ApprovalRequest | undefined
    ctx.on('approval/request', (request) => {
      localAsk = request
      return localDecision.promise
    })
    const agent = ctx.agents.get(sessionId) as Agent
    const decision = ctx.approval.request({ agent, toolName: 'peer-test', reason: 'unit ask' })
    await waitFor(async () => (await peer.state({ target })).state.latch === 'waiting_approval')
    const waiting = await peer.state({ target })
    expect(waiting.state.pendingAsks).toHaveLength(1)
    expect(waiting.state.pendingAsks[0]).toMatchObject({
      kind: 'approval',
      toolName: 'peer-test',
      reason: 'unit ask',
    })
    const askId = waiting.state.pendingAsks[0]!.askId
    const answered = peer.answer({
      target,
      participant: { kind: 'peer', name: 'laptop' },
      askId,
      answer: { kind: 'approval', outcome: 'allowed-once' },
    })
    expect(answered).toEqual({ accepted: true, settled: true })
    await expect(decision).resolves.toBe('allowed-once')
    // Settle broadcast: the local forwarded ask's lifetime signal aborts as
    // soon as the peer wins, so every other client dismisses its card and a
    // client that attaches later is never offered the settled ask.
    expect(localAsk?.signal?.aborted).toBe(true)
    expect(() => peer.answer({
      target,
      participant: { kind: 'peer', name: 'laptop' },
      askId,
      answer: { kind: 'approval', outcome: 'allowed-once' },
    })).toThrow(RemoteError)
    hold.release()
    await waitFor(async () => (await peer.state({ target })).state.latch === 'idle')
    const finished = await peer.state({ target })
    expect(finished.state.lastTurnEnd).toMatchObject({ turn: 1, reason: 'completed' })
    expect(finished.state.lastParticipantAction).toMatchObject({ action: 'answer' })
  })

  it('cancels a running peer turn and reports idle cancels', async () => {
    const { peer, adapter, target } = await setup()
    const hold = adapter.holdNext()
    await peer.prompt({
      target,
      participant: { kind: 'peer', name: 'laptop' },
      requestId: 'req-4' as never,
      content: [{ type: 'text', text: 'long one' }],
    }, NEVER_ABORTED)
    await hold.started
    await waitFor(async () => (await peer.state({ target })).state.latch !== 'idle')
    expect(peer.cancel({ target, participant: { kind: 'peer', name: 'laptop' } }))
      .toMatchObject({ accepted: true, cancelled: true })
    await waitFor(async () => (await peer.state({ target })).state.latch === 'idle')
    const terminal = await peer.state({ target })
    expect(terminal.state.lastTurnEnd?.reason).toBe('aborted')
    expect(terminal.state.lastParticipantAction).toMatchObject({ action: 'cancel' })
    hold.release()
    expect(peer.cancel({ target, participant: { kind: 'peer', name: 'laptop' } }))
      .toMatchObject({ accepted: true, cancelled: false })
  })

  it('falls back to the derived latch when the host latch is unavailable', async () => {
    const { ctx, peer, target } = await setup()
    const hostLatch = vi.spyOn(ctx.sessionController, 'executionState').mockImplementation(() => {
      throw new Error('session is not attached')
    })
    try {
      const state = await peer.state({ target })
      expect(state.state).toMatchObject({ latch: 'idle', source: 'derived', activeDescendants: 0 })
    } finally {
      hostLatch.mockRestore()
    }
  })

  it('pushes an ask minted mid-tool-call to a follower that started before it', async () => {
    const { peer, ctx, adapter, sessionId, target } = await setup()
    const agent = ctx.agents.get(sessionId) as Agent
    const controller = new AbortController()
    const reader = new FollowReader(peer.follow({ target }, controller.signal)[Symbol.asyncIterator]())
    try {
      await reader.waitFor(frame => frame.type === 'snapshot')
      // A turn runs with its model stream held: no durable event can land while
      // the ask is minted, which is exactly the mid-tool-call window.
      const hold = adapter.holdNext()
      await peer.prompt({
        target,
        participant: { kind: 'peer', name: 'laptop' },
        requestId: 'req-push' as never,
        content: [{ type: 'text', text: 'ask mid-tool' }],
      }, NEVER_ABORTED)
      await hold.started
      await reader.drainIdle()
      const baseline = reader.frames.length
      const mintedAt = Date.now()
      mintQuestionAsk(ctx, agent)
      const pushed = await reader.waitFor(
        frame => frame.type === 'state' && frame.state.pendingAsks.length > 0,
        { from: baseline },
      )
      // Promptly means the registry push, not the next durable event.
      expect(Date.now() - mintedAt).toBeLessThan(1_000)
      expect(reader.frames.slice(baseline, pushed.index + 1).some(frame => frame.type === 'event')).toBe(false)
      if (pushed.frame.type === 'state') {
        expect(pushed.frame.state.pendingAsks[0]).toMatchObject({ kind: 'question', since: expect.any(Number) })
        // A pushed frame carries the last scanned durable position, so repair
        // from any frame cut stays contiguous.
        const priorCursors = reader.frames.slice(0, pushed.index).flatMap(frame =>
          frame.type === 'snapshot' || frame.type === 'event' || frame.type === 'state' ? [frame.cursor as number] : [])
        expect(pushed.frame.cursor).toBe(Math.max(...priorCursors))
      }
      hold.release()
    } finally {
      controller.abort()
      await reader.close()
    }
  })

  it('emits exactly one further state frame when a pushed ask settles', async () => {
    const { peer, ctx, adapter, sessionId, target } = await setup()
    const agent = ctx.agents.get(sessionId) as Agent
    const controller = new AbortController()
    const reader = new FollowReader(peer.follow({ target }, controller.signal)[Symbol.asyncIterator]())
    try {
      await reader.waitFor(frame => frame.type === 'snapshot')
      const hold = adapter.holdNext()
      await peer.prompt({
        target,
        participant: { kind: 'peer', name: 'laptop' },
        requestId: 'req-settle' as never,
        content: [{ type: 'text', text: 'ask then settle' }],
      }, NEVER_ABORTED)
      await hold.started
      await reader.drainIdle()
      const baseline = reader.frames.length
      mintQuestionAsk(ctx, agent)
      const pushed = await reader.waitFor(
        frame => frame.type === 'state' && frame.state.pendingAsks.length > 0,
        { from: baseline },
      )
      const askId = pushed.frame.type === 'state' ? pushed.frame.state.pendingAsks[0]!.askId : undefined
      if (askId === undefined) throw new Error('no pushed ask to settle')
      expect(peer.answer({
        target,
        participant: { kind: 'peer', name: 'laptop' },
        askId,
        answer: { kind: 'question', answer: { answers: [{ id: 'colour', selected: ['blue'] }] } },
      })).toEqual({ accepted: true, settled: true })
      const settled = await reader.waitFor(
        frame => frame.type === 'state' && frame.state.pendingAsks.length === 0,
        { from: pushed.index + 1 },
      )
      const between = reader.frames.slice(pushed.index + 1, settled.index + 1)
      expect(between.filter(frame => frame.type === 'state')).toHaveLength(1)
      expect(between.some(frame => frame.type === 'event')).toBe(false)
      // The raced settle (registry answer then race finally) must not push again.
      await reader.quiet(200)
      hold.release()
    } finally {
      controller.abort()
      await reader.close()
    }
  })

  it('emits no frame when a mint and settle land before the next read', async () => {
    const { peer, ctx, sessionId, target } = await setup()
    const agent = ctx.agents.get(sessionId) as Agent
    const controller = new AbortController()
    const iterator = peer.follow({ target }, controller.signal)[Symbol.asyncIterator]()
    try {
      const snapshot = await iterator.next()
      expect(snapshot.value).toMatchObject({ type: 'snapshot' })
      // The generator is parked at the snapshot yield, so both notifications
      // coalesce into one wake that finds the snapshot's ask set unchanged.
      mintQuestionAsk(ctx, agent)
      await waitFor(async () => peer.registry.pendingFor(sessionId).length === 1)
      const askId = peer.registry.pendingFor(sessionId)[0]!.askId
      expect(peer.answer({
        target,
        participant: { kind: 'peer', name: 'laptop' },
        askId,
        answer: { kind: 'question', answer: { answers: [{ id: 'colour', selected: ['blue'] }] } },
      })).toEqual({ accepted: true, settled: true })
      expect(peer.registry.pendingFor(sessionId)).toHaveLength(0)
      const next = await Promise.race([
        iterator.next(),
        new Promise<'quiet'>(resolve => setTimeout(() => resolve('quiet'), 200)),
      ])
      expect(next).toBe('quiet')
    } finally {
      controller.abort()
      await iterator.return?.()
    }
  })

  it('carries a pre-existing ask in the opening snapshot', async () => {
    const { peer, ctx, sessionId, target } = await setup()
    const agent = ctx.agents.get(sessionId) as Agent
    mintQuestionAsk(ctx, agent)
    await waitFor(async () => peer.registry.pendingFor(sessionId).length === 1)
    const controller = new AbortController()
    const reader = new FollowReader(peer.follow({ target }, controller.signal)[Symbol.asyncIterator]())
    try {
      const snapshot = await reader.waitFor(frame => frame.type === 'snapshot')
      if (snapshot.frame.type !== 'snapshot') throw new Error('no opening snapshot')
      expect(snapshot.frame.state.pendingAsks).toHaveLength(1)
      expect(snapshot.frame.state.pendingAsks[0]).toMatchObject({ kind: 'question' })
    } finally {
      controller.abort()
      await reader.close()
    }
  })

  it('ends the generation with target-detached when the durable stream loses the session', async () => {
    const { ctx, peer, target } = await setup()
    vi.spyOn(ctx.sessionController, 'follow').mockImplementation((() => {
      return (async function* () {
        throw new RemoteError('peer/not-found', 'session gone', {})
      })()
    }) as never)
    const frames: PeerFollowFrame[] = []
    const controller = new AbortController()
    for await (const frame of peer.follow({ target }, controller.signal)) {
      frames.push(frame)
      if (frame.type === 'end') break
    }
    expect(frames.at(-1)).toMatchObject({ type: 'end', reason: 'target-detached' })
  })

  it('rejects unpaired targets and a hop ceiling when configured', async () => {
    const { peer } = await setup()
    await expect(peer.state({ target: { kind: 'session', sessionId: 'nope' as never } }))
      .rejects.toThrow(RemoteError)
    try {
      await peer.state({ target: { kind: 'session', sessionId: 'nope' as never } })
    } catch (error) {
      expect((error as RemoteError).code).toBe('peer/not-paired')
    }
    // No ceiling is configured by default: a high hop count is admitted.
    const { peer: peer2, target: target2 } = await setup()
    const value = await peer2.prompt({
      target: target2,
      participant: { kind: 'peer', name: 'laptop' },
      requestId: 'req-5' as never,
      content: [{ type: 'text', text: 'hop' }],
      hopCount: 500,
    }, NEVER_ABORTED)
    expect(value.hopCount).toBe(501)
    void peer
  })

  it('aborts an orphaned peer turn through the watchdog', async () => {
    const { peer, adapter, target } = await setup({ watchdogMs: 120 })
    const hold = adapter.holdNext()
    await peer.prompt({
      target,
      participant: { kind: 'peer', name: 'laptop' },
      requestId: 'req-6' as never,
      content: [{ type: 'text', text: 'orphan me' }],
    }, NEVER_ABORTED)
    await hold.started
    await waitFor(async () => (await peer.state({ target })).state.latch === 'idle', 5_000)
    const terminal = await peer.state({ target })
    expect(terminal.state.lastTurnEnd?.reason).toBe('aborted')
    hold.release()
  })

  it('re-arms the orphan watchdog when the last follower drops mid-turn', async () => {
    const { peer, adapter, target } = await setup({ watchdogMs: 120 })
    // Attach a follower first, then drop it while the turn runs: the drop must
    // re-arm the watchdog it disarmed on attach, or the turn runs unbounded.
    const controller = new AbortController()
    const iterator = peer.follow({ target }, controller.signal)[Symbol.asyncIterator]()
    await iterator.next()

    const hold = adapter.holdNext()
    await peer.prompt({
      target,
      participant: { kind: 'peer', name: 'laptop' },
      requestId: 'req-drop' as never,
      content: [{ type: 'text', text: 'drop me' }],
    }, NEVER_ABORTED)
    await hold.started
    // Outlive the watchdog armed at prompt admission: it fires while the
    // follower is still attached, sees followers > 0, and disarms itself. Only
    // dropping the follower now must re-arm the watchdog.
    await new Promise(resolve => setTimeout(resolve, 200))
    // Dropping the follower mirrors the caller's `for await` loop leaving on
    // abort: the terminal `end` frame arrives, then `return()` runs the
    // generator's `finally`, which is what releases the follower count.
    controller.abort()
    await iterator.next().catch(() => undefined)
    await iterator.return?.(undefined).catch(() => undefined)

    await waitFor(async () => (await peer.state({ target })).state.latch === 'idle', 5_000)
    expect((await peer.state({ target })).state.lastTurnEnd?.reason).toBe('aborted')
    hold.release()
  })

  it('reloads created-session bindings across a host restart', async () => {
    const { peer, sessionId, target } = await setup()
    await peer.prompt({
      target,
      participant: { kind: 'peer', name: 'laptop' },
      requestId: 'req-7' as never,
      content: [{ type: 'text', text: 'before restart' }],
    }, NEVER_ABORTED)
    // A restart re-reads the machine-written binding document and re-resolves the alias.
    const restarted = new PeerPairingsStore(peer.pairings.pairingsPath, peer.pairings.bindingsPath)
    expect(restarted.resolve(target)?.sessionId).toBe(sessionId)
    void peer
  })
})
