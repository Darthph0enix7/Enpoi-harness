import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  cleanKeeperProse,
  keeperBriefShapeRejection,
  keeperProseRejection,
  createBriefService,
  createCheckpointService,
  resetKeeperRouteHealth,
  type Config,
  type CheckpointData,
} from '../src/index'

beforeEach(() => { resetKeeperRouteHealth() })

/**
 * The real live garbage (2026-09-19, freellmapi/auto, session-d84cadc0 →
 * session-b6193eea): the model echoed the framed input back as raw
 * `<dots_function_call>` XML. The stream looked clean (finish `stop`), so the
 * old `cleanKeeperProse` published it verbatim as the brief.
 */
const REAL_GARBAGE_SAMPLE = [
  '<dots_function_call>',
  '<dots_function_call>',
  '<dots_function_call>',
  '<invoke name="subagent">',
  '<parameter name="description">explorer: list src files</parameter>',
  '<parameter name="prompt">List the file names in /home/user/.dsh/profiles/web/packages/enpoi-capabilities/src and reply.</parameter>',
  '<parameter name="run_in_background">false</parameter>',
  '</invoke>',
  '</dots_function_call>',
  '<dots_function_call>',
  '<dots_function_call>',
  '<invoke name="oracle_review">',
  '<parameter name="request">Confirm /home/user/.dsh/profiles/web/packages/enpoi-capabilities/src exists and name one file in it</parameter>',
  '<parameter name="reason">post 0.1.6a2 final smoke</parameter>',
  '</invoke>',
  '</dots_function_call>',
].join('\n')

const GOOD_PROSE = '🎯 ACTIVE GOAL: ship the heart\n- Whiteboard + keeper checkpoints'

function makeSession(events: Array<{ type: string; seq: number; data: unknown }> = []) {
  const log = [...events]
  return {
    id: 'prose-session',
    get seq() { return log.length },
    events: log,
    snapshotEvents: (from = 0, to = log.length): Array<{ type: string; seq: number; data: unknown }> => log.slice(from, to),
    requestContext: () => undefined,
    surface: { nodes: [] as number[] },
    append: vi.fn((...args: unknown[]) => {
      const [type, data] = args as [string, unknown]
      log.push({ type, seq: log.length, data })
      return { type, seq: log.length - 1, data }
    }),
  }
}

/** A session with N structural events (user/message + turn/end pairs). */
function sessionWithTurns(n: number) {
  const events: Array<{ type: string; seq: number; data: unknown }> = []
  let seq = 0
  for (let i = 0; i < n; i++) {
    events.push({ type: 'user/message', seq: seq++, data: { content: `query ${i}`, source: { kind: 'user' } } })
    events.push({ type: 'assistant/message', seq: seq++, data: { text: `answer ${i}` } })
    events.push({ type: 'turn/end', seq: seq++, data: { reason: { kind: 'stop' }, turn: i + 1 } })
  }
  return makeSession(events)
}

const baseConfig: Config = {
  provider: 'freellmapi',
  model: 'auto',
  fallbackProvider: 'antigravity',
  fallbackModel: 'gemini-3.7-flash-tiered',
  leaseMs: 45_000,
  maxInputEvents: 80,
  maxOutputTokens: 2048,
  structuralDistanceK: 24,
  minRefreshMs: 60_000,
  negativeCacheMs: 120_000,
  claimsBatchSize: 8,
  claimsBatchMinutes: 5,
  checkpointStaleEvents: 12,
  checkpointStaleHours: 24,
}

