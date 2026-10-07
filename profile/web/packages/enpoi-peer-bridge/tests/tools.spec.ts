import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import type { PeerPendingAsk, PeerWebSocket } from '../src/peer-client.ts'
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

interface HostOptions {
  readonly answerError?: string
  readonly ask?: PeerPendingAsk | null
  readonly withApproval?: boolean
  readonly networkFail?: boolean
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
  writeFileSync(pairingsPath, PAIRING_DOC)

  const calls: Array<{ method: string; args: Record<string, unknown> }> = []
  const captured = { requestId: undefined as string | undefined }
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
        return ok({
          target: { device: 'serverlocal', sessionId: 'sess-1', exposure: 'debug', alias: 'scratch' },
          state: {
            latch: 'idle', since: 0, source: 'host-latch', activeDescendants: 0, descendantsExact: true,
            pendingAsks: options.ask === undefined || options.ask === null ? [] : [options.ask],
            model: { provider: 'antigravity', model: 'gemini-3.8-flash-tiered' },
            lastTurnEnd: { turn: 0, reason: 'completed', at: 0 },
          },
          cursor: 0,
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
        if (options.answerError !== undefined) return fail(options.answerError, 'already settled')
        return ok({ accepted: true, settled: true })
      case 'cancel':
        return ok({ accepted: true, cancelled: true })
      default:
        return fail('peer/not-paired', `no ${method}`)
    }
  }) as unknown as typeof fetch

  const socketFactory = (): PeerWebSocket => new FakeSocket((socket, streamId) => {
    socket.frame(streamId, SNAPSHOT)
    if (options.ask !== undefined && options.ask !== null) {
      socket.frame(streamId, {
        type: 'state',
        state: {
          latch: 'waiting_approval', since: 1, source: 'host-latch', activeDescendants: 0,
          descendantsExact: true, pendingAsks: [options.ask],
        },
        cursor: 1,
      })
      if (options.settleAskRemotely === true) {
        setTimeout(() => {
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
    socket.frame(streamId, {
      type: 'event',
      record: { seq: 10, time: 1, type: 'user/message', data: { source: { kind: 'user', rpcId: captured.requestId }, content: [{ type: 'text', text: 'run it' }] } },
      cursor: 10,
    })
    if (options.holdFollow === true) return
    socket.frame(streamId, {
      type: 'event',
      record: { seq: 11, time: 2, type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: 'remote answer text' }] } } },
      cursor: 11,
    })
    socket.frame(streamId, {
      type: 'event',
      record: { seq: 12, time: 3, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
      cursor: 12,
    })
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

  registerTools(ctx, { pairingsPath, noticesPath }, { fetch: fetchImpl, webSocket: socketFactory })
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

  it('surfaces a remote approval ask locally and relays allowed-once', async () => {
    const harness = createHarness({ ask: APPROVAL_ASK })
    const result = await harness.tools.get('peer_ask')!.execute({ alias: 'scratch', message: 'rm the dir' }, harness.exec)
    expect(result.ok).toBe(true)
    expect(harness.approvalCalls).toHaveLength(1)
    const request = harness.approvalCalls[0] as Record<string, unknown>
    expect(request.toolName).toBe('bash')
    expect(String(request.reason)).toContain('remote ask on scratch')
    expect(String(request.reason)).toContain('bash rule "rm" requires approval')
    const answerCall = harness.calls.find(call => call.method === 'answer')
    expect(answerCall!.args).toMatchObject({ answer: { kind: 'approval', outcome: 'allowed-once' } })
    expect((result.asks as string[])[0]).toContain('relay=settled')
  })

  it('cancels a pending local ask when the follow ends while the card is open', async () => {
    const harness = createHarness({ ask: APPROVAL_ASK, holdApproval: true })
    const result = await harness.tools.get('peer_ask')!.execute({ alias: 'scratch', message: 'rm the dir' }, harness.exec)
    expect(result).toMatchObject({ ok: true, terminal: 'completed', answer: 'remote answer text' })
    expect(harness.approvalCalls).toHaveLength(1)
    // The card's signal is the linked follow lifetime: it must be aborted.
    expect((harness.approvalCalls[0] as { signal: AbortSignal }).signal.aborted).toBe(true)
    // A withdrawn local ask is never relayed blind.
    expect(harness.calls.filter(call => call.method === 'answer')).toHaveLength(0)
    expect((result.asks as string[])[0]).toContain('decision=cancelled')
  })

  it('dismisses a local approval card when the remote ask settles elsewhere', async () => {
    const harness = createHarness({ ask: APPROVAL_ASK, holdApproval: true, holdFollow: true, settleAskRemotely: true })
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
    const harness = createHarness({ ask: QUESTION_ASK, holdQuestion: true, holdFollow: true, settleAskRemotely: true })
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
    expect(String((missing.error as Record<string, unknown>).message)).toContain('no caller-role pairing')
  })

  it('leaves a local ask answerable while the follow stays open, then relays the answer', async () => {
    const harness = createHarness({ ask: APPROVAL_ASK, holdApproval: true, holdFollow: true })
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

  it('surfaces a remote question locally, relays the selected label, and reports it', async () => {
    const harness = createHarness({ ask: QUESTION_ASK })
    const result = await harness.tools.get('peer_ask')!.execute({ alias: 'scratch', message: 'ask me something' }, harness.exec)
    expect(result.ok).toBe(true)
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

  it('fails loud on an unknown alias', async () => {
    const harness = createHarness()
    await expect(harness.tools.get('peer_status')!.execute({ alias: 'nope' }, harness.exec))
      .rejects.toThrowError(/available: scratch/u)
  })
})
