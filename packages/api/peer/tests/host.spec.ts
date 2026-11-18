import type { SessionSeq } from '@deepseek-ai/dsh-session/types'
import { brandNumber } from '@deepseek-ai/dsh-brand'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { AttachmentAdmissionPart, AdmittedPromptContentPart, ImageAttachmentLimits } from '@deepseek-ai/dsh-attachment'
import SessionController from '@deepseek-ai/dsh-api-session-controller'
import { SessionId } from '@deepseek-ai/dsh-session'
import SessionQueryEngine, { type SessionObservationOptions } from '@deepseek-ai/dsh-session-query'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import { LlmAdapter, ToolCallId, type GenerateOptions, type LlmModelInfo, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { scopeTarget } from '@deepseek-ai/dsh-scope'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import ApprovalService, { type ApprovalRequest } from '@deepseek-ai/dsh-user-approval'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PeerService, PEER_CAPABILITIES, PEER_CAPABILITY_LEDGER, PLANNED_PEER_CAPABILITIES } from '../src/host.ts'
import { HARNESS_VERSION } from '../src/version.ts'
import { MODEL_HOP_RECORD_TYPE } from '../src/exposure.ts'
import { PEER_BUDGET_STOP_REASON } from '../src/latch.ts'
import { PeerConfigError, PeerPairingsStore } from '../src/pairings.ts'
import { PeerReceiptStore, receiptKey } from '../src/receipts.ts'
import type {
  PeerCapability,
  PeerEventRecord,
  PeerFollowFrame,
  PeerModelsFilter,
  PeerModelsValue,
  PeerModelSelection,
  PeerRoutingPolicy,
  PeerRoutingService,
  PeerRoutingVerdict,
  PeerTarget,
} from '../src/types.ts'

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
  private readonly toolCallCalls = new Set<number>()
  private readonly holdCalls = new Map<number, () => undefined>()
  private releaseStream: (() => undefined) | undefined
  private started: (() => undefined) | undefined

  /** Make the next stream request one unknown probe tool before answering. */
  callToolOnce(): void {
    this.callToolOn(this.calls.length + 1)
  }

  /** Make the 1-based stream number `call` request one unknown probe tool. */
  callToolOn(call: number): void {
    this.toolCallCalls.add(call)
  }

  /** Hold the 1-based stream number `call` until `release()` is called. */
  holdCall(call: number): { started: Promise<undefined>; release: () => undefined } {
    const started = Promise.withResolvers<undefined>()
    this.holdCalls.set(call, () => { started.resolve(undefined) })
    return {
      started: started.promise,
      release: () => {
        this.holdCalls.delete(call)
        this.releaseStream?.()
      },
    }
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

  /** Routes this adapter advertises; the Session Controller validates switches against them. */
  private readonly catalog: readonly string[] = ['mock', 'routed', 'switched', 'chain-resolved']

  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve(this.catalog.map(id => ({ provider, id, name: id })))
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.calls.push(options)
    const holdMarker = this.holdCalls.get(this.calls.length)
    if (this.hold || holdMarker !== undefined) {
      const released = Promise.withResolvers<undefined>()
      this.releaseStream = () => { released.resolve(undefined) }
      if (holdMarker === undefined) {
        this.started?.()
      } else {
        this.holdCalls.delete(this.calls.length)
        holdMarker()
      }
      // Bounded hold: an unreleased stream must not keep a failed spec's fibers alive.
      const timer = setTimeout(() => { released.resolve(undefined) }, 2_000)
      await released.promise
      clearTimeout(timer)
      this.releaseStream = undefined
      this.started = undefined
    }
    if (this.toolCallCalls.delete(this.calls.length)) {
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

/** Scripted `PeerRoutingService`: records every evaluation and answers by `decision`. */
class FakeRoutingService implements PeerRoutingService {
  readonly evaluations: Array<{ policy: PeerRoutingPolicy; selection: PeerModelSelection }> = []
  readonly discoveries: Array<{
    policy: PeerRoutingPolicy
    request: { filter?: PeerModelsFilter; cursor?: string; limit?: number }
  }> = []
  /** Thrown by the next `evaluate` calls when set, standing in for a service fault. */
  failEvaluate: unknown
  /** Thrown by the next `discover` calls when set, standing in for a service fault. */
  failDiscover: unknown
  decision: (selection: PeerModelSelection) => PeerRoutingVerdict = selection => ({
    allowed: true,
    selection: {
      provider: selection.provider === '' ? 'scripted' : selection.provider,
      model: selection.model === '' ? 'chain-resolved' : selection.model,
      ...(selection.chain === undefined ? {} : { chain: selection.chain }),
      ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }),
    },
  })

  async evaluate(policy: PeerRoutingPolicy, selection: PeerModelSelection): Promise<PeerRoutingVerdict> {
    this.evaluations.push({ policy, selection })
    if (this.failEvaluate !== undefined) throw this.failEvaluate
    return this.decision(selection)
  }

  async discover(
    policy: PeerRoutingPolicy,
    request: { filter?: PeerModelsFilter; cursor?: string; limit?: number },
  ): Promise<{
    chains: PeerModelsValue['chains']
    models: PeerModelsValue['models']
    nextCursor?: string
  }> {
    this.discoveries.push({ policy, request })
    if (this.failDiscover !== undefined) throw this.failDiscover
    return {
      chains: [{
        id: 'free',
        label: 'Free',
        dynamic: true,
        members: [{ provider: 'scripted', model: 'chain-resolved', state: 'ready' }],
      }],
      models: [{
        provider: 'scripted',
        model: 'chain-resolved',
        tools: true,
        vision: false,
        contextWindow: 65_536,
        zeroPrice: true,
        gated: false,
        trainsOnData: 'no',
        reasoningEfforts: ['minimal', 'medium'],
      }],
      ...(request.cursor === 'start' ? { nextCursor: 'more' } : {}),
    }
  }
}

/** Count the durable `model/selection` events in one Session log. */
async function selectionEvents(ctx: Context, sessionId: SessionId): Promise<number> {
  const observation = await ctx.sessionQuery.observeSession(sessionId, { projectionMode: 'none' })
  try {
    return observation.events.filter(event => event.type === 'model/selection').length
  } finally {
    observation[Symbol.dispose]()
  }
}

const ROUTING_BLOCK = [
  '    routing:',
  '      allowChains: [free]',
  '      allowModels: ["scripted/*"]',
  '      requireZeroPrice: true',
  '      allowReasoningEfforts: [minimal, medium]',
  '      allowSwitch: idle-only',
  '      maxTotalTokens: 1000',
]

interface Harness {
  readonly ctx: Context
  readonly peer: PeerService
  readonly adapter: ScriptedAdapter
  readonly root: string
  readonly sessionId: SessionId
  readonly target: PeerTarget
  /** Child fiber owning the PeerService when `peerAsFiber` mounted it. */
  readonly peerFiber?: { dispose: () => Promise<void> }
  /** Every selection the deployment default was asked to persist. */
  readonly savedDefaults: Array<{ readonly provider: string; readonly model: string }>
}

