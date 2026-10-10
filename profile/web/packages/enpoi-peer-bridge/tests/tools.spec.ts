import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import type { PeerExecutionState, PeerPendingAsk, PeerWebSocket } from '../src/peer-client.ts'
import { registerTools } from '../src/index.ts'
import { FakeSocket, rpcResponse, SNAPSHOT } from './helpers.ts'

const PAIRING_DOC = [
  'version: 1',
  'device: serverlocal',
  'pairings:',
  '  - alias: scratch',
  '    peer: serverlocal',
  '    exposure: debug',
  '    endpoint: https://serverlocal.pike-acrux.ts.net:8443',
  '    create:',
  '      cwd: /tmp/scratch-work',
  '',
].join('\n')

/** The same pairing with a create-time route, as the live loopback pairing pins it. */
const ROUTED_PAIRING_DOC = [
  'version: 1',
  'device: serverlocal',
  'pairings:',
  '  - alias: scratch',
  '    peer: serverlocal',
  '    exposure: debug',
  '    endpoint: https://serverlocal.pike-acrux.ts.net:8443',
  '    create:',
  '      cwd: /tmp/scratch-work',
  '      provider: antigravity',
  '      model: gemini-3.8-flash-tiered',
  '      chain: loopback',
  '      reasoningEffort: high',
  '',
].join('\n')

interface HostOptions {
  readonly answerError?: string
  readonly ask?: PeerPendingAsk | null
  readonly withApproval?: boolean
  readonly networkFail?: boolean
  /** Halt the first follow at the gated ask, then replay the same turn to terminal on later follows. */
  readonly resumeFlow?: boolean
  /** Latch the ask state frame carries (default waiting_approval, which returns early). */
  readonly askLatch?: PeerExecutionState['latch']
  /** Hold the local approval card open until settled manually or its signal aborts. */
  readonly holdApproval?: boolean
  /** Hold the local question card open until its signal aborts. */
  readonly holdQuestion?: boolean
  /** Emit a second state frame, after the ask frame, whose pendingAsks is empty. */
  readonly settleAskRemotely?: boolean
  /** Stop the scripted follow after the prompt event, leaving the stream open. */
  readonly holdFollow?: boolean
  /** Local user-questions answerer; absent from the context when `withQuestions: false`. */
  readonly withQuestions?: boolean
  /** Make the local question answerer refuse, mirroring an unattended/closed UI. */
  readonly questionRefusal?: boolean
  /** Answer the local user-questions request resolves with. */
  readonly questionAnswer?: { readonly answers: readonly { readonly id: string; readonly selected: readonly string[] }[] }
  /** Prepend a completed third-party turn 1 before our admitted prompt in turn 2. */
  readonly prelude?: boolean
  /** Stop the script after the prelude, before our prompt ever starts a turn. */
  readonly stopAfterPrelude?: boolean
  /** Stop the script after our admitted user/message, leaving our turn terminal open. */
  readonly thirdPartyOnly?: boolean
  /** Replay seqs 10-12 in a reconnect snapshot after the first terminal. */
  readonly replay?: boolean
  /** Start a follow-up turn carrying this text after the first terminal. */
  readonly secondTurn?: string
  /** Start a later turn opened by another operator's prompt, carrying this answer text. */
  readonly foreignPrompt?: string
  /** Start a later continuation turn that produces no assistant text and ends in error. */
  readonly silentSecondTurn?: boolean
  /** End our own turn in error after committing its assistant text. */
  readonly ourTurnError?: boolean
  /** End our own turn as cancelled after committing its assistant text. */
  readonly ourTurnCancelled?: boolean
  /** Skip the trailing settled state frame, leaving the last follow state busy. */
  readonly noFinalState?: boolean
  /** Quiet window override for the follow's settle clock. */
  readonly settleMs?: number
  /** Latch the unary `peer.state` read reports (default idle). */
  readonly stateLatch?: string
  /** Live descendants the unary `peer.state` read reports (default 0). */
  readonly stateDescendants?: number
  /** Throw a transport error after removing the ask (the remote applied it). */
  readonly answerTransportLost?: boolean
  /** Throw a transport error without removing the ask (the remote never saw it). */
  readonly answerTransportFail?: boolean
  /** Throw a transport error on cancel; `peer.state` reports the configured latch. */
  readonly cancelTransportFail?: boolean
  /** Report `peer/not-paired` from `peer.state` until `create` binds the session. */
  readonly unbound?: boolean
  /** Pairing document override (defaults to {@link PAIRING_DOC}). */
  readonly pairingDoc?: string
}

interface RegisteredTool {
  readonly name: string
  readonly description: string
  readonly execute: (args: unknown, exec: Record<string, unknown>) => Promise<Record<string, unknown>>
  readonly output: { readonly render: (args: unknown, value: unknown) => { type: string; text: string }[] }
}