/** Minimal ctx mock: settings + llm.stream (per-call script) + logger. */
function makeCtx(script: (call: number) => string) {
  let call = 0
  const stream = async function* () {
    call += 1
    const text = script(call)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
  return {
    ctx: {
      get: (ns: string) => (ns === 'settings' ? { get: () => ({ capabilities: { tools: {} }, personas: {} }) } : undefined),
      llm: { stream: vi.fn(stream) },
      logger: { info: vi.fn(), warn: vi.fn() },
      on: vi.fn(),
    },
    callCount: () => call,
  }
}

describe('enpoi-context-keeper prose rejection (live-defect regression)', () => {
  it('flags the real <dots_function_call> echo from 2026-09-19', () => {
    const reason = keeperProseRejection(REAL_GARBAGE_SAMPLE)
    expect(reason).not.toBeNull()
    expect(reason).toContain('<dots_function_call')
  })

  it('never publishes the real garbage sample as prose', () => {
    expect(cleanKeeperProse(REAL_GARBAGE_SAMPLE)).toBe('')
  })

  it.each([
    ['<function_call>write</function_call>', '<function_call'],
    ['assistant wants <tool_use name="read">', '<tool_use'],
    ['tool_call: {"name":"read","arguments":"{}"}', 'tool_call'],
  ])('flags marker variant %s', (text, marker) => {
    expect(keeperProseRejection(text)).toContain(marker)
    expect(cleanKeeperProse(text)).toBe('')
  })

  it('flags JSON tool envelopes', () => {
    expect(keeperProseRejection('{"name":"write","arguments":"{\\"path\\":\\"a.md\\"}"}')).toBe('JSON tool-call envelope')
    expect(keeperProseRejection('{"tool_calls":[{"name":"read","arguments":"{}"}]}')).toBe('JSON tool-call envelope')
    expect(keeperProseRejection('{"function_call":{"name":"x","arguments":"{}"}}')).toBe('JSON tool-call envelope')
    expect(cleanKeeperProse('{"name":"write","arguments":"{}"}')).toBe('')
  })

  it('flags most-markup blobs that carry no section header', () => {
    expect(keeperProseRejection('<root><a>1</a><b>2</b><c>3</c><d>4</d><e>5</e></root>')).toBe('output is mostly markup')
  })

  it('rejects a header-less landing (live defect 2026-09-27: probe-answer echo published as the brief)', () => {
    const echo = 'F1=640\nF2=73\nF3=190\nF4=377\nF5=E6612\nF6=E9022\nF7=E1001\nF8=unknown\nF9=unknown\nF10=unknown'
    expect(cleanKeeperProse(echo)).toBe('')
    expect(keeperBriefShapeRejection(echo)).toBe('brief has no section header')
  })

  it('rejects a header-only landing and a one-line landing below the length floor', () => {
    expect(cleanKeeperProse('🎯 ACTIVE GOAL & CORE TRAJECTORY:')).toBe('')
    expect(keeperBriefShapeRejection('🎯 ACTIVE GOAL & CORE TRAJECTORY:')).toBe('brief has no bullet content')
    expect(cleanKeeperProse('🎯 ACTIVE GOAL: ship it')).toBe('')
    // A header + bullet that is still below the floor (a one-line landing).
    expect(cleanKeeperProse('🎯 ACTIVE GOAL: ok\n- do it')).toBe('')
    expect(keeperBriefShapeRejection('🎯 ACTIVE GOAL: ok\n- do it')).toContain('minimum length')
    // A structurally complete brief above the floor still publishes.
    expect(cleanKeeperProse(GOOD_PROSE)).toContain('ship the heart')
  })

  it('keeps genuine prose (including harmless inline tags)', () => {
    expect(keeperProseRejection(GOOD_PROSE)).toBeNull()
    expect(cleanKeeperProse(GOOD_PROSE)).toContain('ship the heart')
    // False-positive guard: a bullet may mention markup, and a JSON-ish fact
    // without envelope keys is not a tool call.
    expect(keeperProseRejection('🏛️ ARCHITECTURAL INVARIANTS & CONCRETE DECISIONS:\n- Keep <div> support')).toBeNull()
    expect(keeperProseRejection('{"fact":"the tunnel id exists"}')).toBeNull()
    expect(keeperProseRejection('🎯 ACTIVE GOAL:\n- parse tool_call events before publishing')).toContain('tool_call')
  })
})

describe('enpoi-context-keeper prose rejection → model-chain fallback', () => {
  it('advances to the fallback route when the primary echoes garbage, publishing only the good prose', async () => {
    const { ctx, callCount } = makeCtx((call) => (call === 1 ? REAL_GARBAGE_SAMPLE : GOOD_PROSE))
    const service = createBriefService(ctx as never, baseConfig)
    const session = sessionWithTurns(1)

    const result = await service.ensureFreshBrief(session as never)

    expect(result.ok).toBe(true)
    expect(result.model).toBe('antigravity/gemini-3.7-flash-tiered')
    expect(result.prose).toContain('ship the heart')
    expect(callCount()).toBe(2) // primary rejected → fallback served
    const [type, payload] = session.append.mock.calls[0] as [string, { text: string }]
    expect(type).toBe('brief/prose-updated')
    expect(payload.text).toContain('ship the heart')
    expect(payload.text).not.toContain('dots_function_call')
  })

  it('fails the pass (and publishes nothing) when every route echoes garbage', async () => {
    const { ctx, callCount } = makeCtx(() => REAL_GARBAGE_SAMPLE)
    const service = createBriefService(ctx as never, baseConfig)
    const session = sessionWithTurns(1)

    const result = await service.ensureFreshBrief(session as never)

    expect(result.ok).toBe(false)
    expect(result.reason).toBe('failed')
    expect(callCount()).toBe(2) // primary + fallback both rejected
    expect(session.append).not.toHaveBeenCalled()
  })

  it('advances to the fallback route when the primary lands a one-line shape failure', async () => {
    const oneLine = '🎯 ACTIVE GOAL: ship it'
    const { ctx, callCount } = makeCtx((call) => (call === 1 ? oneLine : GOOD_PROSE))
    const service = createBriefService(ctx as never, baseConfig)
    const session = sessionWithTurns(1)

    const result = await service.ensureFreshBrief(session as never)

    expect(result.ok).toBe(true)
    expect(result.model).toBe('antigravity/gemini-3.7-flash-tiered')
    expect(result.prose).toContain('ship the heart')
    expect(callCount()).toBe(2)
    const [type, payload] = session.append.mock.calls[0] as [string, { text: string }]
    expect(type).toBe('brief/prose-updated')
    expect(payload.text).not.toBe(oneLine)
  })

  it('falls back to the deterministic template when every route lands a one-line shape failure', async () => {
    const { ctx } = makeCtx(() => '🎯 ACTIVE GOAL: ship it')
    const service = createCheckpointService(ctx as never, baseConfig)
    const session = sessionWithTurns(2)

    const result = await service.ensureCheckpoint(session as never)

    expect(result.ok).toBe(true)
    const calls = (session.append.mock.calls as Array<[string, CheckpointData]>).filter((call) => call[0] === 'state/checkpoint')
    expect(calls).toHaveLength(1)
    expect(calls[0]![1].via).toBe('template')
    expect(calls[0]![1].text).not.toContain('ship it')
  })

  it('falls back to the deterministic checkpoint template when every route echoes garbage', async () => {
    const { ctx } = makeCtx(() => REAL_GARBAGE_SAMPLE)
    const service = createCheckpointService(ctx as never, baseConfig)
    const session = sessionWithTurns(2)

    const result = await service.ensureCheckpoint(session as never)

    expect(result.ok).toBe(true)
    const calls = (session.append.mock.calls as Array<[string, CheckpointData]>).filter((call) => call[0] === 'state/checkpoint')
    expect(calls).toHaveLength(1)
    expect(calls[0]![1].via).toBe('template')
    expect(calls[0]![1].text).not.toContain('dots_function_call')
    expect(calls[0]![1].text).toContain('query 0')
  })
})