async function setup(options: {
  readonly watchdogMs?: number
  readonly exposures?: readonly string[]
  readonly extraAliases?: readonly string[]
  readonly routingAliases?: readonly string[]
  readonly routingBlocks?: Readonly<Record<string, readonly string[]>>
  readonly routingService?: PeerRoutingService
  readonly receiptsPath?: string
  readonly modelsLimit?: number
  readonly modelsLimitMax?: number
  readonly harnessVersion?: string
  readonly peerAsFiber?: boolean
  /** Set false to mount the peer host without the token-meter/`tokenUsage` seam. */
  readonly meter?: boolean
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
      ...options.routingBlocks?.[alias]
        ?? (options.routingAliases?.includes(alias) === true ? ROUTING_BLOCK : []),
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
  if (options.meter !== false) await ctx.plugin(TokenMeter)
  if (options.routingService !== undefined) ctx.provide('peerRouting', options.routingService)
  const peerConfig = {
    pairingsPath,
    bindingsPath,
    receiptsPath: options.receiptsPath ?? join(root, 'peer-receipts.json'),
    watchdogMs: options.watchdogMs ?? 60_000,
    ...(options.modelsLimit === undefined ? {} : { modelsLimit: options.modelsLimit }),
    ...(options.modelsLimitMax === undefined ? {} : { modelsLimitMax: options.modelsLimitMax }),
    ...(options.harnessVersion === undefined ? {} : { harnessVersion: options.harnessVersion }),
  }
  let peer: PeerService
  let peerFiber: { dispose: () => Promise<void> } | undefined
  if (options.peerAsFiber === true) {
    const mounted = { current: undefined as PeerService | undefined }
    const fiber = ctx.plugin((inner) => { mounted.current = new PeerService(inner, peerConfig) })
    await fiber
    peer = mounted.current!
    peerFiber = fiber
  } else {
    peer = new PeerService(ctx, peerConfig)
  }
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
    ...(peerFiber === undefined ? {} : { peerFiber }),
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

/** Bind one total-token ceiling onto a harness Session by adopting it. */
async function adoptCeiling(peer: PeerService, sessionId: SessionId, maxTotalTokens: number): Promise<void> {
  await peer.create({
    alias: 'debug' as never,
    participant: { kind: 'peer', name: 'laptop' },
    sessionId,
    maxTotalTokens,
  })
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

  it('derives one prose-free model-hop record at every exposure', async () => {
    const { MODEL_HOP_RECORD_TYPE, isDebugOnlyType, isExposedEvent, toPeerRecords } = await import('../src/exposure.ts')
    const source = {
      seq: 9,
      time: 90,
      type: 'llm/attempt-failed',
      data: {
        provider: 'kilo',
        model: 'free-a',
        code: 'RATE_LIMIT',
        message: 'quota exceeded for key sk-live-secret: see https://provider.example/request/9',
        status: 429,
        requestId: 'req-secret-9',
        chain: 'free',
        link: 1,
        next: { provider: 'openrouter', model: 'free-b' },
      },
    }
    const answerOnly = toPeerRecords(source, 'answer-only')
    expect(answerOnly).toHaveLength(1)
    const hop = answerOnly[0]!
    expect(hop.type).toBe(MODEL_HOP_RECORD_TYPE)
    expect(hop.seq).toBe(9)
    expect(hop.time).toBe(90)
    expect(hop.data).toEqual({
      from: { provider: 'kilo', model: 'free-a' },
      to: { provider: 'openrouter', model: 'free-b' },
      reason: 'rate-limit',
      chain: 'free',
      at: 90,
    })
    const serialized = JSON.stringify(hop)
    for (const secret of ['sk-live-secret', 'https://provider.example', 'req-secret-9', 'quota exceeded']) {
      expect(serialized).not.toContain(secret)
    }
    // Debug keeps today's raw record and appends the same-seq synthetic one.
    const debug = toPeerRecords(source, 'debug')
    expect(debug.map(record => record.type)).toEqual(['llm/attempt-failed', MODEL_HOP_RECORD_TYPE])
    expect(debug[0]?.data).toMatchObject({ message: expect.stringContaining('sk-live-secret') as string })
    expect(debug[0]?.seq).toBe(debug[1]?.seq)
    expect(JSON.stringify(debug[1])).not.toContain('sk-live-secret')
    // Other events keep the earlier single-record semantics.
    expect(toPeerRecords({ seq: 1, time: 2, type: 'turn/end', data: {} }, 'answer-only')).toHaveLength(1)
    expect(toPeerRecords({ seq: 1, time: 2, type: 'tool/call', data: {} }, 'answer-only')).toHaveLength(0)
    expect(toPeerRecords({ seq: 1, time: 2, type: 'tool/call', data: {} }, 'debug')).toHaveLength(1)
    // A malformed failure record never fabricates a hop.
    expect(toPeerRecords({ seq: 2, time: 3, type: 'llm/attempt-failed', data: { provider: 'kilo' } }, 'answer-only'))
      .toHaveLength(0)
    expect(toPeerRecords({ seq: 2, time: 3, type: 'llm/attempt-failed', data: { provider: 'kilo' } }, 'debug'))
      .toHaveLength(1)
    // A hop with no chain and no successor still keeps only allow-listed fields.
    const pool = toPeerRecords({
      seq: 10,
      time: 100,
      type: 'llm/attempt-failed',
      data: {
        provider: 'kilo',
        model: 'free-a',
        code: 'AUTH',
        message: 'gate',
        identity: 'one',
        next: { identity: 'two' },
      },
    }, 'answer-only')[0]
    expect(pool?.data).toEqual({
      from: { provider: 'kilo', model: 'free-a' },
      to: { provider: 'kilo', model: 'free-a' },
      reason: 'unavailable',
      at: 100,
    })
    const bare = toPeerRecords({
      seq: 11,
      time: 110,
      type: 'llm/attempt-failed',
      data: { provider: 'kilo', model: 'free-a', code: 'SERVER', message: 'boom' },
    }, 'answer-only')[0]
    expect(bare?.data).toEqual({ from: { provider: 'kilo', model: 'free-a' }, reason: 'error', at: 110 })
    // Recorded-producer variants and the debug-only classifier.
    expect(isExposedEvent('user/message', null, 'answer-only')).toBe(true)
    expect(isExposedEvent('user/message', { source: 'plugin' }, 'answer-only')).toBe(false)
    expect(isExposedEvent('user/message', { source: { kind: 'synthetic' } }, 'answer-only')).toBe(false)
    expect(isDebugOnlyType('tool/call')).toBe(true)
    expect(isDebugOnlyType('user/message')).toBe(true)
    expect(isDebugOnlyType('turn/start')).toBe(false)
  })

  it('streams and pages a model-hop at the source seq in both exposures', async () => {
    const { peer, ctx, sessionId } = await setup({ exposures: ['debug', 'answer-only'] })
    const agent = ctx.agents.get(sessionId) as Agent
    const appended = agent.session.append('llm/attempt-failed', {
      provider: 'kilo',
      model: 'free-a',
      code: 'RATE_LIMIT',
      message: 'provider prose https://kilo.example/429 for key sk-secret',
      status: 429,
      requestId: 'req-123',
      chain: 'free',
      link: 1,
      next: { provider: 'openrouter', model: 'free-b' },
    }, { ignorable: true })
    const answerOnly: PeerTarget = { kind: 'alias', alias: 'answer-only' as never }
    const debugTarget: PeerTarget = { kind: 'alias', alias: 'debug' as never }
    const recordsOf = (frames: readonly PeerFollowFrame[]): PeerEventRecord[] =>
      frames.flatMap(frame => frame.type === 'event'
        ? [frame.record]
        : frame.type === 'snapshot' ? [...frame.records] : [])
    const hasHop = (frames: readonly PeerFollowFrame[]): boolean =>
      frames.some(frame => frame.type === 'event'
        ? frame.record.type === MODEL_HOP_RECORD_TYPE
        : frame.type === 'snapshot' && frame.records.some(record => record.type === MODEL_HOP_RECORD_TYPE))

    const answerFrames = await collectFollow(peer, answerOnly, hasHop)
    const answerHops = recordsOf(answerFrames).filter(record => record.type === MODEL_HOP_RECORD_TYPE)
    expect(answerHops).toHaveLength(1)
    expect(answerHops[0]?.seq).toBe(appended.seq)
    expect(JSON.stringify(answerHops[0])).not.toContain('sk-secret')
    expect(recordsOf(answerFrames).some(record => record.type === 'llm/attempt-failed')).toBe(false)

    // The default alias is debug: raw record first, then the synthetic hop.
    const debugFrames = await collectFollow(peer, debugTarget, hasHop)
    const debugRecords = recordsOf(debugFrames)
    const rawIndex = debugRecords.findIndex(record => record.type === 'llm/attempt-failed')
    const hopIndex = debugRecords.findIndex(record => record.type === MODEL_HOP_RECORD_TYPE)
    expect(rawIndex).toBeGreaterThanOrEqual(0)
    expect(hopIndex).toBe(rawIndex + 1)
    expect(debugRecords[rawIndex]?.seq).toBe(appended.seq)
    expect(debugRecords[hopIndex]?.seq).toBe(appended.seq)

    // `peer.page` derives the same records from the same durable position.
    const cut = brandNumber<SessionSeq>(appended.seq)
    const pagedAnswer = await peer.page({ target: answerOnly, throughSeq: cut }, NEVER_ABORTED)
    const pagedHops = pagedAnswer.records.filter(record => record.type === MODEL_HOP_RECORD_TYPE)
    expect(pagedHops).toHaveLength(1)
    expect(pagedHops[0]?.seq).toBe(appended.seq)
    expect(pagedHops[0]).toEqual(answerHops[0])
    expect(JSON.stringify(pagedHops[0])).not.toContain('sk-secret')
    const pagedDebug = await peer.page({ target: debugTarget, throughSeq: cut }, NEVER_ABORTED)
    expect(pagedDebug.records.map(record => record.type)).toEqual(['llm/attempt-failed', MODEL_HOP_RECORD_TYPE])

    // Live stream: one durable event yields the raw record and its hop under
    // the same durable cursor, and continuity keeps advancing by one event.
    const controller = new AbortController()
    const reader = new FollowReader(peer.follow({ target: debugTarget }, controller.signal)[Symbol.asyncIterator]())
    try {
      await reader.waitFor(frame => frame.type === 'snapshot')
      const live = agent.session.append('llm/attempt-failed', {
        provider: 'openrouter',
        model: 'free-b',
        code: 'SERVER',
        message: 'second provider prose https://kilo.example/500',
        chain: 'free',
        link: 2,
        next: { provider: 'kilo', model: 'free-c' },
      }, { ignorable: true })
      const hopFrame = await reader.waitFor(frame => frame.type === 'event' && frame.record.type === MODEL_HOP_RECORD_TYPE)
      expect(hopFrame.frame).toMatchObject({ type: 'event', cursor: live.seq, record: { seq: live.seq } })
      const rawFrame = reader.frames[hopFrame.index - 1]
      expect(rawFrame).toMatchObject({ type: 'event', cursor: live.seq, record: { type: 'llm/attempt-failed', seq: live.seq } })
    } finally {
      // Abort first: the generator is parked on a durable next(), so its
      // return() only settles once the signal wakes the race.
      controller.abort()
      await reader.close()
    }

    // The state fold exposes the same bounded hop window.
    const state = (await peer.state({ target: answerOnly })).state
    expect(state.recentModelHops).toHaveLength(2)
    expect(state.recentModelHops?.[0]).toMatchObject({ from: { provider: 'kilo' }, reason: 'rate-limit' })
    expect(state.recentModelHops?.[1]).toMatchObject({ from: { provider: 'openrouter' }, reason: 'error' })
    expect(state.lastTurnEnd).toBeUndefined()
  })

  it('reports session token totals and a ceiling budget from the projections', async () => {
    const { peer, target, sessionId } = await setup()
    const collected = collectFollow(peer, target, frames => frames.some(
      frame => frame.type === 'event' && frame.record.type === 'turn/end',
    ))
    await peer.prompt({
      target,
      participant: { kind: 'peer', name: 'laptop' },
      requestId: 'req-usage' as never,
      content: [{ type: 'text', text: 'count me' }],
    }, NEVER_ABORTED)
    await collected
    await waitFor(async () => (await peer.state({ target })).state.latch === 'idle')
    const state = (await peer.state({ target })).state
    expect(state.usage).toEqual({ inputTokens: 3, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 })
    expect(state.budget).toBeUndefined()
    expect(state.lastTurnEnd?.ran).toMatchObject({ provider: 'scripted', model: 'mock', hops: 0 })

    // Re-adopting the same Session with a ceiling records it on the binding;
    // `state.budget` then reports the projection totals against it.
    await peer.create({
      alias: 'debug' as never,
      participant: { kind: 'peer', name: 'laptop' },
      sessionId,
      maxTotalTokens: 5,
    })
    const capped = (await peer.state({ target })).state
    expect(capped.budget).toEqual({ maxTotalTokens: 5, usedTokens: 5, exceeded: true, metered: true })
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
    expect(value.harnessVersion).toBe(HARNESS_VERSION)
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

  it('reports a configured harness version over the manifest default', async () => {
    const { peer } = await setup({ harnessVersion: '2.0.0-test' })
    expect(peer.handshake({
      protocolVersion: 1,
      harnessVersion: 'caller',
      schemaDigest: 'digest',
      device: 'laptop',
    }).harnessVersion).toBe('2.0.0-test')
  })

  it('warns once when a pairing reload keeps the previous snapshot', async () => {
    const { ctx, peer, root, target } = await setup()
    const warnings: unknown[][] = []
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation((...args: unknown[]) => { warnings.push(args) })
    const pairingsPath = join(root, 'pairings.yaml')
    writeFileSync(pairingsPath, 'version: 1\ndevice: serverlocal\npairings:\n  - alias: [unclosed\n    peer: secret-value')
    // The reload keeps the last valid table, so the alias still resolves.
    expect((await peer.state({ target })).state.latch).toBe('idle')
    expect(warnings).toHaveLength(1)
    expect(String(warnings[0]?.[0])).toContain('pairings reload rejected; previous snapshot kept')
    expect(String(warnings[0]?.[0])).not.toContain('secret-value')
    // A second rejected reload with the same diagnostic stays silent.
    writeFileSync(pairingsPath, `version: 1\ndevice: serverlocal\npairings:\n  - alias: [unclosed\n    peer: secret-value\n# ${'x'.repeat(64)}`)
    expect((await peer.state({ target })).state.latch).toBe('idle')
    expect(warnings).toHaveLength(1)
    warn.mockRestore()
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
    const routingCapabilities: readonly PeerCapability[] = [
      'model-discovery',
      'model-routing-at-create',
      'model-switch',
    ]
    const usageCapabilities: readonly PeerCapability[] = ['token-ceiling']
    const { peer } = await setup()
    const handshake = (target: PeerService): readonly PeerCapability[] => target.handshake({
      protocolVersion: 1,
      harnessVersion: 'test',
      schemaDigest: 'digest',
      device: 'laptop',
    }).capabilities
    const advertised = handshake(peer)
    const ledger = Object.keys(PEER_CAPABILITY_LEDGER) as PeerCapability[]
    // handshake.capabilities ⊆ the contractual union (the ledger keys are
    // exactly the union: its Record type fails the build on drift).
    for (const capability of advertised) expect(ledger).toContain(capability)
    // Without a mounted routing service the routing trio is not served, so it
    // must not be advertised; the rest of the build's capabilities are, and
    // this host mounts the token meter.
    expect(new Set(advertised)).toEqual(new Set(
      PEER_CAPABILITIES.filter(capability => !routingCapabilities.includes(capability)),
    ))
    for (const capability of routingCapabilities) expect(advertised).not.toContain(capability)
    // The same build advertises the routing trio once the seam is mounted.
    const routed = await setup({ routingService: new FakeRoutingService() })
    expect(new Set(handshake(routed.peer))).toEqual(new Set(PEER_CAPABILITIES))
    // Without the usage seam both the routing trio and token-ceiling are
    // withheld: nothing may promise a guard this host cannot read.
    const unmetered = await setup({ meter: false })
    const unmeteredCaps = handshake(unmetered.peer)
    expect(new Set(unmeteredCaps)).toEqual(new Set(PEER_CAPABILITIES.filter(capability =>
      !routingCapabilities.includes(capability) && !usageCapabilities.includes(capability))))
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
    // The accounting members this build gained are served too on a metered host.
    for (const capability of ['token-ceiling', 'model-attribution'] as const) {
      expect(advertised).toContain(capability)
    }
  })

  it('refuses a token ceiling on a host without the usage seam before any session exists', async () => {
    const routing = new FakeRoutingService()
    const { ctx, peer } = await setup({
      meter: false,
      extraAliases: ['spare', 'routed'],
      routingAliases: ['routed'],
      routingService: routing,
    })
    const participant = { kind: 'peer', name: 'laptop' } as const
    const createSpy = vi.spyOn(ctx.sessionController, 'create')
    // A legacy pairing (no routing policy) still refuses the explicit ceiling.
    await expect(peer.create({
      alias: 'spare' as never,
      participant,
      maxTotalTokens: 10,
    })).rejects.toMatchObject({
      code: 'peer/forbidden',
      details: { reason: 'budget-unmetered', denied: '10' },
    })
    // A policy ceiling is a create-time ceiling too: an omitted request value
    // would be capped to it, which the host cannot enforce without usage.
    await expect(peer.create({
      alias: 'routed' as never,
      participant,
      provider: 'scripted',
      model: 'routed',
    })).rejects.toMatchObject({
      code: 'peer/forbidden',
      details: { reason: 'budget-unmetered', denied: '1000' },
    })
    // Policy evaluation ran first, but no session was created.
    expect(routing.evaluations).toHaveLength(1)
    expect(createSpy).not.toHaveBeenCalled()
  })

  it('reports an unreadable usage projection as unmetered and lets the turn spend', async () => {
    const { ctx, peer, sessionId, target } = await setup({ meter: false })
    const participant = { kind: 'peer', name: 'laptop' } as const
    // A binding written by a metered host can still be present after a restart
    // into a host without the projection; the state must say so honestly.
    await peer.pairings.bind('debug' as never, 'laptop', sessionId, { maxTotalTokens: 2 })
    const before = (await peer.state({ target })).state
    expect(before.usage).toBeUndefined()
    expect(before.budget).toEqual({
      maxTotalTokens: 2,
      usedTokens: 0,
      exceeded: false,
      metered: false,
    })
    const cancelSpy = vi.spyOn(ctx.agents.get(sessionId)!, 'cancel')
    // The prompt gate falls through because unreadable usage is never
    // `exceeded`, and the watcher has nothing to enforce.
    await peer.prompt({
      target,
      participant,
      requestId: 'req-unmetered' as never,
      content: [{ type: 'text', text: 'spend without a meter' }],
    }, NEVER_ABORTED)
    await waitFor(async () => (await peer.state({ target })).state.latch === 'idle')
    const after = (await peer.state({ target })).state
    expect(cancelSpy).not.toHaveBeenCalled()
    expect(after.usage).toBeUndefined()
    expect(after.budget).toEqual({
      maxTotalTokens: 2,
      usedTokens: 0,
      exceeded: false,
      metered: false,
    })
    expect(after.lastTurnEnd).toMatchObject({ reason: 'completed' })
    expect(after.lastTurnEnd?.stop).toBeUndefined()
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

  it('creates a routed session under the policy and persists the capped ceiling', async () => {
    const routing = new FakeRoutingService()
    const { peer, savedDefaults, sessionId } = await setup({
      extraAliases: ['routed'],
      routingAliases: ['routed'],
      routingService: routing,
    })
    const created = await peer.create({
      alias: 'routed' as never,
      participant: { kind: 'peer', name: 'laptop' },
      provider: 'scripted',
      model: 'routed',
      maxTotalTokens: 400,
    })
    expect(created.created).toBe(true)
    expect(routing.evaluations).toHaveLength(1)
    expect(routing.evaluations[0]?.selection).toEqual({ provider: 'scripted', model: 'routed' })
    // The selection applies to this Session only; the deployment default never moves.
    expect(savedDefaults).toEqual([])
    expect(peer.ceilingOf(created.target.sessionId)).toBe(400)
    expect(peer.ceilingOf(sessionId)).toBeUndefined()
    const state = await peer.state({ target: { kind: 'session', sessionId: created.target.sessionId } })
    expect(state.state.model).toMatchObject({ provider: 'scripted', model: 'routed' })
    const bindings = JSON.parse(readFileSync(peer.pairings.bindingsPath, 'utf8')) as {
      bindings: Record<string, { sessionId: string; maxTotalTokens?: number }>
    }
    expect(bindings.bindings.routed?.maxTotalTokens).toBe(400)
  })

  it('refuses a routing-pairing create that names no route before creating a session', async () => {
    const routing = new FakeRoutingService()
    const { peer, ctx } = await setup({
      extraAliases: ['routed'],
      routingAliases: ['routed'],
      routingService: routing,
    })
    const createSpy = vi.spyOn(ctx.sessionController, 'create')
    try {
      await peer.create({ alias: 'routed' as never, participant: { kind: 'peer', name: 'laptop' } })
      expect.unreachable('a routing pairing must require an explicit route')
    } catch (error) {
      expect((error as RemoteError).code).toBe('peer/forbidden')
      expect((error as RemoteError).details).toEqual({ reason: 'routing-required' })
    }
    expect(createSpy).not.toHaveBeenCalled()
    expect(routing.evaluations).toHaveLength(0)
    expect(peer.list({}).pairings.find(row => row.alias === 'routed')).toMatchObject({ bound: false })
  })

  it('refuses a paid model by policy name before any session or selection exists', async () => {
    const routing = new FakeRoutingService()
    routing.decision = () => ({ allowed: false, reason: 'model-not-allowed', denied: 'openai/gpt-5' })
    const { peer, ctx, sessionId } = await setup({
      extraAliases: ['routed'],
      routingAliases: ['routed'],
      routingService: routing,
    })
    const createSpy = vi.spyOn(ctx.sessionController, 'create')
    const selectSpy = vi.spyOn(ctx.sessionController, 'selectModel')
    const baseline = await selectionEvents(ctx, sessionId)
    try {
      await peer.create({
        alias: 'routed' as never,
        participant: { kind: 'peer', name: 'laptop' },
        provider: 'openai',
        model: 'gpt-5',
      })
      expect.unreachable('a denied model must refuse the create')
    } catch (error) {
      expect((error as RemoteError).code).toBe('peer/forbidden')
      expect((error as RemoteError).details).toEqual({ reason: 'model-not-allowed', denied: 'openai/gpt-5' })
      // `denied` is the offending identifier, never the allow list.
      expect(JSON.stringify((error as RemoteError).details)).not.toContain('scripted/*')
    }
    expect(createSpy).not.toHaveBeenCalled()
    expect(selectSpy).not.toHaveBeenCalled()
    expect(await selectionEvents(ctx, sessionId)).toBe(baseline)
    expect(peer.list({}).pairings.find(row => row.alias === 'routed')).toMatchObject({ bound: false })
  })

  it('caps an omitted ceiling to the policy and refuses one above it', async () => {
    const routing = new FakeRoutingService()
    const { peer, ctx } = await setup({
      extraAliases: ['routed'],
      routingAliases: ['routed'],
      routingService: routing,
    })
    const capped = await peer.create({
      alias: 'routed' as never,
      participant: { kind: 'peer', name: 'laptop' },
      provider: 'scripted',
      model: 'routed',
    })
    expect(peer.ceilingOf(capped.target.sessionId)).toBe(1000)
    const createSpy = vi.spyOn(ctx.sessionController, 'create')
    try {
      await peer.create({
        alias: 'routed' as never,
        participant: { kind: 'peer', name: 'laptop' },
        provider: 'scripted',
        model: 'routed',
        maxTotalTokens: 1001,
      })
      expect.unreachable('a ceiling above the policy must refuse')
    } catch (error) {
      expect((error as RemoteError).code).toBe('peer/forbidden')
      expect((error as RemoteError).details).toEqual({ reason: 'budget', denied: '1001' })
    }
    expect(createSpy).not.toHaveBeenCalled()
  })

  it.each([0, -5, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'refuses a malformed token ceiling of %s before any session exists',
    async (maxTotalTokens) => {
      const routing = new FakeRoutingService()
      const { peer, ctx } = await setup({
        extraAliases: ['routed'],
        routingAliases: ['routed'],
        routingService: routing,
      })
      const createSpy = vi.spyOn(ctx.sessionController, 'create')
      await expect(peer.create({
        alias: 'routed' as never,
        participant: { kind: 'peer', name: 'laptop' },
        provider: 'scripted',
        model: 'routed',
        maxTotalTokens,
      })).rejects.toMatchObject({ code: 'gateway/bad-request' })
      expect(createSpy).not.toHaveBeenCalled()
    },
  )

  it('resolves a chain-only create through the verdict selection', async () => {
    const routing = new FakeRoutingService()
    const { peer } = await setup({
      extraAliases: ['routed'],
      routingAliases: ['routed'],
      routingService: routing,
    })
    const created = await peer.create({
      alias: 'routed' as never,
      participant: { kind: 'peer', name: 'laptop' },
      chain: 'free',
    })
    // The host asked about the chain alone and applied the resolved selection.
    expect(routing.evaluations[0]?.selection).toEqual({ provider: '', model: '', chain: 'free' })
    const state = await peer.state({ target: { kind: 'session', sessionId: created.target.sessionId } })
    expect(state.state.model).toMatchObject({
      provider: 'scripted',
      model: 'chain-resolved',
      chain: 'free',
    })
  })

  it('adopts under a routing pairing and ignores legacy allowModelChange', async () => {
    const routing = new FakeRoutingService()
    const { peer, sessionId } = await setup({
      extraAliases: ['routed'],
      routingAliases: ['routed'],
      routingService: routing,
    })
    const adopted = await peer.create({
      alias: 'routed' as never,
      participant: { kind: 'peer', name: 'laptop' },
      sessionId,
      provider: 'scripted',
      model: 'switched',
    })
    expect(adopted.created).toBe(false)
    expect(adopted.target.sessionId).toBe(sessionId)
    const state = await peer.state({ target: { kind: 'alias', alias: 'routed' as never } })
    expect(state.state.model).toMatchObject({ provider: 'scripted', model: 'switched' })
  })

  it('fails closed when a routing pairing has no mounted routing service', async () => {
    const { peer, ctx, sessionId } = await setup({ extraAliases: ['routed'], routingAliases: ['routed'] })
    const createSpy = vi.spyOn(ctx.sessionController, 'create')
    try {
      await peer.create({
        alias: 'routed' as never,
        participant: { kind: 'peer', name: 'laptop' },
        provider: 'scripted',
        model: 'routed',
      })
      expect.unreachable('a routing pairing must fail closed without a routing service')
    } catch (error) {
      expect((error as RemoteError).code).toBe('peer/forbidden')
      expect((error as RemoteError).details).toEqual({ reason: 'routing-unavailable' })
    }
    expect(createSpy).not.toHaveBeenCalled()
    await expect(peer.models({
      alias: 'routed' as never,
      participant: { kind: 'peer', name: 'laptop' },
    })).rejects.toMatchObject({ code: 'peer/forbidden', details: { reason: 'routing-unavailable' } })
    // Bind the session to the routed alias so the switch reaches the policy gate.
    await peer.pairings.bind('routed' as never, 'laptop', sessionId)
    await expect(peer.selectModel({
      target: { kind: 'alias', alias: 'routed' as never },
      participant: { kind: 'peer', name: 'laptop' },
      requestId: 'sw-unavailable' as never,
      provider: 'scripted',
      model: 'switched',
    })).rejects.toMatchObject({ code: 'peer/forbidden', details: { reason: 'routing-unavailable' } })
    const capabilities = peer.handshake({
      protocolVersion: 1,
      harnessVersion: 'test',
      schemaDigest: 'digest',
      device: 'laptop',
    }).capabilities
    expect(capabilities).not.toContain('model-discovery')
    expect(capabilities).not.toContain('model-switch')
    expect(capabilities).not.toContain('model-routing-at-create')
  })

  it('passes discovery through the routing service and clamps the page limit', async () => {
    const routing = new FakeRoutingService()
    const { peer } = await setup({
      extraAliases: ['routed'],
      routingAliases: ['routed'],
      routingService: routing,
      modelsLimit: 30,
      modelsLimitMax: 60,
    })
    const value = await peer.models({
      alias: 'routed' as never,
      participant: { kind: 'peer', name: 'laptop' },
      filter: { zeroPrice: true, tools: true, minContextWindow: 1000 },
      cursor: 'start',
      limit: 1000,
    })
    expect(routing.discoveries[0]?.request).toEqual({
      filter: { zeroPrice: true, tools: true, minContextWindow: 1000 },
      cursor: 'start',
      limit: 60,
    })
    expect(value.nextCursor).toBe('more')
    expect(value.chains[0]).toMatchObject({ id: 'free', dynamic: true })
    expect(value.models[0]).toMatchObject({ provider: 'scripted', model: 'chain-resolved', zeroPrice: true })
    expect(value.selectableByThisAlias).toEqual({
      chains: ['free'],
      models: ['scripted/*'],
      reasoningEfforts: ['minimal', 'medium'],
      requireZeroPrice: true,
      requireNoTraining: false,
      requireTools: false,
      allowSwitch: 'idle-only',
    })
    // An absent limit uses the configured default; an invalid one is clamped.
    await peer.models({ alias: 'routed' as never, participant: { kind: 'peer', name: 'laptop' } })
    expect(routing.discoveries[1]?.request.limit).toBe(30)
    await peer.models({ alias: 'routed' as never, participant: { kind: 'peer', name: 'laptop' }, limit: -5 })
    expect(routing.discoveries[2]?.request.limit).toBe(30)
  })

  it('maps routing service throws into the peer vocabulary without leaking internals', async () => {
    const routing = new FakeRoutingService()
    const participant = { kind: 'peer', name: 'laptop' } as const
    const { ctx, peer, sessionId } = await setup({
      extraAliases: ['routed'],
      routingAliases: ['routed'],
      routingService: routing,
    })
    // The engine's cursor refusal has caller meaning and becomes a clean input error.
    routing.failDiscover = new Error('invalid cursor')
    await expect(peer.models({ alias: 'routed' as never, participant })).rejects.toMatchObject({
      code: 'gateway/bad-request',
      message: 'invalid cursor',
    })
    // Any other throw is a service fault: fail closed, fixed message, no stack.
    const secret = 'postgres://catalogue:secret@catalogue.internal/rows'
    routing.failDiscover = new Error(secret)
    const modelError = await peer.models({ alias: 'routed' as never, participant }).catch((error: unknown) => error)
    expect(modelError).toBeInstanceOf(RemoteError)
    expect(modelError).toMatchObject({
      code: 'peer/forbidden',
      message: 'the model routing service failed on this host',
      details: { reason: 'routing-unavailable' },
    })
    expect((modelError as RemoteError).message).not.toContain('secret')
    expect((modelError as RemoteError).cause).toBeUndefined()
    // A non-Error throw maps the same way.
    routing.failDiscover = 'catalogue exploded'
    await expect(peer.models({ alias: 'routed' as never, participant })).rejects.toMatchObject({
      code: 'peer/forbidden',
      details: { reason: 'routing-unavailable' },
    })

    // A throwing evaluation is a create refusal before any session exists.
    routing.failEvaluate = new Error(`${secret} at /home/operator/catalogue.ts:42`)
    const createSpy = vi.spyOn(ctx.sessionController, 'create')
    await expect(peer.create({
      alias: 'routed' as never,
      participant,
      provider: 'scripted',
      model: 'routed',
    })).rejects.toMatchObject({
      code: 'peer/forbidden',
      details: { reason: 'routing-unavailable' },
    })
    expect(createSpy).not.toHaveBeenCalled()
    // The same mapping covers an idle switch.
    await peer.pairings.bind('routed' as never, 'laptop', sessionId)
    await expect(peer.selectModel({
      target: { kind: 'alias', alias: 'routed' as never },
      participant,
      requestId: 'sw-throwing' as never,
      provider: 'scripted',
      model: 'routed',
    })).rejects.toMatchObject({
      code: 'peer/forbidden',
      details: { reason: 'routing-unavailable' },
    })
  })

  it('refuses discovery for an unpaired alias or a pairing without routing', async () => {
    const { peer } = await setup()
    const participant = { kind: 'peer', name: 'laptop' } as const
    await expect(peer.models({ alias: 'ghost' as never, participant }))
      .rejects.toMatchObject({ code: 'peer/not-paired' })
    await expect(peer.models({ alias: 'debug' as never, participant }))
      .rejects.toMatchObject({ code: 'peer/forbidden', details: { reason: 'routing-not-configured' } })
  })

  it('switches an idle routed session and reports the actor and both selections', async () => {
    const routing = new FakeRoutingService()
    const { peer, ctx } = await setup({
      extraAliases: ['routed'],
      routingAliases: ['routed'],
      routingService: routing,
    })
    const created = await peer.create({
      alias: 'routed' as never,
      participant: { kind: 'peer', name: 'laptop' },
      provider: 'scripted',
      model: 'routed',
    })
    const target: PeerTarget = { kind: 'alias', alias: 'routed' as never }
    const baseline = await selectionEvents(ctx, created.target.sessionId)
    const value = await peer.selectModel({
      target,
      participant: { kind: 'peer', name: 'laptop' },
      requestId: 'sw-1' as never,
      provider: 'scripted',
      model: 'switched',
    })
    expect(value).toEqual({
      accepted: true,
      selected: { provider: 'scripted', model: 'switched' },
      previous: { provider: 'scripted', model: 'routed' },
      replayed: false,
    })
    expect(await selectionEvents(ctx, created.target.sessionId)).toBe(baseline + 1)
    const state = await peer.state({ target })
    expect(state.state.model).toMatchObject({ provider: 'scripted', model: 'switched' })
    expect(state.state.lastParticipantAction).toMatchObject({
      action: 'model-change',
      actor: { kind: 'peer', name: 'laptop' },
      detail: 'scripted/switched',
    })
    expect(statSync(peer.receipts.path).mode & 0o777).toBe(0o600)
  })

  it('replays a switch by request id and refuses a changed payload', async () => {
    const routing = new FakeRoutingService()
    const { peer, ctx } = await setup({
      extraAliases: ['routed'],
      routingAliases: ['routed'],
      routingService: routing,
    })
    const created = await peer.create({
      alias: 'routed' as never,
      participant: { kind: 'peer', name: 'laptop' },
      provider: 'scripted',
      model: 'routed',
    })
    const target: PeerTarget = { kind: 'alias', alias: 'routed' as never }
    const request = {
      target,
      participant: { kind: 'peer', name: 'laptop' } as const,
      requestId: 'sw-replay' as never,
      provider: 'scripted',
      model: 'switched',
    }
    const first = await peer.selectModel(request)
    const baseline = await selectionEvents(ctx, created.target.sessionId)
    const replayed = await peer.selectModel(request)
    expect(replayed).toEqual({ ...first, replayed: true })
    expect(await selectionEvents(ctx, created.target.sessionId)).toBe(baseline)
    await expect(peer.selectModel({ ...request, model: 'mock' }))
      .rejects.toMatchObject({ code: 'peer/conflict', details: { reason: 'request-id-reuse' } })
    expect(await selectionEvents(ctx, created.target.sessionId)).toBe(baseline)
    // A receipt survives a fresh store over the same document.
    const restarted = new PeerReceiptStore(peer.receipts.path, 512)
    expect(restarted.get(receiptKey(created.target.sessionId, 'sw-replay'))?.value.selected)
      .toMatchObject({ provider: 'scripted', model: 'switched' })
  })

  it('refuses a switch while the session is running or waiting on an approval', async () => {
    const routing = new FakeRoutingService()
    const { peer, ctx, adapter } = await setup({
      extraAliases: ['routed'],
      routingAliases: ['routed'],
      routingService: routing,
    })
    const created = await peer.create({
      alias: 'routed' as never,
      participant: { kind: 'peer', name: 'laptop' },
      provider: 'scripted',
      model: 'routed',
    })
    const target: PeerTarget = { kind: 'alias', alias: 'routed' as never }
    const switchRequest = {
      target,
      participant: { kind: 'peer', name: 'laptop' } as const,
      requestId: 'sw-busy' as never,
      provider: 'scripted',
      model: 'switched',
    }
    const hold = adapter.holdNext()
    await peer.prompt({
      target,
      participant: { kind: 'peer', name: 'laptop' },
      requestId: 'req-switch-busy' as never,
      content: [{ type: 'text', text: 'hold the turn' }],
    }, NEVER_ABORTED)
    await hold.started
    await waitFor(async () => (await peer.state({ target })).state.latch === 'running')
    await expect(peer.selectModel(switchRequest))
      .rejects.toMatchObject({ code: 'peer/conflict', details: { reason: 'busy', latch: 'running' } })

    const decision = Promise.withResolvers<ApprovalOutcome>()
    ctx.on('approval/request', () => decision.promise)
    const agent = ctx.agents.get(created.target.sessionId) as Agent
    const pending = ctx.approval.request({ agent, toolName: 'peer-switch', reason: 'busy check' })
    await waitFor(async () => (await peer.state({ target })).state.latch === 'waiting_approval')
    await expect(peer.selectModel({ ...switchRequest, requestId: 'sw-waiting' as never }))
      .rejects.toMatchObject({ code: 'peer/conflict', details: { reason: 'busy', latch: 'waiting_approval' } })
    decision.resolve('rejected')
    await pending.catch(() => undefined)
    hold.release()
    await waitFor(async () => (await peer.state({ target })).state.latch === 'idle')
  })

  it('refuses a switch when the policy default disallows it', async () => {
    const routing = new FakeRoutingService()
    const { peer } = await setup({
      extraAliases: ['routed'],
      routingBlocks: { routed: ['    routing:', '      allowModels: ["scripted/*"]'] },
      routingService: routing,
    })
    const created = await peer.create({
      alias: 'routed' as never,
      participant: { kind: 'peer', name: 'laptop' },
      provider: 'scripted',
      model: 'routed',
    })
    await expect(peer.selectModel({
      target: { kind: 'session', sessionId: created.target.sessionId },
      participant: { kind: 'peer', name: 'laptop' },
      requestId: 'sw-never' as never,
      provider: 'scripted',
      model: 'switched',
    })).rejects.toMatchObject({ code: 'peer/forbidden', details: { reason: 'switch-not-allowed' } })
    const value = await peer.models({ alias: 'routed' as never, participant: { kind: 'peer', name: 'laptop' } })
    expect(value.selectableByThisAlias.allowSwitch).toBe('never')
  })

  it('leaves the selection unchanged when the policy refuses a switch', async () => {
    const routing = new FakeRoutingService()
    const { peer, ctx } = await setup({
      extraAliases: ['routed'],
      routingAliases: ['routed'],
      routingService: routing,
    })
    const created = await peer.create({
      alias: 'routed' as never,
      participant: { kind: 'peer', name: 'laptop' },
      provider: 'scripted',
      model: 'routed',
    })
    const before = await selectionEvents(ctx, created.target.sessionId)
    routing.decision = () => ({ allowed: false, reason: 'price-unproven', denied: 'scripted/switched' })
    await expect(peer.selectModel({
      target: { kind: 'session', sessionId: created.target.sessionId },
      participant: { kind: 'peer', name: 'laptop' },
      requestId: 'sw-denied' as never,
      provider: 'scripted',
      model: 'switched',
    })).rejects.toMatchObject({
      code: 'peer/forbidden',
      details: { reason: 'price-unproven', denied: 'scripted/switched' },
    })
    expect(await selectionEvents(ctx, created.target.sessionId)).toBe(before)
    const state = await peer.state({ target: { kind: 'session', sessionId: created.target.sessionId } })
    expect(state.state.model).toMatchObject({ provider: 'scripted', model: 'routed' })
  })

  it('rejects an unpaired create alias and malformed routing requests', async () => {
    const routing = new FakeRoutingService()
    const { peer } = await setup({
      extraAliases: ['routed'],
      routingAliases: ['routed'],
      routingService: routing,
    })
    const participant = { kind: 'peer', name: 'laptop' } as const
    await expect(peer.create({ alias: 'ghost' as never, participant }))
      .rejects.toMatchObject({ code: 'peer/not-paired' })
    // A pinned route must name provider and model together.
    await expect(peer.create({
      alias: 'routed' as never,
      participant,
      provider: 'scripted',
    })).rejects.toMatchObject({ code: 'gateway/bad-request' })
    // Both new remote methods reject an absent request object cleanly.
    await expect(peer.models(undefined as never)).rejects.toMatchObject({ code: 'gateway/bad-request' })
    await expect(peer.selectModel(undefined as never)).rejects.toMatchObject({ code: 'gateway/bad-request' })
    // A caller-minted request id is required.
    const created = await peer.create({
      alias: 'routed' as never,
      participant,
      provider: 'scripted',
      model: 'routed',
    })
    await expect(peer.selectModel({
      target: { kind: 'session', sessionId: created.target.sessionId },
      participant,
      requestId: '' as never,
      provider: 'scripted',
      model: 'switched',
    })).rejects.toMatchObject({ code: 'gateway/bad-request' })
  })

  it('refuses a switch on a cold session whose agent is still running', async () => {
    const routing = new FakeRoutingService()
    const { peer, ctx, adapter } = await setup({
      extraAliases: ['routed'],
      routingAliases: ['routed'],
      routingService: routing,
    })
    await peer.create({
      alias: 'routed' as never,
      participant: { kind: 'peer', name: 'laptop' },
      provider: 'scripted',
      model: 'routed',
    })
    const target: PeerTarget = { kind: 'alias', alias: 'routed' as never }
    const hold = adapter.holdNext()
    await peer.prompt({
      target,
      participant: { kind: 'peer', name: 'laptop' },
      requestId: 'req-cold-switch' as never,
      content: [{ type: 'text', text: 'cold latch' }],
    }, NEVER_ABORTED)
    await hold.started
    await waitFor(async () => (await peer.state({ target })).state.latch === 'running')
    const cold = vi.spyOn(ctx.sessionController, 'executionState').mockImplementation(() => {
      throw new Error('session is not attached')
    })
    try {
      await expect(peer.selectModel({
        target,
        participant: { kind: 'peer', name: 'laptop' },
        requestId: 'sw-cold' as never,
        provider: 'scripted',
        model: 'switched',
      })).rejects.toMatchObject({ code: 'peer/conflict', details: { reason: 'busy', latch: 'running' } })
    } finally {
      cold.mockRestore()
    }
    hold.release()
    await waitFor(async () => (await peer.state({ target })).state.latch === 'idle')
  })

  it('switches a session with no prior selection without inventing a previous one', async () => {
    const routing = new FakeRoutingService()
    const { peer, sessionId } = await setup({
      extraAliases: ['routed'],
      routingAliases: ['routed'],
      routingService: routing,
    })
    // Bind the unrouted session from the harness to the routed alias directly.
    await peer.pairings.bind('routed' as never, 'laptop', sessionId)
    const value = await peer.selectModel({
      target: { kind: 'alias', alias: 'routed' as never },
      participant: { kind: 'peer', name: 'laptop' },
      requestId: 'sw-no-previous' as never,
      provider: 'scripted',
      model: 'switched',
    })
    expect(value.previous).toBeUndefined()
    expect(value.selected).toMatchObject({ provider: 'scripted', model: 'switched' })
  })

  it('keeps the switch applied when the receipt write fails', async () => {
    const routing = new FakeRoutingService()
    const { peer } = await setup({
      extraAliases: ['routed'],
      routingAliases: ['routed'],
      routingService: routing,
    })
    const created = await peer.create({
      alias: 'routed' as never,
      participant: { kind: 'peer', name: 'laptop' },
      provider: 'scripted',
      model: 'routed',
    })
    vi.spyOn(peer.receipts, 'put').mockRejectedValueOnce(new Error('disk full'))
    const value = await peer.selectModel({
      target: { kind: 'session', sessionId: created.target.sessionId },
      participant: { kind: 'peer', name: 'laptop' },
      requestId: 'sw-write-fail' as never,
      provider: 'scripted',
      model: 'switched',
    })
    expect(value.accepted).toBe(true)
    expect(value.selected).toMatchObject({ provider: 'scripted', model: 'switched' })
  })

  it('keeps legacy pairing behavior when no routing policy is present', async () => {
    const { peer, sessionId } = await setup({ extraAliases: ['legacy'] })
    const participant = { kind: 'peer', name: 'laptop' } as const
    // Adopt-time routing still needs allowModelChange on a legacy pairing.
    await expect(peer.create({
      alias: 'legacy' as never,
      participant,
      sessionId,
      provider: 'scripted',
      model: 'routed',
    })).rejects.toMatchObject({ code: 'peer/forbidden', details: { reason: 'model-change' } })
    // A chain without provider/model stays a bad request, as before.
    await expect(peer.create({
      alias: 'legacy' as never,
      participant,
      chain: 'free',
    })).rejects.toMatchObject({ code: 'gateway/bad-request' })
    await expect(peer.selectModel({
      target: { kind: 'session', sessionId },
      participant,
      requestId: 'sw-legacy' as never,
      provider: 'scripted',
      model: 'switched',
    })).rejects.toMatchObject({ code: 'peer/forbidden', details: { reason: 'routing-not-configured' } })
    // A legacy create may still record its requested token ceiling.
    const created = await peer.create({
      alias: 'legacy' as never,
      participant,
      maxTotalTokens: 50,
    })
    expect(peer.ceilingOf(created.target.sessionId)).toBe(50)
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
  it('stops a session at its token ceiling, reports budget, and refuses further spend', async () => {
    const { ctx, peer, adapter, sessionId, target } = await setup({ extraAliases: ['spare'] })
    const participant = { kind: 'peer', name: 'laptop' } as const
    await adoptCeiling(peer, sessionId, 2)
    const cancelSpy = vi.spyOn(ctx.agents.get(sessionId)!, 'cancel')
    adapter.callToolOnce()
    const held = adapter.holdCall(2)
    await peer.prompt({
      target,
      participant,
      requestId: 'req-budget' as never,
      content: [{ type: 'text', text: 'spend it' }],
    }, NEVER_ABORTED)
    // The tool-call step commits 4 tokens. The watcher must stop the still
    // running turn instead of waiting for it to end on its own.
    await waitFor(async () => cancelSpy.mock.calls.length > 0)
    held.release()
    await waitFor(async () => (await peer.state({ target })).state.latch === 'idle')
    const stopped = (await peer.state({ target })).state
    expect(cancelSpy).toHaveBeenCalledTimes(1)
    expect(cancelSpy).toHaveBeenCalledWith(
      { kind: 'hook', reason: PEER_BUDGET_STOP_REASON },
      { keepInbox: true },
    )
    expect(stopped.budget).toEqual({ maxTotalTokens: 2, usedTokens: 4, exceeded: true, metered: true })
    expect(stopped.lastTurnEnd).toMatchObject({ reason: 'aborted', stop: 'budget' })
    // The stamp is derived from a durable marker, so a restart that re-folds
    // this log reaches the same conclusion.
    const watchedTerminal = ctx.sessions.get(sessionId)!.snapshotEvents()
      .findLast(event => event.type === 'turn/end')
    expect(watchedTerminal?.data).toMatchObject({
      reason: { kind: 'aborted', reason: { kind: 'hook', reason: PEER_BUDGET_STOP_REASON } },
    })

    // A Session the host never capped spends freely: no budget facts, no stop.
    const spare = await peer.create({ alias: 'spare' as never, participant })
    const spareTarget: PeerTarget = { kind: 'session', sessionId: spare.target.sessionId }
    await peer.prompt({
      target: spareTarget,
      participant,
      requestId: 'req-spare' as never,
      content: [{ type: 'text', text: 'spend freely' }],
    }, NEVER_ABORTED)
    await waitFor(async () => (await peer.state({ target: spareTarget })).state.latch === 'idle')
    const free = (await peer.state({ target: spareTarget })).state
    expect(free.budget).toBeUndefined()
    expect(free.usage).toEqual({ inputTokens: 3, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 })
    expect(free.lastTurnEnd).toMatchObject({ reason: 'completed' })
    expect(cancelSpy).toHaveBeenCalledTimes(1)

    // New peer spend is refused with the peer vocabulary before admission.
    const promptSpy = vi.spyOn(ctx.sessionController, 'prompt')
    await expect(peer.prompt({
      target,
      participant,
      requestId: 'req-budget-refused' as never,
      content: [{ type: 'text', text: 'one more' }],
    }, NEVER_ABORTED)).rejects.toMatchObject({
      code: 'peer/forbidden',
      details: { reason: 'budget', denied: '2' },
    })
    expect(promptSpy).not.toHaveBeenCalled()
  })

  it('does not stamp a human cancel of an over-budget turn as a budget stop', async () => {
    const { ctx, peer, adapter, sessionId, target } = await setup()
    const participant = { kind: 'peer', name: 'laptop' } as const
    await adoptCeiling(peer, sessionId, 2)
    adapter.callToolOnce()
    const held = adapter.holdCall(2)
    const agent = ctx.agents.get(sessionId)!
    // Hide the running agent from the watcher's status probe so only the
    // human cancel below ends this over-budget turn.
    const statusSpy = vi.spyOn(agent, 'status', 'get').mockReturnValue('idle')
    try {
      await peer.prompt({
        target,
        participant,
        requestId: 'req-human-cancel' as never,
        content: [{ type: 'text', text: 'spend and stop me' }],
      }, NEVER_ABORTED)
      await waitFor(async () => ctx.sessions.get(sessionId)?.snapshotEvents()
        .some(event => event.type === 'assistant/message' && event.data.turn === 1) === true)
      ctx.sessionController.cancel({ sessionId })
      held.release()
    } finally {
      statusSpy.mockRestore()
    }
    await waitFor(async () => (await peer.state({ target })).state.latch === 'idle')
    const state = (await peer.state({ target })).state
    expect(state.budget).toEqual({
      maxTotalTokens: 2,
      usedTokens: 4,
      exceeded: true,
      metered: true,
    })
    expect(state.lastTurnEnd).toMatchObject({ reason: 'aborted' })
    expect(state.lastTurnEnd?.stop).toBeUndefined()
    // The durable cause is the human stop, not the watcher's hook marker.
    const terminal = ctx.sessions.get(sessionId)!.snapshotEvents()
      .findLast(event => event.type === 'turn/end')
    expect(terminal?.data).toMatchObject({
      reason: { kind: 'aborted', reason: { kind: 'user' } },
    })
  })

  it('keeps a session under its ceiling running without a stop', async () => {
    const { ctx, peer, sessionId, target } = await setup()
    const participant = { kind: 'peer', name: 'laptop' } as const
    await adoptCeiling(peer, sessionId, 100)
    const cancelSpy = vi.spyOn(ctx.agents.get(sessionId)!, 'cancel')
    await peer.prompt({
      target,
      participant,
      requestId: 'req-under' as never,
      content: [{ type: 'text', text: 'stay under' }],
    }, NEVER_ABORTED)
    await waitFor(async () => (await peer.state({ target })).state.latch === 'idle')
    const state = (await peer.state({ target })).state
    expect(cancelSpy).not.toHaveBeenCalled()
    expect(state.budget).toEqual({ maxTotalTokens: 100, usedTokens: 5, exceeded: false, metered: true })
    expect(state.lastTurnEnd).toMatchObject({ reason: 'completed' })
    expect(state.lastTurnEnd?.stop).toBeUndefined()
  })

  it('keeps one ceiling observation in flight and coalesces the next event', async () => {
    const { ctx, peer, sessionId, target } = await setup()
    const participant = { kind: 'peer', name: 'laptop' } as const
    await adoptCeiling(peer, sessionId, 2)
    const cancelSpy = vi.spyOn(ctx.agents.get(sessionId)!, 'cancel')
    const original = ctx.sessionQuery.observeSession.bind(ctx.sessionQuery)
    const gate = Promise.withResolvers<undefined>()
    let reads = 0
    const observeSpy = vi.spyOn(ctx.sessionQuery, 'observeSession').mockImplementation((
      (id: SessionId, options?: SessionObservationOptions) => {
        reads += 1
        const observation = original(id, options)
        // The prompt gate's read (1) must settle; the watcher's first read (2)
        // stays open across the rest of the turn, so the terminal event only
        // arms one trailing re-check.
        return reads === 2 ? gate.promise.then(() => observation) : observation
      }
    ))
    try {
      await peer.prompt({
        target,
        participant,
        requestId: 'req-single-flight' as never,
        content: [{ type: 'text', text: 'one read at a time' }],
      }, NEVER_ABORTED)
      await waitFor(async () => ctx.sessions.get(sessionId)?.snapshotEvents()
        .some(event => event.type === 'turn/end') === true)
      gate.resolve(undefined)
      // The trailing re-check is the third read; without coalescing the
      // terminal event would have opened a second observation in parallel.
      await waitFor(async () => reads >= 3)
      await new Promise(resolve => setTimeout(resolve, 20))
      expect(reads).toBe(3)
      expect(cancelSpy).not.toHaveBeenCalled()
    } finally {
      observeSpy.mockRestore()
    }
    await waitFor(async () => (await peer.state({ target })).state.latch === 'idle')
    expect((await peer.state({ target })).state.budget).toEqual({
      maxTotalTokens: 2,
      usedTokens: 5,
      exceeded: true,
      metered: true,
    })
  })


  it('skips a coalesced event once the same turn was already stopped', async () => {
    const { ctx, peer, adapter, sessionId, target } = await setup()
    const participant = { kind: 'peer', name: 'laptop' } as const
    await adoptCeiling(peer, sessionId, 2)
    // Two tool-call steps commit 4 tokens each; the third request stays open
    // so the turn is still running when the gated observation resolves.
    adapter.callToolOn(1)
    adapter.callToolOn(2)
    const held = adapter.holdCall(3)
    const cancelSpy = vi.spyOn(ctx.agents.get(sessionId)!, 'cancel')
    const original = ctx.sessionQuery.observeSession.bind(ctx.sessionQuery)
    const gate = Promise.withResolvers<undefined>()
    let reads = 0
    const observeSpy = vi.spyOn(ctx.sessionQuery, 'observeSession').mockImplementation((
      (id: SessionId, options?: SessionObservationOptions) => {
        reads += 1
        const observation = original(id, options)
        return reads === 2 ? gate.promise.then(() => observation) : observation
      }
    ))
    try {
      await peer.prompt({
        target,
        participant,
        requestId: 'req-coalesced' as never,
        content: [{ type: 'text', text: 'two steps' }],
      }, NEVER_ABORTED)
      await waitFor(async () => adapter.calls.length >= 3)
      gate.resolve(undefined)
      await waitFor(async () => cancelSpy.mock.calls.length === 1)
    } finally {
      observeSpy.mockRestore()
    }
    held.release()
    await waitFor(async () => (await peer.state({ target })).state.latch === 'idle')
    // The second committed message armed one trailing re-check; the turn was
    // already stopped by the first, so it must not issue a second cancel.
    expect(reads).toBe(2)
    expect(cancelSpy).toHaveBeenCalledTimes(1)
    expect((await peer.state({ target })).state.lastTurnEnd)
      .toMatchObject({ reason: 'aborted', stop: 'budget' })
  })

  it('contains a ceiling observation failure instead of failing the append feed', async () => {
    const { ctx, peer, sessionId, target } = await setup()
    const participant = { kind: 'peer', name: 'laptop' } as const
    await adoptCeiling(peer, sessionId, 2)
    const cancelSpy = vi.spyOn(ctx.agents.get(sessionId)!, 'cancel')
    const warnings: string[] = []
    const warnSpy = vi.spyOn(ctx.logger, 'warn').mockImplementation((
      (message: unknown) => { warnings.push(String(message)) }
    ) as never)
    const observeSpy = vi.spyOn(ctx.sessionQuery, 'observeSession')
      .mockRejectedValue(new Error('projection unavailable'))
    try {
      // The prompt gate's failed read must not become a refusal: the turn is
      // admitted, and the watcher's failed read leaves it to finish normally.
      await peer.prompt({
        target,
        participant,
        requestId: 'req-read-failure' as never,
        content: [{ type: 'text', text: 'unreadable budget' }],
      }, NEVER_ABORTED)
      await waitFor(async () => ctx.sessions.get(sessionId)?.snapshotEvents()
        .some(event => event.type === 'turn/end') === true)
      await new Promise(resolve => setTimeout(resolve, 20))
    } finally {
      observeSpy.mockRestore()
    }
    await waitFor(async () => (await peer.state({ target })).state.latch === 'idle')
    expect(cancelSpy).not.toHaveBeenCalled()
    const state = (await peer.state({ target })).state
    expect(state.budget).toEqual({ maxTotalTokens: 2, usedTokens: 5, exceeded: true, metered: true })
    expect(state.lastTurnEnd).toMatchObject({ reason: 'completed' })
    expect(warnings.some(line => line.includes('listener rejected'))).toBe(false)
    warnSpy.mockRestore()
  })

  it('stops each new turn while the session stays over its ceiling', async () => {
    const { ctx, peer, adapter, sessionId, target } = await setup()
    const participant = { kind: 'peer', name: 'laptop' } as const
    await adoptCeiling(peer, sessionId, 2)
    const cancelSpy = vi.spyOn(ctx.agents.get(sessionId)!, 'cancel')
    adapter.callToolOnce()
    const firstHold = adapter.holdCall(2)
    await peer.prompt({
      target,
      participant,
      requestId: 'req-turn-one' as never,
      content: [{ type: 'text', text: 'first turn' }],
    }, NEVER_ABORTED)
    await waitFor(async () => cancelSpy.mock.calls.length === 1)
    firstHold.release()
    await waitFor(async () => (await peer.state({ target })).state.latch === 'idle')
    // An autonomous wake (settlement or goal continuation) enters through the
    // controller, bypassing the peer prompt gate. The watcher still stops its
    // first response, so the overshoot stays bounded to one request.
    adapter.callToolOnce()
    const secondHold = adapter.holdCall(adapter.calls.length + 2)
    await ctx.sessionController.prompt({
      requestId: 'req-turn-two' as never,
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text: 'wake up' }],
    }, NEVER_ABORTED)
    await waitFor(async () => cancelSpy.mock.calls.length === 2)
    secondHold.release()
    await waitFor(async () => (await peer.state({ target })).state.latch === 'idle')
    expect((await peer.state({ target })).state.lastTurnEnd)
      .toMatchObject({ turn: 2, reason: 'aborted', stop: 'budget' })
    expect(cancelSpy).toHaveBeenCalledTimes(2)
  })

  it('removes the ceiling watcher when the plugin fiber is disposed', async () => {
    const { ctx, peer, peerFiber, sessionId } = await setup({ peerAsFiber: true })
    expect(peerFiber).toBeDefined()
    await adoptCeiling(peer, sessionId, 2)
    const ceilingSpy = vi.spyOn(peer, 'ceilingOf')
    const cancelSpy = vi.spyOn(ctx.agents.get(sessionId)!, 'cancel')
    await peerFiber!.dispose()
    ceilingSpy.mockClear()
    await ctx.sessionController.prompt({
      requestId: 'req-disposed' as never,
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text: 'after disposal' }],
    }, NEVER_ABORTED)
    await waitFor(async () => ctx.sessions.get(sessionId)?.snapshotEvents()
      .some(event => event.type === 'turn/end') === true)
    await new Promise(resolve => setTimeout(resolve, 20))
    const terminal = ctx.sessions.get(sessionId)?.snapshotEvents()
      .findLast(event => event.type === 'turn/end')
    expect(terminal).toMatchObject({ type: 'turn/end', data: { reason: { kind: 'completed' } } })
    expect(ceilingSpy).not.toHaveBeenCalled()
    expect(cancelSpy).not.toHaveBeenCalled()
  })

  it('keeps the ceiling of a retired binding addressable for the watcher', async () => {
    const routing = new FakeRoutingService()
    const participant = { kind: 'peer', name: 'laptop' } as const
    const { peer, sessionId } = await setup({
      extraAliases: ['routed'],
      routingAliases: ['routed'],
      routingService: routing,
    })
    const first = await peer.create({
      alias: 'routed' as never,
      participant,
      provider: 'scripted',
      model: 'routed',
      maxTotalTokens: 400,
    })
    expect(peer.ceilingOf(first.target.sessionId)).toBe(400)
    const second = await peer.create({
      alias: 'routed' as never,
      participant,
      provider: 'scripted',
      model: 'routed',
      maxTotalTokens: 100,
    })
    expect(peer.ceilingOf(second.target.sessionId)).toBe(100)
    expect(peer.ceilingOf(first.target.sessionId)).toBe(400)
    expect(peer.ceilingOf(sessionId)).toBeUndefined()
  })

  it('swallows a detach race between the running check and the budget stop', async () => {
    const { ctx, peer, adapter, sessionId, target } = await setup()
    const participant = { kind: 'peer', name: 'laptop' } as const
    await adoptCeiling(peer, sessionId, 2)
    const warnings: string[] = []
    const warnSpy = vi.spyOn(ctx.logger, 'warn').mockImplementation((
      (message: unknown) => { warnings.push(String(message)) }
    ) as never)
    const cancelSpy = vi.spyOn(ctx.agents.get(sessionId)!, 'cancel')
      .mockImplementationOnce(() => { throw new RemoteError('session/not-found', 'detached', { sessionId }) })
    adapter.callToolOnce()
    const held = adapter.holdCall(2)
    await peer.prompt({
      target,
      participant,
      requestId: 'req-detach-race' as never,
      content: [{ type: 'text', text: 'detach under me' }],
    }, NEVER_ABORTED)
    await waitFor(async () => cancelSpy.mock.calls.length === 1)
    held.release()
    await waitFor(async () => (await peer.state({ target })).state.latch === 'idle')
    expect(warnings.some(line => line.includes('listener rejected'))).toBe(false)
    expect((await peer.state({ target })).state.lastTurnEnd).toMatchObject({ reason: 'completed' })
    warnSpy.mockRestore()
  })

  it('drops ceiling bookkeeping when the agent or its session is disposed', async () => {
    const { ctx, peer, adapter, sessionId, target } = await setup()
    const participant = { kind: 'peer', name: 'laptop' } as const
    await adoptCeiling(peer, sessionId, 2)
    adapter.callToolOnce()
    const held = adapter.holdCall(2)
    const cancelSpy = vi.spyOn(ctx.agents.get(sessionId)!, 'cancel')
    await peer.prompt({
      target,
      participant,
      requestId: 'req-prune' as never,
      content: [{ type: 'text', text: 'stop then dispose' }],
    }, NEVER_ABORTED)
    await waitFor(async () => cancelSpy.mock.calls.length === 1)
    held.release()
    await waitFor(async () => (await peer.state({ target })).state.latch === 'idle')
    // A second agent exercises the agent/disposed listener, then the Session
    // disposal exercises session/disposed; neither must leak or throw.
    const handle = await ctx.agents.create({
      sessionId: SessionId('prune-agent'),
      agentOptions: { provider: 'scripted', model: 'mock' },
    })
    await handle.dispose()
    expect(ctx.agents.get(SessionId('prune-agent'))).toBeUndefined()
    expect(ctx.sessions.dispose(sessionId)).toBe(true)
    expect(ctx.sessions.get(sessionId)).toBeUndefined()
  })
})