function createHarness(options: HostOptions = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'peer-bridge-tools-'))
  const pairingsPath = join(dir, 'pairings.yaml')
  const noticesPath = join(dir, 'peer-bridge', 'asks.jsonl')
  writeFileSync(pairingsPath, options.pairingDoc ?? PAIRING_DOC)

  const calls: Array<{ method: string; args: Record<string, unknown> }> = []
  const captured = { requestId: undefined as string | undefined }
  let boundNow = options.unbound !== true
  // The scripted remote: state reads report the asks currently pending, and a
  // successful answer removes its ask, so a later confirming read agrees with
  // the state frames the socket already emitted.
  let pendingAsksNow: PeerPendingAsk[] = options.ask === undefined || options.ask === null ? [] : [options.ask]
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (options.networkFail === true) throw new Error('econnrefused')
    const method = String(input).split('/api/peer/')[1]!
    const body = JSON.parse(String(init?.body)) as { rpcId: string; payload: { args: { request: Record<string, unknown> } } }
    const args = body.payload.args.request
    calls.push({ method, args })
    const ok = (value: unknown): Response => rpcResponse(value)
    const fail = (code: string, message: string): Response => rpcResponse({ code, message }, false)
    switch (method) {
      case 'handshake':
        return ok({ protocolVersion: 1, harnessVersion: '0.1.6-alpha.2', schemaDigest: '', hostDevice: 'serverlocal', capabilities: ['state-latch'], pairings: [] })
      case 'state':
        if (!boundNow) return fail('peer/not-paired', 'no session bound')
        return ok({
          target: { device: 'serverlocal', sessionId: 'sess-1', exposure: 'debug', alias: 'scratch' },
          state: {
            latch: options.stateLatch ?? 'idle', since: 0, source: 'host-latch',
            activeDescendants: options.stateDescendants ?? 0, descendantsExact: true,
            pendingAsks: pendingAsksNow,
            model: { provider: 'antigravity', model: 'gemini-3.8-flash-tiered' },
            lastTurnEnd: { turn: 0, reason: 'completed', at: 0 },
          },
          cursor: 0,
        })
      case 'create':
        boundNow = true
        return ok({
          target: { device: 'serverlocal', sessionId: 'sess-1', exposure: 'debug', alias: 'scratch' },
          created: true,
        })
      case 'list':
        return ok({
          hostDevice: 'serverlocal',
          pairings: [{
            alias: 'scratch',
            peer: 'serverlocal',
            exposure: 'debug',
            bound: true,
            sessionId: 'sess-1',
            latch: 'idle',
            lastActivity: 1_700_000_000_000,
            summary: 'idle · no asks',
          }],
        })
      case 'prompt':
        captured.requestId = typeof args.requestId === 'string' ? args.requestId : undefined
        return ok({ accepted: true, queued: true, hopCount: 1 })
      case 'answer':
        if (options.answerTransportFail === true) throw new Error('econnrefused')
        if (options.answerTransportLost === true) {
          pendingAsksNow = pendingAsksNow.filter(ask => ask.askId !== args.askId)
          throw new Error('econnrefused')
        }
        if (options.answerError !== undefined) return fail(options.answerError, 'already settled')
        pendingAsksNow = pendingAsksNow.filter(ask => ask.askId !== args.askId)
        return ok({ accepted: true, settled: true })
      case 'cancel':
        if (options.cancelTransportFail === true) throw new Error('econnrefused')
        return ok({ accepted: true, cancelled: true })
      default:
        return fail('peer/not-paired', `no ${method}`)
    }
  }) as unknown as typeof fetch

  let followGen = 0
  const socketFactory = (): PeerWebSocket => new FakeSocket((socket, streamId) => {
    followGen += 1
    const ourTurn = options.prelude === true ? 2 : 1
    const settled: PeerExecutionState = {
      latch: 'idle', since: 20, source: 'host-latch', activeDescendants: 0,
      descendantsExact: true, pendingAsks: [],
    }
    if (options.resumeFlow === true && followGen > 1) {
      // The resume generation: the same turn replays from its admission to its
      // terminal. No turn/start is replayed, so attribution must come from the
      // resumed requestId (or the seeded floor when the window cut it).
      socket.frame(streamId, {
        ...SNAPSHOT,
        state: {
          latch: 'running', since: 1, source: 'host-latch', activeDescendants: 0,
          descendantsExact: true, pendingAsks: [],
        },
      })
      socket.frame(streamId, {
        type: 'event',
        record: { seq: 10, time: 4, type: 'user/message', data: { source: { kind: 'user', rpcId: captured.requestId }, content: [{ type: 'text', text: 'run it' }] } },
        cursor: 10,
      })
      socket.frame(streamId, {
        type: 'event',
        record: { seq: 11, time: 5, type: 'assistant/message', data: { turn: ourTurn, message: { content: [{ type: 'text', text: 'remote answer text' }] } } },
        cursor: 11,
      })
      socket.frame(streamId, {
        type: 'event',
        record: { seq: 12, time: 6, type: 'turn/end', data: { turn: ourTurn, reason: { kind: 'completed' } } },
        cursor: 12,
      })
      pendingAsksNow = []
      socket.frame(streamId, { type: 'state', state: settled, cursor: 20 })
      return
    }
    socket.frame(streamId, SNAPSHOT)
    if (options.ask !== undefined && options.ask !== null) {
      socket.frame(streamId, {
        type: 'state',
        state: {
          latch: options.askLatch ?? 'waiting_approval', since: 1, source: 'host-latch', activeDescendants: 0,
          descendantsExact: true, pendingAsks: [options.ask],
        },
        cursor: 1,
      })
      if (options.resumeFlow === true) return
      if (options.settleAskRemotely === true) {
        setTimeout(() => {
          pendingAsksNow = []
          socket.frame(streamId, {
            type: 'state',
            state: {
              latch: 'running', since: 2, source: 'host-latch', activeDescendants: 0,
              descendantsExact: true, pendingAsks: [],
            },
            cursor: 2,
          })
        }, 10)
      }
    }
    if (options.prelude === true) {
      socket.frame(streamId, {
        type: 'event',
        record: { seq: 6, time: 1, type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: 'third party answer' }] } } },
        cursor: 6,
      })
      socket.frame(streamId, {
        type: 'event',
        record: { seq: 7, time: 2, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
        cursor: 7,
      })
    }
    if (options.stopAfterPrelude === true) return
    socket.frame(streamId, {
      type: 'event',
      record: { seq: 9, time: 3, type: 'turn/start', data: { turn: ourTurn } },
      cursor: 9,
    })
    socket.frame(streamId, {
      type: 'event',
      record: { seq: 10, time: 4, type: 'user/message', data: { source: { kind: 'user', rpcId: captured.requestId }, content: [{ type: 'text', text: 'run it' }] } },
      cursor: 10,
    })
    if (options.holdFollow === true || options.thirdPartyOnly === true) return
    socket.frame(streamId, {
      type: 'event',
      record: { seq: 11, time: 5, type: 'assistant/message', data: { turn: ourTurn, message: { content: [{ type: 'text', text: 'remote answer text' }] } } },
      cursor: 11,
    })
    socket.frame(streamId, {
      type: 'event',
      record: { seq: 12, time: 6, type: 'turn/end', data: { turn: ourTurn, reason: { kind: options.ourTurnError === true ? 'error' : options.ourTurnCancelled === true ? 'cancelled' : 'completed' } } },
      cursor: 12,
    })
    if (options.replay === true) {
      socket.frame(streamId, {
        ...SNAPSHOT,
        cursor: 12,
        state: settled,
        records: [
          { seq: 10, time: 4, type: 'user/message', data: { source: { kind: 'user', rpcId: captured.requestId }, content: [{ type: 'text', text: 'run it' }] } },
          { seq: 11, time: 5, type: 'assistant/message', data: { turn: ourTurn, message: { content: [{ type: 'text', text: 'remote answer text' }] } } },
          { seq: 12, time: 6, type: 'turn/end', data: { turn: ourTurn, reason: { kind: 'completed' } } },
        ],
      })
    }
    if (options.secondTurn !== undefined) {
      socket.frame(streamId, {
        type: 'state',
        state: {
          latch: 'idle', since: 13, source: 'host-latch', activeDescendants: 1,
          descendantsExact: true, pendingAsks: [],
        },
        cursor: 13,
      })
      socket.frame(streamId, {
        type: 'event',
        record: { seq: 14, time: 7, type: 'turn/start', data: { turn: ourTurn + 1 } },
        cursor: 14,
      })
      socket.frame(streamId, {
        type: 'event',
        record: { seq: 15, time: 8, type: 'assistant/message', data: { turn: ourTurn + 1, message: { content: [{ type: 'text', text: options.secondTurn }] } } },
        cursor: 15,
      })
      socket.frame(streamId, {
        type: 'event',
        record: { seq: 16, time: 9, type: 'turn/end', data: { turn: ourTurn + 1, reason: { kind: 'completed' } } },
        cursor: 16,
      })
    }
    if (options.foreignPrompt !== undefined) {
      socket.frame(streamId, {
        type: 'state',
        state: {
          latch: 'running', since: 13, source: 'host-latch', activeDescendants: 0,
          descendantsExact: true, pendingAsks: [],
        },
        cursor: 13,
      })
      socket.frame(streamId, {
        type: 'event',
        record: { seq: 14, time: 7, type: 'turn/start', data: { turn: ourTurn + 1 } },
        cursor: 14,
      })
      socket.frame(streamId, {
        type: 'event',
        record: { seq: 15, time: 8, type: 'user/message', data: { source: { kind: 'user', rpcId: 'peer-bridge-other' }, content: [{ type: 'text', text: 'their prompt' }] } },
        cursor: 15,
      })
      socket.frame(streamId, {
        type: 'event',
        record: { seq: 16, time: 9, type: 'assistant/message', data: { turn: ourTurn + 1, message: { content: [{ type: 'text', text: options.foreignPrompt }] } } },
        cursor: 16,
      })
      socket.frame(streamId, {
        type: 'event',
        record: { seq: 17, time: 10, type: 'turn/end', data: { turn: ourTurn + 1, reason: { kind: 'completed' } } },
        cursor: 17,
      })
    }
    if (options.silentSecondTurn === true) {
      socket.frame(streamId, {
        type: 'event',
        record: { seq: 14, time: 7, type: 'turn/start', data: { turn: ourTurn + 1 } },
        cursor: 14,
      })
      socket.frame(streamId, {
        type: 'event',
        record: { seq: 16, time: 9, type: 'turn/end', data: { turn: ourTurn + 1, reason: { kind: 'error' } } },
        cursor: 16,
      })
    }
    if (options.noFinalState !== true) {
      pendingAsksNow = []
      socket.frame(streamId, { type: 'state', state: settled, cursor: 20 })
    }
  })

  const tools = new Map<string, RegisteredTool>()
  const approvalCalls: unknown[] = []
  let approvalDecision = 'allowed-once'
  let settleHeld: ((outcome: string) => void) | undefined
  const approval = {
    request: (request: Record<string, unknown>): Promise<string> => {
      approvalCalls.push(request)
      const signal = request.signal as AbortSignal | undefined
      if (options.holdApproval !== true) return Promise.resolve(approvalDecision)
      // Mirror the real service: a held card resolves cancelled on abort.
      return new Promise<string>(resolve => {
        settleHeld = resolve
        if (signal?.aborted === true) { resolve('cancelled'); return }
        signal?.addEventListener('abort', () => { resolve('cancelled') }, { once: true })
      })
    },
  }
  const questionCalls: Array<Record<string, unknown>> = []
  const userQuestions = {
    ask: (request: Record<string, unknown>): Promise<unknown> => {
      questionCalls.push(request)
      if (options.questionRefusal === true) return Promise.reject(new Error('no user-questions answerer accepted the request'))
      if (options.holdQuestion === true) {
        const signal = request.signal as AbortSignal | undefined
        return new Promise((_resolve, reject) => {
          const abort = (): void => { reject(new Error('ask_user_question was aborted before the user answered')) }
          if (signal?.aborted === true) { abort(); return }
          signal?.addEventListener('abort', abort, { once: true })
        })
      }
      return Promise.resolve(options.questionAnswer ?? { answers: [{ id: 'colour', selected: ['blue'] }] })
    },
  }
  const ctx = {
    tools: {
      register: (definition: RegisteredTool) => {
        tools.set(definition.name, definition)
        return () => {}
      },
    },
    get: (name: string) => {
      if (name === 'approval' && options.withApproval !== false) return approval
      if (name === 'userQuestions' && options.withQuestions !== false) return userQuestions
      return undefined
    },
    logger: { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} },
  } as unknown as Context

  registerTools(ctx, { pairingsPath, noticesPath, settleMs: options.settleMs ?? 20 }, { fetch: fetchImpl, webSocket: socketFactory })
  const execController = new AbortController()
  return {
    tools,
    calls,
    approvalCalls,
    questionCalls,
    noticesPath,
    dir,
    setApprovalDecision: (value: string) => { approvalDecision = value },
    settleApproval: (outcome: string) => { settleHeld?.(outcome) },
    abortExec: () => { execController.abort() },
    exec: { signal: execController.signal, agent: {} },
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitFor timed out')
    await new Promise(resolve => setTimeout(resolve, 1))
  }
}

const APPROVAL_ASK: PeerPendingAsk = {
  kind: 'approval',
  askId: 'ask-1',
  toolName: 'bash',
  reason: 'bash rule "rm" requires approval',
  since: 1,
}

const QUESTION_ASK: PeerPendingAsk = {
  kind: 'question',
  askId: 'ask-q1',
  since: 2,
  questions: [{
    id: 'colour',
    question: 'Pick a colour',
    options: [{ label: 'red' }, { label: 'blue' }],
  }],
}

describe('enpoi-peer-bridge tools', () => {
  it('registers the six bridge tools with model-facing descriptions and renders', () => {
    const harness = createHarness()
    expect([...harness.tools.keys()]).toEqual(['peer_status', 'peer_sessions', 'peer_ask', 'peer_asks', 'peer_answer', 'peer_cancel'])
    for (const tool of harness.tools.values()) {
      expect(tool.description.length).toBeGreaterThan(40)
      expect(typeof tool.output.render).toBe('function')
    }
  })

  it('peer_status reports host identity, latch, model, and pending asks', async () => {
    const harness = createHarness()
    const result = await harness.tools.get('peer_status')!.execute({ alias: 'scratch' }, harness.exec)
    expect(result).toMatchObject({
      ok: true,
      alias: 'scratch',
      sessionId: 'sess-1',
      bound: true,
      latch: 'idle',
      model: 'antigravity/gemini-3.8-flash-tiered',
    })
    expect((result.host as Record<string, unknown>).device).toBe('serverlocal')
  })

  it('peer_status surfaces peer/target-unreachable naming the endpoint', async () => {
    const harness = createHarness({ networkFail: true })
    const result = await harness.tools.get('peer_status')!.execute({ alias: 'scratch' }, harness.exec)
    expect(result.ok).toBe(false)
    const error = result.error as Record<string, unknown>
    expect(error.code).toBe('peer/target-unreachable')
    expect(String(error.message)).toContain('https://serverlocal.pike-acrux.ts.net:8443')
    expect(String(error.hint)).toContain('caller owns backoff')
  })

  it('peer_ask prompts, follows, and returns the remote answer', async () => {
    const harness = createHarness()
    const result = await harness.tools.get('peer_ask')!.execute({ alias: 'scratch', message: 'do the thing' }, harness.exec)
    expect(result).toMatchObject({ ok: true, alias: 'scratch', admitted: true, turn: 1, terminal: 'completed', answer: 'remote answer text' })
    expect(harness.calls.find(call => call.method === 'prompt')!.args).toMatchObject({
      participant: { kind: 'peer', name: 'serverlocal', device: 'serverlocal' },
      content: [{ type: 'text', text: 'do the thing' }],
      hopCount: 0,
    })
  })

  it('peer_ask forwards the pairing create routing to the host verbatim', async () => {
    const harness = createHarness({ unbound: true, pairingDoc: ROUTED_PAIRING_DOC })
    const result = await harness.tools.get('peer_ask')!.execute({ alias: 'scratch', message: 'hi' }, harness.exec)
    expect(result).toMatchObject({ ok: true, created: true })
    expect(harness.calls.find(call => call.method === 'create')!.args).toMatchObject({
      alias: 'scratch',
      provider: 'antigravity',
      model: 'gemini-3.8-flash-tiered',
      chain: 'loopback',
      reasoningEffort: 'high',
    })
  })

  it('peer_ask sends no create routing fields when the pairing pins none', async () => {
    const harness = createHarness({ unbound: true })
    const result = await harness.tools.get('peer_ask')!.execute({ alias: 'scratch', message: 'hi' }, harness.exec)
    expect(result).toMatchObject({ ok: true, created: true })
    const args = harness.calls.find(call => call.method === 'create')!.args
    expect(args).not.toHaveProperty('provider')
    expect(args).not.toHaveProperty('model')
    expect(args).not.toHaveProperty('chain')
    expect(args).not.toHaveProperty('reasoningEffort')
  })

  it('returns early on waiting_approval with the structured asks and relays the local decision', async () => {
    const harness = createHarness({ ask: APPROVAL_ASK })
    const result = await harness.tools.get('peer_ask')!.execute({ alias: 'scratch', message: 'rm the dir' }, harness.exec)
    expect(result).toMatchObject({
      ok: false,
      pending: true,
      status: 'waiting_approval',
      settled: false,
      alias: 'scratch',
      sessionId: 'sess-1',
      admitted: true,
      latch: 'waiting_approval',
    })
    expect(String(result.requestId)).toContain('peer-bridge-')
    expect(result.pendingAsks).toEqual([{
      askId: 'ask-1',
      kind: 'approval',
      toolName: 'bash',
      reason: 'bash rule "rm" requires approval',
      questions: [],
      since: 1,
    }])
    // The local card still surfaced; its immediate decision relayed before the
    // early return finished.
    expect(harness.approvalCalls).toHaveLength(1)
    const request = harness.approvalCalls[0] as Record<string, unknown>
    expect(request.toolName).toBe('bash')
    expect(String(request.reason)).toContain('remote ask on scratch')
    expect(String(request.reason)).toContain('bash rule "rm" requires approval')
    const answerCall = harness.calls.find(call => call.method === 'answer')
    expect(answerCall!.args).toMatchObject({ answer: { kind: 'approval', outcome: 'allowed-once' } })
    expect((result.asks as string[])[0]).toContain('relay=settled')
    const rendered = harness.tools.get('peer_ask')!.output.render({}, result)[0]!.text
    expect(rendered).toContain('WAITING FOR APPROVAL')
    expect(rendered).toContain(`resume: ${JSON.stringify(String(result.requestId))}`)
  })

  it('withdraws the local card when the early return ends the follow', async () => {
    const harness = createHarness({ ask: APPROVAL_ASK, holdApproval: true })
    const result = await harness.tools.get('peer_ask')!.execute({ alias: 'scratch', message: 'rm the dir' }, harness.exec)
    expect(result).toMatchObject({ ok: false, pending: true, status: 'waiting_approval' })
    expect(harness.approvalCalls).toHaveLength(1)
    // The card's signal is the linked follow lifetime: the early return aborts it.
    expect((harness.approvalCalls[0] as { signal: AbortSignal }).signal.aborted).toBe(true)
    // A withdrawn local ask is never relayed blind; the caller answers via peer_answer.
    expect(harness.calls.filter(call => call.method === 'answer')).toHaveLength(0)
    expect((result.asks as string[])[0]).toContain('decision=cancelled')
  })

  it('resumes the same followed turn to terminal after peer_answer, without re-prompting', async () => {
    // withApproval false models the non-interactive caller: the ask is left for
    // peer_answer instead of a local card.
    const harness = createHarness({ ask: APPROVAL_ASK, resumeFlow: true, withApproval: false })
    const first = await harness.tools.get('peer_ask')!.execute({ alias: 'scratch', message: 'rm the dir' }, harness.exec)
    expect(first).toMatchObject({ ok: false, pending: true, status: 'waiting_approval', admitted: true })
    expect((first.asks as string[])[0]).toContain('decision=unsurfaced')
    const requestId = String(first.requestId)

    const answered = await harness.tools.get('peer_answer')!.execute({ alias: 'scratch', askId: 'ask-1', outcome: 'rejected' }, harness.exec)
    expect(answered).toMatchObject({ ok: true, settled: true })
    expect((harness.calls.find(call => call.method === 'answer')!.args.answer as Record<string, unknown>).outcome).toBe('rejected')

    const second = await harness.tools.get('peer_ask')!.execute({ alias: 'scratch', resume: requestId }, harness.exec)
    expect(second).toMatchObject({
      ok: true,
      resumed: true,
      admitted: false,
      settled: true,
      turn: 1,
      terminal: 'completed',
      answer: 'remote answer text',
    })
    // Resume never sends the message again.
    expect(harness.calls.filter(call => call.method === 'prompt')).toHaveLength(1)
  })

  it('rejects a resume that also carries a message, and a blank resume', async () => {
    const harness = createHarness()
    const withMessage = await harness.tools.get('peer_ask')!.execute({ alias: 'scratch', resume: 'peer-bridge-x', message: 'hi' }, harness.exec)
    expect(withMessage.ok).toBe(false)
    expect(String((withMessage.error as Record<string, unknown>).message)).toContain('drop message')
    const blank = await harness.tools.get('peer_ask')!.execute({ alias: 'scratch', resume: '' }, harness.exec)
    expect(blank.ok).toBe(false)
    expect(String((blank.error as Record<string, unknown>).message)).toContain('requestId')
    // Neither malformed call reached the wire.
    expect(harness.calls).toHaveLength(0)
  })

  it('dismisses a local approval card when the remote ask settles elsewhere', async () => {
    // askLatch running keeps the follow alive past the ask frame so the
    // remote-side settle (not the early return) is what withdraws the card.
    const harness = createHarness({ ask: APPROVAL_ASK, askLatch: 'running', holdApproval: true, holdFollow: true, settleAskRemotely: true })
    const pending = harness.tools.get('peer_ask')!.execute({ alias: 'scratch', message: 'rm the dir' }, harness.exec)
    await waitFor(() => harness.approvalCalls.length === 1)
    const request = harness.approvalCalls[0] as { signal: AbortSignal }
    expect(request.signal.aborted).toBe(false)
    await waitFor(() => request.signal.aborted)
    // The remote settle must withdraw the card, never relay a blind answer.
    expect(harness.calls.filter(call => call.method === 'answer')).toHaveLength(0)
    harness.abortExec()
    const result = await pending
    const askLine = (result.asks as string[])[0]!
    expect(askLine).toContain('decision=cancelled')
    expect(askLine).toContain('settled elsewhere')
  })

  it('dismisses a local question card when the remote ask settles elsewhere', async () => {
    const harness = createHarness({ ask: QUESTION_ASK, askLatch: 'running', holdQuestion: true, holdFollow: true, settleAskRemotely: true })
    const pending = harness.tools.get('peer_ask')!.execute({ alias: 'scratch', message: 'ask me something' }, harness.exec)
    await waitFor(() => harness.questionCalls.length === 1)
    const request = harness.questionCalls[0] as { signal: AbortSignal }
    expect(request.signal.aborted).toBe(false)
    await waitFor(() => request.signal.aborted)
    expect(harness.calls.filter(call => call.method === 'answer')).toHaveLength(0)
    harness.abortExec()
    const result = await pending
    const askLine = (result.asks as string[])[0]!
    expect(askLine).toContain('decision=cancelled')
    expect(askLine).toContain('settled elsewhere')
  })

  it('peer_sessions lists caller pairings with bound remoteSessionId and latch summary', async () => {
    const harness = createHarness()
    const result = await harness.tools.get('peer_sessions')!.execute({}, harness.exec)
    expect(result).toMatchObject({ ok: true, device: 'serverlocal' })
    const sessions = result.sessions as Record<string, unknown>[]
    expect(sessions).toHaveLength(1)
    expect(sessions[0]).toMatchObject({
      alias: 'scratch',
      peer: 'serverlocal',
      endpoint: 'https://serverlocal.pike-acrux.ts.net:8443',
      remoteSessionId: 'sess-1',
      exposure: 'debug',
      bound: true,
      latch: 'idle',
      summary: 'idle · no asks',
    })
    const rendered = harness.tools.get('peer_sessions')!.output.render({}, result)[0]!.text
    expect(rendered).toContain('session sess-1')
    expect(rendered).toContain('latch=idle')
    expect(rendered).toContain('idle · no asks')
  })

  it('peer_sessions reports an unreachable host per row and filters by alias', async () => {
    const failing = createHarness({ networkFail: true })
    const result = await failing.tools.get('peer_sessions')!.execute({}, failing.exec)
    expect(result.ok).toBe(true)
    const row = (result.sessions as Record<string, unknown>[])[0]!
    expect((row.error as Record<string, unknown>).code).toBe('peer/target-unreachable')
    expect(failing.tools.get('peer_sessions')!.output.render({}, result)[0]!.text).toContain('unreachable')
    const missing = await failing.tools.get('peer_sessions')!.execute({ alias: 'nope' }, failing.exec)
    expect(missing.ok).toBe(false)
    expect(String((missing.error as Record<string, unknown>).message))
      .toContain('no caller-role pairing with alias "nope"; available: scratch → serverlocal')
  })

  it('leaves a local ask answerable while a non-approval follow stays open, then relays the answer', async () => {
    // askLatch running: latch alone does not trigger the early return, the card
    // stays linked to the open follow, and the operator's decision relays.
    const harness = createHarness({ ask: APPROVAL_ASK, askLatch: 'running', holdApproval: true, holdFollow: true })
    const pending = harness.tools.get('peer_ask')!.execute({ alias: 'scratch', message: 'rm the dir' }, harness.exec)
    await waitFor(() => harness.approvalCalls.length === 1)
    const request = harness.approvalCalls[0] as { signal: AbortSignal }
    expect(request.signal.aborted).toBe(false)
    harness.settleApproval('allowed-once')
    await waitFor(() => harness.calls.some(call => call.method === 'answer'))
    expect(harness.calls.find(call => call.method === 'answer')!.args).toMatchObject({
      answer: { kind: 'approval', outcome: 'allowed-once' },
    })
    harness.abortExec()
    const result = await pending
    expect(result.pending).toBe(true)
    expect((result.asks as string[])[0]).toContain('relay=settled')
  })

  it('relays a local rejection as rejected', async () => {
    const harness = createHarness({ ask: APPROVAL_ASK })
    harness.setApprovalDecision('rejected')
    await harness.tools.get('peer_ask')!.execute({ alias: 'scratch', message: 'rm the dir' }, harness.exec)
    expect(harness.calls.find(call => call.method === 'answer')!.args).toMatchObject({ answer: { kind: 'approval', outcome: 'rejected' } })
  })

  it('reports peer/conflict instead of retrying when another participant answered', async () => {
    const harness = createHarness({ ask: APPROVAL_ASK, answerError: 'peer/conflict' })
    const result = await harness.tools.get('peer_ask')!.execute({ alias: 'scratch', message: 'rm the dir' }, harness.exec)
    const askLine = (result.asks as string[])[0]!
    expect(askLine).toContain('relay=conflict')
    expect(askLine).toContain('not retried')
    expect(harness.calls.filter(call => call.method === 'answer')).toHaveLength(1)
  })

  it('records a durable notice and leaves the ask answerable when the approval service is absent', async () => {
    const harness = createHarness({ ask: APPROVAL_ASK, withApproval: false })
    const result = await harness.tools.get('peer_ask')!.execute({ alias: 'scratch', message: 'rm the dir' }, harness.exec)
    expect((result.asks as string[])[0]).toContain('decision=unsurfaced')
    expect(harness.calls.filter(call => call.method === 'answer')).toHaveLength(0)
    expect(existsSync(harness.noticesPath)).toBe(true)
    const notice = readFileSync(harness.noticesPath, 'utf8')
    expect(notice).toContain('"askId":"ask-1"')
    expect(notice).toContain('local approval service unavailable')
  })

  it('peer_answer reports conflicts and settles approvals', async () => {
    const harness = createHarness()
    const settled = await harness.tools.get('peer_answer')!.execute({ alias: 'scratch', askId: 'ask-1', outcome: 'allowed-once' }, harness.exec)
    expect(settled).toMatchObject({ ok: true, settled: true })
    const conflicting = createHarness({ answerError: 'peer/conflict' })
    const failed = await conflicting.tools.get('peer_answer')!.execute({ alias: 'scratch', askId: 'ask-1', outcome: 'rejected' }, conflicting.exec)
    expect(failed.ok).toBe(false)
    expect(String(failed.note)).toContain('peer/conflict')
    expect(failed.settled).toBe(false)
  })

  it('peer_cancel reports the remote turn state', async () => {
    const harness = createHarness()
    const result = await harness.tools.get('peer_cancel')!.execute({ alias: 'scratch' }, harness.exec)
    expect(result).toMatchObject({ ok: true, cancelled: true })
  })

  it('peer_asks lists pending remote asks', async () => {
    const harness = createHarness()
    const result = await harness.tools.get('peer_asks')!.execute({ alias: 'scratch' }, harness.exec)
    expect(result).toMatchObject({ ok: true, alias: 'scratch', latch: 'idle', asks: [] })
  })

  it('surfaces a remote question locally, relays the selected label, and returns it as a pending ask', async () => {
    const harness = createHarness({ ask: QUESTION_ASK })
    const result = await harness.tools.get('peer_ask')!.execute({ alias: 'scratch', message: 'ask me something' }, harness.exec)
    expect(result).toMatchObject({ ok: false, pending: true, status: 'waiting_approval' })
    expect(result.pendingAsks).toEqual([{
      askId: 'ask-q1',
      kind: 'question',
      toolName: '',
      reason: '',
      questions: [{ id: 'colour', question: 'Pick a colour', multiSelect: false, options: ['red', 'blue'] }],
      since: 2,
    }])
    expect(harness.questionCalls).toHaveLength(1)
    const request = harness.questionCalls[0] as { questions: Array<Record<string, unknown>> }
    expect(request.questions[0]).toMatchObject({ id: 'colour', question: 'Pick a colour', options: [{ label: 'red' }, { label: 'blue' }] })
    const answerCall = harness.calls.find(call => call.method === 'answer')
    expect(answerCall!.args).toMatchObject({
      askId: 'ask-q1',
      answer: { kind: 'question', answer: { answers: [{ id: 'colour', selected: ['blue'] }] } },
    })
    const askLine = (result.asks as string[])[0]!
    expect(askLine).toContain('selected=blue')
    expect(askLine).toContain('relay=settled')
  })

  it('records a durable notice with the options and never auto-answers when no local answerer accepts', async () => {
    const harness = createHarness({ ask: QUESTION_ASK, questionRefusal: true })
    const result = await harness.tools.get('peer_ask')!.execute({ alias: 'scratch', message: 'ask me something' }, harness.exec)
    expect(harness.questionCalls).toHaveLength(1)
    expect(harness.calls.filter(call => call.method === 'answer')).toHaveLength(0)
    const askLine = (result.asks as string[])[0]!
    expect(askLine).toContain('decision=unsurfaced')
    expect(askLine).toContain('options: red, blue')
    const notice = readFileSync(harness.noticesPath, 'utf8')
    expect(notice).toContain('"askId":"ask-q1"')
    expect(notice).toContain('"question":"Pick a colour"')
    expect(notice).toContain('local question answerer declined')
  })

  it('peer_answer rejects a malformed question selection with the reason and sends nothing', async () => {
    const harness = createHarness({ ask: QUESTION_ASK })
    const result = await harness.tools.get('peer_answer')!.execute({
      alias: 'scratch',
      askId: 'ask-q1',
      answers: [{ id: 'colour', selected: ['green'] }],
    }, harness.exec)
    expect(result.ok).toBe(false)
    const error = result.error as Record<string, unknown>
    expect(error.code).toBe('gateway/bad-request')
    expect(String(error.message)).toContain('"green" is not an option of question "colour"')
    expect(harness.calls.filter(call => call.method === 'answer')).toHaveLength(0)
  })

  it('peer_answer answers a question ask with validated labels', async () => {
    const harness = createHarness({ ask: QUESTION_ASK })
    const result = await harness.tools.get('peer_answer')!.execute({
      alias: 'scratch',
      askId: 'ask-q1',
      answers: [{ id: 'colour', selected: ['red'] }],
    }, harness.exec)
    expect(result).toMatchObject({ ok: true, settled: true, note: 'question settled; the first answer won' })
    expect(harness.calls.find(call => call.method === 'answer')!.args).toMatchObject({
      answer: { kind: 'question', answer: { answers: [{ id: 'colour', selected: ['red'] }] } },
    })
  })

  it('peer_asks exposes question ids and option labels', async () => {
    const harness = createHarness({ ask: QUESTION_ASK })
    const result = await harness.tools.get('peer_asks')!.execute({ alias: 'scratch' }, harness.exec)
    expect(result).toMatchObject({
      ok: true,
      asks: [{ askId: 'ask-q1', kind: 'question', questions: [{ id: 'colour', question: 'Pick a colour', options: ['red', 'blue'] }] }],
    })
    const rendered = harness.tools.get('peer_asks')!.output.render({}, result)[0]!.text
    expect(rendered).toContain('options: red, blue')
  })

  it('folds a reconnect snapshot replay without doubling the answer', async () => {
    const harness = createHarness({ replay: true })
    const result = await harness.tools.get('peer_ask')!.execute({ alias: 'scratch', message: 'do the thing' }, harness.exec)
    expect(result).toMatchObject({ ok: true, settled: true, turn: 1, terminal: 'completed' })
    expect(result.answer).toBe('remote answer text')
  })

  it('keeps following past the first terminal while descendants are live', async () => {
    const harness = createHarness({ secondTurn: 'FINAL SUMMARY: children settled' })
    const result = await harness.tools.get('peer_ask')!.execute({ alias: 'scratch', message: 'fan out' }, harness.exec)
    expect(result).toMatchObject({ ok: true, settled: true, turn: 2, terminal: 'completed' })
    expect(result.answer).toBe('FINAL SUMMARY: children settled')
  })

  it('reports a terminal that arrived while the session was still busy as pending', async () => {
    const harness = createHarness({ secondTurn: 'too late', noFinalState: true })
    const result = await harness.tools.get('peer_ask')!.execute({ alias: 'scratch', message: 'fan out', waitMs: 40 }, harness.exec)
    expect(result).toMatchObject({ ok: false, pending: true, settled: false, turn: 2, terminal: 'completed' })
    expect(String(result.note)).toContain('live descendant')
  })

  it('ignores a third-party turn that ended before our prompt was admitted', async () => {
    const harness = createHarness({ prelude: true, thirdPartyOnly: true })
    const result = await harness.tools.get('peer_ask')!.execute({ alias: 'scratch', message: 'ours', waitMs: 40 }, harness.exec)
    expect(result.pending).toBe(true)
    expect(result.answer).toBe('')
    expect(result.turn).toBeUndefined()
    expect(result.terminal).toBeUndefined()
  })

  it('reports a host-accepted prompt as admitted before any turn of ours starts', async () => {
    const harness = createHarness({ prelude: true, stopAfterPrelude: true })
    const result = await harness.tools.get('peer_ask')!.execute({ alias: 'scratch', message: 'ours', waitMs: 40 }, harness.exec)
    expect(result).toMatchObject({ ok: false, pending: true, admitted: true })
    expect(result.terminal).toBeUndefined()
    expect(result.answer).toBe('')
  })

  it("keeps our turn's answer when a different operator's prompt opens a later turn", async () => {
    const harness = createHarness({ foreignPrompt: 'their answer' })
    const result = await harness.tools.get('peer_ask')!.execute({ alias: 'scratch', message: 'ours' }, harness.exec)
    expect(result).toMatchObject({ ok: true, settled: true, superseded: true, turn: 1, terminal: 'completed' })
    expect(result.answer).toBe('remote answer text')
    const rendered = harness.tools.get('peer_ask')!.output.render({}, result)[0]!.text
    expect(rendered).toContain('different operator')
  })

  it("does not report an earlier turn's answer under a later turn's terminal", async () => {
    const harness = createHarness({ silentSecondTurn: true })
    const result = await harness.tools.get('peer_ask')!.execute({ alias: 'scratch', message: 'ours' }, harness.exec)
    expect(result).toMatchObject({ ok: false, settled: true, turn: 2, terminal: 'error' })
    expect(result.answer).toBe('')
  })

  it('keeps the answer committed by a turn that ended in error', async () => {
    const harness = createHarness({ ourTurnError: true })
    const result = await harness.tools.get('peer_ask')!.execute({ alias: 'scratch', message: 'ours' }, harness.exec)
    expect(result).toMatchObject({ ok: false, settled: true, turn: 1, terminal: 'error' })
    expect(result.answer).toBe('remote answer text')
  })

  it('renders a cancelled settled turn informatively instead of an empty failure', async () => {
    const harness = createHarness({ ourTurnCancelled: true })
    const result = await harness.tools.get('peer_ask')!.execute({ alias: 'scratch', message: 'ours' }, harness.exec)
    expect(result).toMatchObject({ ok: false, settled: true, turn: 1, terminal: 'cancelled' })
    // The text committed before the cancellation is still returned.
    expect(result.answer).toBe('remote answer text')
    const rendered = harness.tools.get('peer_ask')!.output.render({}, result)[0]!.text
    expect(rendered).toContain('REMOTE TURN CANCELLED on scratch (session sess-1, turn 1).')
    expect(rendered).toContain('remote answer text')
    expect(rendered).not.toContain('peer_ask failed')
    expect(rendered).not.toContain('unknown')
  })

  it('renders a target-unreachable peer_ask once, without doubling the prefix', async () => {
    const harness = createHarness({ networkFail: true })
    const result = await harness.tools.get('peer_ask')!.execute({ alias: 'scratch', message: 'hi' }, harness.exec)
    expect(result.ok).toBe(false)
    const rendered = harness.tools.get('peer_ask')!.output.render({}, result)[0]!.text
    expect(rendered.match(/REMOTE TARGET UNREACHABLE/g)).toHaveLength(1)
    expect(rendered).toContain('https://serverlocal.pike-acrux.ts.net:8443')
    // The structured message keeps the loud prefix for non-render consumers.
    expect(String((result.error as Record<string, unknown>).message)).toContain('REMOTE TARGET UNREACHABLE:')
  })

  it('confirms a settled quiet window against a fresh state read', async () => {
    const harness = createHarness({ stateLatch: 'running', stateDescendants: 1 })
    const result = await harness.tools.get('peer_ask')!.execute({ alias: 'scratch', message: 'do the thing' }, harness.exec)
    expect(result).toMatchObject({ ok: false, pending: true, settled: false, turn: 1, terminal: 'completed' })
    expect(String(result.note)).toContain('live descendant')
  })

  it('reports an answer whose confirmation was lost as settled remotely', async () => {
    const harness = createHarness({ ask: APPROVAL_ASK, answerTransportLost: true })
    const result = await harness.tools.get('peer_answer')!.execute({ alias: 'scratch', askId: 'ask-1', outcome: 'allowed-once' }, harness.exec)
    expect(result).toMatchObject({ ok: true, settled: false, confirmation: 'lost' })
    expect(String(result.note)).toContain('no longer pending')
  })

  it('keeps a transport failure when the confirming read still shows the ask', async () => {
    const harness = createHarness({ ask: APPROVAL_ASK, answerTransportFail: true })
    const result = await harness.tools.get('peer_answer')!.execute({ alias: 'scratch', askId: 'ask-1', outcome: 'allowed-once' }, harness.exec)
    expect(result.ok).toBe(false)
    expect((result.error as Record<string, unknown>).code).toBe('peer/target-unreachable')
  })

  it('reports a cancel whose confirmation was lost when no turn is running', async () => {
    const harness = createHarness({ cancelTransportFail: true })
    const result = await harness.tools.get('peer_cancel')!.execute({ alias: 'scratch' }, harness.exec)
    expect(result).toMatchObject({ ok: true, cancelled: false, confirmation: 'lost' })
    expect(String(result.note)).toContain('no active turn')
  })

  it('fails loud on an unknown alias', async () => {
    const harness = createHarness()
    await expect(harness.tools.get('peer_status')!.execute({ alias: 'nope' }, harness.exec))
      .rejects.toThrowError('no caller-role pairing with alias "nope"; available: scratch → serverlocal')
  })

  it('peer_ask names the available aliases and their targets for an unknown alias', async () => {
    // The fleet convention resolves one alias both directions: asking for the
    // target host name is the confusion this listing prevents.
    const harness = createHarness()
    await expect(harness.tools.get('peer_ask')!.execute({ alias: 'serverlocal', message: 'hi' }, harness.exec))
      .rejects.toThrowError('no caller-role pairing with alias "serverlocal"; available: scratch → serverlocal')
  })

  it('states in the peer_status and peer_ask descriptions that the alias names the pairing, not the host', () => {
    const harness = createHarness()
    for (const name of ['peer_status', 'peer_ask']) {
      const description = harness.tools.get(name)!.description
      expect(description).toContain('The alias names the pairing (the member device in the fleet convention)')
      expect(description).toContain('it is NOT the target host name')
    }
  })

  it('documents the waiting_approval early return and the resume flow in the peer_ask description', () => {
    const description = createHarness().tools.get('peer_ask')!.description
    expect(description).toContain('waiting_approval')
    expect(description).toContain('peer_asks/peer_answer')
    expect(description).toContain('resume set to the returned requestId')
  })
})
